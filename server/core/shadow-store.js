import { access, readFile } from 'fs/promises';
import { findShadowSnippets as findLegacyShadowSnippets } from './source-index-store.js';
import { findPreparedShadowSnippets } from './prepared-shadow-store.js';

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

function excerptText(text, limit = 320) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

function normalizeScopedSlice(doc, file) {
  const schema = safeText(doc?.schema);
  if (schema === 'hippocove_translation_slice_v0.1') {
    return {
      source_mode: 'scoped_truth',
      source_kind: 'translation_slice',
      slice_id: safeText(doc?.slice_id),
      doc_id: safeText(doc?.doc_id),
      title: safeText(doc?.title),
      kind: safeText(doc?.kind),
      created_at: safeText(doc?.created_at),
      start_char: Number(doc?.start_char || 0),
      end_char: Number(doc?.end_char || 0),
      char_count: Number(doc?.char_count || 0),
      prompt_hint: safeText(doc?.prompt_hint),
      preview: safeText(doc?.preview),
      excerpt: excerptText(doc?.text),
      file
    };
  }

  if (schema === 'hippocove_ingest_document_v0.1') {
    return {
      source_mode: 'scoped_truth',
      source_kind: 'ingest_document',
      slice_id: '',
      doc_id: safeText(doc?.doc_id),
      title: safeText(doc?.title),
      kind: safeText(doc?.kind),
      created_at: safeText(doc?.created_at),
      start_char: 0,
      end_char: Number(doc?.char_count || 0),
      char_count: Number(doc?.char_count || 0),
      prompt_hint: '',
      preview: safeText(doc?.preview),
      excerpt: excerptText(doc?.text),
      file
    };
  }

  return null;
}

export async function loadScopedShadowSnippets({
  sourceRefs = []
} = {}, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 8;
  const refs = uniqueStrings(sourceRefs, limit * 4);
  const out = [];
  const seen = new Set();

  for (const file of refs) {
    if (out.length >= limit) break;
    if (!await fileExists(file)) continue;
    let parsed = null;
    try {
      parsed = await readJson(file);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const normalized = normalizeScopedSlice(parsed, file);
    if (!normalized) continue;
    const dedupeKey = `${normalized.source_kind}::${normalized.slice_id || normalized.doc_id || file}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(normalized);
  }

  return out;
}

export async function getShadowRecall({
  sourceRefs = [],
  sourceGroupKeys = [],
  sourceWindows = [],
  topicIds = [],
  sourceBatches = [],
  queryTerms = []
} = {}, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 8;
  const scoped = await loadScopedShadowSnippets({ sourceRefs }, { limit });
  let remaining = Math.max(0, limit - scoped.length);

  let prepared = [];
  if (remaining > 0) {
    prepared = await findPreparedShadowSnippets({
      sourceRefs,
      sourceWindows,
      topicIds,
      sourceBatches,
      queryTerms
    }, { limit: remaining });
    remaining = Math.max(0, remaining - prepared.length);
  }

  let fallback = [];
  if (remaining > 0) {
    fallback = await findLegacyShadowSnippets({
      topicIds,
      sourceWindows,
      sourceBatches
    }, { limit: remaining });
  }

  let source_mode = 'none';
  if (scoped.length) {
    source_mode = prepared.length || fallback.length ? 'mixed' : 'scoped_truth';
  } else if (prepared.length) {
    source_mode = fallback.length ? 'legacy_prepared_mixed' : 'legacy_prepared';
  } else if (fallback.length) {
    source_mode = 'dev_fallback';
  }

  return {
    source_mode,
    exact_count: scoped.length,
    prepared_count: prepared.length,
    fallback_count: fallback.length,
    source_group_keys: uniqueStrings(sourceGroupKeys, 24),
    snippets: [...scoped, ...prepared, ...fallback]
  };
}
