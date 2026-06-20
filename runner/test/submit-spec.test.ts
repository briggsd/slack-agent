/**
 * Unit tests for the readSpecForApproval helper (runner/src/main.ts, S11).
 *
 * Tests the exported helper in isolation — no SDK, no stdio, no Docker.
 */

import { describe, it, expect } from 'vitest';
import { readSpecForApproval } from '../src/main.js';
import type { ReadFileFn } from '../src/main.js';

describe('readSpecForApproval', () => {
  it('returns spec content when /workspace/SPEC.md has content', async () => {
    const readFile: ReadFileFn = async (path) => {
      if (path === '/workspace/SPEC.md') return 'My great plan';
      return null;
    };

    const result = await readSpecForApproval(readFile);
    expect(result).toBe('My great plan');
  });

  it('returns null when /workspace/SPEC.md is absent (readFile returns null)', async () => {
    const readFile: ReadFileFn = async () => null;

    const result = await readSpecForApproval(readFile);
    expect(result).toBeNull();
  });

  it('returns null when /workspace/SPEC.md is empty string', async () => {
    const readFile: ReadFileFn = async () => '';

    const result = await readSpecForApproval(readFile);
    expect(result).toBeNull();
  });

  it('returns null when /workspace/SPEC.md is whitespace-only', async () => {
    const readFile: ReadFileFn = async () => '   \n  \t  ';

    const result = await readSpecForApproval(readFile);
    expect(result).toBeNull();
  });

  it('returns content trimmed (realReadFile trims; the helper returns what readFile gives)', async () => {
    // In the real implementation, realReadFile already trims, so readSpecForApproval will
    // get pre-trimmed content. The helper doesn't double-trim; it just checks for empty.
    const readFile: ReadFileFn = async () => 'Plan: do something';

    const result = await readSpecForApproval(readFile);
    expect(result).toBe('Plan: do something');
  });
});
