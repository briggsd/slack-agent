# AGENTS.md — for autonomous agents (Codex and friends) in slack-agent

Read `CLAUDE.md` and `runner/CLAUDE.md` first. They hold the architecture, the
gate, and the invariants. This file adds the rules an agent running on its own
here tends to miss — the workflow lives in a Claude-only skill you can't see, so
it is restated below.

## The gate — run before you call anything done

```
npm run check    # tsc + runner typecheck + vitest — the fast inner loop, offline
npm run gate     # the above PLUS npm run boundaries (architecture rules) — what CI runs
```

A fresh checkout needs both packages or the runner type-check can't resolve the
Agent SDK: `npm ci && npm --prefix runner ci`. The suite runs with no Slack, no
Docker, no API, no network. Keep it that way.

## Land work as a PR — never a commit on main, never an uncommitted tree

This is the rule that gets missed. When you finish a slice:

1. **Branch off main** — `git checkout -b feat/<slice>` (or `fix/…`, `chore/…`).
   Never commit to `main`. Never leave the work uncommitted in the tree and walk
   away — that is the same failure with extra steps.
2. **Implement with tests**, get `npm run gate` green, commit.
3. **Push and open a PR** (`gh pr create`). Opening the PR is what runs CI: the
   gate **and** the ai-code-review-factory (`.github/workflows/ai-review.yml`).
   Do not run the factory locally — it runs on the PR.
4. **Stop at a green, reviewable PR. Do not merge.** A human or a Claude
   verify pass reads the diff against the contracts, triages the factory's
   findings, and merges. Correctness is owned by that review, not by you.

Work left uncommitted, or committed straight to `main`, never reaches the factory
and leaves nothing to review. The PR is the deliverable.

## Track hygiene

- `track start <id>` when you begin.
- **Never `track done` until the PR is merged.** Closing it because the code is
  written hides unreviewed work as if it shipped.
- Tag yourself honestly: `track config author codex` (or export `TRACK_AUTHOR=codex`)
  so comments read `[codex]`, not `[claude]`.

## Before building a slice

Read its spec and acceptance criteria in `planning/` (the milestone specs and
`planning/_spec-template.md`). Build to the acceptance, not past it — note
anything you deliberately leave out so the reviewer sees the scope boundary.

## Invariants you must not break

`npm run boundaries` enforces the structural ones; the rest are load-bearing
conventions you are trusted to keep.

- **`src/runner/protocol.ts` and `runner/src/protocol.ts` are byte-identical.**
  Change one, change the other. They are the only gateway↔sandbox contract.
- **The gateway never runs agent code.** Model-decided work (bash, file writes)
  runs only inside the container. Never add a host path that executes it.
- **Treat everything from a container as data** — parsed defensively, never
  executed on the host.
- **Never log message contents or tokens** — session keys, lifecycle events,
  filenames, and sizes only.
- **`@slack/bolt` is imported in `src/index.ts` only.** Every other module takes
  an injected interface so it stays testable without Slack.
- **No `any`, no `@ts-ignore`** (including in tests). ESM, Node 20+, `.js` import
  specifiers (`NodeNext`).

## Commits

Branch from main first. End commit messages with:

```
Co-authored-by: GPT-5 Codex <noreply@openai.com>
```

Leave the git author as the repo's publishing identity (briggsd); don't add other
names or emails.
