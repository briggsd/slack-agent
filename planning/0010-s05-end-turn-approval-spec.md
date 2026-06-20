# Task: Make the build SPEC gate end-turn-and-resume

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-gpt-5.4-0010-end-turn-resume-gates`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md`
first**, then `runner/CLAUDE.md`, then this spec. You are on branch
`gpt-5.4/0010-end-turn-resume-gates`.

## Context - read before writing code

- Design intent: `design/0010-coordinator-verifies.md`, slice 6, decided that both
  human-ask moments use **end-turn-and-resume** rather than a held container/park
  with a 15 minute abandon. The worktree does not contain `design/`, so the relevant
  contract is in this spec.
- Already shipped 0010 spine:
  - PR #47 added `publish`/`open_pr`.
  - PR #48 made `build_spec` produce a local candidate.
  - PR #49 added `run_checks`.
  - PR #50 strengthened the coordinator prompt to verify before publish and to ask
    the user when checks/diff are not publishable.
- Current gateway behavior to change:
  - `src/runner/docker.ts:415-459` converts runner `request_approval` into a blocking
    `await_approval` yield, waits for a `GateResume`, writes `approval_verdict`, and
    resets the same turn deadline.
  - `src/sessions/manager.ts:559-563` blocks `driveToThread` on
    `awaitApproval(...)`.
  - `src/sessions/manager.ts:750-813` registers `pendingApproval` as a promise
    resolver and starts `gateTimeoutMs`; the prompt says no reply in N minutes
    abandons the plan.
  - `runner/src/approval.ts:47-56` returns a promise that resolves only when the
    gateway sends `approval_verdict`, so the SDK tool call and container turn stay
    live while the human is away.
- Current runner/build behavior to change:
  - `runner/src/main.ts:191-213` has `runBuildSpec` call `submitSpec`, wait for a
    verdict, and if approved immediately call `requestBuild`.
  - `runner/test/runner-main.test.ts:727-824` pins the old mid-turn demux: the tool
    blocks while the test pushes `approval_verdict`.

The new shape is: `build_spec` asks for approval, returns to the model, and the turn
ends. A later requestor reply is authenticated by the gateway, sent to the runner as
a trusted approval control before that new user turn, and `build_spec` can then be
called again to consume the approved/rejected decision. No container/tool promise is
held open while waiting for the human.

## CRITICAL - do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure - implement end to end in this
run.

## Acceptance criteria

1. `npm run gate` passes.
2. Runner-side `build_spec` approval is no longer a blocking promise:
   - First call with a non-empty `/workspace/SPEC.md` emits `request_approval` and
     returns tool text telling the coordinator that approval was requested and it
     must end the turn / ask the user to reply.
   - That first call does **not** call `requestBuild`.
   - After an authenticated approval control arrives, a later `build_spec` call for
     the same pending gate consumes it and then calls `requestBuild`.
   - After authenticated feedback/rejection arrives, a later `build_spec` call
     consumes it and returns the existing "NOT APPROVED" style text with feedback as
     delimited data; it does not build.
3. Gateway `request_approval` handling is non-blocking:
   - `DockerRunner.send()` surfaces a gateway-internal event for approval requested
     and then continues reading the same turn. It must not wait for a
     `GateResume`, must not write `approval_verdict` immediately, and must not reset
     a same-turn approval deadline.
   - `SessionManager` registers a pending approval id when it sees that event,
     updates the Slack placeholder with the SPEC/prompt, and then lets the turn
     complete normally. The session is not stuck `draining` while waiting for the
     human.
4. A later thread reply resolves the pending approval as a **new turn**:
   - The same requestor only may resolve it. Non-requestor replies remain handled
     and rejected with the existing notice/audit shape, and they do not enqueue a
     normal turn.
   - Requestor `approve` / `approved` becomes an authenticated
     `approval_verdict { approved: true }` control.
   - Requestor `cancel` / `abort` / `reject` becomes an authenticated
     `approval_verdict { approved: false }` control with no user-content feedback.
   - Any other requestor reply becomes an authenticated
     `approval_verdict { approved: false, feedback: <raw reply> }` control.
   - The control is delivered to the runner before the new `user_message`, so the
     resumed SDK turn can see the user's prose and call `build_spec` again against
     already-recorded gate state.
5. The 15-minute abandon is retired for the runner `build_spec` gate:
   - No approval timeout text is appended to the build SPEC prompt.
   - No timer resolves runner `build_spec` approval as `{ kind: 'timeout' }`.
   - `GATE_TIMEOUT_MS` may remain for legacy one-shot `await_approval` callers if
     removing them is too broad, but the build SPEC gate must not use it.
6. Persistence/reap behavior is good enough for the end-turn contract:
   - Runner approval state is kept under `/workspace/.slackbot/` (or an equivalent
     session-volume path) so a reaped/recreated runner can consume a later
     `approval_verdict`.
   - Gateway in-memory pending approval may be process-local in this slice; full
     durable pending-gateway state across gateway restart belongs to the later S13
     lifecycle work. Do not fake a database migration unless you truly need it.
7. System prompt/tool text is updated so the coordinator knows the new flow:
   - On `APPROVAL REQUESTED`, stop and ask the user to approve or request changes.
   - On the next user reply for that pending gate, call `build_spec` again; if the
     gateway authenticated approval, it will build without asking again.
   - Escalation after red/inconclusive verification remains normal assistant prose
     from PR #50: ask honestly and end the turn; no special gateway park.
8. Tests cover the new seams offline:
   - Runner unit tests for approval state/request/consume and `runBuildSpec`.
   - Runner main-loop test replacing the old mid-turn blocking demux expectation:
     request emits, tool/turn completes, later verdict+user turn can be consumed.
   - DockerRunner test showing `request_approval` yields the non-blocking approval
     event and then continues to the same turn's final text.
   - SessionManager test showing approval request does not keep the session draining
     and a requestor reply starts a second `send()` with an approval control; keep a
     non-requestor rejection test.

## Suggested implementation shape

Use the existing names where possible, but do not preserve the old blocking contract.
This is a suggested shape, not a mandate if you find a cleaner local fit:

1. Add a gateway-internal runner control type in `src/runner/types.ts`, for example:
   - `ApprovalControl = { id: string; approved: boolean; feedback?: string }`
   - `RunnerSendOptions = { approval?: ApprovalControl }`
   - `SessionRunner.send(message, opts?: RunnerSendOptions): RunnerStream`
   - a new `RunnerEvent` variant like
     `{ type: 'approval_requested'; approvalId: string; prompt: string }`
2. In `src/runner/docker.ts`, when parsing `request_approval`:
   - validate `id` and `specRef` as today.
   - yield `approval_requested` with the id and prompt.
   - continue reading output; do not wait for a resume.
   - when `send(..., { approval })` is called, write the matching
     `approval_verdict` NDJSON line before the `user_message` line.
3. In `src/sessions/manager.ts`:
   - change `pendingApproval` from a resolver to a record containing the approval id.
   - handle `approval_requested` by setting that record synchronously, auditing
     `approval/requested`, and updating the placeholder with the prompt plus a short
     no-timeout instruction. Do not append "No reply within N min".
   - on requestor reply while pending, classify the message as above, clear the
     pending record, audit `approval/resolved`, enqueue a new turn carrying the
     approval control, and drain normally.
   - keep non-requestor behavior fail-closed and content-free.
4. In `runner/src/approval.ts`, replace the promise-only coordinator with a
   request/consume state machine. It should write pending state to the session volume
   so a later container can consume a verdict:
   - first `requestApproval(specRef)` stores `{ id, specRef, status: 'requested' }`,
     emits `request_approval`, and returns a non-blocking result such as
     `{ status: 'requested' }`.
   - `handleVerdict` finds the pending id and stores `{ status: 'approved' }` or
     `{ status: 'rejected', feedback? }`.
   - a later `requestApproval(specRef)` consumes approved/rejected state instead of
     re-emitting the request. Compare against the current spec text (exact string is
     acceptable for this slice); if the SPEC changed, start a new approval request.
   - preserve defensive handling for EOF/shutdown.
5. In `runner/src/main.ts`, update `runBuildSpec` to branch on requested vs approved
   vs rejected. Keep `readSpecForApproval`, `runPublish`, and `runChecks` focused.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the tail of its output when done.
- Conventions per root `CLAUDE.md`: no `any`, no `@ts-ignore`; `NodeNext` ESM;
  inject external dependencies and keep tests offline.
- If touching `protocol.ts`, edit **both** copies identically
  (`src/runner/protocol.ts` == `runner/src/protocol.ts`). You may not need a
  protocol change because `request_approval` / `approval_verdict` already exist.
- Never log message contents, SPEC text, feedback text, or tokens. Audit/log only
  ids, session keys, action labels, and statuses.
- Do not import `@slack/bolt` outside `src/index.ts`; do not import the runner package
  from gateway code.
- Do not add dependencies.
- Do NOT commit; leave the working tree for coordinator review.

## Out of scope (do NOT build)

- Full durable pending-approval recovery across gateway restart using new database
  columns. S13 lifecycle work owns that.
- Block Kit buttons for approval.
- A live Docker/API smoke test. Keep CI/offline tests green.
- Changing publish/open_pr gateway behavior; PR #47-#50 already moved publish behind
  coordinator verification.
- Reworking the legacy supervised one-shot blueprint unless it is necessary to keep
  types/tests coherent. This slice is about the runner `build_spec` SPEC gate.

## When done - report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, not paraphrased).
- Any deviation from this spec and why.
- Anything a unit test cannot catch that you verified another way, or could not verify.
