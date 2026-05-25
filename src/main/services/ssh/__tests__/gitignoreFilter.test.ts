import { describe, expect, it } from 'vitest';
import { GitignoreFilter } from '../GitignoreFilter';

describe('GitignoreFilter', () => {
  it('ignores node_modules', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', 'node_modules');
    expect(filter.shouldIgnore('node_modules')).toBe(true);
    expect(filter.shouldIgnore('node_modules/foo.js')).toBe(true);
    expect(filter.shouldIgnore('src/main.ts')).toBe(false);
  });

  it('ignores dist directory', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', 'dist');
    expect(filter.shouldIgnore('dist')).toBe(true);
    expect(filter.shouldIgnore('dist/bundle.js')).toBe(true);
  });

  it('respects nested .gitignore in subdirectory', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', 'node_modules');
    filter.addGitignore('packages/lib', 'dist');
    expect(filter.shouldIgnore('packages/lib/dist')).toBe(true);
    expect(filter.shouldIgnore('packages/lib/src/index.ts')).toBe(false);
    expect(filter.shouldIgnore('packages/app/dist')).toBe(false);
  });

  it('never ignores .git directory', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', '.git');
    filter.addGitignore('', '*');
    expect(filter.shouldIgnore('.git')).toBe(false);
    expect(filter.shouldIgnore('.git/HEAD')).toBe(false);
    expect(filter.shouldIgnore('.git/objects/abc')).toBe(false);
  });

  it('handles negation patterns', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', '*.log\n!important.log');
    expect(filter.shouldIgnore('debug.log')).toBe(true);
    expect(filter.shouldIgnore('important.log')).toBe(false);
  });

  it('handles anchored patterns with /', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', '/build');
    expect(filter.shouldIgnore('build')).toBe(true);
    expect(filter.shouldIgnore('src/build')).toBe(false);
  });

  it('handles wildcard patterns', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', '*.ts\n!*.d.ts');
    expect(filter.shouldIgnore('foo.ts')).toBe(true);
    expect(filter.shouldIgnore('foo.d.ts')).toBe(false);
    expect(filter.shouldIgnore('src/bar.ts')).toBe(true);
  });

  it('handles nested .gitignore overriding parent', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', '*.log');
    filter.addGitignore('logs', '!*.log');
    // Root ignores *.log
    expect(filter.shouldIgnore('app.log')).toBe(true);
    // Nested dir un-ignores *.log
    expect(filter.shouldIgnore('logs/access.log')).toBe(false);
  });

  it('handles directory-only patterns with trailing /', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', 'docs/');
    expect(filter.shouldIgnore('docs', true)).toBe(true);
    expect(filter.shouldIgnore('docs/readme.md')).toBe(true);
    // Non-anchored docs/ matches src/docs when it's a directory
    expect(filter.shouldIgnore('src/docs', true)).toBe(true);
    // But not when treated as a file
    expect(filter.shouldIgnore('src/docs', false)).toBe(false);
  });

  it('handles empty rules gracefully', () => {
    const filter = new GitignoreFilter('/root');
    expect(filter.shouldIgnore('anything')).toBe(false);
    expect(filter.shouldIgnore('foo/bar')).toBe(false);
  });

  it('handles double-star patterns', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', '**/node_modules');
    expect(filter.shouldIgnore('node_modules')).toBe(true);
    expect(filter.shouldIgnore('packages/app/node_modules')).toBe(true);
    expect(filter.shouldIgnore('deep/nested/node_modules')).toBe(true);
  });

  it('handles backslash paths from Windows', () => {
    const filter = new GitignoreFilter('/root');
    filter.addGitignore('', 'node_modules');
    expect(filter.shouldIgnore('node_modules\\foo.js')).toBe(true);
  });
});
