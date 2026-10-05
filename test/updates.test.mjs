import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkUpdates, getState, gitTreeHash, readLock, runAction, SkmError, writeLock, lockPath } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { link, mkSkill, tmp, write } from './fixture.mjs';

const supported = ['darwin', 'linux'].includes(process.platform);
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

function gitRepo(files) {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, content] of Object.entries(files)) write(path.join(dir, f), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// ---- tree hash -----------------------------------------------------------

test('gitTreeHash matches git for files, nested dirs, modes, symlinks and tricky ordering', () => {
  const repo = gitRepo({ 'seed.txt': 'x' });
  const dir = path.join(repo, 'skills', 'demo');
  write(path.join(dir, 'SKILL.md'), '---\nname: demo\n---\n');
  write(path.join(dir, 'a.txt'), 'a\n');
  write(path.join(dir, 'a-b.txt'), 'dash\n'); // sorts between `a` and `a/` entries
  write(path.join(dir, 'a', 'inner.md'), 'in\n');
  write(path.join(dir, 'a.b', 'x'), 'dot\n');
  write(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, 'scripts', 'run.sh'), 0o755);
  write(path.join(dir, 'empty.txt'), '');
  fs.symlinkSync('SKILL.md', path.join(dir, 'link.md'));
  fs.mkdirSync(path.join(dir, 'emptydir'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'demo');
  write(path.join(dir, '.DS_Store'), 'junk'); // untracked and skipped by skm
  assert.equal(gitTreeHash(dir), git(repo, 'rev-parse', 'HEAD:skills/demo'));
  assert.equal(gitTreeHash(path.join(dir, 'a')), git(repo, 'rev-parse', 'HEAD:skills/demo/a'));
});

// ---- lock ----------------------------------------------------------------

test('lock round trip keeps unknown fields, other skills and the indentation', () => {
  for (const indent of ['  ', '    ', '\t']) {
    const home = tmp();
    const doc = { version: 3, skills: { foo: { source: 'o/r', extra: { deep: [1, 2] } }, bar: { source: 'o/q' } }, dismissed: { x: true }, lastSelectedAgents: ['claude-code'] };
    write(lockPath(home), JSON.stringify(doc, null, indent) + '\n');
    const lock = readLock(home);
    assert.equal(lock.indent, indent);
    lock.data.skills.foo.updatedAt = 'now';
    writeLock(home, lock);
    const raw = fs.readFileSync(lockPath(home), 'utf8');
    assert.equal(raw, JSON.stringify({ ...doc, skills: { ...doc.skills, foo: { ...doc.skills.foo, updatedAt: 'now' } } }, null, indent) + '\n');
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath(home))), ['.skill-lock.json']); // no temp file left
  }
});

test('missing or invalid lock means no provenance', () => {
  const home = tmp();
  assert.equal(readLock(home), null);
  write(lockPath(home), '{ nope');
  assert.equal(readLock(home), null);
  write(lockPath(home), '[]');
  assert.equal(readLock(home), null);
  assert.equal(getState({ home, cwd: home }).global.length, 0);
});

// ---- origin in scan ------------------------------------------------------

/** A home with skills installed from a lock, hashes computed from the local folders. */
function lockedHome(entries, extraLock = {}) {
  const home = tmp();
  const ag = path.join(home, '.agents', 'skills');
  const skills = {};
  for (const [name, e] of Object.entries(entries)) {
    if (e.installed !== false) {
      mkSkill(e.inactive ? path.join(home, '.agents', 'skills-inactive') : ag, name, { extra: e.extra });
      if (!e.inactive) link(`../../.agents/skills/${name}`, path.join(home, '.claude', 'skills', name));
    }
    skills[name] = {
      source: e.source ?? 'o/r',
      sourceType: e.sourceType ?? 'github',
      sourceUrl: e.sourceUrl ?? `https://github.com/${e.source ?? 'o/r'}.git`,
      skillPath: e.skillPath ?? `skills/${name}/SKILL.md`,
      skillFolderHash: e.hash ?? (e.installed === false ? 'f'.repeat(40) : gitTreeHash(path.join(e.inactive ? path.join(home, '.agents', 'skills-inactive') : ag, name))),
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }
  write(lockPath(home), JSON.stringify({ version: 3, skills, dismissed: {}, ...extraLock }, null, 2) + '\n');
  return home;
}

test('scan: origin only for tracked global skills, modified from the local hash, lock entries of absent skills ignored', () => {
  const home = lockedHome({ tracked: {}, edited: {}, ghost: { installed: false } });
  mkSkill(path.join(home, '.agents', 'skills'), 'untracked');
  write(path.join(home, '.agents', 'skills', 'edited', 'new.md'), 'local change');
  const proj = tmp();
  fs.mkdirSync(path.join(proj, '.git'));
  mkSkill(path.join(proj, '.claude', 'skills'), 'tracked');
  const st = getState({ home, cwd: proj });
  const by = (n) => st.global.find((s) => s.name === n);
  assert.deepEqual(by('tracked').origin, {
    source: 'o/r', url: 'https://github.com/o/r.git', skillPath: 'skills/tracked/SKILL.md',
    installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', modified: false,
  });
  assert.equal(by('edited').origin.modified, true);
  assert.equal(by('untracked').origin, null);
  assert.equal(by('ghost'), undefined);
  assert.equal(st.local.find((s) => s.name === 'tracked').origin, null);
});

// ---- remote check --------------------------------------------------------

const json = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body });

function fakeGitHub(repos, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const m = /repos\/([^/]+\/[^/?]+)(\/git\/trees\/([^?]+))?/.exec(url);
    const repo = repos[m[1]];
    if (repo === 'down') throw new TypeError('fetch failed');
    if (repo === 'limited') return json({}, 403, { 'x-ratelimit-remaining': '0' });
    if (!repo) return json({}, 404);
    if (!m[2]) return json({ default_branch: 'trunk' });
    assert.equal(m[3], 'trunk');
    return json({ sha: 'roothash', truncated: false, tree: Object.entries(repo).map(([p, sha]) => ({ path: p, type: 'tree', sha })) });
  };
}

test('check: statuses, one repo+tree call per repo, token sent, absent lock entries ignored', async () => {
  const home = lockedHome({
    same: { hash: 'a'.repeat(40) },
    newer: { hash: 'b'.repeat(40) },
    gone: {},
    renamed: { source: 'o/r' },
    off: { source: 'o/down' },
    lim: { source: 'o/limited' },
    missing: { source: 'o/none' },
    npm: { sourceType: 'npm' },
    ghost: { installed: false },
  });
  const calls = [];
  const fetch = fakeGitHub({
    'o/r': { 'skills/same': 'a'.repeat(40), 'skills/newer': 'c'.repeat(40) },
    'o/down': 'down', 'o/limited': 'limited',
  }, calls);
  const { checkedAt, results } = await checkUpdates({ home, cwd: home, fetch, token: () => 'tok123', now: new Date('2026-10-05T20:00:00Z') });
  assert.equal(checkedAt, '2026-10-05T20:00:00.000Z');
  assert.deepEqual(results.same, { status: 'up-to-date', remoteHash: 'a'.repeat(40) });
  assert.deepEqual(results.newer, { status: 'update-available', remoteHash: 'c'.repeat(40) });
  assert.deepEqual(results.gone, { status: 'removed-upstream' });
  assert.deepEqual(results.renamed, { status: 'removed-upstream' });
  assert.equal(results.off.status, 'unreachable');
  assert.match(results.off.error, /network error/);
  assert.deepEqual(results.lim, { status: 'unreachable', error: 'rate limited' });
  assert.equal(results.missing.status, 'unreachable');
  assert.equal(results.npm, undefined);
  assert.equal(results.ghost, undefined);
  const forRepo = calls.filter((c) => c.url.includes('/repos/o/r'));
  assert.equal(forRepo.length, 2); // 1 repo + 1 tree for 4 skills
  assert.equal(forRepo[0].init.headers.authorization, 'Bearer tok123');
});

test('check: anonymous without a token; no lock means no calls', async () => {
  const home = lockedHome({ a: { hash: 'a'.repeat(40) } });
  const calls = [];
  await checkUpdates({ home, fetch: fakeGitHub({ 'o/r': { 'skills/a': 'a'.repeat(40) } }, calls), token: () => null });
  assert.equal(calls[0].init.headers.authorization, undefined);
  const empty = tmp();
  const none = [];
  const r = await checkUpdates({ home: empty, fetch: fakeGitHub({}, none), token: () => null });
  assert.deepEqual(r.results, {});
  assert.equal(none.length, 0);
});

test('GET /api/updates uses the injected fetch', async () => {
  const home = lockedHome({ a: { hash: 'a'.repeat(40) }, b: { hash: 'b'.repeat(40) } });
  const srv = await startServer({ home, cwd: home, port: 0, token: () => null, fetch: fakeGitHub({ 'o/r': { 'skills/a': 'a'.repeat(40), 'skills/b': 'z'.repeat(40) } }) });
  try {
    const res = await fetch(`${srv.url}/api/updates`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.fromEntries(Object.entries(body.results).map(([k, v]) => [k, v.status])), { a: 'up-to-date', b: 'update-available' });
    assert.ok(body.checkedAt);
  } finally {
    await srv.close();
  }
});

// ---- update end to end (local file:// repo, temp home) -------------------

function updateFixture({ inactive = false } = {}) {
  const repo = gitRepo({ 'skills/demo/SKILL.md': '---\nname: demo\ndescription: v1\n---\n', 'skills/demo/old.txt': 'old\n', 'README.md': 'r' });
  const home = lockedHome({ demo: { source: 'o/demo', sourceUrl: `file://${repo}`, inactive, extra: { 'old.txt': 'old\n' } } });
  const upstream = () => {
    write(path.join(repo, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: v2\n---\n');
    fs.rmSync(path.join(repo, 'skills/demo/old.txt'));
    write(path.join(repo, 'skills/demo/new.txt'), 'new\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'v2');
  };
  const opts = { home, cwd: home, now: new Date('2026-10-05T21:00:00Z') };
  const base = inactive ? path.join(home, '.agents', 'skills-inactive') : path.join(home, '.agents', 'skills');
  return { repo, home, upstream, opts, dir: path.join(base, 'demo') };
}
const lockOf = (home) => readLock(home).data.skills.demo;
const trashDir = (home) => (process.platform === 'darwin' ? path.join(home, '.Trash') : path.join(home, '.local', 'share', 'Trash', 'files'));
const update = (opts, extra = {}) => runAction(opts, { action: 'update', scope: 'global', name: 'demo', ...extra });

test('update: trashes the old folder, puts the new files in place, updates the lock', { skip: !supported }, () => {
  const f = updateFixture();
  f.upstream();
  const before = lockOf(f.home);
  const r = update(f.opts);
  assert.equal(r.ok, true);
  assert.match(r.message, /system Trash/);
  assert.equal(r.changes.length, 3);
  assert.match(fs.readFileSync(path.join(f.dir, 'SKILL.md'), 'utf8'), /v2/);
  assert.ok(fs.existsSync(path.join(f.dir, 'new.txt')));
  assert.equal(fs.existsSync(path.join(f.dir, 'old.txt')), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.git')), false);
  assert.ok(fs.existsSync(path.join(trashDir(f.home), 'demo', 'old.txt'))); // old version in the temp home Trash
  const after = lockOf(f.home);
  assert.equal(after.skillFolderHash, git(f.repo, 'rev-parse', 'HEAD:skills/demo'));
  assert.equal(after.skillFolderHash, gitTreeHash(f.dir));
  assert.notEqual(after.skillFolderHash, before.skillFolderHash);
  assert.equal(after.updatedAt, '2026-10-05T21:00:00.000Z');
  assert.equal(after.installedAt, before.installedAt);
  assert.ok(fs.lstatSync(path.join(f.home, '.claude', 'skills', 'demo')).isSymbolicLink()); // symlink untouched
  assert.equal(getState(f.opts).global[0].origin.modified, false);
  assert.match(update(f.opts).message, /already up to date/);
});

test('update: dryRun lists changes and writes nothing', { skip: !supported }, () => {
  const f = updateFixture();
  f.upstream();
  const lockBefore = fs.readFileSync(lockPath(f.home), 'utf8');
  const r = update(f.opts, { dryRun: true });
  assert.match(r.message, /^dry run:/);
  assert.equal(r.changes.length, 3);
  assert.ok(fs.existsSync(path.join(f.dir, 'old.txt')));
  assert.equal(fs.existsSync(trashDir(f.home)), false);
  assert.equal(fs.readFileSync(lockPath(f.home), 'utf8'), lockBefore);
});

test('update: refuses a modified skill unless force', { skip: !supported }, () => {
  const f = updateFixture();
  f.upstream();
  write(path.join(f.dir, 'mine.txt'), 'local work');
  assert.throws(() => update(f.opts), (e) => e instanceof SkmError && e.code === 'modified');
  assert.ok(fs.existsSync(path.join(f.dir, 'mine.txt')));
  assert.throws(() => update(f.opts, { dryRun: true }), (e) => e.code === 'modified');
  update(f.opts, { force: true });
  assert.equal(fs.existsSync(path.join(f.dir, 'mine.txt')), false);
  assert.ok(fs.existsSync(path.join(trashDir(f.home), 'demo', 'mine.txt')));
  assert.equal(lockOf(f.home).skillFolderHash, gitTreeHash(f.dir));
});

test('update: an inactive skill is updated where it lives', { skip: !supported }, () => {
  const f = updateFixture({ inactive: true });
  f.upstream();
  update(f.opts);
  assert.ok(fs.existsSync(path.join(f.dir, 'new.txt')));
  assert.equal(fs.existsSync(path.join(f.home, '.agents', 'skills', 'demo')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.claude', 'skills', 'demo')), false);
});

test('update: documented errors and untouched unknown lock fields', { skip: !supported }, () => {
  const f = updateFixture();
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } };
  assert.equal(code(() => runAction(f.opts, { action: 'update', scope: 'global', name: 'nope' })), 'not-found');
  mkSkill(path.join(f.home, '.agents', 'skills'), 'plain');
  assert.equal(code(() => runAction(f.opts, { action: 'update', scope: 'global', name: 'plain' })), 'not-tracked');
  assert.equal(code(() => runAction(f.opts, { action: 'update', scope: 'local', name: 'demo' })), 'invalid');
  // folder removed upstream
  git(f.repo, 'rm', '-q', '-r', 'skills/demo');
  git(f.repo, 'commit', '-q', '-m', 'rm');
  assert.equal(code(() => update(f.opts)), 'removed-upstream');
  assert.ok(fs.existsSync(f.dir));
  // clone failure
  const bad = { ...f.opts, git: () => { throw Object.assign(new Error('x'), { stderr: 'fatal: unable to access' }); } };
  assert.equal(code(() => update(bad)), 'network');
});

test('update preserves unknown lock fields and indentation', { skip: !supported }, () => {
  const f = updateFixture();
  f.upstream();
  const doc = JSON.parse(fs.readFileSync(lockPath(f.home), 'utf8'));
  doc.lastSelectedAgents = ['claude-code'];
  doc.skills.demo.pluginName = 'p';
  write(lockPath(f.home), JSON.stringify(doc, null, '\t'));
  update(f.opts);
  const raw = fs.readFileSync(lockPath(f.home), 'utf8');
  assert.match(raw, /^\{\n\t"version"/);
  assert.equal(raw.endsWith('\n'), false);
  const out = JSON.parse(raw);
  assert.deepEqual(out.lastSelectedAgents, ['claude-code']);
  assert.equal(out.skills.demo.pluginName, 'p');
});

test('POST /api/action update: force, modified error, dryRun', { skip: !supported }, async () => {
  const f = updateFixture();
  f.upstream();
  write(path.join(f.dir, 'mine.txt'), 'x');
  const srv = await startServer({ ...f.opts, port: 0 });
  const post = async (body) => {
    const res = await fetch(`${srv.url}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const mod = await post({ action: 'update', scope: 'global', name: 'demo' });
    assert.equal(mod.status, 409);
    assert.deepEqual([mod.body.ok, mod.body.code], [false, 'modified']);
    const dry = await post({ action: 'update', scope: 'global', name: 'demo', force: true, dryRun: true });
    assert.equal(dry.body.ok, true);
    assert.ok(fs.existsSync(path.join(f.dir, 'mine.txt')));
    const real = await post({ action: 'update', scope: 'global', name: 'demo', force: true });
    assert.equal(real.body.ok, true);
    assert.ok(fs.existsSync(path.join(f.dir, 'new.txt')));
  } finally {
    await srv.close();
  }
});
