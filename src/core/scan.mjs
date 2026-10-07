import fs from 'node:fs';
import path from 'node:path';
import { assertName, resolveContext, SkmError } from './context.mjs';
import { costOf, totalsOf } from './cost.mjs';
import { dirHash, inspect, parseDescription, walk } from './fsutil.mjs';
import { lintSkill } from './lint.mjs';
import { lockEntry, readLock } from './lock.mjs';
import { metaFor, readMeta, tagCounts } from './meta.mjs';
import { gitTreeHash } from './treehash.mjs';

const IGNORED = new Set(['synced', 'node_modules']);
const isIgnored = (name) => name.startsWith('.') || IGNORED.has(name);

function listNames(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !isIgnored(n));
  } catch {
    return [];
  }
}

/** The (up to four) places a skill can live in a scope. Missing/non-dir entries are null. */
export function locate(ctx, scope, name) {
  const d = ctx.dirs(scope);
  const at = (dir) => inspect(path.join(dir, name));
  return {
    a: at(d.agents),
    c: at(d.claude),
    ia: at(d.agentsInactive),
    ic: scope === 'local' ? at(d.claudeInactive) : null,
  };
}

/** The global folder a copy to local reads: active copies first, then inactive ones (a real folder in ~/.claude/skills-inactive counts too). */
export function globalSource(ctx, name) {
  const g = locate(ctx, 'global', name);
  const gci = inspect(path.join(ctx.dirs('global').claudeInactive, name));
  return [g.a, g.c, g.ia, gci].find((x) => x && x.kind !== 'broken-symlink') ?? null;
}

/** Real folders of a local skill, active or inactive (links are left out: they follow their target). */
export function localFolders(ctx, name) {
  const l = locate(ctx, 'local', name);
  return [l.a, l.c, l.ia, l.ic].filter((x) => x?.kind === 'dir');
}

/**
 * `"identical"` or `"diverged"`: the local skill's real folders against the global copy (active or inactive).
 * Null when either side is missing. `cache` (Map name -> hash) avoids hashing a global folder twice.
 */
export function compareWithGlobal(ctx, name, cache) {
  try {
    const src = globalSource(ctx, name);
    const dirs = localFolders(ctx, name);
    if (!src || !dirs.length) return null;
    const hash = cache?.get(name) ?? dirHash(src.real);
    cache?.set(name, hash);
    return dirs.every((d) => dirHash(d.path) === hash) ? 'identical' : 'diverged';
  } catch {
    return null;
  }
}

/** The folder whose contents represent the skill, or null when everything is broken. */
function primaryDir(...locs) {
  for (const l of locs) if (l && l.real) return l.real;
  return null;
}

function conflictFiles(dir) {
  return walk(dir)
    .filter((e) => /\.sync-conflict-/.test(path.basename(e.rel)))
    .map((e) => e.rel);
}

function classify(scope, { a, c, ia, ic }) {
  const issues = [];
  const active = Boolean(a || c);
  const present = [a, c, ia, ic].filter(Boolean);
  const dir = primaryDir(a, c, ia, ic);
  let status;

  if (active) {
    const broken = [['agents', a], ['claude', c], ['agents (inactive)', ia], ['claude (inactive)', ic]].filter(
      ([, l]) => l?.kind === 'broken-symlink',
    );
    if (broken.length) {
      status = 'broken-link';
      for (const [root, l] of broken) issues.push(`${root} entry is a broken symlink -> ${l.target}`);
    } else if (scope === 'global') {
      if (c?.kind === 'symlink') {
        if (a && a.real === c.real) status = 'ok';
        else {
          status = 'wrong-link';
          issues.push(`claude symlink points to ${c.target}, not to the agents folder`);
        }
      } else if (a && c) {
        if (dirHash(a.real) === dirHash(c.real)) {
          status = 'duplicate';
          issues.push('real folders in agents and claude, identical');
        } else {
          status = 'diverged';
          issues.push('real folders in agents and claude, contents differ');
        }
      } else if (c) {
        status = 'claude-only';
        issues.push('real folder only in claude, not in agents');
      } else {
        status = 'needs-link';
        issues.push('claude symlink is missing');
      }
    } else if (a && c && a.real !== c.real) {
      if (dirHash(a.real) === dirHash(c.real)) {
        status = 'duplicate';
        issues.push('copies in .agents and .claude, identical');
      } else {
        status = 'diverged';
        issues.push('copies in .agents and .claude, contents differ');
      }
    } else status = 'ok';
  } else status = 'ok';

  if (dir) {
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
      issues.push('folder has no SKILL.md');
      if (status === 'ok') status = 'empty';
    }
    const conflicts = conflictFiles(dir);
    if (conflicts.length) {
      issues.push(`Syncthing conflict files: ${conflicts.join(', ')}`);
      if (status === 'ok') status = 'conflict';
    }
  }
  return { active, status, issues, dir };
}

function buildSkill(scope, name, locs) {
  const { active, status, issues, dir } = classify(scope, locs);
  let description = '';
  let files = 0;
  let bytes = 0;
  let mtime = null;
  let cost = { listing: 0, full: 0 };
  const lint = dir ? lintSkill(dir, name) : [];
  if (dir) {
    try {
      const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      description = parseDescription(md);
      cost = costOf(md, name);
    } catch {}
    let latest = fs.statSync(dir).mtimeMs;
    for (const e of walk(dir)) {
      if (!e.stat.isDirectory()) {
        files++;
        bytes += e.stat.size;
      }
      latest = Math.max(latest, e.stat.mtimeMs);
    }
    mtime = new Date(latest).toISOString();
  }
  const locations = [];
  const push = (l, root, inactive) => {
    if (!l) return;
    const o = { root, path: l.path, kind: l.kind };
    if (l.target !== undefined) o.target = l.target;
    if (inactive) o.inactive = true;
    locations.push(o);
  };
  push(locs.a, 'agents', false);
  push(locs.c, 'claude', false);
  push(locs.ia, 'agents', true);
  push(locs.ic, 'claude', true);
  return { name, scope, active, status, issues, description, files, bytes, mtime, locations, alsoIn: [], origin: null, cost, lint, dir };
}

/** Provenance from a lock entry; `modified` compares the local git tree hash with the recorded one. */
function originOf(e, dir) {
  let modified = false;
  try {
    modified = Boolean(dir && e.skillFolderHash && gitTreeHash(dir) !== e.skillFolderHash);
  } catch {}
  return { source: e.source ?? null, url: e.sourceUrl ?? null, skillPath: e.skillPath ?? null, installedAt: e.installedAt ?? null, updatedAt: e.updatedAt ?? null, modified };
}

export function scanScope(opts, scope) {
  const ctx = resolveContext(opts);
  if (scope === 'local' && !ctx.project) return [];
  const d = ctx.dirs(scope);
  const dirs = [d.agents, d.claude, d.agentsInactive];
  if (scope === 'local') dirs.push(d.claudeInactive);
  const names = new Set(dirs.flatMap(listNames));
  const skills = [];
  for (const name of [...names].sort()) {
    const locs = locate(ctx, scope, name);
    if (!Object.values(locs).some(Boolean)) continue;
    skills.push(buildSkill(scope, name, locs));
  }
  const lock = scope === 'global' ? readLock(ctx.home) : null;
  const meta = readMeta(ctx);
  for (const s of skills) {
    s.meta = metaFor(meta, s.name);
    const e = lockEntry(lock, s.name);
    if (e) s.origin = originOf(e, s.dir);
    delete s.dir;
  }
  return skills;
}

export function getState(opts = {}) {
  const ctx = resolveContext(opts);
  const global = scanScope(ctx, 'global');
  const local = scanScope(ctx, 'local');
  const g = new Set(global.map((s) => s.name));
  const l = new Set(local.map((s) => s.name));
  for (const s of global) if (l.has(s.name)) s.alsoIn.push('local');
  for (const s of local) if (g.has(s.name)) s.alsoIn.push('global');
  for (const s of local) s.vsGlobal = s.alsoIn.length ? compareWithGlobal(ctx, s.name) : null;
  const all = [...global, ...local];
  const favorites = new Set(all.filter((s) => s.meta.favorite).map((s) => s.name)).size;
  return { cwd: ctx.cwd, project: ctx.project, global, local, totals: totalsOf(global, local), tags: tagCounts(all), favorites };
}

export function getSkill(opts, scope, name) {
  const ctx = resolveContext(opts);
  assertName(name);
  const state = getState(ctx);
  const skill = (scope === 'local' ? state.local : state.global).find((s) => s.name === name);
  if (!skill) throw new SkmError('not-found', `skill not found: ${scope}/${name}`);
  const locs = locate(ctx, scope, name);
  const dir = primaryDir(locs.a, locs.c, locs.ia, locs.ic);
  let markdown = '';
  let tree = [];
  if (dir) {
    try {
      markdown = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    } catch {}
    tree = walk(dir)
      .filter((e) => !e.stat.isDirectory())
      .map((e) => e.rel);
  }
  return { skill, markdown, tree };
}
