import { loadTranslationTaskByFile, updateTranslationTaskStatus } from './translation-task-store.js';
import { normalizeCompact, pickEarlierDate, pickLaterDate, sqlGrowthUniqueStrings } from './growth-helpers.js';
import { ensureRuntimeReviewedPacket, loadLatestRuntimeReviewedPacket, saveRuntimeReviewedPacket } from './runtime-reviewed-store.js';
import { parseAiTranslationTaskSubmission } from './memory-translation-ai-service.js';
import { writeMemoryEnvelope } from './memory-write-service.js';
import { buildMemoryScope } from './scope-contract.js';
import { getMemoryHomePacket } from './memory-home-service.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function uniqueStrings(values, limit = 64) {
  return sqlGrowthUniqueStrings(Array.isArray(values) ? values : [], limit);
}

function stableEntryList(values = [], limit = 24) {
  return uniqueStrings(values, limit);
}

function buildRootKey(entry = {}) {
  return `${safeText(entry.anchor_type).toLowerCase()}::${normalizeCompact(entry.canonical_name) || 'unnamed'}`;
}

function buildEntrySignature(entry = {}) {
  return [
    buildRootKey(entry),
    normalizeCompact(entry.secondary_slot),
    normalizeCompact(entry.slot_path),
    stableEntryList(entry.stable_facts).map((item) => normalizeCompact(item)).join('|'),
    stableEntryList(
      (Array.isArray(entry.recent_updates) ? entry.recent_updates : [])
        .flatMap((item) => Array.isArray(item?.summaries) ? item.summaries : [])
    ).map((item) => normalizeCompact(item)).join('|')
  ].join('::');
}

function buildClusterId(rootKey) {
  return `cluster::${rootKey}`;
}

function normalizeRecentUpdates(updates = []) {
  const list = Array.isArray(updates) ? updates : [];
  return list.map((item) => ({
    batch: safeText(item?.batch),
    first_seen_at: safeText(item?.first_seen_at),
    last_seen_at: safeText(item?.last_seen_at),
    summaries: stableEntryList(item?.summaries || item?.summary || [], 8),
    stable_facts: stableEntryList(item?.stable_facts || [], 8),
    persona_refs: stableEntryList(item?.persona_refs || [], 8),
    conflict_hint: Boolean(item?.conflict_hint)
  })).filter((item) => (
    item.batch
    || item.summaries.length
    || item.stable_facts.length
    || item.persona_refs.length
  ));
}

function normalizeReviewedEntry(entry = {}) {
  return {
    anchor_type: safeText(entry.anchor_type).toLowerCase(),
    canonical_name: safeText(entry.canonical_name),
    trunk: safeText(entry.trunk),
    secondary_slot: safeText(entry.secondary_slot),
    slot_path: safeText(entry.slot_path),
    slot_owner_hint: safeText(entry.slot_owner_hint),
    first_seen_at: safeText(entry.first_seen_at),
    last_seen_at: safeText(entry.last_seen_at),
    stable_facts: stableEntryList(entry.stable_facts || [], 24),
    recent_updates: normalizeRecentUpdates(entry.recent_updates),
    provenance: {
      source_batches: stableEntryList(entry?.provenance?.source_batches || [], 24),
      source_refs: stableEntryList(entry?.provenance?.source_refs || [], 48),
      source_windows: stableEntryList(entry?.provenance?.source_windows || [], 48),
      topic_ids: stableEntryList(entry?.provenance?.topic_ids || [], 24),
      persona_refs: stableEntryList(entry?.provenance?.persona_refs || [], 24),
      source_group_keys: stableEntryList(entry?.provenance?.source_group_keys || [], 48)
    },
    conflict_hint: Boolean(entry.conflict_hint)
  };
}

function summarizeReviewedPacket(packet = {}) {
  const groups = buildReviewedClusters(packet);
  const ambiguousClusterCount = groups.filter((item) => item.ambiguous).length;
  return {
    append_count: Number(packet?.tasks?.length || 0),
    item_count: Number(packet?.items?.length || 0),
    cluster_count: groups.length,
    ambiguous_cluster_count: ambiguousClusterCount,
    merged_entry_count: Number(packet?.finalized_entries?.length || 0)
  };
}

function mergeRecentUpdates(list = []) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const normalized = {
      batch: safeText(item?.batch),
      first_seen_at: safeText(item?.first_seen_at),
      last_seen_at: safeText(item?.last_seen_at),
      summaries: stableEntryList(item?.summaries || [], 8),
      stable_facts: stableEntryList(item?.stable_facts || [], 8),
      persona_refs: stableEntryList(item?.persona_refs || [], 8),
      conflict_hint: Boolean(item?.conflict_hint)
    };
    const signature = [
      normalized.batch,
      normalized.first_seen_at,
      normalized.last_seen_at,
      normalized.summaries.map((value) => normalizeCompact(value)).join('|'),
      normalized.stable_facts.map((value) => normalizeCompact(value)).join('|'),
      normalized.persona_refs.map((value) => normalizeCompact(value)).join('|'),
      normalized.conflict_hint ? '1' : '0'
    ].join('::');
    if (!signature.replace(/[:|]/g, '')) continue;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(normalized);
  }
  out.sort((left, right) => String(left.first_seen_at || left.last_seen_at || '').localeCompare(String(right.first_seen_at || right.last_seen_at || '')));
  return out;
}

function codeMergeReviewedEntries(entries = []) {
  const list = entries.map((entry) => normalizeReviewedEntry(entry)).filter((entry) => entry.anchor_type && entry.canonical_name);
  if (!list.length) return null;
  const base = list[0];
  const firstSeen = list
    .map((item) => item.first_seen_at)
    .filter(Boolean)
    .reduce((acc, value) => pickEarlierDate(acc, value), '');
  const lastSeen = list
    .map((item) => item.last_seen_at)
    .filter(Boolean)
    .reduce((acc, value) => pickLaterDate(acc, value), '');

  return {
    anchor_type: base.anchor_type,
    canonical_name: base.canonical_name,
    trunk: list.find((item) => item.trunk)?.trunk || base.trunk || '',
    secondary_slot: list.find((item) => item.secondary_slot)?.secondary_slot || base.secondary_slot || '',
    slot_path: list.find((item) => item.slot_path)?.slot_path || base.slot_path || '',
    slot_owner_hint: list.find((item) => item.slot_owner_hint)?.slot_owner_hint || base.slot_owner_hint || '',
    first_seen_at: firstSeen,
    last_seen_at: lastSeen || firstSeen,
    stable_facts: stableEntryList(list.flatMap((item) => item.stable_facts), 24),
    recent_updates: mergeRecentUpdates(list.flatMap((item) => item.recent_updates)),
    provenance: {
      source_batches: stableEntryList(list.flatMap((item) => item.provenance?.source_batches || []), 24),
      source_refs: stableEntryList(list.flatMap((item) => item.provenance?.source_refs || []), 64),
      source_windows: stableEntryList(list.flatMap((item) => item.provenance?.source_windows || []), 64),
      topic_ids: stableEntryList(list.flatMap((item) => item.provenance?.topic_ids || []), 32),
      persona_refs: stableEntryList(list.flatMap((item) => item.provenance?.persona_refs || []), 32),
      source_group_keys: stableEntryList(list.flatMap((item) => item.provenance?.source_group_keys || []), 64)
    },
    conflict_hint: list.some((item) => item.conflict_hint)
  };
}

function buildReviewedClusters(packet = {}) {
  const groups = new Map();
  (Array.isArray(packet?.items) ? packet.items : []).forEach((item) => {
    const rootKey = safeText(item?.root_key || buildRootKey(item?.entry));
    if (!rootKey) return;
    if (!groups.has(rootKey)) groups.set(rootKey, []);
    groups.get(rootKey).push(item);
  });

  return Array.from(groups.entries()).map(([rootKey, items]) => {
    const signatures = Array.from(new Set(items.map((item) => safeText(item.signature))));
    const merged = codeMergeReviewedEntries(items.map((item) => item.entry));
    return {
      cluster_id: buildClusterId(rootKey),
      root_key: rootKey,
      ambiguous: signatures.length > 1,
      entry_count: items.length,
      items: items.map((item) => ({
        item_id: item.item_id,
        task_file: item.task_file,
        batch_id: item.batch_id,
        signature: item.signature,
        entry: item.entry
      })),
      merged_entry: merged
    };
  }).sort((left, right) => right.entry_count - left.entry_count);
}

function coerceAiMergeMap(aiMerges = []) {
  const list = Array.isArray(aiMerges) ? aiMerges : [];
  const map = new Map();
  list.forEach((item) => {
    const clusterId = safeText(item?.cluster_id);
    if (!clusterId || !item?.entry) return;
    map.set(clusterId, normalizeReviewedEntry(item.entry));
  });
  return map;
}

export async function appendRuntimeReviewedEntries(body = {}) {
  const parsed = await parseAiTranslationTaskSubmission(body, {
    markSubmitted: true,
    markFailure: true
  });
  if (!parsed?.ok) return parsed;

  const scope = buildMemoryScope({
    ownerId: parsed?.scope?.owner_id || body?.scope?.owner_id,
    realmId: parsed?.scope?.realm_id || body?.scope?.realm_id,
    botId: parsed?.scope?.bot_id || body?.scope?.bot_id,
    mode: 'bot'
  });

  const packetState = await ensureRuntimeReviewedPacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    scope,
    label: safeText(body?.source?.label || `${scope.realm_id}__reviewed`)
  });

  const packet = packetState.packet || {};
  const taskFile = safeText(parsed.task_file);
  packet.items = (Array.isArray(packet.items) ? packet.items : []).filter((item) => safeText(item.task_file) !== taskFile);
  packet.tasks = (Array.isArray(packet.tasks) ? packet.tasks : []).filter((item) => safeText(item.task_file) !== taskFile);

  const items = parsed.entries.map((entry, index) => {
    const normalized = normalizeReviewedEntry(entry);
    const rootKey = buildRootKey(normalized);
    return {
      item_id: `${taskFile || parsed.batch_id || 'task'}::${String(index + 1).padStart(3, '0')}`,
      task_file: taskFile,
      batch_id: safeText(parsed.batch_id || body?.source?.label || ''),
      packet_file: safeText(parsed.packet_file),
      root_key: rootKey,
      signature: buildEntrySignature(normalized),
      entry: normalized
    };
  });

  packet.items.push(...items);
  packet.tasks.push({
    task_file: taskFile,
    batch_id: safeText(parsed.batch_id || body?.source?.label || ''),
    packet_file: safeText(parsed.packet_file),
    parsed_entries: items.length,
    updated_at: new Date().toISOString()
  });
  packet.updated_at = new Date().toISOString();
  packet.summary = summarizeReviewedPacket(packet);

  await saveRuntimeReviewedPacket(packetState.packetFile, packet);

  const home = await getMemoryHomePacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    botId: scope.bot_id,
    mode: 'bot'
  });

  return {
    ok: true,
    schema: 'hippocove_runtime_reviewed_append_v0.1',
    scope,
    reviewed: {
      packet_file: packetState.packetFile,
      summary: packet.summary
    },
    parsed_entries: items.length,
    task_file: taskFile,
    home: home?.ok ? home : {},
    home_summary: home?.ok && home?.home_summary ? home.home_summary : {}
  };
}

export async function getRuntimeReviewedClusters(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  let loaded = null;
  try {
    loaded = await loadLatestRuntimeReviewedPacket({
      ownerId: scope.owner_id,
      realmId: scope.realm_id
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!loaded?.packet) {
    return {
      ok: true,
      schema: 'hippocove_runtime_reviewed_clusters_v0.1',
      scope,
      packet_file: '',
      summary: {
        append_count: 0,
        item_count: 0,
        cluster_count: 0,
        ambiguous_cluster_count: 0,
        merged_entry_count: 0
      },
      clusters: []
    };
  }
  const clusters = buildReviewedClusters(loaded.packet);
  return {
    ok: true,
    schema: 'hippocove_runtime_reviewed_clusters_v0.1',
    scope,
    packet_file: loaded.packetFile,
    summary: loaded.packet?.summary || summarizeReviewedPacket(loaded.packet),
    clusters
  };
}

export async function finalizeRuntimeReviewedEntries(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  let loaded = null;
  try {
    loaded = await loadLatestRuntimeReviewedPacket({
      ownerId: scope.owner_id,
      realmId: scope.realm_id
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!loaded?.packet) {
    return {
      ok: true,
      schema: 'hippocove_runtime_reviewed_finalize_v0.1',
      scope,
      packet_file: '',
      summary: {
        append_count: 0,
        item_count: 0,
        cluster_count: 0,
        ambiguous_cluster_count: 0,
        merged_entry_count: 0
      },
      clusters: [],
      merged_entries: 0,
      writeback: {
        ok: true,
        summary: {
          created_roots: 0,
          updated_roots: 0,
          total_roots: 0,
          vine_edges: 0
        }
      },
      home: {},
      home_summary: {}
    };
  }
  const packet = loaded.packet || {};
  const aiMergeMap = coerceAiMergeMap(body?.ai_merges);
  const clusters = buildReviewedClusters(packet);
  const finalEntries = clusters.map((cluster) => {
    const aiMerged = aiMergeMap.get(cluster.cluster_id);
    return aiMerged || cluster.merged_entry;
  }).filter(Boolean);

  const writeback = await writeMemoryEnvelope({
    scope,
    source: {
      kind: 'runtime_reviewed_finalize',
      label: safeText(body?.source?.label || `${scope.realm_id}__reviewed_finalize`)
    },
    entries: finalEntries
  }, {
    label: safeText(body?.source?.label || `${scope.realm_id}__reviewed_finalize`)
  });

  const taskFiles = Array.from(new Set((Array.isArray(packet.tasks) ? packet.tasks : []).map((item) => safeText(item.task_file)).filter(Boolean)));
  for (const taskFile of taskFiles) {
    const current = await loadTranslationTaskByFile(taskFile).catch(() => null);
    if (!current || safeText(current.status) === 'failed') continue;
    await updateTranslationTaskStatus(taskFile, (task) => ({
      ...task,
      status: 'applied',
      lifecycle: {
        ...(task.lifecycle || {}),
        applied_at: new Date().toISOString()
      },
      writeback: {
        ok: Boolean(writeback?.ok),
        created_roots: Number(writeback?.summary?.created_roots || 0),
        updated_roots: Number(writeback?.summary?.updated_roots || 0),
        total_roots: Number(writeback?.summary?.total_roots || 0),
        vine_edges: Number(writeback?.summary?.vine_edges || 0)
      }
    }));
  }

  packet.finalized_at = new Date().toISOString();
  packet.updated_at = packet.finalized_at;
  packet.finalized_entries = finalEntries;
  packet.summary = summarizeReviewedPacket(packet);
  await saveRuntimeReviewedPacket(loaded.packetFile, packet);

  return {
    ok: true,
    schema: 'hippocove_runtime_reviewed_finalize_v0.1',
    scope,
    packet_file: loaded.packetFile,
    summary: packet.summary,
    clusters: clusters.map((item) => ({
      cluster_id: item.cluster_id,
      entry_count: item.entry_count,
      ambiguous: item.ambiguous
    })),
    merged_entries: finalEntries.length,
    writeback,
    home: writeback?.home || {},
    home_summary: writeback?.home_summary || {}
  };
}
