# Task: Add a SAFE structured `errorClass` to runner errors so `runner_error` is diagnosable from the gateway

You are implementing one slice in this repo (TypeScript, Node 20+, ESM, vitest, strict
tsc). **Read the root `CLAUDE.md` and `runner/CLAUDE.md` first** (gate, invariants,
conventions), then the context below. You are on branch
`sonnet/8ebf72-runner-error-class`. **Do ALL work in this checkout** — it is an
APFS clone at `/Users/jedanner/.agent-clones/slack-agent-5d78a1f8/sa-8ebf72` with its
own `node_modules` (already present — no install needed).

> NOTE: this checkout carries some pre-existing modified/untracked files (`.gitignore`,
> `.claude/skills/...`, `planning/m6-*.md`, `scripts/smoke-*.mjs`). They are NOT yours —
> leave them alone. Do not stage or revert them.

## Context — the bug

When a turn dies inside the container, the runner emits a protocol `error` message and the
gateway maps it to `reason: 'runner_error'`. The gateway then **nulls** the message out of
its logs and audit ledger (`src/sessions/manager.ts` ~lines 935-955) — correctly, because
`error.message` is relayed verbatim from inside the container and is untrusted (it could
echo prompt/tool/file content). The cost: **total opacity** — an operator sees only
`[session] turn error (runner_error) <key>` and cannot tell a max-turns exhaustion from a
budget cap from an SDK crash. A real live run (2026-06-27) died this way with zero signal.

**Fix:** the runner classifies each error into a **closed, content-free enum** derived from
typed signals (SDK result subtype / caught error type — never free text), and sends it as a
new optional `errorClass` field on the protocol `error` message. The gateway **validates it
against the closed set** (container output is data — never trust an unvalidated string) and,
when valid, logs + audits it. The `message` field stays nulled exactly as today.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND `npm run gate`
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding after
only exploring (zero file changes) is a failure — implement end to end in this run.

## CRITICAL — ground API usage, don't recall it

The SDK error types below are quoted from
`runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. Use only symbols you can
point to there. If reality differs, follow the real API and note it in your report.

- `SDKResultError.subtype`: `'error_during_execution' | 'error_max_turns' |
  'error_max_budget_usd' | 'error_max_structured_output_retries'` (sdk.d.ts ~line 3848).
- `AbortError` is an exported class: `export declare class AbortError extends Error`
  (sdk.d.ts line 17), importable from `@anthropic-ai/claude-agent-sdk`.

## The enum (decided — do not redesign)

A closed union, every value backed by a typed signal or a specific emit site:

```ts
export type RunnerErrorClass =
  | 'max_turns'        // result.subtype === 'error_max_turns'
  | 'budget_exceeded'  // result.subtype === 'error_max_budget_usd'
  | 'output_retries'   // result.subtype === 'error_max_structured_output_retries'
  | 'execution_error'  // result.subtype === 'error_during_execution' (SDK catch-all)
  | 'no_result'        // stream ended with no result event
  | 'aborted'          // err instanceof AbortError in the outer catch
  | 'malformed_input'  // a malformed input line could not be parsed
  | 'unknown';         // any other thrown error
```

## Where to change it

### 1. Protocol — BOTH copies, byte-identical (`src/runner/protocol.ts` ≡ `runner/src/protocol.ts`)

- Define and export `RunnerErrorClass` (the union above) in `protocol.ts`.
- Add an **optional** field to `ErrorMessage`:
  ```ts
  export type ErrorMessage = {
    type: 'error';
    id: string;
    message: string;
    errorClass?: RunnerErrorClass;  // safe closed enum; absent on legacy/unknown
  };
  ```
- `exactOptionalPropertyTypes` is on — make it genuinely optional (never set to `undefined`).
- **Edit both files identically in the same change.** The gate runs a byte-identical check
  conceptually; a drift breaks the contract. Copy-paste the exact same text into both.

### 2. Runner — classify at each emit site (`runner/src/main.ts`)

There are FOUR `emit({ type: 'error', ... })` sites. Add the right `errorClass` to each:

- **Result-error path** (~line 974, where `turnError` is set from a non-success `result`
  event): capture the class alongside `turnError`. Add a small **pure exported helper**
  ```ts
  export function classifyResultError(subtype: string): RunnerErrorClass
  ```
  mapping the four `SDKResultError` subtypes per the table above; any unrecognized subtype →
  `'execution_error'` (the SDK catch-all is the safest default for an unknown result error,
  NOT `'unknown'` — we know it was a result error). Store the class in a `turnErrorClass`
  variable next to `turnError`, and pass it on the emit at ~line 1013.
- **`'no result received from SDK'`** (~line 1019): `errorClass: 'no_result'`.
- **Outer `catch (err)`** (~line 1024): `errorClass: err instanceof AbortError ? 'aborted'
  : 'unknown'`. Import `AbortError` from `@anthropic-ai/claude-agent-sdk` (alongside the
  existing `query, tool, createSdkMcpServer` import).
- **Malformed input** (~line 744, `id: 'unknown'`): `errorClass: 'malformed_input'`.

Keep the `message` exactly as it is today on every site — you are ADDING a field, not
changing existing text.

### 3. Gateway — validate, then thread + log + audit

- **`src/runner/types.ts`**: the `RunnerEvent` error variant gains the field:
  `| { type: 'error'; message: string; reason: ErrorReason; errorClass?: RunnerErrorClass }`.
  Import `RunnerErrorClass` from `./protocol.js` (types.ts already imports cross-module).
- **`src/runner/docker.ts`**:
  - Extend the `errorEvent` helper (~line 211) to accept an optional validated class:
    `private errorEvent(message: string, reason: ErrorReason, errorClass?: RunnerErrorClass): RunnerEvent`
    — include `errorClass` in the returned object only when defined.
  - At the wire-parse site (~line 829-830, `parsed.type === 'error' && parsed.id === id`):
    **validate `parsed.errorClass` against the closed set** before passing it through. Add a
    pure type-guard `isRunnerErrorClass(x: unknown): x is RunnerErrorClass` (a `Set`/array
    `includes` over the 8 literals) — define it in `protocol.ts` next to the type and export
    it (so BOTH copies have it, byte-identical), or in a small gateway util if you prefer it
    gateway-only; **prefer protocol.ts** so the closed set lives in one authored place. Then:
    `yield self.errorEvent(parsed.message, 'runner_error', isRunnerErrorClass(parsed.errorClass) ? parsed.errorClass : undefined);`
  - This is the SECURITY crux: an unvalidated `errorClass` off the wire could inject
    arbitrary text into logs/audit. Only a value in the closed set may pass. This is why it's
    safe to log/audit `errorClass` while `message` stays nulled.
  - The OTHER `errorEvent(...)` calls in docker.ts are gateway-internal infra errors
    (`'runner is disposed'`, `'runner stdin is not writable'`) — leave them with no
    `errorClass` (undefined). Do not invent classes for them.
- **`src/sessions/manager.ts`** (~lines 935-955, the `event.type === 'error'` branch):
  - `errorClass` is a **trusted** validated enum (unlike `message`). For the log line and
    the audit `summary`, use it as the safe detail.
  - Concretely: the audit `summary` currently becomes `null` for `runner_error`. Change it so
    `summary` = the safe class when present. Define a `safeClass = event.errorClass ?? null`
    and set audit `summary: safeClass` (still null `message`, never the relayed text). For
    `timeout`/`container_exit` reasons, keep today's behavior (those messages are
    gateway-generated and already safe — do NOT regress them; `safeDetail` for them stays
    `event.message`). Net: `summary` carries `event.message` for the gateway-generated
    reasons and `event.errorClass` (or null) for `runner_error`.
  - The log line: include the class for a `runner_error` when present, e.g.
    `[session] turn error (runner_error) <key>: <errorClass>`. Never include `event.message`
    for `runner_error` (keep the existing redaction).
  - The Slack post (`tryUpdate(`:x: Error: ${event.message}`)`) is UNCHANGED — the user still
    sees full detail in their own thread.

## Acceptance criteria

1. `npm run gate` passes (tsc + runner type-check + vitest + boundaries); paste the real tail.
2. `RunnerErrorClass` + `isRunnerErrorClass` defined and exported identically in BOTH
   `protocol.ts` copies; `ErrorMessage` gains optional `errorClass` in both.
3. `runner/src/main.ts`: all four error emits carry the correct `errorClass`;
   `classifyResultError` exported and maps the four subtypes (+ catch-all `execution_error`).
4. Gateway: `RunnerEvent` error variant + `errorEvent` helper carry `errorClass`; the
   wire-parse site **validates** via `isRunnerErrorClass` (a bogus class becomes `undefined`).
5. `manager.ts` logs + audits the validated `errorClass` for `runner_error`
   (audit `summary` = the class, not null), while `message` is still never logged/audited.

## Tests (front-loaded — this is the failure locus; do not skip)

- **Runner** (`runner/test/runner-main.test.ts`): there's an existing `makeSdkResultError`
  helper (~line 99) that builds a `result` with `subtype: 'error_during_execution'`, and the
  FakeAgentSdk harness drives turns. Add tests that:
  - drive a result error with each of the four subtypes and assert the emitted `error`
    message carries the mapped `errorClass` (`error_max_turns` → `max_turns`, etc.). Add a
    parametrized helper (e.g. `makeSdkResultErrorSubtype(subtype)`) if it helps — mirror the
    existing `makeSdkResultError`.
  - a unit test of `classifyResultError` directly for all four + an unrecognized subtype →
    `'execution_error'`.
- **Gateway docker** (`test/docker.test.ts`): feed a wire `error` line and assert the emitted
  `RunnerEvent` carries `errorClass`; feed one with a **bogus** `errorClass` (e.g.
  `"errorClass":"haxx"`) and assert the emitted event has `errorClass` undefined (validation
  dropped it). Use the existing docker test harness/fakes.
- **Gateway manager** (`test/manager.test.ts`): MIRROR the existing test
  *"redacts a runner_error message from logs + audit ..."* (~line 2185). Add a sibling that
  emits `{ type: 'error', message: relayed, reason: 'runner_error', errorClass: 'max_turns' }`
  and asserts: the audit `error` row has `summary: 'max_turns'` (NOT null), the log line is
  `[session] turn error (runner_error) TEAM:C:T: max_turns`, the relayed `message` still never
  appears in logs/audit, and the Slack post is still `:x: Error: ${relayed}`.
  - Also keep a case with NO `errorClass` (legacy) asserting `summary: null` (today's behavior
    preserved — the field is optional/back-compatible).

## Hard constraints (do NOT violate)

- Gate must pass; no `any`, no `@ts-ignore`; NodeNext ESM (`.js` specifiers); strict +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- **`protocol.ts` two copies stay byte-identical** — edit both in lockstep.
- **`@slack/bolt` only in `src/index.ts`**; gateway never imports the Agent SDK or `runner/`.
- **Treat container output as data** — the gateway MUST validate `errorClass` against the
  closed set; an out-of-set value is dropped to `undefined`. This is non-negotiable (it's the
  whole reason the class is safe to log while `message` is not).
- **Never log message contents or tokens** — `errorClass` (a closed enum) is safe; the
  relayed `message` is not. Do not regress the existing `runner_error` message redaction.
- Add no dependencies. **Do NOT commit.** Do NOT edit this spec file. Do NOT touch the
  pre-existing dirty files noted at the top.

## Out of scope (do NOT build)

- Finer API-error classes (`rate_limit`, `overloaded`, `context_overflow`): they require
  observing assistant-error / rate-limit events the runner doesn't currently capture, or
  parsing free text — a separate future slice. The 8-value set above is the whole scope.
- OOM: it kills the process → surfaces as `reason: 'container_exit'`, a different path; not
  part of `runner_error`.
- Any audit DB/schema/migration change — reuse the existing `summary` field.

## When done — report precisely (with REAL command output)

- Each file changed, one line each (expect ~6 source files + 3 test files).
- The real tail of `npm run gate` (vitest pass count + boundaries result).
- Confirm the two `protocol.ts` copies are byte-identical (e.g. `diff` them and say so).
- Any deviation from this spec and why.
