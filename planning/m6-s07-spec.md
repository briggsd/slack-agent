# Task: spend-caps Slice A — record per-turn cost to the audit ledger (measurement only)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` and
`runner/CLAUDE.md` first** (gate, invariants, the two-copy `protocol.ts` rule), then
the context below. You are on branch `sonnet/m6-s07-spend-caps-measurement`, working
in this worktree (`../sa-wt-sonnet-m6-s07-spend-caps-measurement`).

## Context — read before writing code

This is **Slice A of spend caps** (M6 issue #22). The Agent SDK already computes a
per-turn dollar cost; the runner consumes the SDK `result` message but discards the
cost. This slice carries that cost across the gateway↔runner protocol and records it
to the existing `audit_events` table. **Measurement only — NO enforcement, no caps, no
limits, no env knobs.** That is Slice B.

Why it matters: spend is the last unguarded destructive axis (a runaway loop can torch
the API bill). Slice B will read `SUM(cost_micro_usd)` over `audit_events` as the
ledger and reject/abandon over a cap. This slice just makes the ledger get written.

Code this builds on (all line numbers verified at spec time):

- `src/runner/protocol.ts` + `runner/src/protocol.ts` — the **two byte-identical**
  copies of the NDJSON wire contract. You add a `usage` message to both.
- `src/runner/types.ts` — the gateway-internal `RunnerEvent` union (distinct from the
  wire protocol). `DockerRunner` translates wire→`RunnerEvent`; `FakeRunner` emits
  `RunnerEvent` directly; the manager drain loop consumes `RunnerEvent`.
- `runner/src/main.ts:228` — the SDK `result` handler (success + error). Currently
  captures `event.result` and discards `total_cost_usd` + `usage`.
- `src/runner/docker.ts:305–334` — parses wire NDJSON and yields `RunnerEvent`s.
- `src/sessions/store.ts` — `AuditEvent` interface (54–65), `createSchema()` (197–243),
  `recordAudit` statement (165–180) + method (271–284), `stmtGetAudit` (182–184).
- `src/sessions/manager.ts:366–445` — the drain loop (`if/else if` on `event.type`);
  the `audit()` helper (556–578).
- `src/runner/fake.ts` — `FakeRunner`, emits scripted `RunnerEvent`s.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end in this
run. You must NOT edit this spec file.

## CRITICAL — ground SDK usage, don't recall it

The SDK `result` event shape is **already grounded for you** below (read from
`runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`). Both `SDKResultSuccess`
and `SDKResultError` carry these fields, typed non-optional:

```
total_cost_usd: number;
usage: NonNullableUsage;   // .input_tokens, .output_tokens,
                           // .cache_creation_input_tokens, .cache_read_input_tokens — all `number`
```

So inside `if (event.type === 'result')` the narrowed `event` has both fields on either
subtype. Read them directly — no `any`, no cast, no optional chaining needed. Do not
invent other fields.

## The change, step by step

### 1. Wire protocol — add `UsageMessage` to BOTH copies, byte-identical

In **both** `src/runner/protocol.ts` AND `runner/src/protocol.ts`, add `UsageMessage`
to the `RunnerToGatewayMessage` union and define the type. Paste this **exactly** (same
bytes in both files):

Union becomes:

```ts
export type RunnerToGatewayMessage =
  | ReadyMessage
  | StatusMessage
  | FileMessage
  | TextMessage
  | UsageMessage
  | ErrorMessage;
```

New type — place it immediately **before** `ErrorMessage`'s definition:

```ts
/**
 * Per-turn cost + token usage. Emitted exactly once per user_message, just before
 * the terminal text/error — and on error/abandoned turns too, because they still
 * cost money. The gateway records this to the audit ledger as data; it is never
 * acted on as control. Dedicated (not bolted onto `text`) so turns that emit no
 * text still report cost.
 */
export type UsageMessage = {
  type: 'usage';
  id: string;
  /** Per-turn cost in integer micro-USD: round(total_cost_usd * 1e6). */
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};
```

After editing, the two files must be identical — verify with
`diff src/runner/protocol.ts runner/src/protocol.ts` (must print nothing).

### 2. Runner extraction (`runner/src/main.ts`)

- Add a local alongside `resultText` / `turnError` (near line 182):
  `let usageMsg: RunnerToGatewayMessage | null = null;`
- Inside the `if (event.type === 'result')` block (around 228–249), **before the
  `break`** and regardless of subtype (success or error), build the usage message:

  ```ts
  usageMsg = {
    type: 'usage',
    id,
    costMicroUsd: Math.round(event.total_cost_usd * 1e6),
    inputTokens: event.usage.input_tokens,
    outputTokens: event.usage.output_tokens,
    cacheReadTokens: event.usage.cache_read_input_tokens,
    cacheCreationTokens: event.usage.cache_creation_input_tokens,
  };
  ```

- After the SDK event loop, just before the existing `if (turnError !== null)` block
  (line 277), emit it if present:

  ```ts
  if (usageMsg !== null) {
    emit(usageMsg);
  }
  ```

  This emits usage on every turn that produced a `result` event (success OR error),
  ordered before the terminal text/error. The "no result received from SDK" path
  (`usageMsg` stays null) reports nothing — correct, there is no cost to report.
- Update the file's top doc comment (line ~5) that enumerates emitted message types to
  include `UsageMessage`.

### 3. Gateway-internal `RunnerEvent` (`src/runner/types.ts`)

Add a `usage` variant to the `RunnerEvent` union, placed **before** the `error`
variant (mirroring wire order):

```ts
// per-turn cost + tokens, emitted just before the terminal text/error (and on
// error/abandoned turns too — they still cost). Recorded to the audit ledger;
// never acted on as control. Does NOT terminate the stream.
| { type: 'usage'; costMicroUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
```

### 4. `DockerRunner` wire→event translation (`src/runner/docker.ts`)

In the dispatch chain (305–334), add a branch for `usage`, placed **before** the
`text`/`error` branches. It yields the internal event and **does NOT `break`** (the
turn continues until text/error):

```ts
} else if (parsed.type === 'usage' && parsed.id === id) {
  yield {
    type: 'usage',
    costMicroUsd: parsed.costMicroUsd,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheCreationTokens: parsed.cacheCreationTokens,
  } as RunnerEvent;
}
```

(Match the existing `as RunnerEvent` cast style already used in that block.)

### 5. Store — new `cost_micro_usd` column (`src/sessions/store.ts`)

The `audit_events` table is recreated on every boot (`DROP TABLE IF EXISTS` at
createSchema — see the S05 comment at ~220), so **no migration is needed**; just add
the column to the `CREATE TABLE`.

- **`AuditEvent` interface (54–65):** add after `cost_tokens`:
  `cost_micro_usd: number | null;`
- **`createSchema()` CREATE TABLE (226–238):** add a column after `cost_tokens`:
  `cost_micro_usd  INTEGER`
- **`stmtRecordAudit` (165–180):** add one more `number | null` to the bind tuple, add
  `cost_micro_usd` to the column list, add one more `?` to the VALUES list.
- **`recordAudit` method (271–284):** add `event.cost_micro_usd` as the final `.run()`
  argument (matching the new column position).
- **`stmtGetAudit` (182–184):** add `cost_micro_usd` to the explicit SELECT column list
  so round-trips return it.

### 6. Gateway — record cost on the `usage` event (`src/sessions/manager.ts`)

- **`audit()` helper (556–578):** extend it to carry `cost_micro_usd`. Add
  `'cost_micro_usd'` to the `Omit<AuditEvent, ...>` key list, add
  `cost_micro_usd?: number | null;` to the inline optional extension, and in the
  constructed `event` literal add `cost_micro_usd: partial.cost_micro_usd ?? null`.
- **Drain loop (366–445):** add a handler, placed **before** the `error` branch:

  ```ts
  } else if (event.type === 'usage') {
    // Slice A: record per-turn cost to the audit ledger. Measurement only — no
    // enforcement. Silent: no Slack post. Cost is metadata, never message content.
    this.audit({
      session_key: session.key,
      team_id: session.teamId ?? null,
      user_id: session.requestorUserId ?? null,
      kind: 'cost',
      tool: null,
      cost_tokens:
        event.inputTokens +
        event.outputTokens +
        event.cacheReadTokens +
        event.cacheCreationTokens,
      cost_micro_usd: event.costMicroUsd,
    });
  }
  ```

  `kind: 'cost'` already exists in the `AuditEvent` kind union — no type change there.
  `cost_tokens` holds the **total** token volume (input + output + cache read + cache
  creation); `cost_micro_usd` holds the dollar cost. This is a deliberate choice — the
  per-field breakdown rides the wire for future use but the table collapses tokens to a
  single total (the existing column), per design 0008's plumbing note.

### 7. `FakeRunner` emits `usage` (`src/runner/fake.ts`)

Make the **default** (no-script) turn emit a `usage` event, so the cost ledger is
exercised across the offline suite and the Slice-B cap path is testable. New default
event sequence per turn, in order: `status`, then `usage`, then the `text` echo:

```ts
const defaultEvents: RunnerEvent[] = [
  { type: 'status', text: 'processing…' },
  {
    type: 'usage',
    costMicroUsd: 1000,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  { type: 'text', text: `Echo: ${message}` },
];
```

(Scripted turns already gain `usage` for free now that `RunnerEvent` includes it —
tests can script a `usage` event directly.)

**Expected test fallout:** the new default `usage` event adds a `kind: 'cost'` row to
the captured audit stream in manager tests that use the default FakeRunner turn. Tests
that **filter by a specific kind** (most of them) are unaffected. Any test that asserts
an exact `audits.length` or the exact full set of audit events must be updated to
account for the cost row. **Do NOT weaken an assertion beyond accommodating the cost
row** — if a test breaks for any other reason, that is a real regression to fix, not to
paper over.

## Acceptance criteria

1. `npm run gate` passes (all existing tests keep passing, plus the new ones below).
   Run it from the worktree root.
2. `src/runner/protocol.ts` and `runner/src/protocol.ts` are **byte-identical** after
   your change (`diff` of the two prints nothing) and both define `UsageMessage` in the
   union.
3. A runner turn (success AND error) emits a `usage` NDJSON line carrying
   `costMicroUsd = round(total_cost_usd * 1e6)` and the four token counts, ordered
   before the terminal `text`/`error` line.
4. A `usage` `RunnerEvent` reaching the gateway drain loop writes one `audit_events`
   row with `kind='cost'`, `cost_micro_usd` set, `cost_tokens` = the token total, and
   `session_key`/`team_id`/`user_id` attributed from the session — and posts nothing to
   Slack.
5. `store.recordAudit` + `getAuditEvents` round-trips `cost_micro_usd` (a value and
   `null`).

### New tests (use the existing fakes/seams — no network, Slack, Docker, or API)

- **`runner/test/runner-main.test.ts`** — assert the runner emits a `usage` line with
  the correct `costMicroUsd` and token fields for a success result with **nonzero**
  `total_cost_usd` (e.g. `0.0123` → `costMicroUsd: 12300`), and that an error result
  also emits `usage`. Extend/parameterize the existing `makeSdkResult` /
  `makeSdkResultError` fakes (currently `total_cost_usd: 0`) — they already carry a
  valid `usage` block. Assert ordering: `usage` before `text`/`error`.
- **`test/store.test.ts`** — round-trip a `kind:'cost'` `AuditEvent` with a
  `cost_micro_usd` value through `recordAudit` + `getAuditEvents`; assert it returns
  intact, and that `null` round-trips as `null`.
- **`test/manager.test.ts`** — script a `usage` `RunnerEvent` (via the FakeRunner
  script) and assert exactly one `kind:'cost'` audit row is captured with the right
  `cost_micro_usd`/`cost_tokens` and session attribution, and that no Slack
  message/upload was triggered by it. Use the existing `CapturingStore` pattern
  (`test/manager.test.ts:682`).

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the **tail** of its real output when done
  (with pass/fail counts — not a paraphrase).
- `protocol.ts` edited in **both** copies, byte-identical (constraint #2 above).
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` import specifiers); inject deps in
  tests (no real Slack/Docker/API/network).
- **Never log message contents or tokens.** The cost numbers go to the DB only — do not
  add log lines that print token counts or cost, and the `usage` handler posts nothing
  to Slack.
- The gateway never imports the Agent SDK or the `runner/` package (boundary-enforced).
- Add no dependencies.
- Do NOT commit — leave the working tree for review. Do NOT edit this spec.

## Out of scope (do NOT build — these are Slice B / later)

- Any enforcement: no caps, limits, env knobs, `SUM`-over-ledger checks, admission
  rejection, or mid-task abandon. Record only.
- No new `audit_events` indexes (`(user_id, ts)` / `(ts)`) — those are Slice B.
- No SDK-native `maxTurns` / per-task budget knob.
- No per-team / soft-warn / queue behavior.
- Do not touch the `DROP TABLE IF EXISTS audit_events` line or the audit-persistence
  model (that the table is recreated each boot is a known Slice-B concern, not this
  slice's).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, with test counts).
- Confirm `diff src/runner/protocol.ts runner/src/protocol.ts` prints nothing.
- The baseline test count before your change vs after (so the coordinator can confirm
  tests were actually added).
- Any deviation from this spec and why.
