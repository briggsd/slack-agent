# Task: Add `research` and `plan` agentic nodes to the one-shot blueprint (the RPI front of the flow)

You are implementing one slice in the slack-agent repo (in an isolated worktree off branch
`sonnet/m5-s04b2-research-plan`). TypeScript, Node 20+, ESM (`.js` import specifiers), vitest,
strict tsc. **Read the root `CLAUDE.md` first** (gate, invariants, conventions), then the context
below.

## Context — read before writing code

This is the one-shot repo-work flow, expressed as a declarative blueprint (an ordered list of
nodes over the generic engine in `src/blueprints/`). Today the blueprint is
`clone → branch → implement → push → open-pr` (`src/oneshot/repo-oneshot.ts`). This slice adds the
**research → plan** front of the design's full RPI (research-plan-implement) flow, so the agent
inventories the repo and writes a plan *before* it implements — the data-room pattern that kills
most brownfield hallucination. Target order after this slice:
`clone → research → plan → branch → implement → push → open-pr`.

Key fact about the seam: all agentic nodes share **one** inner `SessionRunner` (one Docker
container = one persistent Agent SDK session). `research`, `plan`, and `implement` are three
`deps.inner.send()` turns **in the same conversation** — the agent's session carries context
across turns, so the plan turn can reference the research it just did, and implement can reference
the plan. The prompts therefore stay lean; you do NOT need to re-feed prior output into later
prompts. (You still capture each turn's final text into `ctx` for observability + downstream use.)

Code this builds on (all under `src/oneshot/`):
- `nodes/implement.ts` — the existing agentic node. It yields a `status`, sends a directive to
  `deps.inner`, forwards inner `status` events, captures the inner `text` into `ctx.implementSummary`,
  and throws on an inner `error` event. **This is your precedent for an agentic node** — research
  and plan have the same mechanics.
- `nodes/clone.ts`, `nodes/branch.ts` — node structure (`name`, `kind`, `run`).
- `context.ts` — `OneShotContext` (`workdir`, `branch`, `instruction`, `implementSummary?`, …) and
  `OneShotDeps` (`inner: SessionRunner`, `gitNodes`). `OneShotNode = BlueprintNode<OneShotContext, OneShotDeps>`.
- `repo-oneshot.ts` — the blueprint node list.
- `src/blueprints/README.md` — how a node is authored; `kind: 'agentic'` nodes are the only ones
  allowed to touch `deps.inner` (the engine never runs agent code — the container is the boundary).

Test infra (offline — no Docker/network):
- `test/oneshot.test.ts` is the behavior pin. `FakeRunner(sessionKey, script)` scripts turns: each
  array entry is one `send()` turn's events. `innerRunner.sends: string[]` records every prompt sent,
  in order — assert the research/plan/implement prompts there. `FakeBroker`, `FakeGitNodeExecutor`
  as today.
- `test/blueprint.test.ts` has a `blueprintFor('repo-oneshot')` test asserting the node-name order —
  update it.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND `npm run gate` passes.
Make every edit, update/add tests, run the gate, fix failures, then stop. Yielding after only
exploring (zero file changes) is a failure — implement end to end in this run.

## Acceptance criteria

1. `npm run gate` passes (`npm run check` + `npm run boundaries`) — all existing tests stay green
   (after the order/prompt updates below), plus new ones. Paste the real tail.
2. **Shared agentic-turn helper** at `src/oneshot/nodes/agentic-turn.ts`: a small async generator,
   e.g. `runAgenticTurn(deps, prompt, onText)`, that sends `prompt` to `deps.inner`, forwards inner
   `status` events (re-yielded as `status`), passes each inner `text` to the `onText` callback (so
   the caller stores it where it wants), and **throws** on an inner `error` event (message prefixed
   like implement's `Inner agent error: …`). Refactor `implement.ts`, `research.ts`, and `plan.ts`
   to all use it — three copies of the same loop is the smell this removes.
   - `implement.ts`'s externally-visible behavior must NOT change: it still yields `'implementing…'`,
     sends the **same** directive (repo cloned at `ctx.workdir` on `ctx.branch`; make changes + commit
     there), and writes the captured text to `ctx.implementSummary`. You MAY add one sentence to the
     directive tying it to the plan (e.g. "Implement the plan you produced."), but keep the workdir +
     commit instruction intact (item 1 depends on it).
3. **`research` node** (`src/oneshot/nodes/research.ts`, `kind: 'agentic'`, `name: 'research'`):
   yields status `'researching…'`, then drives one agentic turn whose prompt instructs the agent to
   investigate the repo cloned at `ctx.workdir` (structure, conventions, the parts relevant to the
   task) **without making changes yet**, and includes the task `ctx.instruction`. Capture the turn's
   final text into a new `ctx.researchSummary`.
4. **`plan` node** (`src/oneshot/nodes/plan.ts`, `kind: 'agentic'`, `name: 'plan'`): yields status
   `'planning…'`, then drives one agentic turn whose prompt instructs the agent to write a concise
   implementation plan based on what it just found, **still without making changes**. Capture the
   final text into a new `ctx.planSummary`.
5. **`OneShotContext`** (`context.ts`) gains `researchSummary?: string` and `planSummary?: string`
   (optional accumulators, same style as `implementSummary?`).
6. **Blueprint order** (`repo-oneshot.ts`) becomes
   `[clone, research, plan, branch, implement, push, openPr]`.
7. **Tests** in `test/oneshot.test.ts` and `test/blueprint.test.ts`:
   - Update `blueprint.test.ts` node-name order to `['clone','research','plan','branch','implement','push','open-pr']`.
   - Update the happy-path test: the `FakeRunner` script must now supply **three** scripted turns
     (research, plan, implement) — give each a distinct final `text` (e.g. `'research done'`,
     `'plan done'`, `'impl done'`). Add `'researching…'` and `'planning…'` to the expected status
     set and extend the ordering chain to clone < research < plan < branch < implement < push < pr.
   - `innerRunner.sends` now has length 3. Assert: `sends[0]` (research) contains the workdir and the
     instruction; `sends[1]` (plan) is the plan prompt; `sends[2]` (implement) contains the workdir
     and mentions committing. Assert order (research before plan before implement).
   - Assert `ctx` accumulators land: after a run, the orchestrator's terminal text still carries the
     PR url (unchanged). (You can't read `ctx` directly from outside; instead assert via `innerRunner.sends`
     and statuses. If you want to pin `researchSummary`/`planSummary`, do it through a node-level unit
     test that calls the node `run()` with a fake `deps` and inspects the mutated ctx — your call.)
   - Add a failure-path test: script the **research** turn to emit an `error` event ⇒ lease acquired
     and revoked exactly once, a single terminal `error` event, and **no** branch/push/openChangeRequest
     calls and no plan/implement turns (assert `gitNodes.branches`/`pushes`/`changeRequests` empty;
     `innerRunner.sends` has length 1 — only research was attempted).

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the real tail.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers); strict / `noUncheckedIndexedAccess` /
  `exactOptionalPropertyTypes`.
- Only `kind: 'agentic'` nodes touch `deps.inner` (research/plan/implement). The engine stays generic
  — do not import `oneshot/` from `src/blueprints/` (a dependency-cruiser rule enforces this).
- Inject deps; suite stays offline (FakeRunner/FakeBroker/FakeGitNodeExecutor). Never log message
  contents or tokens.
- Keep the diff focused — touch only the files named above.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build — later sub-slices, confirmed with the user)

- `lint` / `test` deterministic nodes and lint/test command discovery (sub-slice 2b).
- `boundedRetry` combinator and the failure classifier (sub-slice 2c).
- The lease-free agentic context view (separate S04b item).
- Enriching the PR body with the plan, or any `open-pr.ts` change.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The real tail of `npm run gate` (incl. the vitest pass count).
- Any deviation from this spec and why.
- Anything a unit test can't catch (e.g. that the agent's session actually carries research→plan→implement
  context across turns is only provable by a live smoke — the coordinator runs it).
