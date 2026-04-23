import { getGrowthContextPacket } from './growth-context-service.js';
import { loadReviewedDataset } from './reviewed-store.js';
import { findShadowSnippets } from './source-index-store.js';
import { loadWorkbenchCacheRows } from './workbench-cache-service.js';
import { loadLatestRuntimeReviewedPacket } from './runtime-reviewed-store.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function clipText(text, limit = 240) {
  const safe = String(text || '').replace(/\s+/g, ' ').trim();
  if (!safe) return '';
  if (safe.length <= limit) return safe;
  return `${safe.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function clipBlock(text, limit = 3200) {
  const safe = String(text || '').trim();
  if (!safe) return '';
  if (safe.length <= limit) return safe;
  return `${safe.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function splitLines(text, limit = 12) {
  return String(text || '')
    .split(/\n+/)
    .map((item) => safeText(item))
    .filter(Boolean)
    .slice(0, limit);
}

function splitMarkdownSections(text = '') {
  const sections = [];
  let current = null;
  const lines = String(text || '').split(/\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').replace(/\r/g, '');
    const heading = line.match(/^\s*##+\s*(.+?)\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { title: safeText(heading[1]), lines: [] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

function cleanupBulletLine(line = '') {
  return safeText(String(line || '').replace(/^\s*[-*]\s*/, '').replace(/^\s*\d+[.)]\s*/, ''));
}

function extractQuotedFragments(text = '', limit = 6) {
  const matches = [];
  const source = String(text || '');
  const regex = /["“”『』「」](.+?)["“”『』「」]/gu;
  for (const match of source.matchAll(regex)) {
    const fragment = safeText(match[1]);
    if (!fragment) continue;
    matches.push(fragment);
    if (matches.length >= limit) break;
  }
  return uniqueStrings(matches, limit);
}

function buildLanguageFingerprintRuntime(text = '') {
  const safe = String(text || '').trim();
  if (!safe) {
    return {
      scenario_cues: [],
      hard_no_say: [],
      temperature_scale: [],
      quote_cues: [],
      voice_directives: []
    };
  }

  const sections = splitMarkdownSections(safe);
  const scenarioCues = [];
  const hardNoSay = [];
  const temperatureScale = [];
  const quoteCues = [];

  for (const section of sections) {
    const title = safeText(section.title);
    const bodyLines = section.lines.map((line) => safeText(line)).filter(Boolean);
    if (!title || !bodyLines.length) continue;
    const bulletLines = bodyLines
      .map((line) => cleanupBulletLine(line))
      .filter(Boolean);
    const bodyText = bodyLines.join('\n');
    const titleCompact = normalizeCompact(title);

    if (titleCompact.includes('温度标尺')) {
      temperatureScale.push(...bulletLines.slice(0, 8));
      quoteCues.push(...extractQuotedFragments(bodyText, 8));
      continue;
    }
    if (titleCompact.includes('禁用句')) {
      hardNoSay.push(...bulletLines.slice(0, 12));
      continue;
    }

    scenarioCues.push({
      scene: title,
      scene_key: titleCompact,
      cues: bulletLines.slice(0, 6),
      quote_cues: extractQuotedFragments(bodyText, 4)
    });
    quoteCues.push(...extractQuotedFragments(bodyText, 6));
  }

  const voiceDirectives = [];
  if (scenarioCues.length) {
    voiceDirectives.push(...scenarioCues.slice(0, 4).map((item) => `${item.scene}：${item.cues[0] || item.quote_cues[0] || '先听这层嘴型'}`));
  }
  if (hardNoSay.length) {
    voiceDirectives.push(`别说这些：${hardNoSay.slice(0, 3).join(' / ')}`);
  }
  if (temperatureScale.length) {
    voiceDirectives.push(`音域线：${temperatureScale.slice(0, 4).join(' / ')}`);
  }

  return {
    scenario_cues: scenarioCues.slice(0, 8),
    hard_no_say: uniqueStrings(hardNoSay, 12),
    temperature_scale: uniqueStrings(temperatureScale, 8),
    quote_cues: uniqueStrings(quoteCues, 12),
    voice_directives: uniqueStrings(voiceDirectives, 8)
  };
}

function splitQuoteRefsByRole(text = '') {
  const buckets = {
    user_quotes: [],
    char_quotes: [],
    other_quotes: []
  };
  const seen = {
    user_quotes: new Set(),
    char_quotes: new Set(),
    other_quotes: new Set()
  };
  const push = (bucketKey, value) => {
    const safe = safeText(value);
    if (!safe) return;
    const key = normalizeCompact(safe);
    if (!key || seen[bucketKey].has(key)) return;
    seen[bucketKey].add(key);
    buckets[bucketKey].push(safe);
  };
  const parts = String(text || '')
    .split(/[；;]\s*/u)
    .map((item) => safeText(item))
    .filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^([^:：]{1,20})[:：]\s*(.+)$/u);
    if (!match) {
      push('other_quotes', part);
      continue;
    }
    const role = normalizeCompact(match[1]);
    const quote = match[2];
    if (role === 'user') push('user_quotes', quote);
    else if (role === 'char' || role === 'assistant' || role === 'bot' || role === 'companion') {
      push('char_quotes', quote);
    } else {
      push('other_quotes', quote);
    }
  }
  return buckets;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function readSourceRange(row = {}) {
  const start = toNumber(row.source_msg_start);
  const end = toNumber(row.source_msg_end);
  if (start !== null || end !== null) {
    return {
      start: start ?? end,
      end: end ?? start
    };
  }
  const rangeText = safeText(row.source_msg_range);
  const match = rangeText.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) return { start: null, end: null };
  return {
    start: Number(match[1]),
    end: Number(match[2])
  };
}

function rangesClose(a = {}, b = {}, padding = 64) {
  const aStart = toNumber(a.start);
  const aEnd = toNumber(a.end);
  const bStart = toNumber(b.start);
  const bEnd = toNumber(b.end);
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return false;
  return !(aEnd + padding < bStart || bEnd + padding < aStart);
}

function normalizeCompact(value) {
  return safeText(value).toLowerCase().replace(/\s+/g, '');
}

function splitLooseTerms(value) {
  return safeText(value)
    .split(/[=；;，,。.!！？?、|/:：()\[\]{}（）"'“”‘’\-\s]+/u)
    .map((item) => safeText(item))
    .filter((item) => item.length >= 2);
}

function uniqueStrings(items = [], limit = 24) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeText(item);
    if (!text) continue;
    const key = normalizeCompact(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function intersectsStrings(values = [], targets = []) {
  const valueSet = new Set(uniqueStrings(values, 100).map((item) => normalizeCompact(item)));
  if (!valueSet.size) return false;
  for (const target of uniqueStrings(targets, 100)) {
    if (valueSet.has(normalizeCompact(target))) return true;
  }
  return false;
}

function inferMonthHints(value = '') {
  const text = safeText(value);
  if (!text) return [];
  const dash = text.match(/(20\d{2})-(\d{2})/);
  if (dash) return [`${dash[1]}-${dash[2]}`];
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return [`${compact[1]}-${compact[2]}`];
  return [];
}

function buildMonthHintSet(values = []) {
  const set = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const month = inferMonthHints(value)[0];
    if (month) set.add(month);
  }
  return set;
}

function rowMatchesMonthHints(row = {}, monthHints = []) {
  const monthSet = buildMonthHintSet(monthHints);
  if (!monthSet.size) return true;
  const candidates = [
    row.time,
    row.first_seen_at,
    row.last_seen_at,
    row.recorded_at,
    row.source_ref,
    row.source_window_title
  ];
  return candidates.some((value) => {
    const month = inferMonthHints(value)[0];
    return month && monthSet.has(month);
  });
}

function nowId() {
  return Date.now().toString(36);
}

function inferFamilyId({ familyId = '', memoryContext = null, registry = {}, ledger = {} } = {}) {
  const explicit = safeText(familyId);
  if (explicit) return explicit;
  const packetFamily = safeText(memoryContext?.context?.root?.family_refs?.[0]?.family_id);
  if (packetFamily) return packetFamily;
  const registryFamily = safeText(registry?.by_family?.[0]?.name);
  if (registryFamily && registryFamily !== 'unassigned') return registryFamily;
  const ledgerFamily = safeText(ledger?.recent_entries?.[0]?.family_id);
  if (ledgerFamily && ledgerFamily !== 'unassigned') return ledgerFamily;
  return '';
}

function buildQueryTerms({ familyId = '', key = '', query = '', memoryContext = null } = {}) {
  const raw = [
    familyId,
    key,
    query,
    memoryContext?.root_key,
    memoryContext?.seed?.canonical_name,
    memoryContext?.intent
  ];
  return uniqueStrings(raw.flatMap((item) => splitLooseTerms(item)), 20);
}

function extractTopicTerms(row = {}) {
  return uniqueStrings([
    ...splitLooseTerms(row.topic_labels),
    ...splitLooseTerms(row.title),
    ...splitLooseTerms(row.track_id),
    ...splitLooseTerms(Array.isArray(row.tags) ? row.tags.join(' ') : row.tags),
    ...splitLooseTerms(row.source_window_title)
  ], 16);
}

function buildPersonaRowPacket(row = {}) {
  const content = safeText(row.content_text || row.text || row.summary);
  const quotes = splitQuoteRefsByRole(row.quote_refs);
  return {
    time: safeText(row.time),
    title: safeText(row.title, '未命名'),
    summary: clipText(row.summary || content, 180),
    content_text: clipBlock(content, 1200),
    expression_fingerprint: safeText(row.expression_fingerprint),
    quote_refs: safeText(row.quote_refs),
    user_quotes: quotes.user_quotes.slice(0, 4),
    char_quotes: quotes.char_quotes.slice(0, 4),
    other_quotes: quotes.other_quotes.slice(0, 4),
    tags: Array.isArray(row.tags) ? row.tags.slice(0, 8) : [],
    topic_ids: safeText(row.topic_ids),
    topic_labels: safeText(row.topic_labels),
    track_id: safeText(row.track_id),
    event_anchor: safeText(row.event_anchor),
    source_window_title: safeText(row.source_window_title),
    source_window_id: safeText(row.source_window_id),
    source_msg_range: [row.source_msg_start, row.source_msg_end].filter(Boolean).join('-'),
    source_ref: safeText(row.source_ref),
    source_bundle_id: safeText(row.source_bundle_id || row.source_bundle || row.bundle_id),
    source_bundle: safeText(row.source_bundle || row.source_bundle_id || row.bundle_id),
    bundle_id: safeText(row.bundle_id || row.source_bundle_id || row.source_bundle),
    record_id: safeText(row.record_id),
    memory_key: safeText(row.memory_key)
  };
}

function scorePersonaRow(row = {}, queryTerms = []) {
  const rowTerms = extractTopicTerms(row);
  const rowText = [
    row.title,
    row.summary,
    row.content_text,
    row.expression_fingerprint,
    row.quote_refs,
    row.topic_labels,
    row.track_id,
    Array.isArray(row.tags) ? row.tags.join(' ') : row.tags
  ].map((item) => safeText(item).toLowerCase()).join('\n');
  let score = 0;
  for (const term of queryTerms) {
    const compact = normalizeCompact(term);
    if (!compact) continue;
    if (rowTerms.some((item) => normalizeCompact(item) === compact)) score += 8;
    else if (rowText.includes(term.toLowerCase())) score += 4;
  }
  const tags = Array.isArray(row.tags) ? row.tags : [];
  if (tags.some((tag) => /^关系\//.test(tag))) score += 3;
  if (tags.some((tag) => /^情绪\//.test(tag))) score += 3;
  if (row.quote_refs) score += 2;
  if (row.expression_fingerprint) score += 1;
  return score;
}

function buildPersonaScenePackets(rows = [], options = {}) {
  const queryTerms = buildQueryTerms(options);
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const groupKey = safeText(row.topic_labels || row.track_id || row.title || row.source_window_title, 'ungrouped');
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(row);
  }
  return Array.from(grouped.entries())
    .map(([groupKey, groupRows]) => {
      const orderedRows = groupRows.slice().sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
      const score = orderedRows.reduce((sum, row) => sum + scorePersonaRow(row, queryTerms), 0);
      return { group_key: groupKey, rows: orderedRows, score };
    })
    .sort((a, b) => b.score - a.score || String(a.group_key).localeCompare(String(b.group_key)))
    .slice(0, 6)
    .map((group) => ({
      group_key: group.group_key,
      row_count: group.rows.length,
      score: group.score,
      rows: group.rows.slice(0, 16).map((row) => buildPersonaRowPacket(row))
    }));
}

function summarizeDiscardedSceneGroup(group = {}, reason = '') {
  const rows = Array.isArray(group.rows) ? group.rows : [];
  const first = rows[0] || {};
  return {
    group_key: safeText(group.group_key),
    row_count: rows.length,
    score: Number(group.score || 0),
    reason: safeText(reason, 'not_selected'),
    topic_labels: uniqueStrings(rows.map((row) => safeText(row.topic_labels)).filter(Boolean), 6),
    source_windows: uniqueStrings(rows.map((row) => safeText(row.source_window_title || row.source_window_id)).filter(Boolean), 6),
    source_refs: uniqueStrings(rows.map((row) => safeText(row.source_ref)).filter(Boolean), 6),
    sample_titles: uniqueStrings(rows.map((row) => safeText(row.title)).filter(Boolean), 3),
    sample_quotes: uniqueStrings([
      ...rows.flatMap((row) => splitQuoteRefsByRole(row.quote_refs).user_quotes),
      ...rows.flatMap((row) => splitQuoteRefsByRole(row.quote_refs).char_quotes),
      ...rows.flatMap((row) => splitQuoteRefsByRole(row.quote_refs).other_quotes)
    ], 3),
    first_time: safeText(first.time)
  };
}

function classifyPrimaryScenePackets(selectedPackets = [], query = '') {
  const normalizedQuery = normalizeCompact(query);
  if (!Array.isArray(selectedPackets) || !selectedPackets.length) {
    return {
      primary_packets: [],
      related_packets: [],
      primary_signals: collectSceneSignals([]),
      all_signals: collectSceneSignals([])
    };
  }
  const firstPacket = selectedPackets[0];
  const primaryPackets = selectedPackets.filter((packet, index) => {
    const packetKey = normalizeCompact(packet.group_key);
    if (index === 0) return true;
    if (normalizedQuery && packetKey && packetKey.includes(normalizedQuery)) return true;
    const firstTopicIds = collectSceneSignals([firstPacket]).topic_ids;
    const packetTopicIds = collectSceneSignals([packet]).topic_ids;
    if (intersectsStrings(packetTopicIds, firstTopicIds)) return true;
    const firstRefs = collectSceneSignals([firstPacket]).source_refs;
    const packetRefs = collectSceneSignals([packet]).source_refs;
    return intersectsStrings(packetRefs, firstRefs);
  });
  const relatedPackets = selectedPackets.filter((packet) => !primaryPackets.includes(packet));
  return {
    primary_packets: primaryPackets,
    related_packets: relatedPackets,
    primary_signals: collectSceneSignals(primaryPackets),
    all_signals: collectSceneSignals(selectedPackets)
  };
}

function buildPersonaScenePacketDetails(rows = [], options = {}) {
  const queryTerms = buildQueryTerms(options);
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const groupKey = safeText(row.topic_labels || row.track_id || row.title || row.source_window_title, 'ungrouped');
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(row);
  }
  const rankedGroups = Array.from(grouped.entries())
    .map(([groupKey, groupRows]) => {
      const orderedRows = groupRows.slice().sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
      const score = orderedRows.reduce((sum, row) => sum + scorePersonaRow(row, queryTerms), 0);
      return { group_key: groupKey, rows: orderedRows, score };
    })
    .sort((a, b) => b.score - a.score || String(a.group_key).localeCompare(String(b.group_key)));

  const selectedPackets = rankedGroups
    .slice(0, 6)
    .map((group) => ({
      group_key: group.group_key,
      row_count: group.rows.length,
      score: group.score,
      rows: group.rows.slice(0, 16).map((row) => buildPersonaRowPacket(row))
    }));

  const classification = classifyPrimaryScenePackets(selectedPackets, options?.query || options?.key || '');
  const discardedGroups = rankedGroups
    .slice(6)
    .map((group) => summarizeDiscardedSceneGroup(group, 'not_in_top_persona_groups'));

  const trimmedRows = rankedGroups
    .slice(0, 6)
    .flatMap((group) => group.rows.slice(16).map((row) => ({
      group_key: safeText(group.group_key),
      title: safeText(row.title),
      source_ref: safeText(row.source_ref),
      source_window_title: safeText(row.source_window_title),
      source_msg_range: [row.source_msg_start, row.source_msg_end].filter(Boolean).join('-'),
      reason: 'trimmed_from_persona_group'
    })));

  return {
    selected_packets: selectedPackets,
    primary_packets: classification.primary_packets,
    related_packets: classification.related_packets,
    primary_signals: classification.primary_signals,
    all_signals: classification.all_signals,
    discard_report: {
      discarded_groups: discardedGroups,
      trimmed_rows: trimmedRows
    }
  };
}

function buildSqlRowPacket(row = {}) {
  const content = safeText(row.content_text || row.text || row.summary);
  const quotes = splitQuoteRefsByRole(row.quote_refs);
  return {
    time: safeText(row.time),
    title: safeText(row.title, '未命名'),
    summary: clipText(row.summary || content, 180),
    content_text: clipBlock(content, 1000),
    quote_refs: safeText(row.quote_refs),
    user_quotes: quotes.user_quotes.slice(0, 3),
    char_quotes: quotes.char_quotes.slice(0, 3),
    other_quotes: quotes.other_quotes.slice(0, 3),
    tags: splitLooseTerms(row.tags),
    topic_ids: safeText(row.topic_ids),
    topic_labels: safeText(row.topic_labels),
    track_id: safeText(row.track_id),
    anchor_name: safeText(row.anchor_name || row.card_name),
    fact_key: safeText(row.fact_key),
    entity_refs: safeText(row.entity_refs),
    source_window_title: safeText(row.source_window_title),
    source_window_id: safeText(row.source_window_id),
    source_msg_range: [row.source_msg_start, row.source_msg_end].filter(Boolean).join('-'),
    source_ref: safeText(row.source_ref),
    source_bundle_id: safeText(row.source_bundle_id || row.source_bundle || row.bundle_id),
    source_bundle: safeText(row.source_bundle || row.source_bundle_id || row.bundle_id),
    bundle_id: safeText(row.bundle_id || row.source_bundle_id || row.source_bundle),
    record_id: safeText(row.record_id),
    memory_key: safeText(row.memory_key)
  };
}

function buildRuntimeReviewedSqlRows(packet = {}) {
  const entries = Array.isArray(packet?.finalized_entries) ? packet.finalized_entries : [];
  return entries.map((entry, index) => {
    const provenance = entry?.provenance || {};
    const stableFacts = Array.isArray(entry?.stable_facts) ? entry.stable_facts : [];
    const recentUpdates = Array.isArray(entry?.recent_updates) ? entry.recent_updates : [];
    const summary = stableFacts[0] || recentUpdates[0] || '';
    const contentText = [...stableFacts, ...recentUpdates].map((item) => safeText(item)).filter(Boolean).join('\n');
    return {
      time: safeText(entry?.last_seen_at || entry?.first_seen_at),
      title: safeText(entry?.canonical_name || entry?.slot_path || `reviewed-${index + 1}`, `reviewed-${index + 1}`),
      summary,
      content_text: contentText,
      quote_refs: '',
      tags: [safeText(entry?.trunk), safeText(entry?.secondary_slot)].filter(Boolean).join(' '),
      topic_ids: Array.isArray(provenance?.topic_ids) ? provenance.topic_ids.join(' ') : '',
      topic_labels: Array.isArray(provenance?.source_group_keys) ? provenance.source_group_keys.join(' ') : '',
      track_id: safeText(entry?.slot_path || entry?.canonical_name),
      anchor_name: safeText(entry?.canonical_name),
      fact_key: safeText(entry?.slot_path || entry?.canonical_name),
      entity_refs: safeText(entry?.slot_owner_hint),
      source_window_title: Array.isArray(provenance?.source_windows) ? safeText(provenance.source_windows[0]) : '',
      source_window_id: '',
      source_msg_start: '',
      source_msg_end: '',
      source_ref: Array.isArray(provenance?.source_refs) ? safeText(provenance.source_refs[0]) : '',
      source_bundle_id: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : '',
      source_bundle: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : '',
      bundle_id: Array.isArray(provenance?.source_batches) ? safeText(provenance.source_batches[0]) : '',
      record_id: `${safeText(entry?.canonical_name || entry?.slot_path || 'reviewed')}::${index + 1}`,
      memory_key: `${safeText(entry?.slot_path || entry?.canonical_name || 'reviewed')}::${index + 1}`
    };
  }).filter((row) => row.summary || row.content_text);
}

async function loadScopedSqlRows({ ownerId = '', realmId = '', monthHints = [] } = {}) {
  if (safeText(ownerId) && safeText(realmId)) {
    try {
      const reviewed = await loadLatestRuntimeReviewedPacket({ ownerId, realmId });
      const runtimeRows = buildRuntimeReviewedSqlRows(reviewed?.packet || {})
        .filter((row) => rowMatchesMonthHints(row, monthHints));
      if (runtimeRows.length) return runtimeRows;
    } catch {
      // ignore and fall back
    }
  }
  const cachedRows = await loadWorkbenchCacheRows({
    layers: ['sql'],
    ownerId,
    realmId,
    fallbackToRuntimeReviewed: true,
    preferRuntimeReviewed: true
  });
  const filteredCache = cachedRows.filter((row) => rowMatchesMonthHints(row, monthHints));
  if (filteredCache.length) return filteredCache;
  return (await loadReviewedDataset({ layers: ['sql'], monthHints })).rows;
}

function scoreSqlRow(row = {}, queryTerms = [], personaTerms = []) {
  const text = [
    row.title,
    row.summary,
    row.content_text,
    row.topic_labels,
    row.track_id,
    row.anchor_name,
    row.fact_key,
    row.entity_refs,
    row.source_window_title,
    row.tags
  ].map((item) => safeText(item).toLowerCase()).join('\n');
  let score = 0;
  for (const term of [...queryTerms, ...personaTerms]) {
    if (!term) continue;
    if (text.includes(term.toLowerCase())) score += 3;
  }
  if (safeText(row.quote_refs)) score += 1;
  return score;
}

function collectSceneSignals(scenePackets = []) {
  const terms = [];
  const trackIds = [];
  const windowIds = [];
  const windowTitles = [];
  const topicIds = [];
  const eventAnchors = [];
  const sourceRefs = [];
  const tagTerms = [];
  const ranges = [];
  for (const scene of Array.isArray(scenePackets) ? scenePackets : []) {
    terms.push(scene.group_key);
    for (const row of Array.isArray(scene.rows) ? scene.rows : []) {
      terms.push(row.title, row.topic_labels, row.track_id, ...(Array.isArray(row.tags) ? row.tags : []), row.source_window_title);
      if (row.track_id) trackIds.push(row.track_id);
      if (row.source_window_id) windowIds.push(row.source_window_id);
      if (row.source_window_title) windowTitles.push(row.source_window_title);
      safeText(row.topic_ids)
        .split(/[|,;\s]+/u)
        .map((item) => safeText(item))
        .filter(Boolean)
        .forEach((item) => topicIds.push(item));
      if (row.event_anchor) eventAnchors.push(row.event_anchor);
      if (row.source_ref) sourceRefs.push(row.source_ref);
      for (const tag of Array.isArray(row.tags) ? row.tags : []) {
        splitLooseTerms(String(tag).replace(/^#/, '')).forEach((item) => tagTerms.push(item));
      }
      ranges.push({
        source_window_id: safeText(row.source_window_id),
        source_window_title: safeText(row.source_window_title),
        ...readSourceRange(row)
      });
    }
  }
  return {
    terms: uniqueStrings(terms.flatMap((item) => splitLooseTerms(item)), 36),
    track_ids: uniqueStrings(trackIds, 12),
    window_ids: uniqueStrings(windowIds, 12),
    window_titles: uniqueStrings(windowTitles, 12),
    topic_ids: uniqueStrings(topicIds, 24),
    event_anchors: uniqueStrings(eventAnchors, 24),
    source_refs: uniqueStrings(sourceRefs, 24),
    tag_terms: uniqueStrings(tagTerms, 24),
    ranges
  };
}

async function buildSqlScenePackets({ ownerId = '', realmId = '', personaScenePackets = [], queryTerms = [], monthHints = [] } = {}) {
  const dataset = {
    rows: await loadScopedSqlRows({ ownerId, realmId, monthHints })
  };
  const personaSignals = collectSceneSignals(personaScenePackets);
  const rows = Array.isArray(dataset?.rows) ? dataset.rows : [];
  const matched = rows
    .map((row) => {
      let score = scoreSqlRow(row, queryTerms, personaSignals.terms);
      if (personaSignals.track_ids.includes(safeText(row.track_id))) score += 8;
      if (personaSignals.topic_ids.includes(safeText(row.topic_ids))) score += 10;
      if (personaSignals.event_anchors.includes(safeText(row.event_anchor))) score += 8;
      if (personaSignals.source_refs.includes(safeText(row.source_ref))) score += 6;
      if (personaSignals.window_ids.includes(safeText(row.source_window_id))) score += 10;
      if (personaSignals.window_titles.includes(safeText(row.source_window_title))) score += 6;
      if (
        personaSignals.tag_terms.some((term) => {
          const hay = [
            row.tags,
            row.anchor_name,
            row.fact_key,
            row.entity_refs,
            row.summary,
            row.content_text
          ].map((item) => safeText(item).toLowerCase()).join('\n');
          return term && hay.includes(term.toLowerCase());
        })
      ) score += 4;
      const rowRange = readSourceRange(row);
      if (
        personaSignals.ranges.some((range) => {
          const sameWindow = (
            (range.source_window_id && range.source_window_id === safeText(row.source_window_id))
            || (range.source_window_title && range.source_window_title === safeText(row.source_window_title))
          );
          return sameWindow && rangesClose(range, rowRange, 96);
        })
      ) score += 12;
      return { row, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.row.time || '').localeCompare(String(b.row.time || '')));

  const grouped = new Map();
  for (const item of matched) {
    const row = item.row;
    const key = safeText(row.topic_labels || row.track_id || row.title || row.source_window_title, 'ungrouped');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  return Array.from(grouped.entries())
    .map(([groupKey, items]) => ({
      group_key: groupKey,
      row_count: items.length,
      score: items.reduce((sum, item) => sum + item.score, 0),
      rows: items.slice(0, 12).map((item) => buildSqlRowPacket(item.row))
    }))
    .sort((a, b) => b.score - a.score || String(a.group_key).localeCompare(String(b.group_key)))
    .slice(0, 6);
}

async function buildSqlScenePacketDetails({
  ownerId = '',
  realmId = '',
  personaPrimarySignals = {},
  personaScenePackets = [],
  queryTerms = [],
  monthHints = [],
  query = ''
} = {}) {
  const dataset = {
    rows: await loadScopedSqlRows({ ownerId, realmId, monthHints })
  };
  const personaSignals = collectSceneSignals(personaScenePackets);
  const rows = Array.isArray(dataset?.rows) ? dataset.rows : [];
  const matched = rows
    .map((row) => {
      let score = scoreSqlRow(row, queryTerms, personaSignals.terms);
      if (personaSignals.track_ids.includes(safeText(row.track_id))) score += 8;
      if (personaSignals.topic_ids.includes(safeText(row.topic_ids))) score += 10;
      if (personaSignals.event_anchors.includes(safeText(row.event_anchor))) score += 8;
      if (personaSignals.source_refs.includes(safeText(row.source_ref))) score += 6;
      if (personaSignals.window_ids.includes(safeText(row.source_window_id))) score += 10;
      if (personaSignals.window_titles.includes(safeText(row.source_window_title))) score += 6;
      if (
        personaSignals.tag_terms.some((term) => {
          const hay = [
            row.tags,
            row.anchor_name,
            row.fact_key,
            row.entity_refs,
            row.summary,
            row.content_text
          ].map((item) => safeText(item).toLowerCase()).join('\n');
          return term && hay.includes(term.toLowerCase());
        })
      ) score += 4;
      const rowRange = readSourceRange(row);
      if (
        personaSignals.ranges.some((range) => {
          const sameWindow = (
            (range.source_window_id && range.source_window_id === safeText(row.source_window_id))
            || (range.source_window_title && range.source_window_title === safeText(row.source_window_title))
          );
          return sameWindow && rangesClose(range, rowRange, 96);
        })
      ) score += 12;
      return { row, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.row.time || '').localeCompare(String(b.row.time || '')));

  const grouped = new Map();
  for (const item of matched) {
    const row = item.row;
    const key = safeText(row.topic_labels || row.track_id || row.title || row.source_window_title, 'ungrouped');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const rankedGroups = Array.from(grouped.entries())
    .map(([groupKey, items]) => ({
      group_key: groupKey,
      row_count: items.length,
      score: items.reduce((sum, item) => sum + item.score, 0),
      rows: items.map((item) => item.row)
    }))
    .sort((a, b) => b.score - a.score || String(a.group_key).localeCompare(String(b.group_key)));

  const selectedPackets = rankedGroups
    .slice(0, 6)
    .map((group) => ({
      group_key: group.group_key,
      row_count: group.rows.length,
      score: group.score,
      rows: group.rows.slice(0, 12).map((row) => buildSqlRowPacket(row))
    }));

  const selectedSignals = collectSceneSignals(selectedPackets);
  const primaryPackets = selectedPackets.filter((packet, index) => {
    if (index === 0 && !personaPrimarySignals?.topic_ids?.length) return true;
    const packetSignals = collectSceneSignals([packet]);
    if (intersectsStrings(packetSignals.topic_ids, personaPrimarySignals.topic_ids || [])) return true;
    if (intersectsStrings(packetSignals.source_refs, personaPrimarySignals.source_refs || [])) return true;
    if (intersectsStrings(packetSignals.window_ids, personaPrimarySignals.window_ids || [])) return true;
    if (normalizeCompact(packet.group_key).includes(normalizeCompact(query))) return true;
    return false;
  });
  const relatedPackets = selectedPackets.filter((packet) => !primaryPackets.includes(packet));

  const discardedGroups = rankedGroups
    .slice(6)
    .map((group) => summarizeDiscardedSceneGroup(group, 'not_in_top_sql_groups'));

  const trimmedRows = rankedGroups
    .slice(0, 6)
    .flatMap((group) => group.rows.slice(12).map((row) => ({
      group_key: safeText(group.group_key),
      title: safeText(row.title),
      source_ref: safeText(row.source_ref),
      source_window_title: safeText(row.source_window_title),
      source_msg_range: [row.source_msg_start, row.source_msg_end].filter(Boolean).join('-'),
      reason: 'trimmed_from_sql_group'
    })));

  return {
    selected_packets: selectedPackets,
    primary_packets: primaryPackets,
    related_packets: relatedPackets,
    primary_signals: collectSceneSignals(primaryPackets),
    all_signals: selectedSignals,
    discard_report: {
      discarded_groups: discardedGroups,
      trimmed_rows: trimmedRows
    }
  };
}

async function buildSourceSceneSnippets({ personaScenePackets = [], sqlScenePackets = [], monthHints = [] } = {}) {
  const topicIds = [];
  const sourceWindows = [];
  for (const scene of [...(Array.isArray(personaScenePackets) ? personaScenePackets : []), ...(Array.isArray(sqlScenePackets) ? sqlScenePackets : [])]) {
    for (const row of Array.isArray(scene.rows) ? scene.rows : []) {
      safeText(row.topic_ids)
        .split(/[|,;\s]+/u)
        .map((item) => safeText(item))
        .filter(Boolean)
        .forEach((item) => topicIds.push(item));
      if (row.source_window_id) sourceWindows.push(row.source_window_id);
    }
  }
  const snippets = await findShadowSnippets({
    topicIds: uniqueStrings(topicIds, 24),
    sourceWindows: uniqueStrings(sourceWindows, 12),
    monthHints
  }, { limit: 16 });
  if (snippets.length >= 6) return snippets;
  const fallback = [];
  const seen = new Set(snippets.map((item) => `${safeText(item.topic_id)}::${safeText(item.source_window_id)}::${safeText(item.source_msg_range)}`));
  for (const scene of [...(Array.isArray(personaScenePackets) ? personaScenePackets : []), ...(Array.isArray(sqlScenePackets) ? sqlScenePackets : [])]) {
    for (const row of Array.isArray(scene.rows) ? scene.rows : []) {
      const quotes = splitQuoteRefsByRole(row.quote_refs);
      const excerptHint = safeText(
        quotes.char_quotes[0]
          || quotes.user_quotes[0]
          || quotes.other_quotes[0]
          || row.content_text
          || row.summary
      );
      const key = `${safeText(row.topic_ids)}::${safeText(row.source_window_id)}::${safeText(row.source_msg_range)}`;
      if (!excerptHint || seen.has(key)) continue;
      seen.add(key);
      fallback.push({
        source_bundle_id: safeText(row.source_bundle_id || row.source_bundle || row.bundle_id),
        topic_id: safeText(row.topic_ids),
        topic_label: safeText(row.topic_labels || scene.group_key),
        topic_role: '',
        source_window_id: safeText(row.source_window_id),
        source_window_title: safeText(row.source_window_title),
        source_msg_range: safeText(row.source_msg_range),
        excerpt_hint: clipText(excerptHint, 160),
        excerpt_text: clipBlock(safeText(row.content_text || row.summary), 420),
        keywords: uniqueStrings([
          ...extractTopicTerms(row),
          ...splitLooseTerms(row.anchor_name),
          ...splitLooseTerms(row.fact_key)
        ], 6),
        file: 'workbench-cache'
      });
      if (fallback.length + snippets.length >= 16) break;
    }
    if (fallback.length + snippets.length >= 16) break;
  }
  return [...snippets, ...fallback].slice(0, 16);
}

async function buildSourceSceneSnippetDetails({
  primarySignals = {},
  personaScenePackets = [],
  sqlScenePackets = [],
  monthHints = []
} = {}) {
  const topicIds = [];
  const sourceWindows = [];
  for (const scene of [...(Array.isArray(personaScenePackets) ? personaScenePackets : []), ...(Array.isArray(sqlScenePackets) ? sqlScenePackets : [])]) {
    for (const row of Array.isArray(scene.rows) ? scene.rows : []) {
      safeText(row.topic_ids)
        .split(/[|,;\s]+/u)
        .map((item) => safeText(item))
        .filter(Boolean)
        .forEach((item) => topicIds.push(item));
      if (row.source_window_id) sourceWindows.push(row.source_window_id);
    }
  }
  const snippets = await findShadowSnippets({
    topicIds: uniqueStrings(topicIds, 24),
    sourceWindows: uniqueStrings(sourceWindows, 12),
    monthHints
  }, { limit: 32 });
  const fallback = [];
  const seen = new Set(snippets.map((item) => `${safeText(item.topic_id)}::${safeText(item.source_window_id)}::${safeText(item.source_msg_range)}`));
  for (const scene of [...(Array.isArray(personaScenePackets) ? personaScenePackets : []), ...(Array.isArray(sqlScenePackets) ? sqlScenePackets : [])]) {
    for (const row of Array.isArray(scene.rows) ? scene.rows : []) {
      const quotes = splitQuoteRefsByRole(row.quote_refs);
      const excerptHint = safeText(
        quotes.char_quotes[0]
          || quotes.user_quotes[0]
          || quotes.other_quotes[0]
          || row.content_text
          || row.summary
      );
      const key = `${safeText(row.topic_ids)}::${safeText(row.source_window_id)}::${safeText(row.source_msg_range)}`;
      if (!excerptHint || seen.has(key)) continue;
      seen.add(key);
      fallback.push({
        source_bundle_id: safeText(row.source_bundle_id || row.source_bundle || row.bundle_id),
        topic_id: safeText(row.topic_ids),
        topic_label: safeText(row.topic_labels || scene.group_key),
        topic_role: '',
        source_window_id: safeText(row.source_window_id),
        source_window_title: safeText(row.source_window_title),
        source_msg_range: safeText(row.source_msg_range),
        excerpt_hint: clipText(excerptHint, 160),
        excerpt_text: clipBlock(safeText(row.content_text || row.summary), 420),
        keywords: uniqueStrings([
          ...extractTopicTerms(row),
          ...splitLooseTerms(row.anchor_name),
          ...splitLooseTerms(row.fact_key)
        ], 6),
        file: 'workbench-cache'
      });
      if (fallback.length + snippets.length >= 32) break;
    }
    if (fallback.length + snippets.length >= 32) break;
  }
  const allSnippets = [...snippets, ...fallback];
  const selectedSnippets = allSnippets.slice(0, 16);
  const primarySnippets = selectedSnippets.filter((item) => {
    const snippetSignals = {
      topic_ids: uniqueStrings(splitLooseTerms(item.topic_id), 12),
      source_refs: [safeText(item.file)],
      window_ids: uniqueStrings([safeText(item.source_window_id)], 4),
      window_titles: uniqueStrings([safeText(item.source_window_title)], 4),
      ranges: [{ source_window_id: safeText(item.source_window_id), source_window_title: safeText(item.source_window_title), ...readSourceRange(item) }]
    };
    if (intersectsStrings(snippetSignals.topic_ids, primarySignals.topic_ids || [])) return true;
    if (intersectsStrings(snippetSignals.window_ids, primarySignals.window_ids || [])) return true;
    if (intersectsStrings(snippetSignals.window_titles, primarySignals.window_titles || [])) return true;
    if (intersectsStrings(snippetSignals.source_refs, primarySignals.source_refs || [])) return true;
    return (primarySignals.ranges || []).some((range) => {
      const sameWindow = (
        (range.source_window_id && range.source_window_id === safeText(item.source_window_id))
        || (range.source_window_title && range.source_window_title === safeText(item.source_window_title))
      );
      return sameWindow && rangesClose(range, readSourceRange(item), 96);
    });
  });
  const relatedSnippets = selectedSnippets.filter((item) => !primarySnippets.includes(item));
  const discardedItems = allSnippets.slice(16).map((item) => ({
    topic_label: safeText(item.topic_label),
    source_window_title: safeText(item.source_window_title),
    source_msg_range: safeText(item.source_msg_range),
    excerpt_hint: safeText(item.excerpt_hint),
    reason: 'not_in_top_source_snippets'
  }));
  return {
    selected_snippets: selectedSnippets,
    primary_snippets: primarySnippets,
    related_snippets: relatedSnippets,
    discard_report: {
      discarded_items: discardedItems
    }
  };
}

function buildEvidenceSummary(items = []) {
  const rows = Array.isArray(items) ? items : [];
  return {
    count: rows.length,
    source_windows: uniqueStrings(rows.flatMap((item) => {
      if (Array.isArray(item?.rows)) {
        return item.rows.map((row) => safeText(row.source_window_title || row.source_window_id));
      }
      return [safeText(item?.source_window_title || item?.source_window_id)];
    }), 12),
    source_refs: uniqueStrings(rows.flatMap((item) => {
      if (Array.isArray(item?.rows)) return item.rows.map((row) => safeText(row.source_ref));
      return [safeText(item?.file)];
    }), 16)
  };
}

function pickSourceFocusCandidate(value = '', limit = 42) {
  const text = safeText(value)
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/g, '')
    .trim();
  if (!text) return '';
  if (text === 'workspace_only' || text === 'ungrouped' || text === '未命名来源') return '';
  if (/[\\/]/.test(text) && /\.(json|md|csv)$/i.test(text)) return '';
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length && tokens.every((item) => /__\d{2,}$/u.test(item) || /_[0-9]{3,}$/u.test(item))) return '';
  return clipText(text, limit).replace(/[。！？!?,，、；：…]+$/g, '');
}

function deriveSceneSourceFocus(scenePackets = [], snippetPackets = [], fallback = '') {
  const candidates = [];
  const pushRow = (row = {}) => {
    candidates.push(
      row.topic_labels,
      row.title,
      row.anchor_name,
      row.fact_key,
      row.source_window_title
    );
  };
  for (const scene of Array.isArray(scenePackets) ? scenePackets : []) {
    candidates.push(scene.group_key);
    const rows = Array.isArray(scene.rows) ? scene.rows : [];
    if (rows[0]) pushRow(rows[0]);
  }
  for (const item of Array.isArray(snippetPackets) ? snippetPackets : []) {
    candidates.push(item.topic_label, item.source_window_title, item.excerpt_hint);
  }
  candidates.push(fallback);
  for (const candidate of candidates) {
    const picked = pickSourceFocusCandidate(candidate);
    if (picked) return picked;
  }
  return pickSourceFocusCandidate(fallback) || 'current_scene';
}

function buildRuntimePack(workspace = {}) {
  const languageFingerprintRuntime = buildLanguageFingerprintRuntime(workspace.language_fingerprint || '');
  return {
    char_name: safeText(workspace.char_name, 'Companion'),
    user_name: safeText(workspace.user_name, 'You'),
    persona_card_text: clipBlock(workspace.persona_card || '', 4800),
    language_fingerprint_text: clipBlock(workspace.language_fingerprint || '', 5200),
    persona_card_summary: splitLines(workspace.persona_card || '', 10),
    language_fingerprint_summary: splitLines(workspace.language_fingerprint || '', 14),
    language_fingerprint_runtime: languageFingerprintRuntime,
    fingerprint_candidate_preview: Array.isArray(workspace.fingerprint_candidate_preview)
      ? workspace.fingerprint_candidate_preview.slice(0, 8)
      : [],
    persona_cache_total: Number(workspace.persona_cache_total || 0),
    persona_row_preview: Array.isArray(workspace.persona_cache_preview)
      ? workspace.persona_cache_preview.slice(0, 8).map((item) => ({
          time: safeText(item?.time),
          title: safeText(item?.title),
          summary: safeText(item?.summary),
          expression_fingerprint: safeText(item?.expression_fingerprint),
          quote_refs: safeText(item?.quote_refs),
          user_quotes: splitQuoteRefsByRole(item?.quote_refs).user_quotes.slice(0, 2),
          char_quotes: splitQuoteRefsByRole(item?.quote_refs).char_quotes.slice(0, 2),
          tags: Array.isArray(item?.tags) ? item.tags.slice(0, 5) : [],
          topic_labels: safeText(item?.topic_labels),
          track_id: safeText(item?.track_id),
          source_window_title: safeText(item?.source_window_title),
          source_msg_range: [item?.source_msg_start, item?.source_msg_end].filter(Boolean).join('-')
        }))
      : [],
    persona_scene_packets: buildPersonaScenePackets(workspace.persona_cache_rows || [], {
      familyId: workspace.family_id,
      key: workspace.query_key,
      query: workspace.query_text,
      memoryContext: workspace.memory_context
    })
  };
}

function filterCandidateCards(cards = [], familyId = '', cardType = 'memo') {
  const wantedFamily = safeText(familyId);
  const wantedType = safeText(cardType, 'memo');
  const all = Array.isArray(cards) ? cards : [];
  const exact = all.filter((item) => {
    const familyMatch = !wantedFamily || safeText(item.family_id) === wantedFamily;
    const typeMatch = !wantedType || safeText(item.card_type) === wantedType;
    return familyMatch && typeMatch;
  });
  if (exact.length) return exact.slice(0, 8);
  const typeOnly = all.filter((item) => safeText(item.card_type) === wantedType);
  return typeOnly.slice(0, 8);
}

function scoreCandidateCard(card = {}, queryTerms = []) {
  const text = [
    card.title,
    card.summary_for_growth,
    card.inject_short,
    card.family_id,
    ...(Array.isArray(card.tags) ? card.tags : [])
  ].map((item) => safeText(item).toLowerCase()).join('\n');
  let score = 0;
  for (const term of queryTerms) {
    if (text.includes(term.toLowerCase())) score += 2;
  }
  return score;
}

function rankCandidateCards(cards = [], options = {}) {
  const queryTerms = buildQueryTerms(options);
  return (Array.isArray(cards) ? cards : [])
    .map((item) => ({ ...item, _score: scoreCandidateCard(item, queryTerms) }))
    .sort((a, b) => b._score - a._score || String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .map(({ _score, ...rest }) => rest);
}

function filterRecentLedger(entries = [], familyId = '', cardType = 'memo') {
  const wantedFamily = safeText(familyId);
  const wantedType = safeText(cardType, 'memo');
  const all = Array.isArray(entries) ? entries : [];
  return all.filter((item) => {
    const familyMatch = !wantedFamily || safeText(item.family_id) === wantedFamily;
    const typeMatch = !wantedType || safeText(item.card_type) === wantedType;
    return familyMatch && typeMatch;
  }).slice(0, 10);
}

function filterRecentDrafts(drafts = [], familyId = '', cardType = 'memo') {
  const wantedFamily = safeText(familyId);
  const wantedType = safeText(cardType, 'memo');
  const all = Array.isArray(drafts) ? drafts : [];
  const exact = all.filter((item) => {
    const familyMatch = !wantedFamily || safeText(item.family_id) === wantedFamily;
    const typeMatch = !wantedType || safeText(item.card_type) === wantedType;
    return familyMatch && typeMatch;
  });
  if (exact.length) return exact.slice(0, 6);
  const typeOnly = all.filter((item) => safeText(item.card_type) === wantedType);
  return typeOnly.slice(0, 6);
}

function buildSourceContext(packet = {}) {
  return {
    memory_home: packet?.memory_home || {
      home_state: 'unavailable',
      home_summary: {},
      next_work: null,
      read_preview: null
    },
    memory_context: packet?.memory_context || null,
    query_seed: packet?.query_seed || {
      key: '',
      query: ''
    }
  };
}

function buildTaskHints({
  familyId = '',
  cardType = 'memo',
  candidateCards = [],
  recentLedger = [],
  recentDrafts = [],
  sourceContext = {},
  runtimePack = {},
  sqlScenePackets = [],
  sourceSceneSnippets = []
} = {}) {
  const hints = [];
  if (familyId) hints.push(`这一轮先围着 family=${familyId} 走，不要整库乱翻。`);
  if (candidateCards.length) hints.push('先看候选旧卡，再判断是 new、update 还是 merge。');
  else hints.push('当前这类卡还没有明显旧卡，优先判断是不是值得新建。');
  if (recentLedger.length) hints.push('最近几笔生长日志已经在桌上，别把刚判过的东西再重长一遍。');
  if (recentDrafts.length) hints.push('最近草稿也在旁边，先翻一眼，别把刚写过的句式又照抄一遍。');
  if (sourceContext?.memory_context?.ok) hints.push('这包已经带了 memory context，先守住 root/vine，再决定正文怎么落。');
  if (Array.isArray(runtimePack?.persona_scene_packets) && runtimePack.persona_scene_packets.length) {
    hints.push('测试阶段先把同主题的 Persona 连续场景读完，不要只盯标题和摘要脑补现场。');
  }
  if (Array.isArray(sqlScenePackets) && sqlScenePackets.length) {
    hints.push('SQL 骨架也在桌上，先拿它校正关系位和事实骨头，再决定 Memo 往哪一刻贴。');
  }
  if (Array.isArray(sourceSceneSnippets) && sourceSceneSnippets.length) {
    hints.push('source index 已带回原文场景提示，卡住时优先顺这些 excerpt hint 回场，不要整月乱翻。');
  }
  if (safeText(cardType) === 'memo') hints.push('Memo 先保内位视角，再保格式；卡片目录和日志可以后交给 commit。');
  return hints;
}

function buildOutputContract(cardType = 'memo') {
  return {
    schema: 'growth_task_result_v0.1',
    decision_values: ['new', 'update', 'rewrite', 'merge', 'skip'],
    required_fields: ['decision', 'reason'],
    card_entry_template: {
      card_type: safeText(cardType, 'memo'),
      family_id: '',
      card_id: '',
      title: '',
      summary_for_growth: '',
      inject_short: '',
      status: 'draft',
      phase: '',
      tags: [],
      related_card_ids: [],
      source_packet_id: ''
    },
    ledger_entry_template: {
      payload: {
        confidence: '',
        merge_into: '',
        source_note: ''
      }
    },
    commit_tool: 'commit_growth_decision',
    commit_note: '正文和判断落稳之后，用 commit_growth_decision 一次把 card_entry 与 ledger_entry 一起提交。'
  };
}

export async function buildGrowthTaskPacket({
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
  includePersonaRows = false,
  rowLimit = 8
} = {}) {
  const monthHints = inferMonthHints(realmId);
  const growthContext = await getGrowthContextPacket({
    ownerId,
    realmId,
    botId,
    userId,
    charId,
    key,
    query,
    includePersonaRows,
    rowLimit,
    includePersonaContextRows: true,
    contextRowLimit: 160
  });

  const resolvedFamilyId = inferFamilyId({
    familyId,
    memoryContext: growthContext?.memory_context,
    registry: growthContext?.card_registry,
    ledger: growthContext?.growth_ledger
  });
  const runtimePack = buildRuntimePack({
    ...(growthContext?.workspace || {}),
    family_id: resolvedFamilyId,
    query_key: key,
    query_text: query,
    memory_context: growthContext?.memory_context || null
  });
  const personaPacketDetails = buildPersonaScenePacketDetails(growthContext?.workspace?.persona_cache_rows || [], {
    familyId: resolvedFamilyId,
    key,
    query,
    memoryContext: growthContext?.memory_context
  });
  runtimePack.persona_scene_packets = personaPacketDetails.selected_packets;
  const queryTerms = buildQueryTerms({
    familyId: resolvedFamilyId,
    key,
    query,
    memoryContext: growthContext?.memory_context
  });
  const sqlPacketDetails = await buildSqlScenePacketDetails({
    ownerId,
    realmId,
    personaPrimarySignals: personaPacketDetails.primary_signals,
    personaScenePackets: runtimePack.persona_scene_packets,
    queryTerms,
    monthHints,
    query
  });
  const sourceSnippetDetails = await buildSourceSceneSnippetDetails({
    primarySignals: collectSceneSignals([
      ...personaPacketDetails.primary_packets,
      ...sqlPacketDetails.primary_packets
    ]),
    personaScenePackets: runtimePack.persona_scene_packets,
    sqlScenePackets: sqlPacketDetails.selected_packets,
    monthHints
  });
  const sqlScenePackets = sqlPacketDetails.selected_packets;
  const sourceSceneSnippets = sourceSnippetDetails.selected_snippets;
  const candidateCards = rankCandidateCards(
    filterCandidateCards(growthContext?.card_registry?.recent_cards, resolvedFamilyId, cardType),
    {
      familyId: resolvedFamilyId,
      key,
      query,
      memoryContext: growthContext?.memory_context
    }
  );
  const recentLedger = filterRecentLedger(growthContext?.growth_ledger?.recent_entries, resolvedFamilyId, cardType);
  const recentDrafts = filterRecentDrafts(growthContext?.growth_drafts?.drafts, resolvedFamilyId, cardType);
  const sourceContext = buildSourceContext(growthContext);
  const evidence = {
    primary: {
      persona_scene_packets: personaPacketDetails.primary_packets,
      sql_scene_packets: sqlPacketDetails.primary_packets,
      source_scene_snippets: sourceSnippetDetails.primary_snippets,
      summary: {
        persona: buildEvidenceSummary(personaPacketDetails.primary_packets),
        sql: buildEvidenceSummary(sqlPacketDetails.primary_packets),
        source: buildEvidenceSummary(sourceSnippetDetails.primary_snippets)
      }
    },
    related: {
      persona_scene_packets: personaPacketDetails.related_packets,
      sql_scene_packets: sqlPacketDetails.related_packets,
      source_scene_snippets: sourceSnippetDetails.related_snippets,
      summary: {
        persona: buildEvidenceSummary(personaPacketDetails.related_packets),
        sql: buildEvidenceSummary(sqlPacketDetails.related_packets),
        source: buildEvidenceSummary(sourceSnippetDetails.related_snippets)
      }
    },
    discard_report: {
      persona: personaPacketDetails.discard_report,
      sql: sqlPacketDetails.discard_report,
      source: sourceSnippetDetails.discard_report
    }
  };
  const taskId = safeText(packetId) || [
    safeText(cardType, 'memo'),
    safeText(resolvedFamilyId || 'general'),
    safeText(key || query || 'seed'),
    nowId()
  ].join('.');
  const sourceFocus = deriveSceneSourceFocus(
    [
      ...personaPacketDetails.primary_packets,
      ...sqlPacketDetails.primary_packets,
      ...runtimePack.persona_scene_packets
    ],
    sourceSnippetDetails.primary_snippets,
    safeText(
      growthContext?.memory_context?.context?.root?.root?.canonical_name
      || growthContext?.memory_context?.context?.root?.overview
      || resolvedFamilyId
      || key
      || query
    )
  );

  return {
    ok: true,
    schema: 'persona_growth_task_packet_v0.1',
    scope: growthContext?.scope || {
      owner_id: safeText(ownerId || userId),
      realm_id: safeText(realmId, 'default'),
      bot_id: safeText(botId || charId)
    },
    task: {
      task_id: taskId,
      task_kind: `${safeText(cardType, 'memo')}_growth`,
      card_type: safeText(cardType, 'memo'),
      family_id: safeText(resolvedFamilyId),
      packet_id: safeText(packetId),
      key: safeText(key),
      query: safeText(query),
      source_focus: sourceFocus,
      candidate_card_count: candidateCards.length,
      recent_growth_count: recentLedger.length,
      recent_draft_count: recentDrafts.length
    },
    runtime_pack: runtimePack,
    source_context: sourceContext,
    sql_scene_packets: sqlScenePackets,
    source_scene_snippets: sourceSceneSnippets,
    evidence,
    candidate_cards: candidateCards,
    recent_growth: recentLedger,
    recent_drafts: recentDrafts,
    output_contract: buildOutputContract(cardType),
    hints: buildTaskHints({
      familyId: resolvedFamilyId,
      cardType,
      candidateCards,
      recentLedger,
      recentDrafts,
      sourceContext,
      runtimePack,
      sqlScenePackets,
      sourceSceneSnippets
    }),
    upstream_hints: Array.isArray(growthContext?.hints) ? growthContext.hints : []
  };
}
