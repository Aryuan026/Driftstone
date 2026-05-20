#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';

const DEFAULT_BASELINE_DIR = 'output/notion_import_baseline/driftstone_2025-02_to_2025-04_baseline';

function parseArgs(argv = []) {
  const args = {
    baselineDir: DEFAULT_BASELINE_DIR,
    manifest: 'rollback_manifest.json',
    payload: '',
    database: '',
    responses: [],
    out: 'rollback_manifest_sandbox.json',
    report: 'notion_sandbox_create_result_report.json',
    inPlace: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--baseline-dir') args.baselineDir = argv[++index];
    else if (arg === '--manifest') args.manifest = argv[++index];
    else if (arg === '--payload') args.payload = argv[++index];
    else if (arg === '--database') args.database = argv[++index];
    else if (arg === '--response') args.responses.push(argv[++index]);
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--report') args.report = argv[++index];
    else if (arg === '--in-place') args.inPlace = true;
    else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/debug/record_notion_sandbox_create_result.mjs --response create-pages-result.json',
    '',
    'Options:',
    `  --baseline-dir <dir>   Baseline package dir. Default: ${DEFAULT_BASELINE_DIR}`,
    '  --manifest <file>      Rollback manifest filename/path. Default: rollback_manifest.json',
    '  --payload <file>       Optional sandbox write payload for order-based external_id fallback.',
    '  --database <key>       Database key inside payload.pages_by_database for order fallback.',
    '  --response <file>      Raw Notion create-pages response JSON. Can be repeated.',
    '  --out <file>           Output manifest. Default: rollback_manifest_sandbox.json',
    '  --report <file>        Output JSON report. Default: notion_sandbox_create_result_report.json',
    '  --in-place             Update the manifest file itself instead of writing --out.',
    '',
    'Notes:',
    '  The recorder matches pages by external_id and does not need notion-query-data-sources.',
    '  It accepts plain create-pages JSON and MCP text wrappers containing JSON.',
    '  If create-pages does not echo properties, pass --payload and --database to match pages by write order.'
  ].join('\n');
}

function resolveFromBaseline(baselineDir, value) {
  if (isAbsolute(value)) return value;
  return join(baselineDir, value);
}

function resolveInput(value) {
  if (isAbsolute(value)) return value;
  return resolve(process.cwd(), value);
}

async function readJson(filePath) {
  const text = await readFile(filePath, 'utf8');
  return parseMaybeJson(text);
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Expected JSON text, got parse error: ${error.message}`);
  }
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function propertyValue(properties = {}, key = '') {
  const direct = properties[key];
  if (direct === undefined || direct === null) return '';
  if (typeof direct === 'string' || typeof direct === 'number' || typeof direct === 'boolean') return String(direct);
  if (Array.isArray(direct)) return direct.map((item) => propertyValue({ item }, 'item')).filter(Boolean).join(' ');
  if (typeof direct === 'object') {
    if (typeof direct.value === 'string') return direct.value;
    if (typeof direct.plain_text === 'string') return direct.plain_text;
    if (typeof direct.name === 'string') return direct.name;
    if (typeof direct.text === 'string') return direct.text;
    if (typeof direct.title === 'string') return direct.title;
    if (Array.isArray(direct.title)) return direct.title.map((item) => propertyValue({ item }, 'item')).filter(Boolean).join('');
    if (Array.isArray(direct.rich_text)) return direct.rich_text.map((item) => propertyValue({ item }, 'item')).filter(Boolean).join('');
  }
  return '';
}

function pageExternalId(page = {}) {
  const properties = safeObject(page.properties);
  return (
    page.external_id ||
    page.externalId ||
    page.externalID ||
    propertyValue(properties, 'external_id') ||
    propertyValue(properties, 'External ID') ||
    propertyValue(properties, 'externalId')
  );
}

function pageTitle(page = {}) {
  const properties = safeObject(page.properties);
  return (
    page.title ||
    page.name ||
    propertyValue(properties, 'title') ||
    propertyValue(properties, 'Title') ||
    propertyValue(properties, 'Name') ||
    ''
  );
}

function pageId(page = {}) {
  return page.id || page.page_id || page.notion_page_id || page.notionPageId || '';
}

function pageUrl(page = {}) {
  return page.url || page.page_url || page.notion_page_url || page.notionPageUrl || '';
}

function looksLikePage(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(pageId(value) || pageUrl(value));
}

function collectPages(payload, source, pages = [], seen = new Set()) {
  if (payload === null || payload === undefined) return pages;
  if (typeof payload === 'string') {
    const parsed = parseMaybeJson(payload);
    return collectPages(parsed, source, pages, seen);
  }
  if (seen.has(payload)) return pages;
  if (typeof payload === 'object') seen.add(payload);

  if (Array.isArray(payload)) {
    for (const item of payload) collectPages(item, source, pages, seen);
    return pages;
  }

  if (looksLikePage(payload)) {
    pages.push({ ...payload, __source_file: source });
    return pages;
  }

  if (typeof payload?.text === 'string') collectPages(payload.text, source, pages, seen);
  if (Array.isArray(payload?.pages)) collectPages(payload.pages, source, pages, seen);
  if (Array.isArray(payload?.results)) collectPages(payload.results, source, pages, seen);
  if (Array.isArray(payload?.data)) collectPages(payload.data, source, pages, seen);
  if (payload?.page && typeof payload.page === 'object') collectPages(payload.page, source, pages, seen);
  if (payload?.result && typeof payload.result === 'object') collectPages(payload.result, source, pages, seen);
  return pages;
}

function dedupePages(pages = []) {
  const seen = new Set();
  const deduped = [];
  const duplicates = [];
  for (const page of pages) {
    const externalId = pageExternalId(page);
    const id = pageId(page);
    const key = externalId || id || JSON.stringify(page);
    if (seen.has(key)) {
      duplicates.push({ external_id: externalId, notion_page_id: id, source_file: page.__source_file });
      continue;
    }
    seen.add(key);
    deduped.push(page);
  }
  return { pages: deduped, duplicates };
}

function payloadRowsForDatabase(payload = {}, database = '') {
  if (!payload || typeof payload !== 'object') return [];
  if (database && Array.isArray(payload.pages_by_database?.[database])) {
    return payload.pages_by_database[database];
  }
  if (!database && Array.isArray(payload.pages)) return payload.pages;
  return [];
}

function applyPayloadExternalIds(pages = [], payloadRows = []) {
  const mapped = [];
  const stillMissing = [];
  pages.forEach((page, index) => {
    if (pageExternalId(page)) return;
    const payloadRow = payloadRows[index];
    if (payloadRow?.external_id) {
      page.external_id = payloadRow.external_id;
      page.title = page.title || payloadRow.title;
      page.__external_id_source = 'payload_order';
      mapped.push({
        index,
        external_id: page.external_id,
        title: page.title || null
      });
    } else {
      stillMissing.push({
        index,
        notion_page_id: pageId(page) || null,
        notion_page_url: pageUrl(page) || null
      });
    }
  });
  return { mapped, stillMissing };
}

function updateManifest({ manifest, pages, writtenAt }) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : Array.isArray(manifest) ? manifest : [];
  if (!entries.length) {
    throw new Error('Rollback manifest must be an array or an object with entries[].');
  }
  const byExternalId = new Map(entries.map((entry) => [entry.external_id, entry]));
  const updated = [];
  const unmatched = [];

  for (const page of pages) {
    const externalId = pageExternalId(page);
    const notionPageId = pageId(page);
    const notionPageUrl = pageUrl(page);
    if (!externalId || !byExternalId.has(externalId)) {
      unmatched.push({
        external_id: externalId || null,
        notion_page_id: notionPageId || null,
        notion_page_url: notionPageUrl || null,
        title: pageTitle(page) || null,
        source_file: page.__source_file || null
      });
      continue;
    }
    const entry = byExternalId.get(externalId);
    entry.notion_page_id = notionPageId || entry.notion_page_id || null;
    entry.notion_page_url = notionPageUrl || entry.notion_page_url || null;
    entry.status = 'sandbox_written';
    entry.written_at = writtenAt;
    entry.write_source = 'create_pages_response';
    entry.rollback_action = 'archive_page_by_notion_page_id_or_external_id';
    entry.note = 'Captured notion_page_id/url from create-pages response immediately after write; SQL data-source query is optional verification only.';
    updated.push({
      external_id: externalId,
      target_database: entry.target_database,
      source_month: entry.source_month,
      title: entry.title,
      notion_page_id: entry.notion_page_id,
      notion_page_url: entry.notion_page_url
    });
  }

  return { manifest, entries, updated, unmatched };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.responses.length) {
    throw new Error('At least one --response file is required.');
  }

  const baselineDir = resolveInput(args.baselineDir);
  const manifestPath = resolveFromBaseline(baselineDir, args.manifest);
  const outputManifestPath = args.inPlace ? manifestPath : resolveFromBaseline(baselineDir, args.out);
  const reportPath = resolveFromBaseline(baselineDir, args.report);
  const manifest = await readJson(manifestPath);
  const payload = args.payload ? await readJson(resolveInput(args.payload)) : null;

  const rawPages = [];
  for (const responseFile of args.responses) {
    const resolved = resolveInput(responseFile);
    const payload = await readJson(resolved);
    collectPages(payload, resolved, rawPages);
  }
  const { pages, duplicates } = dedupePages(rawPages);
  const payloadRows = payloadRowsForDatabase(payload, args.database);
  const orderFallback = payloadRows.length ? applyPayloadExternalIds(pages, payloadRows) : { mapped: [], stillMissing: [] };
  const writtenAt = new Date().toISOString();
  const { manifest: updatedManifest, entries, updated, unmatched } = updateManifest({ manifest, pages, writtenAt });

  await mkdir(dirname(outputManifestPath), { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(outputManifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, 'utf8');

  const report = {
    schema: 'driftstone_notion_sandbox_create_result_report_v0.1',
    baseline_dir: baselineDir,
    manifest_path: manifestPath,
    output_manifest_path: outputManifestPath,
    payload_path: args.payload ? resolveInput(args.payload) : null,
    payload_database: args.database || null,
    response_files: args.responses.map(resolveInput),
    written_at: writtenAt,
    parsed_page_count: pages.length,
    matched_count: updated.length,
    unmatched_count: unmatched.length,
    untouched_count: entries.length - updated.length,
    order_fallback_mapped_count: orderFallback.mapped.length,
    order_fallback_mapped_pages: orderFallback.mapped,
    order_fallback_missing_pages: orderFallback.stillMissing,
    payload_row_count: payloadRows.length,
    duplicate_create_results: duplicates,
    unmatched_pages: unmatched,
    updated_entries: updated
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`Matched ${updated.length}/${pages.length} create-pages result page(s).`);
  console.log(`Wrote rollback manifest: ${outputManifestPath}`);
  console.log(`Wrote report: ${reportPath}`);
  if (unmatched.length) {
    console.warn(`Unmatched page(s): ${unmatched.length}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
