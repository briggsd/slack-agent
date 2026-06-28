/**
 * Guard against DIFF_BASE_REF drifting between gateway and runner.
 *
 * DIFF_BASE_REF is duplicated in two decoupled files (the gateway cannot import
 * the runner package). This test reads both files as text and asserts the literal
 * is present and identical — preventing silent breakage of the coordinator's diff
 * if the two copies drift.
 *
 * Fully offline — reads repo files as text, no imports or execution of the modules.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');

const RUNNER_FILE = resolve(repoRoot, 'runner/src/main.ts');
const GATEWAY_FILE = resolve(repoRoot, 'src/oneshot/docker-git-node.ts');

// Regex that matches both `const DIFF_BASE_REF = '...'` and `export const DIFF_BASE_REF = '...'`
const DIFF_BASE_REF_REGEX = /DIFF_BASE_REF\s*=\s*'([^']+)'/;

describe('DIFF_BASE_REF synchronization', () => {
  it('guards DIFF_BASE_REF against drifting between runner and gateway', () => {
    const runnerContent = readFileSync(RUNNER_FILE, 'utf-8');
    const gatewayContent = readFileSync(GATEWAY_FILE, 'utf-8');

    const runnerMatch = runnerContent.match(DIFF_BASE_REF_REGEX);
    const gatewayMatch = gatewayContent.match(DIFF_BASE_REF_REGEX);

    expect(runnerMatch).not.toBeNull();
    expect(gatewayMatch).not.toBeNull();

    if (!runnerMatch || !gatewayMatch) {
      throw new Error(
        `DIFF_BASE_REF literal not found: ` +
          `runner (${RUNNER_FILE}) ${runnerMatch ? 'found' : 'missing'}, ` +
          `gateway (${GATEWAY_FILE}) ${gatewayMatch ? 'found' : 'missing'}`
      );
    }

    const runnerValue = runnerMatch[1];
    const gatewayValue = gatewayMatch[1];

    expect(runnerValue).toBe(
      gatewayValue,
      `DIFF_BASE_REF mismatch: ` +
        `runner=${JSON.stringify(runnerValue)} (${RUNNER_FILE}), ` +
        `gateway=${JSON.stringify(gatewayValue)} (${GATEWAY_FILE})`
    );
  });
});
