/**
 * Container-side commit gate (router; design/0007 decision 5, S10b).
 *
 * The `submit_spec` tool calls {@link ApprovalCoordinator.requestApproval} from inside a live
 * SDK turn. That emits a `request_approval` line to the gateway and blocks on a promise. The
 * runner's stdin dispatcher routes the gateway's `approval_verdict` back in via
 * {@link ApprovalCoordinator.handleVerdict}, which resolves the promise — so the tool returns
 * the human's decision to the model. The coordinator is pure (no SDK, no stdio of its own): it
 * takes an emit callback and is driven by parsed messages, so it unit-tests offline.
 */

import type { ApprovalVerdictMessage, UserMessage } from './protocol.js';

/** The human's decision on a submitted spec, as the tool sees it. */
export type Verdict = { approved: boolean; feedback?: string };

/** Emits a `request_approval` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestApprovalFn = (specRef: string, id: string) => void;

export class ApprovalCoordinator {
  /** id → resolver for each gate awaiting a verdict. At most a handful in flight (turns serial). */
  private readonly pending = new Map<string, (v: Verdict) => void>();
  private seq = 0;
  /** Set once stdin closes: no verdict can arrive after this, so new gates resolve immediately. */
  private drained = false;

  constructor(private readonly emitRequest: EmitRequestApprovalFn) {}

  /**
   * Raise a commit gate: emit `request_approval` and resolve when the matching verdict arrives.
   * The id is the runner's own approval-correlation id (distinct from the turn id), echoed back
   * on the verdict.
   *
   * Once {@link failAllPending} has drained (stdin closed), resolve immediately as not-approved
   * instead of parking — otherwise an agent that calls `submit_spec` AGAIN after a not-approved
   * verdict (the tool result tells it to "revise and resubmit") would emit a `request_approval`
   * no one can answer and hang the turn forever.
   */
  requestApproval(specRef: string): Promise<Verdict> {
    if (this.drained) {
      return Promise.resolve({ approved: false });
    }
    const id = `appr-${++this.seq}`;
    return new Promise<Verdict>((resolve) => {
      this.pending.set(id, resolve);
      this.emitRequest(specRef, id);
    });
  }

  /**
   * Route an inbound `approval_verdict` to its waiting gate. Returns true if it matched a
   * pending gate, false for an unknown or already-settled id (a duplicate/stray verdict is
   * ignored, never executed — it is data from the gateway).
   */
  handleVerdict(msg: ApprovalVerdictMessage): boolean {
    const resolve = this.pending.get(msg.id);
    if (resolve === undefined) return false;
    this.pending.delete(msg.id);
    const verdict: Verdict =
      msg.feedback !== undefined
        ? { approved: msg.approved, feedback: msg.feedback }
        : { approved: msg.approved };
    resolve(verdict);
    return true;
  }

  /**
   * Resolve every still-pending gate as not-approved. Called when stdin closes so a tool parked
   * on a verdict that will never come can't wedge the process at shutdown.
   */
  failAllPending(): void {
    this.drained = true;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ approved: false });
    }
  }
}

/** Parsed result of one inbound NDJSON line from the gateway. */
export type InboundParsed =
  | { kind: 'user'; msg: UserMessage }
  | { kind: 'verdict'; msg: ApprovalVerdictMessage }
  | { kind: 'bad'; error: string };

/**
 * Parse and validate one inbound line. Everything from the gateway is treated as data: bad
 * JSON or an unexpected shape returns `kind: 'bad'` rather than throwing, and only the two
 * known message types are accepted. `exactOptionalPropertyTypes` is on, so `feedback` is set
 * only when present.
 */
export function parseInbound(line: string): InboundParsed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return { kind: 'bad', error: e instanceof Error ? e.message : String(e) };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'bad', error: 'not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['type'] === 'user_message') {
    if (typeof obj['id'] !== 'string' || typeof obj['text'] !== 'string') {
      return { kind: 'bad', error: 'unexpected user_message shape' };
    }
    return { kind: 'user', msg: { type: 'user_message', id: obj['id'], text: obj['text'] } };
  }
  if (obj['type'] === 'approval_verdict') {
    if (typeof obj['id'] !== 'string' || typeof obj['approved'] !== 'boolean') {
      return { kind: 'bad', error: 'unexpected approval_verdict shape' };
    }
    const msg: ApprovalVerdictMessage =
      typeof obj['feedback'] === 'string'
        ? { type: 'approval_verdict', id: obj['id'], approved: obj['approved'], feedback: obj['feedback'] }
        : { type: 'approval_verdict', id: obj['id'], approved: obj['approved'] };
    return { kind: 'verdict', msg };
  }
  return { kind: 'bad', error: 'unknown message type' };
}
