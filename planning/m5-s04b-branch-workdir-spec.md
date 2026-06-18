# Task: Add a deterministic `branch` node and tell the implement node the clone workdir (kills the one-shot 422)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(this worktree: `/Users/jedanner/workspace/sa-wt-sonnet-m5-s04b-branch-workdir`).
TypeScript, Node 20+, ESM (`.js` import specifiers), vitest, strict tsc.
**Read the root `CLAUDE.md` first** (gate, invariants, conventions), then the
context below. You are on branch `sonnet/m5-s04b-branch-workdir`.

## Context — read before writing code

This is the one-shot repo flow: `@bot task github:owner/repo <instruction>` clones a
repo into a per-session Docker volume, lets the agent implement the change, then pushes
a branch and opens a PR. It runs as a declarative blueprint (ordered list of nodes) over
the generic engine in `src/blueprints/` (read `src/blueprints/README.md`).

A **live smoke** proved the flow reaches the agent and the credential boundary works, but
exposed a real bug offline tests can't see: the pushed branch lands at the **same SHA as
the default branch** → GitHub **422 "no commits between base and head"** on PR creation.
Root cause: the agent **is never told where the clone is**, so its file-writes and commit
land outside the cloned tree (`/workspace/<repoSlug>`); meanwhile the design's
deterministic `branch` node (a `git checkout -b` before implement) was never built. This
slice fixes both.

Code this builds on (all under `src/oneshot/`):
- `git-node.ts` — the `GitNodeExecutor` interface + the `CloneRequest` / `PushRequest` /
  `OpenChangeRequest` request types. **This is the contract you extend.**
- `docker-git-node.ts` — `DockerGitNodeExecutor`, the real impl. `clone`/`push` run as
  ephemeral `docker run --rm` containers that mount the session volume at `/workspace`
  and run `git` via `--entrypoint git`. Note `dockerRunArgs(volume, gitArgs)` (private)
  builds the argv; `runDocker(spawnFn, args, token, what, context)` spawns it.
- `fake-git-node.ts` — `FakeGitNodeExecutor`, records every call (`clones`, `pushes`,
  `changeRequests`) for assertions; has `failNextPush` / `failNextOpenChange`.
- `nodes/clone.ts`, `nodes/implement.ts`, `nodes/push.ts`, `nodes/open-pr.ts` — the four
  blueprint nodes. `clone` and `push` are your precedent for a deterministic git node.
- `repo-oneshot.ts` — the blueprint: `{ id: 'repo-oneshot', nodes: [clone, implement, push, openPr] }`.
- `context.ts` — `OneShotContext` (has `repo`, `instruction`, `workdir`, `branch`, `volume`,
  `lease`, …) and `OneShotDeps` (`inner: SessionRunner`, `gitNodes: GitNodeExecutor`).
- `orchestrator.ts` — builds `ctx` (note: `workdir = /workspace/${repo.replaceAll('/','-')}`,
  `branch = slackbot/oneshot-${taskId}`) and runs the blueprint. **You do not need to change it.**

### Grounded facts (so you don't have to re-derive)

- The **shared volume** is the coordination mechanism: the ephemeral `branch` container and
  the persistent agent container both mount the same `/workspace` volume, so a branch created
  by `git -C <workdir> checkout -b <branch>` in the branch node is already checked out when
  the agent runs. This is exactly how `clone` (ephemeral) hands files to the agent today.
- `push` already pushes `HEAD:<branch>` (PR #13), so it works whether or not a local branch
  exists — but the `branch` node makes the local branch name match `ctx.branch`, and, crucially,
  the **workdir directive** is what makes HEAD actually advance (the agent commits in the
  cloned tree). The directive is the load-bearing fix for the 422; the branch node is design
  completeness.
- **Branch creation needs no credential** — `git checkout -b` is purely local. So `BranchRequest`
  must **not** carry a `lease`/token (unlike clone/push). In `DockerGitNodeExecutor.branch`, do
  not set a `credential.helper`, and pass an empty token to `runDocker` (`''`). `dockerRunArgs`
  still injects `-e GIT_TOKEN`; an empty value is harmless since no git op in this node reads it.
- The agent commits today (the smoke confirmed it commits — just in the wrong directory). So
  the fix is to tell it the directory and to commit there, **not** to add a deterministic commit
  node (out of scope; see below).

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND `npm run gate`
passes. Make every edit, add/adjust tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end in this run.

## Acceptance criteria

1. `npm run gate` passes (`npm run check` + `npm run boundaries`) — all existing tests keep
   passing (after the updates in #5 below), plus the new ones. Paste the real tail.
2. **New deterministic `branch` node** at `src/oneshot/nodes/branch.ts`: `name: 'branch'`,
   `kind: 'deterministic'`. It yields a status event (`'creating branch…'`) and calls
   `deps.gitNodes.branch({ repo: ctx.repo, branch: ctx.branch, workdir: ctx.workdir, volume: ctx.volume })`.
3. **`GitNodeExecutor` contract extended** in `src/oneshot/git-node.ts`: add
   `branch(req: BranchRequest): Promise<void>` and a `BranchRequest` interface with
   `repo: string; branch: string; workdir: string; volume: string` (**no `lease`**). Mirror the
   doc-comment style of `CloneRequest`/`PushRequest` and note the no-credential rationale.
   - `DockerGitNodeExecutor.branch` runs `git -C <workdir> checkout -b <branch>` via the existing
     `dockerRunArgs`/`runDocker` path with an **empty** token and **no** `credential.helper`.
     gitArgs = `['-C', req.workdir, 'checkout', '-b', req.branch]`. Use a `what`/`context` string
     parallel to the others (e.g. `'git branch'`, `` `repo: ${req.repo}, branch: ${req.branch}` ``).
   - `FakeGitNodeExecutor.branch` records into a new public `branches: BranchRequest[]` array, and
     add a `failNextBranch(err: Error)` matching the existing `failNextPush` pattern (used by a test).
4. **Implement node tells the agent the workdir + to commit there.** In `src/oneshot/nodes/implement.ts`,
   instead of sending the bare `ctx.instruction`, send a composed message that:
   - states the repo is cloned at `ctx.workdir` (the exact path string) on branch `ctx.branch`,
   - instructs the agent to make all file changes inside that directory and to **commit** them
     there with git before finishing,
   - then includes the original `ctx.instruction` verbatim.
   Keep it short and plainly worded (no AI-tell filler). Everything else in the node (status
   forwarding, `implementSummary` capture, inner-error handling) stays unchanged.
5. **Blueprint order** in `src/oneshot/repo-oneshot.ts` becomes `[clone, branch, implement, push, openPr]`.
6. **Tests updated/added** in `test/oneshot.test.ts` (this is the one-shot behavior pin — it
   intentionally changes here because behavior changes; keep every unrelated assertion green):
   - Update the "runs the full blueprint in order" test: add `'creating branch…'` to the expected
     status texts and extend the ordering assertion to clone < branch < implement < push < pr.
   - Update the "sends the instruction to the inner runner" test: `innerRunner.sends[0]` is now the
     composed directive — assert it **contains** `'add a CHANGELOG'` (the instruction) **and** the
     workdir `'/workspace/acme-widgets'` **and** mentions committing (assert on a stable lowercased
     substring like `'commit'`). Do not assert exact equality.
   - Update "records clone, push, and openChangeRequest calls" (or add a sibling) to assert
     `gitNodes.branches` has length 1 with `branch` matching `slackbot/oneshot-` and
     `workdir === '/workspace/acme-widgets'` and the right `volume` (`volumeNameFor(TEST_SESSION_KEY)`).
   - Add a failure-path test mirroring the existing push-failure test: `gitNodes.failNextBranch(...)`
     ⇒ lease acquired and revoked exactly once, a single terminal `error` event, and **no** push /
     openChangeRequest calls and no `text` event (branch fails before implement, so the inner runner
     must not be sent anything — assert `innerRunner.sends` is empty too).

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the real tail when done.
- Conventions per root `CLAUDE.md`: **no `any`, no `@ts-ignore`**; `NodeNext` ESM (`.js`
  specifiers); strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Inject dependencies; the suite is **offline** — no Slack/Docker/API/network. Use the existing
  fakes (`FakeBroker`, `FakeRunner`, `FakeGitNodeExecutor`).
- **Never log message contents or tokens** — and never put a token in argv/URL/log. The branch
  node uses no token; clone/push keep the inline-credential-helper pattern unchanged.
- The gateway never runs agent code; the `branch` node is `kind: 'deterministic'` (trusted-side).
- Keep the diff focused — touch only the files named above.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build)

- A deterministic **commit** node (the agent commits, per the directive). If you suspect the agent
  won't reliably commit, note it in your report — do not build it here.
- The research / plan / lint / test nodes, the `boundedRetry` combinator, the failure classifier
  (later S04b items).
- The lease-free **agentic context view** (split `OneShotContext`) — a separate S04b item.
- Any change to `orchestrator.ts`, the broker, profiles, or `src/blueprints/` (the generic engine
  stays generic — a dependency-cruiser rule forbids it importing `oneshot/`).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The real tail of `npm run gate` (not paraphrased) — include the vitest pass count.
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (or couldn't) — in particular,
  the agent-actually-commits behavior is only provable by a live smoke (the coordinator runs it).
