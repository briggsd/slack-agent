#!/usr/bin/env bash
# merge-worktree.sh — land a lane PR and tear its worktree down in one idempotent command.
#
# Why this exists: `gh pr merge <N> --squash --delete-branch` run from INSIDE a lane worktree
# aborts mid-way — gh tries to `git checkout main` in the current worktree to delete the local
# branch, but `main` is held by the primary checkout (`fatal: 'main' is already used by
# worktree`), so it merges server-side but never deletes the remote branch. This script runs
# the always-works sequence instead — no `--delete-branch`, explicit remote delete, force
# teardown — and is safe to re-run after a partial failure (each step is a no-op if already done).
#
# Usage:
#   .claude/skills/delegate-implement/merge-worktree.sh <pr#> [branch] [--force]
#     <pr#>      the PR number to squash-merge.
#     [branch]   the lane branch (e.g. sonnet/m4-session-store). Optional — defaults to the PR's
#                head branch (resolved via `gh pr view`).
#     --force    override both safety gates: (1) skip the blocking-check green-gate, and (2) tear
#                the worktree down even if it has uncommitted changes. WITHOUT --force, teardown
#                refuses a dirty worktree so stray work isn't silently lost.
set -euo pipefail

# The blocking PR check — the job name in .github/workflows/ci.yml. Keep these in sync.
BLOCKING_CHECK="Type-check, tests & boundaries"

PR=""
BRANCH=""
FORCE=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *)
      if [[ -z "$PR" ]]; then PR="$arg"
      elif [[ -z "$BRANCH" ]]; then BRANCH="$arg"
      else echo "unexpected argument: $arg" >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "usage: merge-worktree.sh <pr#> [branch] [--force]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve the MAIN checkout even when invoked from inside a linked worktree (see new-worktree.sh).
MAIN="$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")"

# Resolve branch from the PR when not supplied.
if [[ -z "$BRANCH" ]]; then
  BRANCH="$(gh pr view "$PR" --json headRefName -q .headRefName)"
  if [[ -z "$BRANCH" ]]; then
    echo "error: could not resolve head branch for PR #$PR — pass it explicitly." >&2
    exit 1
  fi
  echo "→ resolved branch: $BRANCH"
fi

STATE="$(gh pr view "$PR" --json state -q .state)"

if [[ "$STATE" == "MERGED" ]]; then
  echo "→ PR #$PR already merged; skipping merge, running cleanup only."
else
  if [[ "$STATE" != "OPEN" ]]; then
    echo "error: PR #$PR is $STATE (not OPEN/MERGED) — refusing to merge." >&2
    exit 1
  fi
  # Green-gate on the blocking check. --force skips this. (The factory AI review is run locally
  # by the coordinator before this step — it is NOT a PR check here, so don't gate on it.)
  if [[ -z "$FORCE" ]]; then
    # statusCheckRollup can carry more than one entry for the same check name (a re-run); take the
    # last (most-recent) conclusion so $CHECK is a single value, not a multi-line string.
    CHECK="$(gh pr view "$PR" --json statusCheckRollup \
      -q ".statusCheckRollup[] | select(.name==\"$BLOCKING_CHECK\") | .conclusion" 2>/dev/null \
      | tail -n1 || true)"
    if [[ "$CHECK" != "SUCCESS" ]]; then
      echo "error: blocking check '$BLOCKING_CHECK' is '${CHECK:-not found}', not SUCCESS." >&2
      echo "       wait for it to pass, or re-run with --force to override." >&2
      exit 1
    fi
    echo "✓ blocking check '$BLOCKING_CHECK' is green"
  fi
  echo "→ squash-merging PR #$PR"
  # No --delete-branch: that's the footgun (see header). Remote branch is deleted explicitly below.
  gh pr merge "$PR" --squash
  echo "✓ PR #$PR squash-merged"
fi

# Delete the remote branch explicitly (idempotent — a no-op if already gone).
if git -C "$MAIN" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git -C "$MAIN" push origin --delete "$BRANCH"
  echo "✓ remote branch $BRANCH deleted"
else
  echo "→ remote branch $BRANCH already gone"
fi

# Sync local main so the next worktree forks from the just-merged tip. Warn (don't silently
# swallow) on failure — a stale local main is a real footgun the next slice forks from.
git -C "$MAIN" fetch origin main --quiet || true
if ! git -C "$MAIN" merge --ff-only origin/main >/dev/null 2>&1; then
  echo "⚠ could not fast-forward local main to origin/main — sync it yourself once clear:" >&2
  echo "    git -C \"$MAIN\" merge --ff-only origin/main" >&2
  echo "  (common causes: the main checkout is on another branch, or has untracked files that collide.)" >&2
fi

# Local worktree + branch teardown. Guard against discarding real uncommitted work: find the
# worktree's ACTUAL path (don't reconstruct the sa-wt-<slug> convention, or the guard would
# silently skip whenever a worktree sits elsewhere). Ignore our node_modules symlinks.
DIR="$(git -C "$MAIN" worktree list --porcelain | awk -v b="refs/heads/$BRANCH" '
  $1=="worktree"{p=substr($0,10)} $1=="branch"&&$2==b{print p; exit}')"
if [[ -z "$FORCE" && -n "$DIR" && -d "$DIR" ]]; then
  DIRTY="$(git -C "$DIR" status --porcelain | grep -vE '^\?\? (runner/)?node_modules$' || true)"
  if [[ -n "$DIRTY" ]]; then
    echo "error: worktree $DIR has uncommitted changes — refusing to tear down (it would discard them):" >&2
    echo "$DIRTY" >&2
    echo "       commit/stash/discard them, or re-run merge-worktree.sh with --force." >&2
    exit 1
  fi
fi
echo "→ tearing down local worktree + branch"
"$SCRIPT_DIR/rm-worktree.sh" "$BRANCH" --force --delete-branch
