import { buildMemoryScope } from './scope-contract.js';
import {
  normalizeAnchorType,
  normalizeCompact,
  pickEarlierDate,
  pickLaterDate,
  sqlGrowthDisplayBucket,
  sqlGrowthNormalizeTreePathSegment,
  sqlGrowthUniqueStrings
} from './growth-helpers.js';
import { loadAllRootCards } from './root-store.js';
import { materializeSqlRoots } from './root-materializer.js';
import { buildVineSnapshot, materializeSqlVines } from './vine-materializer.js';
import { getMemoryHomePacket } from './memory-home-service.js';

function stableList(items, limit = 999) {
  return sqlGrowthUniqueStrings(Array.isArray(items) ? items : [], limit);
}

function mergeList(...lists) {
  return stableList(lists.flatMap((items) => Array.isArray(items) ? items : []));
}

function safeText(value) {
  return String(value || '').trim();
}

function buildRootKey(anchorType, canonicalName) {
  return `${anchorType}::${normalizeCompact(canonicalName) || 'unnamed'}`;
}

function updateSignature(update) {
  return [
    safeText(update.batch),
    safeText(update.first_seen_at),
    safeText(update.last_seen_at),
    stableList(update.summaries).join('|'),
    stableList(update.stable_facts).join('|'),
    stableList(update.persona_refs).join('|')
  ].join('::');
}

function normalizeUpdate(update, entry, source, idx) {
  const batch = safeText(update?.batch || source?.batch || source?.label || `entry-${idx + 1}`);
  return {
    batch,
    first_seen_at: safeText(update?.first_seen_at || entry?.first_seen_at || ''),
    last_seen_at: safeText(update?.last_seen_at || entry?.last_seen_at || update?.first_seen_at || ''),
    summaries: stableList(update?.summaries || update?.summary || []),
    stable_facts: stableList(update?.stable_facts || update?.stable_fact_candidates || []),
    persona_refs: stableList(update?.persona_refs || update?.persona_ref || []),
    conflict_hint: !!update?.conflict_hint
  };
}

function normalizeEntry(entry, envelope, idx) {
  const anchorType = normalizeAnchorType(entry?.anchor_type || entry?.type_key || entry?.card_type);
  const canonicalName = safeText(entry?.canonical_name || entry?.title || entry?.anchor_name || '');
  if (!['person', 'thing', 'event', 'rule'].includes(anchorType) || !canonicalName) {
    return null;
  }

  const rawUpdates = Array.isArray(entry?.recent_updates) ? entry.recent_updates : [];
  const recentUpdates = rawUpdates
    .map((item, itemIdx) => normalizeUpdate(item, entry, envelope?.source, itemIdx))
    .filter((item) => item.batch || item.summaries.length || item.stable_facts.length || item.persona_refs.length);

  return {
    entry_key: safeText(entry?.entry_key || entry?.root_key || `${anchorType}::${canonicalName}`),
    root_key: buildRootKey(anchorType, canonicalName),
    anchor_type: anchorType,
    canonical_name: canonicalName,
    trunk: safeText(entry?.trunk || entry?.candidate_trunk || sqlGrowthDisplayBucket(anchorType)),
    secondary_slot: safeText(entry?.secondary_slot || entry?.candidate_secondary_slot || ''),
    slot_path: safeText(entry?.slot_path || ''),
    slot_owner_hint: safeText(entry?.slot_owner_hint || ''),
    first_seen_at: safeText(entry?.first_seen_at || ''),
    last_seen_at: safeText(entry?.last_seen_at || ''),
    stable_facts: stableList(entry?.stable_facts || entry?.stable_fact_candidates || [], 24),
    recent_updates: recentUpdates,
    provenance: {
      source_batches: stableList(entry?.provenance?.source_batches || entry?.source_batches || []),
      source_refs: stableList(entry?.provenance?.source_refs || entry?.source_refs || []),
      source_windows: stableList(entry?.provenance?.source_windows || entry?.source_windows || []),
      topic_ids: stableList(entry?.provenance?.topic_ids || entry?.topic_ids || []),
      persona_refs: stableList(entry?.provenance?.persona_refs || entry?.persona_refs || []),
      source_group_keys: stableList(entry?.provenance?.source_group_keys || entry?.source_group_keys || [])
    },
    conflict_hint: !!entry?.conflict_hint
  };
}

function mergeUpdates(existingUpdates, incomingUpdates) {
  const seen = new Set();
  const merged = [];
  for (const item of Array.isArray(existingUpdates) ? existingUpdates : []) {
    const sig = updateSignature(item);
    if (!seen.has(sig)) {
      seen.add(sig);
      merged.push(item);
    }
  }
  let added = 0;
  for (const item of Array.isArray(incomingUpdates) ? incomingUpdates : []) {
    const sig = updateSignature(item);
    if (!seen.has(sig)) {
      seen.add(sig);
      merged.push(item);
      added += 1;
    }
  }
  merged.sort((a, b) => {
    const left = safeText(a?.first_seen_at || a?.last_seen_at || '');
    const right = safeText(b?.first_seen_at || b?.last_seen_at || '');
    return left.localeCompare(right);
  });
  return { merged, added };
}

function deriveEvolution(stableFacts, recentUpdates) {
  if ((recentUpdates?.length || 0) >= 2) return 'updated';
  if ((stableFacts?.length || 0) > 0) return 'stable';
  return 'volatile';
}

function toRootDoc(root) {
  const provenance = {
    source_batches: stableList(root.provenance?.source_batches || [], 32),
    source_refs: stableList(root.provenance?.source_refs || [], 64),
    source_windows: stableList(root.provenance?.source_windows || [], 64),
    topic_ids: stableList(root.provenance?.topic_ids || [], 64),
    persona_refs: stableList(root.provenance?.persona_refs || [], 64),
    source_group_keys: stableList(root.provenance?.source_group_keys || [], 64)
  };
  return {
    root_key: root.root_key,
    tree_path: root.tree_path,
    anchor_type: root.anchor_type,
    canonical_name: root.canonical_name,
    candidate_trunk: root.trunk || '',
    candidate_secondary_slot: root.secondary_slot || '',
    slot_path: root.slot_path || '',
    slot_owner_hint: root.slot_owner_hint || '',
    first_seen_at: root.first_seen_at || '',
    last_seen_at: root.last_seen_at || '',
    version_count: root.version_count || 1,
    branch_count: root.branch_count || 0,
    evolution_status: root.evolution_status || 'volatile',
    stable_facts: stableList(root.stable_facts, 24),
    recent_updates: Array.isArray(root.recent_updates) ? root.recent_updates : [],
    provenance,
    source_batches: provenance.source_batches,
    source_refs: provenance.source_refs,
    source_windows: provenance.source_windows,
    topic_ids: provenance.topic_ids,
    persona_refs: provenance.persona_refs,
    source_group_keys: provenance.source_group_keys,
    conflict_hint: !!root.conflict_hint
  };
}

function mergeRoot(existingRoot, entry) {
  const previous = existingRoot || {};
  const existingUpdates = Array.isArray(previous.recent_updates) ? previous.recent_updates : [];
  const incomingUpdates = Array.isArray(entry.recent_updates) ? entry.recent_updates : [];
  const { merged: recent_updates, added: addedUpdates } = mergeUpdates(existingUpdates, incomingUpdates);

  const previousStable = stableList(previous.stable_facts || [], 24);
  const stable_facts = mergeList(previousStable, entry.stable_facts).slice(0, 24);
  const addedStableCount = Math.max(0, stable_facts.length - previousStable.length);

  const first_seen_at = [previous.first_seen_at, entry.first_seen_at, ...recent_updates.map((item) => item.first_seen_at)]
    .filter(Boolean)
    .reduce((acc, item) => pickEarlierDate(acc, item), '');
  const last_seen_at = [previous.last_seen_at, entry.last_seen_at, ...recent_updates.map((item) => item.last_seen_at)]
    .filter(Boolean)
    .reduce((acc, item) => pickLaterDate(acc, item), '');

  const provenance = {
    source_batches: mergeList(previous.provenance?.source_batches || previous.source_batches || [], entry.provenance?.source_batches || []),
    source_refs: mergeList(previous.provenance?.source_refs || previous.source_refs || [], entry.provenance?.source_refs || []),
    source_windows: mergeList(previous.provenance?.source_windows || previous.source_windows || [], entry.provenance?.source_windows || []),
    topic_ids: mergeList(previous.provenance?.topic_ids || previous.topic_ids || [], entry.provenance?.topic_ids || []),
    persona_refs: mergeList(
      previous.provenance?.persona_refs || previous.persona_refs || [],
      entry.provenance?.persona_refs || [],
      recent_updates.flatMap((item) => item.persona_refs || [])
    ),
    source_group_keys: mergeList(previous.provenance?.source_group_keys || previous.source_group_keys || [], entry.provenance?.source_group_keys || [])
  };

  const branch_count = recent_updates.length;
  const baseVersion = Math.max(Number(previous.version_count || 0), 1);
  const version_count = existingRoot
    ? baseVersion + addedUpdates + (addedUpdates === 0 && addedStableCount > 0 ? 1 : 0)
    : Math.max(baseVersion, branch_count || 1);

  return {
    root_key: previous.root_key || entry.root_key,
    tree_path: previous.tree_path || `trunk/${entry.anchor_type}/${sqlGrowthNormalizeTreePathSegment(entry.canonical_name)}`,
    anchor_type: previous.anchor_type || entry.anchor_type,
    canonical_name: previous.canonical_name || entry.canonical_name,
    trunk: previous.trunk || entry.trunk || sqlGrowthDisplayBucket(entry.anchor_type),
    secondary_slot: previous.secondary_slot || entry.secondary_slot || '',
    slot_path: previous.slot_path || entry.slot_path || '',
    slot_owner_hint: previous.slot_owner_hint || entry.slot_owner_hint || '',
    first_seen_at,
    last_seen_at,
    version_count,
    branch_count,
    evolution_status: deriveEvolution(stable_facts, recent_updates),
    stable_facts,
    recent_updates,
    provenance,
    conflict_hint: !!(previous.conflict_hint || entry.conflict_hint || recent_updates.some((item) => item.conflict_hint))
  };
}

function buildSnapshotSummary(roots, stats) {
  return {
    roots: roots.length,
    promote_a: roots.length,
    created_roots: stats.created_roots,
    updated_roots: stats.updated_roots,
    accepted_entries: stats.accepted_entries,
    rejected_entries: stats.rejected_entries
  };
}

export function buildMemoryWriteEnvelopeFromGrowthSnapshot(snapshot, options = {}) {
  const roots = Array.isArray(snapshot?.roots) ? snapshot.roots : [];
  return {
    scope: {
      owner_id: safeText(options.owner_id || ''),
      realm_id: safeText(options.realm_id || 'default'),
      bot_id: safeText(options.bot_id || '')
    },
    source: {
      kind: safeText(options.source_kind || 'growth_snapshot_adapter'),
      label: safeText(options.source_label || 'reviewed_growth_snapshot')
    },
    entries: roots.map((root) => ({
      entry_key: root.root_key,
      anchor_type: root.anchor_type,
      canonical_name: root.canonical_name,
      trunk: root.candidate_trunk || '',
      secondary_slot: root.candidate_secondary_slot || '',
      slot_path: root.slot_path || '',
      slot_owner_hint: root.slot_owner_hint || '',
      first_seen_at: root.first_seen_at || '',
      last_seen_at: root.last_seen_at || '',
      stable_facts: Array.isArray(root.stable_facts) ? root.stable_facts : [],
      recent_updates: Array.isArray(root.recent_updates) ? root.recent_updates : [],
      provenance: {
        source_batches: Array.isArray(root.source_batches) ? root.source_batches : [],
        source_refs: Array.isArray(root.source_refs) ? root.source_refs : [],
        source_windows: Array.isArray(root.source_windows) ? root.source_windows : [],
        topic_ids: Array.isArray(root.topic_ids) ? root.topic_ids : [],
        persona_refs: Array.isArray(root.persona_refs) ? root.persona_refs : [],
        source_group_keys: Array.isArray(root.source_group_keys) ? root.source_group_keys : []
      },
      conflict_hint: !!root.conflict_hint
    }))
  };
}

export async function writeMemoryEnvelope(envelope = {}, options = {}) {
  const scope = buildMemoryScope({
    ownerId: envelope?.scope?.owner_id,
    realmId: envelope?.scope?.realm_id,
    botId: envelope?.scope?.bot_id,
    mode: 'bot'
  });
  const source = envelope?.source || {};
  const label = safeText(options.label || source.label || 'memory_write');

  let existing = [];
  try {
    existing = await loadAllRootCards({
      ownerId: scope.owner_id,
      realmId: scope.realm_id
    });
  } catch {
    existing = [];
  }
  const rootMap = new Map(existing.map((item) => [item.card.root_key, {
    ...item.card,
    provenance: item.card.provenance || {
      source_batches: item.card.source_batches || [],
      source_refs: item.card.source_refs || [],
      source_windows: item.card.source_windows || [],
      topic_ids: item.card.topic_ids || [],
      persona_refs: item.card.persona_refs || [],
      source_group_keys: item.card.source_group_keys || []
    }
  }]));

  let acceptedEntries = 0;
  let rejectedEntries = 0;
  let createdRoots = 0;
  let updatedRoots = 0;

  for (const [idx, rawEntry] of (Array.isArray(envelope?.entries) ? envelope.entries : []).entries()) {
    const entry = normalizeEntry(rawEntry, envelope, idx);
    if (!entry) {
      rejectedEntries += 1;
      continue;
    }
    acceptedEntries += 1;
    const hadRoot = rootMap.has(entry.root_key);
    const merged = mergeRoot(rootMap.get(entry.root_key), entry);
    rootMap.set(entry.root_key, merged);
    if (hadRoot) updatedRoots += 1;
    else createdRoots += 1;
  }

  const roots = Array.from(rootMap.values())
    .map(toRootDoc)
    .sort((a, b) => {
      if (a.anchor_type !== b.anchor_type) return String(a.anchor_type || '').localeCompare(String(b.anchor_type || ''));
      return String(a.canonical_name || '').localeCompare(String(b.canonical_name || ''));
    });

  const snapshot = {
    summary: buildSnapshotSummary(roots, {
      created_roots: createdRoots,
      updated_roots: updatedRoots,
      accepted_entries: acceptedEntries,
      rejected_entries: rejectedEntries
    }),
    roots
  };

  const rootsMaterialized = await materializeSqlRoots(snapshot, {
    label,
    source_kind: safeText(source.kind || 'memory_write_contract'),
    source_label: safeText(source.label || ''),
    owner_id: scope.owner_id,
    realm_id: scope.realm_id
  });

  const vineSnapshot = buildVineSnapshot(roots);
  const vinesMaterialized = await materializeSqlVines(vineSnapshot, {
    label,
    source_label: 'truth_layer/sql_roots',
    source_roots_snapshot: rootsMaterialized.snapshot_dir,
    owner_id: scope.owner_id,
    realm_id: scope.realm_id
  });

  const home = await getMemoryHomePacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    botId: scope.bot_id,
    mode: 'bot'
  });

  return {
    ok: true,
    schema: 'memory_write_result_v0.1',
    scope: {
      ...scope,
      isolation_stage: 'scoped_truth'
    },
    source: {
      kind: safeText(source.kind || 'memory_write_contract'),
      label: safeText(source.label || '')
    },
    summary: {
      input_entries: Array.isArray(envelope?.entries) ? envelope.entries.length : 0,
      accepted_entries: acceptedEntries,
      rejected_entries: rejectedEntries,
      created_roots: createdRoots,
      updated_roots: updatedRoots,
      total_roots: roots.length,
      vine_edges: vineSnapshot.summary.edges || 0
    },
    materialized: {
      roots: rootsMaterialized,
      vines: vinesMaterialized
    },
    home: home?.ok ? home : {},
    home_summary: home?.ok && home?.home_summary ? home.home_summary : {},
    sample_roots: roots.slice(0, 12).map((root) => ({
      root_key: root.root_key,
      anchor_type: root.anchor_type,
      canonical_name: root.canonical_name,
      tree_path: root.tree_path,
      version_count: root.version_count,
      branch_count: root.branch_count,
      evolution_status: root.evolution_status
    }))
  };
}
