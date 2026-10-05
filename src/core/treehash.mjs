import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', '.DS_Store']);

const gitHash = (type, body) =>
  crypto.createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest();

/** Raw 20-byte tree hash of `dir`, or null when it holds nothing git would store (git has no empty trees). */
function tree(dir) {
  const entries = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue;
    const abs = path.join(dir, d.name);
    let mode;
    let sha;
    if (d.isSymbolicLink()) {
      mode = '120000';
      sha = gitHash('blob', Buffer.from(fs.readlinkSync(abs)));
    } else if (d.isDirectory()) {
      mode = '40000';
      sha = tree(abs);
      if (!sha) continue;
    } else if (d.isFile()) {
      mode = fs.statSync(abs).mode & 0o100 ? '100755' : '100644';
      sha = gitHash('blob', fs.readFileSync(abs));
    } else continue;
    // git sorts entries bytewise, comparing a directory as `name/`.
    entries.push({ key: Buffer.from(mode === '40000' ? `${d.name}/` : d.name), head: Buffer.from(`${mode} ${d.name}\0`), sha });
  }
  if (!entries.length) return null;
  entries.sort((x, y) => Buffer.compare(x.key, y.key));
  return gitHash('tree', Buffer.concat(entries.flatMap((e) => [e.head, e.sha])));
}

/** The git tree SHA (hex) of a folder, as `git rev-parse HEAD:<dir>` would give for the same content. */
export function gitTreeHash(dir) {
  const sha = tree(dir);
  return (sha ?? gitHash('tree', Buffer.alloc(0))).toString('hex');
}
