import type { SessionManager } from '../sessions/manager.js';
import type { SlackClientLike } from './responder.js';
import { DEFAULT_PROFILE_ID, REPO_ONESHOT_PROFILE_ID, SUPERVISED_REPO_ONESHOT_PROFILE_ID } from '../profiles/registry.js';

export interface HandlerDeps {
  sessions: SessionManager;
  slack: SlackClientLike;
  botUserId: string;
}

/** Strip a bot mention like <@U12345> from the start of message text */
function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`^<@${botUserId}>\\s*`, 'u'), '').trim();
}

export interface OneShotTrigger {
  profileId: string;
  text: string;
}

/**
 * Recognize the one-shot trigger: a leading `task` or `exec` keyword
 * (case-insensitive) followed by the one-shot task text.
 * - `task` → supervised-repo-oneshot (gated, plan-approval required)
 * - `exec` → repo-oneshot (fire-and-forget, today's default behaviour)
 * Returns null if the message is not a one-shot trigger.
 */
export function parseOneShotTrigger(stripped: string): OneShotTrigger | null {
  const match = /^(task|exec)\s+(.+)$/is.exec(stripped);
  if (match === null) return null;
  const keyword = (match[1] ?? '').toLowerCase();
  const text = match[2]?.trim() ?? '';
  if (text === '') return null;
  const profileId = keyword === 'task'
    ? SUPERVISED_REPO_ONESHOT_PROFILE_ID
    : REPO_ONESHOT_PROFILE_ID;
  return { profileId, text };
}

/** Shape of the event body we care about for app_mention */
export interface MentionEventBody {
  team_id?: string;
  event: {
    type: 'app_mention';
    user?: string;
    text: string;
    ts: string;
    channel: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  };
}

/** Shape of the event body we care about for message */
export interface MessageEventBody {
  team_id?: string;
  event: {
    type: 'message';
    user?: string;
    text?: string;
    ts: string;
    channel: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  };
}

/**
 * Handle app_mention events.
 * - Ignores bot messages (bot_id set)
 * - Ignores edited/deleted subtypes
 * - Creates or reuses a session keyed by `${channel}:${thread_ts ?? ts}`
 * - Enqueues the mention text with bot mention stripped
 */
export async function handleMention(
  body: MentionEventBody,
  deps: HandlerDeps,
): Promise<void> {
  const ev = body.event;

  // Ignore bot messages
  if (ev.bot_id !== undefined) return;

  // Ignore edited/deleted subtypes
  if (ev.subtype !== undefined) return;

  // team_id is always present on real Slack event envelopes; 'unknown' is a defensive
  // placeholder so the key never starts with an empty segment. Recorded, not enforced —
  // do NOT drop or branch on a missing team here; tenancy enforcement/validation is M6.
  const team = body.team_id ?? 'unknown';
  const threadTs = ev.thread_ts ?? ev.ts;
  const sessionKey = `${team}:${ev.channel}:${threadTs}`;
  const stripped = stripMention(ev.text, deps.botUserId);
  const trigger = parseOneShotTrigger(stripped);
  const profileId = trigger?.profileId ?? DEFAULT_PROFILE_ID;
  const message = trigger?.text ?? stripped;

  console.log(`[listener] mention → session=${sessionKey}`);

  await deps.sessions.enqueueNew(sessionKey, {
    message,
    channel: ev.channel,
    threadTs,
    profileId,
    ...(body.team_id !== undefined && { teamId: body.team_id }),
    ...(ev.user !== undefined && { userId: ev.user }),
  });
}

/**
 * Handle message events (thread replies).
 * - Ignores bot messages
 * - Ignores edited/deleted subtypes
 * - Only routes to EXISTING sessions (no auto-create)
 * - Ignored if no session exists for that thread
 */
export async function handleMessage(
  body: MessageEventBody,
  deps: HandlerDeps,
): Promise<void> {
  const ev = body.event;

  // Ignore bot messages
  if (ev.bot_id !== undefined) return;

  // Ignore edited/deleted subtypes
  if (ev.subtype !== undefined) return;

  // Only handle thread replies (thread_ts set)
  if (ev.thread_ts === undefined) return;

  // A message that mentions the bot also fires app_mention — let that handler own it
  if (ev.text !== undefined && ev.text.includes(`<@${deps.botUserId}>`)) return;

  // See handleMention: 'unknown' is a defensive placeholder, recorded-not-enforced (M6).
  const team = body.team_id ?? 'unknown';
  const sessionKey = `${team}:${ev.channel}:${ev.thread_ts}`;
  const message = (ev.text ?? '').trim();
  if (message === '') return;

  const routed = await deps.sessions.enqueueExisting(sessionKey, {
    message,
    channel: ev.channel,
    threadTs: ev.thread_ts,
    profileId: DEFAULT_PROFILE_ID,
    ...(body.team_id !== undefined && { teamId: body.team_id }),
    ...(ev.user !== undefined && { userId: ev.user }),
  });

  if (!routed) {
    console.log(`[listener] thread reply ignored — no session: ${sessionKey}`);
  } else {
    console.log(`[listener] thread reply → session=${sessionKey}`);
  }
}

type AnyEventHandler = (args: { body: unknown }) => Promise<void>;

export interface BoltAppLike {
  event(type: string, handler: AnyEventHandler): void;
}

/**
 * Register handlers on a Bolt App. Only this function (and src/index.ts) may import Bolt.
 * We accept the app with a minimal opaque interface so no other module needs @slack/bolt.
 */
export function registerSlackHandlers(
  app: BoltAppLike,
  deps: HandlerDeps,
): void {
  app.event('app_mention', async ({ body }) => {
    await handleMention(body as MentionEventBody, deps);
  });

  app.event('message', async ({ body }) => {
    await handleMessage(body as MessageEventBody, deps);
  });
}
