import fs from 'node:fs';
import path from 'node:path';
import { collapseHome, expandHome, readConfig, readRaw, updateRaw } from './config.mjs';
import { resolveContext, SkmError } from './context.mjs';
import { isHomeRelative, isPathLike } from './pathkind.mjs';

export const MAX_IGNORE = 200;
const MAX_ENTRY = 500;
const GLOB_CHARS = /^[A-Za-z0-9_.\-@+ *]+$/;

const inside = (dir, root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** An entry with a slash or backslash (or a drive-letter prefix) is a path, anything else a directory-name glob. */
export const ignoreKind = (entry) => (isPathLike(entry) ? 'path' : 'glob');

/** Stored entries (`config.json` -> `ignore`), as written; non-strings and blanks dropped, duplicates removed. */
export function readIgnore(opts = {}) {
  const { home } = resolveContext(opts);
  const raw = readRaw(home).ignore;
  return Array.isArray(raw) ? [...new Set(raw.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim()))] : [];
}

/**
 * Validate one candidate entry and return its stored form: paths are normalized (home -> `~/...`), globs kept as given.
 * Rejects the root of the home, `/` and anything that is neither an absolute/`~/` path nor a plain name glob.
 */
export function normalizeIgnoreEntry(entry, home) {
  if (typeof entry !== 'string' || !entry.trim()) throw new SkmError('invalid', 'ignore entries must be non-empty strings');
  const e = entry.trim();
  if (e.length > MAX_ENTRY) throw new SkmError('invalid', 'ignore entry is too long');
  if (ignoreKind(e) === 'glob') {
    if (!GLOB_CHARS.test(e)) throw new SkmError('invalid', `a name pattern may only use letters, digits, spaces, . _ - @ + and *: ${e}`);
    if (!e.replace(/[*.]/g, '')) throw new SkmError('invalid', `a name pattern needs something besides * and dots: ${e}`);
    return e;
  }
  if (!(path.isAbsolute(e) || isHomeRelative(e))) throw new SkmError('invalid', `a path must be absolute or start with ~/: ${e}`);
  const abs = path.resolve(expandHome(e, home));
  if (abs === path.parse(abs).root) throw new SkmError('invalid', 'refusing to ignore the filesystem root');
  if (abs === path.resolve(home)) throw new SkmError('invalid', 'refusing to ignore the whole home folder');
  return collapseHome(abs, home);
}

const globRegex = (g) => new RegExp(`^${g.split('*').map((s) => s.replace(/[.+@ \\^$|?()[\]{}]/g, '\\$&')).join('.*')}$`);

/**
 * Compiled matcher for stored entries. `match(dir)` returns the first entry covering the absolute directory `dir`
 * (a path entry covers the folder and everything below; a glob covers any folder whose basename matches), or null.
 * Entries that cannot be normalized never match. Directories for which `exempt(dir)` is true never match.
 */
export function compileIgnore(entries, home, exempt = () => false) {
  const rules = [];
  for (const entry of entries) {
    try {
      const norm = normalizeIgnoreEntry(entry, home);
      rules.push(ignoreKind(norm) === 'path' ? { entry, kind: 'path', abs: path.resolve(expandHome(norm, home)) } : { entry, kind: 'glob', re: globRegex(norm) });
    } catch {}
  }
  return {
    entries: entries.map((entry) => ({ entry, kind: ignoreKind(entry) })),
    match(dir) {
      if (exempt(dir)) return null;
      const base = path.basename(dir);
      return rules.find((r) => (r.kind === 'path' ? inside(dir, r.abs) : r.re.test(base)))?.entry ?? null;
    },
  };
}

/** The current project and every folder above it are never hidden (it keeps its own Global/Local view). */
export const currentProjectExempt = (ctx) => {
  const root = ctx.project?.root;
  return (dir) => Boolean(root) && inside(root, dir);
};

/**
 * The entry that hides `dir` (a project or any folder), looking at it and its ancestors below the configured roots.
 * Null when nothing hides it, or when it is the current project.
 */
export function ignoredBy(opts, dir) {
  const ctx = resolveContext(opts);
  const matcher = compileIgnore(readIgnore(ctx), ctx.home, currentProjectExempt(ctx));
  const abs = path.resolve(dir);
  const root = readConfig(ctx).projectRoots.filter((r) => inside(abs, r)).sort((a, b) => b.length - a.length)[0];
  const chain = [abs];
  if (root) for (let d = abs; d !== root && d !== path.dirname(d); ) chain.push((d = path.dirname(d)));
  return chain.map((d) => matcher.match(d)).find(Boolean) ?? null;
}

/** Path entries must lie inside a configured root or be the current project (symlinks resolved on both sides). */
function assertAllowed(ctx, stored) {
  const abs = path.resolve(expandHome(stored, ctx.home));
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const roots = [...readConfig(ctx).projectRoots, ...(ctx.project ? [ctx.project.root] : [])];
  const allowed = roots.flatMap((r) => [r, real(r)]);
  if (!allowed.some((r) => inside(abs, r) || inside(real(abs), r))) throw new SkmError('forbidden', `not inside a configured project root: ${stored}`);
}

/**
 * Add and/or remove ignore entries ({ add, remove }, arrays of strings) and persist; every other config key survives.
 * Returns { ignore, added, removed } with the stored forms. Removing an entry that is not stored is a no-op.
 */
export function updateIgnore(opts, req) {
  const ctx = resolveContext(opts);
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new SkmError('invalid', 'body must be an object');
  for (const k of ['add', 'remove']) {
    if (req[k] !== undefined && (!Array.isArray(req[k]) || req[k].length > MAX_IGNORE)) throw new SkmError('invalid', `${k} must be an array of at most ${MAX_IGNORE} entries`);
  }
  const add = (req.add ?? []).map((e) => normalizeIgnoreEntry(e, ctx.home));
  const remove = (req.remove ?? []).map((e) => normalizeIgnoreEntry(e, ctx.home));
  for (const e of add) if (ignoreKind(e) === 'path') assertAllowed(ctx, e);
  const keyOf = (e) => (ignoreKind(e) === 'path' ? path.resolve(expandHome(e, ctx.home)) : e);
  const current = readIgnore(ctx);
  const drop = new Set(remove.map(keyOf));
  const removed = current.filter((e) => drop.has(keyOf(e)));
  const next = current.filter((e) => !drop.has(keyOf(e)));
  const have = new Set(next.map(keyOf));
  const added = [];
  for (const e of add) {
    if (have.has(keyOf(e))) continue;
    have.add(keyOf(e));
    next.push(e);
    added.push(e);
  }
  if (next.length > MAX_IGNORE) throw new SkmError('invalid', `at most ${MAX_IGNORE} ignore entries`);
  if (added.length || removed.length) {
    updateRaw(ctx, (raw) => {
      const { ignore, ...rest } = raw;
      return next.length ? { ...rest, ignore: next } : rest;
    });
  }
  return { ignore: next, added, removed };
}
