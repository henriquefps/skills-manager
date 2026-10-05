import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class SkmError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MARKERS = ['.git', '.agents', '.claude'];

export function findProjectRoot(cwd, home) {
  let dir = cwd;
  for (;;) {
    // The home dir holds the global stores (~/.agents, ~/.claude): never a project.
    if (dir === home) return null;
    if (MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function scopeDirs(base) {
  return {
    base,
    agents: path.join(base, '.agents', 'skills'),
    claude: path.join(base, '.claude', 'skills'),
    agentsInactive: path.join(base, '.agents', 'skills-inactive'),
    claudeInactive: path.join(base, '.claude', 'skills-inactive'),
  };
}

/** Resolve injectable roots. Idempotent: a resolved context passes through. */
export function resolveContext(opts = {}) {
  if (opts.resolved) return opts;
  const env = opts.env ?? process.env;
  const home = path.resolve(opts.home ?? env.SKM_HOME ?? os.homedir());
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const root = opts.projectRoot ? path.resolve(opts.projectRoot) : findProjectRoot(cwd, home);
  return {
    resolved: true,
    home,
    platform: opts.platform ?? process.platform,
    now: opts.now,
    fetch: opts.fetch ?? globalThis.fetch,
    git: opts.git,
    token: opts.token,
    cwd,
    project: root ? { root, name: path.basename(root) } : null,
    dirs(scope) {
      if (scope === 'global') return scopeDirs(home);
      if (scope === 'local') {
        if (!root) throw new SkmError('no-project', 'no project detected from the current directory');
        return scopeDirs(root);
      }
      throw new SkmError('invalid', `invalid scope: ${scope}`);
    },
  };
}

export function assertName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.startsWith('.') ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new SkmError('invalid', `invalid skill name: ${JSON.stringify(name)}`);
  }
  return name;
}
