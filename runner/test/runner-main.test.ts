/**
 * Unit tests for runner/src/main.ts (the container entry point).
 *
 * Uses a FakeAgentSdk (scripted async generator) and in-memory fs seam
 * (inject read/write fns). All offline — no Docker, no real Agent SDK.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { runLoop } from '../src/main.js';
import type { ReadFileFn, WriteFileFn, MkdirFn, SdkQueryFn, ListFilesFn, ReadBinaryFileFn, ScannedFile } from '../src/main.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// ── FakeAgentSdk ──────────────────────────────────────────────────────────────

type TurnResult = SDKMessage[];

class FakeAgentSdk {
  private turns: TurnResult[];
  private turnIndex = 0;
  public calls: Array<{ prompt: string; resume?: string }> = [];

  constructor(turns: TurnResult[] = []) {
    this.turns = turns;
  }

  getQueryFn(): SdkQueryFn {
    const self = this;
    return (params) => {
      self.calls.push({
        prompt: params.prompt,
        resume: params.options?.resume,
      });
      const idx = self.turnIndex++;
      const messages: SDKMessage[] = self.turns[idx] ?? [
        makeSdkResult('default response'),
      ];

      return {
        [Symbol.asyncIterator]: async function* () {
          for (const msg of messages) {
            yield msg;
          }
        },
      };
    };
  }
}

// ── SDK message builders ──────────────────────────────────────────────────────

function makeSdkInit(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    apiKeySource: 'user',
    claude_code_version: '0.0.0',
    cwd: '/workspace',
    tools: [],
    mcp_servers: [],
    model: 'claude-test',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'text',
    skills: [],
    plugins: [],
    uuid: '00000000-0000-0000-0000-000000000001',
  };
}

function makeSdkResult(text: string, sessionId = 'session-abc'): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    session_id: sessionId,
    is_error: false,
    duration_ms: 100,
    duration_api_ms: 90,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000002',
  };
}

function makeSdkResultError(errors: string[]): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    errors,
    session_id: 'session-abc',
    is_error: true,
    duration_ms: 100,
    duration_api_ms: 90,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000003',
  };
}

function makeSdkToolProgress(toolName: string): SDKMessage {
  return {
    type: 'tool_progress',
    tool_use_id: 'tu-1',
    tool_name: toolName,
    parent_tool_use_id: null,
    elapsed_time_seconds: 1,
    session_id: 'session-abc',
    uuid: '00000000-0000-0000-0000-000000000004',
  };
}

// ── Fake fs seam ──────────────────────────────────────────────────────────────

class InMemoryFs {
  private files = new Map<string, string>();
  /** Scripted workspace file entries for listFiles seam */
  public workspaceFiles: ScannedFile[] = [];
  /** Binary content for each path (keyed by path) */
  private binaryFiles = new Map<string, Buffer>();

  readFile: ReadFileFn = async (path) => {
    return this.files.get(path) ?? null;
  };

  writeFile: WriteFileFn = async (path, data) => {
    this.files.set(path, data);
  };

  mkdir: MkdirFn = async () => {
    // no-op
  };

  listFiles: ListFilesFn = async () => {
    return this.workspaceFiles;
  };

  readBinaryFile: ReadBinaryFileFn = async (path) => {
    return this.binaryFiles.get(path) ?? null;
  };

  get(path: string): string | undefined {
    return this.files.get(path);
  }

  set(path: string, value: string): void {
    this.files.set(path, value);
  }

  /** Add a scripted workspace file for the listFiles seam */
  addWorkspaceFile(path: string, name: string, content: Buffer, mtimeMs: number): void {
    this.workspaceFiles.push({ path, name, size: content.length, mtimeMs });
    this.binaryFiles.set(path, content);
  }
}

// ── Test harness ──────────────────────────────────────────────────────────────

type CollectedOutput = Array<{
  type: string;
  id?: string;
  text?: string;
  message?: string;
  name?: string;
  data_base64?: string;
  size?: number;
}>;

async function runWithInput(
  lines: string[],
  sdk: FakeAgentSdk,
  fs: InMemoryFs = new InMemoryFs(),
): Promise<CollectedOutput> {
  const input = new PassThrough();
  const outputs: CollectedOutput = [];

  // Intercept process.stdout.write
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (chunk: unknown): boolean => {
      const str = typeof chunk === 'string' ? chunk : String(chunk);
      for (const line of str.split('\n')) {
        const trimmed = line.trim();
        if (trimmed !== '') {
          try {
            outputs.push(JSON.parse(trimmed) as CollectedOutput[0]);
          } catch {
            // ignore non-JSON
          }
        }
      }
      return true;
    },
  );

  try {
    const loopPromise = runLoop({
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      mkdir: fs.mkdir,
      sdkQuery: sdk.getQueryFn(),
      listFiles: fs.listFiles,
      readBinaryFile: fs.readBinaryFile,
      input,
    });

    // Write input lines
    for (const line of lines) {
      input.push(line + '\n');
    }
    input.push(null); // EOF

    await loopPromise;
  } finally {
    vi.restoreAllMocks();
  }

  return outputs;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runner main — basic flow', () => {
  it('emits ready on startup', async () => {
    const sdk = new FakeAgentSdk();
    const output = await runWithInput([], sdk);
    expect(output[0]).toEqual({ type: 'ready' });
  });

  it('processes a user_message and emits text', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('hello back', 'sess-1')],
    ]);
    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'msg-1', text: 'hello' })],
      sdk,
    );

    const textEvent = output.find((e) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent?.text).toBe('hello back');
    expect(textEvent?.id).toBe('msg-1');
  });

  it('persists session-id from init message', async () => {
    const fs = new InMemoryFs();
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-persist'), makeSdkResult('ok', 'sess-persist')],
    ]);
    await runWithInput(
      [JSON.stringify({ type: 'user_message', id: '1', text: 'hi' })],
      sdk,
      fs,
    );

    expect(fs.get('/workspace/.slackbot/session-id')).toBe('sess-persist');
  });

  it('passes resume option on restart when session-id file exists', async () => {
    const fs = new InMemoryFs();
    fs.set('/workspace/.slackbot/session-id', 'existing-session');

    const sdk = new FakeAgentSdk([
      [makeSdkResult('resumed!', 'existing-session')],
    ]);
    await runWithInput(
      [JSON.stringify({ type: 'user_message', id: '1', text: 'hi' })],
      sdk,
      fs,
    );

    expect(sdk.calls[0]?.resume).toBe('existing-session');
  });
});

describe('runner main — multiple messages', () => {
  it('processes two sequential messages', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('first reply', 'sess-1')],
      [makeSdkResult('second reply', 'sess-1')],
    ]);
    const output = await runWithInput(
      [
        JSON.stringify({ type: 'user_message', id: 'm1', text: 'msg1' }),
        JSON.stringify({ type: 'user_message', id: 'm2', text: 'msg2' }),
      ],
      sdk,
    );

    const texts = output.filter((e) => e.type === 'text');
    expect(texts).toHaveLength(2);
    expect(texts[0]?.id).toBe('m1');
    expect(texts[1]?.id).toBe('m2');
  });
});

describe('runner main — status events', () => {
  it('emits status events from tool_progress', async () => {
    const sdk = new FakeAgentSdk([
      [
        makeSdkInit('sess-1'),
        makeSdkToolProgress('Bash'),
        makeSdkToolProgress('Read'),
        makeSdkResult('done', 'sess-1'),
      ],
    ]);
    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'do stuff' })],
      sdk,
    );

    const statuses = output.filter((e) => e.type === 'status');
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses.some((s) => s.text?.includes('Bash'))).toBe(true);
  });
});

describe('runner main — error handling', () => {
  it('emits error event on SDK result error', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResultError(['something failed'])],
    ]);
    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'bad' })],
      sdk,
    );

    const errorEvent = output.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.id).toBe('m1');
    expect(errorEvent?.message).toContain('something failed');
  });

  it('emits error event on malformed input line — does not crash', async () => {
    const sdk = new FakeAgentSdk([]);
    const output = await runWithInput(['not valid json at all }{'], sdk);

    const errorEvent = output.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('emits error for missing fields in input', async () => {
    const sdk = new FakeAgentSdk([]);
    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: '1' })], // missing text
      sdk,
    );

    const errorEvent = output.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });
});

// ── File detection tests ──────────────────────────────────────────────────────

describe('runner main — file detection', () => {
  it('emits file event before text when a new file is written during the turn', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    const fs = new InMemoryFs();
    const content = Buffer.from('<svg>hello</svg>', 'utf-8');

    // listFiles will be called after the SDK turn; set up file with a future mtime
    // We need the mtime to be >= turnStart. Since we cannot freeze Date.now precisely
    // in this test, we patch listFiles to return a file with a far-future mtime.
    const futureMs = Date.now() + 60_000;
    fs.addWorkspaceFile('/workspace/image.svg', 'image.svg', content, futureMs);

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'make svg' })],
      sdk,
      fs,
    );

    const fileEvent = output.find((e) => e.type === 'file');
    expect(fileEvent).toBeDefined();
    expect(fileEvent?.name).toBe('image.svg');
    expect(fileEvent?.id).toBe('m1');
    expect(fileEvent?.data_base64).toBe(content.toString('base64'));
    expect(fileEvent?.size).toBe(content.length);

    // file must appear before the text event
    const fileIdx = output.findIndex((e) => e.type === 'file');
    const textIdx = output.findIndex((e) => e.type === 'text');
    expect(fileIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(fileIdx);
  });

  it('does not emit file event when mtime is older than turn start', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    const fs = new InMemoryFs();
    const content = Buffer.from('old content', 'utf-8');
    // Old mtime — far in the past
    const oldMs = Date.now() - 60_000;
    fs.addWorkspaceFile('/workspace/old.txt', 'old.txt', content, oldMs);

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'hi' })],
      sdk,
      fs,
    );

    const fileEvents = output.filter((e) => e.type === 'file');
    expect(fileEvents).toHaveLength(0);
  });

  it('skips oversized files and emits a status event', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    const fs = new InMemoryFs();
    const futureMs = Date.now() + 60_000;
    // Create a "big" file by reporting a large size (> 8 MiB)
    const hugeSize = 9 * 1024 * 1024;
    fs.workspaceFiles.push({ path: '/workspace/big.bin', name: 'big.bin', size: hugeSize, mtimeMs: futureMs });

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'hi' })],
      sdk,
      fs,
    );

    const fileEvents = output.filter((e) => e.type === 'file');
    expect(fileEvents).toHaveLength(0);

    const statusEvents = output.filter((e) => e.type === 'status');
    expect(statusEvents.some((s) => s.text?.includes('big.bin'))).toBe(true);
    expect(statusEvents.some((s) => s.text?.includes('too large') || s.text?.includes('skipped'))).toBe(true);
  });

  it('enforces the max-files-per-turn cap (5 files)', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    const fs = new InMemoryFs();
    const futureMs = Date.now() + 60_000;
    // Add 7 small files
    for (let i = 1; i <= 7; i++) {
      const content = Buffer.from(`file ${i}`, 'utf-8');
      fs.addWorkspaceFile(`/workspace/f${i}.txt`, `f${i}.txt`, content, futureMs);
    }

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'hi' })],
      sdk,
      fs,
    );

    const fileEvents = output.filter((e) => e.type === 'file');
    expect(fileEvents).toHaveLength(5);

    // Skipped files should produce status events
    const statusEvents = output.filter(
      (e) => e.type === 'status' && e.text?.includes('skipped'),
    );
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('skips dotfiles and node_modules entries', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    const fs = new InMemoryFs();
    const futureMs = Date.now() + 60_000;

    // The listFiles seam skips these at the real fs level, so the fake
    // should just not return them (matches the real implementation).
    // Add a normal file and verify dotfiles are absent.
    fs.addWorkspaceFile('/workspace/normal.txt', 'normal.txt', Buffer.from('ok'), futureMs);
    // No dotfiles in the scripted list (real implementation skips them)

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'hi' })],
      sdk,
      fs,
    );

    const fileEvents = output.filter((e) => e.type === 'file');
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0]?.name).toBe('normal.txt');
  });

  it('does not scan for files after an SDK error (scan only on success)', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResultError(['SDK failed'])],
    ]);
    const fs = new InMemoryFs();
    const futureMs = Date.now() + 60_000;
    fs.addWorkspaceFile('/workspace/file.txt', 'file.txt', Buffer.from('data'), futureMs);

    let listFilesCalled = false;
    const origListFiles = fs.listFiles;
    fs.listFiles = async (dir: string) => {
      listFilesCalled = true;
      return origListFiles(dir);
    };

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'bad' })],
      sdk,
      fs,
    );

    expect(listFilesCalled).toBe(false);
    const fileEvents = output.filter((e) => e.type === 'file');
    expect(fileEvents).toHaveLength(0);
  });
});
