# Error model

This document covers how errors move through the system, why message bodies are kept out of logs, the `RunnerErrorClass` table, how to diagnose a live failure, and the `msg_too_long` case (a Slack limit, now handled).

## Flow

Most errors originate inside the container (the Agent SDK throws), and the path looks like this:

1. **SDK throws** inside `runner/src/main.ts` — typically an `APIError` from the Anthropic SDK, an `AbortError` on cancellation, or any other JS exception.
2. **Runner catch** (`runner/src/main.ts` — the `processTurn` outer catch) calls `safeErrorDetail(err)` to extract content-free metadata, logs it to stderr, then emits an `ErrorMessage` (`type: 'error'`) on stdout with the original `message` and the derived `errorClass`.
3. **Protocol** (`src/runner/protocol.ts` / `runner/src/protocol.ts`) — `ErrorMessage` carries `{ type, id, message, errorClass? }`. The gateway receives this as NDJSON over the container's stdout.
4. **Gateway relay** (`src/sessions/manager.ts`, the runner-error branch inside `driveToThread`) — validates `errorClass` with `isRunnerErrorClass`, logs only the class, audits the typed reason, and posts `:x: Error: <message>` to the user's Slack thread.
5. **Gateway catch** (`src/sessions/manager.ts`, the outer `drain` catch) fires when the drive loop itself throws — for example, if the runner process exits unexpectedly before emitting a result. It logs safe structured metadata (name, status, type, first stack frame) and posts `:x: Unexpected error: <message>`.

Errors that come from the gateway's own work (timeouts, container exits) take the same runner-error relay path, but their `reason` (`timeout`, `container_exit`) is gateway-assigned and their `message` is gateway-generated, so both are safe to log.

## Redaction discipline

Error **message bodies are never logged or audited**. A message body can echo prompt text, tool output, or file content — all of it untrusted. The only exception is the user's own Slack thread, where the message is already visible to them.

`errorClass` and structured metadata (`name`, `status`, `type`, `code`, first stack frame) are content-free and safe for logs and the audit ledger.

This rule is encoded in the `RunnerErrorClass` comment in `protocol.ts` and enforced in `manager.ts` in both the runner-error relay branch (`reason === 'runner_error'` redacts the message, keeps the class) and the gateway `drain` catch. The `safeErrorDetail` helper in `runner/src/main.ts` and the `gatewayErrorMeta` function in `manager.ts` both produce metadata strings that contain no message body. (References here are by symbol rather than line number, which drifts.)

## `RunnerErrorClass` table

| Value | Assigned by | Meaning |
|---|---|---|
| `max_turns` | `classifyResultError` | SDK result `error_max_turns` |
| `budget_exceeded` | `classifyResultError` | SDK result `error_max_budget_usd` |
| `output_retries` | `classifyResultError` | SDK result `error_max_structured_output_retries` |
| `execution_error` | `classifyResultError` | SDK result `error_during_execution` (and any unrecognised result subtype) |
| `no_result` | runner emit site | The SDK stream ended without a result event |
| `aborted` | `safeErrorDetail` | `err instanceof AbortError` in the runner outer catch |
| `malformed_input` | runner parse site | An input line could not be parsed as a valid `UserMessage` |
| `api_error` | `safeErrorDetail` | A thrown error that carries `status` (HTTP) or `type`/`error.type` (API error type) — the Anthropic SDK error shape, possibly wrapped so the original lands on `err.cause` |
| `unknown` | `safeErrorDetail` | Any other thrown error that does not match the above |

`isRunnerErrorClass(x)` validates a wire value against this set; the gateway drops unrecognised values to `undefined`.

## Diagnosing a live error

When a turn fails, look for these log lines in the gateway process:

**Runner-originated error** (class 3 above — emitted from inside the container, relayed by the gateway):

```
[runner] turn error: class=api_error name=APIError status=400 type=invalid_request_error
[session] turn error (runner_error) TEAM:C:THREADTS: api_error
```

The first line is from the runner's `log()` helper (stderr of the container process, prefixed by the gateway). The second is from the gateway relay. `api_error` tells you to look at `status` and `type` in the runner log for the specific API condition.

**Gateway-originated error** (class 5 above — the drive loop threw before the runner could emit):

```
[session] error processing message in TEAM:C:THREADTS: name=APIError status=400 type=invalid_request_error @ at Object.<anonymous> (...)
```

This log line now includes the first stack frame so you can locate where the exception originated.

To read the full in-container SDK transcript from a session volume, use `scripts/peek-session.mjs` (introduced in commit `bcbd77`).

## `msg_too_long` — resolved

`msg_too_long` is a Slack error, not Anthropic. Slack rejects any `chat.update` or `chat.postMessage` call whose text exceeds 40,000 characters. The throw origin — `platformErrorFromResult` in `@slack/web-api` — confirmed this via the #89 instrumentation. The earlier theory about a context-window overflow on `claude-opus-4-8` was wrong.

Three changes close the issue:

- `SLACK_TEXT_LIMIT` is now `39000` (down from `40000`), keeping all posts safely under Slack's edge.
- The gateway drain catch calls `isSlackMsgTooLong` and posts `:x: That response was too long to post in Slack — try a narrower question.` instead of the generic unexpected-error message.
- `gatewayErrorMeta` now includes `code` and `slackCode` fields from a `WebAPIPlatformError`, so the structured log line identifies the Slack error code without touching the message body.
