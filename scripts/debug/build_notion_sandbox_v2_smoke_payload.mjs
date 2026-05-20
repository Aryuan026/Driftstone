#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const BASELINE_DIR = 'output/notion_import_baseline/driftstone_2025-02_to_2025-04_baseline';
const SOURCE_PAYLOAD = join(BASELINE_DIR, 'notion_sandbox_write_payload.json');
const OUT_PAYLOAD = join(BASELINE_DIR, 'notion_sandbox_v2_smoke_payload.json');
const OUT_ROLLBACK = join(BASELINE_DIR, 'rollback_manifest_sandbox_v2_seed.json');
const IMPORT_BATCH_ID = 'driftstone_sandbox_v2_smoke_2026-05-17';
const SELECT_COUNTS = {
  stable_memory_cards: 3,
  sampling_memory_cards: 2,
  review_queue: 2,
  source_trace_index: 2,
  relation_root_candidates: 2,
  relation_edge_candidates: 2
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function v2ExternalId(row = {}) {
  return `${row.external_id}:sandbox_v2_smoke`;
}

function v2Title(row = {}) {
  const raw = String(row.title || row.properties?.Name || 'Untitled');
  return raw.replace(/^DRY-RUN \/ SANDBOX\s*·\s*/, 'DRY-RUN / SANDBOX v2 · ');
}

function convertRow(row = {}, targetDatabase = '') {
  const next = clone(row);
  const externalId = v2ExternalId(row);
  const title = v2Title(row);
  next.external_id = externalId;
  next.title = title;
  next.properties = {
    ...(next.properties || {}),
    Name: title,
    external_id: externalId,
    import_batch_id: IMPORT_BATCH_ID,
    package_id: IMPORT_BATCH_ID,
    target_database: targetDatabase,
    rollback_status: 'sandbox_written',
    fetch_back_status: 'pending'
  };
  next.content = [
    '## Sandbox v2 Smoke Status',
    `- target_database: ${targetDatabase}`,
    `- source_month: ${next.properties.source_month || row.source_month || 'n/a'}`,
    `- external_id: ${externalId}`,
    `- import_batch_id: ${IMPORT_BATCH_ID}`,
    `- current_guard: ${next.properties.recall_guard || 'n/a'}`,
    `- recommended_recall_guard: ${next.properties.recommended_recall_guard || 'n/a'}`,
    '',
    '## Smoke Payload Preview',
    `- node_path: ${next.properties.node_path || 'n/a'}`,
    `- anchor_name: ${next.properties.anchor_name || 'n/a'}`,
    `- living_fragment: ${next.properties.living_fragment || 'n/a'}`,
    `- project_fact: ${next.properties.project_fact || 'n/a'}`,
    `- relationship_significance: ${next.properties.relationship_significance || 'n/a'}`,
    `- feeling_as_fact: ${next.properties.feeling_as_fact || 'n/a'}`,
    '',
    '## Recorder Contract',
    '- This page exists only to test create-pages immediate page_id/url capture.',
    '- Rollback truth should come from the create-pages response, then fetch-back verifies fields.',
    '- SQL-style batch query is optional audit, not required for rollback correctness.'
  ].join('\n');
  next.source_month = next.properties.source_month || row.source_month || '';
  return next;
}

function rollbackEntry(row = {}, targetDatabase = '') {
  return {
    schema: 'driftstone_notion_rollback_entry_v0.1',
    package_id: IMPORT_BATCH_ID,
    import_batch_id: IMPORT_BATCH_ID,
    target_database: targetDatabase,
    source_month: row.source_month,
    external_id: row.external_id,
    title: row.title,
    rollback_action: 'archive_page_by_notion_page_id_or_external_id',
    rollback_order: 10,
    notion_page_id: null,
    notion_page_url: null,
    status: 'not_written',
    note: 'Sandbox v2 smoke test seed. Capture notion_page_id/url from create-pages response immediately after write.'
  };
}

async function main() {
  const payload = JSON.parse(await readFile(SOURCE_PAYLOAD, 'utf8'));
  const pagesByDatabase = {};
  const rollbackEntries = [];

  for (const [database, count] of Object.entries(SELECT_COUNTS)) {
    const rows = payload.pages_by_database?.[database] || [];
    const converted = rows.slice(0, count).map((row) => convertRow(row, database));
    pagesByDatabase[database] = converted;
    rollbackEntries.push(...converted.map((row) => rollbackEntry(row, database)));
  }

  const outPayload = {
    schema: 'driftstone_notion_sandbox_v2_smoke_payload_v0.1',
    import_batch_id: IMPORT_BATCH_ID,
    source_payload: SOURCE_PAYLOAD,
    created_for: 'create-pages immediate page_id/url capture smoke test',
    pages_by_database: pagesByDatabase
  };
  const rollbackManifest = {
    schema: 'driftstone_notion_rollback_manifest_v0.1',
    package_id: IMPORT_BATCH_ID,
    import_batch_id: IMPORT_BATCH_ID,
    generated_at: new Date().toISOString(),
    writes_to_notion: false,
    rollback_state: 'sandbox_v2_seed_not_written',
    total_entries: rollbackEntries.length,
    entries: rollbackEntries
  };

  await mkdir(BASELINE_DIR, { recursive: true });
  await writeFile(OUT_PAYLOAD, `${JSON.stringify(outPayload, null, 2)}\n`, 'utf8');
  await writeFile(OUT_ROLLBACK, `${JSON.stringify(rollbackManifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    import_batch_id: IMPORT_BATCH_ID,
    payload: OUT_PAYLOAD,
    rollback_manifest: OUT_ROLLBACK,
    counts: Object.fromEntries(Object.entries(pagesByDatabase).map(([key, rows]) => [key, rows.length])),
    total: rollbackEntries.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
