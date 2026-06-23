# Task: add a generic `serviceDispatch` helper and route the 6 service-call branches through it

You are implementing one slice in this worktree (TypeScript, Node 20+, ESM, vitest,
strict tsc). **Read the root `CLAUDE.md` and the gateway code first** (gate, invariants),
then the context below. You are on branch `sonnet/toolshed-s2-dispatch-helper`.

This is a **behavior-preserving refactor** of `src/runner/docker.ts`. No protocol change, no
runner-package (`runner/`) change, no new feature. Tracks `track e37dcd` (toolshed trim,
slice 2). Background: `docs/toolshed.md`.

## Context — the current state

In `src/runner/docker.ts`, the `send()` method's inner `async function* gen()` is a long
read loop. Inside it, **six branches share a near-identical skeleton** — they validate a
`request_*` line, call a gateway service, and write a `*_result` line back to the
container's stdin. They are (current approx. line ranges):

- `request_clone` (~459–509) → `clone_result`, `self.cloneService.clone`
- `request_publish` (~589–658) → `publish_result`, `self.publishService.publish`
- `request_pr_edit` (~659–713) → `pr_edit_result`, `self.publishService.editPr`
- `request_pr_comment` (~714–765) → `pr_comment_result`, `self.publishService.commentPr`
- `request_run_checks` (~766–817) → `run_checks_result`, `self.checkService.runChecks`
- `request_provision` (~818–~862) → `provision_result`, `self.runtimeProvisionService.provision`

**Do NOT touch** `request_build` and `request_exec` — they are a different style (they
`yield` `run_build`/`run_exec` to the manager and read back a resume via `next()`, they do
not call an injected service). Leave them exactly as they are. Also do not touch
`request_approval`, `request_clone`'s sibling control branches, or the malformed-JSON /
`protocol_skip` paths.

Each of the six branches does, in order:
1. `if (typeof parsed.id !== 'string') { console.error('[gateway] malformed <reqType>: missing id — skipping'); continue; }`
2. validate the route fields; on failure write a `{ ...id, ok:false, reason/error:'malformed request' }` fallback (guarded by `if (self.child.stdin?.writable)`) and `continue`
3. build the service-request DTO (using `self.volume ?? ''` where needed)
4. `yield { type:'status', text:'…' }` BEFORE the service call (so the user sees progress)
5. call the service if wired (`service !== undefined && self.volume !== undefined`), else an "unavailable" outcome; `publish`/`pr_edit`/`pr_comment` measure elapsed via `self.now()`
6. `if (!self.child.stdin?.writable) { yield self.errorEvent('runner stdin is not writable', 'runner_error'); return; }`
7. write the `*_result` line (ok vs fail — tool-specific fields)
8. some `yield` a success event: `publish`→`pr_opened`, `pr_edit`→`pr_edited`, `pr_comment`→`pr_commented` (clone/checks/provision yield none)
9. `deadline = Date.now() + turnTimeoutMs; continue;`

## CRITICAL — do not stop after exploration

Do NOT pause or yield until the refactor is done AND `npm run gate` passes. Make every edit,
run the gate, fix failures, then stop. Zero-file-change yield is a failure.

## CRITICAL — behavior must be identical

Every `docker-*.test.ts` round-trip test (`docker-clone`, `docker-publish`,
`docker-edit-comment-pr`, `docker-run-checks`, `docker-provision-runtime`, `docker.test.ts`)
must pass **UNCHANGED**. Do not edit them to force a pass — a failure means the refactor
changed behavior. Preserve verbatim: the status text strings (including the exact trailing
`…` vs `...`), the result field names, the success-event shapes and fields, the
unavailable-outcome reasons, the malformed-fallback shapes, and the timing measurement (only
where it exists today).

## The change

### 1. Add a private generator method `serviceDispatch` on `DockerRunner`

Place it near `errorEvent` (it is a method, so it uses `this`, not `self`). Implement it
**exactly** as below. The generator's yield/next/return types must be
`AsyncGenerator<RunnerEvent, 'ok' | 'fatal', GateResume | BuildOutcome | ExecOutcome | undefined>`
so `yield*` from `gen()` type-checks (the next-type must match `RunnerStream`'s).

```ts
private async *serviceDispatch<TReq, TOutcome>(
  parsed: RunnerToGatewayMessage,
  spec: {
    /** e.g. 'request_pr_edit' — used only for the id-missing log line. */
    requestType: string;
    /** Validate the line and build the service DTO, or return null if malformed. */
    validate: (p: RunnerToGatewayMessage) => TReq | null;
    /** User-facing progress line, yielded before the service call. */
    statusText: (req: TReq) => string;
    /** Perform the privileged work. MUST itself return the unavailable outcome when the
     *  service (or volume) is not wired — availability is handled here, not by the helper. */
    invoke: (req: TReq) => Promise<TOutcome>;
    /** Build the *_result line for a completed outcome. */
    toResult: (id: string, outcome: TOutcome) => GatewayToRunnerMessage;
    /** Build the malformed-request fallback *_result line. */
    malformedResult: (id: string) => GatewayToRunnerMessage;
    /** Optional success event (pr_opened/pr_edited/pr_commented). elapsedMs is the
     *  measured service wall-clock. Return null for no event. */
    toEvent?: (outcome: TOutcome, elapsedMs: number) => RunnerEvent | null;
  },
): AsyncGenerator<RunnerEvent, 'ok' | 'fatal', GateResume | BuildOutcome | ExecOutcome | undefined> {
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== 'string') {
    console.error(`[gateway] malformed ${spec.requestType}: missing id — skipping`);
    return 'ok';
  }
  const req = spec.validate(parsed);
  if (req === null) {
    if (this.child.stdin?.writable) {
      this.child.stdin.write(JSON.stringify(spec.malformedResult(id)) + '\n');
    }
    return 'ok';
  }
  yield { type: 'status', text: spec.statusText(req) } as RunnerEvent;
  const start = this.now();
  const outcome = await spec.invoke(req);
  const elapsedMs = this.now() - start;
  if (!this.child.stdin?.writable) {
    yield this.errorEvent('runner stdin is not writable', 'runner_error');
    return 'fatal';
  }
  this.child.stdin.write(JSON.stringify(spec.toResult(id, outcome)) + '\n');
  const event = spec.toEvent?.(outcome, elapsedMs);
  if (event !== null && event !== undefined) {
    yield event;
  }
  return 'ok';
}
```

Notes:
- Always measuring `elapsedMs` is safe: clone/checks/provision have no `toEvent`, so the
  value is simply unused for them (observable behavior unchanged).
- `invoke` owns the availability check, which avoids non-null assertions. See the per-tool
  closures below — each captures the service and returns the exact current unavailable
  outcome when unwired.

### 2. Replace each of the 6 branches with a call

Each branch body becomes:

```ts
} else if (parsed.type === 'request_pr_edit') {
  const verdict = yield* self.serviceDispatch<PrEditServiceRequest, PrEditOutcome>(parsed, {
    requestType: 'request_pr_edit',
    validate: (p) => { /* the branch's current field validation; return DTO or null */ },
    statusText: (req) => `editing PR for ${req.repo}…`,
    invoke: (req) =>
      self.publishService !== undefined && self.volume !== undefined
        ? self.publishService.editPr(req)
        : Promise.resolve({ ok: false, reason: 'edit unavailable' } as PrEditOutcome),
    toResult: (id, outcome) => outcome.ok
      ? { type: 'pr_edit_result', id, ok: true }
      : { type: 'pr_edit_result', id, ok: false, reason: outcome.reason },
    malformedResult: (id) => ({ type: 'pr_edit_result', id, ok: false, reason: 'malformed request' }),
    toEvent: (outcome, elapsedMs) => outcome.ok
      ? ({ type: 'pr_edited', url: outcome.prUrl, elapsedMs } as RunnerEvent)
      : null,
  });
  if (verdict === 'fatal') return;
  deadline = Date.now() + turnTimeoutMs;
  continue;
}
```

Use `self.` (the `gen()` closure's alias) when building each config, since the services and
`self.volume` live on `self`. The `yield*` delegates to the method; inside the method `this`
is the same instance.

Port each branch faithfully, preserving its specifics:
- **clone** (`CloneOutcome`, `CloneService`): validate `parsed.repo` is string; DTO
  `{ repo, volume: self.volume }` (note: clone passes `self.volume` directly, only when
  available — keep the current guard inside `invoke`); statusText `\`cloning ${req.repo}…\``;
  invoke uses `self.cloneService.clone({ repo: req.repo, volume: self.volume })` when
  `self.cloneService !== undefined && self.volume !== undefined`, else
  `{ ok: false, error: 'clone unavailable' }`; toResult ok→`{type:'clone_result',id,ok:true,workdir:outcome.workdir}`,
  fail→`{...ok:false,error:outcome.error}`; malformed→`{...ok:false,error:'malformed request'}`;
  no toEvent. (Clone's DTO needs `volume: string`; build it inside `invoke` from `self.volume`
  to keep the validate step pure — your call, as long as behavior matches.)
- **publish** (`PublishOutcome`, `PublishServiceRequest`): validate `parsed.repo` string and
  optional `title`/`body`/`correlationId` are string-or-undefined (reject otherwise); DTO
  `{ repo, volume: self.volume ?? '', ...title, ...body }`; **capture `correlationId`** from
  `parsed` in the branch and reference it in `toEvent`; statusText `\`publishing ${req.repo}…\``;
  toResult ok→`{...ok:true,prUrl:outcome.prUrl}` fail→`{...ok:false,reason}`; toEvent ok→
  `{ type:'pr_opened', url:outcome.prUrl, repo:req.repo, number:outcome.prNumber, headSha:outcome.headSha, elapsedMs, ...(correlationId!==undefined?{correlationId}:{}) }`.
- **pr_edit** — as shown above.
- **pr_comment** (`PrCommentOutcome`, `PrCommentServiceRequest`): validate `parsed.repo`
  string AND `comment` is a non-empty (trimmed) string; DTO `{ repo, volume: self.volume ?? '', comment }`;
  statusText `\`commenting on PR for ${req.repo}…\``; toResult ok→`{...ok:true}` fail→`{...ok:false,reason}`;
  toEvent ok→`{ type:'pr_commented', url:outcome.prUrl, elapsedMs }`.
- **run_checks** (`CheckOutcome`, `CheckServiceRequest`): validate `parsed.repo` string AND
  `SAFE_OWNER_REPO_SLUG.test(parsed.repo)` AND `kind` in `{undefined,'lint','test','all'}`;
  DTO `{ repo, volume: self.volume ?? '', kind: kind ?? 'all' }`; statusText
  `\`running checks for ${req.repo}...\`` (NOTE: three dots, not `…`); toResult ok→
  `{...ok:true,results:outcome.results}` fail→`{...ok:false,reason}`; no toEvent.
- **provision** (`ProvisionOutcome`, `RuntimeProvisionRequest`): validate `parsed.name`
  string; DTO `{ name, volume: self.volume ?? '' }`; statusText
  `\`provisioning runtime ${req.name}...\`` (three dots); toResult ok→`{...ok:true}` fail→
  `{...ok:false,error:outcome.error}`; malformed→`{...ok:false,error:'malformed request'}`;
  no toEvent.

The outcome types (`PublishOutcome`, `PrEditOutcome`, `PrCommentOutcome`, `CloneOutcome`,
`CheckOutcome`, `ProvisionOutcome`) and request DTO types are the **gateway-side** ones
already imported in `docker.ts` (from `src/runner/*-service.ts`) — note `PrCommentOutcome`
here carries `prUrl` on success (unlike the runner-package copy).

## Acceptance criteria

1. `npm run gate` passes; existing test count does not drop; no `docker-*.test.ts` file is
   edited.
2. `serviceDispatch` exists as specified and the 6 branches route through it; `build`/`exec`/
   `approval` branches are unchanged.
3. No change under `runner/`, no change to either `protocol.ts` copy, no service-interface or
   manager change.
4. Net line reduction in `docker.ts` (the six branches shrink).

## Tests

- The six `docker-*.test.ts` round-trip suites are the regression net; they must pass
  unchanged. Run them first to confirm green before and after.
- **ADD** a focused test (extend `test/docker.test.ts` or a new `test/docker-dispatch.test.ts`)
  for the helper's shared behavior that the per-tool suites don't all cover:
  (a) a service-call request whose line is missing `id` is logged and skipped with NO result
      written and the loop continues (use any of the six types, e.g. `request_provision`);
  (b) when a service result arrives but `child.stdin` is not writable at write time, the run
      yields a `runner_error` error event and ends (the `'fatal'` path). Mirror the harness in
      `test/docker-edit-comment-pr.test.ts` (FakeChildProcess + FakePublishService).

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the **real tail** (pass/fail counts) + `git diff --stat`.
- No `any`, no `@ts-ignore`, no non-null `!` assertions (the `invoke` closures make them
  unnecessary). `NodeNext` ESM; honor `exactOptionalPropertyTypes` (build optional fields
  with `...(x !== undefined ? { x } : {})`, never assign `undefined`).
- Never log message content or tokens (the id-missing log carries only the request type).
- Do NOT touch `protocol.ts` (either copy), `runner/`, the `build`/`exec`/`approval` branches,
  or any service interface.
- Do NOT edit existing tests to force a pass. Do NOT commit. Do NOT `git add -A`. (The spec
  file is already committed as the branch's first commit.)

## Out of scope

- `read_issue` (slice 3) and any new tool.
- Folding `build`/`exec` into the helper (different dispatch style).
- Any registry / profile-selection work (0018 Layer 2).

## When done — report precisely (with REAL command output)

- File-by-file summary (one line each).
- Real tail of `npm run gate` (pass/fail counts) + `git diff --stat` (show the docker.ts
  line delta).
- Confirm no `docker-*.test.ts` existing file was modified; state old vs new test count.
- Any deviation from this spec and why.
