import fs from 'node:fs';
import path from 'node:path';
import { assertName, resolveContext, SkmError } from './context.mjs';
import { dirHash, moveSync } from './fsutil.mjs';
import { locate, scanScope } from './scan.mjs';

// ---- plan executor -------------------------------------------------------

const describe = (op) => {
  switch (op.op) {
    case 'move': return `move ${op.from} -> ${op.to}`;
    case 'copy': return `copy ${op.from} -> ${op.to}`;
    case 'symlink': return `symlink ${op.path} -> ${op.target}`;
    case 'unlink': return `unlink ${op.path}`;
    case 'rm': return `remove ${op.path}`;
  }
};

function apply(op) {
  switch (op.op) {
    case 'move': return moveSync(op.from, op.to);
    case 'copy':
      fs.mkdirSync(path.dirname(op.to), { recursive: true });
      return fs.cpSync(op.from, op.to, { recursive: true, dereference: true });
    case 'symlink':
      fs.mkdirSync(path.dirname(op.path), { recursive: true });
      return fs.symlinkSync(op.target, op.path, 'dir');
    case 'unlink': return fs.unlinkSync(op.path);
    case 'rm': return fs.rmSync(op.path, { recursive: true, force: true });
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

function trashPath(dir, name, tag = '') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const base = path.join(dir, `${name}-${stamp}${tag}`);
  let p = base;
  for (let i = 2; fs.existsSync(p); i++) p = `${base}-${i}`;
  return p;
}

/** Trash a real folder, or just unlink a symlink. */
function disposeOps(loc, trashDir, name, tag = '') {
  if (!loc) return [];
  if (loc.kind === 'dir') return [move(loc.path, trashPath(trashDir, name, tag))];
  return [unlink(loc.path)];
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
  }
  return run(plan, dryRun, `deactivated ${scope}/${name}`);
}

function normalizePlan(ctx, name, keep) {
  const d = ctx.dirs('global');
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
    if (keep === 'agents') plan.push(move(c.path, trashPath(d.trash, name, '-claude')), link());
    else plan.push(move(a.path, trashPath(d.trash, name, '-agents')), move(c.path, aPath), link());
  }
  return plan;
}

function normalize(ctx, { name, keep, dryRun }) {
  const plan = normalizePlan(ctx, name, keep);
  return run(plan, dryRun, plan.length ? `normalized ${name}` : `${name} is already normalized`);
}

function promote(ctx, { name, overwrite, dryRun }) {
  const g = ctx.dirs('global');
  const l = locate(ctx, 'local', name);
  const src = [l.a, l.c].find((x) => x && x.kind !== 'broken-symlink');
  if (!src) throw new SkmError('not-found', `no active local skill: ${name}`);
  const dest = locate(ctx, 'global', name);
  const plan = [];
  if (dest.a || dest.c) {
    if (!overwrite) throw new SkmError('exists', `global skill already exists: ${name} (use overwrite)`);
    plan.push(...disposeOps(dest.a, g.trash, name, '-agents'), ...disposeOps(dest.c, g.trash, name, '-claude'));
  }
  plan.push({ op: 'copy', from: src.real, to: path.join(g.agents, name) }, claudeLink(g, name));
  return run(plan, dryRun, `promoted local/${name} to global`);
}

function copyToLocal(ctx, { name, overwrite, target = 'claude', dryRun }) {
  if (!ctx.project) throw new SkmError('no-project', 'no project detected from the current directory');
  if (!['agents', 'claude'].includes(target)) throw new SkmError('invalid', `invalid target: ${target}`);
  const l = ctx.dirs('local');
  const g = locate(ctx, 'global', name);
  const src = [g.a, g.c].find((x) => x && x.kind !== 'broken-symlink');
  if (!src) throw new SkmError('not-found', `no active global skill: ${name}`);
  const existing = locate(ctx, 'local', name)[target === 'agents' ? 'a' : 'c'];
  const plan = [];
  if (existing) {
    if (!overwrite) throw new SkmError('exists', `local skill already exists: ${existing.path} (use overwrite)`);
    plan.push(...disposeOps(existing, l.trash, name));
  }
  plan.push({ op: 'copy', from: src.real, to: path.join(target === 'agents' ? l.agents : l.claude, name) });
  return run(plan, dryRun, `copied global/${name} to local (${target})`);
}

function del(ctx, { scope, name, dryRun }) {
  const d = ctx.dirs(scope);
  const l = locate(ctx, scope, name);
  const all = [l.a, l.c, l.ia, l.ic].filter(Boolean);
  if (!all.length) throw new SkmError('not-found', `skill not found: ${scope}/${name}`);
  const plan = [];
  // Links first, so nothing dangles; real folders go to the trash, never unlinked for real.
  for (const loc of [l.c, l.a]) if (loc && loc.kind !== 'dir') plan.push(unlink(loc.path));
  if (l.a?.kind === 'dir') plan.push(move(l.a.path, trashPath(d.trash, name)));
  if (l.c?.kind === 'dir') plan.push(move(l.c.path, trashPath(d.trash, name, '-claude')));
  if (l.ia) plan.push(...disposeOps(l.ia, d.trash, name, '-inactive'));
  if (l.ic) plan.push(...disposeOps(l.ic, d.trash, name, '-claude-inactive'));
  return run(plan, dryRun, `moved ${scope}/${name} to trash`);
}

// ---- entry points --------------------------------------------------------

export const ACTIONS = ['activate', 'deactivate', 'normalize', 'promote', 'copyToLocal', 'delete'];

/** Run one action. Throws SkmError on failure; returns { ok, message, changes }. */
export function runAction(opts, req) {
  const ctx = resolveContext(opts);
  const { action, scope, keep, overwrite = false, target, dryRun = false } = req ?? {};
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
