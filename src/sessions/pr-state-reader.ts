export interface PrState {
  status: 'open' | 'merged' | 'closed';
  headSha: string;
}

export interface PrStateReader {
  getState(req: { repo: string; number: number }): Promise<PrState>;
}
