import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configPath, deleteProfile, getProfile, getState, profilesPath, readProfiles, runAction, saveProfile, saveProjectProfile, updateMeta, updateProfile } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { buildHome, buildProject, mkSkill, tmp, write } from './fixture.mjs';

const rawProfiles = (home) => JSON.parse(fs.readFileSync(profilesPath(home), 'utf8'));
const isDir = (p) => fs.lstatSync(p).isDirectory();

/** Home + project; the project already has `good` (agents + claude link), `localonly`, `both`, and an inactive `asleep`. */
function setup() {
  const home = buildHome();
  const root = buildProject(home);
  mkSkill(path.join(root, '.claude', 'skills-inactive'), 'asleep');
  mkSkill(path.join(home, '.agents', 'skills'), 'asleep');
  return { home, root, o: { home, cwd: root, platform: 'darwin' } };
}

// ---- storage -------------------------------------------------------------

test('profiles: stored in profiles.json next to the config, names normalized, skills sorted and de-duplicated', () => {
  const home = tmp();
  assert.deepEqual(readProfiles({ home }), []);
  assert.equal(path.dirname(profilesPath(home)), path.dirname(configPath(home)));
  const p = saveProfile({ home }, { name: ' Docs ', skills: ['b', 'a', 'b'] });
  assert.deepEqual(p, { name: 'docs', skills: ['a', 'b'] });
  assert.deepEqual(rawProfiles(home), { profiles: { docs: { skills: ['a', 'b'] } } });
  assert.equal(fs.existsSync(configPath(home)), false); // the config file is not touched
  assert.deepEqual(getProfile({ home }, 'docs'), p);
  assert.throws(() => getProfile({ home }, 'nope'), { code: 'not-found' });
});

test('profiles: validation, exists unless overwrite, unknown keys survive every write', () => {
  const home = tmp();
  write(profilesPath(home), JSON.stringify({ shared: 'keep', profiles: { kit: { skills: ['x'], note: 'mine' } } }));
  assert.throws(() => saveProfile({ home }, { name: 'kit', skills: ['y'] }), { code: 'exists' });
  assert.deepEqual(saveProfile({ home }, { name: 'kit', skills: ['y'], overwrite: true }).skills, ['y']);
  for (const name of ['', 'Has Space', '-lead', 'a/b', 'x'.repeat(49)]) assert.throws(() => saveProfile({ home }, { name, skills: ['a'] }), { code: 'invalid' }, name);
  assert.throws(() => saveProfile({ home }, { name: 'empty', skills: [] }), { code: 'invalid' });
  assert.throws(() => saveProfile({ home }, { name: 'bad', skills: ['../x'] }), { code: 'invalid' });
  assert.throws(() => saveProfile({ home }, { name: 'bad', skills: 'a' }), { code: 'invalid' });
  const raw = rawProfiles(home);
  assert.equal(raw.shared, 'keep');
  assert.deepEqual(raw.profiles.kit, { skills: ['y'], note: 'mine' });
});

test('profiles: a malformed file reads as empty; malformed entries are dropped', () => {
  const home = tmp();
  write(profilesPath(home), '{ not json');
  assert.deepEqual(readProfiles({ home }), []);
  write(profilesPath(home), JSON.stringify({ profiles: { ok: { skills: ['a', 7, '../x', 'a'] }, 'Bad Name': { skills: ['a'] }, nolist: {} } }));
  assert.deepEqual(readProfiles({ home }), [{ name: 'nolist', skills: [] }, { name: 'ok', skills: ['a'] }]);
});

test('profiles: rename and edit members, delete returns the removed profile', () => {
  const home = tmp();
  saveProfile({ home }, { name: 'kit', skills: ['a', 'b'] });
  saveProfile({ home }, { name: 'other', skills: ['z'] });
  assert.deepEqual(updateProfile({ home }, { name: 'kit', addSkills: ['c'], removeSkills: ['a'] }), { name: 'kit', skills: ['b', 'c'] });
  assert.deepEqual(updateProfile({ home }, { name: 'kit', rename: 'mobile', skills: ['d'] }), { name: 'mobile', skills: ['d'] });
  assert.deepEqual(readProfiles({ home }).map((p) => p.name), ['mobile', 'other']);
  assert.throws(() => updateProfile({ home }, { name: 'mobile', rename: 'other' }), { code: 'exists' });
  assert.throws(() => updateProfile({ home }, { name: 'mobile', removeSkills: ['d'] }), { code: 'invalid' }); // never empty
  assert.throws(() => updateProfile({ home }, { name: 'gone', skills: ['a'] }), { code: 'not-found' });
  assert.deepEqual(deleteProfile({ home }, 'mobile'), { name: 'mobile', skills: ['d'] });
  assert.deepEqual(readProfiles({ home }).map((p) => p.name), ['other']);
  deleteProfile({ home }, 'other');
  assert.deepEqual(rawProfiles(home), {}); // no empty `profiles` key left behind
});

test('profiles: the skill config (favorites, tags) and the profiles file do not interfere', () => {
  const home = buildHome();
  updateMeta({ home }, { name: 'good', favorite: true });
  saveProfile({ home }, { name: 'kit', skills: ['good'] });
  updateMeta({ home }, { name: 'good', addTags: ['x'] });
  assert.deepEqual(readProfiles({ home }), [{ name: 'kit', skills: ['good'] }]);
  assert.equal(JSON.parse(fs.readFileSync(configPath(home), 'utf8')).profiles, undefined);
});

// ---- save from a project ---------------------------------------------------

test('saveProjectProfile: stores the active local skills only, needs a project and at least one active skill', () => {
  const { home, root, o } = setup();
  assert.deepEqual(saveProjectProfile(o, { name: 'atlas' }), { name: 'atlas', skills: ['both', 'good', 'localonly'] });
  assert.throws(() => saveProjectProfile(o, { name: 'atlas' }), { code: 'exists' });
  assert.throws(() => saveProjectProfile({ home, cwd: home }, { name: 'x' }), { code: 'no-project' });
  const bare = tmp();
  fs.mkdirSync(path.join(bare, '.git'));
  assert.throws(() => saveProjectProfile({ home, cwd: bare }, { name: 'x' }), { code: 'invalid' });
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills-inactive', 'asleep'))); // nothing moved
});

// ---- apply -----------------------------------------------------------------

test('applyProfile: copies new skills, skips the ones already there, reports names missing from global', () => {
  const { home, root, o } = setup();
  saveProfile(o, { name: 'kit', skills: ['unlinked', 'sleepy', 'good', 'asleep', 'nope'] });
  const r = runAction(o, { action: 'applyProfile', profile: 'kit' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.copied, ['sleepy', 'unlinked']);
  assert.deepEqual(r.skipped, ['asleep', 'good']);
  assert.deepEqual(r.missing, ['nope']);
  assert.deepEqual(r.results.find((x) => x.name === 'good'), { name: 'good', status: 'skipped', reason: 'already in this project' });
  assert.deepEqual(r.results.find((x) => x.name === 'asleep'), { name: 'asleep', status: 'skipped', reason: 'inactive in this project' });
  assert.deepEqual(r.results.find((x) => x.name === 'nope'), { name: 'nope', status: 'missing', error: 'no global skill: nope' });
  assert.match(r.message, /applied profile kit to .*: copied 2, skipped 2, 1 missing from global/);
  assert.ok(isDir(path.join(root, '.claude', 'skills', 'unlinked')));
  assert.ok(isDir(path.join(root, '.claude', 'skills', 'sleepy')));
  // the inactive global source is copied but not activated
  assert.ok(isDir(path.join(home, '.agents', 'skills-inactive', 'sleepy')));
  assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'sleepy')), false);
  assert.equal(getState(o).global.find((s) => s.name === 'sleepy').active, false);
  // skipped ones are untouched, nothing went to the Trash
  assert.ok(fs.lstatSync(path.join(root, '.claude', 'skills', 'good')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(home, '.Trash')), false);
  // applying again copies nothing
  const again = runAction(o, { action: 'applyProfile', profile: 'kit' });
  assert.deepEqual([again.copied, again.changes], [[], []]);
});

test('applyProfile: dry run plans the copies and writes nothing', () => {
  const { root, o } = setup();
  saveProfile(o, { name: 'kit', skills: ['unlinked', 'good'] });
  const r = runAction(o, { action: 'applyProfile', profile: 'kit', dryRun: true, target: 'agents' });
  assert.match(r.message, /^dry run: /);
  assert.deepEqual(r.copied, ['unlinked']);
  assert.equal(r.changes.length, 1);
  assert.match(r.changes[0], /^copy .* -> .*\.agents[\\/]skills[\\/]unlinked$/);
  assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'unlinked')), false);
});

test('applyProfile: overwrite replaces the existing copy where it lives (old one to the Trash), inactive ones stay skipped', () => {
  const { home, root, o } = setup();
  write(path.join(root, '.agents', 'skills', 'good', 'mine.md'), 'local edit');
  saveProfile(o, { name: 'kit', skills: ['good', 'asleep', 'unlinked'] });
  const r = runAction(o, { action: 'applyProfile', profile: 'kit', overwrite: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.copied, ['good', 'unlinked']);
  assert.deepEqual(r.skipped, ['asleep']);
  assert.deepEqual(r.results.find((x) => x.name === 'good').target, 'agents'); // the real folder was in .agents, not the target
  assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'good', 'mine.md')), false);
  assert.ok(fs.existsSync(path.join(home, '.Trash', 'good', 'mine.md')));
  assert.ok(fs.lstatSync(path.join(root, '.claude', 'skills', 'good')).isSymbolicLink()); // the link is left as it was
});

test('applyProfile: errors (no project, unknown profile, bad target)', () => {
  const { home, o } = setup();
  saveProfile(o, { name: 'kit', skills: ['good'] });
  assert.throws(() => runAction({ home, cwd: home }, { action: 'applyProfile', profile: 'kit' }), { code: 'no-project' });
  assert.throws(() => runAction(o, { action: 'applyProfile', profile: 'nope' }), { code: 'not-found' });
  assert.throws(() => runAction(o, { action: 'applyProfile', profile: 'kit', target: 'x' }), { code: 'invalid' });
});

// ---- HTTP API --------------------------------------------------------------

test('API: GET/POST /api/profiles and applyProfile through /api/action with projectRoot', async () => {
  const { home, root } = setup();
  fs.mkdirSync(path.join(home, 'work'));
  const srv = await startServer({ home, cwd: home, port: 0 });
  try {
    const call = async (p, body) => {
      const res = await fetch(srv.url + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
      return { status: res.status, body: await res.json() };
    };
    let r = await call('/api/profiles');
    assert.deepEqual(r.body, { file: profilesPath(home), profiles: [] });
    r = await call('/api/profiles', { op: 'create', name: 'kit', skills: ['unlinked', 'nope'] });
    assert.deepEqual([r.status, r.body.profile], [200, { name: 'kit', skills: ['nope', 'unlinked'] }]);
    assert.equal((await call('/api/profiles', { op: 'create', name: 'kit', skills: ['a'] })).status, 409);
    r = await call('/api/profiles', { op: 'update', name: 'kit', rename: 'web' });
    assert.deepEqual(r.body.profiles.map((p) => p.name), ['web']);
    // the project is outside any configured root: forbidden; with the root configured it works
    assert.equal((await call('/api/profiles', { op: 'saveProject', name: 'atlas', projectRoot: root })).status, 403);
    write(configPath(home), JSON.stringify({ projectRoots: [path.dirname(root)] }));
    r = await call('/api/profiles', { op: 'saveProject', name: 'atlas', projectRoot: root });
    assert.deepEqual(r.body.profile.skills, ['both', 'good', 'localonly']);
    r = await call('/api/action', { action: 'applyProfile', profile: 'web', projectRoot: root, dryRun: true });
    assert.deepEqual([r.status, r.body.copied, r.body.missing], [200, ['unlinked'], ['nope']]);
    assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'unlinked')), false);
    r = await call('/api/profiles', { op: 'delete', name: 'web' });
    assert.deepEqual(r.body.profile, { name: 'web', skills: ['nope', 'unlinked'] });
    assert.equal((await call('/api/profiles', { op: 'nope' })).status, 400);
    const cross = await fetch(`${srv.url}/api/profiles`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: JSON.stringify({ op: 'delete', name: 'atlas' }) });
    assert.equal(cross.status, 403);
  } finally {
    await srv.close();
  }
});

// ---- CLI -------------------------------------------------------------------

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.mjs');
const skm = (home, cwd, args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, SKM_HOME: home, NO_COLOR: '1' }, input: '', encoding: 'utf8' });

test('cli profile: --help, save from project and from names, list, show, apply, rm', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {
  const { home, root } = setup();
  let r = skm(home, root, ['profile', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skm profile list/);
  assert.match(r.stdout, /skm profile apply <name>/);
  assert.match(skm(home, root, ['--help']).stdout, /skm profile list\|show\|save\|apply\|rm/);
  assert.match(skm(home, root, ['profile']).stdout, /no profiles yet/);

  r = skm(home, root, ['profile', 'save', 'atlas']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /saved profile atlas: both, good, localonly/);
  r = skm(home, root, ['profile', 'save', 'kit', 'unlinked', 'sleepy', 'nope']);
  assert.match(r.stdout, /saved profile kit: nope, sleepy, unlinked/);
  assert.equal(skm(home, root, ['profile', 'save', 'kit', 'x']).status, 1);
  assert.match(skm(home, root, ['profile', 'list']).stdout, /kit\s+3\s+nope, sleepy, unlinked/);
  r = skm(home, root, ['profile', 'show', 'kit', '--json']);
  assert.deepEqual(JSON.parse(r.stdout).members.map((m) => [m.name, m.global, m.local]), [['nope', 'missing', 'no'], ['sleepy', 'inactive', 'no'], ['unlinked', 'active', 'no']]);

  r = skm(home, root, ['profile', 'apply', 'kit', '--dry-run']);
  assert.match(r.stdout, /^dry run: applied profile kit/);
  assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'unlinked')), false);
  r = skm(home, root, ['profile', 'apply', 'kit']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /copied\s+sleepy/);
  assert.match(r.stdout, /missing\s+nope\s+not in global/);
  assert.ok(isDir(path.join(root, '.claude', 'skills', 'unlinked')));
  // --overwrite asks first (no TTY: refuses and changes nothing)
  r = skm(home, root, ['profile', 'apply', 'kit', '--overwrite']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /re-run with --yes/);
  const trash = process.platform === 'darwin' ? path.join(home, '.Trash') : path.join(home, '.local', 'share', 'Trash', 'files');
  assert.equal(fs.existsSync(trash), false);
  assert.equal(skm(home, root, ['profile', 'apply', 'kit', '--overwrite', '--yes']).status, 0);
  assert.ok(fs.existsSync(path.join(trash, 'unlinked')));

  r = skm(home, root, ['profile', 'rm', 'kit']);
  assert.match(r.stdout, /deleted profile kit/);
  assert.match(r.stdout, /skm profile save kit nope sleepy unlinked/);
  assert.match(skm(home, root, ['profile', 'show', 'kit']).stderr, /no profile named "kit" \[not-found\]/);
});
