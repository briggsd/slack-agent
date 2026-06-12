/**
 * Unit tests for runner/src/main.ts (the container entry point).
 *
 * Uses a FakeAgentSdk (scripted async generator) and in-memory fs seam
 * (inject read/write fns). All offline — no Docker, no real Agent SDK.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { runLoop } from '../src/main.js';
import type { ReadFileFn, WriteFileFn, MkdirFn, SdkQueryFn } from '../src/main.js';
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

  readFile: ReadFileFn = async (path) => {
    return this.files.get(path) ?? null;
  };

  writeFile: WriteFileFn = async (path, data) => {
    this.files.set(path, data);
  };

  mkdir: MkdirFn = async () => {
    // no-op
  };

  get(path: string): string | undefined {
    return this.files.get(path);
  }

  set(path: string, value: string): void {
    this.files.set(path, value);
  }
}

// ── Test harness ──────────────────────────────────────────────────────────────

type CollectedOutput = Array<{
  type: string;
  id?: string;
  text?: string;
  message?: string;
}>;

async function runWithInput(
  lines: string[],
  sdk: FakeAgentSdk,
  fs: InMemoryFs = new InMemoryFs(),
): Promise<CollectedOutput> {
  const input = new PassThrough();
  const outputs: CollectedOutput = [];

  // Intercept process.stdout.write
  const origWrite = process.stdout.write.bind(process.stdout);
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
