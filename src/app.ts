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
import type { RunnerFactory, VolumeReaper } from './runner/types.js';
import type { SlackClientLike } from './slack/responder.js';
import type { BoltAppLike } from './slack/listener.js';
import { registerSlackHandlers } from './slack/listener.js';
import type { SpendCapsConfig } from './config.js';

export interface GatewayDeps {
  app: BoltAppLike;
  slack: SlackClientLike;
  factory: RunnerFactory;
  store: SessionStore;
  idleTimeoutMs: number;
  gateTimeoutMs?: number;
  botUserId: string;
  volumeReaper?: VolumeReaper;
  volumeTtlMs?: number;
  gcIntervalMs?: number;
  spendCaps?: SpendCapsConfig;
}

export function buildGateway(deps: GatewayDeps): { sessions: SessionManager } {
  const sessions = new SessionManager({
    idleTimeoutMs: deps.idleTimeoutMs,
    ...(deps.gateTimeoutMs !== undefined && { gateTimeoutMs: deps.gateTimeoutMs }),
    factory: deps.factory,
    slack: deps.slack,
    store: deps.store,
    ...(deps.volumeReaper !== undefined && { volumeReaper: deps.volumeReaper }),
    ...(deps.volumeTtlMs !== undefined && { volumeTtlMs: deps.volumeTtlMs }),
    ...(deps.gcIntervalMs !== undefined && { gcIntervalMs: deps.gcIntervalMs }),
    ...(deps.spendCaps !== undefined && { spendCaps: deps.spendCaps }),
  });
  registerSlackHandlers(deps.app, {
    sessions,
    slack: deps.slack,
    botUserId: deps.botUserId,
  });
  return { sessions };
}
