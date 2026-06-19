/**
 * OneShotOrchestrator — a SessionRunner that executes the minimal one-shot blueprint:
 *   parse → lease → run blueprint (clone → implement → push → open PR) → revoke → done
 *
 * All dependencies are injected (inner runner, broker, git nodes) so this is
 * fully testable offline. The real git node executor and live wiring are S03/S05.
 */

import type { SessionRunner, RunnerEvent, RunnerStream } from '../runner/types.js';
import type { CredentialBroker, CredentialLease } from '../broker/types.js';
import type { GitNodeExecutor } from './git-node.js';
import { parseOneShotTask } from './parse.js';
import { volumeNameFor } from '../runner/docker.js';
import { REPO_ONESHOT_PROFILE_ID } from '../profiles/registry.js';
import { blueprintFor } from './registry.js';
import { runBlueprint } from '../blueprints/executor.js';
import type { OneShotContext, OneShotDeps } from './context.js';

export class OneShotOrchestrator implements SessionRunner {
  private readonly inner: SessionRunner;
  private readonly broker: CredentialBroker;
  private readonly gitNodes: GitNodeExecutor;
  private readonly taskId: string;
  private readonly volume: string;
  private readonly blueprintId: string;

  constructor(
    inner: SessionRunner,
    broker: CredentialBroker,
    gitNodes: GitNodeExecutor,
    sessionKey: string,
    taskId?: string,
    blueprintId: string = REPO_ONESHOT_PROFILE_ID,
  ) {
    this.inner = inner;
    this.broker = broker;
    this.gitNodes = gitNodes;
    this.volume = volumeNameFor(sessionKey);
    // Mirror docker.ts correlation id style
    this.taskId = taskId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.blueprintId = blueprintId;
  }

  async *send(message: string): RunnerStream {
    const self = this;

    const parsed = parseOneShotTask(message);
    if (parsed === null) {
      yield {
        type: 'error',
        message: 'Invalid task format. Expected: <host>:<owner>/<repo> <instruction>',
      } satisfies RunnerEvent;
      return;
    }

    const { host, repo, instruction } = parsed;
    const branch = `slackbot/oneshot-${self.taskId}`;
    // Stable workdir derived from the repo slug (ALL slashes → dashes, so GitLab
    // subgroups collapse to one path segment). The slug is already validated safe
    // by parseOneShotTask (no traversal). One thread = one session = one
    // container/volume, so this fixed path is single-occupant — no per-task scoping needed.
    const repoSlug = repo.replaceAll('/', '-');
    const workdir = `/workspace/${repoSlug}`;

    // Lease acquisition is fallible (e.g. an unconfigured host throws) — surface it
    // as an error event rather than letting the rejection escape the iterator.
    let lease: CredentialLease;
    try {
      lease = await self.broker.lease({ host, repo, taskId: self.taskId });
    } catch (err: unknown) {
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      } satisfies RunnerEvent;
      return;
    }

    // Revoke at most once, regardless of which path we exit through.
    let leaseRevoked = false;
    const revokeOnce = async (): Promise<void> => {
      if (leaseRevoked) return;
      leaseRevoked = true;
      try {
        await lease.revoke();
      } catch {
        // best effort — a failed revoke must not mask the turn's real outcome
      }
    };

    const ctx: OneShotContext = {
      host,
      repo,
      instruction,
      taskId: self.taskId,
      volume: self.volume,
      workdir,
      branch,
      lease,
    };

    const deps: OneShotDeps = {
      inner: self.inner,
      gitNodes: self.gitNodes,
    };

    try {
      // runBlueprint converts a node failure into a yielded error event and
      // returns normally — node failures DO NOT enter the catch below; they come
      // out as forwarded error events and the lease is revoked by `finally`. The
      // catch only handles an orchestrator-level throw (e.g. blueprintFor on an
      // unknown id). If you add cleanup/metrics to the catch, mirror it into the
      // node path too — it will not run for node failures.
      // `yield*` (not `for await`) forwards a gate resume value back into the blueprint.
      yield* runBlueprint(blueprintFor(this.blueprintId), ctx, deps);
      await revokeOnce();
    } catch (err: unknown) {
      await revokeOnce();
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg } satisfies RunnerEvent;
    } finally {
      // Guarantees the lease is revoked even on an unexpected early exit; the
      // guard makes this a no-op if it was already revoked above.
      await revokeOnce();
    }
  }

  async dispose(): Promise<void> {
    await this.inner.dispose();
  }
}
