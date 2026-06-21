/**
 * Unit tests for the runProvisionRuntime helper (runner/src/main.ts).
 */

import { describe, expect, it } from 'vitest';
import { runProvisionRuntime } from '../src/main.js';
import type { ProvisionInput, ProvisionOutcome } from '../src/provision.js';

class Recorder {
  calls: ProvisionInput[] = [];
  constructor(private readonly outcome: ProvisionOutcome) {}

  run = async (input: ProvisionInput): Promise<ProvisionOutcome> => {
    this.calls.push(input);
    return this.outcome;
  };
}

describe('runProvisionRuntime', () => {
  it('returns success text and forwards the runtime name', async () => {
    const r = new Recorder({ ok: true });

    const text = await runProvisionRuntime({ name: 'python' }, r.run);

    expect(r.calls).toEqual([{ name: 'python' }]);
    expect(text).toContain('RUNTIME PROVISIONED: python');
    expect(text).toContain('/workspace/.runtimes');
  });

  it('returns refusal text instead of throwing', async () => {
    const r = new Recorder({ ok: false, error: 'runtime not available' });

    const text = await runProvisionRuntime({ name: 'ruby' }, r.run);

    expect(text).toContain('RUNTIME NOT PROVISIONED: runtime not available');
    expect(text).toContain('do not fetch an arbitrary runtime');
  });
});
