import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { diffInstructions, instructionId, INSTRUCTION_FILES, listInstructions, statLine, writeConfig } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { tmp, write } from './fixture.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.mjs');

/** Empty home + project (with .git); `files` maps a path relative to the project (or `~/...` for home) to its text. */
function setup(files = {}) {
  const home = tmp();
  const root = path.join(home, 'code', 'proj');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  for (const [f, text] of Object.entries(files)) write(f.startsWith('~/') ? path.join(home, f.slice(2)) : path.join(root, f), text);
  return { home, root, o: { home, cwd: root } };
}

const fileOf = (r, id) => r.files.find((f) => f.id === id);
const pairOf = (r, a, b) => r.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));

/** Every file under a dir with its bytes, to prove nothing was written. */
const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
  const p = path.join(dir, f);
  const st = fs.lstatSync(p);
  return `${f}:${st.isSymbolicLink() ? fs.readlinkSync(p) : st.isFile() ? fs.readFileSync(p, 'utf8') : 'dir'}`;
});

test('instructions: detects each file name at the project root', () => {
  for (const id of INSTRUCTION_FILES) {
    const { root, o } = setup({ [id]: `# ${id}\nrules\n` });
    const r = listInstructions(o);
    assert.equal(r.project.root, root);
    assert.deepEqual(r.files.map((f) => f.id), [id]);
    const f = fileOf(r, id);
    assert.equal(f.kind, 'file');
    assert.equal(f.scope, 'project');
    assert.equal(f.path, path.join(root, id));
    assert.equal(f.lines, 2);
    assert.ok(f.tokens > 0);
    assert.deepEqual(r.findings, []);
    assert.equal(r.global.kind, 'missing');
  }
});

test('instructions: no project files and no project', () => {
  const { home, o } = setup();
  const r = listInstructions(o);
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.pairs, []);
  const none = listInstructions({ home, cwd: home });
  assert.equal(none.project, null);
  assert.deepEqual(none.files, []);
});

test('instructions: the global ~/.claude/CLAUDE.md honours the injected home', () => {
  const { home, o } = setup({ '~/.claude/CLAUDE.md': 'global rules\n', 'CLAUDE.md': 'project rules\n' });
  const r = listInstructions(o);
  assert.equal(r.global.kind, 'file');
  assert.equal(r.global.scope, 'global');
  assert.equal(r.global.path, path.join(home, '.claude', 'CLAUDE.md'));
  assert.equal(pairOf(r, 'CLAUDE.md', 'global').relation, 'differs');
  assert.deepEqual(r.findings, []); // the global file is meant to differ from the project one
  // SKM_HOME is the same injected home
  assert.equal(listInstructions({ env: { SKM_HOME: home }, cwd: o.cwd }).global.kind, 'file');
});

test('instructions: a plain copy is flagged, also of the global file', () => {
  const { o } = setup({ 'CLAUDE.md': 'same\n', 'AGENTS.md': 'same\n', 'CLAUDE.local.md': 'mine\n', '~/.claude/CLAUDE.md': 'mine\n' });
  const r = listInstructions(o);
  assert.equal(pairOf(r, 'CLAUDE.md', 'AGENTS.md').relation, 'identical');
  assert.deepEqual(r.findings.map((f) => [f.kind, f.files]), [['copy', ['CLAUDE.md', 'AGENTS.md']], ['copy', ['CLAUDE.local.md', 'global']]]);
  assert.match(r.findings[0].message, /AGENTS\.md is a plain copy of CLAUDE\.md/);
  assert.match(r.findings[1].message, /CLAUDE\.local\.md is a plain copy of ~\/\.claude\/CLAUDE\.md/);
});

test('instructions: two shared files that differ are flagged; CLAUDE.local.md may differ', () => {
  const { o } = setup({ 'CLAUDE.md': 'a\nb\n', 'AGENTS.md': 'a\nc\n', '.claude/CLAUDE.md': 'x\n', 'CLAUDE.local.md': 'personal\n' });
  const r = listInstructions(o);
  assert.deepEqual(r.findings.map((f) => f.files), [['CLAUDE.md', 'AGENTS.md'], ['CLAUDE.md', '.claude/CLAUDE.md'], ['AGENTS.md', '.claude/CLAUDE.md']]);
  assert.ok(r.findings.every((f) => f.kind === 'differs'));
  assert.equal(pairOf(r, 'CLAUDE.md', 'CLAUDE.local.md').relation, 'differs');
});

test('instructions: a plain copy is compared once with the other files', () => {
  const { o } = setup({ 'CLAUDE.md': 'same\n', 'AGENTS.md': 'same\n', '.claude/CLAUDE.md': 'other\n' });
  const r = listInstructions(o);
  assert.deepEqual(r.findings.map((f) => [f.kind, f.files]), [['copy', ['CLAUDE.md', 'AGENTS.md']], ['differs', ['CLAUDE.md', '.claude/CLAUDE.md']]]);
  assert.equal(pairOf(r, 'AGENTS.md', '.claude/CLAUDE.md'), undefined);
});

test('instructions: a symlink to another instruction file is a link, not a duplicate', () => {
  const { root, o } = setup({ 'CLAUDE.md': 'rules\n', '~/.claude/CLAUDE.md': 'global\n' });
  fs.symlinkSync('CLAUDE.md', path.join(root, 'AGENTS.md'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.symlinkSync(path.join(o.home, '.claude', 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md'));
  const r = listInstructions(o);
  const agents = fileOf(r, 'AGENTS.md');
  assert.equal(agents.kind, 'symlink');
  assert.equal(agents.target, 'CLAUDE.md');
  assert.equal(agents.linksTo, 'CLAUDE.md');
  assert.equal(fileOf(r, '.claude/CLAUDE.md').linksTo, 'global');
  assert.equal(pairOf(r, 'CLAUDE.md', 'AGENTS.md').relation, 'link');
  assert.equal(pairOf(r, '.claude/CLAUDE.md', 'global').relation, 'link');
  // the link is not compared again with the others: one pair per real file
  assert.equal(pairOf(r, 'AGENTS.md', '.claude/CLAUDE.md'), undefined);
  // .claude/CLAUDE.md is the global file here, and it differs from CLAUDE.md: no copy finding for any link
  assert.deepEqual(r.findings.map((f) => [f.kind, f.files]), [['differs', ['CLAUDE.md', '.claude/CLAUDE.md']]]);
});

test('instructions: a broken symlink is reported', () => {
  const { root, o } = setup();
  fs.symlinkSync('missing.md', path.join(root, 'AGENTS.md'));
  const r = listInstructions(o);
  assert.equal(fileOf(r, 'AGENTS.md').kind, 'broken-symlink');
  assert.deepEqual(r.findings.map((f) => [f.kind, f.files]), [['broken', ['AGENTS.md']]]);
});

test('instructions diff: hunks between two files, reusing diffLines and statLine', () => {
  const { root, o } = setup({ 'CLAUDE.md': 'one\ntwo\nthree\n', 'AGENTS.md': 'one\nTWO\nthree\nfour\n', '~/.claude/CLAUDE.md': 'one\ntwo\nthree\n' });
  const d = diffInstructions(o, 'CLAUDE.md', 'AGENTS.md');
  assert.equal(d.relation, 'differs');
  assert.equal(d.a.path, path.join(root, 'CLAUDE.md'));
  assert.deepEqual(d.stats, { added: 0, removed: 0, modified: 1, insertions: 2, deletions: 1 });
  assert.equal(statLine(d.stats), '1 modified, 0 added, 0 removed (+2 -1)');
  assert.equal(d.files.length, 1);
  assert.equal(d.files[0].path, 'CLAUDE.md -> AGENTS.md');
  assert.deepEqual(d.files[0].hunks, [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' one', '-two', '+TWO', ' three', '+four'] }]);
  // identical and global by id or by path
  const same = diffInstructions(o, './CLAUDE.md', '~/.claude/CLAUDE.md');
  assert.equal(same.relation, 'identical');
  assert.equal(same.b.id, 'global');
  assert.deepEqual(same.files, []);
});

test('instructions diff: link, errors', () => {
  const { home, root, o } = setup({ 'CLAUDE.md': 'rules\n' });
  fs.symlinkSync('CLAUDE.md', path.join(root, 'AGENTS.md'));
  assert.equal(diffInstructions(o, 'AGENTS.md', 'CLAUDE.md').relation, 'link');
  assert.throws(() => diffInstructions(o, 'CLAUDE.md', 'CLAUDE.local.md'), { code: 'not-found' });
  assert.throws(() => diffInstructions(o, 'CLAUDE.md', 'CLAUDE.md'), { code: 'invalid' });
  assert.throws(() => diffInstructions(o, 'CLAUDE.md', '../etc/passwd'), { code: 'invalid' });
  assert.throws(() => diffInstructions({ home, cwd: home }, 'CLAUDE.md', 'global'), { code: 'no-project' });
  assert.throws(() => instructionId('README.md'), { code: 'invalid' });
});

test('instructions: read only, nothing on disk changes', () => {
  const { home, root, o } = setup({ 'CLAUDE.md': 'a\n', 'AGENTS.md': 'a\n', '~/.claude/CLAUDE.md': 'b\n' });
  fs.symlinkSync('CLAUDE.md', path.join(root, 'CLAUDE.local.md'));
  const before = snapshot(home);
  listInstructions(o);
  diffInstructions(o, 'CLAUDE.md', 'global');
  assert.deepEqual(snapshot(home), before);
});

test('api: GET /api/instructions and /api/instructions/diff for a project in the roots', async () => {
  const { home, root } = setup({ 'CLAUDE.md': 'a\n', 'AGENTS.md': 'b\n' });
  writeConfig({ home, cwd: home }, { projectRoots: [path.join(home, 'code')] });
  const srv = await startServer({ home, cwd: home, port: 0 });
  try {
    const get = async (p) => {
      const res = await fetch(srv.url + p);
      return { status: res.status, body: await res.json() };
    };
    const list = await get(`/api/instructions?projectRoot=${encodeURIComponent(root)}`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.files.map((f) => f.id), ['CLAUDE.md', 'AGENTS.md']);
    assert.equal(list.body.findings[0].kind, 'differs');
    const d = await get(`/api/instructions/diff?projectRoot=${encodeURIComponent(root)}&a=CLAUDE.md&b=AGENTS.md`);
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.files[0].hunks[0].lines, ['-a', '+b']);
    const none = await get('/api/instructions');
    assert.equal(none.body.project, null);
    const outside = tmp();
    fs.mkdirSync(path.join(outside, '.git'));
    assert.equal((await get(`/api/instructions?projectRoot=${encodeURIComponent(outside)}`)).status, 403);
    assert.equal((await get(`/api/instructions/diff?projectRoot=${encodeURIComponent(root)}&a=CLAUDE.md&b=CLAUDE.local.md`)).status, 404);
  } finally {
    await srv.close();
  }
});

test('cli: skm instructions lists and flags, diff prints hunks, help and projects show mention them', () => {
  const { home, root } = setup({ 'CLAUDE.md': 'a\nb\n', 'AGENTS.md': 'a\nc\n' });
  fs.mkdirSync(path.join(root, '.claude'));
  fs.symlinkSync('../CLAUDE.md', path.join(root, '.claude', 'CLAUDE.md'));
  writeConfig({ home, cwd: home }, { projectRoots: [path.join(home, 'code')] });
  const skm = (args, cwd = root) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, SKM_HOME: home, NO_COLOR: '1' }, input: '', encoding: 'utf8' });

  const help = skm(['--help']);
  assert.match(help.stdout, /skm instructions \[name\|path\]/);
  assert.match(help.stdout, /skm instructions diff <a> <b>/);

  const ls = skm(['instructions']);
  assert.equal(ls.status, 0, ls.stderr);
  assert.match(ls.stdout, /\.claude\/CLAUDE\.md\s+link -> CLAUDE\.md/);
  assert.match(ls.stdout, /CLAUDE\.md and AGENTS\.md differ/);

  const byName = skm(['instructions', 'proj', '--json'], home);
  assert.equal(byName.status, 0, byName.stderr);
  assert.equal(JSON.parse(byName.stdout).project.root, root);

  const d = skm(['instructions', 'diff', 'CLAUDE.md', 'AGENTS.md', '--project', 'proj'], home);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /@@ -1,2 \+1,2 @@\n a\n-b\n\+c/);
  assert.match(d.stdout, /1 modified, 0 added, 0 removed \(\+1 -1\)/);

  const show = skm(['projects', 'show', 'proj']);
  assert.match(show.stdout, /instructions\s+CLAUDE\.md, AGENTS\.md, \.claude\/CLAUDE\.md -> CLAUDE\.md/);
  assert.match(show.stdout, /CLAUDE\.md and AGENTS\.md differ/);
  assert.ok(JSON.parse(skm(['projects', 'show', 'proj', '--json']).stdout).instructions.files.length === 3);

  const bad = skm(['instructions', 'diff', 'CLAUDE.md']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: skm instructions diff/);
});
