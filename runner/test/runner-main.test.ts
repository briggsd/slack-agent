/**
 * Unit tests for runner/src/main.ts (the container entry point).
 *
 * Uses a FakeAgentSdk (scripted async generator) and in-memory fs seam
 * (inject read/write fns). All offline — no Docker, no real Agent SDK.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { runLoop, runBuildSpec, classifyResultError } from '../src/main.js';
import type { ReadFileFn, WriteFileFn, MkdirFn, SdkQueryFn, ListFilesFn, ReadBinaryFileFn, ScannedFile } from '../src/main.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// ── FakeAgentSdk ──────────────────────────────────────────────────────────────

type TurnResult = SDKMessage[];

class FakeAgentSdk {
  private turns: TurnResult[];
  private turnIndex = 0;
  public calls: Array<{ prompt: string; resume?: string; disallowedTools?: string[]; systemPrompt?: unknown }> = [];

  constructor(turns: TurnResult[] = []) {
    this.turns = turns;
  }

  getQueryFn(): SdkQueryFn {
    const self = this;
    return (params) => {
      self.calls.push({
        prompt: params.prompt,
        resume: params.options?.resume,
        disallowedTools: params.options?.disallowedTools,
        systemPrompt: params.options?.systemPrompt,
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

function makeSdkResultErrorSubtype(subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'): SDKMessage {
  return {
    type: 'result',
    subtype,
    errors: [`SDK error: ${subtype}`],
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
    uuid: '00000000-0000-0000-0000-000000000005',
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
  errorClass?: string;
  name?: string;
  data_base64?: string;
  size?: number;
  point?: string;
  verdict?: string;
  rationale?: string;
  correlationId?: string;
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

  it('disallows AskUserQuestion — it has no answer channel from the sandbox', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'msg-1', text: 'hello' })],
      sdk,
    );

    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]?.disallowedTools).toContain('AskUserQuestion');
  });

  it('appends verify-then-publish workflow guidance to the SDK system prompt', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'msg-1', text: 'hello' })],
      sdk,
    );

    const systemPrompt = sdk.calls[0]?.systemPrompt;
    expect(systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
    });
    expect(typeof systemPrompt).toBe('object');
    expect(systemPrompt).not.toBeNull();

    const append = (systemPrompt as { append?: unknown }).append;
    expect(typeof append).toBe('string');
    expect(append).toContain('SPEC.md');
    expect(append).toContain('diff');
    expect(append).toContain('refs/slack-agent/base...HEAD');
    expect(append).not.toContain('diff main...HEAD');
    expect(append).toContain('run_checks');
    expect(append).toContain('report_verification');
    expect(append).toContain('publish');
    expect(append).toContain('only after');
  });

  it('appends subagent delegation guidance to the SDK system prompt', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-subagent'), makeSdkResult('done', 'sess-subagent')],
    ]);
    await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'msg-subagent', text: 'hello' })],
      sdk,
    );

    const systemPrompt = sdk.calls[0]?.systemPrompt;
    expect(systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
    });

    const append = (systemPrompt as { append?: unknown }).append;
    expect(typeof append).toBe('string');
    expect(append).toContain('delegating');
    expect(append).toContain('subagent (the Task tool)');
    expect(append).toContain('context lean');
  });

  it('runBuildSpec tells the coordinator to report_verification before publish', async () => {
    const text = await runBuildSpec(
      'owner/repo',
      async () => 'Implement the slice',
      async () => ({ status: 'approved' }),
      async () => ({ ok: true }),
    );

    expect(text).toContain('report_verification');
    expect(text).toContain('Publish only after a pass verdict');
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

  it('emits errorClass malformed_input on unparseable input line', async () => {
    const sdk = new FakeAgentSdk([]);
    const output = await runWithInput(['not valid json at all }{'], sdk);

    const errorEvent = output.find((e) => e.type === 'error');
    expect(errorEvent?.errorClass).toBe('malformed_input');
  });

  it.each([
    ['error_during_execution', 'execution_error'],
    ['error_max_turns', 'max_turns'],
    ['error_max_budget_usd', 'budget_exceeded'],
    ['error_max_structured_output_retries', 'output_retries'],
  ] as const)('emits errorClass %s → %s for SDK result subtype', async (subtype, expectedClass) => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResultErrorSubtype(subtype)],
    ]);
    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'go' })],
      sdk,
    );

    const errorEvent = output.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.errorClass).toBe(expectedClass);
  });
});

describe('runner main — classifyResultError', () => {
  it('maps all four SDK subtypes to the correct class', () => {
    expect(classifyResultError('error_max_turns')).toBe('max_turns');
    expect(classifyResultError('error_max_budget_usd')).toBe('budget_exceeded');
    expect(classifyResultError('error_max_structured_output_retries')).toBe('output_retries');
    expect(classifyResultError('error_during_execution')).toBe('execution_error');
  });

  it('maps an unrecognised subtype to execution_error (SDK catch-all)', () => {
    expect(classifyResultError('some_future_subtype')).toBe('execution_error');
    expect(classifyResultError('')).toBe('execution_error');
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

  it('skips oversized files and emits a single summary status event', async () => {
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

    // Exactly one skip summary status — no per-file name in output
    const skipStatuses = output.filter((e) => e.type === 'status' && e.text?.includes('not delivered'));
    expect(skipStatuses).toHaveLength(1);
    expect(skipStatuses[0]?.text).toMatch(/too large/);
    // Summary must NOT include individual filenames
    expect(skipStatuses[0]?.text).not.toContain('big.bin');
  });

  it('enforces the max-files-per-turn cap (5 files) — single summary status', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    const fs = new InMemoryFs();
    const futureMs = Date.now() + 60_000;
    // Add 7 small files — 5 should be forwarded, 2 skipped
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

    // Exactly ONE summary status — not one per skipped file
    const skipStatuses = output.filter((e) => e.type === 'status' && e.text?.includes('not delivered'));
    expect(skipStatuses).toHaveLength(1);
    expect(skipStatuses[0]?.text).toMatch(/5-file limit/);
    expect(skipStatuses[0]?.text).toContain('2 files not delivered');

    // No per-file "skipped file …" statuses remain
    const perFileSkips = output.filter((e) => e.type === 'status' && e.text?.startsWith('skipped file'));
    expect(perFileSkips).toHaveLength(0);
  });

  it('emits one summary status naming all fired reasons for a mix of skip types', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    const fs = new InMemoryFs();
    const futureMs = Date.now() + 60_000;
    // Add 5 small files to hit the count cap, plus one oversized file that would also be skipped
    for (let i = 1; i <= 5; i++) {
      const content = Buffer.from(`file ${i}`, 'utf-8');
      fs.addWorkspaceFile(`/workspace/f${i}.txt`, `f${i}.txt`, content, futureMs);
    }
    // This oversized file comes after the 5 small ones; fileCount cap hits first but
    // we add it to trigger skippedCountCap (since fileCount=5 before reading this)
    const hugeSize = 9 * 1024 * 1024;
    fs.workspaceFiles.push({ path: '/workspace/big.bin', name: 'big.bin', size: hugeSize, mtimeMs: futureMs });

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'hi' })],
      sdk,
      fs,
    );

    // All 5 small files forwarded
    const fileEvents = output.filter((e) => e.type === 'file');
    expect(fileEvents).toHaveLength(5);

    // One summary status for the skipped oversized file (hit count cap)
    const skipStatuses = output.filter((e) => e.type === 'status' && e.text?.includes('not delivered'));
    expect(skipStatuses).toHaveLength(1);
    // 1 file skipped due to count cap
    expect(skipStatuses[0]?.text).toMatch(/1 file not delivered/);
    expect(skipStatuses[0]?.text).toMatch(/5-file limit/);

    // No per-file skipped statuses
    const perFileSkips = output.filter((e) => e.type === 'status' && e.text?.startsWith('skipped file'));
    expect(perFileSkips).toHaveLength(0);
  });

  it('emits one summary status for an over-total-size skip', async () => {
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), makeSdkResult('done', 'sess-1')],
    ]);
    const fs = new InMemoryFs();
    const futureMs = Date.now() + 60_000;
    // Three files each "reported" as 6 MiB (under the 8 MiB per-file limit).
    // File 1 + File 2 total 12 MiB (< 16 MiB) → forwarded.
    // File 3 would push total to 18 MiB (> 16 MiB) → skipped by total cap.
    // Use a tiny dummy buffer for readBinaryFile and override the metadata size.
    const sixMiB = 6 * 1024 * 1024;
    const dummy = Buffer.from('x');
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      fs.addWorkspaceFile(`/workspace/${name}`, name, dummy, futureMs);
      // Override size so cap logic sees 6 MiB (addWorkspaceFile sets size = buffer.length)
      fs.workspaceFiles[fs.workspaceFiles.length - 1]!.size = sixMiB;
    }

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'm1', text: 'hi' })],
      sdk,
      fs,
    );

    // First two files forwarded (6+6=12 MiB); third skipped (12+6=18 MiB > 16 MiB)
    const fileEvents = output.filter((e) => e.type === 'file');
    expect(fileEvents).toHaveLength(2);

    const skipStatuses = output.filter((e) => e.type === 'status' && e.text?.includes('not delivered'));
    expect(skipStatuses).toHaveLength(1);
    expect(skipStatuses[0]?.text).toMatch(/byte total/);
    expect(skipStatuses[0]?.text).toContain('1 file not delivered');

    // No per-file skipped statuses
    const perFileSkips = output.filter((e) => e.type === 'status' && e.text?.startsWith('skipped file'));
    expect(perFileSkips).toHaveLength(0);
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

// ── Usage / cost measurement tests ───────────────────────────────────────────

describe('runner main — usage measurement', () => {
  it('emits a usage event with correct costMicroUsd for a success result with nonzero cost', async () => {
    const sdk = new FakeAgentSdk([
      [
        makeSdkInit('sess-1'),
        {
          ...makeSdkResult('hello', 'sess-1'),
          total_cost_usd: 0.0123,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 10,
            server_tool_use: { web_search_requests: 0 },
          },
        } as SDKMessage,
      ],
    ]);

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'msg-1', text: 'hello' })],
      sdk,
    );

    const usageEvent = output.find((e) => e.type === 'usage');
    expect(usageEvent).toBeDefined();
    expect(usageEvent?.id).toBe('msg-1');
    // 0.0123 * 1e6 = 12300
    expect((usageEvent as { costMicroUsd?: number })?.costMicroUsd).toBe(12300);
    expect((usageEvent as { inputTokens?: number })?.inputTokens).toBe(100);
    expect((usageEvent as { outputTokens?: number })?.outputTokens).toBe(50);
    expect((usageEvent as { cacheCreationTokens?: number })?.cacheCreationTokens).toBe(20);
    expect((usageEvent as { cacheReadTokens?: number })?.cacheReadTokens).toBe(10);
  });

  it('usage event is emitted before the terminal text event (ordering check)', async () => {
    const sdk = new FakeAgentSdk([
      [
        makeSdkInit('sess-1'),
        {
          ...makeSdkResult('answer', 'sess-1'),
          total_cost_usd: 0.001,
        } as SDKMessage,
      ],
    ]);

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'msg-1', text: 'hello' })],
      sdk,
    );

    const usageIdx = output.findIndex((e) => e.type === 'usage');
    const textIdx = output.findIndex((e) => e.type === 'text');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(usageIdx);
  });

  it('emits a usage event for an error result (errors still cost money)', async () => {
    const sdk = new FakeAgentSdk([
      [
        makeSdkInit('sess-1'),
        {
          ...makeSdkResultError(['something went wrong']),
          total_cost_usd: 0.005,
          usage: {
            input_tokens: 30,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 5,
            server_tool_use: { web_search_requests: 0 },
          },
        } as SDKMessage,
      ],
    ]);

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'msg-err', text: 'fail' })],
      sdk,
    );

    const usageEvent = output.find((e) => e.type === 'usage');
    expect(usageEvent).toBeDefined();
    expect(usageEvent?.id).toBe('msg-err');
    expect((usageEvent as { costMicroUsd?: number })?.costMicroUsd).toBe(5000);

    // usage must appear before the error event
    const usageIdx = output.findIndex((e) => e.type === 'usage');
    const errorIdx = output.findIndex((e) => e.type === 'error');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeGreaterThan(usageIdx);
  });

  it('does not emit a usage event when no result event is received from the SDK', async () => {
    // SDK never emits a result — simulates a crash before result
    const sdk = new FakeAgentSdk([[makeSdkInit('sess-1')]]);

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'msg-1', text: 'hello' })],
      sdk,
    );

    const usageEvents = output.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(0);
    // Should still emit an error (no result received)
    const errorEvent = output.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('emits a zero-cost usage event (not an error) when the SDK result omits usage', async () => {
    // Defensive path: the SDK types mark `usage` non-optional, but a shape drift that
    // dropped it must not turn an otherwise-successful result into an error. Build a
    // result with `usage` removed (no `any`, no @ts-ignore — a Record + delete).
    const base = makeSdkResult('survived', 'sess-1');
    const resultWithoutUsage = { ...base } as Record<string, unknown>;
    delete resultWithoutUsage.usage;
    const sdk = new FakeAgentSdk([
      [makeSdkInit('sess-1'), resultWithoutUsage as unknown as SDKMessage],
    ]);

    const output = await runWithInput(
      [JSON.stringify({ type: 'user_message', id: 'msg-1', text: 'hi' })],
      sdk,
    );

    // The successful result still produced its text...
    const textEvent = output.find((e) => e.type === 'text');
    expect((textEvent as { text?: string })?.text).toBe('survived');
    // ...plus a usage event with zeroed token counts (no crash).
    const usageEvent = output.find((e) => e.type === 'usage');
    expect(usageEvent).toBeDefined();
    expect((usageEvent as { inputTokens?: number })?.inputTokens).toBe(0);
    expect((usageEvent as { outputTokens?: number })?.outputTokens).toBe(0);
    expect((usageEvent as { cacheReadTokens?: number })?.cacheReadTokens).toBe(0);
    // And no error was emitted.
    expect(output.find((e) => e.type === 'error')).toBeUndefined();
  });
});

// ── Commit gate: mid-turn stdin demux (S10b) ──────────────────────────────────

/** Poll `probe` until it returns non-null, or throw after `timeoutMs`. */
async function waitFor<T>(probe: () => T | null, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = probe();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

describe('runner main — commit gate stdin demux', () => {
  /**
   * Drives the end-turn-and-resume flow: the first turn requests approval and completes, then a
   * later approval_verdict + user_message pair is delivered in that order so the next turn can
   * consume the persisted decision.
   */
  async function runGate(
    decision: { approved: boolean; feedback?: string },
  ): Promise<{ outputs: CollectedOutput; seenResults: Array<{ status: string; feedback?: string }> }> {
    const input = new PassThrough();
    const outputs: CollectedOutput = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      const str = typeof chunk === 'string' ? chunk : String(chunk);
      for (const piece of str.split('\n')) {
        const t = piece.trim();
        if (t !== '') {
          try {
            outputs.push(JSON.parse(t) as CollectedOutput[0]);
          } catch {
            // ignore non-JSON
          }
        }
      }
      return true;
    });

    const seenResults: Array<{ status: string; feedback?: string }> = [];
    let turnIndex = 0;
    const sdkQuery: SdkQueryFn = (params) => ({
      [Symbol.asyncIterator]: async function* () {
        yield makeSdkInit('sess-1');
        if (params.submitSpec === undefined) {
          throw new Error('submitSpec was not wired into the query');
        }
        const verdict = await params.submitSpec('SPEC TEXT');
        seenResults.push(verdict);
        turnIndex++;
        yield makeSdkResult(
          turnIndex === 1
            ? `first-turn:${verdict.status}`
            : verdict.status === 'approved'
              ? 'second-turn:approved'
              : `second-turn:${verdict.status}:${verdict.feedback ?? '(none)'}`,
          'sess-1',
        );
      },
    });

    const fs = new InMemoryFs();
    try {
      const loopPromise = runLoop({
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        mkdir: fs.mkdir,
        sdkQuery,
        listFiles: fs.listFiles,
        readBinaryFile: fs.readBinaryFile,
        input,
      });

      input.push(JSON.stringify({ type: 'user_message', id: 'u1', text: 'do a thing' }) + '\n');

      // Wait until the first turn has emitted request_approval, then resume on a later turn.
      const req = await waitFor(() => {
        const r = outputs.find((o) => o.type === 'request_approval') as
          | { id?: string; specRef?: string }
          | undefined;
        return r?.id !== undefined ? r : null;
      });
      const line: Record<string, unknown> = {
        type: 'approval_verdict',
        id: req.id,
        specRef: req.specRef,
        approved: decision.approved,
      };
      if (decision.feedback !== undefined) line['feedback'] = decision.feedback;
      input.push(JSON.stringify(line) + '\n');
      input.push(JSON.stringify({ type: 'user_message', id: 'u2', text: decision.approved ? 'approve' : 'needs changes' }) + '\n');
      input.push(null); // EOF

      await loopPromise;
    } finally {
      writeSpy.mockRestore();
    }

    return { outputs, seenResults };
  }

  it('first turn requests approval, then a later approving verdict is consumed on the next turn', async () => {
    const { outputs, seenResults } = await runGate({ approved: true });

    const req = outputs.find((o) => o.type === 'request_approval') as { specRef?: string } | undefined;
    expect(req?.specRef).toBe('SPEC TEXT');
    expect(seenResults).toEqual([{ status: 'requested' }, { status: 'approved' }]);
    expect(outputs.some((o) => o.type === 'text' && o.text === 'first-turn:requested')).toBe(true);
    expect(outputs.some((o) => o.type === 'text' && o.text === 'second-turn:approved')).toBe(true);
    expect(outputs.some((o) => o.type === 'error')).toBe(false);
  });

  it('later rejected feedback is consumed on the next turn without re-emitting request_approval', async () => {
    const { outputs, seenResults } = await runGate({ approved: false, feedback: 'make it faster' });

    expect(seenResults).toEqual([
      { status: 'requested' },
      { status: 'rejected', feedback: 'make it faster' },
    ]);
    expect(outputs.filter((o) => o.type === 'request_approval')).toHaveLength(1);
    expect(outputs.some((o) => o.type === 'text' && o.text === 'second-turn:rejected:make it faster')).toBe(true);
  });

  it('emits a one-way decision with the active build correlation id when verification is reported', async () => {
    const input = new PassThrough();
    const outputs: CollectedOutput = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      const str = typeof chunk === 'string' ? chunk : String(chunk);
      for (const piece of str.split('\n')) {
        const trimmed = piece.trim();
        if (trimmed !== '') {
          try {
            outputs.push(JSON.parse(trimmed) as CollectedOutput[0]);
          } catch {
            // ignore non-JSON
          }
        }
      }
      return true;
    });

    const sdkQuery: SdkQueryFn = (params) => ({
      [Symbol.asyncIterator]: async function* () {
        yield makeSdkInit('sess-verify');
        if (params.requestBuild === undefined || params.reportVerification === undefined) {
          throw new Error('build and verification callbacks must be wired');
        }
        const buildOutcome = await params.requestBuild('owner/repo');
        expect(buildOutcome).toEqual({ ok: true });
        await params.reportVerification({
          verdict: 'pass',
          rationale: 'Checked the diff, ran checks, and the remaining risk is acceptable.',
        });
        yield makeSdkResult('verified', 'sess-verify');
      },
    });

    const fs = new InMemoryFs();
    try {
      const loopPromise = runLoop({
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        mkdir: fs.mkdir,
        sdkQuery,
        listFiles: fs.listFiles,
        readBinaryFile: fs.readBinaryFile,
        input,
      });

      input.push(JSON.stringify({ type: 'user_message', id: 'u-verify', text: 'verify it' }) + '\n');
      const buildRequest = await waitFor(() => {
        const found = outputs.find((o) => o.type === 'request_build') as { id?: string } | undefined;
        return found?.id !== undefined ? found : null;
      });
      input.push(JSON.stringify({ type: 'build_result', id: buildRequest.id, ok: true }) + '\n');
      input.push(null);

      await loopPromise;
    } finally {
      writeSpy.mockRestore();
    }

    expect(outputs.find((o) => o.type === 'decision')).toEqual({
      type: 'decision',
      id: 'u-verify',
      point: 'verify',
      verdict: 'pass',
      rationale: 'Checked the diff, ran checks, and the remaining risk is acceptable.',
      correlationId: 'build-1',
    });
    expect(outputs.filter((o) => o.type === 'decision')).toHaveLength(1);
  });
});
