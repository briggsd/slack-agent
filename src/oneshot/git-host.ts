/**
 * GitHostProvider — host-agnostic seam for git hosting services.
 *
 * GithubProvider is the only concrete implementation this slice.
 * GitLab support is planned (M5+) — providerFor('gitlab') throws a clear
 * "not yet" error so callers get an actionable message at runtime.
 */

import type { GitHost } from '../broker/types.js';

export type FetchFn = typeof fetch;

export interface GitHostProvider {
  readonly host: GitHost;
  /** HTTPS clone URL with NO secret embedded (token applied at runtime via the helper). */
  cloneUrl(repo: string): string;
  /** Git credential username for this host (token is the password). */
  credentialUsername(): string;
  /** The repo's default branch (PR base). */
  defaultBranch(repo: string, token: string, fetchFn: FetchFn): Promise<string>;
  /** Open a PR/MR; returns its web url. */
  openChangeRequest(req: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    token: string;
    fetchFn: FetchFn;
  }): Promise<{ url: string }>;
}

/** GitHub implementation. Credentials travel as Bearer tokens; never embedded in URLs. */
export class GithubProvider implements GitHostProvider {
  readonly host: GitHost = 'github';

  cloneUrl(repo: string): string {
    return `https://github.com/${repo}.git`;
  }

  credentialUsername(): string {
    return 'x-access-token';
  }

  async defaultBranch(repo: string, token: string, fetchFn: FetchFn): Promise<string> {
    const url = `https://api.github.com/repos/${repo}`;
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'slack-agent',
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} fetching repo metadata`);
    }

    const data = (await res.json()) as { default_branch?: unknown };
    if (typeof data.default_branch !== 'string' || data.default_branch === '') {
      throw new Error('GitHub API returned no default_branch');
    }
    return data.default_branch;
  }

  async openChangeRequest(req: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    token: string;
    fetchFn: FetchFn;
  }): Promise<{ url: string }> {
    const url = `https://api.github.com/repos/${req.repo}/pulls`;
    const res = await req.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'slack-agent',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: req.title,
        head: req.head,
        base: req.base,
        body: req.body,
      }),
    });

    if (!res.ok) {
      // Never include the token in the error message
      throw new Error(`GitHub API error ${res.status} creating pull request`);
    }

    const data = (await res.json()) as { html_url?: unknown };
    if (typeof data.html_url !== 'string' || data.html_url === '') {
      throw new Error('GitHub API returned no html_url for the pull request');
    }
    return { url: data.html_url };
  }
}

/** Return the provider for the given git host. Throws a clear error for unsupported hosts. */
export function providerFor(host: GitHost): GitHostProvider {
  if (host === 'github') {
    return new GithubProvider();
  }
  if (host === 'gitlab') {
    throw new Error(
      `GitLab is not yet supported as a git host. Only 'github' is implemented in this slice.`,
    );
  }
  // Exhaustive — TypeScript ensures we handle all GitHost variants above.
  // This branch is a runtime safety net for unexpected values.
  throw new Error(`Unsupported git host: ${String(host)}`);
}
