import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GIT_TIMEOUT_MS = 3000;
const README_BYTES = 16 * 1024;
const README_MAX = 200;
export const GIT_CONCURRENCY = 8;

/** Default git runner: git(args, { cwd }) -> Promise<stdout>. Short timeout, never prompts. An injected runner may be sync or async. */
function defaultGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** `mapper(item)` over `items` with at most `limit` running at once; results keep the input order. */
export async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await mapper(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Remote URL -> `host/owner/repo`. Credentials (`user:pass@`, tokens, the scp-style `git@host:` user) and ports never
 * survive; returns null for anything that is not a host + path (local paths, `file://`, garbage).
 */
export function normalizeRemote(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  let host;
  let rest;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)\/(.*)$/i.exec(s);
  if (scheme) {
    if (scheme[1].toLowerCase() === 'file') return null;
    host = scheme[2].replace(/^.*@/, '').replace(/:\d*$/, '');
    rest = scheme[3];
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s@]+):(?!\/\/)(.+)$/.exec(s);
    if (!scp) return null;
    [, host, rest] = scp;
  }
  rest = rest.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  const out = `${host.toLowerCase()}/${rest}`;
  return host && rest && !/[@\s]/.test(out) ? out : null;
}

const DEP_HINTS = [
  ['react', /^react$/],
  ['next', /^next$/],
  ['vue', /^vue$/],
  ['svelte', /^(svelte|@sveltejs\/.+)$/],
  ['vite', /^vite$/],
  ['tailwind', /^(tailwindcss|@tailwindcss\/.+)$/],
  ['typescript', /^typescript$/],
  ['express', /^express$/],
  ['capacitor', /^@capacitor\/core$/],
  ['cordova', /^(cordova|cordova-.+)$/],
];

/** Stack tags from marker files at the top of a project (sorted, de-duplicated). Never throws. */
export function detectStack(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const has = (n) => names.includes(n);
  const ext = (e) => names.some((n) => n.endsWith(e));
  const stack = new Set();
  if (has('package.json')) {
    stack.add('node');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
      for (const [tag, re] of DEP_HINTS) if (deps.some((d) => re.test(d))) stack.add(tag);
    } catch {}
  }
  if (has('components.json')) stack.add('shadcn');
  if (has('pyproject.toml') || has('requirements.txt')) stack.add('python');
  if (has('Cargo.toml')) stack.add('rust');
  if (has('go.mod')) stack.add('go');
  if (has('config.xml') || has('plugin.xml')) stack.add('cordova');
  if (ext('.csproj')) stack.add('dotnet');
  if (has('Package.swift') || ext('.xcodeproj')) stack.add('swift');
  if (has('build.gradle') || has('build.gradle.kts')) stack.add('android');
  if (ext('.oml') || ext('.oap')) stack.add('outsystems');
  return [...stack].sort();
}

const plain = (s) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** First prose paragraph of a README text: no headings, badges, images, HTML, tables or code; markdown stripped; max 200 chars. */
export function readmeParagraph(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  let para = [];
  let fence = false;
  let comment = false;
  const clip = (s) => (s.length > README_MAX ? `${s.slice(0, README_MAX - 1).trimEnd()}…` : s);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (comment) {
      if (l.includes('-->')) comment = false;
      continue;
    }
    if (l.startsWith('<!--')) {
      comment = !l.includes('-->');
      continue;
    }
    const skip = !l || /^#{1,6}(\s|$)/.test(l) || /^!?\[!?\[|^!\[/.test(l) || l.startsWith('<') || l.startsWith('|') || /^=+$/.test(l) || /^([-*_]\s*){3,}$/.test(l) || /^>?\s*\[!\w+\]/.test(l);
    // A setext underline turns the lines above into a heading; any other blank or skipped line ends the paragraph.
    if (/^(=+|-+)$/.test(l) && para.length) {
      para = [];
      continue;
    }
    if (skip) {
      const s = plain(para.join(' '));
      if (s) return clip(s);
      para = [];
      continue;
    }
    para.push(l);
  }
  return clip(plain(para.join(' ')));
}

function readme(dir) {
  try {
    const file = fs.readdirSync(dir).find((n) => n.toLowerCase() === 'readme.md');
    if (!file) return '';
    const fd = fs.openSync(path.join(dir, file), 'r');
    try {
      const buf = Buffer.alloc(README_BYTES);
      return readmeParagraph(buf.subarray(0, fs.readSync(fd, buf, 0, README_BYTES, 0)).toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Auto facts of one project folder (never stored). `ctx.git` is the injectable runner. Every source is best effort:
 * a failure leaves its field absent (`stack` is always an array). Git is only asked when the folder itself has `.git`,
 * so a parent repository is never mistaken for the project.
 */
export async function projectAuto(ctx, dir) {
  const auto = {};
  if (fs.existsSync(path.join(dir, '.git'))) {
    const git = ctx.git ?? defaultGit;
    const run = async (args) => {
      try {
        return String(await git(args, { cwd: dir })).trim();
      } catch {
        return '';
      }
    };
    const [remote, branch, last] = await Promise.all([run(['remote', 'get-url', 'origin']), run(['rev-parse', '--abbrev-ref', 'HEAD']), run(['log', '-1', '--format=%cI'])]);
    const norm = normalizeRemote(remote);
    if (norm) auto.remote = norm;
    if (branch && branch !== 'HEAD') auto.branch = branch;
    const when = last ? new Date(last) : null;
    if (when && !Number.isNaN(when.getTime())) auto.lastCommitAt = when.toISOString();
  }
  auto.stack = detectStack(dir);
  const r = readme(dir);
  if (r) auto.readme = r;
  return auto;
}
