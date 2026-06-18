/**
 * DispatchingRunnerFactory — wraps a base agent factory and dispatches on
 * profile.mode.
 *
 * For 'one-shot' profiles: creates an inner agent runner using the BASE factory
 * with the conversational profile (no dispatch recursion), then wraps it in a
 * OneShotOrchestrator.
 *
 * For 'conversational' profiles: delegates directly to the base factory.
 */

import type { RunnerFactory, SessionRunner } from '../runner/types.js';
import type { Profile } from '../profiles/registry.js';
import { getProfile } from '../profiles/registry.js';
import type { CredentialBroker } from '../broker/types.js';
import type { GitNodeExecutor } from './git-node.js';
import { OneShotOrchestrator } from './orchestrator.js';

export class DispatchingRunnerFactory implements RunnerFactory {
  private readonly agentFactory: RunnerFactory;
  private readonly broker: CredentialBroker;
  private readonly gitNodes: GitNodeExecutor;

  constructor(
    agentFactory: RunnerFactory,
    broker: CredentialBroker,
    gitNodes: GitNodeExecutor,
  ) {
    this.agentFactory = agentFactory;
    this.broker = broker;
    this.gitNodes = gitNodes;
  }

  async create(sessionKey: string, profile: Profile): Promise<SessionRunner> {
    if (profile.mode === 'one-shot') {
      // Create the inner agent runner using the BASE factory with the conversational
      // profile — never the dispatching factory, never the one-shot profile.
      // This avoids dispatch recursion.
      const inner = await this.agentFactory.create(sessionKey, getProfile('conversational'));
      return new OneShotOrchestrator(inner, this.broker, this.gitNodes, sessionKey);
    }
    return this.agentFactory.create(sessionKey, profile);
  }
}
