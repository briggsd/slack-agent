# Task: surface conversational publish success as the structured `pr_opened` event

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-sonnet-687386-pr-opened-surface`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md`
and `runner/CLAUDE.md` first** (gate, invariants, conventions), then the
context below. You are on branch `sonnet/687386-pr-opened-surface`.

## Context — read before writing code

- Design intent: `design/0013-publish-cluster.md` (the *why*) and the M6/M7
  roadmap in `planning/ARCHITECTURE.md` (the *when*). This implements only
  Slice 1 / track `687386`: route successful conversational publish opens
  through the same structured PR-opened surface as the legacy path
  (`design/0013-publish-cluster.md:79`, `design/0013-publish-cluster.md:100`).
- Code this builds on:
  - `src/runner/docker.ts:551`-`603` handles runner `request_publish`, calls
    `PublishService.publish`, writes `publish_result{prUrl}` back to the
    container, and currently stops there.
  - `src/runner/types.ts:3`-`35` defines gateway-internal `RunnerEvent`; the
    existing `pr_opened` event is declared at `src/runner/types.ts:17`-`20`.
  - `src/sessions/manager.ts:24`-`28` mirrors `pr_opened` in `DriveOutcome`;
    `src/sessions/manager.ts:758`-`773` handles that event by updating Slack
    to `Opened PR: <url>` and writing the metadata-only `open-pr` audit row.
  - `src/runner/protocol.ts:114`-`120` and `src/runner/protocol.ts:301`-`307`
    already define the `publish_result` / `request_publish` wire pair. This
    slice should not need a protocol change.
  - `src/runner/publish-service.ts:9`-`22` defines `PublishService` /
    `PublishOutcome`; `src/oneshot/publish-service.ts:34`-`98` is the real
    gateway-owned publish implementation; `src/runner/fake-publish-service.ts:7`-`19`
    is the existing test seam.
  - `test/docker-publish.test.ts:97`-`138` already tests the successful
    `request_publish` round trip with `FakePublishService`.
  - `test/manager.test.ts:926`-`949` has `CapturingStore`; `test/responder.test.ts:6`-`41`
    has `FakeSlackClient`; `test/manager.test.ts:1285`-`1312` already asserts the
    existing `pr_opened` handler writes one `open-pr` audit and an `Opened PR:`
    placeholder update.
- Motivating need / bug: on the conversational path, the coordinator's publish
  tool opens the PR and receives the URL as data, but the gateway never emits
  the structured `pr_opened` event that the manager consumes. Live track
  `687386` confirmed the result: no `Opened PR:` surface and no `open-pr`
  audit row for the opened PR (`design/0013-publish-cluster.md:19`-`28`).
- Chosen approach: on `request_publish` success in `src/runner/docker.ts`, write
  the existing `publish_result` to the container and additionally yield
  `{ type: 'pr_opened', url: publishOutcome.prUrl }` into the same `RunnerStream`
  the manager already consumes. Prefer this over writing an audit row directly
  at the Docker seam; the manager handler is the canonical post + audit path and
  already preserves the legacy behavior (`src/sessions/manager.ts:758`-`773`).

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure - implement end to
end in this run.

## Acceptance criteria

1. `npm run check` passes (all existing tests keep passing, plus new ones), and
   `npm run boundaries` is clean. If either `protocol.ts` copy is touched,
   `diff src/runner/protocol.ts runner/src/protocol.ts` prints nothing.
2. A successful conversational `request_publish` in `DockerRunner` still writes
   exactly one `publish_result{ok:true, prUrl}` to the runner and also yields
   exactly one gateway-internal `RunnerEvent`:
   `{ type: 'pr_opened', url: <same prUrl> }`. Cover this by extending the
   `test/docker-publish.test.ts:97`-`138` success case or adding a sibling test
   using `FakePublishService` and the fake child process.
3. A failed or unavailable conversational publish (`PublishOutcome.ok === false`
   or no publish service/volume) writes the existing `publish_result{ok:false}`
   behavior and yields no `pr_opened` event. Cover the failure/unavailable paths
   already exercised in `test/docker-publish.test.ts:140`-`193`.
4. When the synthesized `pr_opened` event reaches `SessionManager`, there is
   exactly one Slack placeholder update containing `Opened PR: <url>` and exactly
   one audit row with `kind: 'action'`, `tool: 'open-pr'`, `result: 'opened'`,
   and `summary` equal to the PR URL. The audit remains metadata-only: never
   record PR title/body text, message text, tokens, or reasoning. Use the
   existing `FakeSlackClient` and `CapturingStore` seams in `test/manager.test.ts`.
5. The existing legacy `pr_opened` path still emits exactly one `open-pr` audit
   row and one `Opened PR: <url>` update - no double-audit. Preserve or tighten
   `test/manager.test.ts:1285`-`1312` and the behavior covered by
   `test/build-engine.test.ts:713`-`728`.
6. No new model-facing tool, runner-side tool, protocol message, or service method
   is added for this slice. `request_publish` / `publish_result` remain the only
   wire protocol involved.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the tail of its output when done.
  This runs `npm run check` and `npm run boundaries`.
- Conventions per root `CLAUDE.md`: no `any`, no `@ts-ignore`; `NodeNext` ESM;
  inject external dependencies and test via seams (`FakeRunner`, `FakeSlackClient`,
  `FakePublishService`, fake child process, `CapturingStore`) rather than real
  Slack, Docker, GitHub, network, or filesystem effects.
- If touching `protocol.ts`, edit **both** copies identically
  (`src/runner/protocol.ts` ≡ `runner/src/protocol.ts`). This slice should not
  require touching either file.
- Never log message contents or tokens. In particular, `request_publish` title
  and body are model-authored PR content and must not be logged or audited.
- Add dependencies only with strong justification. This slice should need none.
- The gateway continues to own publish credentials and GitHub writes; the
  container only asks via the existing `request_publish` protocol.
- Commit the implementation after `npm run gate` passes. Use an honest message
  and include:
  `Co-authored-by: GPT-5 Codex <noreply@openai.com>`.

## Out of scope (do NOT build)

- Slice 2 / track `5e9ee3`: `edit_pr`, `comment_pr`, new protocol pairs, new
  runner tools, new `PublishService` methods, and `edit-pr` / `comment-pr`
  audit rows.
- Any new model-facing publish/open PR tool, command name, prompt change, or
  runner-side behavior.
- Any protocol change unless genuinely required. Slice 1 should need none
  because `request_publish` / `publish_result` already exist.
- Direct audit or Slack posting from `src/runner/docker.ts`; route through the
  existing manager `pr_opened` handler instead.
- PR review, merge, issue create/comment, or editing/commenting on PRs other
  than the thread's own PR.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run check` output (real, not paraphrased), and the result of
  `npm run boundaries`.
- Confirmation of whether either `protocol.ts` copy was touched; if touched, the
  byte-identity diff command and result.
- Any deviation from this spec and why.
- Anything a unit test cannot catch that you verified another way (or could not).
