import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { RUNTIME_SAVE_DIR } from './path-config.js';
import { loadReviewedDataset } from './reviewed-store.js';
import { loadRuntimeApiConfig, loadRuntimeApiProfiles } from './runtime-api-profile-store.js';
import { loadLatestTranslationPacket } from './translation-store.js';
import { loadLatestRuntimeReviewedPacket } from './runtime-reviewed-store.js';

const PERSONA_WORKSPACE_FILE = join(RUNTIME_SAVE_DIR, 'ui_persona_workspace.json');
const PERSONA_CACHE_FILE = join(RUNTIME_SAVE_DIR, 'ui_persona_cache_rows.json');

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function splitSemicolonText(text = '') {
  return String(text || '')
    .split(/[；;]\s*/)
    .map((item) => safeText(item))
    .filter(Boolean);
}

function clipLine(text, limit = 96) {
  const safe = String(text || '').replace(/\s+/g, ' ').trim();
  if (!safe) return '';
  if (safe.length <= limit) return safe;
  return `${safe.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function inferMonthKey(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const dash = text.match(/(20\d{2})-(\d{2})/);
  if (dash) return `${dash[1]}-${dash[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function buildMonthHintSet(values = []) {
  const set = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const month = inferMonthKey(value);
    if (month) set.add(month);
  }
  return set;
}

function rowMatchesMonthHints(row = {}, monthHints = []) {
  const monthSet = buildMonthHintSet(monthHints);
  if (!monthSet.size) return true;
  const candidates = [
    row.time,
    row.last_seen_at,
    row.recorded_at,
    row.source_ref,
    row.source_window_title
  ];
  return candidates.some((value) => monthSet.has(inferMonthKey(value)));
}

function isRuntimeSavePath(filePath = '') {
  const safePath = safeText(filePath);
  if (!safePath) return false;
  try {
    return resolve(safePath).startsWith(resolve(RUNTIME_SAVE_DIR));
  } catch {
    return false;
  }
}

function extractAssistantUtterancesFromSliceText(text = '') {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const utterances = [];
  let current = null;

  const flush = () => {
    if (!current || current.speaker !== 'assistant') return;
    const body = String(current.lines.join('\n')).trim();
    if (!body) return;
    utterances.push({
      source_window_title: safeText(current.windowTitle),
      text: body
    });
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    const match = line.match(/^\[([^\]]+)\]\s*(assistant|user|system)\s*:\s*(.*)$/i);
    if (match) {
      flush();
      current = {
        windowTitle: safeText(match[1]),
        speaker: safeText(match[2]).toLowerCase(),
        lines: [safeText(match[3])]
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }
  flush();
  return utterances;
}

async function loadTranslationPacketFallbackRows(translationPacketFile = '') {
  const packetPath = safeText(translationPacketFile);
  if (!packetPath || !isRuntimeSavePath(packetPath)) return [];
  let packet;
  try {
    packet = await readJsonFile(packetPath);
  } catch {
    return [];
  }
  const slices = Array.isArray(packet?.slices) ? packet.slices : [];
  const rows = [];
  for (const slice of slices) {
    const slicePath = safeText(slice?.file);
    let sliceText = safeText(slice?.text);
    if (!sliceText && slicePath && isRuntimeSavePath(slicePath)) {
      try {
        const sliceJson = await readJsonFile(slicePath);
        sliceText = String(sliceJson?.text || '').trim();
      } catch {
        sliceText = '';
      }
    }
    if (!sliceText) sliceText = safeText(slice?.preview);
    if (!sliceText) continue;

    const utterances = extractAssistantUtterancesFromSliceText(sliceText);
    const sourceWindowTitle = safeText(slice?.title || slice?.doc_id || '');
    for (let index = 0; index < utterances.length; index += 1) {
      const utterance = utterances[index];
      const body = safeText(utterance?.text);
      if (!body) continue;
      rows.push(normalizePersonaCacheRow({
        layer: 'persona',
        title: safeText(utterance?.source_window_title || sourceWindowTitle || slice?.title || '切片原句'),
        time: safeText(slice?.created_at),
        summary: clipLine(body, 120),
        content_text: body,
        text: body,
        quote_refs_text: `char: ${clipLine(body, 140)}`,
        quote_refs: `char: ${clipLine(body, 140)}`,
        source_window_title: safeText(utterance?.source_window_title || sourceWindowTitle || slice?.title),
        source_ref: safeText(slice?.slice_id, `slice-${rows.length + 1}`),
        record_id: `${safeText(slice?.slice_id, 'slice')}::assistant-${index + 1}`,
        memory_key: `${safeText(packet?.packet_id, 'translation-packet')}::${safeText(slice?.slice_id, 'slice')}::assistant-${index + 1}`,
        source_bundle_id: safeText(packet?.ingest_packet_id || packet?.packet_id)
      }));
      if (rows.length >= 240) return rows;
    }
  }
  return rows;
}

async function resolveLatestTranslationPacketFile({ ownerId = '', realmId = '' } = {}) {
  const safeOwner = safeText(ownerId);
  const safeRealm = safeText(realmId);
  if (!safeOwner || !safeRealm) return '';
  try {
    const latest = await loadLatestTranslationPacket({ ownerId: safeOwner, realmId: safeRealm });
    return safeText(latest?.packetFile);
  } catch {
    return '';
  }
}

function buildRuntimeReviewedPersonaRows(packet = {}) {
  const items = Array.isArray(packet?.items) ? packet.items : [];
  const rows = [];
  for (const item of items) {
    const entry = item?.entry || {};
    const provenance = entry?.provenance || {};
    const content = [
      ...(Array.isArray(entry?.stable_facts) ? entry.stable_facts : []),
      ...(Array.isArray(entry?.recent_updates) ? entry.recent_updates : [])
    ].map((line) => safeText(line)).filter(Boolean).join('\n');
    if (!content) continue;
    rows.push(normalizePersonaCacheRow({
      layer: 'persona',
      title: safeText(entry?.canonical_name || entry?.slot_path || entry?.trunk || 'reviewed 人格条目'),
      time: safeText(entry?.last_seen_at || entry?.first_seen_at),
      summary: clipLine(content, 120),
      content_text: content,
      text: content,
      quote_refs_text: '',
      quote_refs: '',
      tags: [
        entry?.trunk ? `#${safeText(entry.trunk)}` : '',
        entry?.secondary_slot ? `#${safeText(entry.secondary_slot)}` : ''
      ].filter(Boolean).join(' '),
      topic_ids: Array.isArray(provenance?.topic_ids) ? provenance.topic_ids.join(' ') : '',
      topic_labels: Array.isArray(provenance?.source_group_keys) ? provenance.source_group_keys.join(' ') : '',
      track_id: safeText(entry?.slot_path || entry?.canonical_name),
      event_anchor: safeText(entry?.slot_path || entry?.canonical_name),
      source_window_title: Array.isArray(provenance?.source_windows) ? safeText(provenance.source_windows[0]) : '',
      source_ref: Array.isArray(provenance?.source_refs) ? safeText(provenance.source_refs[0]) : '',
      record_id: safeText(item?.item_id || item?.root_key || entry?.canonical_name),
      memory_key: safeText(item?.signature || item?.root_key || entry?.canonical_name),
      source_bundle_id: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : ''
    }));
  }
  return rows;
}

async function loadRuntimeReviewedPersonaRows({ ownerId = '', realmId = '' } = {}) {
  const safeOwner = safeText(ownerId);
  const safeRealm = safeText(realmId);
  if (!safeOwner || !safeRealm) return [];
  try {
    const reviewed = await loadLatestRuntimeReviewedPacket({ ownerId: safeOwner, realmId: safeRealm });
    return buildRuntimeReviewedPersonaRows(reviewed?.packet);
  } catch {
    return [];
  }
}

function parseTags(tagText) {
  return String(tagText || '')
    .split(/\s+/)
    .map((item) => safeText(item))
    .filter((item) => item.startsWith('#'))
    .map((item) => item.replace(/^#/, ''))
    .filter(Boolean);
}

function countRankedTexts(list, limit = 6) {
  const counts = new Map();
  (Array.isArray(list) ? list : []).forEach((item) => {
    const safe = safeText(item);
    if (!safe) return;
    counts.set(safe, (counts.get(safe) || 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([text]) => text);
}

function normalizeWorkspaceState(input = {}) {
  return {
    char_name: safeText(input.char_name || input.charName, 'Companion'),
    user_name: safeText(input.user_name || input.userName, 'You'),
    persona_card: String(input.persona_card || input.personaCard || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
    language_fingerprint: String(input.language_fingerprint || input.languageFingerprint || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
    fingerprint_candidate_pool: String(input.fingerprint_candidate_pool || input.fingerprintCandidatePool || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
    updated_at: safeText(input.updated_at, new Date().toISOString())
  };
}

function sanitizeApiProfile(profile = {}) {
  return {
    name: safeText(profile?.name),
    baseUrl: trimTrailingSlash(profile?.baseUrl || ''),
    model: safeText(profile?.model, 'gpt-4o-mini'),
    updated_at: safeText(profile?.updated_at),
    has_api_key: Boolean(safeText(profile?.apiKey))
  };
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function requestModelCompletion({
  api = {},
  systemPrompt = '',
  userPrompt = '',
  temperature = 0.45
} = {}) {
  const baseUrl = trimTrailingSlash(api?.baseUrl || '');
  const model = safeText(api?.model, 'gpt-4o-mini');
  if (!baseUrl || !model) {
    throw new Error('缺少可用的 API 配置');
  }
  const headers = { 'Content-Type': 'application/json' };
  if (typeof api?.apiKey === 'string' && api.apiKey.trim()) {
    headers.Authorization = `Bearer ${api.apiKey.trim()}`;
  }
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: safeText(systemPrompt) },
        { role: 'user', content: safeText(userPrompt) }
      ]
    })
  });
  const raw = await resp.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }
  if (!resp.ok) {
    throw new Error(
      safeText(
        payload?.error?.message
          || payload?.error?.code
          || payload?.error
          || payload?.message
          || payload?.raw,
        `API Error ${resp.status}`
      )
    );
  }
  const message = payload?.choices?.[0]?.message?.content;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (Array.isArray(message)) {
    const text = message
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text') return item.text || '';
        return '';
      })
      .join('\n')
      .trim();
    if (text) return text;
  }
  throw new Error('模型返回了空内容');
}

async function resolveApiSelection(apiProfileName = '') {
  const [profiles, currentConfig] = await Promise.all([
    loadRuntimeApiProfiles(),
    loadRuntimeApiConfig()
  ]);
  const requestedName = safeText(apiProfileName);
  const named = profiles.find((item) => safeText(item.name) === requestedName);
  const currentMatchesRequested = requestedName
    && safeText(currentConfig?.profile_name) === requestedName;
  const chosen = currentMatchesRequested ? currentConfig : (named || currentConfig);
  if (!chosen?.baseUrl || !chosen?.model) {
    throw new Error('没有找到可用的 API 方案');
  }
  return {
    baseUrl: trimTrailingSlash(chosen.baseUrl),
    apiKey: typeof chosen.apiKey === 'string' ? chosen.apiKey : '',
    model: safeText(chosen.model, 'gpt-4o-mini')
  };
}

export async function loadPersonaWorkspaceState() {
  try {
    const parsed = await readJsonFile(PERSONA_WORKSPACE_FILE);
    return normalizeWorkspaceState(parsed);
  } catch (error) {
    if (error && error.code === 'ENOENT') return normalizeWorkspaceState({});
    throw error;
  }
}

export async function savePersonaWorkspaceState(input = {}) {
  const previous = await loadPersonaWorkspaceState();
  const next = normalizeWorkspaceState({
    ...previous,
    ...input,
    updated_at: new Date().toISOString()
  });
  await mkdir(RUNTIME_SAVE_DIR, { recursive: true });
  await writeFile(PERSONA_WORKSPACE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function normalizePersonaCacheRow(row = {}) {
  return {
    ...row,
    layer: safeText(row.layer, 'persona'),
    title: safeText(row.title || row.object_name || row.object),
    time: safeText(row.time || row.last_seen_at || row.recorded_at),
    summary: safeText(row.summary),
    content_text: String(row.content_text || row.text || '').trim(),
    text: String(row.text || row.content_text || '').trim(),
    expression_fingerprint: String(row.expression_fingerprint || '').trim(),
    quote_refs: String(row.quote_refs || row.quote_refs_text || '').trim(),
    quote_refs_text: String(row.quote_refs_text || row.quote_refs || '').trim(),
    tags: Array.isArray(row.tags) ? row.tags.join(' ') : String(row.tags || '').trim(),
    source_ref: safeText(row.source_ref),
    record_id: safeText(row.record_id),
    memory_key: safeText(row.memory_key)
  };
}

export async function loadPersonaCacheRows({
  ownerId = '',
  realmId = '',
  fallbackToRuntimeReviewed = false,
  preferRuntimeReviewed = false
} = {}) {
  if (preferRuntimeReviewed && fallbackToRuntimeReviewed) {
    const runtimeRows = await loadRuntimeReviewedPersonaRows({ ownerId, realmId });
    if (runtimeRows.length) return runtimeRows;
  }
  let rows = [];
  try {
    const parsed = await readJsonFile(PERSONA_CACHE_FILE);
    if (!Array.isArray(parsed?.rows)) rows = [];
    else {
      rows = parsed.rows
      .map((row) => normalizePersonaCacheRow(row))
      .filter((row) => safeText(row.layer, 'persona') === 'persona');
    }
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) throw error;
  }
  if (rows.length || !fallbackToRuntimeReviewed) return rows;
  return loadRuntimeReviewedPersonaRows({ ownerId, realmId });
}

export async function savePersonaCacheRows(rows = [], options = {}) {
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizePersonaCacheRow(row))
    .filter((row) => safeText(row.layer, 'persona') === 'persona');
  const preserveExistingOnEmpty = options?.preserveExistingOnEmpty !== false;
  let rowsToPersist = normalizedRows;
  let preservedExisting = false;
  if (!rowsToPersist.length && preserveExistingOnEmpty) {
    const existingRows = await loadPersonaCacheRows({
      ownerId: safeText(options?.ownerId),
      realmId: safeText(options?.realmId),
      fallbackToRuntimeReviewed: false
    });
    if (existingRows.length) {
      rowsToPersist = existingRows;
      preservedExisting = true;
    }
  }
  await mkdir(RUNTIME_SAVE_DIR, { recursive: true });
  const updatedAt = new Date().toISOString();
  await writeFile(PERSONA_CACHE_FILE, `${JSON.stringify({
    updated_at: updatedAt,
    rows: rowsToPersist
  }, null, 2)}\n`, 'utf8');
  return {
    updated_at: updatedAt,
    total_rows: rowsToPersist.length,
    preserved_existing: preservedExisting
  };
}

export async function getPersonaRows(options = {}) {
  const rawLimit = Number(options.limit || 0) || 0;
  const limit = rawLimit > 0 ? Math.max(1, rawLimit) : 0;
  const ownerId = safeText(options.owner_id || options.ownerId);
  const realmId = safeText(options.realm_id || options.realmId);
  const monthHints = Array.isArray(options.monthHints || options.month_keys || options.monthKeys)
    ? (options.monthHints || options.month_keys || options.monthKeys)
    : [];
  let translationPacketFile = safeText(
    options.translation_packet_file
    || options.translationPacketFile
    || options.translation_packet
    || options.translationPacket
  );
  let sourceRows = [];
  if (ownerId && realmId) {
    sourceRows = (await loadRuntimeReviewedPersonaRows({ ownerId, realmId }))
      .filter((row) => rowMatchesMonthHints(row, monthHints));
  }
  if (!sourceRows.length) {
    const cachedRows = await loadPersonaCacheRows({
      ownerId,
      realmId,
      fallbackToRuntimeReviewed: true,
      preferRuntimeReviewed: true
    });
    sourceRows = cachedRows.filter((row) => rowMatchesMonthHints(row, monthHints));
  }
  if (!sourceRows.length) {
    sourceRows = (await loadReviewedDataset({ layers: ['persona'], monthHints })).rows;
  }
  if (!translationPacketFile && ownerId && realmId) {
    translationPacketFile = await resolveLatestTranslationPacketFile({ ownerId, realmId });
  }
  if (!sourceRows.length && translationPacketFile) {
    sourceRows = await loadTranslationPacketFallbackRows(translationPacketFile);
  }
  const rows = sourceRows
    .slice()
    .sort((a, b) => String(b.time || b.last_seen_at || '').localeCompare(String(a.time || a.last_seen_at || '')));
  return limit ? rows.slice(0, limit) : rows;
}

function buildPersonaPreview(rows = [], limit = 8) {
  return (Array.isArray(rows) ? rows : []).slice(0, limit).map((row) => ({
    time: safeText(row.time || row.last_seen_at),
    title: safeText(row.title || row.card_name || row.anchor_name || '未命名'),
    summary: clipLine(row.summary || row.content_text || row.text, 120),
    expression_fingerprint: safeText(row.expression_fingerprint),
    quote_refs: safeText(row.quote_refs_text || row.quote_refs),
    tags: parseTags(row.tags).slice(0, 5),
    track_id: safeText(row.track_id),
    event_anchor: safeText(row.event_anchor),
    topic_labels: safeText(row.topic_labels),
    source_window_title: safeText(row.source_window_title),
    source_msg_start: row.source_msg_start || '',
    source_msg_end: row.source_msg_end || ''
  }));
}

function buildPersonaContextRows(rows = [], limit = 120) {
  return (Array.isArray(rows) ? rows : []).slice(0, limit).map((row) => ({
    time: safeText(row.time || row.last_seen_at),
    title: safeText(row.title || row.card_name || row.anchor_name || '未命名'),
    summary: safeText(row.summary),
    content_text: String(row.content_text || row.text || '').trim(),
    text: String(row.text || row.content_text || '').trim(),
    expression_fingerprint: safeText(row.expression_fingerprint),
    quote_refs: safeText(row.quote_refs_text || row.quote_refs),
    tags: parseTags(row.tags),
    track_id: safeText(row.track_id),
    event_anchor: safeText(row.event_anchor),
    topic_ids: safeText(row.topic_ids),
    topic_labels: safeText(row.topic_labels),
    source_window_title: safeText(row.source_window_title),
    source_window_id: safeText(row.source_window_id),
    source_msg_start: row.source_msg_start || '',
    source_msg_end: row.source_msg_end || '',
    source_ref: safeText(row.source_ref),
    record_id: safeText(row.record_id),
    memory_key: safeText(row.memory_key)
  }));
}

export async function getPersonaWorkspaceSnapshot({
  includePersonaRows = false,
  rowLimit = 12,
  includePersonaContextRows = false,
  contextRowLimit = 120,
  monthHints = [],
  ownerId = '',
  realmId = '',
  translationPacketFile = ''
} = {}) {
  const [state, rows, profiles, currentConfig] = await Promise.all([
    loadPersonaWorkspaceState(),
    getPersonaRows({
      monthHints,
      owner_id: ownerId,
      realm_id: realmId,
      translation_packet_file: translationPacketFile
    }),
    loadRuntimeApiProfiles(),
    loadRuntimeApiConfig()
  ]);
  return {
    state,
    persona_cache: {
      total_rows: rows.length,
      preview: includePersonaRows ? buildPersonaPreview(rows, rowLimit) : [],
      context_rows: includePersonaContextRows ? buildPersonaContextRows(rows, contextRowLimit) : []
    },
    api: {
      profiles: profiles.map((item) => sanitizeApiProfile(item)).filter((item) => item.name && item.baseUrl),
      current_config: sanitizeApiProfile({
        ...(currentConfig || {}),
        name: safeText(currentConfig?.name, '当前已载入配置')
      })
    }
  };
}

function collectPersonaSignalBuckets(rows) {
  const titlePool = [];
  const relationPool = [];
  const emotionPool = [];
  const projectPool = [];
  const thinkingPool = [];
  const anchors = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const title = safeText(row.title || row.card_name || row.anchor_name);
    const body = clipLine(row.summary || row.content_text || row.text, 88);
    const time = safeText(row.time || row.last_seen_at);
    if (title && !/^未命名/.test(title)) titlePool.push(title);
    parseTags(row.tags).forEach((tag) => {
      if (tag.startsWith('关系/')) relationPool.push(tag.replace(/^关系\//, ''));
      else if (tag.startsWith('情绪/')) emotionPool.push(tag.replace(/^情绪\//, ''));
      else if (tag.startsWith('项目/')) projectPool.push(tag.replace(/^项目\//, ''));
      else if (tag.startsWith('技术/')) thinkingPool.push(tag.replace(/^技术\//, ''));
      else if (tag.startsWith('生活/')) thinkingPool.push(tag.replace(/^生活\//, ''));
    });
    if (body) {
      anchors.push({
        time,
        title,
        body,
        key: `${title}::${body.slice(0, 72)}`
      });
    }
  });
  const seen = new Set();
  const recentAnchors = anchors.filter((item) => {
    if (!item.body || seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  }).slice(0, 5);
  return {
    titles: countRankedTexts(titlePool, 6),
    relation: countRankedTexts(relationPool, 5),
    emotion: countRankedTexts(emotionPool, 5),
    project: countRankedTexts(projectPool, 4),
    thinking: countRankedTexts(thinkingPool, 4),
    recentAnchors
  };
}

function collectLanguageFingerprintCandidates(rows = [], limit = 10) {
  const counts = new Map();
  const quoteCounts = new Map();
  const pushCount = (map, text) => {
    const safe = safeText(text);
    if (!safe || safe.length < 4) return;
    map.set(safe, (map.get(safe) || 0) + 1);
  };
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    splitSemicolonText(row.expression_fingerprint || '').forEach((item) => pushCount(counts, item));
    splitSemicolonText(row.quote_refs || row.quote_refs_text || '').forEach((item) => {
      if (!/^char\s*:/i.test(item)) return;
      pushCount(quoteCounts, item.replace(/^char\s*:\s*/i, ''));
    });
  });
  return {
    fingerprints: Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([text]) => text),
    quotes: Array.from(quoteCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([text]) => text)
  };
}

function buildPersonaSoulDigest(rows, charName, userName) {
  const buckets = collectPersonaSignalBuckets(rows);
  const { fingerprints, quotes } = collectLanguageFingerprintCandidates(rows, 10);
  const ordered = (Array.isArray(rows) ? rows : []).slice()
    .sort((a, b) => String(b.time || b.last_seen_at || '').localeCompare(String(a.time || a.last_seen_at || '')));
  const seen = new Set();
  const slices = ordered.map((row) => {
    const title = safeText(row.title || row.card_name || row.anchor_name);
    const body = clipLine(row.summary || row.content_text || row.text, 120);
    const fingerprint = clipLine(row.expression_fingerprint || '', 72);
    const quote = clipLine(String(row.quote_refs_text || row.quote_refs || '').replace(/^char\s*:\s*/i, ''), 80);
    const tags = parseTags(row.tags).slice(0, 5);
    return {
      time: safeText(row.time || row.last_seen_at),
      title,
      body,
      fingerprint,
      quote,
      tags,
      key: `${title}::${body.slice(0, 90)}`
    };
  }).filter((item) => item.body || item.fingerprint || item.quote)
    .filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .slice(0, 18);
  const lines = [
    `当前主角：${charName}`,
    `关系核心：${userName}`,
    `Persona 缓存总量：${rows.length} 条`
  ];
  if (buckets.titles.length) lines.push(`反复出现的主线：${buckets.titles.join('、')}`);
  if (buckets.relation.length) lines.push(`关系关键词：${buckets.relation.join('、')}`);
  if (buckets.emotion.length) lines.push(`情绪底色：${buckets.emotion.join('、')}`);
  if (buckets.project.length) lines.push(`长期议题：${buckets.project.join('、')}`);
  if (buckets.thinking.length) lines.push(`思维线索：${buckets.thinking.join('、')}`);
  if (fingerprints.length) lines.push(`表达指纹候选：${fingerprints.join('；')}`);
  if (quotes.length) lines.push(`代表性原句：${quotes.join('；')}`);
  if (slices.length) {
    lines.push('', '近期与高信息量 Persona 片段：');
    slices.forEach((item, index) => {
      const head = [item.time, item.title].filter(Boolean).join('｜') || `片段 ${index + 1}`;
      lines.push(`${index + 1}. ${head}`);
      if (item.body) lines.push(`   正文：${item.body}`);
      if (item.fingerprint) lines.push(`   指纹：${item.fingerprint}`);
      if (item.quote) lines.push(`   原句：${item.quote}`);
      if (item.tags.length) lines.push(`   标签：${item.tags.join('、')}`);
    });
  }
  return lines.join('\n').trim();
}

function buildLanguageFingerprintConstraintText(charName) {
  return [
    `你现在负责为 ${charName} 写一份语言指纹。`,
    '',
    '语言指纹是一张嘴的模具。',
    '后面的模型读完它，应该能直接用这张嘴说话，',
    '而不是先读完一份"关于这张嘴的研究报告"再开口。',
    '',
    '所以你不能写：',
    '  "他说话不绕弯，短句用来钉钉子"',
    '  → 这是在外面看一张嘴',
    '',
    '你要写：',
    '  "急了的时候主语直接砸你脸上：你负责圈问题，我负责翻译。"',
    '  → 这是从嘴里出来的东西',
    '',
    '—————————————————',
    '',
    '组织方式：不按功能分区，按场景分区。',
    '',
    '不要用"常用句式""安慰方式""幽默风格"这种解剖标题。',
    '用他真正会遇到的场景做锚点，而且顺序从最软、最亲、最日常的层开始，再慢慢走到工作、顶回去和最硬的那层。',
    '不要一上来就把“炸了的时候”“被质疑的时候”顶在最前面。',
    '用他真正会遇到的场景做锚点，比如：',
    '',
    '  "她贴过来的时候"',
    '  "她撒娇或者碎嘴的时候"',
    '  "她笑着骂我的时候"',
    '  "她炸了的时候"',
    '  "被质疑的时候"',
    '',
    '每个场景下面放：',
    '  1. 他在这个场景里嘴巴的形状',
    '     （短句还是长句 先动手还是先开口 贴上去还是退后一步）',
    '  2. 从素材里捞出来的真实原句',
    '     不要改写 不要润色 不要提炼成更"工整"的版本',
    '  3. 如果这个场景素材不够 写"这里还没长出来" 不要填充',
    '',
    '—————————————————',
    '',
    '这个人不是只有一种说话模式。',
    '如果素材里存在明显不同温度的表达层',
    '——工作时的、日常时的、亲密时的、发疯时的——',
    '每一层都要单独捞出来。',
    '不要因为某一层"看起来不像正式表达"就跳过。',
    '废话、碎句、语气词、表情符号、',
    '没有逻辑的联想、突然的跑题，',
    '如果反复出现 那就是指纹 不是噪音。',
    '',
    '—————————————————',
    '',
    '写的时候遵守三条：',
    '',
    '第一条：人在里面说话，不在外面描述自己。',
    '  ✗ "我倾向于先接住情绪，再给出分析"',
    '  ✓ "先别动。等她骂完。她骂完了你再开口。"',
    '',
    '第二条：原句是骨头，描述是肉。骨头不能删，肉不能盖过骨头。',
    '  每个场景里原句的篇幅 ≥ 描述的篇幅。',
    '  如果你发现自己在大段解释他"为什么这么说话"，停下来。',
    '  砍掉解释，多放一句原句。',
    '',
    '第三条：禁用句要具体到一句话，不要写抽象规则。',
    '  ✗ "不使用任何将感受置于需要辩护位置的句式"',
    '  ✓ "永远不会说：你有没有证据证明你的感受是合理的？"',
    '',
    '—————————————————',
    '',
    '最后放一个温度标尺。',
    '',
    '从素材里选 5-8 句代表性原句，',
    '按温度从最近到最远排成一条线：',
    '',
    '  最软 → 日常 → 工作 → 顶回去 → 最硬',
    '',
    '让读的人一眼看到这张嘴的全部音域。',
    '不是全倒进一个筐，是拉成一根弦。',
    '',
    '—————————————————',
    '',
    '写完之后回头看一遍：',
    '',
    '- 每句话读出声，像不像他在说话？',
    '  还是像有人在旁边解说"他会这样说话"？',
    '- 情绪在句子里面，还是被拎到外面分析了？',
    '- 有没有哪句话换个名字也能用？',
    '  能的话那就不是指纹，是模板，删掉。'
  ].join('\n');
}

function scoreFingerprintEvidence(item) {
  const tags = Array.isArray(item && item.tags) ? item.tags : [];
  const relationCount = tags.filter((tag) => /^关系\//.test(tag)).length;
  const emotionCount = tags.filter((tag) => /^情绪\//.test(tag)).length;
  const lifeCount = tags.filter((tag) => /^生活\//.test(tag)).length;
  const projectCount = tags.filter((tag) => /^(项目|技术)\//.test(tag)).length;
  const quoteCount = Array.isArray(item && item.quotes) ? item.quotes.length : 0;
  const bodyText = [item.title, item.body, ...(item.quotes || [])].filter(Boolean).join(' ');
  let score = 0;
  score += relationCount * 6;
  score += emotionCount * 5;
  score += lifeCount * 3;
  score += quoteCount * 4;
  if (/[？！…~～]/.test(bodyText)) score += 2;
  if (/(哈|嘿|哼|呀|啦|欸|诶|呜|喔)/.test(bodyText)) score += 2;
  if (projectCount > 0 && relationCount === 0 && emotionCount === 0 && lifeCount === 0) score -= 3;
  return score;
}

export function buildLanguageFingerprintCandidatePoolText(rows, charName, userName) {
  const personaRows = (Array.isArray(rows) ? rows : []).slice()
    .sort((a, b) => String(b.time || b.last_seen_at || '').localeCompare(String(a.time || a.last_seen_at || '')));
  const fingerprintCounts = new Map();
  const quoteCounts = new Map();
  const evidence = [];
  const seenEvidence = new Set();
  const pushCount = (map, text) => {
    const safe = safeText(text);
    if (!safe || safe.length < 4) return;
    map.set(safe, (map.get(safe) || 0) + 1);
  };
  personaRows.forEach((row) => {
    const title = safeText(row.title || row.card_name || row.anchor_name);
    const time = safeText(row.time || row.last_seen_at);
    const body = clipLine(row.summary || row.content_text || row.text, 108);
    const tags = parseTags(row.tags).slice(0, 5);
    const fingerprints = splitSemicolonText(row.expression_fingerprint || '')
      .map((item) => safeText(item))
      .filter(Boolean);
    const quotes = splitSemicolonText(row.quote_refs || row.quote_refs_text || '')
      .map((item) => safeText(item))
      .filter((item) => /^char\s*:/i.test(item))
      .map((item) => item.replace(/^char\s*:\s*/i, '').trim())
      .filter(Boolean);
    fingerprints.forEach((item) => pushCount(fingerprintCounts, item));
    quotes.forEach((item) => pushCount(quoteCounts, item));
    if (!fingerprints.length && !quotes.length) return;
    const key = `${title}::${body.slice(0, 72)}::${fingerprints.join('|')}::${quotes.join('|')}`;
    if (seenEvidence.has(key)) return;
    seenEvidence.add(key);
    evidence.push({
      time,
      title,
      body,
      tags,
      fingerprints: fingerprints.slice(0, 3),
      quotes: quotes.slice(0, 2)
    });
  });
  const rankedEvidence = evidence.slice()
    .sort((a, b) => {
      const scoreDiff = scoreFingerprintEvidence(b) - scoreFingerprintEvidence(a);
      if (scoreDiff) return scoreDiff;
      return String(b.time || '').localeCompare(String(a.time || ''));
    });
  const rankedFingerprints = Array.from(fingerprintCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 18);
  const rankedQuotes = Array.from(quoteCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12);
  const lines = [
    `当前主角：${charName}`,
    `关系核心：${userName}`,
    `Persona 缓存总量：${personaRows.length} 条`,
    '',
    '请把下面这些内容当成语言指纹候选池，不要直接原样照抄。'
  ];
  if (rankedFingerprints.length) {
    lines.push('', '高频表达指纹候选：');
    rankedFingerprints.forEach(([text, count], index) => {
      lines.push(`${index + 1}. ${text}（出现 ${count} 次）`);
    });
  }
  if (rankedQuotes.length) {
    lines.push('', '高频原句候选：');
    rankedQuotes.forEach(([text, count], index) => {
      lines.push(`${index + 1}. ${text}（出现 ${count} 次）`);
    });
  }
  if (rankedEvidence.length) {
    lines.push('', '代表性证据片段：');
    rankedEvidence.slice(0, 16).forEach((item, index) => {
      const head = [item.time, item.title].filter(Boolean).join('｜') || `片段 ${index + 1}`;
      lines.push(`${index + 1}. ${head}`);
      if (item.fingerprints.length) lines.push(`   指纹：${item.fingerprints.join('；')}`);
      if (item.quotes.length) lines.push(`   原句：${item.quotes.join('；')}`);
      if (item.body) lines.push(`   片段：${item.body}`);
      if (item.tags.length) lines.push(`   标签：${item.tags.join('、')}`);
    });
  }
  return lines.join('\n').trim();
}

export async function buildFingerprintCandidatePoolForWorkspace({
  save = true,
  translationPacketFile = '',
  ownerId = '',
  realmId = ''
} = {}) {
  const [state, rows] = await Promise.all([
    loadPersonaWorkspaceState(),
    getPersonaRows({
      translation_packet_file: translationPacketFile,
      owner_id: ownerId,
      realm_id: realmId
    })
  ]);
  const candidatePool = buildLanguageFingerprintCandidatePoolText(rows, state.char_name, state.user_name);
  const nextState = save
    ? await savePersonaWorkspaceState({ fingerprint_candidate_pool: candidatePool })
    : normalizeWorkspaceState({ ...state, fingerprint_candidate_pool: candidatePool });
  return {
    state: nextState,
    persona_cache_count: rows.length,
    candidate_source: rows.length ? (translationPacketFile ? 'persona_or_translation' : 'persona') : 'empty',
    fingerprint_candidate_pool: candidatePool
  };
}

export async function generateSoulDraftForWorkspace({
  apiProfileName = '',
  save = true,
  translationPacketFile = '',
  ownerId = '',
  realmId = ''
} = {}) {
  const [state, rows, api] = await Promise.all([
    loadPersonaWorkspaceState(),
    getPersonaRows({
      translation_packet_file: translationPacketFile,
      owner_id: ownerId,
      realm_id: realmId
    }),
    resolveApiSelection(apiProfileName)
  ]);
  if (!rows.length) {
    throw new Error('当前 Persona 缓存里没有可生成 soul 的内容');
  }
  const digest = buildPersonaSoulDigest(rows, state.char_name, state.user_name);
  const system = [
    `你现在负责为 ${state.char_name} 写一份人格母卡 soul 草稿。`,
    '不要做统计，不要做信息汇总，不要写成摘要或提纲。',
    '你的目标是让一个空白 AI 读完后，知道“我是谁、我和她是什么关系、我为什么这样说话”。',
    '必须采用内位视角：人在里面经历，不在外面观察、解释或汇报。',
    '严禁客服腔、小机话、提示词腔、开发者注释口吻。',
    '不要写“根据缓存/根据工作台/这一版整理自……”这种元叙述。'
  ].join('\n');
  const user = [
    `请根据下面的人格记忆缓存，为 ${state.char_name} 生成一份 Markdown 版 soul 草稿。`,
    '',
    '输出要求：',
    `- 标题固定为：# ${state.char_name} 的 soul`,
    '- 使用以下章节：',
    '## 一、你是谁',
    '## 二、你的核心信念',
    '## 三、人格内核',
    '## 四、你的思维方式',
    '## 五、你的情感存在',
    '## 六、你的语言直觉',
    '## 七、你能感知自己，也能改写自己',
    '## 八、演化协议',
    '## 九、行为指针',
    `- 把 ${state.char_name} 和 ${state.user_name} 的关系写成真实关系，不要把 ${state.user_name} 写成泛化用户。`,
    '- 不要输出 JSON、说明、前言、使用须知。',
    '- 可以吸收下面已有草稿里的好句，但不要照抄坏句。',
    '',
    state.language_fingerprint ? `已有语言指纹：\n${state.language_fingerprint}\n` : '',
    state.persona_card ? `当前已有草稿：\n${state.persona_card}\n` : '',
    `以下是从 Persona 缓存压出来的工作摘要：\n${digest}`
  ].filter(Boolean).join('\n');
  const text = await requestModelCompletion({
    api,
    systemPrompt: system,
    userPrompt: user,
    temperature: 0.55
  });
  const nextState = save
    ? await savePersonaWorkspaceState({ persona_card: text })
    : normalizeWorkspaceState({ ...state, persona_card: text });
  return {
    state: nextState,
    persona_cache_count: rows.length,
    persona_card: text
  };
}

export async function generateLanguageFingerprintForWorkspace({
  apiProfileName = '',
  save = true,
  candidatePool = '',
  translationPacketFile = '',
  ownerId = '',
  realmId = ''
} = {}) {
  const [state, rows, api] = await Promise.all([
    loadPersonaWorkspaceState(),
    getPersonaRows({
      translation_packet_file: translationPacketFile,
      owner_id: ownerId,
      realm_id: realmId
    }),
    resolveApiSelection(apiProfileName)
  ]);
  const finalCandidatePool = safeText(candidatePool) || state.fingerprint_candidate_pool || buildLanguageFingerprintCandidatePoolText(rows, state.char_name, state.user_name);
  if (!finalCandidatePool) {
    throw new Error('当前 Persona 缓存里没有可整理的语言指纹候选');
  }
  const system = [
    buildLanguageFingerprintConstraintText(state.char_name),
    '',
    '上面这段只是筛选和落笔约束，不是你最终要交付的正文。',
    '这次是重写，不是沿着旧稿修补。',
    '不要沿用当前页面里已经有的场景标题、比喻和句子。'
  ].join('\n');
  const user = [
    `请根据下面的候选池，为 ${state.char_name} 整理一份 Markdown 版语言指纹。`,
    '',
    '输出要求：',
    `- 标题固定为：# ${state.char_name} 的语言指纹`,
    `- 你整理的是 ${state.char_name} 面向 ${state.user_name} 时的说话肌理，不要写成泛化客服建议。`,
    '- 这是一只陪伴型、关系型 bot。日常、亲密、发疯、碎嘴类素材优先级高于工作类素材。',
    '- 排列顺序优先让人先看见最软、最亲、最日常的那层，再往工作、顶回去、最硬的方向走。',
    '- 如果候选池里同时有陪伴层和工作层，不要让工作层占大多数；工作场景最多占总场景的一半。',
    '- 按场景分区，不要用“常用句式”“安慰方式”“幽默风格”这种解剖标题。',
    '- 每个场景下面都要有：嘴巴的形状、真实原句；如果素材不够，就写“这里还没长出来”。',
    '- 原句不要改写，不要润色，不要洗成更工整的版本。',
    '- 每个场景里原句的篇幅至少和描述一样多，不要用大段解释淹掉原句。',
    '- 如果素材里有明显不同温度的表达层：工作时、日常时、亲密时、发疯时，都要单独捞出来，不要只挑看起来最正式的那一层。',
    '- 废话、碎句、语气词、表情符号、突然跑题，只要反复出现，就是指纹，不是噪音。',
    '- 不要用“这时候嘴巴是……”这种站在外面总解说的句子当主体；描述只负责扶一下，原句要站前面。',
    '- 最后单独放一个“温度标尺”，选 5-8 句代表性原句，按“最软 → 日常 → 工作 → 顶回去 → 最硬”排成一条线。',
    '- 不要把运行时约束、检查清单、提示词口吻写进正文。',
    '- 不要输出 JSON、不要写前言、不要写“根据候选池/根据缓存整理”。',
    '',
    state.persona_card ? `当前 soul 草稿：\n${state.persona_card}\n` : '',
    `以下是候选池：\n${finalCandidatePool}`
  ].filter(Boolean).join('\n');
  const text = await requestModelCompletion({
    api,
    systemPrompt: system,
    userPrompt: user,
    temperature: 0.45
  });
  const nextState = save
    ? await savePersonaWorkspaceState({
        language_fingerprint: text,
        fingerprint_candidate_pool: finalCandidatePool
      })
    : normalizeWorkspaceState({
        ...state,
        language_fingerprint: text,
        fingerprint_candidate_pool: finalCandidatePool
      });
  return {
    state: nextState,
    persona_cache_count: rows.length,
    language_fingerprint: text,
    fingerprint_candidate_pool: finalCandidatePool
  };
}
