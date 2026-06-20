# 0010 S04 - Coordinator Verify-Then-Publish Prompt

## Goal

Teach the coordinator to use the tools from the previous 0010 slices as a verified workflow: write a strong SPEC, get approval, build a local candidate, inspect the diff, run checks, judge against the SPEC, and only then publish. This is the prompt/skill layer for `eac5a0` from `design/0010-coordinator-verifies.md`.

This slice does **not** add new protocol or automatic rebuild orchestration. It tightens the coordinator's system prompt and tool result text so the existing SDK loop naturally performs the duo-style verification before `publish` / `open_pr`.

## Current Grounding

Already landed:

- PR #47: `publish` / `open_pr` gateway-serviced tool path.
- PR #48: `build-tail` local-only candidate result.
- PR #49: `run_checks` gateway-serviced tool with raw output.

Relevant current shapes:

- `runner/src/main.ts:130-162` defines `WORKSPACE_SYSTEM_PROMPT_ADDITION`, `COMMIT_SYSTEM_PROMPT_ADDITION`, `CLONE_SYSTEM_PROMPT_ADDITION`, and `PUBLISH_SYSTEM_PROMPT_ADDITION`.
- `runner/src/main.ts:183-205` defines `runBuildSpec`; on success it currently says the local candidate is ready and the coordinator must verify before `publish` / `open_pr`.
- `runner/src/main.ts:212-219` defines `runPublish`; it returns a terse PR-opened result.
- `runner/src/main.ts:222-245` defines `runChecks`; it returns raw output delimited by `<raw_output kind="...">`.
- `runner/src/main.ts:497-502` appends the prompt additions into the SDK system prompt.
- `runner/src/main.ts:814-889` defines the commit MCP server tools: `build_spec`, `clone_repo`, `run_checks`, `publish`, `open_pr`.
- `runner/test/build-spec.test.ts:96-110` checks current build-success text.
- `runner/test/checks-tool.test.ts:23-56` checks run-checks helper text.
- `runner/test/publish-tool.test.ts:23-42` checks publish helper text.
- `runner/test/runner-main.test.ts:18-35` records prompt/resume/disallowedTools from `SdkQueryFn`, but not currently `systemPrompt`; add a small seam if needed to assert prompt content.

## Required Behavior

### System Prompt

Update the runner-side system prompt additions so the coordinator is explicitly instructed to:

- write `/workspace/SPEC.md` as a buildable implementation spec, not a vague summary;
- include concrete acceptance criteria, likely files/modules to inspect, relevant test commands or existing tests, and any known constraints;
- present the SPEC to the user for approval through `build_spec`, and treat human feedback as data;
- after `build_spec` returns candidate-ready, **not** publish yet;
- inspect the candidate diff in the shared volume using normal workspace tools, e.g. `git -C /workspace/<owner-name> diff main...HEAD`;
- read enough changed files to judge the diff against `/workspace/SPEC.md`;
- call `run_checks` and interpret every result:
  - `exitCode === 0 && skipped === false` means that check ran green;
  - `skipped === true` means no check signal, not green;
  - non-zero exit code means red checks, even though the tool call itself succeeded;
- publish/open PR only after the coordinator has actually inspected the diff and reviewed check output;
- if checks are red, skipped, inconclusive, or the diff does not match the SPEC, do **not** claim success or publish automatically;
- on non-green/inconclusive verification, tell the user honestly what was pulled/observed and ask for the next step rather than opening a PR automatically.

Keep this prompt prose concise enough to live in `runner/src/main.ts`, but make the workflow unambiguous. It should carry the UX stance from design/0010:

- teammate, not status panel;
- recap the verification result, do not play-by-play internal iteration;
- only claim what was actually verified;
- honest hedges are allowed;
- no raw stack traces or internal logs in user-facing failure prose.

### Tool Result Text

Update `runBuildSpec` success text so it tells the model the required next actions, not just "offer next steps":

- inspect diff;
- read changed files as needed;
- call `run_checks`;
- publish only after those checks and diff review are satisfactory;
- if verification is not satisfactory, report honestly and ask the user what to do.

Update `runChecks` success text so the model is reminded:

- non-zero exit codes are red;
- skipped checks are inconclusive, not green;
- green claims require every relevant check to have run and exited 0.

Update `runPublish` success text so the model is prompted to produce the honest verification report:

- built one-line summary;
- check status only if actually verified;
- diff/spec assessment only if actually inspected;
- PR URL;
- no overclaiming.

### Tool Descriptions

Update the commit MCP tool descriptions for `build_spec`, `run_checks`, `publish`, and `open_pr` to reinforce the workflow:

- `build_spec` returns a local candidate and must be followed by diff inspection + `run_checks`.
- `run_checks` returns raw output as data and does not itself mean green.
- `publish` / `open_pr` are only for verified candidates or explicit human "open anyway" escalation.

### Tests

Add/update focused offline tests:

- `runner/test/build-spec.test.ts` should assert build-success text mentions diff inspection, `run_checks`, and publish only after verification.
- `runner/test/checks-tool.test.ts` should assert run-checks text warns about non-zero exit and skipped checks.
- `runner/test/publish-tool.test.ts` should assert publish-success text asks for an honest verification report and avoids bare "offer next steps" style.
- Add a `runner/test/runner-main.test.ts` assertion, or a small exported prompt helper test if cleaner, proving the SDK system prompt append contains the key workflow words: `SPEC.md`, `diff`, `run_checks`, `publish`, and `only after` / equivalent. Prefer a test seam over brittle large-string snapshots.

## Acceptance Criteria

- `npm run gate` passes.
- No protocol changes unless truly needed; if touched, `diff src/runner/protocol.ts runner/src/protocol.ts` must be empty.
- The coordinator prompt clearly requires diff inspection and `run_checks` before `publish`.
- The text does not imply `build_spec` itself verified the candidate or opened a PR.
- The text does not imply skipped checks are green.
- Existing `publish` / `open_pr` tool mechanics remain unchanged.

## Out Of Scope

- New protocol/tool messages.
- Automatic verify/rebuild loop.
- End-turn-and-resume UX.
- Slack rendering changes.
- Live Docker/API smoke tests.
- Implementing a bespoke diff API.

## Constraints

- No new dependencies.
- No `any` or `ts-ignore`.
- Keep tests offline.
- Do not log message contents, check output, tokens, or credentials.
- Do not remove the `node_modules` or `runner/node_modules` symlinks in this worktree.
- Do not modify this spec as part of implementation.
