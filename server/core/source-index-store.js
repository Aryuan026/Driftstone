import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { STAGE_DIRS } from './path-config.js';

let sourceIndexCache = null;

function monthKeyFromText(name = '') {
  const text = String(name || '');
  const dash = text.match(/(20\d{2})-(\d{2})/);
  if (dash) return `${dash[1]}-${dash[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function buildMonthHintSet(values = []) {
  const set = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const month = monthKeyFromText(value);
    if (month) set.add(month);
  }
  return set;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

function normalizeTopicEntry(entry, file) {
  return {
    file,
    source_bundle_id: entry?.source_bundle_id || '',
    chunk_id: entry?.chunk_id || '',
    topic_id: entry?.topic_id || '',
    topic_label: entry?.topic_label || '',
    topic_role: entry?.topic_role || '',
    exposure_priority: entry?.exposure_priority || '',
    source_window_id: entry?.source_window_id || '',
    source_window_title: entry?.source_window_title || '',
    source_msg_start: entry?.source_msg_start || null,
    source_msg_end: entry?.source_msg_end || null,
    anchor_ids: Array.isArray(entry?.anchor_ids) ? entry.anchor_ids : [],
    topic_keywords: Array.isArray(entry?.topic_keywords) ? entry.topic_keywords : [],
    background_only: !!entry?.background_only,
    excerpt_hint: entry?.excerpt_hint || '',
    excerpt_text: entry?.excerpt_text || entry?.excerpt || '',
    prev_topic_id: entry?.prev_topic_id || null,
    next_topic_id: entry?.next_topic_id || null
  };
}

export async function loadSourceTopicEntries() {
  if (sourceIndexCache) return sourceIndexCache;
  const dir = STAGE_DIRS.source_index;
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sourceIndexCache = [];
      return sourceIndexCache;
    }
    throw error;
  }
  const entries = [];
  for (const file of files) {
    const payload = await readJson(join(dir, file));
    const topics = Array.isArray(payload?.source_topic_index) ? payload.source_topic_index : [];
    for (const entry of topics) {
      entries.push(normalizeTopicEntry(entry, file));
    }
  }
  sourceIndexCache = entries;
  return entries;
}

export async function findShadowSnippets({ topicIds = [], sourceWindows = [], sourceBatches = [], monthHints = [] } = {}, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 8;
  const topicSet = new Set((Array.isArray(topicIds) ? topicIds : []).map((item) => String(item || '').trim()).filter(Boolean));
  const windowSet = new Set((Array.isArray(sourceWindows) ? sourceWindows : []).map((item) => String(item || '').trim()).filter(Boolean));
  const batchHints = (Array.isArray(sourceBatches) ? sourceBatches : []).map((item) => String(item || '').trim()).filter(Boolean);
  const monthSet = buildMonthHintSet(monthHints);

  const entries = await loadSourceTopicEntries();
  const scored = [];
  for (const entry of entries) {
    if (monthSet.size && !monthSet.has(monthKeyFromText(entry.file))) continue;
    let score = 0;
    if (topicSet.has(entry.topic_id)) score += 5;
    if (windowSet.has(entry.source_window_id)) score += 3;
    if (batchHints.some((batch) => entry.file.includes(batch.replace(/\.csv$/i, '')) || entry.file.includes(batch.replace(/reviewed-memory-reviewed\.csv$/i, '')))) {
      score += 1;
    }
    if (!score) continue;
    scored.push({
      score,
      snippet: {
        source_bundle_id: entry.source_bundle_id,
        topic_id: entry.topic_id,
        topic_label: entry.topic_label,
        topic_role: entry.topic_role,
        source_window_id: entry.source_window_id,
        source_window_title: entry.source_window_title,
        source_msg_range: entry.source_msg_start && entry.source_msg_end ? `${entry.source_msg_start}-${entry.source_msg_end}` : '',
        excerpt_hint: entry.excerpt_hint,
        excerpt_text: entry.excerpt_text,
        keywords: entry.topic_keywords.slice(0, 6),
        file: entry.file
      }
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.snippet.topic_id).localeCompare(String(b.snippet.topic_id));
  });

  const seen = new Set();
  const out = [];
  for (const item of scored) {
    const key = `${item.snippet.topic_id}::${item.snippet.source_window_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.snippet);
    if (out.length >= limit) break;
  }
  return out;
}

export function resetSourceIndexCache() {
  sourceIndexCache = null;
}
