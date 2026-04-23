import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { getScopedGrowthLedgerDir, safeScopeSegment } from './path-config.js';

const ledgerCache = new Map();

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

function sortByCreatedAt(items = []) {
  return (Array.isArray(items) ? items : []).slice().sort((a, b) => {
    return String(b?.created_at || '').localeCompare(String(a?.created_at || ''));
  });
}

function summarizeByDecision(entries = []) {
  const counts = new Map();
  for (const item of Array.isArray(entries) ? entries : []) {
    const decision = safeText(item?.decision, 'unspecified');
    counts.set(decision, (counts.get(decision) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

function buildLedgerEntryId(entry = {}) {
  return [
    safeScopeSegment(entry.decision, 'touch'),
    safeScopeSegment(entry.family_id, 'general').slice(0, 24),
    safeScopeSegment(entry.target_card_id || entry.card_type || 'card', 'card').slice(0, 40),
    Date.now().toString(36)
  ].join('_');
}

function normalizeLedgerEntry(input = {}) {
  const now = new Date().toISOString();
  const entry = {
    entry_id: safeText(input.entry_id),
    created_at: safeText(input.created_at, now),
    packet_id: safeText(input.packet_id),
    family_id: safeText(input.family_id, 'unassigned'),
    card_type: safeText(input.card_type, 'memo'),
    decision: safeText(input.decision, 'touch'),
    target_card_id: safeText(input.target_card_id),
    reason: safeText(input.reason),
    next_hint: safeText(input.next_hint),
    actor: safeText(input.actor, 'unknown'),
    source: safeText(input.source),
    tags: uniqueStrings(input.tags, 24),
    related_card_ids: uniqueStrings(input.related_card_ids, 24),
    payload: input && typeof input.payload === 'object' && input.payload !== null ? input.payload : {}
  };
  entry.entry_id = entry.entry_id || buildLedgerEntryId(entry);
  return entry;
}

function buildLedgerSummary(entries = []) {
  const sorted = sortByCreatedAt(entries);
  return {
    total_entries: sorted.length,
    by_decision: summarizeByDecision(sorted),
    last_entry_at: safeText(sorted[0]?.created_at),
    recent_entries: sorted.slice(0, 12).map((item) => ({
      entry_id: safeText(item.entry_id),
      created_at: safeText(item.created_at),
      family_id: safeText(item.family_id),
      card_type: safeText(item.card_type),
      decision: safeText(item.decision),
      target_card_id: safeText(item.target_card_id),
      reason: safeText(item.reason),
      next_hint: safeText(item.next_hint),
      actor: safeText(item.actor)
    }))
  };
}

function buildEmptyLedger(ownerId = '', realmId = '') {
  const scope = buildScopedMeta(ownerId, realmId);
  return {
    schema: 'memory_growth_ledger_v0.1',
    generated_at: '',
    updated_at: '',
    scope,
    entries: [],
    summary: buildLedgerSummary([])
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

export async function ensureGrowthLedger({ ownerId = '', realmId = '' } = {}) {
  ({ ownerId, realmId } = normalizeScopeInput({ ownerId, realmId }));
  const scope = buildScopedMeta(ownerId, realmId);
  const cacheKey = scopeCacheKey(scope.owner_id, scope.realm_id);
  if (ledgerCache.has(cacheKey)) return ledgerCache.get(cacheKey);
  const dir = getScopedGrowthLedgerDir(scope.owner_id, scope.realm_id);
  const indexFile = join(dir, 'index.json');
  const latestFile = join(dir, 'latest.json');
  const empty = buildEmptyLedger(scope.owner_id, scope.realm_id);
  const existing = await readJsonIfExists(indexFile, null);
  const doc = existing || {
    ...empty,
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  doc.summary = buildLedgerSummary(doc.entries || []);
  await mkdir(dir, { recursive: true });
  await writeJsonAtomically(indexFile, doc);
  await writeJsonAtomically(latestFile, {
    schema: 'memory_growth_ledger_pointer_v0.1',
    generated_at: new Date().toISOString(),
    latest_index: indexFile,
    total_entries: Number(doc.summary?.total_entries || 0),
    scope
  });
  const result = {
    ok: true,
    dir,
    index_file: indexFile,
    latest_file: latestFile,
    ledger: doc
  };
  ledgerCache.set(cacheKey, result);
  return result;
}

export async function loadGrowthLedger({ ownerId = '', realmId = '' } = {}) {
  ({ ownerId, realmId } = normalizeScopeInput({ ownerId, realmId }));
  const scope = buildScopedMeta(ownerId, realmId);
  const cacheKey = scopeCacheKey(scope.owner_id, scope.realm_id);
  if (ledgerCache.has(cacheKey)) return ledgerCache.get(cacheKey);
  return ensureGrowthLedger({ ownerId: scope.owner_id, realmId: scope.realm_id });
}

export async function getGrowthLedgerSnapshot({ ownerId = '', realmId = '', limit = 20 } = {}) {
  ({ ownerId, realmId } = normalizeScopeInput({ ownerId, realmId }));
  const loaded = await loadGrowthLedger({ ownerId, realmId });
  const ledger = loaded.ledger || buildEmptyLedger(ownerId, realmId);
  const entries = sortByCreatedAt(ledger.entries || []);
  return {
    ok: true,
    schema: ledger.schema,
    scope: ledger.scope || buildScopedMeta(ownerId, realmId),
    summary: buildLedgerSummary(entries),
    entries: entries.slice(0, Math.max(1, Number(limit || 20))).map((item) => ({ ...item }))
  };
}

export async function appendGrowthLedgerEntry({ ownerId = '', realmId = '', entry = {} } = {}) {
  ({ ownerId, realmId } = normalizeScopeInput({ ownerId, realmId }));
  const loaded = await loadGrowthLedger({ ownerId, realmId });
  const ledger = loaded.ledger || buildEmptyLedger(ownerId, realmId);
  const entries = Array.isArray(ledger.entries) ? ledger.entries.slice() : [];
  const nextEntry = normalizeLedgerEntry(entry);
  entries.unshift(nextEntry);
  const nextLedger = {
    ...ledger,
    generated_at: safeText(ledger.generated_at, new Date().toISOString()),
    updated_at: new Date().toISOString(),
    entries: entries.slice(0, 400),
    summary: buildLedgerSummary(entries)
  };
  await writeJsonAtomically(loaded.index_file, nextLedger);
  await writeJsonAtomically(loaded.latest_file, {
    schema: 'memory_growth_ledger_pointer_v0.1',
    generated_at: nextLedger.updated_at,
    latest_index: loaded.index_file,
    total_entries: Number(nextLedger.summary?.total_entries || 0),
    scope: nextLedger.scope
  });
  const result = {
    ok: true,
    dir: loaded.dir,
    index_file: loaded.index_file,
    latest_file: loaded.latest_file,
    ledger: nextLedger,
    entry: nextEntry
  };
  ledgerCache.set(scopeCacheKey(nextLedger.scope?.owner_id, nextLedger.scope?.realm_id), result);
  return result;
}
