#!/usr/bin/env node
// Debug-only rehydrate helper for Ajimem dropbox snapshots.
// This file is intentionally isolated under scripts/debug so it can be removed
// after the cache recovery experiment without touching the main app flow.
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { saveWorkbenchCacheRows } from '../../server/core/workbench-cache-service.js';
import { savePersonaCacheRows } from '../../server/core/persona-workspace-service.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeMonth(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const dashed = text.match(/(20\d{2})-(\d{2})/);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function normalizeWorkbenchRow(row = {}) {
  return {
    ...row,
    layer: safeText(row.layer).toLowerCase(),
    title: safeText(row.title || row.card_name || row.anchor_name || row.object_name || row.object),
    time: safeText(row.time || row.last_seen_at || row.recorded_at),
    summary: safeText(row.summary),
    content_text: String(row.content_text || row.text || '').trim(),
    text: String(row.text || row.content_text || '').trim(),
    expression_fingerprint: safeText(row.expression_fingerprint),
    quote_refs: safeText(row.quote_refs || row.quote_refs_text),
    quote_refs_text: safeText(row.quote_refs_text || row.quote_refs),
    tags: Array.isArray(row.tags) ? row.tags.join(' ') : safeText(row.tags),
    topic_ids: safeText(row.topic_ids),
    topic_labels: safeText(row.topic_labels),
    track_id: safeText(row.track_id),
    event_anchor: safeText(row.event_anchor),
    source_window_id: safeText(row.source_window_id),
    source_window_title: safeText(row.source_window_title),
    source_msg_start: row.source_msg_start || '',
    source_msg_end: row.source_msg_end || '',
    source_ref: safeText(row.source_ref),
    source_bundle_id: safeText(row.source_bundle_id || row.source_bundle || row.bundle_id),
    source_bundle: safeText(row.source_bundle || row.source_bundle_id || row.bundle_id),
    bundle_id: safeText(row.bundle_id || row.source_bundle_id || row.source_bundle),
    source_md_ref: safeText(row.source_md_ref),
    source_manifest_kind: safeText(row.source_manifest_kind),
    chunk_id: safeText(row.chunk_id),
    record_id: safeText(row.record_id),
    memory_key: safeText(row.memory_key),
    anchor_name: safeText(row.anchor_name || row.card_name),
    fact_key: safeText(row.fact_key),
    entity_refs: safeText(row.entity_refs)
  };
}

function rowMonthKey(row = {}, fileName = '') {
  return normalizeMonth(
    row.time
    || row.first_seen_at
    || row.last_seen_at
    || row.recorded_at
    || fileName
  );
}

function parseArgs(argv = []) {
  const out = {
    dropboxDir: '/Users/mac/Documents/Ajimem',
    monthHints: [],
    dryRun: false,
    allowAll: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--all') {
      out.allowAll = true;
      continue;
    }
    if (arg === '--dropbox' && argv[i + 1]) {
      out.dropboxDir = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--month' && argv[i + 1]) {
      const month = normalizeMonth(argv[i + 1]);
      if (month) out.monthHints.push(month);
      i += 1;
      continue;
    }
  }
  out.monthHints = Array.from(new Set(out.monthHints));
  return out;
}

function buildMonthSummary(rows = []) {
  const summary = new Map();
  for (const row of rows) {
    const monthKey = safeText(row._rehydrate_month_key, 'unknown');
    if (!summary.has(monthKey)) {
      summary.set(monthKey, {
        month_key: monthKey,
        total_rows: 0,
        persona_rows: 0,
        sql_rows: 0
      });
    }
    const bucket = summary.get(monthKey);
    bucket.total_rows += 1;
    if (row.layer === 'persona') bucket.persona_rows += 1;
    else if (row.layer === 'sql') bucket.sql_rows += 1;
  }
  return Array.from(summary.values()).sort((a, b) => String(a.month_key).localeCompare(String(b.month_key)));
}

async function loadWorkbenchRows(dropboxDir, monthHints = []) {
  const workbenchDir = join(dropboxDir, '01_workbench');
  const names = (await readdir(workbenchDir))
    .filter((name) => !name.startsWith('.') && name.toLowerCase().endsWith('.json'))
    .sort();
  const rows = [];
  for (const name of names) {
    const filePath = join(workbenchDir, name);
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : [];
    for (const item of list) {
      const row = normalizeWorkbenchRow(item);
      if (!['persona', 'sql'].includes(row.layer)) continue;
      const monthKey = rowMonthKey(row, name);
      if (monthHints.length && !monthHints.includes(monthKey)) continue;
      rows.push({
        ...row,
        _rehydrate_source_file: basename(filePath),
        _rehydrate_month_key: monthKey
      });
    }
  }
  rows.sort((a, b) => {
    const timeDiff = String(a.time || '').localeCompare(String(b.time || ''));
    if (timeDiff !== 0) return timeDiff;
    const fileDiff = String(a._rehydrate_source_file || '').localeCompare(String(b._rehydrate_source_file || ''));
    if (fileDiff !== 0) return fileDiff;
    return String(a.record_id || a.memory_key || a.title || '').localeCompare(String(b.record_id || b.memory_key || b.title || ''));
  });
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allRows = await loadWorkbenchRows(dropboxDirOrDefault(args.dropboxDir), []);
  const monthSummary = buildMonthSummary(allRows);
  if (!args.allowAll && !args.monthHints.length) {
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      needs_month_hint: true,
      summary: {
        dropbox_dir: args.dropboxDir,
        total_rows: allRows.length,
        available_months: monthSummary
      },
      hint: 'Use --month YYYY-MM (repeatable) or --all to rehydrate debug cache snapshots.'
    }, null, 2));
    return;
  }

  const selectedRows = args.allowAll
    ? allRows
    : allRows.filter((row) => args.monthHints.includes(row._rehydrate_month_key));
  const personaRows = selectedRows.filter((row) => row.layer === 'persona');
  const summary = {
    dropbox_dir: args.dropboxDir,
    month_hints: args.monthHints,
    allow_all: args.allowAll,
    total_rows: selectedRows.length,
    persona_rows: personaRows.length,
    sql_rows: selectedRows.length - personaRows.length,
    available_months: monthSummary
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dry_run: true, summary }, null, 2));
    return;
  }

  const [workbenchResult, personaResult] = await Promise.all([
    saveWorkbenchCacheRows(selectedRows, { preserveExistingOnEmpty: false }),
    savePersonaCacheRows(personaRows, { preserveExistingOnEmpty: false })
  ]);

  console.log(JSON.stringify({
    ok: true,
    summary,
    workbench_cache: workbenchResult,
    persona_cache: personaResult
  }, null, 2));
}

function dropboxDirOrDefault(value = '') {
  return safeText(value, '/Users/mac/Documents/Ajimem');
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: safeText(error?.message, String(error || 'unknown error'))
  }, null, 2));
  process.exitCode = 1;
});
