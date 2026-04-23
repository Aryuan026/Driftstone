import http from 'http';
import { readFile } from 'fs/promises';
import { extname, normalize, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildNotFoundPayload, dispatchRegisteredRoute } from './routes/registry.js';

const PORT = Number(process.env.PORT || 3460);
const HOST = process.env.HOST || '127.0.0.1';
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function resolveFrontendRequestPath(pathname = '/') {
  const decoded = decodeURIComponent(pathname || '/');
  if (decoded === '/' || decoded === '/index.html') return resolve(APP_ROOT, 'index.html');
  if (decoded === '/legacy' || decoded === '/legacy/' || decoded === '/legacy/index.html') {
    return resolve(APP_ROOT, 'legacy', 'index.html');
  }
  if (decoded.startsWith('/ui/') || decoded.startsWith('/legacy/')) {
    const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
    return resolve(APP_ROOT, relative);
  }
  return '';
}

async function tryServeFrontendAsset(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method || '')) return false;
  if (String(url.pathname || '').startsWith('/api/')) return false;

  const filePath = resolveFrontendRequestPath(url.pathname);
  if (!filePath) return false;
  if (!filePath.startsWith(APP_ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }

  try {
    const body = await readFile(filePath);
    const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    res.end(body);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return false;
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (statusCode, headers = {}) => originalWriteHead(statusCode, {
    ...CORS_HEADERS,
    ...headers
  });
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const handled = await dispatchRegisteredRoute(req, res, url);
    if (handled) return;
    const served = await tryServeFrontendAsset(req, res, url);
    if (served) return;
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buildNotFoundPayload(), null, 2));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: false,
      error: error && error.message ? error.message : 'Unknown error'
    }, null, 2));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`hippocove backend listening on http://${HOST}:${PORT}`);
});
