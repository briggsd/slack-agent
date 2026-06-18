# Task: M5 S03 — real GitNodeExecutor (Docker clone/push + GitHub REST PR) + smoke

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-sonnet-m5-s03-real-git-nodes`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(gate, invariants, conventions), then the context below. You are on branch
`sonnet/m5-s03-real-git-nodes`.

## What this slice is

The **real** `GitNodeExecutor` — the deterministic, credentialed git operations that
S02 stubbed with `FakeGitNodeExecutor`. Clone and push run as **ephemeral
`docker run --rm` containers** that mount the session's workspace volume and carry the
per-lease token in their **env** (never argv, never the agent container); opening a PR
is a **GitHub REST** call. This is the slice that makes the credential boundary real:
the token reaches only the ephemeral git container and the REST call — the agent
container (`DockerRunner`, unchanged) still gets only `ANTHROPIC_API_KEY`.

**Offline-testable by design:** the executor takes an injectable `spawn` (the existing
`SpawnFn` seam) and an injectable `fetch`, so tests assert the generated `docker` argv
and the HTTP request **shapes** — no real Docker, network, or git in the gate. The real
clone→push→PR is validated by a **smoke script** (not in CI) against a throwaway repo +
token, which the user is setting up.

GitHub only this slice. The host-provider seam is shaped so GitLab slots in later
(the M5 decision: host-agnostic, GitLab is the planned second host).

## Context — read before writing code

- **The seam you implement (from S02):** `src/oneshot/git-node.ts` —
  `GitNodeExecutor` with `clone(CloneRequest)`, `push(PushRequest)`,
  `openChangeRequest(OpenChangeRequest): Promise<{url:string}>`. Requests currently
  carry `lease` (a `CredentialLease` = `{ readonly token, readonly host, readonly repo,
  revoke() }` from `src/broker/types.js`), `repo` ("owner/name"), `workdir`, plus
  push's `branch` and openChangeRequest's `head`/`base`/`title`/`body`.
  `src/oneshot/fake-git-node.ts` records calls — keep it working.
- **The precedent to MIRROR — `src/runner/docker.ts`:** `export type SpawnFn`,
  `export function sanitizeKey`, and `DockerRunnerFactory.create` building a
  `docker run` argv. Note line ~407 `volumeName = slackbot-ws-${sanitizeKey(key)}` and
  line ~415 `'-e', 'ANTHROPIC_API_KEY'` — the **name-only `-e`** pattern (value
  inherited from the process env, never placed in argv). Your clone/push mirror this
  exactly for the token. Default the executor's `spawn` to `child_process.spawn` like
  docker.ts does.
- **Where the agent's files live:** the one-shot inner agent runs in a `DockerRunner`
  whose volume is `slackbot-ws-${sanitizeKey(sessionKey)}`. Clone/push must mount **that
  same volume** so the agent edits and the push see the same tree. So you will
  **export a single `volumeNameFor(sessionKey)` from docker.ts** and use it both in
  `DockerRunnerFactory.create` (refactor the inline `volumeName` to call it —
  behavior-preserving) and to derive the volume the executor mounts.
- **The runner image has `git` + `curl`** (`runner/Dockerfile`), so it can double as the
  git-node image — the executor takes the image name as a constructor arg (no hardcoded
  default needed here; the smoke/S05 supply it).
- **Node 20 has global `fetch`** — the executor's `fetchFn` defaults to it; tests inject
  a fake.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end.

## CRITICAL — credential boundary (the security point of this slice)

- The lease **token must NEVER appear in process argv** (it is visible in host `ps`).
  Pass it to the ephemeral container via the spawn's `env` option and reference it by
  name with `-e GIT_TOKEN` (name only), exactly like docker.ts does for
  `ANTHROPIC_API_KEY`. Inside the container, git reads it via a **credential helper that
  echoes the env var** — so it is never in argv or a stored remote URL either.
- The token must never be logged, never put in an error message, and never baked into
  the cloned remote URL.

## What to build

### 1. `volumeNameFor` (in `src/runner/docker.ts`)
Add `export function volumeNameFor(sessionKey: string): string { return
\`slackbot-ws-${sanitizeKey(sessionKey)}\`; }` and refactor
`DockerRunnerFactory.create` to use it (so the two can never drift). No behavior change.

### 2. Host provider — `src/oneshot/git-host.ts`
A host-agnostic seam with a GitHub implementation:
```ts
import type { GitHost } from '../broker/types.js';
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
    repo: string; head: string; base: string; title: string; body: string;
    token: string; fetchFn: FetchFn;
  }): Promise<{ url: string }>;
}
export type FetchFn = typeof fetch;
export class GithubProvider implements GitHostProvider { /* … */ }
export function providerFor(host: GitHost): GitHostProvider; // throws on unsupported (gitlab → clear "not yet" error)
```
GitHub specifics (ground them — these are the real API shapes):
- `cloneUrl('owner/name')` → `https://github.com/owner/name.git`.
- `credentialUsername()` → `'x-access-token'` (works for tokens; password = the token).
- `defaultBranch`: `GET https://api.github.com/repos/{repo}` with headers
  `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
  `User-Agent: slack-agent`; read `default_branch` from the JSON.
- `openChangeRequest`: `POST https://api.github.com/repos/{repo}/pulls` with the same
  headers, JSON body `{ title, head, base, body }`; read `html_url` from the response.
  On a non-2xx, throw an Error with the status (and a short reason if present) but
  **never include the token**.

### 3. Real executor — `src/oneshot/docker-git-node.ts`
`DockerGitNodeExecutor implements GitNodeExecutor`:
- Constructor (all injectable): `{ image: string; spawn?: SpawnFn; fetchFn?: FetchFn }`
  — `spawn` defaults to `child_process.spawn`, `fetchFn` defaults to global `fetch`.
- `clone(req)`: `docker run --rm -v <req.volume>:/workspace -e GIT_TOKEN
  --security-opt no-new-privileges <image> <git-clone-cmd>` via `spawn`, with spawn
  options `{ env: { ...process.env, GIT_TOKEN: req.lease.token }, stdio: 'ignore'-ish }`.
  The git command runs `git` with an inline credential helper that echoes
  `username=<provider.credentialUsername()>` and `password=$GIT_TOKEN`, then
  `git clone <provider.cloneUrl(repo)> <workdir>`. Resolve a non-zero exit into a
  rejected Promise (a clear Error, no token). Pick the provider via
  `providerFor(req.lease.host)`.
- `push(req)`: same ephemeral-container shape, running `git -C <workdir> push origin
  <branch>` with the same credential helper + `-e GIT_TOKEN` env.
- `openChangeRequest(req)`: resolve the real base via
  `provider.defaultBranch(repo, token, fetchFn)` (this fixes S02's hardcoded
  `base:'main'` — use the detected default branch, not the request's `base`), then
  `provider.openChangeRequest({ … base: detectedDefault … })`. Return `{ url }`.
- **You need a small async helper to await a spawned process's exit code** (mirror how
  docker.ts waits, or a minimal `once('exit')`/`once('error')` Promise). Keep it
  injectable-friendly: the test's fake `spawn` returns a fake child whose exit you can
  drive. Look at `FakeChildProcess` in the test suite (used by `docker.test.ts`) and
  reuse/extend it rather than inventing a new fake.

### 4. Add `volume` to the request types + thread it (small, keeps the flow correct)
- `src/oneshot/git-node.ts`: add `volume: string` to `CloneRequest` and `PushRequest`
  (the Docker volume to mount). `OpenChangeRequest` is REST — no volume.
- `src/oneshot/orchestrator.ts`: `OneShotOrchestrator` takes `sessionKey` (new
  constructor param, before the optional `taskId`), computes `volume =
  volumeNameFor(sessionKey)`, and passes `volume` in its clone/push requests. (workdir
  stays `/workspace/<repoSlug>` — a path *inside* that volume.)
- `src/oneshot/dispatching-factory.ts`: pass the `sessionKey` it already receives into
  `new OneShotOrchestrator(...)`.
- `src/oneshot/fake-git-node.ts`: no logic change (it records whole requests; the new
  `volume` field rides along) — but confirm it still type-checks.
- Update `test/oneshot.test.ts`: construct the orchestrator with a `sessionKey` and
  assert `clones[0].volume === volumeNameFor(sessionKey)` (and `pushes[0].volume`).

### 5. Smoke script — `scripts/smoke-oneshot.sh` (NOT in CI; a deliverable for the user)
A small bash script (mirror `scripts/smoke-docker.sh`'s style + header) that, given env
`GIT_TEST_REPO` ("owner/name"), `GIT_TEST_TOKEN`, and `GIT_IMAGE` (default
`slackbot-runner:latest`), drives the **real** executor end-to-end: builds a tiny
throwaway driver (inline `node -e`/a `.mjs`) that constructs a `DockerGitNodeExecutor`
+ a real lease, clones into a fresh volume, makes a trivial commit on a new branch,
pushes, opens a PR, prints the PR url, and cleans up the volume. Document prereqs in the
header (Docker, the git image present, a fine-grained PAT scoped to the repo with
Contents:read/write + Pull requests:read/write). It’s fine for this to be lightly
tested by hand only — mark clearly it is not part of the gate.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` + `npm run boundaries`. Existing tests pass;
   new ones added.
2. `volumeNameFor` exported and used by `DockerRunnerFactory` (no behavior change).
3. `GithubProvider` + `providerFor` exist with the GitHub API shapes above; `gitlab`
   yields a clear "not yet supported" error.
4. `DockerGitNodeExecutor` implements `GitNodeExecutor`: clone/push spawn the documented
   `docker run` argv with the token in **env, not argv**; `openChangeRequest` detects the
   default branch then POSTs the PR and returns its url.
5. `CloneRequest`/`PushRequest` carry `volume`; the orchestrator threads
   `volumeNameFor(sessionKey)`; `test/oneshot.test.ts` updated and green.
6. `scripts/smoke-oneshot.sh` exists (not in the gate).
7. New tests (below) cover criteria 3–4 and the credential-boundary assertion.

## Test infrastructure (how to test this — the hard part, do not skip)

Tests live in `test/`, run under **vitest**, **offline**. Create
`test/docker-git-node.test.ts` (+ extend `test/oneshot.test.ts` for the `volume`
thread). Use injectable seams — never real Docker/network/git:
- **Spawn:** reuse the existing **`FakeChildProcess`** fake (see `test/docker.test.ts`
  for how it's constructed and how exit is driven). Pass a fake `spawn` that returns a
  `FakeChildProcess` and records `(command, args, options)`. Assert:
  - argv contains `'run'`, `'--rm'`, `'-v', '<volume>:/workspace'`, `'-e', 'GIT_TOKEN'`
    (name only), the image, and the git subcommand; for push, the `git -C <workdir> push
    origin <branch>` form.
  - **the token is in `options.env.GIT_TOKEN` and NOT anywhere in argv** —
    `expect(args.join(' ')).not.toContain(token)` and
    `expect(options.env.GIT_TOKEN).toBe(token)`. This is the credential-boundary test.
  - a non-zero exit rejects clone/push with an Error whose message excludes the token.
- **Fetch:** pass a fake `fetchFn` returning canned `Response`-likes. Assert
  `openChangeRequest` first GETs `…/repos/{repo}` (default branch) then POSTs
  `…/repos/{repo}/pulls`; the `Authorization` header carries `Bearer <token>`; the body
  has `{title, head, base, body}` with `base` = the detected default branch (NOT a
  hardcoded 'main'); and the returned url is the response's `html_url`. Assert a non-2xx
  rejects without leaking the token.
- **Provider:** assert `cloneUrl`/`credentialUsername` shapes and that
  `providerFor('gitlab')` throws a clear error.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the **real tail** (pass/fail counts).
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers). Honor
  `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`.
- **Token never in argv, never logged, never in an error message or stored remote URL.**
- `src/` must not import `@slack/bolt`, the Agent SDK, or the `runner/` package
  (`npm run boundaries`). `child_process` and global `fetch` are fine.
- Do NOT touch `src/runner/docker.ts` beyond adding/using `volumeNameFor` (keep the
  container lifecycle behavior identical). Do NOT modify `protocol.ts`, the Slack layer,
  `config.ts`, or `index.ts` (live wiring is S05).
- Keep the diff focused: the new git-host + executor files + their tests, the
  `volumeNameFor` export, the `volume` field + orchestrator thread, and the smoke script.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build — later slices)

- **GitLab** REST/clone specifics — only the seam + a "not yet" error this slice.
- **Live wiring**: instantiating `DockerGitNodeExecutor` in `index.ts`, config
  (`GIT_IMAGE`, broker tokens), channel→profile selection, trigger UX — **S05**.
- Research→plan→implement, lint/test nodes, failure classifier, bounded iteration,
  diff/file forwarding — **S04**.
- Running the real smoke — the coordinator/user runs `scripts/smoke-oneshot.sh`
  post-merge with a real repo + token.

## When done — report precisely (with REAL command output)

Run and paste the ACTUAL output of `git status --short`, `git diff --stat`, and the full
`npm run gate` tail (pass/fail counts). Do not describe any change you cannot point to in
`git diff` — especially `test/docker-git-node.test.ts`. Then: (1) files added/changed,
one line each; (2) how the token is kept out of argv (show the spawn env + `-e GIT_TOKEN`
shape) and how the credential helper reads it; (3) which test covers each acceptance
criterion 3–4 + the credential-boundary assertion; (4) anything you could not satisfy.
Note the smoke script is verified by reading only (not run); state exactly what a human
runs to smoke it (`GIT_TEST_REPO=… GIT_TEST_TOKEN=… bash scripts/smoke-oneshot.sh`).
