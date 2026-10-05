import fs from 'node:fs';
import path from 'node:path';
import { resolveContext, SkmError } from './context.mjs';

export const DEFAULT_DEPTH = 3;
export const MIN_DEPTH = 1;
export const MAX_DEPTH = 6;

export const configPath = (home) => path.join(home, '.config', 'skm', 'config.json');

/** `~` and `~/x` -> absolute under home; anything else is returned as given. */
export function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** Inverse of expandHome for storage: paths inside home are written as `~/...`. */
function collapseHome(abs, home) {
  const rel = path.relative(home, abs);
  if (rel === '') return '~';
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : `~/${rel.split(path.sep).join('/')}`;
}

function readRaw(home) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** The config with `~` expanded and defaults applied. A missing or invalid file means defaults. */
export function readConfig(opts = {}) {
  const { home } = resolveContext(opts);
  const raw = readRaw(home);
  const roots = Array.isArray(raw.projectRoots) ? raw.projectRoots.filter((r) => typeof r === 'string' && r) : [];
  const depth = Number.isInteger(raw.scanDepth) && raw.scanDepth >= MIN_DEPTH && raw.scanDepth <= MAX_DEPTH ? raw.scanDepth : DEFAULT_DEPTH;
  return { projectRoots: [...new Set(roots.map((r) => path.resolve(expandHome(r, home))))], scanDepth: depth };
}

/** Validate a candidate config ({ projectRoots, scanDepth }, both optional) and return it normalized (absolute roots). */
export function validateConfig(input, opts = {}) {
  const { home } = resolveContext(opts);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SkmError('invalid', 'config must be an object');
  const current = readConfig(opts);
  let roots = current.projectRoots;
  if (input.projectRoots !== undefined) {
    if (!Array.isArray(input.projectRoots) || input.projectRoots.some((r) => typeof r !== 'string' || !r.trim())) {
      throw new SkmError('invalid', 'projectRoots must be an array of paths');
    }
    roots = [];
    for (const r of input.projectRoots) {
      const abs = expandHome(r.trim(), home);
      if (!path.isAbsolute(abs)) throw new SkmError('invalid', `project root must be an absolute path (or start with ~): ${r}`);
      const resolved = path.resolve(abs);
      let st;
      try {
        st = fs.statSync(resolved);
      } catch {}
      if (!st?.isDirectory()) throw new SkmError('invalid', `project root is not an existing directory: ${r}`);
      if (!roots.includes(resolved)) roots.push(resolved);
    }
  }
  let depth = current.scanDepth;
  if (input.scanDepth !== undefined) {
    if (!Number.isInteger(input.scanDepth) || input.scanDepth < MIN_DEPTH || input.scanDepth > MAX_DEPTH) {
      throw new SkmError('invalid', `scanDepth must be an integer from ${MIN_DEPTH} to ${MAX_DEPTH}`);
    }
    depth = input.scanDepth;
  }
  return { projectRoots: roots, scanDepth: depth };
}

/**
 * Validate and persist (temp file + rename; created on first write). Keeps unknown fields. Roots under home are
 * stored as `~/...`. Returns the normalized config (absolute roots).
 */
export function writeConfig(opts, input) {
  const ctx = resolveContext(opts);
  const cfg = validateConfig(input, ctx);
  const file = configPath(ctx.home);
  const next = { ...readRaw(ctx.home), projectRoots: cfg.projectRoots.map((r) => collapseHome(r, ctx.home)), scanDepth: cfg.scanDepth };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return cfg;
}
