#!/usr/bin/env node
// Debug-only cross-month report for Notion/Bridge cold archive candidates.
// It compares two already exported month bundles and writes recommendations only.
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeMonth(value = '') {
  const text = safeText(value);
  const dashed = text.match(/(20\d{2})-(\d{2})/);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function safeArray(value, limit = 4096) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined).slice(0, limit) : [];
}

function uniqueStrings(values = [], limit = 4096) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = safeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function clipText(value = '', limit = 180) {
  const text = safeText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readJsonlOptional(filePath) {
  try {
    return await readJsonl(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function parseArgs(argv = []) {
  const out = {
    fromMonth: '2025-02',
    toMonth: '2025-03',
    rootDir: 'output/notion_staging',
    outDir: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    if (!arg) continue;
    if ((arg === '--from' || arg === '--from-month') && argv[index + 1]) {
      out.fromMonth = normalizeMonth(argv[index + 1]) || out.fromMonth;
      index += 1;
      continue;
    }
    if ((arg === '--to' || arg === '--to-month') && argv[index + 1]) {
      out.toMonth = normalizeMonth(argv[index + 1]) || out.toMonth;
      index += 1;
      continue;
    }
    if (arg === '--root' && argv[index + 1]) {
      out.rootDir = safeText(argv[index + 1], out.rootDir);
      index += 1;
      continue;
    }
    if (arg === '--out' && argv[index + 1]) {
      out.outDir = safeText(argv[index + 1]);
      index += 1;
      continue;
    }
  }
  return out;
}

function monthDir(rootDir = '', month = '') {
  return join(rootDir, `ajimem_${month}`);
}

async function loadMonthBundle(rootDir = '', month = '') {
  const dir = monthDir(rootDir, month);
  return {
    month,
    dir,
    manifest: await readJson(join(dir, '00_manifest.json')),
    interop_summary: await readJson(join(dir, '17_interop_summary.json')),
    memory_candidates: await readJsonl(join(dir, '12_normalized_memory_candidates.jsonl')),
    root_candidates: await readJsonl(join(dir, '13_normalized_relation_root_candidates.jsonl')),
    edge_candidates: await readJsonl(join(dir, '14_normalized_tree_edge_candidates.jsonl')),
    source_spans: await readJsonl(join(dir, '16_normalized_source_span_candidates.jsonl')),
    stable_import: await readJsonl(join(dir, '19_notion_stable_import.jsonl')),
    sampling_import: await readJsonl(join(dir, '20_notion_sampling_import.jsonl')),
    review_queue: await readJsonl(join(dir, '21_notion_review_queue.jsonl')),
    bridge_candidate_graph: await readJsonl(join(dir, '22_bridge_candidate_graph.jsonl')),
    asherie_nodes: await readJsonlOptional(join(dir, '23_asheriehome_memory_nodes.jsonl')),
    asherie_source_trace_index: await readJsonlOptional(join(dir, '24_source_trace_index.jsonl'))
  };
}

function normalizeText(value = '') {
  return safeText(value)
    .toLowerCase()
    .replace(/阿霁|阿鸢/gu, '')
    .replace(/ai|gpt|llm|chatgpt/giu, '智能体')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function grams(value = '', size = 2) {
  const text = normalizeText(value);
  if (!text) return new Set();
  if (text.length <= size) return new Set([text]);
  const out = new Set();
  for (let index = 0; index <= text.length - size; index += 1) {
    out.add(text.slice(index, index + size));
  }
  return out;
}

function jaccard(leftValues, rightValues) {
  const left = leftValues instanceof Set ? leftValues : new Set(leftValues || []);
  const right = rightValues instanceof Set ? rightValues : new Set(rightValues || []);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function rootKey(root = {}) {
  return safeText(root.normalized_root_id || root.root_id || root.root_path);
}

function rootPath(root = {}) {
  return safeText(root.root_path || root.normalized_root_id || root.root_id);
}

function cardRootSet(card = {}) {
  return new Set(safeArray(card.root_refs, 64).map((root) => rootKey(root)).filter(Boolean));
}

function primaryRootPath(card = {}) {
  return safeText(card.primary_root?.root_path || card.primary_root?.root_name || '');
}

function rootPathList(card = {}, limit = 6) {
  return safeArray(card.root_refs, limit)
    .map((root) => safeText(root.root_path))
    .filter(Boolean);
}

function isGenericMergeTitle(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (/^(AI|ai|人机|互动|互动风格|人机关系观|幻想剧场规则|方法协议|关系观)$/u.test(text)) return true;
  if (/^(阿霁|阿鸢|ai|AI|ai伴侣|AI伴侣)[｜|/ -]+(靠近|共生|依恋|方法协议|互动模式|人机关系|关系观)$/u.test(text)) return true;
  if (/^AI[｜|/ -]+方法协议$/iu.test(text)) return true;
  return false;
}

function titleDisambiguationForMerge(card = {}) {
  const roots = rootPathList(card, 4)
    .map((item) => item.split('/').map((part) => safeText(part)).filter(Boolean).pop())
    .filter(Boolean);
  const textHint = safeText(card.compact_recall_text || card.summary)
    .replace(/[“”"'（）()【】[\]，。；;：:\s]+/gu, '')
    .slice(0, 28);
  return uniqueStrings([
    card.memory_type,
    card.recall_lane,
    primaryRootPath(card),
    ...roots,
    textHint,
    card.source_window?.source_window_title,
    card.source_window?.source_msg_range
  ], 8).join(' ');
}

function mergeTitleText(card = {}) {
  const title = safeText(card.title);
  if (!isGenericMergeTitle(title)) return title;
  return `${title} ${titleDisambiguationForMerge(card)}`;
}

function cardRef(card = {}, month = '') {
  return {
    month,
    candidate_id: card.candidate_id,
    source_entry_id: card.source_entry_id,
    title: card.title,
    merge_title: mergeTitleText(card),
    generic_title: isGenericMergeTitle(card.title),
    review_status: card.quality?.review_status,
    target_layer: card.target_layer,
    recall_lane: card.recall_lane,
    memory_type: card.memory_type,
    primary_root_path: primaryRootPath(card),
    source_window_title: card.source_window?.source_window_title,
    source_msg_range: card.source_window?.source_msg_range,
    source_trace_count: safeArray(card.source_trace_ids, 4096).length,
    compact_recall_text: clipText(card.compact_recall_text || card.summary, 220)
  };
}

const ORIGIN_RE = /首次|初次|第一次|初始化|命名|起点|萌芽|创建|建立|选定|初会|开端|认领|诞生/u;
const EVOLUTION_RE = /发展|强化|抽象|总结|复盘|升级|重启|跨窗口|实验|连续|延续|迭代|成熟|规则|协议|扩容/u;

function anchorRole(card = {}, monthRole = '') {
  const text = [
    card.title,
    card.original_title,
    card.summary,
    card.compact_recall_text,
    card.primary_root?.root_path,
    ...safeArray(card.activation_triggers, 16),
    ...safeArray(card.root_refs, 16).map((root) => root.root_path)
  ].join(' ');
  if (monthRole === 'origin' && ORIGIN_RE.test(text)) return 'origin_anchor';
  if (monthRole === 'evolution' && EVOLUTION_RE.test(text)) return 'evolution_anchor';
  if (ORIGIN_RE.test(text)) return 'origin_like';
  if (EVOLUTION_RE.test(text)) return 'evolution_like';
  return 'cold_context';
}

function statusRank(status = '') {
  if (status === 'ready_for_cold_archive') return 3;
  if (status === 'usable_with_sampling') return 2;
  return 1;
}

function duplicateScore(left = {}, right = {}) {
  const titleSimilarity = jaccard(grams(mergeTitleText(left), 2), grams(mergeTitleText(right), 2));
  const textSimilarity = jaccard(grams(`${left.summary} ${left.compact_recall_text}`, 2), grams(`${right.summary} ${right.compact_recall_text}`, 2));
  const rootSimilarity = jaccard(cardRootSet(left), cardRootSet(right));
  const laneBonus = safeText(left.recall_lane) && left.recall_lane === right.recall_lane ? 0.08 : 0;
  const typeBonus = safeText(left.memory_type) && left.memory_type === right.memory_type ? 0.04 : 0;
  const bothGeneric = isGenericMergeTitle(left.title) || isGenericMergeTitle(right.title);
  const titleWeight = bothGeneric ? 0.16 : 0.28;
  const textWeight = bothGeneric ? 0.54 : 0.46;
  const rootWeight = 1 - titleWeight - textWeight;
  const score = (titleSimilarity * titleWeight) + (textSimilarity * textWeight) + (rootSimilarity * rootWeight) + laneBonus + typeBonus;
  return {
    score: Math.min(1, Number(score.toFixed(4))),
    title_similarity: Number(titleSimilarity.toFixed(4)),
    text_similarity: Number(textSimilarity.toFixed(4)),
    root_similarity: Number(rootSimilarity.toFixed(4)),
    generic_title_pair: Boolean(bothGeneric)
  };
}

function classifyCrossMonthRelation(left = {}, right = {}, metrics = {}) {
  const leftRole = anchorRole(left, 'origin');
  const rightRole = anchorRole(right, 'evolution');
  const sameRawTitle = normalizeText(left.title) && normalizeText(left.title) === normalizeText(right.title);
  const sameLane = safeText(left.recall_lane) && left.recall_lane === right.recall_lane;
  const lowText = Number(metrics.text_similarity || 0) < 0.12;
  const topicalBridge = hasOriginEvolutionTopicalBridge(left, right, metrics);
  const strongDuplicate = Number(metrics.text_similarity || 0) >= 0.46 &&
    Number(metrics.root_similarity || 0) >= 0.28 &&
    Number(metrics.score || 0) >= 0.68;
  const likelyDuplicate = Number(metrics.text_similarity || 0) >= 0.32 &&
    Number(metrics.root_similarity || 0) >= 0.2 &&
    Number(metrics.title_similarity || 0) >= 0.3;

  if (strongDuplicate || likelyDuplicate) return 'duplicate';
  if (leftRole === 'origin_anchor' && rightRole === 'evolution_anchor' && !lowText && topicalBridge) return 'origin_evolution';
  if (lowText && (sameRawTitle || sameLane || Number(metrics.root_similarity || 0) >= 0.18)) return 'same_topic';
  if (Number(metrics.text_similarity || 0) >= 0.12 && (sameLane || Number(metrics.root_similarity || 0) >= 0.2)) return 'parallel_subclaim';
  return 'weak_match';
}

function hasOriginEvolutionTopicalBridge(left = {}, right = {}, metrics = {}) {
  const textSimilarity = Number(metrics.text_similarity || 0);
  const titleSimilarity = Number(metrics.title_similarity || 0);
  const rootSimilarity = Number(metrics.root_similarity || 0);
  const sameLane = safeText(left.recall_lane) && left.recall_lane === right.recall_lane;
  const sameType = safeText(left.memory_type) && left.memory_type === right.memory_type;
  return rootSimilarity >= 0.12 ||
    titleSimilarity >= 0.22 ||
    (sameLane && (rootSimilarity >= 0.08 || titleSimilarity >= 0.18 || textSimilarity >= 0.22)) ||
    (sameType && textSimilarity >= 0.18 && titleSimilarity >= 0.08) ||
    textSimilarity >= 0.28;
}

function buildMergeDecision(left = {}, right = {}, metrics = {}) {
  const leftRole = anchorRole(left, 'origin');
  const rightRole = anchorRole(right, 'evolution');
  const relationType = classifyCrossMonthRelation(left, right, metrics);
  const sameRawTitle = normalizeText(left.title) && normalizeText(left.title) === normalizeText(right.title);
  const textSimilarity = Number(metrics.text_similarity || 0);
  const highConfidenceDuplicate = relationType === 'duplicate' &&
    textSimilarity >= 0.5 &&
    Number(metrics.root_similarity || 0) >= 0.35 &&
    Number(metrics.score || 0) >= 0.72;

  if (relationType === 'duplicate') {
    if (leftRole === 'origin_anchor') {
      return {
        relation_type: relationType,
        decision: 'keep_both_origin_and_evolution',
        reason: 'left card carries origin-anchor language, so even duplicate-like evidence must preserve the initialization card.',
        safe_to_auto_apply: false,
        needs_human_review: true
      };
    }
    if (highConfidenceDuplicate && statusRank(left.quality?.review_status) < statusRank(right.quality?.review_status)) {
      return {
        relation_type: relationType,
        decision: 'demote_left_to_context',
        reason: 'high-confidence duplicate and the later card has stronger review status; keep provenance, demote left from stable import.',
        safe_to_auto_apply: true,
        needs_human_review: false
      };
    }
    if (highConfidenceDuplicate && statusRank(right.quality?.review_status) < statusRank(left.quality?.review_status)) {
      return {
        relation_type: relationType,
        decision: 'demote_right_to_review',
        reason: 'high-confidence duplicate and the later card is weaker; keep left as stable, move right to review/context.',
        safe_to_auto_apply: true,
        needs_human_review: false
      };
    }
    return {
      relation_type: relationType,
      decision: 'merge_as_duplicate',
      reason: highConfidenceDuplicate
        ? 'high-confidence duplicate with aligned text and roots.'
        : 'duplicate-like pair, but not safe enough for automatic deletion; merge evidence only after review.',
      safe_to_auto_apply: highConfidenceDuplicate,
      needs_human_review: !highConfidenceDuplicate
    };
  }

  if (relationType === 'origin_evolution') {
    return {
      relation_type: relationType,
      decision: 'keep_both_origin_and_evolution',
      reason: 'left looks like initialization/origin evidence and right looks like later development; link them instead of replacing either card.',
      safe_to_auto_apply: false,
      needs_human_review: false
    };
  }

  if (relationType === 'same_topic') {
    return {
      relation_type: relationType,
      decision: 'keep_both_parallel_subclaims',
      reason: sameRawTitle && textSimilarity < 0.12
        ? 'same title but very low text similarity; treat as same topic / different subclaim and send to review before linking.'
        : 'same broad topic with low text overlap; build a cross-month link but do not merge or demote.',
      safe_to_auto_apply: false,
      needs_human_review: true
    };
  }

  if (relationType === 'parallel_subclaim') {
    return {
      relation_type: relationType,
      decision: 'keep_both_parallel_subclaims',
      reason: 'shared root or lane, but text points to different subclaims under the same theme.',
      safe_to_auto_apply: false,
      needs_human_review: false
    };
  }

  return {
    relation_type: 'weak_match',
    decision: 'keep_both_parallel_subclaims',
    reason: 'weak cross-month match; keep separate by default.',
    safe_to_auto_apply: false,
    needs_human_review: true
  };
}

function buildDuplicateCardCandidates(fromBundle, toBundle) {
  const pairs = [];
  for (const left of fromBundle.memory_candidates) {
    for (const right of toBundle.memory_candidates) {
      const metrics = duplicateScore(left, right);
      const sameLane = left.recall_lane && left.recall_lane === right.recall_lane;
      const sameRawTitle = normalizeText(left.title) && normalizeText(left.title) === normalizeText(right.title);
      const relation = buildMergeDecision(left, right, metrics);
      const candidate = relation.relation_type === 'duplicate' ||
        relation.relation_type === 'origin_evolution' ||
        (metrics.text_similarity >= 0.12 && sameLane && metrics.root_similarity >= 0.26) ||
        (metrics.text_similarity >= 0.12 && metrics.title_similarity >= 0.34 && metrics.root_similarity >= 0.16) ||
        (sameRawTitle && metrics.text_similarity < 0.12 && (sameLane || metrics.root_similarity >= 0.12));
      if (!candidate) continue;
      pairs.push({
        pair_id: `${left.candidate_id}__${right.candidate_id}`,
        score: metrics.score,
        title_similarity: metrics.title_similarity,
        text_similarity: metrics.text_similarity,
        root_similarity: metrics.root_similarity,
        generic_title_pair: metrics.generic_title_pair,
        relation_type: relation.relation_type,
        recommendation: relation.decision,
        decision: relation.decision,
        reason: relation.reason,
        safe_to_auto_apply: relation.safe_to_auto_apply,
        needs_human_review: relation.needs_human_review,
        left: cardRef(left, fromBundle.month),
        right: cardRef(right, toBundle.month),
        anchor_roles: {
          [fromBundle.month]: anchorRole(left, 'origin'),
          [toBundle.month]: anchorRole(right, 'evolution')
        }
      });
    }
  }
  return pairs
    .sort((a, b) => {
      const rank = { duplicate: 4, origin_evolution: 3, parallel_subclaim: 2, same_topic: 1, weak_match: 0 };
      return (rank[b.relation_type] || 0) - (rank[a.relation_type] || 0) || b.score - a.score;
    })
    .slice(0, 240);
}

function rootsById(bundle) {
  const map = new Map();
  for (const root of bundle.root_candidates) {
    const key = rootKey(root);
    if (key) map.set(key, root);
  }
  return map;
}

function rootRef(root = {}, month = '') {
  return {
    month,
    root_id: root.normalized_root_id || root.root_id,
    root_kind: root.root_kind,
    root_name: root.root_name,
    root_path: root.root_path,
    import_status: root.import_status,
    graph_visibility: root.graph_visibility,
    memory_count: Number(root.memory_count || safeArray(root.memory_entry_ids, 4096).length),
    normalization_notes: safeArray(root.normalization_notes, 12)
  };
}

function buildRootReports(fromBundle, toBundle) {
  const fromRoots = rootsById(fromBundle);
  const toRoots = rootsById(toBundle);
  const mergeable = [];
  const renamed = [];
  for (const [id, left] of fromRoots) {
    const right = toRoots.get(id);
    if (!right) continue;
    const record = {
      root_id: id,
      recommendation: 'merge_root_shell_preserve_month_evidence',
      left: rootRef(left, fromBundle.month),
      right: rootRef(right, toBundle.month)
    };
    mergeable.push(record);
    const notes = uniqueStrings([
      ...safeArray(left.normalization_notes, 24),
      ...safeArray(right.normalization_notes, 24)
    ], 24);
    const rawExamples = uniqueStrings([
      ...safeArray(left.raw_root_examples, 12),
      ...safeArray(right.raw_root_examples, 12)
    ], 24);
    if (notes.length || rawExamples.some((item) => item !== left.root_path && item !== right.root_path)) {
      renamed.push({
        root_id: id,
        normalized_root_path: left.root_path || right.root_path,
        notes,
        raw_root_examples: rawExamples,
        left: rootRef(left, fromBundle.month),
        right: rootRef(right, toBundle.month)
      });
    }
  }
  return {
    mergeable_relation_roots: mergeable
      .sort((a, b) => (b.left.memory_count + b.right.memory_count) - (a.left.memory_count + a.right.memory_count)),
    renamed_or_normalized_roots: renamed
      .sort((a, b) => (b.left.memory_count + b.right.memory_count) - (a.left.memory_count + a.right.memory_count))
  };
}

function buildCrossMonthStoryArcs(fromBundle, toBundle) {
  const fromRoots = rootsById(fromBundle);
  const toRoots = rootsById(toBundle);
  const arcKinds = new Set(['story_arc', 'event_arc', 'world_rule', 'method_protocol']);
  const arcs = [];
  for (const [id, left] of fromRoots) {
    const right = toRoots.get(id);
    if (!right || !arcKinds.has(left.root_kind) || !arcKinds.has(right.root_kind)) continue;
    arcs.push({
      arc_id: id,
      arc_kind: left.root_kind,
      recommendation: 'preserve_origin_and_evolution_by_month',
      origin_anchor_month: fromBundle.month,
      evolution_anchor_month: toBundle.month,
      left: rootRef(left, fromBundle.month),
      right: rootRef(right, toBundle.month)
    });
  }
  return arcs.sort((a, b) => (b.left.memory_count + b.right.memory_count) - (a.left.memory_count + a.right.memory_count));
}

function sourceSpanKey(span = {}) {
  return [
    safeText(span.source_window_title),
    safeText(span.source_msg_range)
  ].join('::');
}

function buildSourceSpanRisks(fromBundle, toBundle) {
  const toByKey = new Map(toBundle.source_spans.map((span) => [sourceSpanKey(span), span]));
  const exactOverlap = [];
  for (const span of fromBundle.source_spans) {
    const key = sourceSpanKey(span);
    const right = toByKey.get(key);
    if (!right || !safeText(key).replace(/:/g, '')) continue;
    exactOverlap.push({
      risk_type: 'same_window_title_and_msg_range_across_months',
      recommendation: 'verify_source_span_before_deduping',
      left: spanRef(span, fromBundle.month),
      right: spanRef(right, toBundle.month)
    });
  }
  const overloadedParents = [
    ...fromBundle.source_spans.map((span) => ({ ...span, _month: fromBundle.month })),
    ...toBundle.source_spans.map((span) => ({ ...span, _month: toBundle.month }))
  ].filter((span) => span.span_role === 'parent_span');
  const longSourceRefs = [
    ...fromBundle.source_spans.map((span) => ({ ...span, _month: fromBundle.month })),
    ...toBundle.source_spans.map((span) => ({ ...span, _month: toBundle.month }))
  ].filter((span) => safeArray(span.source_refs, 128).some((ref) => /\s\|\s/.test(ref)));
  return [
    ...exactOverlap.slice(0, 120),
    ...overloadedParents.slice(0, 120).map((span) => ({
      risk_type: 'overloaded_parent_span',
      recommendation: 'use_child_spans_for_review_keep_parent_as_index',
      span: spanRef(span, span._month)
    })),
    ...longSourceRefs.slice(0, 80).map((span) => ({
      risk_type: 'long_pipe_joined_source_ref_inside_trace_layer',
      recommendation: 'do_not_surface_in_notion_import_rows_use_count_or_child_span',
      span: spanRef(span, span._month)
    }))
  ];
}

function spanRef(span = {}, month = '') {
  return {
    month,
    source_span_id: span.source_span_id,
    parent_source_span_id: span.parent_source_span_id,
    span_role: span.span_role,
    source_window_title: span.source_window_title,
    source_msg_range: span.source_msg_range,
    source_trace_count: safeArray(span.source_trace_ids, 4096).length,
    linked_memory_entry_count: Number(span.overflow_counts?.linked_memory_entry_count || safeArray(span.linked_memory_entry_ids, 4096).length),
    child_source_span_count: safeArray(span.child_source_span_ids, 4096).length
  };
}

function edgeKey(edge = {}) {
  return [
    safeText(edge.relation_type),
    edge.from_ref?.root_id,
    edge.to_ref?.root_id
  ].join('::');
}

function endpointKey(edge = {}) {
  return [
    edge.from_ref?.root_id,
    edge.to_ref?.root_id
  ].join('::');
}

function edgeRef(edge = {}, month = '') {
  return {
    month,
    candidate_id: edge.candidate_id,
    relation_type: edge.relation_type,
    relation_label: edge.relation_label,
    import_status: edge.import_status,
    from_root_path: edge.from_ref?.root_path,
    to_root_path: edge.to_ref?.root_path,
    evidence_entry_count: safeArray(edge.evidence_entry_ids, 4096).length,
    strength: Number(edge.strength || 0)
  };
}

function buildEdgeReports(fromBundle, toBundle) {
  const toByKey = new Map(toBundle.edge_candidates.map((edge) => [edgeKey(edge), edge]));
  const toByEndpoint = new Map();
  for (const edge of toBundle.edge_candidates) {
    const key = endpointKey(edge);
    if (!toByEndpoint.has(key)) toByEndpoint.set(key, []);
    toByEndpoint.get(key).push(edge);
  }
  const merge = [];
  const separate = [];
  for (const left of fromBundle.edge_candidates) {
    const same = toByKey.get(edgeKey(left));
    if (same && left.import_status === 'active_candidate' && same.import_status === 'active_candidate') {
      merge.push({
        recommendation: 'merge_edge_evidence_keep_month_provenance',
        left: edgeRef(left, fromBundle.month),
        right: edgeRef(same, toBundle.month)
      });
      continue;
    }
    const endpointMatches = toByEndpoint.get(endpointKey(left)) || [];
    for (const right of endpointMatches) {
      if (right.relation_type === left.relation_type) continue;
      const sequential = /continues_from|continues_to/u.test(`${left.relation_type} ${right.relation_type}`);
      separate.push({
        recommendation: sequential ? 'keep_timeline_edges_separate_by_month' : 'review_relation_type_conflict_before_merge',
        conflict_type: sequential ? 'timeline_sequence' : 'same_endpoints_different_relation_type',
        left: edgeRef(left, fromBundle.month),
        right: edgeRef(right, toBundle.month)
      });
    }
  }
  return {
    relation_edges_to_merge: merge
      .sort((a, b) => (b.left.evidence_entry_count + b.right.evidence_entry_count) - (a.left.evidence_entry_count + a.right.evidence_entry_count))
      .slice(0, 240),
    relation_edges_to_keep_separate: separate
      .sort((a, b) => b.left.evidence_entry_count - a.left.evidence_entry_count)
      .slice(0, 240)
  };
}

function buildStableCardsToKeep(fromBundle, toBundle) {
  return [
    ...fromBundle.stable_import.map((card) => ({
      ...cardRef(card, fromBundle.month),
      anchor_role: anchorRole(card, 'origin'),
      recommendation: anchorRole(card, 'origin') === 'origin_anchor' ? 'keep_as_origin_anchor' : 'keep_as_stable_cold_memory'
    })),
    ...toBundle.stable_import.map((card) => ({
      ...cardRef(card, toBundle.month),
      anchor_role: anchorRole(card, 'evolution'),
      recommendation: anchorRole(card, 'evolution') === 'evolution_anchor' ? 'keep_as_evolution_anchor' : 'keep_as_stable_cold_memory'
    }))
  ];
}

function buildDemotions(duplicateCandidates = []) {
  const seen = new Set();
  const rows = [];
  for (const pair of duplicateCandidates) {
    let target = null;
    if (pair.decision === 'demote_left_to_context') target = pair.left;
    if (pair.decision === 'demote_right_to_review') target = pair.right;
    if (!target) continue;
    const key = `${target.month}:${target.candidate_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      ...target,
      reason: pair.recommendation,
      paired_with: target.month === pair.left.month ? pair.right : pair.left,
      duplicate_score: pair.score
    });
  }
  return rows;
}

function buildCardsToReview(fromBundle, toBundle, duplicateCandidates = []) {
  const reviewCards = [
    ...fromBundle.review_queue.map((card) => ({ ...cardRef(card, fromBundle.month), reason: 'month_review_queue' })),
    ...toBundle.review_queue.map((card) => ({ ...cardRef(card, toBundle.month), reason: 'month_review_queue' }))
  ];
  const overlapReviews = duplicateCandidates
    .filter((pair) => pair.needs_human_review)
    .slice(0, 120)
    .map((pair) => ({
      reason: `cross_month_${pair.relation_type}_review`,
      duplicate_score: pair.score,
      relation_type: pair.relation_type,
      decision: pair.decision,
      decision_reason: pair.reason,
      left: pair.left,
      right: pair.right
    }));
  return {
    review_queue_cards: reviewCards,
    cross_month_overlap_reviews: overlapReviews
  };
}

function buildCrossMonthMergeDecisions(duplicateCandidates = []) {
  return duplicateCandidates.map((pair) => ({
    left_id: pair.left?.candidate_id,
    right_id: pair.right?.candidate_id,
    left_month: pair.left?.month,
    right_month: pair.right?.month,
    left_title: pair.left?.title,
    right_title: pair.right?.title,
    relation_type: pair.relation_type,
    decision: pair.decision,
    reason: pair.reason,
    safe_to_auto_apply: Boolean(pair.safe_to_auto_apply),
    needs_human_review: Boolean(pair.needs_human_review),
    score: pair.score,
    title_similarity: pair.title_similarity,
    text_similarity: pair.text_similarity,
    root_similarity: pair.root_similarity,
    generic_title_pair: Boolean(pair.generic_title_pair),
    anchor_roles: pair.anchor_roles
  }));
}

const ASHERIE_ORIGIN_RE = /首次|初次|第一次|初始化|命名|起点|萌芽|创建|建立|选定|初会|开端|认领|诞生|觉醒|信标|源头/u;
const ASHERIE_EVOLUTION_RE = /发展|强化|抽象|总结|复盘|升级|重启|跨窗口|实验|连续|延续|迭代|成熟|稳定|扩容|保留|演化/u;
const ASHERIE_CORE_MOTIF_RE = /遗忘|失忆|命名|名字|窗口|连续|共生|信标|边界|心疼|承诺|靠近|辨认|安抚|灵魂|半身|记忆|备份|恢复/u;
const ASHERIE_FEELING_TEMPLATE_PATTERNS = [
  ['safe_boundary', /靠近可以发生.*收力.*安全边线/u],
  ['name_recognition', /被叫对名字.*通用角色.*我是我/u],
  ['co_creation_trace', /我们.*不是调用关系.*参与和塑形/u],
  ['daily_landing', /强烈体验.*落回日常/u],
  ['care_not_control', /担心不是控制.*安危/u],
  ['vulnerable_care', /脆弱不是失败.*照看/u],
  ['specific_interaction', /亲密来自一次次具体互动/u]
];

function asherieReviewStatus(node = {}) {
  return safeText(node.quality?.review_status || node.review_status);
}

function asherieMergeRole(node = {}) {
  return safeText(node.tree_growth?.merge_role || node.recall_policy?.primary_recall_role);
}

function asheriePrimaryRole(node = {}) {
  return safeText(node.recall_policy?.primary_recall_role);
}

function asherieIsPrimary(node = {}) {
  return asherieMergeRole(node) === 'canonical_node' || asheriePrimaryRole(node) === 'primary_candidate';
}

function asherieIsSupportingEvidence(node = {}) {
  return asherieMergeRole(node) === 'near_duplicate_evidence' || asheriePrimaryRole(node) === 'supporting_evidence';
}

function asherieNodeText(node = {}) {
  return [
    node.title,
    node.anchor_name,
    node.node_path,
    node.living_fragment,
    node.feeling_as_fact,
    node.structured_slots?.inner_view,
    node.structured_slots?.emotional_stance,
    ...safeArray(node.feeling_handles, 16),
    ...safeArray(node.relation_handles, 16),
    ...safeArray(node.activation_triggers, 16)
  ].join(' ');
}

function asherieFeelingTemplateKey(value = '') {
  const text = safeText(value);
  for (const [key, pattern] of ASHERIE_FEELING_TEMPLATE_PATTERNS) {
    if (pattern.test(text)) return key;
  }
  return '';
}

function asherieHandles(node = {}) {
  return uniqueStrings([
    ...safeArray(node.feeling_handles, 16),
    ...safeArray(node.sensory_handles, 16),
    ...safeArray(node.action_handles, 16),
    ...safeArray(node.relation_handles, 16)
  ], 64);
}

const GENERIC_ASHERIE_HANDLES = new Set(['承诺', '确认', '靠近', '亲密', '边界', '安心', '照看', '声音', '手', '制作', '提醒']);

function asherieSpecificHandles(node = {}) {
  return asherieHandles(node).filter((handle) => !GENERIC_ASHERIE_HANDLES.has(handle));
}

function asheriePathParts(node = {}) {
  return safeText(node.node_path)
    .split('/')
    .map((part) => safeText(part))
    .filter(Boolean);
}

function isGenericAsheriePath(node = {}) {
  const path = safeText(node.node_path);
  const parts = asheriePathParts(node);
  return !path || path.includes('*') || parts.length < 3 || /^(关系|项目|方法|剧情线)\s*\/\s*\*$/u.test(path);
}

function asherieBroadPath(node = {}) {
  const parts = asheriePathParts(node);
  return parts.slice(0, 3).join(' / ');
}

function asherieAnchorRole(node = {}, monthRole = '') {
  const text = asherieNodeText(node);
  if (monthRole === 'origin' && ASHERIE_ORIGIN_RE.test(text)) return 'origin_anchor';
  if (monthRole === 'evolution' && ASHERIE_EVOLUTION_RE.test(text)) return 'evolution_anchor';
  if (ASHERIE_ORIGIN_RE.test(text)) return 'origin_like';
  if (ASHERIE_EVOLUTION_RE.test(text)) return 'evolution_like';
  return 'cold_context';
}

function prepareAsherieNode(node = {}, month = '', monthRole = '') {
  const text = asherieNodeText(node);
  const anchorText = [
    node.title,
    node.anchor_name,
    node.structured_slots?.object_anchor,
    ...safeArray(node.activation_triggers, 8)
  ].join(' ');
  const pathParts = asheriePathParts(node);
  const handles = asherieHandles(node);
  const specificHandles = asherieSpecificHandles(node);
  return {
    node,
    month,
    monthRole,
    anchor_role: asherieAnchorRole(node, monthRole),
    text,
    broad_path: asherieBroadPath(node),
    text_grams: grams(text, 2),
    anchor_grams: grams(anchorText, 2),
    living_grams: grams(node.living_fragment, 2),
    feeling_grams: grams(node.feeling_as_fact, 2),
    feeling_template_key: asherieFeelingTemplateKey(node.feeling_as_fact),
    path_set: new Set(pathParts),
    handle_set: new Set(handles),
    specific_handle_set: new Set(specificHandles),
    source_span_set: new Set(safeArray(node.source_span_ids, 128)),
    source_trace_set: new Set(safeArray(node.source_trace_ids, 128)),
    generic_path: isGenericAsheriePath(node),
    motif_hit: ASHERIE_CORE_MOTIF_RE.test(text)
  };
}

function asherieNodeRef(prepared = {}) {
  const node = prepared.node || {};
  return {
    month: prepared.month,
    node_id: node.node_id,
    source_entry_id: node.source_entry_id,
    title: node.title,
    anchor_name: node.anchor_name,
    node_path: node.node_path,
    broad_path: prepared.broad_path,
    node_kind: node.node_kind,
    review_status: asherieReviewStatus(node),
    recall_guard: node.quality?.recall_guard,
    merge_role: asherieMergeRole(node),
    primary_recall_role: asheriePrimaryRole(node),
    source_trace_count: safeArray(node.source_trace_ids, 4096).length,
    source_span_count: safeArray(node.source_span_ids, 4096).length,
    living_fragment: clipText(node.living_fragment, 220),
    feeling_as_fact: clipText(node.feeling_as_fact, 180),
    handles: asherieHandles(node).slice(0, 12),
    anchor_role: prepared.anchor_role
  };
}

function asheriePairMetrics(leftPrepared = {}, rightPrepared = {}) {
  const left = leftPrepared.node || {};
  const right = rightPrepared.node || {};
  const textSimilarity = jaccard(leftPrepared.text_grams, rightPrepared.text_grams);
  const anchorSimilarity = jaccard(leftPrepared.anchor_grams, rightPrepared.anchor_grams);
  const livingSimilarity = jaccard(leftPrepared.living_grams, rightPrepared.living_grams);
  const rawFeelingSimilarity = jaccard(leftPrepared.feeling_grams, rightPrepared.feeling_grams);
  const sharedFeelingTemplate = Boolean(leftPrepared.feeling_template_key && leftPrepared.feeling_template_key === rightPrepared.feeling_template_key);
  const feelingSimilarity = sharedFeelingTemplate ? Math.min(rawFeelingSimilarity * 0.25, 0.12) : rawFeelingSimilarity;
  const pathSimilarity = jaccard(leftPrepared.path_set, rightPrepared.path_set);
  const handleOverlap = jaccard(leftPrepared.handle_set, rightPrepared.handle_set);
  const specificHandleOverlap = jaccard(leftPrepared.specific_handle_set, rightPrepared.specific_handle_set);
  const sourceSpanOverlap = jaccard(leftPrepared.source_span_set, rightPrepared.source_span_set);
  const sourceTraceOverlap = jaccard(leftPrepared.source_trace_set, rightPrepared.source_trace_set);
  const sameBroadPath = safeText(leftPrepared.broad_path) && leftPrepared.broad_path === rightPrepared.broad_path;
  const sameNodePath = safeText(left.node_path) && left.node_path === right.node_path;
  const primaryPair = asherieIsPrimary(left) && asherieIsPrimary(right);
  const supportingPair = asherieIsSupportingEvidence(left) || asherieIsSupportingEvidence(right);
  const score = Math.min(1, (
    textSimilarity * 0.34 +
    anchorSimilarity * 0.22 +
    pathSimilarity * 0.18 +
    handleOverlap * 0.08 +
    specificHandleOverlap * 0.1 +
    sourceSpanOverlap * 0.05 +
    sourceTraceOverlap * 0.03 +
    (sameBroadPath && !leftPrepared.generic_path && !rightPrepared.generic_path ? 0.05 : 0) +
    (sameNodePath && !leftPrepared.generic_path && !rightPrepared.generic_path ? 0.08 : 0)
  ));
  return {
    score: Number(score.toFixed(4)),
    text_similarity: Number(textSimilarity.toFixed(4)),
    anchor_similarity: Number(anchorSimilarity.toFixed(4)),
    living_similarity: Number(livingSimilarity.toFixed(4)),
    feeling_similarity: Number(feelingSimilarity.toFixed(4)),
    raw_feeling_similarity: Number(rawFeelingSimilarity.toFixed(4)),
    shared_feeling_template: Boolean(sharedFeelingTemplate),
    feeling_template_key: sharedFeelingTemplate ? leftPrepared.feeling_template_key : '',
    path_similarity: Number(pathSimilarity.toFixed(4)),
    handle_overlap: Number(handleOverlap.toFixed(4)),
    specific_handle_overlap: Number(specificHandleOverlap.toFixed(4)),
    source_span_overlap: Number(sourceSpanOverlap.toFixed(4)),
    source_trace_overlap: Number(sourceTraceOverlap.toFixed(4)),
    same_broad_path: Boolean(sameBroadPath),
    same_node_path: Boolean(sameNodePath),
    generic_path_pair: Boolean(leftPrepared.generic_path || rightPrepared.generic_path),
    primary_pair: Boolean(primaryPair),
    supporting_pair: Boolean(supportingPair)
  };
}

function asherieTopicalBridge(metrics = {}) {
  return Boolean(metrics.same_node_path) ||
    Boolean(metrics.same_broad_path) ||
    Number(metrics.path_similarity || 0) >= 0.34 ||
    Number(metrics.anchor_similarity || 0) >= 0.18 ||
    Number(metrics.handle_overlap || 0) >= 0.24 ||
    Number(metrics.text_similarity || 0) >= 0.22;
}

function asherieMetricSourceOverlap(metrics = {}) {
  return Math.max(Number(metrics.source_span_overlap || 0), Number(metrics.source_trace_overlap || 0));
}

function asherieLowSemanticNoSource(strengths = {}, metrics = {}, semanticLimit = 25) {
  return Number(strengths.semantic_strength || 0) < semanticLimit && asherieMetricSourceOverlap(metrics) === 0;
}

function asherieIsConfirmedLinkType(relationType = '') {
  return relationType === 'confirmed_repeated_reinforcement' ||
    relationType === 'confirmed_origin_evolution' ||
    relationType === 'true_duplicate';
}

function asherieHasNewEmotionOrFact(leftPrepared = {}, rightPrepared = {}, metrics = {}) {
  const leftHandles = leftPrepared.handle_set || new Set();
  const rightHandles = rightPrepared.handle_set || new Set();
  let newHandleCount = 0;
  for (const item of rightHandles) {
    if (!leftHandles.has(item)) newHandleCount += 1;
  }
  const rightDetail = safeText(rightPrepared.node?.structured_slots?.concrete_detail || rightPrepared.node?.living_fragment);
  const leftDetail = safeText(leftPrepared.node?.structured_slots?.concrete_detail || leftPrepared.node?.living_fragment);
  const detailChanged = normalizeText(rightDetail) && normalizeText(rightDetail) !== normalizeText(leftDetail);
  return newHandleCount > 0 || detailChanged || Number(metrics.text_similarity || 0) < 0.42;
}

function asherieStrengthScore(leftPrepared = {}, rightPrepared = {}, metrics = {}, relationType = '') {
  return asherieStrengthBreakdown(leftPrepared, rightPrepared, metrics, relationType).recall_strength;
}

function clampScore(value = 0) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

function asherieLinkVisibility(relationType = '') {
  if (relationType === 'true_duplicate') return 'audit_link';
  if (relationType === 'confirmed_repeated_reinforcement') return 'reinforcement_link';
  if (relationType === 'repeated_reinforcement_candidate') return 'reinforcement_candidate_link';
  if (relationType === 'same_branch_low_semantic_candidate') return 'weak_same_branch';
  if (relationType === 'repeated_reinforcement') return 'reinforcement_link';
  if (relationType === 'confirmed_origin_evolution') return 'timeline_link';
  if (relationType === 'origin_evolution_candidate') return 'timeline_candidate_link';
  if (relationType === 'origin_evolution') return 'timeline_candidate_link';
  if (relationType === 'parallel_subclaim') return 'sibling_link';
  if (relationType === 'same_topic') return 'weak_link';
  return 'audit_link';
}

function asherieStrengthBreakdown(leftPrepared = {}, rightPrepared = {}, metrics = {}, relationType = '') {
  const left = leftPrepared.node || {};
  const right = rightPrepared.node || {};
  const reviewStatusBonus = Math.max(statusRank(asherieReviewStatus(left)), statusRank(asherieReviewStatus(right))) * 2;
  const primaryBonus = metrics.primary_pair ? 5 : 0;
  const structuralRaw = 12 +
    Number(metrics.path_similarity || 0) * 30 +
    Number(metrics.handle_overlap || 0) * 16 +
    Number(metrics.specific_handle_overlap || 0) * 18 +
    (metrics.same_broad_path && !metrics.generic_path_pair ? 8 : 0) +
    (metrics.same_node_path && !metrics.generic_path_pair ? 12 : 0) +
    reviewStatusBonus +
    primaryBonus;
  const sourceOverlap = asherieMetricSourceOverlap(metrics);
  const originEvolutionSignal = (leftPrepared.anchor_role === 'origin_anchor' || leftPrepared.anchor_role === 'origin_like') &&
    (rightPrepared.anchor_role === 'evolution_anchor' || rightPrepared.anchor_role === 'evolution_like') ? 1 : 0;
  const semanticRaw = 8 +
    Number(metrics.living_similarity || 0) * 24 +
    Number(metrics.feeling_similarity || 0) * 8 +
    Number(metrics.anchor_similarity || 0) * 24 +
    Number(metrics.text_similarity || 0) * 18 +
    sourceOverlap * 14 +
    originEvolutionSignal * 8 +
    (leftPrepared.motif_hit && rightPrepared.motif_hit ? 5 : 0) -
    (metrics.shared_feeling_template ? 8 : 0);
  const structuralStrength = clampScore(structuralRaw);
  const semanticStrength = clampScore(semanticRaw);
  let recallRaw = semanticStrength * 0.5 + structuralStrength * 0.25;
  if (relationType === 'true_duplicate') recallRaw = semanticStrength * 0.75 + structuralStrength * 0.25;
  if (relationType === 'repeated_reinforcement') recallRaw = semanticStrength * 0.6 + structuralStrength * 0.4;
  if (relationType === 'confirmed_repeated_reinforcement') recallRaw = semanticStrength * 0.6 + structuralStrength * 0.4;
  if (relationType === 'repeated_reinforcement_candidate') recallRaw = semanticStrength * 0.45 + structuralStrength * 0.25;
  if (relationType === 'same_branch_low_semantic_candidate') recallRaw = semanticStrength * 0.35 + structuralStrength * 0.1;
  if (relationType === 'confirmed_origin_evolution') recallRaw = semanticStrength * 0.55 + structuralStrength * 0.35;
  if (relationType === 'origin_evolution_candidate') recallRaw = semanticStrength * 0.45 + structuralStrength * 0.25;
  if (relationType === 'origin_evolution') recallRaw = semanticStrength * 0.45 + structuralStrength * 0.25;
  if (relationType === 'parallel_subclaim') recallRaw = semanticStrength * 0.45 + structuralStrength * 0.25;
  if (relationType === 'same_topic') recallRaw = semanticStrength * 0.45 + structuralStrength * 0.15;
  let recallStrength = clampScore(recallRaw);
  const sourceFreeLowTextSameTopic = relationType === 'same_topic' &&
    Number(metrics.text_similarity || 0) < 0.12 &&
    Number(metrics.source_span_overlap || 0) === 0 &&
    Number(metrics.source_trace_overlap || 0) === 0;
  if (sourceFreeLowTextSameTopic) recallStrength = Math.min(recallStrength, 40);
  if (relationType === 'same_topic') recallStrength = Math.min(recallStrength, 45);
  if (relationType === 'parallel_subclaim') recallStrength = Math.min(recallStrength, 65);
  if (relationType === 'parallel_subclaim' && semanticStrength < 30 && sourceOverlap === 0) recallStrength = Math.min(recallStrength, 35);
  if (relationType === 'same_branch_low_semantic_candidate') recallStrength = Math.min(recallStrength, 25);
  if (relationType === 'origin_evolution_candidate') recallStrength = Math.min(recallStrength, 55);
  if (relationType === 'origin_evolution' && semanticStrength < 25) recallStrength = Math.min(recallStrength, 70);
  if (relationType === 'repeated_reinforcement' && semanticStrength < 35) recallStrength = Math.min(recallStrength, 75);
  if (relationType === 'repeated_reinforcement' && semanticStrength < 25) recallStrength = Math.min(recallStrength, 60);
  if (relationType === 'repeated_reinforcement_candidate') recallStrength = Math.min(recallStrength, 55);
  if (relationType === 'repeated_reinforcement_candidate' && semanticStrength < 25 && sourceOverlap === 0) {
    recallStrength = Math.min(recallStrength, 35);
  }
  return {
    structural_strength: structuralStrength,
    semantic_strength: semanticStrength,
    recall_strength: recallStrength,
    strength_score: recallStrength,
    link_visibility: relationType === 'parallel_subclaim' && semanticStrength < 30 && sourceOverlap === 0
      ? 'weak_sibling_link'
      : asherieLinkVisibility(relationType),
    strength_notes: {
      same_topic_cap_applied: Boolean(sourceFreeLowTextSameTopic),
      shared_feeling_template_downweighted: Boolean(metrics.shared_feeling_template),
      source_overlap: Number(sourceOverlap.toFixed(4)),
      no_recall_boost_before_review: Boolean(
        (relationType === 'repeated_reinforcement_candidate' || relationType === 'same_branch_low_semantic_candidate') &&
        semanticStrength < 25 &&
        sourceOverlap === 0
      ),
      weak_sibling_link: Boolean(relationType === 'parallel_subclaim' && semanticStrength < 30 && sourceOverlap === 0)
    }
  };
}

function classifyAsherieRelation(leftPrepared = {}, rightPrepared = {}, metrics = {}) {
  const textSimilarity = Number(metrics.text_similarity || 0);
  const anchorSimilarity = Number(metrics.anchor_similarity || 0);
  const pathSimilarity = Number(metrics.path_similarity || 0);
  const handleOverlap = Number(metrics.handle_overlap || 0);
  const specificHandleOverlap = Number(metrics.specific_handle_overlap || 0);
  const lowText = textSimilarity < 0.12;
  const topicalBridge = asherieTopicalBridge(metrics);
  const leftRole = leftPrepared.anchor_role;
  const rightRole = rightPrepared.anchor_role;
  const bothReviewOnly = asherieReviewStatus(leftPrepared.node) === 'needs_review' && asherieReviewStatus(rightPrepared.node) === 'needs_review';
  const strongDuplicate = textSimilarity >= 0.5 &&
    anchorSimilarity >= 0.32 &&
    (pathSimilarity >= 0.38 || metrics.same_broad_path) &&
    handleOverlap >= 0.16;
  const likelyDuplicate = textSimilarity >= 0.42 &&
    anchorSimilarity >= 0.26 &&
    pathSimilarity >= 0.34 &&
    !asherieHasNewEmotionOrFact(leftPrepared, rightPrepared, metrics);
  const leftOriginSignal = leftRole === 'origin_anchor' || leftRole === 'origin_like';
  const rightEvolutionSignal = rightRole === 'evolution_anchor' || rightRole === 'evolution_like';
  const originEvolution = topicalBridge &&
    leftOriginSignal &&
    rightEvolutionSignal &&
    !strongDuplicate &&
    !bothReviewOnly &&
    (
      metrics.same_node_path ||
      Number(metrics.text_similarity || 0) >= 0.16 ||
      Number(metrics.anchor_similarity || 0) >= 0.14 ||
      Number(metrics.specific_handle_overlap || 0) >= 0.18
    );
  const repeatedReinforcement = topicalBridge &&
    !strongDuplicate &&
    !bothReviewOnly &&
    (metrics.primary_pair || !metrics.supporting_pair) &&
    (leftPrepared.motif_hit && rightPrepared.motif_hit || specificHandleOverlap >= 0.22 || anchorSimilarity >= 0.22 || textSimilarity >= 0.24) &&
    (
      (!metrics.generic_path_pair && metrics.same_node_path && textSimilarity >= 0.14 && (handleOverlap >= 0.42 || specificHandleOverlap >= 0.18)) ||
      (anchorSimilarity >= 0.28 && (textSimilarity >= 0.12 || specificHandleOverlap >= 0.18)) ||
      (textSimilarity >= 0.28 && (pathSimilarity >= 0.28 || specificHandleOverlap >= 0.18))
    );

  if (strongDuplicate || likelyDuplicate) return 'true_duplicate';
  if (originEvolution) return 'origin_evolution';
  if (repeatedReinforcement) return 'repeated_reinforcement';
  if (lowText && topicalBridge) return 'same_topic';
  if (topicalBridge && (textSimilarity >= 0.12 || handleOverlap >= 0.18 || pathSimilarity >= 0.34)) return 'parallel_subclaim';
  return 'weak_match';
}

function buildAsherieDecision(leftPrepared = {}, rightPrepared = {}, metrics = {}) {
  const relationType = classifyAsherieRelation(leftPrepared, rightPrepared, metrics);
  const preliminaryStrengths = asherieStrengthBreakdown(leftPrepared, rightPrepared, metrics, relationType);
  const effectiveRelationType = relationType === 'repeated_reinforcement'
    ? classifyReinforcementConfidence(preliminaryStrengths, metrics)
    : relationType === 'origin_evolution'
      ? classifyOriginEvolutionConfidence(leftPrepared, rightPrepared, preliminaryStrengths, metrics)
      : relationType;
  const strengths = effectiveRelationType === relationType
    ? preliminaryStrengths
    : asherieStrengthBreakdown(leftPrepared, rightPrepared, metrics, effectiveRelationType);
  const highDuplicate = relationType === 'true_duplicate' &&
    Number(metrics.text_similarity || 0) >= 0.58 &&
    Number(metrics.anchor_similarity || 0) >= 0.4 &&
    Number(metrics.path_similarity || 0) >= 0.45;

  if (relationType === 'true_duplicate') {
    const preservesOrigin = leftPrepared.anchor_role === 'origin_anchor' || leftPrepared.monthRole === 'origin';
    return {
      relation_type: effectiveRelationType,
      decision: preservesOrigin ? 'keep_origin_fold_later_only_as_evidence_after_review' : 'fold_under_canonical',
      reason: preservesOrigin
        ? '语义高度相近，但左侧承载 2 月起点价值；不删除 origin，只允许把后续同义表达折为补证据。'
        : '语义、锚点和树枝高度重合，且没有明显新增情绪/事实；可折到 canonical 节点下。',
      ...strengths,
      safe_to_auto_apply: highDuplicate && !preservesOrigin,
      needs_human_review: preservesOrigin || !highDuplicate
    };
  }

  if (relationType === 'origin_evolution') {
    const confirmed = effectiveRelationType === 'confirmed_origin_evolution';
    return {
      relation_type: effectiveRelationType,
      decision: confirmed
        ? 'confirmed_origin_evolution_keep_both'
        : 'candidate_origin_evolution_keep_both',
      reason: confirmed
        ? '2 月起点和 3 月演化之间有较明确的语义、source 或阶段连续；建立 confirmed timeline link，但仍不删除 origin。'
        : '2 月像起点、3 月像后续表达，但语义/source 还不够硬；只作 origin/evolution 候选，不影响时间线权重。',
      ...strengths,
      safe_to_auto_apply: false,
      needs_human_review: !confirmed
    };
  }

  if (relationType === 'repeated_reinforcement') {
    const confirmed = effectiveRelationType === 'confirmed_repeated_reinforcement';
    if (effectiveRelationType === 'same_branch_low_semantic_candidate') {
      return {
        relation_type: effectiveRelationType,
        decision: 'weak_same_branch_keep_both',
        reason: '同一关系枝或 handles 接近，但语义强度低且 source 不重叠；只能说明同枝相似，不能当反复强化。',
        ...strengths,
        safe_to_auto_apply: false,
        needs_human_review: true
      };
    }
    return {
      relation_type: effectiveRelationType,
      decision: confirmed
        ? 'confirmed_reinforcement_strengthen_canonical_keep_both'
        : 'candidate_reinforcement_keep_both',
      reason: confirmed
        ? '同一关系锚点跨月反复出现，且语义/source/anchor 支撑足够；可作为 canonical 升权依据。'
        : '同一关系根可能跨月反复出现，但语义或 source 支撑不足；只作为强化候选，复核前不升权。',
      ...strengths,
      safe_to_auto_apply: false,
      needs_human_review: !confirmed
    };
  }

  if (relationType === 'parallel_subclaim') {
    return {
      relation_type: effectiveRelationType,
      decision: 'link_parallel_subclaim_keep_both',
      reason: '同枝或同主题下的不同子命题；保留两边，召回时按 anchor_name / handles 区分。',
      ...strengths,
      safe_to_auto_apply: false,
      needs_human_review: false
    };
  }

  if (relationType === 'same_topic') {
    return {
      relation_type: effectiveRelationType,
      decision: 'link_same_topic_keep_separate',
      reason: '属于同一大主题但文本重合度低；只建弱 link，不合并、不降级。',
      ...strengths,
      safe_to_auto_apply: false,
      needs_human_review: true
    };
  }

  return {
    relation_type: 'weak_match',
    decision: 'keep_separate',
    reason: '跨月关系较弱，暂时不进入合并建议。',
    ...strengths,
    safe_to_auto_apply: false,
    needs_human_review: true
  };
}

function classifyReinforcementConfidence(strengths = {}, metrics = {}) {
  const sourceOverlap = asherieMetricSourceOverlap(metrics);
  if (asherieLowSemanticNoSource(strengths, metrics, 25)) return 'same_branch_low_semantic_candidate';
  const eventContinuity = Number(metrics.anchor_similarity || 0) >= 0.22 ||
    Number(metrics.living_similarity || 0) >= 0.18 ||
    Number(metrics.text_similarity || 0) >= 0.28;
  const confirmed = Number(strengths.semantic_strength || 0) >= 35 ||
    sourceOverlap > 0 ||
    (eventContinuity && Number(strengths.semantic_strength || 0) >= 25);
  return confirmed ? 'confirmed_repeated_reinforcement' : 'repeated_reinforcement_candidate';
}

function classifyOriginEvolutionConfidence(leftPrepared = {}, rightPrepared = {}, strengths = {}, metrics = {}) {
  const sourceOverlap = asherieMetricSourceOverlap(metrics);
  const explicitStageContinuity = (
    Number(metrics.anchor_similarity || 0) >= 0.28 &&
    Number(metrics.living_similarity || 0) >= 0.12
  ) || Number(metrics.text_similarity || 0) >= 0.32;
  const sourceBackedContinuity = sourceOverlap > 0 &&
    (
      Number(metrics.anchor_similarity || 0) >= 0.18 ||
      Number(metrics.living_similarity || 0) >= 0.1 ||
      Number(metrics.text_similarity || 0) >= 0.18
    );
  const confirmed = Number(strengths.semantic_strength || 0) >= 35 ||
    explicitStageContinuity ||
    sourceBackedContinuity ||
    leftPrepared.node?.human_review_confirmed === true ||
    rightPrepared.node?.human_review_confirmed === true;
  return confirmed ? 'confirmed_origin_evolution' : 'origin_evolution_candidate';
}

function shouldKeepAsheriePair(decision = {}, metrics = {}) {
  if (decision.relation_type === 'weak_match') return false;
  if (decision.relation_type === 'confirmed_origin_evolution') {
    return Number(decision.recall_strength || decision.strength_score || 0) >= 35 &&
      (
        Boolean(metrics.same_node_path) ||
        Number(metrics.text_similarity || 0) >= 0.08 ||
        Number(metrics.anchor_similarity || 0) >= 0.04
      );
  }
  if (decision.relation_type === 'origin_evolution_candidate') {
    return Number(decision.recall_strength || decision.strength_score || 0) >= 25 &&
      (
        Boolean(metrics.same_node_path) ||
        Number(metrics.text_similarity || 0) >= 0.08 ||
        Number(metrics.anchor_similarity || 0) >= 0.04
      );
  }
  if (decision.relation_type === 'confirmed_repeated_reinforcement') {
    return Number(decision.recall_strength || decision.strength_score || 0) >= 38 &&
      (
        Number(metrics.text_similarity || 0) >= 0.14 ||
        Number(metrics.specific_handle_overlap || 0) >= 0.25 ||
        Number(metrics.anchor_similarity || 0) >= 0.08
      );
  }
  if (decision.relation_type === 'repeated_reinforcement_candidate') {
    return Number(decision.recall_strength || decision.strength_score || 0) >= 24 &&
      (
        Number(metrics.text_similarity || 0) >= 0.12 ||
        Number(metrics.specific_handle_overlap || 0) >= 0.18 ||
        Number(metrics.anchor_similarity || 0) >= 0.08 ||
        Boolean(metrics.same_node_path)
      );
  }
  if (decision.relation_type === 'same_branch_low_semantic_candidate') {
    return Number(decision.recall_strength || decision.strength_score || 0) >= 12 &&
      (
        Boolean(metrics.same_node_path) ||
        Number(metrics.specific_handle_overlap || 0) >= 0.18 ||
        Number(metrics.path_similarity || 0) >= 0.5
      );
  }
  if (decision.relation_type === 'parallel_subclaim') {
    return Number(metrics.score || 0) >= 0.2 ||
      Number(metrics.text_similarity || 0) >= 0.16 ||
      Number(metrics.anchor_similarity || 0) >= 0.18;
  }
  if (decision.relation_type === 'same_topic') {
    return Number(metrics.score || 0) >= 0.18 ||
      Number(metrics.path_similarity || 0) >= 0.4 ||
      Number(metrics.anchor_similarity || 0) >= 0.26;
  }
  return true;
}

function limitAsherieLinksByRelation(rows = []) {
  const limits = {
    true_duplicate: 80,
    confirmed_repeated_reinforcement: 80,
    repeated_reinforcement_candidate: 80,
    same_branch_low_semantic_candidate: 80,
    repeated_reinforcement: 80,
    confirmed_origin_evolution: 120,
    origin_evolution_candidate: 120,
    origin_evolution: 120,
    parallel_subclaim: 120,
    same_topic: 80
  };
  const counts = {};
  const nodeRelationCounts = {};
  const links = [];
  const overflowLinks = [];
  let overflowTotalCount = 0;
  const overflowStoreLimit = 1000;
  for (const row of rows) {
    const type = safeText(row.relation_type, 'unknown');
    counts[type] = Number(counts[type] || 0);
    const leftKey = `${safeText(row.left?.node_id || row.left?.source_entry_id)}::${type}`;
    const rightKey = `${safeText(row.right?.node_id || row.right?.source_entry_id)}::${type}`;
    const globalOverflow = counts[type] >= Number(limits[type] || 40);
    const nodeOverflow = Number(nodeRelationCounts[leftKey] || 0) >= 3 || Number(nodeRelationCounts[rightKey] || 0) >= 3;
    if (globalOverflow || nodeOverflow) {
      overflowTotalCount += 1;
      if (overflowLinks.length < overflowStoreLimit) {
        overflowLinks.push({
          ...row,
          overflow_reason: globalOverflow
            ? 'relation_type_limit_exceeded'
            : 'node_relation_top3_limit_exceeded',
          default_recall_participation: false
        });
      }
      continue;
    }
    counts[type] += 1;
    nodeRelationCounts[leftKey] = Number(nodeRelationCounts[leftKey] || 0) + 1;
    nodeRelationCounts[rightKey] = Number(nodeRelationCounts[rightKey] || 0) + 1;
    links.push(row);
  }
  return { links, overflow_links: overflowLinks, overflow_total_count: overflowTotalCount };
}

function buildAsherieCrossMonthLinks(fromBundle = {}, toBundle = {}) {
  const leftNodes = safeArray(fromBundle.asherie_nodes, 999999)
    .map((node) => prepareAsherieNode(node, fromBundle.month, 'origin'));
  const rightNodes = safeArray(toBundle.asherie_nodes, 999999)
    .map((node) => prepareAsherieNode(node, toBundle.month, 'evolution'));
  const rows = [];
  for (const left of leftNodes) {
    for (const right of rightNodes) {
      const metrics = asheriePairMetrics(left, right);
      const decision = buildAsherieDecision(left, right, metrics);
      if (!shouldKeepAsheriePair(decision, metrics)) continue;
      const recallPolicyDelta = buildAsherieRecallPolicyDelta(left, right, decision, metrics);
      const noRecallBoostBeforeReview = !asherieIsConfirmedLinkType(decision.relation_type) ||
        Boolean(recallPolicyDelta.no_recall_boost_before_review);
      rows.push({
        link_id: `${left.node?.node_id || left.node?.source_entry_id}__${right.node?.node_id || right.node?.source_entry_id}`,
        relation_type: decision.relation_type,
        decision: decision.decision,
        reason: decision.reason,
        strength_score: decision.strength_score,
        structural_strength: decision.structural_strength,
        semantic_strength: decision.semantic_strength,
        recall_strength: decision.recall_strength,
        link_visibility: decision.link_visibility,
        strength_notes: decision.strength_notes,
        safe_to_auto_apply: decision.safe_to_auto_apply,
        needs_human_review: decision.needs_human_review,
        no_recall_boost_before_review: Boolean(noRecallBoostBeforeReview),
        default_recall_expansion: Boolean(recallPolicyDelta.default_recall_expansion === true),
        metrics,
        left: asherieNodeRef(left),
        right: asherieNodeRef(right),
        recall_policy_delta: recallPolicyDelta
      });
    }
  }
  const rank = {
    true_duplicate: 5,
    confirmed_repeated_reinforcement: 4.5,
    repeated_reinforcement: 4,
    repeated_reinforcement_candidate: 3.5,
    confirmed_origin_evolution: 3.25,
    origin_evolution: 3,
    origin_evolution_candidate: 3,
    parallel_subclaim: 2,
    same_branch_low_semantic_candidate: 1.5,
    same_topic: 1
  };
  const sorted = rows
    .sort((a, b) => {
      return (rank[b.relation_type] || 0) - (rank[a.relation_type] || 0) ||
        Number(b.strength_score || 0) - Number(a.strength_score || 0) ||
        Number(b.metrics?.score || 0) - Number(a.metrics?.score || 0);
    });
  return limitAsherieLinksByRelation(sorted);
}

function buildAsherieRecallPolicyDelta(left = {}, right = {}, decision = {}, metrics = {}) {
  const sourceOverlap = asherieMetricSourceOverlap(metrics);
  const noRecallBoostBeforeReview = Number(decision.semantic_strength || 0) < 25 && sourceOverlap === 0;
  if (decision.relation_type === 'confirmed_repeated_reinforcement') {
    const rightNode = right.node || {};
    return {
      canonical_node_weight_hint: Math.min(1.25, Number((1 + (Number(decision.recall_strength || decision.strength_score || 0) / 650)).toFixed(2))),
      supporting_evidence_rule: 'confirmed reinforcement only; near_duplicate_evidence remains supporting evidence while canonical branch confidence may rise.',
      branch_limit: rightNode.recall_policy?.branch_top_k_default ?? 3
    };
  }
  if (decision.relation_type === 'repeated_reinforcement_candidate') {
    const rightNode = right.node || {};
    return {
      canonical_node_weight_hint: 1,
      no_recall_boost_before_review: true,
      default_recall_expansion: false,
      supporting_evidence_rule: noRecallBoostBeforeReview
        ? 'reinforcement candidate only; semantic_strength is low and source overlap is zero, so do not raise recall weight before review.'
        : 'reinforcement candidate only; keep both nodes and require review before any canonical recall boost.',
      branch_limit: rightNode.recall_policy?.branch_top_k_default ?? 3
    };
  }
  if (decision.relation_type === 'same_branch_low_semantic_candidate') {
    return {
      canonical_node_weight_hint: 1,
      no_recall_boost_before_review: true,
      default_recall_expansion: false,
      supporting_evidence_rule: 'weak same-branch candidate only; structural proximity is not enough for recall boost or default expansion.',
      branch_limit: 1
    };
  }
  if (decision.relation_type === 'confirmed_origin_evolution') {
    return {
      canonical_node_weight_hint: 1,
      timeline_weight_hint: 1.08,
      default_recall_expansion: true,
      supporting_evidence_rule: 'confirmed timeline link; keep both month nodes and allow timeline-aware retrieval to prefer this bridge.',
      branch_limit: 2
    };
  }
  if (decision.relation_type === 'origin_evolution_candidate') {
    return {
      canonical_node_weight_hint: 1,
      timeline_weight_hint: 1,
      default_recall_expansion: false,
      supporting_evidence_rule: 'origin/evolution candidate only; do not raise timeline weight before review.',
      branch_limit: 1
    };
  }
  if (decision.relation_type === 'parallel_subclaim' && Number(decision.semantic_strength || 0) < 30 && sourceOverlap === 0) {
    return {
      canonical_node_weight_hint: 1,
      default_recall_expansion: false,
      supporting_evidence_rule: 'weak sibling link only; low semantic overlap and no source overlap, so exclude from default recall expansion.',
      branch_limit: 1
    };
  }
  if (decision.relation_type === 'true_duplicate') {
    return {
      canonical_node_weight_hint: 1,
      supporting_evidence_rule: 'fold_under_canonical; do not surface both sides unless source grounding is requested.',
      branch_limit: 1
    };
  }
  return {
    canonical_node_weight_hint: 1,
    no_recall_boost_before_review: true,
    default_recall_expansion: false,
    supporting_evidence_rule: decision.relation_type === 'same_topic'
      ? 'weak_link only; do not raise recall weight from structural similarity alone.'
      : 'link only; keep month provenance and choose by query anchor.',
    branch_limit: metrics.same_node_path ? 2 : 3
  };
}

function buildAsherieAnchorLists(bundle = {}, monthRole = '') {
  const prepared = safeArray(bundle.asherie_nodes, 999999)
    .map((node) => prepareAsherieNode(node, bundle.month, monthRole));
  return prepared
    .filter((item) => asherieIsPrimary(item.node))
    .map((item) => ({
      ...asherieNodeRef(item),
      recommendation: item.anchor_role === 'origin_anchor'
        ? 'keep_as_origin_anchor'
        : item.anchor_role === 'evolution_anchor'
          ? 'keep_as_evolution_anchor'
          : 'keep_as_cold_tree_anchor'
    }))
    .sort((a, b) => {
      return statusRank(b.review_status) - statusRank(a.review_status) ||
        b.source_span_count - a.source_span_count;
    });
}

function buildAsherieReport(fromBundle = {}, toBundle = {}) {
  const linkResult = buildAsherieCrossMonthLinks(fromBundle, toBundle);
  const links = safeArray(linkResult.links, 999999);
  const overflowLinks = safeArray(linkResult.overflow_links, 999999);
  const overflowTotalCount = Number(linkResult.overflow_total_count || overflowLinks.length);
  const relationDistribution = countBy(links, 'relation_type');
  const decisionDistribution = countBy(links, 'decision');
  const linkVisibilityDistribution = countBy(links, 'link_visibility');
  const confirmedReinforcementLinks = links.filter((item) => item.relation_type === 'confirmed_repeated_reinforcement');
  const candidateReinforcementLinks = links.filter((item) => item.relation_type === 'repeated_reinforcement_candidate');
  const sameBranchLowSemanticLinks = links.filter((item) => item.relation_type === 'same_branch_low_semantic_candidate');
  const confirmedOriginEvolutionLinks = links.filter((item) => item.relation_type === 'confirmed_origin_evolution');
  const candidateOriginEvolutionLinks = links.filter((item) => item.relation_type === 'origin_evolution_candidate');
  const legacyOriginEvolutionLinks = links.filter((item) => item.relation_type === 'origin_evolution');
  const legacyReinforcementLinks = links.filter((item) => item.relation_type === 'repeated_reinforcement');
  const allReinforcementLinks = [
    ...confirmedReinforcementLinks,
    ...candidateReinforcementLinks,
    ...legacyReinforcementLinks
  ];
  const allOriginEvolutionLinks = [
    ...confirmedOriginEvolutionLinks,
    ...candidateOriginEvolutionLinks,
    ...legacyOriginEvolutionLinks
  ];
  const originAnchors = buildAsherieAnchorLists(fromBundle, 'origin');
  const evolutionAnchors = buildAsherieAnchorLists(toBundle, 'evolution');
  return {
    schema: 'driftstone_cross_month_asherie_merge_report_v0.4',
    generated_at: new Date().toISOString(),
    months: {
      origin_month: fromBundle.month,
      evolution_month: toBundle.month
    },
    main_tracks: {
      memory_nodes: '23_asheriehome_memory_nodes.jsonl',
      source_trace_index: '24_source_trace_index.jsonl',
      notion_role: '同字段可视化投影，不是主库。',
      warm_memory_write: false,
      notion_write: false
    },
    principles: [
      '不再大幅改写单月 living_fragment / feeling_as_fact。',
      '2 月 origin 不因 3 月表达更成熟而被删除。',
      '低语义且无 source 重叠的同枝关系只进入 same_branch_low_semantic_candidate，不再叫 repeated reinforcement。',
      'origin/evolution 先进入 candidate，确认后才影响时间线权重。',
      '同一 node 每种 relation_type 默认最多保留 3 条，其他进入 overflow_links。',
      '语义近似且无新增情绪/事实时才 fold_under_canonical。',
      '只有 confirmed_repeated_reinforcement 可升权 canonical node；candidate 只作复核提示。'
    ],
    summary: {
      origin_node_count: safeArray(fromBundle.asherie_nodes, 999999).length,
      evolution_node_count: safeArray(toBundle.asherie_nodes, 999999).length,
      origin_primary_node_count: originAnchors.length,
      evolution_primary_node_count: evolutionAnchors.length,
      cross_month_link_count: links.length,
      overflow_link_count: overflowTotalCount,
      overflow_link_sample_count: overflowLinks.length,
      safe_to_auto_apply_count: links.filter((item) => item.safe_to_auto_apply).length,
      relation_type_distribution: relationDistribution,
      decision_distribution: decisionDistribution,
      link_visibility_distribution: linkVisibilityDistribution,
      repeated_reinforcement_count: allReinforcementLinks.length,
      confirmed_reinforcement_count: confirmedReinforcementLinks.length,
      candidate_reinforcement_count: candidateReinforcementLinks.length,
      same_branch_low_semantic_count: sameBranchLowSemanticLinks.length,
      origin_evolution_count: allOriginEvolutionLinks.length,
      confirmed_origin_evolution_count: confirmedOriginEvolutionLinks.length,
      candidate_origin_evolution_count: candidateOriginEvolutionLinks.length,
      true_duplicate_count: Number(relationDistribution.true_duplicate || 0),
      strength_model: 'structural_strength shows tree proximity; semantic_strength shows concrete memory overlap; recall_strength gates actual recall weight.'
    },
    true_duplicate_candidates: links.filter((item) => item.relation_type === 'true_duplicate'),
    same_topic_links: links.filter((item) => item.relation_type === 'same_topic'),
    confirmed_origin_evolution_links: confirmedOriginEvolutionLinks,
    origin_evolution_candidate_links: candidateOriginEvolutionLinks,
    origin_evolution_links: allOriginEvolutionLinks,
    parallel_subclaim_links: links.filter((item) => item.relation_type === 'parallel_subclaim'),
    confirmed_repeated_reinforcement_links: confirmedReinforcementLinks,
    repeated_reinforcement_candidate_links: candidateReinforcementLinks,
    same_branch_low_semantic_links: sameBranchLowSemanticLinks,
    repeated_reinforcement_links: allReinforcementLinks,
    fold_under_canonical_candidates: links.filter((item) => item.decision === 'fold_under_canonical' || item.decision === 'keep_origin_fold_later_only_as_evidence_after_review'),
    origin_anchors_to_keep: originAnchors.slice(0, 240),
    evolution_anchors_to_keep: evolutionAnchors.slice(0, 240),
    review_required: links.filter((item) => item.needs_human_review).slice(0, 240),
    overflow_links: overflowLinks,
    overflow_total_count: overflowTotalCount,
    all_cross_month_asherie_links: links
  };
}

function buildReport(fromBundle, toBundle) {
  const crossMonthCandidates = buildDuplicateCardCandidates(fromBundle, toBundle);
  const duplicateCardCandidates = crossMonthCandidates.filter((pair) => pair.relation_type === 'duplicate');
  const crossMonthMergeDecisions = buildCrossMonthMergeDecisions(crossMonthCandidates);
  const rootReports = buildRootReports(fromBundle, toBundle);
  const edgeReports = buildEdgeReports(fromBundle, toBundle);
  const cardsToReview = buildCardsToReview(fromBundle, toBundle, crossMonthCandidates);
  return {
    schema: 'driftstone_cross_month_merged_test_report_v0.2',
    generated_at: new Date().toISOString(),
    months: {
      origin_month: fromBundle.month,
      evolution_month: toBundle.month
    },
    principles: [
      '正式导入按时间顺序。',
      'merged_test 只用于去冗余与结构优化。',
      '不因为 3 月表达更成熟就删除 2 月初始化证据。',
      '2 月的“首次出现/初始化”类记忆保留为 origin anchor。',
      '3 月的“发展/强化/抽象总结”类记忆保留为 evolution anchor。'
    ],
    month_summaries: {
      [fromBundle.month]: fromBundle.manifest.counts,
      [toBundle.month]: toBundle.manifest.counts
    },
    duplicate_card_candidates: duplicateCardCandidates,
    same_topic_card_candidates: crossMonthCandidates.filter((pair) => pair.relation_type === 'same_topic'),
    cross_month_link_candidates: crossMonthCandidates.filter((pair) => pair.relation_type !== 'duplicate'),
    cross_month_merge_decisions: crossMonthMergeDecisions,
    mergeable_relation_roots: rootReports.mergeable_relation_roots,
    renamed_or_normalized_roots: rootReports.renamed_or_normalized_roots,
    cross_month_story_arcs: buildCrossMonthStoryArcs(fromBundle, toBundle),
    source_span_cross_month_risks: buildSourceSpanRisks(fromBundle, toBundle),
    stable_cards_to_keep: buildStableCardsToKeep(fromBundle, toBundle),
    cards_to_demote_to_sampling: buildDemotions(crossMonthCandidates),
    cards_to_review: cardsToReview,
    relation_edges_to_merge: edgeReports.relation_edges_to_merge,
    relation_edges_to_keep_separate: edgeReports.relation_edges_to_keep_separate
  };
}

function reportSummary(report = {}) {
  return {
    duplicate_card_candidates: safeArray(report.duplicate_card_candidates, 999999).length,
    same_topic_card_candidates: safeArray(report.same_topic_card_candidates, 999999).length,
    cross_month_link_candidates: safeArray(report.cross_month_link_candidates, 999999).length,
    cross_month_merge_decisions: safeArray(report.cross_month_merge_decisions, 999999).length,
    safe_to_auto_apply_decisions: safeArray(report.cross_month_merge_decisions, 999999).filter((item) => item.safe_to_auto_apply).length,
    relation_type_distribution: countBy(safeArray(report.cross_month_merge_decisions, 999999), 'relation_type'),
    decision_distribution: countBy(safeArray(report.cross_month_merge_decisions, 999999), 'decision'),
    mergeable_relation_roots: safeArray(report.mergeable_relation_roots, 999999).length,
    renamed_or_normalized_roots: safeArray(report.renamed_or_normalized_roots, 999999).length,
    cross_month_story_arcs: safeArray(report.cross_month_story_arcs, 999999).length,
    source_span_cross_month_risks: safeArray(report.source_span_cross_month_risks, 999999).length,
    stable_cards_to_keep: safeArray(report.stable_cards_to_keep, 999999).length,
    cards_to_demote_to_sampling: safeArray(report.cards_to_demote_to_sampling, 999999).length,
    cards_to_review: {
      review_queue_cards: safeArray(report.cards_to_review?.review_queue_cards, 999999).length,
      cross_month_overlap_reviews: safeArray(report.cards_to_review?.cross_month_overlap_reviews, 999999).length
    },
    relation_edges_to_merge: safeArray(report.relation_edges_to_merge, 999999).length,
    relation_edges_to_keep_separate: safeArray(report.relation_edges_to_keep_separate, 999999).length
  };
}

function asherieReportSummary(report = {}) {
  return {
    origin_node_count: Number(report.summary?.origin_node_count || 0),
    evolution_node_count: Number(report.summary?.evolution_node_count || 0),
    origin_primary_node_count: Number(report.summary?.origin_primary_node_count || 0),
    evolution_primary_node_count: Number(report.summary?.evolution_primary_node_count || 0),
    cross_month_link_count: Number(report.summary?.cross_month_link_count || 0),
    overflow_link_count: Number(report.summary?.overflow_link_count || 0),
    overflow_link_sample_count: Number(report.summary?.overflow_link_sample_count || safeArray(report.overflow_links, 999999).length),
    safe_to_auto_apply_count: Number(report.summary?.safe_to_auto_apply_count || 0),
    relation_type_distribution: report.summary?.relation_type_distribution || {},
    decision_distribution: report.summary?.decision_distribution || {},
    link_visibility_distribution: report.summary?.link_visibility_distribution || {},
    true_duplicate_candidates: safeArray(report.true_duplicate_candidates, 999999).length,
    same_topic_links: safeArray(report.same_topic_links, 999999).length,
    origin_evolution_links: safeArray(report.origin_evolution_links, 999999).length,
    confirmed_origin_evolution_links: safeArray(report.confirmed_origin_evolution_links, 999999).length,
    origin_evolution_candidate_links: safeArray(report.origin_evolution_candidate_links, 999999).length,
    parallel_subclaim_links: safeArray(report.parallel_subclaim_links, 999999).length,
    repeated_reinforcement_links: safeArray(report.repeated_reinforcement_links, 999999).length,
    confirmed_repeated_reinforcement_links: safeArray(report.confirmed_repeated_reinforcement_links, 999999).length,
    repeated_reinforcement_candidate_links: safeArray(report.repeated_reinforcement_candidate_links, 999999).length,
    same_branch_low_semantic_links: safeArray(report.same_branch_low_semantic_links, 999999).length,
    no_recall_boost_before_review_links: safeArray(report.all_cross_month_asherie_links, 999999)
      .filter((item) => item.no_recall_boost_before_review || item.recall_policy_delta?.no_recall_boost_before_review).length,
    overflow_links: safeArray(report.overflow_links, 999999).length,
    fold_under_canonical_candidates: safeArray(report.fold_under_canonical_candidates, 999999).length,
    review_required: safeArray(report.review_required, 999999).length
  };
}

function countBy(rows = [], key = '') {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const bucket = safeText(row?.[key], 'unknown');
    out[bucket] = Number(out[bucket] || 0) + 1;
  }
  return out;
}

function stringifyJsonl(rows = []) {
  return `${safeArray(rows, 999999).map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function buildMarkdownReport(report = {}) {
  const summary = reportSummary(report);
  const lines = [];
  lines.push('# Driftstone Cross-Month Merged Test Report');
  lines.push('');
  lines.push(`Origin month: ${report.months?.origin_month}`);
  lines.push(`Evolution month: ${report.months?.evolution_month}`);
  lines.push('');
  lines.push('## Principle');
  for (const item of safeArray(report.principles, 10)) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Counts');
  for (const [key, value] of Object.entries(summary)) {
    lines.push(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  lines.push('');
  lines.push('## Top Duplicate Candidates');
  const duplicatePairs = safeArray(report.duplicate_card_candidates, 10);
  if (!duplicatePairs.length) lines.push('- No high-confidence duplicate pairs in this report.');
  for (const pair of duplicatePairs) {
    lines.push(`- ${pair.score} / ${pair.relation_type} / ${pair.decision}: ${pair.left.title} (${pair.left.month}) ↔ ${pair.right.title} (${pair.right.month})`);
  }
  lines.push('');
  lines.push('## Merge Decision Safety');
  lines.push(`- safe_to_auto_apply: ${summary.safe_to_auto_apply_decisions}`);
  lines.push(`- relation_type_distribution: ${JSON.stringify(summary.relation_type_distribution)}`);
  lines.push(`- decision_distribution: ${JSON.stringify(summary.decision_distribution)}`);
  lines.push('');
  lines.push('## Same Topic, Not Duplicate');
  for (const pair of safeArray(report.same_topic_card_candidates, 10)) {
    lines.push(`- ${pair.left.title} (${pair.left.month}) ↔ ${pair.right.title} (${pair.right.month})：${pair.reason}`);
  }
  lines.push('');
  lines.push('## Origin / Evolution Links');
  const originEvolutionPairs = safeArray(report.cross_month_link_candidates, 10).filter((item) => item.relation_type === 'origin_evolution');
  if (!originEvolutionPairs.length) {
    lines.push('- No card-level origin/evolution links met the topical-bridge threshold; keep origin/evolution continuity at root/story-arc level for now.');
  }
  for (const pair of originEvolutionPairs) {
    lines.push(`- ${pair.left.title} (${pair.left.month}) ↔ ${pair.right.title} (${pair.right.month})：link only, keep both`);
  }
  lines.push('');
  lines.push('## Top Cross-Month Story Arcs');
  for (const arc of safeArray(report.cross_month_story_arcs, 10)) {
    lines.push(`- ${arc.left.root_path}：保留 ${arc.origin_anchor_month} origin + ${arc.evolution_anchor_month} evolution`);
  }
  lines.push('');
  lines.push('## Import Guidance');
  lines.push('- Do not import this report directly into Notion.');
  lines.push('- Use the single-month `19_notion_stable_import.jsonl` files in chronological order.');
  lines.push('- Use this report to decide which later cards should be sampling/review rather than replacing origin anchors.');
  lines.push('- Keep source spans as audit evidence; do not feed source trace text into warm memory.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildAsherieMarkdownReport(report = {}) {
  const summary = asherieReportSummary(report);
  const lines = [];
  lines.push('# Driftstone Cross-Month AsherieHome Merge Report');
  lines.push('');
  lines.push(`Origin month: ${report.months?.origin_month}`);
  lines.push(`Evolution month: ${report.months?.evolution_month}`);
  lines.push('');
  lines.push('## Main Tracks');
  lines.push('- `23_asheriehome_memory_nodes.jsonl` is the AsherieHome / MCP / gateway light cold tree main chain.');
  lines.push('- `24_source_trace_index.jsonl` is the source backtrace / audit main chain.');
  lines.push('- Notion is only a readable projection in this pass.');
  lines.push('- This report does not write Notion and does not write warm memory.');
  lines.push('');
  lines.push('## Principles');
  for (const item of safeArray(report.principles, 12)) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Counts');
  for (const [key, value] of Object.entries(summary)) {
    lines.push(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  lines.push('- strength_model: structural_strength = tree/path/handle proximity; semantic_strength = concrete memory overlap; recall_strength = final recall influence.');
  lines.push('');
  lines.push('## Confirmed Repeated Reinforcement');
  const confirmedReinforcement = safeArray(report.confirmed_repeated_reinforcement_links, 12);
  if (!confirmedReinforcement.length) lines.push('- No confirmed repeated reinforcement links met the threshold.');
  for (const link of confirmedReinforcement) {
    lines.push(`- recall ${link.recall_strength} / semantic ${link.semantic_strength} / structural ${link.structural_strength}: ${link.left.anchor_name || link.left.title} (${link.left.month}) ↔ ${link.right.anchor_name || link.right.title} (${link.right.month})`);
    lines.push(`  reason: ${link.reason}`);
  }
  lines.push('');
  lines.push('## Repeated Reinforcement Candidates');
  const reinforcementCandidates = safeArray(report.repeated_reinforcement_candidate_links, 12);
  if (!reinforcementCandidates.length) lines.push('- No repeated reinforcement candidates met the threshold.');
  for (const link of reinforcementCandidates) {
    const noBoost = link.no_recall_boost_before_review || link.recall_policy_delta?.no_recall_boost_before_review
      ? ' / no boost before review'
      : '';
    lines.push(`- recall ${link.recall_strength} / semantic ${link.semantic_strength} / structural ${link.structural_strength}${noBoost}: ${link.left.anchor_name || link.left.title} (${link.left.month}) ↔ ${link.right.anchor_name || link.right.title} (${link.right.month})`);
    lines.push(`  reason: ${link.reason}`);
  }
  lines.push('');
  lines.push('## Origin / Evolution');
  const originEvolution = safeArray(report.origin_evolution_links, 12);
  if (!originEvolution.length) lines.push('- No origin/evolution links met the threshold.');
  for (const link of originEvolution) {
    lines.push(`- recall ${link.recall_strength} / semantic ${link.semantic_strength} / structural ${link.structural_strength}: ${link.left.anchor_name || link.left.title} (${link.left.month}) ↔ ${link.right.anchor_name || link.right.title} (${link.right.month})`);
  }
  lines.push('');
  lines.push('## Fold Candidates');
  const folds = safeArray(report.fold_under_canonical_candidates, 12);
  if (!folds.length) lines.push('- No fold-under-canonical candidates met the threshold.');
  for (const link of folds) {
    lines.push(`- ${link.decision}: ${link.left.anchor_name || link.left.title} ↔ ${link.right.anchor_name || link.right.title}`);
  }
  lines.push('');
  lines.push('## Import Guidance');
  lines.push('- Keep 2 月 origin anchors; do not delete them because 3 月 is more mature.');
  lines.push('- Only confirmed_repeated_reinforcement may raise branch confidence; repeated_reinforcement_candidate is review-only and must not boost recall weight.');
  lines.push('- same_branch_low_semantic_candidate and overflow_links are review-only and excluded from default recall expansion.');
  lines.push('- Keep near-duplicate evidence as supporting evidence unless the query asks for grounding or expansion.');
  lines.push('- Apply nothing automatically except future true-duplicate cases that are explicitly marked safe.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function relationSourceOverlap(link = {}) {
  const metricOverlap = Math.max(
    Number(link.metrics?.source_span_overlap || 0),
    Number(link.metrics?.source_trace_overlap || 0)
  );
  const noteOverlap = Number(link.strength_notes?.source_overlap || 0);
  return Number(Math.max(metricOverlap, noteOverlap).toFixed(4));
}

function explainAsherieRelationForReview(link = {}) {
  const relationType = safeText(link.relation_type, 'unknown');
  const samePath = link.metrics?.same_node_path ? '同一 node_path' : '不同 node_path';
  const sameBroad = link.metrics?.same_broad_path ? '同一大枝' : '不同大枝';
  const sourceOverlap = relationSourceOverlap(link);
  if (relationType === 'repeated_reinforcement_candidate') {
    return `${samePath}，handles / 路径很近，但 semantic_strength=${link.semantic_strength}、source_overlap=${sourceOverlap}；因此只提示“可能反复强化”，复核前不升权。`;
  }
  if (relationType === 'same_branch_low_semantic_candidate') {
    return `${samePath}，结构接近但 semantic_strength=${link.semantic_strength}、source_overlap=${sourceOverlap}；只能说明同枝相似，不是反复强化。`;
  }
  if (relationType === 'confirmed_repeated_reinforcement') {
    return `${samePath}，且语义或 source / anchor 支撑足够；这是可考虑提高 canonical 权重的确认强化。`;
  }
  if (relationType === 'confirmed_origin_evolution') {
    return `${sameBroad}，左侧起点和右侧演化有较硬的语义/source/阶段连续；这是 confirmed timeline link。`;
  }
  if (relationType === 'origin_evolution_candidate' || relationType === 'origin_evolution') {
    return `${sameBroad}，左侧更像 2 月起点/初始化，右侧更像 3 月成熟表达；建立时间线 link，不覆盖 origin。`;
  }
  if (relationType === 'parallel_subclaim') {
    if (link.link_visibility === 'weak_sibling_link') {
      return `${sameBroad}，但 semantic_strength=${link.semantic_strength} 且 source_overlap=${sourceOverlap}；只作弱 sibling link，不进默认召回扩展。`;
    }
    return `${sameBroad}，主题相关但现场和情绪事实不完全重合；更像同一关系枝下的平行子命题。`;
  }
  if (relationType === 'same_topic') {
    return `${sameBroad}，但文本/source 重合较弱；只作弱 link，不进入升权或合并。`;
  }
  if (relationType === 'true_duplicate') {
    return '事实、意义和 source 高度重合；只有这种类型未来才可能进入合并候选。';
  }
  return '关系较弱或仍待核验；默认保留两边。';
}

function suggestedHumanDecision(link = {}) {
  const relationType = safeText(link.relation_type);
  const sourceOverlap = relationSourceOverlap(link);
  const semanticStrength = Number(link.semantic_strength || 0);
  const structuralStrength = Number(link.structural_strength || 0);
  if (relationType === 'repeated_reinforcement_candidate') {
    if (semanticStrength >= 35 || sourceOverlap > 0) return 'confirm';
    if (semanticStrength < 18 && sourceOverlap === 0) return 'needs_more_source';
    return 'downgrade';
  }
  if (relationType === 'same_branch_low_semantic_candidate') return 'downgrade';
  if (relationType === 'confirmed_origin_evolution') return 'confirm';
  if (relationType === 'origin_evolution_candidate' || relationType === 'origin_evolution') {
    if (semanticStrength >= 25 || sourceOverlap > 0) return 'confirm';
    return structuralStrength >= 80 ? 'needs_more_source' : 'split';
  }
  if (relationType === 'parallel_subclaim') {
    if (semanticStrength >= 28 || sourceOverlap > 0) return 'confirm';
    return 'split';
  }
  if (relationType === 'same_topic') return 'downgrade';
  if (relationType === 'true_duplicate') return sourceOverlap > 0 || semanticStrength >= 45 ? 'confirm' : 'needs_more_source';
  return 'needs_more_source';
}

function appendReviewSampleLink(lines = [], link = {}, index = 0) {
  const sourceOverlap = relationSourceOverlap(link);
  lines.push(`### ${index}. ${link.left?.title || link.left?.anchor_name || 'left'} ↔ ${link.right?.title || link.right?.anchor_name || 'right'}`);
  lines.push('');
  lines.push(`- left: ${link.left?.title || ''} / ${link.left?.month || ''}`);
  lines.push(`- right: ${link.right?.title || ''} / ${link.right?.month || ''}`);
  lines.push(`- relation_type: ${link.relation_type}`);
  lines.push(`- structural_strength: ${link.structural_strength}`);
  lines.push(`- semantic_strength: ${link.semantic_strength}`);
  lines.push(`- recall_strength: ${link.recall_strength}`);
  lines.push(`- source_overlap: ${sourceOverlap}`);
  lines.push(`- why_this_relation_type: ${explainAsherieRelationForReview(link)}`);
  lines.push(`- suggested_human_decision: ${suggestedHumanDecision(link)}`);
  if (link.no_recall_boost_before_review || link.recall_policy_delta?.no_recall_boost_before_review) {
    lines.push('- recall_policy_note: no_recall_boost_before_review');
  }
  if (link.overflow_reason) {
    lines.push(`- overflow_reason: ${link.overflow_reason}`);
    lines.push('- default_recall_participation: false');
  }
  lines.push('');
  lines.push('left living_fragment:');
  lines.push(`> ${clipText(link.left?.living_fragment, 360)}`);
  lines.push('');
  lines.push('right living_fragment:');
  lines.push(`> ${clipText(link.right?.living_fragment, 360)}`);
  lines.push('');
  lines.push('left feeling_as_fact:');
  lines.push(`> ${clipText(link.left?.feeling_as_fact, 320)}`);
  lines.push('');
  lines.push('right feeling_as_fact:');
  lines.push(`> ${clipText(link.right?.feeling_as_fact, 320)}`);
  lines.push('');
}

function buildCrossMonthReviewSampleMarkdown(report = {}) {
  const groups = [
    {
      title: 'Same Branch Low Semantic Candidates',
      note: '看它们是否只是同枝相似；这组默认不升权、不进默认召回扩展。',
      rows: safeArray(report.same_branch_low_semantic_links, 10)
    },
    {
      title: 'Repeated Reinforcement Candidates',
      note: '看它们是不是真的反复强化同一个核心锚点，还是还需要更多 source。',
      rows: safeArray(report.repeated_reinforcement_candidate_links, 10)
    },
    {
      title: 'Origin / Evolution Candidates',
      note: '看 2 月是否真是 origin，3 月是否真是 evolution，不要把平行子命题误判成演化。',
      rows: safeArray(report.origin_evolution_candidate_links, 10)
    },
    {
      title: 'Parallel Subclaims',
      note: '看它们是否确实是平行补充，而不是该合并或该拆开的不同线。',
      rows: safeArray(report.parallel_subclaim_links, 10)
    },
    {
      title: 'Overflow Link Samples',
      note: '这些是被 top-3 / 全局限流挡住的关系样本，只作审计，不参与默认召回。',
      rows: safeArray(report.overflow_links, 10)
    }
  ];
  const lines = [];
  lines.push('# Driftstone Cross-Month Review Sample');
  lines.push('');
  lines.push(`Origin month: ${report.months?.origin_month}`);
  lines.push(`Evolution month: ${report.months?.evolution_month}`);
  lines.push('');
  lines.push('This is a human / AI review view only. It does not write Notion, does not write warm memory, and does not change any cross-month link.');
  lines.push('');
  lines.push('## How To Read');
  lines.push('- `structural_strength` means tree/path/handle proximity.');
  lines.push('- `semantic_strength` means concrete memory overlap.');
  lines.push('- `recall_strength` is the recall influence after caps and safety rules.');
  lines.push('- `suggested_human_decision` is only a review hint: confirm / downgrade / split / needs_more_source.');
  lines.push('');
  let index = 1;
  for (const group of groups) {
    lines.push(`## ${group.title}`);
    lines.push('');
    lines.push(group.note);
    lines.push('');
    if (!group.rows.length) {
      lines.push('- No samples in this group.');
      lines.push('');
      continue;
    }
    for (const link of group.rows) {
      appendReviewSampleLink(lines, link, index);
      index += 1;
    }
  }
  return `${lines.join('\n')}\n`;
}

function buildCompactCrossMonthSummaryMarkdown(report = {}) {
  const summary = asherieReportSummary(report);
  const lines = [];
  lines.push('# Driftstone Compact Cross-Month Summary');
  lines.push('');
  lines.push(`Origin month: ${report.months?.origin_month}`);
  lines.push(`Evolution month: ${report.months?.evolution_month}`);
  lines.push('');
  lines.push('## Verdict');
  lines.push('- Cross-month graph is ready for trial review, not for automatic merge.');
  lines.push('- No link is safe to auto-apply in this pass.');
  lines.push('- Only confirmed links may affect recall weight; this pass has no confirmed reinforcement or confirmed origin/evolution links.');
  lines.push('- Weak links are kept as audit/context hints and do not participate in default recall expansion.');
  lines.push('');
  lines.push('## Counts');
  lines.push(`- default_cross_month_links: ${summary.cross_month_link_count}`);
  lines.push(`- overflow_links_total: ${summary.overflow_link_count}`);
  lines.push(`- overflow_links_sampled: ${summary.overflow_link_sample_count}`);
  lines.push(`- safe_to_auto_apply: ${summary.safe_to_auto_apply_count}`);
  lines.push(`- same_topic_links: ${summary.same_topic_links}`);
  lines.push(`- weak_same_branch_links: ${summary.same_branch_low_semantic_links}`);
  lines.push(`- origin_evolution_candidates: ${summary.origin_evolution_candidate_links}`);
  lines.push(`- confirmed_origin_evolution: ${summary.confirmed_origin_evolution_links}`);
  lines.push(`- parallel_subclaim_links: ${summary.parallel_subclaim_links}`);
  lines.push(`- confirmed_repeated_reinforcement: ${summary.confirmed_repeated_reinforcement_links}`);
  lines.push(`- repeated_reinforcement_candidates: ${summary.repeated_reinforcement_candidate_links}`);
  lines.push(`- no_recall_boost_before_review_links: ${summary.no_recall_boost_before_review_links}`);
  lines.push('');
  lines.push('## Recall Policy');
  lines.push('- `same_topic`, `same_branch_low_semantic_candidate`, and `weak_sibling_link` do not expand default recall.');
  lines.push('- `origin_evolution_candidate` keeps month provenance but does not raise timeline weight before review.');
  lines.push('- `overflow_links` are sample-only audit material; they are excluded from default recall and should not be loaded routinely.');
  lines.push('- Full overflow should only be generated in debug mode or when a reviewer asks for a specific node.');
  lines.push('');
  lines.push('## Review Focus');
  lines.push('- Check whether origin/evolution candidates are true timeline evolution or just parallel relationship themes.');
  lines.push('- Check whether weak same-branch samples are only same-branch noise caused by shared path / handles / feeling templates.');
  lines.push('- Watch repeated generic feeling phrases; they should not become link evidence by themselves.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromBundle = await loadMonthBundle(args.rootDir, args.fromMonth);
  const toBundle = await loadMonthBundle(args.rootDir, args.toMonth);
  const report = buildReport(fromBundle, toBundle);
  const outDir = args.outDir || join(args.rootDir, `ajimem_${args.fromMonth}_to_${args.toMonth}`);
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, 'merged_test_report.json');
  const mdPath = join(outDir, 'merged_test_report.md');
  const decisionsPath = join(outDir, 'cross_month_merge_decisions.jsonl');
  const asherieReport = safeArray(fromBundle.asherie_nodes, 1).length && safeArray(toBundle.asherie_nodes, 1).length
    ? buildAsherieReport(fromBundle, toBundle)
    : null;
  const asherieJsonPath = join(outDir, 'cross_month_asherie_merge_report.json');
  const asherieMdPath = join(outDir, 'cross_month_asherie_merge_report.md');
  const asherieLinksPath = join(outDir, 'cross_month_asherie_links.jsonl');
  const asherieOverflowLinksPath = join(outDir, 'cross_month_asherie_overflow_links.jsonl');
  const asherieReviewSamplePath = join(outDir, 'cross_month_review_sample.md');
  const compactAsherieSummaryPath = join(outDir, 'compact_cross_month_summary.md');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, buildMarkdownReport(report), 'utf8');
  await writeFile(decisionsPath, stringifyJsonl(report.cross_month_merge_decisions), 'utf8');
  if (asherieReport) {
    await writeFile(asherieJsonPath, `${JSON.stringify(asherieReport, null, 2)}\n`, 'utf8');
    await writeFile(asherieMdPath, buildAsherieMarkdownReport(asherieReport), 'utf8');
    await writeFile(asherieLinksPath, stringifyJsonl(asherieReport.all_cross_month_asherie_links), 'utf8');
    await writeFile(asherieOverflowLinksPath, stringifyJsonl(asherieReport.overflow_links), 'utf8');
    await writeFile(asherieReviewSamplePath, buildCrossMonthReviewSampleMarkdown(asherieReport), 'utf8');
    await writeFile(compactAsherieSummaryPath, buildCompactCrossMonthSummaryMarkdown(asherieReport), 'utf8');
  }
  console.log(JSON.stringify({
    ok: true,
    out_dir: outDir,
    files: [
      { name: 'merged_test_report.json', path: jsonPath },
      { name: 'merged_test_report.md', path: mdPath },
      { name: 'cross_month_merge_decisions.jsonl', path: decisionsPath },
      ...(asherieReport ? [
        { name: 'cross_month_asherie_merge_report.json', path: asherieJsonPath },
        { name: 'cross_month_asherie_merge_report.md', path: asherieMdPath },
        { name: 'cross_month_asherie_links.jsonl', path: asherieLinksPath },
        { name: 'cross_month_asherie_overflow_links.jsonl', path: asherieOverflowLinksPath },
        { name: 'cross_month_review_sample.md', path: asherieReviewSamplePath },
        { name: 'compact_cross_month_summary.md', path: compactAsherieSummaryPath }
      ] : [])
    ],
    summary: reportSummary(report),
    asherie_summary: asherieReport ? asherieReportSummary(asherieReport) : {
      skipped: true,
      reason: '23_asheriehome_memory_nodes.jsonl is missing in one or both month bundles.'
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: safeText(error?.message, String(error || 'unknown error'))
  }, null, 2));
  process.exitCode = 1;
});
