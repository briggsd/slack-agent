/**
 * OneShotOrchestrator — a SessionRunner that executes the minimal one-shot blueprint:
 *   parse → lease → clone → implement (inner agent) → push → open PR → revoke → done
 *
 * All dependencies are injected (inner runner, broker, git nodes) so this is
 * fully testable offline. The real git node executor and live wiring are S03/S05.
 */

import type { SessionRunner, RunnerEvent } from '../runner/types.js';
import type { CredentialBroker, CredentialLease } from '../broker/types.js';
import type { GitNodeExecutor } from './git-node.js';
import { parseOneShotTask } from './parse.js';
import { volumeNameFor } from '../runner/docker.js';

export class OneShotOrchestrator implements SessionRunner {
  private readonly inner: SessionRunner;
  private readonly broker: CredentialBroker;
  private readonly gitNodes: GitNodeExecutor;
  private readonly taskId: string;
  private readonly volume: string;

  constructor(
    inner: SessionRunner,
    broker: CredentialBroker,
    gitNodes: GitNodeExecutor,
    sessionKey: string,
    taskId?: string,
  ) {
    this.inner = inner;
    this.broker = broker;
    this.gitNodes = gitNodes;
    this.volume = volumeNameFor(sessionKey);
    // Mirror docker.ts correlation id style
    this.taskId = taskId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  send(message: string): AsyncIterable<RunnerEvent> {
    const self = this;

    return {
      [Symbol.asyncIterator]: async function* () {
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

        try {
          // Clone
          yield { type: 'status', text: 'cloning repository…' } satisfies RunnerEvent;
          await self.gitNodes.clone({ lease, repo, workdir, volume: self.volume });

          // Implement (inner agent runner)
          yield { type: 'status', text: 'implementing…' } satisfies RunnerEvent;
          let implementResult = '';
          let innerError: string | null = null;

          for await (const ev of self.inner.send(instruction)) {
            if (ev.type === 'status') {
              yield { type: 'status', text: ev.text } satisfies RunnerEvent;
            } else if (ev.type === 'text') {
              implementResult = ev.text;
            } else if (ev.type === 'error') {
              innerError = ev.message;
              // Treat inner agent error as a blueprint failure — break and handle below
              break;
            }
            // file events from inner runner are not forwarded in this minimal blueprint
          }

          if (innerError !== null) {
            throw new Error(`Inner agent error: ${innerError}`);
          }

          // Push
          yield { type: 'status', text: 'pushing branch…' } satisfies RunnerEvent;
          await self.gitNodes.push({ lease, repo, branch, workdir, volume: self.volume });

          // Open PR
          yield { type: 'status', text: 'opening pull request…' } satisfies RunnerEvent;
          // Title: first ~72 chars of the instruction (first line)
          const title = instruction.split('\n')[0]?.slice(0, 72) ?? instruction.slice(0, 72);
          const body = implementResult !== ''
            ? implementResult.slice(0, 500)
            : `Automated one-shot implementation.\n\nTask: ${title}`;

          const { url } = await self.gitNodes.openChangeRequest({
            lease,
            repo,
            head: branch,
            // base is a hint only — DockerGitNodeExecutor detects the repo's real
            // default branch and uses that, so this value is not relied on.
            base: 'main',
            title,
            body,
          });

          await revokeOnce();
          yield { type: 'text', text: `Opened PR: ${url}` } satisfies RunnerEvent;
        } catch (err: unknown) {
          await revokeOnce();
          const msg = err instanceof Error ? err.message : String(err);
          yield { type: 'error', message: msg } satisfies RunnerEvent;
        } finally {
          // Guarantees the lease is revoked even on an unexpected early exit; the
          // guard makes this a no-op if it was already revoked above.
          await revokeOnce();
        }
      },
    };
  }

  async dispose(): Promise<void> {
    await this.inner.dispose();
  }
}
