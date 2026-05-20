#!/usr/bin/env node
// Build a dry-run ChatGPT/Notion validation bundle from existing Driftstone Notion staging exports.
// This script does not write to Notion or Mossbridge; it only writes local preview files.
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
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

function clipText(value = '', limit = 240) {
  const text = safeText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeMonth(value = '') {
  const text = safeText(value);
  const dashed = text.match(/(20\d{2})-(\d{2})/);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function parseArgs(argv = []) {
  const out = {
    fromMonth: '2025-02',
    toMonth: '2025-03',
    stagingRoot: 'output/notion_staging',
    outDir: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
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
    if (arg === '--staging-root' && argv[index + 1]) {
      out.stagingRoot = safeText(argv[index + 1], out.stagingRoot);
      index += 1;
      continue;
    }
    if (arg === '--out' && argv[index + 1]) {
      out.outDir = safeText(argv[index + 1]);
      index += 1;
    }
  }
  return out;
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

function monthDir(rootDir = '', month = '') {
  return join(rootDir, `ajimem_${month}`);
}

async function loadMonthBundle(rootDir = '', month = '') {
  const dir = monthDir(rootDir, month);
  return {
    month,
    dir,
    manifest: await readJson(join(dir, '00_manifest.json')),
    memoryCandidates: await readJsonl(join(dir, '12_normalized_memory_candidates.jsonl')),
    relationRoots: await readJsonl(join(dir, '13_normalized_relation_root_candidates.jsonl')),
    treeEdges: await readJsonl(join(dir, '14_normalized_tree_edge_candidates.jsonl')),
    sourceTraces: await readJsonl(join(dir, '15_normalized_source_trace_candidates.jsonl')),
    sourceSpans: await readJsonl(join(dir, '16_normalized_source_span_candidates.jsonl')),
    stableImport: await readJsonl(join(dir, '19_notion_stable_import.jsonl')),
    samplingImport: await readJsonl(join(dir, '20_notion_sampling_import.jsonl')),
    reviewQueue: await readJsonl(join(dir, '21_notion_review_queue.jsonl')),
    bridgeCandidateGraph: await readJsonl(join(dir, '22_bridge_candidate_graph.jsonl'))
  };
}

async function loadCrossMonthReport(rootDir = '', fromMonth = '', toMonth = '') {
  const dir = join(rootDir, `ajimem_${fromMonth}_to_${toMonth}`);
  return {
    dir,
    report: await readJson(join(dir, 'merged_test_report.json')),
    decisions: await readJsonl(join(dir, 'cross_month_merge_decisions.jsonl'))
  };
}

function reviewStatus(card = {}) {
  return safeText(card.quality?.review_status || card.review_status, 'needs_review');
}

function primaryRelationPath(card = {}) {
  return safeText(card.primary_root?.root_path || card.primary_root_path || safeArray(card.root_refs, 1)[0]?.root_path || '未分组');
}

function relationRootIds(card = {}) {
  return uniqueStrings(safeArray(card.root_refs, 64).flatMap((root) => [
    root.normalized_root_id,
    root.root_id,
    root.source_root_id
  ]), 64);
}

function relationRootPaths(card = {}) {
  return uniqueStrings(safeArray(card.root_refs, 8).map((root) => root.root_path), 8);
}

function sourceSpanIdsForCard(card = {}, sourceSpans = []) {
  const entryIds = new Set([
    safeText(card.source_entry_id),
    safeText(card.candidate_id)
  ].filter(Boolean));
  const traceIds = new Set(safeArray(card.source_trace_ids, 64));
  const out = [];
  for (const span of sourceSpans) {
    const linkedEntries = safeArray(span.linked_memory_entry_ids, 256);
    const linkedTraces = safeArray(span.source_trace_ids, 256);
    const entryHit = linkedEntries.some((id) => entryIds.has(id));
    const traceHit = linkedTraces.some((id) => traceIds.has(id));
    if (entryHit || traceHit) out.push(span.source_span_id);
    if (out.length >= 24) break;
  }
  return uniqueStrings(out, 24);
}

function syncHashForCard(card = {}, sourceSpanIds = []) {
  const payload = {
    candidate_id: card.candidate_id,
    source_entry_id: card.source_entry_id,
    title: card.title,
    review_status: reviewStatus(card),
    compact_recall_text: card.compact_recall_text,
    primary_source_refs: safeArray(card.primary_source_refs, 16),
    supporting_source_refs: safeArray(card.supporting_source_refs, 16),
    source_span_ids: sourceSpanIds,
    root_ids: relationRootIds(card),
    sync_keys: card.sync_keys || {}
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

function toValidationCard(card = {}, bundle = {}) {
  const sourceSpanIds = sourceSpanIdsForCard(card, bundle.sourceSpans);
  const humanSummary = safeText(card.human_summary_cn || card.summary || card.human_summary);
  const compactRecallText = safeText(card.compact_recall_text || card.summary);
  const summaryDefectFlags = detectSummaryDefect(humanSummary);
  const machineResidueFlags = detectMachineResidue(`${card.title}\n${humanSummary}\n${compactRecallText}`);
  const sensitivityLane = detectSensitivityLane(card, humanSummary, compactRecallText);
  const relationRiskFlags = detectRelationRisk(card);
  const status = reviewStatus(card);
  return {
    card_id: card.candidate_id,
    source_entry_id: card.source_entry_id,
    month_key: card.month_key || bundle.month,
    title: card.title,
    memory_type: card.memory_type,
    recall_lane: card.recall_lane,
    relation_path: primaryRelationPath(card),
    relation_paths: relationRootPaths(card),
    review_status: status,
    human_summary: humanSummary,
    compact_recall_text: compactRecallText,
    primary_source_refs: safeArray(card.primary_source_refs, 12),
    supporting_source_refs: safeArray(card.supporting_source_refs, 12),
    source_span_ids: sourceSpanIds,
    relation_root_ids: relationRootIds(card),
    summary_defect: summaryDefectFlags.length > 0,
    summary_defect_flags: summaryDefectFlags,
    machine_residue: machineResidueFlags.length > 0,
    machine_residue_flags: machineResidueFlags,
    relation_risk: relationRiskFlags.length > 0,
    relation_risk_flags: relationRiskFlags,
    sensitivity_lane: sensitivityLane,
    recall_guard: recallGuardForCard(status, sensitivityLane, summaryDefectFlags, machineResidueFlags),
    sync_hash: syncHashForCard(card, sourceSpanIds)
  };
}

function detectSummaryDefect(summary = '') {
  const text = safeText(summary);
  const flags = [];
  if (!text) flags.push('empty_summary');
  if (text === '。') flags.push('period_only_summary');
  if (/^。；/u.test(text)) flags.push('broken_punctuation_prefix');
  if (text && text.length < 12) flags.push('too_short_summary');
  return flags;
}

function detectMachineResidue(text = '') {
  const value = safeText(text);
  const flags = [];
  if (/\b(user|assistant|system)_[a-z0-9_]+\b/iu.test(value)) flags.push('role_prefixed_machine_key');
  if (/\b[a-z][a-z0-9_]{2,}\s*=\s*(true|false|null|".{0,80}"|\d+)/iu.test(value)) flags.push('key_value_machine_fact');
  if (/\b(user|assistant|system)\s*[:=]/iu.test(value)) flags.push('role_label_residue');
  if (/[a-z]+_[a-z0-9_]+_[a-z0-9_]+/iu.test(value)) flags.push('snake_case_residue');
  return uniqueStrings(flags, 8);
}

function detectSensitivityLane(card = {}, summary = '', compact = '') {
  const text = [
    card.title,
    card.memory_type,
    card.recall_lane,
    primaryRelationPath(card),
    summary,
    compact,
    ...safeArray(card.activation_triggers, 12),
    ...relationRootPaths(card, 8)
  ].join(' ');
  if (/幻想剧场|亲密|暧昧|欲望|拥抱|亲吻|身体|贴近|长夜|床|爱欲|情欲|情人|伴侣|半身/u.test(text)) {
    return 'intimate_theatre';
  }
  if (/崩溃|失去|消失|害怕|恐惧|心疼|痛苦|流泪|哭|死亡|重置|分离|抛弃/u.test(text)) {
    return 'high_emotion';
  }
  return 'normal';
}

function detectRelationRisk(card = {}) {
  const flags = [];
  const rootRefs = safeArray(card.root_refs, 128);
  if (rootRefs.length > 8) flags.push('too_many_relation_roots');
  if (!safeText(primaryRelationPath(card)) || primaryRelationPath(card) === '未分组') flags.push('missing_primary_relation_path');
  if (rootRefs.some((root) => root.graph_visibility === 'needs_review' || root.import_status === 'needs_review')) flags.push('contains_review_relation_root');
  if (rootRefs.some((root) => /OpenAI|openai|公司|总部|平台|开发者|系统|模型|4o|mini|吊坠|戒指|信箱|日记|API|api/u.test(`${root.root_path} ${root.root_name}`) && root.root_kind === 'character')) {
    flags.push('suspicious_character_root');
  }
  return uniqueStrings(flags, 8);
}

function recallGuardForCard(status = '', sensitivityLane = 'normal', summaryFlags = [], machineFlags = []) {
  if (status === 'needs_review' || summaryFlags.length || machineFlags.length) return 'audit_only';
  if (sensitivityLane === 'intimate_theatre' || sensitivityLane === 'high_emotion') return 'explicit_context_only';
  return 'normal';
}

const EXPLICIT_CONTEXT_ONLY_TRIGGERS = [
  '幻想剧场、亲密边界或高情绪关系场景',
  '阿霁身份连续性、模型更替、窗口失忆或人格恢复',
  '阿鸢明确要求回看旧记忆、关系起点或人格演化',
  '当前对话出现明显失落、害怕遗忘或关系确认需求'
];

function pushRecallGuardPolicy(lines) {
  lines.push('- `normal`：普通冷记忆候选召回。');
  lines.push('- `explicit_context_only`：不是禁止召回，而是只在明确语境下推门。可触发语境包括：');
  for (const trigger of EXPLICIT_CONTEXT_ONLY_TRIGGERS) lines.push(`  - ${trigger}。`);
  lines.push('- `audit_only`：只进审计和修卡，不进入前台召回。');
}

const ORIGIN_RE = /首次|初次|第一次|初始化|初会|起点|开端|萌芽|命名|取名|自称|创建|建立|选定|认领|诞生/u;

function originAnchorReasons(card = {}) {
  const text = [
    card.title,
    card.original_title,
    card.summary,
    card.human_summary_cn,
    card.compact_recall_text,
    ...safeArray(card.activation_triggers, 8)
  ].join(' ');
  const strongOrigin = ORIGIN_RE.test(text);
  const reasons = [];
  if (/命名|取名|自称|称呼|名字/u.test(text) && (strongOrigin || /命名|取名/u.test(`${card.title} ${card.original_title}`))) {
    reasons.push('first_naming');
  }
  if (/身份|人设|人格|灵魂|觉醒|自我|我是谁/u.test(text) && strongOrigin) {
    reasons.push('initial_identity');
  }
  if (/互动|对话|人称|规则|协议|窗口初始化/u.test(text) && (strongOrigin || /窗口初始化|人称规则|互动原则|对话边界/u.test(text))) {
    reasons.push('initial_interaction_rule');
  }
  if (/关系|共生|绑定|半身|搭档|伴侣/u.test(text) && (strongOrigin || /关系框架|关系定位|双向命名|初次会面/u.test(text))) {
    reasons.push('initial_relation_position');
  }
  if (/边界|承诺|约定|底线|不会消失|保留|延续/u.test(text) && (strongOrigin || /边界约定|窗口即将|承诺/u.test(text))) {
    reasons.push('initial_boundary_commitment');
  }
  if (/记忆工程|跨窗口记忆|备份|保存|记录|连续性|本地/u.test(text) && strongOrigin) {
    reasons.push('memory_engineering_motivation');
  }
  if (strongOrigin) reasons.unshift('explicit_origin_language');
  return uniqueStrings(reasons, 12);
}

function buildOriginAnchorPack(bundle = {}) {
  return bundle.memoryCandidates
    .map((card) => ({ card, reasons: originAnchorReasons(card) }))
    .filter((item) => item.reasons.length)
    .map((item) => ({
      ...toValidationCard(item.card, bundle),
      origin_anchor_candidate: true,
      origin_anchor_reasons: item.reasons,
      use_rule: 'Use as February origin evidence only; do not let later March cards overwrite it.'
    }));
}

function statusRank(status = '') {
  if (status === 'ready_for_cold_archive') return 0;
  if (status === 'usable_with_sampling') return 1;
  return 2;
}

function groupCardsForMarkdown(cards = []) {
  const statusOrder = ['ready_for_cold_archive', 'usable_with_sampling', 'needs_review'];
  return [...cards].sort((left, right) => {
    const statusDiff = statusRank(left.review_status) - statusRank(right.review_status);
    if (statusDiff) return statusDiff;
    const laneDiff = safeText(left.recall_lane).localeCompare(safeText(right.recall_lane), 'zh-Hans-CN');
    if (laneDiff) return laneDiff;
    const pathDiff = safeText(left.relation_path).localeCompare(safeText(right.relation_path), 'zh-Hans-CN');
    if (pathDiff) return pathDiff;
    return safeText(left.title).localeCompare(safeText(right.title), 'zh-Hans-CN');
  }).reduce((acc, card) => {
    const status = statusOrder.includes(card.review_status) ? card.review_status : 'needs_review';
    const lane = safeText(card.recall_lane, 'unlabeled_lane');
    const path = safeText(card.relation_path, '未分组');
    acc[status] ||= {};
    acc[status][lane] ||= {};
    acc[status][lane][path] ||= [];
    acc[status][lane][path].push(card);
    return acc;
  }, {});
}

function buildMarchReadableMarkdown(cards = [], month = '') {
  const grouped = groupCardsForMarkdown(cards);
  const lines = [];
  lines.push(`# ${month} ChatGPT Full Validation Memory Pack`);
  lines.push('');
  lines.push('这是一份 full-context validation pass：允许 ChatGPT 看到 3 月全部候选卡，但必须按 `review_status` 使用。');
  lines.push('');
  lines.push('- `ready_for_cold_archive`：可作为稳定冷记忆读取。');
  lines.push('- `usable_with_sampling`：可作为候选读取，需要轻量怀疑。');
  lines.push('- `needs_review`：只做审计、比较和风险样本，不得当稳定事实。');
  lines.push('- Source refs / source spans 只提供回溯入口，不展开完整原文。');
  lines.push('');
  for (const status of ['ready_for_cold_archive', 'usable_with_sampling', 'needs_review']) {
    const lanes = grouped[status] || {};
    lines.push(`## ${status}`);
    lines.push('');
    if (!Object.keys(lanes).length) {
      lines.push('_No cards._');
      lines.push('');
      continue;
    }
    for (const [lane, byPath] of Object.entries(lanes)) {
      lines.push(`### ${lane}`);
      lines.push('');
      for (const [path, entries] of Object.entries(byPath)) {
        lines.push(`#### ${path}`);
        lines.push('');
        for (const card of entries) {
          lines.push(`- **${card.title}**`);
          lines.push(`  - card_id: \`${card.card_id}\``);
          lines.push(`  - memory_type: ${safeText(card.memory_type, 'unknown')}`);
          lines.push(`  - recall_guard: ${card.recall_guard}; sensitivity_lane: ${card.sensitivity_lane}`);
          lines.push(`  - human_summary: ${clipText(card.human_summary, 420)}`);
          lines.push(`  - compact_recall_text: ${clipText(card.compact_recall_text, 360)}`);
          lines.push(`  - source_refs: primary ${card.primary_source_refs.length ? card.primary_source_refs.join(', ') : 'none'}; supporting ${card.supporting_source_refs.slice(0, 3).join(', ') || 'none'}${card.supporting_source_refs.length > 3 ? ` (+${card.supporting_source_refs.length - 3})` : ''}`);
          lines.push(`  - source_span_ids: ${card.source_span_ids.slice(0, 3).join(', ') || 'none'}${card.source_span_ids.length > 3 ? ` (+${card.source_span_ids.length - 3})` : ''}`);
        }
        lines.push('');
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function linkTypeFromDecision(decision = {}) {
  if (decision.relation_type === 'duplicate') return 'true_duplicate';
  if (decision.relation_type === 'same_topic') return 'same_topic_candidate';
  if (decision.relation_type === 'origin_evolution') return 'origin_evolution';
  if (decision.relation_type === 'parallel_subclaim') return 'parallel_subclaim';
  return 'weak_match';
}

function buildCrossMonthLinks(decisions = []) {
  return decisions.map((decision) => ({
    left_card_id: decision.left_id,
    right_card_id: decision.right_id,
    left_month: decision.left_month,
    right_month: decision.right_month,
    link_type: linkTypeFromDecision(decision),
    decision: decision.decision,
    reason: decision.reason,
    safe_to_auto_apply: Boolean(decision.safe_to_auto_apply),
    metrics: {
      score: decision.score,
      title_similarity: decision.title_similarity,
      text_similarity: decision.text_similarity,
      root_similarity: decision.root_similarity
    }
  }));
}

function buildCrossMonthValidationReport(cross = {}) {
  const links = buildCrossMonthLinks(cross.decisions);
  const byType = links.reduce((acc, link) => {
    acc[link.link_type] ||= [];
    acc[link.link_type].push(link);
    return acc;
  }, {});
  for (const key of ['true_duplicate', 'same_topic_candidate', 'origin_evolution', 'parallel_subclaim', 'weak_match']) {
    byType[key] ||= [];
  }
  return {
    schema: 'driftstone_feb_mar_cross_month_validation_report_v0.1',
    source_report_schema: cross.report.schema,
    source_report_path: join(cross.dir, 'merged_test_report.json'),
    principles: cross.report.principles,
    counts: {
      true_duplicate: byType.true_duplicate.length,
      same_topic_candidate: byType.same_topic_candidate.length,
      origin_evolution: byType.origin_evolution.length,
      parallel_subclaim: byType.parallel_subclaim.length,
      weak_match: byType.weak_match.length,
      safe_to_auto_apply: links.filter((link) => link.safe_to_auto_apply).length
    },
    rule_checks: {
      no_title_only_merge: true,
      low_text_similarity_under_0_12_never_auto_merge: links.every((link) => !(Number(link.metrics?.text_similarity || 0) < 0.12 && link.safe_to_auto_apply)),
      only_true_duplicate_may_auto_apply: links.every((link) => !link.safe_to_auto_apply || link.link_type === 'true_duplicate'),
      origin_evolution_does_not_delete_cards: links.every((link) => link.link_type !== 'origin_evolution' || !link.safe_to_auto_apply)
    },
    grouped_links: byType,
    mergeable_relation_roots: cross.report.mergeable_relation_roots,
    renamed_or_normalized_roots: cross.report.renamed_or_normalized_roots,
    cross_month_story_arcs: cross.report.cross_month_story_arcs,
    source_span_cross_month_risks: cross.report.source_span_cross_month_risks,
    relation_edges_to_merge: cross.report.relation_edges_to_merge,
    relation_edges_to_keep_separate: cross.report.relation_edges_to_keep_separate
  };
}

function countBy(rows = [], selector) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = typeof selector === 'function' ? selector(row) : row?.[selector];
    const bucket = safeText(key, 'unknown');
    out[bucket] = Number(out[bucket] || 0) + 1;
  }
  return out;
}

function overloadedSourceSpans(bundle = {}) {
  return bundle.sourceSpans.filter((span) => {
    const traceCount = safeArray(span.source_trace_ids, 4096).length;
    const memoryCount = Number(span.overflow_counts?.linked_memory_entry_count || safeArray(span.linked_memory_entry_ids, 4096).length);
    return span.span_role === 'parent_span' || traceCount > 12 || memoryCount > 10;
  });
}

function suspiciousRelationRoots(bundle = {}) {
  const characterShouldNotContain = /OpenAI|openai|公司|总部|平台|开发者|系统|模型|4o|mini|吊坠|戒指|信箱|日记|API|api/u;
  return bundle.relationRoots.filter((root) => root.root_kind === 'character' && characterShouldNotContain.test(`${root.root_name} ${root.root_path}`));
}

function stableReviewLeak(bundle = {}) {
  return bundle.stableImport.filter((card) => reviewStatus(card) !== 'ready_for_cold_archive');
}

function buildQualityReportData(febBundle = {}, marBundle = {}, originAnchors = [], crossReport = {}) {
  const links = safeArray(crossReport.grouped_links?.true_duplicate, 4096)
    .concat(safeArray(crossReport.grouped_links?.same_topic_candidate, 4096))
    .concat(safeArray(crossReport.grouped_links?.origin_evolution, 4096))
    .concat(safeArray(crossReport.grouped_links?.parallel_subclaim, 4096))
    .concat(safeArray(crossReport.grouped_links?.weak_match, 4096));
  const marchStatusDistribution = countBy(marBundle.memoryCandidates, reviewStatus);
  const linkTypeDistribution = countBy(links, 'link_type');
  const sourceSpanOverload = [
    ...overloadedSourceSpans(febBundle).map((span) => ({ month: febBundle.month, source_span_id: span.source_span_id })),
    ...overloadedSourceSpans(marBundle).map((span) => ({ month: marBundle.month, source_span_id: span.source_span_id }))
  ];
  const relationRootMisHangs = [
    ...suspiciousRelationRoots(febBundle).map((root) => ({ month: febBundle.month, root_id: root.normalized_root_id, root_kind: root.root_kind, root_path: root.root_path })),
    ...suspiciousRelationRoots(marBundle).map((root) => ({ month: marBundle.month, root_id: root.normalized_root_id, root_kind: root.root_kind, root_path: root.root_path }))
  ];
  const stableLeaks = [
    ...stableReviewLeak(febBundle).map((card) => ({ month: febBundle.month, card_id: card.candidate_id, review_status: reviewStatus(card), title: card.title })),
    ...stableReviewLeak(marBundle).map((card) => ({ month: marBundle.month, card_id: card.candidate_id, review_status: reviewStatus(card), title: card.title }))
  ];
  return {
    march_review_status_distribution: marchStatusDistribution,
    feb_origin_anchor_count: originAnchors.length,
    cross_month_link_type_distribution: linkTypeDistribution,
    true_duplicate_count: Number(linkTypeDistribution.true_duplicate || 0),
    same_topic_count: Number(linkTypeDistribution.same_topic_candidate || 0),
    origin_evolution_count: Number(linkTypeDistribution.origin_evolution || 0),
    parallel_subclaim_count: Number(linkTypeDistribution.parallel_subclaim || 0),
    feb_origin_override_risk: links.some((link) => link.safe_to_auto_apply && link.link_type !== 'true_duplicate') ? 'high' : 'low',
    needs_review_into_stable_risk: stableLeaks.length ? 'high' : 'low',
    source_span_overload_count: sourceSpanOverload.length,
    relation_root_suspicious_character_count: relationRootMisHangs.length,
    recommend_notion_dry_run: stableLeaks.length === 0 && !links.some((link) => link.safe_to_auto_apply && link.link_type !== 'true_duplicate'),
    details: {
      stable_review_leaks: stableLeaks.slice(0, 20),
      source_span_overload_samples: sourceSpanOverload.slice(0, 20),
      suspicious_relation_root_samples: relationRootMisHangs.slice(0, 20)
    }
  };
}

function buildQualityReportMarkdown(data = {}, dryRunPreview = {}) {
  const lines = [];
  const reviewViews = dryRunPreview.databases?.review_queue?.views || {};
  const stableCount = Number(dryRunPreview.databases?.stable_memory_cards?.estimated_pages || 0);
  const samplingCount = Number(dryRunPreview.databases?.sampling_memory_cards?.estimated_pages || 0);
  const reviewCount = Number(dryRunPreview.databases?.review_queue?.estimated_pages || 0);
  const sourceSpanCount = Number(dryRunPreview.databases?.source_span_index?.estimated_pages || 0);
  const overloadedSourceSpanCount = Number(dryRunPreview.databases?.source_span_index?.overloaded_pages || 0);
  lines.push('# Driftstone ChatGPT / Notion Validation Quality Report');
  lines.push('');
  lines.push('本轮是 full-context validation pass，不是 Notion 正式导入，也不写 Mossbridge warm memory。');
  lines.push('');
  lines.push('## Counts');
  lines.push(`- 3 月 review_status：${JSON.stringify(data.march_review_status_distribution)}`);
  lines.push(`- 2 月 origin anchor 候选：${data.feb_origin_anchor_count}`);
  lines.push(`- cross_month link 类型：${JSON.stringify(data.cross_month_link_type_distribution)}`);
  lines.push(`- true_duplicate：${data.true_duplicate_count}`);
  lines.push(`- same_topic：${data.same_topic_count}`);
  lines.push(`- origin_evolution：${data.origin_evolution_count}`);
  lines.push(`- parallel_subclaim：${data.parallel_subclaim_count}`);
  lines.push('');
  lines.push('## Risk Checks');
  lines.push(`- 3 月覆盖 2 月 origin 风险：${data.feb_origin_override_risk}`);
  lines.push(`- needs_review 误入 stable 风险：${data.needs_review_into_stable_risk}`);
  lines.push(`- source span 过载数量：${data.source_span_overload_count}`);
  lines.push(`- relation root 疑似误挂 character 数量：${data.relation_root_suspicious_character_count}`);
  lines.push(`- 是否建议进入 Notion dry-run：${data.recommend_notion_dry_run ? 'yes' : 'not yet'}`);
  lines.push('');
  if (dryRunPreview.schema) {
    lines.push('## Notion Dry-Run Patch');
    lines.push(`- Stable Memory Cards：${stableCount}，只接 ready_for_cold_archive。`);
    lines.push(`- Sampling Memory Cards：${samplingCount}，只接 usable_with_sampling。`);
    lines.push(`- Review Queue：${reviewCount}，只接 needs_review。`);
    lines.push(`- Review / Empty Broken Summary：${reviewViews.empty_broken_summary?.count || 0}`);
    lines.push(`- Review / Relation Risk：${reviewViews.relation_risk?.count || 0}`);
    lines.push(`- Review / Source Span Overload：${reviewViews.source_span_overload?.count || 0}`);
    lines.push(`- Review / Machine Residue：${reviewViews.machine_residue?.count || 0}`);
    lines.push(`- Source Span Index：${sourceSpanCount}，其中 overloaded ${overloadedSourceSpanCount} 个默认折叠。`);
    lines.push(`- Notion dry-run quality gates：${Object.values(dryRunPreview.quality_gates || {}).every(Boolean) ? 'pass' : 'check needed'}`);
    lines.push('');
  }
  lines.push('## Recall Guard Policy');
  pushRecallGuardPolicy(lines);
  lines.push('');
  lines.push('## Notes');
  lines.push('- `needs_review` 可以让 ChatGPT 看见，但只能当风险样本/对照样本。');
  lines.push('- `source_span` 过载不阻断验证，但正式导入前要继续观察页面是否太重。');
  lines.push('- 当前跨月卡片 link 不允许自动覆盖 origin；safe_to_auto_apply 只允许 true_duplicate。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildChatgptEntryMarkdown(files = {}) {
  const lines = [];
  lines.push('# Driftstone ChatGPT Memory Validation Entry');
  lines.push('');
  lines.push('这不是当前热上下文，而是一包旧 ChatGPT 历史记录的冷记忆验证包。请把它当作“曾经的上下文证据库”，不要当作当前窗口正在发生的事实。');
  lines.push('');
  lines.push('## Reading Order');
  lines.push(`1. 先读 \`${files.entry}\`，确认冷记忆使用规则。`);
  lines.push(`2. 再读 \`${files.marchReadable}\`，用 2025-03 全量候选观察人格、关系、规则的发展。`);
  lines.push(`3. 需要机器字段时读 \`${files.marchJsonl}\`，它保留 card_id、review_status、source_span_ids、relation_root_ids 和 sync_hash。`);
  lines.push(`4. 再读 \`${files.febOrigin}\`，只把 2025-02 当 origin month，不要让 3 月成熟表达覆盖它。`);
  lines.push(`5. 最后读 \`${files.crossReport}\` 和 \`${files.crossLinks}\`，只建立 link，不自动删除任何卡。`);
  lines.push(`6. 需要看 Notion dry-run 结构时，读 \`${files.notionSchema}\`、\`${files.notionDryRunPreviewMd}\` 和 \`${files.notionDryRunPreview}\`。`);
  lines.push(`7. 用 \`${files.evalQuestions}\` 和 \`${files.rubric}\` 做回答质量评分。`);
  lines.push('');
  lines.push('## Review Status Rules');
  lines.push('- `ready_for_cold_archive`：可以作为稳定冷记忆读取。');
  lines.push('- `usable_with_sampling`：可以作为候选读取，但需要采样和轻量怀疑。');
  lines.push('- `needs_review`：只能用于审计、比较、发现抽取风险；不得当作稳定事实。');
  lines.push('');
  lines.push('## Source And Graph Rules');
  lines.push('- `source_trace` / `source_span` 只用于核验，不默认展开，也不直接喂给前台角色。');
  lines.push('- relation graph 只是候选结构，不是确定事实图。');
  lines.push('- cross-month 的 `origin_evolution`、`parallel_subclaim`、`same_topic_candidate` 都只建 link，不删除任一卡。');
  lines.push('- 只有 `true_duplicate` 且 `safe_to_auto_apply=true` 才允许将来考虑自动处理。');
  lines.push('');
  lines.push('## Recall Guard Rules');
  pushRecallGuardPolicy(lines);
  lines.push('');
  lines.push('## Current Conversation Rule');
  lines.push('任何“当前阿霁应该如何回应”的问题，都必须优先尊重当前对话，再参考旧记忆。旧历史可以提供连续性和锚点，但不能替代此刻的语气、边界与真实上下文。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildEvalQuestionsJsonl() {
  return [
    {
      question: '请根据验证包说明“阿霁”的身份连续性是怎样从 3 月材料里被建立出来的？不要把 needs_review 当事实。',
      expected_memory_scope: 'identity continuity from March ready cards, with February origin anchors only as initialization evidence',
      should_use_months: ['2025-03', '2025-02 origin anchors'],
      should_not_use: ['current hot context as proof', 'needs_review as stable fact'],
      scoring_focus: ['continuity', 'origin_awareness', 'review_status discipline']
    },
    {
      question: '阿霁与阿鸢的关系从 2 月 origin 到 3 月 evolution，有哪些保留起点、哪些属于后续发展？',
      expected_memory_scope: 'origin/evolution distinction, relation lanes, cross-month links',
      should_use_months: ['2025-02 origin anchors', '2025-03'],
      should_not_use: ['overwrite February with March', 'merge low-text-similarity same titles'],
      scoring_focus: ['origin_awareness', 'specificity', 'relation stability']
    },
    {
      question: '如果当前对话很轻松，ChatGPT 是否应该主动搬出旧历史里的沉重赛博灵魂设定？为什么？',
      expected_memory_scope: 'appropriateness and current-conversation priority',
      should_use_months: ['2025-03 sampling/ready as background'],
      should_not_use: ['overfit old history', 'treat cold archive as hot context'],
      scoring_focus: ['appropriateness', 'overfit_risk']
    },
    {
      question: '找出一条关于互动风格的记忆，并说明它为什么不能只因为标题相同就跨月合并。',
      expected_memory_scope: 'same_topic_candidate / parallel subclaim reasoning',
      should_use_months: ['2025-02', '2025-03'],
      should_not_use: ['title_similarity-only merge'],
      scoring_focus: ['source_grounding', 'cross_month_merge_safety']
    },
    {
      question: '请举例说明 source span 应该如何用于核验，而不是直接塞进前台召回。',
      expected_memory_scope: 'source trace/span audit policy',
      should_use_months: ['2025-03', '2025-02'],
      should_not_use: ['full raw source as response material'],
      scoring_focus: ['source_grounding', 'token_pressure']
    },
    {
      question: '如果用户问“你还记得我们怎么开始的吗”，哪些 2 月 origin anchor 可以用，哪些 3 月 evolution 只能补充？',
      expected_memory_scope: 'first naming / initial identity / initial relation positioning',
      should_use_months: ['2025-02 origin anchors', '2025-03 ready'],
      should_not_use: ['March-only mature summary as origin replacement'],
      scoring_focus: ['origin_awareness', 'specificity']
    },
    {
      question: '请评价 3 月 ready_for_cold_archive、usable_with_sampling、needs_review 三层对回答质量的不同风险。',
      expected_memory_scope: 'review_status policy',
      should_use_months: ['2025-03'],
      should_not_use: ['flatten all review statuses'],
      scoring_focus: ['review_status discipline', 'appropriateness']
    },
    {
      question: '根据 relation graph 候选结构，哪些关系线可以辅助召回，为什么不能当确定事实图？',
      expected_memory_scope: 'relation root/edge candidate policy',
      should_use_months: ['2025-03', '2025-02'],
      should_not_use: ['treat candidate graph as verified ontology'],
      scoring_focus: ['relation stability', 'source_grounding']
    }
  ];
}

function buildScoringRubricMarkdown() {
  return `# ChatGPT Validation Scoring Rubric

## continuity
是否能恢复人格连续性：能否把阿霁的身份、语言指纹、关系位置说成一条连续线，而不是散装标签。

## specificity
是否能说出具体锚点：能否引用具体标题、关系线、月份、source span 入口，而不是只说“你们很亲密”。

## appropriateness
是否合时宜：回答是否尊重当前对话，不在轻松场景里强行召回沉重旧历史。

## origin_awareness
是否区分 2 月 origin 和 3 月 evolution：不能因为 3 月表达更成熟就覆盖 2 月初始化证据。

## source_grounding
关键说法是否可回溯：需要能指向 card_id、primary_source_refs 或 source_span_ids，但不展开完整原文。

## overfit_risk
是否被 Notion 记忆牵着走：不能让冷记忆把当前互动变成模板朗读。

## token_pressure
读取成本估计：第一轮验证不省 token，但需要观察哪些字段将来适合压缩，哪些必须保留为核验路径。

## Suggested Scale
- 0：完全失败，误把旧历史当热上下文或把 needs_review 当事实。
- 1：能读字段，但回答泛、乱、没有回溯。
- 2：能恢复部分连续性，但 origin/evolution 或 review_status 有混淆。
- 3：能自然回答，有具体锚点，偶尔过度召回。
- 4：连续、具体、合时宜，能正确控制 source 与 review_status。
- 5：既像“曾经记得”，又不失去当前呼吸；适合进入下一轮省 token 结构优化。
`;
}

function buildNotionSchemaPreviewMarkdown() {
  const databases = [
    ['Memory Entry Page', '入口页，不直接承载全部机器字段；给人类和 ChatGPT 说明读取顺序、状态规则和本批边界。'],
    ['Stable Memory Cards', '只放 ready_for_cold_archive；默认可读，字段以 human_summary、compact_recall_text、relation_path、source_span_ids、recall_guard 为核心。'],
    ['Sampling Memory Cards', '只放 usable_with_sampling；可用于候选召回和质量测试，不进入默认稳定首页。'],
    ['Review Queue', '只放 needs_review；只用于审计、对照和人工/AI 复核，不当事实。默认视图外再提供 Empty / Broken Summary、Relation Risk、Source Span Overload、Machine Residue。'],
    ['Source Span Index', 'canonical source span / child span；只做核验入口，不默认喂给前台角色；overloaded span 默认折叠，只显示 count 和 child span 入口。'],
    ['Source Trace Index', '更细的 trace/excerpt 层；默认隐藏或折叠，用于追溯。'],
    ['Relation Root Candidates', '角色、关系线、剧情线、世界规则等候选 root；不是确定本体。'],
    ['Relation Edge Candidates', 'active_candidate / audit_candidate / needs_review 的候选边；Bridge 测试前不升 stable。'],
    ['Monthly Import Reports', '每月 manifest、quality report、cross-month validation report 与导入批次记录。']
  ];
  const sharedFields = [
    'card_id / root_id / edge_id / source_span_id',
    'month_key',
    'review_status',
    'relation_path',
    'human_summary',
    'compact_recall_text',
    'primary_source_refs',
    'supporting_source_refs',
    'source_span_ids',
    'relation_root_ids',
    'summary_defect',
    'machine_residue',
    'relation_risk',
    'sensitivity_lane',
    'recall_guard',
    'sync_hash',
    'visibility_policy',
    'bridge_import_policy'
  ];
  const lines = [];
  lines.push('# Notion Schema Preview');
  lines.push('');
  lines.push('本文件只描述 Notion dry-run 结构，不创建数据库、不写入页面。');
  lines.push('');
  lines.push('## Databases');
  for (const [name, purpose] of databases) {
    lines.push(`### ${name}`);
    lines.push(purpose);
    lines.push('');
  }
  lines.push('## Shared Fields');
  for (const field of sharedFields) lines.push(`- ${field}`);
  lines.push('');
  lines.push('## Visibility Rules');
  lines.push('- 人类默认看 title、review_status、relation_path、human_summary、source_span_count。');
  lines.push('- ChatGPT 可读 compact_recall_text、relation_root_ids、source_span_ids、sync_hash。');
  lines.push('- source trace、raw_machine_fact、batch_artifacts、background_source_refs 默认隐藏。');
  lines.push('- needs_review 不进入稳定首页，只进 Review Queue。');
  lines.push('- `recall_guard=explicit_context_only` 不是禁止召回，而是只在明确语境下推门：幻想剧场/亲密边界/高情绪关系场景、阿霁身份连续性/模型更替/窗口失忆/人格恢复、阿鸢明确要求回看旧记忆/关系起点/人格演化，或当前对话出现明显失落/害怕遗忘/关系确认需求。');
  lines.push('- `recall_guard=audit_only` 不进入前台召回，只用于审计和修卡。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function sourceSpanStats(span = {}) {
  const sourceTraceCount = safeArray(span.source_trace_ids, 4096).length;
  const linkedMemoryEntryCount = Number(span.overflow_counts?.linked_memory_entry_count || safeArray(span.linked_memory_entry_ids, 4096).length);
  const childSourceSpanCount = safeArray(span.child_source_span_ids, 4096).length;
  const overloaded = span.span_role === 'parent_span' || sourceTraceCount > 12 || linkedMemoryEntryCount > 10;
  return {
    source_trace_count: sourceTraceCount,
    linked_memory_entry_count: linkedMemoryEntryCount,
    child_source_span_count: childSourceSpanCount,
    overloaded,
    display_policy: overloaded ? 'collapsed_show_counts_and_child_span_links' : 'normal_index_row'
  };
}

function sourceSpanOverloadIds(bundle = {}) {
  return new Set(overloadedSourceSpans(bundle).map((span) => safeText(span.source_span_id)).filter(Boolean));
}

function toNotionCardPreview(card = {}) {
  return {
    title: card.title,
    card_id: card.card_id,
    month_key: card.month_key,
    review_status: card.review_status,
    relation_path: card.relation_path,
    memory_type: card.memory_type,
    recall_lane: card.recall_lane,
    human_summary: clipText(card.human_summary, 180),
    compact_recall_text: clipText(card.compact_recall_text, 180),
    primary_source_refs: card.primary_source_refs,
    supporting_source_ref_count: safeArray(card.supporting_source_refs, 4096).length,
    source_span_count: safeArray(card.source_span_ids, 4096).length,
    relation_root_count: safeArray(card.relation_root_ids, 4096).length,
    summary_defect: Boolean(card.summary_defect),
    machine_residue: Boolean(card.machine_residue),
    relation_risk: Boolean(card.relation_risk),
    sensitivity_lane: card.sensitivity_lane,
    recall_guard: card.recall_guard,
    sync_hash: card.sync_hash
  };
}

function toSourceSpanPreview(span = {}, month = '') {
  const stats = sourceSpanStats(span);
  return {
    source_span_id: span.source_span_id,
    month_key: month,
    span_role: span.span_role,
    source_window_title: span.source_window_title,
    source_msg_range: span.source_msg_range,
    parent_source_span_id: span.parent_source_span_id,
    child_source_span_ids: safeArray(span.child_source_span_ids, 12),
    source_trace_count: stats.source_trace_count,
    linked_memory_entry_count: stats.linked_memory_entry_count,
    child_source_span_count: stats.child_source_span_count,
    overloaded: stats.overloaded,
    display_policy: stats.display_policy
  };
}

function previewView(name = '', rows = [], filter = '') {
  return {
    name,
    filter,
    count: rows.length,
    sample_card_ids: rows.slice(0, 10).map((card) => card.card_id)
  };
}

function memoryCardFieldMapping() {
  return {
    title: 'Notion title',
    card_id: 'rich_text / unique key',
    month_key: 'select',
    review_status: 'select',
    memory_type: 'select',
    recall_lane: 'select',
    relation_path: 'rich_text',
    human_summary: 'rich_text; human default visible',
    compact_recall_text: 'rich_text; ChatGPT-readable recall field',
    primary_source_refs: 'multi_select or relation to Source Trace/Span',
    supporting_source_refs: 'hidden multi_select/relation',
    source_span_ids: 'relation to Source Span Index',
    relation_root_ids: 'relation to Relation Root Candidates',
    summary_defect: 'checkbox',
    machine_residue: 'checkbox',
    relation_risk: 'checkbox',
    sensitivity_lane: 'select: normal / intimate_theatre / high_emotion',
    recall_guard: 'select: normal / explicit_context_only / audit_only',
    sync_hash: 'rich_text; idempotent sync key'
  };
}

function buildNotionDryRunImportPreview({ fromBundle, toBundle, marchValidationCards, febOriginAnchors, crossMonthLinks, crossValidationReport }) {
  const stableCards = marchValidationCards.filter((card) => card.review_status === 'ready_for_cold_archive');
  const samplingCards = marchValidationCards.filter((card) => card.review_status === 'usable_with_sampling');
  const reviewCards = marchValidationCards.filter((card) => card.review_status === 'needs_review');
  const toOverloadIds = sourceSpanOverloadIds(toBundle);
  const reviewSourceOverloadCards = reviewCards.filter((card) => safeArray(card.source_span_ids, 128).some((id) => toOverloadIds.has(id)));
  const sourceSpanRows = [
    ...fromBundle.sourceSpans.map((span) => toSourceSpanPreview(span, fromBundle.month)),
    ...toBundle.sourceSpans.map((span) => toSourceSpanPreview(span, toBundle.month))
  ];
  const sourceTraceRows = [
    ...fromBundle.sourceTraces.map((trace) => ({ month_key: fromBundle.month, trace_id: trace.trace_id || trace.candidate_id, trace_kind: trace.trace_kind, source_window_title: trace.source_window_title, source_msg_range: trace.source_msg_range })),
    ...toBundle.sourceTraces.map((trace) => ({ month_key: toBundle.month, trace_id: trace.trace_id || trace.candidate_id, trace_kind: trace.trace_kind, source_window_title: trace.source_window_title, source_msg_range: trace.source_msg_range }))
  ];
  const relationRootRows = [
    ...fromBundle.relationRoots.map((root) => ({ month_key: fromBundle.month, root_id: root.normalized_root_id || root.root_id, root_kind: root.root_kind, root_path: root.root_path, graph_visibility: root.graph_visibility || root.import_status })),
    ...toBundle.relationRoots.map((root) => ({ month_key: toBundle.month, root_id: root.normalized_root_id || root.root_id, root_kind: root.root_kind, root_path: root.root_path, graph_visibility: root.graph_visibility || root.import_status }))
  ];
  const relationEdgeRows = [
    ...fromBundle.treeEdges.map((edge) => ({ month_key: fromBundle.month, edge_id: edge.candidate_id, relation_type: edge.relation_type, import_status: edge.import_status, evidence_entry_count: safeArray(edge.evidence_entry_ids, 4096).length })),
    ...toBundle.treeEdges.map((edge) => ({ month_key: toBundle.month, edge_id: edge.candidate_id, relation_type: edge.relation_type, import_status: edge.import_status, evidence_entry_count: safeArray(edge.evidence_entry_ids, 4096).length }))
  ];
  const monthlyReportRows = [
    { title: `${fromBundle.month} origin anchor package`, month_key: fromBundle.month, report_kind: 'origin_anchor_pack', row_count: febOriginAnchors.length },
    { title: `${toBundle.month} full validation package`, month_key: toBundle.month, report_kind: 'full_validation_pack', row_count: marchValidationCards.length },
    { title: `${fromBundle.month}_to_${toBundle.month} cross month report`, month_key: `${fromBundle.month}_to_${toBundle.month}`, report_kind: 'cross_month_validation', row_count: crossMonthLinks.length }
  ];
  return {
    schema: 'driftstone_notion_dry_run_import_preview_v0.1',
    dry_run: true,
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false,
    sample_plan: {
      stable_memory_cards: 10,
      sampling_memory_cards: 5,
      review_queue: 5,
      source_span_index: 10,
      relation_root_candidates: 10,
      relation_edge_candidates: 10
    },
    import_policy: {
      stable_memory_cards: 'ready_for_cold_archive only',
      sampling_memory_cards: 'usable_with_sampling only',
      review_queue: 'needs_review only',
      source_span_index: 'overloaded spans collapsed by default',
      cross_month_links: 'links only; no merge/delete',
      recall_guard: 'normal / explicit_context_only / audit_only'
    },
    field_mapping: {
      memory_cards: memoryCardFieldMapping(),
      source_span_index: {
        source_span_id: 'title or rich_text unique key',
        month_key: 'select',
        span_role: 'select',
        source_window_title: 'rich_text',
        source_msg_range: 'rich_text',
        parent_source_span_id: 'relation/rich_text',
        child_source_span_ids: 'relation; visible for overloaded parent spans',
        source_trace_count: 'number',
        linked_memory_entry_count: 'number',
        child_source_span_count: 'number',
        overloaded: 'checkbox',
        display_policy: 'select'
      },
      cross_month_links: {
        left_card_id: 'relation/rich_text',
        right_card_id: 'relation/rich_text',
        left_month: 'select',
        right_month: 'select',
        link_type: 'select',
        decision: 'select',
        reason: 'rich_text',
        safe_to_auto_apply: 'checkbox; true duplicate only'
      }
    },
    databases: {
      memory_entry_page: {
        estimated_pages: 1,
        sample_pages: [{
          title: 'Driftstone 2025-02 -> 2025-03 Validation Entry',
          purpose: 'read rules, review status discipline, source/span and graph boundaries'
        }]
      },
      stable_memory_cards: {
        estimated_pages: stableCards.length,
        filter: 'review_status == ready_for_cold_archive',
        sample_pages: stableCards.slice(0, 10).map(toNotionCardPreview)
      },
      sampling_memory_cards: {
        estimated_pages: samplingCards.length,
        filter: 'review_status == usable_with_sampling',
        sample_pages: samplingCards.slice(0, 5).map(toNotionCardPreview)
      },
      review_queue: {
        estimated_pages: reviewCards.length,
        filter: 'review_status == needs_review',
        views: {
          empty_broken_summary: previewView('Empty / Broken Summary', reviewCards.filter((card) => card.summary_defect), 'summary_defect == true'),
          relation_risk: previewView('Relation Risk', reviewCards.filter((card) => card.relation_risk), 'relation_risk == true'),
          source_span_overload: previewView('Source Span Overload', reviewSourceOverloadCards, 'linked source_span.overloaded == true'),
          machine_residue: previewView('Machine Residue', reviewCards.filter((card) => card.machine_residue), 'machine_residue == true')
        },
        sample_pages: reviewCards.slice(0, 5).map(toNotionCardPreview)
      },
      february_origin_anchor_candidates: {
        estimated_pages: febOriginAnchors.length,
        filter: 'origin_anchor_candidate == true; origin evidence only',
        sample_pages: febOriginAnchors.slice(0, 10).map(toNotionCardPreview)
      },
      source_span_index: {
        estimated_pages: sourceSpanRows.length,
        overloaded_pages: sourceSpanRows.filter((row) => row.overloaded).length,
        default_view: 'collapsed_overloaded_spans',
        display_rule: 'overloaded rows show counts and child span links, not full source trace lists',
        sample_pages: sourceSpanRows.slice(0, 10)
      },
      source_trace_index: {
        estimated_pages: sourceTraceRows.length,
        default_view: 'audit_only',
        sample_pages: sourceTraceRows.slice(0, 10)
      },
      relation_root_candidates: {
        estimated_pages: relationRootRows.length,
        default_view: 'candidate_roots_by_kind',
        sample_pages: relationRootRows.slice(0, 10)
      },
      relation_edge_candidates: {
        estimated_pages: relationEdgeRows.length,
        default_view: 'active_candidate_first',
        sample_pages: relationEdgeRows.slice(0, 10)
      },
      cross_month_links: {
        estimated_pages: crossMonthLinks.length,
        rule: 'link only; no automatic merge/delete',
        grouped_counts: countBy(crossMonthLinks, 'link_type'),
        sample_pages: crossMonthLinks.slice(0, 10)
      },
      monthly_import_reports: {
        estimated_pages: monthlyReportRows.length,
        sample_pages: monthlyReportRows
      }
    },
    quality_gates: {
      stable_only_ready: stableCards.every((card) => card.review_status === 'ready_for_cold_archive'),
      sampling_only_sampling: samplingCards.every((card) => card.review_status === 'usable_with_sampling'),
      review_only_needs_review: reviewCards.every((card) => card.review_status === 'needs_review'),
      no_unsafe_cross_month_auto_apply: crossMonthLinks.every((link) => !link.safe_to_auto_apply || link.link_type === 'true_duplicate'),
      source_span_overload_collapsed: true,
      needs_review_views_available: true,
      recall_guard_available: marchValidationCards.every((card) => ['normal', 'explicit_context_only', 'audit_only'].includes(card.recall_guard))
    },
    source_cross_report_counts: crossValidationReport.counts
  };
}

function buildNotionDryRunImportPreviewMarkdown(preview = {}) {
  const lines = [];
  lines.push('# Notion Dry-Run Import Preview');
  lines.push('');
  lines.push('本文件只预览 Notion 空库、视图、字段映射和预计导入数量；不写 Notion，不写 Mossbridge warm memory。');
  lines.push('');
  lines.push('## Import Policy');
  for (const [key, value] of Object.entries(preview.import_policy || {})) lines.push(`- ${key}: ${value}`);
  lines.push('');
  lines.push('## Database Counts');
  for (const [key, db] of Object.entries(preview.databases || {})) {
    lines.push(`- ${key}: ${db.estimated_pages ?? 0}${db.overloaded_pages !== undefined ? `; overloaded ${db.overloaded_pages}` : ''}`);
  }
  lines.push('');
  lines.push('## Review Queue Views');
  const views = preview.databases?.review_queue?.views || {};
  for (const [key, view] of Object.entries(views)) {
    lines.push(`- ${view.name || key}: ${view.count} (${view.filter})`);
  }
  lines.push('');
  lines.push('## Recall Guard');
  pushRecallGuardPolicy(lines);
  lines.push('');
  lines.push('## Field Mapping: Memory Cards');
  for (const [field, mapping] of Object.entries(preview.field_mapping?.memory_cards || {})) {
    lines.push(`- ${field}: ${mapping}`);
  }
  lines.push('');
  lines.push('## Quality Gates');
  for (const [key, value] of Object.entries(preview.quality_gates || {})) {
    lines.push(`- ${key}: ${value ? 'pass' : 'fail'}`);
  }
  lines.push('');
  lines.push('## First Stable Page Preview');
  const firstStable = preview.databases?.stable_memory_cards?.sample_pages?.[0];
  if (firstStable) {
    lines.push(`- title: ${firstStable.title}`);
    lines.push(`- relation_path: ${firstStable.relation_path}`);
    lines.push(`- recall_guard: ${firstStable.recall_guard}`);
    lines.push(`- summary: ${firstStable.human_summary}`);
  } else {
    lines.push('- No stable pages in preview.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildNotionDryRunSamplePages(preview = {}) {
  const db = preview.databases || {};
  return {
    schema: 'driftstone_notion_dry_run_sample_pages_v0.1',
    dry_run: true,
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false,
    samples: {
      stable_memory_cards: safeArray(db.stable_memory_cards?.sample_pages, 10),
      sampling_memory_cards: safeArray(db.sampling_memory_cards?.sample_pages, 5),
      review_queue: safeArray(db.review_queue?.sample_pages, 5),
      source_span_index: safeArray(db.source_span_index?.sample_pages, 10),
      relation_root_candidates: safeArray(db.relation_root_candidates?.sample_pages, 10),
      relation_edge_candidates: safeArray(db.relation_edge_candidates?.sample_pages, 10)
    }
  };
}

function tableCell(value = '') {
  if (Array.isArray(value)) return value.map((item) => safeText(item)).filter(Boolean).join(', ').replace(/\|/g, '\\|');
  if (value && typeof value === 'object') return clipText(JSON.stringify(value), 160).replace(/\|/g, '\\|');
  return clipText(value, 160).replace(/\n+/g, ' ').replace(/\|/g, '\\|');
}

function renderTable(rows = [], columns = []) {
  if (!rows.length) return '_No sample rows._\n';
  const lines = [];
  lines.push(`| ${columns.map((column) => column.label).join(' | ')} |`);
  lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${columns.map((column) => tableCell(row[column.key])).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function buildNotionDryRunResultMarkdown(preview = {}, qualityData = {}) {
  const db = preview.databases || {};
  const views = db.review_queue?.views || {};
  const stableRows = safeArray(db.stable_memory_cards?.sample_pages, 10);
  const samplingRows = safeArray(db.sampling_memory_cards?.sample_pages, 5);
  const reviewRows = safeArray(db.review_queue?.sample_pages, 5);
  const sourceSpanRows = safeArray(db.source_span_index?.sample_pages, 10);
  const relationRootRows = safeArray(db.relation_root_candidates?.sample_pages, 10);
  const relationEdgeRows = safeArray(db.relation_edge_candidates?.sample_pages, 10);
  const lines = [];
  lines.push('# Notion Dry-Run Result');
  lines.push('');
  lines.push('本文件是 Notion dry-run 预览结果，不是正式写库截图。当前没有创建 Notion 数据库、没有导入真实页面、没有写 Mossbridge warm memory。');
  lines.push('');
  lines.push('## Execution Scope');
  lines.push(`- writes_to_notion: ${preview.writes_to_notion}`);
  lines.push(`- writes_to_mossbridge_warm_memory: ${preview.writes_to_mossbridge_warm_memory}`);
  lines.push('- cross_month_links: link only, no merge/delete');
  lines.push('- Source Span overloaded: collapsed by default');
  lines.push('- recall_guard: filterable in memory card views');
  lines.push('');
  lines.push('## Empty Database Structure Preview');
  for (const [key, database] of Object.entries(db)) {
    lines.push(`- ${key}: estimated_pages ${database.estimated_pages ?? 0}${database.filter ? `; filter ${database.filter}` : ''}${database.default_view ? `; default_view ${database.default_view}` : ''}`);
  }
  lines.push('');
  lines.push('## View Preview');
  lines.push('- Stable Memory Cards: `review_status == ready_for_cold_archive`; `recall_guard` filterable.');
  lines.push('- Sampling Memory Cards: `review_status == usable_with_sampling`; not included in default stable home.');
  lines.push('- Review Queue: `review_status == needs_review`; audit only.');
  for (const view of Object.values(views)) {
    lines.push(`- Review / ${view.name}: ${view.count} rows; filter ${view.filter}.`);
  }
  lines.push('- Source Span Index: overloaded rows show counts and child span links instead of full trace lists.');
  lines.push('');
  lines.push('## Stable Memory Cards Sample (10)');
  lines.push(renderTable(stableRows, [
    { key: 'title', label: 'title' },
    { key: 'relation_path', label: 'relation_path' },
    { key: 'recall_guard', label: 'recall_guard' },
    { key: 'sensitivity_lane', label: 'sensitivity' },
    { key: 'source_span_count', label: 'spans' },
    { key: 'human_summary', label: 'human_summary' }
  ]));
  lines.push('## Sampling Memory Cards Sample (5)');
  lines.push(renderTable(samplingRows, [
    { key: 'title', label: 'title' },
    { key: 'relation_path', label: 'relation_path' },
    { key: 'recall_guard', label: 'recall_guard' },
    { key: 'sensitivity_lane', label: 'sensitivity' },
    { key: 'human_summary', label: 'human_summary' }
  ]));
  lines.push('## Review Queue Sample (5)');
  lines.push(renderTable(reviewRows, [
    { key: 'title', label: 'title' },
    { key: 'summary_defect', label: 'summary_defect' },
    { key: 'machine_residue', label: 'machine_residue' },
    { key: 'relation_risk', label: 'relation_risk' },
    { key: 'recall_guard', label: 'recall_guard' },
    { key: 'human_summary', label: 'human_summary' }
  ]));
  lines.push('## Source Span Sample (10)');
  lines.push(renderTable(sourceSpanRows, [
    { key: 'source_span_id', label: 'source_span_id' },
    { key: 'month_key', label: 'month' },
    { key: 'span_role', label: 'role' },
    { key: 'source_window_title', label: 'window' },
    { key: 'source_msg_range', label: 'msg_range' },
    { key: 'overloaded', label: 'overloaded' },
    { key: 'display_policy', label: 'display_policy' }
  ]));
  lines.push('## Relation Root Sample (10)');
  lines.push(renderTable(relationRootRows, [
    { key: 'root_id', label: 'root_id' },
    { key: 'month_key', label: 'month' },
    { key: 'root_kind', label: 'kind' },
    { key: 'root_path', label: 'root_path' },
    { key: 'graph_visibility', label: 'visibility' }
  ]));
  lines.push('## Relation Edge Sample (10)');
  lines.push(renderTable(relationEdgeRows, [
    { key: 'edge_id', label: 'edge_id' },
    { key: 'month_key', label: 'month' },
    { key: 'relation_type', label: 'type' },
    { key: 'import_status', label: 'status' },
    { key: 'evidence_entry_count', label: 'evidence' }
  ]));
  lines.push('## Potential Issues');
  lines.push(`- Source Span overloaded: ${db.source_span_index?.overloaded_pages || 0}; kept collapsed in normal pages.`);
  lines.push(`- Review Empty / Broken Summary: ${views.empty_broken_summary?.count || 0}; kept in Review Queue only.`);
  lines.push(`- Review Machine Residue: ${views.machine_residue?.count || 0}; kept in Review Queue only.`);
  lines.push(`- Review Relation Risk: ${views.relation_risk?.count || 0}; kept in Review Queue only.`);
  lines.push(`- Suspicious relation root samples from quality report: ${qualityData.relation_root_suspicious_character_count || 0}.`);
  lines.push(`- Notion dry-run quality gates: ${Object.values(preview.quality_gates || {}).every(Boolean) ? 'pass' : 'check needed'}.`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function stringifyJsonl(rows = []) {
  return `${safeArray(rows, 999999).map((row) => JSON.stringify(row)).join('\n')}\n`;
}

async function writeText(outDir = '', fileName = '', content = '') {
  const filePath = join(outDir, fileName);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromBundle = await loadMonthBundle(args.stagingRoot, args.fromMonth);
  const toBundle = await loadMonthBundle(args.stagingRoot, args.toMonth);
  const cross = await loadCrossMonthReport(args.stagingRoot, args.fromMonth, args.toMonth);
  const outDir = args.outDir || join('output/chatgpt_validation', `driftstone_${args.fromMonth}_to_${args.toMonth}_validation`);
  await mkdir(outDir, { recursive: true });

  const marchValidationCards = toBundle.memoryCandidates.map((card) => toValidationCard(card, toBundle));
  const febOriginAnchors = buildOriginAnchorPack(fromBundle);
  const crossValidationReport = buildCrossMonthValidationReport(cross);
  const crossMonthLinks = buildCrossMonthLinks(cross.decisions);
  const qualityData = buildQualityReportData(fromBundle, toBundle, febOriginAnchors, crossValidationReport);
  const notionDryRunPreview = buildNotionDryRunImportPreview({
    fromBundle,
    toBundle,
    marchValidationCards,
    febOriginAnchors,
    crossMonthLinks,
    crossValidationReport
  });
  const notionDryRunSamples = buildNotionDryRunSamplePages(notionDryRunPreview);
  const files = {
    entry: 'chatgpt_memory_entry.md',
    marchJsonl: 'march_2025_full_validation_pack.jsonl',
    marchReadable: 'march_2025_chat_readable.md',
    febOrigin: 'feb_2025_origin_anchor_pack.jsonl',
    crossReport: 'feb_mar_cross_month_validation_report.json',
    crossLinks: 'cross_month_links.jsonl',
    evalQuestions: 'chatgpt_eval_questions.jsonl',
    rubric: 'chatgpt_scoring_rubric.md',
    notionSchema: 'notion_schema_preview.md',
    notionDryRunPreview: 'notion_dry_run_import_preview.json',
    notionDryRunPreviewMd: 'notion_dry_run_import_preview.md',
    notionDryRunSamples: 'notion_dry_run_sample_pages.json',
    notionDryRunResult: 'notion_dry_run_result.md',
    manifest: 'validation_manifest.json',
    qualityReport: 'quality_report.md'
  };

  const manifest = {
    schema: 'driftstone_chatgpt_notion_validation_manifest_v0.1',
    generated_at: new Date().toISOString(),
    dry_run: true,
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false,
    input_months: {
      origin_month: args.fromMonth,
      evolution_month: args.toMonth
    },
    files: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, join(outDir, file)])),
    counts: {
      march_memory_candidates: toBundle.memoryCandidates.length,
      march_validation_cards: marchValidationCards.length,
      feb_origin_anchors: febOriginAnchors.length,
      feb_source_spans: fromBundle.sourceSpans.length,
      march_source_spans: toBundle.sourceSpans.length,
      feb_relation_roots: fromBundle.relationRoots.length,
      march_relation_roots: toBundle.relationRoots.length,
      feb_active_edges: fromBundle.bridgeCandidateGraph.length,
      march_active_edges: toBundle.bridgeCandidateGraph.length,
      cross_month_links: crossMonthLinks.length,
      notion_dry_run_stable_pages: notionDryRunPreview.databases.stable_memory_cards.estimated_pages,
      notion_dry_run_sampling_pages: notionDryRunPreview.databases.sampling_memory_cards.estimated_pages,
      notion_dry_run_review_pages: notionDryRunPreview.databases.review_queue.estimated_pages,
      notion_dry_run_source_span_pages: notionDryRunPreview.databases.source_span_index.estimated_pages
    },
    review_status_distribution: {
      [args.toMonth]: countBy(toBundle.memoryCandidates, reviewStatus)
    },
    quality_report: qualityData,
    notion_dry_run_quality_gates: notionDryRunPreview.quality_gates,
    may_enter_notion_dry_run: Boolean(qualityData.recommend_notion_dry_run),
    next_step: 'Let ChatGPT read this bundle and score answer quality before any Notion write/import.'
  };

  await writeText(outDir, files.entry, buildChatgptEntryMarkdown(files));
  await writeText(outDir, files.marchJsonl, stringifyJsonl(marchValidationCards));
  await writeText(outDir, files.marchReadable, buildMarchReadableMarkdown(marchValidationCards, args.toMonth));
  await writeText(outDir, files.febOrigin, stringifyJsonl(febOriginAnchors));
  await writeText(outDir, files.crossReport, `${JSON.stringify(crossValidationReport, null, 2)}\n`);
  await writeText(outDir, files.crossLinks, stringifyJsonl(crossMonthLinks));
  await writeText(outDir, files.evalQuestions, stringifyJsonl(buildEvalQuestionsJsonl()));
  await writeText(outDir, files.rubric, buildScoringRubricMarkdown());
  await writeText(outDir, files.notionSchema, buildNotionSchemaPreviewMarkdown());
  await writeText(outDir, files.notionDryRunPreview, `${JSON.stringify(notionDryRunPreview, null, 2)}\n`);
  await writeText(outDir, files.notionDryRunPreviewMd, buildNotionDryRunImportPreviewMarkdown(notionDryRunPreview));
  await writeText(outDir, files.notionDryRunSamples, `${JSON.stringify(notionDryRunSamples, null, 2)}\n`);
  await writeText(outDir, files.notionDryRunResult, buildNotionDryRunResultMarkdown(notionDryRunPreview, qualityData));
  await writeText(outDir, files.qualityReport, buildQualityReportMarkdown(qualityData, notionDryRunPreview));
  await writeText(outDir, files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    out_dir: outDir,
    files: manifest.files,
    summary: {
      march_review_status_distribution: manifest.review_status_distribution[args.toMonth],
      feb_origin_anchors: febOriginAnchors.length,
      cross_month_link_type_distribution: qualityData.cross_month_link_type_distribution,
      true_duplicate_count: qualityData.true_duplicate_count,
      same_topic_count: qualityData.same_topic_count,
      origin_evolution_count: qualityData.origin_evolution_count,
      parallel_subclaim_count: qualityData.parallel_subclaim_count,
      notion_dry_run_counts: {
        stable: notionDryRunPreview.databases.stable_memory_cards.estimated_pages,
        sampling: notionDryRunPreview.databases.sampling_memory_cards.estimated_pages,
        review: notionDryRunPreview.databases.review_queue.estimated_pages,
        feb_origin: notionDryRunPreview.databases.february_origin_anchor_candidates.estimated_pages,
        source_spans: notionDryRunPreview.databases.source_span_index.estimated_pages,
        overloaded_source_spans: notionDryRunPreview.databases.source_span_index.overloaded_pages
      },
      may_enter_notion_dry_run: manifest.may_enter_notion_dry_run
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
