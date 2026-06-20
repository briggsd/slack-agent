# 0010 S02 - Local Build Tail Candidate

## Goal

Split the build tail so `request_build` produces a local candidate only. Build should branch, run the implementation/check loop, and stop with a successful local candidate result. Pushing and opening a PR must move to the explicit, gated publish/open-pr path added in the previous slice.

This implements design item `65ce66` from `design/0010-coordinator-verifies.md`.

## Context

Previous slice PR #47 added the explicit `publish` and `open_pr` protocol/tool/service path. This slice relies on that path being the only way a build result gets pushed and turned into a PR after coordinator verification.

Important current shapes:

- `src/oneshot/build-tail.ts:1-10` imports `pushNode` and `openPrNode`; `buildTail.nodes` is currently `[branchNode, fixLoop, pushNode, openPrNode]`.
- `src/runner/types.ts:39-46` defines `BuildOutcome` success as `{ ok: true; prUrl: string }`.
- `src/sessions/manager.ts:638-667` has `runBuild` translate `pr_opened` to success and return failure when no PR is opened.
- `runner/src/main.ts:175-192` tells the coordinator `BUILD COMPLETE. Opened PR: ...`.
- `runner/src/build.ts:16-57` maps `build_result` success through a `prUrl`.
- `src/runner/docker.ts:523-527` emits `build_result` with `prUrl` on success.
- `src/runner/protocol.ts` and `runner/src/protocol.ts` both document `BuildResultMessage.prUrl` as the opened PR URL.
- Relevant tests include `test/build-engine.test.ts`, `test/docker-build.test.ts`, `runner/test/build.test.ts`, `runner/test/build-spec.test.ts`, and `runner/test/approval.test.ts`.

## Required Behavior

1. `buildTail.nodes` is exactly `[branchNode, fixLoop]`.
2. `build-tail` must not import or use `pushNode` or `openPrNode`.
3. A successful build returns a local-candidate success, not a PR success:
   - container/runner-side `BuildOutcome` success should no longer require `prUrl`;
   - gateway-side `BuildOutcome` success should no longer require `prUrl`;
   - `request_build` should emit `{ type: "build_result", id, ok: true }` with no `prUrl`.
4. `SessionManager.runBuild` should treat a normal completed build-tail run as `{ ok: true }`.
5. `runBuild` should still return `{ ok: false, reason }` on error, abandonment, spawn failure, or other actual build failure.
6. Keep existing `pr_opened` handling for non-build one-shot paths if it is still needed, but build-tail success must not depend on it.
7. The runner-facing build completion text should say the local candidate is ready and that the coordinator must verify it before using `publish` / `open_pr`.
8. The text shown after build must not say "Opened PR" unless a PR was actually opened by an explicit later publish/open-pr step.

## Credentials

Build-tail is local-only. It must not mint a real write credential or broker lease, and it must not call `gitNodes.push` or `openChangeRequest`.

Use the least invasive implementation that preserves existing one-shot behavior for blueprints that still need write credentials. A good shape is blueprint metadata such as `requiresLease?: boolean` defaulting to `true`, with `buildTail.requiresLease = false`, and a no-op local lease object only if the current context type requires a lease value. Tests must prove that:

- build-tail does not call the broker lease/revoke path;
- normal one-shot paths that still need publish behavior continue to mint/revoke leases.

Do not expose real credentials to agentic nodes.

## Protocol Notes

Update `src/runner/protocol.ts` and `runner/src/protocol.ts` byte-identically.

It is acceptable to keep `BuildResultMessage.prUrl?: string` as a tolerated legacy field for rolling compatibility, but the comments and current behavior must make clear that build success means "candidate ready" and the gateway no longer emits `prUrl` for build success. Runner success must not depend on a URL being present.

## Tests

Update or add focused tests for:

- Build engine local-only flow: branch and fix/check loop run; no push; no `openChangeRequest`; no `pr_opened` event; no broker lease/revoke for build-tail.
- Normal one-shot behavior that still needs credentials continues to lease/revoke.
- `SessionManager.runBuild` completed-tail success returns `{ ok: true }`; failure/abandoned/error cases still return `{ ok: false, reason }`.
- Docker build relay emits an ok-only `build_result` on success.
- Runner `build`, `build-spec`, and approval tests expect candidate-ready wording and success shape.
- Protocol parser tests, if touched, still cover tolerated legacy `prUrl` without requiring it.

## Acceptance Criteria

- `npm run gate` passes from the worktree root.
- `diff src/runner/protocol.ts runner/src/protocol.ts` is empty.
- Build-tail does not push or open a PR.
- Build-tail does not mint a real write lease.
- No user-facing build-complete text claims a PR was opened.

## Out Of Scope

- Adding the `run_checks` tool or read-diff inspection surface.
- Full coordinator verification prompt/UX beyond the build completion wording needed here.
- End-turn-resume behavior.
- Live smoke against external services.
- Removing `pushNode`, `openPrNode`, or `pr_opened` from regular one-shot / exec / supervised flows.

## Constraints

- No new dependencies.
- No `any` or `ts-ignore` escapes.
- Do not log content, tokens, or credentials.
- Keep changes offline-testable.
- Do not remove the `node_modules` or `runner/node_modules` symlinks in this worktree.
- Do not modify this spec as part of the implementation.
