import { mkdir, writeFile, readFile, rename } from 'fs/promises';
import { join } from 'path';
import { loadReviewedDataset } from './reviewed-store.js';
import { getScopedFamilyLedgerDir } from './path-config.js';
import { normalizeAnchorType, normalizeCompact } from './growth-helpers.js';

const familyLedgerCache = new Map();

function safeText(value) {
  return String(value || '').trim();
}

function uniqueStrings(items, limit = 24) {
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

function parseTags(value = '') {
  return uniqueStrings(
    safeText(value)
      .split(/\s+/u)
      .map((item) => item.trim())
      .filter((item) => item.startsWith('#')),
    24
  );
}

function familyKey(row = {}) {
  const familyId = safeText(row.family_id || row.raw?.family_id);
  const familyTitle = safeText(row.family_anchor_title || row.raw?.family_anchor_title);
  if (familyId) return familyId;
  if (familyTitle) return `family_title::${normalizeCompact(familyTitle)}`;
  return '';
}

function buildMemberRef(row = {}) {
  return {
    layer: safeText(row.layer),
    row_no: Number(row.row_no || 0),
    source_file: safeText(row.source_file),
    record_id: safeText(row.record_id || row.raw?.record_id),
    title: safeText(row.title),
    anchor_type: normalizeAnchorType(row.anchor_type || row.raw?.anchor_type || row.card_type || row.raw?.card_type),
    anchor_name: safeText(row.anchor_name || row.raw?.anchor_name),
    card_type: normalizeAnchorType(row.card_type || row.raw?.card_type),
    card_name: safeText(row.card_name || row.raw?.card_name),
    family_id: safeText(row.family_id || row.raw?.family_id),
    family_kind: safeText(row.raw?.family_kind),
    family_anchor_id: safeText(row.raw?.family_anchor_id),
    family_anchor_title: safeText(row.family_anchor_title || row.raw?.family_anchor_title),
    family_reason: safeText(row.raw?.family_reason),
    source_ref: safeText(row.source_ref || row.raw?.source_ref),
    source_window_id: safeText(row.source_window_id || row.raw?.source_window_id),
    topic_ids: uniqueStrings(safeText(row.topic_ids || row.raw?.topic_ids).split('|')),
    tags: parseTags(row.raw?.tags)
  };
}

function memberIdentityTokens(member = {}) {
  return uniqueStrings([
    member.title,
    member.anchor_name,
    member.card_name,
    member.family_anchor_title
  ], 12);
}

function identityMatchesMember(root = {}, member = {}) {
  const rootName = normalizeCompact(root?.canonical_name);
  if (!rootName) return false;
  const rootType = normalizeAnchorType(root?.anchor_type);
  const memberType = normalizeAnchorType(member?.anchor_type || member?.card_type);
  const typeCompatible = !memberType || memberType === 'unknown' || memberType === rootType;
  if (!typeCompatible) return false;
  return memberIdentityTokens(member).some((item) => normalizeCompact(item) === rootName);
}

function buildFamilyEntry(seed = {}) {
  return {
    family_id: safeText(seed.family_id),
    family_kind: safeText(seed.family_kind) || 'persona_sql_family',
    family_anchor_id: safeText(seed.family_anchor_id),
    family_anchor_title: safeText(seed.family_anchor_title),
    family_reason: safeText(seed.family_reason),
    persona_count: 0,
    sql_count: 0,
    layers: [],
    source_files: [],
    persona_members: [],
    sql_members: []
  };
}

function summarizeFamilyRef(entry = {}) {
  return {
    family_id: safeText(entry.family_id),
    family_kind: safeText(entry.family_kind),
    family_anchor_id: safeText(entry.family_anchor_id),
    family_anchor_title: safeText(entry.family_anchor_title),
    family_reason: safeText(entry.family_reason),
    persona_count: Number(entry.persona_count || 0),
    sql_count: Number(entry.sql_count || 0)
  };
}

function summarizePersonaMember(member = {}) {
  return {
    family_id: safeText(member.family_id),
    family_kind: safeText(member.family_kind),
    family_anchor_title: safeText(member.family_anchor_title),
    source_file: safeText(member.source_file),
    row_no: Number(member.row_no || 0),
    title: safeText(member.title),
    anchor_name: safeText(member.anchor_name),
    source_ref: safeText(member.source_ref),
    tags: uniqueStrings(member.tags, 12)
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

function deriveFamilyEntries(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = familyKey(row);
    if (!key) continue;
    const member = buildMemberRef(row);
    if (!map.has(key)) {
      map.set(key, buildFamilyEntry(member));
    }
    const entry = map.get(key);
    entry.family_id = entry.family_id || member.family_id;
    entry.family_kind = entry.family_kind || member.family_kind || 'persona_sql_family';
    entry.family_anchor_id = entry.family_anchor_id || member.family_anchor_id;
    entry.family_anchor_title = entry.family_anchor_title || member.family_anchor_title;
    entry.family_reason = entry.family_reason || member.family_reason;
    entry.layers = uniqueStrings(entry.layers.concat(member.layer), 6);
    entry.source_files = uniqueStrings(entry.source_files.concat(member.source_file), 12);
    if (member.layer === 'persona') {
      entry.persona_members.push(member);
      entry.persona_count += 1;
    } else if (member.layer === 'sql') {
      entry.sql_members.push(member);
      entry.sql_count += 1;
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const left = safeText(a.family_anchor_title || a.family_id);
    const right = safeText(b.family_anchor_title || b.family_id);
    return left.localeCompare(right);
  });
}

export async function ensureFamilyLedger({ ownerId = '', realmId = '' } = {}) {
  const owner_id = safeText(ownerId);
  const realm_id = safeText(realmId || 'default');
  const cacheKey = scopeCacheKey(owner_id, realm_id);
  if (familyLedgerCache.has(cacheKey)) return familyLedgerCache.get(cacheKey);
  const dataset = await loadReviewedDataset({ layers: ['sql', 'persona'] });
  const families = deriveFamilyEntries(dataset.rows);
  const dir = getScopedFamilyLedgerDir(owner_id, realm_id);
  const indexFile = join(dir, 'index.json');
  const latestFile = join(dir, 'latest.json');
  const doc = {
    schema: 'memory_family_ledger_v0.1',
    generated_at: new Date().toISOString(),
    scope: { owner_id, realm_id },
    families
  };
  await mkdir(dir, { recursive: true });
  await writeJsonAtomically(indexFile, doc);
  await writeJsonAtomically(latestFile, {
    schema: 'memory_family_ledger_pointer_v0.1',
    generated_at: doc.generated_at,
    latest_index: indexFile,
    family_count: families.length,
    scope: { owner_id, realm_id }
  });
  const result = {
    ok: true,
    dir,
    index_file: indexFile,
    latest_file: latestFile,
    ledger: doc
  };
  familyLedgerCache.set(cacheKey, result);
  return result;
}

export async function loadFamilyLedger({ ownerId = '', realmId = '' } = {}) {
  const cacheKey = scopeCacheKey(ownerId, realmId);
  if (familyLedgerCache.has(cacheKey)) return familyLedgerCache.get(cacheKey);
  const ensured = await ensureFamilyLedger({ ownerId, realmId });
  const raw = await readFile(ensured.index_file, 'utf-8');
  const result = {
    ok: true,
    dir: ensured.dir,
    index_file: ensured.index_file,
    ledger: JSON.parse(raw)
  };
  familyLedgerCache.set(cacheKey, result);
  return result;
}

export function findFamilyRefsForRoot(root = {}, ledger = {}) {
  const families = Array.isArray(ledger?.families) ? ledger.families : [];
  return families
    .filter((entry) => (Array.isArray(entry.sql_members) ? entry.sql_members : []).some((member) => identityMatchesMember(root, member)))
    .map((entry) => summarizeFamilyRef(entry));
}

export function findLinkedPersonaRefsForRoot(root = {}, ledger = {}) {
  const familyRefs = findFamilyRefsForRoot(root, ledger);
  return collectLinkedPersonaRefsForFamilies(familyRefs, ledger);
}

export function collectLinkedPersonaRefsForFamilies(familyRefs = [], ledger = {}) {
  const wantedFamilyIds = new Set((Array.isArray(familyRefs) ? familyRefs : [])
    .map((item) => safeText(item?.family_id || item?.family_anchor_title))
    .filter(Boolean));
  const families = Array.isArray(ledger?.families) ? ledger.families : [];
  const personaRows = [];
  for (const entry of families) {
    const key = safeText(entry.family_id || entry.family_anchor_title);
    if (!wantedFamilyIds.has(key)) continue;
    for (const member of Array.isArray(entry.persona_members) ? entry.persona_members : []) {
      personaRows.push(summarizePersonaMember(member));
    }
  }
  const seen = new Set();
  return personaRows.filter((item) => {
    const key = [
      safeText(item.family_id),
      safeText(item.source_file),
      String(item.row_no || 0),
      safeText(item.source_ref)
    ].join('::');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
