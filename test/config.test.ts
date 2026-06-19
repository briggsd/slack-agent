/**
 * Unit tests for parseCheckCmds and GATE_TIMEOUT_MS (src/config.ts).
 *
 * Purely offline — no process.env mutation, no network, no Docker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCheckCmds } from '../src/config.js';

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

describe('GATE_TIMEOUT_MS config', () => {
  // loadConfig() reads process.env directly and requires the two Slack tokens.
  // These tests stub the whole env (tokens + the var under test), call the real
  // loadConfig(), then restore — so they exercise the actual config path rather
  // than re-asserting arithmetic.
  const TOUCHED = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'GATE_TIMEOUT_MS'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TOUCHED) saved[key] = process.env[key];
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
    process.env['SLACK_APP_TOKEN'] = 'xapp-test';
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
});
