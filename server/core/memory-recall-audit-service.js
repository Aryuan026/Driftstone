import { getMemoryRootPacket } from './memory-read-service.js';
import { getMemoryContextPacket } from './memory-context-service.js';
import { loadLatestRootIndex } from './root-store.js';

function safeText(value) {
  return String(value || '').trim();
}

function normalizeText(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/[\s\p{P}\p{S}]+/gu, '');
}

function buildSignalSet(value) {
  const text = compactText(value);
  if (!text) return new Set();
  const signals = new Set();

  const latin = normalizeText(value).match(/[a-z0-9_]+/g) || [];
  for (const token of latin) {
    if (token.length >= 2) signals.add(token);
  }

  const cjkChunks = text.match(/[\p{Script=Han}]{2,}/gu) || [];
  for (const chunk of cjkChunks) {
    if (chunk.length <= 8) {
      signals.add(chunk);
    }
    for (const size of [2, 3, 4]) {
      if (chunk.length < size) continue;
      for (let i = 0; i <= chunk.length - size; i += 1) {
        signals.add(chunk.slice(i, i + size));
      }
    }
  }

  if (signals.size === 0 && text.length >= 2) {
    for (let i = 0; i < text.length - 1; i += 1) {
      signals.add(text.slice(i, i + 2));
    }
  }
  return signals;
}

function splitMeaningfulSegments(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized
    .split(/[\s=；;，,。.!！？?、|/:：()\[\]{}（）"'“”‘’\-]+/u)
    .map((item) => compactText(item))
    .filter((item) => item.length >= 2);
}

function buildSnippetCorpus(snippet = {}) {
  return [
    snippet.excerpt,
    snippet.preview,
    snippet.prompt_hint,
    snippet.excerpt_hint,
    snippet.topic_label,
    snippet.source_window_title,
    ...(Array.isArray(snippet.keywords) ? snippet.keywords : [])
  ]
    .map((item) => safeText(item))
    .filter(Boolean)
    .join(' ');
}

function scoreTextAgainstCorpus(text, corpus) {
  const textNorm = compactText(text);
  const corpusNorm = compactText(corpus);
  if (!textNorm || !corpusNorm) return 0;
  if (corpusNorm.includes(textNorm)) return 1;

  const segments = splitMeaningfulSegments(text);
  const longSegments = [];
  let totalLength = 0;
  let matchedLength = 0;
  for (const segment of segments) {
    if (segment.length < 3) continue;
    totalLength += segment.length;
    if (corpusNorm.includes(segment)) {
      matchedLength += segment.length;
      if (segment.length >= 5) longSegments.push(segment);
    }
  }
  const segmentCoverage = totalLength > 0 ? Number((matchedLength / totalLength).toFixed(4)) : 0;
  if (longSegments.length) {
    return Math.max(segmentCoverage, 0.72);
  }

  const textSignals = buildSignalSet(text);
  const corpusSignals = buildSignalSet(corpus);
  if (!textSignals.size || !corpusSignals.size) return 0;

  let overlap = 0;
  for (const item of textSignals) {
    if (corpusSignals.has(item)) overlap += 1;
  }
  const signalOverlap = Number((overlap / textSignals.size).toFixed(4));
  return Math.max(signalOverlap, segmentCoverage);
}

function safeTitle(item) {
  return safeText(item?.title || item?.canonical_name || item?.family_anchor_title || item?.tag || item?.effect);
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

function splitTagSemantics(value) {
  return safeText(value)
    .replace(/^#+/u, '')
    .split(/[\/]/u)
    .map((item) => compactText(item))
    .filter((item) => item.length >= 2)
    .filter((item) => !['fact', '关系', '情绪', '项目', '技术', '工作', '人物', '事件', '回顾', '生活'].includes(item));
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

function buildEvidenceItems(rootPacket = {}) {
  const root = rootPacket?.packet?.root || {};
  const rootType = normalizeRootType(root);
  const recentUpdates = Array.isArray(rootPacket?.packet?.vine?.recent_updates)
    ? rootPacket.packet.vine.recent_updates
    : [];
  const familyRefs = Array.isArray(root?.family_refs) ? root.family_refs : [];
  const linkedPersonaRefs = Array.isArray(rootPacket?.packet?.leaf_hints?.linked_persona_refs)
    ? rootPacket.packet.leaf_hints.linked_persona_refs
    : [];
  const typeHints = Array.isArray(root?.type_hints) ? root.type_hints : [];
  const leafTagHints = Array.isArray(rootPacket?.packet?.leaf_hints?.tag_hints)
    ? rootPacket.packet.leaf_hints.tag_hints
    : [];
  const relatedRoots = Array.isArray(rootPacket?.packet?.vine?.related_roots)
    ? rootPacket.packet.vine.related_roots
    : [];
  const atomicFacts = Array.isArray(root?.atomic_facts) ? root.atomic_facts : [];

  const items = [];
  const push = (kind, text, weight = 1) => {
    const value = safeText(text);
    if (!value) return;
    items.push({ kind, text: value, weight });
  };

  push('root_name', root.canonical_name, rootType === 'rule' ? 0.76 : 1);
  for (const item of Array.isArray(root.stable_facts) ? root.stable_facts : []) {
    push('stable_fact', item, rootType === 'rule' ? 0.84 : 0.92);
  }
  for (const item of atomicFacts) {
    const role = safeText(item?.fact_role);
    const kind = role === 'fingerprint_candidate' ? 'atomic_fingerprint' : 'atomic_fact';
    if (role === 'fingerprint_candidate') {
      push(kind, item?.fact_value, rootType === 'rule' ? 0.58 : 0.82);
    } else {
      push(kind, item?.fact_value, rootType === 'rule' ? 0.98 : 1.06);
    }
    push('atomic_key', safeText(item?.fact_key).replace(/_/g, ' '), rootType === 'rule' ? 0.8 : 0.48);
    push('atomic_title', item?.title, rootType === 'rule' ? 0.56 : 0.42);
    for (const tag of Array.isArray(item?.tags) ? item.tags : []) {
      for (const segment of splitTagSemantics(tag)) {
        push('atomic_tag', segment, rootType === 'rule' ? 0.44 : 0.28);
      }
    }
  }
  for (const item of recentUpdates.flatMap((entry) => Array.isArray(entry?.summaries) ? entry.summaries : [])) {
    push('update_summary', item, rootType === 'rule' ? 0.46 : 0.62);
  }
  for (const item of familyRefs) {
    const weight = rootType === 'rule'
      ? (isPersonLikeReference(item?.family_anchor_title) ? 0.18 : 0.64)
      : 0.76;
    push('family_anchor', item?.family_anchor_title, weight);
  }
  for (const item of linkedPersonaRefs) {
    const weight = rootType === 'rule'
      ? (isPersonLikeReference(safeTitle(item), item?.tags) ? 0.16 : 0.62)
      : 0.8;
    push('linked_persona', safeTitle(item), weight);
    for (const tag of Array.isArray(item?.tags) ? item.tags : []) {
      const tagWeight = rootType === 'rule'
        ? (safeText(tag).startsWith('#人物') ? 0.08 : 0.22)
        : 0.36;
      if (safeText(tag).includes('/')) push('linked_persona_tag', tag, tagWeight);
      for (const segment of splitTagSemantics(tag)) {
        push('linked_persona_tag_semantic', segment, rootType === 'rule' ? 0.34 : 0.14);
      }
    }
  }
  for (const item of typeHints) {
    push('type_hint', item?.effect, rootType === 'rule' ? 0.46 : 0.4);
    if (safeText(item?.tag).includes('/')) push('type_hint_tag', item?.tag, rootType === 'rule' ? 0.4 : 0.34);
    for (const segment of splitTagSemantics(item?.tag)) {
      push('type_hint_tag_semantic', segment, rootType === 'rule' ? 0.36 : 0.2);
    }
  }
  for (const item of leafTagHints) {
    push('leaf_hint', item?.effect, rootType === 'rule' ? 0.18 : 0.4);
    if (safeText(item?.tag).includes('/')) push('leaf_hint_tag', item?.tag, rootType === 'rule' ? 0.14 : 0.34);
    for (const segment of splitTagSemantics(item?.tag)) {
      push('leaf_hint_tag_semantic', segment, rootType === 'rule' ? 0.1 : 0.18);
    }
  }
  for (const item of relatedRoots) {
    push('related_root', item?.canonical_name, 0.58);
  }
  return items;
}

function summarizeSnippetAlignment(snippet, rootPacket = {}, contextPacket = {}) {
  const root = rootPacket?.packet?.root || {};
  const corpus = buildSnippetCorpus(snippet);
  const evidenceItems = buildEvidenceItems(rootPacket);
  const matches = evidenceItems
    .map((item) => {
      const rawScore = scoreTextAgainstCorpus(item.text, corpus);
      return {
        kind: item.kind,
        text: item.text,
        raw_score: rawScore,
        weighted_score: Number(Math.min(1, rawScore * Number(item.weight || 1)).toFixed(4))
      };
    })
    .filter((item) => item.raw_score > 0)
    .sort((a, b) => b.weighted_score - a.weighted_score);

  const bestByKind = new Map();
  for (const match of matches) {
    const current = bestByKind.get(match.kind);
    if (!current || match.weighted_score > current.weighted_score) {
      bestByKind.set(match.kind, match);
    }
  }

  const best = (kind) => bestByKind.get(kind)?.weighted_score || 0;
  const sourceWindows = Array.isArray(contextPacket?.context?.shadow_refs?.source_windows)
    ? contextPacket.context.shadow_refs.source_windows
    : [];
  const sourceWindowMatch = sourceWindows.includes(safeText(snippet?.source_window_id));
  const nameScore = best('root_name');
  const stableScore = Math.max(best('stable_fact'), best('update_summary'));
  const atomicScore = Math.max(best('atomic_fact'), best('atomic_fingerprint'), best('atomic_key'), best('atomic_title'), best('atomic_tag'));
  const familyScore = Math.max(best('family_anchor'), best('linked_persona'), best('linked_persona_tag'), best('linked_persona_tag_semantic'));
  const hintScore = Math.max(best('type_hint'), best('type_hint_tag'), best('type_hint_tag_semantic'), best('leaf_hint'), best('leaf_hint_tag'), best('leaf_hint_tag_semantic'));
  const relatedScore = best('related_root');
  const topFactScore = Math.max(stableScore, atomicScore, familyScore, hintScore, relatedScore);
  const supportKinds = [
    nameScore >= 0.18,
    stableScore >= 0.18,
    atomicScore >= 0.18,
    familyScore >= 0.18,
    hintScore >= 0.18,
    relatedScore >= 0.18,
    sourceWindowMatch
  ].filter(Boolean).length;
  const score = Number(Math.min(
    1,
    (nameScore * 0.14) +
    (stableScore * 0.18) +
    (atomicScore * 0.24) +
    (familyScore * 0.18) +
    (hintScore * 0.08) +
    (relatedScore * 0.06) +
    (sourceWindowMatch ? 0.18 : 0)
  ).toFixed(4));

  return {
    topic_id: safeText(snippet?.topic_id),
    source_kind: safeText(snippet?.source_kind || snippet?.file ? 'shadow' : ''),
    preview: safeText(snippet?.excerpt || snippet?.excerpt_hint || snippet?.preview),
    source_window_title: safeText(snippet?.source_window_title),
    source_window_match: sourceWindowMatch,
    name_score: nameScore,
    top_fact_score: topFactScore,
    support_hits: supportKinds,
    score,
    matched_facts: matches.slice(0, 5)
  };
}

function classifyAlignment({ topScore = 0, supportHits = 0, shadowCount = 0, sourceMode = '', sourceWindowMatch = false } = {}) {
  if (!shadowCount) return 'no_shadow';
  if ((topScore >= 0.4 && supportHits >= 2) || topScore >= 0.55 || (sourceWindowMatch && topScore >= 0.32 && supportHits >= 2)) return 'aligned';
  if ((topScore >= 0.22 && supportHits >= 1) || topScore >= 0.3 || sourceMode === 'mixed' || (sourceWindowMatch && supportHits >= 1)) return 'partial';
  return 'weak';
}

function summarizeAudit(rootPacket, contextPacket) {
  const root = rootPacket?.packet?.root || {};
  const snippets = Array.isArray(contextPacket?.context?.shadow_snippets) ? contextPacket.context.shadow_snippets : [];
  const rootName = safeText(root.canonical_name);
  const snippetAlignments = snippets
    .map((snippet) => summarizeSnippetAlignment(snippet, rootPacket, contextPacket))
    .sort((a, b) => b.score - a.score);

  const topScore = snippetAlignments[0]?.score || 0;
  const supportHits = snippetAlignments.reduce((sum, item) => sum + item.support_hits, 0);
  const sourceMode = safeText(contextPacket?.context?.shadow_source);
  const sourceWindowMatch = !!snippetAlignments[0]?.source_window_match;
  const alignment = classifyAlignment({
    topScore,
    supportHits,
    shadowCount: snippets.length,
    sourceMode,
    sourceWindowMatch
  });

  return {
    root_key: safeText(root.root_key),
    canonical_name: rootName,
    anchor_type: safeText(root.anchor_type),
    alignment,
    top_score: topScore,
    support_hits: supportHits,
    shadow_source: sourceMode,
    shadow_snippet_count: snippets.length,
    stable_fact_count: Array.isArray(root.stable_facts) ? root.stable_facts.length : 0,
    atomic_fact_count: Array.isArray(root.atomic_facts) ? root.atomic_facts.length : 0,
    top_matches: snippetAlignments.slice(0, 3),
    evidence_preview: buildEvidenceItems(rootPacket).slice(0, 8).map((item) => `${item.kind}:${item.text}`)
  };
}

function pickStratifiedRootKeys(rows = [], limit = 8) {
  const desired = Math.max(1, Number(limit || 8));
  const buckets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const type = safeText(row?.anchor_type) || 'unknown';
    if (!buckets.has(type)) buckets.set(type, []);
    buckets.get(type).push(row);
  }
  const order = ['person', 'rule', 'event', 'thing', 'unknown'];
  const picks = [];
  const seen = new Set();
  let round = 0;
  while (picks.length < desired) {
    let added = false;
    for (const type of order) {
      const bucket = buckets.get(type) || [];
      const row = bucket[round];
      const key = safeText(row?.root_key);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      picks.push(key);
      added = true;
      if (picks.length >= desired) break;
    }
    if (!added) break;
    round += 1;
  }
  if (picks.length < desired) {
    for (const row of rows) {
      const key = safeText(row?.root_key);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      picks.push(key);
      if (picks.length >= desired) break;
    }
  }
  return picks;
}

export async function auditMemoryRecall({
  key = '',
  ownerId = '',
  realmId = '',
  botId = '',
  mode = 'bot',
  limit = 8
} = {}) {
  const rootKeys = [];

  if (safeText(key)) {
    rootKeys.push(safeText(key));
  } else {
    const { index } = await loadLatestRootIndex({ ownerId, realmId });
    const rows = Array.isArray(index?.roots) ? index.roots : [];
    rootKeys.push(...pickStratifiedRootKeys(rows, limit));
  }

  const audits = [];
  for (const rootKey of rootKeys) {
    const rootPacket = await getMemoryRootPacket(rootKey, { ownerId, realmId });
    if (!rootPacket?.ok) {
      audits.push({
        root_key: rootKey,
        alignment: 'missing_root',
        error: 'Root not found'
      });
      continue;
    }

    const contextPacket = await getMemoryContextPacket({
      key: rootKey,
      ownerId,
      realmId,
      botId,
      mode
    });
    if (!contextPacket?.ok) {
      audits.push({
        root_key: rootKey,
        canonical_name: safeText(rootPacket?.packet?.root?.canonical_name),
        alignment: 'missing_context',
        error: 'Context not available'
      });
      continue;
    }

    audits.push(summarizeAudit(rootPacket, contextPacket));
  }

  const counts = {
    aligned: audits.filter((item) => item.alignment === 'aligned').length,
    partial: audits.filter((item) => item.alignment === 'partial').length,
    weak: audits.filter((item) => item.alignment === 'weak').length,
    no_shadow: audits.filter((item) => item.alignment === 'no_shadow').length,
    missing_root: audits.filter((item) => item.alignment === 'missing_root').length,
    missing_context: audits.filter((item) => item.alignment === 'missing_context').length
  };

  return {
    ok: true,
    schema: 'memory_recall_audit_v0.1',
    scope: {
      owner_id: safeText(ownerId),
      realm_id: safeText(realmId),
      bot_id: safeText(botId),
      mode: safeText(mode || 'bot')
    },
    checked_roots: audits.length,
    counts,
    audits
  };
}
