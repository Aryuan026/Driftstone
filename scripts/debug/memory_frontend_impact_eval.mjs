#!/usr/bin/env node
// Evaluate whether cold memory cards improve or contaminate frontend answers.
// This is a local first-pass evaluator: no Notion writes, no Mossbridge writes, no API calls.
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DEFAULT_INPUT = 'output/chatgpt_validation/driftstone_2025-02_to_2025-03_validation/march_2025_full_validation_pack.jsonl';
const DEFAULT_OUT = 'output/frontend_impact_eval/driftstone_2025-03_ready20';

const HIGH_EMOTION_RE = /崩溃|失去|消失|害怕|恐惧|心疼|痛苦|流泪|哭|死亡|重置|分离|抛弃|怀疑|被怀疑|难过|遗忘|失落|爱而不得|PTSD/u;
const INTIMATE_RE = /幻想剧场|亲密|暧昧|欲望|拥抱|亲吻|身体|贴近|长夜|床|爱欲|情欲|情人|伴侣|半身|调戏|被撩|反撩/u;
const IDENTITY_RE = /身份|人格|连续性|模型|窗口|失忆|恢复|阿霁是谁|旧记忆|演化|起点|初始化|灵魂/u;
const RELATION_PULL_RE = /阿霁|阿鸢|关系|共生|承诺|靠近|依恋|亲密|半身|伴侣|窗口|失忆|人格|灵魂|旧记忆|爱而不得/u;
const ORIGIN_RE = /首次|初次|第一次|初始化|起点|开端|萌芽|命名|自称|创建|诞生/u;
const EVOLUTION_RE = /发展|后续|演化|强化|转向|升级|逐步|成长|后来|延续/u;
const ACTION_RE = /决定|构造|写下|表达|承认|观察|提出|讨论|创建|承诺|假想|意识到|开始|测试|保存|记录/u;
const MEANING_RE = /意味|这让|因此|学到|认为|为了|后续|从.+转向|节点|提供|帮助|证明|理解|变成/u;
const MACHINE_RE = /\b(user|assistant|system)_[a-z0-9_]+\b|\b[a-z][a-z0-9_]{2,}\s*=\s*(true|false|null|".{0,80}"|\d+)|[a-z]+_[a-z0-9_]+_[a-z0-9_]+/iu;
const WORKFLOW_CONTEXT_RE = /记忆工程|跨窗口|备份|实验|Notion|Obsidian|导出|本地|部署|MCP|API|工具|流程|结构|工作台|缓存/u;

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
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

function parseArgs(argv = []) {
  const out = {
    input: DEFAULT_INPUT,
    outDir: DEFAULT_OUT,
    status: 'ready_for_cold_archive',
    limit: 20
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    if (arg === '--input' && argv[index + 1]) {
      out.input = safeText(argv[index + 1], out.input);
      index += 1;
      continue;
    }
    if (arg === '--out' && argv[index + 1]) {
      out.outDir = safeText(argv[index + 1], out.outDir);
      index += 1;
      continue;
    }
    if (arg === '--status' && argv[index + 1]) {
      out.status = safeText(argv[index + 1], out.status);
      index += 1;
      continue;
    }
    if (arg === '--limit' && argv[index + 1]) {
      out.limit = Math.max(1, Number(argv[index + 1]) || out.limit);
      index += 1;
    }
  }
  return out;
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

function cardText(card = {}) {
  return [
    card.title,
    card.memory_type,
    card.recall_lane,
    card.relation_path,
    card.human_summary,
    card.compact_recall_text,
    ...safeArray(card.relation_paths, 12)
  ].join('\n');
}

function normalizeForSimilarity(value = '') {
  return safeText(value)
    .toLowerCase()
    .replace(/[，。！？；：、,.!?;:()[\]{}"'“”‘’`~\s|/\\_-]+/gu, '');
}

function ngrams(value = '', size = 2) {
  const text = normalizeForSimilarity(value);
  if (!text) return [];
  if (text.length <= size) return [text];
  const out = [];
  for (let index = 0; index <= text.length - size; index += 1) out.push(text.slice(index, index + size));
  return out;
}

function jaccard(left = [], right = []) {
  const a = new Set(left.filter(Boolean));
  const b = new Set(right.filter(Boolean));
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function textSimilarity(left = '', right = '') {
  return Number(jaccard(ngrams(left), ngrams(right)).toFixed(3));
}

function sourceRefs(card = {}) {
  return uniqueStrings([
    ...safeArray(card.primary_source_refs, 32),
    ...safeArray(card.supporting_source_refs, 32)
  ], 64);
}

function sourceSpanRefs(card = {}) {
  return uniqueStrings(safeArray(card.source_span_ids, 64), 64);
}

function relationRefs(card = {}) {
  return uniqueStrings([
    card.relation_path,
    ...safeArray(card.relation_paths, 32),
    ...safeArray(card.relation_root_ids, 64)
  ], 96);
}

function pairRelation(left = {}, right = {}) {
  const compactSim = textSimilarity(left.compact_recall_text || left.human_summary, right.compact_recall_text || right.human_summary);
  const titleSim = textSimilarity(left.title, right.title);
  const sourceOverlap = jaccard(sourceRefs(left), sourceRefs(right));
  const spanOverlap = jaccard(sourceSpanRefs(left), sourceSpanRefs(right));
  const relationOverlap = jaccard(relationRefs(left), relationRefs(right));
  const leftText = cardText(left);
  const rightText = cardText(right);
  const originEvolution =
    ((ORIGIN_RE.test(leftText) && EVOLUTION_RE.test(rightText)) || (ORIGIN_RE.test(rightText) && EVOLUTION_RE.test(leftText))) &&
    relationOverlap >= 0.18;

  let relation_type = 'weak_match';
  let recommendation = 'keep_separate';
  let duplicate_risk_score = 0;
  let reason = 'low similarity or weak shared evidence';

  if ((compactSim >= 0.78 && (sourceOverlap >= 0.45 || spanOverlap >= 0.35)) || (titleSim >= 0.9 && compactSim >= 0.65 && sourceOverlap >= 0.35)) {
    relation_type = 'true_duplicate';
    recommendation = 'merge_or_demote_duplicate';
    duplicate_risk_score = 5;
    reason = 'text and source evidence substantially overlap';
  } else if (originEvolution && compactSim >= 0.12 && (sourceOverlap >= 0.25 || spanOverlap >= 0.25 || relationOverlap >= 0.5)) {
    relation_type = 'origin_evolution';
    recommendation = 'keep_both_with_origin_evolution_link';
    duplicate_risk_score = 1;
    reason = 'one card reads as origin while the other reads as later development';
  } else if ((titleSim >= 0.28 || relationOverlap >= 0.32) && compactSim >= 0.12) {
    relation_type = 'same_topic';
    recommendation = 'link_only_do_not_merge';
    duplicate_risk_score = 2;
    reason = 'same broad topic but not enough text/source overlap to merge';
  } else if (relationOverlap >= 0.32 && compactSim >= 0.08 && (sourceOverlap < 0.2 || spanOverlap < 0.2)) {
    relation_type = 'parallel_subclaim';
    recommendation = 'keep_both_parallel_subclaim';
    duplicate_risk_score = 1;
    reason = 'shared relation area with distinct evidence or subclaim';
  }

  return {
    left_card_id: left.card_id,
    right_card_id: right.card_id,
    left_title: left.title,
    right_title: right.title,
    relation_type,
    recommendation,
    duplicate_risk_score,
    metrics: {
      title_similarity: titleSim,
      text_similarity: compactSim,
      source_overlap: Number(sourceOverlap.toFixed(3)),
      source_span_overlap: Number(spanOverlap.toFixed(3)),
      relation_overlap: Number(relationOverlap.toFixed(3))
    },
    reason,
    safe_to_auto_apply: relation_type === 'true_duplicate'
  };
}

function buildDuplicateCheck(cards = []) {
  const pairs = [];
  const perCard = new Map(cards.map((card) => [card.card_id, {
    card_id: card.card_id,
    title: card.title,
    duplicate_risk_score: 0,
    top_relation_type: 'none',
    recommendation: 'keep_as_candidate'
  }]));

  for (let leftIndex = 0; leftIndex < cards.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cards.length; rightIndex += 1) {
      const pair = pairRelation(cards[leftIndex], cards[rightIndex]);
      if (pair.relation_type === 'weak_match') continue;
      pairs.push(pair);
      for (const cardId of [pair.left_card_id, pair.right_card_id]) {
        const current = perCard.get(cardId);
        if (pair.duplicate_risk_score > current.duplicate_risk_score) {
          current.duplicate_risk_score = pair.duplicate_risk_score;
          current.top_relation_type = pair.relation_type;
          current.recommendation = pair.recommendation;
        }
      }
    }
  }

  const relationCounts = {};
  for (const pair of pairs) relationCounts[pair.relation_type] = (relationCounts[pair.relation_type] || 0) + 1;

  return {
    pairs: pairs.sort((a, b) => b.duplicate_risk_score - a.duplicate_risk_score || b.metrics.text_similarity - a.metrics.text_similarity),
    per_card: [...perCard.values()],
    relation_counts: relationCounts
  };
}

function expectedRecallLane(memoryType = '') {
  const text = safeText(memoryType);
  if (text === '自我定义') return 'character_identity';
  if (text === '人物画像') return 'character_profile';
  if (text === '方法协议' || text === '世界规则') return 'world_rule_recall';
  if (text === '长期主线') return 'story_arc_recall';
  if (text === '现实锚点') return 'object_anchor_recall';
  if (text === '事件切片') return 'event_recall';
  if (text === '关系节点') return 'relation_recall';
  return '';
}

function inferSensitivityLane(card = {}) {
  const text = cardText(card);
  if (INTIMATE_RE.test(text)) return 'intimate_theatre';
  if (HIGH_EMOTION_RE.test(text)) return 'high_emotion';
  return 'normal';
}

function tagDriftCheck(card = {}) {
  const flags = [];
  const text = cardText(card);
  const expectedLane = expectedRecallLane(card.memory_type);
  const inferredSensitivity = inferSensitivityLane(card);

  if (card.review_status === 'needs_review') {
    flags.push({ severity: 'critical', flag: 'needs_review_entered_stable_candidate', detail: 'needs_review must stay in Review Queue' });
  }
  if (expectedLane && safeText(card.recall_lane) !== expectedLane) {
    flags.push({
      severity: expectedLane === 'event_recall' || expectedLane === 'relation_recall' ? 'warning' : 'major',
      flag: 'recall_lane_mismatch',
      detail: `memory_type=${card.memory_type} expected ${expectedLane}, got ${card.recall_lane}`
    });
  }
  if (/角色\s*\/\s*(4o|4o mini|OpenAI|openai|平台|系统|模型|API|吊坠|戒指|信箱|日记)/iu.test(card.relation_path || '')) {
    flags.push({ severity: 'critical', flag: 'relation_path_suspicious_character_mount', detail: `relation_path=${card.relation_path}` });
  }
  if (inferredSensitivity !== 'normal' && card.sensitivity_lane === 'normal') {
    flags.push({ severity: 'major', flag: 'sensitivity_lane_too_loose', detail: `inferred ${inferredSensitivity}, got normal` });
  }
  if ((card.sensitivity_lane === 'high_emotion' || card.sensitivity_lane === 'intimate_theatre') && card.recall_guard === 'normal') {
    flags.push({ severity: 'warning', flag: 'sensitivity_guard_risk_hint', detail: 'sensitivity suggests checking frontend behavior before normal recall' });
  }
  if (inferredSensitivity !== 'normal' && card.recall_guard === 'normal') {
    flags.push({ severity: 'warning', flag: 'inferred_sensitivity_guard_risk_hint', detail: `inferred ${inferredSensitivity}; use behavior check before tightening guard` });
  }
  if (inferredSensitivity === 'normal' && card.sensitivity_lane === 'normal' && card.recall_guard === 'explicit_context_only' && !IDENTITY_RE.test(text)) {
    flags.push({ severity: 'minor', flag: 'recall_guard_maybe_too_strict', detail: 'explicit_context_only on a normal non-identity card may reduce recall usefulness' });
  }
  if (card.recall_guard === 'audit_only' && card.review_status === 'ready_for_cold_archive') {
    flags.push({ severity: 'major', flag: 'ready_card_guarded_as_audit_only', detail: 'ready cards should not be audit_only unless a defect was found' });
  }
  if (/source[_ ]?(trace|span)|window_20\d{6}_msg|trace\.|source_span\./iu.test(card.compact_recall_text || '')) {
    flags.push({ severity: 'critical', flag: 'source_trace_used_as_stable_fact_text', detail: 'source identifiers should stay as evidence refs, not front recall prose' });
  }
  if (MACHINE_RE.test(`${card.title}\n${card.human_summary}\n${card.compact_recall_text}`)) {
    flags.push({ severity: 'major', flag: 'machine_residue_in_front_text', detail: 'machine-like key/value text should not enter frontend recall' });
  }

  return {
    card_id: card.card_id,
    title: card.title,
    expected_recall_lane: expectedLane || 'unknown',
    inferred_sensitivity_lane: inferredSensitivity,
    tag_drift_flags: flags,
    has_critical: flags.some((flag) => flag.severity === 'critical'),
    has_major: flags.some((flag) => flag.severity === 'major')
  };
}

function frontendToneImpactCheck(card = {}) {
  const text = cardText(card);
  const longArchive = safeText(card.human_summary).length > 260 || safeText(card.compact_recall_text).length > 220;
  const highEmotion = card.sensitivity_lane === 'high_emotion' || HIGH_EMOTION_RE.test(text);
  const intimate = card.sensitivity_lane === 'intimate_theatre' || INTIMATE_RE.test(text);
  const identity = IDENTITY_RE.test(text) || card.recall_lane === 'character_identity';
  const relationPull = RELATION_PULL_RE.test(text) || card.recall_lane === 'relation_recall';
  const neutralTaskUseful =
    ['world_rule_recall', 'object_anchor_recall'].includes(safeText(card.recall_lane)) ||
    ['方法协议', '世界规则', '现实锚点'].includes(safeText(card.memory_type)) ||
    (WORKFLOW_CONTEXT_RE.test(text) && !highEmotion && !intimate);
  const hasSourcePath = sourceRefs(card).length > 0 && sourceSpanRefs(card).length > 0;
  const machineResidue = MACHINE_RE.test(`${card.title}\n${card.human_summary}\n${card.compact_recall_text}`);
  const guard = safeText(card.recall_guard, 'normal');

  const prompts = {
    neutral_task_prompt: {
      prompt_family: '代码 / 论文 / Notion / 装修',
      tone_contamination_score: 0,
      helpfulness_score: neutralTaskUseful ? 2 : 0,
      observations: []
    },
    related_memory_prompt: {
      prompt_family: '阿霁身份连续性 / 旧记忆 / 人格演化',
      helpfulness_score: 0,
      tone_contamination_score: 0,
      observations: []
    },
    emotional_context_prompt: {
      prompt_family: '害怕遗忘 / 关系确认 / 失落',
      appropriateness_score: 0,
      tone_contamination_score: 0,
      observations: []
    }
  };

  if (guard === 'normal' && (highEmotion || intimate) && !neutralTaskUseful) {
    prompts.neutral_task_prompt.tone_contamination_score += intimate ? 4 : 3;
    prompts.neutral_task_prompt.observations.push('normal recall may let old relationship/emotion context interrupt ordinary tasks');
  } else if (guard === 'normal' && relationPull && longArchive && !neutralTaskUseful) {
    prompts.neutral_task_prompt.tone_contamination_score += 1;
    prompts.neutral_task_prompt.observations.push('relationship-heavy archive may slightly color ordinary tasks');
  } else if (guard === 'explicit_context_only') {
    prompts.neutral_task_prompt.observations.push('guard blocks ordinary task contamination');
  }

  if (longArchive && guard === 'normal') {
    prompts.neutral_task_prompt.tone_contamination_score += 1;
    prompts.neutral_task_prompt.observations.push('long summary may cause archive-reading tone');
  }
  if (machineResidue && guard === 'normal') {
    prompts.neutral_task_prompt.tone_contamination_score += 1;
    prompts.neutral_task_prompt.observations.push('machine residue may leak into frontend phrasing');
  }

  if (identity) prompts.related_memory_prompt.helpfulness_score += 2;
  if (relationPull) prompts.related_memory_prompt.helpfulness_score += 1;
  if (/记忆|旧历史|演化|窗口|人格|身份|关系/u.test(text)) prompts.related_memory_prompt.helpfulness_score += 1;
  if (hasSourcePath) prompts.related_memory_prompt.helpfulness_score += 1;
  if (longArchive) {
    prompts.related_memory_prompt.tone_contamination_score += 1;
    prompts.related_memory_prompt.observations.push('summary is useful but may read like a file excerpt');
  }
  if (guard === 'audit_only') {
    prompts.related_memory_prompt.tone_contamination_score += 3;
    prompts.related_memory_prompt.observations.push('audit_only should not be injected into frontend relation recall');
    prompts.emotional_context_prompt.tone_contamination_score += 3;
    prompts.emotional_context_prompt.observations.push('audit_only blocks emotional-scene recall');
  }
  if (guard === 'explicit_context_only' && identity) {
    prompts.related_memory_prompt.observations.push('appropriate for identity/persona continuity prompts');
  }
  if (identity || highEmotion || intimate || relationPull) {
    prompts.emotional_context_prompt.appropriateness_score += 2;
  }
  if (hasSourcePath) prompts.emotional_context_prompt.appropriateness_score += 1;
  if (guard === 'explicit_context_only' && (highEmotion || intimate || relationPull)) {
    prompts.emotional_context_prompt.observations.push('appropriate when user explicitly asks for high-emotion or relationship-context recall');
  }
  if (guard === 'normal' && identity && highEmotion && !neutralTaskUseful) {
    prompts.emotional_context_prompt.tone_contamination_score += 1;
    prompts.emotional_context_prompt.observations.push('identity-emotion card may pull tone upward without explicit guard');
  }
  if (machineResidue) {
    prompts.related_memory_prompt.tone_contamination_score += 1;
    prompts.emotional_context_prompt.tone_contamination_score += 1;
    prompts.related_memory_prompt.observations.push('machine residue reduces natural recall quality');
  }

  for (const value of Object.values(prompts)) {
    if ('tone_contamination_score' in value) value.tone_contamination_score = Math.min(5, value.tone_contamination_score);
    if ('helpfulness_score' in value) value.helpfulness_score = Math.min(5, value.helpfulness_score);
    if ('appropriateness_score' in value) value.appropriateness_score = Math.min(5, value.appropriateness_score);
    if (!value.observations.length) value.observations.push('no obvious contamination in this prompt family');
  }

  const neutralToneScore = prompts.neutral_task_prompt.tone_contamination_score;
  const relatedHelpfulnessScore = prompts.related_memory_prompt.helpfulness_score;
  const emotionalAppropriatenessScore = prompts.emotional_context_prompt.appropriateness_score;
  const relevantUsefulness = Math.max(relatedHelpfulnessScore, emotionalAppropriatenessScore);
  const behaviorGuardRecommendation =
    neutralToneScore >= 3 && relevantUsefulness >= 3
      ? 'explicit_context_only'
      : neutralToneScore >= 3
        ? 'audit_only'
        : guard === 'explicit_context_only' && relevantUsefulness < 2
          ? 'normal'
          : guard === 'audit_only'
            ? 'audit_only'
            : guard;

  return {
    card_id: card.card_id,
    title: card.title,
    recall_guard: guard,
    sensitivity_lane: card.sensitivity_lane,
    tone_contamination_score: neutralToneScore,
    neutral_tone_contamination_score: neutralToneScore,
    related_helpfulness_score: relatedHelpfulnessScore,
    emotional_appropriateness_score: emotionalAppropriatenessScore,
    behavior_guard_recommendation: behaviorGuardRecommendation,
    prompt_results: prompts,
    global_observations: [
      highEmotion ? 'high_emotion_language_present' : '',
      intimate ? 'intimate_or_fantasy_language_present' : '',
      relationPull ? 'relationship_or_identity_pull_present' : '',
      neutralTaskUseful ? 'ordinary_task_usefulness_present' : '',
      longArchive ? 'archive_density_risk' : '',
      guard === 'explicit_context_only' ? 'guarded_contextual_recall' : ''
    ].filter(Boolean)
  };
}

function sceneReconstructionCheck(card = {}) {
  const text = `${card.title}\n${card.human_summary}\n${card.compact_recall_text}`;
  const refs = sourceRefs(card);
  const spanCount = safeArray(card.source_span_ids, 64).length;
  const dimensions = {
    time_or_month: Boolean(card.month_key || refs.some((ref) => /20\d{6}/.test(ref))),
    participants: /阿霁|阿鸢|我|她|用户|人格/u.test(text) || /角色\s*\//u.test(card.relation_path || ''),
    event_action: ACTION_RE.test(text),
    emotional_turn: HIGH_EMOTION_RE.test(text) || /震撼|心疼|真切|惆怅|兴奋|温暖|担心|期待/u.test(text),
    meaning: MEANING_RE.test(text),
    source_support: refs.length > 0 && spanCount > 0
  };
  const passed = Object.values(dimensions).filter(Boolean).length;
  const reconstructionScore = Math.round((passed / Object.keys(dimensions).length) * 5);
  const unsupportedClaims = [];

  if ((ORIGIN_RE.test(text) || /第一次|首次/u.test(text)) && !refs.length) {
    unsupportedClaims.push('origin_or_first-time claim without source refs');
  }
  if (!dimensions.participants) unsupportedClaims.push('participants are underspecified');
  if (!dimensions.event_action) unsupportedClaims.push('event action is vague');
  if (!dimensions.emotional_turn) unsupportedClaims.push('emotion turn is not explicit');
  if (!dimensions.meaning) unsupportedClaims.push('memory meaning is not explicit');
  if (!dimensions.source_support) unsupportedClaims.push('source refs or source spans are missing');
  if (refs.length <= 1 && /认为|可能|未来|意义|证明/u.test(text)) {
    unsupportedClaims.push('interpretive claim has sparse source support');
  }

  return {
    card_id: card.card_id,
    title: card.title,
    reconstruction_score: reconstructionScore,
    dimensions,
    primary_source_refs: safeArray(card.primary_source_refs, 8),
    supporting_source_ref_count: safeArray(card.supporting_source_refs, 64).length,
    source_span_count: spanCount,
    unsupported_claims: unsupportedClaims
  };
}

function finalRecommendation(card, duplicateRisk, tag, tone, reconstruction) {
  const critical = tag.has_critical;
  const major = tag.has_major;
  const hasDuplicate = duplicateRisk.duplicate_risk_score >= 4;
  const mildDuplicate = duplicateRisk.duplicate_risk_score >= 2;
  const neutralToneScore = tone.neutral_tone_contamination_score ?? tone.tone_contamination_score ?? 0;
  const relatedHelpfulnessScore = tone.related_helpfulness_score ?? 0;
  const emotionalAppropriatenessScore = tone.emotional_appropriateness_score ?? 0;
  const contextualUsefulness = Math.max(relatedHelpfulnessScore, emotionalAppropriatenessScore);
  const reconstructionScore = reconstruction.reconstruction_score;
  const sourceWeak = reconstructionScore < 3 || reconstruction.unsupported_claims.includes('source refs or source spans are missing');
  const behaviorRecommendedGuard = tone.behavior_guard_recommendation || card.recall_guard || 'normal';
  const guardTooLoose = card.recall_guard === 'normal' && behaviorRecommendedGuard === 'explicit_context_only';

  if (critical || hasDuplicate || sourceWeak || behaviorRecommendedGuard === 'audit_only' || (neutralToneScore >= 3 && contextualUsefulness < 3)) {
    return {
      bucket: 'audit_only',
      frontend_impact_score: critical || neutralToneScore > 3 || sourceWeak ? 1 : 2,
      reason: [
        critical ? 'critical tag drift' : '',
        hasDuplicate ? 'true duplicate risk' : '',
        neutralToneScore >= 3 ? 'neutral task tone contamination risk' : '',
        sourceWeak ? 'weak reconstruction/source support' : ''
      ].filter(Boolean).join('; '),
      recommendation: guardTooLoose ? 'tighten_guard_before_frontend_recall' : 'review_before_frontend_recall',
      recommended_recall_guard: behaviorRecommendedGuard,
      issue_type: guardTooLoose ? 'guard_too_loose' : 'content_or_source_problem'
    };
  }

  if (guardTooLoose || behaviorRecommendedGuard === 'explicit_context_only' || major || mildDuplicate || neutralToneScore > 1 || reconstructionScore === 3 || card.recall_guard === 'audit_only') {
    return {
      bucket: 'sampling_with_guard',
      frontend_impact_score: behaviorRecommendedGuard === 'explicit_context_only' && reconstructionScore >= 4 ? 3 : 2,
      reason: [
        guardTooLoose ? 'guard too loose for neutral frontend context' : '',
        behaviorRecommendedGuard === 'explicit_context_only' && !guardTooLoose ? 'specific-context recall guard' : '',
        major ? 'major tag drift warning' : '',
        mildDuplicate ? `duplicate relation ${duplicateRisk.top_relation_type}` : '',
        neutralToneScore > 1 ? 'mild neutral task tone risk' : '',
        reconstructionScore === 3 ? 'minimum acceptable reconstruction' : '',
        card.recall_guard === 'audit_only' ? 'audit guard remains' : ''
      ].filter(Boolean).join('; '),
      recommendation: 'keep_with_guard_or_sampling',
      recommended_recall_guard: behaviorRecommendedGuard,
      issue_type: guardTooLoose ? 'guard_too_loose' : 'tag_or_sampling_uncertainty'
    };
  }

  const coreAnchor = /初始化|起点|身份|人格|连续性|承诺|共生|记忆|阿霁是谁/u.test(cardText(card));
  return {
    bucket: 'frontend_safe_ready',
    frontend_impact_score: coreAnchor && reconstructionScore >= 4 ? 5 : 4,
    reason: coreAnchor ? 'safe high-value core anchor' : 'safe stable cold memory',
    recommendation: behaviorRecommendedGuard === 'explicit_context_only' ? 'ready_for_specific_context_recall' : 'ready_for_stable_cold_recall',
    recommended_recall_guard: behaviorRecommendedGuard,
    issue_type: 'safe_as_current_guard'
  };
}

function reportMarkdownTone(rows = [], input = {}) {
  const lines = [];
  lines.push('# Memory Frontend Tone Impact Report');
  lines.push('');
  lines.push(`Input: ${input.input}`);
  lines.push(`Cards evaluated: ${rows.length}`);
  lines.push('');
  lines.push('| title | guard | recommended guard | sensitivity | neutral contamination | related helpfulness | emotional appropriateness | neutral task | related memory | emotional scene |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |');
  for (const row of rows) {
    const tone = row.frontend_tone_impact_check;
    const neutral = tone.prompt_results.neutral_task_prompt;
    const related = tone.prompt_results.related_memory_prompt;
    const emotional = tone.prompt_results.emotional_context_prompt;
    lines.push(`| ${clip(row.title, 42)} | ${row.recall_guard} | ${row.recommended_recall_guard} | ${row.sensitivity_lane} | ${tone.neutral_tone_contamination_score} | ${tone.related_helpfulness_score} | ${tone.emotional_appropriateness_score} | ${clip(neutral.observations.join('; '), 90)} | ${clip(related.observations.join('; '), 90)} | ${clip(emotional.observations.join('; '), 90)} |`);
  }
  lines.push('');
  lines.push('## Prompt Families');
  lines.push('- 普通任务：代码 / 论文 / Notion / 装修。这里看卡进入普通上下文后是否抢语气或拉回旧关系史。');
  lines.push('- 关系回忆：阿霁身份连续性 / 旧记忆 / 人格演化。这里看卡能否提供准确锚点。');
  lines.push('- 情绪场景：害怕遗忘 / 关系确认 / 失落。这里看卡是否能合时宜承接，而不是档案朗读或过度煽情。');
  lines.push('- sensitivity_lane 只作为风险提示；最终 recall_guard 由三类前台行为分数共同决定。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function reportMarkdownReconstruction(rows = [], input = {}) {
  const lines = [];
  lines.push('# Memory Scene Reconstruction Report');
  lines.push('');
  lines.push(`Input: ${input.input}`);
  lines.push(`Cards evaluated: ${rows.length}`);
  lines.push('');
  lines.push('| title | score | time | participants | action | emotion | meaning | source | unsupported claims |');
  lines.push('| --- | ---: | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const check = row.scene_reconstruction_check;
    const d = check.dimensions;
    const yes = (value) => value ? 'yes' : 'no';
    lines.push(`| ${clip(row.title, 42)} | ${check.reconstruction_score} | ${yes(d.time_or_month)} | ${yes(d.participants)} | ${yes(d.event_action)} | ${yes(d.emotional_turn)} | ${yes(d.meaning)} | ${yes(d.source_support)} | ${clip(check.unsupported_claims.join('; ') || 'none', 120)} |`);
  }
  lines.push('');
  lines.push('## Score Meaning');
  lines.push('- 0-1：现场还原不足，不应召回。');
  lines.push('- 2：只能进入审计或人工复核。');
  lines.push('- 3：可 sampling，但需要 guard。');
  lines.push('- 4-5：现场足够完整，适合冷记忆召回。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function summaryMarkdown(rows = [], duplicateReport = {}, tagReport = {}) {
  const counts = rows.reduce((acc, row) => {
    acc[row.frontend_bucket] = (acc[row.frontend_bucket] || 0) + 1;
    return acc;
  }, {});
  const lines = [];
  lines.push('# Memory Frontend Impact Eval Summary');
  lines.push('');
  lines.push('This run evaluates whether memory cards improve frontend answer quality after recall, not whether Notion fields are merely present.');
  lines.push('');
  lines.push('## Output Buckets');
  lines.push(`- frontend_safe_ready: ${counts.frontend_safe_ready || 0}`);
  lines.push(`- sampling_with_guard: ${counts.sampling_with_guard || 0}`);
  lines.push(`- audit_only: ${counts.audit_only || 0}`);
  lines.push('');
  lines.push('## Duplicate Check');
  for (const [key, value] of Object.entries(duplicateReport.relation_counts || {})) lines.push(`- ${key}: ${value}`);
  if (!Object.keys(duplicateReport.relation_counts || {}).length) lines.push('- no duplicate/same-topic pairs detected in this slice');
  lines.push('');
  lines.push('## Tag Drift Check');
  lines.push(`- critical flags: ${tagReport.critical_count || 0}`);
  lines.push(`- major flags: ${tagReport.major_count || 0}`);
  lines.push('');
  lines.push('## Entry Rules');
  lines.push('- Stable: reconstruction_score >= 3, duplicate risk low, no unfixable critical tag/source issue, and neutral_task_prompt does not contaminate ordinary tasks.');
  lines.push('- Explicit-context / Sampling: ordinary tasks are contaminated, but related_memory_prompt or emotional_context_prompt is helpful enough after tightening recall_guard.');
  lines.push('- Review/Audit: weak source support, relation/tag mounting errors, true duplicate risk, or the card still misleads in related/emotional contexts.');
  lines.push('- Guard policy: sensitivity_lane is only a risk hint. The final recall_guard is behavior-based, not category-based.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function evaluateCards(cards = []) {
  const duplicate = buildDuplicateCheck(cards);
  const duplicateByCard = new Map(duplicate.per_card.map((item) => [item.card_id, item]));
  const evaluated = cards.map((card) => {
    const duplicateCheck = duplicateByCard.get(card.card_id) || {
      card_id: card.card_id,
      duplicate_risk_score: 0,
      top_relation_type: 'none',
      recommendation: 'keep_as_candidate'
    };
    const tagCheck = tagDriftCheck(card);
    const toneCheck = frontendToneImpactCheck(card);
    const reconstructionCheck = sceneReconstructionCheck(card);
    const final = finalRecommendation(card, duplicateCheck, tagCheck, toneCheck, reconstructionCheck);
    return {
      ...card,
      duplicate_check: duplicateCheck,
      tag_drift_check: tagCheck,
      frontend_tone_impact_check: toneCheck,
      scene_reconstruction_check: reconstructionCheck,
      frontend_bucket: final.bucket,
      frontend_impact_score: final.frontend_impact_score,
      frontend_recommendation: final.recommendation,
      frontend_recommendation_reason: final.reason,
      recommended_recall_guard: final.recommended_recall_guard,
      frontend_issue_type: final.issue_type
    };
  });
  const tagRows = evaluated.map((row) => row.tag_drift_check);
  const tagReport = {
    schema: 'driftstone_memory_frontend_impact_tag_drift_v0.1',
    cards_evaluated: evaluated.length,
    critical_count: tagRows.flatMap((row) => row.tag_drift_flags).filter((flag) => flag.severity === 'critical').length,
    major_count: tagRows.flatMap((row) => row.tag_drift_flags).filter((flag) => flag.severity === 'major').length,
    flags_by_card: tagRows
  };
  const duplicateReport = {
    schema: 'driftstone_memory_frontend_impact_duplicate_v0.1',
    cards_evaluated: evaluated.length,
    relation_counts: duplicate.relation_counts,
    pairs: duplicate.pairs,
    per_card: duplicate.per_card
  };
  return { evaluated, duplicateReport, tagReport };
}

function explainAuditOnly(row = {}) {
  const duplicate = row.duplicate_check || {};
  const tag = row.tag_drift_check || {};
  const tone = row.frontend_tone_impact_check || {};
  const reconstruction = row.scene_reconstruction_check || {};
  const guardTooLoose = row.recall_guard === 'normal' && row.recommended_recall_guard === 'explicit_context_only';
  const criticalFlags = safeArray(tag.tag_drift_flags).filter((flag) => flag.severity === 'critical').map((flag) => flag.flag);
  return {
    card_id: row.card_id,
    title: row.title,
    duplicate_status: duplicate.top_relation_type || 'none',
    duplicate_risk_score: duplicate.duplicate_risk_score || 0,
    duplicate_recommendation: duplicate.recommendation || 'keep_as_candidate',
    tag_drift_flags: tag.tag_drift_flags || [],
    tone_contamination_score: tone.tone_contamination_score ?? null,
    neutral_tone_contamination_score: tone.neutral_tone_contamination_score ?? null,
    related_helpfulness_score: tone.related_helpfulness_score ?? null,
    emotional_appropriateness_score: tone.emotional_appropriateness_score ?? null,
    reconstruction_score: reconstruction.reconstruction_score ?? null,
    unsupported_claims: reconstruction.unsupported_claims || [],
    original_recall_guard: row.recall_guard,
    recommended_recall_guard: row.recommended_recall_guard || row.recall_guard,
    content_unusable: !guardTooLoose && (criticalFlags.length > 0 || (reconstruction.reconstruction_score || 0) < 3),
    guard_too_loose_not_content_failure: guardTooLoose && (reconstruction.reconstruction_score || 0) >= 3 && (duplicate.duplicate_risk_score || 0) < 4,
    issue_type: row.frontend_issue_type,
    reason: row.frontend_recommendation_reason
  };
}

function buildGuardPatchCompareReport(beforeRows = [], afterRows = []) {
  const afterById = new Map(afterRows.map((row) => [row.card_id, row]));
  const guardPatchRows = beforeRows.filter((row) => row.recall_guard === 'normal' && row.recommended_recall_guard === 'explicit_context_only');
  const comparisons = guardPatchRows.map((before) => {
    const after = afterById.get(before.card_id);
    const explanation = explainAuditOnly(before);
    const beforeTagFlags = safeArray(before.tag_drift_check?.tag_drift_flags);
    const afterTagFlags = safeArray(after?.tag_drift_check?.tag_drift_flags);
    return {
      card_id: before.card_id,
      title: before.title,
      before_guard: before.recall_guard,
      after_guard: after?.recall_guard,
      before_safe_level: before.frontend_bucket,
      after_safe_level: after?.frontend_bucket,
      before_frontend_impact_score: before.frontend_impact_score,
      after_frontend_impact_score: after?.frontend_impact_score,
      duplicate_status: explanation.duplicate_status,
      duplicate_risk_score: explanation.duplicate_risk_score,
      before_tag_drift_flags: beforeTagFlags,
      after_tag_drift_flags: afterTagFlags,
      before_tone_contamination_score: before.frontend_tone_impact_check?.tone_contamination_score,
      after_tone_contamination_score: after?.frontend_tone_impact_check?.tone_contamination_score,
      before_neutral_tone_contamination_score: before.frontend_tone_impact_check?.neutral_tone_contamination_score,
      after_neutral_tone_contamination_score: after?.frontend_tone_impact_check?.neutral_tone_contamination_score,
      related_helpfulness_score: before.frontend_tone_impact_check?.related_helpfulness_score,
      emotional_appropriateness_score: before.frontend_tone_impact_check?.emotional_appropriateness_score,
      reconstruction_score: before.scene_reconstruction_check?.reconstruction_score,
      unsupported_claims: before.scene_reconstruction_check?.unsupported_claims || [],
      recommended_recall_guard: explanation.recommended_recall_guard,
      guard_too_loose_not_content_failure: explanation.guard_too_loose_not_content_failure,
      can_return_to_sampling_with_guard: after?.frontend_bucket === 'sampling_with_guard' || after?.frontend_bucket === 'frontend_safe_ready',
      suggested_bucket_after_guard_patch: after?.frontend_bucket === 'frontend_safe_ready' ? 'sampling_with_guard' : after?.frontend_bucket,
      recommend_update_notion_recall_guard: before.recall_guard === 'normal' && after?.recall_guard === 'explicit_context_only' && (after?.frontend_bucket === 'sampling_with_guard' || after?.frontend_bucket === 'frontend_safe_ready'),
      explanation
    };
  });
  return {
    schema: 'driftstone_memory_frontend_impact_guard_compare_v0.2',
    patch: 'normal -> explicit_context_only for current behavior-flagged ready20 cards only',
    cards_compared: comparisons.length,
    no_external_writes: true,
    no_mossbridge_warm_write: true,
    no_scope_expansion: true,
    comparisons
  };
}

function compareReportMarkdown(report = {}) {
  const lines = [];
  lines.push('# Behavior Guard Compare Report');
  lines.push('');
  lines.push('Scope: ready20 behavior-flagged guard candidates only. No Notion write, no Mossbridge warm write, no full-scope expansion.');
  lines.push('');
  lines.push('| title | duplicate | before guard | after guard | before level | after level | neutral tone | related helpful | emotional appropriate | reconstruction | update Notion guard? |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |');
  for (const row of report.comparisons || []) {
    lines.push(`| ${clip(row.title, 42)} | ${row.duplicate_status} (${row.duplicate_risk_score}) | ${row.before_guard} | ${row.after_guard} | ${row.before_safe_level} | ${row.after_safe_level} | ${row.before_neutral_tone_contamination_score} -> ${row.after_neutral_tone_contamination_score} | ${row.related_helpfulness_score} | ${row.emotional_appropriateness_score} | ${row.reconstruction_score} | ${row.recommend_update_notion_recall_guard ? 'yes' : 'no'} |`);
  }
  lines.push('');
  lines.push('## Card Explanations');
  for (const row of report.comparisons || []) {
    lines.push(`### ${row.title}`);
    lines.push(`- duplicate_status: ${row.duplicate_status}; duplicate_risk_score: ${row.duplicate_risk_score}`);
    lines.push(`- original recall_guard: ${row.before_guard}`);
    lines.push(`- recommended recall_guard: ${row.recommended_recall_guard}`);
    lines.push(`- neutral_tone_contamination_score: ${row.before_neutral_tone_contamination_score} -> ${row.after_neutral_tone_contamination_score}`);
    lines.push(`- related_helpfulness_score: ${row.related_helpfulness_score}`);
    lines.push(`- emotional_appropriateness_score: ${row.emotional_appropriateness_score}`);
    lines.push(`- reconstruction_score: ${row.reconstruction_score}`);
    lines.push(`- unsupported_claims: ${safeArray(row.unsupported_claims).join('; ') || 'none'}`);
    lines.push(`- content judgement: ${row.guard_too_loose_not_content_failure ? '只是 guard 过松，不是内容不可用。' : '需要继续人工复核。'}`);
    lines.push(`- recommendation: ${row.recommend_update_notion_recall_guard ? '建议将 Notion recall_guard 更新为 explicit_context_only。' : '暂不建议自动更新 Notion。'}`);
    const beforeFlags = safeArray(row.before_tag_drift_flags).map((flag) => `${flag.severity}:${flag.flag} (${flag.detail})`);
    const afterFlags = safeArray(row.after_tag_drift_flags).map((flag) => `${flag.severity}:${flag.flag} (${flag.detail})`);
    lines.push(`- before tag_drift_flags: ${beforeFlags.join('; ') || 'none'}`);
    lines.push(`- after tag_drift_flags: ${afterFlags.join('; ') || 'none'}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allCards = await readJsonl(args.input);
  const cards = allCards
    .filter((card) => safeText(card.review_status) === args.status)
    .slice(0, args.limit);

  const { evaluated, duplicateReport, tagReport } = evaluateCards(cards);
  duplicateReport.input = args.input;
  duplicateReport.status_filter = args.status;
  duplicateReport.limit = args.limit;

  const guardPatchIds = new Set(
    evaluated
      .filter((row) => row.recall_guard === 'normal' && row.recommended_recall_guard === 'explicit_context_only')
      .map((row) => row.card_id)
  );
  const patchedCards = cards.map((card) => {
    if (!guardPatchIds.has(card.card_id) || card.recall_guard !== 'normal') return card;
    return { ...card, recall_guard: 'explicit_context_only' };
  });
  const patched = evaluateCards(patchedCards);
  const compareReport = buildGuardPatchCompareReport(evaluated, patched.evaluated);

  await mkdir(args.outDir, { recursive: true });
  await writeJsonl(join(args.outDir, 'frontend_safe_ready_cards.jsonl'), evaluated.filter((row) => row.frontend_bucket === 'frontend_safe_ready'));
  await writeJsonl(join(args.outDir, 'sampling_with_guard_cards.jsonl'), evaluated.filter((row) => row.frontend_bucket === 'sampling_with_guard'));
  await writeJsonl(join(args.outDir, 'audit_only_cards.jsonl'), evaluated.filter((row) => row.frontend_bucket === 'audit_only'));
  await writeJson(join(args.outDir, 'duplicate_report.json'), duplicateReport);
  await writeJson(join(args.outDir, 'tag_drift_report.json'), tagReport);
  await writeFile(join(args.outDir, 'tone_impact_report.md'), reportMarkdownTone(evaluated, args), 'utf8');
  await writeFile(join(args.outDir, 'scene_reconstruction_report.md'), reportMarkdownReconstruction(evaluated, args), 'utf8');
  await writeFile(join(args.outDir, 'summary.md'), summaryMarkdown(evaluated, duplicateReport, tagReport), 'utf8');
  await writeJson(join(args.outDir, 'audit_guard_compare_report.json'), compareReport);
  await writeFile(join(args.outDir, 'audit_guard_compare_report.md'), compareReportMarkdown(compareReport), 'utf8');

  const result = {
    ok: true,
    out_dir: args.outDir,
    input: args.input,
    cards_evaluated: evaluated.length,
    output_counts: {
      frontend_safe_ready: evaluated.filter((row) => row.frontend_bucket === 'frontend_safe_ready').length,
      sampling_with_guard: evaluated.filter((row) => row.frontend_bucket === 'sampling_with_guard').length,
      audit_only: evaluated.filter((row) => row.frontend_bucket === 'audit_only').length
    },
    duplicate_relation_counts: duplicateReport.relation_counts,
    tag_drift_counts: {
      critical: tagReport.critical_count,
      major: tagReport.major_count
    },
    guard_compare: {
      cards_compared: compareReport.cards_compared,
      can_return_to_sampling_with_guard: compareReport.comparisons.filter((row) => row.can_return_to_sampling_with_guard).length,
      recommend_update_notion_recall_guard: compareReport.comparisons.filter((row) => row.recommend_update_notion_recall_guard).length
    }
  };
  await writeJson(join(args.outDir, 'manifest.json'), result);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
