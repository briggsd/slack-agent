/**
 * Tests for the heuristic failure classifier (src/oneshot/classify.ts).
 *
 * Fully offline — no Docker, no network, no API.
 */

import { describe, it, expect } from 'vitest';
import { classifyFailure, checkFailed } from '../src/oneshot/classify.js';
import type { CheckResult } from '../src/oneshot/git-node.js';

// ── classifyFailure ───────────────────────────────────────────────────────────

describe('classifyFailure — transient markers', () => {
  it('classifies "timed out" as transient', () => {
    expect(classifyFailure('Connection timed out after 30s')).toBe('transient');
  });

  it('classifies "ETIMEDOUT" as transient', () => {
    expect(classifyFailure('Error: ETIMEDOUT')).toBe('transient');
  });

  it('classifies "ECONNRESET" as transient', () => {
    expect(classifyFailure('read ECONNRESET')).toBe('transient');
  });

  it('classifies "ECONNREFUSED" as transient', () => {
    expect(classifyFailure('connect ECONNREFUSED 127.0.0.1:3000')).toBe('transient');
  });

  it('classifies "EAI_AGAIN" as transient', () => {
    expect(classifyFailure('getaddrinfo EAI_AGAIN example.com')).toBe('transient');
  });

  it('classifies "socket hang up" as transient', () => {
    expect(classifyFailure('Error: socket hang up')).toBe('transient');
  });

  it('classifies "network" as transient', () => {
    expect(classifyFailure('network error occurred')).toBe('transient');
  });

  it('classifies "rate limit" as transient', () => {
    expect(classifyFailure('Error: rate limit exceeded')).toBe('transient');
  });

  it('classifies "429" as transient', () => {
    expect(classifyFailure('HTTP 429 Too Many Requests')).toBe('transient');
  });

  it('classifies "503" as transient', () => {
    expect(classifyFailure('503 Service Unavailable')).toBe('transient');
  });

  it('classifies "temporarily unavailable" as transient', () => {
    expect(classifyFailure('The service is temporarily unavailable')).toBe('transient');
  });

  it('is case-insensitive for text markers', () => {
    expect(classifyFailure('TIMED OUT')).toBe('transient');
    expect(classifyFailure('Rate Limit')).toBe('transient');
    expect(classifyFailure('NETWORK ERROR')).toBe('transient');
    expect(classifyFailure('Socket Hang Up')).toBe('transient');
    expect(classifyFailure('Temporarily Unavailable')).toBe('transient');
  });

  it('does NOT classify a bare "network" mention as transient (avoids false positives)', () => {
    // A permanent failure that merely names a "network" module must stay permanent.
    expect(classifyFailure('AssertionError in network.test.ts: expected 1 to equal 2')).toBe('permanent');
    expect(classifyFailure('network')).toBe('permanent');
  });
});

describe('classifyFailure — permanent failures', () => {
  it('classifies a plain assertion failure as permanent', () => {
    expect(classifyFailure('AssertionError: expected 1 to equal 2')).toBe('permanent');
  });

  it('classifies "missing file" output as permanent', () => {
    expect(classifyFailure('Error: missing file foo.ts')).toBe('permanent');
  });

  it('classifies a syntax error as permanent', () => {
    expect(classifyFailure('SyntaxError: Unexpected token')).toBe('permanent');
  });

  it('classifies a type error as permanent', () => {
    expect(classifyFailure("TypeError: Cannot read properties of undefined (reading 'foo')")).toBe('permanent');
  });

  it('classifies an empty string as permanent', () => {
    expect(classifyFailure('')).toBe('permanent');
  });

  it('classifies generic test failure output as permanent', () => {
    expect(classifyFailure('FAIL src/foo.test.ts\n  ● test name › should pass')).toBe('permanent');
  });
});

// ── checkFailed ───────────────────────────────────────────────────────────────

describe('checkFailed', () => {
  it('returns true for a non-skipped non-zero exit code', () => {
    const r: CheckResult = { exitCode: 1, output: 'error output', skipped: false };
    expect(checkFailed(r)).toBe(true);
  });

  it('returns true for a non-zero exit code > 1', () => {
    const r: CheckResult = { exitCode: 2, output: '', skipped: false };
    expect(checkFailed(r)).toBe(true);
  });

  it('returns false for exit code 0 (passed)', () => {
    const r: CheckResult = { exitCode: 0, output: '', skipped: false };
    expect(checkFailed(r)).toBe(false);
  });

  it('returns false for a skipped result (even with non-zero exit)', () => {
    const r: CheckResult = { exitCode: 1, output: 'irrelevant', skipped: true };
    expect(checkFailed(r)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(checkFailed(undefined)).toBe(false);
  });
});
