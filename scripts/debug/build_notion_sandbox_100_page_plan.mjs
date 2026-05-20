#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const BASELINE_DIR = 'output/notion_import_baseline/driftstone_2025-02_to_2025-04_baseline';
const SOURCE_WRITE_PLAN = join(BASELINE_DIR, 'notion_baseline_write_plan.jsonl');
const DEFAULT_VARIANT = 'v3';

const SELECT_COUNTS = {
  stable_memory_cards: 30,
  sampling_memory_cards: 10,
  review_queue: 10,
  source_trace_index: 20,
  relation_root_candidates: 15,
  relation_edge_candidates: 12,
  monthly_import_reports: 3
};

const MONTH_ORDER = ['2025-02', '2025-03', '2025-04'];

function parseArgs(argv = []) {
  const args = {
    variant: DEFAULT_VARIANT,
    legacy: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeString(argv[index]);
    if (arg === '--variant' && argv[index + 1]) {
      args.variant = safeString(argv[index + 1], args.variant).replace(/[^a-zA-Z0-9_-]/g, '');
      index += 1;
      continue;
    }
    if (arg === '--legacy') args.legacy = true;
  }
  if (args.legacy) args.variant = '';
  return args;
}

function batchIdForVariant(variant = '') {
  return variant
    ? `driftstone_sandbox_100_${variant}_plan_2026-05-19`
    : 'driftstone_sandbox_100_plan_2026-05-18';
}

function suffixForVariant(variant = '') {
  return variant ? `sandbox_100_${variant}_plan` : 'sandbox_100_plan';
}

function outputFilesForVariant(variant = '') {
  const mid = variant ? `_sandbox_100_${variant}` : '_sandbox_100';
  return {
    payload: join(BASELINE_DIR, `notion${mid}_write_payload.json`),
    rollback: join(BASELINE_DIR, `rollback_manifest${mid}_seed.json`),
    plan: join(BASELINE_DIR, `notion${mid}_page_write_plan.md`)
  };
}

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readJsonl(text) {
  return text.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

function stripSandboxPrefix(title = '') {
  return String(title).replace(/^DRY-RUN \/ SANDBOX(?: 100)?\s*·\s*/, '').trim();
}

function sandboxExternalId(row = {}, variant = '') {
  return `${row.external_id}:${suffixForVariant(variant)}`;
}

function sandboxTitle(row = {}, variant = '') {
  const label = variant ? `DRY-RUN / SANDBOX 100 ${variant.toUpperCase()}` : 'DRY-RUN / SANDBOX 100';
  return `${label} · ${stripSandboxPrefix(row.title || row.properties?.Name || 'Untitled')}`;
}

function extractPreviewLine(row = {}, prefix = '') {
  const lines = Array.isArray(row.content_preview) ? row.content_preview : [];
  const match = lines.find((line) => String(line).startsWith(prefix));
  return match ? String(match).slice(prefix.length).trim() : '';
}

function inferContextDomain(row = {}, nodePath = '', targetDatabase = '') {
  const explicit = safeString(row.properties?.context_domain);
  if (explicit) return explicit;
  if (targetDatabase === 'source_trace_index') return 'source_trace';
  if (targetDatabase === 'relation_root_candidates') return 'relation_graph';
  if (targetDatabase === 'relation_edge_candidates') return 'relation_graph';
  if (targetDatabase === 'monthly_import_reports') return 'monthly_report';
  const text = `${nodePath} ${row.title || ''}`;
  if (/工程协作|代码|API|MCP|Notion|Obsidian|网关|Hippocove|Driftstone/i.test(text)) return 'engineering';
  if (/项目协作|项目|工具|导出|沙盒|baseline/i.test(text)) return 'project';
  if (/创作协作|创作|世界观|角色|小说|复诞纪元|剧场/.test(text)) return 'creative';
  if (/生活|事实线|日常|天气|出门|饮食|家/.test(text)) return 'life';
  if (/关系|亲密|靠近|共生|边界|承诺|依恋/.test(text)) return 'relationship';
  return 'mixed';
}

function selectBalancedByMonth(rows = [], count = 0) {
  const buckets = new Map();
  for (const row of rows) {
    const month = row.source_month || 'unknown';
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month).push(row);
  }
  const orderedMonths = [
    ...MONTH_ORDER.filter((month) => buckets.has(month)),
    ...[...buckets.keys()].filter((month) => !MONTH_ORDER.includes(month)).sort()
  ];
  const selected = [];
  let cursor = 0;
  while (selected.length < count && orderedMonths.length > 0) {
    const month = orderedMonths[cursor % orderedMonths.length];
    const bucket = buckets.get(month) || [];
    if (bucket.length > 0) selected.push(bucket.shift());
    if (bucket.length === 0) {
      orderedMonths.splice(cursor % orderedMonths.length, 1);
      cursor = 0;
    } else {
      cursor += 1;
    }
  }
  return selected;
}

function convertRow(row = {}, targetDatabase = '', runtime = {}) {
  const props = row.properties || {};
  const externalId = sandboxExternalId(row, runtime.variant);
  const title = sandboxTitle(row, runtime.variant);
  const nodePath = safeString(props.node_path, extractPreviewLine(row, '路径：'));
  const contextDomain = inferContextDomain(row, nodePath, targetDatabase);
  const recallGuard = safeString(props.recall_guard, targetDatabase === 'review_queue' ? 'audit_only' : 'n/a');
  const recommendedRecallGuard = safeString(props.recommended_recall_guard, recallGuard);
  const archiveBucket = safeString(props.archive_bucket);
  const frontendDeliveryTier = safeString(props.frontend_delivery_tier || props.front_recall_tier, recommendedRecallGuard);
  const anchorName = safeString(props.anchor_name, stripSandboxPrefix(row.title || 'Untitled'));
  const livingFragment = safeString(props.living_fragment, extractPreviewLine(row, '现场：'));
  const projectFact = safeString(props.project_fact);
  const relationshipSignificance = safeString(props.relationship_significance);
  const feelingAsFact = safeString(props.feeling_as_fact, extractPreviewLine(row, '情绪事实：'));
  const sourceMonth = safeString(row.source_month || props.source_month, 'unknown');
  const sourceTraceCount = safeNumber(props.source_trace_count);
  const sourceSpanCount = safeNumber(props.source_span_count);

  return {
    schema: 'driftstone_notion_sandbox_100_page_v0.1',
    source_schema: row.schema,
    package_id: runtime.importBatchId,
    import_batch_id: runtime.importBatchId,
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false,
    operation: 'upsert_page_by_external_id',
    source_operation: row.operation,
    target_database: targetDatabase,
    source_month: sourceMonth,
    source_file: row.source_file,
    source_id: row.source_id,
    source_external_id: row.external_id,
    external_id: externalId,
    title,
    properties: {
      Name: title,
      external_id: externalId,
      import_batch_id: runtime.importBatchId,
      package_id: runtime.importBatchId,
      source_month: sourceMonth,
      target_database: targetDatabase,
      review_status: safeString(props.review_status || props.import_status, 'n/a'),
      archive_bucket: archiveBucket,
      recall_guard: recallGuard,
      recommended_recall_guard: recommendedRecallGuard,
      frontend_delivery_tier: frontendDeliveryTier,
      guard_sanity_note: safeString(props.guard_sanity_note),
      front_recall_tier: frontendDeliveryTier,
      context_domain: contextDomain,
      effective_context_domain: safeString(props.effective_context_domain, contextDomain),
      node_path: nodePath,
      anchor_name: anchorName,
      living_fragment: livingFragment,
      project_fact: projectFact,
      relationship_significance: relationshipSignificance,
      feeling_as_fact: feelingAsFact,
      source_trace_count: sourceTraceCount,
      source_span_count: sourceSpanCount,
      rollback_status: 'sandbox_planned',
      fetch_back_status: 'pending'
    },
    source_properties: props,
    source_content_preview: row.content_preview || [],
    content: [
      '## Sandbox 100 Write Status',
      `- target_database: ${targetDatabase}`,
      `- source_month: ${sourceMonth}`,
      `- external_id: ${externalId}`,
      `- import_batch_id: ${runtime.importBatchId}`,
      `- current_guard: ${recallGuard}`,
      `- recommended_recall_guard: ${recommendedRecallGuard}`,
      `- frontend_delivery_tier: ${frontendDeliveryTier}`,
      '',
      '## Memory / Audit Preview',
      `- node_path: ${nodePath || 'n/a'}`,
      `- anchor_name: ${anchorName || 'n/a'}`,
      `- context_domain: ${contextDomain}`,
      `- living_fragment: ${livingFragment || 'n/a'}`,
      `- project_fact: ${projectFact || 'n/a'}`,
      `- relationship_significance: ${relationshipSignificance || 'n/a'}`,
      `- feeling_as_fact: ${feelingAsFact || 'n/a'}`,
      `- source_trace_count: ${sourceTraceCount}`,
      `- source_span_count: ${sourceSpanCount}`,
      '',
      '## Recorder Contract',
      '- This page belongs to the 100-page sandbox write plan.',
      '- rollback_status starts as sandbox_planned and should only become written after create-pages returns page_id/url.',
      '- Capture page_id/url from create-pages response immediately.',
      '- Fetch-back verifies representative pages and then marks fetch_back_status=verified.',
      '- SQL-style batch query is optional audit, not required for rollback correctness.',
      '- Source Trace and Relation Edge pages remain audit/graph layers, not frontend default recall.'
    ].join('\n')
  };
}

function rollbackEntry(row = {}, targetDatabase = '', runtime = {}) {
  return {
    schema: 'driftstone_notion_rollback_entry_v0.1',
    package_id: runtime.importBatchId,
    import_batch_id: runtime.importBatchId,
    target_database: targetDatabase,
    source_month: row.source_month,
    external_id: row.external_id,
    title: row.title,
    rollback_action: 'archive_page_by_notion_page_id_or_external_id',
    rollback_order: 10,
    notion_page_id: null,
    notion_page_url: null,
    status: 'not_written',
    note: 'Sandbox 100-page plan seed. Capture notion_page_id/url from create-pages response immediately after write.'
  };
}

function countBy(rows = [], keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function formatCounts(counts = {}) {
  return Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ');
}

function buildPlanMarkdown({ pagesByDatabase, rollbackEntries, runtime }) {
  const allRows = Object.values(pagesByDatabase).flat();
  const lines = [];
  lines.push('# Driftstone Notion Sandbox 100-Page Write Plan');
  lines.push('');
  lines.push('Milestone dependency: `notion_sandbox_v2_smoke_verified`.');
  lines.push(`Import batch: \`${runtime.importBatchId}\``);
  lines.push(`Source write plan: \`${SOURCE_WRITE_PLAN}\``);
  lines.push('');
  lines.push('This is a plan and payload only. It does not write Notion pages.');
  lines.push('');
  lines.push('## Boundary');
  lines.push('- Do not write Mossbridge warm memory.');
  lines.push('- Do not merge cross-month cards.');
  lines.push('- Do not import overflow links.');
  lines.push('- Source Trace and Relation Edge remain audit / graph layers.');
  lines.push('- Capture `page_id` / `url` from create-pages response immediately.');
  lines.push('- Use fetch-back for verification; SQL batch query is optional audit only.');
  lines.push('');
  lines.push('## Planned Scope');
  for (const [database, count] of Object.entries(SELECT_COUNTS)) {
    lines.push(`- ${database}: ${count}`);
  }
  lines.push(`- total: ${allRows.length}`);
  lines.push('');
  lines.push('## Distributions');
  lines.push(`- source_month: ${formatCounts(countBy(allRows, (row) => row.source_month))}`);
  lines.push(`- target_database: ${formatCounts(countBy(allRows, (row) => row.properties?.target_database))}`);
  lines.push(`- recall_guard: ${formatCounts(countBy(allRows, (row) => row.properties?.recall_guard))}`);
  lines.push(`- frontend_delivery_tier: ${formatCounts(countBy(allRows, (row) => row.properties?.frontend_delivery_tier))}`);
  lines.push(`- context_domain: ${formatCounts(countBy(allRows, (row) => row.properties?.context_domain))}`);
  lines.push('');
  lines.push('## Required Write Flow');
  lines.push(`1. Write pages by target database using \`${runtime.outputFiles.payload}\`.`);
  lines.push('2. Save each raw `create-pages` response.');
  lines.push(`3. Run \`record_notion_sandbox_create_result.mjs\` against \`${runtime.outputFiles.rollback}\`.`);
  lines.push('4. Generate the matching written rollback manifest and create result report.');
  lines.push('5. Fetch-back a representative sample across every target database.');
  lines.push('6. Mark fetched pages `fetch_back_status=verified` only after fetch succeeds.');
  lines.push('7. Do rollback dry-run only. Do not archive or delete.');
  lines.push('');
  lines.push('## Planned Samples');
  for (const [database, rows] of Object.entries(pagesByDatabase)) {
    lines.push('');
    lines.push(`### ${database}`);
    for (const row of rows) {
      lines.push(`- ${row.source_month} · ${row.properties?.frontend_delivery_tier || row.properties?.recall_guard || 'n/a'} · ${row.title} · \`${row.external_id}\``);
    }
  }
  lines.push('');
  lines.push('## Rollback Seed');
  lines.push(`- entries: ${rollbackEntries.length}`);
  lines.push('- initial status: `not_written`');
  lines.push('- initial notion_page_id: `null`');
  lines.push('- rollback action: `archive_page_by_notion_page_id_or_external_id`');
  lines.push('');
  lines.push('## Content Quality Note');
  lines.push('- `life` / `fact_line` feeling text may still be too relationship-flavored.');
  lines.push('- This does not block write-chain testing.');
  lines.push('- Content-quality tuning should be tracked separately from Notion smoke/write plumbing.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = {
    variant: args.variant,
    importBatchId: batchIdForVariant(args.variant),
    outputFiles: outputFilesForVariant(args.variant)
  };
  const writePlan = readJsonl(await readFile(SOURCE_WRITE_PLAN, 'utf8'));
  const pagesByDatabase = {};
  const rollbackEntries = [];

  for (const [database, count] of Object.entries(SELECT_COUNTS)) {
    const rows = writePlan.filter((row) => row.target_database === database);
    if (rows.length < count) {
      throw new Error(`Not enough rows for ${database}: wanted ${count}, got ${rows.length}`);
    }
    const selected = selectBalancedByMonth(rows, count);
    if (selected.length < count) {
      throw new Error(`Balanced selection failed for ${database}: wanted ${count}, got ${selected.length}`);
    }
    const converted = selected.map((row) => convertRow(row, database, runtime));
    pagesByDatabase[database] = converted;
    rollbackEntries.push(...converted.map((row) => rollbackEntry(row, database, runtime)));
  }

  const outPayload = {
    schema: 'driftstone_notion_sandbox_100_write_payload_v0.2',
    import_batch_id: runtime.importBatchId,
    depends_on: 'notion_sandbox_v2_smoke_verified',
    source_write_plan: SOURCE_WRITE_PLAN,
    selection_policy: 'balanced_by_source_month_per_target_database',
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false,
    pages_by_database: pagesByDatabase
  };
  const rollbackManifest = {
    schema: 'driftstone_notion_rollback_manifest_v0.1',
    package_id: runtime.importBatchId,
    import_batch_id: runtime.importBatchId,
    generated_at: new Date().toISOString(),
    writes_to_notion: false,
    rollback_state: 'sandbox_100_seed_not_written',
    total_entries: rollbackEntries.length,
    entries: rollbackEntries
  };

  await mkdir(BASELINE_DIR, { recursive: true });
  await writeFile(runtime.outputFiles.payload, `${JSON.stringify(outPayload, null, 2)}\n`, 'utf8');
  await writeFile(runtime.outputFiles.rollback, `${JSON.stringify(rollbackManifest, null, 2)}\n`, 'utf8');
  await writeFile(runtime.outputFiles.plan, buildPlanMarkdown({ pagesByDatabase, rollbackEntries, runtime }), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    import_batch_id: runtime.importBatchId,
    milestone_dependency: 'notion_sandbox_v2_smoke_verified',
    payload: runtime.outputFiles.payload,
    rollback_manifest: runtime.outputFiles.rollback,
    plan: runtime.outputFiles.plan,
    source_month_distribution: countBy(Object.values(pagesByDatabase).flat(), (row) => row.source_month),
    counts: Object.fromEntries(Object.entries(pagesByDatabase).map(([key, rows]) => [key, rows.length])),
    total: rollbackEntries.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
