import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { diffLines, diffTrees, diffUpstream, getState, gitTreeHash, lintSkill, lockPath, SkmError, statLine } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { link, mkSkill, skillMd, tmp, write } from './fixture.mjs';

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

// ---- cost ----------------------------------------------------------------

test('cost: listing is name + description, full is SKILL.md, estimate is ceil(chars / 4)', () => {
  const home = tmp();
  const md = '---\nname: demo\ndescription: abcdefgh\n---\nbody body\n';
  mkSkill(path.join(home, '.agents', 'skills'), 'demo', { md });
  const s = getState({ home, cwd: home }).global[0];
  assert.deepEqual(s.cost, { listing: Math.ceil('demo abcdefgh'.length / 4), full: Math.ceil(md.length / 4) });
});

test('cost: counted once per name across agents and claude, inactive excluded from totals', () => {
  const home = tmp();
  const ag = path.join(home, '.agents', 'skills');
  mkSkill(ag, 'linked'); // agents + claude symlink
  link('../../.agents/skills/linked', path.join(home, '.claude', 'skills', 'linked'));
  mkSkill(ag, 'copied'); // identical real copies in both
  mkSkill(path.join(home, '.claude', 'skills'), 'copied');
  mkSkill(path.join(home, '.agents', 'skills-inactive'), 'off');
  const proj = tmp();
  fs.mkdirSync(path.join(proj, '.git'));
  mkSkill(path.join(proj, '.agents', 'skills'), 'loc');
  mkSkill(path.join(proj, '.claude', 'skills'), 'loc');
  mkSkill(path.join(proj, '.agents', 'skills-inactive'), 'locoff');
  const st = getState({ home, cwd: proj });
  const one = (scope, n) => st[scope].find((s) => s.name === n).cost.listing;
  assert.equal(st.global.length, 3);
  assert.ok(st.global.find((s) => s.name === 'off').cost.listing > 0); // inactive still has a cost
  assert.deepEqual(st.totals, {
    global: { active: 2, listingTokens: one('global', 'linked') + one('global', 'copied') },
    local: { active: 1, listingTokens: one('local', 'loc') },
    listingTokens: one('global', 'linked') + one('global', 'copied') + one('local', 'loc'),
  });
});

test('cost: a folder without SKILL.md costs nothing', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.agents', 'skills', 'bare'), { recursive: true });
  assert.deepEqual(getState({ home, cwd: home }).global[0].cost, { listing: 0, full: 0 });
});

// ---- lint ----------------------------------------------------------------

const GOOD_DESC = 'Does a useful thing for the user. Use when the user asks for the useful thing.';
const good = (extra = {}) => ({ name: 'demo', desc: GOOD_DESC, body: '# demo\n', ...extra });
function lint(opts = {}) {
  const { name, desc, body, md, files = {}, folder = 'demo' } = { ...good(), ...opts };
  const dir = path.join(tmp(), folder);
  write(path.join(dir, 'SKILL.md'), md ?? `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`);
  for (const [f, c] of Object.entries(files)) write(path.join(dir, f), c);
  return lintSkill(dir, folder);
}
const rules = (findings) => findings.map((f) => f.rule);

test('lint: a clean skill has no findings', () => {
  assert.deepEqual(lint(), []);
});

test('lint: no-skill-md (error)', () => {
  const dir = tmp();
  assert.deepEqual(lintSkill(dir, 'x'), [{ rule: 'no-skill-md', severity: 'error', message: 'folder has no SKILL.md' }]);
});

test('lint: bad-frontmatter (error) for missing, unclosed and unparseable blocks', () => {
  for (const md of ['# just text\n', '---\nname: demo\ndescription: x\n', '---\nthis is not yaml\n---\n']) {
    const f = lint({ md });
    assert.deepEqual(rules(f), ['bad-frontmatter'], md);
    assert.equal(f[0].severity, 'error');
  }
});

test('lint: missing-name and missing-description (error)', () => {
  assert.ok(rules(lint({ md: `---\ndescription: ${GOOD_DESC}\n---\n` })).includes('missing-name'));
  assert.ok(!rules(lint()).includes('missing-name'));
  const f = lint({ md: '---\nname: demo\n---\n' });
  assert.ok(rules(f).includes('missing-description'));
  assert.equal(f.find((x) => x.rule === 'missing-description').severity, 'error');
  assert.ok(!rules(lint()).includes('missing-description'));
});

test('lint: name-mismatch and name-invalid (warn)', () => {
  const f = lint({ name: 'other' });
  assert.deepEqual(f.map((x) => [x.rule, x.severity]), [['name-mismatch', 'warn']]);
  for (const bad of ['Demo_Skill', 'a'.repeat(65)]) {
    assert.ok(rules(lint({ name: bad, folder: bad })).includes('name-invalid'), bad);
  }
  assert.ok(!rules(lint({ name: 'a'.repeat(64), folder: 'a'.repeat(64) })).includes('name-invalid'));
});

test('lint: description-long and description-short (warn), boundaries', () => {
  const pad = (n) => `Use when ${'x'.repeat(n - 9)}`;
  assert.ok(rules(lint({ desc: pad(1025) })).includes('description-long'));
  assert.ok(!rules(lint({ desc: pad(1024) })).includes('description-long'));
  assert.ok(rules(lint({ desc: 'Use when short.' })).includes('description-short'));
  assert.ok(!rules(lint({ desc: pad(40) })).includes('description-short'));
});

test('lint: no-trigger-hint (info) unless the description says when to use it', () => {
  const f = lint({ desc: 'Formats spreadsheets into neat tables with totals and charts.' });
  assert.deepEqual(f.map((x) => [x.rule, x.severity]), [['no-trigger-hint', 'info']]);
  for (const d of ['Formats spreadsheets. Use when the user mentions xlsx.', 'Trigger on spreadsheet requests and similar formatting work.', 'Use this skill whenever you format spreadsheets into tables.', 'Spreadsheet helper to use for reports, when the user wants tables.']) {
    assert.ok(!rules(lint({ desc: d })).includes('no-trigger-hint'), d);
  }
});

test('lint: broken-reference (warn) for links and references/scripts/assets paths', () => {
  const body = 'See [guide](references/guide.md), [site](https://example.com/a.md), [anchor](#top), run `scripts/run.sh` and read assets/logo.png.\n';
  const f = lint({ body });
  assert.deepEqual(f.map((x) => x.rule), ['broken-reference', 'broken-reference', 'broken-reference']);
  assert.ok(f.every((x) => x.severity === 'warn'));
  assert.deepEqual(lint({ body, files: { 'references/guide.md': '', 'scripts/run.sh': '', 'assets/logo.png': '' } }), []);
  // placeholders and a fragment on an existing file are not findings
  assert.deepEqual(lint({ body: 'Use `scripts/<name>.sh` and [x](references/a.md#sec)\n', files: { 'references/a.md': '' } }), []);
});

test('lint: skill-md-large (info) over 500 lines', () => {
  assert.ok(rules(lint({ body: 'line\n'.repeat(497) })).includes('skill-md-large')); // 4 frontmatter lines + 497 = 501
  assert.ok(!rules(lint({ body: 'line\n'.repeat(496) })).includes('skill-md-large')); // exactly 500
});

test('lint is carried on scanned skills and issues stay about layout', () => {
  const home = tmp();
  mkSkill(path.join(home, '.agents', 'skills'), 'demo', { md: skillMd('other', 'tiny') });
  const s = getState({ home, cwd: home }).global[0];
  assert.deepEqual(rules(s.lint).sort(), ['description-short', 'name-mismatch', 'no-trigger-hint']);
  assert.ok(s.issues.every((i) => !/frontmatter|description/.test(i)));
});

// ---- line diff -----------------------------------------------------------

const apply = (oldText, d) => {
  // rebuild the new text from the hunks to prove they are consistent
  const oldLines = oldText.split('\n').filter((_, i, a) => i < a.length - (oldText.endsWith('\n') ? 1 : 0));
  const out = [];
  let pos = 0;
  for (const h of d.hunks) {
    const start = h.oldLines ? h.oldStart - 1 : h.oldStart;
    out.push(...oldLines.slice(pos, start));
    for (const l of h.lines) if (l[0] !== '-') out.push(l.slice(1));
    pos = start + h.oldLines;
  }
  out.push(...oldLines.slice(pos));
  return out.join('\n') + '\n';
};

test('diffLines: identical, empty and simple replace', () => {
  assert.deepEqual(diffLines('a\nb\n', 'a\nb\n'), { insertions: 0, deletions: 0, hunks: [] });
  assert.deepEqual(diffLines('', ''), { insertions: 0, deletions: 0, hunks: [] });
  assert.deepEqual(diffLines('a\nb\nc\n', 'a\nB\nc\n'), {
    insertions: 1,
    deletions: 1,
    hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }],
  });
});

test('diffLines: pure additions and deletions use start 0 for the empty side', () => {
  assert.deepEqual(diffLines('', 'x\ny\n').hunks, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }]);
  assert.deepEqual(diffLines('x\ny\n', '').hunks, [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-x', '-y'] }]);
});

test('diffLines: 3 lines of context, far changes split, near changes merge', () => {
  const nums = (n) => Array.from({ length: n }, (_, i) => `l${i + 1}`);
  const a = nums(20).join('\n') + '\n';
  const far = nums(20);
  far[1] = 'X';
  far[17] = 'Y';
  const d = diffLines(a, far.join('\n') + '\n');
  assert.equal(d.hunks.length, 2);
  assert.deepEqual(d.hunks[0], { oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [' l1', '-l2', '+X', ' l3', ' l4', ' l5'] });
  assert.deepEqual(d.hunks[1], { oldStart: 15, oldLines: 6, newStart: 15, newLines: 6, lines: [' l15', ' l16', ' l17', '-l18', '+Y', ' l19', ' l20'] });
  const near = nums(20);
  near[4] = 'X'; // l5
  near[10] = 'Y'; // l11: 5 unchanged lines between, still within 2 * 3
  const m = diffLines(a, near.join('\n') + '\n');
  assert.equal(m.hunks.length, 1);
  assert.equal(apply(a, m), near.join('\n') + '\n');
});

test('diffLines: hunks rebuild the new text on shuffled inputs', () => {
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let t = 0; t < 40; t++) {
    const a = Array.from({ length: rnd(30) }, () => `w${rnd(6)}`);
    const b = Array.from({ length: rnd(30) }, () => `w${rnd(6)}`);
    const at = a.length ? a.join('\n') + '\n' : '';
    const bt = b.length ? b.join('\n') + '\n' : '';
    const d = diffLines(at, bt);
    if (at === bt) continue;
    assert.equal(apply(at, d), bt === '' ? '\n' : bt, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    assert.equal(d.insertions - d.deletions, b.length - a.length);
  }
});

// ---- tree diff -----------------------------------------------------------

test('diffTrees: added, removed, modified, binary, identical and .git ignored', () => {
  const o = tmp();
  const n = tmp();
  for (const [dir, files] of [
    [o, { 'same.txt': 's\n', 'gone.txt': 'g\n', 'edit.txt': 'a\nb\nc\n', 'bin.dat': Buffer.from([0, 1, 2]), '.git/x': 'o' }],
    [n, { 'same.txt': 's\n', 'new/deep.txt': 'd\n', 'edit.txt': 'a\nB\nc\n', 'bin.dat': Buffer.from([0, 9, 2]), 'img.png': Buffer.from([0, 0]), '.git/y': 'n' }],
  ]) for (const [f, c] of Object.entries(files)) write(path.join(dir, f), c);
  const d = diffTrees(o, n);
  assert.deepEqual(d.stats, { added: 2, removed: 1, modified: 2, insertions: 2, deletions: 2 });
  assert.deepEqual(d.files.map((f) => [f.path, f.status, f.binary]), [
    ['bin.dat', 'modified', true],
    ['edit.txt', 'modified', false],
    ['gone.txt', 'removed', false],
    ['img.png', 'added', true],
    ['new/deep.txt', 'added', false],
  ]);
  assert.deepEqual(d.files[0].hunks, []);
  assert.deepEqual(d.files[2].hunks, [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-g'] }]);
  assert.equal(statLine(d.stats), '2 modified, 2 added, 1 removed (+2 -2)');
  assert.deepEqual(diffTrees(o, o), { stats: { added: 0, removed: 0, modified: 0, insertions: 0, deletions: 0 }, files: [] });
});

// ---- installed -> upstream (file:// git fixture, no network) --------------

function diffFixture() {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: v1\n---\nold line\n');
  write(path.join(repo, 'skills/demo/old.txt'), 'old\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const home = tmp();
  const dir = path.join(home, '.agents', 'skills', 'demo');
  fs.cpSync(path.join(repo, 'skills/demo'), dir, { recursive: true });
  link('../../.agents/skills/demo', path.join(home, '.claude', 'skills', 'demo'));
  write(lockPath(home), JSON.stringify({ version: 3, skills: { demo: { source: 'o/demo', sourceType: 'github', sourceUrl: `file://${repo}`, skillPath: 'skills/demo/SKILL.md', skillFolderHash: gitTreeHash(dir) } } }));
  const upstream = () => {
    write(path.join(repo, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: v2\n---\nnew line\n');
    fs.rmSync(path.join(repo, 'skills/demo/old.txt'));
    write(path.join(repo, 'skills/demo/new.txt'), 'new\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'v2');
  };
  return { repo, home, dir, upstream, opts: { home, cwd: home } };
}

test('diffUpstream: installed -> upstream with hashes, stats, hunks and a cleaned temp dir', async () => {
  const f = diffFixture();
  f.upstream();
  const before = fs.readdirSync(path.join(f.dir, '..')).sort();
  const d = await diffUpstream(f.opts, 'demo');
  assert.equal(d.name, 'demo');
  assert.equal(d.from, gitTreeHash(f.dir).slice(0, 7));
  assert.equal(d.to, git(f.repo, 'rev-parse', 'HEAD:skills/demo').slice(0, 7));
  assert.deepEqual(d.stats, { added: 1, removed: 1, modified: 1, insertions: 3, deletions: 3 });
  const skill = d.files.find((x) => x.path === 'SKILL.md');
  assert.equal(skill.status, 'modified');
  assert.ok(skill.hunks[0].lines.includes('-description: v1') && skill.hunks[0].lines.includes('+description: v2'));
  assert.deepEqual(fs.readdirSync(path.join(f.dir, '..')).sort(), before); // read-only
  // a locally edited file shows as a removal (installed -> upstream)
  write(path.join(f.dir, 'mine.txt'), 'mine\n');
  const e = await diffUpstream(f.opts, 'demo');
  assert.equal(e.files.find((x) => x.path === 'mine.txt').status, 'removed');
});

test('diffUpstream: documented errors', async () => {
  const f = diffFixture();
  const code = async (opts, name) => { try { await diffUpstream(opts, name); } catch (e) { assert.ok(e instanceof SkmError); return e.code; } };
  assert.equal(await code(f.opts, 'nope'), 'not-found');
  mkSkill(path.join(f.home, '.agents', 'skills'), 'plain');
  assert.equal(await code(f.opts, 'plain'), 'not-tracked');
  assert.equal(await code({ ...f.opts, git: () => { throw Object.assign(new Error('x'), { stderr: 'fatal: unable to access' }); } }, 'demo'), 'network');
  git(f.repo, 'rm', '-q', '-r', 'skills/demo');
  git(f.repo, 'commit', '-q', '-m', 'rm');
  assert.equal(await code(f.opts, 'demo'), 'removed-upstream');
});

test('GET /api/diff and /api/state totals, lint and cost', async () => {
  const f = diffFixture();
  f.upstream();
  const srv = await startServer({ ...f.opts, port: 0 });
  const get = async (p) => { const r = await fetch(srv.url + p); return { status: r.status, body: await r.json() }; };
  try {
    const ok = await get('/api/diff?name=demo');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.stats.modified, 1);
    assert.equal((await get('/api/diff?name=nope')).status, 404);
    const st = (await get('/api/state')).body;
    assert.ok(st.global[0].cost.listing > 0 && Array.isArray(st.global[0].lint));
    assert.equal(st.totals.global.active, 1);
    assert.equal(st.totals.listingTokens, st.global[0].cost.listing);
  } finally {
    await srv.close();
  }
});
