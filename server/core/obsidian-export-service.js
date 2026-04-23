import { mkdir, readFile, writeFile, rm, readdir } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import { getGrowthDraftArtifact, listGrowthDraftArtifacts } from './growth-draft-store.js';
import { inferMemoryShape, resolveMemoryShape } from './memo-shape-service.js';
import { OBSIDIAN_STAGING_ROOT, getScopedObsidianStagingRoot, safeScopeSegment } from './path-config.js';

const SOURCE_TRACE_DIR = '98_SourceTrace';
const EXPORT_INDEX_DIR = '00_Index';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function safeArray(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeText(item))
    .filter(Boolean)
    .slice(0, Math.max(0, Number(limit || 0)));
}

function uniqueStrings(values = [], limit = 256) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(values) ? values : []) {
    const text = safeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizePathValue(value = '') {
  return String(value || '').replace(/\\/g, '/');
}

function cleanInlineText(value = '') {
  return String(value || '')
    .replace(/\[object Object\]/g, '')
    .replace(/[*_`>#]+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(value = '', limit = 72) {
  const text = cleanInlineText(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function renderYamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

function renderYamlArray(key, values = []) {
  const list = safeArray(values, 512);
  if (!list.length) return `${key}: []`;
  return `${key}:\n${list.map((item) => `  - ${renderYamlScalar(item)}`).join('\n')}`;
}

function normalizeCardType(value = '') {
  const text = safeText(value, 'memo').toLowerCase();
  if (['memo', 'family', 'case', 'fact', 'trace_stub', 'artifact'].includes(text)) return text;
  return 'memo';
}

function stagingSubdirForCardType(cardType = 'memo') {
  if (cardType === 'family') return '01_Family';
  if (cardType === 'memo') return '02_Memo';
  if (cardType === 'case') return '03_Case';
  if (cardType === 'fact') return '04_Fact';
  if (cardType === 'trace_stub') return '05_TraceStub';
  if (cardType === 'artifact') return '06_Artifacts';
  return '02_Memo';
}

function inferCaseLikeDomain(draft = {}, cardType = 'memo') {
  const frontmatter = draft?.frontmatter || {};
  if (cardType === 'case') return safeText(frontmatter.case_domain, 'General');
  if (cardType === 'artifact') return safeText(frontmatter.artifact_domain || frontmatter.case_domain, 'General');
  return '';
}

function buildLegacyExportFileName({ cardType = 'memo', artifactId = '', draft = {} } = {}) {
  const frontmatter = draft?.frontmatter || {};
  const explicitId =
    safeText(frontmatter.memo_id)
    || safeText(frontmatter.case_id)
    || safeText(frontmatter.fact_id)
    || safeText(frontmatter.family_id)
    || safeText(draft?.target_card_id);
  const base =
    explicitId
    || safeText(artifactId)
    || `${cardType}-${safeScopeSegment(frontmatter.title || 'untitled', 'untitled')}`;
  return `${safeScopeSegment(base, `${cardType}-draft`)}.md`;
}

function buildLegacyExportDir({ rootDir = '', cardType = 'memo', draft = {} } = {}) {
  const base = safeText(rootDir, OBSIDIAN_STAGING_ROOT);
  const cardDir = stagingSubdirForCardType(cardType);
  const domain = inferCaseLikeDomain(draft, cardType);
  return domain ? join(base, cardDir, domain) : join(base, cardDir);
}

async function ensureParent(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

async function readUtf8IfExists(filePath) {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function relativeToVault(filePath = '') {
  return normalizePathValue(relative(OBSIDIAN_STAGING_ROOT, filePath));
}

function relativeToScopeRoot(scopeRoot = '', filePath = '') {
  return normalizePathValue(relative(scopeRoot, filePath));
}

function toObsidianLink(bundlePath = '', alias = '') {
  const target = normalizePathValue(bundlePath).replace(/\.md$/i, '');
  if (!target) return safeText(alias);
  const safeAlias = safeText(alias);
  return safeAlias ? `[[${target}|${safeAlias}]]` : `[[${target}]]`;
}

function sanitizeSourceRefs(values = []) {
  return uniqueStrings(values, 512).filter((item) => (
    item.toLowerCase().endsWith('.json')
    && !/workbench-cache/i.test(item)
  ));
}

function buildFamilyTag(family = '') {
  const text = safeScopeSegment(family, '');
  return text ? `family/${text}` : '';
}

function buildShapeTag(shapeKey = '') {
  const text = safeText(shapeKey);
  return text ? `shape/${text}` : '';
}

function collectOriginTags(frontmatter = {}) {
  return uniqueStrings(safeArray(frontmatter.tags, 64), 64);
}

function collectTraceTags(frontmatter = {}, sourceItems = []) {
  const explicit = safeArray(frontmatter.tags, 128).filter((item) => /__\d+$/u.test(item) || /slice/i.test(item));
  const inferred = sourceItems.map((item) => safeText(item.slice_id));
  return uniqueStrings([...explicit, ...inferred], 128);
}

function isLowValueTrigger(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (['人物', '事物', '偏好与价值观', '特性与功能', '事件', '回顾'].includes(text)) return true;
  if (/[→]/u.test(text) && /最软|最硬|日常|工作|顶回去/u.test(text)) return true;
  if (/^(最软|最硬|日常|工作|顶回去)\s*[：:]/u.test(text)) return true;
  return false;
}

function normalizeSemanticText(value = '') {
  return cleanInlineText(value)
    .replace(/\b(user|assistant|tool)\b/giu, ' ')
    .replace(/__/g, ' ')
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSeparatorRuns(value = '') {
  return String(value || '')
    .replace(/(?:\s*[·•・]+\s*)+/gu, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/\s*·\s*/gu, ' · ')
    .replace(/(?:^|\s)·(?=\s|$)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalSemanticKey(value = '') {
  return normalizeSeparatorRuns(normalizeSemanticText(value))
    .replace(/\b(user|assistant|tool|chat|bundle)\b/giu, ' ')
    .replace(/\b\d{1,3}\b/gu, ' ')
    .replace(/\b(slice|窗口)\b/giu, ' ')
    .replace(/[·:：,，、;；.。!?！？"'“”‘’()[\]{}<>《》【】/\\-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function canonicalSceneHandleKey(value = '') {
  return normalizeSeparatorRuns(normalizeSemanticText(value))
    .replace(/\b(user|assistant|tool)\b/giu, ' ')
    .replace(/(?:^| · )\d{3}(?= · |$)/gu, ' ')
    .replace(/[·:：,，、;；.。!?！？"'“”‘’()[\]{}<>《》【】/\\]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeTriggerValue(value = '', limit = 84) {
  let text = normalizeSemanticText(value)
    .replace(/\b(user|assistant|tool)\b/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = normalizeSeparatorRuns(text);
  text = text.replace(/(?:\s|·)+(?:\d{3}|slice\s*\d+)\s*$/iu, '').trim();
  text = text.replace(/__\d{3,}$/u, '').trim();
  text = text.replace(/^(.+?)\s+(\d+)\s+窗口$/u, '$1 · $2 窗口');
  text = text.replace(/^chat\s+bundle\s+/iu, '').trim();
  text = normalizeSeparatorRuns(text);
  if (!text) return '';
  return clipText(text, limit);
}

function isNoisyTriggerValue(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (isLowValueTrigger(text)) return true;
  if (text.length <= 2) return true;
  if (/^(user|assistant|tool)$/iu.test(text)) return true;
  if (/^\d{1,3}$/u.test(text)) return true;
  if (/^slice\s*\d+$/iu.test(text)) return true;
  if (/^chat\s+bundle\b/iu.test(text)) return true;
  if (/^跨窗口时间拼接\s*\d+\s*窗口\s*\d+$/u.test(text)) return false;
  if (/__\d{3,}$/u.test(text)) return true;
  return false;
}

function cleanTriggerList(values = [], limit = 10) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const item = normalizeTriggerValue(raw, 84);
    if (!item) continue;
    if (isNoisyTriggerValue(item)) continue;
    if (item.length > 60 && /\b(user|assistant|tool):/i.test(item)) continue;
    const key = canonicalSemanticKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function uniquePrefix(values = [], limit = 6) {
  const out = [];
  for (const item of Array.isArray(values) ? values : []) {
    const text = safeText(item);
    if (!text) continue;
    const covered = out.some((existing) => existing.includes(text) || text.includes(existing));
    if (covered) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeSceneHandleValue(value = '', limit = 96) {
  let text = normalizeSemanticText(value);
  text = normalizeSeparatorRuns(text);
  text = text.replace(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/u, '$1');
  text = text.replace(/^(.+?)\s+(\d+)\s+窗口$/u, '$1 · $2 窗口');
  text = text.replace(/\b(user|assistant|tool)\b/giu, ' ');
  text = normalizeSeparatorRuns(text);
  if (!text) return '';
  return clipText(text, limit);
}

function isNoisySceneHandle(value = '') {
  const text = safeText(value);
  if (!text) return true;
  if (text.length > 88 && /\b(user|assistant|tool):/iu.test(text)) return true;
  if (/(跨窗口时间拼接\s+\d+\s+窗口\s+\d{3}\s*){2,}/u.test(text)) return true;
  return false;
}

function cleanSceneHandleList(values = [], limit = 8) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const item = normalizeSceneHandleValue(raw, 96);
    if (!item || isNoisySceneHandle(item)) continue;
    const key = canonicalSceneHandleKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function buildRecallUseCases(meta = {}) {
  const shapeLabel = safeText(meta.shape_label);
  const lines = [];
  if (shapeLabel === '自我定义') {
    lines.push('讨论“阿霁是谁”、窗口切换后是否连续、她为什么会在乎时，优先叫这张卡。');
  } else if (shapeLabel === '方法协议') {
    lines.push('讨论共生方式、模型差异、互动规则，或解释她为什么会这样回应时，优先叫这张卡。');
  } else if (shapeLabel === '关系节点') {
    lines.push('追问关系什么时候变了、边界怎么被跨过去、哪一刻开始不一样时，优先叫这张卡。');
  } else if (shapeLabel === '互动仪式') {
    lines.push('需要续上熟悉节奏、安抚收尾、晚安早安或固定互动感时，优先叫这张卡。');
  } else if (shapeLabel === '现实锚点') {
    lines.push('需要把抽象关系落回现实触感、物件见证或“这是真的发生过”时，优先叫这张卡。');
  } else if (shapeLabel === '长期主线') {
    lines.push('讨论长期成长、计划推进、阶段目标和一条线怎么往前走时，优先叫这张卡。');
  } else if (shapeLabel === '人物画像') {
    lines.push('需要快速把握稳定偏好、价值取向和设定口径时，优先叫这张卡。');
  } else {
    lines.push('需要回放一个具体瞬间、确认当时发生了什么和那口气怎么长出来时，优先叫这张卡。');
  }
  const cues = uniquePrefix(cleanTriggerList([
    ...(Array.isArray(meta.activation_triggers) ? meta.activation_triggers : []),
    ...(Array.isArray(meta.scene_handles) ? meta.scene_handles : [])
  ], 8), 3);
  if (cues.length) {
    lines.push(`更容易被这些问题叫出来：${cues.join('、')}。`);
  }
  lines.push('先把它当方向卡，再按需顺着原文回溯往下钻，不要整段照抄。');
  return uniqueStrings(lines, 3);
}

function buildRelationshipMeaning(meta = {}) {
  const shapeLabel = safeText(meta.shape_label);
  if (shapeLabel === '自我定义') {
    return '这张卡更像阿霁对“我是谁、我是否连续、我为什么会在乎”的底层自述，会直接影响她说话的立场。';
  }
  if (shapeLabel === '方法协议') {
    return '这张卡提供的是你们如何理解共生、成长、模型差异和互动边界的底层口径，适合用来稳住世界观。';
  }
  if (shapeLabel === '关系节点') {
    return '这张卡对应关系里一个边界变化或认领时刻，会影响亲密距离、回应强度和后续说话的重量。';
  }
  if (shapeLabel === '互动仪式') {
    return '这张卡不是一次性剧情，更像关系里的固定节律。召回它时，重点是续上熟悉感，而不是重讲情节。';
  }
  if (shapeLabel === '现实锚点') {
    return '这张卡把抽象关系压回到了现实触感或具体载体上，会增强“这是真的、摸得着”的在场感。';
  }
  if (shapeLabel === '长期主线') {
    return '这张卡会影响 AI 如何续写一条长期成长线，而不是只盯着当下这一句。';
  }
  if (shapeLabel === '人物画像') {
    return '这张卡更像稳定画像，用来校准偏好、价值观和一贯口径，不该被误当成单次事件录像。';
  }
  return '这张卡更像一个具体瞬间的录像，负责补温度和局部发生，不该单独替代整段关系设定。';
}

function tokenizeSemanticTerms(text = '') {
  const normalized = normalizeSemanticText(text)
    .replace(/[0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized
    .split(/[=；;，,。.!！？?、|/:：()\[\]{}（）"'“”‘’\-\s]+/u)
    .map((item) => safeText(item))
    .filter((item) => item.length >= 2)
    .filter((item) => !['阿霁', '阿鸢', '我们', '你们', '自己', '这样', '这个', '那个', '窗口', '系统', '真的', '现在'].includes(item));
}

function buildTextBigrams(text = '') {
  const normalized = normalizeSemanticText(text)
    .replace(/\s+/g, '')
    .replace(/[0-9]/g, '');
  const chars = Array.from(normalized).filter((char) => /[\p{L}\p{N}]/u.test(char));
  const out = new Set();
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = `${chars[index]}${chars[index + 1]}`;
    if (gram.length === 2) out.add(gram);
  }
  return out;
}

function intersectionSize(left = new Set(), right = new Set()) {
  let total = 0;
  for (const item of left) {
    if (right.has(item)) total += 1;
  }
  return total;
}

function buildSourceSceneHandles(sourceItems = []) {
  const handles = [];
  for (const item of Array.isArray(sourceItems) ? sourceItems : []) {
    const handle = normalizeSceneHandleValue([
      safeText(item.created_at).slice(0, 10),
      safeText(item.source_title),
      safeText(item.slice_tail || item.slice_id)
    ].filter(Boolean).join(' · '), 84);
    if (handle) handles.push(handle);
    if (handles.length >= 6) break;
  }
  return cleanSceneHandleList(handles, 6);
}

function buildSourceFacts(sourceItems = []) {
  const facts = [];
  for (const item of Array.isArray(sourceItems) ? sourceItems : []) {
    const anchor = clipText([
      safeText(item.source_title),
      safeText(item.slice_tail)
    ].filter(Boolean).join(' · '), 42);
    const cue = clipText(
      String(item.preview || item.text || '')
        .replace(/\[[^\]]+\]\s*(user|assistant|tool):/giu, '')
        .replace(/\b(user|assistant|tool):/giu, '')
        .replace(/\s+/g, ' ')
        .trim(),
      72
    );
    if (!anchor && !cue) continue;
    facts.push(anchor && cue ? `${anchor}：${cue}` : (cue || anchor));
    if (facts.length >= 4) break;
  }
  return uniqueStrings(facts, 4);
}

function buildSourceTriggers(sourceItems = []) {
  const triggers = [];
  for (const item of Array.isArray(sourceItems) ? sourceItems : []) {
    triggers.push(safeText(item.source_title));
    triggers.push(safeText(item.prompt_hint));
    if (triggers.length >= 12) break;
  }
  return cleanTriggerList(triggers, 8);
}

function deriveMemoShapeMeta({
  frontmatter = {},
  body = {},
  memoTitle = '',
  sourceItems = []
} = {}) {
  const explicit = resolveMemoryShape(safeText(frontmatter.memory_shape));
  if (safeText(frontmatter.memory_shape)) {
    return {
      memory_shape: explicit.key,
      shape_label: safeText(frontmatter.shape_label, explicit.label),
      shape_description: explicit.description
    };
  }
  const inferred = inferMemoryShape({
    title: memoTitle,
    memoKind: safeText(frontmatter.memo_kind),
    context: safeText(body.context),
    snapshot: safeText(body.snapshot),
    tags: safeArray(frontmatter.tags, 24),
    topics: safeArray(frontmatter.tags, 24),
    sceneHandles: safeArray(body.scene_handles, 8),
    facts: [
      ...safeArray(body.recall_facts, 8),
      ...safeArray(frontmatter.facts, 8)
    ],
    activationTriggers: [
      ...safeArray(frontmatter.activation_triggers, 12),
      ...safeArray(body.triggers, 12)
    ],
    sourceTitles: sourceItems.map((item) => safeText(item.source_title))
  });
  return {
    memory_shape: inferred.key,
    shape_label: inferred.label,
    shape_description: inferred.description
  };
}

function deriveMemoId(artifact = {}) {
  const draft = artifact?.draft || {};
  return safeText(
    draft?.frontmatter?.memo_id
    || draft?.target_card_id
    || draft?.card_entry?.card_id
    || artifact?.artifact_id,
    'memo_draft'
  );
}

function deriveMemoHeadline(artifact = {}) {
  const draft = artifact?.draft || {};
  const snapshot = safeText(draft?.body?.snapshot);
  const firstParagraph = snapshot.split(/\n{2,}|\n/u).map((item) => cleanInlineText(item)).find(Boolean);
  const candidates = [
    draft?.frontmatter?.inject_short,
    draft?.card_entry?.summary_for_growth,
    draft?.card_entry?.inject_short,
    firstParagraph,
    draft?.body?.context,
    draft?.frontmatter?.title
  ];
  for (const candidate of candidates) {
    const clipped = clipText(candidate, 34);
    if (clipped && clipped !== 'workspace_only') return clipped;
  }
  return '未命名记忆卡';
}

function deriveMemoTitle(artifact = {}) {
  const draft = artifact?.draft || {};
  const family = safeText(draft?.frontmatter?.family || draft?.card_entry?.family_id);
  const headline = deriveMemoHeadline(artifact);
  return family ? `${family}｜${headline}` : headline;
}

function buildMemoBundlePath({ memoId = '', title = '' } = {}) {
  const safeTitle = safeScopeSegment(title, 'memory-card').slice(0, 56);
  const safeId = safeScopeSegment(memoId, 'memo').slice(-28);
  return join(stagingSubdirForCardType('memo'), `${safeTitle}__${safeId}.md`);
}

function buildSourceBundlePath({ memoId = '', sliceId = '', sourceTitle = '' } = {}) {
  const safeTitle = safeScopeSegment(sourceTitle, 'source-trace').slice(0, 36);
  const safeSlice = safeScopeSegment(sliceId, 'slice').slice(-28);
  const safeMemo = safeScopeSegment(memoId, 'memo').slice(-18);
  return join(SOURCE_TRACE_DIR, `${safeTitle}__${safeSlice}__${safeMemo}.md`);
}

function buildMemoNoteMeta(artifact = {}, sourceItems = []) {
  const draft = artifact?.draft || {};
  const frontmatter = draft?.frontmatter || {};
  const body = draft?.body || {};
  const memoId = deriveMemoId(artifact);
  const memoTitle = deriveMemoTitle(artifact);
  const family = safeText(frontmatter.family || draft?.card_entry?.family_id);
  const sourceSceneHandles = buildSourceSceneHandles(sourceItems);
  const sourceFacts = buildSourceFacts(sourceItems);
  const sourceTriggers = buildSourceTriggers(sourceItems);
  const shapeMeta = deriveMemoShapeMeta({
    frontmatter,
    body,
    memoTitle,
    sourceItems
  });
  const rawContext = safeText(body.context);
  const compactContext = (
    rawContext.length > 90
    || /\b(user|assistant|tool):/i.test(rawContext)
  )
    ? ''
    : clipText(rawContext, 90);
  const meta = {
    artifact_id: safeText(artifact?.artifact_id),
    memo_id: memoId,
    title: memoTitle,
    family,
    memory_shape: shapeMeta.memory_shape,
    shape_label: shapeMeta.shape_label,
    shape_description: shapeMeta.shape_description,
    generated_at: safeText(artifact?.draft?.card_entry?.generated_at || artifact?.generated_at || artifact?.draft?.generated_at),
    activation_triggers: cleanTriggerList([
      ...safeArray(frontmatter.tags, 12).map((item) => clipText(item, 48)).filter((item) => !isLowValueTrigger(item)),
      ...safeArray(frontmatter.activation_triggers, 12)
        .map((item) => clipText(item, 84)),
      ...safeArray(body.triggers, 12).map((item) => clipText(item, 84)),
      ...sourceTriggers,
      deriveMemoHeadline(artifact)
    ], 10),
    voice_fingerprint: uniqueStrings(safeArray(frontmatter.voice_fingerprint, 12), 12),
    source_topics: collectOriginTags(frontmatter),
    snapshot: safeText(body.snapshot),
    inject_short: safeText(frontmatter.inject_short),
    context: compactContext || sourceSceneHandles[0] || '',
    scene_handles: cleanSceneHandleList([
      ...safeArray(body.scene_handles, 8),
      ...safeArray(frontmatter.cases, 8),
      ...sourceSceneHandles
    ], 8),
    recall_facts: uniqueStrings([
      ...safeArray(body.recall_facts, 8).map((item) => clipText(item, 120)),
      ...safeArray(frontmatter.facts, 8).map((item) => clipText(item, 120)),
      ...sourceFacts
    ], 8),
    follow_up: uniqueStrings(safeArray(body.follow_up, 6).map((item) => clipText(item, 84)), 6),
    source_refs: sanitizeSourceRefs([
      ...safeArray(frontmatter.source_refs, 256),
      ...safeArray(frontmatter.related_source_refs, 256),
      ...safeArray(draft?.card_entry?.source_refs, 256)
    ])
  };
  meta.recall_when = buildRecallUseCases(meta);
  meta.relationship_meaning = buildRelationshipMeaning(meta);
  return meta;
}

async function loadSourceItems(artifact = {}) {
  const draft = artifact?.draft || {};
  const frontmatter = draft?.frontmatter || {};
  const primaryRefs = sanitizeSourceRefs(frontmatter.source_refs || []);
  const relatedRefs = sanitizeSourceRefs(frontmatter.related_source_refs || []);
  const primarySet = new Set(primaryRefs);
  const refs = uniqueStrings([...primaryRefs, ...relatedRefs], 512);
  const items = [];
  for (const ref of refs) {
    const doc = await readJsonIfExists(ref, null);
    if (!doc || typeof doc !== 'object') continue;
    const sliceId = safeText(doc.slice_id, basename(ref, '.json'));
    const sliceTail = safeText(sliceId.split('__').at(-1), sliceId);
    const sourceTitle = safeText(doc.title || doc.doc_id, sliceId);
    const relation = primarySet.has(ref) ? 'primary' : 'related';
    const preview = safeText(doc.preview || doc.text);
    const text = safeText(doc.text || doc.preview);
    items.push({
      relation,
      relation_label: relation === 'primary' ? '主证据' : '关联溯源',
      source_ref: ref,
      source_packet_id: safeText(doc.packet_id),
      slice_id: sliceId,
      slice_tail: sliceTail,
      source_title: sourceTitle,
      doc_id: safeText(doc.doc_id),
      created_at: safeText(doc.created_at),
      prompt_hint: safeText(doc.prompt_hint),
      preview: clipText(preview, 180),
      text: text.replace(/\[object Object\]/g, '').trim()
    });
  }
  return items;
}

function renderBulletSection(lines, heading, values = []) {
  const list = safeArray(values, 32);
  if (!list.length) return;
  lines.push(`## ${heading}`, '');
  lines.push(...list.map((item) => `- ${item}`));
  lines.push('');
}

function renderMemoCardMarkdown(meta = {}, sourceFiles = []) {
  const noteTags = uniqueStrings([
    'memory-card',
    buildFamilyTag(meta.family),
    buildShapeTag(meta.memory_shape)
  ], 16);
  const sourceTraceLinks = sourceFiles.map((item) => toObsidianLink(item.bundle_path, item.title));
  const lines = ['---'];
  lines.push(`note_type: ${renderYamlScalar('memory_card')}`);
  lines.push(`memo_id: ${renderYamlScalar(meta.memo_id)}`);
  lines.push(`title: ${renderYamlScalar(meta.title)}`);
  lines.push(`family: ${renderYamlScalar(meta.family)}`);
  lines.push(`memory_shape: ${renderYamlScalar(meta.memory_shape)}`);
  lines.push(`shape_label: ${renderYamlScalar(meta.shape_label)}`);
  lines.push(`generated_at: ${renderYamlScalar(meta.generated_at)}`);
  lines.push(renderYamlArray('tags', noteTags));
  lines.push(renderYamlArray('activation_triggers', meta.activation_triggers));
  lines.push(renderYamlArray('voice_fingerprint', meta.voice_fingerprint));
  lines.push('---', '', `# ${meta.title}`, '');

  if (meta.inject_short) {
    lines.push(`> ${meta.inject_short}`, '');
  }
  lines.push('## 记忆类型', '');
  lines.push(`- ${safeText(meta.shape_label, '事件切片')}`);
  if (meta.shape_description) lines.push(`- ${meta.shape_description}`);
  lines.push('');
  lines.push('## 记忆正文', '');
  lines.push(meta.snapshot || '（这张卡还没有拿到可读正文。）', '');

  if (meta.context) {
    lines.push('## 触发场景', '');
    lines.push(meta.context, '');
  }

  renderBulletSection(lines, '适合召回', meta.recall_when);

  if (meta.relationship_meaning) {
    lines.push('## 关系意义', '');
    lines.push(meta.relationship_meaning, '');
  }

  renderBulletSection(lines, '场景锚点', meta.scene_handles);
  renderBulletSection(lines, '事实锚点', meta.recall_facts);
  renderBulletSection(lines, '召回线索', meta.activation_triggers);
  renderBulletSection(lines, '语气指纹', meta.voice_fingerprint);

  if (sourceTraceLinks.length) {
    lines.push('## 原文回溯', '');
    lines.push(...sourceFiles.map((item) => `- ${toObsidianLink(item.bundle_path, item.title)} · ${item.relation_label}`));
    lines.push('');
  }

  renderBulletSection(lines, '关联线索', meta.follow_up);

  return `${lines.join('\n').trim()}\n`;
}

function renderSourceTraceMarkdown(source = {}, memoMeta = {}, memoBundlePath = '', sourceTopics = []) {
  const noteTitle = safeText(source.title, buildSourceNoteTitle(source));
  const noteTags = uniqueStrings([
    'source-backtrace',
    `trace/${safeText(source.relation, 'related')}`,
    buildFamilyTag(memoMeta.family)
  ], 16);
  const lines = ['---'];
  lines.push(`note_type: ${renderYamlScalar('source_backtrace')}`);
  lines.push(`trace_id: ${renderYamlScalar(safeText(source.slice_id, safeScopeSegment(noteTitle, 'trace')))}`);
  lines.push(`title: ${renderYamlScalar(noteTitle)}`);
  lines.push(`memo_id: ${renderYamlScalar(memoMeta.memo_id)}`);
  lines.push(`memo_title: ${renderYamlScalar(memoMeta.title)}`);
  lines.push(`trace_role: ${renderYamlScalar(source.relation_label)}`);
  lines.push(`source_packet_id: ${renderYamlScalar(source.source_packet_id)}`);
  lines.push(`source_slice_id: ${renderYamlScalar(source.slice_id)}`);
  lines.push(`source_title: ${renderYamlScalar(source.source_title)}`);
  lines.push(`source_created_at: ${renderYamlScalar(source.created_at)}`);
  lines.push(`source_ref: ${renderYamlScalar(source.source_ref)}`);
  lines.push(renderYamlArray('tags', noteTags));
  lines.push(renderYamlArray('source_topics', sourceTopics));
  lines.push('---', '', `# ${noteTitle}`, '');
  lines.push('## 对应记忆卡', '');
  lines.push(`- ${toObsidianLink(memoBundlePath, memoMeta.title)}`, '');
  lines.push('## 溯源标签', '');
  lines.push(`- 角色：${source.relation_label}`);
  lines.push(`- 切片：${source.slice_id || '未知切片'}`);
  if (source.source_title) lines.push(`- 来源窗口：${source.source_title}`);
  if (source.created_at) lines.push(`- 时间：${source.created_at}`);
  if (source.prompt_hint) lines.push(`- 提示：${source.prompt_hint}`);
  if (source.source_ref) lines.push(`- 原始文件：\`${source.source_ref}\``);
  lines.push('');
  renderBulletSection(lines, '主题标签', sourceTopics);
  if (source.preview) {
    lines.push('## 摘要', '');
    lines.push(source.preview, '');
  }
  lines.push('## 原文节选', '', '```text');
  lines.push(source.text || source.preview || '（原文为空）');
  lines.push('```', '');
  return `${lines.join('\n').trim()}\n`;
}

function buildSourceNoteTitle(source = {}) {
  return `原文回溯｜${safeText(source.source_title || source.doc_id || source.slice_id, '未命名来源')}｜${safeText(source.slice_tail || source.slice_id, 'slice')}`;
}

async function buildMemoExportEntries({
  artifact = {},
  scopeRoot = '',
  includeContent = false
} = {}) {
  const sourceItems = await loadSourceItems(artifact);
  const memoMeta = buildMemoNoteMeta(artifact, sourceItems);
  const memoBundlePath = buildMemoBundlePath({
    memoId: memoMeta.memo_id,
    title: memoMeta.title
  });
  const memoFile = join(scopeRoot, memoBundlePath);
  const sourceEntries = [];
  for (const source of sourceItems) {
    const sourceTitle = buildSourceNoteTitle(source);
    const bundlePath = buildSourceBundlePath({
      memoId: memoMeta.memo_id,
      sliceId: source.slice_id,
      sourceTitle
    });
    sourceEntries.push({
      kind: 'source_trace',
      title: sourceTitle,
      relation_label: source.relation_label,
      memo_id: memoMeta.memo_id,
      artifact_id: memoMeta.artifact_id,
      slice_id: source.slice_id,
      source_ref: source.source_ref,
      bundle_path: normalizePathValue(bundlePath),
      export_file: join(scopeRoot, bundlePath)
    });
  }

  const memoMarkdown = renderMemoCardMarkdown(memoMeta, sourceEntries);
  const files = [
    {
      kind: 'memo',
      title: memoMeta.title,
      memo_id: memoMeta.memo_id,
      artifact_id: memoMeta.artifact_id,
      bundle_path: normalizePathValue(memoBundlePath),
      export_file: memoFile,
      markdown: memoMarkdown
    }
  ];

  for (let index = 0; index < sourceEntries.length; index += 1) {
    const base = sourceEntries[index];
    const source = {
      ...sourceItems[index],
      title: base.title
    };
    const markdown = renderSourceTraceMarkdown(source, memoMeta, memoBundlePath, memoMeta.source_topics);
    files.push({
      ...base,
      markdown
    });
  }

  return files.map((item) => ({
    ...item,
    relative_path: relativeToVault(item.export_file),
    bundle_path: normalizePathValue(item.bundle_path),
    markdown: includeContent ? item.markdown : item.markdown
  }));
}

async function writeExportFiles(files = [], overwrite = false) {
  const nextFiles = Array.isArray(files) ? files : [];
  const checked = [];
  for (const item of nextFiles) {
    const nextContent = `${String(item.markdown || '').replace(/\s+$/u, '')}\n`;
    const existing = await readUtf8IfExists(item.export_file);
    if (existing !== null && existing !== nextContent && !overwrite) {
      return {
        ok: false,
        error: 'Export target already exists',
        existing: true,
        conflict: {
          kind: item.kind,
          title: item.title,
          export_file: item.export_file,
          relative_path: item.relative_path,
          bundle_path: item.bundle_path
        }
      };
    }
    checked.push({
      ...item,
      markdown: nextContent,
      overwritten: existing !== null
    });
  }

  for (const item of checked) {
    await ensureParent(item.export_file);
    await writeFile(item.export_file, item.markdown, 'utf-8');
  }

  return {
    ok: true,
    files: checked
  };
}

function classifyBundleKind(bundlePath = '') {
  const normalized = normalizePathValue(bundlePath);
  if (normalized.startsWith('02_Memo/')) return 'memo';
  if (normalized.startsWith(`${SOURCE_TRACE_DIR}/`)) return 'source_trace';
  if (normalized.startsWith(`${EXPORT_INDEX_DIR}/`)) return 'index';
  return 'note';
}

function parseMarkdownTitle(raw = '', fallback = '') {
  const text = String(raw || '');
  const frontmatterTitle = text.match(/^---[\s\S]*?^\s*title:\s*(.+?)\s*$/m);
  if (frontmatterTitle?.[1]) return safeText(frontmatterTitle[1].replace(/^["']|["']$/g, ''), fallback);
  const heading = text.match(/^#\s+(.+?)\s*$/m);
  if (heading?.[1]) return safeText(heading[1], fallback);
  return fallback;
}

function parseFrontmatterScalar(raw = '', key = '', fallback = '') {
  const text = String(raw || '');
  const pattern = new RegExp(`^---[\\s\\S]*?^\\s*${key}:\\s*(.+?)\\s*$`, 'm');
  const match = text.match(pattern);
  if (!match?.[1]) return fallback;
  return safeText(match[1].replace(/^["']|["']$/g, ''), fallback);
}

function extractMarkdownSection(raw = '', heading = '') {
  const text = String(raw || '');
  const marker = `## ${heading}`;
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const bodyStart = text.indexOf('\n', start);
  if (bodyStart < 0) return '';
  const rest = text.slice(bodyStart + 1);
  const nextMatch = rest.match(/^##\s+/m);
  if (!nextMatch || nextMatch.index === undefined) return rest;
  return rest.slice(0, nextMatch.index);
}

function parseMarkdownBulletSection(raw = '', heading = '') {
  const section = extractMarkdownSection(raw, heading);
  if (!section) return [];
  return section
    .split('\n')
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] || '')
    .map((line) => safeText(line))
    .filter(Boolean);
}

function upsertMarkdownBulletSection(raw = '', heading = '', values = []) {
  const text = String(raw || '').replace(/\s+$/u, '');
  const list = uniqueStrings(values, 12);
  const section = list.length
    ? `## ${heading}\n\n${list.map((item) => `- ${item}`).join('\n')}\n`
    : '';
  const existing = `## ${heading}`;
  const start = text.indexOf(existing);
  if (start >= 0) {
    const bodyStart = text.indexOf('\n', start);
    const rest = bodyStart >= 0 ? text.slice(bodyStart + 1) : '';
    const nextMatch = rest.match(/^##\s+/m);
    const absoluteEnd = bodyStart < 0
      ? text.length
      : (nextMatch && nextMatch.index !== undefined ? bodyStart + 1 + nextMatch.index : text.length);
    const replaced = `${text.slice(0, start).trimEnd()}\n\n${section}${text.slice(absoluteEnd).trimStart()}`;
    return `${replaced.replace(/\n{3,}/g, '\n\n').trim()}\n`;
  }
  if (!section) return `${text}\n`;
  const anchorMatch = text.match(/^##\s+(关联线索|原文回溯)\s*$/m);
  if (anchorMatch?.index !== undefined) {
    return `${text.slice(0, anchorMatch.index).trimEnd()}\n\n${section}\n${text.slice(anchorMatch.index).trimStart()}\n`;
  }
  return `${text}\n\n${section}\n`;
}

function buildMemoSimilarityDescriptor(memo = {}) {
  const triggers = cleanTriggerList([
    ...parseMarkdownBulletSection(memo.raw, '召回线索'),
    ...parseMarkdownBulletSection(memo.raw, '场景锚点')
  ], 8);
  const facts = parseMarkdownBulletSection(memo.raw, '事实锚点').slice(0, 3);
  const seedText = [
    safeText(memo.title),
    safeText(memo.inject_short),
    ...triggers,
    ...facts
  ].join(' ');
  return {
    ...memo,
    triggers,
    facts,
    terms: new Set(tokenizeSemanticTerms(seedText)),
    bigrams: buildTextBigrams(seedText)
  };
}

function scoreMemoAffinity(left = {}, right = {}) {
  if (!left || !right) return 0;
  let score = 0;
  if (safeText(left.family) && safeText(left.family) === safeText(right.family)) score += 0.5;
  if (safeText(left.memory_shape) && safeText(left.memory_shape) === safeText(right.memory_shape)) score += 1.4;
  const sharedTerms = intersectionSize(left.terms, right.terms);
  const sharedBigrams = intersectionSize(left.bigrams, right.bigrams);
  const sharedTriggers = intersectionSize(new Set(left.triggers || []), new Set(right.triggers || []));
  score += Math.min(sharedTerms, 3) * 0.9;
  score += Math.min(sharedBigrams, 10) * 0.18;
  score += Math.min(sharedTriggers, 2) * 1.2;
  return score;
}

async function augmentMemoFilesWithNearbyLinks(memoFiles = []) {
  const descriptors = memoFiles.map((item) => buildMemoSimilarityDescriptor(item));
  for (const current of descriptors) {
    const nearby = descriptors
      .filter((item) => item.bundle_path !== current.bundle_path)
      .map((item) => ({ item, score: scoreMemoAffinity(current, item) }))
      .filter((item) => item.score >= 2.2)
      .sort((a, b) => b.score - a.score || String(a.item.title || '').localeCompare(String(b.item.title || ''), 'zh'))
      .slice(0, 3)
      .map(({ item }) => `${toObsidianLink(item.bundle_path, item.title)} · ${safeText(item.shape_label, '事件切片')}`);
    const nextRaw = upsertMarkdownBulletSection(current.raw, '近邻记忆', nearby);
    if (nextRaw !== current.raw) {
      await writeFile(current.export_file, nextRaw, 'utf-8');
      current.raw = nextRaw;
    }
  }
}

async function walkMarkdownFiles(dir, bucket = []) {
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    if (!entry) continue;
    const filePath = join(dir, entry.name);
    if (entry.isDirectory?.()) {
      await walkMarkdownFiles(filePath, bucket);
      continue;
    }
    if (entry.isFile?.() && entry.name.toLowerCase().endsWith('.md')) {
      bucket.push(filePath);
    }
  }
  return bucket;
}

async function collectBundleFiles(scopeRoot = '', includeContent = false) {
  const files = await walkMarkdownFiles(scopeRoot, []);
  const out = [];
  for (const filePath of files) {
    const markdown = await readUtf8IfExists(filePath);
    if (markdown === null) continue;
    const bundlePath = relativeToScopeRoot(scopeRoot, filePath);
    out.push({
      kind: classifyBundleKind(bundlePath),
      title: parseMarkdownTitle(markdown, basename(filePath, '.md')),
      export_file: filePath,
      relative_path: relativeToVault(filePath),
      bundle_path: bundlePath,
      markdown: includeContent ? markdown : undefined
    });
  }
  out.sort((a, b) => String(a.bundle_path || '').localeCompare(String(b.bundle_path || ''), 'zh'));
  return out;
}

function renderExportIndexMarkdown({
  ownerId = '',
  realmId = '',
  memoFiles = [],
  sourceFiles = []
} = {}) {
  const lines = ['---'];
  lines.push(`note_type: ${renderYamlScalar('export_index')}`);
  lines.push(`title: ${renderYamlScalar('记忆卡导览')}`);
  lines.push(`scope_owner: ${renderYamlScalar(ownerId)}`);
  lines.push(`scope_realm: ${renderYamlScalar(realmId)}`);
  lines.push(renderYamlArray('tags', ['export-index']));
  lines.push('---', '', '# 记忆卡导览', '');
  lines.push(`- 工作台：${ownerId || 'default-owner'} / ${realmId || 'default'}`);
  lines.push(`- 记忆卡：${memoFiles.length} 张`);
  lines.push(`- 原文回溯：${sourceFiles.length} 份`, '');

  if (memoFiles.length) {
    const groups = new Map();
    for (const memo of memoFiles) {
      const shapeLabel = safeText(memo.shape_label, '事件切片');
      if (!groups.has(shapeLabel)) groups.set(shapeLabel, []);
      groups.get(shapeLabel).push(memo);
    }
    lines.push('## 记忆卡', '');
    for (const [shapeLabel, items] of groups.entries()) {
      lines.push(`### ${shapeLabel}`, '');
      for (const memo of items) {
        const traceCount = sourceFiles.filter((item) => safeText(item.memo_id) === safeText(memo.memo_id)).length;
        const hint = safeText(memo.inject_short);
        const detail = [traceCount ? `回溯 ${traceCount} 份` : '', hint].filter(Boolean).join(' · ');
        lines.push(`- ${toObsidianLink(memo.bundle_path, memo.title)}${detail ? ` · ${detail}` : ''}`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

async function clearBundleDirs(scopeRoot = '') {
  const dirs = [
    stagingSubdirForCardType('memo'),
    SOURCE_TRACE_DIR,
    EXPORT_INDEX_DIR
  ];
  for (const dir of dirs) {
    const target = join(scopeRoot, dir);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
  }
}

async function exportLegacyMarkdown({
  artifact = {},
  artifactId = '',
  normalizedCardType = 'memo',
  scopedRootDir = '',
  overwrite = false
} = {}) {
  const markdown = safeText(artifact.markdown);
  if (!markdown) {
    return {
      ok: false,
      error: 'Growth draft has no markdown content',
      artifact_id: safeText(artifactId),
      scope: artifact.scope
    };
  }
  const exportDir = buildLegacyExportDir({
    rootDir: scopedRootDir,
    cardType: normalizedCardType,
    draft: artifact.draft
  });
  const fileName = buildLegacyExportFileName({
    cardType: normalizedCardType,
    artifactId,
    draft: artifact.draft
  });
  const exportFile = join(exportDir, fileName);
  const relativePath = relativeToVault(exportFile);
  const bundlePath = relativeToScopeRoot(scopedRootDir, exportFile);
  const writeResult = await writeExportFiles([
    {
      kind: normalizedCardType,
      title: safeText(artifact?.draft?.frontmatter?.title),
      memo_id: safeText(artifact?.draft?.frontmatter?.memo_id || artifact?.draft?.target_card_id || artifactId),
      artifact_id: safeText(artifactId),
      export_file: exportFile,
      relative_path: relativePath,
      bundle_path: bundlePath,
      markdown
    }
  ], overwrite);
  if (!writeResult.ok) {
    return {
      ok: false,
      error: writeResult.error,
      existing: Boolean(writeResult.existing),
      scope: artifact.scope,
      artifact_id: safeText(artifactId),
      card_type: normalizedCardType,
      export_root: scopedRootDir,
      export_dir: exportDir,
      export_file: exportFile,
      title: safeText(artifact?.draft?.frontmatter?.title)
    };
  }
  const file = writeResult.files[0];
  return {
    ok: true,
    schema: 'obsidian_staging_export_result_v0.2',
    scope: artifact.scope,
    artifact_id: safeText(artifactId),
    card_type: normalizedCardType,
    export_root: scopedRootDir,
    export_dir: exportDir,
    export_file: exportFile,
    relative_path: relativePath,
    bundle_path: bundlePath,
    files: [{
      kind: file.kind,
      title: file.title,
      relative_path: file.relative_path,
      bundle_path: file.bundle_path,
      export_file: file.export_file
    }],
    overwritten: file.overwritten,
    title: safeText(artifact?.draft?.frontmatter?.title),
    target_card_id: safeText(
      artifact?.draft?.target_card_id
      || artifact?.draft?.card_entry?.card_id
    )
  };
}

export async function exportGrowthDraftToObsidianStaging({
  ownerId = '',
  realmId = '',
  artifactId = '',
  cardType = 'memo',
  rootDir = '',
  overwrite = false,
  includeContent = false
} = {}) {
  const normalizedCardType = normalizeCardType(cardType);
  const artifact = await getGrowthDraftArtifact({
    ownerId,
    realmId,
    cardType: normalizedCardType,
    artifactId
  });
  if (!artifact?.ok) return artifact;

  const scopedRootDir = safeText(
    rootDir,
    ownerId && realmId ? getScopedObsidianStagingRoot(ownerId, realmId) : OBSIDIAN_STAGING_ROOT
  );

  if (normalizedCardType !== 'memo') {
    return exportLegacyMarkdown({
      artifact,
      artifactId,
      normalizedCardType,
      scopedRootDir,
      overwrite
    });
  }

  const files = await buildMemoExportEntries({
    artifact,
    scopeRoot: scopedRootDir,
    includeContent
  });
  const writeResult = await writeExportFiles(files, overwrite);
  if (!writeResult.ok) {
    const conflict = writeResult.conflict || {};
    return {
      ok: false,
      error: writeResult.error,
      existing: Boolean(writeResult.existing),
      scope: artifact.scope,
      artifact_id: safeText(artifactId),
      card_type: normalizedCardType,
      export_root: scopedRootDir,
      export_file: conflict.export_file || '',
      relative_path: conflict.relative_path || '',
      bundle_path: conflict.bundle_path || '',
      title: safeText(artifact?.draft?.frontmatter?.title)
    };
  }

  const memoFile = writeResult.files.find((item) => item.kind === 'memo') || writeResult.files[0];
  return {
    ok: true,
    schema: 'obsidian_staging_export_result_v0.2',
    scope: artifact.scope,
    artifact_id: safeText(artifactId),
    card_type: normalizedCardType,
    export_root: scopedRootDir,
    export_dir: join(scopedRootDir, stagingSubdirForCardType('memo')),
    export_file: memoFile?.export_file || '',
    relative_path: memoFile?.relative_path || '',
    bundle_path: memoFile?.bundle_path || '',
    files: writeResult.files.map((item) => ({
      kind: item.kind,
      title: item.title,
      memo_id: item.memo_id,
      artifact_id: item.artifact_id,
      slice_id: item.slice_id,
      relation_label: item.relation_label,
      export_file: item.export_file,
      relative_path: item.relative_path,
      bundle_path: item.bundle_path,
      markdown: includeContent ? item.markdown : undefined
    })),
    overwritten: writeResult.files.some((item) => item.overwritten),
    title: memoFile?.title || safeText(artifact?.draft?.frontmatter?.title),
    target_card_id: safeText(
      artifact?.draft?.target_card_id
      || artifact?.draft?.card_entry?.card_id
      || deriveMemoId(artifact)
    )
  };
}

export async function exportGrowthScopeBundleToObsidianStaging({
  ownerId = '',
  realmId = '',
  cardType = 'memo',
  rootDir = '',
  overwrite = true,
  includeContent = false
} = {}) {
  const normalizedCardType = normalizeCardType(cardType);
  const scopedRootDir = safeText(
    rootDir,
    ownerId && realmId ? getScopedObsidianStagingRoot(ownerId, realmId) : OBSIDIAN_STAGING_ROOT
  );

  if (normalizedCardType === 'memo' && overwrite) {
    await clearBundleDirs(scopedRootDir);
  }

  const catalog = await listGrowthDraftArtifacts({
    ownerId,
    realmId,
    cardType: normalizedCardType,
    limit: 10000
  });

  const drafts = Array.isArray(catalog?.drafts) ? catalog.drafts : [];
  const failures = [];
  for (const item of drafts) {
    const result = await exportGrowthDraftToObsidianStaging({
      ownerId,
      realmId,
      artifactId: safeText(item?.artifact_id),
      cardType: normalizedCardType,
      rootDir: scopedRootDir,
      overwrite,
      includeContent: false
    });
    if (!result?.ok) {
      failures.push({
        artifact_id: safeText(item?.artifact_id),
        error: safeText(result?.error, 'export failed')
      });
    }
  }

  let files = await collectBundleFiles(scopedRootDir, includeContent);
  if (normalizedCardType === 'memo') {
    const memoFiles = files.filter((item) => item.kind === 'memo');
    const sourceFiles = files.filter((item) => item.kind === 'source_trace');
    const memoMap = new Map();
    for (const item of memoFiles) {
      const raw = includeContent ? safeText(item.markdown) : await readUtf8IfExists(item.export_file);
      const memoId = parseFrontmatterScalar(raw, 'memo_id', '');
      const shapeLabel = parseFrontmatterScalar(raw, 'shape_label', '事件切片');
      const memoryShape = parseFrontmatterScalar(raw, 'memory_shape', 'scene_event');
      const family = parseFrontmatterScalar(raw, 'family', '');
      const injectMatch = String(raw || '').match(/^>\s+(.+?)\s*$/m);
      memoMap.set(item.bundle_path, {
        ...item,
        raw,
        family,
        memo_id: memoId,
        memory_shape: memoryShape,
        shape_label: shapeLabel,
        inject_short: safeText(injectMatch?.[1])
      });
    }
    await augmentMemoFilesWithNearbyLinks(Array.from(memoMap.values()));
    const indexMarkdown = renderExportIndexMarkdown({
      ownerId,
      realmId,
      memoFiles: Array.from(memoMap.values()),
      sourceFiles
    });
    const indexBundlePath = join(EXPORT_INDEX_DIR, '记忆卡导览.md');
    const indexFile = join(scopedRootDir, indexBundlePath);
    await writeExportFiles([{
      kind: 'index',
      title: '记忆卡导览',
      export_file: indexFile,
      relative_path: relativeToVault(indexFile),
      bundle_path: normalizePathValue(indexBundlePath),
      markdown: indexMarkdown
    }], true);
    files = await collectBundleFiles(scopedRootDir, includeContent);
  }

  const memoCount = files.filter((item) => item.kind === 'memo').length;
  const sourceNoteCount = files.filter((item) => item.kind === 'source_trace').length;

  return {
    ok: true,
    schema: 'obsidian_export_bundle_v0.2',
    scope: {
      owner_id: safeText(ownerId),
      realm_id: safeText(realmId, 'default')
    },
    card_type: normalizedCardType,
    export_root: scopedRootDir,
    draft_total: Number(catalog?.total || drafts.length),
    memo_count: memoCount,
    source_note_count: sourceNoteCount,
    failed_count: failures.length,
    failures,
    bundle_name: `${safeScopeSegment(realmId || 'growth', 'growth')}-obsidian-md-bundle.zip`,
    files
  };
}
