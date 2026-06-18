/**
 * Architecture-boundary rules. These mechanize the load-bearing invariants from the root
 * CLAUDE.md and docs/ARCHITECTURE.md so they're enforced, not just documented. Every rule
 * carries a remediation message so an agent (or human) can self-correct from the error
 * output alone.
 *
 * Run: `npm run boundaries` (a separate CI step; deliberately NOT folded into
 * `npm run check`, which stays exactly tsc + runner check + vitest).
 */
module.exports = {
  forbidden: [
    {
      name: "bolt-only-in-index",
      severity: "error",
      comment:
        "@slack/bolt may be imported only by src/index.ts. Every other module takes a minimal " +
        "injected interface (SlackClientLike, an injectable spawn, etc.) so it stays testable " +
        "without Slack. Move the Bolt-typed code into index.ts, or accept the dependency through " +
        "a small interface parameter instead of importing Bolt here. See root CLAUDE.md.",
      from: { pathNot: "^src/index\\.ts$" },
      to: { path: "@slack/bolt" },
    },
    {
      name: "gateway-never-runs-agent-code",
      severity: "error",
      comment:
        "The gateway (src/) must never import the Claude Agent SDK. Agent tools run only inside " +
        "the container — the sandbox is the permission boundary. The SDK lives in the runner/ " +
        "package, not here. If you need agent behavior, drive it through the runner over the " +
        "NDJSON protocol, don't run it in the gateway process. See root CLAUDE.md.",
      from: { path: "^src/" },
      to: { path: "@anthropic-ai/claude-agent-sdk" },
    },
    {
      name: "gateway-does-not-import-runner-package",
      severity: "error",
      comment:
        "src/ must not import from the sibling runner/ package. The two sides share the protocol " +
        "by KEEPING TWO IDENTICAL COPIES (src/runner/protocol.ts and runner/src/protocol.ts), not " +
        "by importing across the package boundary — that boundary is the gateway/sandbox trust " +
        "line. Edit both protocol copies in lockstep instead. See root CLAUDE.md.",
      from: { path: "^src/" },
      to: { path: "^runner/" },
    },
    {
      name: "blueprints-engine-stays-generic",
      severity: "error",
      comment:
        "src/blueprints/ is the generic workflow engine — it must not import workflow-specific " +
        "code (src/oneshot/) or credential/git seams (src/broker/). Keep it parameterized over " +
        "Ctx/Deps: a workflow defines its own context + deps and consumes the engine, never the " +
        "reverse. Move the workflow-specific piece into src/<workflow>/ instead.",
      from: { path: "^src/blueprints/" },
      to: { path: "^src/(oneshot|broker)/" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular dependency. Break the cycle by moving the shared piece into a leaf module " +
        "(e.g. a types-only file) or by inverting the dependency through an interface.",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".json"],
    },
  },
};
