import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { symlinkDir } from '../src/core/actions.mjs';
import { trashTarget } from '../src/core/trash.mjs';
import { tmp } from './fixture.mjs';

const now = new Date(2026, 0, 2, 3, 4, 5);

test('win32 trash target uses LOCALAPPDATA and avoids clashes', () => {
  const local = tmp();
  const base = { home: '/h', platform: 'win32', now, env: { LOCALAPPDATA: local }, taken: new Set() };
  const dir = path.join(local, 'skm', 'Trash');
  assert.equal(trashTarget('/x/foo', base).dest, path.join(dir, 'foo'));
  assert.equal(trashTarget('/y/foo', base).dest, path.join(dir, 'foo 2026-01-02 03.04.05'));
  assert.equal(trashTarget('/z/foo', base).dest, path.join(dir, 'foo 2026-01-02 03.04.05 2'));
  fs.mkdirSync(path.join(dir, 'bar'), { recursive: true });
  assert.equal(trashTarget('/x/bar', { ...base, taken: new Set() }).dest, path.join(dir, 'bar 2026-01-02 03.04.05'));
});

test('win32 trash target falls back to home AppData', () => {
  const { dest } = trashTarget('/x/foo', { home: '/h', platform: 'win32', now, env: {} });
  assert.equal(dest, path.join('/h', 'AppData', 'Local', 'skm', 'Trash', 'foo'));
});

test('symlinkDir falls back to a junction with an absolute target on win32 EPERM', () => {
  const calls = [];
  const fsImpl = {
    symlinkSync(t, p, type) {
      calls.push([t, p, type]);
      if (type === 'dir') throw Object.assign(new Error('nope'), { code: 'EPERM' });
    },
  };
  symlinkDir('../../.agents/skills/a', '/r/.claude/skills/a', { platform: 'win32', fsImpl });
  assert.deepEqual(calls, [
    ['../../.agents/skills/a', '/r/.claude/skills/a', 'dir'],
    [path.resolve('/r/.claude/skills', '../../.agents/skills/a'), '/r/.claude/skills/a', 'junction'],
  ]);
});

test('symlinkDir does not fall back off win32 or on other errors', () => {
  const eperm = { symlinkSync() { throw Object.assign(new Error('x'), { code: 'EPERM' }); } };
  assert.throws(() => symlinkDir('t', '/l', { platform: 'linux', fsImpl: eperm }), { code: 'EPERM' });
  const eexist = { symlinkSync() { throw Object.assign(new Error('x'), { code: 'EEXIST' }); } };
  assert.throws(() => symlinkDir('t', '/l', { platform: 'win32', fsImpl: eexist }), { code: 'EEXIST' });
});
