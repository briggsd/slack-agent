/**
 * Unit tests for RealRuntimeProvisionService.
 */

import { describe, expect, it } from 'vitest';
import { RealRuntimeProvisionService } from '../src/oneshot/runtime-provision-service.js';
import { FakeGitNodeExecutor } from '../src/oneshot/fake-git-node.js';
import type { RuntimeCatalogEntry } from '../src/runner/runtime-provision-service.js';

const PYTHON_ENTRY: RuntimeCatalogEntry = {
  version: '3.12.13+20260610',
  url: 'https://example.test/python.tar.gz',
  sha256: 'a'.repeat(64),
  binSubdir: 'python/bin',
};

describe('RealRuntimeProvisionService', () => {
  it('refuses names not in the catalog without calling the git-node seam', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    const svc = new RealRuntimeProvisionService(gitNodes, new Map([['python', PYTHON_ENTRY]]));

    await expect(svc.provision({ name: 'ruby', volume: 'vol' })).resolves.toEqual({
      ok: false,
      error: 'runtime not available',
    });
    expect(gitNodes.runtimeProvisions).toHaveLength(0);
  });

  it('calls provisionRuntime once with the resolved catalog entry', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    const svc = new RealRuntimeProvisionService(gitNodes, new Map([['python', PYTHON_ENTRY]]));

    await expect(svc.provision({ name: 'python', volume: 'vol' })).resolves.toEqual({ ok: true });

    expect(gitNodes.runtimeProvisions).toEqual([{
      name: 'python',
      entry: PYTHON_ENTRY,
      volume: 'vol',
    }]);
  });

  it('returns failure as data when the executor fails', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.failNextProvisionRuntime(new Error('docker failed'));
    const svc = new RealRuntimeProvisionService(gitNodes, new Map([['python', PYTHON_ENTRY]]));

    await expect(svc.provision({ name: 'python', volume: 'vol' })).resolves.toEqual({
      ok: false,
      error: 'runtime provision failed',
    });
  });
});
