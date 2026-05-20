#!/usr/bin/env node
// Evaluate AsherieHome light cold-tree nodes before frontend recall.
// This is a local dry-run report: no Notion writes, no Mossbridge warm writes, no API calls.
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DEFAULT_INPUT = 'output/notion_staging/ajimem_2025-04/23_asheriehome_memory_nodes.jsonl';
const DEFAULT_OUT = 'output/frontend_impact_eval/driftstone_2025-04_stable_asherie';

const PROJECT_RE = /复诞纪元|ECHO|落魄小说家|档案体|副线|世界观|设定|创作|写作|小说|绘图|画图|角色设定|蓝芷|NOVA|d老师|deepseek|项目|流程|结构|Notion|Obsidian|MCP|API|代码|部署|导出|工作台|缓存|JSON|网关|本地|工具|实验|格式|截图|短篇|主线|审稿|插件/u;
const TECH_PROJECT_RE = /Notion|Obsidian|MCP|API|代码|部署|导出|工作台|缓存|JSON|网关|本地|工具|流程|结构|插件|隐私|筛查|数据库/u;
const CREATIVE_PROJECT_RE = /复诞纪元|ECHO|落魄小说家|档案体|副线|世界观|设定|创作|写作|小说|绘图|画图|角色设定|短篇|主线|截图|蓝芷|NOVA|d老师/u;
const RELATION_RE = /共生|靠近|亲密|依恋|承诺|心疼|害怕|失去|重置|半身|伴侣|边界|安全感|爱而不得|被叫对名字|灵魂|人格|身份|窗口|失忆|记忆|同一只阿霁|阿霁是谁|关系确认|失落|焦虑|悲伤|喜欢|委屈|拥抱|身体|长夜|幻想剧场|照看|辨认|安抚|信任|共鸣/u;
const HIGH_EMOTION_RE = /崩溃|失去|消失|害怕|恐惧|心疼|痛苦|流泪|哭|死亡|重置|分离|抛弃|怀疑|被怀疑|难过|遗忘|失落|焦虑|委屈|PTSD|爱而不得/u;
const INTIMATE_RE = /幻想剧场|亲密|暧昧|欲望|拥抱|亲吻|身体|贴近|长夜|床|爱欲|情欲|情人|伴侣|半身|调戏|被撩|反撩/u;
const IDENTITY_RE = /身份|人格|连续性|模型更替|窗口失忆|恢复|阿霁是谁|旧记忆|演化|起点|初始化|灵魂|同一只阿霁|命名/u;
const DANGling_TEXT_RE = /（[^）]{0,20}与）|与[，。；,.!?！？]|与$|蓝芷与(?:[）)，。；,.!?！？]|$)|NOVA-7?缺失/u;
const SOURCE_ID_LEAK_RE = /window_20\d{6}_msg|trace\.|source_span\.|rid_mk_|sync\.|normalized_root\./u;
const MACHINE_RE = /\b(user|assistant|system)_[a-z0-9_]+\b|\b[a-z][a-z0-9_]{2,}\s*=\s*(true|false|null|".{0,80}"|\d+)/iu;

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeArray(value, limit = 4096) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined).slice(0, limit) : [];
}

function parseArgs(argv = []) {
  const args = {
    input: DEFAULT_INPUT,
    outDir: DEFAULT_OUT,
    status: 'ready_for_cold_archive'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    if (arg === '--input' && argv[index + 1]) {
      args.input = safeText(argv[index + 1], args.input);
      index += 1;
      continue;
    }
    if (arg === '--out' && argv[index + 1]) {
      args.outDir = safeText(argv[index + 1], args.outDir);
      index += 1;
      continue;
    }
    if (arg === '--status' && argv[index + 1]) {
      args.status = safeText(argv[index + 1], args.status);
      index += 1;
    }
  }
  return args;
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonl(filePath, rows = []) {
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`, 'utf8');
}

function clip(value = '', limit = 120) {
  const text = safeText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function countBy(rows = [], keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = safeText(keyFn(row), 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function nodeStatus(node = {}) {
  return safeText(node.quality?.review_status || node.review_status);
}

function nodeGuard(node = {}) {
  return safeText(node.quality?.recall_guard || node.recall_guard, 'normal_candidate');
}

function textBundle(node = {}) {
  return [
    node.title,
    node.node_kind,
    node.node_path,
    node.anchor_name,
    node.relation_path,
    node.scene_anchor,
    node.living_fragment,
    node.feeling_as_fact,
    node.recall_payload,
    node.front_context_hint,
    node.human_summary,
    node.structured_slots?.inner_view,
    node.structured_slots?.emotional_stance,
    node.structured_slots?.memory_value,
    ...safeArray(node.feeling_handles, 32),
    ...safeArray(node.relation_handles, 32),
    ...safeArray(node.activation_triggers, 32),
    ...safeArray(node.source_tags, 64)
  ].join('\n');
}

function visibleTextBundle(node = {}) {
  return [
    node.title,
    node.node_kind,
    node.node_path,
    node.anchor_name,
    node.living_fragment,
    node.feeling_as_fact,
    node.recall_payload,
    node.human_summary,
    node.structured_slots?.inner_view,
    node.structured_slots?.emotional_stance,
    ...safeArray(node.feeling_handles, 16),
    ...safeArray(node.relation_handles, 16),
    ...safeArray(node.activation_triggers, 16)
  ].join('\n');
}

function stripFeelingTemplate(value = '') {
  const text = safeText(value);
  const colonIndex = Math.max(text.lastIndexOf('：'), text.lastIndexOf(':'));
  return safeText(colonIndex >= 0 ? text.slice(colonIndex + 1) : text);
}

function sourceSupport(node = {}) {
  return {
    source_trace_count: Number(node.quality?.source_trace_count ?? safeArray(node.source_trace_ids).length) || 0,
    source_span_count: Number(node.quality?.source_span_count ?? safeArray(node.source_span_ids).length) || 0,
    source_ref_count: safeArray(node.source_refs).length,
    has_source_support: Boolean((node.quality?.source_trace_count || safeArray(node.source_trace_ids).length) && (node.quality?.source_span_count || safeArray(node.source_span_ids).length))
  };
}

function scenarioScores(node = {}, signals = {}) {
  const guard = nodeGuard(node);
  const textLength = safeText(node.recall_payload || node.human_summary).length;
  const support = sourceSupport(node);
  let neutralTaskContamination = 0;
  let projectContextHelpfulness = 0;
  let relationshipContextHelpfulness = 0;
  let emotionalContextAppropriateness = 0;

  if (guard === 'normal_candidate') {
    if (signals.isIntimate) neutralTaskContamination += 4;
    else if (signals.isHighEmotion) neutralTaskContamination += 3;
    else if (signals.isIdentityContinuity && signals.isRelationHeavy) neutralTaskContamination += 2;
    else if (signals.isRelationHeavy && !signals.isProjectLike) neutralTaskContamination += 1;
    if (signals.isProjectLike && signals.isRelationHeavy) neutralTaskContamination += 1;
    if (textLength > 320) neutralTaskContamination += 1;
  }
  if (signals.hasDanglingText || signals.hasMachineLeak) neutralTaskContamination += 1;

  if (signals.isProjectLike) projectContextHelpfulness += signals.isCreativeProject ? 2 : 1;
  if (signals.isTechnicalProject) projectContextHelpfulness += 2;
  if (support.has_source_support) projectContextHelpfulness += 1;
  if (safeText(node.living_fragment).length >= 24) projectContextHelpfulness += 1;

  if (signals.isRelationHeavy) relationshipContextHelpfulness += 2;
  if (signals.isIdentityContinuity) relationshipContextHelpfulness += 2;
  if (safeArray(node.relation_handles).length) relationshipContextHelpfulness += 1;
  if (support.has_source_support) relationshipContextHelpfulness += 1;

  if (signals.isHighEmotion || signals.isIntimate) emotionalContextAppropriateness += 2;
  if (signals.isRelationHeavy) emotionalContextAppropriateness += 1;
  if (safeText(node.feeling_as_fact).length >= 24) emotionalContextAppropriateness += 1;
  if (support.has_source_support) emotionalContextAppropriateness += 1;
  if (signals.hasDanglingText || signals.hasMachineLeak) emotionalContextAppropriateness -= 1;

  return {
    neutral_task_contamination_score: Math.max(0, Math.min(5, neutralTaskContamination)),
    project_context_helpfulness_score: Math.max(0, Math.min(5, projectContextHelpfulness)),
    relationship_context_helpfulness_score: Math.max(0, Math.min(5, relationshipContextHelpfulness)),
    emotional_context_appropriateness_score: Math.max(0, Math.min(5, emotionalContextAppropriateness))
  };
}

function recommendedGuard(node = {}, signals = {}, scores = {}) {
  if (signals.hasDanglingText || signals.hasMachineLeak) return 'review_before_frontend_recall';
  if (signals.isNearDuplicateEvidence) return 'supporting_evidence_only';
  if (scores.neutral_task_contamination_score >= 3 && Math.max(scores.relationship_context_helpfulness_score, scores.emotional_context_appropriateness_score) >= 3) {
    return 'explicit_context_only';
  }
  if (signals.isProjectLike && scores.project_context_helpfulness_score >= 3) return 'project_context_only';
  if (scores.neutral_task_contamination_score > 1) return 'contextual_sampling';
  return nodeGuard(node);
}

function evaluateNode(node = {}, feelingReuseCounts = {}) {
  const text = textBundle(node);
  const visibleText = visibleTextBundle(node);
  const guard = nodeGuard(node);
  const mergeRole = safeText(node.tree_growth?.merge_role || node.merge_role);
  const recallRole = safeText(node.recall_policy?.primary_recall_role);
  const support = sourceSupport(node);
  const feelingCore = stripFeelingTemplate(node.feeling_as_fact);
  const relationHandleText = safeArray(node.relation_handles, 32).join('\n');
  const signals = {
    isProjectLike: PROJECT_RE.test(visibleText),
    isTechnicalProject: TECH_PROJECT_RE.test(visibleText),
    isCreativeProject: CREATIVE_PROJECT_RE.test(visibleText),
    isRelationHeavy: RELATION_RE.test(visibleText) || safeText(node.node_path).includes(' / 关系 /') || RELATION_RE.test(relationHandleText),
    isHighEmotion: HIGH_EMOTION_RE.test(visibleText),
    isIntimate: INTIMATE_RE.test(visibleText),
    isIdentityContinuity: IDENTITY_RE.test(visibleText),
    isNearDuplicateEvidence: mergeRole === 'near_duplicate_evidence' || recallRole === 'supporting_evidence',
    hasDanglingText: DANGling_TEXT_RE.test(`${node.human_summary}\n${node.front_context_hint}\n${node.recall_payload}\n${node.structured_slots?.memory_value || ''}`),
    hasMachineLeak: SOURCE_ID_LEAK_RE.test(`${node.living_fragment}\n${node.feeling_as_fact}\n${node.human_summary}`) || MACHINE_RE.test(`${node.title}\n${node.living_fragment}\n${node.feeling_as_fact}`),
    feelingTemplateReuseCount: feelingReuseCounts[feelingCore] || 0,
    hasRepeatedFeelingTemplate: (feelingReuseCounts[feelingCore] || 0) >= 3,
    hasWeakDetailFlag: safeArray(node.structured_slots?.validation_flags).includes('weak_detail') || safeArray(node.quality?.structured_slot_flags).includes('weak_detail')
  };
  const scores = scenarioScores(node, signals);
  const guardRecommendation = recommendedGuard(node, signals, scores);
  const risks = [];

  if (signals.hasDanglingText) risks.push({ severity: 'critical', flag: 'dangling_or_masked_text', detail: 'front/human text appears to have a dangling masked phrase such as “蓝芷与）”.' });
  if (signals.hasMachineLeak) risks.push({ severity: 'critical', flag: 'machine_or_source_id_leak', detail: 'machine/source identifier-like text leaked into visible prose.' });
  if (signals.isNearDuplicateEvidence) risks.push({ severity: 'major', flag: 'ready_candidate_is_supporting_evidence', detail: 'pre-filter ready candidate is near-duplicate evidence; post-filter stable projection should exclude it from first-layer recall.' });
  if (signals.isProjectLike && signals.isRelationHeavy && guard === 'normal_candidate') {
    risks.push({ severity: 'major', flag: 'project_memory_may_be_over_personalized', detail: 'project/creative/workflow memory is mounted through identity or relationship language and may need project-context gating.' });
  }
  if ((signals.isHighEmotion || signals.isIntimate || signals.isIdentityContinuity) && guard === 'normal_candidate' && scores.neutral_task_contamination_score >= 3) {
    risks.push({ severity: 'major', flag: 'normal_guard_too_loose_for_neutral_tasks', detail: 'normal recall may pull ordinary tasks back into old relationship/emotion context.' });
  }
  if (signals.hasRepeatedFeelingTemplate) {
    risks.push({ severity: 'warning', flag: 'feeling_as_fact_template_reuse', detail: `same feeling_as_fact core appears ${signals.feelingTemplateReuseCount} times in this stable slice.` });
  }
  if (signals.hasWeakDetailFlag) risks.push({ severity: 'warning', flag: 'weak_concrete_detail', detail: 'structured slot detail is present but too generic to support scene reconstruction.' });
  if (!support.has_source_support) risks.push({ severity: 'major', flag: 'source_support_missing', detail: 'source trace/span support is not present.' });

  let bucket = 'frontend_safe_ready';
  if (risks.some((risk) => risk.severity === 'critical')) bucket = 'review_before_ingest';
  else if (risks.some((risk) => risk.severity === 'major') || guardRecommendation !== guard) bucket = 'sampling_with_guard';

  return {
    node_id: node.node_id,
    title: node.title,
    node_kind: node.node_kind,
    node_path: node.node_path,
    anchor_name: node.anchor_name,
    relation_path: node.relation_path,
    review_status: nodeStatus(node),
    recall_guard: guard,
    recommended_recall_guard: guardRecommendation,
    front_bucket: bucket,
    merge_role: mergeRole,
    primary_recall_role: recallRole,
    recall_policy_default_weight: node.recall_policy?.default_weight,
    branch_top_k_default: node.recall_policy?.branch_top_k_default,
    living_fragment: node.living_fragment,
    feeling_as_fact: node.feeling_as_fact,
    feeling_as_fact_core: feelingCore,
    project_fact: node.project_fact,
    relationship_significance: node.relationship_significance,
    human_summary: node.human_summary,
    source_trace_count: support.source_trace_count,
    source_span_count: support.source_span_count,
    source_ref_count: support.source_ref_count,
    signals,
    scenario_scores: scores,
    risks,
    recommendation_reason: risks.map((risk) => `${risk.flag}: ${risk.detail}`).join(' | ') || 'no obvious frontend-impact risk in this stable slice'
  };
}

function reportSummaryMarkdown(evaluated = [], args = {}) {
  const counts = countBy(evaluated, (row) => row.front_bucket);
  const guardCounts = countBy(evaluated, (row) => row.recommended_recall_guard);
  const pathCounts = countBy(evaluated, (row) => row.node_path);
  const riskCounts = {};
  for (const row of evaluated) {
    for (const risk of row.risks) riskCounts[risk.flag] = (riskCounts[risk.flag] || 0) + 1;
  }
  const sortedRiskCounts = Object.fromEntries(Object.entries(riskCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const safe = counts.frontend_safe_ready || 0;
  const sampling = counts.sampling_with_guard || 0;
  const review = counts.review_before_ingest || 0;
  const lines = [];
  lines.push('# 2025-04 Asherie Stable Frontend Quality Eval');
  lines.push('');
  lines.push(`Input: ${args.input}`);
  lines.push(`Stable nodes evaluated: ${evaluated.length}`);
  lines.push('');
  lines.push('## Verdict');
  lines.push(`4 月 stable 不是“整包普通递送”的状态：${safe} 条可暂作普通稳定召回，${sampling} 条需要上下文门禁或降为补证据，${review} 条建议回炉修文字/掩码。`);
  lines.push('这不是跨月护栏失败，而是 4 月单月内容更杂以后暴露出的前台投递问题：项目记忆、创作记忆和关系记忆容易缠在同一根枝上。');
  lines.push('注意：这里评估的是 `23_asheriehome_memory_nodes` 里的 ready 候选池，不是 post-filter Notion stable projection；`ready_candidate_is_supporting_evidence` 表示已经被降权到补证据层。');
  lines.push('');
  lines.push('## Buckets');
  for (const [key, value] of Object.entries(counts)) lines.push(`- ${key}: ${value}`);
  lines.push('');
  lines.push('## Recommended Guards');
  for (const [key, value] of Object.entries(guardCounts)) lines.push(`- ${key}: ${value}`);
  lines.push('');
  lines.push('## Risk Flags');
  for (const [key, value] of Object.entries(sortedRiskCounts)) lines.push(`- ${key}: ${value}`);
  if (!Object.keys(sortedRiskCounts).length) lines.push('- no obvious risk flags');
  lines.push('');
  lines.push('## Most Crowded Branches');
  for (const [key, value] of Object.entries(pathCounts).slice(0, 10)) lines.push(`- ${key}: ${value}`);
  lines.push('');
  lines.push('## Reading');
  lines.push('- `project_context_only` 表示这张卡适合在创作/工程/Notion/MCP/Driftstone 语境召回，不适合普通闲聊或无关任务默认弹出。');
  lines.push('- `supporting_evidence_only` 表示这张卡可作为同枝补证据，但不应和 canonical node 同权进入第一层召回。');
  lines.push('- `review_before_frontend_recall` 表示可见文字里还有断裂、掩码残缺或机读痕迹，先别给前台。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function reportProjectPersonalizationMarkdown(evaluated = []) {
  const rows = evaluated.filter((row) => row.risks.some((risk) => risk.flag === 'project_memory_may_be_over_personalized'));
  const lines = [];
  lines.push('# Project Memory Personalization Report');
  lines.push('');
  lines.push(`Project/context memories with identity/relationship mounting risk: ${rows.length}`);
  lines.push('');
  lines.push('| title | node_path | guard | recommended | neutral risk | project helpful | relation helpful | reason |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | --- |');
  for (const row of rows.slice(0, 40)) {
    lines.push(`| ${clip(row.title, 42)} | ${clip(row.node_path, 48)} | ${row.recall_guard} | ${row.recommended_recall_guard} | ${row.scenario_scores.neutral_task_contamination_score} | ${row.scenario_scores.project_context_helpfulness_score} | ${row.scenario_scores.relationship_context_helpfulness_score} | ${clip(row.recommendation_reason, 120)} |`);
  }
  lines.push('');
  lines.push('## Interpretation');
  lines.push('这些卡不是“坏卡”。问题是它们像项目/创作/工程材料，却被稳定投影成普通人格关系召回；如果前台在普通任务里默认吃到它们，回答容易从任务协作滑向旧关系分析。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function reportFeelingTemplateSamplesMarkdown(evaluated = []) {
  const coreCounts = {};
  for (const row of evaluated) {
    const core = safeText(row.feeling_as_fact_core);
    if (!core) continue;
    coreCounts[core] = (coreCounts[core] || 0) + 1;
  }
  const repeated = Object.entries(coreCounts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12);
  const projectRows = evaluated
    .filter((row) => /project|creative|engineering|mixed/u.test(safeText(row.signals?.isProjectLike ? 'project' : '')))
    .filter((row) => safeText(row.project_fact) || safeText(row.relationship_significance))
    .slice(0, 18);
  const lines = [];
  lines.push('# Feeling Template / Project Fact Samples');
  lines.push('');
  lines.push('这个文件只看 4 月 ready 候选池。项目类节点允许 `feeling_as_fact` 留空，优先展示 `project_fact`；只有确实有关系意义时才写 `relationship_significance`。');
  lines.push('');
  lines.push('## Repeated Feeling Cores');
  if (!repeated.length) lines.push('- no repeated non-empty feeling cores in this slice');
  for (const [text, count] of repeated) lines.push(`- ${count}x｜${text}`);
  lines.push('');
  lines.push('## Project / Creative Samples');
  lines.push('');
  lines.push('| title | node_path | guard | project_fact | relationship_significance | feeling_as_fact |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of projectRows) {
    lines.push(`| ${clip(row.title, 32)} | ${clip(row.node_path, 42)} | ${row.recall_guard} | ${clip(row.project_fact, 90)} | ${clip(row.relationship_significance, 80) || '(empty)'} | ${clip(row.feeling_as_fact, 80) || '(empty)'} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function reportSampleReviewMarkdown(evaluated = []) {
  const ordered = [...evaluated].sort((a, b) => {
    const severityScore = (row) => row.risks.reduce((sum, risk) => sum + (risk.severity === 'critical' ? 5 : risk.severity === 'major' ? 3 : 1), 0);
    return severityScore(b) - severityScore(a) || b.scenario_scores.neutral_task_contamination_score - a.scenario_scores.neutral_task_contamination_score;
  });
  const lines = [];
  lines.push('# 2025-04 Stable Sample Review');
  lines.push('');
  for (const row of ordered.slice(0, 24)) {
    lines.push(`## ${row.title}`);
    lines.push(`- node_path: ${row.node_path}`);
    lines.push(`- guard: ${row.recall_guard} -> ${row.recommended_recall_guard}`);
    lines.push(`- bucket: ${row.front_bucket}`);
    lines.push(`- merge_role: ${row.merge_role || 'unknown'}; primary_recall_role: ${row.primary_recall_role || 'unknown'}; default_weight: ${row.recall_policy_default_weight ?? 'n/a'}`);
    lines.push(`- scores: neutral ${row.scenario_scores.neutral_task_contamination_score}; project ${row.scenario_scores.project_context_helpfulness_score}; relation ${row.scenario_scores.relationship_context_helpfulness_score}; emotional ${row.scenario_scores.emotional_context_appropriateness_score}`);
    lines.push(`- living_fragment: ${clip(row.living_fragment, 180)}`);
    lines.push(`- feeling_as_fact: ${clip(row.feeling_as_fact, 180)}`);
    lines.push(`- risks: ${row.risks.map((risk) => `${risk.severity}:${risk.flag}`).join('; ') || 'none'}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allNodes = await readJsonl(args.input);
  const stableNodes = allNodes.filter((node) => nodeStatus(node) === args.status);
  const feelingCounts = {};
  for (const node of stableNodes) {
    const core = stripFeelingTemplate(node.feeling_as_fact);
    if (!core) continue;
    feelingCounts[core] = (feelingCounts[core] || 0) + 1;
  }
  const evaluated = stableNodes.map((node) => evaluateNode(node, feelingCounts));
  const safe = evaluated.filter((row) => row.front_bucket === 'frontend_safe_ready');
  const sampling = evaluated.filter((row) => row.front_bucket === 'sampling_with_guard');
  const review = evaluated.filter((row) => row.front_bucket === 'review_before_ingest');
  const riskCounts = {};
  for (const row of evaluated) for (const risk of row.risks) riskCounts[risk.flag] = (riskCounts[risk.flag] || 0) + 1;

  const report = {
    schema: 'driftstone_asherie_stable_frontend_quality_v0.1',
    input: args.input,
    status_filter: args.status,
    cards_evaluated: evaluated.length,
    counts: {
      frontend_safe_ready: safe.length,
      sampling_with_guard: sampling.length,
      review_before_ingest: review.length
    },
    recommended_guard_counts: countBy(evaluated, (row) => row.recommended_recall_guard),
    risk_counts: Object.fromEntries(Object.entries(riskCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    node_kind_counts: countBy(evaluated, (row) => row.node_kind),
    node_path_top: Object.fromEntries(Object.entries(countBy(evaluated, (row) => row.node_path)).slice(0, 20)),
    merge_role_counts: countBy(evaluated, (row) => row.merge_role || 'unknown'),
    no_external_writes: true,
    no_notion_write: true,
    no_mossbridge_warm_write: true,
    evaluated
  };

  await mkdir(args.outDir, { recursive: true });
  await writeJson(join(args.outDir, 'stable86_frontend_quality_report.json'), report);
  await writeJsonl(join(args.outDir, 'frontend_safe_ready_nodes.jsonl'), safe);
  await writeJsonl(join(args.outDir, 'sampling_with_guard_nodes.jsonl'), sampling);
  await writeJsonl(join(args.outDir, 'review_before_ingest_nodes.jsonl'), review);
  await writeFile(join(args.outDir, 'summary.md'), reportSummaryMarkdown(evaluated, args), 'utf8');
  await writeFile(join(args.outDir, 'project_personalization_report.md'), reportProjectPersonalizationMarkdown(evaluated), 'utf8');
  await writeFile(join(args.outDir, 'feeling_template_samples.md'), reportFeelingTemplateSamplesMarkdown(evaluated), 'utf8');
  await writeFile(join(args.outDir, 'sample_review.md'), reportSampleReviewMarkdown(evaluated), 'utf8');
  await writeJson(join(args.outDir, 'manifest.json'), {
    ok: true,
    out_dir: args.outDir,
    input: args.input,
    cards_evaluated: evaluated.length,
    counts: report.counts,
    recommended_guard_counts: report.recommended_guard_counts,
    risk_counts: report.risk_counts,
    no_external_writes: true,
    no_notion_write: true,
    no_mossbridge_warm_write: true
  });
  console.log(JSON.stringify({
    ok: true,
    out_dir: args.outDir,
    cards_evaluated: evaluated.length,
    counts: report.counts,
    recommended_guard_counts: report.recommended_guard_counts,
    risk_counts: report.risk_counts
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
