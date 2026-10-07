import fs from 'node:fs';
import path from 'node:path';
import { assertName, resolveContext, SkmError } from './context.mjs';
import { walk } from './fsutil.mjs';
import { lockEntry, readLock } from './lock.mjs';
import { globalSource, locate, localFolders } from './scan.mjs';
import { gitTreeHash } from './treehash.mjs';
import { withUpstream } from './updates.mjs';

const CONTEXT = 3;

/** Split text into lines (a trailing newline does not add an empty last line). */
const toLines = (text) => {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Myers O(ND) shortest edit script: [{ op: ' '|'-'|'+', line }]. */
function edits(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ha = a.length;
  let hb = b.length;
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) {
    ha--;
    hb--;
  }
  const A = a.slice(lo, ha);
  const B = b.slice(lo, hb);
  const n = A.length;
  const m = B.length;
  const max = n + m;
  const off = max;
  const trace = [];
  let v = new Array(2 * max + 2).fill(0);
  let found = n + m === 0 ? 0 : -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  const mid = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && pv[off + k - 1] < pv[off + k + 1]) ? k + 1 : k - 1;
    const px = pv[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) {
      x--;
      y--;
      mid.push({ op: ' ', line: A[x] });
    }
    if (x === px) mid.push({ op: '+', line: B[--y] });
    else mid.push({ op: '-', line: A[--x] });
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    mid.push({ op: ' ', line: A[x] });
  }
  mid.reverse();
  return [
    ...a.slice(0, lo).map((line) => ({ op: ' ', line })),
    ...mid,
    ...a.slice(ha).map((line) => ({ op: ' ', line })),
  ];
}

/**
 * Line diff of two texts with 3 lines of context.
 * Returns { insertions, deletions, hunks: [{ oldStart, oldLines, newStart, newLines, lines: [" ctx", "-old", "+new"] }] }.
 */
export function diffLines(oldText, newText) {
  const ops = edits(toLines(oldText), toLines(newText));
  const changed = [];
  ops.forEach((o, i) => o.op !== ' ' && changed.push(i));
  const hunks = [];
  let insertions = 0;
  let deletions = 0;
  for (const o of ops) {
    if (o.op === '+') insertions++;
    else if (o.op === '-') deletions++;
  }
  // Line numbers (1-based) of every op in old and new.
  const oldAt = [];
  const newAt = [];
  let oi = 0;
  let ni = 0;
  for (const o of ops) {
    oldAt.push(oi + 1);
    newAt.push(ni + 1);
    if (o.op !== '+') oi++;
    if (o.op !== '-') ni++;
  }
  let i = 0;
  while (i < changed.length) {
    let from = changed[i];
    let to = changed[i];
    while (i + 1 < changed.length && changed[i + 1] - to <= 2 * CONTEXT) to = changed[++i];
    i++;
    from = Math.max(0, from - CONTEXT);
    to = Math.min(ops.length - 1, to + CONTEXT);
    const slice = ops.slice(from, to + 1);
    const oldLines = slice.filter((o) => o.op !== '+').length;
    const newLines = slice.filter((o) => o.op !== '-').length;
    hunks.push({
      oldStart: oldLines ? oldAt[from] : oldAt[from] - 1,
      oldLines,
      newStart: newLines ? newAt[from] : newAt[from] - 1,
      newLines,
      lines: slice.map((o) => o.op + o.line),
    });
  }
  return { insertions, deletions, hunks };
}

// ---- directory trees -----------------------------------------------------

/** Files of a folder: Map<rel, Buffer> (symlinks are their target text). `.git` is ignored. */
function readTree(dir) {
  const files = new Map();
  for (const e of walk(dir)) {
    if (e.rel === '.git' || e.rel.startsWith('.git/')) continue;
    if (e.stat.isSymbolicLink()) files.set(e.rel, Buffer.from(fs.readlinkSync(e.abs)));
    else if (e.stat.isFile()) files.set(e.rel, fs.readFileSync(e.abs));
  }
  return files;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Diff two folders (old -> new): { stats, files: [{ path, status, binary, hunks }] }, files sorted by path. */
export function diffTrees(oldDir, newDir) {
  const a = readTree(oldDir);
  const b = readTree(newDir);
  const files = [];
  const stats = { added: 0, removed: 0, modified: 0, insertions: 0, deletions: 0 };
  for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(p);
    const y = b.get(p);
    if (x && y && x.equals(y)) continue;
    const status = !x ? 'added' : !y ? 'removed' : 'modified';
    const binary = isBinary(x ?? Buffer.alloc(0)) || isBinary(y ?? Buffer.alloc(0));
    const file = { path: p, status, binary, hunks: [] };
    if (!binary) {
      const d = diffLines(x ? x.toString('utf8') : '', y ? y.toString('utf8') : '');
      file.hunks = d.hunks;
      stats.insertions += d.insertions;
      stats.deletions += d.deletions;
    }
    stats[status]++;
    files.push(file);
  }
  return { stats, files };
}

/** One-line summary: "2 modified, 1 added, 0 removed (+40 -12)". */
export const statLine = (s) => `${s.modified} modified, ${s.added} added, ${s.removed} removed (+${s.insertions} -${s.deletions})`;

// ---- installed -> upstream -----------------------------------------------

/** Diff the installed global skill against its upstream folder (same clone logic as update). */
export async function diffUpstream(opts, name) {
  const ctx = resolveContext(opts);
  assertName(name);
  const entry = lockEntry(readLock(ctx.home), name);
  const l = locate(ctx, 'global', name);
  if (!l.a && !l.ia && !l.c) throw new SkmError('not-found', `skill not found: global/${name}`);
  if (!entry || entry.sourceType !== 'github' || !entry.sourceUrl || !entry.skillPath) {
    throw new SkmError('not-tracked', `${name} has no GitHub source in the skills lock file`);
  }
  const dir = [l.a, l.ia, l.c].find((x) => x?.real)?.real;
  if (!dir) throw new SkmError('invalid', `${name} has no readable folder`);
  return withUpstream(ctx, entry, ({ src, newHash }) => ({
    name,
    from: gitTreeHash(dir).slice(0, 7),
    to: newHash.slice(0, 7),
    ...diffTrees(dir, src),
  }));
}

// ---- local -> global -----------------------------------------------------

/**
 * Diff a local skill against the global copy (old = local, new = global: what a refresh would do, so local edits
 * show as removals). The global skill may be inactive. With two local folders, the first one that differs is shown.
 */
export function diffLocal(opts, name) {
  const ctx = resolveContext(opts);
  assertName(name);
  if (!ctx.project) throw new SkmError('no-project', 'no project detected from the current directory');
  const src = globalSource(ctx, name);
  if (!src) throw new SkmError('not-found', `no global skill: ${name}`);
  const dirs = localFolders(ctx, name);
  if (!dirs.length) throw new SkmError('not-found', `no local skill folder: ${name}`);
  const diffs = dirs.map((d) => ({ local: d.path, ...diffTrees(d.path, src.real) }));
  const d = diffs.find((x) => x.files.length) ?? diffs[0];
  return { name, from: 'local', to: 'global', local: d.local, global: src.real, stats: d.stats, files: d.files };
}
