import { postJson } from '../api-client.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function mergeReviewedClustersWithAi({
  backendBase,
  scope,
  clusters = [],
  apiConfig = {},
  intervalMs = 0,
  onProgress = () => {}
} = {}) {
  const ambiguousClusters = (Array.isArray(clusters) ? clusters : [])
    .filter((cluster) => Boolean(cluster?.ambiguous) && Number(cluster?.entry_count || 0) > 1);

  if (!ambiguousClusters.length) {
    return {
      ai_merges: [],
      ambiguous_count: 0,
      ai_used: 0,
      fallback_count: 0
    };
  }

  if (!safeText(apiConfig?.baseUrl) || !safeText(apiConfig?.model)) {
    return {
      ai_merges: [],
      ambiguous_count: ambiguousClusters.length,
      ai_used: 0,
      fallback_count: ambiguousClusters.length
    };
  }

  const aiMerges = [];
  let aiUsed = 0;
  let fallbackCount = 0;

  for (let index = 0; index < ambiguousClusters.length; index += 1) {
    const cluster = ambiguousClusters[index];
    if (intervalMs > 0 && index > 0) await sleep(intervalMs);

    const resp = await postJson(backendBase, '/api/memory/runtime/reviewed/merge', {
      scope,
      cluster_id: safeText(cluster.cluster_id),
      api: apiConfig
    });

    if (!resp.ok || resp.payload?.ok === false) {
      fallbackCount += 1;
    } else if (resp.payload?.used_ai && resp.payload?.entry) {
      aiMerges.push({
        cluster_id: safeText(cluster.cluster_id),
        entry: resp.payload.entry
      });
      aiUsed += 1;
    } else {
      fallbackCount += 1;
    }

    onProgress({
      current: index + 1,
      total: ambiguousClusters.length,
      aiUsed,
      fallbackCount,
      label: safeText(cluster.root_key || cluster.cluster_id || `cluster_${index + 1}`)
    });
  }

  return {
    ai_merges: aiMerges,
    ambiguous_count: ambiguousClusters.length,
    ai_used: aiUsed,
    fallback_count: fallbackCount
  };
}
