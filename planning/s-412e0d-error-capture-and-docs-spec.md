# Task: Capture structured error metadata at both catch sites + document the error model (412e0d)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent` (this is a
worktree of it; TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` and `runner/CLAUDE.md` first**, then the context below. You are on branch
`sonnet/runner-error-capture-and-docs`.

## Why (context — read before writing code)

A live turn failed with `:x: Unexpected error: An API error occurred: msg_too_long`
and we could not diagnose it, because **both error catch sites throw away the
error's structure** and keep only `err.message`:

- **Runner** (`runner/src/main.ts:1087-1091`): `const message = err.message; …
  errorClass = err instanceof AbortError ? 'aborted' : 'unknown'`. No status, no API
  error type, no `.cause` inspection — `msg_too_long` collapsed to `errorClass:
  'unknown'` + an opaque message.
- **Gateway** (`src/sessions/manager.ts:1234-1238`): `const msg = err.message;
  console.error('[session] error processing message in <key>: ' + msg)`. The
  confirmed landing site for `msg_too_long` — surfaces the raw message but captures
  nothing structured (no name/status/type/origin).

Investigation already ruled out the obvious cause: the agent runs on `claude-opus-4-8`
which has a **1M context window natively** (no beta), and a real context-window
overflow on a 4.5+ model surfaces as `stop_reason: 'model_context_window_exceeded'`,
**not** `msg_too_long`. So `msg_too_long` is some *other* API/SDK condition we have
not identified. This slice makes the **next** occurrence diagnosable, gives it a
real error class, and writes down the error model so we don't re-derive it.

`"An API error occurred: …"` is the Agent SDK's own wording (not in our code); the
gateway (`src/`) makes no Anthropic calls. The underlying Anthropic SDK error carries
structured fields — `err.status` (HTTP), `err.error?.type` / `err.type` (the API
error type string, e.g. `invalid_request_error`, `request_too_large`), `err.name`.
The Agent SDK may wrap it, so the original is often on `err.cause`.

### The redaction discipline (do NOT violate — this is the #80 invariant)

`errorClass` and structured metadata (`name`, `status`, `type`, `code`, the first
stack frame) are **content-free** and SAFE to log/audit. The error **message body**
is untrusted (it can echo prompt/tool/file text) and must **never** be logged or
audited — only surfaced on the user's own Slack thread. See `protocol.ts:455-462`
and `manager.ts:933-942`. This slice logs ONLY the safe structured fields; it must
not add the message body to any log/audit line.

### Grounded facts (verified at current `main`)

- `RunnerErrorClass` closed enum + `RUNNER_ERROR_CLASS_SET` + `isRunnerErrorClass`
  live in `runner/src/protocol.ts:463-487` AND the byte-identical
  `src/runner/protocol.ts`. `ErrorMessage` (`:490-496`) has optional `errorClass`.
- `classifyResultError(subtype)` (`runner/src/main.ts:51-59`) maps SDK *result*
  subtypes only; thrown errors never reach it.
- Runner catch: `runner/src/main.ts:1087-1091`. Runner has a `log()` helper (writes
  to stderr → appears as `[runner] …` in the gateway log).
- Gateway catch: `src/sessions/manager.ts:1234-1238` (`console.error('[session]
  error processing message in <key>: <msg>')` + `:x: Unexpected error: <msg>`).
- Gateway runner-error relay (the OTHER, redacted path): `manager.ts:932-956` —
  logs `errorClass` (safe), redacts the message. Do not change its redaction.

## CRITICAL — do not stop after exploration

Make the edits, add tests + the doc, run `npm run gate`, fix failures, then stop.

## CRITICAL — ground SDK error shape, don't recall it

The Anthropic SDK error fields are: `status` (number), `error` (the response body,
with `error.type`), `type`, `name`, `code`. Extract defensively (each may be
absent), and also check `err.cause`. Do not assume a fixed class — duck-type on the
fields. Quote what you rely on in your report.

## Implementation

### 1. Add `api_error` to the error-class enum (BOTH protocol.ts copies)

In `runner/src/protocol.ts` and `src/runner/protocol.ts` (keep byte-identical), add
`| 'api_error'` to `RunnerErrorClass` (with a one-line comment: "a thrown
Anthropic API/SDK error — see status/type in the runner log") and add `'api_error'`
to `RUNNER_ERROR_CLASS_SET`.

### 2. Runner — classify + log structured detail for thrown errors

In `runner/src/main.ts`:
- Add a small, exported, unit-testable helper, e.g.:
  ```ts
  /** Safe, content-free structured summary of a thrown error (NO message body). */
  export function safeErrorDetail(err: unknown): { class: RunnerErrorClass; detail: string } {
    if (err instanceof AbortError) return { class: 'aborted', detail: 'AbortError' };
    // Duck-type the Anthropic SDK error shape on err and err.cause.
    const candidates = [err, (err as { cause?: unknown })?.cause];
    for (const c of candidates) {
      if (c && typeof c === 'object') {
        const o = c as { name?: unknown; status?: unknown; type?: unknown; code?: unknown; error?: { type?: unknown } };
        const status = typeof o.status === 'number' ? o.status : undefined;
        const apiType = typeof o.error?.type === 'string' ? o.error.type
                      : typeof o.type === 'string' ? o.type : undefined;
        if (status !== undefined || apiType !== undefined) {
          const name = typeof o.name === 'string' ? o.name : 'Error';
          const code = typeof o.code === 'string' ? o.code : undefined;
          const parts = [`name=${name}`,
            status !== undefined ? `status=${status}` : null,
            apiType !== undefined ? `type=${apiType}` : null,
            code !== undefined ? `code=${code}` : null].filter(Boolean);
          return { class: 'api_error', detail: parts.join(' ') };
        }
      }
    }
    const name = err instanceof Error ? err.name : 'unknown';
    return { class: 'unknown', detail: `name=${name}` };
  }
  ```
  (Wording/structure at your discretion, but: AbortError→aborted; an
  Anthropic-API-shaped error on `err` or `err.cause`→api_error with a safe detail
  string; else unknown. The detail string is metadata ONLY — never `err.message`.)
- In the catch (`main.ts:1087-1091`): replace the inline classification with
  `safeErrorDetail(err)`. `log()` the safe detail (e.g. `log(\`turn error:
  class=${d.class} ${d.detail}\`)`) — this is the diagnostic line. Keep emitting the
  error protocol message with `message` unchanged (the user still sees it on Slack)
  and `errorClass: d.class`. Do NOT log `err.message`.

### 3. Gateway — capture structured metadata at the confirmed landing site

In `src/sessions/manager.ts:1234-1238`, the gateway catch currently logs the raw
`msg`. Add a SAFE structured suffix derived from `err` (and `err.cause`): `name`,
`status`, `type`, and the **first stack frame** (origin). Keep the existing line
shape but append the structured fields, e.g.:
`[session] error processing message in <key>: <name> status=<status> type=<type> @ <first-stack-frame>`.
- This tells us, next time, the error's class AND where it was thrown.
- Add a tiny helper (gateway-local) mirroring the duck-typing above, OR inline it —
  but the gateway must NOT import from `runner/` (boundary rule). Duplicate the small
  extractor here or put a shared content-free helper in an allowed location; do not
  cross the gateway→runner boundary. Simplest: a small local function in `manager.ts`.
- The user-facing `:x: Unexpected error: <msg>` may stay as-is (the message is on the
  user's own thread, which is allowed), OR you may append the safe class. Do NOT add
  `err.message` to any NEW log/audit line — only the structured suffix.

### 4. Docs — `docs/errors.md` (the place we asked for)

Create `docs/errors.md`. **Follow the `human-prose` skill** (strip AI tells — this
is prose). Cover, concisely:
- **The error model / flow**: SDK error thrown in the container → caught in
  `runner/src/main.ts` → emitted as a protocol `ErrorMessage { message, errorClass }`
  → gateway relays it (`manager.ts` runner-error path) → Slack `:x: Error: …`. Plus
  the separate gateway-side catch (`manager.ts` `:x: Unexpected error: …`) for
  exceptions thrown while driving the turn. Name the file:line of each.
- **The redaction discipline**: why the message body is never logged/audited (it can
  echo prompt/tool/file content) and `errorClass` + structured metadata are the safe
  channel. Reference the protocol comment.
- **`RunnerErrorClass` table**: each value, what it means, and where it's assigned
  (`classifyResultError` subtype, the catch, malformed-input, no-result, the new
  `api_error`). Keep it in sync with `protocol.ts`.
- **How to diagnose a live error**: the gateway log lines to look for, the new
  structured metadata this slice adds, and `scripts/peek-session.mjs` (bcbd77) to
  read the in-container SDK transcript from the session volume.
- **Known open issue — `msg_too_long`**: what we ruled out (NOT an Opus-4.8
  1M-context overflow — that surfaces as `model_context_window_exceeded`; thinking
  blocks are auto-stripped from context) and the remaining candidates (request
  byte-size limit, a single over-long message/content-block, org-tier gating). Point
  at issue `412e0d`.

Keep it tight and factual — a reference, not an essay.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`. The gateway must NOT import `runner/` (boundaries enforces).
2. `RunnerErrorClass` includes `'api_error'` in BOTH byte-identical `protocol.ts`
   copies + the SET; `isRunnerErrorClass('api_error')` is true. (A test asserts it.)
3. Runner: `safeErrorDetail` (or your equivalent) returns `aborted` for AbortError,
   `api_error` (with a status/type detail string and NO message body) for an
   Anthropic-API-shaped error on `err` AND on `err.cause`, and `unknown` otherwise.
   The catch logs the safe detail and emits `errorClass` accordingly. Tests cover all
   three branches + the `.cause` path, and assert the logged/emitted detail contains
   NO message body.
4. Gateway: the `manager.ts:1234` catch logs a safe structured suffix (name/status/
   type/first-stack-frame) for a thrown error, without adding the message body to a
   new log/audit line. (Test via the existing manager test harness — e.g. a
   FakeRunner whose drive throws a structured error — asserting the captured console
   line includes the structured fields and not the body.)
5. `docs/errors.md` exists, follows `human-prose`, and documents the flow + the
   `RunnerErrorClass` table + the `msg_too_long` open issue.

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail.
- `protocol.ts` is two byte-identical copies — edit BOTH.
- **Never log or audit the error message body** — only the content-free structured
  metadata + `errorClass`. The message stays on the user's Slack thread only.
- Gateway must not import from `runner/` (boundary) — duplicate the tiny extractor or
  inline it gateway-side.
- No `any`, no `@ts-ignore`; NodeNext ESM. Suite stays offline.
- Don't add dependencies. Don't commit. Don't edit this spec file.
- Doc prose: follow `~/.claude/skills/human-prose/SKILL.md`.

## Out of scope (do NOT build)

- Actually fixing `msg_too_long` (we don't yet know what it is — this slice is the
  instrumentation + docs that make the next occurrence diagnosable).
- Compaction / context-window / model-pinning changes (ruled out — Opus 4.8 is
  already 1M-native).
- Changing the redacted runner-error relay path's behavior (`manager.ts:932-956`).

## When done — report precisely (with REAL command output)

- File-by-file summary (one line each).
- The tail of `npm run gate` — test count + file count.
- Which SDK error fields you relied on (grounded) and how you handle `err.cause`.
- Confirmation no log/audit line gained the message body; the structured suffix is
  metadata only.
