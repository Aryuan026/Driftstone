import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import { firstValue, parseCsvText, toInt } from './csv-reader.js';
import { STAGE_DIRS } from './path-config.js';

let reviewedFileListCache = null;
const reviewedCsvCache = new Map();
const reviewedDatasetCache = new Map();

function monthKeyFromName(name) {
  const text = String(name || '');
  const dash = text.match(/(20\d{2})-(\d{2})/);
  if (dash) return `${dash[1]}-${dash[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function normalizeMonthHint(value) {
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
    const month = normalizeMonthHint(value);
    if (month) set.add(month);
  }
  return set;
}

function normalizeReviewedLayer(row) {
  const explicit = firstValue(row, ['layer', 'source_type', 'sourceType']).toLowerCase();
  if (explicit === 'persona' || explicit === 'sql' || explicit === 'case') return explicit;
  if (firstValue(row, ['card_id', 'card_type', 'card_name'])) return 'sql';
  return 'unknown';
}

export async function listReviewedCsvFiles() {
  const { readdir } = await import('fs/promises');
  if (reviewedFileListCache) return reviewedFileListCache;
  try {
    const names = (await readdir(STAGE_DIRS.reviewed)).filter((name) => !name.startsWith('.') && name.toLowerCase().endsWith('.csv'));
    reviewedFileListCache = names.sort().map((name) => ({
      name,
      month_key: monthKeyFromName(name),
      path: join(STAGE_DIRS.reviewed, name)
    }));
    return reviewedFileListCache;
  } catch {
    return [];
  }
}

export async function loadReviewedCsv(filePath) {
  if (reviewedCsvCache.has(filePath)) return reviewedCsvCache.get(filePath);
  const raw = await readFile(filePath, 'utf-8');
  const rows = parseCsvText(raw);
  const mapped = rows.map((row, index) => ({
    row_no: toInt(firstValue(row, ['row_no']), index + 1),
    layer: normalizeReviewedLayer(row),
    title: firstValue(row, ['title', 'card_name', 'anchor_name', 'fact_key']),
    time: firstValue(row, ['time', 'first_seen_at', 'last_seen_at']),
    record_id: firstValue(row, ['record_id']),
    family_id: firstValue(row, ['family_id']),
    family_kind: firstValue(row, ['family_kind']),
    family_anchor_id: firstValue(row, ['family_anchor_id']),
    family_anchor_title: firstValue(row, ['family_anchor_title']),
    family_reason: firstValue(row, ['family_reason']),
    card_type: firstValue(row, ['card_type', 'anchor_type']),
    card_name: firstValue(row, ['card_name', 'anchor_name']),
    anchor_type: firstValue(row, ['anchor_type', 'card_type']),
    anchor_name: firstValue(row, ['anchor_name', 'card_name']),
    fact_key: firstValue(row, ['fact_key']),
    fact_keys: firstValue(row, ['fact_keys']),
    fact_value: firstValue(row, ['fact_value']),
    fact_role: firstValue(row, ['fact_role']),
    value_type: firstValue(row, ['value_type']),
    expression_fingerprint: firstValue(row, ['expression_fingerprint', 'tone_sample']),
    quote_refs: firstValue(row, ['quote_refs']),
    quote_refs_text: firstValue(row, ['quote_refs_text', 'quote_refs']),
    content_text: firstValue(row, ['content_text', 'text', 'summary']),
    text: firstValue(row, ['text', 'content_text', 'summary']),
    summary: firstValue(row, ['summary', 'content_text', 'text']),
    stable_points: firstValue(row, ['stable_points']),
    update_points: firstValue(row, ['update_points']),
    first_seen_at: firstValue(row, ['first_seen_at']),
    last_seen_at: firstValue(row, ['last_seen_at']),
    evolution_status: firstValue(row, ['evolution_status']),
    version_count: toInt(firstValue(row, ['version_count']), 0),
    source_ref: firstValue(row, ['source_ref']),
    source_window_id: firstValue(row, ['source_window_id']),
    source_window_title: firstValue(row, ['source_window_title']),
    source_msg_start: firstValue(row, ['source_msg_start']),
    source_msg_end: firstValue(row, ['source_msg_end']),
    topic_ids: firstValue(row, ['topic_ids']),
    topic_labels: firstValue(row, ['topic_labels', 'merged_topic_labels']),
    track_id: firstValue(row, ['track_id']),
    tags: firstValue(row, ['tags']),
    entity_refs: firstValue(row, ['entity_refs']),
    raw: row
  }));
  reviewedCsvCache.set(filePath, mapped);
  return mapped;
}

function countBy(items, key) {
  const out = {};
  for (const item of items) {
    const bucket = String(item && item[key] ? item[key] : 'unknown');
    out[bucket] = (out[bucket] || 0) + 1;
  }
  return out;
}

export async function getReviewedSummary() {
  const files = await listReviewedCsvFiles();
  const months = [];
  const totals = {
    rows: 0,
    persona: 0,
    sql: 0,
    case: 0,
    unknown: 0
  };

  for (const file of files) {
    const rows = await loadReviewedCsv(file.path);
    const layers = countBy(rows, 'layer');
    const sqlRows = rows.filter((row) => row.layer === 'sql');
    const evolution = countBy(sqlRows.map((row) => ({
      bucket: row.evolution_status || 'volatile'
    })), 'bucket');
    months.push({
      file: basename(file.path),
      month_key: file.month_key || basename(file.path),
      rows: rows.length,
      layers,
      sql_evolution: evolution,
      sql_roots_hint: Array.from(new Set(sqlRows
        .map((row) => firstValue(row, ['anchor_name', 'card_name', 'title']))
        .filter(Boolean))).slice(0, 12)
    });
    totals.rows += rows.length;
    totals.persona += layers.persona || 0;
    totals.sql += layers.sql || 0;
    totals.case += layers.case || 0;
    totals.unknown += layers.unknown || 0;
  }

  return {
    reviewed_dir: STAGE_DIRS.reviewed,
    months,
    totals
  };
}

export async function loadReviewedDataset(options = {}) {
  const wantedLayers = Array.isArray(options.layers) && options.layers.length
    ? new Set(options.layers.map((item) => String(item || '').trim().toLowerCase()))
    : null;
  const monthHints = buildMonthHintSet(options.monthHints || options.month_keys || options.monthKeys || []);
  const cacheKey = wantedLayers
    ? Array.from(wantedLayers).sort().join('|')
    : '__all__';
  const scopedCacheKey = `${cacheKey}::${Array.from(monthHints).sort().join('|') || '__all_months__'}`;
  if (reviewedDatasetCache.has(scopedCacheKey)) return reviewedDatasetCache.get(scopedCacheKey);
  const files = await listReviewedCsvFiles();
  const months = [];
  const rows = [];

  for (const file of files) {
    if (monthHints.size && !monthHints.has(file.month_key)) continue;
    const fileRows = await loadReviewedCsv(file.path);
    const filtered = wantedLayers
      ? fileRows.filter((row) => wantedLayers.has(String(row.layer || '').trim().toLowerCase()))
      : fileRows;
    const monthRows = filtered.map((row) => ({
      ...row,
      month_key: file.month_key || basename(file.path),
      source_file: basename(file.path)
    }));
    months.push({
      month_key: file.month_key || basename(file.path),
      file: basename(file.path),
      rows: monthRows
    });
    rows.push(...monthRows);
  }

  const result = {
    files: files.map((file) => ({
      name: basename(file.path),
      month_key: file.month_key || basename(file.path),
      path: file.path
    })),
    months,
    rows
  };
  reviewedDatasetCache.set(scopedCacheKey, result);
  return result;
}
