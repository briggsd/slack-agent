# Task: surface malformed-protocol-line skips as a console line + an audit row (`kind:'protocol_skip'`)

You are implementing one slice in this worktree (TypeScript, Node 20+, ESM, vitest,
strict tsc). **Read the root `CLAUDE.md` first** (gate, invariants, conventions), then
the context below. You are on branch `sonnet/d185bd-protocol-skip`.

Tracks `track d185bd` (M7 telemetry, "Telemetry T2: surface malformed-protocol-line
skips — session context + audit, not silent continue").

## Context — read before writing code

Today the gateway's protocol-read loop in `src/runner/docker.ts` silently drops two
classes of bad lines from a container with a bare `continue` — no log, no telemetry.
A container bug or corruption is therefore invisible. This slice makes those two skips
observable: a metadata-only `console.error` **and** a queryable audit row.

The decided design (already settled — do not re-litigate): a new **gateway-internal**
`RunnerEvent` of `type:'protocol_skip'` that the manager's drain loop turns into an
audit row of `kind:'protocol_skip'`. This is NOT a wire/protocol change — it never
crosses the container boundary, so **`protocol.ts` is NOT touched**.

**Your end-to-end template is the `decision` event (PR #69).** It is the exact same
shape of change — a gateway-internal `RunnerEvent` that docker.ts emits and the manager
audits — so mirror how it is plumbed at every layer. Find it and follow it:

- `src/runner/types.ts:33` — the `decision` variant of the `RunnerEvent` union.
- `src/runner/docker.ts:425-440` — where docker.ts validates + yields the `decision`
  event inside the read loop.
- `src/sessions/manager.ts:903-918` — the `else if (event.type === 'decision')` branch
  in the drain loop: a `console.log` (metadata only) + a `this.audit({...})` call.
- `src/sessions/store.ts:63` — the `AuditEvent.kind` union (a plain text column).
- `src/sessions/manager.ts:1320` — the `private audit(...)` helper you call.

The two silent skip sites you are fixing (cover BOTH, and ONLY these two):

1. `src/runner/docker.ts:393-399` — the `JSON.parse(rawLine)` `try/catch`. The `catch`
   currently does `// Skip unparseable lines` + `continue`. → reason `'json_parse'`.
2. `src/runner/docker.ts:425-433` — inside `parsed.type === 'decision' && parsed.id === id`,
   the field-validation block whose failure path is `continue`. → reason `'decision_invalid'`.

**Do NOT touch** the other `continue`/`console.error` skip branches (`request_approval`,
`request_clone`, `request_build`, `request_exec`, `request_publish`, `request_pr_edit`,
`request_pr_comment`) — they already log, and they are out of scope (see below).

`rawLine` (the loop variable from `docker.ts:377`) is in scope at BOTH skip sites, so
both can compute the byte length.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND `npm run gate`
passes. Make every edit, add/adjust tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure — implement end to end
in this run.

## The change, layer by layer

### 1. `src/runner/types.ts` — new gateway-internal event variant

Add, near the `decision` variant (~line 33), a `ProtocolSkipReason` type and a new
`RunnerEvent` variant. Give it a comment matching the house style of the neighbouring
"gateway-internal" variants (note: never crosses the container boundary; recorded as
data; does NOT terminate the stream):

```ts
export type ProtocolSkipReason = 'json_parse' | 'decision_invalid';
// ... inside the RunnerEvent union:
  | { type: 'protocol_skip'; reason: ProtocolSkipReason; bytes: number }
```

`bytes` is a content-free size signal only — never the line content (trust boundary).

### 2. `src/runner/docker.ts` — yield the event at both skip sites

At **site 1** (the `JSON.parse` catch, ~396): before `continue`, `yield self.errorEvent`-style
— but it's NOT an error (errors are terminal and `break`). Yield the new non-terminal
event, then `continue`:

```ts
} catch {
  yield { type: 'protocol_skip', reason: 'json_parse', bytes: Buffer.byteLength(rawLine, 'utf8') } as RunnerEvent;
  continue;
}
```

At **site 2** (the decision field-validation `continue`, ~432): replace the bare
`continue` with the same yield, reason `'decision_invalid'`, then `continue`. `rawLine`
is in scope here.

Use `Buffer.byteLength(rawLine, 'utf8')` (honest byte count; `Buffer` is already used in
this file). Do NOT log the line content anywhere in docker.ts.

### 3. `src/sessions/manager.ts` — drain-loop branch + audit

Add an `else if (event.type === 'protocol_skip')` branch alongside the non-terminal data
events (place it right after the `decision` branch, ~line 918, BEFORE the `error`
branch). It must be **non-terminal**: no `break`, no `captured = ...` assignment —
mirror the `usage`/`decision` branches, NOT the `error` branch.

- A metadata-only `console.error` with session context (mirror the `decision` branch's
  `console.log` and the `error` branch's `console.error` format). Content-free — session
  key + reason + bytes only, e.g.:
  `[session] protocol skip (${event.reason}) ${session.key}: ${event.bytes}b`
- A `this.audit({...})` call mapping:
  - `session_key: session.key`
  - `team_id: session.teamId ?? null`
  - `user_id: session.requestorUserId ?? null`
  - `profile_id: session.profileId`
  - `kind: 'protocol_skip'`
  - `tool: null`
  - `result: event.reason` (mirrors how `error` puts its `reason` in `result` and
    `decision` puts its `verdict` in `result`)
  - `summary: \`${event.bytes}b\`` (content-free metadata only)

Leave `reasoning`/cost/duration fields unset (the `audit` helper defaults them to null).

**Exhaustiveness:** if `tsc` flags any other `RunnerEvent` consumer with an exhaustive
`switch`/`if` chain that now misses `protocol_skip` (e.g. in the one-shot path or
responder), handle it as a no-op (ignore the event) — do not invent behaviour. Let `tsc`
tell you; do not pre-emptively hunt.

### 4. `src/sessions/store.ts` — extend the `kind` union

Add `'protocol_skip'` to the `AuditEvent.kind` union at line 63 (keep the list
alphabetical — it currently is). **No migration**: `kind` is an existing text column;
this is a type-only widening. Do not add or alter any `ALTER`/`CREATE` SQL.

## Acceptance criteria

1. `npm run gate` passes (= `npm run check` + `npm run boundaries`): tsc + runner
   type-check + vitest all green, dependency-cruiser clean. All existing tests keep
   passing (with the one deliberate update in #5 below), plus the new ones.
2. A line that fails `JSON.parse` in the docker read loop yields exactly one
   `{ type: 'protocol_skip', reason: 'json_parse', bytes: N }` (N > 0) and the turn
   still drains normally to its terminal `text`.
3. A `type:'decision'` line with invalid fields (e.g. `verdict:'maybe'`) yields exactly
   one `{ type: 'protocol_skip', reason: 'decision_invalid', bytes: N }` and the turn
   still drains normally — it must NOT yield a `decision` event and must NOT be fatal.
4. When the manager drains a `protocol_skip` event, it records an audit row with
   `kind:'protocol_skip'`, `result:` the reason, `summary:` the `${bytes}b` string,
   `tool:null`, and the session's `profile_id` — and the turn is NOT terminated (no
   error/abandoned outcome from the skip alone).
5. `protocol.ts` is untouched (`git diff --stat` shows neither copy).

## Tests — front-loaded; this is where slices fail. Add ALL of these.

Use the existing fakes/harnesses; do not mock the world.

**(a) `test/docker-decision.test.ts`** is your docker-side harness precedent — it already
has `FakeChildProcess`, `makeReadyRunner()`, `turnId()`, `tick()`, and drives a turn via
`runner.send(...)[Symbol.asyncIterator]()`, feeding lines with `fake.writeOut(...)`.

- **UPDATE the existing test** `'skips a malformed decision line (treat container output
  as data) and keeps draining'` (~line 90): it currently asserts the bad decision line
  produces NO event before the terminal text. That is now wrong — the malformed decision
  line yields a `protocol_skip` event. Update it to assert the first yielded value is
  `{ type: 'protocol_skip', reason: 'decision_invalid', bytes: <expect.any(Number)> }`,
  then the terminal `{ type: 'text', text: 'done' }`, then `done`. (Match its existing
  assertion style — `toEqual` against the yielded `.value`.)
- **ADD a test** for the `json_parse` site: after the turn starts, `fake.writeOut('not json{')`
  (a deliberately unparseable line — `writeOut` appends the newline), assert the first
  yielded value is `{ type: 'protocol_skip', reason: 'json_parse', bytes: <a number > 0> }`,
  then feed a valid terminal `text` line and assert the turn drains to it and then `done`.

  You may add these to `test/docker-decision.test.ts` (rename the `describe` if apt) or a
  new `test/docker-protocol-skip.test.ts` reusing the same harness shape — your call;
  keep it consistent with the repo.

**(b) `test/manager.test.ts`** — the audit-emission precedent is the two tests at ~line
1451 (`'audits a decision row ...'`). They use the `DecisionRunner` fake (line 1260) — a
`SessionRunner` that yields a fixed `RunnerEvent[]` — plus `CapturingStore` (line 966,
whose `.audits` array captures every `recordAudit`), driven via `manager.enqueueNew(...)`.

- **ADD a test**: build a factory whose runner yields a `protocol_skip` event (reuse
  `DecisionRunner` directly — it yields whatever `RunnerEvent[]` you pass; or add a
  tiny analogous fake if you prefer a clearer name), e.g.
  `[{ type: 'protocol_skip', reason: 'json_parse', bytes: 9 }]`. After `enqueueNew`,
  assert `store.audits.filter(a => a.kind === 'protocol_skip')` has length 1 and the row
  `toMatchObject({ result: 'json_parse', summary: '9b', tool: null, profile_id: <the
  session's profile_id used by the other tests> })`. Also assert the turn did not produce
  a PR / error outcome from the skip (mirror the existing tests' `store.pullRequests`
  check where relevant).

**(c) `test/store.test.ts`** — mirror the round-trip test at line 242
(`'recordAudit + getAuditEvents round-trip ...'`): `recordAudit` an `AuditEvent` with
`kind:'protocol_skip'`, `result:'json_parse'`, `summary:'42b'`, then `getAuditEvents`
and assert the row's `kind`/`result`/`summary` survive the round-trip.

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the **real tail** of its output when done (the
  pass/fail counts, not a paraphrase). Also paste `git diff --stat`.
- Conventions per root `CLAUDE.md`: **no `any`, no `@ts-ignore`**; `NodeNext` ESM
  (`.js` import specifiers); strict tsc; inject deps in tests (use the existing fakes).
- **Do NOT touch `protocol.ts`** (either copy) — this is gateway-internal, not a wire change.
- **Never log message contents or tokens** — the `console.error` and the audit `summary`
  carry session key + reason + byte count ONLY, never any slice of the line itself.
- No new dependencies.
- **Do NOT `git add -A`/`git add .`** and do NOT commit — leave the working tree for the
  coordinator to review. (The spec file is already committed as the branch's first commit.)

## Out of scope (do NOT build)

- The other malformed `request_*` skip branches in docker.ts — they already
  `console.error`; do not convert them to audit rows here (a later slice may, but not now).
- Lines that parse but match no branch / a different turn id (the silent fall-through) —
  out of scope; only the two named sites.
- Any DB migration, new audit column, or `AuditSink` fan-out (`track 927c5b`, separate).
- Surfacing skips to the Slack thread / user — telemetry only, no user-facing message.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each), including which test file(s) you added to.
- The real tail of `npm run gate` (pass/fail counts) and `git diff --stat`.
- Confirm the test count rose vs the 684-test baseline.
- Any deviation from this spec and why.
