import type { RunnerEvent, SessionRunner, RunnerFactory } from './types.js';

export type ScriptedEvent = RunnerEvent;

/**
 * A scripted turn: either a static list of events, or a factory
 * that returns a Promise (so tests can block a turn until they resolve it).
 */
export type TurnScript =
  | ScriptedEvent[]
  | (() => Promise<ScriptedEvent[]>);

export class FakeRunner implements SessionRunner {
  readonly sessionKey: string;
  private script: TurnScript[];
  private turnIndex = 0;
  public disposed = false;
  public sends: string[] = [];

  constructor(sessionKey: string, script: TurnScript[] = []) {
    this.sessionKey = sessionKey;
    this.script = script;
  }

  send(message: string): AsyncIterable<RunnerEvent> {
    this.sends.push(message);
    const idx = this.turnIndex++;
    const turn = this.script[idx];

    // Default behaviour (no script): emit one status then final echo text
    const defaultEvents: RunnerEvent[] = [
      { type: 'status', text: 'processing…' },
      { type: 'text', text: `Echo: ${message}` },
    ];

    return {
      [Symbol.asyncIterator]: async function* () {
        const events: RunnerEvent[] =
          turn === undefined
            ? defaultEvents
            : Array.isArray(turn)
              ? turn
              : await turn();
        for (const e of events) {
          yield e;
        }
      },
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export class FakeRunnerFactory implements RunnerFactory {
  public creates: string[] = [];
  private script: TurnScript[];
  public runners: FakeRunner[] = [];

  constructor(script: TurnScript[] = []) {
    this.script = script;
  }

  async create(sessionKey: string): Promise<SessionRunner> {
    this.creates.push(sessionKey);
    const runner = new FakeRunner(sessionKey, this.script);
    this.runners.push(runner);
    return runner;
  }
}
