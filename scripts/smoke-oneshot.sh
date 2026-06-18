#!/usr/bin/env bash
# Smoke-test the real DockerGitNodeExecutor end-to-end.
#
# Prerequisites:
#   - Docker running
#   - GIT_TEST_REPO    — "owner/name" of a throwaway GitHub repo you control
#   - GIT_TEST_TOKEN   — fine-grained PAT scoped to that repo with:
#                          Contents: read + write
#                          Pull requests: read + write
#   - GIT_IMAGE        — Docker image with git installed (default: slackbot-runner:latest)
#   - The gateway must be built first: `npm run build` (this script imports from dist/).
#   - Run: GIT_TEST_REPO=owner/name GIT_TEST_TOKEN=ghp_... bash scripts/smoke-oneshot.sh
#
# This script is NOT part of the CI gate — it requires a real Docker daemon,
# a real GitHub repo, and a valid personal access token.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "${REPO_ROOT}/dist/oneshot/docker-git-node.js" ]]; then
  echo "ERROR: ${REPO_ROOT}/dist not built — run 'npm run build' first" >&2
  exit 1
fi

GIT_IMAGE="${GIT_IMAGE:-slackbot-runner:latest}"
GIT_TEST_REPO="${GIT_TEST_REPO:?ERROR: GIT_TEST_REPO must be set (e.g. owner/throwaway-repo)}"
GIT_TEST_TOKEN="${GIT_TEST_TOKEN:?ERROR: GIT_TEST_TOKEN must be set}"

SMOKE_SESSION="smoke-oneshot-$$"
SMOKE_VOLUME="slackbot-ws-$(echo "$SMOKE_SESSION" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-64)"

echo ">>> Smoke test: DockerGitNodeExecutor"
echo "    repo  : $GIT_TEST_REPO"
echo "    image : $GIT_IMAGE"
echo "    volume: $SMOKE_VOLUME"
echo ""

cleanup() {
  echo ">>> Cleaning up volume: $SMOKE_VOLUME"
  docker volume rm "$SMOKE_VOLUME" 2>/dev/null || true
}
trap cleanup EXIT

echo ">>> Creating workspace volume"
docker volume create "$SMOKE_VOLUME" >/dev/null

# Build a tiny inline ESM driver that uses the real executor.
# We use `node --input-type=module` to avoid a temp file on disk.
NODE_SCRIPT="
import { DockerGitNodeExecutor } from '${REPO_ROOT}/dist/oneshot/docker-git-node.js';

const executor = new DockerGitNodeExecutor({ image: '${GIT_IMAGE}' });

const lease = {
  token: process.env.GIT_TEST_TOKEN,
  host: 'github',
  repo: '${GIT_TEST_REPO}',
  revoke: async () => {},
};

const workdir = '/workspace/smoke-repo';
const volume  = '${SMOKE_VOLUME}';
const branch  = 'slackbot/smoke-\${Date.now()}';

console.log('[smoke] cloning...');
await executor.clone({ lease, repo: lease.repo, workdir, volume });
console.log('[smoke] clone done');

// Make a trivial commit on a new branch inside the volume
const { default: cp } = await import('child_process');
const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  const c = cp.spawn(cmd, args, { stdio: 'inherit', ...opts });
  c.once('exit', code => code === 0 ? res() : rej(new Error(cmd + ' ' + args.join(' ') + ' exited ' + code)));
});

await run('docker', [
  'run', '--rm', '-v', volume + ':/workspace',
  '${GIT_IMAGE}',
  'sh', '-c',
  'git -C ' + workdir + ' checkout -b ' + branch +
  ' && echo smoke-\$(date) >> ' + workdir + '/SMOKE.md' +
  ' && git -C ' + workdir + ' add SMOKE.md' +
  ' && git -C ' + workdir + ' -c user.email=smoke@bot -c user.name=SmokBot commit -m \"smoke test commit\"'
]);

console.log('[smoke] pushing...');
await executor.push({ lease, repo: lease.repo, branch, workdir, volume });
console.log('[smoke] push done');

console.log('[smoke] opening pull request...');
const { url } = await executor.openChangeRequest({
  lease,
  repo: lease.repo,
  head: branch,
  base: 'main',   // openChangeRequest detects the real default branch
  title: 'Smoke test PR from slack-agent',
  body: 'Automated smoke test. Safe to close.',
});
console.log('[smoke] PR opened:', url);
"

echo ">>> Running executor via node (ESM, importing from dist/)"
echo "$NODE_SCRIPT" | GIT_TEST_TOKEN="$GIT_TEST_TOKEN" \
  node --input-type=module 2>&1

echo ""
echo ">>> Smoke test completed. Check the PR url printed above."
echo "    Volume cleanup happens on exit (trap)."
