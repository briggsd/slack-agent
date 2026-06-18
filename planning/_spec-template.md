# Task: <one-line imperative — what this slice delivers>

<!--
The spec format the m1/m2/m3 specs already use, extracted so every slice starts
from the proven shape. Delete these comments. Keep it tight: a spec is a contract,
not an essay. Fill every section; "N/A" is a valid answer for some.
-->

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md`
first** (gate, invariants, conventions), then the context below. You are on branch
`<feat/branch-name>`.

## Context — read before writing code

- Design intent: `design/<relevant note>` (the *why*) and the M-milestone in
  `planning/ARCHITECTURE.md` (the *when*).
- Code this builds on: `<list the 3–6 files and what each does>`.
- Motivating need / bug, if any: `<one or two sentences>`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure — implement end to
end in this run.

<!-- Include this block ONLY when the slice calls an external/unfamiliar API
(e.g. the Agent SDK, a Slack method you haven't used):

## CRITICAL — ground API usage, don't recall it

Read the relevant `.d.ts` / official docs before writing calls. Use only symbols
you can point to. If the real API differs from what you expected, follow the real
API and note the difference in your report.
-->

## Acceptance criteria

<!-- Numbered, directly testable, unambiguous. Each should map to a test or an
observable behavior. The gate passing is always #1. -->

1. `npm run check` passes (all existing tests keep passing, plus new ones).
2. `<behavior the slice must exhibit, stated so it's checkable>`
3. `<protocol/interface change, if any — name the exact files/types>`
4. `<new tests: what they cover and which seam/fake they use>`

## Hard constraints (do NOT violate)

- The gate (`npm run check`) must pass; paste the tail of its output when done.
- Conventions per root `CLAUDE.md`: no `any`, no `@ts-ignore`; `NodeNext` ESM;
  inject external dependencies (don't reach for the real world in tests).
- If touching `protocol.ts`, edit **both** copies identically
  (`src/runner/protocol.ts` ≡ `runner/src/protocol.ts`).
- Never log message contents or tokens.
- Add dependencies only with strong justification.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build)

- `<adjacent work that belongs to a later slice — name it and the milestone>`

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run check` output (real, not paraphrased).
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (or couldn't).
