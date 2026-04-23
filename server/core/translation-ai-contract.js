function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function previewText(text, limit = 220) {
  const value = safeText(text).replace(/\s+/g, ' ');
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export function buildTranslationAiSystemPrompt() {
  return [
    '你是 Hippocove 的标准语言翻译层。',
    '你的任务不是聊天，也不是解释，而是把原文切片翻成可写入记忆树的 entries。',
    '四个主干只有：person / thing / event / rule。',
    'time 不是第五主干；如果某个日期/纪念日其实更像事件锚，请直接写成 event。',
    'persona 的情绪、语气、关系温差不要写成事实主干；只保留能稳定挂在根上的事实和规则骨点。',
    '如果切片里存在明显的人称漂移，请优先用稳定主体改写，不要把“我/你/她/他”原样带进长期事实。',
    '输出只允许 JSON，顶层必须是对象，且包含 entries 数组。',
    '每条 entry 必须对应一个或多个 slice_ids，并包含：anchor_type, canonical_name, trunk, secondary_slot, slot_path, slot_owner_hint, stable_facts, recent_updates, first_seen_at, last_seen_at, conflict_hint。',
    'anchor_type 只能是 person / thing / event / rule。',
    'stable_facts 最多 5 条，只保留低波动、可长期挂载的骨点。',
    'recent_updates 允许为空；如果写，就写短期变化或当月补充。',
    '不要输出解释文字，不要输出 markdown。'
  ].join('\n');
}

export function buildTranslationAiFallbackPrompt() {
  return [
    '你是 Hippocove 的标准语言翻译层。',
    '这次不要输出 JSON，也不要写解释散文。',
    '请严格按“翻译便签”格式输出。',
    '每个 entry 都以 ### ENTRY 开头，不要编号，不要前言，不要总结。',
    '字段顺序固定，不要省略字段名。',
    '模板如下：',
    '### ENTRY',
    'SLICE_IDS: <用 | 分隔>',
    'TYPE: <person|thing|event|rule>',
    'NAME: <稳定名称>',
    'TRUNK: <人物|事物|事件|规则>',
    'OWNER: <owner 或 none>',
    'SLOT: <二级槽位或 none>',
    'PATH: <树路径或 none>',
    'STABLE:',
    '- <事实1>',
    '- <事实2>',
    'UPDATE: <一句短更新，没有写 none>',
    'CONFLICT: <一句冲突提示，没有写 none>',
    'RULE: <一句为什么这样归位，没有写 none>',
    '不要输出模板外的内容。'
  ].join('\n');
}

export function buildTranslationAiResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'hippocove_translation_entries',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slice_ids: {
                  type: 'array',
                  items: { type: 'string' }
                },
                anchor_type: { type: 'string' },
                canonical_name: { type: 'string' },
                trunk: { type: 'string' },
                secondary_slot: { type: 'string' },
                slot_path: { type: 'string' },
                slot_owner_hint: { type: 'string' },
                stable_facts: {
                  type: 'array',
                  items: { type: 'string' }
                },
                recent_updates: {
                  anyOf: [
                    { type: 'string' },
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          batch: { type: 'string' },
                          first_seen_at: { type: 'string' },
                          last_seen_at: { type: 'string' },
                          summaries: {
                            type: 'array',
                            items: { type: 'string' }
                          },
                          stable_facts: {
                            type: 'array',
                            items: { type: 'string' }
                          },
                          persona_refs: {
                            type: 'array',
                            items: { type: 'string' }
                          },
                          conflict_hint: { type: 'boolean' }
                        },
                        required: ['batch', 'first_seen_at', 'last_seen_at', 'summaries', 'stable_facts', 'persona_refs', 'conflict_hint']
                      }
                    }
                  ]
                },
                first_seen_at: { type: 'string' },
                last_seen_at: { type: 'string' },
                conflict_hint: { type: 'boolean' }
              },
              required: [
                'slice_ids',
                'anchor_type',
                'canonical_name',
                'trunk',
                'secondary_slot',
                'slot_path',
                'slot_owner_hint',
                'stable_facts',
                'recent_updates',
                'first_seen_at',
                'last_seen_at',
                'conflict_hint'
              ]
            }
          }
        },
        required: ['entries']
      }
    }
  };
}

export function buildTranslationAiUserPrompt(task = {}, translatorContract = {}) {
  const slices = Array.isArray(task?.slices) ? task.slices : [];
  const sliceBlocks = slices.map((slice) => [
    `SLICE_ID: ${safeText(slice.slice_id)}`,
    `TITLE: ${safeText(slice.title)}`,
    `KIND: ${safeText(slice.kind)}`,
    `CREATED_AT: ${safeText(slice.created_at)}`,
    'TEXT:',
    safeText(slice.text),
    '---'
  ].join('\n')).join('\n');

  return [
    `BATCH_ID: ${safeText(task.batch_id)}`,
    `ENTRY_LIMIT_HINT: ${String(task.entry_limit || 6)}`,
    '输出要求：',
    '- 只提取特别明确、值得长期挂在根上的事实/规则骨点',
    '- 如果切片内容主要是情绪流动或解释散文，可以少提，宁缺毋滥',
    '- 同一主体的多个稳定事实可以合成一条 entry',
    '',
    'translator_contract:',
    JSON.stringify(translatorContract, null, 2),
    '',
    'slices:',
    sliceBlocks
  ].join('\n');
}

function parseLabelValue(line) {
  const match = String(line || '').trim().match(/^([^:：]+)\s*[:：]\s*(.*)$/u);
  if (!match) return null;
  return {
    label: match[1].trim().toUpperCase(),
    value: match[2].trim()
  };
}

export function parseTranslationNoteEntries(raw) {
  const text = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/^```[a-zA-Z0-9_-]*\n?/g, '')
    .replace(/\n?```$/g, '');
  if (!text.trim()) return [];
  let parts = text.split(/^### ENTRY\s*$/m).map((part) => part.trim()).filter(Boolean);
  if (!parts.length || (parts.length === 1 && !/^SLICE_IDS\s*[:：]/mi.test(parts[0]))) {
    parts = [text.trim()];
  }
  const entries = [];
  for (const part of parts) {
    const lines = part.split('\n');
    const item = {};
    const stableFacts = [];
    let stableMode = false;
    for (const lineRaw of lines) {
      const line = String(lineRaw || '').trim();
      if (!line) continue;
      if (stableMode) {
        if (line.startsWith('- ')) {
          const fact = safeText(line.slice(2));
          if (fact && !/^none$/i.test(fact)) stableFacts.push(fact);
          continue;
        }
        stableMode = false;
      }
      const parsed = parseLabelValue(line);
      if (!parsed) continue;
      const { label, value } = parsed;
      if (label === 'STABLE') {
        stableMode = true;
        if (value && !/^none$/i.test(value)) stableFacts.push(value);
        continue;
      }
      if (label === 'SLICE_IDS') item.slice_ids = value.split('|').map((v) => safeText(v)).filter(Boolean);
      else if (label === 'TYPE') item.anchor_type = safeText(value).toLowerCase();
      else if (label === 'NAME') item.canonical_name = value;
      else if (label === 'TRUNK') item.trunk = /^none$/i.test(value) ? '' : value;
      else if (label === 'OWNER') item.slot_owner_hint = /^none$/i.test(value) ? '' : value;
      else if (label === 'SLOT') item.secondary_slot = /^none$/i.test(value) ? '' : value;
      else if (label === 'PATH') item.slot_path = /^none$/i.test(value) ? '' : value;
      else if (label === 'UPDATE') item.recent_updates = /^none$/i.test(value) ? [] : value;
      else if (label === 'CONFLICT') item.conflict_hint = !/^none$/i.test(value);
    }
    item.stable_facts = stableFacts.slice(0, 5);
    if (Array.isArray(item.slice_ids) && item.slice_ids.length && safeText(item.anchor_type) && safeText(item.canonical_name)) {
      item.first_seen_at = '';
      item.last_seen_at = '';
      if (item.recent_updates === undefined) item.recent_updates = [];
      if (item.conflict_hint === undefined) item.conflict_hint = false;
      entries.push(item);
    }
  }
  return entries;
}

export function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}

  const startChars = ['{', '['];
  for (let i = 0; i < text.length; i += 1) {
    if (!startChars.includes(text[i])) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      if (ch === '}' || ch === ']') depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(i, j + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

export function summarizeTask(task = {}) {
  const slices = Array.isArray(task?.slices) ? task.slices : [];
  return {
    batch_id: safeText(task.batch_id),
    slice_count: slices.length,
    total_chars: slices.reduce((sum, slice) => sum + Number(slice.char_count || 0), 0),
    previews: slices.slice(0, 3).map((slice) => ({
      slice_id: slice.slice_id,
      title: slice.title,
      preview: previewText(slice.text)
    }))
  };
}
