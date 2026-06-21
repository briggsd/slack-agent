# Task: add `assertDogfoodGate` — fail startup if the self-repo is dogfood-allowlisted without the full gate as its check

You are implementing one slice in this worktree
(`/Users/jedanner/workspace/sa-wt-codex-dogfood-gate-guardrail`, a checkout of the
slack-agent repo — TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` and `AGENTS.md` first** (gate, invariants, branch+PR workflow), then the
context below. You are already on branch `codex/dogfood-gate-guardrail` — do NOT
create a new branch, and do NOT commit to `main`. `node_modules` is symlinked, so the
gate runs offline without `npm ci`.

## Context — read before writing code

- **Why:** `docs/DOGFOODING.md` (read it — it is the contract this guardrail
  enforces). Tier-1 dogfooding lets the bot do leaf work on its own repo. A hard
  prerequisite is that `run_checks` for the self-repo runs the **full gate**
  (`npm run gate`), not the default vitest-only `test` script — otherwise the
  agent's PRs skip `tsc`/runner-typecheck/`boundaries`, where this repo's
  invariants live. This guardrail makes that prerequisite impossible to forget:
  if the self-repo is dogfood-enabled but its check command is too weak, startup
  fails loud. Track item: `24b94a` (label `sandbox-caps`).
- **Code this builds on (all in `src/config.ts`):**
  - `parseRepoAllowlist` (~`:148`) → `cloneRepoAllowlist: ReadonlySet<string>`
    (`OneShotConfig`, `:73`). Allowlisting the self-repo is the "dogfooding on"
    signal.
  - `parseCheckCmds` (~`:99`) → `checkCmds: ReadonlyMap<string, RepoCheckCmds>`
    (`:82`); `RepoCheckCmds` is `{ lint?: string; test?: string }`.
  - `loadConfig` assembles both from env (`:313` allowlist, `:316` checkCmds) into
    the returned config around `:290`–`:320`. This is where the assertion is called.
- **Pattern to mirror:** the existing pure parse-and-validate, fail-startup-on-bad
  helpers (`parseRepoAllowlist` throws on a malformed slug). This is the same shape:
  a pure exported function that throws a clear `Error`, called at the `loadConfig`
  boundary. No I/O.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end.

## What to build

1. **Two module-level constants in `src/config.ts`** (near the other dogfooding-
   adjacent config):
   - `SELF_REPO = 'briggsd/slack-agent'` — this repo's own owner/name slug.
   - `REQUIRED_SELF_CHECK_CMD = 'npm run gate'` — the check command the self-repo
     must use when dogfood-enabled.

2. **`export function assertDogfoodGate(allowlist: ReadonlySet<string>, checkCmds:
   ReadonlyMap<string, RepoCheckCmds>): void`** — pure, no I/O, throws on violation:
   - If `!allowlist.has(SELF_REPO)` → return (dogfooding off; nothing to enforce).
   - Otherwise the self-repo is dogfood-enabled, so require
     `checkCmds.get(SELF_REPO)?.test === REQUIRED_SELF_CHECK_CMD`. If the entry is
     missing, or its `test` is undefined or any other string, **throw** an `Error`
     whose message states that the self-repo is in `CLONE_REPO_ALLOWLIST` so its
     `ONESHOT_CHECK_CMDS` `test` command must be `npm run gate`, and names
     `docs/DOGFOODING.md`. Keep the message one or two sentences, token-free.
   - Only the `test` command is checked (the documented recipe sets
     `{"test":"npm run gate"}`); `lint` is not required.

3. **Call it in `loadConfig`**, right after both `cloneRepoAllowlist` and
   `checkCmds` are available and before/at the config return assembly (~`:290`–`:316`),
   so a misconfigured dogfooding deploy fails at startup, not at first use.

## Acceptance criteria

1. `npm run check` passes (all existing tests keep passing, plus the new ones); the
   full gate `npm run gate` is clean (`boundaries` included).
2. `assertDogfoodGate` is a pure exported function with the exact signature above.
3. New tests in `test/config.test.ts` (pure, no env mutation, no I/O), each
   constructing `Set`/`Map` inputs directly:
   - self-repo **not** in allowlist → does **not** throw, regardless of `checkCmds`
     (including an empty map, and a wrong self-repo cmd that is ignored because
     dogfooding is off).
   - self-repo in allowlist + `checkCmds` has `{ test: 'npm run gate' }` for it →
     does **not** throw.
   - self-repo in allowlist + **no** `checkCmds` entry for it → **throws**.
   - self-repo in allowlist + entry `{ test: 'npm test' }` (wrong cmd) → **throws**.
   - self-repo in allowlist + entry `{ lint: 'npm run gate' }` (test undefined) →
     **throws**.
4. (If quick to assert) a `loadConfig`-level test that a dogfood-allowlisted env
   without the gate check command surfaces the throw — only if it fits the existing
   `loadConfig` test seam without reaching the real world; otherwise the pure-function
   tests in #3 are sufficient and the call-site is covered by inspection.

## Hard constraints (do NOT violate)

- The gate (`npm run check`) must pass; paste the tail of its output when done.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers); pure function, no I/O
  in the helper, no env mutation in tests.
- Do not touch `protocol.ts`, the allowlist/check-cmd parsers' existing behavior, or
  any runtime path beyond adding the assertion call.
- Add no dependencies. Never log message contents or tokens (this code logs nothing).
- Do NOT commit to `main`. Branch, implement, get `npm run gate` green, commit, open
  a PR (`gh pr create`), and stop at a green reviewable PR — do not merge (per
  `AGENTS.md`).

## Out of scope (do NOT build)

- Changing `CLONE_REPO_ALLOWLIST` / `ONESHOT_CHECK_CMDS` to be file-backed/committed —
  they stay env, operator-controlled by design.
- Any Tier-2/Tier-3 enablement, profile/system-prompt changes, or bot behavioral
  guardrails (`docs/DOGFOODING.md` describes those tiers; this slice is only the
  startup check).
- Writing `docs/DOGFOODING.md` — it already exists; only reference it.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run check` (real, not paraphrased) and that `npm run boundaries`
  is clean.
- Any deviation from this spec and why.
