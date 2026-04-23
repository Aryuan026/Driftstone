import { advanceMemoryBay, drainMemoryBay } from '../../core/memory-advance-service.js';

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export async function handleMemoryAdvanceRoute(req, res, url) {
  if (
    url.pathname !== '/api/memory/advance' &&
    url.pathname !== '/api/memory/advance/drain'
  ) return false;

  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }

  const body = await readJsonBody(req);
  const payload = url.pathname === '/api/memory/advance/drain'
    ? await drainMemoryBay(body)
    : await advanceMemoryBay(body);
  json(res, 200, payload);
  return true;
}
