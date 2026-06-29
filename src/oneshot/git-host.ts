/**
 * GitHostProvider — host-agnostic seam for git hosting services.
 *
 * GithubProvider is the only concrete implementation this slice.
 * GitLab support is planned (M5+) — providerFor('gitlab') throws a clear
 * "not yet" error so callers get an actionable message at runtime.
 */

import type { GitHost } from '../broker/types.js';

export type FetchFn = typeof fetch;

/**
 * Read a short, safe reason from a failed GitHub response. GitHub's error body carries
 * the actual cause (e.g. "No commits between main and X") and never echoes the request's
 * Authorization header, so it is safe to surface — unlike the token we sent.
 */
async function safeReason(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: unknown };
    if (typeof data.message === 'string' && data.message !== '') {
      return ` — ${data.message.slice(0, 200)}`;
    }
  } catch {
    // body not JSON / already consumed — fall through
  }
  return '';
}

export interface GitHostProvider {
  readonly host: GitHost;
  /** HTTPS clone URL with NO secret embedded (token applied at runtime via the helper). */
  cloneUrl(repo: string): string;
  /** Git credential username for this host (token is the password). */
  credentialUsername(): string;
  /** The repo's default branch (PR base). */
  defaultBranch(repo: string, token: string, fetchFn: FetchFn): Promise<string>;
  /** Read the current state of a PR/MR and the branch head it points at. */
  getChangeRequestState(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
  }): Promise<{ status: 'open' | 'merged' | 'closed'; headSha: string }>;
  /** Resolve the open PR/MR for the given head branch. */
  getChangeRequestByHead(req: {
    repo: string;
    head: string;
    token: string;
    fetchFn: FetchFn;
  }): Promise<{ number: number; url: string; headSha: string } | null>;
  /** Open a PR/MR; returns its web url. */
  openChangeRequest(req: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    token: string;
    fetchFn: FetchFn;
  }): Promise<{ url: string; number: number; headSha: string }>;
  /** Edit an existing PR/MR title/body. */
  editChangeRequest(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
    title?: string;
    body?: string;
  }): Promise<{ url: string }>;
  /** Add a comment to an existing PR/MR. */
  addChangeRequestComment(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
    comment: string;
  }): Promise<{ url: string }>;
  /** Read an issue (also matches PRs on GitHub). Returns title, body, state, and author. */
  getIssue(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
  }): Promise<{ title: string; body: string; state: 'open' | 'closed'; author: string }>;
  /** Read general comments on an issue/PR (issues/{n}/comments). Returns all comments from a single page. */
  getIssueComments(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
  }): Promise<Array<{ author: string; body: string }>>;
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
      throw new Error(`GitHub API error ${res.status} fetching repo metadata${await safeReason(res)}`);
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
  }): Promise<{ url: string; number: number; headSha: string }> {
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
      // GitHub's response body carries the reason and never echoes our token.
      throw new Error(`GitHub API error ${res.status} creating pull request${await safeReason(res)}`);
    }

    const data = (await res.json()) as {
      html_url?: unknown;
      number?: unknown;
      head?: { sha?: unknown };
    };
    if (typeof data.html_url !== 'string' || data.html_url === '') {
      throw new Error('GitHub API returned no html_url for the pull request');
    }
    if (typeof data.number !== 'number') {
      throw new Error('GitHub API returned no numeric pull request number');
    }
    if (typeof data.head?.sha !== 'string' || data.head.sha === '') {
      throw new Error('GitHub API returned no head.sha for the pull request');
    }
    return { url: data.html_url, number: data.number, headSha: data.head.sha };
  }

  async getChangeRequestByHead(req: {
    repo: string;
    head: string;
    token: string;
    fetchFn: FetchFn;
  }): Promise<{ number: number; url: string; headSha: string } | null> {
    const owner = req.repo.split('/')[0];
    if (owner === undefined || owner === '') {
      throw new Error('GitHub API request needs an owner/repo slug');
    }
    const url = `https://api.github.com/repos/${req.repo}/pulls?head=${encodeURIComponent(`${owner}:${req.head}`)}&state=open`;
    const res = await req.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'slack-agent',
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} fetching pull requests${await safeReason(res)}`);
    }

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('GitHub API returned a non-array pull request list');
    }
    if (data.length === 0) {
      return null;
    }
    const first = data[0];
    if (typeof first !== 'object' || first === null) {
      throw new Error('GitHub API returned an invalid pull request entry');
    }
    const pr = first as {
      html_url?: unknown;
      number?: unknown;
      head?: { sha?: unknown };
    };
    if (typeof pr.html_url !== 'string' || pr.html_url === '') {
      throw new Error('GitHub API returned no html_url for the pull request');
    }
    if (typeof pr.number !== 'number') {
      throw new Error('GitHub API returned no numeric pull request number');
    }
    if (typeof pr.head?.sha !== 'string' || pr.head.sha === '') {
      throw new Error('GitHub API returned no head.sha for the pull request');
    }
    return { number: pr.number, url: pr.html_url, headSha: pr.head.sha };
  }

  async editChangeRequest(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
    title?: string;
    body?: string;
  }): Promise<{ url: string }> {
    const url = `https://api.github.com/repos/${req.repo}/pulls/${String(req.number)}`;
    const res = await req.fetchFn(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'slack-agent',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(req.title !== undefined && { title: req.title }),
        ...(req.body !== undefined && { body: req.body }),
      }),
    });

    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} editing pull request${await safeReason(res)}`);
    }

    const data = (await res.json()) as { html_url?: unknown };
    if (typeof data.html_url !== 'string' || data.html_url === '') {
      throw new Error('GitHub API returned no html_url for the pull request');
    }
    return { url: data.html_url };
  }

  async addChangeRequestComment(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
    comment: string;
  }): Promise<{ url: string }> {
    const url = `https://api.github.com/repos/${req.repo}/issues/${String(req.number)}/comments`;
    const res = await req.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'slack-agent',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: req.comment }),
    });

    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} creating pull request comment${await safeReason(res)}`);
    }

    const data = (await res.json()) as { html_url?: unknown };
    if (typeof data.html_url !== 'string' || data.html_url === '') {
      throw new Error('GitHub API returned no html_url for the comment');
    }
    return { url: data.html_url };
  }

  async getIssue(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
  }): Promise<{ title: string; body: string; state: 'open' | 'closed'; author: string }> {
    const url = `https://api.github.com/repos/${req.repo}/issues/${req.number}`;
    const res = await req.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'slack-agent',
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} fetching issue${await safeReason(res)}`);
    }

    const data = (await res.json()) as {
      title?: unknown;
      body?: unknown;
      state?: unknown;
      user?: { login?: unknown };
    };

    const title = typeof data.title === 'string' ? data.title : '';
    const body = (data.body === null || data.body === undefined || typeof data.body !== 'string') ? '' : data.body;
    const state: 'open' | 'closed' = data.state === 'closed' ? 'closed' : 'open';
    const author = typeof data.user?.login === 'string' ? data.user.login : '';

    return { title, body, state, author };
  }

  async getIssueComments(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
  }): Promise<Array<{ author: string; body: string }>> {
    const url = `https://api.github.com/repos/${req.repo}/issues/${req.number}/comments?per_page=100`;
    const res = await req.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'slack-agent',
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} fetching issue comments${await safeReason(res)}`);
    }

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('GitHub API returned a non-array issue comments list');
    }

    return data.map((entry: unknown) => {
      const e = entry as { body?: unknown; user?: { login?: unknown } };
      const body = (e.body === null || e.body === undefined || typeof e.body !== 'string') ? '' : e.body;
      const author = typeof e.user?.login === 'string' ? e.user.login : '';
      return { author, body };
    });
  }

  async getChangeRequestState(req: {
    repo: string;
    number: number;
    token: string;
    fetchFn: FetchFn;
  }): Promise<{ status: 'open' | 'merged' | 'closed'; headSha: string }> {
    const url = `https://api.github.com/repos/${req.repo}/pulls/${req.number}`;
    const res = await req.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'slack-agent',
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} fetching pull request${await safeReason(res)}`);
    }

    const data = (await res.json()) as {
      merged?: unknown;
      state?: unknown;
      head?: { sha?: unknown };
    };
    if (typeof data.merged !== 'boolean') {
      throw new Error('GitHub API returned no merged flag for the pull request');
    }
    if (typeof data.state !== 'string' || data.state === '') {
      throw new Error('GitHub API returned no state for the pull request');
    }
    if (typeof data.head?.sha !== 'string' || data.head.sha === '') {
      throw new Error('GitHub API returned no head.sha for the pull request');
    }

    const status = data.merged ? 'merged' : data.state === 'closed' ? 'closed' : 'open';
    return { status, headSha: data.head.sha };
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
