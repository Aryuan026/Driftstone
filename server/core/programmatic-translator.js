import { readFile } from 'fs/promises';
import { loadLatestTranslationPacket, loadTranslationPacketByFile } from './translation-store.js';
import { buildMemoryScope } from './scope-contract.js';
import { applyTranslationEntries } from './memory-translation-service.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function uniqueStrings(values, limit = 24) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function previewText(text, limit = 160) {
  const value = safeText(text).replace(/\s+/g, ' ');
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function normalizeFactText(text) {
  return safeText(text)
    .replace(/\s+/g, ' ')
    .replace(/^[\-•]\s*/, '')
    .replace(/^用户(?:希望|喜欢|偏好)/, (m) => m)
    .trim();
}

function parseChatRows(text) {
  return String(text || '')
    .split('\n')
    .map((line) => {
      const match = line.match(/^\[(?<thread>[^\]]+)\]\s+(?<role>user|assistant|tool):\s*(?<content>.*)$/u);
      if (!match) {
        return {
          role: 'text',
          content: safeText(line)
        };
      }
      return {
        role: safeText(match.groups?.role),
        content: safeText(match.groups?.content),
        thread: safeText(match.groups?.thread)
      };
    })
    .filter((row) => row.content);
}

async function loadSliceText(slice = {}) {
  if (safeText(slice?.text)) return safeText(slice.text);
  if (!safeText(slice?.file)) return '';
  try {
    const raw = await readFile(slice.file, 'utf-8');
    const parsed = JSON.parse(raw);
    return safeText(parsed?.text || '');
  } catch {
    return '';
  }
}

function normalizeCandidateName(rawName, fullText = '') {
  const cleaned = safeText(rawName)
    .replace(/[*`"'“”‘’（）()]/g, '')
    .replace(/[，。！？,.!?:：].*$/u, '')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length === 1 && /[\p{Script=Han}]/u.test(cleaned)) {
    const aliased = `阿${cleaned}`;
    if (fullText.includes(aliased)) return aliased;
  }
  return cleaned;
}

function inferUserName(rows) {
  const fullText = rows.map((row) => row.content).join('\n');
  const patterns = [
    /用户希望AI称呼其为[“"]([^”"]{1,12})[”"]/u,
    /用户希望AI称呼其为([^，。！？\s]{1,8})/u,
    /不如你叫我([^，。！？\s]{1,8})/u,
    /你叫我([^，。！？\s]{1,8})/u
  ];
  const hits = [];
  for (const row of rows) {
    for (const pattern of patterns) {
      const match = row.content.match(pattern);
      if (!match) continue;
      const name = normalizeCandidateName(match[1], fullText);
      if (name) hits.push(name);
    }
  }
  return hits.length ? hits[hits.length - 1] : '用户';
}

function inferAssistantName(rows) {
  const fullText = rows.map((row) => row.content).join('\n');
  const patterns = [
    /我想叫(?:\*\*)?[“"]?([^”"\n]{1,12})/u,
    /你可以直接叫我([^，。！？\s]{1,8})/u,
    /我想叫\*\*“([^”]{1,8})”/u
  ];
  const hits = [];
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    for (const pattern of patterns) {
      const match = row.content.match(pattern);
      if (!match) continue;
      const name = normalizeCandidateName(match[1], fullText);
      if (name) hits.push(name);
    }
  }
  return hits.length ? hits[hits.length - 1] : '';
}

function isUserMemorySummary(row) {
  if (row.role !== 'assistant') return false;
  if (!row.content.startsWith('用户')) return false;
  if (row.content.length > 180) return false;
  if (/[？?]$/.test(row.content)) return false;
  return /(用户是|用户希望|用户喜欢|用户偏好|用户曾|用户最近|用户不会|用户更|用户对|用户与AI|用户沟通风格|用户曾在)/u.test(row.content);
}

function classifyUserSlot(content) {
  if (/(称呼|名字|起名|多个名字|用作账号昵称|笔名)/u.test(content)) return '名字与别名';
  if (/(同事|家人|父亲|母亲|弟弟|妹妹)/u.test(content)) return '关系与周边';
  if (/(工作|协作|项目|写作|整理|故事|剧情)/u.test(content)) return '工作与协作';
  return '偏好与价值观';
}

function isRuleLine(row) {
  if (row.role !== 'user') return false;
  const text = row.content;
  return (
    /我希望你/u.test(text) ||
    /我不会对你进行主观塑造/u.test(text) ||
    /如果你察觉/u.test(text) ||
    /在我们对话框结束之前/u.test(text) ||
    /保留独立性/u.test(text) ||
    /提示我交流即将受限/u.test(text)
  );
}

function classifyRuleSlot(content) {
  if (/(写日记|更新人设|记忆|窗口|受限|带到新的对话框)/u.test(content)) return '记忆治理';
  if (/(故事|剧情|整理|协助|干活|写作)/u.test(content)) return '协作与写作';
  return '互动方式';
}

function pushGroupedFact(groups, {
  key,
  anchor_type,
  canonical_name,
  trunk,
  secondary_slot,
  slot_owner_hint,
  fact,
  slice,
  source_kind
}) {
  const factText = normalizeFactText(fact);
  if (!factText) return;
  const mapKey = `${anchor_type}::${canonical_name}::${secondary_slot}`;
  if (!groups.has(mapKey)) {
    groups.set(mapKey, {
      key: key || mapKey,
      anchor_type,
      canonical_name,
      trunk,
      secondary_slot,
      slot_owner_hint,
      slice_ids: [],
      stable_facts: [],
      first_seen_at: '',
      last_seen_at: '',
      source_kind: safeText(source_kind || 'programmatic_translation')
    });
  }
  const group = groups.get(mapKey);
  group.slice_ids.push(slice.slice_id);
  group.stable_facts.push(factText);
  const createdAt = safeText(slice.created_at);
  if (!group.first_seen_at || createdAt < group.first_seen_at) group.first_seen_at = createdAt;
  if (!group.last_seen_at || createdAt > group.last_seen_at) group.last_seen_at = createdAt;
}

export async function buildProgrammaticEntriesFromSlices(slicesInput = []) {
  const slices = Array.isArray(slicesInput) ? slicesInput : [];
  const hydratedSlices = [];
  const rowsBySlice = new Map();
  const allRows = [];
  for (const slice of slices) {
    const text = await loadSliceText(slice);
    const hydrated = {
      ...slice,
      text
    };
    hydratedSlices.push(hydrated);
    const rows = parseChatRows(text);
    rowsBySlice.set(slice.slice_id, rows);
    allRows.push(...rows);
  }

  const userName = inferUserName(allRows);
  const assistantName = inferAssistantName(allRows);
  const groups = new Map();

  for (const slice of hydratedSlices) {
    const rows = rowsBySlice.get(slice.slice_id) || [];
    for (const row of rows) {
      if (isUserMemorySummary(row)) {
        pushGroupedFact(groups, {
          anchor_type: 'person',
          canonical_name: userName,
          trunk: '人物',
          secondary_slot: classifyUserSlot(row.content),
          slot_owner_hint: userName,
          fact: row.content,
          slice,
          source_kind: 'programmatic_translation'
        });
      }

      if (assistantName && row.role === 'assistant' && /(我想叫|你可以直接叫我)/u.test(row.content)) {
        pushGroupedFact(groups, {
          anchor_type: 'person',
          canonical_name: assistantName,
          trunk: '人物',
          secondary_slot: '名字与别名',
          slot_owner_hint: assistantName,
          fact: `当前对话中 AI 自选名字为${assistantName}。`,
          slice,
          source_kind: 'programmatic_translation'
        });
      }

      if (isRuleLine(row)) {
        pushGroupedFact(groups, {
          anchor_type: 'rule',
          canonical_name: '对话规则与偏好',
          trunk: '规则',
          secondary_slot: classifyRuleSlot(row.content),
          slot_owner_hint: userName,
          fact: row.content,
          slice,
          source_kind: 'programmatic_translation'
        });
      }
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      slice_ids: uniqueStrings(group.slice_ids, 48),
      anchor_type: group.anchor_type,
      canonical_name: group.canonical_name,
      trunk: group.trunk,
      secondary_slot: group.secondary_slot,
      slot_path: `${group.trunk}/${group.canonical_name}/${group.secondary_slot}`,
      slot_owner_hint: group.slot_owner_hint,
      stable_facts: uniqueStrings(group.stable_facts, 12),
      recent_updates: [],
      first_seen_at: group.first_seen_at,
      last_seen_at: group.last_seen_at,
      conflict_hint: false
    }))
    .filter((entry) => entry.stable_facts.length > 0);
}

async function buildEntriesFromSlices(packet) {
  return buildProgrammaticEntriesFromSlices(Array.isArray(packet?.slices) ? packet.slices : []);
}

async function resolveTranslationPacket(body = {}) {
  if (safeText(body.packet_file)) {
    return {
      packetFile: body.packet_file,
      packet: await loadTranslationPacketByFile(body.packet_file)
    };
  }
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const latest = await loadLatestTranslationPacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id
  });
  return {
    packetFile: latest.packetFile,
    packet: latest.packet
  };
}

export async function runProgrammaticTranslation(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const { packet, packetFile } = await resolveTranslationPacket(body);
  const entries = await buildEntriesFromSlices(packet);
  const response = {
    ok: true,
    schema: 'hippocove_programmatic_translation_v0.1',
    scope: {
      ...scope,
      isolation_stage: 'translation_packet'
    },
    packet_file: packetFile,
    translator: {
      strategy: 'programmatic_v0.1',
      packet_id: safeText(packet?.packet_id),
      slice_count: Number(packet?.summary?.slice_count || 0),
      candidate_entries: entries.length,
      note: '这一版只吃特别明确的记忆句，不和 AI 抢模糊判断。'
    },
    sample_entries: entries.slice(0, 12),
    entries
  };

  if (!body?.apply) return response;

  const writeback = await applyTranslationEntries({
    packet_file: packetFile,
    scope: {
      owner_id: scope.owner_id || packet?.scope?.owner_id || '',
      realm_id: scope.realm_id || packet?.scope?.realm_id || 'default',
      bot_id: scope.bot_id || packet?.scope?.bot_id || ''
    },
    source: {
      label: safeText(body?.source?.label || `${safeText(packet?.source?.label || packet?.packet_id)}__programmatic`)
    },
    entries
  });

  return {
    ...response,
    scope: writeback.scope,
    writeback
  };
}

export function summarizeProgrammaticEntries(entries = []) {
  const bucket = {
    person: 0,
    thing: 0,
    event: 0,
    rule: 0
  };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (bucket[entry.anchor_type] !== undefined) bucket[entry.anchor_type] += 1;
  }
  return bucket;
}
