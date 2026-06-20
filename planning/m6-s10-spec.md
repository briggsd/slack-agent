# Task: Commit spine — `request_approval`/`approval_verdict` protocol + conversational park (gateway half)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md`
first** (gate, invariants, conventions), then the context below. You are on branch
`feat/router-s10-commit-spine`.

This is the first slice of the conversational-planning "router" arc
(`design/0007`, the 2026-06-20 decisions). It lands the **transition-mechanism
spine** on the gateway side: the protocol messages and the wiring that lets a
*conversational* session park at a commit gate, reusing the existing one-shot
approval machinery. The container-side `submit_spec` tool that actually emits the
signal is the next slice (S10b) — see "Out of scope".

## Context — read before writing code

- Design intent: `design/0007` — esp. decision 5 (commit = agent calls a tool →
  `request_approval` → gateway parks → requestor-keyed approval) and the
  `planning/m6-conversational-planning-slices.md` breakdown (S10).
- Code this builds on:
  - `src/runner/protocol.ts` **and** `runner/src/protocol.ts` — the two byte-identical
    NDJSON contract copies. Today `GatewayToRunnerMessage = UserMessage` only;
    runner→gateway has no approval message.
  - `src/runner/docker.ts` — `DockerRunner`: translates NDJSON ↔ the gateway's
    `RunnerEvent` stream (the `send()` iterator the manager drives). This is where an
    inbound `request_approval` line becomes an `await_approval` event and a resume
    value becomes an outbound `approval_verdict` line.
  - `src/sessions/manager.ts` — the drive loop (~540–600) **already** handles an
    `await_approval` event by calling `awaitApproval(...)` (~686), which posts the
    prompt and parks; the gate resolver in `enqueueExisting` (~324–394) is
    **requestor-only, fail-closed** and resolves the parked promise with the reply
    text. Reuse all of it.
  - `src/oneshot/nodes/plan-gate.ts` — the existing approve / cancel / feedback
    classification of a gate reply. Mirror its keyword rules.
  - `src/runner/fake.ts` (`FakeRunner`) and `src/runner/types.ts` (`RunnerEvent`,
    `GateResume`) — the seam your tests drive.
- Motivating need: a conversational session has no commit today; the one-shot
  `await_approval` event is emitted gateway-side by the orchestrator, never by the
  agent. The router needs the *agent in the container* to raise the gate, so the
  signal must cross the NDJSON boundary — a new message in each direction.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure — implement end to
end in this run.

## Acceptance criteria

1. `npm run gate` passes — `tsc --noEmit` + runner typecheck + `vitest run` +
   `npm run boundaries`. Paste the tail when done.

2. **Protocol — both copies edited identically.** Add to `src/runner/protocol.ts`
   AND `runner/src/protocol.ts` (byte-identical; `diff` must print nothing):
   - Runner→gateway: `RequestApprovalMessage { type: 'request_approval'; id: string;
     specRef: string }` added to the `RunnerToGatewayMessage` union. `specRef` is the
     spec the human approves — a text blob in this slice (a `/workspace` path arrives
     with S11); document that in a comment.
   - Gateway→runner: `ApprovalVerdictMessage { type: 'approval_verdict'; id: string;
     approved: boolean; feedback?: string }` added to the `GatewayToRunnerMessage`
     union (today only `UserMessage`). `id` correlates to the `request_approval` it
     answers. Note `exactOptionalPropertyTypes` is on — type `feedback` as optional
     correctly.

3. **DockerRunner translation** (`src/runner/docker.ts`):
   - An inbound `request_approval` NDJSON line is surfaced on the `send()` iterator as
     an `await_approval` `RunnerEvent` carrying `specRef` as the prompt (reuse the
     existing event shape the drive loop already parks on — do **not** add a new
     manager branch).
   - The `GateResume` value fed back via `next(resume)` is translated to an outbound
     `approval_verdict` line with the correlating `id`. Map the resume per the
     keyword rules below.
   - Treat the inbound line as data: bad shape skipped/logged, never executed
     (existing protocol-parsing discipline).

4. **Keyword classification** (mirror `plan-gate.ts`): the requestor's gate reply is
   classified into the verdict — an exact-match commit keyword (e.g. `approve` /
   `approved`) → `approved: true`; a cancel keyword → abandon (existing `abandoned`
   path); anything else → `approved: false` with the reply as `feedback`. On
   `approved`, this slice only returns the verdict to the runner — dispatching the
   build tail is S12.

5. **Tests** (offline, via `FakeRunner`): extend the fake to yield an
   `await_approval`/`request_approval` event mid-conversation, then assert:
   (a) the session parks (`pendingApproval` set), the spec is posted, idle timer
   behavior matches the one-shot gate; (b) a **non-requestor** reply does not resolve
   it (fail-closed) and posts the "only X can approve" notice; (c) the **requestor**'s
   commit keyword resolves it and an `approval_verdict { approved: true }` reaches the
   runner; (d) a non-keyword requestor reply returns `approved: false` + feedback and
   the conversation continues. Cover the new audit rows if you emit any.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the tail of its output when done.
- **`protocol.ts` edited in both copies identically** — `diff src/runner/protocol.ts
  runner/src/protocol.ts` prints nothing.
- Conventions per root `CLAUDE.md`: no `any`, no `@ts-ignore`; `NodeNext` ESM;
  inject dependencies (`FakeRunner`/`FakeSlackClient`, never the real world in tests).
- Never log message contents or tokens — only keys, lifecycle, sizes.
- Reuse the existing `await_approval` drive-loop branch and `awaitApproval` /
  requestor-gate machinery; do not fork a parallel conversational gate path.
- Add no dependencies.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build) — these are later slices

- **S10b — the container-side `submit_spec` SDK tool + stdin demultiplexing.** The
  real runner (`runner/src/main.ts`) currently reads one `user_message`, runs the SDK
  stream to completion, then loops — it does not read stdin mid-turn. The real
  `submit_spec` tool fires *inside* the SDK stream and must block on an
  `approval_verdict` that arrives on stdin *while the stream is live*, so S10b must
  (1) add the first custom SDK tool (ground it in the SDK `.d.ts`, don't recall the
  API) and (2) demultiplex inbound lines (`user_message` vs `approval_verdict`)
  against pending tool calls. Leave `main.ts`'s loop untouched here beyond the
  protocol *types*; this slice proves the gateway contract with `FakeRunner`.
- The read-clone tool and `SPEC.md`-on-volume (S11): `specRef` stays a text blob now.
- Dispatching the build tail on approval (S12).
- Block Kit button (keyword commit only).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The output of `diff src/runner/protocol.ts runner/src/protocol.ts` (must be empty).
- The tail of `npm run gate` output (real, not paraphrased).
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (or couldn't).
