/**
 * Unit tests for parseCheckCmds and GATE_TIMEOUT_MS (src/config.ts).
 *
 * Purely offline — no process.env mutation, no network, no Docker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCheckCmds, parseRepoAllowlist, parseRuntimeCatalog } from '../src/config.js';

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
  const valid = {
    python: {
      version: '3.12.13+20260610',
      url: 'https://example.test/python.tar.gz',
      sha256: 'a'.repeat(64),
      binSubdir: 'python/bin',
    },
  };

  it('returns an empty map for undefined or empty input', () => {
    expect(parseRuntimeCatalog(undefined).size).toBe(0);
    expect(parseRuntimeCatalog('').size).toBe(0);
  });

  it('parses a valid catalog entry into a map', () => {
    const result = parseRuntimeCatalog(JSON.stringify(valid));

    expect(result.size).toBe(1);
    expect(result.get('python')).toEqual(valid.python);
  });

  it('throws for malformed JSON and non-object catalogs', () => {
    expect(() => parseRuntimeCatalog('{nope')).toThrow(/runtime catalog/i);
    expect(() => parseRuntimeCatalog('[]')).toThrow(/runtime catalog/i);
  });

  it('throws for bad sha256 length or charset', () => {
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { ...valid.python, sha256: 'a'.repeat(63) },
    }))).toThrow(/sha256/);
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { ...valid.python, sha256: `${'a'.repeat(63)}z` },
    }))).toThrow(/sha256/);
  });

  it('throws for non-https urls', () => {
    expect(() => parseRuntimeCatalog(JSON.stringify({
      python: { ...valid.python, url: 'http://example.test/python.tar.gz' },
    }))).toThrow(/https/);
  });

  it('throws for unsafe binSubdir values', () => {
    for (const binSubdir of ['../bin', 'python/../bin', '/python/bin']) {
      expect(() => parseRuntimeCatalog(JSON.stringify({
        python: { ...valid.python, binSubdir },
      }))).toThrow(/binSubdir/);
    }
  });

  it('throws for unsafe runtime names (catalog keys interpolate into the rm -rf/mv target)', () => {
    for (const name of ['.', '..', '../evil', 'py/bin', 'a b']) {
      expect(() => parseRuntimeCatalog(JSON.stringify({
        [name]: valid.python,
      }))).toThrow(/name/);
    }
  });
});

describe('GATE_TIMEOUT_MS config', () => {
  // loadConfig() reads process.env directly and requires the two Slack tokens.
  // These tests stub the whole env (tokens + the var under test), call the real
  // loadConfig(), then restore — so they exercise the actual config path rather
  // than re-asserting arithmetic.
  const TOUCHED = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'GATE_TIMEOUT_MS', 'PLANNING_IDLE_TIMEOUT_MS'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TOUCHED) saved[key] = process.env[key];
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
    process.env['SLACK_APP_TOKEN'] = 'xapp-test';
    delete process.env['PLANNING_IDLE_TIMEOUT_MS'];
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
