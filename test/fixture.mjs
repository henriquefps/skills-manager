import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skm-test-')));
}

export function write(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export const skillMd = (name, desc = `${name} skill`) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`;

/** Create a real skill folder at dir/name with a SKILL.md (and optional extra files). */
export function mkSkill(dir, name, { md = skillMd(name), extra = {} } = {}) {
  write(path.join(dir, name, 'SKILL.md'), md);
  for (const [f, content] of Object.entries(extra)) write(path.join(dir, name, f), content);
}

export const link = (target, p) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.symlinkSync(target, p, 'dir');
};

/** A fake $HOME mimicking the real layout, with every interesting case. Returns the home dir. */
export function buildHome() {
  const home = tmp();
  const ag = path.join(home, '.agents', 'skills');
  const cl = path.join(home, '.claude', 'skills');
  // ok: canonical + relative symlink
  mkSkill(ag, 'good');
  link('../../.agents/skills/good', path.join(cl, 'good'));
  // needs-link
  mkSkill(ag, 'unlinked');
  // duplicate (identical) and diverged
  mkSkill(ag, 'dup');
  mkSkill(cl, 'dup');
  mkSkill(ag, 'split', { md: skillMd('split', 'agents version') });
  mkSkill(cl, 'split', { md: skillMd('split', 'claude version') });
  // claude-only
  mkSkill(cl, 'orphan');
  // broken symlink
  link('../../.agents/skills/gone', path.join(cl, 'gone'));
  // wrong link
  mkSkill(path.join(home, 'elsewhere'), 'stray');
  link('../../elsewhere/stray', path.join(cl, 'stray'));
  // empty folder
  fs.mkdirSync(path.join(ag, 'youtube_transcript_skill'), { recursive: true });
  link('../../.agents/skills/youtube_transcript_skill', path.join(cl, 'youtube_transcript_skill'));
  // syncthing conflict
  mkSkill(ag, 'conflicted', { extra: { 'SKILL.sync-conflict-20260101-120000-ABC.md': 'x' } });
  link('../../.agents/skills/conflicted', path.join(cl, 'conflicted'));
  // inactive
  mkSkill(path.join(home, '.agents', 'skills-inactive'), 'sleepy');
  // ignored noise
  for (const d of [ag, cl]) {
    write(path.join(d, '.DS_Store'), 'x');
    fs.mkdirSync(path.join(d, '.trash'), { recursive: true });
    fs.mkdirSync(path.join(d, '.stfolder'), { recursive: true });
    fs.mkdirSync(path.join(d, 'synced'), { recursive: true });
  }
  return home;
}

/** A project dir under tmp with .git; returns { root, home }. */
export function buildProject(home) {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  mkSkill(path.join(root, '.claude', 'skills'), 'localonly');
  mkSkill(path.join(root, '.agents', 'skills'), 'both');
  mkSkill(path.join(root, '.claude', 'skills'), 'both');
  mkSkill(path.join(root, '.agents', 'skills'), 'good'); // same name as a global skill
  link('../../.agents/skills/good', path.join(root, '.claude', 'skills', 'good'));
  return root;
}
