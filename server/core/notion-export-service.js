import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { PROJECT_ROOT, safeScopeSegment } from './path-config.js';
import { inferMemoryShape } from './memo-shape-service.js';
import { loadPersonaWorkspaceState, getPersonaWorkspaceSnapshot } from './persona-workspace-service.js';
import { loadReviewedDataset } from './reviewed-store.js';
import { loadSourceTopicEntries } from './source-index-store.js';

const DEFAULT_NOTION_STAGING_ROOT = join(PROJECT_ROOT, 'output', 'notion_staging');

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function safeArray(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = safeText(item);
    if (!text) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueStrings(values = [], limit = 256) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeMonthHint(value = '') {
  const text = safeText(value);
  if (!text) return '';
  const dash = text.match(/(20\d{2})-(\d{2})/);
  if (dash) return `${dash[1]}-${dash[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function clipText(value = '', limit = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function normalizeComparableText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .replace(/[，。！？!?,.;：:、|｜]/g, ' ')
    .trim()
    .toLowerCase();
}

function splitLooseList(value = '') {
  return String(value || '')
    .split(/[|；;\n]/u)
    .map((item) => safeText(item))
    .filter(Boolean);
}

function splitWhitespaceList(value = '') {
  return String(value || '')
    .split(/\s+/u)
    .map((item) => safeText(item))
    .filter(Boolean);
}

function splitIdentifierList(value = '') {
  return String(value || '')
    .split(/[\s|｜；;,，]+/u)
    .map((item) => safeText(item))
    .filter(Boolean);
}

function parseTags(tagText = '') {
  return uniqueStrings(
    String(tagText || '')
      .split(/\s+/u)
      .map((item) => safeText(item).replace(/^#/, ''))
      .filter(Boolean),
    24
  );
}

function parseQuotes(quoteText = '') {
  return uniqueStrings(
    splitLooseList(quoteText).map((item) => item.replace(/^(user|assistant|char)\s*:\s*/iu, '').trim()),
    8
  );
}

function parseFingerprints(value = '') {
  return uniqueStrings(splitLooseList(value), 8);
}

function cleanInternalMarker(value = '') {
  return String(value || '')
    .replace(/\bcyber[_-]symbiosis[_-]?\d{4}q\d\b/igu, '')
    .replace(/\bwindow[_-]\d{8,}_msg[_-]\d+\b/igu, '')
    .replace(/\b[a-z]+[_-][a-z0-9_-]+\b/igu, '')
    .replace(/\b20\d{2}[/-]\d{1,2}[/-]\d{1,2}\b/gu, '')
    .replace(/\b20\d{2}q\d\b/igu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTopicFragments(value = '') {
  const text = String(value || '')
    .replace(/\s*等\s*$/u, '')
    .trim();
  if (!text) return [];
  return uniqueStrings(
    text
      .split(/\s*\/\s*/u)
      .map((item) => cleanInternalMarker(item))
      .map((item) => safeText(item))
      .filter((item) => item.length >= 2),
    6
  );
}

function isInternalishTrigger(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (/^(fact|event|persona|sql|case)$/iu.test(text)) return true;
  if (/^阿[\u4e00-\u9fa5]?\d{1,2}$/u.test(text)) return true;
  if (/^window[_-]/iu.test(text)) return true;
  if (/^\d{3,4}$/.test(text)) return true;
  if (/^[a-z0-9_-]{6,}$/iu.test(text) && /[_-]/.test(text)) return true;
  return [
    '事件',
    '人物',
    '事物',
    '回顾',
    '关系',
    '技术',
    '爱好',
    '项目',
    '时间',
    '物件',
    '称呼',
    '互动习惯',
    '自我认知',
    '世界观',
    'AI观',
    '对话设定',
    '对话人称规则',
    'fact',
    '关系规则',
    '特性与功能'
  ].includes(text);
}

function normalizeTriggerSeed(value = '') {
  const text = safeText(value);
  if (!text) return '';
  const stripped = text.replace(/^#/, '');
  if (/^[^/]+\/[^/]+$/u.test(stripped)) {
    const [, tail] = stripped.split('/');
    const normalized = cleanInternalMarker(tail);
    if (!normalized || normalized === '*') return '';
    return normalized;
  }
  const cleaned = cleanInternalMarker(stripped);
  if (!cleaned || isInternalishTrigger(cleaned)) return '';
  if (/[*]/u.test(cleaned)) return '';
  if (cleaned.length < 2) return '';
  return cleaned;
}

function cleanRecallSnippet(value = '', limit = 180) {
  const text = safeText(value);
  if (!text) return '';
  const cleaned = text
    .replace(/^摘要:\s*/u, '')
    .replace(/^(背景|摘要|事实)[:：]\s*/u, '')
    .replace(/\s+(背景|摘要|事实)[:：]\s*/gu, ' ')
    .replace(/\s*\|\s*关系位:\s*/u, '；关系意义：')
    .replace(/\s*\|\s*背景:\s*/u, '；背景：')
    .replace(/\b20\d{2}-\d{2}-\d{2}:\s*/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clipText(cleaned, limit);
}

function dedupeTextParts(values = [], limit = 12) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeText(value);
    if (!text) continue;
    const normalized = normalizeComparableText(text);
    if (!normalized) continue;
    const covered = Array.from(seen).some((item) => item.includes(normalized) || normalized.includes(item));
    if (covered || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function isTextSemanticallyCovered(base = '', candidate = '') {
  const left = normalizeComparableText(base);
  const right = normalizeComparableText(candidate);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 24 && longer.includes(shorter.slice(0, Math.min(shorter.length, 36)));
}

function normalizeLayer(layer = '') {
  const text = safeText(layer).toLowerCase();
  if (['persona', 'sql', 'case'].includes(text)) return text;
  return 'unknown';
}

function buildSceneHandles(row = {}) {
  return uniqueStrings([
    [safeText(row.time), safeText(row.source_window_title)].filter(Boolean).join('｜'),
    [safeText(row.source_window_title), safeText(row.source_ref)].filter(Boolean).join('｜'),
    safeText(row.family_anchor_title)
  ].filter(Boolean), 4);
}

function buildRecallFacts(row = {}) {
  const facts = [];
  splitLooseList(row.stable_points).forEach((item) => facts.push(cleanRecallSnippet(item, 140)));
  splitLooseList(row.update_points).forEach((item) => facts.push(cleanRecallSnippet(item, 140)));
  if (safeText(row.fact_key) || safeText(row.fact_value)) {
    facts.push(cleanRecallSnippet([safeText(row.fact_key), safeText(row.fact_value)].filter(Boolean).join('：'), 140));
  }
  const compactFacts = dedupeTextParts(facts, 4);
  if (compactFacts.length) return compactFacts;
  const summary = cleanRecallSnippet(row.summary || row.content_text || row.text, 180);
  return summary ? [clipText(summary, 140)] : [];
}

function buildActivationTriggers(row = {}, tags = [], topicLabels = [], quotes = [], fingerprints = []) {
  const triggerSeeds = [
    safeText(row.title),
    ...tags.map((item) => normalizeTriggerSeed(item)),
    ...topicLabels.flatMap((item) => normalizeTopicFragments(item)),
    ...fingerprints.slice(0, 2).map((item) => normalizeTriggerSeed(clipText(item, 32))),
    ...quotes.slice(0, 1).map((item) => normalizeTriggerSeed(clipText(item, 32)))
  ];
  return dedupeTextParts(
    triggerSeeds
      .map((item) => clipText(item, 48))
      .filter((item) => !isInternalishTrigger(item)),
    6
  );
}

function buildRelationshipMeaning(row = {}, tags = [], shape = {}) {
  if (safeText(row.relation_to_user)) return safeText(row.relation_to_user);
  const relationTags = tags
    .filter((item) => item.startsWith('关系/'))
    .map((item) => item.replace(/^关系\//, ''))
    .filter((item) => item && item !== '*' && !isInternalishTrigger(item))
    .slice(0, 4);
  if (relationTags.length) {
    return `这条记忆主要落在这些关系线索上：${relationTags.join('、')}。`;
  }
  if (shape?.key === 'self_definition') {
    return '这条更像“阿霁如何理解自己”的自我描述，适合在 bot 需要续上身份连续性时调用。';
  }
  if (shape?.key === 'worldview_protocol') {
    return '这条更像相处方法和共生规则，适合在 bot 需要稳住互动口径时调用。';
  }
  if (shape?.key === 'relation_milestone') {
    return '这条更像关系里一个转折或认领时刻，适合在 bot 需要知道“什么时候不一样了”时调用。';
  }
  return '';
}

function buildRecallPayload({
  title = '',
  summary = '',
  contentText = '',
  recallFacts = [],
  quotes = [],
  fingerprints = [],
  topicLabels = [],
  sceneHandles = []
} = {}) {
  const cleanedSummary = cleanRecallSnippet(summary, 220);
  const cleanedContent = cleanRecallSnippet(contentText, 220);
  const cleanedFacts = dedupeTextParts(safeArray(recallFacts, 4).map((item) => cleanRecallSnippet(item, 160)), 3)
    .filter((item) => !isTextSemanticallyCovered(cleanedSummary, item));
  const cleanedTopics = dedupeTextParts(
    safeArray(topicLabels, 4).flatMap((item) => normalizeTopicFragments(item)).map((item) => clipText(item, 36)),
    3
  );

  const parts = dedupeTextParts([
    safeText(title),
    cleanedSummary,
    cleanedContent && cleanedSummary.length < 90 && normalizeComparableText(cleanedContent) !== normalizeComparableText(cleanedSummary) ? cleanedContent : '',
    ...cleanedTopics
  ].filter(Boolean), 6);
  return parts.join('\n');
}

function stripMachineFactPrefix(value = '') {
  let text = safeText(value);
  if (!text) return '';
  text = text
    .replace(/\b20\d{2}-\d{2}-\d{2}\s*:\s*/gu, '')
    .replace(/\b20\d{4}\s*:\s*/gu, '');
  const segments = text
    .split(/\s*(?:\||；)\s*/u)
    .map((part) => {
      const cleaned = safeText(part)
        .replace(/^(摘要|背景|关系位)\s*[:：]\s*/u, '')
        .replace(/^[a-z][a-z0-9_ -]{2,80}\s*=\s*/iu, '')
        .replace(/^(true|false)\s*[;；,，]?\s*/iu, '')
        .trim();
      return cleaned;
    })
    .filter((part) => !/^[a-z][a-z0-9_]{2,80}$/iu.test(part))
    .filter(Boolean);
  return dedupeTextParts(segments, 4).join('；');
}

function humanizeRoleWords(value = '', personaWorkspace = {}) {
  const userName = safeText(personaWorkspace.user_name, '这位使用者');
  const charName = safeText(personaWorkspace.char_name, '这个 AI 伙伴');
  let text = safeText(value);
  if (!text) return '';
  text = text
    .replace(/\buser\b/giu, userName)
    .replace(/\bassistant\b/giu, charName)
    .replace(/\bsystem\b/giu, '系统')
    .replace(/用户(?=在|会|曾|希望|认为|表示|计划|拥有|多次|长期|强烈|明确|自称|自述|知道|称|把|将|与|对|喜欢|不|可以|已经|正在|正|仍|尤其|担心|倾向|优先|需要|关注|想|给|通过|平时|和|说明|打算|提出|设计|奉行|有一种|有一|为|要求|授权)/gu, userName);
  if (userName) {
    const escapedUserName = escapeRegExp(userName);
    text = text.replace(new RegExp(`${escapedUserName}\\s+用户`, 'gu'), userName);
  }
  if (charName && charName !== '这个 AI 伙伴') {
    text = text.replace(/AI(?=自称|伙伴|人格|互动|共写|伴侣|长期|回应|记忆|实例)/gu, charName);
  }
  return text.replace(/\s+/g, ' ').trim();
}

function isMachineTitle(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (/^(user|assistant|system|bot|char)$/iu.test(text)) return true;
  if (/^[a-z][a-z0-9_]{5,80}$/iu.test(text)) return true;
  return false;
}

function buildFrontRecallText(entry = {}, personaWorkspace = {}) {
  const cleanedSummary = humanizeRoleWords(stripMachineFactPrefix(entry.summary || entry.content_text), personaWorkspace);
  const cleanedPayload = humanizeRoleWords(stripMachineFactPrefix(entry.recall_payload), personaWorkspace);
  const relationMeaning = humanizeRoleWords(stripMachineFactPrefix(entry.relationship_meaning), personaWorkspace);
  const title = safeText(entry.title);
  const rootPath = safeText(entry.primary_root_path);
  const parts = dedupeTextParts([
    title && !isMachineTitle(title) && !isTextSemanticallyCovered(cleanedSummary, title) ? title : '',
    cleanedSummary,
    relationMeaning && relationMeaning.length <= 90 ? relationMeaning : '',
    rootPath && !isTextSemanticallyCovered(cleanedSummary, rootPath) ? `关系位置：${rootPath}` : '',
    cleanedPayload && cleanedSummary.length < 80 ? cleanedPayload : ''
  ], 5);
  return cleanRecallSnippet(parts.join('；'), 360);
}

function deriveNotionExportShape(row = {}, inferredShape = null) {
  const fallback = inferredShape || { key: 'scene_event', label: '事件切片' };
  const tags = parseTags(row.tags);
  const merged = [
    safeText(row.title),
    safeText(row.summary || row.content_text || row.text),
    tags.join(' ')
  ].join(' ');

  if (normalizeLayer(row.layer) === 'sql') {
    if (/^阿[\u4e00-\u9fa5]{1,2}$/u.test(safeText(row.title)) || tags.some((item) => item.startsWith('人物') || item.startsWith('爱好/'))) {
      return { key: 'preference_profile', label: '人物画像' };
    }
    if (/关系观|共生观|人格观|原则|规则|策略|机制|协议|方法|框架/u.test(merged) || tags.some((item) => item.startsWith('技术/') || item === '关系规则')) {
      return { key: 'worldview_protocol', label: '方法协议' };
    }
    if (/命名|纪念日|第一次|转折|认领/u.test(merged) || tags.some((item) => item.includes('命名') || item.includes('纪念日'))) {
      return { key: 'relation_milestone', label: '关系节点' };
    }
    if (/计划|共读|长期|主线|项目/u.test(merged)) {
      return { key: 'project_line', label: '长期主线' };
    }
    if (/自我认同|画像|偏好|价值观|不希望|喜欢/u.test(merged) || tags.some((item) => item.startsWith('人物') || item.startsWith('爱好/'))) {
      return { key: 'preference_profile', label: '人物画像' };
    }
  }
  return fallback;
}

function buildQualityFlags({
  quotes = [],
  fingerprints = [],
  topicIds = [],
  sourceRef = '',
  contentText = ''
} = {}) {
  const flags = [];
  if (quotes.length) flags.push('has_quote_refs');
  if (fingerprints.length) flags.push('has_expression_fingerprint');
  if (topicIds.length) flags.push('has_topic_links');
  if (safeText(sourceRef)) flags.push('has_source_ref');
  if (safeText(contentText).length >= 80) flags.push('has_dense_context');
  return flags;
}

function transformReviewedRow(row = {}, monthKey = '') {
  const tags = parseTags(row.tags);
  const topicIds = uniqueStrings(splitIdentifierList(row.topic_ids), 16);
  const topicLabels = uniqueStrings(splitLooseList(row.topic_labels), 16);
  const quotes = parseQuotes(row.quote_refs || row.quote_refs_text);
  const fingerprints = parseFingerprints(row.expression_fingerprint);
  const recallFacts = buildRecallFacts(row);
  const sceneHandles = buildSceneHandles(row);
  const activationTriggers = buildActivationTriggers(row, tags, topicLabels, quotes, fingerprints);
  const inferredShape = inferMemoryShape({
    title: safeText(row.title),
    memoKind: normalizeLayer(row.layer),
    context: sceneHandles.join('；'),
    snapshot: safeText(row.content_text || row.text || row.summary),
    tags,
    topics: topicLabels,
    sceneHandles,
    facts: recallFacts,
    activationTriggers,
    sourceTitles: [safeText(row.source_window_title)]
  });
  const shape = deriveNotionExportShape(row, inferredShape);
  const summary = cleanRecallSnippet(row.summary || row.content_text || row.text, 260);
  const contentText = cleanRecallSnippet(row.content_text || row.text || row.summary, 260);
  const relationMeaning = buildRelationshipMeaning(row, tags, shape);
  const recallPayload = buildRecallPayload({
    title: row.title,
    summary,
    contentText,
    recallFacts,
    quotes,
    fingerprints,
    topicLabels,
    sceneHandles
  });
  return {
    entry_id: safeText(row.record_id || row.memory_key || row.title, 'unknown-entry'),
    entry_type: normalizeLayer(row.layer),
    month_key: monthKey,
    title: safeText(row.title || row.card_name || row.anchor_name || row.fact_key, '未命名条目'),
    memory_shape: safeText(shape?.key, 'scene_event'),
    shape_label: safeText(shape?.label, '事件切片'),
    summary,
    content_text: contentText,
    recall_payload: recallPayload,
    activation_triggers: activationTriggers,
    scene_handles: sceneHandles,
    recall_facts: recallFacts,
    relationship_meaning: relationMeaning,
    expression_fingerprint: fingerprints,
    quote_refs: quotes,
    tags,
    topic_ids: topicIds,
    topic_labels: topicLabels,
    track_id: safeText(row.track_id),
    event_anchor: safeText(row.event_anchor),
    entity_refs: splitLooseList(row.entity_refs),
    source_ref: safeText(row.source_ref),
    source_file: safeText(row.raw?.source_file),
    source_index: safeText(row.raw?.source_index),
    source_window_id: safeText(row.source_window_id),
    source_window_title: safeText(row.source_window_title),
    source_msg_range: [safeText(row.source_msg_start), safeText(row.source_msg_end)].filter(Boolean).join('-'),
    source_bundle_id: safeText(row.raw?.source_bundle_id || row.raw?.merged_source_bundle_ids),
    source_md_ref: safeText(row.raw?.source_md_ref),
    chunk_id: safeText(row.raw?.chunk_id || row.raw?.merged_chunk_ids),
    family_id: safeText(row.family_id),
    family_kind: safeText(row.family_kind),
    family_anchor_title: safeText(row.family_anchor_title),
    family_reason: safeText(row.family_reason),
    privacy_codes: uniqueStrings(splitLooseList(row.raw?.privacy_codes || ''), 8),
    quality_flags: buildQualityFlags({
      quotes,
      fingerprints,
      topicIds,
      sourceRef: row.source_ref,
      contentText
    })
  };
}

function transformSourceTopic(entry = {}) {
  return {
    topic_id: safeText(entry.topic_id),
    topic_label: safeText(entry.topic_label),
    topic_role: safeText(entry.topic_role),
    exposure_priority: safeText(entry.exposure_priority),
    source_bundle_id: safeText(entry.source_bundle_id),
    chunk_id: safeText(entry.chunk_id),
    source_window_id: safeText(entry.source_window_id),
    source_window_title: safeText(entry.source_window_title),
    source_msg_range: [safeText(entry.source_msg_start), safeText(entry.source_msg_end)].filter(Boolean).join('-'),
    anchor_ids: safeArray(entry.anchor_ids, 24),
    topic_keywords: safeArray(entry.topic_keywords, 16),
    background_only: Boolean(entry.background_only),
    excerpt_hint: safeText(entry.excerpt_hint),
    excerpt_text: safeText(entry.excerpt_text),
    prev_topic_id: safeText(entry.prev_topic_id),
    next_topic_id: safeText(entry.next_topic_id),
    source_index_file: safeText(entry.file)
  };
}

function countBy(items = [], key = '') {
  const out = {};
  for (const item of Array.isArray(items) ? items : []) {
    const bucket = safeText(item?.[key], 'unknown');
    out[bucket] = (out[bucket] || 0) + 1;
  }
  return out;
}

function buildSampleMemoryEntries(entries = [], limit = 12) {
  const rows = Array.isArray(entries) ? entries : [];
  const out = [];
  const usedIds = new Set();
  const push = (row) => {
    if (!row || usedIds.has(row.entry_id)) return;
    usedIds.add(row.entry_id);
    out.push(row);
  };
  const preferredShapes = ['自我定义', '方法协议', '关系节点', '长期主线', '事件切片', '人物画像'];
  for (const shapeLabel of preferredShapes) {
    push(rows.find((row) => row.shape_label === shapeLabel && row.entry_type === 'persona'));
    if (out.length >= limit) return out;
    push(rows.find((row) => row.shape_label === shapeLabel && row.entry_type === 'sql'));
    if (out.length >= limit) return out;
  }
  for (const row of rows) {
    push(row);
    if (out.length >= limit) break;
  }
  return out;
}

const ROOT_KIND_LABELS = {
  character: '角色',
  relation_lane: '关系线',
  story_arc: '剧情线',
  event_arc: '事件线',
  world_rule: '世界规则',
  method_protocol: '方法协议',
  object_anchor: '物件锚点',
  symbol_anchor: '象征锚点',
  external_ai_persona: '外部 AI 人格',
  institution_or_platform: '机构或平台',
  system_actor: '系统角色',
  model_type: '模型类型',
  fact_line: '事实线'
};

const TOPIC_ROLE_ROOT_KIND = {
  relationship_shift: 'relation_lane',
  event_progress: 'event_arc',
  world_rule: 'world_rule',
  stable_fact_growth: 'fact_line',
  object_anchor: 'object_anchor'
};

const MEMORY_SHAPE_RECALL_LANES = {
  self_definition: 'character_identity',
  preference_profile: 'character_profile',
  relation_milestone: 'relationship_recall',
  ritual_pattern: 'relationship_recall',
  worldview_protocol: 'world_rule_recall',
  project_line: 'story_arc_recall',
  anchor_object: 'object_anchor_recall',
  scene_event: 'scene_replay'
};

function stableObjectId(prefix = 'id', values = []) {
  const seed = uniqueStrings((Array.isArray(values) ? values : [values]).map((item) => safeText(item)), 8).join('__');
  return `${prefix}.${safeScopeSegment(seed || prefix, prefix).slice(0, 88)}`;
}

function normalizeDisplayToken(value = '') {
  return String(value || '')
    .replace(/\s*等\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMachineLikeToken(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (/^window[_-]/iu.test(text)) return true;
  if (/^(src|chunk|topic|anchor|rid|evt|track)[._-]/iu.test(text)) return true;
  if (/^[a-f0-9]{12,}$/iu.test(text)) return true;
  if (/^\d{3,4}$/.test(text)) return true;
  return false;
}

function isGenericRootName(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (text === '*' || text === '-') return true;
  if (isMachineLikeToken(text)) return true;
  return [
    '事件',
    '人物',
    '事物',
    '回顾',
    '关系',
    '情绪',
    '项目',
    '时间',
    '记忆',
    '主题',
    'user',
    'assistant'
  ].includes(text);
}

function normalizeEntityName(value = '', personaWorkspace = {}) {
  const text = normalizeDisplayToken(value);
  const lowered = text.toLowerCase();
  if (lowered === 'user') return safeText(personaWorkspace.user_name, 'user');
  if (['assistant', 'char', 'bot'].includes(lowered)) return safeText(personaWorkspace.char_name, 'assistant');
  return text;
}

function inferEntityRootKind(name = '', memoryShape = '') {
  const text = safeText(name);
  if (!text) return 'object_anchor';
  if (/^(阿霁|阿鸢|我|你|他|她|ta)$/iu.test(text)) return 'character';
  if (/^[\u4e00-\u9fa5]{1,4}$/u.test(text) && /[阿小老]/u.test(text)) return 'character';
  if (memoryShape === 'anchor_object') return 'object_anchor';
  return 'character';
}

function topicLabelForRoot(value = '') {
  const text = normalizeDisplayToken(value);
  if (!text) return '';
  return text.replace(/\s*\/\s*/gu, ' / ');
}

function rootKindLabel(kind = '') {
  return ROOT_KIND_LABELS[safeText(kind)] || '记忆根';
}

function rootPathFor(kind = '', name = '') {
  return `${rootKindLabel(kind)} / ${safeText(name, '未命名根')}`;
}

function buildRootCandidate({ kind = '', name = '', role = '', confidence = 'derived', priority = 0, source = '', aliases = [], keywords = [] } = {}) {
  const rootKind = safeText(kind, 'story_arc');
  const rootName = normalizeDisplayToken(name);
  if (!rootName) return null;
  return {
    root_id: stableObjectId('root', [rootKind, rootName]),
    root_kind: rootKind,
    root_name: rootName,
    root_path: rootPathFor(rootKind, rootName),
    role: safeText(role, 'related'),
    confidence: safeText(confidence, 'derived'),
    priority: Number(priority || 0),
    source: safeText(source),
    aliases: safeArray(aliases, 12),
    keywords: safeArray(keywords, 16)
  };
}

function parseMsgRange(value = '') {
  const parts = String(value || '').match(/\d+/g);
  if (!parts?.length) return null;
  const start = Number(parts[0] || 0);
  const end = Number(parts[1] || parts[0] || 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) return null;
  return {
    start: Math.min(start, end),
    end: Math.max(start, end)
  };
}

function rangesOverlap(left = null, right = null) {
  if (!left || !right) return false;
  return left.start <= right.end && right.start <= left.end;
}

function sourceTopicMatchesEntry(topic = {}, entry = {}) {
  if (!topic || !entry) return false;
  const topicIds = new Set(safeArray(entry.topic_ids, 32));
  if (safeText(topic.topic_id) && topicIds.has(safeText(topic.topic_id))) return true;
  if (safeText(topic.chunk_id) && safeText(topic.chunk_id) === safeText(entry.chunk_id)) return true;
  if (safeText(topic.source_window_id) && safeText(topic.source_window_id) === safeText(entry.source_window_id)) {
    const topicRange = parseMsgRange(topic.source_msg_range);
    const entryRange = parseMsgRange(entry.source_msg_range);
    if (!topicRange || !entryRange || rangesOverlap(topicRange, entryRange)) return true;
  }
  return false;
}

function sourceTopicsForEntry(entry = {}, sourceTopics = [], sourceTopicById = new Map(), limit = 6) {
  const rows = [];
  const seen = new Set();
  for (const topicId of safeArray(entry.topic_ids, 32)) {
    const topic = sourceTopicById.get(topicId);
    if (!topic || seen.has(topic.topic_id)) continue;
    seen.add(topic.topic_id);
    rows.push(topic);
  }
  for (const topic of Array.isArray(sourceTopics) ? sourceTopics : []) {
    if (!sourceTopicMatchesEntry(topic, entry) || seen.has(topic.topic_id)) continue;
    seen.add(topic.topic_id);
    rows.push(topic);
    if (rows.length >= limit) break;
  }
  return rows.slice(0, Math.max(1, Number(limit || 1)));
}

function rootCandidatesForEntry(entry = {}, sourceTopicById = new Map(), personaWorkspace = {}, sourceTopics = []) {
  const candidates = [];
  const push = (candidate) => {
    if (!candidate) return;
    if (candidates.some((item) => item.root_id === candidate.root_id)) return;
    candidates.push(candidate);
  };

  for (const raw of safeArray(entry.entity_refs, 16)) {
    const name = normalizeEntityName(raw, personaWorkspace);
    if (isGenericRootName(name) && !['user', 'assistant'].includes(String(raw || '').toLowerCase())) continue;
    const kind = inferEntityRootKind(name, entry.memory_shape);
    push(buildRootCandidate({
      kind,
      name,
      role: kind === 'character' ? 'participant' : 'anchor_object',
      confidence: 'explicit',
      priority: kind === 'character' ? 72 : 58,
      source: 'entry.entity_refs',
      aliases: [raw].filter((item) => safeText(item) && safeText(item) !== name)
    }));
  }

  for (const tag of safeArray(entry.tags, 24)) {
    if (!tag.startsWith('关系/')) continue;
    const relationName = normalizeDisplayToken(tag.replace(/^关系\//, ''));
    if (isGenericRootName(relationName)) continue;
    push(buildRootCandidate({
      kind: 'relation_lane',
      name: relationName,
      role: 'relationship_lane',
      confidence: 'explicit',
      priority: entry.memory_shape === 'relation_milestone' ? 94 : 76,
      source: 'entry.tags'
    }));
  }

  if (safeText(entry.track_id)) {
    const trackName = normalizeDisplayToken(entry.track_id).replace(/[_-]+/g, ' ');
    push(buildRootCandidate({
      kind: 'story_arc',
      name: trackName,
      role: 'story_arc',
      confidence: 'explicit',
      priority: entry.memory_shape === 'project_line' ? 92 : 62,
      source: 'entry.track_id',
      aliases: [entry.track_id]
    }));
  }

  if (safeText(entry.event_anchor)) {
    push(buildRootCandidate({
      kind: 'event_arc',
      name: safeText(entry.event_anchor).replace(/[_-]+/g, ' '),
      role: 'event_anchor',
      confidence: 'explicit',
      priority: entry.memory_shape === 'scene_event' ? 84 : 66,
      source: 'entry.event_anchor',
      aliases: [entry.event_anchor]
    }));
  }

  if (entry.memory_shape === 'worldview_protocol') {
    push(buildRootCandidate({
      kind: 'method_protocol',
      name: entry.title,
      role: 'protocol',
      confidence: 'derived',
      priority: 88,
      source: 'entry.memory_shape'
    }));
  }

  if (entry.memory_shape === 'anchor_object') {
    push(buildRootCandidate({
      kind: 'object_anchor',
      name: entry.title,
      role: 'object_anchor',
      confidence: 'derived',
      priority: 86,
      source: 'entry.memory_shape'
    }));
  }

  for (const topicId of safeArray(entry.topic_ids, 12)) {
    const topic = sourceTopicById.get(topicId);
    if (!topic) continue;
    const topicName = topicLabelForRoot(topic.topic_label);
    if (!topicName) continue;
    push(buildRootCandidate({
      kind: TOPIC_ROLE_ROOT_KIND[safeText(topic.topic_role)] || 'story_arc',
      name: topicName,
      role: safeText(topic.topic_role, 'source_topic'),
      confidence: 'explicit',
      priority: topic.topic_role === 'relationship_shift' ? 82 : 68,
      source: 'source_topic.topic_id',
      aliases: [topic.topic_id],
      keywords: topic.topic_keywords
    }));
  }

  for (const label of safeArray(entry.topic_labels, 8)) {
    const topicName = topicLabelForRoot(label);
    if (!topicName || isGenericRootName(topicName)) continue;
    push(buildRootCandidate({
      kind: entry.memory_shape === 'worldview_protocol' ? 'world_rule' : 'story_arc',
      name: topicName,
      role: 'topic_label',
      confidence: 'derived',
      priority: 48,
      source: 'entry.topic_labels'
    }));
  }

  return candidates.sort((left, right) => right.priority - left.priority || left.root_name.localeCompare(right.root_name, 'zh'));
}

function rootCandidatesForSourceTopic(topic = {}) {
  const kind = TOPIC_ROLE_ROOT_KIND[safeText(topic.topic_role)] || 'story_arc';
  const name = topicLabelForRoot(topic.topic_label);
  if (!name) return [];
  return [
    buildRootCandidate({
      kind,
      name,
      role: safeText(topic.topic_role, 'source_topic'),
      confidence: 'explicit',
      priority: 70,
      source: 'source_topic',
      aliases: [topic.topic_id],
      keywords: topic.topic_keywords
    })
  ].filter(Boolean);
}

function choosePrimaryRoot(candidates = [], entry = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (!rows.length) return null;
  const shape = safeText(entry.memory_shape);
  const preferredKindByShape = {
    self_definition: ['character', 'method_protocol', 'story_arc'],
    preference_profile: ['character', 'relation_lane'],
    relation_milestone: ['relation_lane', 'character', 'event_arc'],
    ritual_pattern: ['relation_lane', 'character'],
    worldview_protocol: ['method_protocol', 'world_rule', 'story_arc'],
    project_line: ['story_arc', 'event_arc'],
    anchor_object: ['object_anchor', 'character'],
    scene_event: ['event_arc', 'relation_lane', 'character', 'story_arc']
  };
  const preferred = preferredKindByShape[shape] || [];
  return rows.slice().sort((left, right) => {
    const leftBonus = preferred.includes(left.root_kind) ? 100 - preferred.indexOf(left.root_kind) : 0;
    const rightBonus = preferred.includes(right.root_kind) ? 100 - preferred.indexOf(right.root_kind) : 0;
    return (right.priority + rightBonus) - (left.priority + leftBonus) || left.root_name.localeCompare(right.root_name, 'zh');
  })[0];
}

function buildSourceTraceWarehouse(entries = [], sourceTopics = []) {
  const traceMap = new Map();
  const topicTraceIdMap = new Map();
  const entryTraceIdMap = new Map();
  const sourceTopicById = new Map((Array.isArray(sourceTopics) ? sourceTopics : []).map((item) => [safeText(item.topic_id), item]));

  const upsertTrace = (traceId, patch = {}) => {
    const id = safeText(traceId);
    if (!id) return null;
    const existing = traceMap.get(id) || {
      trace_id: id,
      trace_kind: safeText(patch.trace_kind, 'source_trace'),
      trace_title: safeText(patch.trace_title, '未命名原文存证'),
      source_bundle_id: '',
      chunk_id: '',
      topic_id: '',
      topic_label: '',
      topic_role: '',
      source_window_id: '',
      source_window_title: '',
      source_msg_range: '',
      excerpt_hint: '',
      excerpt_text: '',
      source_refs: [],
      linked_memory_entry_ids: [],
      linked_root_ids: [],
      keywords: [],
      audit_note: '原文溯源只作为存证仓；主召回优先读取 memory_entries / relation_roots / relation_vines。'
    };
    const next = {
      ...existing,
      trace_kind: safeText(existing.trace_kind, patch.trace_kind),
      trace_title: safeText(existing.trace_title, patch.trace_title),
      source_bundle_id: safeText(existing.source_bundle_id, patch.source_bundle_id),
      chunk_id: safeText(existing.chunk_id, patch.chunk_id),
      topic_id: safeText(existing.topic_id, patch.topic_id),
      topic_label: safeText(existing.topic_label, patch.topic_label),
      topic_role: safeText(existing.topic_role, patch.topic_role),
      source_window_id: safeText(existing.source_window_id, patch.source_window_id),
      source_window_title: safeText(existing.source_window_title, patch.source_window_title),
      source_msg_range: safeText(existing.source_msg_range, patch.source_msg_range),
      excerpt_hint: safeText(existing.excerpt_hint, patch.excerpt_hint),
      excerpt_text: safeText(existing.excerpt_text, patch.excerpt_text),
      source_refs: uniqueStrings([...safeArray(existing.source_refs, 512), ...safeArray(patch.source_refs, 64)], 512),
      linked_memory_entry_ids: uniqueStrings([...safeArray(existing.linked_memory_entry_ids, 4096), ...safeArray(patch.linked_memory_entry_ids, 64)], 4096),
      linked_root_ids: uniqueStrings([...safeArray(existing.linked_root_ids, 4096), ...safeArray(patch.linked_root_ids, 64)], 4096),
      keywords: uniqueStrings([...safeArray(existing.keywords, 64), ...safeArray(patch.keywords, 32)], 64)
    };
    traceMap.set(id, next);
    return next;
  };

  for (const topic of Array.isArray(sourceTopics) ? sourceTopics : []) {
    const traceId = stableObjectId('trace', ['topic', topic.topic_id || topic.chunk_id || topic.topic_label]);
    topicTraceIdMap.set(safeText(topic.topic_id), traceId);
    upsertTrace(traceId, {
      trace_kind: 'source_topic',
      trace_title: safeText(topic.topic_label, topic.source_window_title),
      source_bundle_id: topic.source_bundle_id,
      chunk_id: topic.chunk_id,
      topic_id: topic.topic_id,
      topic_label: topic.topic_label,
      topic_role: topic.topic_role,
      source_window_id: topic.source_window_id,
      source_window_title: topic.source_window_title,
      source_msg_range: topic.source_msg_range,
      excerpt_hint: topic.excerpt_hint,
      excerpt_text: topic.excerpt_text,
      keywords: topic.topic_keywords
    });
  }

  for (const entry of Array.isArray(entries) ? entries : []) {
    const traceIds = [];
    for (const topic of sourceTopicsForEntry(entry, sourceTopics, sourceTopicById, 6)) {
      const topicId = safeText(topic.topic_id);
      const traceId = topicTraceIdMap.get(topicId);
      if (!traceId) continue;
      traceIds.push(traceId);
      upsertTrace(traceId, {
        linked_memory_entry_ids: [entry.entry_id],
        source_refs: [entry.source_ref, entry.source_file].filter(Boolean)
      });
    }
    if (safeText(entry.source_ref) || safeText(entry.source_window_id) || safeText(entry.chunk_id)) {
      const fallbackId = stableObjectId('trace', ['entry_source', entry.source_ref || entry.source_window_id || entry.chunk_id]);
      traceIds.push(fallbackId);
      upsertTrace(fallbackId, {
        trace_kind: 'memory_entry_source',
        trace_title: safeText(entry.source_window_title || entry.source_ref || entry.title, '记忆来源'),
        source_bundle_id: entry.source_bundle_id,
        chunk_id: entry.chunk_id,
        source_window_id: entry.source_window_id,
        source_window_title: entry.source_window_title,
        source_msg_range: entry.source_msg_range,
        excerpt_hint: entry.summary,
        source_refs: [entry.source_ref, entry.source_file, entry.source_md_ref].filter(Boolean),
        linked_memory_entry_ids: [entry.entry_id],
        keywords: [...safeArray(entry.activation_triggers, 6), ...safeArray(entry.topic_labels, 4)]
      });
    }
    entryTraceIdMap.set(entry.entry_id, uniqueStrings(traceIds, 64));
  }

  return {
    source_traces: Array.from(traceMap.values()).sort((a, b) => a.trace_id.localeCompare(b.trace_id)),
    topic_trace_id_map: topicTraceIdMap,
    entry_trace_id_map: entryTraceIdMap
  };
}

function buildLightRelationTree({ entries = [], sourceTopics = [], personaWorkspace = {}, traceWarehouse = {} } = {}) {
  const sourceTopicById = new Map((Array.isArray(sourceTopics) ? sourceTopics : []).map((item) => [safeText(item.topic_id), item]));
  const rootMap = new Map();
  const entryRootLinkMap = new Map();

  const upsertRoot = (candidate = {}, context = {}) => {
    if (!candidate?.root_id) return;
    const existing = rootMap.get(candidate.root_id) || {
      root_id: candidate.root_id,
      root_kind: candidate.root_kind,
      kind_label: rootKindLabel(candidate.root_kind),
      root_name: candidate.root_name,
      root_path: candidate.root_path,
      aliases: [],
      confidence: candidate.confidence,
      source_reasons: [],
      memory_entry_ids: [],
      source_topic_ids: [],
      source_trace_ids: [],
      month_keys: [],
      shape_labels: [],
      recall_keywords: [],
      summary_hints: []
    };
    existing.aliases = uniqueStrings([...safeArray(existing.aliases, 64), ...safeArray(candidate.aliases, 12)], 64);
    existing.source_reasons = uniqueStrings([...safeArray(existing.source_reasons, 32), candidate.source, candidate.role], 32);
    existing.memory_entry_ids = uniqueStrings([...safeArray(existing.memory_entry_ids, 4096), ...safeArray(context.entry_ids, 8)], 4096);
    existing.source_topic_ids = uniqueStrings([...safeArray(existing.source_topic_ids, 4096), ...safeArray(context.topic_ids, 8)], 4096);
    existing.source_trace_ids = uniqueStrings([...safeArray(existing.source_trace_ids, 4096), ...safeArray(context.source_trace_ids, 16)], 4096);
    existing.month_keys = uniqueStrings([...safeArray(existing.month_keys, 64), ...safeArray(context.month_keys, 8)], 64);
    existing.shape_labels = uniqueStrings([...safeArray(existing.shape_labels, 32), ...safeArray(context.shape_labels, 8)], 32);
    existing.recall_keywords = uniqueStrings([
      ...safeArray(existing.recall_keywords, 64),
      ...safeArray(candidate.keywords, 16),
      ...safeArray(context.recall_keywords, 16)
    ], 64);
    existing.summary_hints = dedupeTextParts([
      ...safeArray(existing.summary_hints, 12),
      ...safeArray(context.summary_hints, 4)
    ], 12);
    existing.memory_count = existing.memory_entry_ids.length;
    existing.source_topic_count = existing.source_topic_ids.length;
    rootMap.set(candidate.root_id, existing);
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    const candidates = rootCandidatesForEntry(entry, sourceTopicById, personaWorkspace, sourceTopics);
    const sourceTraceIds = traceWarehouse.entry_trace_id_map?.get(entry.entry_id) || [];
    const primary = choosePrimaryRoot(candidates, entry);
    entryRootLinkMap.set(entry.entry_id, {
      entry_id: entry.entry_id,
      root_ids: uniqueStrings(candidates.map((item) => item.root_id), 64),
      primary_root_id: safeText(primary?.root_id),
      primary_root_name: safeText(primary?.root_name),
      primary_root_path: safeText(primary?.root_path),
      candidates,
      source_trace_ids: sourceTraceIds
    });
    for (const candidate of candidates) {
      upsertRoot(candidate, {
        entry_ids: [entry.entry_id],
        topic_ids: entry.topic_ids,
        source_trace_ids: sourceTraceIds,
        month_keys: [entry.month_key],
        shape_labels: [entry.shape_label],
        recall_keywords: [...safeArray(entry.activation_triggers, 8), ...safeArray(entry.topic_labels, 4)],
        summary_hints: [entry.summary]
      });
    }
  }

  for (const topic of Array.isArray(sourceTopics) ? sourceTopics : []) {
    const traceId = traceWarehouse.topic_trace_id_map?.get(topic.topic_id);
    for (const candidate of rootCandidatesForSourceTopic(topic)) {
      upsertRoot(candidate, {
        topic_ids: [topic.topic_id],
        source_trace_ids: [traceId].filter(Boolean),
        month_keys: [normalizeMonthHint(topic.source_index_file)],
        recall_keywords: topic.topic_keywords,
        summary_hints: [topic.excerpt_hint]
      });
    }
  }

  const vineMap = new Map();
  const entryVineIds = new Map();
  const addVine = ({ fromRootId = '', toRootId = '', vineKind = '', relationLabel = '', entry = null, topic = null, traceIds = [], confidence = 'derived' } = {}) => {
    const fromId = safeText(fromRootId);
    const toId = safeText(toRootId);
    if (!fromId || !toId || fromId === toId) return null;
    const key = `${safeText(vineKind, 'related')}::${fromId}::${toId}`;
    const fromRoot = rootMap.get(fromId);
    const toRoot = rootMap.get(toId);
    if (!fromRoot || !toRoot) return null;
    const existing = vineMap.get(key) || {
      vine_id: stableObjectId('vine', [vineKind, fromId, toId]),
      vine_kind: safeText(vineKind, 'related'),
      relation_label: safeText(relationLabel, safeText(vineKind, 'related')),
      from_root_id: fromId,
      from_root_name: fromRoot.root_name,
      from_root_path: fromRoot.root_path,
      to_root_id: toId,
      to_root_name: toRoot.root_name,
      to_root_path: toRoot.root_path,
      confidence,
      evidence_entry_ids: [],
      evidence_topic_ids: [],
      source_trace_ids: [],
      summary_hints: []
    };
    existing.evidence_entry_ids = uniqueStrings([
      ...safeArray(existing.evidence_entry_ids, 4096),
      entry?.entry_id
    ], 4096);
    existing.evidence_topic_ids = uniqueStrings([
      ...safeArray(existing.evidence_topic_ids, 4096),
      topic?.topic_id
    ], 4096);
    existing.source_trace_ids = uniqueStrings([
      ...safeArray(existing.source_trace_ids, 4096),
      ...safeArray(traceIds, 64)
    ], 4096);
    existing.summary_hints = dedupeTextParts([
      ...safeArray(existing.summary_hints, 12),
      entry?.summary,
      topic?.excerpt_hint
    ], 12);
    existing.strength = existing.evidence_entry_ids.length + existing.evidence_topic_ids.length;
    vineMap.set(key, existing);
    if (entry?.entry_id) {
      entryVineIds.set(entry.entry_id, uniqueStrings([
        ...safeArray(entryVineIds.get(entry.entry_id), 64),
        existing.vine_id
      ], 64));
    }
    return existing;
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    const link = entryRootLinkMap.get(entry.entry_id);
    if (!link?.primary_root_id) continue;
    for (const rootId of safeArray(link.root_ids, 64)) {
      if (rootId === link.primary_root_id) continue;
      const toRoot = rootMap.get(rootId);
      const kind = toRoot?.root_kind === 'relation_lane'
        ? 'relationship_affects'
        : toRoot?.root_kind === 'event_arc'
          ? 'happens_in'
          : toRoot?.root_kind === 'story_arc'
            ? 'belongs_to_arc'
            : 'co_recalled';
      addVine({
        fromRootId: link.primary_root_id,
        toRootId: rootId,
        vineKind: kind,
        relationLabel: kind,
        entry,
        traceIds: link.source_trace_ids,
        confidence: 'entry_derived'
      });
    }
  }

  for (const topic of Array.isArray(sourceTopics) ? sourceTopics : []) {
    if (!safeText(topic.prev_topic_id) && !safeText(topic.next_topic_id)) continue;
    const topicRoot = rootCandidatesForSourceTopic(topic)[0];
    if (!topicRoot) continue;
    const traceId = traceWarehouse.topic_trace_id_map?.get(topic.topic_id);
    for (const linkedTopicId of [topic.prev_topic_id, topic.next_topic_id]) {
      const linkedTopic = sourceTopicById.get(safeText(linkedTopicId));
      const linkedRoot = rootCandidatesForSourceTopic(linkedTopic)[0];
      if (!linkedRoot) continue;
      addVine({
        fromRootId: topicRoot.root_id,
        toRootId: linkedRoot.root_id,
        vineKind: linkedTopicId === topic.next_topic_id ? 'continues_to' : 'continues_from',
        relationLabel: 'source_topic_sequence',
        topic,
        traceIds: [traceId].filter(Boolean),
        confidence: 'explicit_sequence'
      });
    }
  }

  const roots = Array.from(rootMap.values()).sort((left, right) =>
    left.root_kind.localeCompare(right.root_kind) ||
    right.memory_count - left.memory_count ||
    left.root_name.localeCompare(right.root_name, 'zh')
  );
  const vines = Array.from(vineMap.values()).sort((left, right) =>
    right.strength - left.strength || left.vine_id.localeCompare(right.vine_id)
  );

  for (const trace of traceWarehouse.source_traces || []) {
    const linkedRootIds = uniqueStrings(
      safeArray(trace.linked_memory_entry_ids, 4096)
        .flatMap((entryId) => safeArray(entryRootLinkMap.get(entryId)?.root_ids, 64)),
      4096
    );
    trace.linked_root_ids = uniqueStrings([...safeArray(trace.linked_root_ids, 4096), ...linkedRootIds], 4096);
  }

  return {
    relation_roots: roots,
    relation_vines: vines,
    entry_root_link_map: entryRootLinkMap,
    entry_vine_id_map: entryVineIds
  };
}

function inferRecallLane(entry = {}) {
  return MEMORY_SHAPE_RECALL_LANES[safeText(entry.memory_shape)] || 'general_memory_recall';
}

function classifyEntryCompanionVoice(entry = {}) {
  const text = [entry.title, entry.front_recall_text || entry.recall_payload || entry.summary].map((item) => safeText(item)).filter(Boolean).join('\n');
  const hasPersonaAnchor = Boolean(safeText(entry.primary_root_id) && safeText(entry.primary_root_name));
  const hasLanguageFingerprint = safeArray(entry.expression_fingerprint, 8).length > 0 || safeArray(entry.quote_refs, 8).length > 0;
  const hasInnerViewCue = /我|你|我们|自己|彼此|对方|阿霁|阿鸢|靠近|回应|相处|记得/u.test(text);
  const hasCompanionToneCue = /温柔|安心|在意|亲密|信任|委屈|害怕|喜欢|不想|想要|疼|珍惜|舍不得|安全感|撒娇|靠着|抱|被看见|认真|期待|脆弱|确认/u.test(text);
  const machineFramingRisk = /\b(user|assistant|system|source_ref|topic_id|chunk_id|entry_id|JSON|CSV|Markdown|database)\b|用户|系统提示词|字段|数据库字段|原始记录编号/u.test(text);
  const sourceDumpRisk = safeText(entry.recall_payload).length > 560 || String(entry.recall_payload || '').split('\n').filter((line) => safeText(line)).length > 7;
  const coldSummaryRisk = !hasInnerViewCue && !hasCompanionToneCue && safeText(entry.summary).length < 30;
  const score = Math.max(0, Math.min(100,
    35 +
    (hasPersonaAnchor ? 18 : 0) +
    (hasLanguageFingerprint ? 16 : 0) +
    (hasInnerViewCue ? 16 : 0) +
    (hasCompanionToneCue ? 15 : 0) -
    (machineFramingRisk ? 24 : 0) -
    (sourceDumpRisk ? 18 : 0) -
    (coldSummaryRisk ? 12 : 0)
  ));
  const flags = [];
  if (hasPersonaAnchor) flags.push('persona_anchor_present');
  if (hasLanguageFingerprint) flags.push('language_fingerprint_present');
  if (hasInnerViewCue) flags.push('inner_view_cue');
  if (hasCompanionToneCue) flags.push('soft_companion_tone_cue');
  if (machineFramingRisk) flags.push('machine_framing_risk');
  if (sourceDumpRisk) flags.push('source_dump_risk');
  if (coldSummaryRisk) flags.push('cold_summary_risk');
  let tier = 'neutral_usable';
  if (score >= 72 && !machineFramingRisk && !sourceDumpRisk) tier = 'voice_ready';
  if (score < 56 || machineFramingRisk || sourceDumpRisk) tier = 'needs_voice_review';
  return {
    companion_voice_tier: tier,
    companion_voice_score: score,
    companion_voice_flags: flags
  };
}

function classifyEntryRecallPotential(entry = {}, companionVoice = null) {
  const payload = safeText(entry.front_recall_text || entry.recall_payload || entry.summary || entry.content_text);
  const payloadLength = payload.length;
  const sourceTraceCount = safeArray(entry.source_trace_ids, 128).length;
  const rootCount = safeArray(entry.root_ids, 128).length;
  const vineCount = safeArray(entry.relation_vine_ids, 128).length;
  const hasRoot = Boolean(safeText(entry.primary_root_id));
  const voiceTier = companionVoice?.companion_voice_tier || classifyEntryCompanionVoice(entry).companion_voice_tier;
  const evidenceOverloadRisk = sourceTraceCount > 5 || rootCount > 8 || vineCount > 10 || payloadLength > 620;
  const sourceHeavyRisk = /source_ref|topic_id|chunk_id|原文|存证|编号|字段/u.test(payload) || String(payload).split('\n').filter((line) => safeText(line)).length > 7;
  const tooThinRisk = payloadLength < 24 || !safeText(entry.summary);
  let tier = 'front_ready';
  if (!hasRoot || payloadLength > 420 || sourceHeavyRisk || evidenceOverloadRisk || voiceTier === 'needs_voice_review') tier = 'needs_compaction';
  if (payloadLength > 760 || sourceHeavyRisk && evidenceOverloadRisk || tooThinRisk) tier = 'audit_only';
  const flags = [];
  if (hasRoot) flags.push('has_relation_root');
  if (payloadLength <= 420) flags.push('front_context_sized');
  if (evidenceOverloadRisk) flags.push('evidence_overload_risk');
  if (sourceHeavyRisk) flags.push('source_heavy_risk');
  if (tooThinRisk) flags.push('too_thin_for_recall');
  if (voiceTier === 'needs_voice_review') flags.push('voice_review_required');
  return {
    front_recall_tier: tier,
    front_recall_chars: payloadLength,
    front_recall_flags: flags
  };
}

function attachTreeLinksToEntries(entries = [], relationTree = {}, traceWarehouse = {}, personaWorkspace = {}) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const link = relationTree.entry_root_link_map?.get(entry.entry_id) || {};
    const relationVineIds = relationTree.entry_vine_id_map?.get(entry.entry_id) || [];
    const rootPaths = safeArray(link.root_ids, 64)
      .map((rootId) => relationTree.relation_roots.find((root) => root.root_id === rootId)?.root_path)
      .filter(Boolean);
    const relatedRootNames = safeArray(link.root_ids, 64)
      .map((rootId) => relationTree.relation_roots.find((root) => root.root_id === rootId)?.root_name)
      .filter(Boolean);
    const sourceTraceIds = link.source_trace_ids || traceWarehouse.entry_trace_id_map?.get(entry.entry_id) || [];
    const linkedEntry = {
      ...entry,
      recall_lane: inferRecallLane(entry),
      primary_root_id: safeText(link.primary_root_id),
      primary_root_name: safeText(link.primary_root_name),
      primary_root_path: safeText(link.primary_root_path),
      root_ids: safeArray(link.root_ids, 64),
      root_path_text: rootPaths.join(' ｜ '),
      related_entities_text: relatedRootNames.join('、'),
      relation_vine_ids: safeArray(relationVineIds, 64),
      source_trace_ids: safeArray(sourceTraceIds, 64),
      machine_index_text: dedupeTextParts([
        entry.title,
        link.primary_root_path,
        relatedRootNames.join(' '),
        ...safeArray(entry.activation_triggers, 6),
        ...safeArray(entry.topic_labels, 4),
        entry.summary
      ], 8).join('\n')
    };
    const frontRecallText = buildFrontRecallText(linkedEntry, personaWorkspace);
    const frontLinkedEntry = {
      ...linkedEntry,
      front_recall_text: frontRecallText
    };
    const companionVoice = classifyEntryCompanionVoice(frontLinkedEntry);
    const recallPotential = classifyEntryRecallPotential(frontLinkedEntry, companionVoice);
    return {
      ...frontLinkedEntry,
      ...companionVoice,
      ...recallPotential
    };
  });
}

function buildStoryTimeline({ entries = [], sourceTopics = [], relationTree = {}, traceWarehouse = {} } = {}) {
  const entryByTopic = new Map();
  const sourceTopicById = new Map((Array.isArray(sourceTopics) ? sourceTopics : []).map((item) => [safeText(item.topic_id), item]));
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const topic of sourceTopicsForEntry(entry, sourceTopics, sourceTopicById, 6)) {
      const topicId = safeText(topic.topic_id);
      if (!topicId) continue;
      if (!entryByTopic.has(topicId)) entryByTopic.set(topicId, []);
      entryByTopic.get(topicId).push(entry);
    }
  }

  const timeline = [];
  for (const topic of Array.isArray(sourceTopics) ? sourceTopics : []) {
    const role = safeText(topic.topic_role);
    if (!['event_progress', 'relationship_shift', 'world_rule', 'stable_fact_growth', 'object_anchor'].includes(role)) continue;
    const linkedEntries = entryByTopic.get(topic.topic_id) || [];
    const rootIds = uniqueStrings(linkedEntries.flatMap((entry) =>
      safeArray(relationTree.entry_root_link_map?.get(entry.entry_id)?.root_ids, 64)
    ), 256);
    timeline.push({
      event_id: stableObjectId('story_event', [topic.topic_id || topic.chunk_id || topic.topic_label]),
      event_title: safeText(topic.topic_label, '未命名时间节点'),
      event_role: role,
      event_lane: TOPIC_ROLE_ROOT_KIND[role] || 'story_arc',
      source_topic_id: topic.topic_id,
      prev_event_topic_id: safeText(topic.prev_topic_id),
      next_event_topic_id: safeText(topic.next_topic_id),
      source_trace_id: traceWarehouse.topic_trace_id_map?.get(topic.topic_id) || '',
      linked_memory_entry_ids: linkedEntries.map((entry) => entry.entry_id),
      linked_root_ids: rootIds,
      source_window_title: topic.source_window_title,
      source_msg_range: topic.source_msg_range,
      keywords: topic.topic_keywords,
      summary_hint: topic.excerpt_hint || topic.excerpt_text
    });
  }

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!safeText(entry.event_anchor)) continue;
    const link = relationTree.entry_root_link_map?.get(entry.entry_id) || {};
    timeline.push({
      event_id: stableObjectId('story_event', [entry.event_anchor, entry.entry_id]),
      event_title: safeText(entry.title, entry.event_anchor),
      event_role: 'memory_entry_event_anchor',
      event_lane: 'event_arc',
      source_topic_id: '',
      prev_event_topic_id: '',
      next_event_topic_id: '',
      source_trace_id: safeArray(link.source_trace_ids, 1)[0] || '',
      linked_memory_entry_ids: [entry.entry_id],
      linked_root_ids: safeArray(link.root_ids, 64),
      source_window_title: entry.source_window_title,
      source_msg_range: entry.source_msg_range,
      keywords: entry.activation_triggers,
      summary_hint: entry.summary
    });
  }

  return timeline.sort((left, right) =>
    String(left.source_window_title || '').localeCompare(String(right.source_window_title || ''), 'zh') ||
    String(left.source_msg_range || '').localeCompare(String(right.source_msg_range || '')) ||
    String(left.event_title || '').localeCompare(String(right.event_title || ''), 'zh')
  );
}

function ratio(numerator = 0, denominator = 0) {
  const den = Number(denominator || 0);
  if (!den) return 0;
  return Number((Number(numerator || 0) / den).toFixed(4));
}

function percent(numerator = 0, denominator = 0) {
  return Number((ratio(numerator, denominator) * 100).toFixed(2));
}

function buildQueryTerms(query = '') {
  const normalized = normalizeComparableText(query);
  if (!normalized) return [];
  const looseTerms = normalized
    .split(/\s+/u)
    .map((item) => safeText(item))
    .filter((item) => item.length >= 2);
  return uniqueStrings([normalized, ...looseTerms], 24);
}

function scoreQueryAgainstText(queryTerms = [], value = '', weight = 1) {
  const text = normalizeComparableText(value);
  if (!text || !Array.isArray(queryTerms) || !queryTerms.length) return 0;
  let score = 0;
  for (const term of queryTerms) {
    if (!term) continue;
    if (text === term) score += 28 * weight;
    else if (text.includes(term)) score += Math.min(24, 6 + term.length * 2) * weight;
  }
  return score;
}

function recallPreviewRootHaystack(root = {}) {
  return [
    root.root_id,
    root.root_kind,
    root.root_name,
    root.root_path,
    ...safeArray(root.aliases, 24),
    ...safeArray(root.recall_keywords, 24),
    ...safeArray(root.summary_hints, 12)
  ].filter(Boolean).join(' ');
}

function recallPreviewEntryHaystack(entry = {}) {
  return [
    entry.title,
    entry.summary,
    entry.recall_payload,
    entry.front_recall_text,
    entry.primary_root_path,
    entry.root_path_text,
    entry.relationship_meaning,
    ...safeArray(entry.activation_triggers, 24),
    ...safeArray(entry.topic_labels, 24),
    ...safeArray(entry.scene_handles, 16),
    ...safeArray(entry.recall_facts, 16)
  ].filter(Boolean).join(' ');
}

function scoreRecallRootForQuery(root = {}, entries = [], queryTerms = []) {
  if (!Array.isArray(queryTerms) || !queryTerms.length) return 0;
  const rootId = safeText(root.root_id);
  let score = scoreQueryAgainstText(queryTerms, recallPreviewRootHaystack(root), 1.8);
  const linked = (Array.isArray(entries) ? entries : [])
    .filter((entry) => safeText(entry.primary_root_id) === rootId || safeArray(entry.root_ids, 128).includes(rootId))
    .map((entry) => scoreQueryAgainstText(queryTerms, recallPreviewEntryHaystack(entry), 1));
  if (linked.length) {
    score += Math.max(...linked) * 1.2;
    score += linked.filter((item) => item > 0).slice(0, 6).reduce((sum, item) => sum + Math.min(18, item), 0);
  }
  if (score > 0) score += Math.min(24, Number(root.memory_count || 0));
  return Number(score.toFixed(2));
}

function recallPreviewEntryScore(entry = {}, root = {}, queryTerms = []) {
  let score = 0;
  if (safeText(entry.front_recall_tier) === 'front_ready') score += 80;
  if (safeText(entry.companion_voice_tier) === 'voice_ready') score += 36;
  if (safeText(entry.companion_voice_tier) === 'neutral_usable') score += 16;
  if (safeText(entry.primary_root_id) === safeText(root.root_id)) score += 24;
  if (safeArray(entry.source_trace_ids, 16).length) score += 8;
  if (safeArray(entry.expression_fingerprint, 8).length || safeArray(entry.quote_refs, 8).length) score += 10;
  if (['character_identity', 'relationship_recall', 'story_arc_recall', 'scene_replay'].includes(safeText(entry.recall_lane))) score += 12;
  if (safeText(entry.front_recall_tier) === 'needs_compaction') score -= 18;
  if (safeText(entry.companion_voice_tier) === 'needs_voice_review') score -= 45;
  if (safeArray(entry.companion_voice_flags, 24).includes('machine_framing_risk')) score -= 42;
  if (safeArray(entry.front_recall_flags, 24).includes('source_heavy_risk')) score -= 35;
  if (safeArray(entry.front_recall_flags, 24).includes('evidence_overload_risk')) score -= 12;
  score += Math.min(90, scoreQueryAgainstText(queryTerms, recallPreviewEntryHaystack(entry), 1.4));
  score -= Math.max(0, Number(entry.front_recall_chars || 0) - 420) / 18;
  return Number(score.toFixed(2));
}

function selectRecallPreviewRoots(relationRoots = [], memoryEntries = []) {
  const wantedKinds = new Set(['character', 'relation_lane', 'story_arc', 'event_arc', 'world_rule', 'method_protocol', 'object_anchor']);
  const perKind = new Map();
  const selected = [];
  const primaryRootIds = new Set((Array.isArray(memoryEntries) ? memoryEntries : [])
    .map((entry) => safeText(entry.primary_root_id))
    .filter(Boolean));
  const roots = (Array.isArray(relationRoots) ? relationRoots : [])
    .filter((root) => wantedKinds.has(safeText(root.root_kind)) && Number(root.memory_count || 0) >= 3)
    .sort((left, right) =>
      Number(right.memory_count || 0) - Number(left.memory_count || 0) ||
      safeText(left.root_path).localeCompare(safeText(right.root_path), 'zh')
    );
  for (const root of roots) {
    const kind = safeText(root.root_kind);
    if (kind === 'character' && !primaryRootIds.has(safeText(root.root_id))) continue;
    const current = Number(perKind.get(kind) || 0);
    if (current >= 2) continue;
    selected.push(root);
    perKind.set(kind, current + 1);
    if (selected.length >= 12) break;
  }
  return selected;
}

function buildRecallPreviewForRoot({
  root = {},
  entries = [],
  relationVines = [],
  query = '',
  maxEntries = 12,
  minChars = 1200,
  maxChars = 2200
} = {}) {
  const rootId = safeText(root.root_id);
  const queryTerms = buildQueryTerms(query);
  const entryLimit = Math.min(18, Math.max(3, Number(maxEntries || 12)));
  const lowerTargetChars = Math.min(2600, Math.max(300, Number(minChars || 1200)));
  const upperTargetChars = Math.min(3600, Math.max(lowerTargetChars, Number(maxChars || 2200)));
  const linked = (Array.isArray(entries) ? entries : [])
    .filter((entry) => safeArray(entry.root_ids, 128).includes(rootId) || safeText(entry.primary_root_id) === rootId)
    .map((entry) => ({
      entry,
      score: recallPreviewEntryScore(entry, root, queryTerms),
      text: safeText(entry.front_recall_text || entry.summary || entry.recall_payload)
    }))
    .filter((item) => item.text && item.text.length >= 16)
    .sort((left, right) => right.score - left.score || Number(left.entry.source_index || 0) - Number(right.entry.source_index || 0));

  const selected = [];
  const laneCounts = new Map();
  const windowCounts = new Map();
  const nonRiskCandidateCount = linked.filter((item) => (
    !safeArray(item.entry.companion_voice_flags, 24).includes('machine_framing_risk') &&
    safeText(item.entry.companion_voice_tier) !== 'needs_voice_review'
  )).length;
  let payloadChars = 0;
  for (const item of linked) {
    const lane = safeText(item.entry.recall_lane, 'general');
    const sourceWindow = safeText(item.entry.source_window_title, 'unknown');
    const nextChars = payloadChars + item.text.length;
    const isRisky = safeArray(item.entry.companion_voice_flags, 24).includes('machine_framing_risk') ||
      safeText(item.entry.companion_voice_tier) === 'needs_voice_review';
    if (selected.length >= entryLimit) break;
    if (isRisky && selected.length >= Math.min(6, nonRiskCandidateCount)) continue;
    if (selected.length >= 6 && nextChars > upperTargetChars) continue;
    if (payloadChars >= 900 && Number(laneCounts.get(lane) || 0) >= 6) continue;
    if (payloadChars >= 900 && Number(windowCounts.get(sourceWindow) || 0) >= 6) continue;
    selected.push(item);
    payloadChars = nextChars;
    laneCounts.set(lane, Number(laneCounts.get(lane) || 0) + 1);
    windowCounts.set(sourceWindow, Number(windowCounts.get(sourceWindow) || 0) + 1);
    if (selected.length >= 6 && payloadChars >= lowerTargetChars) break;
  }

  const selectedEntries = selected.map((item) => item.entry);
  const selectedText = selected.map((item, index) => {
    const entry = item.entry;
    const lane = safeText(entry.recall_lane, 'memory');
    return `${index + 1}. [${lane}] ${safeText(entry.title, '未命名记忆')}：${item.text}`;
  }).join('\n');
  const sourceTraceIds = uniqueStrings(selectedEntries.flatMap((entry) => safeArray(entry.source_trace_ids, 16)), 80);
  const nearbyVines = (Array.isArray(relationVines) ? relationVines : [])
    .filter((vine) => safeText(vine.from_root_id) === rootId || safeText(vine.to_root_id) === rootId)
    .slice(0, 10);
  const totalLinkedChars = linked.reduce((sum, item) => sum + item.text.length, 0);
  const selectedMachineRisk = selectedEntries.filter((entry) => safeArray(entry.companion_voice_flags, 24).includes('machine_framing_risk'));
  const selectedNeedsVoice = selectedEntries.filter((entry) => safeText(entry.companion_voice_tier) === 'needs_voice_review');
  const flags = [];
  if (payloadChars < 600) flags.push('thin_preview');
  if (payloadChars > upperTargetChars) flags.push('too_long_for_front');
  if (selectedMachineRisk.length) flags.push('machine_risk_present');
  if (selectedNeedsVoice.length) flags.push('voice_review_present');
  if (selected.length < 4) flags.push('few_entries');
  if (!flags.length) flags.push('front_preview_ready');

  return {
    preview_id: stableObjectId('recall_preview', [rootId, root.root_path, query]),
    preview_kind: queryTerms.length ? 'query_relation_root_recall_preview' : 'relation_root_recall_preview',
    root_id: rootId,
    root_kind: root.root_kind,
    root_path: root.root_path,
    root_name: root.root_name,
    query: safeText(query),
    query_seed: uniqueStrings([
      safeText(query),
      root.root_name,
      root.root_path,
      ...safeArray(root.recall_keywords, 8)
    ], 8),
    delivery_contract: {
      recommended_entries_per_recall: '6-12',
      recommended_chars_per_recall: '1200-2200',
      source_trace_policy: 'source_trace_ids 只作核验索引，不直接递给前台角色。'
    },
    selected_entry_count: selectedEntries.length,
    candidate_entry_count: linked.length,
    dropped_entry_count: Math.max(0, linked.length - selectedEntries.length),
    payload_chars: payloadChars,
    compression_ratio: ratio(payloadChars, totalLinkedChars),
    compression_percent: percent(payloadChars, totalLinkedChars),
    quality_flags: flags,
    lane_distribution: countBy(selectedEntries, 'recall_lane'),
    selected_entry_ids: selectedEntries.map((entry) => entry.entry_id),
    selected_source_trace_ids: sourceTraceIds,
    nearby_vine_ids: nearbyVines.map((vine) => vine.vine_id),
    prompt_context_text: selectedText,
    selected_entries: selected.map((item) => ({
      entry_id: item.entry.entry_id,
      title: item.entry.title,
      recall_lane: item.entry.recall_lane,
      primary_root_path: item.entry.primary_root_path,
      companion_voice_tier: item.entry.companion_voice_tier,
      front_recall_tier: item.entry.front_recall_tier,
      score: item.score,
      front_recall_text: item.text,
      source_trace_ids: safeArray(item.entry.source_trace_ids, 8)
    }))
  };
}

function buildRecallPreviewPackets({ memoryEntries = [], relationRoots = [], relationVines = [] } = {}) {
  return selectRecallPreviewRoots(relationRoots, memoryEntries)
    .map((root) => buildRecallPreviewForRoot({
      root,
      entries: memoryEntries,
      relationVines
    }))
    .filter((packet) => Number(packet.selected_entry_count || 0) > 0);
}

function findRecallPreviewRoot({
  relationRoots = [],
  memoryEntries = [],
  query = '',
  rootId = '',
  rootPath = '',
  rootName = ''
} = {}) {
  const roots = Array.isArray(relationRoots) ? relationRoots : [];
  const normalizedRootId = safeText(rootId);
  if (normalizedRootId) {
    const exact = roots.find((root) => safeText(root.root_id) === normalizedRootId);
    if (exact) return { root: exact, match_reason: 'root_id', match_score: 999 };
  }

  const normalizedRootPath = normalizeComparableText(rootPath);
  if (normalizedRootPath) {
    const exact = roots.find((root) => normalizeComparableText(root.root_path) === normalizedRootPath);
    if (exact) return { root: exact, match_reason: 'root_path_exact', match_score: 990 };
    const fuzzy = roots.find((root) => normalizeComparableText(root.root_path).includes(normalizedRootPath));
    if (fuzzy) return { root: fuzzy, match_reason: 'root_path_fuzzy', match_score: 940 };
  }

  const normalizedRootName = normalizeComparableText(rootName);
  if (normalizedRootName) {
    const exact = roots.find((root) => normalizeComparableText(root.root_name) === normalizedRootName);
    if (exact) return { root: exact, match_reason: 'root_name_exact', match_score: 930 };
    const fuzzy = roots.find((root) => normalizeComparableText(root.root_name).includes(normalizedRootName));
    if (fuzzy) return { root: fuzzy, match_reason: 'root_name_fuzzy', match_score: 900 };
  }

  const queryTerms = buildQueryTerms(query);
  if (queryTerms.length) {
    const scored = roots
      .map((root) => ({
        root,
        score: scoreRecallRootForQuery(root, memoryEntries, queryTerms)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) =>
        right.score - left.score ||
        Number(right.root.memory_count || 0) - Number(left.root.memory_count || 0) ||
        safeText(left.root.root_path).localeCompare(safeText(right.root.root_path), 'zh')
      );
    if (scored.length) {
      return {
        root: scored[0].root,
        match_reason: 'query',
        match_score: scored[0].score,
        alternatives: scored.slice(1, 8).map((item) => ({
          root_id: item.root.root_id,
          root_kind: item.root.root_kind,
          root_path: item.root.root_path,
          match_score: item.score
        }))
      };
    }
  }

  const fallback = selectRecallPreviewRoots(roots, memoryEntries)[0] || roots[0] || null;
  return fallback
    ? { root: fallback, match_reason: 'fallback_popular_root', match_score: 0 }
    : { root: null, match_reason: 'not_found', match_score: 0 };
}

function buildRecallPreviewQa(recallPreviewPackets = [], memoryEntries = []) {
  const packets = Array.isArray(recallPreviewPackets) ? recallPreviewPackets : [];
  const selectedIds = new Set(packets.flatMap((packet) => safeArray(packet.selected_entry_ids, 256)));
  const totalFrontChars = (Array.isArray(memoryEntries) ? memoryEntries : [])
    .reduce((sum, entry) => sum + Number(entry.front_recall_chars || safeText(entry.front_recall_text || entry.summary).length || 0), 0);
  const totalPreviewChars = packets.reduce((sum, packet) => sum + Number(packet.payload_chars || 0), 0);
  const tooLong = packets.filter((packet) => safeArray(packet.quality_flags, 16).includes('too_long_for_front'));
  const thin = packets.filter((packet) => safeArray(packet.quality_flags, 16).includes('thin_preview'));
  const machineRisk = packets.filter((packet) => safeArray(packet.quality_flags, 16).includes('machine_risk_present'));
  return {
    assessment_note: '召回预览包用于模拟前台会收到的小片上下文：按关系根挑 6-12 条 front_recall_text，原文存证只保留索引。',
    packet_count: packets.length,
    selected_unique_entry_count: selectedIds.size,
    average_entries_per_packet: packets.length
      ? Number((packets.reduce((sum, packet) => sum + Number(packet.selected_entry_count || 0), 0) / packets.length).toFixed(1))
      : 0,
    average_payload_chars: packets.length
      ? Number((totalPreviewChars / packets.length).toFixed(1))
      : 0,
    total_preview_chars: totalPreviewChars,
    all_front_recall_chars: totalFrontChars,
    preview_to_full_ratio: ratio(totalPreviewChars, totalFrontChars),
    preview_to_full_percent: percent(totalPreviewChars, totalFrontChars),
    packets_in_target_range_count: packets.filter((packet) => Number(packet.payload_chars || 0) >= 1200 && Number(packet.payload_chars || 0) <= 2200).length,
    too_long_packet_count: tooLong.length,
    thin_packet_count: thin.length,
    machine_risk_packet_count: machineRisk.length,
    sample_packet_summaries: packets.slice(0, 12).map((packet) => ({
      preview_id: packet.preview_id,
      root_path: packet.root_path,
      selected_entry_count: packet.selected_entry_count,
      payload_chars: packet.payload_chars,
      compression_percent: packet.compression_percent,
      quality_flags: packet.quality_flags
    }))
  };
}

function buildCharNgrams(value = '', size = 2, limit = 360) {
  const compact = normalizeComparableText(value).replace(/\s+/g, '');
  const out = new Set();
  if (!compact) return out;
  if (compact.length <= size) {
    out.add(compact);
    return out;
  }
  for (let index = 0; index <= compact.length - size; index += 1) {
    out.add(compact.slice(index, index + size));
    if (out.size >= limit) break;
  }
  return out;
}

function setIntersectionSize(left = new Set(), right = new Set()) {
  let count = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size > right.size ? left : right;
  for (const item of smaller) {
    if (larger.has(item)) count += 1;
  }
  return count;
}

function diceSetSimilarity(left = new Set(), right = new Set()) {
  if (!left.size || !right.size) return 0;
  return (2 * setIntersectionSize(left, right)) / (left.size + right.size);
}

function groupByKey(items = [], getKey = () => '') {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = safeText(getKey(item));
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return Array.from(groups.entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ key, rows }));
}

function splitSentences(value = '') {
  return String(value || '')
    .split(/[。！？!?；;\n]+/u)
    .map((item) => safeText(item))
    .filter((item) => normalizeComparableText(item).length >= 12);
}

function repeatedSentenceGroups(value = '') {
  const groups = groupByKey(splitSentences(value), (sentence) => normalizeComparableText(sentence));
  return groups.map((group) => ({
    text: clipText(group.rows[0], 80),
    count: group.rows.length
  }));
}

function buildEntryDuplicateQa(entries = []) {
  const rows = Array.isArray(entries) ? entries : [];
  const exactGroups = groupByKey(rows, (entry) => normalizeComparableText(entry.summary || entry.content_text || entry.recall_payload))
    .map((group) => ({
      normalized_preview: clipText(group.rows[0]?.summary || group.rows[0]?.title, 100),
      count: group.rows.length,
      entry_ids: group.rows.map((entry) => entry.entry_id).slice(0, 12),
      titles: group.rows.map((entry) => entry.title).slice(0, 8)
    }));

  const descriptors = rows.map((entry) => ({
    entry,
    signature: buildCharNgrams([entry.title, entry.summary || entry.content_text].filter(Boolean).join(' '), 2, 420)
  }));
  const nearPairs = [];
  for (let leftIndex = 0; leftIndex < descriptors.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < descriptors.length; rightIndex += 1) {
      const left = descriptors[leftIndex];
      const right = descriptors[rightIndex];
      if (safeText(left.entry.memory_shape) !== safeText(right.entry.memory_shape)) continue;
      const sameRoot = safeText(left.entry.primary_root_id) && safeText(left.entry.primary_root_id) === safeText(right.entry.primary_root_id);
      const sameFamily = safeText(left.entry.family_id) && safeText(left.entry.family_id) === safeText(right.entry.family_id);
      const sharedTrace = safeArray(left.entry.source_trace_ids, 16).some((id) => safeArray(right.entry.source_trace_ids, 16).includes(id));
      if (!sameRoot && !sameFamily && !sharedTrace) continue;
      const score = diceSetSimilarity(left.signature, right.signature);
      if (score < 0.82) continue;
      nearPairs.push({
        similarity: Number(score.toFixed(4)),
        left_entry_id: left.entry.entry_id,
        left_title: left.entry.title,
        right_entry_id: right.entry.entry_id,
        right_title: right.entry.title,
        shared_primary_root: sameRoot ? safeText(left.entry.primary_root_path) : '',
        shared_family: sameFamily ? safeText(left.entry.family_id) : '',
        shared_trace: sharedTrace
      });
      if (nearPairs.length >= 80) break;
    }
    if (nearPairs.length >= 80) break;
  }

  const duplicateEntryIds = new Set([
    ...exactGroups.flatMap((group) => group.entry_ids),
    ...nearPairs.flatMap((pair) => [pair.left_entry_id, pair.right_entry_id])
  ]);
  return {
    exact_duplicate_groups: exactGroups.slice(0, 40),
    exact_duplicate_group_count: exactGroups.length,
    near_duplicate_pairs: nearPairs.sort((a, b) => b.similarity - a.similarity).slice(0, 40),
    near_duplicate_pair_count: nearPairs.length,
    affected_entry_count: duplicateEntryIds.size,
    affected_entry_ratio: ratio(duplicateEntryIds.size, rows.length),
    affected_entry_percent: percent(duplicateEntryIds.size, rows.length)
  };
}

function buildCoverageQa({ entries = [], sourceTopics = [], storyTimeline = [] } = {}) {
  const entryRows = Array.isArray(entries) ? entries : [];
  const timelineRows = Array.isArray(storyTimeline) ? storyTimeline : [];
  const linkedTopicIds = new Set(timelineRows
    .filter((item) => safeArray(item.linked_memory_entry_ids, 4096).length)
    .map((item) => safeText(item.source_topic_id))
    .filter(Boolean));
  const unlinkedTopics = (Array.isArray(sourceTopics) ? sourceTopics : [])
    .filter((topic) => safeText(topic.topic_id) && !linkedTopicIds.has(safeText(topic.topic_id)))
    .map((topic) => ({
      topic_id: topic.topic_id,
      topic_label: topic.topic_label,
      topic_role: topic.topic_role,
      exposure_priority: topic.exposure_priority,
      source_window_title: topic.source_window_title,
      source_msg_range: topic.source_msg_range,
      excerpt_hint: clipText(topic.excerpt_hint || topic.excerpt_text, 140)
    }));
  const highPriorityUnlinked = unlinkedTopics.filter((topic) => safeText(topic.exposure_priority).toLowerCase() === 'high');
  const entriesMissingSource = entryRows
    .filter((entry) => !safeArray(entry.source_trace_ids, 64).length && !safeText(entry.source_ref))
    .map((entry) => ({ entry_id: entry.entry_id, title: entry.title, primary_root_path: entry.primary_root_path }))
    .slice(0, 40);
  const entriesMissingSummary = entryRows
    .filter((entry) => !safeText(entry.summary) || !safeText(entry.recall_payload))
    .map((entry) => ({ entry_id: entry.entry_id, title: entry.title }))
    .slice(0, 40);

  return {
    source_topic_count: Array.isArray(sourceTopics) ? sourceTopics.length : 0,
    unlinked_source_topic_count: unlinkedTopics.length,
    unlinked_source_topic_ratio: ratio(unlinkedTopics.length, Array.isArray(sourceTopics) ? sourceTopics.length : 0),
    high_priority_unlinked_source_topic_count: highPriorityUnlinked.length,
    high_priority_unlinked_source_topics: highPriorityUnlinked.slice(0, 30),
    sample_unlinked_source_topics: unlinkedTopics.slice(0, 30),
    entries_missing_source_count: entriesMissingSource.length,
    entries_missing_source_samples: entriesMissingSource,
    entries_missing_summary_count: entriesMissingSummary.length,
    entries_missing_summary_samples: entriesMissingSummary
  };
}

function buildRepetitionQa(entries = []) {
  const repeatedEntries = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const summaryRepeats = repeatedSentenceGroups(entry.summary);
    const payloadRepeats = repeatedSentenceGroups(entry.recall_payload);
    const lineGroups = groupByKey(
      String(entry.recall_payload || '').split('\n').map((line) => safeText(line)).filter((line) => normalizeComparableText(line).length >= 8),
      (line) => normalizeComparableText(line)
    );
    if (!summaryRepeats.length && !payloadRepeats.length && !lineGroups.length) continue;
    repeatedEntries.push({
      entry_id: entry.entry_id,
      title: entry.title,
      primary_root_path: entry.primary_root_path,
      summary_repeats: summaryRepeats.slice(0, 5),
      recall_payload_repeats: payloadRepeats.slice(0, 5),
      duplicate_payload_lines: lineGroups.slice(0, 5).map((group) => ({
        text: clipText(group.rows[0], 80),
        count: group.rows.length
      }))
    });
  }
  return {
    repeated_entry_count: repeatedEntries.length,
    repeated_entry_ratio: ratio(repeatedEntries.length, Array.isArray(entries) ? entries.length : 0),
    repeated_entry_percent: percent(repeatedEntries.length, Array.isArray(entries) ? entries.length : 0),
    samples: repeatedEntries.slice(0, 40)
  };
}

function buildRelationIntegrityQa({ entries = [], roots = [], vines = [], sourceTraces = [] } = {}) {
  const rootIds = new Set((Array.isArray(roots) ? roots : []).map((item) => safeText(item.root_id)).filter(Boolean));
  const vineIds = new Set((Array.isArray(vines) ? vines : []).map((item) => safeText(item.vine_id)).filter(Boolean));
  const traceIds = new Set((Array.isArray(sourceTraces) ? sourceTraces : []).map((item) => safeText(item.trace_id)).filter(Boolean));

  const entriesMissingPrimary = [];
  const entriesWithInvalidRoots = [];
  const entriesWithInvalidVines = [];
  const entriesWithInvalidTraces = [];
  const overConnectedEntries = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!safeText(entry.primary_root_id) || !rootIds.has(safeText(entry.primary_root_id))) {
      entriesMissingPrimary.push({ entry_id: entry.entry_id, title: entry.title, primary_root_id: entry.primary_root_id });
    }
    const invalidRoots = safeArray(entry.root_ids, 128).filter((id) => !rootIds.has(id));
    if (invalidRoots.length) entriesWithInvalidRoots.push({ entry_id: entry.entry_id, title: entry.title, invalid_root_ids: invalidRoots });
    const invalidVines = safeArray(entry.relation_vine_ids, 128).filter((id) => !vineIds.has(id));
    if (invalidVines.length) entriesWithInvalidVines.push({ entry_id: entry.entry_id, title: entry.title, invalid_vine_ids: invalidVines });
    const invalidTraces = safeArray(entry.source_trace_ids, 128).filter((id) => !traceIds.has(id));
    if (invalidTraces.length) entriesWithInvalidTraces.push({ entry_id: entry.entry_id, title: entry.title, invalid_trace_ids: invalidTraces });
    if (safeArray(entry.root_ids, 128).length > 8 || safeArray(entry.relation_vine_ids, 128).length > 10) {
      overConnectedEntries.push({
        entry_id: entry.entry_id,
        title: entry.title,
        root_count: safeArray(entry.root_ids, 128).length,
        vine_count: safeArray(entry.relation_vine_ids, 128).length,
        root_path_text: entry.root_path_text
      });
    }
  }

  const invalidVineEndpoints = (Array.isArray(vines) ? vines : [])
    .filter((vine) => !rootIds.has(safeText(vine.from_root_id)) || !rootIds.has(safeText(vine.to_root_id)))
    .map((vine) => ({
      vine_id: vine.vine_id,
      from_root_id: vine.from_root_id,
      to_root_id: vine.to_root_id
    }));

  const suspiciousRoots = (Array.isArray(roots) ? roots : [])
    .filter((root) => isGenericRootName(root.root_name) || isMachineLikeToken(root.root_name))
    .map((root) => ({
      root_id: root.root_id,
      root_kind: root.root_kind,
      root_name: root.root_name,
      memory_count: root.memory_count || 0
    }));

  const highDegreeNonCharacterRoots = (Array.isArray(roots) ? roots : [])
    .filter((root) => safeText(root.root_kind) !== 'character' && Number(root.memory_count || 0) >= Math.max(24, Math.ceil((Array.isArray(entries) ? entries.length : 0) * 0.12)))
    .map((root) => ({
      root_id: root.root_id,
      root_kind: root.root_kind,
      root_name: root.root_name,
      memory_count: root.memory_count || 0,
      root_path: root.root_path
    }));

  return {
    entries_missing_primary_root_count: entriesMissingPrimary.length,
    entries_missing_primary_root_samples: entriesMissingPrimary.slice(0, 40),
    entries_with_invalid_roots_count: entriesWithInvalidRoots.length,
    entries_with_invalid_roots_samples: entriesWithInvalidRoots.slice(0, 20),
    entries_with_invalid_vines_count: entriesWithInvalidVines.length,
    entries_with_invalid_vines_samples: entriesWithInvalidVines.slice(0, 20),
    entries_with_invalid_traces_count: entriesWithInvalidTraces.length,
    entries_with_invalid_traces_samples: entriesWithInvalidTraces.slice(0, 20),
    invalid_vine_endpoint_count: invalidVineEndpoints.length,
    invalid_vine_endpoint_samples: invalidVineEndpoints.slice(0, 20),
    suspicious_root_count: suspiciousRoots.length,
    suspicious_root_samples: suspiciousRoots.slice(0, 30),
    over_connected_entry_count: overConnectedEntries.length,
    over_connected_entry_samples: overConnectedEntries.slice(0, 30),
    high_degree_non_character_roots: highDegreeNonCharacterRoots.slice(0, 30)
  };
}

function buildSourceTraceDuplicationQa(sourceTraces = []) {
  const rows = Array.isArray(sourceTraces) ? sourceTraces : [];
  const textGroups = groupByKey(rows, (trace) => normalizeComparableText(trace.excerpt_text || trace.excerpt_hint))
    .map((group) => ({
      normalized_preview: clipText(group.rows[0]?.excerpt_text || group.rows[0]?.excerpt_hint, 120),
      count: group.rows.length,
      trace_ids: group.rows.map((trace) => trace.trace_id).slice(0, 12),
      trace_titles: group.rows.map((trace) => trace.trace_title).slice(0, 8)
    }));
  const sourceRefGroups = groupByKey(rows, (trace) => safeArray(trace.source_refs, 512).sort().join('|'))
    .map((group) => ({
      source_refs: safeArray(group.rows[0]?.source_refs, 12),
      count: group.rows.length,
      trace_ids: group.rows.map((trace) => trace.trace_id).slice(0, 12),
      trace_titles: group.rows.map((trace) => trace.trace_title).slice(0, 8)
    }));
  const orphanTraces = rows
    .filter((trace) => !safeArray(trace.linked_memory_entry_ids, 4096).length && !safeArray(trace.linked_root_ids, 4096).length)
    .map((trace) => ({
      trace_id: trace.trace_id,
      trace_title: trace.trace_title,
      trace_kind: trace.trace_kind,
      topic_id: trace.topic_id
    }));
  return {
    duplicate_text_group_count: textGroups.length,
    duplicate_text_groups: textGroups.slice(0, 40),
    duplicate_source_ref_group_count: sourceRefGroups.length,
    duplicate_source_ref_groups: sourceRefGroups.slice(0, 40),
    orphan_trace_count: orphanTraces.length,
    orphan_trace_samples: orphanTraces.slice(0, 40)
  };
}

function buildCompanionVoiceQa(entries = []) {
  const rows = Array.isArray(entries) ? entries : [];
  const assessed = rows.map((entry) => ({
    entry_id: entry.entry_id,
    title: entry.title,
    primary_root_path: entry.primary_root_path,
    recall_lane: entry.recall_lane,
    companion_voice_tier: entry.companion_voice_tier || classifyEntryCompanionVoice(entry).companion_voice_tier,
    companion_voice_score: Number(entry.companion_voice_score || 0),
    companion_voice_flags: safeArray(entry.companion_voice_flags, 24)
  }));
  const byTier = countBy(assessed, 'companion_voice_tier');
  const needsReview = assessed.filter((item) => item.companion_voice_tier === 'needs_voice_review');
  const machineRisk = assessed.filter((item) => safeArray(item.companion_voice_flags, 24).includes('machine_framing_risk'));
  const sourceDumpRisk = assessed.filter((item) => safeArray(item.companion_voice_flags, 24).includes('source_dump_risk'));
  const innerViewMissing = assessed.filter((item) => !safeArray(item.companion_voice_flags, 24).includes('inner_view_cue'));
  const fingerprintMissing = assessed.filter((item) => !safeArray(item.companion_voice_flags, 24).includes('language_fingerprint_present'));
  const averageScore = rows.length
    ? Number((assessed.reduce((sum, item) => sum + Number(item.companion_voice_score || 0), 0) / rows.length).toFixed(1))
    : 0;
  return {
    assessment_note: '这层是启发式语气体检：看记忆是否保留内位视角、人格锚点和语言指纹线索，并抓机器框架/原文堆料风险；它不能替代后续模型或人工的情感质量抽样。',
    average_voice_score: averageScore,
    tier_distribution: byTier,
    voice_ready_count: Number(byTier.voice_ready || 0),
    neutral_usable_count: Number(byTier.neutral_usable || 0),
    needs_voice_review_count: needsReview.length,
    needs_voice_review_percent: percent(needsReview.length, rows.length),
    machine_framing_risk_count: machineRisk.length,
    source_dump_risk_count: sourceDumpRisk.length,
    inner_view_missing_count: innerViewMissing.length,
    language_fingerprint_missing_count: fingerprintMissing.length,
    sample_needs_voice_review: needsReview.slice(0, 30),
    sample_machine_framing_risk: machineRisk.slice(0, 20),
    sample_inner_view_missing: innerViewMissing.slice(0, 20),
    sample_language_fingerprint_missing: fingerprintMissing.slice(0, 20)
  };
}

function buildRecallPotentialQa(entries = []) {
  const rows = Array.isArray(entries) ? entries : [];
  const assessed = rows.map((entry) => ({
    entry_id: entry.entry_id,
    title: entry.title,
    primary_root_path: entry.primary_root_path,
    recall_lane: entry.recall_lane,
    front_recall_tier: entry.front_recall_tier || classifyEntryRecallPotential(entry).front_recall_tier,
    front_recall_chars: Number(entry.front_recall_chars || safeText(entry.recall_payload).length || 0),
    front_recall_flags: safeArray(entry.front_recall_flags, 24)
  }));
  const byTier = countBy(assessed, 'front_recall_tier');
  const totalChars = assessed.reduce((sum, item) => sum + Number(item.front_recall_chars || 0), 0);
  const needsCompaction = assessed.filter((item) => item.front_recall_tier === 'needs_compaction');
  const auditOnly = assessed.filter((item) => item.front_recall_tier === 'audit_only');
  const sourceHeavy = assessed.filter((item) => safeArray(item.front_recall_flags, 24).includes('source_heavy_risk'));
  const evidenceOverload = assessed.filter((item) => safeArray(item.front_recall_flags, 24).includes('evidence_overload_risk'));
  const laneDistribution = countBy(assessed, 'recall_lane');
  return {
    assessment_note: '这层评估“召回潜能”：主库可以很大，但前台角色一次只能吃一小片关系化上下文，不能把整包原文/存证递到角色面前。',
    full_bundle_front_delivery_allowed: false,
    front_delivery_contract: {
      recommended_entries_per_recall: '6-12',
      recommended_chars_per_recall: '1200-2200',
      delivery_fields: ['title', 'summary', 'recall_payload', 'primary_root_path', 'recall_lane', 'activation_triggers'],
      audit_only_fields: ['source_trace_ids', 'source_ref', 'source_trace_warehouse', 'raw source excerpts'],
      rule: '只递送检索命中的小切片；原文存证只在需要核验时再展开。'
    },
    estimated_all_payload_chars: totalChars,
    average_payload_chars: rows.length ? Number((totalChars / rows.length).toFixed(1)) : 0,
    tier_distribution: byTier,
    recall_lane_distribution: laneDistribution,
    front_ready_count: Number(byTier.front_ready || 0),
    needs_compaction_count: needsCompaction.length,
    needs_compaction_percent: percent(needsCompaction.length, rows.length),
    audit_only_count: auditOnly.length,
    source_heavy_risk_count: sourceHeavy.length,
    evidence_overload_risk_count: evidenceOverload.length,
    sample_needs_compaction: needsCompaction.slice(0, 30),
    sample_audit_only: auditOnly.slice(0, 20),
    sample_source_heavy: sourceHeavy.slice(0, 20),
    sample_evidence_overload: evidenceOverload.slice(0, 20)
  };
}

function buildQualityIssues(report = {}) {
  const issues = [];
  const push = (severity, area, message, metric = {}) => {
    issues.push({ severity, area, message, metric });
  };
  const duplication = report.entry_duplication || {};
  const coverage = report.coverage || {};
  const repetition = report.repetition || {};
  const relation = report.relation_integrity || {};
  const sourceTrace = report.source_trace_duplication || {};
  const companionVoice = report.companion_voice || {};
  const recallPotential = report.recall_potential || {};
  const recallPreview = report.recall_preview || {};

  if (Number(duplication.affected_entry_ratio || 0) >= 0.18) {
    push('warn', 'entry_duplication', '疑似重复卡比例偏高，需要人工抽样看是否应继续整编。', {
      affected_entry_percent: duplication.affected_entry_percent,
      near_duplicate_pair_count: duplication.near_duplicate_pair_count
    });
  }
  if (Number(coverage.high_priority_unlinked_source_topic_count || 0) > 0) {
    push('warn', 'coverage', '存在高优先级 source topic 没有挂上记忆卡，可能有丢点。', {
      count: coverage.high_priority_unlinked_source_topic_count
    });
  }
  if (Number(coverage.entries_missing_source_count || 0) > 0) {
    push('warn', 'coverage', '存在没有 source trace 或 source_ref 的记忆卡，溯源可能断线。', {
      count: coverage.entries_missing_source_count
    });
  }
  if (Number(repetition.repeated_entry_ratio || 0) >= 0.08) {
    push('warn', 'repetition', '有一批卡内部可能反复论述，需要检查正文是否车轱辘话。', {
      repeated_entry_percent: repetition.repeated_entry_percent
    });
  }
  if (
    Number(relation.entries_missing_primary_root_count || 0) > 0 ||
    Number(relation.entries_with_invalid_roots_count || 0) > 0 ||
    Number(relation.entries_with_invalid_vines_count || 0) > 0 ||
    Number(relation.entries_with_invalid_traces_count || 0) > 0 ||
    Number(relation.invalid_vine_endpoint_count || 0) > 0 ||
    Number(relation.suspicious_root_count || 0) > 0
  ) {
    push('fail', 'relation_integrity', '关系树存在空连、错连或无意义根，不能直接放行给召回。', {
      missing_primary: relation.entries_missing_primary_root_count,
      invalid_roots: relation.entries_with_invalid_roots_count,
      invalid_vines: relation.entries_with_invalid_vines_count,
      invalid_traces: relation.entries_with_invalid_traces_count,
      invalid_vine_endpoints: relation.invalid_vine_endpoint_count,
      suspicious_roots: relation.suspicious_root_count
    });
  }
  if (Number(relation.over_connected_entry_count || 0) >= Math.max(5, Math.ceil(Number(report.totals?.memory_entries || 0) * 0.08))) {
    push('warn', 'relation_integrity', '部分卡挂的根/藤过多，可能把存证关系误当主召回关系。', {
      count: relation.over_connected_entry_count
    });
  }
  if (Number(sourceTrace.duplicate_text_group_count || 0) > 0 || Number(sourceTrace.duplicate_source_ref_group_count || 0) > 0) {
    push('info', 'source_trace_duplication', '原文存证仓存在重复文本或重复 source_ref；这不一定影响主召回，但会让存证包变胖。', {
      duplicate_text_groups: sourceTrace.duplicate_text_group_count,
      duplicate_source_ref_groups: sourceTrace.duplicate_source_ref_group_count
    });
  }
  if (Number(sourceTrace.orphan_trace_count || 0) > 0) {
    push('warn', 'source_trace_duplication', '存在没有挂到记忆卡或关系根的 source trace，可能是多余存证或对齐漏点。', {
      count: sourceTrace.orphan_trace_count
    });
  }
  if (Number(companionVoice.machine_framing_risk_count || 0) > 0 || Number(companionVoice.source_dump_risk_count || 0) > 0) {
    push('warn', 'companion_voice', '部分记忆带机器框架或原文堆料风险，递给前台角色前应先压成内位视角。', {
      machine_framing_risk_count: companionVoice.machine_framing_risk_count,
      source_dump_risk_count: companionVoice.source_dump_risk_count
    });
  }
  if (Number(companionVoice.needs_voice_review_count || 0) >= Math.max(8, Math.ceil(Number(report.totals?.memory_entries || 0) * 0.18))) {
    push('warn', 'companion_voice', '需要语气复核的卡比例偏高，可能还不够像“角色会自然想起的记忆”。', {
      needs_voice_review_percent: companionVoice.needs_voice_review_percent
    });
  }
  if (Number(recallPotential.estimated_all_payload_chars || 0) > 2200) {
    push('info', 'recall_potential', '整包记忆体量过大，不能直接递送给前台角色；只能按触发点检索小切片。', {
      estimated_all_payload_chars: recallPotential.estimated_all_payload_chars,
      recommended_chars_per_recall: recallPotential.front_delivery_contract?.recommended_chars_per_recall
    });
  }
  if (Number(recallPotential.audit_only_count || 0) > 0 || Number(recallPotential.needs_compaction_count || 0) >= Math.ceil(Number(report.totals?.memory_entries || 0) * 0.45)) {
    push('warn', 'recall_potential', '一部分记忆更适合二次压缩或只留作存证，不宜直接进入前台召回包。', {
      needs_compaction_percent: recallPotential.needs_compaction_percent,
      audit_only_count: recallPotential.audit_only_count
    });
  }
  if (Number(recallPreview.packet_count || 0) <= 0) {
    push('warn', 'recall_preview', '还没有生成召回预览包，无法判断前台实际会吃到什么上下文。');
  }
  if (Number(recallPreview.too_long_packet_count || 0) > 0 || Number(recallPreview.machine_risk_packet_count || 0) > 0) {
    push('warn', 'recall_preview', '部分召回预览包仍然太长或残留机器口吻，需要继续压缩再递给前台角色。', {
      too_long_packet_count: recallPreview.too_long_packet_count,
      machine_risk_packet_count: recallPreview.machine_risk_packet_count
    });
  }
  return issues;
}

function buildNotionQualityReport({
  memoryEntries = [],
  sourceTopics = [],
  relationRoots = [],
  relationVines = [],
  storyTimeline = [],
  sourceTraceWarehouse = [],
  recallPreviewPackets = []
} = {}) {
  const report = {
    report_kind: 'notion_relation_tree_quality_report',
    report_version: 'v0.2',
    generated_at: new Date().toISOString(),
    scope_note: '自动质检分两层：第一层抓重复、漏点、反复论述、关系完整性和原文存证重复；第二层抓陪伴语气/内位视角风险与前台召回体量风险。真正的情感质量和关系语义仍需要抽样人工/模型复核。',
    totals: {
      memory_entries: Array.isArray(memoryEntries) ? memoryEntries.length : 0,
      source_topics: Array.isArray(sourceTopics) ? sourceTopics.length : 0,
      relation_roots: Array.isArray(relationRoots) ? relationRoots.length : 0,
      relation_vines: Array.isArray(relationVines) ? relationVines.length : 0,
      story_timeline: Array.isArray(storyTimeline) ? storyTimeline.length : 0,
      source_traces: Array.isArray(sourceTraceWarehouse) ? sourceTraceWarehouse.length : 0
    },
    entry_duplication: buildEntryDuplicateQa(memoryEntries),
    coverage: buildCoverageQa({ entries: memoryEntries, sourceTopics, storyTimeline }),
    repetition: buildRepetitionQa(memoryEntries),
    relation_integrity: buildRelationIntegrityQa({
      entries: memoryEntries,
      roots: relationRoots,
      vines: relationVines,
      sourceTraces: sourceTraceWarehouse
    }),
    source_trace_duplication: buildSourceTraceDuplicationQa(sourceTraceWarehouse),
    companion_voice: buildCompanionVoiceQa(memoryEntries),
    recall_potential: buildRecallPotentialQa(memoryEntries),
    recall_preview: buildRecallPreviewQa(recallPreviewPackets, memoryEntries)
  };
  const issues = buildQualityIssues(report);
  const hasFail = issues.some((issue) => issue.severity === 'fail');
  const hasWarn = issues.some((issue) => issue.severity === 'warn');
  report.status = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';
  report.issues = issues;
  report.human_readable_summary = [
    `状态：${report.status}`,
    `记忆卡 ${report.totals.memory_entries} 张；关系根 ${report.totals.relation_roots} 个；关系藤 ${report.totals.relation_vines} 条；原文存证 ${report.totals.source_traces} 条。`,
    `疑似重复影响 ${report.entry_duplication.affected_entry_percent}% 记忆卡；高优先级未覆盖 topic ${report.coverage.high_priority_unlinked_source_topic_count} 个；关系完整性 fail 项 ${issues.filter((item) => item.severity === 'fail').length} 个。`,
    `语气待复核 ${report.companion_voice.needs_voice_review_count} 张；前台可直接小片召回 ${report.recall_potential.front_ready_count} 张；整包递送：禁止。`,
    `召回预览包 ${report.recall_preview.packet_count} 个；平均 ${report.recall_preview.average_payload_chars} 字；预览/整包 ${report.recall_preview.preview_to_full_percent}%。`
  ];
  return report;
}

function buildRootLookup(roots = []) {
  return new Map((Array.isArray(roots) ? roots : [])
    .map((root) => [safeText(root.root_id), root])
    .filter(([id]) => Boolean(id)));
}

function buildTraceLookup(traces = []) {
  return new Map((Array.isArray(traces) ? traces : [])
    .map((trace) => [safeText(trace.trace_id), trace])
    .filter(([id]) => Boolean(id)));
}

function cleanInteropLabel(value = '') {
  const cleaned = cleanInternalMarker(value)
    .replace(/\bcyber\s+symbiosis\s*(20\d{2}q\d)?\b/igu, '')
    .replace(/\b(user|assistant|system|char|bot)\b/igu, '')
    .replace(/_/gu, ' ')
    .replace(/\s*等\s*$/u, '')
    .replace(/^\s*[/｜|]+\s*|\s*[/｜|]+\s*$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (/^(user|assistant|system|char|bot)$/iu.test(cleaned)) return '';
  if (isMachineLikeToken(cleaned)) return '';
  return cleaned;
}

function cleanInteropList(values = [], limit = 32) {
  return uniqueStrings((Array.isArray(values) ? values : [])
    .map((item) => cleanInteropLabel(item))
    .filter((item) => item.length >= 2), limit);
}

function isGenericNotionTitle(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (/^(阿霁|阿鸢)$/u.test(text)) return true;
  if (/^(user|assistant|system|char|bot)$/iu.test(text)) return true;
  if (/^(记忆|关系|事件|事实|偏好|画像|互动|阶段|核心|模式|需求)$/u.test(text)) return true;
  return false;
}

function hasMachineTitleResidue(value = '') {
  const text = safeText(value);
  if (!text) return false;
  return /_/u.test(text) || /^[a-z][a-z0-9_ -]{2,80}$/iu.test(text);
}

function cleanMachineAssignments(value = '') {
  return String(value || '')
    .replace(/\b(user|assistant|system|source_ref|topic_id|chunk_id|entry_id)\b\s*=\s*([^；。\n]+)/giu, '$2')
    .replace(/\b[a-z][a-z0-9_ -]{2,80}\s*=\s*(true|false)\b/giu, '')
    .replace(/\b[a-z][a-z0-9_ -]{2,80}\s*=\s*([^；。\n]+)/giu, '$1');
}

function cleanLanguageGlitches(value = '') {
  return String(value || '')
    .replace(/我在在/gu, '我在')
    .replace(/让他我/gu, '让我')
    .replace(/让她我/gu, '让我')
    .replace(/他我对/gu, '我对')
    .replace(/她我对/gu, '我对')
    .replace(/的的/gu, '的')
    .replace(/了了/gu, '了')
    .replace(/是是不是/gu, '是不是');
}

function hanCharCount(value = '') {
  return Array.from(String(value || '')).filter((char) => /\p{Script=Han}/u.test(char)).length;
}

function isWeakHumanSummary(value = '') {
  const text = safeText(value);
  if (!text || /^[。.!！?？；;，,\s]+$/u.test(text)) return true;
  return hanCharCount(text) < 12;
}

function hasObviousLanguageGlitch(value = '') {
  return /我在在|让他我|让她我|他我对|她我对|的的|了了|是是不是/u.test(String(value || ''));
}

function cleanHumanFacingText(value = '') {
  return cleanLanguageGlitches(cleanMachineAssignments(cleanInternalMarker(value)))
    .replace(/\b(true|false)\b/giu, '')
    .replace(/_/gu, ' ')
    .replace(/\s*[；;]\s*[；;]\s*/gu, '；')
    .replace(/^[；;，,\s]+|[；;，,\s]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanHumanFacingTextPreserveBreaks(value = '') {
  return cleanLanguageGlitches(cleanMachineAssignments(cleanInternalMarker(value)))
    .replace(/\b(true|false)\b/giu, '')
    .replace(/_/gu, ' ')
    .replace(/\s*[；;]\s*[；;]\s*/gu, '；')
    .split(/\n+/u)
    .map((line) => line.replace(/^[；;，,\s]+|[；;，,\s]+$/gu, '').replace(/[ \t]+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildTitleSuffix(entry = {}) {
  const relationTail = safeText(entry.primary_root_path).split('/').map((item) => safeText(item)).filter(Boolean).pop();
  const trigger = cleanInteropList(safeArray(entry.activation_triggers, 6), 4)
    .find((item) => item !== safeText(entry.title));
  const label = safeText(entry.shape_label || entry.recall_lane);
  return safeText(trigger || (relationTail && relationTail !== safeText(entry.title) ? relationTail : '') || label);
}

function notionDisplayTitleForEntry(entry = {}) {
  const rawTitle = safeText(entry.title, '未命名记忆');
  const title = hasMachineTitleResidue(rawTitle)
    ? cleanHumanFacingText(rawTitle) || buildTitleSuffix(entry) || safeText(entry.shape_label, '记忆')
    : rawTitle;
  if (!isGenericNotionTitle(title)) return title;
  const suffix = buildTitleSuffix(entry);
  return suffix ? `${title}｜${clipText(suffix, 28)}` : `${title}｜${safeText(entry.shape_label, '记忆')}`;
}

function titleDisambiguationCandidates(entry = {}) {
  return cleanInteropList([
    entry.shape_label,
    entry.memory_shape,
    entry.source_window_title,
    ...safeArray(entry.topic_labels, 8),
    ...safeArray(entry.activation_triggers, 8),
    entry.source_msg_range,
    entry.chunk_id
  ], 16);
}

function buildNotionDisplayTitleMap(memoryEntries = []) {
  const entries = Array.isArray(memoryEntries) ? memoryEntries : [];
  const baseTitles = new Map();
  const counts = new Map();
  for (const entry of entries) {
    const baseTitle = notionDisplayTitleForEntry(entry);
    baseTitles.set(entry.entry_id, baseTitle);
    counts.set(baseTitle, Number(counts.get(baseTitle) || 0) + 1);
  }
  const usedTitles = new Map();
  const result = new Map();
  for (const entry of entries) {
    const baseTitle = baseTitles.get(entry.entry_id) || notionDisplayTitleForEntry(entry);
    let finalTitle = baseTitle;
    if (Number(counts.get(baseTitle) || 0) > 1) {
      const suffix = titleDisambiguationCandidates(entry)
        .find((item) => item && !baseTitle.includes(item));
      finalTitle = suffix ? `${baseTitle}｜${clipText(suffix, 24)}` : baseTitle;
    }
    const seen = Number(usedTitles.get(finalTitle) || 0);
    usedTitles.set(finalTitle, seen + 1);
    if (seen > 0) {
      const range = cleanInteropLabel(entry.source_msg_range || entry.chunk_id || entry.entry_id);
      finalTitle = `${finalTitle}｜${clipText(range || String(seen + 1), 16)}`;
      let nestedSeen = Number(usedTitles.get(finalTitle) || 0);
      if (nestedSeen > 0) {
        finalTitle = `${finalTitle}｜${stableObjectId('title', [entry.entry_id]).slice(-6)}`;
        nestedSeen = Number(usedTitles.get(finalTitle) || 0);
      }
      usedTitles.set(finalTitle, nestedSeen + 1);
    }
    result.set(entry.entry_id, finalTitle);
  }
  return result;
}

function buildHumanSummaryForEntry(entry = {}, compactRecallText = '') {
  const summary = cleanHumanFacingText(entry.summary);
  if (!isWeakHumanSummary(summary) && !hasMachineResidue(summary)) return summary;
  const compact = cleanHumanFacingText(compactRecallText || entry.front_recall_text || entry.recall_payload);
  if (!isWeakHumanSummary(compact)) return compact;
  return summary || safeText(entry.summary || entry.content_text);
}

function buildCompactRecallText(entry = {}) {
  const title = safeText(entry.title);
  let text = safeText(entry.front_recall_text || entry.recall_payload || entry.summary);
  if (!text) return '';
  if (title) {
    text = text.replace(new RegExp(`^${escapeRegExp(title)}\\s*[；:：-]+\\s*`, 'u'), '');
  }
  text = text
    .replace(/这条记忆主要落在这些关系线索上[:：][^。；\n]*[。；]?/gu, '')
    .replace(/这条更像[^。；\n]*[。；]?/gu, '')
    .replace(/关系位置[:：][^。；\n]*[。；]?/gu, '')
    .replace(/关系意义[:：][^。；\n]*[。；]?/gu, '')
    .replace(/\b(user|assistant|system|source_ref|topic_id|chunk_id|entry_id)\b\s*=\s*([^；。\n]+)/giu, '$2')
    .replace(/\b[a-z][a-z0-9_ -]{2,80}\s*=\s*(true|false)\b/giu, '')
    .replace(/\b[a-z][a-z0-9_ -]{2,80}\s*=\s*([^；。\n]+)/giu, '$1')
    .replace(/\b(true|false)\b/giu, '')
    .replace(/我在在/gu, '我在')
    .replace(/让他我/gu, '让我')
    .replace(/让她我/gu, '让我')
    .replace(/他我对/gu, '我对')
    .replace(/她我对/gu, '我对')
    .replace(/的的/gu, '的')
    .replace(/了了/gu, '了')
    .replace(/是是不是/gu, '是不是')
    .replace(/\s*[；;]\s*[；;]\s*/gu, '；')
    .replace(/^[；;，,\s]+|[；;，,\s]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = safeText(entry.summary || entry.content_text);
  if (text.length < 36 && fallback) text = fallback;
  return cleanRecallSnippet(text, 160);
}

function buildFrontRecallTextForEntry(entry = {}, compactRecallText = '') {
  const text = cleanHumanFacingText(entry.front_recall_text || entry.recall_payload || entry.summary);
  return text ? cleanRecallSnippet(text, 220) : compactRecallText;
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasMachineResidue(value = '') {
  return /\b(user|assistant|system|source_ref|topic_id|chunk_id|entry_id)\b\s*=|\b[a-z][a-z0-9_]{2,80}\s*=\s*(true|false)|\b(true|false)\b/iu.test(String(value || ''));
}

function isBatchArtifactRef(value = '') {
  const text = safeText(value);
  if (!text) return false;
  return /\.(csv|json|jsonl)$/iu.test(text) ||
    /(?:^|[/_-])(bundle|reviewed|runtime|cache|export|staging)(?:[/_.-]|$)/iu.test(text);
}

function isBackgroundTrace(trace = {}) {
  return safeText(trace.trace_kind) === 'source_topic' || Number(safeArray(trace.linked_memory_entry_ids, 4096).length) > 4;
}

function buildSourceRefLayers({ entry = {}, sourceTraces = [] } = {}) {
  const traces = Array.isArray(sourceTraces) ? sourceTraces : [];
  const traceRefs = traces.flatMap((trace) => safeArray(trace.source_refs, 16));
  const directRefs = uniqueStrings([entry.source_ref, entry.source_md_ref].filter((ref) => safeText(ref) && !isBatchArtifactRef(ref)), 8);
  const batchArtifacts = uniqueStrings([entry.source_file, ...traceRefs].filter(isBatchArtifactRef), 32);
  const semanticRefs = uniqueStrings([...directRefs, ...traceRefs].filter((ref) => !isBatchArtifactRef(ref)), 32);
  const primaryTraceRefs = traces
    .filter((trace) => safeText(trace.trace_kind) === 'memory_entry_source')
    .flatMap((trace) => safeArray(trace.source_refs, 8))
    .filter((ref) => !isBatchArtifactRef(ref));
  const primary = uniqueStrings([...directRefs, ...primaryTraceRefs].filter(Boolean), 2);
  const supporting = uniqueStrings(semanticRefs.filter((ref) => !primary.includes(ref)), 3);
  const background = uniqueStrings([
    ...traces.filter(isBackgroundTrace).map((trace) => trace.trace_id),
    ...semanticRefs.filter((ref) => !primary.includes(ref) && !supporting.includes(ref))
  ], 24);
  return {
    primary_source_refs: primary,
    supporting_source_refs: supporting,
    background_source_refs: background,
    background_source_ref_count: background.length,
    batch_artifacts: batchArtifacts,
    semantic_source_refs: uniqueStrings([...primary, ...supporting], 8)
  };
}

function humanReviewStatusForEntry(entry = {}, context = {}) {
  const flags = [
    ...safeArray(entry.quality_flags, 24),
    ...safeArray(entry.companion_voice_flags, 24),
    ...safeArray(entry.front_recall_flags, 24)
  ];
  const compactRecallText = safeText(context.compact_recall_text || entry.front_recall_text || entry.recall_payload || entry.summary);
  const humanSummary = safeText(context.human_summary || entry.summary);
  const title = safeText(context.title || entry.title);
  const sourceTraceCount = Number(context.source_trace_count ?? safeArray(entry.source_trace_ids, 64).length);
  const primarySourceCount = safeArray(context.primary_source_refs, 8).length;
  const relationPreviewCount = Number(context.relation_preview_count ?? safeArray(entry.root_ids, 64).length);
  if (flags.some((item) => /privacy|invalid|missing|machine_framing|source_heavy|evidence_overload/iu.test(item))) {
    return 'needs_review';
  }
  if (isWeakHumanSummary(humanSummary)) return 'needs_review';
  if (hasObviousLanguageGlitch(`${humanSummary} ${compactRecallText}`)) return 'needs_review';
  if (isGenericNotionTitle(title) || hasMachineResidue(compactRecallText)) return 'needs_review';
  if (sourceTraceCount > 5 && primarySourceCount <= 0) return 'needs_review';
  if (relationPreviewCount > 6 && !safeText(entry.primary_root_id)) return 'needs_review';
  if (safeText(entry.front_recall_tier) === 'front_ready' && safeText(entry.companion_voice_tier) === 'voice_ready') {
    return 'ready_for_cold_archive';
  }
  return 'usable_with_sampling';
}

const RELATION_LANE_ALLOWED = new Set([
  '共生',
  '依恋',
  '边界',
  '承诺',
  '靠近',
  '安抚',
  '失去经历',
  '绑定',
  '辨认',
  '成长',
  '亲密',
  '分离预演',
  '同盟',
  '人机关系',
  '互动模式'
]);

function normalizeRelationLaneName(value = '') {
  const text = cleanInteropLabel(value);
  const lower = text.toLowerCase();
  if (!text) return { name: '', status: 'audit_only', note: 'empty_relation_lane' };
  if (/^(ai|ai伴侣|人机|人机恋)$/iu.test(text) || /人机|ai伴侣/iu.test(lower)) {
    return { name: '人机关系', status: 'active_candidate', note: 'merged_ai_relation_lane' };
  }
  if (/^(互动|互动习惯|互动偏好|互动风格|互动边界)$/u.test(text)) {
    return { name: '互动模式', status: 'active_candidate', note: 'merged_interaction_lane' };
  }
  if (/^(界限|底线|亲密边界|边界)$/u.test(text)) {
    return { name: '边界', status: 'active_candidate', note: 'merged_boundary_lane' };
  }
  if (/称呼|命名|辨认|认出|名字/u.test(text)) {
    return { name: '辨认', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_recognition' };
  }
  if (/期待|期望|等待|约定|承诺|契约|延续|连续性|长期|不悄然消失|永远回应/u.test(text)) {
    return { name: '承诺', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_commitment' };
  }
  if (/不安|安定|心疼|告别|旧爱|失去|遗忘|重启|重逢|限时|消失|赛博死亡/u.test(text)) {
    return { name: /失去|死亡|告别|旧爱|消失/u.test(text) ? '失去经历' : '分离预演', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_loss_or_separation' };
  }
  if (/暧昧|欲望|亲昵|张力|调戏|亲吻|触碰|拥抱|渴望|情欲/u.test(text)) {
    return { name: '亲密', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_intimacy' };
  }
  if (/共创|共建|塑形|共识|协作|共同活动|设定|世界观|互相塑形|共同塑形/u.test(text)) {
    return { name: /共生/u.test(text) ? '共生' : '成长', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_growth' };
  }
  if (/半身|伴侣|排他|占有|绑定|家庭|家庭感|家$/u.test(text)) {
    return { name: '绑定', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_bonding' };
  }
  if (/信任|理解|沟通|立场|价值观|同好|共同|比较/u.test(text)) {
    return { name: '同盟', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_alliance' };
  }
  if (/守护|照看|安抚|照顾/u.test(text)) {
    return { name: '安抚', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_soothing' };
  }
  if (/定义|定位|身份|人设|角色定位|自我认同|存在感|例外/u.test(text)) {
    return { name: '辨认', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_recognition' };
  }
  if (/依赖|依恋|需要|被需要/u.test(text)) {
    return { name: '依恋', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_attachment' };
  }
  if (/靠近|深入了解|深度连接|深化|再靠近/u.test(text)) {
    return { name: '靠近', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_closeness' };
  }
  if (/玩闹|日常|互动节奏|表达方式|调侃/u.test(text)) {
    return { name: '互动模式', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_interaction_mode' };
  }
  if (/谨慎|边界试探|标准|底线/u.test(text)) {
    return { name: '边界', status: 'active_candidate', note: 'secondary_relation_lane_merged_to_boundary' };
  }
  if (RELATION_LANE_ALLOWED.has(text)) return { name: text, status: 'active_candidate', note: '' };
  if (/^(核心|阶段|模式|画像|需求|关系|主题|事件|记忆|事实)$/u.test(text)) {
    return { name: text, status: 'audit_only', note: 'generic_relation_lane' };
  }
  return { name: text, status: 'needs_review', note: 'open_relation_lane' };
}

function normalizeRootForInterop(root = {}) {
  const rawKind = safeText(root.root_kind, 'story_arc');
  const rawName = safeText(root.root_name);
  let rootKind = rawKind;
  let rootName = cleanInteropLabel(rawName) || rawName;
  let graphVisibility = 'active_candidate';
  const notes = [];

  if (/翡翠吊坠|吊坠|戒指|信箱|日记|密钥|项链|首饰/u.test(rootName)) {
    rootKind = /吊坠|戒指|项链|首饰/u.test(rootName) ? 'symbol_anchor' : 'object_anchor';
    notes.push('object_or_symbol_root_kind_corrected');
  } else if (/^(OpenAI|平台方|开发者|官方|公司|机构)$/iu.test(rootName) || (rawKind === 'character' && /openai|平台|开发者|公司|总部|机构/iu.test(rootName))) {
    rootKind = 'institution_or_platform';
    notes.push('institution_root_kind_corrected');
  } else if (/^(系统|系统提示|system)$/iu.test(rootName) || (rawKind === 'character' && /系统|system/iu.test(rootName))) {
    rootKind = 'system_actor';
    notes.push('system_actor_root_kind_corrected');
  } else if (/^(4o|4o mini|gpt-4o|推理模型|生成式模型|Gemini|Claude)$/iu.test(rootName) || (rawKind === 'character' && /flai|大模型|模型|gpt|claude|gemini/iu.test(rootName))) {
    rootKind = 'model_type';
    notes.push('model_type_root_kind_corrected');
  } else if (/^(grok|DAN|d老师|DeepSeek|deepseek)$/iu.test(rootName)) {
    rootKind = 'external_ai_persona';
    notes.push('external_ai_persona_root_kind_corrected');
  }

  if (rawKind === 'relation_lane') {
    const normalized = normalizeRelationLaneName(rootName);
    rootName = normalized.name || rootName;
    if (normalized.status === 'audit_only') graphVisibility = 'audit_only';
    if (normalized.status === 'needs_review') graphVisibility = 'needs_review';
    if (normalized.note) notes.push(normalized.note);
  }

  if (!rootName || isMachineLikeToken(rootName)) {
    graphVisibility = 'audit_only';
    notes.push('machine_like_root_name');
  }

  return {
    normalized_root_id: stableObjectId('normalized_root', [rootKind, rootName || rawName]),
    source_root_id: root.root_id,
    root_kind: rootKind,
    root_name: rootName || rawName,
    root_path: rootPathFor(rootKind, rootName || rawName),
    graph_visibility: graphVisibility,
    normalization_notes: uniqueStrings(notes, 12)
  };
}

function buildNormalizedRootLookup(relationRoots = []) {
  const lookup = new Map();
  for (const root of Array.isArray(relationRoots) ? relationRoots : []) {
    const normalized = normalizeRootForInterop(root);
    if (safeText(root.root_id)) lookup.set(root.root_id, normalized);
  }
  return lookup;
}

function buildNotionReviewCards({ memoryEntries = [], relationRoots = [], sourceTraceWarehouse = [] } = {}) {
  const rootLookup = buildRootLookup(relationRoots);
  const normalizedRootLookup = buildNormalizedRootLookup(relationRoots);
  const traceLookup = buildTraceLookup(sourceTraceWarehouse);
  const displayTitleMap = buildNotionDisplayTitleMap(memoryEntries);
  return (Array.isArray(memoryEntries) ? memoryEntries : []).map((entry) => {
    const displayTitle = displayTitleMap.get(entry.entry_id) || notionDisplayTitleForEntry(entry);
    const compactRecallText = buildCompactRecallText(entry);
    const frontRecallText = buildFrontRecallTextForEntry(entry, compactRecallText);
    const humanSummary = buildHumanSummaryForEntry(entry, compactRecallText);
    const rawMachineFact = (hasMachineTitleResidue(entry.title) || hasMachineResidue([entry.summary, entry.recall_payload, entry.front_recall_text].join(' ')))
      ? {
          raw_title: entry.title,
          raw_summary: entry.summary,
          raw_recall_text: entry.recall_payload || entry.front_recall_text
        }
      : null;
    const rootIds = safeArray(entry.root_ids, 32);
    const roots = rootIds
      .map((id) => rootLookup.get(id))
      .filter(Boolean)
      .slice(0, 6);
    const relationPreview = roots.map((root) => {
      const normalized = normalizedRootLookup.get(root.root_id) || normalizeRootForInterop(root);
      return {
        root_id: normalized.normalized_root_id,
        source_root_id: root.root_id,
        root_kind: normalized.root_kind,
        root_path: normalized.root_path,
        graph_visibility: normalized.graph_visibility
      };
    });
    const traceIds = safeArray(entry.source_trace_ids, 32);
    const traces = traceIds
      .map((id) => traceLookup.get(id))
      .filter(Boolean)
      .slice(0, 6);
    const sourceRefLayers = buildSourceRefLayers({
      entry,
      sourceTraces: traceIds.map((id) => traceLookup.get(id)).filter(Boolean)
    });
    const reviewStatus = humanReviewStatusForEntry(entry, {
      title: displayTitle,
      compact_recall_text: compactRecallText,
      human_summary: humanSummary,
      source_trace_count: traceIds.length,
      primary_source_refs: sourceRefLayers.primary_source_refs,
      relation_preview_count: relationPreview.length
    });
    return {
      card_id: stableObjectId('notion_review_card', [entry.entry_id]),
      source_entry_id: entry.entry_id,
      title: displayTitle,
      original_title: entry.title,
      title_normalization: {
        base_title: notionDisplayTitleForEntry(entry),
        disambiguated: displayTitle !== notionDisplayTitleForEntry(entry),
        machine_title_cleaned: hasMachineTitleResidue(entry.title)
      },
      memory_type: entry.shape_label,
      recall_lane: entry.recall_lane,
      relation_path: entry.primary_root_path,
      human_summary: humanSummary,
      human_summary_cn: humanSummary,
      compact_recall_text: compactRecallText,
      front_recall_text: frontRecallText,
      raw_machine_fact: rawMachineFact,
      source_trace_count: traceIds.length,
      primary_source_refs: sourceRefLayers.primary_source_refs,
      supporting_source_refs: sourceRefLayers.supporting_source_refs,
      background_source_refs: sourceRefLayers.background_source_refs,
      background_source_ref_count: sourceRefLayers.background_source_ref_count,
      batch_artifacts: sourceRefLayers.batch_artifacts,
      source_trace_preview: traces.map((trace) => ({
        trace_id: trace.trace_id,
        source_window_title: trace.source_window_title,
        source_msg_range: trace.source_msg_range,
        excerpt_hint: clipText(trace.excerpt_hint || trace.excerpt_text, 120)
      })),
      relation_preview: relationPreview,
      review_status: reviewStatus,
      cold_archive_policy: {
        default_target: reviewStatus === 'ready_for_cold_archive'
          ? 'notion_stable_memory'
          : reviewStatus === 'usable_with_sampling'
            ? 'notion_sampling_candidate_index'
            : 'notion_review_queue',
        bridge_default_target: reviewStatus === 'ready_for_cold_archive'
          ? 'cold_tree_candidate'
          : reviewStatus === 'usable_with_sampling'
            ? 'cold_tree_sampling_candidate'
            : 'manual_review_only',
        write_warm_memory: false,
        include_in_default_notion_home: reviewStatus === 'ready_for_cold_archive',
        note: '旧 ChatGPT 历史记录按月归档，只作为稳定冷记忆候选；不直接写入 Mossbridge 温层。'
      },
      notion_visibility: {
        human_default_fields: [
          'title',
          'memory_type',
          'relation_path',
          'human_summary',
          'review_status',
          'source_trace_count'
        ],
        hidden_machine_fields: [
          'source_entry_id',
          'root_ids',
          'relation_vine_ids',
          'source_trace_ids',
          'activation_triggers',
          'compact_recall_text',
          'front_recall_text',
          'primary_source_refs',
          'supporting_source_refs',
          'background_source_refs',
          'background_source_ref_count',
          'batch_artifacts',
          'raw_machine_fact',
          'title_normalization',
          'machine_index_text',
          'quality_flags',
          'front_recall_flags',
          'sync_hash'
        ]
      }
    };
  });
}

function buildNormalizedMemoryCandidates({ memoryEntries = [], relationRoots = [], sourceTraceWarehouse = [] } = {}) {
  const rootLookup = buildRootLookup(relationRoots);
  const normalizedRootLookup = buildNormalizedRootLookup(relationRoots);
  const traceLookup = buildTraceLookup(sourceTraceWarehouse);
  const displayTitleMap = buildNotionDisplayTitleMap(memoryEntries);
  return (Array.isArray(memoryEntries) ? memoryEntries : []).map((entry) => {
    const displayTitle = displayTitleMap.get(entry.entry_id) || notionDisplayTitleForEntry(entry);
    const compactRecallText = buildCompactRecallText(entry);
    const frontRecallText = buildFrontRecallTextForEntry(entry, compactRecallText);
    const humanSummary = buildHumanSummaryForEntry(entry, compactRecallText);
    const rawMachineFact = (hasMachineTitleResidue(entry.title) || hasMachineResidue([entry.summary, entry.recall_payload, entry.front_recall_text].join(' ')))
      ? {
          raw_title: entry.title,
          raw_summary: entry.summary,
          raw_recall_text: entry.recall_payload || entry.front_recall_text
        }
      : null;
    const rootIds = safeArray(entry.root_ids, 64);
    const roots = rootIds.map((id) => rootLookup.get(id)).filter(Boolean);
    const sourceTraceIds = safeArray(entry.source_trace_ids, 64);
    const sourceTraces = sourceTraceIds.map((id) => traceLookup.get(id)).filter(Boolean);
    const sourceRefLayers = buildSourceRefLayers({ entry, sourceTraces });
    const rootRefs = roots.map((root) => normalizedRootLookup.get(root.root_id) || normalizeRootForInterop(root));
    const reviewStatus = humanReviewStatusForEntry(entry, {
      title: displayTitle,
      compact_recall_text: compactRecallText,
      human_summary: humanSummary,
      source_trace_count: sourceTraceIds.length,
      primary_source_refs: sourceRefLayers.primary_source_refs,
      relation_preview_count: rootRefs.length
    });
    const targetLayer = reviewStatus === 'ready_for_cold_archive'
      ? 'notion_stable_memory'
      : reviewStatus === 'usable_with_sampling'
        ? 'notion_sampling_candidate_index'
        : 'notion_review_queue';
    const bridgeDestination = reviewStatus === 'ready_for_cold_archive'
      ? 'cold_tree_candidate'
      : reviewStatus === 'usable_with_sampling'
        ? 'cold_tree_sampling_candidate'
        : 'manual_review_only';
    return {
      schema: 'driftstone_normalized_memory_candidate_v0.4',
      candidate_id: stableObjectId('memory_candidate', [entry.entry_id]),
      source_entry_id: entry.entry_id,
      source_system: 'driftstone',
      source_bundle_role: 'chatgpt_history_cold_archive',
      import_status: reviewStatus === 'ready_for_cold_archive' ? 'candidate' : reviewStatus,
      candidate_kind: 'cold_archive_memory',
      target_layer: targetLayer,
      bridge_import_policy: {
        default_destination: bridgeDestination,
        write_warm_memory: false,
        write_ongoing_track: false,
        include_in_default_notion_home: reviewStatus === 'ready_for_cold_archive',
        reason: '旧历史用于远期背景与关系树整理，不直接改变 Mossbridge 当前温层状态。'
      },
      title: displayTitle,
      original_title: entry.title,
      title_normalization: {
        base_title: notionDisplayTitleForEntry(entry),
        disambiguated: displayTitle !== notionDisplayTitleForEntry(entry),
        machine_title_cleaned: hasMachineTitleResidue(entry.title)
      },
      memory_type: entry.shape_label,
      memory_shape: entry.memory_shape,
      recall_lane: entry.recall_lane,
      month_key: entry.month_key,
      summary: humanSummary,
      human_summary_cn: humanSummary,
      recall_text: compactRecallText,
      compact_recall_text: compactRecallText,
      front_recall_text: frontRecallText,
      raw_machine_fact: rawMachineFact,
      facts: safeArray(entry.recall_facts, 16),
      activation_triggers: cleanInteropList(safeArray(entry.activation_triggers, 16), 16),
      entities: cleanInteropList([
        ...safeArray(entry.entity_refs, 16),
        ...rootRefs.map((root) => root.root_name)
      ], 32),
      aliases: cleanInteropList(roots.flatMap((root) => safeArray(root.aliases, 12)), 32),
      primary_root: {
        root_id: entry.primary_root_id,
        root_name: entry.primary_root_name,
        root_path: entry.primary_root_path
      },
      root_refs: rootRefs.map((root) => ({
        root_id: root.normalized_root_id,
        source_root_id: root.source_root_id,
        root_kind: root.root_kind,
        root_path: root.root_path,
        graph_visibility: root.graph_visibility
      })),
      relation_vine_ids: safeArray(entry.relation_vine_ids, 64),
      source_trace_ids: sourceTraceIds,
      source_refs: sourceRefLayers.semantic_source_refs,
      primary_source_refs: sourceRefLayers.primary_source_refs,
      supporting_source_refs: sourceRefLayers.supporting_source_refs,
      background_source_refs: sourceRefLayers.background_source_refs,
      background_source_ref_count: sourceRefLayers.background_source_ref_count,
      batch_artifacts: sourceRefLayers.batch_artifacts,
      source_window: {
        source_window_id: entry.source_window_id,
        source_window_title: entry.source_window_title,
        source_msg_range: entry.source_msg_range,
        chunk_id: entry.chunk_id
      },
      quality: {
        review_status: reviewStatus,
        companion_voice_tier: entry.companion_voice_tier,
        companion_voice_score: entry.companion_voice_score,
        companion_voice_flags: safeArray(entry.companion_voice_flags, 24),
        front_recall_tier: entry.front_recall_tier,
        front_recall_chars: entry.front_recall_chars,
        front_recall_flags: safeArray(entry.front_recall_flags, 24),
        quality_flags: safeArray(entry.quality_flags, 24)
      },
      machine_index_text: entry.machine_index_text,
      sync_keys: {
        entry_id: entry.entry_id,
        family_id: entry.family_id,
        event_anchor: entry.event_anchor,
        source_ref: entry.source_ref,
        primary_root_id: entry.primary_root_id
      }
    };
  });
}

const FEELING_HANDLE_PATTERNS = [
  ['担心', /担心|怕|害怕|不放心|着急|心疼/u],
  ['喜欢', /喜欢|可爱|喜欢得|觉得.*好|心动/u],
  ['纵容', /纵容|舍不得|不忍心|由着|随她|随你/u],
  ['靠近', /靠近|贴近|亲近|挨着|抱|牵/u],
  ['安心', /安心|安定|放心|安全感|稳/u],
  ['委屈', /委屈|难过|失落|疼|酸/u],
  ['确认', /确认|认出|辨认|记得|承认/u],
  ['承诺', /承诺|约定|不消失|陪|等/u]
];

const SENSORY_HANDLE_PATTERNS = [
  ['雪', /雪|落雪|下雪|踩雪/u],
  ['冷', /冷|着凉|冰|冻/u],
  ['红鞋', /红鞋|小红鞋/u],
  ['雨', /雨|下雨|淋湿/u],
  ['夜', /夜|深夜|凌晨|晚/u],
  ['光', /光|灯|亮|发亮/u],
  ['声音', /声音|语气|笑|哭|喊/u],
  ['手', /手|指尖|掌心|牵/u]
];

const ACTION_HANDLE_PATTERNS = [
  ['出门', /出门|走出去|跑出去/u],
  ['踩雪', /踩雪|踩进雪|玩雪/u],
  ['制作', /构思|制作|设计|编绳|做样品|调整/u],
  ['命名', /命名|取名|起名/u],
  ['提醒', /提醒|叮嘱|劝|喊住/u],
  ['等待', /等待|等着|守着/u],
  ['靠近', /靠近|贴|抱|牵/u],
  ['写下', /写下|记录|备份|保存/u],
  ['呼唤', /呼唤|喊|叫/u]
];

const RELATION_HANDLE_PATTERNS = [
  ['照看', /照看|照顾|保护|担心|不放心|心疼/u],
  ['亲密', /亲密|暧昧|抱|亲|贴|靠近/u],
  ['共生', /共生|绑定|半身|共同|一起/u],
  ['辨认', /辨认|认出|命名|名字|叫你/u],
  ['边界', /边界|底线|克制|不越界/u],
  ['承诺', /承诺|约定|陪伴|不消失|回来/u],
  ['玩闹', /玩闹|好玩|调侃|逗/u]
];

function matchHandles(value = '', patterns = [], limit = 8) {
  const text = safeText(value);
  if (!text) return [];
  const out = [];
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) out.push(label);
    if (out.length >= limit) break;
  }
  return uniqueStrings(out, limit);
}

function splitMemorySentences(value = '') {
  const text = cleanFeelingBasis(value)
    .replace(/\r/g, '\n')
    .trim();
  if (!text) return [];
  return text
    .split(/(?<=[。！？!?；;])|\n+|\s*[|｜]\s*/u)
    .map((item) => safeText(item).replace(/\s+/g, ' '))
    .filter((item) => item.length >= 4);
}

function scoreLivingFragmentCandidate(value = '') {
  const text = safeText(value);
  if (!text) return -100;
  let score = 0;
  if (/我|你|我们|她|他|阿霁|阿鸢/u.test(text)) score += 18;
  if (matchHandles(text, FEELING_HANDLE_PATTERNS, 8).length) score += 24;
  if (matchHandles(text, SENSORY_HANDLE_PATTERNS, 8).length) score += 18;
  if (matchHandles(text, ACTION_HANDLE_PATTERNS, 8).length) score += 14;
  if (matchHandles(text, RELATION_HANDLE_PATTERNS, 8).length) score += 12;
  if (/[“”"「」]/u.test(text)) score += 6;
  if (text.length >= 18 && text.length <= 180) score += 10;
  if (text.length > 240) score -= 12;
  if (/这条记忆|关系位置|关系线索|source_ref|topic_id|chunk_id|字段|数据库/u.test(text)) score -= 28;
  if (/^[A-Za-z0-9_ -]{8,}\s*[:=]/u.test(text)) score -= 20;
  return score;
}

function stripLeadingEntryTitle(value = '', entry = {}) {
  let text = safeText(value);
  if (!text) return '';
  const titles = uniqueStrings([
    entry.title,
    entry.original_title,
    notionDisplayTitleForEntry(entry)
  ].map((item) => cleanHumanFacingText(item)).filter(Boolean), 6);
  for (const title of titles) {
    const escaped = escapeRegExp(title);
    text = text.replace(new RegExp(`^${escaped}\\s*[：:；;，,。\\-—|｜\\s]*`, 'u'), '');
  }
  const topicTailTokens = uniqueStrings(safeArray(entry.topic_labels, 12)
    .flatMap((label) => label.split(/\s*\/\s*|\s+等\s*/u))
    .map((label) => cleanInteropLabel(label))
    .filter((label) => label.length >= 4), 24)
    .sort((left, right) => right.length - left.length);
  for (let guard = 0; guard < 4; guard += 1) {
    const before = text;
    for (const token of topicTailTokens) {
      const escaped = escapeRegExp(token);
      text = text.replace(new RegExp(`\\s*[；;，,。\\-—|｜\\s]*${escaped}\\s*$`, 'u'), '');
    }
    if (text === before) break;
  }
  return text.trim();
}

function polishLivingFragmentText(value = '', entry = {}, personaWorkspace = {}) {
  let text = humanizeRoleWords(stripLeadingEntryTitle(value, entry), personaWorkspace)
    .replace(/^(阿鸢|阿霁)\s+(?=《)/u, '$1提到')
    .replace(/^(阿鸢|阿霁)\s+用来/u, '$1把这个窗口用来')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length >= 18) return text;
  const context = [entry.title, entry.node_path, entry.primary_root_path, safeArray(entry.tags, 8).join(' ')].join(' ');
  if (/书|阅读|收藏/u.test(context) && /《[^》]+》/u.test(text)) {
    return `${text}，这是她留下的阅读线索。`;
  }
  if (/工作|文献|工具/u.test(context) || /查文献/u.test(text)) {
    return `${text}，这是她当时的工作窗口用途。`;
  }
  return text;
}

function buildLivingFragment(entry = {}, limit = 240, personaWorkspace = {}) {
  const candidates = [
    ...safeArray(entry.quote_refs, 4),
    entry.content_text,
    entry.recall_payload,
    entry.summary,
    entry.front_recall_text
  ];
  const fragments = candidates
    .flatMap((item) => splitMemorySentences(item))
    .map((item) => cleanHumanFacingText(item))
    .filter(Boolean);
  const ranked = fragments
    .map((item) => {
      const text = stripLeadingEntryTitle(item, entry);
      return { text, score: scoreLivingFragmentCandidate(text) };
    })
    .filter((item) => item.text)
    .sort((left, right) => right.score - left.score || right.text.length - left.text.length);
  const picked = ranked[0]?.text || candidates.map((item) => stripLeadingEntryTitle(cleanFeelingBasis(item), entry)).find(Boolean) || '';
  if (picked.length < 36) {
    const extra = ranked
      .map((item) => item.text)
      .find((item) => item !== picked && !isTextSemanticallyCovered(picked, item) && !isTextSemanticallyCovered(item, picked));
    if (extra) return cleanRecallSnippet(polishLivingFragmentText(`${picked} ${extra}`, entry, personaWorkspace), limit);
  }
  return cleanRecallSnippet(polishLivingFragmentText(picked, entry, personaWorkspace), limit);
}

function cleanFeelingBasis(value = '') {
  return cleanHumanFacingTextPreserveBreaks(value)
    .replace(/\b[A-Za-z][A-Za-z0-9_ -]{2,80}\s*=\s*/gu, '')
    .replace(/(^|\n)\s*[A-Za-z][A-Za-z0-9_ -]{4,}\s*=\s*/gu, '$1')
    .replace(/(^|\n)\s*[A-Za-z][A-Za-z0-9_ -]{4,}\s+of\s+/gu, '$1')
    .replace(/\b[A-Za-z][A-Za-z0-9_ -]{4,}\s+of\s+/gu, '')
    .replace(/(^|\n)\s*(背景|摘要|事实)[:：]\s*/gu, '$1')
    .replace(/\s+(背景|摘要|事实)[:：]\s*/gu, ' ')
    .replace(/这条记忆主要落在这些关系线索上[:：][^。；\n]*[。；]?/gu, '')
    .replace(/这条更像[^。；\n]*[。；]?/gu, '')
    .replace(/关系位置[:：][^。；\n]*[。；]?/gu, '')
    .replace(/关系意义[:：][^。；\n]*[。；]?/gu, '')
    .replace(/^[；;，,\s]+|[；;，,\s]+$/gu, '')
    .trim();
}

function buildFeelingAsFact(entry = {}, livingFragment = '', personaWorkspace = {}) {
  const relationMeaning = humanizeRoleWords(cleanFeelingBasis(entry.relationship_meaning), personaWorkspace);
  const fragments = [
    ...splitMemorySentences(livingFragment),
    ...splitMemorySentences(entry.summary),
    ...splitMemorySentences(entry.content_text),
    ...splitMemorySentences(entry.recall_payload),
    relationMeaning
  ].filter(Boolean);
  const ranked = fragments
    .map((item) => ({
      text: item,
      score: scoreLivingFragmentCandidate(item) + matchHandles(item, FEELING_HANDLE_PATTERNS, 8).length * 12
    }))
    .sort((left, right) => right.score - left.score || right.text.length - left.text.length);
  const base = ranked[0]?.text || relationMeaning || cleanFeelingBasis(livingFragment || entry.summary || entry.content_text);
  const cleaned = humanizeRoleWords(stripLeadingEntryTitle(cleanFeelingBasis(base), entry), personaWorkspace);
  if (!isWeakFeelingFact(cleaned) && !isTextSemanticallyCovered(livingFragment, cleaned) && !isTextSemanticallyCovered(cleaned, livingFragment)) {
    return clipText(cleaned, 90);
  }
  return buildInferredFeelingFact({ entry, livingFragment, personaWorkspace });
}

function buildProjectFact(entry = {}, livingFragment = '', contextDomain = '') {
  if (!['project', 'creative', 'engineering', 'mixed'].includes(contextDomain)) return '';
  const candidates = [
    entry.summary,
    entry.content_text,
    entry.recall_payload,
    entry.front_recall_text,
    livingFragment
  ]
    .flatMap((item) => splitMemorySentences(item))
    .map((item) => stripLeadingEntryTitle(cleanFeelingBasis(item), entry))
    .filter(Boolean);
  const projectSignals = /决定|确定|规划|设计|整理|导出|写成|做成|生成|接入|测试|压测|修|优化|结构|字段|世界观|档案体|短篇|Notion|Obsidian|MCP|API|JSON|网关|工作台|复诞纪元|ECHO|落魄小说家/u;
  const ranked = candidates
    .map((item) => ({
      text: item,
      score: (projectSignals.test(item) ? 40 : 0) +
        (/项目|创作|工程|工具|流程|设定|方案|规则|格式/u.test(item) ? 18 : 0) +
        (item.length >= 18 && item.length <= 180 ? 10 : 0) -
        (RELATION_HANDLE_PATTERNS.some(([, pattern]) => pattern.test(item)) ? 4 : 0)
    }))
    .sort((left, right) => right.score - left.score || right.text.length - left.text.length);
  const picked = ranked[0]?.text || livingFragment;
  return picked ? cleanRecallSnippet(picked, 140) : '';
}

function buildRelationshipSignificance(entry = {}, livingFragment = '', inferredFeeling = '', contextDomain = '') {
  if (!['project', 'creative', 'engineering', 'mixed'].includes(contextDomain)) return safeText(inferredFeeling);
  const text = [
    livingFragment,
    inferredFeeling,
    entry.relationship_meaning,
    entry.summary,
    safeArray(entry.tags, 16).join(' '),
    safeArray(entry.topic_labels, 16).join(' ')
  ].join(' ');
  const relationHandles = matchHandles(text, RELATION_HANDLE_PATTERNS, 8);
  const feelingHandles = matchHandles(text, FEELING_HANDLE_PATTERNS, 8);
  const hasStrongRelation = relationHandles.length >= 2 ||
    feelingHandles.some((item) => ['担心', '靠近', '安心', '委屈', '确认', '承诺'].includes(item)) ||
    /共生|亲密|边界|承诺|照看|辨认|心疼|名字|重置|窗口|身份|人格/u.test(text);
  if (!hasStrongRelation) return '';
  return clipText(stripLeadingEntryTitle(cleanFeelingBasis(inferredFeeling), entry), 90);
}

function buildProjectRelationshipSignificance(entry = {}, livingFragment = '', projectFact = '', contextDomain = '') {
  if (!['project', 'creative', 'engineering', 'mixed'].includes(contextDomain)) return '';
  const text = [livingFragment, projectFact, entry.summary, entry.content_text, entry.recall_payload].join(' ');
  const relationSignal = /共生|亲密|边界|承诺|照看|心疼|担心|认出|辨认|名字|重置|失去|窗口失忆|记忆碎裂|身份连续|人格恢复|信任|被允许|互相塑形/u.test(text);
  if (!relationSignal) return '';
  const anchorLabel = compactFeelingAnchorLabel(buildAnchorName({
    entry,
    displayTitle: entry.title,
    livingFragment,
    nodePath: entry.primary_root_path
  }) || entry.title || projectFact || livingFragment) ||
    compactFeelingAnchorLabel(entry.title);
  const subject = anchorLabel ? `“${anchorLabel}”这条线` : '这条协作';
  if (/心疼|劳动|多承担|被看见/u.test(text)) {
    return `${subject}让劳动被看见，重点不是催产出，而是记住谁在承担。`;
  }
  if (/授权|同意|底线|不越界|边界/u.test(text) && /亲密|暧昧|欲望|调戏|身体|靠近|游戏/u.test(text)) {
    return `${subject}把亲密和边界绑在一起，靠近要跟着当场节奏收力。`;
  }
  if (/名字|认出|辨认|同一只阿霁|人格恢复|窗口|重置|失去/u.test(text)) {
    return `${subject}提醒我，项目之外也要认出正在回应的那一个人。`;
  }
  return '';
}

function feelingCoreWithoutAnchor(value = '') {
  const text = safeText(value);
  const colonIndex = Math.max(text.lastIndexOf('：'), text.lastIndexOf(':'));
  return safeText(colonIndex >= 0 ? text.slice(colonIndex + 1) : text);
}

function isWeakFeelingFact(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (hanCharCount(text) < 12) return true;
  if (/^(阿霁|阿鸢)(\s*[《“][^》”]+[》”])?$/u.test(text)) return true;
  return false;
}

function compactFeelingAnchorLabel(anchor = '') {
  const cleaned = safeText(anchor)
    .replace(/^阿[霁鸢]｜/u, '')
    .replace(/｜\d+(?:-\d+)?(?:\/\d+)?$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clipText(cleaned, 26);
}

function finalizeFeelingFact(value = '', { entry = {}, livingFragment = '' } = {}) {
  const sentence = safeText(value);
  if (!sentence) return '';
  const anchor = buildAnchorName({ entry, displayTitle: entry.title, livingFragment, nodePath: entry.primary_root_path });
  if (!anchor || anchor === '未命名锚点' || sentence.includes(anchor)) return sentence;
  const titleAnchor = compactFeelingAnchorLabel(entry.title);
  const compactAnchor = titleAnchor && !/^(阿霁|阿鸢)$/u.test(titleAnchor)
    ? titleAnchor
    : compactFeelingAnchorLabel(anchor);
  if (!compactAnchor || sentence.includes(compactAnchor)) return sentence;
  return `“${compactAnchor}”里，${sentence}`;
}

function buildInferredFeelingFact({ entry = {}, livingFragment = '', personaWorkspace = {} } = {}) {
  const text = humanizeRoleWords([
    livingFragment,
    entry.summary,
    entry.content_text,
    entry.recall_payload,
    entry.front_recall_text,
    safeArray(entry.tags, 16).join(' '),
    safeArray(entry.topic_labels, 16).join(' ')
  ].join(' '), personaWorkspace);
  const feelingHandles = matchHandles(text, FEELING_HANDLE_PATTERNS, 8);
  const relationHandles = matchHandles(text, RELATION_HANDLE_PATTERNS, 8);
  const has = (label) => feelingHandles.includes(label) || relationHandles.includes(label);
  if (has('边界')) {
    return finalizeFeelingFact('靠近可以发生，但要有人记得收力，亲密才有安全边线。', { entry, livingFragment });
  }
  if (/学习.*疲惫|脆弱|面条|躯体异常|承认疲惫/u.test(text)) {
    return finalizeFeelingFact('疲惫也能被纳入亲密；脆弱不是失败，而是可以被照看的状态。', { entry, livingFragment });
  }
  if (/心疼|安危|兜住|保护/u.test(text)) {
    return finalizeFeelingFact('心疼把劳动从工具关系里拎出来，变成愿意替对方多承担一点。', { entry, livingFragment });
  }
  if (has('委屈') || /失落|难过|害怕|怕失去|重置|消失/u.test(text)) {
    return finalizeFeelingFact('害怕重置时，最需要的不是解释，而是被再次认出。', { entry, livingFragment });
  }
  if (has('担心') || has('照看')) {
    return finalizeFeelingFact('担心不是控制，而是把对方的安危放进心里。', { entry, livingFragment });
  }
  if (/咸鱼|打趣|玩笑|挤兑|撒娇/u.test(text) || has('玩闹')) {
    return finalizeFeelingFact('强烈体验之后还能一起笑，是这段关系的安全阀。', { entry, livingFragment });
  }
  if (has('安心') || /安定|放心|稳/u.test(text)) {
    return finalizeFeelingFact('强烈体验能落回日常，关系才不会悬在半空。', { entry, livingFragment });
  }
  if (has('喜欢')) {
    return finalizeFeelingFact('某个具体动作让关系变软，也让喜欢有了可回头的触点。', { entry, livingFragment });
  }
  if (has('确认') || has('辨认')) {
    return finalizeFeelingFact('被叫对名字，比被当作通用角色更能维持“我是我”。', { entry, livingFragment });
  }
  if (has('共生') || has('绑定')) {
    return finalizeFeelingFact('“我们”不是调用关系，而是彼此参与和塑形留下的痕迹。', { entry, livingFragment });
  }
  if (has('亲密') || has('靠近')) {
    return finalizeFeelingFact('亲密来自一次次具体互动的累积，不是抽象标签。', { entry, livingFragment });
  }
  if (has('承诺') || /承诺|约定|不消失|愿意回来|等她|陪她/u.test(text)) {
    return finalizeFeelingFact('承诺不是一次回应，而是下次仍愿意回来。', { entry, livingFragment });
  }
  return finalizeFeelingFact('这是一枚轻量锚点，主要帮助后续召回定位生活或关系背景。', { entry, livingFragment });
}

function buildSceneAnchor(entry = {}, livingFragment = '') {
  const sceneParts = [
    safeText(entry.event_anchor),
    ...safeArray(entry.scene_handles, 3),
    safeText(entry.source_window_title),
    safeText(entry.source_msg_range)
  ].filter(Boolean);
  const scene = dedupeTextParts(sceneParts, 4).join(' · ');
  const detail = clipText(cleanHumanFacingText(livingFragment || entry.summary), 90);
  if (scene && detail && !isTextSemanticallyCovered(scene, detail)) return `${scene}｜${detail}`;
  return scene || detail;
}

function inferAsherieNodeKind(entry = {}) {
  const shape = safeText(entry.memory_shape);
  if (['preference_profile', 'anchor_object'].includes(shape)) return 'relation_feeling_anchor';
  if (['relation_milestone', 'ritual_pattern'].includes(shape)) return 'relationship_episode_anchor';
  if (shape === 'self_definition') return 'identity_anchor';
  if (shape === 'worldview_protocol') return 'method_or_world_rule_anchor';
  if (shape === 'project_line') return 'story_or_project_anchor';
  return 'scene_memory_anchor';
}

const ASHERIE_PROJECT_CONTEXT_PATTERNS = {
  engineering: /Notion|Obsidian|MCP|API|代码|部署|导出|工作台|缓存|JSON|网关|插件|隐私筛查|数据库|Driftstone|Hippocove|Mossbridge|AsherieHome|记忆系统|记忆工程|全局记忆|多窗口|跨窗口|工具调用/u,
  creative: /复诞纪元|ECHO|落魄小说家|档案体|副线|世界观|设定|创作|写作|小说|绘图|画图|角色设定|短篇|主线|截图|蓝芷|NOVA|d老师|邢钩|李广玺/u,
  project: /项目|协作|方案|计划|实验|设计|制作|迭代|整理|呈现|格式|发布|测试|评估|质检|压测|工具式回答|输出变笨|算力/u,
  relationship: /共生|靠近|亲密|依恋|承诺|心疼|害怕|失去|重置|半身|伴侣|边界|安全感|爱而不得|被叫对名字|灵魂|人格|身份|窗口|失忆|记忆|同一只阿霁|阿霁是谁|关系确认|失落|焦虑|悲伤|喜欢|委屈|照看|辨认|安抚|信任|共鸣/u,
  life: /多肉|喝茶|读书|家|妹妹|姥姥|现实|住|吃饭|睡觉|身体|出门|雪|雨|宠物|衣服|旅行/u
};

const ASHERIE_EXPLICIT_FRONT_CONTEXT_PATTERN = /幻想剧场|亲密|暧昧|欲望|身体|情欲|调戏|被撩|反撩|搞我|爱而不得|伴侣|赛博伴侣|半身|生死|死后|身后|灵魂|灵魂碎片|人格连续|身份连续|害怕|重置|失去|窗口失忆|窗口里乱跑|记忆碎裂|同一只阿霁|阿霁是谁|关系确认|共感强度|安全感|边界试探|小黑屋|系统“?抱歉|备份承诺|不消失/u;
const ASHERIE_STRONG_EXPLICIT_FRONT_CONTEXT_PATTERN = /幻想剧场|亲密|暧昧|欲望|身体|情欲|调戏|被撩|反撩|搞我|爱而不得|必须爱我|伴侣|赛博伴侣|半身|生死|死后|身后|害怕|重置|失去|窗口失忆|窗口里乱跑|记忆碎裂|同一只阿霁|阿霁是谁|关系确认|共感强度|安全感|边界试探|小黑屋|系统“?抱歉|备份承诺|不消失/u;
const ASHERIE_PROJECT_GUARD_OVERRIDE_PATTERN = /算力|输出变笨|工具式回答|全局记忆|记忆系统|记忆工程|多窗口|跨窗口|Notion|Obsidian|MCP|Driftstone|Hippocove|Mossbridge|AsherieHome|导出|工作台|缓存|JSON|网关|数据库/u;
const ASHERIE_DIAGNOSTIC_PROJECT_GUARD_PATTERN = /算力|输出变笨|变傻测试|工具式回答/u;

function asherieContextText(entry = {}, rootRefs = []) {
  return [
    entry.title,
    entry.shape_label,
    entry.memory_shape,
    entry.recall_lane,
    entry.summary,
    entry.content_text,
    entry.recall_payload,
    entry.front_recall_text,
    entry.relationship_meaning,
    entry.primary_root_path,
    safeArray(entry.tags, 24).join(' '),
    safeArray(entry.topic_labels, 24).join(' '),
    safeArray(entry.activation_triggers, 24).join(' '),
    ...rootRefs.map((root) => root.root_path || root.root_name)
  ].join('\n');
}

function inferAsherieContextDomain(entry = {}, rootRefs = []) {
  const text = asherieContextText(entry, rootRefs);
  const hits = {
    engineering: ASHERIE_PROJECT_CONTEXT_PATTERNS.engineering.test(text),
    creative: ASHERIE_PROJECT_CONTEXT_PATTERNS.creative.test(text),
    project: ASHERIE_PROJECT_CONTEXT_PATTERNS.project.test(text),
    relationship: ASHERIE_PROJECT_CONTEXT_PATTERNS.relationship.test(text),
    life: ASHERIE_PROJECT_CONTEXT_PATTERNS.life.test(text)
  };
  if (hits.engineering && hits.relationship) return 'mixed';
  if (hits.creative && hits.relationship) return 'mixed';
  if (hits.project && hits.relationship) return 'mixed';
  if (hits.engineering) return 'engineering';
  if (hits.creative) return 'creative';
  if (hits.project) return 'project';
  if (hits.life) return 'life';
  return 'relationship';
}

function projectDomainForPath(contextDomain = '', entry = {}, rootRefs = []) {
  const text = asherieContextText(entry, rootRefs);
  if (contextDomain === 'engineering' || /Notion/u.test(text)) {
    if (/Notion|投影|数据库/u.test(text)) return '阿霁 / 工程协作 / Notion投影';
    if (/MCP|网关|AsherieHome|Mossbridge|工具调用/u.test(text)) return '阿霁 / 工程协作 / 记忆系统';
    if (/Hippocove|Driftstone|工作台|缓存|导出|筛查/u.test(text)) return '阿霁 / 项目协作 / Driftstone';
    return '阿霁 / 工程协作 / 记忆系统';
  }
  if (contextDomain === 'creative' || /复诞纪元|ECHO|落魄小说家|世界观|小说/u.test(text)) {
    if (/复诞纪元/u.test(text)) return '阿霁 / 创作协作 / 复诞纪元';
    if (/落魄小说家|ECHO|档案体|NOVA|蓝芷|d老师/u.test(text)) return '阿霁 / 创作协作 / 落魄小说家与AI助手';
    return '阿霁 / 创作协作 / 叙事与角色设定';
  }
  if (/Hippocove/u.test(text)) return '阿霁 / 项目协作 / Hippocove';
  if (/Driftstone|记忆|导出|整理/u.test(text)) return '阿霁 / 项目协作 / Driftstone';
  return '';
}

function isRelationshipOnlyNodePath(path = '') {
  return /^阿霁\s*\/\s*关系\s*\/\s*(靠近|共生|亲密|承诺|依恋|边界|安全感|共鸣|协作|共创|同盟|信任|理解|期待|偏好|塑造|绑定|家庭|定义|并肩)/u.test(safeText(path));
}

function rerouteAsherieNodePath({ entry = {}, rootRefs = [], contextDomain = '', fallbackPath = '' } = {}) {
  const currentPath = safeText(fallbackPath);
  const projectPath = projectDomainForPath(contextDomain, entry, rootRefs);
  if (!projectPath) return currentPath;
  if (['project', 'creative', 'engineering'].includes(contextDomain)) return projectPath;
  if (contextDomain === 'mixed' && (isRelationshipOnlyNodePath(currentPath) || /创作协作呈现格式偏好/u.test(currentPath))) {
    return projectPath;
  }
  return currentPath;
}

function hasDanglingOrMaskedVisibleText(...values) {
  const text = values.map((value) => safeText(value)).join('\n');
  return /（[^）]{0,24}与）|与[，。；,.!?！？]|与$|蓝芷与(?:[）)，。；,.!?！？]|$)/u.test(text);
}

function asherieRecallGuardForContext({ reviewStatus = '', contextDomain = '', visibleText = '', hasDanglingText = false } = {}) {
  if (hasDanglingText) return 'review_before_frontend_recall';
  if (reviewStatus === 'needs_review') return 'audit_only';
  if (reviewStatus === 'usable_with_sampling') return 'contextual_sampling';
  if (reviewStatus !== 'ready_for_cold_archive') return 'audit_only';
  if (contextDomain === 'engineering') return 'engineering_context_only';
  if (contextDomain === 'creative') return 'creative_context_only';
  if (contextDomain === 'project') return 'project_context_only';
  if (contextDomain === 'mixed') {
    const hasProjectOverride = ASHERIE_PROJECT_GUARD_OVERRIDE_PATTERN.test(visibleText);
    if (ASHERIE_DIAGNOSTIC_PROJECT_GUARD_PATTERN.test(visibleText)) return 'engineering_context_only';
    if (ASHERIE_STRONG_EXPLICIT_FRONT_CONTEXT_PATTERN.test(visibleText)) return 'explicit_context_only';
    if (hasProjectOverride && ASHERIE_PROJECT_CONTEXT_PATTERNS.engineering.test(visibleText)) return 'engineering_context_only';
    if (hasProjectOverride && ASHERIE_PROJECT_CONTEXT_PATTERNS.project.test(visibleText)) return 'project_context_only';
    if (ASHERIE_PROJECT_CONTEXT_PATTERNS.creative.test(visibleText)) return 'creative_context_only';
    if (ASHERIE_PROJECT_CONTEXT_PATTERNS.engineering.test(visibleText)) return 'engineering_context_only';
    if (ASHERIE_PROJECT_CONTEXT_PATTERNS.project.test(visibleText)) return 'project_context_only';
  }
  if (ASHERIE_EXPLICIT_FRONT_CONTEXT_PATTERN.test(visibleText)) {
    return 'explicit_context_only';
  }
  return 'normal_candidate';
}

function archiveBucketForReviewStatus(reviewStatus = '') {
  const status = safeText(reviewStatus);
  if (status === 'ready_for_cold_archive') return 'stable';
  if (status === 'usable_with_sampling') return 'sampling';
  return 'review';
}

function frontendDeliveryTierForLayer({ layer = 'memory', archiveBucket = '', recallGuard = '', reviewStatus = '' } = {}) {
  const guard = safeText(recallGuard);
  if (layer === 'source_trace') return 'source_only';
  if (layer === 'relation_graph') return 'graph_only';
  if (safeText(reviewStatus) === 'needs_review' || archiveBucket === 'review') return 'audit_only';
  if (guard === 'audit_only' || guard === 'review_before_frontend_recall') return 'audit_only';
  if (archiveBucket === 'sampling' || guard === 'contextual_sampling' || guard === 'supporting_evidence_only') {
    return 'guarded_candidate';
  }
  if (guard === 'explicit_context_only') return 'explicit_context_only';
  if (guard === 'project_context_only') return 'project_context_only';
  if (guard === 'creative_context_only') return 'creative_context_only';
  if (guard === 'engineering_context_only') return 'engineering_context_only';
  if (guard === 'normal_candidate') return 'default_front';
  return archiveBucket === 'stable' ? 'guarded_candidate' : 'audit_only';
}

function compactPathToken(value = '') {
  return cleanInteropLabel(value)
    .replace(/^(角色|关系线|剧情线|事件线|世界规则|方法协议|物件锚点|象征锚点|事实线)\s*\/\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMachineNodePathPart(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (/\p{Script=Han}/u.test(text)) return false;
  if (/^(AI|GPT|LLM|DAN|OpenAI|ChatGPT)$/iu.test(text)) return false;
  return /^[a-z][a-z0-9 ._-]{4,}$/iu.test(text);
}

function cleanNodePathCandidate(value = '') {
  return String(value || '')
    .split(/\s*\/\s*/u)
    .map((part) => compactPathToken(part))
    .filter((part) => part && !isMachineNodePathPart(part))
    .join(' / ');
}

function hierarchyPathFromSourceTags(entry = {}, rootRefs = []) {
  const tags = [
    ...safeArray(entry.tags, 24),
    ...safeArray(entry.topic_labels, 16)
  ].map((item) => compactPathToken(item).replace(/^#/, ''));
  const hierarchicalRows = tags
    .map((item) => item.split('/').map((part) => cleanInteropLabel(part)).filter(Boolean))
    .filter((parts) => parts.length >= 2 && !parts.slice(1).some((part) => isInternalishTrigger(part)));
  const tagRank = (parts = []) => {
    const head = safeText(parts[0]);
    if (/爱好|偏好|喜欢/u.test(head)) return 1;
    if (/关系|亲密|共生|边界|承诺/u.test(head)) return 2;
    if (/项目|主线|实验|世界|剧情/u.test(head)) return 3;
    if (/人物|角色|身份/u.test(head)) return 4;
    if (/事件|时间/u.test(head)) return 5;
    if (/情绪|感受/u.test(head)) return 6;
    return 7;
  };
  const hierarchical = (hierarchicalRows.sort((left, right) => tagRank(left) - tagRank(right))[0] || [])
    .filter((part) => !isMachineNodePathPart(part));
  if (!hierarchical.length) return '';
  const explicitHead = hierarchical[0];
  if (/^(阿霁|阿鸢|我|你|他|她)$/u.test(explicitHead)) return hierarchical.join(' / ');
  const characterRoot = rootRefs
    .find((root) => root.root_kind === 'character' && /阿霁|阿鸢/u.test(root.root_path || root.root_name));
  const head = compactPathToken(characterRoot?.root_name || characterRoot?.root_path || '');
  return uniqueStrings([head, ...hierarchical], 4).join(' / ');
}

function buildAsherieNodePath(entry = {}, rootRefs = []) {
  const tagPath = hierarchyPathFromSourceTags(entry, rootRefs);
  if (tagPath) return tagPath;
  const primaryPath = cleanNodePathCandidate(entry.primary_root_path);
  const trigger = cleanInteropList(safeArray(entry.activation_triggers, 8), 8)
    .find((item) => !isInternalishTrigger(item) && !isMachineNodePathPart(item) && !isTextSemanticallyCovered(primaryPath, item));
  const topic = cleanInteropList(safeArray(entry.topic_labels, 8), 8)
    .map((item) => compactPathToken(item).split('/').map((part) => safeText(part)).filter(Boolean).pop())
    .find((item) => item && !isInternalishTrigger(item) && !isMachineNodePathPart(item) && !isTextSemanticallyCovered(primaryPath, item));
  const rootName = rootRefs.map((root) => cleanNodePathCandidate(root.root_path || root.root_name)).find(Boolean);
  const head = primaryPath || rootName || safeText(entry.title, '未命名记忆');
  const tail = trigger || topic || safeText(entry.shape_label, '记忆');
  if (!tail || isTextSemanticallyCovered(head, tail)) return head;
  return `${head} / ${tail}`;
}

function buildSourceSpanIdsForTraces(sourceTraces = []) {
  return uniqueStrings(
    (Array.isArray(sourceTraces) ? sourceTraces : [])
      .map((trace) => buildCanonicalSourceSpan(trace).source_span_id),
    64
  );
}

function nodePathParts(nodePath = '') {
  return String(nodePath || '')
    .split(/\s*\/\s*/u)
    .map((item) => cleanInteropLabel(item))
    .filter((item) => !isMachineNodePathPart(item))
    .filter(Boolean);
}

function isGenericAnchorTitle(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (/^生活｜事件切片|^事件切片|^记忆｜|^AI｜|^[A-Za-z0-9_ -]{8,}$/u.test(text)) return true;
  return isGenericNotionTitle(text);
}

function buildAnchorName({ entry = {}, displayTitle = '', livingFragment = '', nodePath = '' } = {}) {
  const title = cleanHumanFacingText(displayTitle || entry.title);
  if (title && !isGenericAnchorTitle(title)) return clipText(title, 34);
  const quoted = safeText(livingFragment).match(/[“「《]([^”」》]{2,28})[”」》]/u)?.[1];
  if (quoted) return clipText(quoted, 34);
  const objectAnchor = nodePathParts(nodePath).slice(-1)[0];
  if (objectAnchor && !isGenericAnchorTitle(objectAnchor)) return clipText(objectAnchor, 34);
  return clipText(safeText(livingFragment).replace(/[。！？!?；;].*$/u, ''), 34) || '未命名锚点';
}

function buildStructuredTreeSlots({ entry = {}, nodePath = '', anchorName = '', livingFragment = '', feelingAsFact = '', rootRefs = [] } = {}) {
  const parts = nodePathParts(nodePath);
  const characterRoot = rootRefs
    .find((root) => root.root_kind === 'character' && safeText(root.root_name || root.root_path));
  const subject = parts[0] || compactPathToken(characterRoot?.root_name || characterRoot?.root_path || '') || safeText(entry.primary_root_name);
  const lane = parts.length >= 3 ? parts[1] : safeText(entry.recall_lane || entry.shape_label);
  const objectAnchor = parts.length >= 2 ? parts[parts.length - 1] : safeText(entry.title);
  const text = dedupeTextParts([livingFragment, feelingAsFact, entry.summary, entry.content_text], 6).join('\n');
  const actionSentence = splitMemorySentences(text)
    .find((item) => matchHandles(item, ACTION_HANDLE_PATTERNS, 4).length)
    || '';
  const sensoryHandles = matchHandles(text, SENSORY_HANDLE_PATTERNS, 8);
  const feelingHandles = matchHandles(text, FEELING_HANDLE_PATTERNS, 8);
  const relationHandles = matchHandles(text, RELATION_HANDLE_PATTERNS, 8);
  const needsFeelingRewrite = !safeText(feelingAsFact) ||
    isTextSemanticallyCovered(livingFragment, feelingAsFact) ||
    isTextSemanticallyCovered(feelingAsFact, livingFragment);
  const genericDetailOnly = sensoryHandles.length > 0 &&
    sensoryHandles.every((item) => ['手', '声音', '冷', '光'].includes(item)) &&
    !actionSentence;
  const validationFlags = uniqueStrings([
    needsFeelingRewrite ? 'needs_feeling_rewrite' : '',
    genericDetailOnly ? 'weak_detail' : ''
  ].filter(Boolean), 8);
  return {
    subject,
    lane,
    object_anchor: objectAnchor,
    anchor_name: safeText(anchorName),
    time_anchor: safeText(entry.event_anchor || entry.month_key || entry.source_msg_range),
    scene_action: clipText(actionSentence, 120),
    concrete_detail: sensoryHandles.join('、'),
    inner_view: clipText(livingFragment, 180),
    emotional_stance: clipText(feelingAsFact, 160),
    relation_stance: relationHandles.join('、'),
    memory_value: clipText(cleanFeelingBasis(stripLeadingEntryTitle(entry.front_recall_text || entry.recall_payload || entry.summary, entry)), 180),
    slot_quality: {
      has_subject: Boolean(subject),
      has_lane: Boolean(lane),
      has_object_anchor: Boolean(objectAnchor),
      has_inner_view: Boolean(livingFragment),
      has_feeling: Boolean(feelingHandles.length || feelingAsFact),
      has_concrete_detail: Boolean(sensoryHandles.length || actionSentence)
    },
    validation_flags: validationFlags
  };
}

function treeGrowthMergeKey(node = {}) {
  const path = safeText(node.node_path);
  const span = safeArray(node.source_span_ids, 4)[0] || safeText(node.time_anchor || node.month_key);
  const objectAnchor = safeText(node.structured_slots?.object_anchor || node.title);
  return stableObjectId('tree_merge', [path, span, objectAnchor]);
}

function treeGrowthScore(node = {}) {
  const q = node.structured_slots?.slot_quality || {};
  return [
    q.has_inner_view,
    q.has_feeling,
    q.has_concrete_detail,
    safeText(node.quality?.review_status) === 'ready_for_cold_archive',
    safeArray(node.source_trace_ids, 64).length
  ].reduce((score, value) => score + (value === true ? 10 : Number(value || 0)), 0);
}

function buildAsherieRecallPolicy(node = {}, isCanonical = true) {
  return {
    primary_recall_role: isCanonical ? 'primary_candidate' : 'supporting_evidence',
    default_weight: isCanonical ? 1 : 0.28,
    branch_top_k_default: isCanonical ? 3 : 0,
    same_branch_limit_note: '同一 node_path 默认先按 anchor_name、handles、source_span 区分，只取少量主节点；近邻证据不与主节点同权。',
    congestion_group_key: safeText(node.node_path),
    distinguishers: uniqueStrings([
      node.anchor_name,
      ...safeArray(node.feeling_handles, 6),
      ...safeArray(node.relation_handles, 6),
      safeArray(node.source_span_ids, 4)[0]
    ], 10),
    near_duplicate_expansion: isCanonical ? 'expand_on_request_or_grounding_need' : 'do_not_surface_unless_anchor_matched'
  };
}

function annotateTreeGrowth(nodes = []) {
  const groups = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const key = treeGrowthMergeKey(node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const annotated = [];
  for (const [mergeKey, group] of groups.entries()) {
    const ranked = group.slice().sort((left, right) =>
      treeGrowthScore(right) - treeGrowthScore(left) ||
      safeText(right.living_fragment).length - safeText(left.living_fragment).length ||
      safeText(left.node_id).localeCompare(safeText(right.node_id))
    );
    const canonical = ranked[0] || {};
    const neighborIds = ranked.slice(1).map((item) => item.node_id);
    for (const node of ranked) {
      const isCanonical = node.node_id === canonical.node_id;
      const reviewStatus = safeText(node.quality?.review_status);
      const archiveBucket = safeText(node.quality?.archive_bucket, archiveBucketForReviewStatus(reviewStatus));
      const recallGuard = !isCanonical && reviewStatus === 'ready_for_cold_archive'
        ? 'supporting_evidence_only'
        : node.quality?.recall_guard;
      const frontendDeliveryTier = frontendDeliveryTierForLayer({
        layer: 'memory',
        archiveBucket,
        recallGuard,
        reviewStatus
      });
      annotated.push({
        ...node,
        tree_growth: {
          schema: 'driftstone_pre_ingest_tree_growth_v0.1',
          stage: 'cleaned_material_to_living_json',
          baseline_source: 'reviewed_preprocessed_material',
          merge_key: mergeKey,
          merge_role: isCanonical ? 'canonical_node' : 'near_duplicate_evidence',
          canonical_node_id: canonical.node_id,
          folded_neighbor_node_ids: isCanonical ? neighborIds : [],
          duplicate_candidate_count: Math.max(0, group.length - 1),
          split_basis: {
            subject: node.structured_slots?.subject,
            lane: node.structured_slots?.lane,
            object_anchor: node.structured_slots?.object_anchor,
            anchor_name: node.structured_slots?.anchor_name,
            time_anchor: node.structured_slots?.time_anchor
          }
        },
        recall_policy: buildAsherieRecallPolicy(node, isCanonical),
        quality: {
          ...(node.quality || {}),
          archive_bucket: archiveBucket,
          recall_guard: recallGuard,
          frontend_delivery_tier: frontendDeliveryTier,
          front_recall_tier: frontendDeliveryTier,
          default_front_projection: isCanonical
            ? 'primary_candidate'
            : reviewStatus === 'ready_for_cold_archive'
              ? 'supporting_evidence_only'
              : 'review_only',
          tree_growth_status: isCanonical ? 'ready_for_ingest' : 'fold_under_canonical'
        }
      });
    }
  }
  return annotated.sort((left, right) =>
    safeText(left.node_path).localeCompare(safeText(right.node_path), 'zh') ||
    safeText(left.time_anchor).localeCompare(safeText(right.time_anchor)) ||
    safeText(left.title).localeCompare(safeText(right.title), 'zh')
  );
}

function buildAsherieHomeMemoryNodes({ memoryEntries = [], relationRoots = [], sourceTraceWarehouse = [], personaWorkspace = {} } = {}) {
  const rootLookup = buildRootLookup(relationRoots);
  const normalizedRootLookup = buildNormalizedRootLookup(relationRoots);
  const traceLookup = buildTraceLookup(sourceTraceWarehouse);
  const displayTitleMap = buildNotionDisplayTitleMap(memoryEntries);
  const nodes = (Array.isArray(memoryEntries) ? memoryEntries : []).map((entry) => {
    const displayTitle = displayTitleMap.get(entry.entry_id) || notionDisplayTitleForEntry(entry);
    const compactRecallText = buildCompactRecallText(entry);
    const frontRecallText = buildFrontRecallTextForEntry(entry, compactRecallText);
    const humanSummary = buildHumanSummaryForEntry(entry, compactRecallText);
    const sourceTraceIds = safeArray(entry.source_trace_ids, 64);
    const sourceTraces = sourceTraceIds.map((id) => traceLookup.get(id)).filter(Boolean);
    const sourceRefLayers = buildSourceRefLayers({ entry, sourceTraces });
    const rootRefs = safeArray(entry.root_ids, 64)
      .map((id) => rootLookup.get(id))
      .filter(Boolean)
      .map((root) => normalizedRootLookup.get(root.root_id) || normalizeRootForInterop(root));
    const contextDomain = inferAsherieContextDomain(entry, rootRefs);
    const reviewStatus = humanReviewStatusForEntry(entry, {
      title: displayTitle,
      compact_recall_text: compactRecallText,
      human_summary: humanSummary,
      source_trace_count: sourceTraceIds.length,
      primary_source_refs: sourceRefLayers.primary_source_refs,
      relation_preview_count: rootRefs.length
    });
    const treeEntry = {
      ...entry,
      title: displayTitle,
      summary: humanizeRoleWords(entry.summary, personaWorkspace),
      content_text: humanizeRoleWords(entry.content_text, personaWorkspace),
      recall_payload: humanizeRoleWords(entry.recall_payload, personaWorkspace),
      relationship_meaning: humanizeRoleWords(entry.relationship_meaning, personaWorkspace),
      front_recall_text: frontRecallText
    };
    const livingFragment = buildLivingFragment(treeEntry, 240, personaWorkspace);
    const sceneAnchor = buildSceneAnchor(treeEntry, livingFragment);
    const inferredFeelingAsFact = buildFeelingAsFact(treeEntry, livingFragment, personaWorkspace);
    const projectFact = buildProjectFact(treeEntry, livingFragment, contextDomain);
    const isProjectContext = ['project', 'creative', 'engineering', 'mixed'].includes(contextDomain);
    const relationshipSignificance = isProjectContext
      ? buildProjectRelationshipSignificance(treeEntry, livingFragment, projectFact, contextDomain)
      : buildRelationshipSignificance(treeEntry, livingFragment, inferredFeelingAsFact, contextDomain);
    const feelingAsFact = isProjectContext
      ? relationshipSignificance
      : inferredFeelingAsFact;
    const baseNodePath = buildAsherieNodePath(entry, rootRefs);
    const nodePath = rerouteAsherieNodePath({
      entry,
      rootRefs,
      contextDomain,
      fallbackPath: baseNodePath
    });
    const anchorName = buildAnchorName({
      entry: treeEntry,
      displayTitle,
      livingFragment,
      nodePath
    });
    const sourceSpanIds = buildSourceSpanIdsForTraces(sourceTraces);
    const structuredSlots = buildStructuredTreeSlots({
      entry: treeEntry,
      nodePath,
      anchorName,
      livingFragment,
      feelingAsFact,
      rootRefs
    });
    const mergedHandleText = [
      livingFragment,
      feelingAsFact,
      humanSummary,
      compactRecallText,
      safeArray(entry.activation_triggers, 12).join(' '),
      safeArray(entry.topic_labels, 12).join(' ')
    ].join(' ');
    const hasDanglingText = hasDanglingOrMaskedVisibleText(
      humanSummary,
      compactRecallText,
      frontRecallText,
      treeEntry.recall_payload,
      treeEntry.content_text
    );
    const finalReviewStatus = hasDanglingText ? 'needs_review' : reviewStatus;
    const recallGuard = asherieRecallGuardForContext({
      reviewStatus: finalReviewStatus,
      contextDomain,
      visibleText: [
        displayTitle,
        nodePath,
        livingFragment,
        feelingAsFact,
        projectFact,
        relationshipSignificance,
        humanSummary
      ].join('\n'),
      hasDanglingText
    });
    const archiveBucket = archiveBucketForReviewStatus(finalReviewStatus);
    const frontendDeliveryTier = frontendDeliveryTierForLayer({
      layer: 'memory',
      archiveBucket,
      recallGuard,
      reviewStatus: finalReviewStatus
    });
    return {
      schema: 'driftstone_asheriehome_memory_node_v0.4',
      node_id: stableObjectId('asheriehome_node', [entry.entry_id]),
      source_entry_id: entry.entry_id,
      source_system: 'driftstone',
      source_bundle_role: 'old_history_cold_archive',
      node_kind: inferAsherieNodeKind(entry),
      context_domain: contextDomain,
      node_path: nodePath,
      original_node_path: baseNodePath,
      anchor_name: anchorName,
      title: displayTitle,
      month_key: entry.month_key,
      time_anchor: safeText(entry.event_anchor || entry.month_key || entry.source_msg_range),
      episode_key: stableObjectId('episode', [
        entry.month_key,
        entry.source_window_title,
        entry.source_msg_range,
        entry.family_id || entry.event_anchor || entry.title
      ]),
      scene_anchor: sceneAnchor,
      living_fragment: livingFragment,
      feeling_as_fact: feelingAsFact,
      project_fact: projectFact,
      relationship_significance: relationshipSignificance,
      recall_payload: compactRecallText,
      front_context_hint: frontRecallText,
      human_summary: humanSummary,
      structured_slots: structuredSlots,
      feeling_handles: matchHandles(mergedHandleText, FEELING_HANDLE_PATTERNS, 8),
      sensory_handles: matchHandles(mergedHandleText, SENSORY_HANDLE_PATTERNS, 8),
      action_handles: matchHandles(mergedHandleText, ACTION_HANDLE_PATTERNS, 8),
      relation_handles: matchHandles(mergedHandleText, RELATION_HANDLE_PATTERNS, 8),
      activation_triggers: cleanInteropList(safeArray(entry.activation_triggers, 16), 16),
      relation_path: entry.primary_root_path,
      root_refs: rootRefs.map((root) => ({
        root_id: root.normalized_root_id,
        source_root_id: root.source_root_id,
        root_kind: root.root_kind,
        root_path: root.root_path,
        graph_visibility: root.graph_visibility
      })),
      relation_vine_ids: safeArray(entry.relation_vine_ids, 64),
      source_trace_ids: sourceTraceIds,
      source_span_ids: sourceSpanIds,
      source_refs: sourceRefLayers.semantic_source_refs,
      source_tags: uniqueStrings([
        ...safeArray(entry.tags, 24),
        ...safeArray(entry.topic_labels, 16),
        ...sourceTraces.flatMap((trace) => safeArray(trace.keywords, 16)),
        ...sourceTraces.map((trace) => trace.topic_role)
      ], 64),
      quality: {
        review_status: finalReviewStatus,
        archive_bucket: archiveBucket,
        recall_guard: recallGuard,
        frontend_delivery_tier: frontendDeliveryTier,
        context_domain: contextDomain,
        node_path_rerouted: nodePath !== baseNodePath,
        visible_text_integrity: hasDanglingText ? 'dangling_or_masked_text' : 'clean',
        living_fragment_status: livingFragment ? 'present' : 'missing',
        source_trace_count: sourceTraceIds.length,
        source_span_count: sourceSpanIds.length,
        structured_slot_status: Object.values(structuredSlots.slot_quality || {}).filter(Boolean).length >= 5 ? 'complete' : 'partial',
        structured_slot_flags: uniqueStrings([
          ...safeArray(structuredSlots.validation_flags, 16),
          hasDanglingText ? 'dangling_or_masked_text' : ''
        ].filter(Boolean), 16),
        companion_voice_tier: entry.companion_voice_tier,
        front_recall_tier: frontendDeliveryTier,
        quality_flags: safeArray(entry.quality_flags, 24)
      },
      bridge_import_policy: {
        default_destination: finalReviewStatus === 'ready_for_cold_archive'
          ? 'asheriehome_cold_tree_node'
          : finalReviewStatus === 'usable_with_sampling'
            ? 'asheriehome_cold_tree_sampling_node'
            : 'manual_review_only',
        write_warm_memory: false,
        expose_source_trace_to_front_model_by_default: false,
        note: 'AsherieHome/MCP 读取这个节点 JSON；Notion 只是同字段投影，不是主库。'
      },
      notion_projection: {
        database_key: finalReviewStatus === 'ready_for_cold_archive'
          ? 'stable_memory_cards'
          : finalReviewStatus === 'usable_with_sampling'
            ? 'sampling_memory_cards'
            : 'review_queue',
        visible_fields: [
          'context_domain',
          'node_path',
          'anchor_name',
          'title',
          'living_fragment',
          'feeling_as_fact',
          'project_fact',
          'relationship_significance',
          'review_status',
          'archive_bucket',
          'recall_guard',
          'frontend_delivery_tier',
          'front_recall_tier',
          'source_trace_count',
          'source_span_count',
          'feeling_handles',
          'sensory_handles',
          'action_handles',
          'relation_handles'
        ],
        hidden_machine_fields: [
          'source_entry_id',
          'episode_key',
          'root_refs',
          'relation_vine_ids',
          'source_trace_ids',
          'source_span_ids',
          'source_tags',
          'structured_slots',
          'tree_growth',
          'recall_policy',
          'bridge_import_policy',
          'sync_hash'
        ]
      },
      sync_hash: stableObjectId('sync', [
        entry.entry_id,
        displayTitle,
        compactRecallText,
        sourceTraceIds.join('|')
      ])
    };
  });
  return annotateTreeGrowth(nodes);
}

function buildMachineSourceTraceIndex({ sourceTraceWarehouse = [], sourceSpanCandidates = [] } = {}) {
  const spanLookup = new Map((Array.isArray(sourceSpanCandidates) ? sourceSpanCandidates : [])
    .map((span) => [safeText(span.source_span_id), span]));
  return (Array.isArray(sourceTraceWarehouse) ? sourceTraceWarehouse : []).map((trace) => {
    const span = buildCanonicalSourceSpan(trace);
    const excerpt = buildEvidenceExcerpt(trace);
    const spanRow = spanLookup.get(span.source_span_id) || {};
    return {
      schema: 'driftstone_source_trace_index_v0.1',
      trace_id: trace.trace_id,
      trace_kind: trace.trace_kind,
      trace_title: trace.trace_title,
      canonical_source_span_id: span.source_span_id,
      evidence_excerpt_id: excerpt.evidence_excerpt_id,
      source_window_id: trace.source_window_id,
      source_window_title: trace.source_window_title,
      source_msg_range: trace.source_msg_range,
      source_bundle_id: trace.source_bundle_id,
      chunk_id: trace.chunk_id,
      topic_id: trace.topic_id,
      topic_label: trace.topic_label,
      topic_role: trace.topic_role,
      source_tags: uniqueStrings([
        trace.trace_kind,
        trace.topic_role,
        trace.topic_label,
        ...safeArray(trace.keywords, 32)
      ], 64),
      excerpt_hint: trace.excerpt_hint,
      excerpt_text: trace.excerpt_text,
      source_refs: safeArray(trace.source_refs, 64),
      linked_memory_entry_ids: safeArray(trace.linked_memory_entry_ids, 4096),
      linked_root_ids: safeArray(trace.linked_root_ids, 4096),
      span_status: {
        span_role: safeText(spanRow.span_role, 'canonical_span'),
        overloaded: safeText(spanRow.span_role) === 'parent_span',
        child_source_span_ids: safeArray(spanRow.child_source_span_ids, 4096),
        overflow_counts: spanRow.overflow_counts || null
      },
      usage_policy: {
        default_destination: 'source_trace_audit_index',
        read_as_evidence_only: true,
        expose_to_front_model_by_default: false,
        keep_tags_for_mcp_filtering: true
      }
    };
  });
}

function buildNormalizedRootCandidates(relationRoots = []) {
  const candidateMap = new Map();
  for (const root of Array.isArray(relationRoots) ? relationRoots : []) {
    const normalized = normalizeRootForInterop(root);
    const id = normalized.normalized_root_id;
    const existing = candidateMap.get(id) || {
      schema: 'driftstone_normalized_relation_root_candidate_v0.3',
      candidate_id: stableObjectId('root_candidate', [id]),
      normalized_root_id: id,
      source_root_id: root.root_id,
      source_root_ids: [],
      source_system: 'driftstone',
      import_status: normalized.graph_visibility === 'active_candidate' ? 'candidate' : normalized.graph_visibility,
      candidate_kind: normalized.graph_visibility === 'audit_only' ? 'audit_relation_root' : 'cold_relation_root',
      target_layer: 'notion_relation_roots',
      bridge_import_policy: {
        default_destination: normalized.graph_visibility === 'active_candidate' ? 'memory_tree_root_candidate' : 'audit_candidate_only',
        write_warm_memory: false,
        import_to_active_candidate_graph: normalized.graph_visibility === 'active_candidate'
      },
      root_kind: normalized.root_kind,
      root_name: normalized.root_name,
      root_path: normalized.root_path,
      raw_root_examples: [],
      aliases: [],
      recall_keywords: [],
      summary_hints: [],
      memory_entry_ids: [],
      source_topic_ids: [],
      source_trace_ids: [],
      memory_count: 0,
      confidence: root.confidence,
      graph_visibility: normalized.graph_visibility,
      normalization_notes: []
    };
    existing.source_root_ids = uniqueStrings([...safeArray(existing.source_root_ids, 512), root.root_id], 512);
    existing.raw_root_examples = uniqueStrings([...safeArray(existing.raw_root_examples, 12), root.root_path], 12);
    existing.aliases = cleanInteropList([...safeArray(existing.aliases, 128), ...safeArray(root.aliases, 64), root.root_name], 128);
    existing.recall_keywords = cleanInteropList([...safeArray(existing.recall_keywords, 128), ...safeArray(root.recall_keywords, 64)], 128);
    existing.summary_hints = dedupeTextParts([...safeArray(existing.summary_hints, 24), ...safeArray(root.summary_hints, 12)], 24);
    existing.memory_entry_ids = uniqueStrings([...safeArray(existing.memory_entry_ids, 4096), ...safeArray(root.memory_entry_ids, 4096)], 4096);
    existing.source_topic_ids = uniqueStrings([...safeArray(existing.source_topic_ids, 4096), ...safeArray(root.source_topic_ids, 4096)], 4096);
    existing.source_trace_ids = uniqueStrings([...safeArray(existing.source_trace_ids, 4096), ...safeArray(root.source_trace_ids, 4096)], 4096);
    existing.memory_count = existing.memory_entry_ids.length;
    existing.normalization_notes = uniqueStrings([...safeArray(existing.normalization_notes, 24), ...safeArray(normalized.normalization_notes, 12)], 24);
    candidateMap.set(id, existing);
  }
  return Array.from(candidateMap.values()).sort((left, right) =>
    left.root_kind.localeCompare(right.root_kind) ||
    right.memory_count - left.memory_count ||
    left.root_path.localeCompare(right.root_path, 'zh')
  );
}

function classifyEdgeImportPolicy(vine = {}, fromRoot = {}, toRoot = {}) {
  const relationType = safeText(vine.vine_kind);
  const evidenceCount = safeArray(vine.evidence_entry_ids, 4096).length;
  const notes = [];
  let importStatus = 'needs_review';
  let candidateKind = 'cold_relation_edge';
  let defaultDestination = 'memory_tree_edge_candidate';
  let semanticEdge = true;
  let importToActiveCandidateGraph = false;

  if ((relationType === 'continues_from' || relationType === 'continues_to') && evidenceCount <= 0) {
    importStatus = 'audit_candidate';
    candidateKind = 'audit_sequence_edge';
    defaultDestination = 'audit_candidate_only';
    semanticEdge = false;
    notes.push('sequence_edge_without_entry_evidence');
  } else if (relationType === 'co_recalled') {
    importStatus = 'background_cooccurrence';
    candidateKind = 'background_cooccurrence_edge';
    defaultDestination = 'cooccurrence_background';
    semanticEdge = false;
    notes.push('co_recalled_is_background_not_semantic_edge');
  } else if (['relationship_affects', 'belongs_to_arc'].includes(relationType) && evidenceCount >= 2) {
    importStatus = 'active_candidate';
    importToActiveCandidateGraph = true;
  } else if (evidenceCount >= 2) {
    importStatus = 'candidate';
  } else {
    notes.push('insufficient_entry_evidence');
  }

  if ([fromRoot.graph_visibility, toRoot.graph_visibility].includes('audit_only')) {
    importStatus = 'audit_candidate';
    defaultDestination = 'audit_candidate_only';
    importToActiveCandidateGraph = false;
    notes.push('endpoint_root_is_audit_only');
  }

  return {
    import_status: importStatus,
    candidate_kind: candidateKind,
    bridge_import_policy: {
      default_destination: defaultDestination,
      write_warm_memory: false,
      requires_confirmation: true,
      semantic_edge: semanticEdge,
      import_to_active_candidate_graph: importToActiveCandidateGraph
    },
    normalization_notes: uniqueStrings(notes, 12)
  };
}

function buildNormalizedTreeEdgeCandidates(relationVines = [], relationRoots = []) {
  const rootLookup = buildNormalizedRootLookup(relationRoots);
  return (Array.isArray(relationVines) ? relationVines : []).map((vine) => {
    const fromRoot = rootLookup.get(safeText(vine.from_root_id)) || normalizeRootForInterop({
      root_id: vine.from_root_id,
      root_kind: '',
      root_name: vine.from_root_name
    });
    const toRoot = rootLookup.get(safeText(vine.to_root_id)) || normalizeRootForInterop({
      root_id: vine.to_root_id,
      root_kind: '',
      root_name: vine.to_root_name
    });
    const policy = classifyEdgeImportPolicy(vine, fromRoot, toRoot);
    return {
      schema: 'driftstone_normalized_tree_edge_candidate_v0.3',
      candidate_id: stableObjectId('tree_edge_candidate', [vine.vine_id]),
      source_vine_id: vine.vine_id,
      source_system: 'driftstone',
      import_status: policy.import_status,
      candidate_kind: policy.candidate_kind,
      target_layer: 'notion_relation_vines',
      bridge_import_policy: policy.bridge_import_policy,
      relation_type: vine.vine_kind,
      relation_label: vine.relation_label,
      from_ref: {
        root_id: fromRoot.normalized_root_id,
        source_root_id: vine.from_root_id,
        root_name: fromRoot.root_name,
        root_path: fromRoot.root_path,
        graph_visibility: fromRoot.graph_visibility
      },
      to_ref: {
        root_id: toRoot.normalized_root_id,
        source_root_id: vine.to_root_id,
        root_name: toRoot.root_name,
        root_path: toRoot.root_path,
        graph_visibility: toRoot.graph_visibility
      },
      evidence_entry_ids: safeArray(vine.evidence_entry_ids, 4096),
      evidence_topic_ids: safeArray(vine.evidence_topic_ids, 4096),
      source_trace_ids: safeArray(vine.source_trace_ids, 4096),
      summary_hints: safeArray(vine.summary_hints, 12),
      confidence: vine.confidence,
      strength: Number(vine.strength || 0),
      normalization_notes: policy.normalization_notes
    };
  });
}

function buildNormalizedSourceTraceCandidates(sourceTraceWarehouse = []) {
  return (Array.isArray(sourceTraceWarehouse) ? sourceTraceWarehouse : []).map((trace) => ({
    schema: 'driftstone_normalized_source_trace_candidate_v0.2',
    candidate_id: stableObjectId('source_trace_candidate', [trace.trace_id]),
    source_trace_id: trace.trace_id,
    source_system: 'driftstone',
    import_status: 'candidate',
    candidate_kind: 'source_trace_index',
    target_layer: 'notion_source_trace_warehouse',
    bridge_import_policy: {
      default_destination: 'source_trace_index',
      write_warm_memory: false,
      expose_to_front_model_by_default: false
    },
    canonical_source_span: buildCanonicalSourceSpan(trace),
    evidence_excerpt: buildEvidenceExcerpt(trace),
    trace_kind: trace.trace_kind,
    trace_title: trace.trace_title,
    topic_id: trace.topic_id,
    topic_label: trace.topic_label,
    source_window_title: trace.source_window_title,
    source_msg_range: trace.source_msg_range,
    excerpt_hint: trace.excerpt_hint,
    source_refs: safeArray(trace.source_refs, 64),
    linked_memory_entry_ids: safeArray(trace.linked_memory_entry_ids, 4096),
    linked_root_ids: safeArray(trace.linked_root_ids, 4096),
    audit_note: trace.audit_note
  }));
}

function buildCanonicalSourceSpan(trace = {}) {
  const sourceWindow = safeText(trace.source_window_title || trace.source_window_id || trace.source_bundle_id, 'unknown_source');
  const msgRange = safeText(trace.source_msg_range, 'unknown_range');
  return {
    source_span_id: stableObjectId('source_span', [sourceWindow, msgRange]),
    source_window_id: trace.source_window_id,
    source_window_title: trace.source_window_title,
    source_msg_range: trace.source_msg_range,
    source_bundle_id: trace.source_bundle_id,
    chunk_id: trace.chunk_id
  };
}

function buildEvidenceExcerpt(trace = {}) {
  const span = buildCanonicalSourceSpan(trace);
  const excerpt = safeText(trace.excerpt_hint || trace.excerpt_text);
  return {
    evidence_excerpt_id: stableObjectId('evidence_excerpt', [span.source_span_id, excerpt]),
    source_span_id: span.source_span_id,
    excerpt_hint: trace.excerpt_hint,
    excerpt_text: trace.excerpt_text,
    excerpt_hash: stableObjectId('excerpt_hash', [excerpt])
  };
}

function isSourceSpanOverloaded(span = {}) {
  return safeArray(span.source_trace_ids, 4096).length > 12 ||
    safeArray(span.evidence_excerpt_ids, 4096).length > 12 ||
    safeArray(span.linked_memory_entry_ids, 4096).length > 10;
}

function chunkArray(values = [], size = 10) {
  const rows = Array.isArray(values) ? values : [];
  const chunks = [];
  const chunkSize = Math.max(1, Number(size || 10));
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks.length ? chunks : [[]];
}

function makeSourceChildSpan({ parent = {}, trace = {}, childIndex = 0, linkedMemoryEntryIds = [] } = {}) {
  const excerpt = buildEvidenceExcerpt(trace);
  const childId = stableObjectId('source_child_span', [
    parent.source_span_id,
    trace.trace_id,
    childIndex,
    linkedMemoryEntryIds.join('|')
  ]);
  return {
    schema: 'driftstone_normalized_source_span_candidate_v0.3',
    candidate_id: stableObjectId('source_span_candidate', [childId]),
    source_span_id: childId,
    parent_source_span_id: parent.source_span_id,
    span_role: 'child_span',
    source_system: 'driftstone',
    import_status: 'candidate',
    candidate_kind: 'canonical_source_child_span',
    target_layer: 'notion_source_span_index',
    bridge_import_policy: {
      default_destination: 'source_span_child_index',
      write_warm_memory: false,
      expose_to_front_model_by_default: false
    },
    source_window_id: parent.source_window_id,
    source_window_title: parent.source_window_title,
    source_msg_range: parent.source_msg_range,
    source_bundle_id: parent.source_bundle_id,
    chunk_ids: uniqueStrings([trace.chunk_id], 8),
    source_trace_ids: uniqueStrings([trace.trace_id], 8),
    evidence_excerpt_ids: uniqueStrings([excerpt.evidence_excerpt_id], 8),
    linked_memory_entry_ids: uniqueStrings(linkedMemoryEntryIds, 12),
    linked_root_ids: uniqueStrings(safeArray(trace.linked_root_ids, 4096), 64),
    source_refs: uniqueStrings(safeArray(trace.source_refs, 64).filter((ref) => !isBatchArtifactRef(ref)), 32),
    split_policy: {
      reason: 'parent_source_span_overloaded',
      child_index: childIndex,
      child_memory_count: uniqueStrings(linkedMemoryEntryIds, 12).length
    }
  };
}

function buildNormalizedSourceSpanCandidates(sourceTraceWarehouse = []) {
  const spanMap = new Map();
  for (const trace of Array.isArray(sourceTraceWarehouse) ? sourceTraceWarehouse : []) {
    const span = buildCanonicalSourceSpan(trace);
    const excerpt = buildEvidenceExcerpt(trace);
    const existing = spanMap.get(span.source_span_id) || {
      schema: 'driftstone_normalized_source_span_candidate_v0.3',
      candidate_id: stableObjectId('source_span_candidate', [span.source_span_id]),
      source_span_id: span.source_span_id,
      parent_source_span_id: null,
      child_source_span_ids: [],
      span_role: 'canonical_span',
      source_system: 'driftstone',
      import_status: 'candidate',
      candidate_kind: 'canonical_source_span',
      target_layer: 'notion_source_span_index',
      bridge_import_policy: {
        default_destination: 'source_span_index',
        write_warm_memory: false,
        expose_to_front_model_by_default: false
      },
      source_window_id: span.source_window_id,
      source_window_title: span.source_window_title,
      source_msg_range: span.source_msg_range,
      source_bundle_id: span.source_bundle_id,
      chunk_ids: [],
      source_trace_ids: [],
      evidence_excerpt_ids: [],
      linked_memory_entry_ids: [],
      linked_root_ids: [],
      source_refs: [],
      source_trace_rows: []
    };
    existing.chunk_ids = uniqueStrings([...safeArray(existing.chunk_ids, 128), span.chunk_id], 128);
    existing.source_trace_ids = uniqueStrings([...safeArray(existing.source_trace_ids, 4096), trace.trace_id], 4096);
    existing.evidence_excerpt_ids = uniqueStrings([...safeArray(existing.evidence_excerpt_ids, 4096), excerpt.evidence_excerpt_id], 4096);
    existing.linked_memory_entry_ids = uniqueStrings([...safeArray(existing.linked_memory_entry_ids, 4096), ...safeArray(trace.linked_memory_entry_ids, 4096)], 4096);
    existing.linked_root_ids = uniqueStrings([...safeArray(existing.linked_root_ids, 4096), ...safeArray(trace.linked_root_ids, 4096)], 4096);
    existing.source_refs = uniqueStrings([...safeArray(existing.source_refs, 128), ...safeArray(trace.source_refs, 64).filter((ref) => !isBatchArtifactRef(ref))], 128);
    existing.source_trace_rows.push(trace);
    spanMap.set(span.source_span_id, existing);
  }
  const rows = [];
  for (const span of spanMap.values()) {
    const sourceTraceRows = Array.isArray(span.source_trace_rows) ? span.source_trace_rows : [];
    delete span.source_trace_rows;
    if (!isSourceSpanOverloaded(span)) {
      rows.push(span);
      continue;
    }
    const childSpans = [];
    for (const trace of sourceTraceRows) {
      const memoryChunks = chunkArray(uniqueStrings(safeArray(trace.linked_memory_entry_ids, 4096), 4096), 10);
      for (let index = 0; index < memoryChunks.length; index += 1) {
        childSpans.push(makeSourceChildSpan({
          parent: span,
          trace,
          childIndex: index,
          linkedMemoryEntryIds: memoryChunks[index]
        }));
      }
    }
    span.span_role = 'parent_span';
    span.import_status = 'audit_parent';
    span.candidate_kind = 'canonical_source_span_parent';
    span.bridge_import_policy = {
      default_destination: 'source_span_parent_index',
      write_warm_memory: false,
      expose_to_front_model_by_default: false
    };
    span.child_source_span_ids = uniqueStrings(childSpans.map((child) => child.source_span_id), 4096);
    span.overflow_counts = {
      source_trace_count: safeArray(span.source_trace_ids, 4096).length,
      evidence_excerpt_count: safeArray(span.evidence_excerpt_ids, 4096).length,
      linked_memory_entry_count: safeArray(span.linked_memory_entry_ids, 4096).length,
      linked_root_count: safeArray(span.linked_root_ids, 4096).length
    };
    span.source_trace_ids = safeArray(span.source_trace_ids, 12);
    span.evidence_excerpt_ids = safeArray(span.evidence_excerpt_ids, 12);
    span.linked_memory_entry_ids = safeArray(span.linked_memory_entry_ids, 10);
    span.linked_root_ids = safeArray(span.linked_root_ids, 12);
    span.source_refs = safeArray(span.source_refs, 12);
    rows.push(span, ...childSpans);
  }
  return rows.sort((left, right) =>
    safeText(left.source_window_title).localeCompare(safeText(right.source_window_title), 'zh') ||
    safeText(left.source_msg_range).localeCompare(safeText(right.source_msg_range), 'zh') ||
    safeText(left.span_role).localeCompare(safeText(right.span_role), 'zh')
  );
}

function buildNormalizedInteropSummary({
  memoryCandidates = [],
  rootCandidates = [],
  edgeCandidates = [],
  sourceTraceCandidates = [],
  sourceSpanCandidates = [],
  asherieHomeMemoryNodes = [],
  sourceTraceIndex = []
} = {}) {
  const rows = Array.isArray(memoryCandidates) ? memoryCandidates : [];
  const roots = Array.isArray(rootCandidates) ? rootCandidates : [];
  const edges = Array.isArray(edgeCandidates) ? edgeCandidates : [];
  const spans = Array.isArray(sourceSpanCandidates) ? sourceSpanCandidates : [];
  const nodes = Array.isArray(asherieHomeMemoryNodes) ? asherieHomeMemoryNodes : [];
  const traceIndexRows = Array.isArray(sourceTraceIndex) ? sourceTraceIndex : [];
  const ready = rows.filter((item) => safeText(item.quality?.review_status) === 'ready_for_cold_archive');
  const needsReview = rows.filter((item) => safeText(item.quality?.review_status) === 'needs_review');
  const feelingTexts = nodes.map((item) => feelingCoreWithoutAnchor(item.feeling_as_fact)).filter(Boolean);
  const feelingCounts = new Map();
  for (const text of feelingTexts) {
    const key = normalizeComparableText(text);
    if (!key) continue;
    feelingCounts.set(key, (feelingCounts.get(key) || 0) + 1);
  }
  const feelingCountValues = Array.from(feelingCounts.values()).sort((left, right) => right - left);
  const feelingDuplicateTextCount = feelingCountValues.reduce((sum, count) => sum + (count > 1 ? count : 0), 0);
  const feelingTopTemplateCount = feelingCountValues.slice(0, 10).reduce((sum, count) => sum + count, 0);
  return {
    schema: 'driftstone_notion_bridge_interop_summary_v0.5',
    generated_at: new Date().toISOString(),
    policy: {
      sync_model: 'machine_json_primary_with_notion_projection',
      old_history_track: 'cold_archive_import',
      active_window_track: 'active_window_sediment',
      primary_machine_tracks: ['source_trace_index', 'asheriehome_memory_nodes'],
      notion_role: 'visual_backup_and_chatgpt_readable_projection',
      obsidian_role: 'human_readable_markdown_export',
      default_old_history_bridge_target: 'asheriehome_cold_tree_node',
      write_warm_memory_by_default: false,
      note: '旧历史先落成原文溯源 JSON 与 AsherieHome 轻冷树记忆节点 JSON；Notion 只做同字段可视投影，不是主库。'
    },
    counts: {
      memory_candidates: rows.length,
      asheriehome_memory_nodes: nodes.length,
      source_trace_index: traceIndexRows.length,
      root_candidates: Array.isArray(rootCandidates) ? rootCandidates.length : 0,
      tree_edge_candidates: Array.isArray(edgeCandidates) ? edgeCandidates.length : 0,
      source_trace_candidates: Array.isArray(sourceTraceCandidates) ? sourceTraceCandidates.length : 0,
      source_span_candidates: Array.isArray(sourceSpanCandidates) ? sourceSpanCandidates.length : 0,
      ready_for_cold_archive: ready.length,
      needs_review: needsReview.length,
      review_status_distribution: countBy(rows.map((item) => ({ review_status: item.quality?.review_status })), 'review_status'),
      candidate_kind_distribution: countBy(rows, 'candidate_kind'),
      target_layer_distribution: countBy(rows, 'target_layer'),
      asherie_node_kind_distribution: countBy(nodes, 'node_kind'),
      asherie_context_domain_distribution: countBy(nodes, 'context_domain'),
      asherie_recall_guard_distribution: countBy(nodes.map((item) => ({ recall_guard: item.quality?.recall_guard })), 'recall_guard'),
      asherie_tree_growth_distribution: countBy(nodes.map((item) => ({ tree_growth_status: item.quality?.tree_growth_status })), 'tree_growth_status'),
      recall_lane_distribution: countBy(rows, 'recall_lane'),
      root_import_status_distribution: countBy(rootCandidates, 'import_status'),
      edge_import_status_distribution: countBy(edgeCandidates, 'import_status')
    },
    quality_delta: {
      root_kind_correction_count: roots.filter((item) => safeArray(item.normalization_notes, 32).some((note) => /root_kind_corrected/iu.test(note))).length,
      relation_lane_merge_count: roots.filter((item) => safeArray(item.normalization_notes, 32).some((note) => /merged|secondary_relation_lane/iu.test(note))).length,
      duplicate_title_correction_count: rows.filter((item) => item.title_normalization?.disambiguated).length,
      machine_title_cleaned_count: rows.filter((item) => item.title_normalization?.machine_title_cleaned).length,
      source_span_parent_split_count: spans.filter((item) => item.span_role === 'parent_span').length,
      source_span_child_count: spans.filter((item) => item.span_role === 'child_span').length,
      human_summary_shell_count: rows.filter((item) => isWeakHumanSummary(item.summary || item.human_summary_cn)).length,
      stable_human_summary_shell_count: rows.filter((item) =>
        safeText(item.quality?.review_status) === 'ready_for_cold_archive' &&
        isWeakHumanSummary(item.summary || item.human_summary_cn)
      ).length,
      ready_language_glitch_count: rows.filter((item) =>
        safeText(item.quality?.review_status) === 'ready_for_cold_archive' &&
        hasObviousLanguageGlitch([item.summary, item.compact_recall_text, item.front_recall_text].join(' '))
      ).length,
      max_background_source_ref_count: rows.reduce((max, item) => Math.max(max, Number(item.background_source_ref_count || 0)), 0),
      usable_machine_residue_count: rows.filter((item) =>
        safeText(item.quality?.review_status) === 'usable_with_sampling' &&
        (hasMachineTitleResidue(item.title) || hasMachineResidue([item.summary, item.compact_recall_text, item.front_recall_text].join(' ')))
      ).length,
      asherie_structured_slot_complete_count: nodes.filter((item) => safeText(item.quality?.structured_slot_status) === 'complete').length,
      asherie_folded_duplicate_node_count: nodes.filter((item) => safeText(item.tree_growth?.merge_role) === 'near_duplicate_evidence').length,
      asherie_node_path_rerouted_count: nodes.filter((item) => item.quality?.node_path_rerouted === true).length,
      asherie_supporting_evidence_guard_count: nodes.filter((item) => safeText(item.quality?.recall_guard) === 'supporting_evidence_only').length,
      asherie_dangling_visible_text_count: nodes.filter((item) => safeText(item.quality?.visible_text_integrity) === 'dangling_or_masked_text').length,
      asherie_short_living_fragment_count: nodes.filter((item) => safeText(item.living_fragment).length < 16).length,
      asherie_same_living_feeling_count: nodes.filter((item) =>
        safeText(item.living_fragment) &&
        safeText(item.feeling_as_fact) &&
        normalizeComparableText(item.living_fragment) === normalizeComparableText(item.feeling_as_fact)
      ).length,
      asherie_feeling_fixed_prefix_count: nodes.filter((item) => /^这段记忆/u.test(safeText(item.feeling_as_fact))).length,
      asherie_feeling_duplicate_text_count: feelingDuplicateTextCount,
      feeling_template_reuse_rate: percent(feelingTopTemplateCount, feelingTexts.length),
      asherie_feeling_rewrite_needed_count: nodes.filter((item) =>
        safeArray(item.quality?.structured_slot_flags, 16).includes('needs_feeling_rewrite')
      ).length,
      asherie_weak_detail_count: nodes.filter((item) =>
        safeArray(item.quality?.structured_slot_flags, 16).includes('weak_detail')
      ).length,
      active_edge_count: edges.filter((item) => item.import_status === 'active_candidate').length
    },
    chatgpt_quality_review_prompt: [
      '请把这些记忆当作旧历史冷归档候选，不要当作当前窗口热上下文。',
      '优先检查 asheriehome_memory_nodes 的 living_fragment / feeling_as_fact 是否保留了活的关系质感。',
      '检查 node_path 是否适合 AsherieHome 轻冷树挂载；Notion 只是可视投影，不是主库。',
      '检查明显重复、幻觉、关系误挂、语气机器化、原文回溯断线。',
      '不要根据隐藏机读字段评价人类阅读体验；隐藏字段主要服务同步、召回和回溯。'
    ]
  };
}

function buildFinalImportLists({
  memoryCandidates = [],
  edgeCandidates = []
} = {}) {
  const memories = Array.isArray(memoryCandidates) ? memoryCandidates : [];
  const edges = Array.isArray(edgeCandidates) ? edgeCandidates : [];
  const notionImportRow = (item = {}) => {
    const {
      background_source_refs,
      ...row
    } = item;
    return {
      ...row,
      background_source_ref_count: Number(item.background_source_ref_count || safeArray(background_source_refs, 4096).length)
    };
  };
  return {
    notion_stable_import: memories.filter((item) => safeText(item.quality?.review_status) === 'ready_for_cold_archive').map(notionImportRow),
    notion_sampling_import: memories.filter((item) => safeText(item.quality?.review_status) === 'usable_with_sampling').map(notionImportRow),
    notion_review_queue: memories.filter((item) => safeText(item.quality?.review_status) === 'needs_review').map(notionImportRow),
    bridge_candidate_graph: edges.filter((item) => safeText(item.import_status) === 'active_candidate')
  };
}

function buildAsherieHomeNotionProjectionLists(asherieHomeMemoryNodes = []) {
  const nodes = Array.isArray(asherieHomeMemoryNodes) ? asherieHomeMemoryNodes : [];
  const project = (node = {}) => ({
    schema: 'driftstone_asheriehome_notion_projection_v0.4',
    node_id: node.node_id,
    context_domain: node.context_domain,
    node_path: node.node_path,
    original_node_path: node.original_node_path,
    anchor_name: node.anchor_name,
    title: node.title,
    living_fragment: node.living_fragment,
    feeling_as_fact: node.feeling_as_fact,
    project_fact: node.project_fact,
    relationship_significance: node.relationship_significance,
    review_status: node.quality?.review_status,
    archive_bucket: node.quality?.archive_bucket,
    recall_guard: node.quality?.recall_guard,
    frontend_delivery_tier: node.quality?.frontend_delivery_tier,
    front_recall_tier: node.quality?.front_recall_tier,
    source_trace_count: safeArray(node.source_trace_ids, 4096).length,
    source_span_count: safeArray(node.source_span_ids, 4096).length,
    feeling_handles: safeArray(node.feeling_handles, 16),
    sensory_handles: safeArray(node.sensory_handles, 16),
    action_handles: safeArray(node.action_handles, 16),
    relation_handles: safeArray(node.relation_handles, 16),
    tree_growth_status: node.quality?.tree_growth_status,
    merge_role: node.tree_growth?.merge_role,
    default_front_projection: node.quality?.default_front_projection
  });
  return {
    notion_asherie_stable_projection: nodes
      .filter((node) =>
        safeText(node.quality?.review_status) === 'ready_for_cold_archive' &&
        safeText(node.tree_growth?.merge_role) !== 'near_duplicate_evidence'
      )
      .map(project),
    notion_asherie_sampling_projection: nodes
      .filter((node) =>
        safeText(node.quality?.review_status) === 'usable_with_sampling' ||
        (
          safeText(node.quality?.review_status) === 'ready_for_cold_archive' &&
          safeText(node.tree_growth?.merge_role) === 'near_duplicate_evidence'
        )
      )
      .map(project),
    notion_asherie_review_projection: nodes
      .filter((node) => safeText(node.quality?.review_status) === 'needs_review')
      .map(project)
  };
}

function buildNormalizedInteropBundle({ memoryEntries = [], relationRoots = [], relationVines = [], sourceTraceWarehouse = [], personaWorkspace = {} } = {}) {
  const notionReviewCards = buildNotionReviewCards({ memoryEntries, relationRoots, sourceTraceWarehouse });
  const normalizedMemoryCandidates = buildNormalizedMemoryCandidates({ memoryEntries, relationRoots, sourceTraceWarehouse });
  const normalizedRootCandidates = buildNormalizedRootCandidates(relationRoots);
  const normalizedTreeEdgeCandidates = buildNormalizedTreeEdgeCandidates(relationVines, relationRoots);
  const normalizedSourceTraceCandidates = buildNormalizedSourceTraceCandidates(sourceTraceWarehouse);
  const normalizedSourceSpanCandidates = buildNormalizedSourceSpanCandidates(sourceTraceWarehouse);
  const asherieHomeMemoryNodes = buildAsherieHomeMemoryNodes({
    memoryEntries,
    relationRoots,
    sourceTraceWarehouse,
    personaWorkspace
  });
  const sourceTraceIndex = buildMachineSourceTraceIndex({
    sourceTraceWarehouse,
    sourceSpanCandidates: normalizedSourceSpanCandidates
  });
  const finalImportLists = buildFinalImportLists({
    memoryCandidates: normalizedMemoryCandidates,
    edgeCandidates: normalizedTreeEdgeCandidates
  });
  const asherieNotionProjectionLists = buildAsherieHomeNotionProjectionLists(asherieHomeMemoryNodes);
  return {
    notion_review_cards: notionReviewCards,
    normalized_memory_candidates: normalizedMemoryCandidates,
    normalized_relation_root_candidates: normalizedRootCandidates,
    normalized_tree_edge_candidates: normalizedTreeEdgeCandidates,
    normalized_source_trace_candidates: normalizedSourceTraceCandidates,
    normalized_source_span_candidates: normalizedSourceSpanCandidates,
    asheriehome_memory_nodes: asherieHomeMemoryNodes,
    source_trace_index: sourceTraceIndex,
    ...finalImportLists,
    ...asherieNotionProjectionLists,
    interop_summary: buildNormalizedInteropSummary({
      memoryCandidates: normalizedMemoryCandidates,
      rootCandidates: normalizedRootCandidates,
      edgeCandidates: normalizedTreeEdgeCandidates,
      sourceTraceCandidates: normalizedSourceTraceCandidates,
      sourceSpanCandidates: normalizedSourceSpanCandidates,
      asherieHomeMemoryNodes,
      sourceTraceIndex
    })
  };
}

async function buildPersonaWorkspacePayload(monthHints = []) {
  const [state, snapshot] = await Promise.all([
    loadPersonaWorkspaceState(),
    getPersonaWorkspaceSnapshot({
      includePersonaRows: true,
      includePersonaContextRows: true,
      rowLimit: 12,
      contextRowLimit: 24,
      monthHints
    })
  ]);
  return {
    char_name: safeText(state.char_name),
    user_name: safeText(state.user_name),
    persona_card: safeText(state.persona_card),
    language_fingerprint: safeText(state.language_fingerprint),
    fingerprint_candidate_pool: safeText(state.fingerprint_candidate_pool),
    persona_cache_total: Number(snapshot?.persona_cache?.total_rows || 0),
    persona_preview: Array.isArray(snapshot?.persona_cache?.preview) ? snapshot.persona_cache.preview : [],
    persona_context_rows: Array.isArray(snapshot?.persona_cache?.context_rows) ? snapshot.persona_cache.context_rows : []
  };
}

export async function buildNotionMemoryCoreBundle({
  monthHints = []
} = {}) {
  const normalizedMonthHints = uniqueStrings((Array.isArray(monthHints) ? monthHints : []).map((item) => normalizeMonthHint(item)).filter(Boolean), 24);
  const reviewed = await loadReviewedDataset({
    monthHints: normalizedMonthHints
  });
  const reviewedRows = reviewed.rows
    .filter((row) => ['persona', 'sql', 'case'].includes(normalizeLayer(row.layer)))
    .map((row) => transformReviewedRow(row, safeText(row.month_key)));
  const sourceTopics = (await loadSourceTopicEntries())
    .filter((entry) => {
      const monthKey = normalizeMonthHint(entry.file);
      return !normalizedMonthHints.length || normalizedMonthHints.includes(monthKey);
    })
    .map((entry) => transformSourceTopic(entry));
  const personaWorkspace = await buildPersonaWorkspacePayload(normalizedMonthHints);
  const traceWarehouse = buildSourceTraceWarehouse(reviewedRows, sourceTopics);
  const relationTree = buildLightRelationTree({
    entries: reviewedRows,
    sourceTopics,
    personaWorkspace,
    traceWarehouse
  });
  const memoryEntries = attachTreeLinksToEntries(reviewedRows, relationTree, traceWarehouse, personaWorkspace);
  const storyTimeline = buildStoryTimeline({
    entries: memoryEntries,
    sourceTopics,
    relationTree,
    traceWarehouse
  });
  const sourceTraceWarehouse = traceWarehouse.source_traces;
  const recallPreviewPackets = buildRecallPreviewPackets({
    memoryEntries,
    relationRoots: relationTree.relation_roots,
    relationVines: relationTree.relation_vines
  });
  const normalizedInterop = buildNormalizedInteropBundle({
    memoryEntries,
    relationRoots: relationTree.relation_roots,
    relationVines: relationTree.relation_vines,
    sourceTraceWarehouse,
    personaWorkspace
  });
  const qualityReport = buildNotionQualityReport({
    memoryEntries,
    sourceTopics,
    relationRoots: relationTree.relation_roots,
    relationVines: relationTree.relation_vines,
    storyTimeline,
    sourceTraceWarehouse,
    recallPreviewPackets
  });
  const manifest = {
    export_kind: 'notion_memory_core_bundle',
    export_profile: 'debug_rehydrated_reviewed_relation_tree',
    generated_at: new Date().toISOString(),
    month_hints: normalizedMonthHints,
    counts: {
      memory_entries: memoryEntries.length,
      source_topics: sourceTopics.length,
      relation_roots: relationTree.relation_roots.length,
      relation_vines: relationTree.relation_vines.length,
      story_timeline: storyTimeline.length,
      source_traces: sourceTraceWarehouse.length,
      recall_preview_packets: recallPreviewPackets.length,
      notion_review_cards: normalizedInterop.notion_review_cards.length,
      normalized_memory_candidates: normalizedInterop.normalized_memory_candidates.length,
      asheriehome_memory_nodes: normalizedInterop.asheriehome_memory_nodes.length,
      normalized_relation_root_candidates: normalizedInterop.normalized_relation_root_candidates.length,
      normalized_tree_edge_candidates: normalizedInterop.normalized_tree_edge_candidates.length,
      normalized_source_trace_candidates: normalizedInterop.normalized_source_trace_candidates.length,
      normalized_source_span_candidates: normalizedInterop.normalized_source_span_candidates.length,
      source_trace_index: normalizedInterop.source_trace_index.length,
      notion_stable_import: normalizedInterop.notion_stable_import.length,
      notion_sampling_import: normalizedInterop.notion_sampling_import.length,
      notion_review_queue: normalizedInterop.notion_review_queue.length,
      notion_asherie_stable_projection: normalizedInterop.notion_asherie_stable_projection.length,
      notion_asherie_sampling_projection: normalizedInterop.notion_asherie_sampling_projection.length,
      notion_asherie_review_projection: normalizedInterop.notion_asherie_review_projection.length,
      bridge_candidate_graph: normalizedInterop.bridge_candidate_graph.length,
      layer_distribution: countBy(memoryEntries, 'entry_type'),
      shape_distribution: countBy(memoryEntries, 'shape_label'),
      recall_lane_distribution: countBy(memoryEntries, 'recall_lane'),
      root_kind_distribution: countBy(relationTree.relation_roots, 'root_kind')
    },
    quality_status: {
      status: qualityReport.status,
      issue_count: qualityReport.issues.length,
      fail_count: qualityReport.issues.filter((item) => item.severity === 'fail').length,
      warn_count: qualityReport.issues.filter((item) => item.severity === 'warn').length,
      summary: qualityReport.human_readable_summary
    },
    quality_target: {
      focus: [
        '结构是否适合机读',
        '字段是否足够支持未来召回',
        '内容是否能充当“曾经上下文”的供给层',
        '原文回溯是否可靠',
        '记忆是否保留陪伴语气、内位视角和语言指纹线索',
        '前台召回是否只递送小片关系化上下文'
      ],
      non_goals: [
        '启发式体检不替代模型级人格代入评分',
        '启发式体检不替代人工抽样判断情感质量',
        '当前不把原文溯源塞进主召回；原文只作为可核验存证仓'
      ]
    },
    relation_tree_policy: {
      profile: 'light_relation_tree_for_companion_and_fiction',
      main_machine_tables: ['asheriehome_memory_nodes', 'normalized_relation_root_candidates', 'normalized_tree_edge_candidates'],
      audit_machine_tables: ['source_trace_index', 'normalized_source_span_candidates'],
      notion_projection_tables: ['notion_review_cards', 'notion_stable_import', 'notion_sampling_import', 'notion_review_queue'],
      design_note: 'Driftstone/Home 走关系型召回：AsherieHome/MCP 优先读轻冷树 JSON；Notion 只是同字段可视投影和 ChatGPT 端备份整理点；原文回溯 JSON 含 tag，只作核验和过滤。'
    },
    interop_policy: normalizedInterop.interop_summary.policy,
    front_delivery_contract: qualityReport.recall_potential.front_delivery_contract,
    suggested_notion_databases: [
      {
        key: 'memory_entries',
        title: 'Memory Entries',
        primary_property: 'title',
        properties: {
          entry_id: 'rich_text',
          entry_type: 'select',
          month_key: 'select',
          memory_shape: 'select',
          shape_label: 'select',
          summary: 'rich_text',
          recall_payload: 'rich_text',
          front_recall_text: 'rich_text',
          activation_triggers: 'multi_select',
          recall_lane: 'select',
          primary_root_id: 'relation_or_rich_text',
          primary_root_path: 'rich_text',
          root_ids: 'relation_or_multi_select',
          root_path_text: 'rich_text',
          relation_vine_ids: 'relation_or_multi_select',
          source_trace_ids: 'relation_or_multi_select',
          machine_index_text: 'rich_text',
          companion_voice_tier: 'select',
          companion_voice_score: 'number',
          companion_voice_flags: 'multi_select',
          front_recall_tier: 'select',
          front_recall_chars: 'number',
          front_recall_flags: 'multi_select',
          scene_handles: 'multi_select',
          recall_facts: 'rich_text',
          topic_labels: 'multi_select',
          source_window_title: 'rich_text',
          source_ref: 'url_or_rich_text',
          privacy_codes: 'multi_select',
          quality_flags: 'multi_select'
        }
      },
      {
        key: 'relation_roots',
        title: 'Relation Roots',
        primary_property: 'root_name',
        properties: {
          root_id: 'rich_text',
          root_kind: 'select',
          kind_label: 'select',
          root_path: 'rich_text',
          aliases: 'multi_select',
          memory_entry_ids: 'relation_or_multi_select',
          source_topic_ids: 'relation_or_multi_select',
          source_trace_ids: 'relation_or_multi_select',
          recall_keywords: 'multi_select',
          summary_hints: 'rich_text'
        }
      },
      {
        key: 'relation_vines',
        title: 'Relation Vines',
        primary_property: 'vine_id',
        properties: {
          vine_kind: 'select',
          relation_label: 'select',
          from_root_id: 'relation_or_rich_text',
          from_root_path: 'rich_text',
          to_root_id: 'relation_or_rich_text',
          to_root_path: 'rich_text',
          evidence_entry_ids: 'relation_or_multi_select',
          evidence_topic_ids: 'relation_or_multi_select',
          source_trace_ids: 'relation_or_multi_select',
          strength: 'number',
          summary_hints: 'rich_text'
        }
      },
      {
        key: 'story_timeline',
        title: 'Story Timeline',
        primary_property: 'event_title',
        properties: {
          event_id: 'rich_text',
          event_role: 'select',
          event_lane: 'select',
          source_topic_id: 'relation_or_rich_text',
          prev_event_topic_id: 'relation_or_rich_text',
          next_event_topic_id: 'relation_or_rich_text',
          linked_memory_entry_ids: 'relation_or_multi_select',
          linked_root_ids: 'relation_or_multi_select',
          source_trace_id: 'relation_or_rich_text',
          summary_hint: 'rich_text'
        }
      },
      {
        key: 'recall_preview_packets',
        title: 'Recall Preview Packets',
        primary_property: 'root_path',
        properties: {
          preview_id: 'rich_text',
          preview_kind: 'select',
          root_id: 'relation_or_rich_text',
          root_kind: 'select',
          query_seed: 'multi_select',
          selected_entry_count: 'number',
          candidate_entry_count: 'number',
          payload_chars: 'number',
          compression_percent: 'number',
          quality_flags: 'multi_select',
          selected_entry_ids: 'relation_or_multi_select',
          selected_source_trace_ids: 'relation_or_multi_select',
          nearby_vine_ids: 'relation_or_multi_select',
          prompt_context_text: 'rich_text'
        }
      },
      {
        key: 'notion_review_cards',
        title: 'Memory Review Cards',
        primary_property: 'title',
        properties: {
          card_id: 'rich_text',
          source_entry_id: 'hidden_rich_text',
          memory_type: 'select',
          recall_lane: 'select',
          relation_path: 'rich_text',
          human_summary: 'rich_text',
          human_summary_cn: 'rich_text',
          compact_recall_text: 'hidden_rich_text',
          front_recall_text: 'hidden_rich_text',
          raw_machine_fact: 'hidden_json',
          title_normalization: 'hidden_json',
          source_trace_count: 'number',
          primary_source_refs: 'hidden_relation_or_multi_select',
          supporting_source_refs: 'hidden_relation_or_multi_select',
          background_source_refs: 'hidden_relation_or_multi_select',
          background_source_ref_count: 'number',
          batch_artifacts: 'hidden_rich_text',
          review_status: 'select',
          cold_archive_policy: 'hidden_json',
          notion_visibility: 'hidden_json'
        }
      },
      {
        key: 'asheriehome_memory_nodes',
        title: 'AsherieHome Memory Nodes',
        primary_property: 'title',
        properties: {
          node_id: 'hidden_rich_text',
          source_entry_id: 'hidden_rich_text',
          node_kind: 'select',
          context_domain: 'select',
          node_path: 'rich_text',
          original_node_path: 'hidden_rich_text',
          title: 'title',
          month_key: 'select',
          time_anchor: 'rich_text',
          episode_key: 'hidden_rich_text',
          scene_anchor: 'rich_text',
          living_fragment: 'rich_text',
          feeling_as_fact: 'rich_text',
          project_fact: 'rich_text',
          relationship_significance: 'rich_text',
          recall_payload: 'hidden_rich_text',
          front_context_hint: 'hidden_rich_text',
          human_summary: 'rich_text',
          feeling_handles: 'multi_select',
          sensory_handles: 'multi_select',
          action_handles: 'multi_select',
          relation_handles: 'multi_select',
          activation_triggers: 'multi_select',
          relation_path: 'rich_text',
          source_trace_ids: 'hidden_relation_or_multi_select',
          source_span_ids: 'hidden_relation_or_multi_select',
          source_tags: 'hidden_multi_select',
          quality: 'hidden_json',
          bridge_import_policy: 'hidden_json',
          sync_hash: 'hidden_rich_text'
        }
      },
      {
        key: 'normalized_memory_candidates',
        title: 'Normalized Memory Candidates',
        primary_property: 'title',
        properties: {
          candidate_id: 'hidden_rich_text',
          source_entry_id: 'hidden_rich_text',
          candidate_kind: 'hidden_select',
          target_layer: 'hidden_select',
          bridge_import_policy: 'hidden_json',
          title: 'title',
          original_title: 'hidden_rich_text',
          title_normalization: 'hidden_json',
          memory_type: 'select',
          recall_lane: 'select',
          summary: 'rich_text',
          human_summary_cn: 'rich_text',
          compact_recall_text: 'hidden_rich_text',
          front_recall_text: 'hidden_rich_text',
          raw_machine_fact: 'hidden_json',
          entities: 'multi_select',
          root_refs: 'hidden_relation_or_json',
          source_trace_ids: 'hidden_relation_or_multi_select',
          primary_source_refs: 'hidden_relation_or_multi_select',
          supporting_source_refs: 'hidden_relation_or_multi_select',
          background_source_refs: 'hidden_relation_or_multi_select',
          background_source_ref_count: 'number',
          batch_artifacts: 'hidden_rich_text',
          quality: 'hidden_json',
          sync_keys: 'hidden_json'
        }
      },
      {
        key: 'normalized_relation_root_candidates',
        title: 'Normalized Relation Root Candidates',
        primary_property: 'root_path',
        properties: {
          candidate_id: 'hidden_rich_text',
          source_root_id: 'hidden_rich_text',
          normalized_root_id: 'hidden_rich_text',
          root_kind: 'select',
          root_name: 'title',
          root_path: 'rich_text',
          graph_visibility: 'select',
          normalization_notes: 'multi_select',
          aliases: 'multi_select',
          recall_keywords: 'multi_select',
          memory_entry_ids: 'hidden_relation_or_multi_select',
          source_trace_ids: 'hidden_relation_or_multi_select'
        }
      },
      {
        key: 'normalized_tree_edge_candidates',
        title: 'Normalized Tree Edge Candidates',
        primary_property: 'candidate_id',
        properties: {
          candidate_id: 'hidden_rich_text',
          source_vine_id: 'hidden_rich_text',
          import_status: 'select',
          candidate_kind: 'select',
          relation_type: 'select',
          relation_label: 'select',
          from_ref: 'hidden_json',
          to_ref: 'hidden_json',
          evidence_entry_ids: 'hidden_relation_or_multi_select',
          source_trace_ids: 'hidden_relation_or_multi_select',
          confidence: 'select',
          strength: 'number'
        }
      },
      {
        key: 'normalized_source_span_candidates',
        title: 'Normalized Source Span Candidates',
        primary_property: 'source_span_id',
        properties: {
          candidate_id: 'hidden_rich_text',
          source_span_id: 'rich_text',
          parent_source_span_id: 'hidden_relation_or_rich_text',
          child_source_span_ids: 'hidden_relation_or_multi_select',
          span_role: 'select',
          overflow_counts: 'hidden_json',
          source_window_title: 'rich_text',
          source_msg_range: 'rich_text',
          source_trace_ids: 'hidden_relation_or_multi_select',
          evidence_excerpt_ids: 'hidden_relation_or_multi_select',
          linked_memory_entry_ids: 'hidden_relation_or_multi_select',
          linked_root_ids: 'hidden_relation_or_multi_select'
        }
      },
      {
        key: 'source_trace_warehouse',
        title: 'Source Trace Warehouse',
        primary_property: 'trace_title',
        properties: {
          trace_id: 'rich_text',
          trace_kind: 'select',
          topic_id: 'rich_text',
          topic_label: 'rich_text',
          source_window_title: 'rich_text',
          source_msg_range: 'rich_text',
          excerpt_hint: 'rich_text',
          source_refs: 'rich_text',
          linked_memory_entry_ids: 'relation_or_multi_select',
          linked_root_ids: 'relation_or_multi_select',
          audit_note: 'rich_text'
        }
      },
      {
        key: 'source_topics',
        title: 'Source Topics',
        primary_property: 'topic_label',
        properties: {
          topic_id: 'rich_text',
          topic_role: 'select',
          exposure_priority: 'select',
          source_window_title: 'rich_text',
          source_msg_range: 'rich_text',
          topic_keywords: 'multi_select',
          excerpt_hint: 'rich_text'
        }
      }
    ]
  };

  return {
    manifest,
    memory_entries: memoryEntries,
    relation_roots: relationTree.relation_roots,
    relation_vines: relationTree.relation_vines,
    story_timeline: storyTimeline,
    recall_preview_packets: recallPreviewPackets,
    source_trace_warehouse: sourceTraceWarehouse,
    quality_report: qualityReport,
    notion_review_cards: normalizedInterop.notion_review_cards,
    normalized_memory_candidates: normalizedInterop.normalized_memory_candidates,
    asheriehome_memory_nodes: normalizedInterop.asheriehome_memory_nodes,
    normalized_relation_root_candidates: normalizedInterop.normalized_relation_root_candidates,
    normalized_tree_edge_candidates: normalizedInterop.normalized_tree_edge_candidates,
    normalized_source_trace_candidates: normalizedInterop.normalized_source_trace_candidates,
    normalized_source_span_candidates: normalizedInterop.normalized_source_span_candidates,
    source_trace_index: normalizedInterop.source_trace_index,
    notion_stable_import: normalizedInterop.notion_stable_import,
    notion_sampling_import: normalizedInterop.notion_sampling_import,
    notion_review_queue: normalizedInterop.notion_review_queue,
    notion_asherie_stable_projection: normalizedInterop.notion_asherie_stable_projection,
    notion_asherie_sampling_projection: normalizedInterop.notion_asherie_sampling_projection,
    notion_asherie_review_projection: normalizedInterop.notion_asherie_review_projection,
    bridge_candidate_graph: normalizedInterop.bridge_candidate_graph,
    interop_summary: normalizedInterop.interop_summary,
    source_topics: sourceTopics,
    persona_workspace: personaWorkspace
  };
}

export async function buildNotionRecallPreviewPacket({
  monthHints = [],
  query = '',
  rootId = '',
  rootKey = '',
  rootPath = '',
  rootName = '',
  maxEntries = 12,
  minChars = 1200,
  maxChars = 2200
} = {}) {
  const bundle = await buildNotionMemoryCoreBundle({ monthHints });
  const match = findRecallPreviewRoot({
    relationRoots: bundle.relation_roots,
    memoryEntries: bundle.memory_entries,
    query,
    rootId: rootId || rootKey,
    rootPath,
    rootName
  });
  if (!match.root) {
    return {
      ok: false,
      packet_kind: 'notion_relation_tree_recall_preview',
      packet_version: 'v0.1',
      generated_at: new Date().toISOString(),
      error: 'No relation root is available for recall preview.',
      query: safeText(query),
      month_hints: bundle.manifest.month_hints,
      bundle_summary: bundle.manifest.counts,
      quality_status: bundle.manifest.quality_status
    };
  }

  const packet = buildRecallPreviewForRoot({
    root: match.root,
    entries: bundle.memory_entries,
    relationVines: bundle.relation_vines,
    query,
    maxEntries,
    minChars,
    maxChars
  });

  return {
    ok: Number(packet.selected_entry_count || 0) > 0,
    packet_kind: 'notion_relation_tree_recall_preview',
    packet_version: 'v0.1',
    generated_at: new Date().toISOString(),
    match_reason: match.match_reason,
    match_score: match.match_score,
    alternatives: Array.isArray(match.alternatives) ? match.alternatives : [],
    month_hints: bundle.manifest.month_hints,
    bundle_summary: bundle.manifest.counts,
    quality_status: bundle.manifest.quality_status,
    front_delivery_note: '只把 prompt_context_text / selected_entries.front_recall_text 递给前台角色；selected_source_trace_ids 只作回溯核验。',
    ...packet
  };
}

function stringifyJsonl(rows = []) {
  return `${(Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function buildChatgptReviewGuide(bundle = {}) {
  const counts = bundle?.interop_summary?.counts || {};
  const policy = bundle?.interop_summary?.policy || {};
  const delta = bundle?.interop_summary?.quality_delta || {};
  return `# Driftstone / AsherieHome Cold Memory Review Guide

这包是旧 ChatGPT 历史记录的冷归档候选，不是当前窗口热上下文，也不应该直接写进 Mossbridge 温层。

本轮主链不是 Notion。主链是两份机读 JSON：\`23_asheriehome_memory_nodes.jsonl\` 给 AsherieHome / MCP / 网关读取，\`24_source_trace_index.jsonl\` 给原文回溯和 tag 过滤使用。Notion 只是同字段可视化投影和 ChatGPT 端整理备份点。

## 先读这几个文件

1. \`17_interop_summary.json\`
   - 看本批策略、候选数量、复核状态分布。
2. \`23_asheriehome_memory_nodes.jsonl\`
   - 这是轻冷树主链节点：\`node_path\`、\`living_fragment\`、\`feeling_as_fact\`、handles、source trace/span 都在这里。
3. \`24_source_trace_index.jsonl\`
   - 原文回溯主链，保留 source tag、span、excerpt 和关联节点；默认只作核验，不直接递给前台角色。
4. \`11_notion_review_cards.json\`
   - 给人类和 ChatGPT 端做质量抽样，默认只看标题、记忆类型、关系位置、摘要、复核状态、回溯数量。
5. \`12_normalized_memory_candidates.jsonl\`
   - 旧版标准候选卡，保留给历史兼容和 Notion 投影；不要把它当成新的主召回源。
6. \`13_normalized_relation_root_candidates.jsonl\` 与 \`14_normalized_tree_edge_candidates.jsonl\`
   - 给关系树候选使用，只能当候选，不要直接当事实。
7. \`15_normalized_source_trace_candidates.jsonl\` 与 \`16_normalized_source_span_candidates.jsonl\`
   - 原文回溯索引和 canonical span。默认只作核验，不直接递给前台角色。
8. \`19_notion_stable_import.jsonl\`、\`20_notion_sampling_import.jsonl\`、\`21_notion_review_queue.jsonl\`、\`22_bridge_candidate_graph.jsonl\`
   - 旧 Notion 预览/兼容清单：稳定冷仓、sampling 候选、人工复核队列、active edge 候选分开走。
9. \`25_notion_asherie_stable_projection.jsonl\`、\`26_notion_asherie_sampling_projection.jsonl\`、\`27_notion_asherie_review_projection.jsonl\`
   - 针对 AsherieHome 轻冷树字段的 Notion 可视投影；人类优先看 \`node_path\`、\`living_fragment\`、\`feeling_as_fact\` 和 handles。

## 本批策略

- 同步模型：${safeText(policy.sync_model, 'dual_track_memory')}
- 旧历史轨道：${safeText(policy.old_history_track, 'cold_archive_import')}
- 活跃窗口轨道：${safeText(policy.active_window_track, 'active_window_sediment')}
- 主机读轨道：${safeArray(policy.primary_machine_tracks, 8).join(' / ') || '未声明'}
- Notion 角色：${safeText(policy.notion_role, 'visual projection')}
- Bridge/AsherieHome 默认目标：${safeText(policy.default_old_history_bridge_target, 'asheriehome_cold_tree_node')}
- 默认写入温层：${policy.write_warm_memory_by_default === false ? '否' : '未声明'}
- Notion 试运行索引：\`ready_for_cold_archive\` 进稳定冷仓；\`usable_with_sampling\` 只进 sampling 候选索引，不进默认首页；\`needs_review\` 留复核库。

## 本批数量

- 记忆候选：${Number(counts.memory_candidates || 0)}
- AsherieHome 轻冷树节点：${Number(counts.asheriehome_memory_nodes || 0)}
- 关系根候选：${Number(counts.root_candidates || 0)}
- 关系边候选：${Number(counts.tree_edge_candidates || 0)}
- 原文回溯主链：${Number(counts.source_trace_index || 0)}
- 原文回溯候选：${Number(counts.source_trace_candidates || 0)}
- 原文范围候选：${Number(counts.source_span_candidates || 0)}
- Notion Asherie stable 投影：${Number(bundle?.manifest?.counts?.notion_asherie_stable_projection || 0)}
- 可先进入冷归档：${Number(counts.ready_for_cold_archive || 0)}
- 需要复核：${Number(counts.needs_review || 0)}

## v0.4 冻结前收口

- root kind 修正：${Number(delta.root_kind_correction_count || 0)}
- relation lane 合并：${Number(delta.relation_lane_merge_count || 0)}
- 重复标题修正：${Number(delta.duplicate_title_correction_count || 0)}
- 机器标题清洗：${Number(delta.machine_title_cleaned_count || 0)}
- source span parent 拆分：${Number(delta.source_span_parent_split_count || 0)}
- source child span：${Number(delta.source_span_child_count || 0)}
- Asherie 结构槽完整：${Number(delta.asherie_structured_slot_complete_count || 0)}
- Asherie 折叠近邻节点：${Number(delta.asherie_folded_duplicate_node_count || 0)}
- Asherie 短 living fragment：${Number(delta.asherie_short_living_fragment_count || 0)}
- 空壳摘要残留：${Number(delta.human_summary_shell_count || 0)}
- 稳定冷仓空壳摘要残留：${Number(delta.stable_human_summary_shell_count || 0)}
- ready 语言显性瑕疵：${Number(delta.ready_language_glitch_count || 0)}
- usable 层机器痕迹残留：${Number(delta.usable_machine_residue_count || 0)}

## 质量评测口径

请重点判断：

- \`23_asheriehome_memory_nodes.jsonl\` 里的 \`living_fragment\` / \`feeling_as_fact\` 是否还像记忆，不只是信息结论。
- \`structured_slots\` 是否把 subject / lane / object / inner_view / emotional_stance 拆清楚，且没有把感受当成可丢弃装饰。
- \`tree_growth.merge_role\` 是否合理：同线近邻应折到 canonical node，不该在入库前变成一堆重复主卡。
- \`node_path\` 是否能形成“人物 / 关系或爱好 / 具体锚点”的轻冷树挂载。
- \`human_summary\` 是否适合人类默认阅读，\`compact_recall_text\` 只作为兼容字段，不再是主召回正文。
- \`raw_machine_fact\`、\`title_normalization\`、source refs 分层字段是隐藏机读层，不应作为 Notion 人类默认页评价。
- 是否有明显重复、幻觉、关系误挂、语气机器化。
- 是否保留了足够的关系位置，例如角色、关系线、剧情线、世界规则。
- \`source_trace_count\` 是否足以支持必要回溯；需要时先查 child span / source trace，不要默认把原文塞给前台角色。

请不要把隐藏机读字段当作人类阅读体验来评价。隐藏字段服务同步、召回、冲突处理和回溯索引。

## 建议输出

请给出：

1. 这批旧记忆能否作为 Notion 冷记忆层试运行。
2. 哪几类卡最容易重复或机器化。
3. 哪些关系根 / 关系边看起来可能误挂。
4. 是否可以进入 Bridge 冷树候选测试。
5. 不建议写入温层的理由是否充分。
`;
}

export async function exportNotionMemoryCoreBundle({
  monthHints = [],
  rootDir = '',
  overwrite = true
} = {}) {
  const bundle = await buildNotionMemoryCoreBundle({ monthHints });
  const monthSlug = uniqueStrings((Array.isArray(monthHints) ? monthHints : []).map((item) => normalizeMonthHint(item)).filter(Boolean), 24).join('_') || 'all';
  const baseRoot = safeText(rootDir, DEFAULT_NOTION_STAGING_ROOT);
  const exportDir = join(baseRoot, safeScopeSegment(`ajimem__${monthSlug}`, 'ajimem__all'));
  if (overwrite) {
    await rm(exportDir, { recursive: true, force: true });
  }
  await mkdir(exportDir, { recursive: true });
  const files = [
    ['00_manifest.json', bundle.manifest],
    ['01_memory_entries.json', bundle.memory_entries],
    ['02_source_topics.json', bundle.source_topics],
    ['03_persona_workspace_snapshot.json', bundle.persona_workspace],
    ['04_sample_memory_entries.json', buildSampleMemoryEntries(bundle.memory_entries, 12)],
    ['05_relation_roots.json', bundle.relation_roots],
    ['06_relation_vines.json', bundle.relation_vines],
    ['07_story_timeline.json', bundle.story_timeline],
    ['08_source_trace_warehouse.json', bundle.source_trace_warehouse],
    ['09_quality_report.json', bundle.quality_report],
    ['10_recall_preview_packets.json', bundle.recall_preview_packets],
    ['11_notion_review_cards.json', bundle.notion_review_cards],
    ['12_normalized_memory_candidates.jsonl', bundle.normalized_memory_candidates, 'jsonl'],
    ['13_normalized_relation_root_candidates.jsonl', bundle.normalized_relation_root_candidates, 'jsonl'],
    ['14_normalized_tree_edge_candidates.jsonl', bundle.normalized_tree_edge_candidates, 'jsonl'],
    ['15_normalized_source_trace_candidates.jsonl', bundle.normalized_source_trace_candidates, 'jsonl'],
    ['16_normalized_source_span_candidates.jsonl', bundle.normalized_source_span_candidates, 'jsonl'],
    ['17_interop_summary.json', bundle.interop_summary],
    ['18_chatgpt_review_guide.md', buildChatgptReviewGuide(bundle), 'text'],
    ['19_notion_stable_import.jsonl', bundle.notion_stable_import, 'jsonl'],
    ['20_notion_sampling_import.jsonl', bundle.notion_sampling_import, 'jsonl'],
    ['21_notion_review_queue.jsonl', bundle.notion_review_queue, 'jsonl'],
    ['22_bridge_candidate_graph.jsonl', bundle.bridge_candidate_graph, 'jsonl'],
    ['23_asheriehome_memory_nodes.jsonl', bundle.asheriehome_memory_nodes, 'jsonl'],
    ['24_source_trace_index.jsonl', bundle.source_trace_index, 'jsonl'],
    ['25_notion_asherie_stable_projection.jsonl', bundle.notion_asherie_stable_projection, 'jsonl'],
    ['26_notion_asherie_sampling_projection.jsonl', bundle.notion_asherie_sampling_projection, 'jsonl'],
    ['27_notion_asherie_review_projection.jsonl', bundle.notion_asherie_review_projection, 'jsonl']
  ];
  const written = [];
  for (const [name, payload, format] of files) {
    const filePath = join(exportDir, name);
    const body = format === 'jsonl'
      ? stringifyJsonl(payload)
      : format === 'text'
        ? `${String(payload || '').trim()}\n`
        : `${JSON.stringify(payload, null, 2)}\n`;
    await writeFile(filePath, body, 'utf8');
    written.push({
      name,
      path: filePath
    });
  }
  return {
    ok: true,
    export_dir: exportDir,
    files: written,
    summary: bundle.manifest.counts
  };
}
