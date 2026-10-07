import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkHealth, runAction, saveProfile, updateMeta, writeConfig } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { buildHome, buildProject, link, mkSkill, skillMd, tmp, write } from './fixture.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.mjs');
const skm = (home, cwd, args) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, SKM_HOME: home, NO_COLOR: '1' }, input: '', encoding: 'utf8' });

const NOW = new Date(2026, 9, 7, 10, 0, 0);
const LATER = new Date(NOW.getTime() + 400 * 86400000); // everything on disk looks old
const find = (r, type, name, kind) => r.findings.find((f) => f.type === type && f.name === name && (!kind || f.kind === kind));
const run = (o, fix, dryRun = false) => runAction(o, { ...fix.request, dryRun });

/** A home with only healthy skills (one active, one inactive), so each test adds the case it checks. */
function cleanHome() {
  const home = tmp();
  mkSkill(path.join(home, '.agents', 'skills'), 'good');
  link('../../.agents/skills/good', path.join(home, '.claude', 'skills', 'good'));
  return home;
}

test('health: a healthy home has no findings', async () => {
  const r = await checkHealth({ home: cleanHome(), cwd: tmp(), now: NOW });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.counts, { error: 0, hint: 0 });
  assert.deepEqual(r.checked, { global: true, projects: [] });
});

test('health: broken symlink next to a real folder is an error, fixed by normalize', async () => {
  const home = cleanHome();
  mkSkill(path.join(home, '.agents', 'skills'), 'relink');
  link('../../old-skills/relink', path.join(home, '.claude', 'skills', 'relink'));
  const o = { home, cwd: tmp(), now: NOW, platform: 'darwin' };
  const f = find(await checkHealth(o), 'broken-link', 'relink');
  assert.equal(f.severity, 'error');
  assert.deepEqual(f.paths, [path.join(home, '.claude', 'skills', 'relink')]);
  assert.match(f.message, /old-skills\/relink/);
  assert.deepEqual(f.fixes.map((x) => x.request), [{ action: 'normalize', scope: 'global', name: 'relink' }]);
  assert.ok(run(o, f.fixes[0], true).changes.length); // dry run plans and touches nothing
  assert.ok(find(await checkHealth(o), 'broken-link', 'relink'));
  run(o, f.fixes[0]);
  assert.deepEqual((await checkHealth(o)).findings, []);
});

test('health: a broken link in an inactive folder is removed (only unlinked) by delete', async () => {
  const home = cleanHome();
  link('../../nowhere/ghost', path.join(home, '.agents', 'skills-inactive', 'ghost'));
  const o = { home, cwd: tmp(), now: NOW, platform: 'darwin' };
  const f = find(await checkHealth(o), 'broken-link', 'ghost');
  assert.equal(f.severity, 'error');
  assert.deepEqual(f.fixes[0].request, { action: 'delete', scope: 'global', name: 'ghost' });
  assert.deepEqual(run(o, f.fixes[0]).changes, [`unlink ${path.join(home, '.agents', 'skills-inactive', 'ghost')}`]);
  assert.equal(fs.existsSync(path.join(home, '.Trash')), false);
  assert.deepEqual((await checkHealth(o)).findings, []);
});

test('health: an active skill whose source is missing is an error (link to nothing, or no SKILL.md)', async () => {
  const home = buildHome(); // `gone` is a claude link to a missing folder, youtube_transcript_skill has no SKILL.md
  const o = { home, cwd: tmp(), now: NOW, platform: 'darwin' };
  const r = await checkHealth(o);
  const gone = find(r, 'missing-source', 'gone');
  assert.equal(gone.severity, 'error');
  assert.equal(gone.kind, 'link');
  assert.equal(find(r, 'broken-link', 'gone'), undefined); // reported once
  assert.deepEqual(gone.fixes[0].request, { action: 'delete', scope: 'global', name: 'gone' });
  const empty = find(r, 'missing-source', 'youtube_transcript_skill');
  assert.equal(empty.kind, 'skill-md');
  assert.match(empty.manual, /SKILL\.md/);
  assert.equal(r.counts.error, 2);
  run(o, gone.fixes[0]);
  assert.equal(find(await checkHealth(o), 'missing-source', 'gone'), undefined);
});

test('health: forgotten inactive folders are hints (empty, or unreferenced and old)', async () => {
  const home = cleanHome();
  const inactive = path.join(home, '.agents', 'skills-inactive');
  mkSkill(inactive, 'sleepy');
  mkSkill(inactive, 'kept');
  mkSkill(inactive, 'tagged');
  mkSkill(inactive, 'in-kit');
  fs.mkdirSync(path.join(inactive, 'hollow'), { recursive: true });
  updateMeta({ home }, { name: 'tagged', addTags: ['mobile'] });
  updateMeta({ home }, { name: 'kept', favorite: true });
  saveProfile({ home }, { name: 'kit', skills: ['in-kit'] });

  const recent = await checkHealth({ home, cwd: tmp(), now: NOW });
  assert.deepEqual(recent.findings.map((f) => f.name), ['hollow']); // only the empty one while everything is recent
  const hollow = recent.findings[0];
  assert.equal(hollow.type, 'forgotten-inactive');
  assert.equal(hollow.severity, 'hint');
  assert.deepEqual(hollow.reasons, ['empty', 'unreferenced']);
  assert.deepEqual(hollow.fixes.map((x) => x.request.action), ['delete']); // nothing to activate

  const later = await checkHealth({ home, cwd: tmp(), now: LATER });
  const sleepy = find(later, 'forgotten-inactive', 'sleepy');
  assert.deepEqual(sleepy.reasons, ['unreferenced', 'old']);
  assert.deepEqual(sleepy.fixes.map((x) => x.request), [{ action: 'activate', scope: 'global', name: 'sleepy' }, { action: 'delete', scope: 'global', name: 'sleepy' }]);
  for (const n of ['kept', 'tagged', 'in-kit', 'good']) assert.equal(find(later, 'forgotten-inactive', n), undefined, n);
  assert.equal(later.counts.error, 0);

  const o = { home, cwd: tmp(), now: LATER, platform: 'darwin' };
  run(o, sleepy.fixes[0]);
  assert.equal(find(await checkHealth(o), 'forgotten-inactive', 'sleepy'), undefined);
});

test('health: same name with diverged content is a hint with refresh / promote / normalize fixes', async () => {
  const home = buildHome();
  const root = buildProject(home);
  write(path.join(root, '.agents', 'skills', 'good', 'SKILL.md'), skillMd('good', 'old local copy'));
  const o = { home, cwd: root, now: NOW, platform: 'darwin' };
  const r = await checkHealth(o);
  assert.deepEqual(r.checked.projects, [{ root, name: path.basename(root) }]);
  const local = find(r, 'diverged', 'good', 'vs-global');
  assert.equal(local.severity, 'hint');
  assert.equal(local.scope, 'local');
  assert.deepEqual(local.project, { root, name: path.basename(root) });
  assert.deepEqual(local.fixes.map((x) => x.request), [
    { action: 'refresh', scope: 'local', name: 'good', projectRoot: root },
    { action: 'promote', scope: 'local', name: 'good', projectRoot: root, overwrite: true },
  ]);
  const copies = find(r, 'diverged', 'split', 'copies');
  assert.deepEqual(copies.fixes.map((x) => x.request.keep), ['agents', 'claude']);
  run(o, local.fixes[0]);
  assert.equal(find(await checkHealth(o), 'diverged', 'good', 'vs-global'), undefined);
});

test('health: scopes (global, local, projects) and across-project duplicates', async () => {
  const home = buildHome();
  const base = tmp();
  for (const [p, desc] of [['one', 'first'], ['two', 'second']]) {
    fs.mkdirSync(path.join(base, p, '.git'), { recursive: true });
    mkSkill(path.join(base, p, '.claude', 'skills'), 'shared', { md: skillMd('shared', desc) });
  }
  writeConfig({ home }, { projectRoots: [base] });
  const o = { home, cwd: tmp(), now: NOW };
  const global = await checkHealth(o, { scope: 'global' });
  assert.ok(global.findings.every((f) => f.scope === 'global'));
  await assert.rejects(checkHealth(o, { scope: 'local' }), { code: 'no-project' });
  await assert.rejects(checkHealth(o, { scope: 'nope' }), { code: 'invalid' });
  const all = await checkHealth(o, { scope: 'projects' });
  assert.deepEqual(all.checked.projects.map((p) => p.name), ['one', 'two']);
  const across = find(all, 'diverged', 'shared', 'across-projects');
  assert.deepEqual(across.paths, [path.join(base, 'one'), path.join(base, 'two')]);
  assert.deepEqual(across.fixes, []);
  const local = await checkHealth({ ...o, cwd: path.join(base, 'one') }, { scope: 'local' });
  assert.deepEqual(local.checked, { global: false, projects: [{ root: path.join(base, 'one'), name: 'one' }] });
  assert.deepEqual(local.findings, []);
});

test('cli check: exit code 1 on errors, JSON shape, 0 when clean, listed in --help', () => {
  const home = buildHome();
  const r = skm(home, home, ['check', '--json']);
  assert.equal(r.status, 1, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(body).sort(), ['checked', 'counts', 'findings', 'scope']);
  assert.equal(body.counts.error, 2);
  for (const f of body.findings) {
    for (const k of ['id', 'type', 'severity', 'scope', 'name', 'project', 'message', 'paths', 'fixes', 'manual']) assert.ok(k in f, k);
    for (const fx of f.fixes) assert.equal(typeof fx.request.action, 'string');
  }
  const text = skm(home, home, ['check']);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /2 errors, \d+ hints?/);
  assert.match(text.stdout, /fix: skm delete gone --global/);
  assert.match(text.stdout, /fix: skm normalize split --keep agents/);

  const clean = cleanHome();
  const ok = skm(clean, clean, ['check']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /no problems found/);
  assert.equal(skm(clean, clean, ['check', '--json']).status, 0);
  assert.match(skm(clean, clean, ['--help']).stdout, /skm check \[--json\]/);
});

test('GET /api/health', async () => {
  const home = buildHome();
  const srv = await startServer({ home, cwd: home, port: 0 });
  try {
    const res = await fetch(`${srv.url}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.counts.error, 2);
    assert.ok(body.findings.find((f) => f.type === 'missing-source' && f.name === 'gone'));
    const bad = await fetch(`${srv.url}/api/health?scope=nope`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'invalid');
  } finally {
    await srv.close();
  }
});
