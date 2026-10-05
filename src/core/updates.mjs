import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveContext, SkmError } from './context.mjs';
import { moveSync } from './fsutil.mjs';
import { lockEntry, readLock, writeLock } from './lock.mjs';
import { locate, scanScope } from './scan.mjs';
import { trashSync, trashTarget } from './trash.mjs';
import { gitTreeHash } from './treehash.mjs';

const API = 'https://api.github.com';

// ---- injectable edges ----------------------------------------------------

/** GITHUB_TOKEN / GH_TOKEN, else `gh auth token` when gh exists, else anonymous (null). */
export function defaultToken(env = process.env) {
  const t = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (t) return t;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Default git runner: git(args, { cwd }) -> stdout. Throws on a non-zero exit. */
export function defaultGit(args, { cwd } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

// ---- remote check --------------------------------------------------------

/** Folder of a skill inside its repo: skills/foo/SKILL.md -> skills/foo ('' = repo root). */
const folderOf = (skillPath) => {
  const d = path.posix.dirname(String(skillPath));
  return d === '.' ? '' : d;
};

async function githubJson(ctx, url, token) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'skm', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await ctx.fetch(url, { headers });
  } catch (err) {
    throw new Error(`network error: ${err?.cause?.code ?? err?.message ?? err}`);
  }
  if (res.ok) return res.json();
  const limited = res.status === 429 || (res.status === 403 && res.headers?.get?.('x-ratelimit-remaining') === '0');
  if (limited) throw new Error('rate limited');
  if (res.status === 404) throw new Error('repository not found (or private without a token)');
  throw new Error(`GitHub API ${res.status}`);
}

/**
 * Remote check of every installed global skill that has a GitHub lock entry. One repo call and one
 * tree call per distinct repo. Returns { checkedAt, results: { <name>: { status, remoteHash?, error? } } }.
 */
export async function checkUpdates(opts = {}) {
  const ctx = resolveContext(opts);
  const lock = readLock(ctx.home);
  const results = {};
  const byRepo = new Map();
  for (const s of lock ? scanScope(ctx, 'global') : []) {
    const e = lockEntry(lock, s.name);
    if (!e || e.sourceType !== 'github' || !e.source || !e.skillPath) continue;
    if (!byRepo.has(e.source)) byRepo.set(e.source, []);
    byRepo.get(e.source).push({ name: s.name, entry: e });
  }
  if (byRepo.size) {
    let token = null;
    try {
      token = await (ctx.token ?? defaultToken)();
    } catch {}
    for (const [repo, skills] of byRepo) {
      let tree;
      try {
        const info = await githubJson(ctx, `${API}/repos/${repo}`, token);
        tree = await githubJson(ctx, `${API}/repos/${repo}/git/trees/${encodeURIComponent(info.default_branch)}?recursive=1`, token);
      } catch (err) {
        for (const { name } of skills) results[name] = { status: 'unreachable', error: err.message };
        continue;
      }
      const hashes = new Map((tree.tree ?? []).filter((t) => t.type === 'tree').map((t) => [t.path, t.sha]));
      if (tree.sha) hashes.set('', tree.sha);
      for (const { name, entry } of skills) {
        const remoteHash = hashes.get(folderOf(entry.skillPath));
        if (remoteHash) results[name] = { status: remoteHash === entry.skillFolderHash ? 'up-to-date' : 'update-available', remoteHash };
        else if (tree.truncated) results[name] = { status: 'unreachable', error: 'repository tree too large to check' };
        else results[name] = { status: 'removed-upstream' };
      }
    }
  }
  return { checkedAt: (ctx.now ?? new Date()).toISOString(), results };
}

// ---- update --------------------------------------------------------------

/** Update one global skill from its source repo. Same result shape as the other actions. */
export function updateSkill(opts, { name, force = false, dryRun = false }) {
  const ctx = resolveContext(opts);
  const lock = readLock(ctx.home);
  const entry = lockEntry(lock, name);
  const l = locate(ctx, 'global', name);
  const dir = [l.a, l.ia, l.c].find((x) => x?.kind === 'dir');
  if (!l.a && !l.ia && !l.c) throw new SkmError('not-found', `skill not found: global/${name}`);
  if (!entry || entry.sourceType !== 'github' || !entry.sourceUrl || !entry.skillPath) {
    throw new SkmError('not-tracked', `${name} has no GitHub source in the skills lock file`);
  }
  if (!dir || dir.path === l.c?.path) throw new SkmError('invalid', `${name} is not a real folder in the agents store; run normalize first`);
  const modified = gitTreeHash(dir.path) !== entry.skillFolderHash;
  if (modified && !force) throw new SkmError('modified', `${name} was modified locally; pass force to overwrite it`);

  const git = ctx.git ?? defaultGit;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-update-'));
  try {
    const clone = path.join(tmp, 'repo');
    try {
      git(['clone', '--depth', '1', entry.sourceUrl, clone]);
    } catch (err) {
      throw new SkmError('network', `could not clone ${entry.sourceUrl}: ${String(err.stderr || err.message).trim().split('\n').pop()}`);
    }
    const folder = folderOf(entry.skillPath);
    const src = path.join(clone, folder);
    if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory()) {
      throw new SkmError('removed-upstream', `${folder || 'the skill folder'} no longer exists in ${entry.source}`);
    }
    const newHash = git(['rev-parse', folder ? `HEAD:${folder}` : 'HEAD^{tree}'], { cwd: clone }).trim();
    if (newHash === entry.skillFolderHash && !modified) {
      return { ok: true, message: `${dryRun ? 'dry run: ' : ''}${name} is already up to date`, changes: [] };
    }

    const target = trashTarget(dir.path, { home: ctx.home, platform: ctx.platform, now: ctx.now ?? new Date() });
    const changes = [`trash ${dir.path} -> ${target.dest}`, `copy ${src} -> ${dir.path}`, `lock ${name}: skillFolderHash ${entry.skillFolderHash} -> ${newHash}`];
    const message = `updated global/${name} from ${entry.source}; the old version is in the system Trash (${target.dest})`;
    if (dryRun) return { ok: true, message: `dry run: ${message}`, changes };

    trashSync(dir.path, target);
    fs.cpSync(src, dir.path, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(path.join(dir.path, '.git'), { recursive: true, force: true });
    entry.skillFolderHash = newHash;
    entry.updatedAt = (ctx.now ?? new Date()).toISOString();
    writeLock(ctx.home, lock);
    return { ok: true, message, changes };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- upstream clone (shared with diff) -----------------------------------

/**
 * Shallow-clone `entry.sourceUrl` into a temp dir, call `fn({ src, newHash, folder })` with the skill folder
 * of the clone, and always clean the temp dir. Throws `network` / `removed-upstream` like update does.
 */
export async function withUpstream(ctx, entry, fn) {
  const git = ctx.git ?? defaultGit;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-upstream-'));
  try {
    const clone = path.join(tmp, 'repo');
    try {
      git(['clone', '--depth', '1', entry.sourceUrl, clone]);
    } catch (err) {
      throw new SkmError('network', `could not clone ${entry.sourceUrl}: ${String(err.stderr || err.message).trim().split('\n').pop()}`);
    }
    const folder = folderOf(entry.skillPath);
    const src = path.join(clone, folder);
    if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory()) {
      throw new SkmError('removed-upstream', `${folder || 'the skill folder'} no longer exists in ${entry.source}`);
    }
    const newHash = git(['rev-parse', folder ? `HEAD:${folder}` : 'HEAD^{tree}'], { cwd: clone }).trim();
    return await fn({ src, newHash, folder });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
