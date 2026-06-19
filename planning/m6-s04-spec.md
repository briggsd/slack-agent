# M6 S04 — Per-user gate authorization (only-requestor resolve)

> Issue #22 item #1. Closes the resolve-authz half of the M6 per-user authorization
> work. Design settled by a `grill-me` pass on 2026-06-19; grounding in
> `design/0006` (§"Who may resolve the gate") and `design/open-questions.md` Q1/Q4.
> Coordinator-authored (manager hot path + authz boundary; #28 precedent).

## What & why

A run parked at the plan-approval gate is resolved by the next thread reply
(approve / cancel / free-text feedback). Today **any** thread participant's reply
resolves it — intentional for S03 (the gate shipped as *supervision*, not authz).

This slice makes resolution **requestor-only**: only the Slack user who started the
thread may approve, cancel, or redirect a parked plan. A non-requestor reply does
not resolve the gate and is not enqueued; the gate keeps waiting for the requestor
or its timeout.

Scope is deliberately **resolve-authz only**. Invocation stays open (anyone may
`task`/`exec`) by design: the real authority boundary is downstream — every profile
terminates at *open a PR*, which a human reviews and merges on GitHub; the bot never
merges. So "the person who started it supervises it" is the right grain, and an
invoke allow-list is out of scope.

## Acceptance criteria

1. `Session` records the original requestor's Slack user id, set once at session
   creation from the creating mention's `userId`.
2. On the **rehydrate** path (`enqueueExisting` → `getOrCreate` for an evicted
   session), the requestor is sourced from the **stored** row (`row.user_id`), NOT
   from the replying message — the original starter stays stable. (Mirrors how
   `profile_id` is already overridden on that path.)
3. When a run is parked (`pendingApproval !== null`) and a reply arrives:
   - reply's `userId` **equals** the session requestor → resolve as today
     (approve/cancel/feedback all flow through this one check).
   - reply's `userId` **differs**, OR the session requestor is **undefined**
     (fail-closed) → do **not** resolve, do **not** enqueue. Post a **new**
     threaded message (never an `update` to the gate placeholder): `Only
     <@REQUESTOR> can approve or cancel this plan.` (ping by name; when the
     requestor is unknown, fall back to neutral wording). Return `true` (handled).
4. A `console.log` (session key + lifecycle only, no message content) records each
   rejected non-requestor reply, with a `// TODO(M6 audit): emit audit_events row`
   marker at the rejection point. A separate `console.log` fires when a gate parks
   with no requestor (it can only ever resolve via timeout).
5. `npm run gate` green; new tests assert: requestor approve resolves; non-requestor
   reply is rejected (no resume, no enqueue, notice posted to `posts`); fail-closed
   when requestor undefined; rehydrate preserves the original requestor.

## Where to look

- `src/sessions/manager.ts`
  - `Session` interface (~L17) — add `requestorUserId: string | undefined`.
  - `getOrCreate` (~L68) — set `requestorUserId: item.userId` on the new `Session`.
  - `enqueueExisting` (~L122) — the `pendingApproval !== null` branch is where the
    check goes; rewrite the inline SECURITY comment to the new posture. The
    rehydrate call (~L160) must pass the stored requestor (build the rehydrate
    `QueueItem` with `userId` from `row.user_id`, omitted when null → fail-closed).
  - `awaitApproval` (~L328) — add the no-requestor diagnostic log.
- The notice uses `this.slack.postMessage` (the `SlackClientLike` seam in
  `src/slack/responder.ts`) — fire-and-forget with a `.catch` (a post failure must
  not strand the parked run; the timeout still bounds it).

## Precedent to mirror

- Conditional-spread for optional `userId` under `exactOptionalPropertyTypes`:
  `src/slack/listener.ts:108` (`...(ev.user !== undefined && { userId: ev.user })`).
- `row.profile_id` override on rehydrate: `manager.ts:160` — do the same for the
  requestor.
- Gate tests: `test/manager.test.ts` `describe('SessionManager — approval gate')`
  (~L339) and `'— abandoned event'` (~L451). `GateRunnerFactory`/`GateRunner`
  (L19–40) park and record the resume. `FakeSlackClient` (`test/responder.test.ts`)
  captures `postMessage` in `.posts`, `update` in `.updates`.

## Hard constraints

- Gate must pass: `npm run gate`. Strict TS, no `any`, no `@ts-ignore`,
  `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess` on.
- Never log message contents — session keys + lifecycle only.
- `@slack/bolt` stays out of the manager; keep using the injected `SlackClientLike`.
- The notice is a **new** `postMessage`, never an `update` to the placeholder (the
  placeholder must keep showing the plan + prompt for the requestor).
- Keep the diff focused on the manager + its tests + the doc caveats. No protocol
  change (this is entirely gateway-side).

## Docs to update (state the real posture)

- `README.md` heads-up (~L150) and `docs/ARCHITECTURE.md` access-control rows
  (~L245–246) + status footer (~L300): resolution is now requestor-only;
  invocation stays open by design; the real control is downstream PR review/merge +
  branch protection; the bot never merges.

## Out of scope

- Invoke allow-list / roles / per-team designated reviewers.
- The first `audit_events` write (its own slice — sets the schema precedent).
- Durable park across gateway restart (M6 item #2).
