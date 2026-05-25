import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';

/**
 * Manages nested .gitignore rules for a remote directory tree.
 * Collects per-directory .gitignore content and evaluates paths
 * by combining all applicable rules (deepest first) into a single
 * ignore instance, matching git's precedence semantics.
 */
export class GitignoreFilter {
  private rules = new Map<string, string[]>();
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in fromLocalDir
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  /**
   * Add .gitignore rules from a specific directory.
   * @param dirPath Relative directory path (empty string for root)
   * @param content Raw .gitignore file content
   */
  addGitignore(dirPath: string, content: string): void {
    this.rules.set(dirPath, content.split('\n'));
  }

  /**
   * Check whether a given path should be ignored.
   * Builds a combined ignore instance from all applicable .gitignore
   * files, ordered shallowest-first so deeper rules (added last) win.
   * @param relativePath Path relative to root (e.g., 'src/index.ts')
   * @param isDir Whether the path is a directory
   */
  shouldIgnore(relativePath: string, isDir = false): boolean {
    const normalized = relativePath.replace(/\\/g, '/');

    // .git/ paths are NEVER ignored (F-013 decision)
    if (normalized === '.git' || normalized.startsWith('.git/')) {
      return false;
    }

    // Collect all applicable rules, shallowest first
    // so deeper rules are added last and take precedence
    const ig = ignore();
    const parts = normalized.split('/');

    for (let i = 0; i <= parts.length - 1; i++) {
      const dirRelative = i === 0 ? '' : parts.slice(0, i).join('/');
      const lines = this.rules.get(dirRelative);
      if (!lines) continue;

      // Scope child-directory rules to their path
      const prefix = dirRelative ? `${dirRelative}/` : '';
      const adjusted = lines
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return '';
          // Already anchored with /
          if (trimmed.startsWith('/')) return prefix + trimmed;
          // Negation of anchored pattern
          if (trimmed.startsWith('!/')) return `!${prefix}${trimmed.slice(1)}`;
          // Negation of non-anchored pattern
          if (trimmed.startsWith('!')) return `!${prefix}${trimmed.slice(1)}`;
          return prefix + trimmed;
        })
        .filter(Boolean);

      ig.add(adjusted);
    }

    if (ig.ignores(normalized)) return true;
    if (isDir && ig.ignores(`${normalized}/`)) return true;
    return false;
  }

  /**
   * Load .gitignore files from a local directory tree (for testing).
   */
  static fromLocalDir(rootPath: string): GitignoreFilter {
    const filter = new GitignoreFilter(rootPath);

    const walkDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const childPath = path.join(dir, entry.name);
          const gitignorePath = path.join(childPath, '.gitignore');
          if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, 'utf8');
            const relativeDir = path.relative(rootPath, childPath).replace(/\\/g, '/');
            filter.addGitignore(relativeDir, content);
          }
          walkDir(childPath);
        }
      }
    };

    const rootGitignore = path.join(rootPath, '.gitignore');
    if (fs.existsSync(rootGitignore)) {
      const content = fs.readFileSync(rootGitignore, 'utf8');
      filter.addGitignore('', content);
    }

    walkDir(rootPath);
    return filter;
  }
}
