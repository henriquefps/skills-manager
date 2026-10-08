import fs from 'node:fs';
import path from 'node:path';
import { resolveContext, SkmError } from './context.mjs';
import { estimateTokens } from './cost.mjs';
import { diffLines } from './diff.mjs';

// Read only (Phase 1 of docs/planned-features/instructions-management.md): nothing here writes.

/** Instruction files looked up at a project root, in display order. Nested files deeper in the tree are out of scope. */
export const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'];
/** Id of the global `~/.claude/CLAUDE.md`. */
export const GLOBAL_ID = 'global';

/** Alternatives for the same shared content: two of these that differ are flagged. CLAUDE.local.md and the global file are meant to differ. */
const SHARED = new Set(['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md']);

const globalFile = (ctx) => path.join(ctx.home, '.claude', 'CLAUDE.md');

/** One file: { id, scope, path, kind: file|symlink|broken-symlink|missing, target?, real?, bytes?, lines?, tokens?, mtime? }. */
function inspect(id, scope, file) {
  const f = { id, scope, path: file, kind: 'missing' };
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return f;
  }
  if (st.isSymbolicLink()) {
    f.kind = 'symlink';
    f.target = fs.readlinkSync(file);
    try {
      f.real = fs.realpathSync(file);
      st = fs.statSync(file);
    } catch {
      f.kind = 'broken-symlink';
      return f;
    }
  } else f.real = fs.realpathSync(file);
  if (!st.isFile()) return { id, scope, path: file, kind: 'missing' };
  if (f.kind === 'missing') f.kind = 'file';
  const text = fs.readFileSync(file, 'utf8');
  f.bytes = st.size;
  f.lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  f.tokens = estimateTokens(text);
  f.mtime = st.mtime.toISOString();
  return f;
}

const readable = (f) => f.kind === 'file' || f.kind === 'symlink';

/** `link` (both resolve to the same file), `identical` (a plain copy) or `differs`. */
function relationOf(a, b) {
  if (a.real === b.real) return 'link';
  return fs.readFileSync(a.real).equals(fs.readFileSync(b.real)) ? 'identical' : 'differs';
}

/** Root of the project to look at: `root` when given, else the current project (or none). */
function projectOf(ctx, root) {
  if (root) return { root: path.resolve(root), name: path.basename(path.resolve(root)) };
  return ctx.project;
}

/**
 * Instruction files of one project plus the global one. Returns
 * { project, files, global, pairs: [{ a, b, relation }], findings: [{ kind: copy|differs|broken, files, message }] }.
 * `files` lists the project files that exist (symlinks included), `pairs` every pair of readable files (the global
 * file too). Findings: a plain copy of another file (a symlink would keep them in sync), two of CLAUDE.md, AGENTS.md
 * and .claude/CLAUDE.md that differ, and broken symlinks. A link is valid and never a finding.
 */
export function listInstructions(opts, root) {
  const ctx = resolveContext(opts);
  const project = projectOf(ctx, root);
  const files = project ? INSTRUCTION_FILES.map((id) => inspect(id, 'project', path.join(project.root, id))).filter((f) => f.kind !== 'missing') : [];
  const global = inspect(GLOBAL_ID, 'global', globalFile(ctx));
  const all = [...files, global].filter(readable);
  for (const f of files) {
    if (f.kind !== 'symlink') continue;
    const same = all.filter((o) => o !== f && o.real === f.real);
    const to = same.find((o) => o.kind === 'file') ?? same[0];
    if (to) f.linksTo = to.id;
  }
  const pairs = [];
  const findings = [];
  // Files that resolve to the same file are one: a link pair, then only the first of them is compared with the rest.
  const heads = [];
  for (const f of all) {
    const head = heads.find((h) => h.real === f.real);
    if (head) pairs.push({ a: head.id, b: f.id, relation: 'link' });
    else heads.push(f);
  }
  // Plain copies are one content too: a copy is reported once and only the first of them is compared with the rest.
  const contents = [];
  for (const b of heads) {
    const a = contents.find((a) => relationOf(a, b) === 'identical');
    if (a) {
      pairs.push({ a: a.id, b: b.id, relation: 'identical' });
      findings.push({ kind: 'copy', files: [a.id, b.id], message: `${label(b.id === GLOBAL_ID ? a : b)} is a plain copy of ${label(b.id === GLOBAL_ID ? b : a)}: a symlink would keep them in sync` });
      continue;
    }
    for (const a of contents) {
      pairs.push({ a: a.id, b: b.id, relation: 'differs' });
      if (SHARED.has(a.id) && SHARED.has(b.id)) findings.push({ kind: 'differs', files: [a.id, b.id], message: `${label(a)} and ${label(b)} differ` });
    }
    contents.push(b);
  }
  for (const f of [...files, global]) {
    if (f.kind === 'broken-symlink') findings.push({ kind: 'broken', files: [f.id], message: `${label(f)} is a broken symlink (-> ${f.target})` });
  }
  return { project, files, global, pairs, findings };
}

const label = (f) => (f.id === GLOBAL_ID ? '~/.claude/CLAUDE.md' : f.id);

/** `global`, `~/.claude/CLAUDE.md` or one of INSTRUCTION_FILES (a leading `./` is dropped) -> id. */
export function instructionId(name) {
  const n = String(name ?? '').replace(/^\.\//, '');
  if (n === GLOBAL_ID || n === '~/.claude/CLAUDE.md') return GLOBAL_ID;
  if (INSTRUCTION_FILES.includes(n)) return n;
  throw new SkmError('invalid', `unknown instruction file: ${JSON.stringify(name)} (use one of ${[...INSTRUCTION_FILES, GLOBAL_ID].join(', ')})`);
}

/**
 * Line diff between two instruction files (old = a, new = b). Same shape as diffTrees, so the CLI and the UI render
 * it like a skill diff: { a, b, project, relation, stats, files: [{ path, status, binary, hunks }] }; no files when
 * they are the same (or one links to the other).
 */
export function diffInstructions(opts, a, b, root) {
  const ctx = resolveContext(opts);
  const project = projectOf(ctx, root);
  const pick = (name) => {
    const id = instructionId(name);
    if (id !== GLOBAL_ID && !project) throw new SkmError('no-project', 'no project detected from the current directory');
    const f = id === GLOBAL_ID ? inspect(id, 'global', globalFile(ctx)) : inspect(id, 'project', path.join(project.root, id));
    if (!readable(f)) throw new SkmError('not-found', `${label(f)} ${f.kind === 'broken-symlink' ? 'is a broken symlink' : 'does not exist'}: ${f.path}`);
    return f;
  };
  const x = pick(a);
  const y = pick(b);
  if (x.id === y.id) throw new SkmError('invalid', 'pick two different instruction files');
  const relation = relationOf(x, y);
  const stats = { added: 0, removed: 0, modified: 0, insertions: 0, deletions: 0 };
  const files = [];
  if (relation === 'differs') {
    const d = diffLines(fs.readFileSync(x.real, 'utf8'), fs.readFileSync(y.real, 'utf8'));
    stats.modified = 1;
    stats.insertions = d.insertions;
    stats.deletions = d.deletions;
    files.push({ path: `${label(x)} -> ${label(y)}`, status: 'modified', binary: false, hunks: d.hunks });
  }
  return { a: { id: x.id, path: x.path }, b: { id: y.id, path: y.path }, project, relation, stats, files };
}
