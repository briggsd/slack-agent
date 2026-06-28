# Task: Nudge the in-container agent to delegate repo survey to subagents (keep context lean)

You are implementing one small slice in `/Users/jedanner/workspace/slack-agent`
(this is a worktree of it; TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the
root `CLAUDE.md` and `runner/CLAUDE.md` first**, then the context below. You are on
branch `sonnet/subagent-survey-nudge`.

## Why (context — read before writing code)

In a live review, the in-container agent did a whole investigation with flat
`Bash`/`Read`/`Grep`, reading large chunks of a cloned repo into one context →
context bloat → a long model turn. The `Task` (subagent) tool is already available
(only `AskUserQuestion` is denied, `runner/src/main.ts:186`), the agent just didn't
use it. This slice adds a **system-prompt nudge** to delegate broad repo exploration
to subagents during reviews, keeping the agent's own context lean (shorter, cheaper
turns). It is **prompt-only** — no tool/structure change, advisory not mandatory.

### Grounded facts (verified at `844f408`)

- The runner builds the SDK system prompt as `{ type: 'preset', preset:
  'claude_code', append: ... }` (`runner/src/main.ts:~931-938`). The `append` string
  concatenates six addition constants with `\n\n`
  (`WORKSPACE_/COMMIT_/CLONE_/PUBLISH_/EXEC_/RUNTIME_SYSTEM_PROMPT_ADDITION`), defined
  at `:200,210,224,234,251,258`. Each is a concise, imperative single concatenated
  string. The append site is `:937`.
- Existing additions are the precedent for style: short, concrete, imperative.

## CRITICAL — do not stop after exploration

Make the edits, run `npm run gate`, fix failures, then stop.

## Implementation

### 1. New addition constant (use this exact text — it's human-prose-reviewed)

Add, right after `RUNTIME_SYSTEM_PROMPT_ADDITION` (after `:262`):

```ts
const SUBAGENT_SYSTEM_PROMPT_ADDITION =
  'For broad investigation of a large cloned repo — mapping its structure, finding ' +
  'every caller of a symbol, or learning how something is tested — prefer delegating ' +
  'to a subagent (the Task tool) and working from its summary, rather than reading ' +
  'many files into this conversation yourself. That keeps your own context lean, ' +
  'which keeps turns fast. Use Grep/Glob/Read directly for targeted, surgical ' +
  'lookups where a subagent would only add overhead.';
```

Do not reword it (it's deliberately tell-free prose). Place it among the other
addition consts, matching their formatting.

### 2. Append it to the system prompt

At the `append:` concatenation (`:937`), add `\n\n${SUBAGENT_SYSTEM_PROMPT_ADDITION}`
to the END of the template string (after `${RUNTIME_SYSTEM_PROMPT_ADDITION}`). Keep
the `\n\n` separator pattern identical to the others.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`.
2. The appended system prompt includes the new subagent guidance. Add (or extend) a
   test that captures the `sdkQuery` params via the existing `FakeAgentSdk` and
   asserts the appended `systemPrompt` (`options.systemPrompt.append`) contains a
   stable substring of the new text (e.g. `'delegating'` + `'subagent (the Task
   tool)'`). Check `runner/test/runner-main.test.ts` and
   `runner/test/runner-heartbeat.test.ts` first — if a test already inspects
   `options` (the heartbeat test asserts `includePartialMessages`), extend that
   pattern; otherwise add a small focused test. Do NOT assert the entire prompt
   string (brittle) — assert a substring.

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail when done.
- Prompt-only change to `runner/src/main.ts` (one new const + one append). Do NOT
  touch `protocol.ts`, the gateway, tool config (`DISALLOWED_TOOLS`), or anything
  else. Do NOT reword the supplied text.
- No `any`, no `@ts-ignore`. NodeNext ESM.
- Don't add dependencies. Don't commit. Don't edit this spec file.

## Out of scope

- Forcing subagent use, changing the tool allow/deny list, or any heartbeat/timeout
  work (89ab70, already shipped). This is advisory guidance only.

## When done — report precisely (with REAL command output)

- What changed (the const + the append).
- The tail of `npm run gate` — test count + file count.
- Which test asserts the new guidance is in the appended prompt.
- Any deviation from this spec and why.
