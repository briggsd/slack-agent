/**
 * Runner container entry point.
 *
 * Reads NDJSON from stdin line-by-line (UserMessage).
 * Writes NDJSON to stdout (ReadyMessage | StatusMessage | TextMessage | ErrorMessage).
 * All logs go to stderr only — never to stdout.
 *
 * Session-ID persistence: on first turn the SDK emits a system/init message
 * with session_id. We persist that to SESSION_ID_PATH so that if the
 * container is reaped and recreated the SDK session can be resumed.
 */

import { createInterface } from 'readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  GatewayToRunnerMessage,
  RunnerToGatewayMessage,
} from './protocol.js';

// ── Injectable seams for testing ──────────────────────────────────────────────

export type ReadFileFn = (path: string) => Promise<string | null>;
export type WriteFileFn = (path: string, data: string) => Promise<void>;
export type MkdirFn = (path: string) => Promise<void>;

/** A scanned file entry returned by ListFilesFn */
export type ScannedFile = {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
};

/**
 * List regular files under a directory, recursively.
 * Returns entries sorted by path (stable order for tests).
 */
export type ListFilesFn = (dir: string) => Promise<ScannedFile[]>;

/** Read a file as a Buffer (for binary / base64 forwarding). */
export type ReadBinaryFileFn = (path: string) => Promise<Buffer | null>;

export type SdkQueryFn = (params: {
  prompt: string;
  options?: {
    resume?: string;
    cwd?: string;
    permissionMode?: 'bypassPermissions';
    allowDangerouslySkipPermissions?: boolean;
    /**
     * Tools the SDK must refuse to run (see {@link DISALLOWED_TOOLS}). A custom
     * implementation of this seam must forward this list to the underlying query —
     * dropping it silently re-enables the no-op `AskUserQuestion` guardrail.
     */
    disallowedTools?: string[];
    systemPrompt?: string | string[] | {
      type: 'preset';
      preset: 'claude_code';
      append?: string;
      excludeDynamicSections?: boolean;
    };
  };
}) => AsyncIterable<SDKMessage>;

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_ID_PATH = '/workspace/.slackbot/session-id';
const WORKSPACE_DIR = '/workspace';

/** Maximum number of files forwarded per turn. */
const MAX_FILES_PER_TURN = 5;
/** Maximum bytes for a single file (8 MiB). */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Maximum total bytes forwarded per turn (16 MiB). */
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/**
 * Tools the agent must never use inside the container. `AskUserQuestion` blocks
 * for a structured answer, but there is no channel back to Slack from the sandbox
 * in either mode — the protocol carries only text/status/file/error out. So the
 * tool is a no-op that strands the turn on a phantom answer. Disabling it forces
 * the agent to ask in prose instead (a thread reply continues a conversational
 * session; in one-shot the question surfaces as a stated assumption in the PR).
 */
const DISALLOWED_TOOLS = ['AskUserQuestion'];

const WORKSPACE_SYSTEM_PROMPT_ADDITION =
  'Files you save under /workspace are automatically delivered to the user at the ' +
  'end of your turn. When asked to produce a file (e.g. an SVG, PDF, CSV, or any ' +
  'other artifact), save it under /workspace so it reaches the user.';

// ── Stdout helpers (one line per event, no content logged) ───────────────────

function emit(msg: RunnerToGatewayMessage): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log(msg: string): void {
  process.stderr.write(`[runner] ${msg}\n`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runLoop(opts: {
  readFile: ReadFileFn;
  writeFile: WriteFileFn;
  mkdir: MkdirFn;
  sdkQuery: SdkQueryFn;
  listFiles: ListFilesFn;
  readBinaryFile: ReadBinaryFileFn;
  input: NodeJS.ReadableStream;
}): Promise<void> {
  const { readFile, writeFile, mkdir, sdkQuery, listFiles, readBinaryFile, input } = opts;

  // Load persisted session ID (for resume-after-reap)
  let sessionId: string | null = await readFile(SESSION_ID_PATH);

  if (sessionId !== null) {
    log(`resuming session ${sessionId}`);
  }

  // Signal readiness
  emit({ type: 'ready' });

  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line === '') continue;

    let msg: GatewayToRunnerMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as Record<string, unknown>)['type'] !== 'user_message' ||
        typeof (parsed as Record<string, unknown>)['id'] !== 'string' ||
        typeof (parsed as Record<string, unknown>)['text'] !== 'string'
      ) {
        throw new Error('unexpected message shape');
      }
      msg = parsed as GatewayToRunnerMessage;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`malformed input line: ${message}`);
      // We don't have an id, so we emit without one (id: 'unknown')
      const errorMsg: RunnerToGatewayMessage = {
        type: 'error',
        id: 'unknown',
        message: `malformed input: ${message}`,
      };
      emit(errorMsg);
      continue;
    }

    const { id, text } = msg;

    try {
      // Record turn start for file mtime filtering
      const turnStartMs = Date.now();

      const stream = sdkQuery({
        prompt: text,
        options: {
          ...(sessionId !== null ? { resume: sessionId } : {}),
          cwd: WORKSPACE_DIR,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          disallowedTools: DISALLOWED_TOOLS,
          // Verified against runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
          // Options.systemPrompt supports { type: 'preset', preset: 'claude_code', append?: string }
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: WORKSPACE_SYSTEM_PROMPT_ADDITION,
          },
        },
      });

      let resultText: string | null = null;
      let turnError: string | null = null;

      for await (const event of stream) {
        // Capture session ID from system init
        if (
          event.type === 'system' &&
          (event as { subtype?: string }).subtype === 'init'
        ) {
          const newSessionId = event.session_id;
          if (sessionId !== newSessionId) {
            sessionId = newSessionId;
            try {
              await mkdir('/workspace/.slackbot');
              await writeFile(SESSION_ID_PATH, sessionId);
              log(`session id persisted`);
            } catch (e) {
              log(`warning: could not persist session id: ${String(e)}`);
            }
          }
          continue;
        }

        // Tool progress → status event
        if (event.type === 'tool_progress') {
          const statusMsg: RunnerToGatewayMessage = {
            type: 'status',
            id,
            text: `using tool: ${event.tool_name}`,
          };
          emit(statusMsg);
          continue;
        }

        // Tool use summary → status event
        if (event.type === 'tool_use_summary') {
          const statusMsg: RunnerToGatewayMessage = {
            type: 'status',
            id,
            text: event.summary,
          };
          emit(statusMsg);
          continue;
        }

        // Result (success or error)
        if (event.type === 'result') {
          if (event.subtype === 'success') {
            resultText = event.result;
            // Update session_id from result in case it changed
            if (event.session_id && event.session_id !== sessionId) {
              sessionId = event.session_id;
              try {
                await mkdir('/workspace/.slackbot');
                await writeFile(SESSION_ID_PATH, sessionId);
              } catch {
                // best effort
              }
            }
          } else {
            const errors = event.errors;
            turnError =
              (errors !== undefined && errors.length > 0
                ? errors.join('; ')
                : undefined) ?? `SDK error: ${event.subtype}`;
          }
          break;
        }

        // Assistant message content (for status notes mid-turn)
        if (event.type === 'assistant') {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                typeof block === 'object' &&
                block !== null &&
                'type' in block &&
                block.type === 'tool_use' &&
                'name' in block &&
                typeof block.name === 'string'
              ) {
                const statusMsg: RunnerToGatewayMessage = {
                  type: 'status',
                  id,
                  text: `using tool: ${block.name}`,
                };
                emit(statusMsg);
              }
            }
          }
          continue;
        }
      }

      if (turnError !== null) {
        emit({ type: 'error', id, message: turnError });
      } else if (resultText !== null) {
        // Scan workspace for files written during this turn (success only)
        await emitNewFiles(id, turnStartMs, listFiles, readBinaryFile);
        emit({ type: 'text', id, text: resultText });
      } else {
        emit({ type: 'error', id, message: 'no result received from SDK' });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`error processing message: ${message}`);
      emit({ type: 'error', id, message });
    }
  }
}

// ── File scanning helpers ─────────────────────────────────────────────────────

/** Returns true if a path component is a dotfile/dot-directory or should be skipped. */
function shouldSkipName(name: string): boolean {
  return name.startsWith('.');
}

/**
 * Scan for new files and emit file messages.
 * Called after a successful SDK turn only.
 */
async function emitNewFiles(
  id: string,
  turnStartMs: number,
  listFiles: ListFilesFn,
  readBinaryFile: ReadBinaryFileFn,
): Promise<void> {
  let allFiles: ScannedFile[];
  try {
    allFiles = await listFiles(WORKSPACE_DIR);
  } catch (e) {
    log(`warning: could not scan workspace for files: ${String(e)}`);
    return;
  }

  // Filter to files written during this turn
  const newFiles = allFiles.filter((f) => f.mtimeMs >= turnStartMs);

  let fileCount = 0;
  let totalBytes = 0;

  for (const f of newFiles) {
    if (fileCount >= MAX_FILES_PER_TURN) {
      emit({
        type: 'status',
        id,
        text: `skipped file ${f.name}: per-turn file limit (${MAX_FILES_PER_TURN}) reached`,
      });
      log(`skipped file ${f.name} (file count cap)`);
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      emit({
        type: 'status',
        id,
        text: `skipped file ${f.name}: file too large (${f.size} bytes, limit ${MAX_FILE_BYTES})`,
      });
      log(`skipped file ${f.name} (${f.size} bytes, over per-file cap)`);
      continue;
    }
    if (totalBytes + f.size > MAX_TOTAL_BYTES) {
      emit({
        type: 'status',
        id,
        text: `skipped file ${f.name}: total size limit (${MAX_TOTAL_BYTES} bytes) would be exceeded`,
      });
      log(`skipped file ${f.name} (would exceed total bytes cap)`);
      continue;
    }

    let data: Buffer | null;
    try {
      data = await readBinaryFile(f.path);
    } catch (e) {
      log(`warning: could not read file ${f.name}: ${String(e)}`);
      continue;
    }
    if (data === null) {
      log(`warning: file ${f.name} disappeared before read`);
      continue;
    }

    fileCount++;
    totalBytes += f.size;

    const fileMsg: RunnerToGatewayMessage = {
      type: 'file',
      id,
      name: f.name,
      data_base64: data.toString('base64'),
      size: f.size,
    };
    emit(fileMsg);
    log(`forwarded file ${f.name} (${f.size} bytes)`);
  }
}

// ── Real I/O implementations ──────────────────────────────────────────────────

async function realReadFile(path: string): Promise<string | null> {
  const { readFile } = await import('fs/promises');
  try {
    const content = await readFile(path, 'utf-8');
    return content.trim();
  } catch {
    return null;
  }
}

async function realWriteFile(path: string, data: string): Promise<void> {
  const { writeFile } = await import('fs/promises');
  await writeFile(path, data, 'utf-8');
}

async function realMkdir(path: string): Promise<void> {
  const { mkdir } = await import('fs/promises');
  await mkdir(path, { recursive: true });
}

async function realListFiles(dir: string): Promise<ScannedFile[]> {
  const { readdir, stat } = await import('fs/promises');
  const results: ScannedFile[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: import('fs').Dirent<string>[];
    try {
      const raw = await readdir(currentDir, { withFileTypes: true, encoding: 'utf-8' });
      entries = raw as import('fs').Dirent<string>[];
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip dotfiles/dot-directories, node_modules
      if (shouldSkipName(entry.name) || entry.name === 'node_modules') {
        continue;
      }
      const fullPath = `${currentDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const st = await stat(fullPath);
          results.push({
            path: fullPath,
            name: entry.name,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          // File disappeared between readdir and stat — skip
        }
      }
      // symlinks are skipped (not isFile(), not isDirectory() with this check)
    }
  }

  await walk(dir);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

async function realReadBinaryFile(path: string): Promise<Buffer | null> {
  const { readFile } = await import('fs/promises');
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function realSdkQuery(params: {
  prompt: string;
  options?: {
    resume?: string;
    cwd?: string;
    permissionMode?: 'bypassPermissions';
    allowDangerouslySkipPermissions?: boolean;
    disallowedTools?: string[];
    systemPrompt?: string | string[] | {
      type: 'preset';
      preset: 'claude_code';
      append?: string;
      excludeDynamicSections?: boolean;
    };
  };
}): AsyncIterable<SDKMessage> {
  const opts = params.options;
  if (opts !== undefined) {
    return query({
      prompt: params.prompt,
      options: {
        ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.allowDangerouslySkipPermissions !== undefined
          ? { allowDangerouslySkipPermissions: opts.allowDangerouslySkipPermissions }
          : {}),
        ...(opts.disallowedTools !== undefined ? { disallowedTools: opts.disallowedTools } : {}),
        ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      },
    });
  }
  return query({ prompt: params.prompt });
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Only run when executed directly (not imported in tests)

const isMain = process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/dist/main.js') || process.argv[1].endsWith('/src/main.ts'));

if (isMain) {
  runLoop({
    readFile: realReadFile,
    writeFile: realWriteFile,
    mkdir: realMkdir,
    sdkQuery: realSdkQuery,
    listFiles: realListFiles,
    readBinaryFile: realReadBinaryFile,
    input: process.stdin,
  }).catch((err: unknown) => {
    process.stderr.write(`[runner] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
