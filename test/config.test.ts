/**
 * Unit tests for parseCheckCmds (src/config.ts).
 *
 * Purely offline — no process.env mutation, no network, no Docker.
 */

import { describe, it, expect } from 'vitest';
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
