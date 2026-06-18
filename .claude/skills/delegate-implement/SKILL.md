---
name: delegate-implement
description: Coordinator/implementer workflow tuned for the slack-agent repo — the coordinator researches, writes a tight spec from planning/_spec-template.md, hands a decided slice to an in-harness implementer subagent (Sonnet by default, Haiku for trivial) working in an isolated worktree, then verifies, runs the ai-code-review-factory locally, triages findings, opens a PR, and lands it with merge-worktree.sh. Use when delegating a milestone work item here ("delegate this slice", "have sonnet/haiku build M4 S0N").
---

# delegate-implement (slack-agent overlay)

This repo's pins for the coordinator/implementer workflow. The portable narrative (the loop,
failure modes, review-triage rubric) lives at `~/.claude/skills/delegate-implement/SKILL.md`.
This file overrides it with slack-agent's concrete values. **You (coordinator) keep a lean
context and never type the slice yourself** — research, spec, hand off, verify, review, merge.

## The loop (per work item)

1. **Research non-trivial bits first** (subagent). For anything you can't implement confidently
   from memory — an SDK call, a protocol shape, a Slack API — spawn an `Explore` subagent to
   find the grounding (real `.d.ts`, existing patterns) and report back. Don't guess in the spec.
2. **Write the spec** to `planning/m<N>-s<NN>-spec.md` from `planning/_spec-template.md`. Cite the
   design note(s) in `design/` (the *why*) and the exact files to touch — and **inline the grounded
   facts** (line numbers, API shapes) so the implementer doesn't need `design/` (it's gitignored
   and absent from worktrees). Make acceptance criteria directly testable. **Cite the invariants
   the slice touches** (below).
3. **Spin an isolated worktree** — `new-worktree.sh <backend>/<slug>` (see Worktrees below).
4. **Commit the spec into the slice branch, then hand off.** Copy the spec into the worktree and
   commit it there as the branch's first commit — keep it *tracked*, never leave it untracked in
   the worktree (an untracked spec trips `merge-worktree.sh`'s dirty-guard at teardown). Then hand
   off to the implementer subagent — Sonnet by default, Haiku for mechanical/trivial slices —
   giving it the worktree path, the spec path, and the gate command. It implements, adds tests,
   runs `npm run gate`, and reports with the gate output (the implementer must NOT touch the spec).
5. **Coordinator-verify** — reconcile the report ⇆ `git diff`; run `npm run gate` yourself in the
   worktree. A "done" claim is not a passing gate until you've seen it.
6. **Review locally with the factory** + triage (see Review below).
7. **Open a PR**, let CI run the gate, then **`merge-worktree.sh <pr#>`** to squash-merge + tear
   down. Surface each merge.

## Repo pins

- **Gate (run yourself, every iteration):** `npm run gate` (= `npm run check` + `npm run
  boundaries`). `check` is tsc + runner type-check + vitest; `boundaries` is dependency-cruiser.
  Strict TS, **no `any`, no `@ts-ignore`**. The suite is offline — no Slack/Docker/API/network.
- **Branch convention:** `<backend>/<slug>` — e.g. `sonnet/m4-session-store`, `haiku/fix-reaper`.
- **Commit footer (required):** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
  Tag the subject by backend when a subagent wrote it (`[sonnet]` / `[haiku]`); plain when the
  coordinator applied the fix.
- **Never `git add -A` / `git add .`** — stage explicit paths; `git status` first. A catch-all
  add sweeps in machine-local/ignored files.
- **Tests** live in `test/` (gateway) and `runner/test/` (runner), via the existing fakes
  (`FakeSlackClient`, `FakeChildProcess`, `FakeRunner`, `FakeAgentSdk`). New code takes its
  external deps as injectable params the same way. Keep fake/no-network.

## Invariants to cite in every spec (the implementer must not break)

The structural ones are **boundary-enforced** (`npm run boundaries` fails the build) — name them
anyway so the implementer designs with them, not against them:

- **`protocol.ts` is two byte-identical copies** (`src/runner/protocol.ts` ≡
  `runner/src/protocol.ts`). A protocol change edits BOTH in lockstep.
- **`@slack/bolt` only in `src/index.ts`**; the gateway never imports the Agent SDK or the
  `runner/` package. (See root `CLAUDE.md` and `.dependency-cruiser.cjs`.)
- **The gateway never runs agent code**; the container is the permission boundary.
- **Never log message contents or tokens** — session keys + lifecycle only.

## Worktrees — one per concurrent slice (non-negotiable)

One repo = one HEAD; two agents in the same checkout collide. Give every concurrent slice its
own worktree.

```bash
.claude/skills/delegate-implement/new-worktree.sh <backend>/<slug>   # e.g. sonnet/m4-session-store
#   → ../sa-wt-<slug>, BOTH node_modules symlinked (root + runner/), gate-ready
.claude/skills/delegate-implement/rm-worktree.sh <branch> [--force] [--delete-branch]
.claude/skills/delegate-implement/merge-worktree.sh <pr#> [branch] [--force]   # land + clean up
```

- **In-harness implementer:** prefer pointing a Sonnet/Haiku subagent at a worktree created by
  `new-worktree.sh` (it symlinks BOTH packages' `node_modules`). The Agent tool's
  `isolation: "worktree"` makes its own bare worktree that will NOT have node_modules — if you use
  it, the subagent must `npm ci && npm --prefix runner ci` (or symlink both) before the gate.
- **Landing:** `merge-worktree.sh <pr#>` from the main checkout — **never `gh pr merge
  --delete-branch` from inside a worktree** (it aborts on `'main' is already used by worktree`).
  It green-gates the blocking check `Type-check, tests & boundaries`, squash-merges, deletes the
  remote branch explicitly, ff-syncs local main, and tears the worktree down (refuses a dirty
  worktree without `--force`).

## Review — run the factory locally, then triage

slack-agent's CI is just the gate; the **AI code review is a manual local step** the coordinator
runs against the worktree's diff using the separate `~/workspace/ai-code-review-factory` repo.
Run it **before** opening the PR for security/correctness-heavy slices (skip for doc/trivial).

```bash
# from inside the slack-agent worktree, after the implementer has committed:
cd ../sa-wt-<slug>
git add -N <any-new-untracked-files>   # so the diff sees them; `git reset` after
bun ~/workspace/ai-code-review-factory/src/cli.ts run --git-diff --base main \
  --runtime pi --pi-provider anthropic --pi-model claude-sonnet-4-6 \
  --pi-api-key env:ANTHROPIC_API_KEY --output-dir /tmp/sa-review
# API key (macOS keychain): export ANTHROPIC_API_KEY="$(security find-generic-password -s ANTHROPIC_API_KEY -w)"
```

The factory's flags can change — its `review:local` script and `delegate-implement` SKILL.md are
the source of truth; verify the invocation there if it errors. Running it in the worktree drops a
`.ai-review/` working dir in cwd — it's gitignored, so it won't trip teardown; the grounded findings
are in `<output-dir>/runs/<id>/summary.json` (`.findings`), with raw/withheld ones in the trace.

**Triage discipline** (from the factory's hard-won rules):
- **Don't trust the headline.** A reviewer can fail (timeout/`schema_invalid`) and still read
  "clean" — check the trace for `failedReviewerCount` / `Degraded`, and sanity-check wall-clock
  (a sub-60s "review" with ~0 model tokens is a fake-green, not a pass).
- **Triage each finding** real / false-positive / accept-with-reason. Verify a "CRITICAL" against
  the code before "fixing" — its fix may break an invariant.
- **Max ~2 review rounds**, then accept-and-document the remainder in the PR body and merge on the
  green blocking check. Don't burn cycles on a pure-suggestion round.

## Keep the user in the loop

Human-in-the-loop, not fire-and-forget. Plan which slices and their sequencing with the user;
surface each merge. Throughput isn't the goal — verified, visible merges are.
