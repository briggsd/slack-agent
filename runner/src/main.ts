/**
 * Runner container entry point.
 *
 * Reads NDJSON from stdin line-by-line (UserMessage).
 * Writes NDJSON to stdout (ReadyMessage | StatusMessage | UsageMessage | TextMessage | ErrorMessage).
 * All logs go to stderr only — never to stdout.
 *
 * Session-ID persistence: on first turn the SDK emits a system/init message
 * with session_id. We persist that to SESSION_ID_PATH so that if the
 * container is reaped and recreated the SDK session can be resumed.
 */

import { createInterface } from 'readline';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  UserMessage,
  RunnerToGatewayMessage,
} from './protocol.js';
import { ApprovalCoordinator, parseInbound } from './approval.js';
import type { Verdict } from './approval.js';

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
  /**
   * Bound at the runner so the SDK's `submit_spec` tool can raise the commit gate. The real
   * query wraps this in an in-process MCP tool; the test fake calls it directly to drive the
   * mid-turn stdin demux. Omitted only by callers that don't wire the gate.
   */
  submitSpec?: (specRef: string) => Promise<Verdict>;
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

/**
 * Tells the agent how the commit gate works. The mechanism (the tool, the gateway's
 * requestor-only check) is S10b; richer router behaviour — when exactly to commit, what a
 * SPEC.md contains — is shaped in later slices.
 */
const COMMIT_SYSTEM_PROMPT_ADDITION =
  'Before you take an action that needs human sign-off (writing code, opening a PR, running a ' +
  'build), call the submit_spec tool with the full plan and wait for the verdict. Proceed only ' +
  'if it returns approved; otherwise revise from the feedback and resubmit, or keep discussing.';

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

  // The commit gate. `submit_spec` calls coordinator.requestApproval mid-turn; inbound
  // approval_verdict lines are routed to coordinator.handleVerdict by the dispatcher below.
  const coordinator = new ApprovalCoordinator((specRef, gateId) =>
    emit({ type: 'request_approval', id: gateId, specRef }),
  );

  // Signal readiness
  emit({ type: 'ready' });

  const rl = createInterface({ input, crlfDelay: Infinity });

  // Stdin demux: a single line listener routes inbound messages. user_message lines feed a
  // serial turn queue; approval_verdict lines resolve a tool parked mid-turn. The old
  // `for await (const line of rl)` consumed stdin only between turns, so a verdict that
  // arrives WHILE the SDK stream is live (which is exactly when submit_spec is waiting) would
  // never be read. An event listener reads continuously instead.
  const turnQueue: UserMessage[] = [];
  let inputClosed = false;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    if (wake !== null) {
      const w = wake;
      wake = null;
      w();
    }
  };

  rl.on('line', (rawLine: string) => {
    const line = rawLine.trim();
    if (line === '') return;
    const parsed = parseInbound(line);
    if (parsed.kind === 'verdict') {
      if (!coordinator.handleVerdict(parsed.msg)) {
        log(`approval_verdict for unknown gate ${parsed.msg.id} — ignored`);
      }
      return;
    }
    if (parsed.kind === 'user') {
      turnQueue.push(parsed.msg);
      signal();
      return;
    }
    log(`malformed input line: ${parsed.error}`);
    emit({ type: 'error', id: 'unknown', message: `malformed input: ${parsed.error}` });
  });
  rl.on('close', () => {
    inputClosed = true;
    // Unblock any tool still parked on a verdict that will never come, so shutdown completes.
    coordinator.failAllPending();
    signal();
  });

  const submitSpec = (specRef: string): Promise<Verdict> => coordinator.requestApproval(specRef);

  // Drain turns serially. A turn holds the loop until its SDK stream completes; verdicts for
  // an in-flight gate are delivered concurrently by the listener above, not from here.
  while (true) {
    if (turnQueue.length === 0) {
      if (inputClosed) break;
      // No lost wakeup: the Promise executor runs synchronously, so `wake` is assigned before
      // `await` suspends. There is no yield point between the emptiness check and that
      // assignment, so a `line`/`close` callback (which can only run once we're parked at the
      // await) always sees a non-null `wake`. JS run-to-completion guarantees this.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    const msg = turnQueue.shift();
    if (msg === undefined) continue;
    sessionId = await processTurn(msg, sessionId, {
      sdkQuery,
      writeFile,
      mkdir,
      listFiles,
      readBinaryFile,
      submitSpec,
    });
  }
}

/**
 * Run one user_message turn to completion, emitting status/usage/file/text/error. Returns the
 * (possibly updated) SDK session id so the caller threads it into the next turn.
 */
async function processTurn(
  msg: UserMessage,
  sessionId: string | null,
  deps: {
    sdkQuery: SdkQueryFn;
    writeFile: WriteFileFn;
    mkdir: MkdirFn;
    listFiles: ListFilesFn;
    readBinaryFile: ReadBinaryFileFn;
    submitSpec: (specRef: string) => Promise<Verdict>;
  },
): Promise<string | null> {
  const { id, text } = msg;
  let currentSessionId = sessionId;

  try {
    // Record turn start for file mtime filtering
    const turnStartMs = Date.now();

    const stream = deps.sdkQuery({
      prompt: text,
      submitSpec: deps.submitSpec,
      options: {
        ...(currentSessionId !== null ? { resume: currentSessionId } : {}),
        cwd: WORKSPACE_DIR,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        disallowedTools: DISALLOWED_TOOLS,
        // Verified against runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
        // Options.systemPrompt supports { type: 'preset', preset: 'claude_code', append?: string }
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `${WORKSPACE_SYSTEM_PROMPT_ADDITION}\n\n${COMMIT_SYSTEM_PROMPT_ADDITION}`,
        },
      },
    });

    let resultText: string | null = null;
    let turnError: string | null = null;
    let usageMsg: RunnerToGatewayMessage | null = null;

    for await (const event of stream) {
      // Capture session ID from system init
      if (
        event.type === 'system' &&
        (event as { subtype?: string }).subtype === 'init'
      ) {
        const newSessionId = event.session_id;
        if (currentSessionId !== newSessionId) {
          currentSessionId = newSessionId;
          try {
            await deps.mkdir('/workspace/.slackbot');
            await deps.writeFile(SESSION_ID_PATH, currentSessionId);
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

      // Result (success or error). Read cost/usage defensively: the SDK types mark
      // total_cost_usd/usage as non-optional, but a shape drift that left usage absent
      // would throw here and turn an otherwise-successful result into an error. Default
      // to 0 — a turn that ran still happened, it just reports no cost.
      if (event.type === 'result') {
        const usage = event.usage;
        usageMsg = {
          type: 'usage',
          id,
          costMicroUsd: Math.round((event.total_cost_usd ?? 0) * 1e6),
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
        };
        if (event.subtype === 'success') {
          resultText = event.result;
          // Update session_id from result in case it changed
          if (event.session_id && event.session_id !== currentSessionId) {
            currentSessionId = event.session_id;
            try {
              await deps.mkdir('/workspace/.slackbot');
              await deps.writeFile(SESSION_ID_PATH, currentSessionId);
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

    if (usageMsg !== null) {
      emit(usageMsg);
    }

    if (turnError !== null) {
      emit({ type: 'error', id, message: turnError });
    } else if (resultText !== null) {
      // Scan workspace for files written during this turn (success only)
      await emitNewFiles(id, turnStartMs, deps.listFiles, deps.readBinaryFile);
      emit({ type: 'text', id, text: resultText });
    } else {
      emit({ type: 'error', id, message: 'no result received from SDK' });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`error processing message: ${message}`);
    emit({ type: 'error', id, message });
  }

  return currentSessionId;
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

/**
 * Build the in-process MCP server that exposes the commit gate as the `submit_spec` tool. The
 * tool surfaces to the model as `mcp__commit__submit_spec`; its handler raises the gate via the
 * injected submitSpec and returns the human's verdict as the tool result. `alwaysLoad` keeps it
 * out of deferred tool search so the agent can always reach it.
 */
function buildCommitMcpServer(submitSpec: (specRef: string) => Promise<Verdict>) {
  const submitSpecTool = tool(
    'submit_spec',
    'Submit the finalized spec or plan for the human to approve before you build, write code, ' +
      'or open a PR. Pass the full spec text as `spec`. Blocks until the human responds and ' +
      'returns whether they approved plus any feedback. Do not act on the plan until it returns approved.',
    { spec: z.string().describe('The full spec/plan text to show the human for approval.') },
    async (args) => {
      const verdict = await submitSpec(args.spec);
      const resultText = verdict.approved
        ? 'APPROVED. Proceed with the spec as written.'
        : `NOT APPROVED. ${
            verdict.feedback !== undefined
              ? `Human feedback: ${verdict.feedback}`
              : 'No feedback was given.'
          } Revise the plan and resubmit, or keep discussing — do not proceed.`;
      return { content: [{ type: 'text' as const, text: resultText }] };
    },
  );
  return createSdkMcpServer({
    name: 'commit',
    version: '0.0.0',
    tools: [submitSpecTool],
    alwaysLoad: true,
  });
}

function realSdkQuery(params: {
  prompt: string;
  submitSpec?: (specRef: string) => Promise<Verdict>;
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
  const mcpServers =
    params.submitSpec !== undefined
      ? { commit: buildCommitMcpServer(params.submitSpec) }
      : undefined;
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
        ...(mcpServers !== undefined ? { mcpServers } : {}),
      },
    });
  }
  return query(
    mcpServers !== undefined
      ? { prompt: params.prompt, options: { mcpServers } }
      : { prompt: params.prompt },
  );
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
