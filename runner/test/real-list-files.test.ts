/**
 * Unit tests for the real `realListFiles` walker in runner/src/main.ts.
 *
 * Exercises the REAL implementation against a REAL temp directory — no mocks of fs.
 * All offline (temp fs only; no Slack/Docker/API/network).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { realListFiles } from '../src/main.js';

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir !== undefined) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('realListFiles — git-repo subtree skipping', () => {
  it('includes loose artifacts but excludes git-repo subtrees, worktrees, node_modules, and dotfiles', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'real-list-files-'));

    // loose artifact at scanned root — INCLUDED
    await writeFile(join(tmpDir, 'loose.txt'), 'hello');

    // myrepo: normal clone with .git directory — EXCLUDED (whole subtree)
    await mkdir(join(tmpDir, 'myrepo', '.git'), { recursive: true });
    await writeFile(join(tmpDir, 'myrepo', '.git', 'HEAD'), 'ref: refs/heads/main');
    await writeFile(join(tmpDir, 'myrepo', 'README.md'), '# readme');
    await mkdir(join(tmpDir, 'myrepo', 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'myrepo', 'src', 'index.ts'), 'export {}');

    // worktree: .git as a file (gitlink) — EXCLUDED (whole subtree)
    await mkdir(join(tmpDir, 'worktree'), { recursive: true });
    await writeFile(join(tmpDir, 'worktree', '.git'), 'gitdir: ../.git/worktrees/wt');
    await writeFile(join(tmpDir, 'worktree', 'code.ts'), 'const x = 1;');

    // node_modules — EXCLUDED (existing behavior)
    await mkdir(join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}');

    // dotfile — EXCLUDED (existing behavior)
    await writeFile(join(tmpDir, '.hidden'), 'secret');

    // plain subdir (non-repo) — its files INCLUDED
    await mkdir(join(tmpDir, 'sub'), { recursive: true });
    await writeFile(join(tmpDir, 'sub', 'keep.txt'), 'artifact');

    const files = await realListFiles(tmpDir);
    const names = files.map((f) => f.name);
    const paths = files.map((f) => f.path);

    // Only loose.txt and sub/keep.txt should appear
    expect(names).toContain('loose.txt');
    expect(names).toContain('keep.txt');
    expect(files).toHaveLength(2);

    // Nothing from cloned repos
    expect(paths.some((p) => p.includes('myrepo'))).toBe(false);
    expect(paths.some((p) => p.includes('worktree'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.hidden'))).toBe(false);
  });

  it('still walks into non-repo nested subdirs', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'real-list-files-nested-'));

    await mkdir(join(tmpDir, 'a', 'b'), { recursive: true });
    await writeFile(join(tmpDir, 'a', 'b', 'deep.txt'), 'deep artifact');

    const files = await realListFiles(tmpDir);
    expect(files.map((f) => f.name)).toContain('deep.txt');
  });

  it('excludes the whole repo subtree when .git is a directory', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'real-list-files-git-dir-'));

    await mkdir(join(tmpDir, 'repo', '.git', 'objects'), { recursive: true });
    await writeFile(join(tmpDir, 'repo', 'main.py'), 'print("hi")');
    await writeFile(join(tmpDir, 'outside.txt'), 'outside');

    const files = await realListFiles(tmpDir);
    expect(files.map((f) => f.name)).toEqual(['outside.txt']);
  });

  it('excludes the whole repo subtree when .git is a file (worktree gitlink)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'real-list-files-git-file-'));

    await mkdir(join(tmpDir, 'wt'), { recursive: true });
    await writeFile(join(tmpDir, 'wt', '.git'), 'gitdir: ../.git/worktrees/wt');
    await writeFile(join(tmpDir, 'wt', 'feature.ts'), 'export const x = 1;');
    await writeFile(join(tmpDir, 'result.csv'), 'a,b,c');

    const files = await realListFiles(tmpDir);
    expect(files.map((f) => f.name)).toEqual(['result.csv']);
  });
});
