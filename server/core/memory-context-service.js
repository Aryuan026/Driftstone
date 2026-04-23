import { getMemoryRootPacket, getMemorySearchResults } from './memory-read-service.js';
import { getShadowRecall } from './shadow-store.js';
import { buildMemoryScope } from './scope-contract.js';
import { getMemoryLeafPacket } from './memory-leaf-service.js';

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

function safeText(value) {
  return String(value || '').trim();
}

function summarizeRelatedRoot(item) {
  return {
    root_key: item.root_key,
    canonical_name: item.canonical_name,
    anchor_type: item.anchor_type,
    tree_path: item.tree_path,
    primary_relation: item.primary_relation,
    score: item.score,
    overlap: item.overlap || {}
  };
}

function normalizeContextMode(mode) {
  const text = String(mode || '').trim().toLowerCase();
  if (!text || text === 'main_bot' || text === 'bot' || text === 'reader_bot') return 'bot';
  if (text === 'persona_helper' || text === 'persona') return 'persona_helper';
  if (text === 'mcp' || text === 'agent') return 'mcp';
  return text;
}

function buildModeNotes(mode) {
  const readerMode = normalizeContextMode(mode);
  if (readerMode === 'persona_helper') {
    return {
      mode: 'persona_helper',
      intent: '补叶与整理语境，不改写事实主干',
      emphasis: ['先读根与藤，再补人物感受与语气', '保留关系温差，不覆盖事实卡', '需要时顺影回场']
    };
  }
  if (readerMode === 'mcp') {
    return {
      mode: 'mcp',
      intent: '给操作型 agent 一个紧凑、可检索、少抒情的上下文包',
      emphasis: ['先看根，再看相关藤', '只在需要时展开影', '不要把 leaf hints 当成硬事实']
    };
  }
  return {
    mode: 'bot',
    intent: '给当前 bot 一份能长叶的记忆上下文',
    emphasis: ['先守住根和藤', '叶只负责温度与意义', '影是回场，不是主叙事']
  };
}

function buildLeafHints(packet, mode, leafPacket) {
  const personaRefs = uniqueStrings(packet?.leaf_hints?.persona_refs, 12);
  const recentToneHints = uniqueStrings(
    (packet?.vine?.recent_updates || []).flatMap((item) => item.summaries || []),
    mode === 'persona_helper' ? 8 : 4
  );
  return {
    persona_refs: personaRefs,
    echo_hints: recentToneHints,
    guidance: buildModeNotes(mode).emphasis,
    profile: leafPacket?.leaf || {
      bot_id: '',
      display_name: '',
      persona_summary: '',
      style_notes: [],
      memory_notes: [],
      prompt_fragments: [],
      updated_at: '',
      source: {}
    }
  };
}

function splitQueryHints(value) {
  return safeText(value)
    .split(/[=；;，,。.!！？?、|/:：()\[\]{}（）"'“”‘’\-\s]+/u)
    .map((item) => safeText(item))
    .filter((item) => item.length >= 2);
}

function extractQuotedPhrases(value) {
  const text = safeText(value);
  if (!text) return [];
  const matches = [];
  const regex = /[“"「『](.{2,48}?)[”"」』]/gu;
  for (const match of text.matchAll(regex)) {
    const phrase = safeText(match[1]);
    if (phrase.length >= 2) matches.push(phrase);
  }
  return matches;
}

function extractAliasFragments(value) {
  const text = safeText(value);
  if (!text) return [];
  return text
    .split(/[\/→→→]|(?:（)|(?:\()|(?:后为)|(?:原名)|(?:系统初始名)|(?:一句话台词)|(?:服务机构)/u)
    .flatMap((item) => splitQueryHints(item))
    .filter((item) => item.length >= 2 && item.length <= 24);
}

function pushUniqueTerm(target, value) {
  const text = safeText(value);
  if (!text) return;
  target.push(text);
}

function pushShortAnchorTerms(target, value) {
  const text = safeText(value);
  if (!text) return;
  if (text.length <= 36) target.push(text);
  extractQuotedPhrases(text).forEach((item) => target.push(item));
}

function normalizeRootType(root = {}) {
  const raw = safeText(root?.anchor_type || root?.trunk).toLowerCase();
  if (!raw) return '';
  if (raw === '人物' || raw === 'person') return 'person';
  if (raw === '规则' || raw === 'rule') return 'rule';
  if (raw === '事件' || raw === 'event') return 'event';
  if (raw === '事物' || raw === 'thing') return 'thing';
  return raw;
}

function splitTagSemanticTerms(value) {
  return safeText(value)
    .replace(/^#+/u, '')
    .split(/[\/]/u)
    .flatMap((item) => splitQueryHints(item))
    .filter((item) => item.length >= 2 && item.length <= 24)
    .filter((item) => !['fact', '关系', '情绪', '项目', '技术', '工作', '人物', '事件', '回顾', '生活'].includes(item.toLowerCase()));
}

function isPersonLikeReference(value, tags = []) {
  const text = safeText(value);
  const tagList = Array.isArray(tags) ? tags.map((item) => safeText(item)) : [];
  if (tagList.some((tag) => tag.startsWith('#人物'))) return true;
  if (!text) return false;
  if (/^[A-Za-z][A-Za-z0-9_（）()·\-]{0,18}$/u.test(text) && text.length <= 18) return true;
  const compact = text.replace(/[\s（）()·\-]/gu, '');
  if ((compact.match(/[\p{Script=Han}]/gu) || []).length <= 4) return true;
  return false;
}

function isGenericFamilyReason(value) {
  const text = safeText(value);
  return !text || text === '叙事主锚';
}

function extractMeaningUnits(value) {
  return safeText(value)
    .split(/[；;，,。.!！？?\n]+/u)
    .map((item) => safeText(item))
    .filter((item) => item.length >= 4 && item.length <= 28);
}

function buildFactKeyTerms(value) {
  const phrase = safeText(value).replace(/_/g, ' ');
  if (!phrase) return [];
  const terms = [phrase];
  const tokens = phrase
    .toLowerCase()
    .split(/\s+/u)
    .map((item) => safeText(item))
    .filter((item) => item.length >= 2)
    .filter((item) => !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'user', 'fact', 'role'].includes(item));
  for (const size of [3, 2]) {
    if (tokens.length < size) continue;
    for (let i = 0; i <= tokens.length - size; i += 1) {
      const chunk = tokens.slice(i, i + size).join(' ');
      if (chunk.length >= 6 && chunk.length <= 36) terms.push(chunk);
    }
  }
  return uniqueStrings(terms, 5);
}

function buildShadowQueryTerms(rootPayload = {}) {
  const packet = rootPayload?.packet || {};
  const root = packet.root || {};
  const rootType = normalizeRootType(root);
  const familyRefs = Array.isArray(root?.family_refs) ? root.family_refs : [];
  const linkedPersonaRefs = Array.isArray(packet?.leaf_hints?.linked_persona_refs)
    ? packet.leaf_hints.linked_persona_refs
    : [];
  const recentUpdates = Array.isArray(packet?.vine?.recent_updates) ? packet.vine.recent_updates : [];
  const atomicFacts = Array.isArray(root?.atomic_facts) ? root.atomic_facts : [];

  const coreTerms = [];
  const anchorTerms = [];
  const factTerms = [];
  const factSecondaryTerms = [];
  const tagTerms = [];
  const updateTerms = [];

  pushUniqueTerm(coreTerms, root.canonical_name);
  splitQueryHints(root.canonical_name).forEach((item) => coreTerms.push(item));
  extractAliasFragments(root.canonical_name).forEach((item) => coreTerms.push(item));
  for (const item of atomicFacts) {
    pushUniqueTerm(factTerms, item?.title);
    extractAliasFragments(item?.title).forEach((alias) => factTerms.push(alias));
    if (rootType === 'rule') {
      const keyTerms = buildFactKeyTerms(item?.fact_key);
      if (keyTerms.length) {
        factTerms.push(keyTerms[0]);
        keyTerms.slice(1).forEach((segment) => factSecondaryTerms.push(segment));
      }
      extractMeaningUnits(item?.fact_value).forEach((segment) => factTerms.push(segment));
      extractQuotedPhrases(item?.fact_value).forEach((segment) => factTerms.push(segment));
      for (const tag of Array.isArray(item?.tags) ? item.tags : []) {
        splitTagSemanticTerms(tag).forEach((segment) => tagTerms.push(segment));
      }
    } else {
      splitQueryHints(safeText(item?.fact_key).replace(/_/g, ' ')).forEach((segment) => factTerms.push(segment));
      pushShortAnchorTerms(factTerms, item?.fact_value);
    }
  }
  for (const item of Array.isArray(root?.stable_facts) ? root.stable_facts.slice(0, 4) : []) {
    if (rootType === 'rule') {
      extractMeaningUnits(item).forEach((segment) => factTerms.push(segment));
      extractQuotedPhrases(item).forEach((segment) => factTerms.push(segment));
    } else {
      pushShortAnchorTerms(factTerms, item);
    }
  }
  for (const item of familyRefs) {
    if (rootType === 'rule') {
      if (!isPersonLikeReference(item?.family_anchor_title)) {
        pushUniqueTerm(anchorTerms, item?.family_anchor_title);
      }
      if (!isGenericFamilyReason(item?.family_reason)) {
        pushShortAnchorTerms(anchorTerms, item?.family_reason);
      }
    } else {
      pushUniqueTerm(anchorTerms, item?.family_anchor_title);
      pushShortAnchorTerms(anchorTerms, item?.family_reason);
    }
  }
  for (const item of linkedPersonaRefs) {
    const title = item?.title || item?.canonical_name || item?.family_anchor_title;
    if (rootType !== 'rule' || !isPersonLikeReference(title, item?.tags)) {
      pushUniqueTerm(anchorTerms, title);
    }
    for (const tag of Array.isArray(item?.tags) ? item.tags : []) {
      splitTagSemanticTerms(tag).forEach((segment) => tagTerms.push(segment));
    }
  }
  if (rootType !== 'rule') {
    for (const update of recentUpdates) {
      for (const summary of Array.isArray(update?.summaries) ? update.summaries : []) {
        pushShortAnchorTerms(updateTerms, summary);
      }
    }
  }

  return uniqueStrings(
    [
      ...coreTerms,
      ...anchorTerms,
      ...factTerms,
      ...tagTerms,
      ...factSecondaryTerms,
      ...updateTerms
    ],
    28
  );
}

function buildRootContext(rootPayload, mode, leafPacket) {
  const packet = rootPayload?.packet || {};
  const root = packet.root || {};
  const vine = packet.vine || {};
  return {
    root: {
      root_key: root.root_key,
      canonical_name: root.canonical_name,
      anchor_type: root.anchor_type,
      trunk: root.trunk,
      slot_path: root.slot_path,
      first_seen_at: root.first_seen_at,
      last_seen_at: root.last_seen_at,
      version_count: root.version_count,
      evolution_status: root.evolution_status,
      stable_facts: uniqueStrings(root.stable_facts, mode === 'mcp' ? 5 : 8)
    },
    vine: {
      related_roots: (vine.related_roots || []).slice(0, mode === 'mcp' ? 5 : 8).map(summarizeRelatedRoot),
      recent_updates: (vine.recent_updates || []).slice(0, mode === 'mcp' ? 4 : 6),
      topic_ids: uniqueStrings(vine.topic_ids, 12)
    },
    leaf: buildLeafHints(packet, mode, leafPacket),
    shadow_refs: {
      source_refs: uniqueStrings(packet?.shadow?.source_refs, 12),
      source_windows: uniqueStrings(packet?.shadow?.source_windows, 12),
      topic_ids: uniqueStrings(packet?.shadow?.topic_ids, 12),
      source_batches: uniqueStrings(packet?.shadow?.source_batches, 12),
      source_group_keys: uniqueStrings(packet?.shadow?.source_group_keys, 24)
    }
  };
}

export async function getMemoryContextPacket({
  key = '',
  query = '',
  mode = 'bot',
  ownerId = '',
  realmId = '',
  botId = '',
  userId = '',
  charId = ''
} = {}) {
  let targetKey = String(key || '').trim();
  let seed = null;
  const readerMode = normalizeContextMode(mode);
  const scope = buildMemoryScope({
    ownerId,
    realmId,
    botId,
    mode: readerMode,
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
      mode: readerMode,
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
      mode: readerMode,
      scope,
      root_key: targetKey
    };
  }

  const leafPacket = await getMemoryLeafPacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    botId: scope.bot_id,
    userId,
    charId
  });

  const context = buildRootContext(rootPayload, readerMode, leafPacket);
  const shadowQueryTerms = buildShadowQueryTerms(rootPayload);
  const shadowRecall = await getShadowRecall({
    sourceRefs: context.shadow_refs.source_refs,
    sourceGroupKeys: context.shadow_refs.source_group_keys,
    topicIds: context.shadow_refs.topic_ids,
    sourceWindows: context.shadow_refs.source_windows,
    sourceBatches: context.shadow_refs.source_batches,
    queryTerms: shadowQueryTerms
  }, { limit: readerMode === 'mcp' ? 4 : 6 });

  return {
    ok: true,
    schema: 'memory_context_packet_v0.1',
    mode: buildModeNotes(readerMode).mode,
    scope: {
      ...scope,
      isolation_stage: leafPacket?.found ? 'bot_leaf_scoped' : (rootPayload?.storage?.scope_mode === 'scoped' ? 'scoped_truth' : scope.isolation_stage)
    },
    intent: buildModeNotes(readerMode).intent,
    root_key: targetKey,
    query: String(query || ''),
    seed: seed ? {
      root_key: seed.root_key,
      canonical_name: seed.canonical_name,
      anchor_type: seed.anchor_type,
      tree_path: seed.tree_path
    } : rootPayload.index_row,
    context: {
      ...context,
      routing: {
        shadow_query_terms: shadowQueryTerms.slice(0, 12)
      },
      shadow_source: shadowRecall.source_mode,
      shadow_snippets: shadowRecall.snippets
    }
  };
}
