/**
 * Transport-agnostic composition root.
 *
 * Called by both edges:
 *   - src/index.ts (real Bolt edge, with the real App wrapped as BoltAppLike)
 *   - src/harness/* (fake Slack edge, with FakeSlackApp + CapturingSlackClient)
 *
 * This file must NOT import @slack/bolt — it receives everything through deps.
 */
import { SessionManager } from './sessions/manager.js';
import type { SessionStore } from './sessions/store.js';
import type { RunnerFactory, VolumeReaper, BuildRunnerFactory } from './runner/types.js';
import type { SlackClientLike } from './slack/responder.js';
import type { BoltAppLike } from './slack/listener.js';
import { registerSlackHandlers } from './slack/listener.js';
import type { SpendCapsConfig } from './config.js';
import type { PrStateReader } from './sessions/pr-state-reader.js';

export interface GatewayDeps {
  app: BoltAppLike;
  slack: SlackClientLike;
  factory: RunnerFactory;
  store: SessionStore;
  idleTimeoutMs: number;
  planningIdleTimeoutMs?: number;
  gateTimeoutMs?: number;
  botUserId: string;
  volumeReaper?: VolumeReaper;
  volumeTtlMs?: number;
  gcIntervalMs?: number;
  prStateReader?: PrStateReader;
  spendCaps?: SpendCapsConfig;
  buildRunnerFactory?: BuildRunnerFactory;
  decisionCapture?: boolean;
}

export function buildGateway(deps: GatewayDeps): { sessions: SessionManager } {
  const sessions = new SessionManager({
    idleTimeoutMs: deps.idleTimeoutMs,
    ...(deps.planningIdleTimeoutMs !== undefined && { planningIdleTimeoutMs: deps.planningIdleTimeoutMs }),
    ...(deps.gateTimeoutMs !== undefined && { gateTimeoutMs: deps.gateTimeoutMs }),
    factory: deps.factory,
    slack: deps.slack,
    store: deps.store,
    ...(deps.volumeReaper !== undefined && { volumeReaper: deps.volumeReaper }),
    ...(deps.volumeTtlMs !== undefined && { volumeTtlMs: deps.volumeTtlMs }),
    ...(deps.gcIntervalMs !== undefined && { gcIntervalMs: deps.gcIntervalMs }),
    ...(deps.prStateReader !== undefined && { prStateReader: deps.prStateReader }),
    ...(deps.spendCaps !== undefined && { spendCaps: deps.spendCaps }),
    ...(deps.buildRunnerFactory !== undefined && { buildRunnerFactory: deps.buildRunnerFactory }),
    ...(deps.decisionCapture !== undefined ? { decisionCapture: deps.decisionCapture } : {}),
  });
  registerSlackHandlers(deps.app, {
    sessions,
    slack: deps.slack,
    botUserId: deps.botUserId,
  });
  return { sessions };
}
