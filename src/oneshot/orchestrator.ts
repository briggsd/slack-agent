/**
 * OneShotOrchestrator — a SessionRunner that executes a one-shot blueprint:
 *   parse → maybe lease → run blueprint → revoke → done
 *
 * All dependencies are injected (inner runner, broker, git nodes) so this is
 * fully testable offline. The real git node executor and live wiring are S03/S05.
 */

import type { SessionRunner, RunnerEvent, RunnerStream } from '../runner/types.js';
import type { CredentialBroker, CredentialLease } from '../broker/types.js';
import type { GitHost } from '../broker/types.js';
import type { GitNodeExecutor } from './git-node.js';
import { parseOneShotTask, isSafeRepoSlug } from './parse.js';
import { volumeNameFor } from '../runner/docker.js';
import { REPO_ONESHOT_PROFILE_ID } from '../profiles/registry.js';
import { blueprintFor } from './registry.js';
import { runBlueprint } from '../blueprints/executor.js';
import type { OneShotBlueprint, OneShotContext, OneShotDeps } from './context.js';

export function branchForTask(taskId: string): string {
  return `slackbot/oneshot-${taskId}`;
}

export function taskIdFromWorkspaceVolume(volume: string): string {
  const prefix = 'slackbot-ws-';
  return volume.startsWith(prefix) ? volume.slice(prefix.length) : volume;
}

export function taskIdForSessionKey(sessionKey: string): string {
  return taskIdFromWorkspaceVolume(volumeNameFor(sessionKey));
}

export function workdirForRepo(repo: string): string {
  return `/workspace/${repo.replaceAll('/', '-')}`;
}

function localOnlyLease(host: GitHost, repo: string): CredentialLease {
  return {
    token: '',
    host,
    repo,
    async revoke(): Promise<void> {
      // Local-only flows never mint a real lease.
    },
  };
}

export class OneShotOrchestrator implements SessionRunner {
  private readonly inner: SessionRunner;
  private readonly broker: CredentialBroker;
  private readonly gitNodes: GitNodeExecutor;
  private readonly taskId: string;
  private readonly volume: string;
  private readonly blueprintId: string;
  private readonly explicitTask: { host: GitHost; repo: string; instruction: string } | undefined;

  constructor(
    inner: SessionRunner,
    broker: CredentialBroker,
    gitNodes: GitNodeExecutor,
    sessionKey: string,
    taskId?: string,
    blueprintId: string = REPO_ONESHOT_PROFILE_ID,
    explicitTask?: { host: GitHost; repo: string; instruction: string },
  ) {
    this.inner = inner;
    this.broker = broker;
    this.gitNodes = gitNodes;
    this.volume = volumeNameFor(sessionKey);
    // Mirror docker.ts correlation id style
    this.taskId = taskId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.blueprintId = blueprintId;
    this.explicitTask = explicitTask;
  }

  async *send(message: string): RunnerStream {
    const self = this;

    let host: GitHost, repo: string, instruction: string;
    if (this.explicitTask !== undefined) {
      ({ host, repo, instruction } = this.explicitTask);
      // The explicit-context path skips parseOneShotTask, so re-apply its no-traversal
      // slug guard here. The repo ultimately flows from a container-emitted run_build
      // event (untrusted), and is turned into the filesystem path /workspace/<slug> and
      // passed to broker.lease — so an unsafe slug (e.g. '..') must be rejected, not
      // sanitised. The slash→dash workdir rewrite below does NOT neutralise a bare '..'.
      if (!isSafeRepoSlug(repo)) {
        yield {
          type: 'error',
          message: 'Invalid repo slug — expected owner/name with no path traversal.',
        } satisfies RunnerEvent;
        return;
      }
    } else {
      const parsed = parseOneShotTask(message);
      if (parsed === null) {
        yield {
          type: 'error',
          message: 'Invalid task format. Expected: <host>:<owner>/<repo> <instruction>',
        } satisfies RunnerEvent;
        return;
      }
      ({ host, repo, instruction } = parsed);
    }
    const branch = branchForTask(self.taskId);
    // Stable workdir derived from the repo slug (ALL slashes → dashes, so GitLab
    // subgroups collapse to one path segment). The slug is already validated safe
    // (no traversal) by parseOneShotTask on the parsed path or by the isSafeRepoSlug
    // check above on the explicit-context path. One thread = one session = one
    // container/volume, so this fixed path is single-occupant — no per-task scoping needed.
    const workdir = workdirForRepo(repo);

    let blueprint: OneShotBlueprint;
    try {
      blueprint = blueprintFor(this.blueprintId);
    } catch (err: unknown) {
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      } satisfies RunnerEvent;
      return;
    }
    const requiresLease = blueprint.requiresLease !== false;

    // Lease acquisition is fallible (e.g. an unconfigured host throws) — surface it
    // as an error event rather than letting the rejection escape the iterator.
    let lease: CredentialLease;
    if (requiresLease) {
      try {
        lease = await self.broker.lease({ host, repo, taskId: self.taskId });
      } catch (err: unknown) {
        yield {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } satisfies RunnerEvent;
        return;
      }
    } else {
      lease = localOnlyLease(host, repo);
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

    const checkPolicy =
      blueprint.requiresPassingChecks === true ? { requiresPassingChecks: true } : {};

    const ctx: OneShotContext = {
      host,
      repo,
      instruction,
      taskId: self.taskId,
      volume: self.volume,
      workdir,
      branch,
      lease,
      ...checkPolicy,
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
      yield* runBlueprint(blueprint, ctx, deps);
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
