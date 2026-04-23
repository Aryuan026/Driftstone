import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { STAGE_DIRS } from './path-config.js';
import { loadSourceTopicEntries } from './source-index-store.js';

let preparedChunkCache = null;

function safeText(value) {
  return String(value || '').trim();
}

function uniqueStrings(items, limit = 12) {
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

function excerptText(text, limit = 420) {
  const value = String(text || '')
    .replace(/\[EXTRACT_META\][\s\S]*?\[\/EXTRACT_META\]/g, ' ')
    .replace(/^#.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return '';
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function parseSourceRef(ref) {
  const text = safeText(ref);
  const match = text.match(/^(window_\d{8})_msg_(\d+)$/);
  if (!match) return null;
  return {
    raw: text,
    window_ref: match[1],
    msg_index: safeNumber(match[2])
  };
}

function normalizePreparedChunk(entry, file) {
  const fullText = excerptText(entry?.text, 12000);
  return {
    file,
    source_bundle_id: safeText(entry?.source_bundle_id),
    source_md_ref: safeText(entry?.source_md_ref),
    source_manifest_kind: safeText(entry?.source_manifest_kind),
    chunk_id: safeText(entry?.chunk_id),
    source_ref: safeText(entry?.source_ref),
    source_window_id: safeText(entry?.source_window_id),
    source_window_title: safeText(entry?.source_window_title),
    source_msg_start: safeNumber(entry?.source_msg_start),
    source_msg_end: safeNumber(entry?.source_msg_end),
    source_start_date: safeText(entry?.source_start_date),
    source_end_date: safeText(entry?.source_end_date),
    search_text: fullText,
    preview: excerptText(entry?.text, 220),
    excerpt: excerptText(entry?.text, 520)
  };
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

export async function loadPreparedChunks() {
  if (preparedChunkCache) return preparedChunkCache;
  const dir = STAGE_DIRS.prepared_bundle;
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      preparedChunkCache = [];
      return preparedChunkCache;
    }
    throw error;
  }
  const chunks = [];
  for (const file of files) {
    const payload = await readJson(join(dir, file));
    if (!Array.isArray(payload)) continue;
    for (const entry of payload) {
      chunks.push(normalizePreparedChunk(entry, file));
    }
  }
  preparedChunkCache = chunks;
  return chunks;
}

function rangesOverlap(startA, endA, startB, endB) {
  if (!startA || !endA || !startB || !endB) return false;
  return startA <= endB && startB <= endA;
}

function sourceRefMatchesChunk(refInfo, chunk, windowSet) {
  if (!refInfo) return false;
  if (safeText(chunk.source_ref) === refInfo.raw) return true;
  if (windowSet.size && !windowSet.has(chunk.source_window_id)) return false;
  if (!chunk.source_msg_start || !chunk.source_msg_end) return false;
  return refInfo.msg_index >= chunk.source_msg_start && refInfo.msg_index <= chunk.source_msg_end;
}

function buildPreparedSnippet(chunk, topicEntry, score) {
  return {
    source_mode: 'legacy_prepared',
    source_kind: topicEntry ? 'prepared_topic_chunk' : 'prepared_chunk',
    slice_id: safeText(chunk.chunk_id),
    doc_id: safeText(chunk.source_bundle_id || chunk.source_md_ref || chunk.file),
    source_ref: safeText(chunk.source_ref),
    topic_id: safeText(topicEntry?.topic_id),
    topic_label: safeText(topicEntry?.topic_label),
    topic_role: safeText(topicEntry?.topic_role),
    source_window_id: safeText(chunk.source_window_id),
    source_window_title: safeText(chunk.source_window_title),
    source_msg_range: chunk.source_msg_start && chunk.source_msg_end
      ? `${chunk.source_msg_start}-${chunk.source_msg_end}`
      : '',
    excerpt_hint: safeText(topicEntry?.excerpt_hint),
    prompt_hint: safeText(chunk.preview),
    preview: safeText(chunk.preview),
    excerpt: safeText(chunk.excerpt),
    keywords: uniqueStrings(topicEntry?.topic_keywords || [], 6),
    file: safeText(chunk.file),
    score
  };
}

function normalizeSearchText(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/[\s\p{P}\p{S}]+/gu, '');
}

function splitSearchTerms(value) {
  return normalizeSearchText(value)
    .split(/[\s=；;，,。.!！？?、|/:：()\[\]{}（）"'“”‘’\-]+/u)
    .map((item) => compactSearchText(item))
    .filter((item) => item.length >= 2);
}

function scoreQueryTermAgainstChunk(term, chunk) {
  const searchCorpus = compactSearchText(chunk?.search_text || chunk?.excerpt || chunk?.preview || '');
  const query = compactSearchText(term);
  if (!searchCorpus || !query) return 0;
  if (searchCorpus.includes(query)) return 1;

  const segments = splitSearchTerms(term);
  let totalLength = 0;
  let matchedLength = 0;
  for (const segment of segments) {
    if (segment.length < 3) continue;
    totalLength += segment.length;
    if (searchCorpus.includes(segment)) {
      matchedLength += segment.length;
    }
  }

  if (totalLength > 0) {
    return Number((matchedLength / totalLength).toFixed(4));
  }
  return 0;
}

export async function findPreparedShadowSnippets({
  sourceRefs = [],
  sourceWindows = [],
  topicIds = [],
  sourceBatches = [],
  queryTerms = []
} = {}, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 8;
  const chunks = await loadPreparedChunks();
  const topicEntries = await loadSourceTopicEntries();

  const windowSet = new Set(uniqueStrings(sourceWindows, 48));
  const refInfos = uniqueStrings(sourceRefs, 48).map(parseSourceRef).filter(Boolean);
  const topicSet = new Set(uniqueStrings(topicIds, 48));
  const batchHints = uniqueStrings(sourceBatches, 24);
  const queryHints = uniqueStrings(queryTerms, 24).filter((item) => safeText(item).length >= 2);

  const matchedTopics = topicEntries.filter((entry) => topicSet.has(entry.topic_id));
  const scored = [];

  for (const chunk of chunks) {
    let score = 0;
    let matchedTopic = null;

    for (const refInfo of refInfos) {
      if (sourceRefMatchesChunk(refInfo, chunk, windowSet)) {
        score += safeText(chunk.source_ref) === refInfo.raw ? 10 : 7;
      }
    }

    if (windowSet.has(chunk.source_window_id)) {
      score += 2;
    }

    if (batchHints.some((batch) => chunk.file.includes(batch.replace(/reviewed-memory-reviewed\.csv$/i, '')))) {
      score += 1;
    }

    let queryHitCount = 0;
    let queryScore = 0;
    for (const term of queryHints) {
      const hit = scoreQueryTermAgainstChunk(term, chunk);
      if (hit >= 0.95) {
        queryScore += 5;
        queryHitCount += 1;
      } else if (hit >= 0.6) {
        queryScore += 3;
        queryHitCount += 1;
      } else if (hit >= 0.3) {
        queryScore += 1.5;
        queryHitCount += 1;
      }
    }

    if (queryHitCount) {
      score += queryScore + Math.min(4, queryHitCount);
    }

    for (const topic of matchedTopics) {
      if (safeText(topic.source_window_id) !== safeText(chunk.source_window_id)) continue;
      if (rangesOverlap(
        safeNumber(topic.source_msg_start),
        safeNumber(topic.source_msg_end),
        safeNumber(chunk.source_msg_start),
        safeNumber(chunk.source_msg_end)
      )) {
        matchedTopic = topic;
        score += 8;
        break;
      }
    }

    if (!score) continue;
    scored.push({
      score,
      snippet: buildPreparedSnippet(chunk, matchedTopic, score)
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.snippet.slice_id || '').localeCompare(String(b.snippet.slice_id || ''));
  });

  const out = [];
  const seen = new Set();
  for (const item of scored) {
    const key = `${item.snippet.source_kind}::${item.snippet.slice_id || item.snippet.doc_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.snippet);
    if (out.length >= limit) break;
  }
  return out;
}

export function resetPreparedChunkCache() {
  preparedChunkCache = null;
}
