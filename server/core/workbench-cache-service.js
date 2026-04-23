import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { RUNTIME_SAVE_DIR } from './path-config.js';
import { loadLatestRuntimeReviewedPacket } from './runtime-reviewed-store.js';

const WORKBENCH_CACHE_FILE = join(RUNTIME_SAVE_DIR, 'ui_workbench_cache_rows.json');

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeWorkbenchRow(row = {}) {
  return {
    ...row,
    layer: safeText(row.layer).toLowerCase(),
    title: safeText(row.title || row.card_name || row.anchor_name || row.object_name || row.object),
    time: safeText(row.time || row.last_seen_at || row.recorded_at),
    summary: safeText(row.summary),
    content_text: String(row.content_text || row.text || '').trim(),
    text: String(row.text || row.content_text || '').trim(),
    expression_fingerprint: safeText(row.expression_fingerprint),
    quote_refs: safeText(row.quote_refs || row.quote_refs_text),
    quote_refs_text: safeText(row.quote_refs_text || row.quote_refs),
    tags: Array.isArray(row.tags) ? row.tags.join(' ') : safeText(row.tags),
    topic_ids: safeText(row.topic_ids),
    topic_labels: safeText(row.topic_labels),
    track_id: safeText(row.track_id),
    event_anchor: safeText(row.event_anchor),
    source_window_id: safeText(row.source_window_id),
    source_window_title: safeText(row.source_window_title),
    source_msg_start: row.source_msg_start || '',
    source_msg_end: row.source_msg_end || '',
    source_ref: safeText(row.source_ref),
    source_bundle_id: safeText(row.source_bundle_id || row.source_bundle || row.bundle_id),
    source_bundle: safeText(row.source_bundle || row.source_bundle_id || row.bundle_id),
    bundle_id: safeText(row.bundle_id || row.source_bundle_id || row.source_bundle),
    source_md_ref: safeText(row.source_md_ref),
    source_manifest_kind: safeText(row.source_manifest_kind),
    chunk_id: safeText(row.chunk_id),
    record_id: safeText(row.record_id),
    memory_key: safeText(row.memory_key),
    anchor_name: safeText(row.anchor_name || row.card_name),
    fact_key: safeText(row.fact_key),
    entity_refs: safeText(row.entity_refs)
  };
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function buildRuntimeReviewedPersonaRows(packet = {}) {
  const items = Array.isArray(packet?.items) ? packet.items : [];
  const rows = [];
  for (const item of items) {
    const entry = item?.entry || {};
    const provenance = entry?.provenance || {};
    const content = [
      ...(Array.isArray(entry?.stable_facts) ? entry.stable_facts : []),
      ...(Array.isArray(entry?.recent_updates) ? entry.recent_updates : [])
    ].map((line) => safeText(line)).filter(Boolean).join('\n');
    if (!content) continue;
    rows.push(normalizeWorkbenchRow({
      layer: 'persona',
      title: safeText(entry?.canonical_name || entry?.slot_path || entry?.trunk || 'reviewed 人格条目'),
      time: safeText(entry?.last_seen_at || entry?.first_seen_at),
      summary: content.split('\n')[0] || '',
      content_text: content,
      text: content,
      quote_refs_text: '',
      quote_refs: '',
      tags: [
        entry?.trunk ? `#${safeText(entry.trunk)}` : '',
        entry?.secondary_slot ? `#${safeText(entry.secondary_slot)}` : ''
      ].filter(Boolean).join(' '),
      topic_ids: Array.isArray(provenance?.topic_ids) ? provenance.topic_ids.join(' ') : '',
      topic_labels: Array.isArray(provenance?.source_group_keys) ? provenance.source_group_keys.join(' ') : '',
      track_id: safeText(entry?.slot_path || entry?.canonical_name),
      event_anchor: safeText(entry?.slot_path || entry?.canonical_name),
      source_window_title: Array.isArray(provenance?.source_windows) ? safeText(provenance.source_windows[0]) : '',
      source_ref: Array.isArray(provenance?.source_refs) ? safeText(provenance.source_refs[0]) : '',
      source_bundle_id: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : '',
      source_bundle: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : '',
      bundle_id: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : '',
      record_id: safeText(item?.item_id || item?.root_key || entry?.canonical_name),
      memory_key: safeText(item?.signature || item?.root_key || entry?.canonical_name)
    }));
  }
  return rows;
}

function buildRuntimeReviewedSqlRows(packet = {}) {
  const entries = Array.isArray(packet?.finalized_entries) ? packet.finalized_entries : [];
  return entries.map((entry, index) => {
    const provenance = entry?.provenance || {};
    const stableFacts = Array.isArray(entry?.stable_facts) ? entry.stable_facts : [];
    const recentUpdates = Array.isArray(entry?.recent_updates) ? entry.recent_updates : [];
    const summary = stableFacts[0] || recentUpdates[0] || '';
    const contentText = [...stableFacts, ...recentUpdates].map((item) => safeText(item)).filter(Boolean).join('\n');
    return normalizeWorkbenchRow({
      layer: 'sql',
      time: safeText(entry?.last_seen_at || entry?.first_seen_at),
      title: safeText(entry?.canonical_name || entry?.slot_path || `reviewed-${index + 1}`, `reviewed-${index + 1}`),
      summary,
      content_text: contentText,
      text: contentText,
      quote_refs: '',
      tags: [safeText(entry?.trunk), safeText(entry?.secondary_slot)].filter(Boolean).join(' '),
      topic_ids: Array.isArray(provenance?.topic_ids) ? provenance.topic_ids.join(' ') : '',
      topic_labels: Array.isArray(provenance?.source_group_keys) ? provenance.source_group_keys.join(' ') : '',
      track_id: safeText(entry?.slot_path || entry?.canonical_name),
      anchor_name: safeText(entry?.canonical_name),
      fact_key: safeText(entry?.slot_path || entry?.canonical_name),
      entity_refs: safeText(entry?.slot_owner_hint),
      source_window_title: Array.isArray(provenance?.source_windows) ? safeText(provenance.source_windows[0]) : '',
      source_ref: Array.isArray(provenance?.source_refs) ? safeText(provenance.source_refs[0]) : '',
      source_bundle_id: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : '',
      source_bundle: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : '',
      bundle_id: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : '',
      record_id: `${safeText(entry?.canonical_name || entry?.slot_path || 'reviewed')}::${index + 1}`,
      memory_key: `${safeText(entry?.slot_path || entry?.canonical_name || 'reviewed')}::${index + 1}`
    });
  }).filter((row) => row.summary || row.content_text);
}

async function loadRuntimeReviewedWorkbenchRows({ ownerId = '', realmId = '', wanted = null } = {}) {
  const safeOwner = safeText(ownerId);
  const safeRealm = safeText(realmId);
  if (!safeOwner || !safeRealm) return [];
  try {
    const reviewed = await loadLatestRuntimeReviewedPacket({ ownerId: safeOwner, realmId: safeRealm });
    const rows = [];
    if (!wanted || wanted.has('persona')) rows.push(...buildRuntimeReviewedPersonaRows(reviewed?.packet || {}));
    if (!wanted || wanted.has('sql')) rows.push(...buildRuntimeReviewedSqlRows(reviewed?.packet || {}));
    return rows;
  } catch {
    return [];
  }
}

export async function loadWorkbenchCacheRows({
  layers = [],
  ownerId = '',
  realmId = '',
  fallbackToRuntimeReviewed = false,
  preferRuntimeReviewed = false
} = {}) {
  const wanted = Array.isArray(layers) && layers.length
    ? new Set(layers.map((item) => safeText(item).toLowerCase()).filter(Boolean))
    : null;
  if (preferRuntimeReviewed && fallbackToRuntimeReviewed) {
    const runtimeRows = await loadRuntimeReviewedWorkbenchRows({ ownerId, realmId, wanted });
    if (runtimeRows.length) return runtimeRows;
  }
  let rows = [];
  try {
    const parsed = await readJsonFile(WORKBENCH_CACHE_FILE);
    rows = Array.isArray(parsed?.rows) ? parsed.rows.map((row) => normalizeWorkbenchRow(row)) : [];
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  const filteredRows = wanted ? rows.filter((row) => wanted.has(row.layer)) : rows;
  if (filteredRows.length || !fallbackToRuntimeReviewed) return filteredRows;
  const runtimeRows = await loadRuntimeReviewedWorkbenchRows({ ownerId, realmId, wanted });
  if (runtimeRows.length) return runtimeRows;
  return filteredRows;
}

export async function saveWorkbenchCacheRows(rows = [], options = {}) {
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeWorkbenchRow(row))
    .filter((row) => row.layer === 'persona' || row.layer === 'sql');
  const preserveExistingOnEmpty = options?.preserveExistingOnEmpty !== false;
  let rowsToPersist = normalizedRows;
  let preservedExisting = false;
  if (!rowsToPersist.length && preserveExistingOnEmpty) {
    const existingRows = await loadWorkbenchCacheRows({
      layers: ['persona', 'sql'],
      ownerId: safeText(options?.ownerId),
      realmId: safeText(options?.realmId),
      fallbackToRuntimeReviewed: false
    });
    if (existingRows.length) {
      rowsToPersist = existingRows;
      preservedExisting = true;
    }
  }
  await mkdir(RUNTIME_SAVE_DIR, { recursive: true });
  const payload = {
    updated_at: new Date().toISOString(),
    rows: rowsToPersist
  };
  await writeFile(WORKBENCH_CACHE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return {
    updated_at: payload.updated_at,
    total_rows: rowsToPersist.length,
    persona_rows: rowsToPersist.filter((row) => row.layer === 'persona').length,
    sql_rows: rowsToPersist.filter((row) => row.layer === 'sql').length,
    preserved_existing: preservedExisting
  };
}

export async function getWorkbenchCacheSnapshot({
  layers = [],
  limit = 24,
  ownerId = '',
  realmId = '',
  preferRuntimeReviewed = false
} = {}) {
  const rows = await loadWorkbenchCacheRows({
    layers,
    ownerId,
    realmId,
    fallbackToRuntimeReviewed: true,
    preferRuntimeReviewed
  });
  return {
    total_rows: rows.length,
    rows: rows.slice(0, Math.max(1, Number(limit || 24)))
  };
}
