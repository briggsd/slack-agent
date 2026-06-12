export type RunnerEvent =
  | { type: 'status'; text: string }   // progress note (tool use etc.)
  | { type: 'text'; text: string }     // final assistant text for this turn
  | { type: 'error'; message: string };

export interface SessionRunner {
  /** Send one user message; yields events until the turn completes. */
  send(message: string): AsyncIterable<RunnerEvent>;
  dispose(): Promise<void>;
}

export interface RunnerFactory {
  create(sessionKey: string): Promise<SessionRunner>;
}
