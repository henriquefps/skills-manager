import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getSkill, getState, normalizeAll, resolveContext, runAction, scanScope } from '../src/core/index.mjs';
import { buildHome, buildProject, link, mkSkill, skillMd, tmp, write } from './fixture.mjs';

const byName = (list, n) => list.find((s) => s.name === n);

test('scan classifies every real-world case and ignores noise', () => {
  const home = buildHome();
  const g = scanScope({ home, cwd: home }, 'global');
  const st = Object.fromEntries(g.map((s) => [s.name, s.status]));
  assert.deepEqual(st, {
    conflicted: 'conflict',
    dup: 'duplicate',
    good: 'ok',
    gone: 'broken-link',
    orphan: 'claude-only',
    sleepy: 'ok',
    split: 'diverged',
    stray: 'wrong-link',
    unlinked: 'needs-link',
    youtube_transcript_skill: 'empty',
  });
  assert.equal(byName(g, 'sleepy').active, false);
  assert.equal(byName(g, 'good').active, true);
  assert.equal(byName(g, 'good').description, 'good skill');
  assert.equal(byName(g, 'good').locations.find((l) => l.root === 'claude').target, '../../.agents/skills/good');
  assert.match(byName(g, 'conflicted').issues.join('\n'), /sync-conflict/);
  assert.match(byName(g, 'youtube_transcript_skill').issues.join('\n'), /SKILL\.md/);
  assert.equal(byName(g, 'gone').locations[0].kind, 'broken-symlink');
});

test('local scope, project detection, alsoIn', () => {
  const home = buildHome();
  const root = buildProject(home);
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const s = getState({ home, cwd: sub });
  assert.equal(s.project.root, root);
  assert.equal(s.project.name, path.basename(root));
  const l = Object.fromEntries(s.local.map((x) => [x.name, x]));
  assert.equal(l.localonly.status, 'ok');
  assert.equal(l.both.status, 'duplicate');
  assert.equal(l.good.status, 'ok'); // symlink to same folder is not a duplicate
  assert.deepEqual(l.good.alsoIn, ['global']);
  assert.deepEqual(byName(s.global, 'good').alsoIn, ['local']);
  assert.deepEqual(l.localonly.alsoIn, []);
});

test('no project markers: project null and local empty; home is never a project', () => {
  const home = buildHome();
  const s = getState({ home, cwd: home });
  assert.equal(s.project, null);
  assert.deepEqual(s.local, []);
  const bare = tmp();
  assert.equal(getState({ home, cwd: bare }).project, null);
});

test('SKM_HOME env var overrides home', () => {
  const home = buildHome();
  const ctx = resolveContext({ env: { SKM_HOME: home }, cwd: home });
  assert.equal(ctx.home, home);
});

test('dryRun never touches disk', () => {
  const home = buildHome();
  const before = JSON.stringify(scanScope({ home }, 'global'));
  for (const req of [
    { action: 'normalize', scope: 'global', name: 'dup' },
    { action: 'deactivate', scope: 'global', name: 'good' },
    { action: 'delete', scope: 'global', name: 'good' },
    { action: 'activate', scope: 'global', name: 'sleepy' },
  ]) {
    const r = runAction({ home, cwd: home }, { ...req, dryRun: true });
    assert.equal(r.ok, true);
    assert.ok(r.changes.length > 0, req.action);
  }
  assert.equal(JSON.stringify(scanScope({ home }, 'global')), before);
});

test('normalize: needs-link, duplicate, claude-only, broken, wrong-link', () => {
  const home = buildHome();
  const o = { home, cwd: home };
  for (const n of ['unlinked', 'dup', 'orphan', 'gone']) runAction(o, { action: 'normalize', name: n });
  const g = scanScope(o, 'global');
  for (const n of ['unlinked', 'dup', 'orphan']) {
    assert.equal(byName(g, n).status, 'ok', n);
    const lnk = path.join(home, '.claude', 'skills', n);
    assert.equal(fs.readlinkSync(lnk), `../../.agents/skills/${n}`);
  }
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'orphan', 'SKILL.md')));
  assert.equal(byName(g, 'gone'), undefined); // dangling link removed, nothing to adopt
  // wrong-link with no canonical folder cannot be fixed automatically
  assert.throws(() => runAction(o, { action: 'normalize', name: 'stray' }), { code: 'wrong-link' });
  // wrong-link with a canonical folder is relinked
  mkSkill(path.join(home, '.agents', 'skills'), 'stray');
  assert.equal(byName(scanScope(o, 'global'), 'stray').status, 'wrong-link');
  runAction(o, { action: 'normalize', name: 'stray' });
  assert.equal(byName(scanScope(o, 'global'), 'stray').status, 'ok');
});

test('normalize: diverged needs keep, trashes the loser', () => {
  const home = buildHome();
  const o = { home, cwd: home };
  assert.throws(() => runAction(o, { action: 'normalize', name: 'split' }), { code: 'diverged' });
  runAction(o, { action: 'normalize', name: 'split', keep: 'claude' });
  const md = fs.readFileSync(path.join(home, '.agents', 'skills', 'split', 'SKILL.md'), 'utf8');
  assert.match(md, /claude version/);
  assert.equal(byName(scanScope(o, 'global'), 'split').status, 'ok');
  const trash = fs.readdirSync(path.join(home, '.agents', 'skills-trash'));
  assert.equal(trash.length, 1);
  assert.match(trash[0], /^split-.*-agents$/);
});

test('normalizeAll skips diverged and reports it', () => {
  const home = buildHome();
  const r = normalizeAll({ home, cwd: home });
  assert.ok(r.skipped.some((s) => s.startsWith('split:')));
  assert.equal(byName(scanScope({ home }, 'global'), 'split').status, 'diverged');
  assert.equal(byName(scanScope({ home }, 'global'), 'dup').status, 'ok');
});

test('deactivate / activate round trip (global)', () => {
  const home = buildHome();
  const o = { home, cwd: home };
  runAction(o, { action: 'deactivate', scope: 'global', name: 'good' });
  let s = byName(scanScope(o, 'global'), 'good');
  assert.equal(s.active, false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'good')), false);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills-inactive', 'good', 'SKILL.md')));
  runAction(o, { action: 'activate', scope: 'global', name: 'good' });
  s = byName(scanScope(o, 'global'), 'good');
  assert.equal(s.active, true);
  assert.equal(s.status, 'ok');
  // activate the originally inactive one
  runAction(o, { action: 'activate', scope: 'global', name: 'sleepy' });
  assert.equal(byName(scanScope(o, 'global'), 'sleepy').status, 'ok');
  assert.equal(fs.readlinkSync(path.join(home, '.claude', 'skills', 'sleepy')), '../../.agents/skills/sleepy');
});

test('deactivate refuses a real claude folder', () => {
  const home = buildHome();
  assert.throws(() => runAction({ home }, { action: 'deactivate', scope: 'global', name: 'dup' }), { code: 'needs-normalize' });
});

test('local deactivate / activate round trip', () => {
  const home = buildHome();
  const root = buildProject(home);
  const o = { home, cwd: root };
  runAction(o, { action: 'deactivate', scope: 'local', name: 'both' });
  assert.equal(byName(scanScope(o, 'local'), 'both').active, false);
  assert.ok(fs.existsSync(path.join(root, '.agents', 'skills-inactive', 'both')));
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills-inactive', 'both')));
  runAction(o, { action: 'activate', scope: 'local', name: 'both' });
  assert.equal(byName(scanScope(o, 'local'), 'both').active, true);
});

test('delete goes to trash and removes the claude symlink', () => {
  const home = buildHome();
  const o = { home, cwd: home };
  runAction(o, { action: 'delete', scope: 'global', name: 'good' });
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'good')), false);
  assert.equal(fs.lstatSync(path.join(home, '.claude', 'skills'), {}).isDirectory(), true);
  const trash = fs.readdirSync(path.join(home, '.agents', 'skills-trash'));
  assert.equal(trash.length, 1);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills-trash', trash[0], 'SKILL.md')));
  assert.equal(byName(scanScope(o, 'global'), 'good'), undefined);
  // broken symlink: unlinked, not trashed
  runAction(o, { action: 'delete', scope: 'global', name: 'gone' });
  assert.equal(fs.readdirSync(path.join(home, '.agents', 'skills-trash')).length, 1);
  assert.throws(() => runAction(o, { action: 'delete', scope: 'global', name: 'nope' }), { code: 'not-found' });
});

test('promote copies local -> global with symlink; exists unless overwrite', () => {
  const home = buildHome();
  const root = buildProject(home);
  const o = { home, cwd: root };
  runAction(o, { action: 'promote', scope: 'local', name: 'localonly' });
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'localonly', 'SKILL.md'))); // copy, not move
  assert.equal(byName(scanScope(o, 'global'), 'localonly').status, 'ok');
  assert.throws(() => runAction(o, { action: 'promote', scope: 'local', name: 'localonly' }), { code: 'exists' });
  write(path.join(root, '.claude', 'skills', 'localonly', 'SKILL.md'), skillMd('localonly', 'new'));
  const dry = runAction(o, { action: 'promote', scope: 'local', name: 'localonly', overwrite: true, dryRun: true });
  assert.ok(dry.changes.length >= 3);
  runAction(o, { action: 'promote', scope: 'local', name: 'localonly', overwrite: true });
  assert.equal(byName(scanScope(o, 'global'), 'localonly').description, 'new');
  assert.equal(fs.readdirSync(path.join(home, '.agents', 'skills-trash')).length, 1);
});

test('copyToLocal: default claude target, agents target, exists/overwrite, no project', () => {
  const home = buildHome();
  const root = buildProject(home);
  const o = { home, cwd: root };
  runAction(o, { action: 'copyToLocal', scope: 'global', name: 'unlinked' });
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'unlinked', 'SKILL.md')));
  assert.equal(fs.lstatSync(path.join(root, '.claude', 'skills', 'unlinked')).isSymbolicLink(), false);
  runAction(o, { action: 'copyToLocal', scope: 'global', name: 'unlinked', target: 'agents' });
  assert.ok(fs.existsSync(path.join(root, '.agents', 'skills', 'unlinked', 'SKILL.md')));
  assert.throws(() => runAction(o, { action: 'copyToLocal', name: 'unlinked' }), { code: 'exists' });
  runAction(o, { action: 'copyToLocal', name: 'unlinked', overwrite: true });
  assert.equal(fs.readdirSync(path.join(root, '.agents', 'skills-trash')).length, 1);
  assert.throws(() => runAction({ home, cwd: home }, { action: 'copyToLocal', name: 'good' }), { code: 'no-project' });
});

test('invalid input is rejected', () => {
  const home = buildHome();
  const o = { home, cwd: home };
  for (const name of ['../x', 'a/b', '.hidden', '']) {
    assert.throws(() => runAction(o, { action: 'delete', scope: 'global', name }), { code: 'invalid' });
  }
  assert.throws(() => runAction(o, { action: 'explode', scope: 'global', name: 'good' }), { code: 'invalid' });
});

test('getSkill returns markdown and tree', () => {
  const home = buildHome();
  mkSkill(path.join(home, '.agents', 'skills'), 'rich', { extra: { 'references/a.md': 'hi' } });
  const r = getSkill({ home, cwd: home }, 'global', 'rich');
  assert.match(r.markdown, /# rich/);
  assert.deepEqual(r.tree, ['SKILL.md', 'references/a.md']);
  assert.equal(r.skill.files, 2);
  assert.throws(() => getSkill({ home }, 'global', 'missing'), { code: 'not-found' });
});

// ---- .gitignore handling on local deactivate -----------------------------

const deactivateLocal = (o, dryRun = false) => runAction(o, { action: 'deactivate', scope: 'local', name: 'both', dryRun });

test('local deactivate appends skills-inactive/ to an existing .gitignore, once', () => {
  const home = buildHome();
  const root = buildProject(home);
  const gi = path.join(root, '.gitignore');
  write(gi, 'node_modules\n');
  const o = { home, cwd: root };
  const r = deactivateLocal(o);
  assert.ok(r.changes.some((c) => c.startsWith('append skills-inactive/ to ')));
  assert.equal(fs.readFileSync(gi, 'utf8'), 'node_modules\nskills-inactive/\n');
  runAction(o, { action: 'activate', scope: 'local', name: 'both' });
  const r2 = deactivateLocal(o);
  assert.ok(!r2.changes.some((c) => c.includes('.gitignore')));
  assert.equal(fs.readFileSync(gi, 'utf8'), 'node_modules\nskills-inactive/\n');
});

test('local deactivate leaves .gitignore alone when skills-inactive is already mentioned', () => {
  for (const line of ['skills-inactive/', '.claude/skills-inactive', '**/skills-inactive/', '  /.agents/skills-inactive/  ']) {
    const home = buildHome();
    const root = buildProject(home);
    const gi = path.join(root, '.gitignore');
    write(gi, `# skills-inactive\n\n${line}\n`);
    const before = fs.readFileSync(gi, 'utf8');
    const r = deactivateLocal({ home, cwd: root });
    assert.ok(!r.changes.some((c) => c.includes('.gitignore')), line);
    assert.equal(fs.readFileSync(gi, 'utf8'), before);
  }
});

test('a commented-out mention does not count', () => {
  const home = buildHome();
  const root = buildProject(home);
  write(path.join(root, '.gitignore'), '# skills-inactive/\n');
  deactivateLocal({ home, cwd: root });
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '# skills-inactive/\nskills-inactive/\n');
});

test('local deactivate never creates a .gitignore', () => {
  const home = buildHome();
  const root = buildProject(home);
  const r = deactivateLocal({ home, cwd: root });
  assert.ok(!r.changes.some((c) => c.includes('.gitignore')));
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
});

test('missing trailing newline is handled', () => {
  const home = buildHome();
  const root = buildProject(home);
  const gi = path.join(root, '.gitignore');
  write(gi, 'dist');
  deactivateLocal({ home, cwd: root });
  assert.equal(fs.readFileSync(gi, 'utf8'), 'dist\nskills-inactive/\n');
});

test('dryRun lists the .gitignore change but does not write it', () => {
  const home = buildHome();
  const root = buildProject(home);
  const gi = path.join(root, '.gitignore');
  write(gi, 'dist\n');
  const r = deactivateLocal({ home, cwd: root }, true);
  assert.ok(r.changes.some((c) => c.startsWith('append skills-inactive/ to ')));
  assert.equal(fs.readFileSync(gi, 'utf8'), 'dist\n');
});

test('global deactivate and other actions leave .gitignore alone', () => {
  const home = buildHome();
  const root = buildProject(home);
  const gi = path.join(root, '.gitignore');
  write(gi, 'dist\n');
  const o = { home, cwd: root };
  runAction(o, { action: 'deactivate', scope: 'global', name: 'good' });
  runAction(o, { action: 'activate', scope: 'global', name: 'good' });
  runAction(o, { action: 'promote', scope: 'local', name: 'localonly' });
  runAction(o, { action: 'delete', scope: 'local', name: 'localonly' });
  assert.equal(fs.readFileSync(gi, 'utf8'), 'dist\n');
});

test('local deactivate skips the .gitignore outside a git project', () => {
  const home = buildHome();
  const root = buildProject(home);
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  write(path.join(root, '.gitignore'), 'dist\n');
  const r = deactivateLocal({ home, cwd: root });
  assert.ok(!r.changes.some((c) => c.includes('.gitignore')));
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'dist\n');
});
