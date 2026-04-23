import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { getScopedCardRegistryDir, safeScopeSegment } from './path-config.js';

const registryCache = new Map();

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeScopeInput(options = {}) {
  return {
    ownerId: safeText(options?.ownerId ?? options?.owner_id),
    realmId: safeText(options?.realmId ?? options?.realm_id)
  };
}

function uniqueStrings(items, limit = 24) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function scopeCacheKey(ownerId = '', realmId = '') {
  return `${safeText(ownerId)}::${safeText(realmId || 'default')}`;
}

function buildScopedMeta(ownerId = '', realmId = '') {
  return {
    owner_id: safeText(ownerId),
    realm_id: safeText(realmId || 'default')
  };
}

function sortByUpdatedAt(items = []) {
  return (Array.isArray(items) ? items : []).slice().sort((a, b) => {
    return String(b?.updated_at || b?.created_at || '').localeCompare(String(a?.updated_at || a?.created_at || ''));
  });
}

function isDraftRegistryEntry(item = {}) {
  const status = safeText(item?.status).toLowerCase();
  const phase = safeText(item?.phase).toLowerCase();
  return status === 'draft' || phase === 'growth';
}

function summarizeByKey(items = [], key) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const value = safeText(item?.[key], key === 'family_id' ? 'unassigned' : 'unknown');
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

function buildCardId(entry = {}) {
  const cardType = safeText(entry.card_type, 'memo');
  const familyId = safeText(entry.family_id, 'general');
  const title = safeText(entry.title, 'untitled');
  return [
    safeScopeSegment(cardType, 'memo'),
    safeScopeSegment(familyId, 'general').slice(0, 24),
    safeScopeSegment(title, 'untitled').slice(0, 48),
    Date.now().toString(36)
  ].join('_');
}

function normalizeCardEntry(input = {}, previous = {}) {
  const now = new Date().toISOString();
  const merged = { ...previous, ...input };
  const entry = {
    card_id: safeText(merged.card_id),
    card_type: safeText(merged.card_type || merged.type, 'memo'),
    family_id: safeText(merged.family_id || merged.family, 'unassigned'),
    title: safeText(merged.title, '未命名卡片'),
    status: safeText(merged.status, 'draft'),
    phase: safeText(merged.phase, ''),
    summary_for_growth: safeText(merged.summary_for_growth || merged.summary, ''),
    inject_short: safeText(merged.inject_short, ''),
    voice_fingerprint: uniqueStrings(merged.voice_fingerprint, 12),
    tags: uniqueStrings(merged.tags, 24),
    related_card_ids: uniqueStrings(merged.related_card_ids, 24),
    source_packet_id: safeText(merged.source_packet_id || merged.packet_id, ''),
    source_refs: uniqueStrings(merged.source_refs, 24),
    last_action: safeText(merged.last_action, previous.card_id ? 'update' : 'new'),
    last_actor: safeText(merged.last_actor, 'unknown'),
    updated_at: now,
    created_at: safeText(previous.created_at, now)
  };
  entry.card_id = entry.card_id || buildCardId(entry);
  return entry;
}

function buildRegistrySummary(cards = []) {
  const sorted = sortByUpdatedAt(cards);
  return {
    total_cards: sorted.length,
    by_type: summarizeByKey(sorted, 'card_type'),
    by_family: summarizeByKey(sorted, 'family_id').slice(0, 12),
    last_updated_at: safeText(sorted[0]?.updated_at || sorted[0]?.created_at),
    recent_cards: sorted.slice(0, 8).map((item) => ({
      card_id: safeText(item.card_id),
      card_type: safeText(item.card_type),
      family_id: safeText(item.family_id),
      title: safeText(item.title),
      status: safeText(item.status),
      phase: safeText(item.phase),
      summary_for_growth: safeText(item.summary_for_growth),
      last_action: safeText(item.last_action),
      updated_at: safeText(item.updated_at || item.created_at)
    }))
  };
}

function buildEmptyRegistry(ownerId = '', realmId = '') {
  const scope = buildScopedMeta(ownerId, realmId);
  return {
    schema: 'memory_card_registry_v0.1',
    generated_at: '',
    updated_at: '',
    scope,
    cards: [],
    summary: buildRegistrySummary([])
  };
}

async function writeJsonAtomically(filePath, payload) {
  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  await rename(tmpFile, filePath);
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function ensureCardRegistry({ ownerId = '', realmId = '' } = {}) {
  ({ ownerId, realmId } = normalizeScopeInput({ ownerId, realmId }));
  const scope = buildScopedMeta(ownerId, realmId);
  const cacheKey = scopeCacheKey(scope.owner_id, scope.realm_id);
  if (registryCache.has(cacheKey)) return registryCache.get(cacheKey);
  const dir = getScopedCardRegistryDir(scope.owner_id, scope.realm_id);
  const indexFile = join(dir, 'index.json');
  const latestFile = join(dir, 'latest.json');
  const empty = buildEmptyRegistry(scope.owner_id, scope.realm_id);
  const existing = await readJsonIfExists(indexFile, null);
  const doc = existing || {
    ...empty,
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  doc.summary = buildRegistrySummary(doc.cards || []);
  await mkdir(dir, { recursive: true });
  await writeJsonAtomically(indexFile, doc);
  await writeJsonAtomically(latestFile, {
    schema: 'memory_card_registry_pointer_v0.1',
    generated_at: new Date().toISOString(),
    latest_index: indexFile,
    total_cards: Number(doc.summary?.total_cards || 0),
    scope
  });
  const result = {
    ok: true,
    dir,
    index_file: indexFile,
    latest_file: latestFile,
    registry: doc
  };
  registryCache.set(cacheKey, result);
  return result;
}

export async function loadCardRegistry({ ownerId = '', realmId = '' } = {}) {
  ({ ownerId, realmId } = normalizeScopeInput({ ownerId, realmId }));
  const scope = buildScopedMeta(ownerId, realmId);
  const cacheKey = scopeCacheKey(scope.owner_id, scope.realm_id);
  if (registryCache.has(cacheKey)) return registryCache.get(cacheKey);
  return ensureCardRegistry({ ownerId: scope.owner_id, realmId: scope.realm_id });
}

export async function getCardRegistrySnapshot({ ownerId = '', realmId = '', limit = 12 } = {}) {
  ({ ownerId, realmId } = normalizeScopeInput({ ownerId, realmId }));
  const loaded = await loadCardRegistry({ ownerId, realmId });
  const registry = loaded.registry || buildEmptyRegistry(ownerId, realmId);
  const cards = sortByUpdatedAt(registry.cards || []);
  return {
    ok: true,
    schema: registry.schema,
    scope: registry.scope || buildScopedMeta(ownerId, realmId),
    summary: buildRegistrySummary(cards),
    cards: cards.slice(0, Math.max(1, Number(limit || 12))).map((item) => ({ ...item }))
  };
}

export async function upsertCardRegistryEntry({ ownerId = '', realmId = '', entry = {} } = {}) {
  ({ ownerId, realmId } = normalizeScopeInput({ ownerId, realmId }));
  const loaded = await loadCardRegistry({ ownerId, realmId });
  const registry = loaded.registry || buildEmptyRegistry(ownerId, realmId);
  const cards = Array.isArray(registry.cards) ? registry.cards.slice() : [];
  const requestedId = safeText(entry?.card_id);
  const existingIndex = requestedId
    ? cards.findIndex((item) => safeText(item.card_id) === requestedId)
    : -1;
  const previous = existingIndex >= 0 ? cards[existingIndex] : {};
  const nextEntry = normalizeCardEntry(entry, previous);
  if (existingIndex >= 0) cards.splice(existingIndex, 1, nextEntry);
  else cards.push(nextEntry);
  const nextRegistry = {
    ...registry,
    generated_at: safeText(registry.generated_at, new Date().toISOString()),
    updated_at: new Date().toISOString(),
    cards,
    summary: buildRegistrySummary(cards)
  };
  await writeJsonAtomically(loaded.index_file, nextRegistry);
  await writeJsonAtomically(loaded.latest_file, {
    schema: 'memory_card_registry_pointer_v0.1',
    generated_at: nextRegistry.updated_at,
    latest_index: loaded.index_file,
    total_cards: Number(nextRegistry.summary?.total_cards || 0),
    scope: nextRegistry.scope
  });
  const result = {
    ok: true,
    dir: loaded.dir,
    index_file: loaded.index_file,
    latest_file: loaded.latest_file,
    registry: nextRegistry,
    entry: nextEntry
  };
  registryCache.set(scopeCacheKey(nextRegistry.scope?.owner_id, nextRegistry.scope?.realm_id), result);
  return result;
}

export async function clearDraftCardRegistryEntries({ ownerId = '', realmId = '', cardType = '' } = {}) {
  ({ ownerId, realmId } = normalizeScopeInput({ ownerId, realmId }));
  const loaded = await loadCardRegistry({ ownerId, realmId });
  const registry = loaded.registry || buildEmptyRegistry(ownerId, realmId);
  const wantedType = safeText(cardType);
  const cards = Array.isArray(registry.cards) ? registry.cards.slice() : [];
  let clearedCount = 0;
  const nextCards = cards.filter((item) => {
    const typeMatches = !wantedType || safeText(item?.card_type, 'memo') === wantedType;
    const shouldClear = typeMatches && isDraftRegistryEntry(item);
    if (shouldClear) clearedCount += 1;
    return !shouldClear;
  });
  if (!clearedCount) {
    return {
      ok: true,
      dir: loaded.dir,
      index_file: loaded.index_file,
      latest_file: loaded.latest_file,
      registry,
      cleared_count: 0
    };
  }
  const nextRegistry = {
    ...registry,
    updated_at: new Date().toISOString(),
    cards: nextCards,
    summary: buildRegistrySummary(nextCards)
  };
  await writeJsonAtomically(loaded.index_file, nextRegistry);
  await writeJsonAtomically(loaded.latest_file, {
    schema: 'memory_card_registry_pointer_v0.1',
    generated_at: nextRegistry.updated_at,
    latest_index: loaded.index_file,
    total_cards: Number(nextRegistry.summary?.total_cards || 0),
    scope: nextRegistry.scope
  });
  const result = {
    ok: true,
    dir: loaded.dir,
    index_file: loaded.index_file,
    latest_file: loaded.latest_file,
    registry: nextRegistry,
    cleared_count: clearedCount
  };
  registryCache.set(scopeCacheKey(nextRegistry.scope?.owner_id, nextRegistry.scope?.realm_id), result);
  return result;
}
