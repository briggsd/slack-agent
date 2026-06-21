/**
 * Container-side build-spec approval state (router; design/0010 slice 6).
 *
 * The `build_spec` tool no longer parks a live turn while the human is away. Instead it writes a
 * pending approval request under /workspace/.slackbot/, emits `request_approval`, and returns to
 * the model so the turn can end. Later, the gateway delivers a trusted `approval_verdict` control
 * before the next user turn; the runner keeps that verdict in process memory so a later
 * `build_spec` call can consume it exactly once. Only the request is durable — trusted verdicts
 * are never trusted from the agent-writable workspace.
 */

import type {
  ApprovalVerdictMessage,
  BuildResultMessage,
  CloneResultMessage,
  ExecResultMessage,
  PublishResultMessage,
  ProvisionResultMessage,
  RunChecksResult,
  RunChecksResultMessage,
  UserMessage,
} from './protocol.js';

export const APPROVAL_STATE_PATH = '/workspace/.slackbot/build-spec-approval.json';

export type ApprovalResult =
  | { status: 'requested' }
  | { status: 'approved' }
  | { status: 'rejected'; feedback?: string };

/** Emits a `request_approval` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestApprovalFn = (specRef: string, id: string) => void;
export type ReadApprovalStateFn = () => Promise<string | null>;
export type WriteApprovalStateFn = (data: string) => Promise<void>;
export type EnsureApprovalStateDirFn = () => Promise<void>;

type StoredApprovalState =
  | { version: 1; status: 'idle' }
  | { version: 1; status: 'requested'; id: string; specRef: string }
  | { version: 1; status: 'approved'; id: string; specRef: string }
  | { version: 1; status: 'rejected'; id: string; specRef: string; feedback?: string };

const IDLE_STATE: StoredApprovalState = { version: 1, status: 'idle' };

function parseStoredState(raw: string | null): StoredApprovalState {
  if (raw === null) return IDLE_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return IDLE_STATE;
  }
  if (typeof parsed !== 'object' || parsed === null) return IDLE_STATE;
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== 1 || typeof obj['status'] !== 'string') return IDLE_STATE;
  if (obj['status'] === 'idle') return IDLE_STATE;
  if (
    obj['status'] === 'requested' &&
    typeof obj['id'] === 'string' &&
    typeof obj['specRef'] === 'string'
  ) {
    return { version: 1, status: 'requested', id: obj['id'], specRef: obj['specRef'] };
  }
  // Approval verdicts are trusted only when delivered through the gateway control channel.
  // Treat any on-disk approved/rejected state as untrusted agent-writable data.
  return IDLE_STATE;
}

function approvalResultFromState(state: Extract<StoredApprovalState, { status: 'approved' | 'rejected' }>): ApprovalResult {
  if (state.status === 'approved') {
    return { status: 'approved' };
  }
  return state.feedback !== undefined
    ? { status: 'rejected', feedback: state.feedback }
    : { status: 'rejected' };
}

function nextSeqFromState(state: StoredApprovalState, currentSeq: number): number {
  if (state.status === 'idle') return currentSeq;
  const match = /^appr-(\d+)$/.exec(state.id);
  if (match === null) return currentSeq;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.max(currentSeq, parsed) : currentSeq;
}

export class ApprovalCoordinator {
  private seq = 0;
  private drained = false;
  private state: StoredApprovalState | null = null;

  constructor(
    private readonly emitRequest: EmitRequestApprovalFn,
    private readonly readStateFile: ReadApprovalStateFn,
    private readonly writeStateFile: WriteApprovalStateFn,
    private readonly ensureStateDir: EnsureApprovalStateDirFn,
  ) {}

  private async loadState(): Promise<StoredApprovalState> {
    if (this.state !== null) return this.state;
    const parsed = parseStoredState(await this.readStateFile());
    this.seq = nextSeqFromState(parsed, this.seq);
    this.state = parsed;
    return parsed;
  }

  private async persistState(state: StoredApprovalState): Promise<void> {
    this.state = state;
    this.seq = nextSeqFromState(state, this.seq);
    await this.ensureStateDir();
    await this.writeStateFile(JSON.stringify(state));
  }

  /**
   * Raise or consume a build-spec approval gate.
   *
   * - Same spec + `requested` => re-emit the request and return `requested`; the re-emit lets
   *   a gateway that lost its in-memory pending handle re-register the approval prompt.
   * - Same spec + approved/rejected verdict => consume it exactly once.
   * - Different spec (or idle) => start a fresh approval request.
   */
  async requestApproval(specRef: string): Promise<ApprovalResult> {
    if (this.drained) {
      return { status: 'rejected' };
    }

    const current = await this.loadState();
    if (current.status !== 'idle' && current.specRef === specRef) {
      if (current.status === 'requested') {
        this.emitRequest(specRef, current.id);
        return { status: 'requested' };
      }
      const result = approvalResultFromState(current);
      await this.persistState(IDLE_STATE);
      return result;
    }

    const nextState: StoredApprovalState = {
      version: 1,
      status: 'requested',
      id: `appr-${this.seq + 1}`,
      specRef,
    };
    await this.persistState(nextState);
    this.emitRequest(specRef, nextState.id);
    return { status: 'requested' };
  }

  /**
   * Record a trusted inbound verdict for the currently pending approval id.
   * Returns false for unknown/stale ids or when no request is pending.
   *
   * The resulting approved/rejected state deliberately stays in memory only: the state file lives
   * under /workspace so the agent can write it, and therefore cannot be a trusted verdict store.
   */
  async handleVerdict(msg: ApprovalVerdictMessage): Promise<boolean> {
    const current = await this.loadState();
    if (current.status !== 'requested' || current.id !== msg.id || current.specRef !== msg.specRef) return false;
    this.state =
      msg.approved
        ? { version: 1, status: 'approved', id: current.id, specRef: msg.specRef }
        : msg.feedback !== undefined
          ? { version: 1, status: 'rejected', id: current.id, specRef: msg.specRef, feedback: msg.feedback }
          : { version: 1, status: 'rejected', id: current.id, specRef: msg.specRef };
    return true;
  }

  /**
   * Preserve whatever was already stored, but stop creating new requests after stdin closes.
   */
  failAllPending(): void {
    this.drained = true;
  }
}

/** Parsed result of one inbound NDJSON line from the gateway. */
export type InboundParsed =
  | { kind: 'user'; msg: UserMessage }
  | { kind: 'verdict'; msg: ApprovalVerdictMessage }
  | { kind: 'clone_result'; msg: CloneResultMessage }
  | { kind: 'build_result'; msg: BuildResultMessage }
  | { kind: 'exec_result'; msg: ExecResultMessage }
  | { kind: 'publish_result'; msg: PublishResultMessage }
  | { kind: 'run_checks_result'; msg: RunChecksResultMessage }
  | { kind: 'provision_result'; msg: ProvisionResultMessage }
  | { kind: 'bad'; error: string };

/**
 * Parse and validate one inbound line. Everything from the gateway is treated as data: bad
 * JSON or an unexpected shape returns `kind: 'bad'` rather than throwing.
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
    if (typeof obj['id'] !== 'string' || typeof obj['specRef'] !== 'string' || typeof obj['approved'] !== 'boolean') {
      return { kind: 'bad', error: 'unexpected approval_verdict shape' };
    }
    const msg: ApprovalVerdictMessage =
      typeof obj['feedback'] === 'string'
        ? { type: 'approval_verdict', id: obj['id'], specRef: obj['specRef'], approved: obj['approved'], feedback: obj['feedback'] }
        : { type: 'approval_verdict', id: obj['id'], specRef: obj['specRef'], approved: obj['approved'] };
    return { kind: 'verdict', msg };
  }
  if (obj['type'] === 'clone_result') {
    if (typeof obj['id'] !== 'string' || typeof obj['ok'] !== 'boolean') {
      return { kind: 'bad', error: 'unexpected clone_result shape' };
    }
    const ok = obj['ok'];
    const id = obj['id'];
    let msg: CloneResultMessage;
    if (ok && typeof obj['workdir'] === 'string') {
      msg = { type: 'clone_result', id, ok: true, workdir: obj['workdir'] };
    } else if (ok) {
      msg = { type: 'clone_result', id, ok: true };
    } else if (typeof obj['error'] === 'string') {
      msg = { type: 'clone_result', id, ok: false, error: obj['error'] };
    } else {
      msg = { type: 'clone_result', id, ok: false };
    }
    return { kind: 'clone_result', msg };
  }
  if (obj['type'] === 'build_result') {
    if (typeof obj['id'] !== 'string' || typeof obj['ok'] !== 'boolean') {
      return { kind: 'bad', error: 'unexpected build_result shape' };
    }
    const ok = obj['ok'];
    const id = obj['id'];
    let msg: BuildResultMessage;
    if (ok && typeof obj['prUrl'] === 'string') {
      msg = { type: 'build_result', id, ok: true, prUrl: obj['prUrl'] };
    } else if (ok) {
      msg = { type: 'build_result', id, ok: true };
    } else if (typeof obj['reason'] === 'string') {
      msg = { type: 'build_result', id, ok: false, reason: obj['reason'] };
    } else {
      msg = { type: 'build_result', id, ok: false };
    }
    return { kind: 'build_result', msg };
  }
  if (obj['type'] === 'exec_result') {
    if (typeof obj['id'] !== 'string' || typeof obj['ok'] !== 'boolean') {
      return { kind: 'bad', error: 'unexpected exec_result shape' };
    }
    const ok = obj['ok'];
    const id = obj['id'];
    let msg: ExecResultMessage;
    if (ok && typeof obj['prUrl'] === 'string') {
      msg = { type: 'exec_result', id, ok: true, prUrl: obj['prUrl'] };
    } else if (ok) {
      msg = { type: 'exec_result', id, ok: true };
    } else if (typeof obj['reason'] === 'string') {
      msg = { type: 'exec_result', id, ok: false, reason: obj['reason'] };
    } else {
      msg = { type: 'exec_result', id, ok: false };
    }
    return { kind: 'exec_result', msg };
  }
  if (obj['type'] === 'publish_result') {
    if (typeof obj['id'] !== 'string' || typeof obj['ok'] !== 'boolean') {
      return { kind: 'bad', error: 'unexpected publish_result shape' };
    }
    const ok = obj['ok'];
    const id = obj['id'];
    let msg: PublishResultMessage;
    if (ok && typeof obj['prUrl'] === 'string') {
      msg = { type: 'publish_result', id, ok: true, prUrl: obj['prUrl'] };
    } else if (ok) {
      msg = { type: 'publish_result', id, ok: true };
    } else if (typeof obj['reason'] === 'string') {
      msg = { type: 'publish_result', id, ok: false, reason: obj['reason'] };
    } else {
      msg = { type: 'publish_result', id, ok: false };
    }
    return { kind: 'publish_result', msg };
  }
  if (obj['type'] === 'run_checks_result') {
    if (typeof obj['id'] !== 'string' || typeof obj['ok'] !== 'boolean') {
      return { kind: 'bad', error: 'unexpected run_checks_result shape' };
    }
    const ok = obj['ok'];
    const id = obj['id'];
    let msg: RunChecksResultMessage;
    if (ok) {
      if (!Array.isArray(obj['results'])) {
        return { kind: 'bad', error: 'unexpected run_checks_result shape' };
      }
      const results: RunChecksResult[] = [];
      for (const item of obj['results']) {
        if (typeof item !== 'object' || item === null) {
          return { kind: 'bad', error: 'unexpected run_checks_result shape' };
        }
        const result = item as Record<string, unknown>;
        if (
          (result['kind'] !== 'lint' && result['kind'] !== 'test') ||
          typeof result['exitCode'] !== 'number' ||
          !Number.isFinite(result['exitCode']) ||
          typeof result['skipped'] !== 'boolean' ||
          typeof result['output'] !== 'string'
        ) {
          return { kind: 'bad', error: 'unexpected run_checks_result shape' };
        }
        results.push({
          kind: result['kind'],
          exitCode: result['exitCode'],
          skipped: result['skipped'],
          output: result['output'],
        });
      }
      msg = { type: 'run_checks_result', id, ok: true, results };
    } else if (typeof obj['reason'] === 'string') {
      msg = { type: 'run_checks_result', id, ok: false, reason: obj['reason'] };
    } else {
      msg = { type: 'run_checks_result', id, ok: false };
    }
    return { kind: 'run_checks_result', msg };
  }
  if (obj['type'] === 'provision_result') {
    if (typeof obj['id'] !== 'string' || typeof obj['ok'] !== 'boolean') {
      return { kind: 'bad', error: 'unexpected provision_result shape' };
    }
    const ok = obj['ok'];
    const id = obj['id'];
    const msg: ProvisionResultMessage = ok
      ? { type: 'provision_result', id, ok: true }
      : typeof obj['error'] === 'string'
        ? { type: 'provision_result', id, ok: false, error: obj['error'] }
        : { type: 'provision_result', id, ok: false };
    return { kind: 'provision_result', msg };
  }
  return { kind: 'bad', error: 'unknown message type' };
}
