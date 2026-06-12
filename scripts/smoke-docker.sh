#!/usr/bin/env bash
# Smoke-test the runner container end-to-end.
#
# Prerequisites:
#   - Docker running
#   - ANTHROPIC_API_KEY set in the environment
#   - Run from the repo root: bash scripts/smoke-docker.sh
#
# This script is NOT part of the CI gate — it requires a real Docker daemon
# and a valid ANTHROPIC_API_KEY.

set -euo pipefail

IMAGE="${RUNNER_IMAGE:-slackbot-runner:latest}"
VOLUME="slackbot-smoke-test-vol"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ERROR: ANTHROPIC_API_KEY is not set" >&2
  exit 1
fi

echo ">>> Building runner image: $IMAGE"
docker build -t "$IMAGE" runner/

echo ">>> Cleaning up any leftover smoke-test volume"
docker volume rm "$VOLUME" 2>/dev/null || true

echo ">>> Starting smoke-test container"
# Launch the container with stdin open
CONTAINER=$(docker run -d --rm -i \
  --name "slackbot-smoke-test" \
  -v "${VOLUME}:/workspace" \
  -e ANTHROPIC_API_KEY \
  --memory 512m \
  --cpus 1.0 \
  --pids-limit 256 \
  --security-opt no-new-privileges \
  "$IMAGE")

echo ">>> Container started: $CONTAINER"
echo ">>> Waiting for ready..."

# Use a named pipe to read stdout
TMP_OUT=$(mktemp)
docker attach --no-stdin "$CONTAINER" > "$TMP_OUT" 2>/dev/null &
ATTACH_PID=$!

sleep 2

# Send one user_message
MSG='{"type":"user_message","id":"smoke-1","text":"Say hello in exactly three words."}'
echo ">>> Sending: $MSG"
echo "$MSG" | docker exec -i slackbot-smoke-test cat /dev/stdin || true

# Alternative: pass via docker attach stdin
echo "$MSG" | docker attach slackbot-smoke-test > /dev/null 2>&1 &

sleep 10

echo ">>> Container output so far:"
cat "$TMP_OUT"

echo ">>> Cleaning up"
docker kill slackbot-smoke-test 2>/dev/null || true
docker volume rm "$VOLUME" 2>/dev/null || true
kill "$ATTACH_PID" 2>/dev/null || true
rm -f "$TMP_OUT"

echo ">>> Smoke test done"
