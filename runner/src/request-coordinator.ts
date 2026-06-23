/**
 * Generic request/result coordinator for container-side tool flows.
 *
 * Each tool that emits a `request_*` line to the gateway and blocks on the
 * matching `*_result` uses this base. It owns the `pending` map, a `seq`
 * counter, and the `drained` flag so each coordinator wrapper can be a thin
 * shell of typed adapter logic.
 */

export class RequestCoordinator<TInput, TResultMessage extends { id: string }, TOutcome> {
  private readonly pending = new Map<string, (outcome: TOutcome) => void>();
  private seq = 0;
  private drained = false;

  constructor(
    private readonly prefix: string,
    private readonly emitRequest: (input: TInput, id: string) => void,
    private readonly fromMessage: (msg: TResultMessage) => TOutcome,
    private readonly shutdownOutcome: TOutcome,
  ) {}

  request(input: TInput): Promise<TOutcome> {
    if (this.drained) {
      return Promise.resolve(this.shutdownOutcome);
    }
    const id = `${this.prefix}-${++this.seq}`;
    return new Promise<TOutcome>((resolve) => {
      this.pending.set(id, resolve);
      this.emitRequest(input, id);
    });
  }

  handleResult(msg: TResultMessage): boolean {
    const resolve = this.pending.get(msg.id);
    if (resolve === undefined) return false;
    this.pending.delete(msg.id);
    resolve(this.fromMessage(msg));
    return true;
  }

  failAllPending(): void {
    this.drained = true;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve(this.shutdownOutcome);
    }
  }
}
