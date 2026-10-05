import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { resolveContext, SkmError } from './context.mjs';
import { dirHash } from './fsutil.mjs';
import { GIT_CONCURRENCY, mapLimit, projectAuto } from './projectinfo.mjs';
import { projectMetaFor, readProjectMeta, writeProjectMeta } from './projectmeta.mjs';
import { scanScope } from './scan.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash']);

/** Files that mark a folder as one project even without git or skills. */
const MARKER_FILES = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'config.xml', 'plugin.xml', 'Package.swift', 'build.gradle', 'build.gradle.kts', 'pubspec.yaml']);
const MARKER_EXTS = ['.xcodeproj', '.csproj', '.sln', '.oml', '.oap'];
const isMarker = (name) => MARKER_FILES.has(name) || MARKER_EXTS.some((x) => name.endsWith(x));

/** Does `dir` hold a project marker file (see MARKER_FILES / MARKER_EXTS)? */
function hasMarker(dir) {
  try {
    return fs.readdirSync(dir).some(isMarker);
  } catch {
    return false;
  }
}

const inside = (dir, root) => dir === root || dir.startsWith(root + path.sep);

/** Token estimate for one skill, `ceil(chars / 4)`. Single place to swap for the shared cost module. */
export function skillCost(skill) {
  if (skill.cost) return skill.cost;
  const tokens = (chars) => Math.ceil(chars / 4);
  let full = 0;
  for (const l of skill.locations) {
    if (l.kind === 'broken-symlink') continue;
    try {
      full = fs.readFileSync(path.join(l.path, 'SKILL.md'), 'utf8').length;
      break;
    } catch {}
  }
  return { listing: tokens(skill.name.length + skill.description.length), full: tokens(full) };
}

/** A context whose local scope is the project at `root` (`cwd` = root, so its markers are found). */
const projectCtx = (ctx, root) => resolveContext({ ...ctx, resolved: false, cwd: root, projectRoot: root });

/**
 * Projects (not symlinked dirs) below `root` up to `depth` levels; never descends into a found project. A folder is a
 * project when it has a `.git` entry (dir or file), skills in `.agents/skills` or `.claude/skills`, or a marker file.
 */
function findProjects(ctx, root, depth) {
  const found = [];
  const visit = (dir, level) => {
    if (dir !== ctx.home) {
      const pctx = projectCtx(ctx, dir);
      const skills = scanScope(pctx, 'local');
      if (skills.length || fs.existsSync(path.join(dir, '.git')) || hasMarker(dir)) {
        found.push({ root: dir, name: path.basename(dir), skills, ctx: pctx });
        return;
      }
    }
    if (level >= depth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      visit(path.join(dir, e.name), level + 1);
    }
  };
  visit(root, 0);
  return found;
}

function skillDir(skill) {
  const loc = skill.locations.find((l) => l.kind !== 'broken-symlink' && !l.inactive) ?? skill.locations.find((l) => l.kind !== 'broken-symlink');
  return loc?.path ?? null;
}

const skillEntry = (s) => ({ name: s.name, active: s.active, status: s.status, cost: skillCost(s), meta: s.meta });

/**
 * Scan the configured roots. `config` overrides the stored one ({ projectRoots, scanDepth }). Every project carries its
 * stored `meta` and its computed `auto` facts (git best effort, run with bounded concurrency).
 */
export async function scanProjects(opts = {}, config) {
  const ctx = resolveContext(opts);
  const { projectRoots, scanDepth } = config ?? readConfig(ctx);
  const seen = new Set();
  let projects = [];
  const metas = readProjectMeta(ctx);
  const dirs = new Map(); // project root -> name -> folder
  for (const r of projectRoots) {
    for (const p of findProjects(ctx, r, scanDepth)) {
      if (seen.has(p.root)) continue;
      seen.add(p.root);
      const map = new Map(p.skills.map((s) => [s.name, skillDir(s)]));
      dirs.set(p.root, map);
      projects.push({
        root: p.root,
        name: p.name,
        meta: projectMetaFor(metas, p.root),
        skills: p.skills.map(skillEntry),
      });
    }
  }
  projects.sort((a, b) => (a.root < b.root ? -1 : 1));
  const autos = await mapLimit(projects, GIT_CONCURRENCY, (p) => projectAuto(ctx, p.root));
  projects = projects.map((p, i) => ({ root: p.root, name: p.name, meta: p.meta, auto: autos[i], skills: p.skills }));

  const byName = new Map();
  for (const p of projects) for (const s of p.skills) byName.set(s.name, [...(byName.get(s.name) ?? []), p.root]);
  const global = new Set(scanScope(ctx, 'global').map((s) => s.name));
  const repeated = [];
  for (const [name, roots] of [...byName].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (roots.length < 2) continue;
    const hashes = roots.map((r) => {
      const d = dirs.get(r).get(name);
      try {
        return d ? dirHash(d) : null;
      } catch {
        return null;
      }
    });
    repeated.push({ name, projects: roots, inGlobal: global.has(name), identical: hashes.every((h) => h && h === hashes[0]) });
  }
  return { roots: projectRoots, projects, repeated };
}

/**
 * Context for an action on another project. `projectRoot` must be an absolute path to an existing
 * project that lies inside a configured root or is the current project (symlinks resolved first).
 */
export function projectContext(opts, projectRoot) {
  const ctx = resolveContext(opts);
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new SkmError('invalid', 'projectRoot must be an absolute path');
  let real;
  try {
    real = fs.realpathSync(projectRoot);
    if (!fs.statSync(real).isDirectory()) throw new Error();
  } catch {
    throw new SkmError('not-found', `projectRoot is not an existing directory: ${projectRoot}`);
  }
  const roots = [...readConfig(ctx).projectRoots];
  if (ctx.project) roots.push(ctx.project.root);
  const allowed = [];
  for (const r of roots) {
    try {
      allowed.push(fs.realpathSync(r));
    } catch {}
  }
  let pctx = resolveContext({ ...ctx, resolved: false, cwd: real });
  if (!pctx.project && hasMarker(real)) pctx = projectCtx(ctx, real);
  const proj = pctx.project?.root;
  if (!proj) throw new SkmError('no-project', `not a project: ${projectRoot}`);
  if (!allowed.some((r) => inside(proj, r))) throw new SkmError('forbidden', `projectRoot is outside the configured project roots: ${projectRoot}`);
  return pctx;
}

/** The same entry `scanProjects` returns, for one project folder (used for projects without skills and the current one). */
export async function describeProject(opts, root) {
  const ctx = resolveContext(opts);
  const pctx = projectCtx(ctx, root);
  return {
    root,
    name: path.basename(root),
    meta: projectMetaFor(readProjectMeta(ctx), root),
    auto: await projectAuto(ctx, root),
    skills: scanScope(pctx, 'local').map(skillEntry),
  };
}

/** Change the stored meta of a project; `req.root` goes through the same guard as `projectRoot` on actions. Returns the meta. */
export function updateProjectMeta(opts, req) {
  const pctx = projectContext(opts, req?.root);
  return writeProjectMeta(opts, pctx.project.root, req);
}
