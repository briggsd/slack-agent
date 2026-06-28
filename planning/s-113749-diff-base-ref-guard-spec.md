# Task: Guard the duplicated DIFF_BASE_REF literal — assert the runner and gateway copies match

You are implementing one small slice in `/Users/jedanner/workspace/slack-agent`
(this is a worktree of it; TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the
root `CLAUDE.md` first**, then the context below. You are on branch
`haiku/diff-base-ref-guard`.

## Why (context — read before writing code)

`DIFF_BASE_REF` is the git ref the gateway creates so the agent can diff its work
against a stable base (`<ref>...HEAD`). The literal is **duplicated** in two files
that are otherwise decoupled (the gateway must not import the runner package), and
the two copies are only kept in sync by a hand-written "keep in sync" comment:

- **Gateway** (`src/oneshot/docker-git-node.ts:251`):
  `export const DIFF_BASE_REF = 'refs/slack-agent/base';` — the gateway *creates* this
  ref on the clone.
- **Runner** (`runner/src/main.ts:232`):
  `const DIFF_BASE_REF = 'refs/slack-agent/base';` (not exported) — the runner tells
  the agent to `git diff ${DIFF_BASE_REF}...HEAD`.

If these drift, the coordinator's diff silently breaks (the runner instructs a diff
against a ref the gateway never created) with no test failure. Add a guard that fails
the suite on drift — analogous in spirit to the `protocol.ts` "two byte-identical
copies" rule, but for this one literal.

### Grounded facts (verified at `2bbb55f`)

- Both literals are exactly `'refs/slack-agent/base'` today.
- The gateway copy is `export`ed; the runner copy is a plain module-private `const`
  (do NOT rely on importing it — see Approach).
- There is no existing protocol-identity test to import a helper from; this is a new,
  self-contained test.

## Approach — text-read assertion (no cross-package import)

Importing `runner/src/main.ts` into a gateway test would (a) execute the runner entry
module's top-level code and (b) cross the gateway→runner boundary. Avoid both: the
guard **reads the two source files as text** and extracts the literal via regex, then
asserts the two values are equal. Reading repo files in a test is offline-safe (no
network/Docker/Slack/API) and creates no dependency-cruiser edge.

## Implementation — new test only

Create `test/diff-base-ref-sync.test.ts`:

- Resolve both paths relative to the test file (use `fileURLToPath(import.meta.url)`
  + `path` to get the repo root, or `process.cwd()` which is the repo root under
  vitest — pick one and be consistent). The two files:
  `runner/src/main.ts` and `src/oneshot/docker-git-node.ts`.
- `readFileSync(path, 'utf-8')` each.
- Extract the literal with a regex that matches the declaration in BOTH files, e.g.
  `/DIFF_BASE_REF\s*=\s*'([^']+)'/` (matches both `export const DIFF_BASE_REF = '…'`
  and `const DIFF_BASE_REF = '…'`). Use the first capture group.
- Assertions:
  1. The literal is found in the runner file (regex match is non-null) — a guard
     against the declaration being renamed/removed unnoticed.
  2. The literal is found in the gateway file.
  3. The two captured values are strictly equal (`expect(runnerVal).toBe(gatewayVal)`).
  - Add a clear failure message naming both files so a drift is actionable.

Keep it to ONE focused test file. No production changes.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`.
2. The new test reads both source files as text (NOT via import), extracts
   `DIFF_BASE_REF`, and asserts equality + presence in each file.
3. Sanity-check the guard actually bites: temporarily change one copy's literal in
   your worktree, confirm the test FAILS, then revert. (Don't commit the temporary
   change — just confirm the guard is real, and say so in your report.)

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail when done.
- Test-only change. Do NOT modify `runner/src/main.ts` or
  `src/oneshot/docker-git-node.ts` (no export change, no refactor) — the whole point
  is to guard the existing duplication, not eliminate it (the gateway can't import the
  runner package). Do NOT import either module in the test.
- No `any`, no `@ts-ignore`. NodeNext ESM (`.js` import specifiers for any real
  imports; `node:fs`/`node:path`/`node:url` as needed).
- Don't add dependencies. Don't commit. Don't edit this spec file.

## Out of scope

- Adding a similar guard for `protocol.ts` byte-identity (separate concern; not this
  issue).
- De-duplicating the literal / a shared constants module (the gateway↔runner boundary
  forbids a shared import; the guard is the accepted approach).

## When done — report precisely (with REAL command output)

- What changed (the new test file).
- The tail of `npm run gate` — test count + file count.
- Confirmation you verified the guard bites (drift → red), then reverted.
