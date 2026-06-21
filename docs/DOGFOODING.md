# Dogfooding slack-agent on slack-agent

Using the bot to do real work on its own codebase is the most direct source of the
signal the M7 flywheel needs — real specs, real PRs, real merge-or-intervene
outcomes (`design/0015` acceptance metric, `0016` circuit breaker, `3be6d6`
feedback telemetry). And the people building it are the sharpest possible users:
they know what a good spec and a correct diff look like, and they feel the friction
where it actually hurts.

But dogfooding *this* repo is not the same as the stress-tests on
`slack-agent-test`. There the worst case is a junk PR on a throwaway repo. Here the
agent would be modifying **the trusted host that spawns and contains it** — the
gateway that talks to Slack, owns session bookkeeping, and is the permission
boundary for every sandbox. A bad merge to that core doesn't just produce a bad
PR; it can break the process running the agent, or quietly widen the sandbox the
agent is confined by. The blast radius includes the harness.

So dogfooding is gated by **what** work it covers, not turned on wholesale. Three
tiers, by blast radius.

## The tiers

**Tier 1 — leaf work. Enabled.** Changes that cannot touch the permission boundary
or the gateway's trusted core: docs, planning specs, the research briefs, test
additions, the `scripts/` smoke harnesses, self-contained utilities. A bad PR here
is caught by the gate and human review, and even if merged it can't break the host.
This is where dogfooding earns its keep with almost no downside.

**Tier 2 — bounded feature slices. Behind the approval gate.** Well-scoped backlog
items (e.g. `5e9ee3` edit_pr/comment_pr, `113749` the DIFF_BASE_REF guard) built
through the **supervised profile + `build_spec` approval gate**: a human reads the
SPEC before the build and the diff before the merge, and CI's review factory is a
second net. The approval gate is the control that makes this safe; don't run Tier-2
work on an unsupervised profile.

**Tier 3 — the trusted core. Human-driven.** The session manager, the permission
boundary, `protocol.ts`, the broker, the Bolt wiring in `index.ts`. This is
self-modification of the containing host, and it stays a human job until the tool
has a long, boring track record on Tiers 1 and 2.

A PR's tier is the *highest-risk file it touches*, not its line count. A one-line
change to `protocol.ts` is Tier 3.

## Two prerequisites that bite here specifically

**The agent's checks must run the full gate, not just vitest.** `run_checks`
auto-detects from `package.json`, and this repo's `test` script is plain vitest —
which skips `tsc`, the runner typecheck, and `boundaries`, exactly where the
load-bearing invariants live. So a dogfooding session must run `npm run gate` as its
check, set per-repo via `ONESHOT_CHECK_CMDS` (below). Forget this and the agent's
PRs pass *its* checks while failing the invariants that define the codebase. This is
enforced at startup — see the guardrail.

**The sandbox can't run the live smokes.** The container has no Docker-in-Docker and
no root, so it runs `tsc`/`vitest`/`boundaries` fine but cannot run the real
Docker-based smokes (like the `provision_runtime` smoke in `smoke-testing` memory).
Any gateway, runtime, or protocol change still needs a human smoke pass before merge.
This caps how much Tier-2/3 work self-dogfooding can finish on its own, and it's a
hard reason the trusted core stays human-driven.

## Enabling Tier 1

The dogfooding knobs are env, operator-controlled — deliberately not committed, so
turning this on is an explicit deploy decision, not a repo default.

```sh
# Add the self-repo to the clone allowlist (alongside whatever else is allowed).
CLONE_REPO_ALLOWLIST=briggsd/slack-agent-test,briggsd/slack-agent

# Make the self-repo's checks the FULL gate, not the default vitest-only run.
ONESHOT_CHECK_CMDS={"briggsd/slack-agent":{"test":"npm run gate"}}
```

The broker's GitHub PAT also needs Pull-requests read/write on `briggsd/slack-agent`
(Contents read for clone). Keep Tier-1/2 dogfooding to a dedicated Slack channel
bound to the supervised profile, so unsupervised conversational sessions can't reach
the self-repo.

## The startup guardrail

`assertDogfoodGate` runs at config load: **if `briggsd/slack-agent` is in the clone
allowlist, its `ONESHOT_CHECK_CMDS` entry must run `npm run gate`** — otherwise
startup fails loud, naming this file. The point is that the full-gate prerequisite
can't be silently dropped: you can't enable dogfooding with a check command too weak
to enforce the invariants. The match is an exact literal string — the `test` command
must be precisely `npm run gate`, so a functionally-equivalent spelling (e.g.
`npm run check && npm run boundaries`, or a stray trailing space) still trips it; use
the literal recipe above. Removing the self-repo from the allowlist turns dogfooding
off and the guardrail goes quiet.
