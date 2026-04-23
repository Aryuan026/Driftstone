import {
  getMemoryOverview,
  getMemoryRootPacket,
  getMemorySearchResults
} from '../../core/memory-read-service.js';
import { getMemoryContextPacket } from '../../core/memory-context-service.js';
import { getMemoryEntryPacket } from '../../core/memory-entry-service.js';
import { getMemoryShadowPacket } from '../../core/memory-shadow-service.js';
import { getMemoryHomePacket } from '../../core/memory-home-service.js';
import { auditMemoryRecall } from '../../core/memory-recall-audit-service.js';
import { getMemoryScopePacket, listMemoryScopes } from '../../core/memory-scope-service.js';

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

const MEMORY_READ_PATHS = new Set([
  '/api/memory/overview',
  '/api/memory/scopes',
  '/api/memory/scope',
  '/api/memory/search',
  '/api/memory/root',
  '/api/memory/context',
  '/api/memory/home',
  '/api/memory/entry',
  '/api/memory/shadow',
  '/api/memory/audit/recall'
]);

export async function handleMemoryReadRoute(req, res, url) {
  if (!MEMORY_READ_PATHS.has(url.pathname)) return false;

  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }

  if (url.pathname === '/api/memory/overview') {
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    json(res, 200, await getMemoryOverview({ ownerId, realmId }));
    return true;
  }

  if (url.pathname === '/api/memory/scopes') {
    const ownerId = url.searchParams.get('owner_id') || '';
    json(res, 200, await listMemoryScopes({ ownerId }));
    return true;
  }

  if (url.pathname === '/api/memory/scope') {
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const botId = url.searchParams.get('bot_id') || '';
    const rootLimit = Number.parseInt(url.searchParams.get('root_limit') || '8', 10);
    const payload = await getMemoryScopePacket({ ownerId, realmId, botId, rootLimit });
    json(res, payload.ok ? 200 : 404, payload);
    return true;
  }

  if (url.pathname === '/api/memory/search') {
    const query = url.searchParams.get('q') || '';
    const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    json(res, 200, await getMemorySearchResults(query, { limit, ownerId, realmId }));
    return true;
  }

  if (url.pathname === '/api/memory/root') {
    const rootKey = url.searchParams.get('key') || url.searchParams.get('root_key') || '';
    if (!rootKey) {
      json(res, 400, { ok: false, error: 'Missing key' });
      return true;
    }
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const payload = await getMemoryRootPacket(rootKey, { ownerId, realmId });
    json(res, payload.ok ? 200 : 404, payload);
    return true;
  }

  if (url.pathname === '/api/memory/context') {
    const rootKey = url.searchParams.get('key') || url.searchParams.get('root_key') || '';
    const query = url.searchParams.get('q') || '';
    const mode = url.searchParams.get('mode') || 'bot';
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const botId = url.searchParams.get('bot_id') || '';
    const userId = url.searchParams.get('user_id') || '';
    const charId = url.searchParams.get('char_id') || '';
    const payload = await getMemoryContextPacket({
      key: rootKey,
      query,
      mode,
      ownerId,
      realmId,
      botId,
      userId,
      charId
    });
    json(res, payload.ok ? 200 : 404, payload);
    return true;
  }

  if (url.pathname === '/api/memory/home') {
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const botId = url.searchParams.get('bot_id') || '';
    const userId = url.searchParams.get('user_id') || '';
    const charId = url.searchParams.get('char_id') || '';
    const mode = url.searchParams.get('mode') || 'bot';
    const rootLimit = Number.parseInt(url.searchParams.get('root_limit') || '8', 10);
    const payload = await getMemoryHomePacket({
      ownerId,
      realmId,
      botId,
      userId,
      charId,
      mode,
      rootLimit
    });
    json(res, payload.ok ? 200 : 404, payload);
    return true;
  }

  if (url.pathname === '/api/memory/entry') {
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const botId = url.searchParams.get('bot_id') || '';
    const userId = url.searchParams.get('user_id') || '';
    const charId = url.searchParams.get('char_id') || '';
    const mode = url.searchParams.get('mode') || 'bot';
    const rootLimit = Number.parseInt(url.searchParams.get('root_limit') || '8', 10);
    const payload = await getMemoryEntryPacket({
      ownerId,
      realmId,
      botId,
      userId,
      charId,
      mode,
      rootLimit
    });
    json(res, payload.ok ? 200 : 404, payload);
    return true;
  }

  if (url.pathname === '/api/memory/shadow') {
    const rootKey = url.searchParams.get('key') || url.searchParams.get('root_key') || '';
    const query = url.searchParams.get('q') || '';
    const limit = Number.parseInt(url.searchParams.get('limit') || '8', 10);
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const botId = url.searchParams.get('bot_id') || '';
    const userId = url.searchParams.get('user_id') || '';
    const charId = url.searchParams.get('char_id') || '';
    const payload = await getMemoryShadowPacket({
      key: rootKey,
      query,
      limit,
      ownerId,
      realmId,
      botId,
      userId,
      charId
    });
    json(res, payload.ok ? 200 : 404, payload);
    return true;
  }

  if (url.pathname === '/api/memory/audit/recall') {
    const rootKey = url.searchParams.get('key') || url.searchParams.get('root_key') || '';
    const ownerId = url.searchParams.get('owner_id') || '';
    const realmId = url.searchParams.get('realm_id') || '';
    const botId = url.searchParams.get('bot_id') || '';
    const mode = url.searchParams.get('mode') || 'bot';
    const limit = Number.parseInt(url.searchParams.get('limit') || '5', 10);
    json(res, 200, await auditMemoryRecall({
      key: rootKey,
      ownerId,
      realmId,
      botId,
      mode,
      limit
    }));
    return true;
  }

  return false;
}
