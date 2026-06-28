/**
 * Unit tests for parseCheckCmds and GATE_TIMEOUT_MS (src/config.ts).
 *
 * Purely offline — no process.env mutation, no network, no Docker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assertDogfoodGate,
  parseCheckCmds,
  parseExecOptInUsers,
  parseRepoAllowlist,
  parseRuntimeCatalog,
} from '../src/config.js';

describe('parseCheckCmds', () => {
  it('returns an empty map for undefined input', () => {
    const result = parseCheckCmds(undefined);
    expect(result.size).toBe(0);
  });

  it('returns an empty map for an empty string', () => {
    const result = parseCheckCmds('');
    expect(result.size).toBe(0);
  });

  it('returns an empty map for malformed JSON', () => {
    const result = parseCheckCmds('{not valid json');
    expect(result.size).toBe(0);
  });

  it('returns an empty map for a JSON array (wrong shape)', () => {
    const result = parseCheckCmds('["acme/api"]');
    expect(result.size).toBe(0);
  });

  it('returns an empty map for a JSON primitive (wrong shape)', () => {
    const result = parseCheckCmds('"just a string"');
    expect(result.size).toBe(0);
  });

  it('parses a valid JSON object with both lint and test into a populated map', () => {
    const raw = JSON.stringify({
      'acme/api': { lint: 'ruff check', test: 'pytest' },
    });
    const result = parseCheckCmds(raw);
    expect(result.size).toBe(1);
    expect(result.get('acme/api')).toEqual({ lint: 'ruff check', test: 'pytest' });
  });

  it('parses multiple repo entries', () => {
    const raw = JSON.stringify({
      'acme/api': { lint: 'ruff check', test: 'pytest' },
      'acme/web': { test: 'npm test' },
    });
    const result = parseCheckCmds(raw);
    expect(result.size).toBe(2);
    expect(result.get('acme/api')).toEqual({ lint: 'ruff check', test: 'pytest' });
    expect(result.get('acme/web')).toEqual({ test: 'npm test' });
  });

  it('a repo entry with only lint sets only lint (test is absent)', () => {
    const raw = JSON.stringify({ 'acme/api': { lint: 'make lint' } });
    const result = parseCheckCmds(raw);
    const entry = result.get('acme/api');
    expect(entry?.lint).toBe('make lint');
    expect(entry?.test).toBeUndefined();
  });

  it('a repo entry with only test sets only test (lint is absent)', () => {
    const raw = JSON.stringify({ 'acme/web': { test: 'npm test' } });
    const result = parseCheckCmds(raw);
    const entry = result.get('acme/web');
    expect(entry?.test).toBe('npm test');
    expect(entry?.lint).toBeUndefined();
  });

  it('ignores repo entries whose value is not an object', () => {
    const raw = JSON.stringify({
      'acme/api': 'not an object',
      'acme/web': { test: 'npm test' },
    });
    const result = parseCheckCmds(raw);
    // 'acme/api' is skipped; 'acme/web' still parsed
    expect(result.has('acme/api')).toBe(false);
    expect(result.get('acme/web')).toEqual({ test: 'npm test' });
  });

  it('ignores lint/test values that are not strings', () => {
    const raw = JSON.stringify({
      'acme/api': { lint: 42, test: 'pytest' },
    });
    const result = parseCheckCmds(raw);
    const entry = result.get('acme/api');
    expect(entry?.lint).toBeUndefined();
    expect(entry?.test).toBe('pytest');
  });

  it('ignores empty-string lint/test values', () => {
    const raw = JSON.stringify({
      'acme/api': { lint: '', test: 'pytest' },
    });
    const result = parseCheckCmds(raw);
    const entry = result.get('acme/api');
    expect(entry?.lint).toBeUndefined();
    expect(entry?.test).toBe('pytest');
  });

  it('drops a repo entry with no effective command (keeps size a faithful signal)', () => {
    const raw = JSON.stringify({
      'acme/api': { lint: '', test: 42 }, // both invalid → no effective override
      'acme/web': { test: 'npm test' },
    });
    const result = parseCheckCmds(raw);
    expect(result.has('acme/api')).toBe(false);
    expect(result.size).toBe(1);
    expect(result.get('acme/web')?.test).toBe('npm test');
  });

  it('never throws for any input (defensive)', () => {
    const weirdInputs = [
      'null',
      'true',
      '0',
      '{"a":null}',
      '{"a":[]}',
      '{"a":{"lint":true}}',
      undefined,
      '',
      '}{',
    ];
    for (const input of weirdInputs) {
      expect(() => parseCheckCmds(input)).not.toThrow();
    }
  });
});

describe('parseRepoAllowlist', () => {
  it('returns an empty set for undefined or empty input', () => {
    expect(parseRepoAllowlist(undefined).size).toBe(0);
    expect(parseRepoAllowlist('   ').size).toBe(0);
  });

  it('parses comma-separated owner/name slugs case-insensitively', () => {
    const result = parseRepoAllowlist('Owner/Repo, acme/widgets ');

    expect([...result].sort()).toEqual(['acme/widgets', 'owner/repo']);
  });

  it('skips empty comma entries', () => {
    const result = parseRepoAllowlist('owner/repo,,acme/widgets,');

    expect([...result].sort()).toEqual(['acme/widgets', 'owner/repo']);
  });

  it('rejects malformed entries instead of silently widening policy', () => {
    for (const bad of ['owner', 'owner/repo/extra', '../repo', 'owner/re po']) {
      expect(() => parseRepoAllowlist(bad)).toThrow(/CLONE_REPO_ALLOWLIST/);
    }
  });
});

describe('parseRuntimeCatalog', () => {
  // Helpers for building valid arch-aware catalog entries
  const validArtifact = {
    url: 'https://example.test/python.tar.gz',
    sha256: 'a'.repeat(64),
    binSubdir: 'python/bin',
  };
  const validArtifactAlt = {
    url: 'https://example.test/python-arm64.tar.gz',
    sha256: 'b'.repeat(64),
    binSubdir: 'python/bin',
  };
  const validEntry = {
    version: '3.12.13+20260610',
    arch: { amd64: validArtifact },
  };
  const validEntryBothArches = {
    version: '3.12.13+20260610',
    arch: { amd64: validArtifact, arm64: validArtifactAlt },
  };

  it('returns an empty map for undefined or empty input', () => {
    expect(parseRuntimeCatalog(undefined).size).toBe(0);
    expect(parseRuntimeCatalog('').size).toBe(0);
  });

  it('parses a valid single-arch entry (no format field) and defaults format to tar.gz', () => {
    const result = parseRuntimeCatalog(JSON.stringify({ python: validEntry }));

    expect(result.size).toBe(1);
    const entry = result.get('python');
    expect(entry?.version).toBe('3.12.13+20260610');
    expect(entry?.format).toBe('tar.gz');
    expect(entry?.arch.amd64?.url).toBe(validArtifact.url);
    expect(entry?.arch.amd64?.sha256).toBe(validArtifact.sha256.toLowerCase());
    expect(entry?.arch.amd64?.binSubdir).toBe('python/bin');
    expect(entry?.arch.arm64).toBeUndefined();
  });

  it('parses a valid 2-arch entry with both amd64 and arm64 present', () => {
    const result = parseRuntimeCatalog(JSON.stringify({ python: validEntryBothArches }));

    expect(result.size).toBe(1);
    const entry = result.get('python');
    expect(entry?.arch.amd64?.url).toBe(validArtifact.url);
    expect(entry?.arch.arm64?.url).toBe(validArtifactAlt.url);
    expect(entry?.arch.arm64?.binSubdir).toBe('python/bin');
  });

  it('parses a zip entry with explicit format: "zip"', () => {
    const catalog = {
      bun: {
        version: '1.3.14',
        format: 'zip',
        arch: {
          amd64: {
            url: 'https://example.test/bun.zip',
            sha256: 'b'.repeat(64),
            binSubdir: 'bun-linux-x64-baseline',
          },
        },
      },
    };
    const result = parseRuntimeCatalog(JSON.stringify(catalog));

    expect(result.size).toBe(1);
    const entry = result.get('bun');
    expect(entry?.format).toBe('zip');
    expect(entry?.arch.amd64?.binSubdir).toBe('bun-linux-x64-baseline');
  });

  it('parses an explicit format: "tar.gz" entry', () => {
    const catalog = { python: { ...validEntry, format: 'tar.gz' } };
    const result = parseRuntimeCatalog(JSON.stringify(catalog));

    expect(result.get('python')?.format).toBe('tar.gz');
  });

  it('throws for an unrecognized format value (fail-closed)', () => {
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { ...validEntry, format: 'rar' },
    }))).toThrow(/format must be "tar.gz" or "zip"/);
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { ...validEntry, format: 'tgz' },
    }))).toThrow(/format must be "tar.gz" or "zip"/);
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { ...validEntry, format: '' },
    }))).toThrow(/format must be "tar.gz" or "zip"/);
  });

  it('throws when arch is missing', () => {
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { version: '3.12.0' },
    }))).toThrow(/arch must be an object/);
  });

  it('throws when arch is an empty object (fail-closed: must define at least one arch)', () => {
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { version: '3.12.0', arch: {} },
    }))).toThrow(/at least one arch/);
  });

  it('throws for unknown arch key (fail-closed — no silent drop)', () => {
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: {
        version: '3.12.0',
        arch: { x86_64: validArtifact },
      },
    }))).toThrow(/unknown arch key/);
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: {
        version: '3.12.0',
        arch: { arm: validArtifact },
      },
    }))).toThrow(/unknown arch key/);
  });

  it('throws for bad per-arch sha256', () => {
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { version: '3.12.0', arch: { amd64: { ...validArtifact, sha256: 'a'.repeat(63) } } },
    }))).toThrow(/sha256/);
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { version: '3.12.0', arch: { amd64: { ...validArtifact, sha256: `${'a'.repeat(63)}z` } } },
    }))).toThrow(/sha256/);
  });

  it('throws for per-arch non-https url', () => {
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { version: '3.12.0', arch: { amd64: { ...validArtifact, url: 'http://example.test/python.tar.gz' } } },
    }))).toThrow(/https/);
  });

  it('throws for per-arch unsafe binSubdir values', () => {
    for (const binSubdir of ['../bin', 'python/../bin', '/python/bin']) {
      expect(() => parseRuntimeCatalog(JSON.stringify({
        python: { version: '3.12.0', arch: { amd64: { ...validArtifact, binSubdir } } },
      }))).toThrow(/binSubdir/);
    }
  });

  it('throws for malformed JSON and non-object catalogs', () => {
    expect(() => parseRuntimeCatalog('{nope')).toThrow(/runtime catalog/i);
    expect(() => parseRuntimeCatalog('[]')).toThrow(/runtime catalog/i);
  });

  it('throws for unsafe runtime names (catalog keys interpolate into the rm -rf/mv target)', () => {
    for (const name of ['.', '..', '../evil', 'py/bin', 'a b']) {
      expect(() => parseRuntimeCatalog(JSON.stringify({
        [name]: validEntry,
      }))).toThrow(/name/);
    }
  });

  it('parses the real config/runtimes.json: both python and bun have amd64 and arm64, bun is zip', () => {
    const { readFileSync } = require('node:fs');
    const raw: string = readFileSync('config/runtimes.json', 'utf-8');
    const catalog = parseRuntimeCatalog(raw);

    expect(catalog.size).toBe(2);

    const python = catalog.get('python');
    expect(python?.format).toBe('tar.gz');
    expect(python?.arch.amd64?.binSubdir).toBe('python/bin');
    expect(python?.arch.arm64?.binSubdir).toBe('python/bin');
    expect(python?.arch.amd64?.url).toContain('x86_64');
    expect(python?.arch.arm64?.url).toContain('aarch64');

    const bun = catalog.get('bun');
    expect(bun?.format).toBe('zip');
    expect(bun?.arch.amd64?.binSubdir).toBe('bun-linux-x64-baseline');
    expect(bun?.arch.arm64?.binSubdir).toBe('bun-linux-aarch64');
    expect(bun?.version).toBe('1.3.14');
  });
});

describe('assertDogfoodGate', () => {
  it('does not throw when the self-repo is not allowlisted, including empty and ignored wrong-command maps', () => {
    expect(() => assertDogfoodGate(new Set(), new Map())).not.toThrow();
    expect(() => assertDogfoodGate(
      new Set(['acme/widgets']),
      new Map([['briggsd/slack-agent', { test: 'npm test' }]]),
    )).not.toThrow();
  });

  it('does not throw when the self-repo is allowlisted and uses npm run gate as its test command', () => {
    expect(() => assertDogfoodGate(
      new Set(['briggsd/slack-agent']),
      new Map([['briggsd/slack-agent', { test: 'npm run gate' }]]),
    )).not.toThrow();
  });

  it('throws when the self-repo is allowlisted but has no check command entry', () => {
    expect(() => assertDogfoodGate(
      new Set(['briggsd/slack-agent']),
      new Map(),
    )).toThrow(/ONESHOT_CHECK_CMDS/);
  });

  it('throws when the self-repo is allowlisted but uses the wrong test command', () => {
    expect(() => assertDogfoodGate(
      new Set(['briggsd/slack-agent']),
      new Map([['briggsd/slack-agent', { test: 'npm test' }]]),
    )).toThrow(/npm run gate/);
  });

  it('throws when the self-repo is allowlisted but only lint is configured', () => {
    expect(() => assertDogfoodGate(
      new Set(['briggsd/slack-agent']),
      new Map([['briggsd/slack-agent', { lint: 'npm run gate' }]]),
    )).toThrow(/docs\/DOGFOODING\.md/);
  });
});

describe('GATE_TIMEOUT_MS config', () => {
  // loadConfig() reads process.env directly and requires the two Slack tokens.
  // These tests stub the whole env (tokens + the var under test), call the real
  // loadConfig(), then restore — so they exercise the actual config path rather
  // than re-asserting arithmetic.
  const TOUCHED = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'GATE_TIMEOUT_MS',
    'PLANNING_IDLE_TIMEOUT_MS',
    'CLONE_REPO_ALLOWLIST',
    'ONESHOT_CHECK_CMDS',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TOUCHED) saved[key] = process.env[key];
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
    process.env['SLACK_APP_TOKEN'] = 'xapp-test';
    delete process.env['PLANNING_IDLE_TIMEOUT_MS'];
    delete process.env['CLONE_REPO_ALLOWLIST'];
    delete process.env['ONESHOT_CHECK_CMDS'];
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      const val = saved[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('defaults GATE_TIMEOUT_MS to 15 minutes (900000 ms) when env var is absent', async () => {
    delete process.env['GATE_TIMEOUT_MS'];
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().GATE_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it('reads GATE_TIMEOUT_MS from the environment when set', async () => {
    process.env['GATE_TIMEOUT_MS'] = '300000';
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().GATE_TIMEOUT_MS).toBe(300_000);
  });

  it('rejects a non-numeric GATE_TIMEOUT_MS', async () => {
    process.env['GATE_TIMEOUT_MS'] = 'not-a-number';
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/GATE_TIMEOUT_MS/);
  });

  it('defaults PLANNING_IDLE_TIMEOUT_MS to 4 hours when env var is absent', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().PLANNING_IDLE_TIMEOUT_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('reads PLANNING_IDLE_TIMEOUT_MS from the environment when set', async () => {
    process.env['PLANNING_IDLE_TIMEOUT_MS'] = '123456';
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().PLANNING_IDLE_TIMEOUT_MS).toBe(123_456);
  });

  it('rejects a non-numeric PLANNING_IDLE_TIMEOUT_MS', async () => {
    process.env['PLANNING_IDLE_TIMEOUT_MS'] = 'later';
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/PLANNING_IDLE_TIMEOUT_MS/);
  });

  it('surfaces the dogfood gate assertion during config load', async () => {
    process.env['CLONE_REPO_ALLOWLIST'] = 'briggsd/slack-agent';
    process.env['ONESHOT_CHECK_CMDS'] = JSON.stringify({
      'briggsd/slack-agent': { test: 'npm test' },
    });
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/docs\/DOGFOODING\.md/);
  });
});

describe('DECISION_CAPTURE config', () => {
  const TOUCHED = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DECISION_CAPTURE',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TOUCHED) saved[key] = process.env[key];
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
    process.env['SLACK_APP_TOKEN'] = 'xapp-test';
    delete process.env['DECISION_CAPTURE'];
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      const val = saved[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('defaults DECISION_CAPTURE to false when the env var is absent', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().decisionCapture).toBe(false);
  });

  it('accepts true-ish values case-insensitively', async () => {
    const { loadConfig } = await import('../src/config.js');
    for (const value of ['1', 'true', 'TRUE', 'yes', 'YeS']) {
      process.env['DECISION_CAPTURE'] = value;
      expect(loadConfig().decisionCapture).toBe(true);
    }
  });

  it('accepts false-ish values case-insensitively', async () => {
    const { loadConfig } = await import('../src/config.js');
    for (const value of ['0', 'false', 'FALSE', 'no', 'No']) {
      process.env['DECISION_CAPTURE'] = value;
      expect(loadConfig().decisionCapture).toBe(false);
    }
  });

  it('rejects invalid boolean values', async () => {
    process.env['DECISION_CAPTURE'] = 'maybe';
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/DECISION_CAPTURE/);
  });
});

describe('spendCaps config (Slice B1)', () => {
  // Each test in this suite mutates a set of env vars and restores them in afterEach.
  const CAP_VARS = [
    'SPEND_CAP_PER_TASK_USD',
    'SPEND_CAP_PER_USER_24H_USD',
    'SPEND_CAP_GLOBAL_24H_USD',
    'PLANNING_IDLE_TIMEOUT_MS',
  ] as const;
  const REQUIRED = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [...CAP_VARS, ...REQUIRED]) saved[key] = process.env[key];
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
    process.env['SLACK_APP_TOKEN'] = 'xapp-test';
    // Remove all three cap vars so each test starts clean
    for (const key of CAP_VARS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of [...CAP_VARS, ...REQUIRED]) {
      const val = saved[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('defaults: unset vars → generous defaults in micro-USD', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    // $20 default per-task → 20_000_000 micro-USD
    expect(cfg.spendCaps.perTaskMicroUsd).toBe(20_000_000);
    // $100 default per-user-24h → 100_000_000 micro-USD
    expect(cfg.spendCaps.perUser24hMicroUsd).toBe(100_000_000);
    // $400 default global-24h → 400_000_000 micro-USD
    expect(cfg.spendCaps.perGlobal24hMicroUsd).toBe(400_000_000);
  });

  it('explicit 0 → 0 (cap disabled)', async () => {
    process.env['SPEND_CAP_PER_TASK_USD'] = '0';
    process.env['SPEND_CAP_PER_USER_24H_USD'] = '0';
    process.env['SPEND_CAP_GLOBAL_24H_USD'] = '0';
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.spendCaps.perTaskMicroUsd).toBe(0);
    expect(cfg.spendCaps.perUser24hMicroUsd).toBe(0);
    expect(cfg.spendCaps.perGlobal24hMicroUsd).toBe(0);
  });

  it('negative dollar values are clamped to 0', async () => {
    process.env['SPEND_CAP_PER_TASK_USD'] = '-5';
    process.env['SPEND_CAP_PER_USER_24H_USD'] = '-100';
    process.env['SPEND_CAP_GLOBAL_24H_USD'] = '-0.01';
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.spendCaps.perTaskMicroUsd).toBe(0);
    expect(cfg.spendCaps.perUser24hMicroUsd).toBe(0);
    expect(cfg.spendCaps.perGlobal24hMicroUsd).toBe(0);
  });

  it('converts dollar values to integer micro-USD correctly', async () => {
    process.env['SPEND_CAP_PER_TASK_USD'] = '1.5';    // → 1_500_000
    process.env['SPEND_CAP_PER_USER_24H_USD'] = '10'; // → 10_000_000
    process.env['SPEND_CAP_GLOBAL_24H_USD'] = '0.01'; // → 10_000
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.spendCaps.perTaskMicroUsd).toBe(1_500_000);
    expect(cfg.spendCaps.perUser24hMicroUsd).toBe(10_000_000);
    expect(cfg.spendCaps.perGlobal24hMicroUsd).toBe(10_000);
  });

  it('rejects a non-numeric cap value', async () => {
    process.env['SPEND_CAP_PER_TASK_USD'] = 'unlimited';
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/SPEND_CAP_PER_TASK_USD/);
  });
});

describe('parseExecOptInUsers', () => {
  it('returns an empty array for undefined input', () => {
    expect(parseExecOptInUsers(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseExecOptInUsers('')).toEqual([]);
  });

  it('returns an empty array for a whitespace-only string', () => {
    expect(parseExecOptInUsers('   ')).toEqual([]);
  });

  it('parses a well-formed T1:U1,T1:U2 into two pairs', () => {
    const result = parseExecOptInUsers('T1:U1,T1:U2');
    expect(result).toEqual([
      { teamId: 'T1', userId: 'U1' },
      { teamId: 'T1', userId: 'U2' },
    ]);
  });

  it('tolerates whitespace around comma separators', () => {
    const result = parseExecOptInUsers(' T1:U1 , T2:U2 ');
    expect(result).toEqual([
      { teamId: 'T1', userId: 'U1' },
      { teamId: 'T2', userId: 'U2' },
    ]);
  });

  it('skips empty segments (trailing/leading/double commas)', () => {
    const result = parseExecOptInUsers(',T1:U1,,T2:U2,');
    expect(result).toEqual([
      { teamId: 'T1', userId: 'U1' },
      { teamId: 'T2', userId: 'U2' },
    ]);
  });

  it('collapses duplicate (team, user) pairs without error', () => {
    const result = parseExecOptInUsers('T1:U1,T1:U1,T1:U2');
    expect(result).toEqual([
      { teamId: 'T1', userId: 'U1' },
      { teamId: 'T1', userId: 'U2' },
    ]);
  });

  it('throws for an entry without a colon', () => {
    expect(() => parseExecOptInUsers('U1')).toThrow(/EXEC_OPT_IN_USERS/);
  });

  it('throws for an entry with an empty team (colon at start)', () => {
    expect(() => parseExecOptInUsers(':U1')).toThrow(/EXEC_OPT_IN_USERS/);
  });

  it('throws for an entry with an empty user (colon at end)', () => {
    expect(() => parseExecOptInUsers('T1:')).toThrow(/EXEC_OPT_IN_USERS/);
  });

  it('throws for an entry with more than one colon (extra colon)', () => {
    expect(() => parseExecOptInUsers('T1:U1:x')).toThrow(/EXEC_OPT_IN_USERS/);
  });

  it('throws for an entry containing internal whitespace', () => {
    expect(() => parseExecOptInUsers('T 1:U1')).toThrow(/EXEC_OPT_IN_USERS/);
    expect(() => parseExecOptInUsers('T1:U 1')).toThrow(/EXEC_OPT_IN_USERS/);
  });

  it('includes the offending entry text in the error message', () => {
    expect(() => parseExecOptInUsers('BADENTRY')).toThrow(/"BADENTRY"/);
  });
});
