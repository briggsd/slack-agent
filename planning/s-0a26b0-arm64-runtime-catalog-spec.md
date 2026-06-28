# Task: Make the runtime catalog arch-aware (per-arch artifacts) so native arm64 runners can provision the right binaries

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(this is a worktree of it; TypeScript, Node 20+, ESM, vitest, strict tsc).
**Read the root `CLAUDE.md` first** (gate, invariants, conventions), then the
context below. You are on branch `sonnet/arm64-runtime-catalog`.

## Why (context — read before writing code)

The runner Docker image today is built `--platform linux/amd64` on the arm64 Mac
host **only because** `config/runtimes.json` pins x86_64-only binaries (python
`x86_64-unknown-linux-gnu`, bun `bun-linux-x64-baseline`) — they can't exec on a
native arm64 image (there is no in-container emulation). Forcing the whole
container to amd64 means everything runs under qemu: slow, CPU-heavy, a prime
suspect for Socket-Mode flapping under load.

This slice removes the reason for the amd64 pin: make the catalog hold **both**
arches' artifacts and pick the right one **at provision time inside the container
via `uname -m`**. Once landed, the live runner image can be rebuilt native arm64
(an out-of-repo operational step — NOT part of this slice; see Out of scope) and
`uname` will select the arm64 binaries automatically.

**Decided design (do not re-litigate):**
- **Nested arch map** — one logical runtime name; an `arch` sub-map holds the
  per-arch `{url, sha256, binSubdir}` triple. `version` and `format` stay at the
  entry level (arch-independent: python is tar.gz both arches, bun is zip both).
- **In-container `uname -m` selection** — the gateway bakes *both* arches into the
  provision shell script; a `case "$(uname -m)"` picks the right one at runtime,
  fail-closed on an unsupported arch. The gateway does **not** decide arch.

### Code this builds on (exact files + line numbers as of `d04402d`)

- `src/config.ts:72-78` — `RuntimeCatalogEntry` interface (`{version, url, sha256,
  binSubdir, format}`). `src/config.ts:248-306` — `parseRuntimeCatalog()`:
  fail-closed validation (https url, 64-hex sha256 lowercased, safe `binSubdir`,
  `format` default `tar.gz`). `isSafeRuntimeName`/`isSafeRuntimeBinSubdir`/
  `isRuntimeRecord` helpers live in the same file — reuse them.
- `src/runner/runtime-provision-service.ts:7-13` — a **second** declaration of
  `RuntimeCatalogEntry` (structurally identical, separately declared). `git-node.ts`
  imports the type from here. **Both declarations must change in lockstep** (treat
  like the `protocol.ts` discipline — keep them identical).
- `src/oneshot/docker-git-node.ts:319-332` — `runtimePathPrefixScript()`: builds the
  PATH prefix for run_checks from the catalog; each entry contributes
  `/workspace/.runtimes/<name>/<binSubdir>`, **already guarded by `[ -d "$d" ]`** so
  only actually-installed dirs land on PATH.
- `src/oneshot/docker-git-node.ts:529-570` — `dockerProvisionArgs()`: bakes
  `entry.url/sha256/binSubdir/format` into the download→sha256-verify→extract shell
  script. `format` chooses the mktemp suffix + `unzip` vs `tar -xzf`.
- `src/oneshot/runtime-provision-service.ts:23-35` — `RealRuntimeProvisionService.
  provision()`: `catalog.get(name)` → passes the whole `entry` to
  `gitNodes.provisionRuntime({name, entry, volume})`. **No change needed** (it just
  forwards the entry) — but confirm it still type-checks against the new shape.
- `src/oneshot/git-node.ts:107-112` — `ProvisionRuntimeRequest` carries `entry:
  RuntimeCatalogEntry`. No field change; the entry shape changes underneath it.
- `config/runtimes.json` — the live catalog (2 entries: python, bun).
- Tests: `test/config.test.ts:163-266` (parse), `test/docker-git-node.test.ts`
  (PATH prefix ~928-975; provision/extract ~1164-1286).

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run `npm run gate`, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure.

## The new schema (exact)

```ts
export type RuntimeArch = 'amd64' | 'arm64';

export interface RuntimeArchArtifact {
  url: string;       // https only
  sha256: string;    // 64 hex, stored lowercased
  binSubdir: string; // safe relative path (no '..', no leading '/')
}

export interface RuntimeCatalogEntry {
  version: string;
  format: 'tar.gz' | 'zip';
  /** At least one arch must be present. Keys constrained to RuntimeArch. */
  arch: { readonly [A in RuntimeArch]?: RuntimeArchArtifact };
}
```

Declare these identically in **both** `src/config.ts` and
`src/runner/runtime-provision-service.ts` (`RuntimeArch` + `RuntimeArchArtifact` +
`RuntimeCatalogEntry`). Where to put `RuntimeArch` for the `case`/PATH code in
`docker-git-node.ts`: import it from `../runner/runtime-provision-service.js` (same
path it already imports the entry type from via `git-node.ts`).

### `config/runtimes.json` — the exact new contents (URLs + sha256 verified live 2026-06-27)

```json
{
  "python": {
    "version": "3.12.13+20260610",
    "format": "tar.gz",
    "arch": {
      "amd64": {
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.12.13%2B20260610-x86_64-unknown-linux-gnu-install_only.tar.gz",
        "sha256": "c218f50baeb2c06a30c2f03db5986b2bad6ab7c8a52faad2d5a59bda0677b93a",
        "binSubdir": "python/bin"
      },
      "arm64": {
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.12.13%2B20260610-aarch64-unknown-linux-gnu-install_only.tar.gz",
        "sha256": "bc74cf1bb517651868342b0619b21eaaf9f94a2022c9c61886dd980e16fb091b",
        "binSubdir": "python/bin"
      }
    }
  },
  "bun": {
    "version": "1.3.14",
    "format": "zip",
    "arch": {
      "amd64": {
        "url": "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip",
        "sha256": "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
        "binSubdir": "bun-linux-x64-baseline"
      },
      "arm64": {
        "url": "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip",
        "sha256": "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
        "binSubdir": "bun-linux-aarch64"
      }
    }
  }
}
```

(`%2B` is the URL-encoded `+` in the python version — keep it exactly. bun's arm64
`binSubdir` is `bun-linux-aarch64`, NOT `...-baseline`; baseline is an x64-only
concept. python's `binSubdir` is `python/bin` for both arches. These archive-top
dir names were confirmed by extracting both arm64 archives.)

## Implementation notes (the two non-obvious bits)

### 1. `parseRuntimeCatalog` — validate the nested shape, fail-closed

For each named entry: validate `version` (non-empty string) and `format` (absent →
`'tar.gz'`; else exactly `'tar.gz'`|`'zip'`, else throw) as today. Then:
- `arch` must be a record (`isRuntimeRecord`); throw if missing/not-an-object.
- It must have **at least one** key; throw on an empty `arch` (`"must define at
  least one arch"`).
- Every key must be in `{amd64, arm64}`; throw on an unknown arch key (fail-closed
  — don't silently drop it).
- For each present arch artifact, validate `url` (https), `sha256` (64-hex,
  store `.toLowerCase()`), `binSubdir` (`isSafeRuntimeBinSubdir`) — same rules and
  same error-message style as today, scoped per `"<name>" arch "<arch>"`.

The resulting map value is the new `RuntimeCatalogEntry` (with `format` defaulted
and each artifact's sha256 lowercased).

### 2. `dockerProvisionArgs` — `uname -m` case picks url/sha256/bin_subdir

`target = /workspace/.runtimes/<name>` stays arch-independent. The script must
resolve `url` / `expected` (sha256) / `bin_subdir` from `uname -m` BEFORE the
idempotency check (because `bin_dir` depends on `bin_subdir`). Shape:

```sh
set -eu
target='/workspace/.runtimes/<name>'
arch="$(uname -m)"
case "$arch" in
  x86_64)        url='<amd64 url>'; expected='<amd64 sha>'; bin_subdir='<amd64 binSubdir>';;   # only if amd64 present
  aarch64|arm64) url='<arm64 url>'; expected='<arm64 sha>'; bin_subdir='<arm64 binSubdir>';;   # only if arm64 present
  *) echo "unsupported arch: $arch" >&2; exit 24;;
esac
bin_dir="$target/$bin_subdir"
if [ -d "$bin_dir" ]; then exit 0; fi
# ... unchanged from here: mktemp (suffix from format), curl --proto =https --tlsv1.2,
#     sha256sum compare vs "$expected" (exit 23 on mismatch), extract (unzip|tar -xzf
#     from format), rm -rf "$target"; mv tmp "$target"; test -d "$bin_dir"
```

- Emit a `case` arm **only for arches present in `entry.arch`** (so an entry with
  only arm64 fails closed on an amd64 host, and vice-versa). Map `amd64`→`x86_64)`,
  `arm64`→`aarch64|arm64)`. All values `shellQuote`d.
- `format` is arch-independent — keep choosing the mktemp suffix and `unzip` vs
  `tar -xzf` from `req.entry.format` at TS level, exactly as today.
- Use a NEW exit code for the unsupported-arch case (e.g. `24`) distinct from the
  existing `23` (sha mismatch); assert it in a test.

### 3. `runtimePathPrefixScript` — emit every arch's binSubdir candidate, deduped

Because only one arch actually installs and the loop already guards each dir with
`[ -d "$d" ]`, you do NOT need `uname` here. For each catalog entry, emit
`/workspace/.runtimes/<name>/<binSubdir>` for **every** arch present in
`entry.arch`. **Dedupe** the final dir list (python's amd64 and arm64 `binSubdir`
are both `python/bin` → identical path; don't emit it twice) — e.g. collect into a
`Set` before quoting. The `[ -d ]` guard then keeps only the installed one. Empty
catalog still returns `':'`.

## Acceptance criteria (each maps to a test or observable behavior)

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`. All existing tests pass (updated to the new shape) plus new ones.
2. `RuntimeCatalogEntry` is the nested-arch shape above, declared **identically** in
   `src/config.ts` and `src/runner/runtime-provision-service.ts`.
3. `parseRuntimeCatalog` accepts the new `config/runtimes.json` and: rejects an empty
   `arch`, rejects an unknown arch key, rejects a bad per-arch url/sha256/binSubdir —
   each fail-closed (throws at startup), with a per-arch-scoped message. New tests
   cover each rejection + a happy-path 2-arch entry, and the "real `config/runtimes.json`
   loads with both arches for python and bun" assertion is updated.
4. `dockerProvisionArgs` produces a script whose `case "$(uname -m)"` contains an arm
   for each present arch with that arch's url/sha256/bin_subdir, a fail-closed `*)`
   arm with a distinct exit code, and resolves `bin_dir` from the selected
   `bin_subdir`. Tests assert: both arches' url+sha appear in the script; the
   `x86_64)`/`aarch64|arm64)` tokens appear; the unsupported-arch exit code appears;
   the existing sha-mismatch (23), no-`GIT_TOKEN`, idempotency, and tar.gz-vs-zip
   extract assertions still hold (rewritten to the nested fixture).
5. `runtimePathPrefixScript` emits each present arch's binSubdir path, deduped, still
   `[ -d ]`-guarded; empty catalog → `':'`. Test: a 2-arch bun fixture puts BOTH
   `bun-linux-x64-baseline` and `bun-linux-aarch64` candidate dirs on the guarded
   list; python's single `python/bin` appears once (dedupe).

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail of its output when done.
- Conventions per root `CLAUDE.md`: **no `any`, no `@ts-ignore`**; `NodeNext` ESM
  (`.js` import specifiers); inject external deps (tests stay offline — no Docker /
  network). The whole suite must run with no Docker/Slack/API/network.
- `RuntimeCatalogEntry` lives in two `src/` copies (`config.ts` +
  `runner/runtime-provision-service.ts`) — edit **both** identically.
- Treat container output as data; never log message contents or tokens (this slice
  shouldn't add logging anyway).
- Do NOT add dependencies. Do NOT touch `protocol.ts` (not involved).
- Do NOT commit — leave the working tree for review. Do NOT edit this spec file.

## Out of scope (do NOT build)

- **Rebuilding the runner image native arm64** — that's an out-of-repo operational
  step on the live host (`~/workspace/slack-agent-live/run-supervised.sh` drops
  `--platform linux/amd64`). No repo build script forces a platform today
  (`scripts/smoke-docker.sh` builds native), so there is nothing to change in-repo.
  Do not add `--platform` flags to any container spawn (`docker.ts`,
  `dockerProvisionArgs`, `dockerCheckArgs`) — containers must stay native so
  `uname` reflects the host.
- Host-arch detection in the gateway / a `RUNNER_ARCH` env — explicitly rejected in
  favor of in-container `uname`.
- Updating the untracked `scripts/smoke-runtime*.mjs` — if they construct catalog
  entries inline they'll break against the new type, but they're untracked smoke
  scripts outside the gate; leave them (note it in your report if you notice).
- musl variants, additional runtimes, additional arches (riscv etc.).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, not paraphrased) — test count + files.
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (or couldn't) —
  e.g. you cannot run a real arm64 provision offline; say so.
