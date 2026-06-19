# Task: `boundedRetry` combinator + heuristic failure classifier (the fix loop)

You are implementing one slice in the slack-agent repo (in an isolated worktree off branch
`sonnet/m5-s04b4-bounded-retry`). TypeScript, Node 20+, ESM (`.js` import specifiers), vitest,
strict tsc. **Read the root `CLAUDE.md` first** (gate, invariants, conventions), then the context
below. This is the most design-dense slice so far — read it all before writing code.

## Context — read before writing code

The one-shot blueprint is currently the flat list
`clone → research → plan → branch → implement → lint → test → push → open-pr`. The `lint`/`test`
nodes (S04b-3) *run and capture* `ctx.lintResult` / `ctx.testResult` (`CheckResult = { exitCode, output, skipped }`)
but nothing acts on them. This slice adds the **bounded fix loop**: wrap `[implement, lint, test]`
in a `boundedRetry` combinator that, when a check **fails**, classifies the failure and re-runs the
body (so the agent fixes it) up to a small cap.

Design (`design/0005` "Declarative Blueprints", `design/0004` "the blueprint"): *"Control flow beyond
a straight list is a combinator node: `boundedRetry(body[], {maxCycles, classify})` wraps a
sub-sequence (implement + lint + test), runs the failure classifier between cycles, and stops on
success or after the cap."* *"Failure classifier before each retry. Transient (flaky test, timeout →
retry) vs permanent (missing file, schema mismatch → stop). Start heuristic ... LLM fallback"* (the
LLM fallback is explicitly **deferred** — heuristic only here).

**Two product decisions already made with the user (do NOT change):**
1. **On exhausted-or-permanent failure, still open the PR** with the failing checks surfaced (this
   matches S04b-3's non-gating stance and `design/0004`'s "the PR is the gate"; approval gates are M6).
   Retry engages **only** on a *transient* failure with attempts remaining.
2. **A retry re-runs `[implement → lint → test]`**, and the implement node feeds the prior cycle's
   failing check output back to the agent so it actually fixes the problem.

Code to study:
- `src/blueprints/types.ts` — `BlueprintNode<Ctx,Deps>` (`name`, `kind`, `run()→AsyncIterable<RunnerEvent>`),
  `Blueprint<Ctx,Deps>`. `src/blueprints/executor.ts` — `runBlueprint` runs nodes in order; a node that
  **throws** aborts the run (turned into one `error` event). `src/blueprints/README.md` — the engine is
  generic and a dependency-cruiser rule (`blueprints-engine-stays-generic`) **forbids** `src/blueprints/`
  from importing `src/oneshot/` or `src/broker/`.
- `src/oneshot/repo-oneshot.ts` — the node list you'll rewire. `src/oneshot/context.ts` —
  `OneShotContext` (has `lintResult?`, `testResult?`, `implementSummary?`). `src/oneshot/nodes/implement.ts`
  — agentic node using `runAgenticTurn`. `src/oneshot/git-node.ts` — `CheckResult`.
- `test/blueprint.test.ts` (engine tests + the `blueprintFor('repo-oneshot')` node-name/kind asserts),
  `test/oneshot.test.ts` (orchestrator behavior pin; `FakeRunner(key, script)` scripts agentic turns,
  `FakeGitNodeExecutor` records git ops + `setCheckResult(kind, result)`).

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND `npm run gate` passes. Make
every edit, add/adjust tests, run the gate, fix failures, then stop.

## Acceptance criteria

1. `npm run gate` passes (`npm run check` + `npm run boundaries`). Paste the real tail.
2. **Generic `boundedRetry` combinator** in a new `src/blueprints/combinators.ts`:
   ```ts
   export interface BoundedRetryOptions<Ctx, Deps> {
     readonly name: string;            // the combinator node's display name
     readonly maxAttempts: number;     // total body executions (>=1); 2 = initial + one fix cycle
     // Called after each body run EXCEPT the last. retry=true → run body again.
     // attempt is 0-based (0 = first run just finished). An optional status is yielded.
     decide(ctx: Ctx, deps: Deps, attempt: number): Promise<{ retry: boolean; status?: string }>;
   }
   export function boundedRetry<Ctx, Deps>(
     body: readonly BlueprintNode<Ctx, Deps>[],
     opts: BoundedRetryOptions<Ctx, Deps>,
   ): BlueprintNode<Ctx, Deps>;
   ```
   - Returned node: `name = opts.name`; `kind` is `'agentic'` if any body node is agentic, else `'deterministic'`.
   - `run()`: loop `attempt` from 0 to `maxAttempts-1`; each iteration runs every body node in order
     (yield all their events); after a non-final iteration call `decide(...)`, yield its `status` if
     present, and **break** if `retry` is false. A body node that **throws** must propagate (do NOT catch
     it — a thrown error is fatal, only `decide` drives retries). Stays generic — **no** import of
     `oneshot/`.
   - Export it from wherever the engine's public surface is exposed if there's an index; otherwise just the file.
3. **Heuristic classifier** in a new `src/oneshot/classify.ts`:
   - `export type FailureClass = 'transient' | 'permanent';`
   - `export function classifyFailure(output: string): FailureClass` — returns `'transient'` if the
     combined output matches known transient markers (timeouts: `timed out`/`ETIMEDOUT`; connection:
     `ECONNRESET`/`ECONNREFUSED`/`EAI_AGAIN`/`socket hang up`; `network`; rate/availability: `rate limit`/
     `429`/`503`/`temporarily unavailable`), else `'permanent'`. Case-insensitive. Add a comment that the
     LLM fallback for ambiguous cases is deferred (a future slice).
   - `export function checkFailed(r: CheckResult | undefined): boolean` — true iff `r` exists, is not
     `skipped`, and `exitCode !== 0`. (Shared by the decider and the implement feedback.)
4. **Wire the loop** in `repo-oneshot.ts`: build `fixLoop = boundedRetry<OneShotContext, OneShotDeps>([implementNode, lintNode, testNode], { name: 'implement-check-loop', maxAttempts: 2, decide })`,
   and make the blueprint `[cloneNode, researchNode, planNode, branchNode, fixLoop, pushNode, openPrNode]`.
   The `decide` callback (define it in this file or a small local helper):
   - Collect failing results: `[ctx.lintResult, ctx.testResult].filter(checkFailed)`.
   - If none failing → `{ retry: false }` (success: checks passed or were skipped).
   - Else classify the joined failing `output`: `'transient'` → `{ retry: true, status: 'checks failed (transient) — retrying…' }`;
     `'permanent'` → `{ retry: false, status: 'checks failed (permanent) — opening PR with failing checks for review' }`.
5. **Implement node feeds failure back on a retry** (`implement.ts`): before building the directive,
   gather `[ctx.lintResult, ctx.testResult].filter(checkFailed)` (use `checkFailed` from `classify.ts`).
   If non-empty (i.e. a prior cycle's checks failed), prepend a section to the directive: a short line
   that the previous attempt's checks failed, then the captured output (cap the combined output to ~1500
   chars), then "Fix these issues." The existing directive (workdir + commit + plan + instruction) stays.
   On the first attempt these results are undefined, so this only triggers on a retry — no flag needed.
6. **Tests:**
   - `test/blueprint.test.ts`: new `boundedRetry` unit tests using simple fake `BlueprintNode`s (a counter
     node that records how many times it ran and yields a status): (a) `decide`→no-retry runs the body once;
     (b) `decide`→retry re-runs the body until `maxAttempts`; (c) `decide`→stop after attempt 0 runs body
     exactly twice... — design the cases to prove: body runs once when no retry; body runs `maxAttempts`
     times when decide always retries; an intermediate stop breaks early; body-node events are forwarded
     every cycle; the `decide` status is yielded; a throwing body node propagates (the combinator does not
     swallow it). Also update the `blueprintFor('repo-oneshot')` node-name order to
     `['clone','research','plan','branch','implement-check-loop','push','open-pr']` and the node-kinds test
     (the loop node is `'agentic'`).
   - `test/classify` coverage (in `test/oneshot.test.ts` or a new `test/classify.test.ts`): transient
     markers classify transient; a plain assertion-failure / "missing file" output classifies permanent;
     `checkFailed` true only for non-skipped non-zero results (skipped→false, exit 0→false).
   - `test/oneshot.test.ts` retry-path tests. **You will need to extend the fakes:**
     - `FakeGitNodeExecutor`: allow a *sequence* of results per kind so a check can fail then pass across
       cycles — e.g. add `queueCheckResults(kind, results: CheckResult[])` that returns successive entries
       (last one sticks once the queue drains). Keep `setCheckResult` working (single fixed result).
     - `FakeRunner`: each agentic turn consumes one scripted entry. With `maxAttempts: 2`, a retried run
       does research(1) + plan(1) + implement(cycle1) + implement(cycle2) = **4** turns; script enough.
     Cases:
     - **transient retry then success:** lint returns `{exitCode:1, output:'... ETIMEDOUT ...', skipped:false}`
       on cycle 1, `{exitCode:0, output:'', skipped:false}` on cycle 2 ⇒ implement runs **twice**
       (`innerRunner.sends` for implement-kind prompts = 2), a `'checks failed (transient) — retrying…'`
       status appears, and push + openChangeRequest happen (PR opens).
     - **permanent failure:** lint returns `{exitCode:1, output:'Error: missing file foo.ts', skipped:false}`
       ⇒ **no** retry (implement runs once), a `'…(permanent)…'` status appears, and push + PR **still happen**
       (PR opens with failing checks).
     - **exhaustion:** lint returns transient-classified failure every cycle ⇒ implement runs exactly
       `maxAttempts` times, then push + PR happen (PR opens despite still-failing checks).
     - **retry feeds the failure back:** on the transient-retry case, assert the **second** implement prompt
       contains the failing check output (e.g. `'ETIMEDOUT'`) and a fix instruction — the first does not.

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the real tail.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers); strict / `noUncheckedIndexedAccess` /
  `exactOptionalPropertyTypes`.
- **`src/blueprints/combinators.ts` must NOT import `src/oneshot/` or `src/broker/`** (the
  `blueprints-engine-stays-generic` dependency-cruiser rule fails the build otherwise). All oneshot
  knowledge (classifier, check-result reading) lives in the injected `decide` callback / `classify.ts`.
- Only agentic nodes touch `deps.inner`; the combinator delegates to body nodes and never touches it directly.
- Never log message contents or tokens. Keep the suite offline (fakes only).
- Keep the diff focused — touch only the files named above. Do NOT commit.

## Out of scope (do NOT build)

- LLM-fallback classifier (heuristic only — deferred).
- Making checks actually gate/block the PR (the decision is: open the PR regardless, surface failures).
- Config knob for `maxAttempts` (hardcode 2 in `repo-oneshot.ts` for this slice).
- The lease-free agentic context view (separate item).
- Broader lint/test discovery (tracked in issue #19).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The real tail of `npm run gate` (incl. the vitest pass count).
- Any deviation from this spec and why.
- Anything a unit test can't catch (e.g. that a real agent, given the fed-back failure output, actually
  fixes the checks — only a live smoke shows that; the coordinator runs it).
