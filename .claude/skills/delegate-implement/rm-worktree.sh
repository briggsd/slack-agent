#!/usr/bin/env bash
# rm-worktree.sh — tear down a worktree created by new-worktree.sh.
#
# Refuses to nuke uncommitted work: if the worktree is dirty it stops and tells you, so a
# merged-but-not-pushed commit or stray edit isn't silently lost. Pass --force to override.
#
# Usage:
#   .claude/skills/delegate-implement/rm-worktree.sh <branch> [--force] [--delete-branch]
#     <branch>          the branch passed to new-worktree.sh (e.g. sonnet/m4-session-store)
#     --force           remove even if the worktree has uncommitted changes; ALSO upgrades
#                       --delete-branch from a safe `git branch -d` to a force `-D`.
#     --delete-branch   also delete the local branch. Safe by default (`-d` refuses an
#                       unmerged branch). NOTE: a squash-merge is NOT recognized as merged by
#                       `-d` — clean up a squash-merged branch with --force.
set -euo pipefail

BRANCH="${1:-}"
FORCE=""
DEL_BRANCH=""
for arg in "${@:2}"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    --delete-branch) DEL_BRANCH="1" ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  echo "usage: rm-worktree.sh <branch> [--force] [--delete-branch]" >&2
  exit 2
fi

# Resolve the MAIN checkout even when invoked from inside a linked worktree (see new-worktree.sh).
MAIN="$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")"
PARENT="$(dirname "$MAIN")"
SLUG="$(printf '%s' "$BRANCH" | tr '/' '-')"
DIR="$PARENT/sa-wt-$SLUG"

# If the worktree dir is already gone, allow a branch-only cleanup.
if [[ ! -d "$DIR" ]]; then
  if [[ -z "$DEL_BRANCH" ]]; then
    echo "error: $DIR not found — nothing to remove." >&2
    exit 1
  fi
  echo "→ worktree $DIR already gone; cleaning up branch only."
else
  echo "→ removing worktree $DIR"
  # Strip our own node_modules symlinks first (root + runner). `.gitignore` has `node_modules/`
  # (a dir pattern) which does NOT match a symlink, so git reports them untracked and would
  # falsely trip the dirty-tree guard. Removing them leaves the guard reflecting only real work.
  [[ -L "$DIR/node_modules" ]] && rm -f "$DIR/node_modules"
  [[ -L "$DIR/runner/node_modules" ]] && rm -f "$DIR/runner/node_modules"
  if ! git -C "$MAIN" worktree remove $FORCE "$DIR"; then
    echo "→ worktree NOT removed (see git error above). If it's only uncommitted changes, re-run with --force." >&2
    exit 1
  fi
  echo "✓ worktree removed"
fi

if [[ -n "$DEL_BRANCH" ]]; then
  # Idempotent: a completed prior run already deleted the branch — re-running must not error.
  if ! git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "→ branch $BRANCH already gone"
  elif [[ -n "$FORCE" ]]; then
    git -C "$MAIN" branch -D "$BRANCH" && echo "✓ branch $BRANCH force-deleted"
  elif git -C "$MAIN" branch -d "$BRANCH" 2>/dev/null; then
    echo "✓ branch $BRANCH deleted"
  else
    echo "→ branch $BRANCH not fully merged (a squash-merge isn't seen as merged) — re-run with --force to force-delete." >&2
  fi
fi
