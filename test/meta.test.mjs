import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configPath, getState, readConfig, readMeta, runAction, scanProjects, updateMeta, writeConfig } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { buildHome, buildProject, mkSkill, tmp } from './fixture.mjs';

const rawConfig = (home) => JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
const isDir = (p) => fs.lstatSync(p).isDirectory();

/** Home with inactive skills in agents and claude, plus a project. */
function inactiveSetup() {
  const home = buildHome();
  const root = buildProject(home);
  mkSkill(path.join(home, '.claude', 'skills-inactive'), 'claude-sleepy');
  return { home, root, o: { home, cwd: root, platform: 'darwin' } };
}

// ---- copy from inactive --------------------------------------------------

test('copyToLocal: inactive agents and claude skills are copied as real active folders and stay inactive', () => {
  const { home, root, o } = inactiveSetup();
  const r = runAction(o, { action: 'copyToLocal', scope: 'global', name: 'sleepy' });
  assert.equal(r.ok, true);
  const dest = path.join(root, '.claude', 'skills', 'sleepy');
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  assert.ok(isDir(dest));
  runAction(o, { action: 'copyToLocal', scope: 'global', name: 'claude-sleepy', target: 'agents' });
  assert.ok(isDir(path.join(root, '.agents', 'skills', 'claude-sleepy')));
  // sources untouched, still inactive, nothing activated
  assert.ok(isDir(path.join(home, '.agents', 'skills-inactive', 'sleepy')));
  assert.ok(isDir(path.join(home, '.claude', 'skills-inactive', 'claude-sleepy')));
  assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'sleepy')), false);
  const sleepy = getState(o).global.find((s) => s.name === 'sleepy');
  assert.equal(sleepy.active, false);
  assert.ok(getState(o).local.find((s) => s.name === 'sleepy' && s.active));
});

test('copyToLocal: dry run writes nothing, missing skill says "no global skill", no project still errors', () => {
  const { root, o, home } = inactiveSetup();
  const dry = runAction(o, { action: 'copyToLocal', name: 'sleepy', dryRun: true });
  assert.match(dry.message, /^dry run: /);
  assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'sleepy')), false);
  assert.throws(() => runAction(o, { action: 'copyToLocal', name: 'nope' }), { code: 'not-found', message: 'no global skill: nope' });
  assert.throws(() => runAction({ home, cwd: home }, { action: 'copyToLocal', name: 'sleepy' }), { code: 'no-project' });
  assert.throws(() => runAction({ home, cwd: home }, { action: 'copyToLocal', names: ['sleepy'] }), { code: 'no-project' });
});

test('copyToLocal batch: continues past a failure, per-item results, top-level ok false', () => {
  const { root, o } = inactiveSetup();
  const r = runAction(o, { action: 'copyToLocal', scope: 'global', names: ['sleepy', 'nope', 'unlinked'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.results, [
    { name: 'sleepy', ok: true },
    { name: 'nope', ok: false, error: 'no global skill: nope', code: 'not-found' },
    { name: 'unlinked', ok: true },
  ]);
  assert.equal(r.changes.length, 2);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'sleepy', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'unlinked', 'SKILL.md')));
  // second run: existing items fail with `exists` unless overwrite (which trashes the old copy)
  const again = runAction(o, { action: 'copyToLocal', names: ['sleepy'] });
  assert.deepEqual([again.ok, again.results[0].code], [false, 'exists']);
  const over = runAction(o, { action: 'copyToLocal', names: ['sleepy', 'unlinked'], overwrite: true });
  assert.equal(over.ok, true);
  assert.equal(fs.readdirSync(path.join(o.home, '.Trash')).length, 2);
  assert.throws(() => runAction(o, { action: 'copyToLocal', names: [] }), { code: 'invalid' });
  const bad = runAction(o, { action: 'copyToLocal', names: ['../x', 'dup'], dryRun: true });
  assert.deepEqual(bad.results.map((x) => [x.ok, x.code]), [[false, 'invalid'], [true, undefined]]);
});

// ---- config --------------------------------------------------------------

test('config: writeConfig preserves skills and unknown keys, readConfig shape is unchanged', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'work'));
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  const skills = { good: { favorite: true, tags: ['a'] } };
  fs.writeFileSync(configPath(home), JSON.stringify({ projectRoots: [], scanDepth: 3, future: { x: 1 }, skills }));
  writeConfig({ home }, { projectRoots: ['~/work'] });
  writeConfig({ home }, { scanDepth: 5 });
  assert.deepEqual(rawConfig(home), { projectRoots: ['~/work'], scanDepth: 5, future: { x: 1 }, skills });
  assert.deepEqual(readConfig({ home }), { projectRoots: [path.join(home, 'work')], scanDepth: 5 });
});

// ---- meta ----------------------------------------------------------------

test('meta: tag rules (normalized, validated, sorted, de-duplicated, max 8)', () => {
  const home = buildHome();
  const o = { home, cwd: home };
  assert.deepEqual(updateMeta(o, { name: 'good', addTags: ['SaaS', 'mobile', ' saas ', 'a-1'] }), { favorite: false, tags: ['a-1', 'mobile', 'saas'] });
  for (const bad of ['has space', 'under_score', '', 'x'.repeat(25), 'é', 5]) {
    assert.throws(() => updateMeta(o, { name: 'good', addTags: [bad] }), { code: 'invalid' }, String(bad));
  }
  assert.equal(updateMeta(o, { name: 'good', addTags: ['x'.repeat(24)] }).tags.length, 4);
  assert.throws(() => updateMeta(o, { name: 'good', tags: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }), { code: 'invalid' });
  assert.equal(updateMeta(o, { name: 'good', tags: ['1', '2', '3', '4', '5', '6', '7', '8', '8'] }).tags.length, 8);
  assert.throws(() => updateMeta(o, { name: 'good', addTags: ['9'] }), { code: 'invalid' });
  // replace, then add, then remove
  assert.deepEqual(updateMeta(o, { name: 'good', tags: ['b', 'a'], addTags: ['c'], removeTags: ['a'] }).tags, ['b', 'c']);
  assert.throws(() => updateMeta(o, { name: 'good', favorite: 'yes' }), { code: 'invalid' });
  assert.throws(() => updateMeta(o, { name: 'good', addTags: 'x' }), { code: 'invalid' });
});

test('meta: name must exist (global, local or inactive); typos create nothing', () => {
  const { o, home, root } = inactiveSetup();
  assert.throws(() => updateMeta(o, { name: 'typo', favorite: true }), { code: 'not-found' });
  assert.throws(() => updateMeta(o, { name: '../x', favorite: true }), { code: 'invalid' });
  assert.equal(fs.existsSync(configPath(home)), false);
  for (const name of ['good', 'sleepy', 'claude-sleepy', 'localonly']) assert.equal(updateMeta(o, { name, favorite: true }).favorite, true, name);
  // local names are only valid inside that project
  assert.throws(() => updateMeta({ home, cwd: home }, { name: 'localonly', favorite: true }), { code: 'not-found' });
  assert.ok(root);
});

test('meta: empty entries are pruned, untouched entries and the file stay intact', () => {
  const home = buildHome();
  const o = { home, cwd: home };
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  fs.writeFileSync(configPath(home), JSON.stringify({ scanDepth: 2, skills: { dup: { favorite: true, tags: [] } } }));
  updateMeta(o, { name: 'good', favorite: true, addTags: ['x'] });
  assert.deepEqual(rawConfig(home).skills, { dup: { favorite: true, tags: [] }, good: { favorite: true, tags: ['x'] } });
  updateMeta(o, { name: 'good', favorite: false });
  assert.deepEqual(rawConfig(home).skills.good, { favorite: false, tags: ['x'] });
  updateMeta(o, { name: 'good', removeTags: ['x'] });
  assert.deepEqual(rawConfig(home).skills, { dup: { favorite: true, tags: [] } });
  updateMeta(o, { name: 'dup', favorite: false });
  assert.deepEqual(rawConfig(home), { scanDepth: 2 }); // empty skills object dropped, the rest kept
  // a no-op never creates the file
  const fresh = tmp();
  mkSkill(path.join(fresh, '.agents', 'skills'), 's');
  updateMeta({ home: fresh, cwd: fresh }, { name: 's', favorite: false });
  assert.equal(fs.existsSync(configPath(fresh)), false);
});

test('meta: state and projects carry meta, tags counts and favorites', async () => {
  const { o, home, root } = inactiveSetup();
  updateMeta(o, { name: 'good', favorite: true, addTags: ['saas', 'mobile'] });
  updateMeta(o, { name: 'sleepy', addTags: ['saas'] });
  updateMeta(o, { name: 'localonly', favorite: true });
  updateMeta(o, { name: 'gone', favorite: true }); // exists as a (broken) link on disk
  const st = getState(o);
  assert.deepEqual(st.global.find((s) => s.name === 'good').meta, { favorite: true, tags: ['mobile', 'saas'] });
  assert.deepEqual(st.global.find((s) => s.name === 'unlinked').meta, { favorite: false, tags: [] });
  assert.deepEqual(st.local.find((s) => s.name === 'good').meta.tags, ['mobile', 'saas']); // keyed by name, any scope
  assert.deepEqual(st.tags, [{ tag: 'saas', count: 2 }, { tag: 'mobile', count: 1 }]);
  assert.equal(st.favorites, 3); // good (counted once for both scopes), localonly, gone
  fs.mkdirSync(path.join(home, 'ws'));
  fs.renameSync(root, path.join(home, 'ws', 'p'));
  const scan = await scanProjects(o, { projectRoots: [path.join(home, 'ws')], scanDepth: 2 });
  assert.deepEqual(scan.projects[0].skills.find((s) => s.name === 'localonly').meta, { favorite: true, tags: [] });
  assert.deepEqual(scan.projects[0].skills.find((s) => s.name === 'good').meta.tags, ['mobile', 'saas']);
});

test('meta: malformed stored entries are ignored on read, not fatal', () => {
  const home = buildHome();
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  fs.writeFileSync(configPath(home), JSON.stringify({ skills: { good: { favorite: 'yes', tags: ['ok', 'BAD TAG', 7] }, dup: 3, split: [] } }));
  assert.deepEqual([...readMeta({ home })], [['good', { favorite: false, tags: ['ok'] }]]);
});

// ---- API -----------------------------------------------------------------

let srv;
let h;
let root;
before(async () => {
  h = buildHome();
  root = buildProject(h);
  mkSkill(path.join(h, '.agents', 'skills-inactive'), 'dormant');
  srv = await startServer({ home: h, cwd: root, port: 0 });
});
after(() => srv.close());

const call = async (p, init) => {
  const res = await fetch(srv.url + p, init);
  return { status: res.status, body: await res.json() };
};
const post = (p, body, headers = {}) => call(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('api: POST /api/meta sets, adds, removes; GET /api/state reflects it', async () => {
  const r = await post('/api/meta', { name: 'good', favorite: true, addTags: ['saas', 'old'] });
  assert.deepEqual([r.status, r.body], [200, { ok: true, meta: { favorite: true, tags: ['old', 'saas'] } }]);
  assert.deepEqual((await post('/api/meta', { name: 'good', removeTags: ['old'] })).body.meta.tags, ['saas']);
  assert.deepEqual((await post('/api/meta', { name: 'dormant', tags: ['z', 'a'] })).body.meta, { favorite: false, tags: ['a', 'z'] });
  const st = (await call('/api/state')).body;
  assert.equal(st.favorites, 1);
  assert.deepEqual(st.tags.map((t) => t.tag), ['a', 'saas', 'z']);
  assert.deepEqual(st.global.find((s) => s.name === 'dormant').meta.tags, ['a', 'z']);
});

test('api: POST /api/meta errors are JSON, cross-origin is refused', async () => {
  const bad = await post('/api/meta', { name: 'good', addTags: ['no way'] });
  assert.deepEqual([bad.status, bad.body.ok, bad.body.code], [400, false, 'invalid']);
  const miss = await post('/api/meta', { name: 'nope', favorite: true });
  assert.deepEqual([miss.status, miss.body.code], [404, 'not-found']);
  assert.equal((await call('/api/meta', { method: 'POST', body: '{nope' })).status, 400);
  const x = await post('/api/meta', { name: 'unlinked', favorite: true }, { origin: 'http://evil.example' });
  assert.equal(x.status, 403);
  assert.equal(readMeta({ home: h }).has('unlinked'), false);
});

test('api: PUT /api/config keeps skills and unknown keys', async () => {
  const before = rawConfig(h);
  assert.ok(before.skills.good);
  fs.writeFileSync(configPath(h), JSON.stringify({ ...before, future: true }));
  const put = await call('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scanDepth: 2 }) });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { projectRoots: [], scanDepth: 2 });
  assert.deepEqual(rawConfig(h), { ...before, future: true, projectRoots: [], scanDepth: 2 });
});

test('api: POST /api/action batch copyToLocal with a failure in the middle', async () => {
  const r = await post('/api/action', { action: 'copyToLocal', names: ['dormant', 'nope', 'good'], scope: 'global', target: 'agents' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.results.map((x) => [x.name, x.ok, x.code]), [['dormant', true, undefined], ['nope', false, 'not-found'], ['good', false, 'exists']]);
  assert.ok(isDir(path.join(root, '.agents', 'skills', 'dormant')));
  assert.ok(isDir(path.join(h, '.agents', 'skills-inactive', 'dormant')));
  const single = await post('/api/action', { action: 'copyToLocal', name: 'nope' });
  assert.deepEqual([single.status, single.body.error], [404, 'no global skill: nope']);
});

// ---- CLI -----------------------------------------------------------------

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.mjs');
const skm = (home, cwd, args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, FORCE_COLOR: undefined, SKM_HOME: home, NO_COLOR: '1' }, input: '', encoding: 'utf8' });

test('cli: fav/tag/tags/list filters and columns', () => {
  const home = buildHome();
  const ok = (args, cwd = home) => {
    const r = skm(home, cwd, args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  assert.match(ok(['fav', 'good', 'sleepy']), /favorited: good, sleepy/);
  assert.match(ok(['tag', 'good', 'SaaS', 'mobile']), /^good: mobile, saas/);
  assert.match(ok(['tag', 'sleepy', 'saas']), /^sleepy: saas/);
  const list = ok(['list']);
  const header = list.split('\n')[0];
  assert.match(header, /NAME\s+FAV\s+STATE\s+STATUS\s+TOK\s+ORIGIN\s+TAGS\s+ALSO IN/);
  assert.match(list, /global\s+good\s+\*\s+active\s+ok\s+\d+\s+-\s+mobile,saas/);
  assert.match(list, /global\s+unlinked\s+active/);
  const names = (out) => out.split('\n').filter((l) => /^(global|local) /.test(l)).map((l) => l.split(/\s+/)[1]);
  assert.deepEqual(names(ok(['list', '--fav'])).sort(), ['good', 'sleepy']);
  assert.deepEqual(names(ok(['list', '--tag', 'mobile'])), ['good']);
  assert.deepEqual(JSON.parse(ok(['list', '--fav', '--tag', 'mobile', '--json'])).global.map((s) => s.name), ['good']);
  assert.match(ok(['list', '--tag', 'nothing']), /no skills match/);
  const tags = ok(['tags']);
  assert.match(tags, /TAG\s+SKILLS\nsaas\s+2\nmobile\s+1/);
  assert.deepEqual(JSON.parse(ok(['tags', '--json'])), [{ tag: 'saas', count: 2 }, { tag: 'mobile', count: 1 }]);
  assert.match(ok(['untag', 'good', 'mobile']), /^good: saas/);
  assert.match(ok(['unfav', 'sleepy']), /unfavorited: sleepy/);
  assert.equal(JSON.parse(fs.readFileSync(configPath(home), 'utf8')).skills.sleepy.favorite, false);
  ok(['untag', 'sleepy', 'saas']);
  assert.equal(JSON.parse(fs.readFileSync(configPath(home), 'utf8')).skills.sleepy, undefined);
});

test('cli: fav/tag reject unknown names and bad tags, nothing is written', () => {
  const home = buildHome();
  let r = skm(home, home, ['fav', 'good', 'typo']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no skill named "typo" \[not-found\]/);
  r = skm(home, home, ['tag', 'good', 'bad tag']);
  assert.match(r.stderr, /invalid tag/);
  assert.equal(skm(home, home, ['tag', 'good']).status, 1);
  assert.equal(fs.existsSync(configPath(home)), false);
});

test('cli: pull several names, inactive included; failure in the middle exits 1', () => {
  const { home, root } = inactiveSetup();
  let r = skm(home, root, ['pull', 'sleepy', 'nope', 'unlinked']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /copied 2 of 3 global skill\(s\) to local \(claude\)/);
  assert.match(r.stdout, /failed nope: no global skill: nope \[not-found\]/);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'sleepy', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'unlinked', 'SKILL.md')));
  r = skm(home, root, ['pull', 'claude-sleepy', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^dry run: copied global\/claude-sleepy to local/);
  assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'claude-sleepy')), false);
});
