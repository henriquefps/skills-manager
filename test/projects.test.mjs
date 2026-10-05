import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configPath, projectContext, readConfig, runAction, scanProjects, SkmError, writeConfig } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { link, mkSkill, skillMd, tmp } from './fixture.mjs';

const proj = (dir, ...names) => {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const n of names) mkSkill(path.join(dir, '.claude', 'skills'), n);
  return dir;
};

/** A workspace tree with every scan case. Returns { home, ws }. */
function build() {
  const home = tmp();
  const ws = path.join(home, 'ws');
  proj(path.join(ws, 'a'), 'one', 'shared');
  proj(path.join(ws, 'group', 'b'), 'shared', 'two');
  proj(path.join(ws, 'group', 'deep', 'deeper', 'c'), 'far');
  proj(path.join(ws, 'node_modules', 'n'), 'nm');
  proj(path.join(ws, '.hidden', 'h'), 'hid');
  proj(path.join(ws, 'a', 'nested'), 'inner'); // inside a found project
  proj(path.join(ws, 'noskills')); // project without skills
  fs.mkdirSync(path.join(ws, 'real'));
  proj(path.join(ws, 'real', 'viaLink'), 'linked');
  link(path.join(ws, 'real'), path.join(ws, 'linkdir')); // symlinked dir: never followed
  return { home, ws };
}

const names = (scan) => scan.projects.map((p) => path.relative(scan.roots[0], p.root));

test('config: defaults, round trip, ~ stored for paths in home, unknown fields kept', () => {
  const home = tmp();
  assert.deepEqual(readConfig({ home }), { projectRoots: [], scanDepth: 3 });
  assert.equal(fs.existsSync(configPath(home)), false);
  fs.mkdirSync(path.join(home, 'work'));
  const out = tmp();
  writeConfig({ home }, { projectRoots: ['~/work', out, '~/work'], scanDepth: 2 });
  assert.deepEqual(readConfig({ home }), { projectRoots: [path.join(home, 'work'), out], scanDepth: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath(home), 'utf8')).projectRoots, ['~/work', out]);
  fs.writeFileSync(configPath(home), JSON.stringify({ projectRoots: ['~/work'], scanDepth: 2, extra: 1 }));
  writeConfig({ home }, { scanDepth: 4 });
  const raw = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
  assert.deepEqual(raw, { projectRoots: ['~/work'], scanDepth: 4, extra: 1 });
});

test('config: validation', () => {
  const home = tmp();
  const bad = (input) => assert.throws(() => writeConfig({ home }, input), (e) => e instanceof SkmError && e.code === 'invalid');
  bad({ projectRoots: ['~/missing'] });
  bad({ projectRoots: ['relative/path'] });
  bad({ projectRoots: 'nope' });
  bad({ projectRoots: [''] });
  bad({ projectRoots: [5] });
  bad({ scanDepth: 0 });
  bad({ scanDepth: 7 });
  bad({ scanDepth: 2.5 });
  bad({ scanDepth: '3' });
  bad(null);
  bad([]);
  const file = path.join(home, 'afile');
  fs.writeFileSync(file, 'x');
  bad({ projectRoots: [file] });
  assert.equal(fs.existsSync(configPath(home)), false);
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  fs.writeFileSync(configPath(home), '{not json');
  assert.deepEqual(readConfig({ home }), { projectRoots: [], scanDepth: 3 });
});

test('scan: depth, skip rules, never descends into a found project', () => {
  const { home, ws } = build();
  const scan = (scanDepth) => scanProjects({ home }, { projectRoots: [ws], scanDepth });
  assert.deepEqual(names(scan(1)), ['a']);
  assert.deepEqual(names(scan(2)), ['a', 'group/b', 'real/viaLink']);
  assert.deepEqual(names(scan(4)), ['a', 'group/b', 'group/deep/deeper/c', 'real/viaLink']);
  const all = names(scan(6));
  assert.ok(!all.some((n) => /node_modules|\.hidden|nested|noskills|linkdir/.test(n)), all.join());
  const a = scan(1).projects[0];
  assert.deepEqual(a.skills.map((s) => s.name), ['one', 'shared']);
  assert.deepEqual(Object.keys(a.skills[0]), ['name', 'active', 'status', 'cost', 'meta']);
});

test('scan: skills carry active/status and ceil(chars/4) cost', () => {
  const home = tmp();
  const root = tmp();
  const p = proj(path.join(root, 'p'), 'live');
  mkSkill(path.join(p, '.claude', 'skills-inactive'), 'asleep');
  const md = skillMd('live', 'x'.repeat(30));
  fs.writeFileSync(path.join(p, '.claude', 'skills', 'live', 'SKILL.md'), md);
  const [found] = scanProjects({ home }, { projectRoots: [root], scanDepth: 1 }).projects;
  const live = found.skills.find((s) => s.name === 'live');
  assert.equal(live.active, true);
  assert.equal(live.status, 'ok');
  assert.deepEqual(live.cost, { listing: Math.ceil((4 + 30) / 4), full: Math.ceil(md.length / 4) });
  assert.equal(found.skills.find((s) => s.name === 'asleep').active, false);
});

test('scan: the home dir is never a project and a root can itself be a project', () => {
  const home = tmp();
  mkSkill(path.join(home, '.agents', 'skills'), 'global1');
  const solo = proj(path.join(home, 'solo'), 's');
  const scan = scanProjects({ home }, { projectRoots: [home, solo], scanDepth: 1 });
  assert.deepEqual(scan.projects.map((p) => p.root), [solo]);
});

test('repeated: identical vs diverged, inGlobal, single-project skills excluded', () => {
  const home = tmp();
  mkSkill(path.join(home, '.agents', 'skills'), 'inglobal');
  const root = tmp();
  proj(path.join(root, 'p1'), 'same', 'differs', 'only1');
  proj(path.join(root, 'p2'), 'same', 'differs');
  proj(path.join(root, 'p3'), 'same', 'differs', 'inglobal');
  fs.writeFileSync(path.join(root, 'p2', '.claude', 'skills', 'differs', 'SKILL.md'), skillMd('differs', 'other'));
  mkSkill(path.join(root, 'p2', '.agents', 'skills'), 'inglobal');
  const { repeated } = scanProjects({ home }, { projectRoots: [root], scanDepth: 1 });
  assert.deepEqual(repeated.map((r) => r.name), ['differs', 'inglobal', 'same']);
  const get = (n) => repeated.find((r) => r.name === n);
  assert.equal(get('differs').identical, false);
  assert.equal(get('same').identical, true);
  assert.deepEqual(get('same').projects, ['p1', 'p2', 'p3'].map((p) => path.join(root, p)));
  assert.equal(get('inglobal').inGlobal, true);
  assert.equal(get('same').inGlobal, false);
});

test('projectContext guard: outside roots rejected, inside and current project accepted', () => {
  const { home, ws } = build();
  const other = proj(path.join(tmp(), 'elsewhere'), 'x');
  const cur = proj(path.join(tmp(), 'cur'), 'y');
  writeConfig({ home }, { projectRoots: [ws] });
  const opts = { home, cwd: cur };
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };
  assert.equal(code(() => projectContext(opts, other)), 'forbidden');
  assert.equal(code(() => projectContext(opts, home)), 'no-project');
  assert.equal(code(() => projectContext(opts, 'relative')), 'invalid');
  assert.equal(code(() => projectContext(opts, path.join(ws, 'nope'))), 'not-found');
  assert.equal(code(() => projectContext(opts, ws)), 'no-project');
  assert.equal(projectContext(opts, path.join(ws, 'a')).project.root, path.join(ws, 'a'));
  assert.equal(projectContext(opts, cur).project.root, cur);
  // a symlink inside a root that points outside is resolved first and rejected
  link(other, path.join(ws, 'escape'));
  assert.equal(code(() => projectContext(opts, path.join(ws, 'escape'))), 'forbidden');
});

test('actions run against the given project', () => {
  const { home, ws } = build();
  writeConfig({ home }, { projectRoots: [ws] });
  const cur = proj(path.join(tmp(), 'cur'));
  const pctx = projectContext({ home, cwd: cur }, path.join(ws, 'group', 'b'));
  runAction(pctx, { action: 'deactivate', scope: 'local', name: 'two' });
  const b = path.join(ws, 'group', 'b', '.claude');
  assert.ok(fs.existsSync(path.join(b, 'skills-inactive', 'two')));
  assert.ok(!fs.existsSync(path.join(cur, '.claude', 'skills-inactive')));
  runAction(pctx, { action: 'promote', scope: 'local', name: 'shared' });
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'shared', 'SKILL.md')));
  runAction(pctx, { action: 'delete', scope: 'local', name: 'shared', dryRun: true });
});

let srv;
let home;
let ws;
let cur;
before(async () => {
  ({ home, ws } = build());
  cur = proj(path.join(tmp(), 'cur'), 'curskill');
  srv = await startServer({ home, cwd: cur, port: 0 });
});
after(() => srv.close());
const call = async (p, init) => {
  const res = await fetch(srv.url + p, init);
  return { status: res.status, body: await res.json() };
};
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('server: /api/config, /api/projects, projectRoot on /api/action', async () => {
  assert.deepEqual((await call('/api/config')).body, { projectRoots: [], scanDepth: 3 });
  assert.deepEqual((await call('/api/projects')).body, { roots: [], projects: [], repeated: [] });
  const bad = await call('/api/config', json('PUT', { projectRoots: [path.join(ws, 'missing')] }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid');
  const cross = await call('/api/config', { ...json('PUT', { scanDepth: 2 }), headers: { 'content-type': 'application/json', origin: 'http://evil.example' } });
  assert.equal(cross.status, 403);
  const put = await call('/api/config', json('PUT', { projectRoots: [ws], scanDepth: 2 }));
  assert.deepEqual(put.body, { projectRoots: [ws], scanDepth: 2 });
  const { body } = await call('/api/projects');
  assert.deepEqual(body.projects.map((p) => p.name), ['a', 'b', 'viaLink']);
  assert.deepEqual(body.repeated.map((r) => [r.name, r.identical]), [['shared', true]]);

  const target = path.join(ws, 'a');
  const run = await call('/api/action', json('POST', { action: 'deactivate', scope: 'local', name: 'one', projectRoot: target }));
  assert.equal(run.status, 200);
  assert.ok(fs.existsSync(path.join(target, '.claude', 'skills-inactive', 'one')));
  assert.ok(fs.existsSync(path.join(cur, '.claude', 'skills', 'curskill')));

  const outside = proj(path.join(tmp(), 'out'), 'zzz');
  const denied = await call('/api/action', json('POST', { action: 'delete', scope: 'local', name: 'zzz', projectRoot: outside }));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'forbidden');
  assert.ok(fs.existsSync(path.join(outside, '.claude', 'skills', 'zzz')));
  const current = await call('/api/action', json('POST', { action: 'deactivate', scope: 'local', name: 'curskill', projectRoot: cur, dryRun: true }));
  assert.equal(current.status, 200);
});

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.mjs');
const skm = (home, cwd, args) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, SKM_HOME: home, NO_COLOR: '1' }, input: '', encoding: 'utf8' });

test('cli: projects add/rm/depth/config and scan output', () => {
  const { home, ws } = build();
  assert.match(skm(home, home, ['projects']).stdout, /no project roots configured/);
  assert.match(skm(home, home, ['config']).stdout, /no config file yet/);
  assert.equal(skm(home, home, ['projects', 'add', ws]).status, 0);
  assert.equal(skm(home, home, ['projects', 'add', '~/missing']).status, 1);
  assert.match(skm(home, home, ['projects', 'depth', '2']).stdout, /scan depth: 2/);
  assert.equal(skm(home, home, ['projects', 'depth', '9']).status, 1);
  const out = skm(home, home, ['projects']).stdout;
  assert.match(out, /group\/b|\bb\b/);
  assert.match(out, /shared\s+identical/);
  const json = JSON.parse(skm(home, home, ['projects', '--json']).stdout);
  assert.equal(json.projects.length, 3);
  assert.match(skm(home, home, ['config']).stdout, /"scanDepth": 2/);
  assert.equal(skm(home, home, ['projects', 'rm', path.join(ws, 'nope')]).status, 1);
  assert.equal(skm(home, home, ['projects', 'rm', ws]).status, 0);
  assert.deepEqual(readConfig({ home }).projectRoots, []);
});
