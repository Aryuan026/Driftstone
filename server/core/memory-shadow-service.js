import { getMemoryRootPacket, getMemorySearchResults } from './memory-read-service.js';
import { buildMemoryScope } from './scope-contract.js';
import { getShadowRecall } from './shadow-store.js';

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

export async function getMemoryShadowPacket({
  key = '',
  query = '',
  ownerId = '',
  realmId = '',
  botId = '',
  userId = '',
  charId = '',
  limit = 8
} = {}) {
  let targetKey = String(key || '').trim();
  let seed = null;
  const scope = buildMemoryScope({
    ownerId,
    realmId,
    botId,
    mode: 'bot',
    userId,
    charId
  });

  if (!targetKey) {
    const search = await getMemorySearchResults(query, {
      limit: 1,
      ownerId,
      realmId
    });
    seed = Array.isArray(search?.roots) ? search.roots[0] : null;
    targetKey = seed?.root_key || '';
  }

  if (!targetKey) {
    return {
      ok: false,
      error: 'No matching root',
      scope,
      query: String(query || '')
    };
  }

  const rootPayload = await getMemoryRootPacket(targetKey, {
    ownerId,
    realmId
  });
  if (!rootPayload?.ok) {
    return {
      ok: false,
      error: 'Root not found',
      root_key: targetKey,
      scope
    };
  }

  const shadow = rootPayload?.packet?.shadow || {};
  const recall = await getShadowRecall({
    sourceRefs: shadow.source_refs,
    sourceGroupKeys: shadow.source_group_keys,
    sourceWindows: shadow.source_windows,
    topicIds: shadow.topic_ids,
    sourceBatches: shadow.source_batches
  }, { limit });

  return {
    ok: true,
    schema: 'memory_shadow_packet_v0.1',
    root_key: targetKey,
    scope: {
      ...scope,
      isolation_stage: rootPayload?.storage?.scope_mode === 'scoped' ? 'scoped_truth' : scope.isolation_stage
    },
    seed: seed ? {
      root_key: seed.root_key,
      canonical_name: seed.canonical_name,
      anchor_type: seed.anchor_type,
      tree_path: seed.tree_path
    } : rootPayload.index_row,
    shadow: {
      source_mode: recall.source_mode,
      exact_count: recall.exact_count,
      fallback_count: recall.fallback_count,
      source_refs: uniqueStrings(shadow.source_refs, 24),
      source_windows: uniqueStrings(shadow.source_windows, 24),
      source_batches: uniqueStrings(shadow.source_batches, 24),
      source_group_keys: uniqueStrings(shadow.source_group_keys, 32),
      snippets: recall.snippets
    }
  };
}
