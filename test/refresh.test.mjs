import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { diffLocal, getState, runAction, scanProjects, writeConfig } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { buildHome, buildProject, mkSkill, skillMd, write } from './fixture.mjs';

const byName = (list, name) => list.find((s) => s.name === name);
const md = (p) => fs.readFileSync(path.join(p, 'SKILL.md'), 'utf8');

/** Home + project where local `good` (in .agents, linked from .claude) differs from the active global `good`. */
function setup() {
  const home = buildHome();
  const root = buildProject(home);
  write(path.join(root, '.agents', 'skills', 'good', 'SKILL.md'), skillMd('good', 'old local copy'));
  write(path.join(root, '.agents', 'skills', 'good', 'notes.md'), 'local only\n');
  return { home, root, o: { home, cwd: root, platform: 'darwin', now: new Date(2026, 9, 7, 10, 0, 0) } };
}

test('refresh: vsGlobal marks a local skill that differs from global, identical after refresh', () => {
  const { root, o } = setup();
  const s = getState(o);
  assert.equal(byName(s.local, 'good').vsGlobal, 'diverged');
  assert.equal(byName(s.local, 'localonly').vsGlobal, null);
  assert.equal(byName(s.global, 'good').vsGlobal, undefined);

  const dry = runAction(o, { action: 'refresh', scope: 'local', name: 'good', dryRun: true });
  const dir = path.join(root, '.agents', 'skills', 'good');
  const dest = path.join(o.home, '.Trash', 'good');
  assert.deepEqual(dry.changes, [`trash ${dir} -> ${dest}`, `copy ${path.join(o.home, '.agents', 'skills', 'good')} -> ${dir}`]);
  assert.match(dry.message, /^dry run: refreshed local\/good from global/);
  assert.match(md(dir), /old local copy/); // dryRun touches nothing
  assert.equal(fs.existsSync(dest), false);

  const r = runAction(o, { action: 'refresh', name: 'good' }); // scope defaults to local
  assert.ok(r.message.includes(dest));
  assert.equal(md(dir), skillMd('good'));
  assert.equal(fs.existsSync(path.join(dir, 'notes.md')), false);
  assert.match(md(dest), /old local copy/); // the old copy is in the Trash
  assert.ok(fs.lstatSync(path.join(root, '.claude', 'skills', 'good')).isSymbolicLink()); // the local link is untouched
  assert.equal(byName(getState(o).local, 'good').vsGlobal, 'identical');

  const again = runAction(o, { action: 'refresh', name: 'good' });
  assert.deepEqual(again.changes, []);
  assert.equal(again.message, 'local/good is already the same as global');
});

test('refresh: an inactive global source is only read and stays inactive; an inactive local stays inactive', () => {
  const { home, root, o } = setup();
  const ginactive = path.join(home, '.agents', 'skills-inactive', 'sleepy');
  const before = fs.readdirSync(ginactive);
  mkSkill(path.join(root, '.claude', 'skills-inactive'), 'sleepy', { md: skillMd('sleepy', 'stale local') });
  assert.equal(byName(getState(o).local, 'sleepy').vsGlobal, 'diverged');
  runAction(o, { action: 'refresh', scope: 'local', name: 'sleepy' });
  const local = path.join(root, '.claude', 'skills-inactive', 'sleepy');
  assert.equal(md(local), skillMd('sleepy'));
  assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'sleepy')), false);
  assert.deepEqual(fs.readdirSync(ginactive), before);
  assert.equal(byName(getState(o).global, 'sleepy').active, false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'sleepy')), false);
  assert.ok(fs.existsSync(path.join(home, '.Trash', 'sleepy', 'SKILL.md')));
});

test('refresh: both local folders differ -> both trashed (distinct slots) and replaced', () => {
  const { home, root, o } = setup();
  mkSkill(path.join(home, '.agents', 'skills'), 'both', { md: skillMd('both', 'global both') });
  const r = runAction(o, { action: 'refresh', name: 'both' });
  assert.equal(r.changes.filter((c) => c.startsWith('trash ')).length, 2);
  for (const d of ['.agents', '.claude']) assert.match(md(path.join(root, d, 'skills', 'both')), /global both/);
  assert.deepEqual(fs.readdirSync(path.join(home, '.Trash')).sort(), ['both', 'both 2026-10-07 10.00.00']);
});

test('refresh: errors (no global, no local, links only, no project, wrong scope)', () => {
  const { home, root, o } = setup();
  assert.throws(() => runAction(o, { action: 'refresh', name: 'localonly' }), { code: 'not-found' });
  assert.throws(() => runAction(o, { action: 'refresh', name: 'unlinked' }), { code: 'not-found' });
  fs.rmSync(path.join(root, '.agents', 'skills', 'good'), { recursive: true });
  fs.symlinkSync(path.join(home, '.agents', 'skills', 'good'), path.join(root, '.agents', 'skills', 'good'), 'dir');
  assert.throws(() => runAction(o, { action: 'refresh', name: 'good' }), { code: 'invalid' });
  assert.throws(() => runAction({ home, cwd: home }, { action: 'refresh', name: 'good' }), { code: 'no-project' });
  assert.throws(() => runAction(o, { action: 'refresh', scope: 'global', name: 'good' }), { code: 'invalid' });
});

test('refresh batch: several names, dry run, continues past failures', () => {
  const { home, root, o } = setup();
  mkSkill(path.join(root, '.claude', 'skills'), 'dup', { md: skillMd('dup', 'local dup') });
  const names = ['good', 'dup', 'localonly'];
  const dry = runAction(o, { action: 'refresh', scope: 'local', names, dryRun: true });
  assert.equal(dry.ok, false);
  assert.equal(dry.message, 'dry run: refreshed 2 of 3 local skill(s) from global');
  assert.deepEqual(dry.results.map((x) => [x.name, x.ok, x.code]), [['good', true, undefined], ['dup', true, undefined], ['localonly', false, 'not-found']]);
  assert.equal(dry.changes.length, 4);
  assert.equal(fs.existsSync(path.join(home, '.Trash')), false);

  const r = runAction(o, { action: 'refresh', names: ['good', 'dup'] });
  assert.equal(r.ok, true);
  assert.equal(md(path.join(root, '.claude', 'skills', 'dup')), skillMd('dup'));
  assert.equal(md(path.join(root, '.agents', 'skills', 'good')), skillMd('good'));
  assert.throws(() => runAction(o, { action: 'refresh', names: [] }), { code: 'invalid' });
});

test('diffLocal: local -> global, local edits show as removals', () => {
  const { o } = setup();
  const d = diffLocal(o, 'good');
  assert.equal(d.from, 'local');
  assert.equal(d.to, 'global');
  assert.deepEqual(d.files.map((f) => [f.path, f.status]), [['SKILL.md', 'modified'], ['notes.md', 'removed']]);
  assert.ok(d.files[0].hunks[0].lines.includes('-description: old local copy'));
  assert.throws(() => diffLocal(o, 'localonly'), { code: 'not-found' });
});

test('scanProjects: project skill entries carry vsGlobal', async () => {
  const { home, root, o } = setup();
  const parent = path.dirname(root);
  writeConfig(o, { projectRoots: [parent], scanDepth: 1 });
  const scan = await scanProjects({ home, cwd: home, git: () => '' });
  const p = scan.projects.find((x) => x.root === root);
  assert.equal(byName(p.skills, 'good').vsGlobal, 'diverged');
  assert.equal(byName(p.skills, 'localonly').vsGlobal, null);
});

// ---- server ----------------------------------------------------------------

let srv;
let env;
before(async () => {
  env = setup();
  srv = await startServer({ home: env.home, cwd: env.home, port: 0, platform: 'darwin' });
  writeConfig(env.o, { projectRoots: [path.dirname(env.root)], scanDepth: 1 });
});
after(() => srv.close());

test('server: GET /api/diff?scope=local and POST refresh with projectRoot', async () => {
  const q = new URLSearchParams({ scope: 'local', name: 'good', projectRoot: env.root });
  const d = await (await fetch(`${srv.url}/api/diff?${q}`)).json();
  assert.equal(d.from, 'local');
  assert.equal(d.files.length, 2);
  const res = await fetch(`${srv.url}/api/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'refresh', scope: 'local', names: ['good'], projectRoot: env.root }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(md(path.join(env.root, '.agents', 'skills', 'good')), skillMd('good'));
});

// ---- cli -------------------------------------------------------------------

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.mjs');
const skm = (cwd, home, args) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, SKM_HOME: home, NO_COLOR: '1' }, input: '', encoding: 'utf8' });
const supported = ['darwin', 'linux'].includes(process.platform);

test('cli: help lists refresh; dry run, non-TTY confirmation, --yes', { skip: !supported }, () => {
  const { home, root } = setup();
  assert.match(skm(root, home, ['--help']).stdout, /skm refresh <name\.\.\.>/);
  const dir = path.join(root, '.agents', 'skills', 'good');
  const dry = skm(root, home, ['refresh', 'good', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^dry run: refreshed local\/good from global/);
  const ask = skm(root, home, ['refresh', 'good']);
  assert.equal(ask.status, 1);
  assert.match(ask.stderr, /local good will be replaced by the global copy; the old local copy goes to the system Trash/);
  assert.match(md(dir), /old local copy/);
  const diff = skm(root, home, ['diff', 'good', '--local']);
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /-description: old local copy/);
  const ok = skm(root, home, ['refresh', 'good', '--yes']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(md(dir), skillMd('good'));
});

test('cli: batch refresh reports failures and exits 1', { skip: !supported }, () => {
  const { home, root } = setup();
  const r = skm(root, home, ['refresh', 'good', 'localonly', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refreshed 1 of 2 local skill\(s\) from global/);
  assert.match(r.stdout, /failed localonly: no global skill: localonly \[not-found\]/);
});

