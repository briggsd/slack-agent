/**
 * Unit tests for heartbeat emission from runner/src/main.ts:
 * - includePartialMessages: true is forwarded to sdkQuery
 * - stream_event (SDKPartialAssistantMessage) emits a throttled heartbeat
 * - rapid stream_events within HEARTBEAT_THROTTLE_MS emit only one heartbeat
 * - stream_events beyond the throttle window emit another heartbeat
 * - partial content is never forwarded as text/status
 *
 * Clock notes: HEARTBEAT_THROTTLE_MS = 10_000ms. The throttle check is
 *   `now() - lastHeartbeatMs >= HEARTBEAT_THROTTLE_MS`
 * where lastHeartbeatMs is initialised to 0.
 * A first stream_event fires only if now() >= 10_000 — the implementation
 * assumes real-world timestamps (ms since epoch) which are always >> 10_000.
 * Tests inject a clock returning >= 20_000 to simulate this.
 *
 * All offline — no Docker, no real SDK, no network.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { runLoop } from '../src/main.js';
import type { ReadFileFn, WriteFileFn, MkdirFn, SdkQueryFn, ListFilesFn, ReadBinaryFileFn } from '../src/main.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';

// ── FakeAgentSdk (heartbeat-aware variant) ────────────────────────────────────

class FakeAgentSdk {
  private turns: SDKMessage[][];
  private turnIndex = 0;
  public calls: Array<{
    prompt: string;
    includePartialMessages?: boolean;
    disallowedTools?: string[];
  }> = [];

  constructor(turns: SDKMessage[][] = []) {
    this.turns = turns;
  }

  getQueryFn(): SdkQueryFn {
    const self = this;
    return (params) => {
      self.calls.push({
        prompt: params.prompt,
        includePartialMessages: params.options?.includePartialMessages,
        disallowedTools: params.options?.disallowedTools,
      });
      const idx = self.turnIndex++;
      const messages: SDKMessage[] = self.turns[idx] ?? [makeSdkResult('default')];
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

function makeSdkResult(text: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    session_id: 'session-hb',
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 9,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 5,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000001',
  };
}

/**
 * Build a minimal SDKPartialAssistantMessage (type: 'stream_event').
 * We only need the type discriminant; the runner inspects nothing else.
 * Verified: sdk.d.ts:3733 — SDKPartialAssistantMessage = { type: 'stream_event'; event; ... }.
 */
function makeSdkStreamEvent(): SDKMessage {
  return {
    type: 'stream_event',
    event: {} as BetaRawMessageStreamEvent, // runtime value irrelevant; runner only reads .type
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000099' as `${string}-${string}-${string}-${string}-${string}`,
    session_id: 'session-hb',
  };
}

// ── Minimal fs / no-op seam ───────────────────────────────────────────────────

function makeNoopFs(): {
  readFile: ReadFileFn;
  writeFile: WriteFileFn;
  mkdir: MkdirFn;
  listFiles: ListFilesFn;
  readBinaryFile: ReadBinaryFileFn;
} {
  return {
    readFile: async () => null,
    writeFile: async () => undefined,
    mkdir: async () => undefined,
    listFiles: async () => [],
    readBinaryFile: async () => null,
  };
}

// ── Test runner helper ────────────────────────────────────────────────────────

type CollectedLine = { type: string; [k: string]: unknown };

async function runWithMessage(
  turns: SDKMessage[][],
  nowFn?: () => number,
): Promise<{ outputs: CollectedLine[]; sdk: FakeAgentSdk }> {
  const sdk = new FakeAgentSdk(turns);
  const input = new PassThrough();
  const outputs: CollectedLine[] = [];

  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    const str = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of str.split('\n')) {
      const trimmed = line.trim();
      if (trimmed !== '') {
        try {
          outputs.push(JSON.parse(trimmed) as CollectedLine);
        } catch {
          // ignore non-JSON
        }
      }
    }
    return true;
  });

  try {
    const loopPromise = runLoop({
      ...makeNoopFs(),
      sdkQuery: sdk.getQueryFn(),
      input,
      ...(nowFn !== undefined ? { now: nowFn } : {}),
    });

    input.push(JSON.stringify({ type: 'user_message', id: 'msg-hb-1', text: 'hello' }) + '\n');
    input.push(null);

    await loopPromise;
  } finally {
    vi.restoreAllMocks();
  }

  return { outputs, sdk };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runner heartbeat — includePartialMessages', () => {
  it('passes includePartialMessages: true to sdkQuery options', async () => {
    const { sdk } = await runWithMessage([[makeSdkResult('done')]]);
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]?.includePartialMessages).toBe(true);
  });
});

describe('runner heartbeat — stream_event throttling', () => {
  it('first stream_event emits a heartbeat when clock is past HEARTBEAT_THROTTLE_MS (real-world behaviour)', async () => {
    // In production, now() ≈ Date.now() >> 10_000. Use 20_000 to simulate.
    // lastHeartbeatMs starts at 0. First check: 20_000 - 0 = 20_000 >= 10_000 → emit.
    const clock = (): number => 20_000;

    const { outputs } = await runWithMessage(
      [[makeSdkStreamEvent(), makeSdkResult('done')]],
      clock,
    );
    const heartbeats = outputs.filter((o) => o['type'] === 'heartbeat');
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({ type: 'heartbeat', id: 'msg-hb-1' });
  });

  it('rapid stream_events within HEARTBEAT_THROTTLE_MS emit only one heartbeat', async () => {
    // clock = 20_000 constant. First event: 20_000 - 0 >= 10_000 → emit, lastHeartbeatMs = 20_000.
    // Second event: 20_000 - 20_000 = 0 < 10_000 → skip.
    // Third event: 20_000 - 20_000 = 0 < 10_000 → skip.
    const clock = (): number => 20_000;

    const { outputs } = await runWithMessage(
      [[
        makeSdkStreamEvent(),
        makeSdkStreamEvent(),
        makeSdkStreamEvent(),
        makeSdkResult('done'),
      ]],
      clock,
    );
    const heartbeats = outputs.filter((o) => o['type'] === 'heartbeat');
    expect(heartbeats).toHaveLength(1);
  });

  it('no heartbeat emitted when stream_events arrive at time 0 (below throttle threshold)', async () => {
    // clock = 0 constant. lastHeartbeatMs = 0. Check: 0 - 0 = 0 < 10_000 → no emit.
    // This tests the throttle lower bound.
    const clock = (): number => 0;

    const { outputs } = await runWithMessage(
      [[makeSdkStreamEvent(), makeSdkStreamEvent(), makeSdkResult('done')]],
      clock,
    );
    const heartbeats = outputs.filter((o) => o['type'] === 'heartbeat');
    expect(heartbeats).toHaveLength(0);
  });

  it('stream_event after throttle window fires a second heartbeat', async () => {
    // processTurn calls now() once for turnStartMs before the event loop, then:
    //   - twice per firing stream_event (condition check + lastHeartbeatMs update)
    //   - once per skipping stream_event (condition check only)
    // Full call sequence for 3 events (fire, skip, fire):
    //   call 1: turnStartMs (value doesn't affect heartbeat logic)
    //   call 2: event 1 condition check → 20_000 (20_000-0 >= 10_000 → fires)
    //   call 3: event 1 lastHeartbeatMs update → 20_000
    //   call 4: event 2 condition check → 20_000 (20_000-20_000=0 < 10_000 → skips)
    //   call 5: event 3 condition check → 30_001 (30_001-20_000=10_001 >= 10_000 → fires)
    //   call 6: event 3 lastHeartbeatMs update → 30_001
    let callCount = 0;
    const times = [
      0,              // call 1: turnStartMs (irrelevant to heartbeat logic)
      20_000, 20_000, // call 2-3: event 1 fires, update
      20_000,         // call 4: event 2 skips (20_000-20_000=0 < 10_000)
      30_001, 30_001, // call 5-6: event 3 fires, update
    ];
    const clock = (): number => times[callCount++] ?? 30_001;

    const { outputs } = await runWithMessage(
      [[
        makeSdkStreamEvent(), // fires (20_000 - 0 >= 10_000)
        makeSdkStreamEvent(), // skips (20_000 - 20_000 = 0 < 10_000)
        makeSdkStreamEvent(), // fires (30_001 - 20_000 = 10_001 >= 10_000)
        makeSdkResult('done'),
      ]],
      clock,
    );
    const heartbeats = outputs.filter((o) => o['type'] === 'heartbeat');
    expect(heartbeats).toHaveLength(2);
  });

  it('partial content from stream_event is never forwarded as text or status', async () => {
    const clock = (): number => 20_000;

    const { outputs } = await runWithMessage(
      [[makeSdkStreamEvent(), makeSdkResult('the final text')]],
      clock,
    );

    // stream_event must not leak partial content as status or text
    const statusEvents = outputs.filter((o) => o['type'] === 'status');
    const textEvents = outputs.filter((o) => o['type'] === 'text');
    const heartbeatEvents = outputs.filter((o) => o['type'] === 'heartbeat');

    expect(statusEvents).toHaveLength(0);              // no partial content forwarded as status
    expect(heartbeatEvents).toHaveLength(1);           // one throttled heartbeat
    expect(textEvents).toHaveLength(1);                // final text unchanged
    expect(textEvents[0]?.['text']).toBe('the final text');
  });

  it('heartbeat carries no content — only type and id fields', async () => {
    const clock = (): number => 20_000;

    const { outputs } = await runWithMessage(
      [[makeSdkStreamEvent(), makeSdkResult('done')]],
      clock,
    );
    const heartbeat = outputs.find((o) => o['type'] === 'heartbeat');

    expect(heartbeat).toBeDefined();
    if (heartbeat !== undefined) {
      const keys = Object.keys(heartbeat);
      // Must have exactly type and id — no content fields (privacy invariant)
      expect(keys.sort()).toEqual(['id', 'type']);
      expect(heartbeat['type']).toBe('heartbeat');
      expect(typeof heartbeat['id']).toBe('string');
    }
  });
});
