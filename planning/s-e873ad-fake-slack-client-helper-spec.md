# Task: Move FakeSlackClient out of responder.test.ts into a shared fake so importers stop re-running responder's suite

You are implementing one small, mechanical slice in
`/Users/jedanner/workspace/slack-agent` (this is a worktree of it; TypeScript,
Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**, then the
context below. You are on branch `haiku/test-fake-slack-client`.

## Why (context — read before writing code)

`FakeSlackClient` is defined AND exported in `test/responder.test.ts` (a `.test.ts`
file with its own `describe` blocks). Six other test files import it from
`'./responder.test.js'`, which makes vitest load `responder.test.ts` and re-run its
three `describe` blocks (`responder`, `boundSlackText`, `updatePlaceholder`) once per
importer — inflating the suite/test counts (the same suite runs ~6× extra).

Fix: move the fake into a non-`.test.ts` shared file, matching this repo's existing
fake convention, and update the importers. The fakes here live in `src/<area>/fake*`
(e.g. `FakeBroker` → `src/broker/fake.ts`, `FakeRunner` → `src/runner/fake.ts`,
`FakeCloneService` → `src/runner/fake-clone-service.ts`). `FakeSlackClient` fakes
`SlackClientLike` from `src/slack/responder.ts`, so its home is
**`src/slack/fake-slack-client.ts`**.

### Grounded facts (verified at `5265956`)

- **Definition**: `test/responder.test.ts:6-42` — `export class FakeSlackClient
  implements SlackClientLike { ... }` (records posts/updates/uploads; `uploadError`
  hook; `postMessage`/`update`/`uploadFile`). Preceded by a `/** Fake Slack client
  that records all calls */` comment at line 5. The `describe` blocks start at line 44.
- `SlackClientLike` is imported in `responder.test.ts:2` via
  `import type { SlackClientLike } from '../src/slack/responder.js';`.
- **Importers** (all currently `from './responder.test.js'`):
  - Static: `test/store.test.ts:18`, `test/listener.test.ts:7`,
    `test/manager.test.ts:28`, `test/build-engine.test.ts:27`, `test/docker.test.ts:16`
    — `import { FakeSlackClient } from './responder.test.js';`
  - Dynamic: `test/profiles.test.ts:86` and `:108` —
    `const { FakeSlackClient } = await import('./responder.test.js');`
  - And `responder.test.ts` itself uses the class in its own tests.

## CRITICAL — do not stop after exploration

Make the edits, run `npm run gate`, fix failures, then stop. Zero file changes is a
failure.

## Implementation — exact mechanical move

1. **Create `src/slack/fake-slack-client.ts`** containing the `FakeSlackClient`
   class verbatim from `responder.test.ts:5-42` (the comment + the class), with the
   import at top:
   ```ts
   import type { SlackClientLike } from './responder.js';
   ```
   (Note the relative path is `./responder.js` from inside `src/slack/`.) Keep the
   `export` on the class. No behavior change.

2. **`test/responder.test.ts`**: delete the class definition (lines 5-42) and add an
   import for it instead:
   ```ts
   import { FakeSlackClient } from '../src/slack/fake-slack-client.js';
   ```
   Leave the file's own `describe` blocks and its other imports unchanged. It still
   uses `FakeSlackClient` in its tests (now via the import).

3. **Update the 5 static importers** — change the specifier from
   `'./responder.test.js'` to `'../src/slack/fake-slack-client.js'` in:
   `test/store.test.ts`, `test/listener.test.ts`, `test/manager.test.ts`,
   `test/build-engine.test.ts`, `test/docker.test.ts`.

4. **Update `test/profiles.test.ts`** — change both dynamic imports (lines 86, 108)
   from `await import('./responder.test.js')` to
   `await import('../src/slack/fake-slack-client.js')`.

5. Grep to confirm NO remaining reference to `FakeSlackClient` via
   `'./responder.test.js'` anywhere.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`. (Fakes already live in `src/` here — `boundaries` allows it;
   confirm it stays green.)
2. `FakeSlackClient` is defined in `src/slack/fake-slack-client.ts` and nowhere else;
   no file imports it from `'./responder.test.js'`.
3. **Suite/test counts drop**: the responder `describe` blocks no longer re-run per
   importer. Note the new totals from the gate output in your report (they should be
   LOWER than the pre-change `813 tests / 53 files` because the duplicated runs are
   gone). This is the observable proof the fix worked.

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail when done.
- Test-only / fake-only change — do NOT alter `src/slack/responder.ts` or any
  production behavior, and do NOT change `FakeSlackClient`'s implementation (just
  relocate it). No `any`, no `@ts-ignore`. NodeNext ESM (`.js` import specifiers).
- Don't add dependencies. Don't commit. Don't edit this spec file.

## Out of scope

- Renaming the fake or changing its API; touching any other fake; deduping other
  test cross-imports.

## When done — report precisely (with REAL command output)

- File-by-file summary (one line each).
- The tail of `npm run gate` — the NEW test count + file count (and call out the drop
  vs 813/53).
- Confirm no `FakeSlackClient` import from `'./responder.test.js'` remains.
