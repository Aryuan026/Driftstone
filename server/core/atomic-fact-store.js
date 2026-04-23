import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { loadReviewedDataset } from './reviewed-store.js';
import { getScopedAtomicFactDir } from './path-config.js';
import { findFamilyRefsForRoot, loadFamilyLedger } from './family-store.js';
import { normalizeCompact } from './growth-helpers.js';

const atomicFactCache = new Map();

function safeText(value) {
  return String(value || '').trim();
}

function uniqueStrings(items, limit = 48) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeText(item);
    if (!text) continue;
    const key = normalizeCompact(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function splitPipeValues(value = '') {
  return uniqueStrings(
    safeText(value)
      .split(/\s*\|\s*/u)
      .map((item) => item.trim())
      .filter(Boolean),
    64
  );
}

function splitFactKeys(value = '') {
  return uniqueStrings(
    safeText(value)
      .split(/\s*[|,]\s*/u)
      .map((item) => item.trim())
      .filter(Boolean),
    64
  );
}

function parseTags(value = '') {
  return uniqueStrings(
    safeText(value)
      .split(/\s+/u)
      .map((item) => item.trim())
      .filter((item) => item.startsWith('#')),
    32
  );
}

function normalizeFactRole(value = '') {
  const text = safeText(value).toLowerCase();
  if (text === 'stable_fact' || text === 'fingerprint_candidate') return text;
  return text || 'unknown';
}

function normalizeFactKey(value = '') {
  return safeText(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '_').replace(/^_+|_+$/g, '');
}

function guessValueType(value = '', explicit = '') {
  const preset = safeText(explicit).toLowerCase();
  if (preset) return preset;
  const text = safeText(value);
  if (!text) return 'text';
  if (/^(true|false)$/iu.test(text)) return 'boolean';
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return 'number';
  if (/^20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}(?:日|号)?)?$/u.test(text)) return 'date';
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) return 'json';
  return 'text';
}

function canonicalFactKey(sourceKey = '', evidenceKey = '') {
  const source = normalizeFactKey(sourceKey);
  const evidence = normalizeFactKey(evidenceKey);
  const joined = `${source} ${evidence}`;
  if (/birthday|生日|诞生/.test(joined)) return 'birthday';
  if (/mbti/.test(joined)) return 'mbti';
  if (/binding|绑定/.test(joined) && (/target|对象|伴侣/.test(joined))) return 'binding_target';
  if (/name_meaning|名字寓意|命名意义/.test(joined)) return 'name_meaning';
  if (/preferred_name|persona_name|partner_name|assistant_name|name/.test(joined) && !/meaning/.test(joined)) return 'name';
  return source || evidence;
}

function tokenizeIdentity(...values) {
  return uniqueStrings(values.flatMap((value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return safeText(value).split(/[|/]/u).map((item) => item.trim()).filter(Boolean);
  }), 24);
}

function extractKeyValuePairs(text = '') {
  const source = safeText(text);
  if (!source) return [];
  const out = [];
  const pattern = /([^|；。\n]+?)\s*=\s*([^|；。\n]+)/gu;
  let match = null;
  while ((match = pattern.exec(source))) {
    out.push({
      raw_key: safeText(match[1]),
      raw_value: safeText(match[2])
    });
  }
  return out;
}

function extractJsonBlobs(text = '') {
  const source = safeText(text);
  if (!source) return [];
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = source.slice(start, i + 1);
        try {
          out.push(JSON.parse(candidate));
        } catch {
          // ignore malformed inline blobs
        }
        start = -1;
      }
    }
  }
  return out;
}

function pickJsonValue(profile = {}, sourceFactKey = '') {
  const source = normalizeFactKey(sourceFactKey);
  if (!source || !profile || typeof profile !== 'object') return '';
  if (source.includes('mbti')) return safeText(profile.mbti);
  if (source.includes('name')) return safeText(profile.name);
  return '';
}

function factIdentityTokens(row = {}) {
  return tokenizeIdentity(
    row.title,
    row.card_name,
    row.anchor_name
  );
}

function buildFactRecord(row = {}, sourceFactKey = '', factKey = '', factValue = '', evidence = '') {
  const normalizedFactKey = canonicalFactKey(sourceFactKey, factKey);
  return {
    atomic_fact_id: [
      safeText(row.source_file),
      String(row.row_no || 0),
      normalizeFactKey(sourceFactKey || factKey),
      normalizeCompact(factValue).slice(0, 48)
    ].join('::'),
    source_file: safeText(row.source_file),
    row_no: Number(row.row_no || 0),
    record_id: safeText(row.record_id),
    layer: safeText(row.layer),
    family_id: safeText(row.family_id),
    family_kind: safeText(row.family_kind),
    family_anchor_id: safeText(row.family_anchor_id),
    family_anchor_title: safeText(row.family_anchor_title),
    family_reason: safeText(row.family_reason),
    anchor_type: safeText(row.anchor_type),
    anchor_name: safeText(row.anchor_name || row.card_name || row.title),
    title: safeText(row.title),
    source_ref: safeText(row.source_ref),
    source_window_id: safeText(row.source_window_id),
    topic_ids: splitPipeValues(row.topic_ids),
    tags: parseTags(row.tags || row.raw?.tags),
    fact_role: normalizeFactRole(row.fact_role || row.raw?.fact_role),
    source_fact_key: safeText(sourceFactKey || row.fact_key || row.raw?.fact_key),
    fact_key: normalizedFactKey,
    fact_value: safeText(factValue),
    value_type: guessValueType(factValue, row.value_type || row.raw?.value_type),
    evidence_text: safeText(evidence),
    identity_tokens: factIdentityTokens(row),
    conflict_hint: false
  };
}

function deriveFactsFromRow(row = {}) {
  const factKeys = splitFactKeys(row.fact_keys || row.raw?.fact_keys || row.fact_key || row.raw?.fact_key);
  const explicitValue = safeText(row.fact_value || row.raw?.fact_value);
  const summary = safeText(row.summary);
  const stablePoints = safeText(row.stable_points);
  const evidenceTexts = uniqueStrings([summary, stablePoints], 6);
  const parsedPairs = evidenceTexts.flatMap((text) => extractKeyValuePairs(text));
  const parsedJson = evidenceTexts.flatMap((text) => extractJsonBlobs(text));
  const out = [];
  const seen = new Set();

  function pushFact(sourceFactKey, factKey, factValue, evidence) {
    const value = safeText(factValue);
    if (!safeText(sourceFactKey || factKey) || !value) return;
    const record = buildFactRecord(row, sourceFactKey, factKey, value, evidence);
    const dedupeKey = `${record.atomic_fact_id}::${record.fact_role}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push(record);
  }

  for (const sourceFactKey of factKeys) {
    if (explicitValue) {
      pushFact(sourceFactKey, sourceFactKey, explicitValue, summary || stablePoints);
    }

    const matchingPairs = parsedPairs.filter((item) => {
      const pairKey = normalizeFactKey(item.raw_key);
      const sourceKey = normalizeFactKey(sourceFactKey);
      return pairKey === sourceKey || sourceKey.includes(pairKey) || pairKey.includes(sourceKey);
    });

    if (matchingPairs.length > 0) {
      for (const pair of matchingPairs) {
        pushFact(sourceFactKey, pair.raw_key, pair.raw_value, pair.raw_key && pair.raw_value ? `${pair.raw_key} = ${pair.raw_value}` : summary);
      }
    } else if (factKeys.length === 1 && parsedPairs.length === 1) {
      const pair = parsedPairs[0];
      pushFact(sourceFactKey, pair.raw_key, pair.raw_value, `${pair.raw_key} = ${pair.raw_value}`);
    }

    for (const profile of parsedJson) {
      const profileValue = pickJsonValue(profile, sourceFactKey);
      if (profileValue) {
        pushFact(sourceFactKey, sourceFactKey, profileValue, JSON.stringify(profile));
      }
    }
  }

  return out;
}

function markConflicts(facts = []) {
  const grouped = new Map();
  for (const fact of facts) {
    if (safeText(fact.fact_role) !== 'stable_fact') continue;
    const key = safeText(fact.fact_key);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, new Set());
    grouped.get(key).add(safeText(fact.fact_value));
  }
  const conflicted = new Set(Array.from(grouped.entries())
    .filter(([, values]) => values.size > 1)
    .map(([key]) => key));
  return facts.map((fact) => ({
    ...fact,
    conflict_hint: conflicted.has(safeText(fact.fact_key))
  }));
}

function summarizeFactForIndex(fact = {}) {
  return {
    atomic_fact_id: safeText(fact.atomic_fact_id),
    fact_key: safeText(fact.fact_key),
    source_fact_key: safeText(fact.source_fact_key),
    fact_role: safeText(fact.fact_role),
    fact_value: safeText(fact.fact_value),
    value_type: safeText(fact.value_type),
    family_id: safeText(fact.family_id),
    family_anchor_id: safeText(fact.family_anchor_id),
    family_anchor_title: safeText(fact.family_anchor_title),
    anchor_type: safeText(fact.anchor_type),
    anchor_name: safeText(fact.anchor_name),
    title: safeText(fact.title),
    source_ref: safeText(fact.source_ref),
    source_window_id: safeText(fact.source_window_id),
    tags: uniqueStrings(fact.tags, 16),
    topic_ids: uniqueStrings(fact.topic_ids, 16),
    identity_tokens: uniqueStrings(fact.identity_tokens, 16),
    conflict_hint: !!fact.conflict_hint
  };
}

function scopeCacheKey(ownerId = '', realmId = '') {
  return `${safeText(ownerId)}::${safeText(realmId || 'default')}`;
}

async function writeJsonAtomically(filePath, payload) {
  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  await rename(tmpFile, filePath);
}

export async function ensureAtomicFactTable({ ownerId = '', realmId = '' } = {}) {
  const owner_id = safeText(ownerId);
  const realm_id = safeText(realmId || 'default');
  const cacheKey = scopeCacheKey(owner_id, realm_id);
  if (atomicFactCache.has(cacheKey)) return atomicFactCache.get(cacheKey);
  const dataset = await loadReviewedDataset({ layers: ['sql'] });
  const facts = markConflicts(dataset.rows.flatMap((row) => deriveFactsFromRow(row)));
  const dir = getScopedAtomicFactDir(owner_id, realm_id);
  const indexFile = join(dir, 'index.json');
  const latestFile = join(dir, 'latest.json');
  const doc = {
    schema: 'memory_atomic_fact_table_v0.1',
    generated_at: new Date().toISOString(),
    scope: { owner_id, realm_id },
    fact_count: facts.length,
    facts: facts.map(summarizeFactForIndex)
  };
  await mkdir(dir, { recursive: true });
  await writeJsonAtomically(indexFile, doc);
  await writeJsonAtomically(latestFile, {
    schema: 'memory_atomic_fact_pointer_v0.1',
    generated_at: doc.generated_at,
    latest_index: indexFile,
    fact_count: facts.length,
    scope: { owner_id, realm_id }
  });
  const result = {
    ok: true,
    dir,
    index_file: indexFile,
    latest_file: latestFile,
    table: doc
  };
  atomicFactCache.set(cacheKey, result);
  return result;
}

export async function loadAtomicFactTable({ ownerId = '', realmId = '' } = {}) {
  const cacheKey = scopeCacheKey(ownerId, realmId);
  if (atomicFactCache.has(cacheKey)) return atomicFactCache.get(cacheKey);
  const ensured = await ensureAtomicFactTable({ ownerId, realmId });
  const raw = await readFile(ensured.index_file, 'utf-8');
  const result = {
    ok: true,
    dir: ensured.dir,
    index_file: ensured.index_file,
    table: JSON.parse(raw)
  };
  atomicFactCache.set(cacheKey, result);
  return result;
}

function factMatchesRootIdentity(root = {}, fact = {}) {
  const rootName = normalizeCompact(root?.canonical_name);
  if (!rootName) return false;
  const rootType = safeText(root?.anchor_type);
  const factType = safeText(fact?.anchor_type);
  const factKey = safeText(fact?.fact_key);
  const allowsRootAttachedTimeFact =
    rootType === 'person'
    && factType === 'time'
    && (/birthday|生日/iu.test(factKey) || /birthday|生日/iu.test(safeText(fact?.source_fact_key)));
  if (factType && factType !== 'unknown' && rootType && factType !== rootType && !allowsRootAttachedTimeFact) {
    return false;
  }
  return uniqueStrings([
    ...(Array.isArray(fact.identity_tokens) ? fact.identity_tokens : []),
    fact.anchor_name,
    fact.title
  ], 24).some((token) => {
    const normalized = normalizeCompact(token);
    if (!normalized) return false;
    if (normalized === rootName) return true;
    if (!/[\p{Script=Han}]/u.test(rootName)) return false;
    const extra = Math.abs(normalized.length - rootName.length);
    return extra > 0
      && extra <= 4
      && (normalized.startsWith(rootName) || normalized.endsWith(rootName));
  });
}

function factMatchesFamilyScope(fact = {}, familyRefs = []) {
  const familyIds = new Set(uniqueStrings((Array.isArray(familyRefs) ? familyRefs : []).flatMap((item) => [
    item?.family_id,
    item?.family_anchor_id,
    item?.family_anchor_title
  ]), 48));

  if (familyIds.size === 0) return false;
  const factFamilyTokens = uniqueStrings([
    fact.family_id,
    fact.family_anchor_id,
    fact.family_anchor_title
  ], 12);
  return factFamilyTokens.some((token) => familyIds.has(token));
}

function withConflictSummary(facts = []) {
  const grouped = new Map();
  for (const fact of facts) {
    const key = safeText(fact.fact_key);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, new Set());
    grouped.get(key).add(safeText(fact.fact_value));
  }
  const conflictKeys = Array.from(grouped.entries())
    .filter(([, values]) => values.size > 1)
    .map(([key]) => key);
  return {
    facts,
    conflict_keys: conflictKeys
  };
}

export async function getAtomicFactsForRoot(root = {}, { ownerId = '', realmId = '', familyRefs = [] } = {}) {
  const tableHit = await loadAtomicFactTable({ ownerId, realmId });
  let resolvedFamilyRefs = Array.isArray(familyRefs) ? familyRefs : [];
  if (resolvedFamilyRefs.length === 0) {
    const familyLedgerHit = await loadFamilyLedger({ ownerId, realmId });
    resolvedFamilyRefs = findFamilyRefsForRoot(root, familyLedgerHit?.ledger || {});
  }
  const allFacts = Array.isArray(tableHit?.table?.facts) ? tableHit.table.facts : [];
  const facts = allFacts
    .filter((fact) => factMatchesRootIdentity(root, fact))
    .sort((a, b) => {
      const roleDelta = safeText(a.fact_role) === 'stable_fact' ? -1 : 1;
      const otherRoleDelta = safeText(b.fact_role) === 'stable_fact' ? -1 : 1;
      if (roleDelta !== otherRoleDelta) return roleDelta - otherRoleDelta;
      return safeText(a.fact_key).localeCompare(safeText(b.fact_key));
    });
  const directIds = new Set(facts.map((fact) => safeText(fact.atomic_fact_id)).filter(Boolean));
  const familyFacts = allFacts
    .filter((fact) => factMatchesFamilyScope(fact, resolvedFamilyRefs))
    .filter((fact) => !directIds.has(safeText(fact.atomic_fact_id)))
    .sort((a, b) => {
      const roleDelta = safeText(a.fact_role) === 'stable_fact' ? -1 : 1;
      const otherRoleDelta = safeText(b.fact_role) === 'stable_fact' ? -1 : 1;
      if (roleDelta !== otherRoleDelta) return roleDelta - otherRoleDelta;
      return safeText(a.fact_key).localeCompare(safeText(b.fact_key));
    });
  const directSummary = withConflictSummary(facts);
  return {
    ...directSummary,
    family_related_facts: familyFacts,
    family_related_conflict_keys: withConflictSummary(familyFacts).conflict_keys
  };
}

export function lookupAtomicFactsByKey(facts = [], factKey = '') {
  const needle = canonicalFactKey(factKey, factKey);
  return (Array.isArray(facts) ? facts : [])
    .filter((fact) => safeText(fact.fact_key) === needle);
}
