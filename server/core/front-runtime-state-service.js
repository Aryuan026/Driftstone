import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { RUNTIME_SAVE_DIR, getScopedTruthDir, safeScopeSegment } from './path-config.js';

const FRONT_RUNTIME_STATE_DIR = join(RUNTIME_SAVE_DIR, 'front_runtime_state');
const FRONT_RUNTIME_STATE_FILE = join(FRONT_RUNTIME_STATE_DIR, 'latest.json');

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeScope(state = {}) {
  const explicitScope = state?.active_scope && typeof state.active_scope === 'object'
    ? state.active_scope
    : {};
  const parseDashboardScope = state?.parseDashboard?.active_scope && typeof state.parseDashboard.active_scope === 'object'
    ? state.parseDashboard.active_scope
    : {};
  const explicitRealmId = safeText(explicitScope?.realm_id || explicitScope?.realmId || state?.sessionId);
  const parseRealmId = safeText(parseDashboardScope?.realm_id || parseDashboardScope?.realmId);
  const activeScope = explicitRealmId && (!parseRealmId || parseRealmId !== explicitRealmId)
    ? explicitScope
    : (parseDashboardScope?.realm_id || parseDashboardScope?.realmId ? parseDashboardScope : explicitScope);
  const realmId = safeText(activeScope?.realm_id || activeScope?.realmId || state?.sessionId);
  const ownerId = safeText(activeScope?.owner_id || activeScope?.ownerId || (realmId ? 'history-to-obsidian' : ''));
  if (!ownerId || !realmId) return null;
  return {
    owner_id: ownerId,
    realm_id: realmId
  };
}

function normalizeState(state = {}) {
  const normalized = state && typeof state === 'object' ? { ...state } : {};
  const activeScope = normalizeScope(normalized);
  if (activeScope) {
    normalized.sessionId = activeScope.realm_id;
    normalized.active_scope = {
      owner_id: activeScope.owner_id,
      realm_id: activeScope.realm_id
    };
  }
  return {
    saved_at: new Date().toISOString(),
    active_scope: activeScope,
    state: normalized
  };
}

function getScopedStateFile(ownerId = '', realmId = '') {
  if (!ownerId || !realmId) return '';
  return join(
    getScopedTruthDir(ownerId, realmId),
    'front_runtime_state',
    `${safeScopeSegment(realmId, 'default')}.json`
  );
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveFrontRuntimeState(state = {}) {
  const payload = normalizeState(state);
  await mkdir(FRONT_RUNTIME_STATE_DIR, { recursive: true });
  await writeFile(FRONT_RUNTIME_STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const scope = payload.active_scope;
  if (scope?.owner_id && scope?.realm_id) {
    const scopedFile = getScopedStateFile(scope.owner_id, scope.realm_id);
    await mkdir(join(getScopedTruthDir(scope.owner_id, scope.realm_id), 'front_runtime_state'), { recursive: true });
    await writeFile(scopedFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
  return payload;
}

export async function getFrontRuntimeState({ ownerId = '', realmId = '' } = {}) {
  const requestedOwner = safeText(ownerId);
  const requestedRealm = safeText(realmId);
  if (requestedOwner && requestedRealm) {
    const scoped = await readJsonIfExists(getScopedStateFile(requestedOwner, requestedRealm));
    if (scoped) return scoped;
    return null;
  }
  return readJsonIfExists(FRONT_RUNTIME_STATE_FILE);
}
