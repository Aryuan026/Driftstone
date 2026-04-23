import { loadLatestRootIndex, loadRootCardByKey, searchRootCards } from './root-store.js';
import { loadLatestVineIndex, loadRootVines } from './vine-store.js';
import { loadFamilyLedger, findFamilyRefsForRoot, findLinkedPersonaRefsForRoot } from './family-store.js';
import { buildTagHintBundleForRoot } from './tag-hint-store.js';

function uniqueStrings(items, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function countBy(items, key) {
  const out = {};
  for (const item of Array.isArray(items) ? items : []) {
    const bucket = String(item?.[key] || 'unknown');
    out[bucket] = (out[bucket] || 0) + 1;
  }
  return out;
}

function summarizeRootIndexRow(row) {
  return {
    root_key: row.root_key,
    canonical_name: row.canonical_name,
    anchor_type: row.anchor_type,
    tree_path: row.tree_path,
    version_count: row.version_count || 0,
    branch_count: row.branch_count || 0,
    evolution_status: row.evolution_status || '',
    file: row.file || ''
  };
}

function summarizeRecentUpdate(item) {
  return {
    batch: item.batch || '',
    first_seen_at: item.first_seen_at || '',
    last_seen_at: item.last_seen_at || '',
    summaries: uniqueStrings(item.summaries, 3),
    stable_facts: uniqueStrings(item.stable_facts, 3),
    persona_refs: uniqueStrings(item.persona_refs, 6),
    conflict_hint: !!item.conflict_hint
  };
}

function buildRootPacket(card, tagHints = {}) {
  const provenance = card?.provenance || {};
  const recentUpdates = Array.isArray(card?.recent_updates) ? card.recent_updates : [];
  const leafHints = uniqueStrings([
    ...uniqueStrings(provenance.persona_refs, 12),
    ...recentUpdates.flatMap((item) => uniqueStrings(item.persona_refs, 6))
  ], 16);

  return {
    schema: 'memory_root_packet_v0.1',
    root: {
      root_key: card.root_key,
      canonical_name: card.canonical_name,
      anchor_type: card.anchor_type,
      tree_path: card.tree_path,
      trunk: card.trunk || '',
      secondary_slot: card.secondary_slot || '',
      slot_path: card.slot_path || '',
      slot_owner_hint: card.slot_owner_hint || '',
      first_seen_at: card.first_seen_at || '',
      last_seen_at: card.last_seen_at || '',
      version_count: card.version_count || 0,
      branch_count: card.branch_count || 0,
      evolution_status: card.evolution_status || '',
      stable_facts: uniqueStrings(card.stable_facts, 8),
      atomic_facts: Array.isArray(card?.atomic_facts) ? card.atomic_facts.slice(0, 16) : [],
      type_hints: Array.isArray(tagHints?.root_type_hints) ? tagHints.root_type_hints : [],
      conflict_hint: !!card.conflict_hint
    },
    vine: {
      recent_updates: recentUpdates.slice(0, 8).map(summarizeRecentUpdate),
      related_batches: uniqueStrings(provenance.source_batches, 16),
      topic_ids: uniqueStrings(provenance.topic_ids, 16),
      tag_hints: Array.isArray(tagHints?.vine_tag_hints) ? tagHints.vine_tag_hints : [],
      relation_hints: {
        persona_refs: leafHints,
        source_group_keys: uniqueStrings(provenance.source_group_keys, 12)
      }
    },
    leaf_hints: {
      persona_refs: leafHints,
      tag_hints: Array.isArray(tagHints?.leaf_tag_hints) ? tagHints.leaf_tag_hints : []
    },
    shadow: {
      source_refs: uniqueStrings(provenance.source_refs, 16),
      source_windows: uniqueStrings(provenance.source_windows, 16),
      topic_ids: uniqueStrings(provenance.topic_ids, 16),
      source_batches: uniqueStrings(provenance.source_batches, 16),
      source_group_keys: uniqueStrings(provenance.source_group_keys, 24)
    }
  };
}

export async function getMemoryOverview(options = {}) {
  const { pointer, index, storage } = await loadLatestRootIndex(options);
  let vineCount = 0;
  try {
    const { pointer: vinePointer } = await loadLatestVineIndex(options);
    vineCount = Number(vinePointer?.edge_count || 0);
  } catch {
    vineCount = 0;
  }
  const roots = Array.isArray(index?.roots) ? index.roots : [];
  const typeCounts = countBy(roots, 'anchor_type');
  const latestSeen = roots
    .map((item) => String(item?.last_seen_at || item?.generated_at || ''))
    .filter(Boolean)
    .sort()
    .at(-1) || '';

  return {
    ok: true,
    schema: 'memory_overview_v0.1',
    source: {
      latest_snapshot: pointer.latest_snapshot,
      root_count: pointer.root_count || roots.length,
      latest_seen_at: latestSeen,
      vine_edge_count: vineCount,
      storage
    },
    trunks: {
      person: typeCounts.person || 0,
      thing: typeCounts.thing || 0,
      event: typeCounts.event || 0,
      rule: typeCounts.rule || 0,
      unknown: typeCounts.unknown || 0
    },
    sample_roots: roots.slice(0, 12).map(summarizeRootIndexRow)
  };
}

export async function getMemorySearchResults(query, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 20;
  const hits = await searchRootCards(query, {
    limit,
    ownerId: options.ownerId,
    realmId: options.realmId,
    owner_id: options.owner_id,
    realm_id: options.realm_id
  });
  return {
    ok: true,
    schema: 'memory_search_results_v0.1',
    query: String(query || ''),
    count: hits.length,
    roots: hits.map(summarizeRootIndexRow)
  };
}

export async function getMemoryRootPacket(rootKey, options = {}) {
  const hit = await loadRootCardByKey(rootKey, options);
  if (!hit?.card) {
    return {
      ok: false,
      error: 'Root not found',
      root_key: rootKey
    };
  }

  const relatedRoots = await loadRootVines(rootKey, options);
  const familyLedgerHit = await loadFamilyLedger({
    ownerId: options.ownerId || options.owner_id || '',
    realmId: options.realmId || options.realm_id || ''
  });
  const familyRefs = Array.isArray(hit.card?.family_refs) ? hit.card.family_refs : findFamilyRefsForRoot(hit.card, familyLedgerHit?.ledger || {});
  const linkedPersonaRefs = Array.isArray(hit.card?.linked_persona_refs) ? hit.card.linked_persona_refs : findLinkedPersonaRefsForRoot(hit.card, familyLedgerHit?.ledger || {});
  const tagHints = await buildTagHintBundleForRoot(hit.card, {
    ownerId: options.ownerId || options.owner_id || '',
    realmId: options.realmId || options.realm_id || '',
    familyRefs,
    linkedPersonaRefs
  });
  const packet = buildRootPacket(hit.card, tagHints);
  return {
    ok: true,
    root_key: rootKey,
    storage: hit.storage || {},
    packet: {
      ...packet,
      root: {
        ...packet.root,
        family_refs: familyRefs
      },
      vine: {
        ...packet.vine,
        related_roots: relatedRoots.slice(0, 8)
      },
      leaf_hints: {
        ...packet.leaf_hints,
        linked_persona_refs: linkedPersonaRefs
      }
    },
    index_row: summarizeRootIndexRow(hit.index_row || {})
  };
}
