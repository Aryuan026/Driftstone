import {
  loadRuntimeApiConfig,
  loadRuntimeApiProfiles,
  saveRuntimeApiConfig,
  saveRuntimeApiProfiles
} from '../../core/runtime-api-profile-store.js';

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
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

export async function handleRuntimeApiProfilesRoute(req, res, url) {
  if (url.pathname !== '/api/runtime/api-profiles') return false;

  if (req.method === 'GET') {
    const [profiles, currentConfig] = await Promise.all([
      loadRuntimeApiProfiles(),
      loadRuntimeApiConfig()
    ]);
    json(res, 200, {
      ok: true,
      profiles,
      current_config: currentConfig
    });
    return true;
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const [profiles, currentConfig] = await Promise.all([
      saveRuntimeApiProfiles(body?.profiles),
      saveRuntimeApiConfig(body?.current_config)
    ]);
    json(res, 200, {
      ok: true,
      profiles,
      current_config: currentConfig
    });
    return true;
  }

  json(res, 405, { ok: false, error: 'Method not allowed' });
  return true;
}
