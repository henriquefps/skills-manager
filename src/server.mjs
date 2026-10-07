import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkUpdates, diffLocal, diffUpstream, getSkill, getState, projectContext, readConfig, resolveContext, runAction, scanProjects, searchProjects, SkmError, updateIgnore, updateMeta, updateProjectMeta, writeConfig } from './core/index.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const STATUS = { 'not-found': 404, exists: 409, diverged: 409, modified: 409, 'removed-upstream': 409, invalid: 400, network: 502, forbidden: 403 };

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(data);
}

const sendError = (res, err) => {
  if (err instanceof SkmError) {
    return sendJson(res, STATUS[err.code] ?? 400, { ok: false, error: err.message, code: err.code });
  }
  return sendJson(res, 500, { ok: false, error: err?.message ?? String(err), code: 'internal' });
};

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new SkmError('invalid', 'request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Writes are same-origin only: a request carrying a foreign Origin header is refused. */
function refuseCrossOrigin(req) {
  if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new SkmError('forbidden', 'cross-origin request refused');
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    if (err instanceof SkmError) throw err;
    throw new SkmError('invalid', 'request body is not valid JSON');
  }
}

function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.resolve(UI_DIR, `.${rel}`);
  if (file !== UI_DIR && !file.startsWith(UI_DIR + path.sep)) return sendJson(res, 403, { ok: false, error: 'forbidden', code: 'forbidden' });
  let st;
  try {
    st = fs.statSync(file);
  } catch {}
  if (!st?.isFile()) return sendJson(res, 404, { ok: false, error: `not found: ${pathname}`, code: 'not-found' });
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

/** Build the request handler. `opts` = { home, cwd, fetch, git, token } (injectable roots and edges). */
export function createServer(opts = {}) {
  const base = resolveContext(opts);
  return http.createServer(async (req, res) => {
    try {
      // Same-origin only: blocks DNS rebinding and cross-site POSTs.
      const hostOk = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? '');
      if (!hostOk) return sendJson(res, 403, { ok: false, error: 'forbidden host', code: 'forbidden' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const ctx = resolveContext({ ...opts, home: base.home, cwd: base.cwd }); // re-read project markers each request

      if (url.pathname === '/api/state' && req.method === 'GET') return sendJson(res, 200, getState(ctx));
      if (url.pathname === '/api/updates' && req.method === 'GET') return sendJson(res, 200, await checkUpdates(ctx));
      if (url.pathname === '/api/diff' && req.method === 'GET') {
        const name = url.searchParams.get('name');
        if (url.searchParams.get('scope') !== 'local') return sendJson(res, 200, await diffUpstream(ctx, name));
        const root = url.searchParams.get('projectRoot');
        return sendJson(res, 200, diffLocal(root ? projectContext(ctx, root) : ctx, name));
      }
      // projects + config
      if (url.pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, readConfig(ctx));
      if (url.pathname === '/api/config' && req.method === 'PUT') {
        refuseCrossOrigin(req);
        return sendJson(res, 200, writeConfig(ctx, await readJson(req)));
      }
      if (url.pathname === '/api/meta' && req.method === 'POST') {
        refuseCrossOrigin(req);
        const body = await readJson(req);
        const meta = updateMeta(body?.projectRoot === undefined ? ctx : projectContext(ctx, body.projectRoot), body);
        return sendJson(res, 200, { ok: true, meta });
      }
      if (url.pathname === '/api/project-meta' && req.method === 'POST') {
        refuseCrossOrigin(req);
        return sendJson(res, 200, { ok: true, meta: updateProjectMeta(ctx, await readJson(req)) });
      }
      if (url.pathname === '/api/project-ignore' && req.method === 'POST') {
        refuseCrossOrigin(req);
        const { ignore } = updateIgnore(ctx, await readJson(req));
        return sendJson(res, 200, { ok: true, ignore });
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        const scan = await scanProjects(ctx);
        const q = url.searchParams.get('q');
        return sendJson(res, 200, q?.trim() ? { ...scan, projects: searchProjects(scan.projects, q) } : scan);
      }

      if (url.pathname === '/api/skill' && req.method === 'GET') {
        const scope = url.searchParams.get('scope') ?? 'global';
        if (!['global', 'local'].includes(scope)) throw new SkmError('invalid', `invalid scope: ${scope}`);
        return sendJson(res, 200, getSkill(ctx, scope, url.searchParams.get('name')));
      }
      if (url.pathname === '/api/action' && req.method === 'POST') {
        refuseCrossOrigin(req);
        const body = await readJson(req);
        return sendJson(res, 200, runAction(body?.projectRoot === undefined ? ctx : projectContext(ctx, body.projectRoot), body));
      }
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'unknown endpoint', code: 'not-found' });
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, url.pathname);
      return sendJson(res, 405, { ok: false, error: 'method not allowed', code: 'invalid' });
    } catch (err) {
      sendError(res, err);
    }
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

/** Listen on 127.0.0.1, starting at `port` and falling back to the next free one. Port 0 = any free port. */
export async function startServer({ port = 4747, open = false, ...opts } = {}) {
  const server = createServer(opts);
  let p = port;
  for (let tries = 0; ; tries++) {
    try {
      p = await listen(server, p);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || tries >= 50 || port === 0) throw err;
      p++;
    }
  }
  const url = `http://127.0.0.1:${p}`;
  if (open) openBrowser(url);
  return { server, port: p, url, close: () => new Promise((r) => server.close(r)) };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}
