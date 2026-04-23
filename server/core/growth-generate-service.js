import { buildGrowthTaskPacket } from './growth-task-service.js';
import { commitGrowthDecision } from './growth-commit-service.js';
import { saveGrowthDraftArtifact } from './growth-draft-store.js';
import { exportGrowthDraftToObsidianStaging } from './obsidian-export-service.js';
import { inferMemoryShape } from './memo-shape-service.js';
import { loadRuntimeApiConfig, loadRuntimeApiProfiles } from './runtime-api-profile-store.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function uniqueStrings(items, limit = 24) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function splitLooseTerms(value) {
  return safeText(value)
    .split(/[=；;，,。.!！？?、|/:：()\[\]{}（）"'“”‘’\-\s]+/u)
    .map((item) => safeText(item))
    .filter((item) => item.length >= 2);
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeDecision(value) {
  const text = safeText(value, 'skip').toLowerCase();
  if (['new', 'create'].includes(text)) return 'new';
  if (['update', 'patch', 'revise'].includes(text)) return 'update';
  if (['rewrite', 'rewrite_card'].includes(text)) return 'rewrite';
  if (['merge', 'merge_into'].includes(text)) return 'merge';
  if (['skip', 'hold'].includes(text)) return 'skip';
  return text || 'skip';
}

function normalizeApiConfig(api = {}) {
  return {
    baseUrl: trimTrailingSlash(api?.baseUrl || ''),
    apiKey: typeof api?.apiKey === 'string' ? api.apiKey : '',
    model: safeText(api?.model, 'gpt-4o-mini')
  };
}

function isProgrammaticMode(mode = '') {
  const text = safeText(mode).toLowerCase();
  return text === 'local_programmatic' || text === 'programmatic' || text === 'mock';
}

function isProgrammaticApi(api = {}) {
  const config = normalizeApiConfig(api);
  const base = safeText(config.baseUrl).toLowerCase();
  const model = safeText(config.model).toLowerCase();
  return base.startsWith('mock://') || base.startsWith('local://') || model === 'local-programmatic' || model === '__programmatic__';
}

function safeArray(value, limit = 24) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value, limit);
}

async function readMaybeJson(resp) {
  const raw = await resp.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function buildApiErrorMessage(payload = {}, fallback = '') {
  return safeText(
    payload?.error?.message
      || payload?.error?.code
      || payload?.error
      || payload?.message
      || payload?.raw
      || fallback,
    fallback
  );
}

function extractModelOutput(payload = {}) {
  const message = payload?.choices?.[0]?.message?.content;
  if (typeof message === 'string') return message.trim();
  if (Array.isArray(message)) {
    return message
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text') return item.text || '';
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

async function requestModelCompletion({
  api = {},
  systemPrompt = '',
  userPrompt = '',
  temperature = 0.35
} = {}) {
  const config = normalizeApiConfig(api);
  if (!config.baseUrl || !config.model) {
    throw new Error('缺少可用的 API 配置');
  }
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      temperature,
      messages: [
        { role: 'system', content: safeText(systemPrompt) },
        { role: 'user', content: safeText(userPrompt) }
      ]
    })
  });
  const payload = await readMaybeJson(resp);
  if (!resp.ok) {
    throw new Error(buildApiErrorMessage(payload, `API Error ${resp.status}`));
  }
  const rawOutput = extractModelOutput(payload);
  if (!rawOutput) {
    throw new Error('模型返回了空内容');
  }
  return rawOutput;
}

function tryParseJsonObject(raw = '') {
  const text = safeText(raw);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function resolveApiSelection(apiProfileName = '', mode = '') {
  if (isProgrammaticMode(mode)) {
    return {
      baseUrl: 'mock://programmatic',
      apiKey: '',
      model: 'local-programmatic',
      profile_name: '本地快检（不走外部 API）'
    };
  }
  const [profiles, currentConfig] = await Promise.all([
    loadRuntimeApiProfiles(),
    loadRuntimeApiConfig()
  ]);
  const requestedName = safeText(apiProfileName);
  const named = profiles.find((item) => safeText(item.name) === requestedName);
  const currentMatchesRequested = requestedName
    && safeText(currentConfig?.profile_name) === requestedName;
  const chosen = currentMatchesRequested ? currentConfig : (named || currentConfig);
  const config = normalizeApiConfig(chosen || {});
  if (!config.baseUrl || !config.model) {
    throw new Error('没有找到可用的 API 方案');
  }
  return {
    ...config,
    profile_name: safeText(chosen?.name || chosen?.profile_name, '当前已载入配置')
  };
}

function renderYamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

function renderYamlArray(key, values = []) {
  const list = Array.isArray(values) ? values : [];
  if (!list.length) return `${key}: []`;
  return `${key}:\n${list.map((item) => `  - ${renderYamlScalar(item)}`).join('\n')}`;
}

function renderMemoMarkdown(frontmatter = {}, body = {}) {
  const lines = ['---'];
  lines.push(`memo_id: ${renderYamlScalar(frontmatter.memo_id || 'memo_draft')}`);
  lines.push(`title: ${renderYamlScalar(frontmatter.title || '未命名 Memo')}`);
  lines.push(`memo_kind: ${renderYamlScalar(frontmatter.memo_kind || 'memory_note')}`);
  lines.push(`memory_shape: ${renderYamlScalar(frontmatter.memory_shape || 'scene_event')}`);
  lines.push(`shape_label: ${renderYamlScalar(frontmatter.shape_label || '事件切片')}`);
  lines.push(`date_start: ${renderYamlScalar(frontmatter.date_start || '')}`);
  lines.push(`time_precision: ${renderYamlScalar(frontmatter.time_precision || 'unknown')}`);
  lines.push(`stage: ${renderYamlScalar(frontmatter.stage || 'seed')}`);
  lines.push(`family: ${renderYamlScalar(frontmatter.family || '')}`);
  lines.push(renderYamlArray('cases', frontmatter.cases || []));
  lines.push(renderYamlArray('facts', frontmatter.facts || []));
  lines.push(renderYamlArray('tags', frontmatter.tags || []));
  lines.push(renderYamlArray('activation_triggers', frontmatter.activation_triggers || []));
  lines.push(renderYamlArray('voice_fingerprint', frontmatter.voice_fingerprint || []));
  lines.push(`inject_short: ${renderYamlScalar(frontmatter.inject_short || '')}`);
  lines.push(`status: ${renderYamlScalar(frontmatter.status || 'draft')}`);
  lines.push(`source_packet_id: ${renderYamlScalar(frontmatter.source_packet_id || '')}`);
  lines.push(renderYamlArray('source_windows', frontmatter.source_windows || []));
  lines.push(renderYamlArray('source_msg_ranges', frontmatter.source_msg_ranges || []));
  lines.push(renderYamlArray('source_refs', frontmatter.source_refs || []));
  lines.push(renderYamlArray('related_source_windows', frontmatter.related_source_windows || []));
  lines.push(renderYamlArray('related_source_msg_ranges', frontmatter.related_source_msg_ranges || []));
  lines.push(renderYamlArray('related_source_refs', frontmatter.related_source_refs || []));
  lines.push('---', '', `# ${safeText(frontmatter.title || '未命名 Memo')}`, '');

  const snapshot = safeText(body.snapshot);
  const context = safeText(body.context);
  const triggerList = safeArray(body.triggers, 12);
  const sceneHandles = safeArray(body.scene_handles, 12);
  const recallFacts = safeArray(body.recall_facts, 12);
  const followUp = safeArray(body.follow_up, 12);
  const primaryTraceRows = Array.isArray(body.primary_trace_rows) ? body.primary_trace_rows : [];
  const relatedTraceRows = Array.isArray(body.related_trace_rows) ? body.related_trace_rows : [];

  lines.push(snapshot || '这里补这一记忆点的主体片段。', '');
  lines.push('## 记忆类型', '');
  lines.push(`${safeText(frontmatter.shape_label, '事件切片')}。`, '');
  if (context) {
    lines.push('## 触发场景', '');
    lines.push(context, '');
  }
  if (sceneHandles.length) {
    lines.push('## 场景锚点', '');
    lines.push(...sceneHandles.map((item) => `- ${item}`));
    lines.push('');
  }
  if (recallFacts.length) {
    lines.push('## 事实锚点', '');
    lines.push(...recallFacts.map((item) => `- ${item}`));
    lines.push('');
  }
  if (triggerList.length) {
    lines.push('## 召回线索', '');
    lines.push(...triggerList.map((item) => `- ${item}`));
    lines.push('');
  }
  if (followUp.length) {
    lines.push('## 关联线索', '');
    lines.push(...followUp.map((item) => `- ${item}`));
    lines.push('');
  }
  if (primaryTraceRows.length || relatedTraceRows.length) {
    lines.push('## Trace');
    if (primaryTraceRows.length) {
      lines.push('### 主证据');
      lines.push(...primaryTraceRows.map((item) => `- ${item}`));
    }
    if (relatedTraceRows.length) {
      if (primaryTraceRows.length) lines.push('');
      lines.push('### 关联溯源');
      lines.push(...relatedTraceRows.map((item) => `- ${item}`));
    }
  }
  return lines.join('\n').trim();
}

function buildMemoTrace(taskPacket = {}) {
  const primaryPersonaScenes = Array.isArray(taskPacket?.evidence?.primary?.persona_scene_packets)
    ? taskPacket.evidence.primary.persona_scene_packets
    : [];
  const primarySqlScenes = Array.isArray(taskPacket?.evidence?.primary?.sql_scene_packets)
    ? taskPacket.evidence.primary.sql_scene_packets
    : [];
  const relatedPersonaScenes = Array.isArray(taskPacket?.evidence?.related?.persona_scene_packets)
    ? taskPacket.evidence.related.persona_scene_packets
    : [];
  const relatedSqlScenes = Array.isArray(taskPacket?.evidence?.related?.sql_scene_packets)
    ? taskPacket.evidence.related.sql_scene_packets
    : [];
  const primaryRows = collectSceneRows({
    runtime_pack: { persona_scene_packets: primaryPersonaScenes },
    sql_scene_packets: primarySqlScenes
  });
  const relatedRows = collectSceneRows({
    runtime_pack: { persona_scene_packets: relatedPersonaScenes },
    sql_scene_packets: relatedSqlScenes
  });
  const primarySnippets = Array.isArray(taskPacket?.evidence?.primary?.source_scene_snippets)
    ? taskPacket.evidence.primary.source_scene_snippets
    : [];
  const relatedSnippets = Array.isArray(taskPacket?.evidence?.related?.source_scene_snippets)
    ? taskPacket.evidence.related.source_scene_snippets
    : [];
  const primaryBundleId = uniqueStrings([
    ...primaryRows.map((row) => safeText(row.source_bundle_id || row.source_bundle || row.bundle_id)),
    ...primarySnippets.map((item) => safeText(item.source_bundle_id))
  ], 1)[0];
  const relatedBundleId = uniqueStrings([
    ...relatedRows.map((row) => safeText(row.source_bundle_id || row.source_bundle || row.bundle_id)),
    ...relatedSnippets.map((item) => safeText(item.source_bundle_id))
  ], 1)[0];
  const sourceWindows = uniqueStrings([
    ...primaryRows.map((row) => safeText(row.source_window_title || row.source_window_id)),
    ...primarySnippets.map((item) => safeText(item.source_window_title || item.source_window_id))
  ], 256);
  const sourceMsgRanges = uniqueStrings([
    ...primaryRows.map((row) => safeText(row.source_msg_range)),
    ...primarySnippets.map((item) => safeText(item.source_msg_range))
  ], 256);
  const sourceRefs = uniqueStrings([
    ...primaryRows.map((row) => safeText(row.source_ref)),
    ...primarySnippets.map((item) => safeText(item.file))
  ], 256);
  const relatedSourceWindows = uniqueStrings([
    ...relatedRows.map((row) => safeText(row.source_window_title || row.source_window_id)),
    ...relatedSnippets.map((item) => safeText(item.source_window_title || item.source_window_id))
  ], 256);
  const relatedSourceMsgRanges = uniqueStrings([
    ...relatedRows.map((row) => safeText(row.source_msg_range)),
    ...relatedSnippets.map((item) => safeText(item.source_msg_range))
  ], 256);
  const relatedSourceRefs = uniqueStrings([
    ...relatedRows.map((row) => safeText(row.source_ref)),
    ...relatedSnippets.map((item) => safeText(item.file))
  ], 256);
  const primaryTraceRows = [];
  const relatedTraceRows = [];
  for (const item of primarySnippets) {
    const bits = [
      safeText(item.source_window_title || item.source_window_id),
      safeText(item.source_msg_range),
      clipText(safeText(item.excerpt_text || item.excerpt_hint), 180)
    ].filter(Boolean);
    if (bits.length) primaryTraceRows.push(bits.join(' · '));
  }
  if (!primaryTraceRows.length) {
    for (const row of primaryRows) {
      const directQuote = safeText(
        row.char_quotes?.[0]
          || row.user_quotes?.[0]
          || row.other_quotes?.[0]
          || row.quote_refs
          || row.content_text
          || row.summary
      );
      const bits = [
        safeText(row.source_window_title || row.source_window_id),
        safeText(row.source_msg_range),
        clipText(directQuote, 180)
      ].filter(Boolean);
      if (bits.length) primaryTraceRows.push(clipText(bits.join(' · '), 220));
    }
  }
  for (const item of relatedSnippets) {
    const bits = [
      safeText(item.source_window_title || item.source_window_id),
      safeText(item.source_msg_range),
      clipText(safeText(item.excerpt_text || item.excerpt_hint), 180)
    ].filter(Boolean);
    if (bits.length) relatedTraceRows.push(bits.join(' · '));
  }
  if (!relatedTraceRows.length) {
    for (const row of relatedRows) {
      const directQuote = safeText(
        row.char_quotes?.[0]
          || row.user_quotes?.[0]
          || row.other_quotes?.[0]
          || row.quote_refs
          || row.content_text
          || row.summary
      );
      const bits = [
        safeText(row.source_window_title || row.source_window_id),
        safeText(row.source_msg_range),
        clipText(directQuote, 180)
      ].filter(Boolean);
      if (bits.length) relatedTraceRows.push(clipText(bits.join(' · '), 220));
    }
  }
  return {
    source_packet_id: safeText(primaryBundleId || relatedBundleId || taskPacket?.task?.packet_id),
    source_windows: sourceWindows,
    source_msg_ranges: sourceMsgRanges,
    source_refs: sourceRefs,
    related_source_windows: relatedSourceWindows,
    related_source_msg_ranges: relatedSourceMsgRanges,
    related_source_refs: relatedSourceRefs,
    primary_trace_rows: uniqueStrings(primaryTraceRows, 256),
    related_trace_rows: uniqueStrings(relatedTraceRows, 256)
  };
}

function buildProgrammaticDraft(taskPacket = {}) {
  const familyId = safeText(taskPacket?.task?.family_id, 'unassigned');
  const activationTriggers = inferMemoActivationTriggers(taskPacket);
  const sceneHandles = inferMemoSceneHandles(taskPacket);
  const recallFacts = inferMemoRecallFacts(taskPacket);
  const sourceSeed = safeText(
    taskPacket?.task?.query
    || taskPacket?.task?.key
    || taskPacket?.task?.source_focus
    || taskPacket?.runtime_pack?.persona_scene_packets?.[0]?.title
    || taskPacket?.runtime_pack?.sql_scene_packets?.[0]?.title
  );
  const fallbackSnapshot = safeText(
    taskPacket?.source_context?.memory_context?.context?.root?.overview
    || taskPacket?.source_context?.memory_home?.read_preview?.context?.root?.overview
    || taskPacket?.runtime_pack?.persona_scene_packets?.[0]?.content_text
    || taskPacket?.runtime_pack?.source_scene_snippets?.[0]?.excerpt_text
    || taskPacket?.runtime_pack?.fingerprint_candidate_preview?.[0]
  );
  const snapshotSeed = clipText(
    fallbackSnapshot
      .replace(/[\r\n]+/g, ' ')
      .replace(/[“”"'_*#`]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    18
  ).replace(/[。！？!?,，、；：…]+$/g, '');
  const title = safeText(
    taskPacket?.source_context?.memory_context?.context?.root?.root?.canonical_name
      || taskPacket?.source_context?.memory_home?.read_preview?.seed?.canonical_name
      || snapshotSeed,
    sourceSeed ? `围绕 ${sourceSeed} 的 Memo` : '从当前桌面继续长一张 Memo'
  );
  const context = clipText(
    taskPacket?.source_context?.memory_context?.intent
    || taskPacket?.source_context?.memory_home?.home_summary?.current_bot_leaf_persona_summary
    || '当前上下文还偏空桌，这张卡主要用来确认 memo growth 的结构闭环。',
    220
  );
  const shapeMeta = inferMemoShapeMeta(taskPacket, {
    title,
    activationTriggers,
    sceneHandles,
    recallFacts,
    snapshot: fallbackSnapshot,
    context
  });
  return {
    decision: 'new',
    reason: '本地快检模式下，先产出一张最小可用 Memo 草稿，验证题面与合同闭环。',
    target_card_id: '',
    title,
    memo_kind: 'memory_note',
    memory_shape: shapeMeta.memory_shape,
    shape_label: shapeMeta.shape_label,
    date_start: '',
    time_precision: 'unknown',
    stage: 'seed',
    status: 'draft',
    phase: 'seed',
    family: familyId,
    cases: [],
    facts: [],
    tags: uniqueStrings([`#${safeText(taskPacket?.task?.card_type, 'memo')}`, '#growth-draft'], 12),
    activation_triggers: activationTriggers.length ? activationTriggers : uniqueStrings([sourceSeed], 6),
    voice_fingerprint: [],
    inject_short: safeText(
      taskPacket?.runtime_pack?.fingerprint_candidate_preview?.[0]
        || taskPacket?.runtime_pack?.language_fingerprint_summary?.[0]
        || '等待补入更具体的人格语气与触发条件。'
    ),
    snapshot: clipText(
      taskPacket?.source_context?.memory_context?.context?.root?.overview
      || taskPacket?.source_context?.memory_home?.read_preview?.context?.root?.overview
      || '这是一张本地快检生成的 Memo 草稿，先验证 growth task 与 commit 的收口方式。',
      280
    ),
    triggers: activationTriggers.length ? activationTriggers : uniqueStrings([
      sourceSeed,
      safeText(taskPacket?.runtime_pack?.fingerprint_candidate_preview?.[0])
    ], 6),
    context,
    scene_handles: sceneHandles,
    recall_facts: recallFacts,
    follow_up: uniqueStrings([
      safeText(taskPacket?.hints?.[0]),
      safeText(taskPacket?.upstream_hints?.[0])
    ], 6),
    next_hint: '下一步换成真实 API，再看内位视角和语言指纹是否能真的长进正文。'
  };
}

function clipText(text, limit = 280) {
  const safe = String(text || '').replace(/\s+/g, ' ').trim();
  if (!safe) return '';
  if (safe.length <= limit) return safe;
  return `${safe.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function buildMemoGenerationPrompt(taskPacket = {}) {
  const runtimePack = taskPacket?.runtime_pack || {};
  const charLabel = safeText(runtimePack.char_name, '她');
  const userLabel = safeText(runtimePack.user_name, '她');
  const fingerprintRuntime = runtimePack?.language_fingerprint_runtime || {};
  const scenarioCueText = Array.isArray(fingerprintRuntime?.scenario_cues)
    ? fingerprintRuntime.scenario_cues
      .slice(0, 6)
      .map((item) => {
        const scene = safeText(item?.scene, '未命名场景');
        const cues = uniqueStrings([
          ...(Array.isArray(item?.cues) ? item.cues : []),
          ...(Array.isArray(item?.quote_cues) ? item.quote_cues : [])
        ], 3);
        return `${scene}：${cues.join(' / ')}`;
      })
      .filter(Boolean)
    : [];
  const quoteCueText = safeArray(fingerprintRuntime?.quote_cues, 8);
  const temperatureScaleText = safeArray(fingerprintRuntime?.temperature_scale, 6);

  return [
    `你现在要替 ${charLabel} 写一张会被以后拿来召回的 Memo。`,
    `${charLabel} 不是你的研究对象，也不是你的角色设定说明；她就在里面。${userLabel} 也不是素材标签，而是她正在靠近的人。`,
    '',
    '先完整读 runtime_pack 里的 persona_card_text 和 language_fingerprint_text。',
    '不要把它们复述成规则。把它们当成这个人已经长好的自我认知和说话肌理。',
    '',
    '再读 persona_scene_packets、sql_scene_packets、source_scene_snippets、user_quotes、char_quotes、excerpt_text。',
    '这些不是提纲，是现场。',
    '',
    '写的时候只抓一件事：这一刻是怎么落到我身上的。',
    '让一句真话先落下来，再顺着它往里走。不要抢着分析，不要站到外面解释，不要把意义提前宣布出来。',
    '',
    '语言要自然，要有感情，要像这张嘴自己长出来的，不要像在完成任务。',
    '可以有比喻、黏连感、热度，只要那是这张嘴会说的话。',
    '',
    '只守这一条事实边界：',
    '切片原文、user_quotes、char_quotes、excerpt_text 里没有出现过的动作、表情、环境、道具、节奏，不要写成真的发生过。',
    '如果原料没有给到，就停在那个位置上，不要替现场补灯光。',
    '',
    '输出仍然只给我 1 个 JSON 对象，不要解释，不要 markdown，不要代码块。字段如下：',
    '- decision: new/update/rewrite/merge/skip',
    '- reason',
    '- target_card_id',
    '- title',
    '- memo_kind',
    '- date_start',
    '- time_precision',
    '- stage',
    '- status',
    '- phase',
    '- family',
    '- cases: string[]',
    '- facts: string[]',
    '- tags: string[]',
    '- activation_triggers: string[]',
    '- voice_fingerprint: string[]',
    '- inject_short',
    '- snapshot',
    '- triggers: string[]',
    '- context',
    '- follow_up: string[]',
    '- next_hint',
    '',
    '字段只这样理解：',
    '- snapshot 是正文主体，把那一下真的写出来。',
    '- context 只补最少的时间、窗口、关系锚点，不抢正文。',
    '- follow_up 只留后续还能挂接的线索。',
    '',
    '桌上现成的嘴型提示：',
    ...(scenarioCueText.length ? scenarioCueText.map((line) => `- ${line}`) : ['- 场景嘴型暂时还是空的，更依赖原句和原场。']),
    ...(quoteCueText.length ? ['- 代表性嘴型碎片：', ...quoteCueText.map((line) => `  - ${line}`)] : []),
    ...(temperatureScaleText.length ? ['- 温度标尺：', ...temperatureScaleText.map((line) => `  - ${line}`)] : []),
    '',
    '最后只记一句：写得像她真的把这段事重新想了一遍。'
  ].join('\n');
}

function buildMemoBodyPrompt(taskPacket = {}) {
  const runtimePack = taskPacket?.runtime_pack || {};
  const charLabel = safeText(runtimePack.char_name, '她');
  const userLabel = safeText(runtimePack.user_name, '她');
  return [
    `你现在替 ${charLabel} 写一小段 Memo 正文。`,
    `${charLabel} 在里面，${userLabel} 也在里面。不要站到外面解释他们，不要研究他们，不要替这段关系下定义。`,
    '',
    '先读她的人格卡，再读她的语言指纹，再读桌上的原场切片。',
    '写的时候只做一件事：把那一下重新想一遍，让它从嘴里长出来。',
    '',
    '只守一条边界：原场里没有的动作、表情、环境、道具，不要补成真的发生过。',
    '没有就停住。不要替她笑，不要替她停顿，不要替现场打灯。',
    '',
    '可以有温度，可以有比喻，可以有黏连感，但那必须是这张嘴会说出来的话，不是任务腔，也不是分析腔。',
    '',
    '只输出正文，不要 JSON，不要标题，不要 markdown，不要解释。'
  ].join('\n');
}

function buildMemoBodyInput(taskPacket = {}) {
  const runtimePack = taskPacket?.runtime_pack || {};
  const personaScenes = Array.isArray(runtimePack.persona_scene_packets)
    ? runtimePack.persona_scene_packets.slice(0, 3).map((scene) => ({
        scene: safeText(scene.group_key),
        rows: (Array.isArray(scene.rows) ? scene.rows : []).slice(0, 4).map((row) => ({
          time: safeText(row.time),
          title: safeText(row.title),
          content_text: safeText(row.content_text),
          user_quotes: safeArray(row.user_quotes, 4),
          char_quotes: safeArray(row.char_quotes, 4),
          topic_labels: safeText(row.topic_labels),
          source_window_title: safeText(row.source_window_title),
          source_msg_range: safeText(row.source_msg_range)
        }))
      }))
    : [];
  const sqlScenes = Array.isArray(taskPacket?.sql_scene_packets)
    ? taskPacket.sql_scene_packets.slice(0, 3).map((scene) => ({
        scene: safeText(scene.group_key),
        rows: (Array.isArray(scene.rows) ? scene.rows : []).slice(0, 3).map((row) => ({
          time: safeText(row.time),
          title: safeText(row.title),
          content_text: safeText(row.content_text),
          user_quotes: safeArray(row.user_quotes, 3),
          char_quotes: safeArray(row.char_quotes, 3),
          topic_labels: safeText(row.topic_labels),
          source_window_title: safeText(row.source_window_title),
          source_msg_range: safeText(row.source_msg_range)
        }))
      }))
    : [];
  const snippets = Array.isArray(taskPacket?.source_scene_snippets)
    ? taskPacket.source_scene_snippets.slice(0, 8).map((item) => ({
        topic_label: safeText(item.topic_label),
        source_window_title: safeText(item.source_window_title),
        source_msg_range: safeText(item.source_msg_range),
        excerpt_text: safeText(item.excerpt_text || item.excerpt_hint)
      }))
    : [];
  const evidence = taskPacket?.evidence || {};

  return {
    char_name: safeText(runtimePack.char_name),
    user_name: safeText(runtimePack.user_name),
    query: safeText(taskPacket?.task?.query || taskPacket?.task?.source_focus),
    persona_card_text: safeText(runtimePack.persona_card_text),
    language_fingerprint_text: safeText(runtimePack.language_fingerprint_text),
    persona_scenes: personaScenes,
    sql_scenes: sqlScenes,
    source_snippets: snippets,
    primary_evidence: {
      persona_scene_count: Number(evidence?.primary?.summary?.persona?.count || 0),
      sql_scene_count: Number(evidence?.primary?.summary?.sql?.count || 0),
      source_snippet_count: Number(evidence?.primary?.summary?.source?.count || 0),
      source_refs: safeArray(evidence?.primary?.summary?.source?.source_refs, 8)
    },
    related_evidence: {
      persona_scene_count: Number(evidence?.related?.summary?.persona?.count || 0),
      sql_scene_count: Number(evidence?.related?.summary?.sql?.count || 0),
      source_snippet_count: Number(evidence?.related?.summary?.source?.count || 0),
      source_refs: safeArray(evidence?.related?.summary?.source?.source_refs, 8)
    }
  };
}

function buildRelevantQueryTerms(taskPacket = {}) {
  return uniqueStrings([
    ...splitLooseTerms(taskPacket?.task?.query),
    ...splitLooseTerms(taskPacket?.task?.source_focus),
    ...splitLooseTerms(taskPacket?.task?.key)
  ], 12);
}

function normalizeRecallText(value = '', limit = 84) {
  const text = String(value || '')
    .replace(/\[object Object\]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[“”"'`*_#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return clipText(text, limit);
}

function pickRowAnchor(row = {}) {
  const topicText = splitLooseTerms(row.topic_labels || '').slice(0, 2).join(' / ');
  return normalizeRecallText(
    row.title
      || row.anchor_name
      || row.fact_key
      || topicText
      || row.source_window_title
      || row.source_window_id,
    48
  );
}

function pickRowCue(row = {}) {
  return normalizeRecallText(
    row.char_quotes?.[0]
      || row.user_quotes?.[0]
      || row.other_quotes?.[0]
      || row.quote_refs
      || row.content_text
      || row.summary,
    96
  );
}

function collectRelevantSourceSnippets(taskPacket = {}) {
  const candidates = [
    ...(Array.isArray(taskPacket?.evidence?.primary?.source_scene_snippets) ? taskPacket.evidence.primary.source_scene_snippets : []),
    ...(Array.isArray(taskPacket?.source_scene_snippets) ? taskPacket.source_scene_snippets : []),
    ...(Array.isArray(taskPacket?.evidence?.related?.source_scene_snippets) ? taskPacket.evidence.related.source_scene_snippets : [])
  ];
  const seen = new Set();
  const out = [];
  for (const item of candidates) {
    const key = [
      safeText(item?.file),
      safeText(item?.source_window_title || item?.source_window_id),
      safeText(item?.source_msg_range),
      safeText(item?.excerpt_text || item?.excerpt_hint)
    ].join('::');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 12) break;
  }
  return out;
}

function pickSnippetAnchor(item = {}) {
  return normalizeRecallText(
    item.topic_label
      || item.source_window_title
      || item.source_window_id
      || item.source_msg_range,
    48
  );
}

function pickSnippetCue(item = {}) {
  return normalizeRecallText(item.excerpt_text || item.excerpt_hint, 96);
}

function scoreRelevantRow(row = {}, queryTerms = []) {
  const hay = [
    safeText(row.title),
    safeText(row.content_text),
    safeText(row.topic_labels),
    safeText(row.track_id),
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...(Array.isArray(row.user_quotes) ? row.user_quotes : []),
    ...(Array.isArray(row.char_quotes) ? row.char_quotes : [])
  ].join('\n').toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (hay.includes(term.toLowerCase())) score += 2;
  }
  return score;
}

function collectSceneRows(taskPacket = {}) {
  const rows = [];
  for (const scene of Array.isArray(taskPacket?.runtime_pack?.persona_scene_packets) ? taskPacket.runtime_pack.persona_scene_packets : []) {
    for (const row of Array.isArray(scene.rows) ? scene.rows : []) rows.push(row);
  }
  for (const scene of Array.isArray(taskPacket?.sql_scene_packets) ? taskPacket.sql_scene_packets : []) {
    for (const row of Array.isArray(scene.rows) ? scene.rows : []) rows.push(row);
  }
  return rows;
}

function collectRelevantSceneRows(taskPacket = {}) {
  const queryTerms = buildRelevantQueryTerms(taskPacket);
  const rows = collectSceneRows(taskPacket)
    .map((row) => ({ row, score: scoreRelevantRow(row, queryTerms) }))
    .sort((a, b) => b.score - a.score || String(a.row.time || '').localeCompare(String(b.row.time || '')));
  const best = rows.filter((item) => item.score > 0).map((item) => item.row);
  return (best.length ? best : rows.map((item) => item.row)).slice(0, 12);
}

function inferMemoDate(taskPacket = {}) {
  const rows = collectRelevantSceneRows(taskPacket);
  const dates = rows
    .map((row) => safeText(row.time))
    .filter(Boolean)
    .sort();
  return safeText(dates[0]);
}

function inferMemoFamily(taskPacket = {}) {
  return safeText(
    taskPacket?.task?.family_id
    || taskPacket?.source_context?.memory_context?.context?.root?.family_refs?.[0]?.family_id
    || [safeText(taskPacket?.runtime_pack?.char_name), safeText(taskPacket?.runtime_pack?.user_name)].filter(Boolean).join('与')
  );
}

function inferMemoShapeMeta(taskPacket = {}, {
  title = '',
  activationTriggers = [],
  sceneHandles = [],
  recallFacts = [],
  snapshot = '',
  context = ''
} = {}) {
  const relevantRows = collectRelevantSceneRows(taskPacket);
  const sourceSnippets = collectRelevantSourceSnippets(taskPacket);
  const shape = inferMemoryShape({
    title: safeText(title),
    memoKind: safeText(taskPacket?.task?.memo_kind),
    query: safeText(taskPacket?.task?.query || taskPacket?.task?.source_focus || taskPacket?.task?.key),
    context: safeText(context),
    snapshot: safeText(snapshot),
    tags: inferMemoTags(taskPacket),
    topics: uniqueStrings([
      ...relevantRows.flatMap((row) => splitLooseTerms(row.topic_labels)),
      ...sourceSnippets.map((item) => safeText(item.topic_label))
    ], 24),
    sceneHandles,
    facts: recallFacts,
    activationTriggers,
    sourceTitles: uniqueStrings([
      ...relevantRows.map((row) => safeText(row.source_window_title || row.source_window_id)),
      ...sourceSnippets.map((item) => safeText(item.source_window_title || item.source_window_id))
    ], 12)
  });
  return {
    memory_shape: safeText(shape?.key, 'scene_event'),
    shape_label: safeText(shape?.label, '事件切片')
  };
}

function inferMemoSceneHandles(taskPacket = {}) {
  const handles = [];
  for (const row of collectRelevantSceneRows(taskPacket).slice(0, 4)) {
    const handle = clipText([
      safeText(row.time),
      pickRowAnchor(row),
      safeText(row.source_window_title || row.source_window_id),
      safeText(row.source_msg_range)
    ].filter(Boolean).join(' · '), 96);
    if (handle) handles.push(handle);
  }
  for (const item of collectRelevantSourceSnippets(taskPacket).slice(0, 3)) {
    const handle = clipText([
      pickSnippetAnchor(item),
      safeText(item.source_window_title || item.source_window_id),
      safeText(item.source_msg_range)
    ].filter(Boolean).join(' · '), 96);
    if (handle) handles.push(handle);
  }
  return uniqueStrings(handles, 6);
}

function inferMemoRecallFacts(taskPacket = {}) {
  const facts = [];
  for (const row of collectRelevantSceneRows(taskPacket).slice(0, 5)) {
    const anchor = pickRowAnchor(row);
    const cue = pickRowCue(row);
    if (!anchor && !cue) continue;
    facts.push(anchor && cue ? `${anchor}：${cue}` : (cue || anchor));
    if (facts.length >= 4) break;
  }
  if (facts.length < 4) {
    for (const item of collectRelevantSourceSnippets(taskPacket).slice(0, 4)) {
      const anchor = pickSnippetAnchor(item);
      const cue = pickSnippetCue(item);
      if (!anchor && !cue) continue;
      facts.push(anchor && cue ? `${anchor}：${cue}` : (cue || anchor));
      if (facts.length >= 4) break;
    }
  }
  return uniqueStrings(facts.map((item) => clipText(item, 120)), 4);
}

function inferMemoActivationTriggers(taskPacket = {}) {
  const triggers = [
    safeText(taskPacket?.task?.query),
    safeText(taskPacket?.task?.source_focus),
    safeText(taskPacket?.task?.key)
  ];
  for (const row of collectRelevantSceneRows(taskPacket).slice(0, 6)) {
    triggers.push(pickRowAnchor(row));
    splitLooseTerms(row.topic_labels || '').slice(0, 2).forEach((item) => triggers.push(item));
  }
  for (const item of collectRelevantSourceSnippets(taskPacket).slice(0, 4)) {
    triggers.push(pickSnippetAnchor(item));
  }
  const cleaned = triggers
    .map((item) => normalizeRecallText(item, 42))
    .filter((item) => item.length >= 2)
    .filter((item) => !/^current_scene$/i.test(item))
    .filter((item) => item !== 'workspace_only');
  return uniqueStrings(cleaned, 8);
}

function inferMemoTags(taskPacket = {}) {
  const tags = [];
  for (const row of collectRelevantSceneRows(taskPacket)) {
    for (const tag of Array.isArray(row.tags) ? row.tags : []) tags.push(tag);
    splitLooseTerms(row.topic_labels).forEach((item) => tags.push(item));
  }
  const cleaned = tags.filter((tag) => {
    const text = safeText(tag);
    if (!text) return false;
    if (text.includes('技术/生成风格')) return false;
    if (text === '事件' || text === '回顾') return false;
    return true;
  });
  return uniqueStrings(cleaned, 6);
}

function inferMemoVoiceFingerprint(taskPacket = {}) {
  const runtime = taskPacket?.runtime_pack?.language_fingerprint_runtime || {};
  const candidates = [
    ...(Array.isArray(runtime.quote_cues) ? runtime.quote_cues : []),
    ...(Array.isArray(runtime.voice_directives) ? runtime.voice_directives : [])
  ];
  const cleaned = candidates.filter((item) => {
    const text = safeText(item);
    if (!text) return false;
    if (text.length <= 1) return false;
    if (/^[你我她他]$/.test(text)) return false;
    if (text.includes('最软') || text.includes('日常') || text.includes('工作') || text.includes('顶回去') || text.includes('最硬')) return false;
    return true;
  });
  return uniqueStrings(cleaned, 4);
}

function inferMemoFollowUp(taskPacket = {}) {
  const follow = [];
  for (const draft of Array.isArray(taskPacket?.recent_drafts) ? taskPacket.recent_drafts : []) {
    const title = safeText(draft.title);
    if (title) follow.push(title);
  }
  for (const card of Array.isArray(taskPacket?.candidate_cards) ? taskPacket.candidate_cards : []) {
    const title = safeText(card.title);
    if (title) follow.push(title);
  }
  for (const item of Array.isArray(taskPacket?.source_scene_snippets) ? taskPacket.source_scene_snippets : []) {
    const text = safeText(item.topic_label);
    if (text) follow.push(text);
  }
  return uniqueStrings(follow, 4);
}

function inferMemoContext(taskPacket = {}) {
  const firstSnippet = Array.isArray(taskPacket?.evidence?.primary?.source_scene_snippets)
    ? taskPacket.evidence.primary.source_scene_snippets[0]
    : (Array.isArray(taskPacket?.source_scene_snippets) ? taskPacket.source_scene_snippets[0] : null);
  const firstRow = collectSceneRows({
    runtime_pack: {
      persona_scene_packets: Array.isArray(taskPacket?.evidence?.primary?.persona_scene_packets)
        ? taskPacket.evidence.primary.persona_scene_packets
        : (Array.isArray(taskPacket?.runtime_pack?.persona_scene_packets) ? taskPacket.runtime_pack.persona_scene_packets : [])
    },
    sql_scene_packets: Array.isArray(taskPacket?.evidence?.primary?.sql_scene_packets)
      ? taskPacket.evidence.primary.sql_scene_packets
      : (Array.isArray(taskPacket?.sql_scene_packets) ? taskPacket.sql_scene_packets : [])
  })[0] || {};
  const runtimePack = taskPacket?.runtime_pack || {};
  const relation = [safeText(runtimePack.char_name), safeText(runtimePack.user_name)].filter(Boolean).join(' ↔ ');
  const bits = [
    relation,
    safeText(firstRow.time),
    pickRowAnchor(firstRow) || pickSnippetAnchor(firstSnippet),
    safeText(firstSnippet?.source_window_title || firstRow.source_window_title),
    safeText(taskPacket?.task?.query || taskPacket?.task?.source_focus)
  ].filter(Boolean);
  return bits.join(' · ');
}

function buildBodyOnlyDraft(rawBody = '', taskPacket = {}) {
  const queryTitle = safeText(taskPacket?.task?.query || taskPacket?.task?.source_focus, '未命名 Memo');
  const bodyText = safeText(rawBody);
  const trace = buildMemoTrace(taskPacket);
  const activationTriggers = inferMemoActivationTriggers(taskPacket);
  const sceneHandles = inferMemoSceneHandles(taskPacket);
  const recallFacts = inferMemoRecallFacts(taskPacket);
  const context = inferMemoContext(taskPacket);
  const shapeMeta = inferMemoShapeMeta(taskPacket, {
    title: queryTitle,
    activationTriggers,
    sceneHandles,
    recallFacts,
    snapshot: bodyText,
    context
  });
  const frontmatter = {
    memo_id: '',
    title: queryTitle,
    memo_kind: 'memory_note',
    memory_shape: shapeMeta.memory_shape,
    shape_label: shapeMeta.shape_label,
    date_start: inferMemoDate(taskPacket),
    time_precision: 'day',
    stage: 'seed',
    family: inferMemoFamily(taskPacket),
    cases: [],
    facts: [],
    tags: inferMemoTags(taskPacket),
    activation_triggers: activationTriggers,
    voice_fingerprint: inferMemoVoiceFingerprint(taskPacket),
    inject_short: clipText(bodyText.split(/\n+/)[0] || bodyText, 90),
    status: 'draft',
    phase: 'growth',
    source_packet_id: trace.source_packet_id,
    source_windows: trace.source_windows,
    source_msg_ranges: trace.source_msg_ranges,
    source_refs: trace.source_refs,
    related_source_windows: trace.related_source_windows,
    related_source_msg_ranges: trace.related_source_msg_ranges,
    related_source_refs: trace.related_source_refs
  };
  const body = {
    snapshot: bodyText,
    triggers: activationTriggers,
    context,
    scene_handles: sceneHandles,
    recall_facts: recallFacts,
    follow_up: inferMemoFollowUp(taskPacket),
    primary_trace_rows: trace.primary_trace_rows,
    related_trace_rows: trace.related_trace_rows
  };
  const markdown = renderMemoMarkdown(frontmatter, body);
  const cardEntry = {
    card_id: '',
    card_type: 'memo',
    family_id: frontmatter.family,
    title: frontmatter.title,
    status: frontmatter.status,
    phase: frontmatter.phase,
    summary_for_growth: frontmatter.inject_short,
    inject_short: frontmatter.inject_short,
    voice_fingerprint: frontmatter.voice_fingerprint,
    tags: frontmatter.tags,
    related_card_ids: [],
    source_packet_id: trace.source_packet_id,
    source_refs: uniqueStrings([
      ...trace.source_refs,
      ...trace.related_source_refs
    ], 512)
  };
  const ledgerEntry = {
    target_card_id: '',
    family_id: frontmatter.family,
    card_type: 'memo',
    payload: {
      memo_kind: frontmatter.memo_kind,
      date_start: frontmatter.date_start,
      time_precision: frontmatter.time_precision
    }
  };
  return {
    decision: 'new',
    reason: '正文试写模式：先让 API 只把这一刻写活，字段和导出由代码回填。',
    next_hint: '如果正文方向对了，再把这张卡并入真正的生长账本。',
    target_card_id: '',
    frontmatter,
    body,
    markdown,
    card_entry: cardEntry,
    ledger_entry: ledgerEntry,
    source_review: {
      primary_evidence: taskPacket?.evidence?.primary || {},
      related_evidence: taskPacket?.evidence?.related || {},
      discard_report: taskPacket?.evidence?.discard_report || {}
    }
  };
}

function normalizeMemoDraft(parsed = {}, taskPacket = {}) {
  const decision = normalizeDecision(parsed?.decision);
  const family = safeText(parsed?.family, safeText(taskPacket?.task?.family_id));
  const targetCardId = safeText(parsed?.target_card_id);
  const trace = buildMemoTrace(taskPacket);
  const derivedActivationTriggers = inferMemoActivationTriggers(taskPacket);
  const derivedSceneHandles = inferMemoSceneHandles(taskPacket);
  const derivedRecallFacts = inferMemoRecallFacts(taskPacket);
  const derivedContext = inferMemoContext(taskPacket);
  const shapeMeta = inferMemoShapeMeta(taskPacket, {
    title: safeText(parsed?.title, '未命名 Memo'),
    activationTriggers: safeArray(parsed?.activation_triggers?.length ? parsed.activation_triggers : derivedActivationTriggers, 12),
    sceneHandles: safeArray(parsed?.cases?.length ? parsed.cases : derivedSceneHandles, 12),
    recallFacts: safeArray(parsed?.facts?.length ? parsed.facts : derivedRecallFacts, 12),
    snapshot: safeText(parsed?.snapshot),
    context: safeText(parsed?.context, derivedContext)
  });
  const frontmatter = {
    memo_id: safeText(targetCardId || parsed?.memo_id || ''),
    title: safeText(parsed?.title, '未命名 Memo'),
    memo_kind: safeText(parsed?.memo_kind, 'memory_note'),
    memory_shape: safeText(parsed?.memory_shape, shapeMeta.memory_shape),
    shape_label: safeText(parsed?.shape_label, shapeMeta.shape_label),
    date_start: safeText(parsed?.date_start),
    time_precision: safeText(parsed?.time_precision, 'unknown'),
    stage: safeText(parsed?.stage, 'seed'),
    family,
    cases: safeArray(parsed?.cases, 12),
    facts: safeArray(parsed?.facts, 12),
    tags: safeArray(parsed?.tags, 16),
    activation_triggers: safeArray(parsed?.activation_triggers?.length ? parsed.activation_triggers : derivedActivationTriggers, 12),
    voice_fingerprint: safeArray(
      parsed?.voice_fingerprint?.length
        ? parsed.voice_fingerprint
        : (taskPacket?.runtime_pack?.language_fingerprint_runtime?.quote_cues
          || taskPacket?.runtime_pack?.language_fingerprint_runtime?.voice_directives
          || []),
      12
    ),
    inject_short: safeText(parsed?.inject_short),
    status: safeText(parsed?.status, 'draft'),
    phase: safeText(parsed?.phase, 'seed'),
    source_packet_id: trace.source_packet_id,
    source_windows: trace.source_windows,
    source_msg_ranges: trace.source_msg_ranges,
    source_refs: trace.source_refs,
    related_source_windows: trace.related_source_windows,
    related_source_msg_ranges: trace.related_source_msg_ranges,
    related_source_refs: trace.related_source_refs
  };
  const body = {
    snapshot: safeText(parsed?.snapshot),
    triggers: safeArray(parsed?.triggers?.length ? parsed.triggers : derivedActivationTriggers, 12),
    context: safeText(parsed?.context, derivedContext),
    scene_handles: safeArray(parsed?.cases?.length ? parsed.cases : derivedSceneHandles, 12),
    recall_facts: safeArray(parsed?.facts?.length ? parsed.facts : derivedRecallFacts, 12),
    follow_up: safeArray(parsed?.follow_up?.length ? parsed.follow_up : inferMemoFollowUp(taskPacket), 12),
    primary_trace_rows: trace.primary_trace_rows,
    related_trace_rows: trace.related_trace_rows
  };
  const markdown = decision === 'skip'
    ? ''
    : renderMemoMarkdown(frontmatter, body);
  const cardEntry = {
    card_id: safeText(targetCardId),
    card_type: 'memo',
    family_id: family,
    title: frontmatter.title,
    status: frontmatter.status,
    phase: frontmatter.phase,
    summary_for_growth: safeText(frontmatter.inject_short || body.snapshot),
    inject_short: frontmatter.inject_short,
    voice_fingerprint: frontmatter.voice_fingerprint,
    tags: frontmatter.tags,
    related_card_ids: uniqueStrings([
      ...frontmatter.cases,
      ...frontmatter.facts
    ], 24),
    source_packet_id: trace.source_packet_id,
    source_refs: uniqueStrings([
      ...trace.source_refs,
      ...trace.related_source_refs
    ], 512)
  };
  const ledgerEntry = {
    target_card_id: safeText(targetCardId),
    family_id: family,
    card_type: 'memo',
    payload: {
      memo_kind: frontmatter.memo_kind,
      date_start: frontmatter.date_start,
      time_precision: frontmatter.time_precision
    }
  };
  return {
    decision,
    reason: safeText(parsed?.reason),
    next_hint: safeText(parsed?.next_hint),
    target_card_id: targetCardId,
    frontmatter,
    body,
    markdown,
    card_entry: cardEntry,
    ledger_entry: ledgerEntry,
    source_review: {
      primary_evidence: taskPacket?.evidence?.primary || {},
      related_evidence: taskPacket?.evidence?.related || {},
      discard_report: taskPacket?.evidence?.discard_report || {}
    }
  };
}

export async function generateGrowthDraft({
  ownerId = '',
  realmId = '',
  botId = '',
  userId = '',
  charId = '',
  key = '',
  query = '',
  familyId = '',
  cardType = 'memo',
  packetId = '',
  includePersonaRows = true,
  rowLimit = 8,
  apiProfileName = '',
  mode = '',
  commit = false,
  saveArtifact = true,
  exportToObsidian = false,
  exportRoot = '',
  overwriteExport = false,
  onStatus = null
} = {}) {
  const normalizedCardType = safeText(cardType, 'memo');
  if (normalizedCardType !== 'memo') {
    throw new Error('当前只实现了 memo growth draft。');
  }
  if (typeof onStatus === 'function') {
    await onStatus({
      phase: 'preparing_task',
      progress: 12,
      label: '正在整理这轮题面'
    });
  }
  const taskPacket = await buildGrowthTaskPacket({
    ownerId,
    realmId,
    botId,
    userId,
    charId,
    key,
    query,
    familyId,
    cardType: normalizedCardType,
    packetId,
    includePersonaRows,
    rowLimit
  });
  if (typeof onStatus === 'function') {
    await onStatus({
      phase: 'binding_materials',
      progress: 24,
      label: '正在把人格桌面和这轮原料绑在一起',
      detail: {
        family_id: safeText(taskPacket?.task?.family_id),
        query: safeText(taskPacket?.task?.query || taskPacket?.task?.source_focus)
      }
    });
  }

  const api = await resolveApiSelection(apiProfileName, mode);
  let rawOutput = '';
  let parsed = null;

  if (isProgrammaticMode(mode) || isProgrammaticApi(api)) {
    if (typeof onStatus === 'function') {
      await onStatus({
        phase: 'programmatic_draft',
        progress: 42,
        label: '本地快检正在起草这张卡'
      });
    }
    parsed = buildProgrammaticDraft(taskPacket);
    rawOutput = JSON.stringify(parsed, null, 2);
  } else {
    if (typeof onStatus === 'function') {
      await onStatus({
        phase: 'waiting_model',
        progress: 42,
        label: '模型正在写这一张卡',
        detail: {
          model: safeText(api.model),
          profile_name: safeText(api.profile_name)
        }
      });
    }
    rawOutput = await requestModelCompletion({
      api,
      systemPrompt: buildMemoBodyPrompt(taskPacket),
      userPrompt: JSON.stringify(buildMemoBodyInput(taskPacket), null, 2),
      temperature: 0.65
    });
    parsed = buildBodyOnlyDraft(rawOutput, taskPacket);
  }
  if (typeof onStatus === 'function') {
    await onStatus({
      phase: 'normalizing_draft',
      progress: 68,
      label: '已经拿到正文，正在补卡片字段'
    });
  }

  const draft = (isProgrammaticMode(mode) || isProgrammaticApi(api))
    ? normalizeMemoDraft(parsed, taskPacket)
    : parsed;
  const resolvedOwnerId = safeText(taskPacket.scope?.owner_id || ownerId);
  const resolvedRealmId = safeText(taskPacket.scope?.realm_id || realmId, 'default');
  const artifact = saveArtifact === false
    ? null
    : await (async () => {
        if (typeof onStatus === 'function') {
          await onStatus({
            phase: 'saving_draft',
            progress: 82,
            label: '正在落草稿'
          });
        }
        return saveGrowthDraftArtifact({
        ownerId: resolvedOwnerId,
        realmId: resolvedRealmId,
        cardType: normalizedCardType,
        familyId: draft?.frontmatter?.family || taskPacket.task?.family_id || '',
        task: taskPacket.task,
        draft,
        api: {
          mode: isProgrammaticMode(mode) || isProgrammaticApi(api) ? 'local_programmatic' : 'api_profile',
          profile_name: safeText(api.profile_name),
          model: safeText(api.model)
        }
      });
      })();

  if (artifact) {
    draft.ledger_entry.payload = {
      ...(draft.ledger_entry.payload || {}),
      artifact_id: artifact.artifact_id,
      markdown_file: artifact.markdown_file,
      json_file: artifact.json_file
    };
  }

  let exportResult = null;
  if (exportToObsidian) {
    if (!artifact?.artifact_id) {
      throw new Error('当前草稿还没有 artifact，无法导出到 Obsidian staging');
    }
    if (typeof onStatus === 'function') {
      await onStatus({
        phase: 'exporting',
        progress: 92,
        label: '正在写入 Obsidian staging'
      });
    }
    exportResult = await exportGrowthDraftToObsidianStaging({
      ownerId: resolvedOwnerId,
      realmId: resolvedRealmId,
      artifactId: artifact.artifact_id,
      cardType: normalizedCardType,
      rootDir: exportRoot,
      overwrite: overwriteExport
    });
    if (exportResult?.ok) {
      draft.frontmatter = {
        ...(draft.frontmatter || {}),
        status: 'staged',
        phase: 'staged'
      };
      draft.card_entry = {
        ...(draft.card_entry || {}),
        status: 'staged',
        phase: 'staged'
      };
      draft.ledger_entry.payload = {
        ...(draft.ledger_entry.payload || {}),
        export_file: exportResult.export_file,
        export_dir: exportResult.export_dir,
        export_root: exportResult.export_root
      };
    }
  }

  let commitResult = null;
  if (commit && draft.decision !== 'skip') {
    if (typeof onStatus === 'function') {
      await onStatus({
        phase: 'committing',
        progress: 96,
        label: '正在记账并挂到主卡目录'
      });
    }
    commitResult = await commitGrowthDecision({
      ownerId: resolvedOwnerId,
      realmId: resolvedRealmId,
      decision: draft.decision,
      packetId: taskPacket.task?.task_id || packetId,
      reason: draft.reason,
      nextHint: draft.next_hint,
      actor: 'runtime_growth_ai',
      source: 'runtime_growth_generate',
      cardEntry: draft.card_entry,
      ledgerEntry: draft.ledger_entry
    });
  }

  return {
    ok: true,
    schema: 'growth_generate_result_v0.1',
    task: taskPacket.task,
    api: {
      mode: isProgrammaticMode(mode) || isProgrammaticApi(api) ? 'local_programmatic' : 'api_profile',
      profile_name: safeText(api.profile_name),
      model: safeText(api.model)
    },
    raw_output: rawOutput,
    draft,
    artifact,
    committed: Boolean(commitResult),
    commit_result: commitResult,
    exported: Boolean(exportResult?.ok),
    export_result: exportResult
  };
}
