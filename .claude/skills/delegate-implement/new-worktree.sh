#!/usr/bin/env bash
# new-worktree.sh — spin up a gate-ready, isolated git worktree for parallel agent work.
#
# WHY: one repo = one HEAD = one index = one working tree. Two agents in the SAME checkout
# collide — agent B's `git checkout -b` makes agent A's next `git commit` land on B's branch,
# and A's `git push` ships a stale base. The fix is one checkout per agent. This script removes
# the friction that otherwise makes a fresh worktree fail the gate: a fresh worktree has no
# node_modules, and slack-agent has TWO packages (root + runner/), so it symlinks BOTH.
#
# Usage:
#   .claude/skills/delegate-implement/new-worktree.sh <branch> [base]
#     <branch>  full branch name, house convention <backend>/<slug>
#               e.g. sonnet/m4-session-store, haiku/fix-reaper-timer
#     [base]    branch to fork from (default: main)
#
# Run from anywhere inside the main checkout. Tear down with rm-worktree.sh / merge-worktree.sh.
set -euo pipefail

BRANCH="${1:-}"
BASE="${2:-main}"

if [[ -z "$BRANCH" ]]; then
  echo "usage: new-worktree.sh <branch> [base]   (e.g. sonnet/m4-session-store main)" >&2
  exit 2
fi

# Resolve the MAIN checkout even when invoked from inside a linked worktree:
# --git-common-dir points at the shared .git (the main worktree's), so its parent IS the main
# checkout. (--show-toplevel would return the *current* worktree's root — wrong from a worktree.)
MAIN="$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")"
PARENT="$(dirname "$MAIN")"
SLUG="$(printf '%s' "$BRANCH" | tr '/' '-')"
DIR="$PARENT/sa-wt-$SLUG"

if [[ -e "$DIR" ]]; then
  echo "error: $DIR already exists — pick another branch or remove it first." >&2
  exit 1
fi

if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "error: branch '$BRANCH' already exists. Use rm-worktree.sh or pick a new name." >&2
  exit 1
fi

echo "→ creating worktree $DIR  (branch $BRANCH off $BASE)"
git -C "$MAIN" worktree add -b "$BRANCH" "$DIR" "$BASE"

# A fresh worktree has no deps; the gate (tsc over BOTH packages + vitest) needs them. Symlink
# the main checkout's node_modules for each package — instant vs a full `npm ci`.
link_node_modules() {
  local pkg_rel="$1"  # "" for root, "runner" for the runner package
  local src="$MAIN/${pkg_rel:+$pkg_rel/}node_modules"
  local dst="$DIR/${pkg_rel:+$pkg_rel/}node_modules"
  if [[ -d "$src" ]]; then
    ln -s "$src" "$dst"
    echo "→ symlinked ${pkg_rel:-root} node_modules → $src"
  else
    echo "warning: $src absent — run 'npm ci${pkg_rel:+ --prefix $pkg_rel}' before the gate." >&2
  fi
}
link_node_modules ""
link_node_modules "runner"

cat <<EOF

✓ Worktree ready. Point an agent (or a new Claude Code session) at it with:

    cd "$DIR"
    npm run gate    # verify it's green before starting

Branch:   $BRANCH  (off $BASE)
Teardown: .claude/skills/delegate-implement/rm-worktree.sh $BRANCH
   (or, after the PR lands: merge-worktree.sh <pr#>)
EOF
