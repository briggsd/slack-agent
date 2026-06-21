import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Keep the cache inside the project root, not the default node_modules/.vite. In a
  // git worktree (the delegate-implement flow) node_modules is a symlink to the main
  // checkout, which lands outside a sandboxed implementer's writable root — the default
  // cache path then fails with EPERM. A project-local, gitignored dir avoids that and
  // gives each worktree its own cache.
  cacheDir: '.vite',
  test: {
    include: ['test/**/*.test.ts', 'runner/test/**/*.test.ts'],
    environment: 'node',
  },
});
