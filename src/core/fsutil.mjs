import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SKIP_FILES = new Set(['.DS_Store']);

/** Describe a path without following it blindly. Returns null for missing / non-directory entries. */
export function inspect(p) {
  const l = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!l) return null;
  if (l.isSymbolicLink()) {
    const target = fs.readlinkSync(p);
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) return { kind: 'broken-symlink', path: p, target, real: null };
    if (!st.isDirectory()) return null;
    return { kind: 'symlink', path: p, target, real: fs.realpathSync(p) };
  }
  if (l.isDirectory()) return { kind: 'dir', path: p, real: fs.realpathSync(p) };
  return null;
}

/** Every entry below dir (no symlink following): [{ rel, abs, stat }], sorted by rel. */
export function walk(dir) {
  const out = [];
  const rec = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_FILES.has(d.name)) continue;
      const a = path.join(abs, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      const stat = fs.lstatSync(a);
      out.push({ rel: r, abs: a, stat });
      if (stat.isDirectory()) rec(a, r);
    }
  };
  rec(dir, '');
  return out.sort((x, y) => (x.rel < y.rel ? -1 : 1));
}

export function dirHash(dir) {
  const h = crypto.createHash('sha256');
  for (const e of walk(dir)) {
    h.update(`${e.rel}\0`);
    if (e.stat.isSymbolicLink()) h.update(`link:${fs.readlinkSync(e.abs)}`);
    else if (e.stat.isFile()) h.update(fs.readFileSync(e.abs));
    else h.update('dir');
    h.update('\0');
  }
  return h.digest('hex');
}

export function moveSync(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export function parseDescription(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return '';
  const first = lines[i].replace(/^description:\s*/, '').trim();
  const rest = [];
  for (let j = i + 1; j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === ''); j++) {
    rest.push(lines[j].trim());
  }
  let text;
  if (/^[>|][+-]?$/.test(first)) text = rest.join(' ');
  else text = [first, ...rest].join(' ');
  text = text.replace(/\s+/g, ' ').trim();
  const q = text.match(/^(["'])(.*)\1$/);
  return q ? q[2] : text;
}
