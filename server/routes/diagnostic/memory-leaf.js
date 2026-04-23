import { getMemoryLeafPacket, writeMemoryLeafEnvelope } from '../../core/memory-leaf-service.js';
import { auditMemoryLeaf } from '../../core/memory-leaf-audit-service.js';
import { applyMemoryLeafRepair, previewMemoryLeafRepair } from '../../core/memory-leaf-repair-service.js';

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

export async function handleMemoryLeafRoute(req, res, url) {
  if (url.pathname === '/api/memory/leaf') {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const botId = url.searchParams.get('bot_id') || '';
    const userId = url.searchParams.get('user_id') || '';
    const charId = url.searchParams.get('char_id') || '';
    json(res, 200, await getMemoryLeafPacket({ ownerId, realmId, botId, userId, charId }));
    return true;
  }

  if (url.pathname === '/api/memory/leaf/audit') {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const botId = url.searchParams.get('bot_id') || '';
    const mode = url.searchParams.get('mode') || 'bot';
    const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
    json(res, 200, await auditMemoryLeaf({ ownerId, realmId, botId, mode, query }));
    return true;
  }

  if (url.pathname === '/api/memory/leaf/repair') {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const botId = url.searchParams.get('bot_id') || '';
    const mode = url.searchParams.get('mode') || 'bot';
    const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
    json(res, 200, await previewMemoryLeafRepair({ ownerId, realmId, botId, mode, query }));
    return true;
  }

  if (url.pathname === '/api/memory/leaf/repair/apply') {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }
    const body = await readJsonBody(req);
    json(res, 200, await applyMemoryLeafRepair({
      ownerId: body?.scope?.owner_id || '',
      realmId: body?.scope?.realm_id || '',
      botId: body?.scope?.bot_id || '',
      mode: body?.mode || 'bot',
      query: body?.query || '',
      source: body?.source || {}
    }));
    return true;
  }

  if (url.pathname === '/api/memory/leaf/write') {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }
    const body = await readJsonBody(req);
    json(res, 200, await writeMemoryLeafEnvelope(body));
    return true;
  }

  return false;
}
