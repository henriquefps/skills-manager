import fs from 'node:fs';
import path from 'node:path';
import { assertName, resolveContext, SkmError } from './context.mjs';
import { dirHash, moveSync } from './fsutil.mjs';
import { applyIgnoreOp, inactiveIgnoreOp } from './gitignore.mjs';
import { getProfile } from './profiles.mjs';
import { globalSource, locate, localFolders, scanScope } from './scan.mjs';
import { trashSync, trashTarget } from './trash.mjs';
import { updateSkill } from './updates.mjs';

// ---- plan executor -------------------------------------------------------

const describe = (op) => {
  switch (op.op) {
    case 'move': return `move ${op.from} -> ${op.to}`;
    case 'trash': return `trash ${op.from} -> ${op.target.dest}`;
    case 'copy': return `copy ${op.from} -> ${op.to}`;
    case 'symlink': return `symlink ${op.path} -> ${op.target}`;
    case 'unlink': return `unlink ${op.path}`;
    case 'rm': return `remove ${op.path}`;
    case 'gitignore': return `append ${op.line} to ${op.path}`;
  }
};

/** Create a directory symlink. On Windows, fall back to a junction (absolute target) when symlinks need privileges. */
export function symlinkDir(target, linkPath, { platform = process.platform, fsImpl = fs } = {}) {
  try {
    return fsImpl.symlinkSync(target, linkPath, 'dir');
  } catch (e) {
    if (platform !== 'win32' || (e.code !== 'EPERM' && e.code !== 'EACCES')) throw e;
    return fsImpl.symlinkSync(path.resolve(path.dirname(linkPath), target), linkPath, 'junction');
  }
}

function apply(op) {
  switch (op.op) {
    case 'move': return moveSync(op.from, op.to);
    case 'trash': return trashSync(op.from, op.target);
    case 'copy':
      fs.mkdirSync(path.dirname(op.to), { recursive: true });
      return fs.cpSync(op.from, op.to, { recursive: true, dereference: true });
    case 'symlink':
      fs.mkdirSync(path.dirname(op.path), { recursive: true });
      return symlinkDir(op.target, op.path);
    case 'unlink': return fs.unlinkSync(op.path);
    case 'rm': return fs.rmSync(op.path, { recursive: true, force: true });
    case 'gitignore': return applyIgnoreOp(op);
  }
}

function run(plan, dryRun, message) {
  const changes = plan.map(describe);
  if (!dryRun) for (const op of plan) apply(op);
  return { ok: true, message: dryRun ? `dry run: ${message}` : message, changes };
}

const move = (from, to) => ({ op: 'move', from, to });
const unlink = (p) => ({ op: 'unlink', path: p });
const claudeLink = (d, name) => ({
  op: 'symlink',
  path: path.join(d.claude, name),
  target: path.relative(d.claude, path.join(d.agents, name)),
});

/** Planner for moves to the system Trash; destinations are reserved so one plan never reuses a slot. */
function trasher(ctx) {
  const taken = new Set();
  const now = ctx.now ?? new Date();
  const trash = (from) => ({ op: 'trash', from, target: trashTarget(from, { home: ctx.home, platform: ctx.platform, now, taken }) });
  /** Trash a real folder, or just unlink a symlink. */
  trash.dispose = (loc) => (!loc ? [] : loc.kind === 'dir' ? [trash(loc.path)] : [unlink(loc.path)]);
  return trash;
}

const requireScope = (scope, allowed) => {
  if (!allowed.includes(scope)) throw new SkmError('invalid', `action not available for scope ${scope}`);
};

// ---- actions -------------------------------------------------------------

function activate(ctx, { scope, name, dryRun }) {
  const d = ctx.dirs(scope);
  const l = locate(ctx, scope, name);
  const plan = [];
  if (scope === 'global') {
    if (!l.ia) throw new SkmError('not-found', `no inactive global skill: ${name}`);
    if (l.a) throw new SkmError('exists', `already active: ${path.join(d.agents, name)}`);
    plan.push(move(l.ia.path, path.join(d.agents, name)));
    if (!l.c) plan.push(claudeLink(d, name));
  } else {
    if (!l.ia && !l.ic) throw new SkmError('not-found', `no inactive local skill: ${name}`);
    if (l.ia) {
      if (l.a) throw new SkmError('exists', `already exists: ${l.a.path}`);
      plan.push(move(l.ia.path, path.join(d.agents, name)));
    }
    if (l.ic) {
      if (l.c) throw new SkmError('exists', `already exists: ${l.c.path}`);
      plan.push(move(l.ic.path, path.join(d.claude, name)));
    }
  }
  return run(plan, dryRun, `activated ${scope}/${name}`);
}

function deactivate(ctx, { scope, name, dryRun }) {
  const d = ctx.dirs(scope);
  const l = locate(ctx, scope, name);
  const plan = [];
  if (scope === 'global') {
    if (!l.a) {
      if (l.c?.kind === 'dir') throw new SkmError('needs-normalize', `${name} only exists in claude; run normalize first`);
      throw new SkmError('not-found', `no active global skill: ${name}`);
    }
    if (l.c?.kind === 'dir') throw new SkmError('needs-normalize', `${name} has a real folder in claude; run normalize first`);
    if (l.ia) throw new SkmError('exists', `already exists: ${l.ia.path}`);
    plan.push(move(l.a.path, path.join(d.agentsInactive, name)));
    if (l.c) plan.push(unlink(l.c.path));
  } else {
    if (!l.a && !l.c) throw new SkmError('not-found', `no active local skill: ${name}`);
    if (l.a) {
      if (l.ia) throw new SkmError('exists', `already exists: ${l.ia.path}`);
      plan.push(move(l.a.path, path.join(d.agentsInactive, name)));
    }
    if (l.c) {
      if (l.c.kind !== 'dir' || (l.a && l.a.real === l.c.real)) plan.push(unlink(l.c.path));
      else {
        if (l.ic) throw new SkmError('exists', `already exists: ${l.ic.path}`);
        plan.push(move(l.c.path, path.join(d.claudeInactive, name)));
      }
    }
    const ignore = plan.some((op) => op.op === 'move') && inactiveIgnoreOp(ctx.project.root);
    if (ignore) plan.push(ignore);
  }
  return run(plan, dryRun, `deactivated ${scope}/${name}`);
}

function normalizePlan(ctx, name, keep) {
  const d = ctx.dirs('global');
  const trash = trasher(ctx);
  const { a, c } = locate(ctx, 'global', name);
  if (!a && !c) throw new SkmError('not-found', `no active global skill: ${name}`);
  if (keep && !['agents', 'claude'].includes(keep)) throw new SkmError('invalid', `invalid keep: ${keep}`);
  const plan = [];
  const aPath = path.join(d.agents, name);
  const link = () => claudeLink(d, name);

  if (a && a.kind === 'broken-symlink') {
    throw new SkmError('broken-link', `${a.path} is a broken symlink; remove or repair it manually`);
  }
  if (!a) {
    if (c.kind === 'dir') plan.push(move(c.path, aPath), link());
    else if (c.kind === 'broken-symlink') plan.push(unlink(c.path));
    else throw new SkmError('wrong-link', `${c.path} points to ${c.target}, but there is no agents folder to link to`);
  } else if (!c) plan.push(link());
  else if (c.kind === 'symlink' && c.real === a.real) return plan;
  else if (c.kind === 'symlink' || c.kind === 'broken-symlink') plan.push(unlink(c.path), link());
  else if (dirHash(a.real) === dirHash(c.real)) plan.push({ op: 'rm', path: c.path }, link());
  else {
    if (!keep) throw new SkmError('diverged', `${name}: agents and claude copies differ; pass keep: "agents" or "claude"`);
    if (keep === 'agents') plan.push(trash(c.path), link());
    else plan.push(trash(a.path), move(c.path, aPath), link());
  }
  return plan;
}

function normalize(ctx, { name, keep, dryRun }) {
  const plan = normalizePlan(ctx, name, keep);
  return run(plan, dryRun, plan.length ? `normalized ${name}` : `${name} is already normalized`);
}

function promote(ctx, { name, overwrite, dryRun }) {
  const g = ctx.dirs('global');
  const trash = trasher(ctx);
  const l = locate(ctx, 'local', name);
  const src = [l.a, l.c].find((x) => x && x.kind !== 'broken-symlink');
  if (!src) throw new SkmError('not-found', `no active local skill: ${name}`);
  const dest = locate(ctx, 'global', name);
  const plan = [];
  if (dest.a || dest.c) {
    if (!overwrite) throw new SkmError('exists', `global skill already exists: ${name} (use overwrite)`);
    plan.push(...trash.dispose(dest.a), ...trash.dispose(dest.c));
  }
  plan.push({ op: 'copy', from: src.real, to: path.join(g.agents, name) }, claudeLink(g, name));
  return run(plan, dryRun, `promoted local/${name} to global`);
}

function copyToLocal(ctx, { name, overwrite, target = 'claude', dryRun }) {
  if (!ctx.project) throw new SkmError('no-project', 'no project detected from the current directory');
  if (!['agents', 'claude'].includes(target)) throw new SkmError('invalid', `invalid target: ${target}`);
  const l = ctx.dirs('local');
  // Active copies first, then inactive ones. The source is never touched.
  const src = globalSource(ctx, name);
  if (!src) throw new SkmError('not-found', `no global skill: ${name}`);
  const existing = locate(ctx, 'local', name)[target === 'agents' ? 'a' : 'c'];
  const plan = [];
  if (existing) {
    if (!overwrite) throw new SkmError('exists', `local skill already exists: ${existing.path} (use overwrite)`);
    plan.push(...trasher(ctx).dispose(existing));
  }
  plan.push({ op: 'copy', from: src.real, to: path.join(target === 'agents' ? l.agents : l.claude, name) });
  return run(plan, dryRun, `copied global/${name} to local (${target})`);
}

/**
 * Replace a local skill with the global copy (active or inactive; the global side is only read). Every real local
 * folder that differs goes to the system Trash and gets the global copy in its place, so an inactive local skill
 * stays inactive and links are left alone. Identical folders are a no-op.
 */
function refresh(ctx, { name, dryRun }) {
  if (!ctx.project) throw new SkmError('no-project', 'no project detected from the current directory');
  const src = globalSource(ctx, name);
  if (!src) throw new SkmError('not-found', `no global skill: ${name}`);
  const l = locate(ctx, 'local', name);
  if (![l.a, l.c, l.ia, l.ic].some(Boolean)) throw new SkmError('not-found', `no local skill: ${name}`);
  const dirs = localFolders(ctx, name);
  if (!dirs.length) throw new SkmError('invalid', `local ${name} has no real folder to refresh (only links)`);
  const hash = dirHash(src.real);
  const stale = dirs.filter((d) => dirHash(d.path) !== hash);
  if (!stale.length) return run([], dryRun, `local/${name} is already the same as global`);
  const trash = trasher(ctx);
  const plan = stale.flatMap((d) => [trash(d.path), { op: 'copy', from: src.real, to: d.path }]);
  const dests = plan.filter((op) => op.op === 'trash').map((op) => op.target.dest);
  return run(plan, dryRun, `refreshed local/${name} from global; the old copy is in the system Trash (${dests.join(', ')})`);
}

/** Run `one(name)` for several names; continues past failures and reports each one. */
function forEachName(names, one) {
  if (!Array.isArray(names) || !names.length) throw new SkmError('invalid', 'names must be a non-empty array');
  const results = [];
  const changes = [];
  for (const name of new Set(names)) {
    try {
      changes.push(...one(assertName(name)).changes);
      results.push({ name, ok: true });
    } catch (err) {
      if (!(err instanceof SkmError)) throw err;
      results.push({ name, ok: false, error: err.message, code: err.code });
    }
  }
  return { results, changes, done: results.filter((r) => r.ok).length };
}

/** Copy several global skills; continues past failures and reports each one. */
function copyManyToLocal(ctx, { names, overwrite, target = 'claude', dryRun }) {
  if (!Array.isArray(names) || !names.length) throw new SkmError('invalid', 'names must be a non-empty array');
  if (!ctx.project) throw new SkmError('no-project', 'no project detected from the current directory');
  if (!['agents', 'claude'].includes(target)) throw new SkmError('invalid', `invalid target: ${target}`);
  const { results, changes, done } = forEachName(names, (name) => copyToLocal(ctx, { name, overwrite, target, dryRun }));
  const message = `${dryRun ? 'dry run: ' : ''}copied ${done} of ${results.length} global skill(s) to local (${target})`;
  return { ok: done === results.length, message, changes, results };
}

/** Refresh several local skills from global; continues past failures and reports each one. */
function refreshMany(ctx, { names, dryRun }) {
  if (!Array.isArray(names) || !names.length) throw new SkmError('invalid', 'names must be a non-empty array');
  if (!ctx.project) throw new SkmError('no-project', 'no project detected from the current directory');
  const { results, changes, done } = forEachName(names, (name) => refresh(ctx, { name, dryRun }));
  const message = `${dryRun ? 'dry run: ' : ''}refreshed ${done} of ${results.length} local skill(s) from global`;
  return { ok: done === results.length, message, changes, results };
}

/**
 * Copy every skill of a profile into the project through copyManyToLocal. A skill already in the project is skipped
 * unless `overwrite` (which replaces the copy where it lives); a skill inactive in the project is always skipped.
 * Inactive global skills are valid sources and stay inactive. Names with no global skill are reported as `missing`.
 */
function applyProfile(ctx, { profile, overwrite, target = 'claude', dryRun }) {
  if (!ctx.project) throw new SkmError('no-project', 'no project detected from the current directory');
  if (!['agents', 'claude'].includes(target)) throw new SkmError('invalid', `invalid target: ${target}`);
  const p = getProfile(ctx, profile);
  const byName = new Map();
  const groups = { agents: [], claude: [] };
  for (const name of p.skills) {
    const l = locate(ctx, 'local', name);
    if (!l.a && !l.c && (l.ia || l.ic)) byName.set(name, { name, status: 'skipped', reason: 'inactive in this project' });
    else if ((l.a || l.c) && !overwrite) byName.set(name, { name, status: 'skipped', reason: 'already in this project' });
    else {
      // Overwrite replaces the real folder where it lives, so a skill never ends up in both roots by accident.
      const dir = (x) => x?.kind === 'dir';
      const where = !l.a && !l.c ? target : dir(l[target === 'agents' ? 'a' : 'c']) ? target : dir(l.a) ? 'agents' : dir(l.c) ? 'claude' : target;
      groups[where].push(name);
    }
  }
  const changes = [];
  for (const where of ['claude', 'agents']) {
    if (!groups[where].length) continue;
    const batch = copyManyToLocal(ctx, { names: groups[where], overwrite, target: where, dryRun });
    changes.push(...batch.changes);
    for (const r of batch.results) {
      if (r.ok) byName.set(r.name, { name: r.name, status: 'copied', target: where });
      else if (r.code === 'not-found') byName.set(r.name, { name: r.name, status: 'missing', error: r.error });
      else byName.set(r.name, { name: r.name, status: 'failed', error: r.error, code: r.code });
    }
  }
  const results = p.skills.map((n) => byName.get(n));
  const pick = (st) => results.filter((r) => r.status === st).map((r) => r.name);
  const [copied, skipped, missing, failed] = ['copied', 'skipped', 'missing', 'failed'].map(pick);
  const parts = [`copied ${copied.length}`, skipped.length && `skipped ${skipped.length}`, missing.length && `${missing.length} missing from global`, failed.length && `${failed.length} failed`];
  const message = `${dryRun ? 'dry run: ' : ''}applied profile ${p.name} to ${ctx.project.name}: ${parts.filter(Boolean).join(', ')}`;
  return { ok: !failed.length, message, changes, results, copied, skipped, missing, failed };
}

function del(ctx, { scope, name, dryRun }) {
  const l = locate(ctx, scope, name);
  const all = [l.a, l.c, l.ia, l.ic].filter(Boolean);
  if (!all.length) throw new SkmError('not-found', `skill not found: ${scope}/${name}`);
  const trash = trasher(ctx);
  const plan = [];
  // Links first, so nothing dangles; real folders go to the system Trash, symlinks are only unlinked.
  for (const loc of [l.c, l.a]) if (loc && loc.kind !== 'dir') plan.push(unlink(loc.path));
  for (const loc of [l.a, l.c, l.ia, l.ic]) if (loc?.kind === 'dir') plan.push(trash(loc.path));
  for (const loc of [l.ia, l.ic]) if (loc && loc.kind !== 'dir') plan.push(unlink(loc.path));
  const dests = plan.filter((op) => op.op === 'trash').map((op) => op.target.dest);
  const where = dests.length ? ` to the system Trash (${dests.join(', ')})` : '';
  return run(plan, dryRun, `moved ${scope}/${name}${where}`);
}

// ---- entry points --------------------------------------------------------

export const ACTIONS = ['activate', 'deactivate', 'normalize', 'promote', 'copyToLocal', 'refresh', 'delete', 'update', 'applyProfile'];

/** Run one action. Throws SkmError on failure; returns { ok, message, changes }. */
export function runAction(opts, req) {
  const ctx = resolveContext(opts);
  const { action, scope, keep, overwrite = false, target, dryRun = false, force = false } = req ?? {};
  if (action === 'copyToLocal' && req?.names !== undefined) {
    requireScope(scope ?? 'global', ['global']);
    return copyManyToLocal(ctx, { names: req.names, overwrite, target, dryRun });
  }
  if (action === 'refresh' && req?.names !== undefined) {
    requireScope(scope ?? 'local', ['local']);
    return refreshMany(ctx, { names: req.names, dryRun });
  }
  if (action === 'applyProfile') return applyProfile(ctx, { profile: req.profile, overwrite, target, dryRun });
  const name = assertName(req?.name);
  switch (action) {
    case 'activate':
    case 'deactivate':
      requireScope(scope, ['global', 'local']);
      return (action === 'activate' ? activate : deactivate)(ctx, { scope, name, dryRun });
    case 'delete':
      requireScope(scope, ['global', 'local']);
      return del(ctx, { scope, name, dryRun });
    case 'normalize':
      requireScope(scope ?? 'global', ['global']);
      return normalize(ctx, { name, keep, dryRun });
    case 'promote':
      requireScope(scope ?? 'local', ['local']);
      return promote(ctx, { name, overwrite, dryRun });
    case 'copyToLocal':
      requireScope(scope ?? 'global', ['global']);
      return copyToLocal(ctx, { name, overwrite, target, dryRun });
    case 'refresh':
      requireScope(scope ?? 'local', ['local']);
      return refresh(ctx, { name, dryRun });
    case 'update':
      requireScope(scope ?? 'global', ['global']);
      return updateSkill(ctx, { name, force: Boolean(force), dryRun });
    default:
      throw new SkmError('invalid', `unknown action: ${action}`);
  }
}

/** Normalize every global skill that can be fixed without a decision. Diverged ones are reported, not touched. */
export function normalizeAll(opts, { keep, dryRun = false } = {}) {
  const ctx = resolveContext(opts);
  const changes = [];
  const skipped = [];
  for (const s of scanScope(ctx, 'global')) {
    if (!s.active || s.status === 'ok' || s.status === 'empty' || s.status === 'conflict') continue;
    try {
      changes.push(...normalize(ctx, { name: s.name, keep, dryRun }).changes);
    } catch (err) {
      if (!(err instanceof SkmError)) throw err;
      skipped.push(`${s.name}: ${err.message}`);
    }
  }
  return { ok: true, message: `normalized ${changes.length} change(s), skipped ${skipped.length}`, changes, skipped };
}
