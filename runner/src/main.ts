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

export type SdkQueryFn = (params: {
  prompt: string;
  options?: {
    resume?: string;
    cwd?: string;
    permissionMode?: 'bypassPermissions';
    allowDangerouslySkipPermissions?: boolean;
  };
}) => AsyncIterable<SDKMessage>;

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_ID_PATH = '/workspace/.slackbot/session-id';
const WORKSPACE_DIR = '/workspace';

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
  input: NodeJS.ReadableStream;
}): Promise<void> {
  const { readFile, writeFile, mkdir, sdkQuery, input } = opts;

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
      const stream = sdkQuery({
        prompt: text,
        options: {
          ...(sessionId !== null ? { resume: sessionId } : {}),
          cwd: WORKSPACE_DIR,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
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

function realSdkQuery(params: {
  prompt: string;
  options?: {
    resume?: string;
    cwd?: string;
    permissionMode?: 'bypassPermissions';
    allowDangerouslySkipPermissions?: boolean;
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
    input: process.stdin,
  }).catch((err: unknown) => {
    process.stderr.write(`[runner] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
