import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { BUNDLE_SCHEMA, validatePortableWarmBundle } from './portable-warm-bundle-contract.js';
import { PROJECT_ROOT, safeScopeSegment } from './path-config.js';

const PROJECTION_SCHEMA = 'driftstone_portable_warm_projection_v0';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value || '')).digest('hex')}`;
}

function shortHash(value, length = 12) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function toJsonl(rows = []) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`;
}

function relativeArtifactPath(outputDir = '', filePath = '') {
  const rel = relative(outputDir, filePath);
  return rel && !rel.startsWith('..') && rel !== filePath ? rel : basename(filePath);
}

function sanitizeSourceFileLabel(value = '') {
  const text = safeText(value);
  if (!text) return '';
  if (isAbsolute(text) || text.includes('/Users/') || text.includes('/srv/') || text.includes('\\')) {
    return basename(text) || 'local_source';
  }
  return text;
}

function resolveOutputRoot(outputRoot = '') {
  const requested = safeText(outputRoot);
  const defaultRoot = resolve(PROJECT_ROOT, 'output', 'portable_warm_projections');
  if (!requested) return defaultRoot;
  const resolved = resolve(requested);
  const projectOutput = resolve(PROJECT_ROOT, 'output');
  const systemTmp = resolve(tmpdir());
  const insideProjectOutput = resolved === projectOutput || resolved.startsWith(`${projectOutput}/`);
  const insideTmp = resolved === systemTmp || resolved.startsWith(`${systemTmp}/`);
  if (insideProjectOutput || insideTmp) return resolved;
  const error = new Error('output_root must be inside this project output directory or the system temporary directory');
  error.code = 'DRIFTSTONE_OUTPUT_ROOT_OUT_OF_BOUNDS';
  throw error;
}

function findPrivacyPreflightHits(value, path = '$', hits = []) {
  if (hits.length >= 20) return hits;
  if (typeof value === 'string') {
    if (/sk-[A-Za-z0-9_-]{20,}/.test(value)) {
      hits.push({ path, reason: 'secret_like_api_key' });
    } else if (/\/Users\/[^\s"'`]+/.test(value) || /\/srv\/[^\s"'`]+/.test(value)) {
      hits.push({ path, reason: 'absolute_private_path' });
    }
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findPrivacyPreflightHits(item, `${path}[${index}]`, hits));
    return hits;
  }
  if (!isPlainObject(value)) return hits;
  Object.entries(value).forEach(([key, child]) => {
    if (key === 'source_file') return;
    findPrivacyPreflightHits(child, `${path}.${key}`, hits);
  });
  return hits;
}

function resolveBundleFile({ bundlePath = '', bundleDir = '' } = {}) {
  const explicitPath = safeText(bundlePath);
  if (explicitPath) return resolve(explicitPath);
  const dir = safeText(bundleDir);
  if (dir) return resolve(dir, 'portable_warm_bundle.json');
  throw new Error('bundle_path or bundle_dir is required');
}

function cardBody(card = {}) {
  return isPlainObject(card?.portable_warm_card) ? card.portable_warm_card : {};
}

function sourceSpanIdsForCard(card = {}) {
  return Array.isArray(card?.source_refs?.source_span_ids)
    ? card.source_refs.source_span_ids.map((item) => safeText(item)).filter(Boolean)
    : [];
}

function sourceOccurrenceIdsForCard(card = {}) {
  return Array.isArray(card?.source_refs?.source_occurrence_ids)
    ? card.source_refs.source_occurrence_ids.map((item) => safeText(item)).filter(Boolean)
    : [];
}

function buildSourceMaps(bundle = {}) {
  const occurrencesById = new Map();
  const candidateIdsBySpanId = new Map();

  for (const occurrence of Array.isArray(bundle.source_occurrences) ? bundle.source_occurrences : []) {
    occurrencesById.set(safeText(occurrence?.source_occurrence_id), occurrence);
  }
  for (const card of Array.isArray(bundle.warm_cards) ? bundle.warm_cards : []) {
    const candidateId = safeText(card?.candidate_id);
    for (const spanId of sourceSpanIdsForCard(card)) {
      if (!candidateIdsBySpanId.has(spanId)) candidateIdsBySpanId.set(spanId, []);
      candidateIdsBySpanId.get(spanId).push(candidateId);
    }
  }

  return { occurrencesById, candidateIdsBySpanId };
}

function projectionHash(row = {}) {
  return sha256(stableJson({
    ...row,
    notion_page_id: '',
    notion_sync_hash: ''
  }));
}

function buildNotionWarmCardRow({ bundle = {}, card = {} } = {}) {
  const body = cardBody(card);
  const row = {
    projection_schema: PROJECTION_SCHEMA,
    target_database: 'portable_warm_cards',
    bundle_id: safeText(bundle?.manifest?.bundle_id),
    candidate_id: safeText(card?.candidate_id),
    title: safeText(card?.title, 'Untitled portable Warm card'),
    archive_bucket: safeText(card?.archive_bucket, 'stable'),
    frontend_delivery_tier: safeText(card?.frontend_delivery_tier, 'guarded_candidate'),
    review_status: safeText(card?.home_import_policy?.state, 'review_only'),
    body_markdown: safeText(body.body_markdown),
    living_fragment: safeText(body.living_fragment),
    feeling_as_fact: safeText(body.feeling_as_fact),
    future_use_hint: safeText(body.future_use_hint),
    voice_fingerprint_refs: Array.isArray(body.voice_fingerprint_refs) ? body.voice_fingerprint_refs : [],
    persona_refs: Array.isArray(body.persona_refs) ? body.persona_refs : [],
    source_occurrence_ids: sourceOccurrenceIdsForCard(card),
    source_span_ids: sourceSpanIdsForCard(card),
    source_span_count: sourceSpanIdsForCard(card).length,
    source_complete: Boolean(card?.quality?.source_complete),
    local_only: card?.privacy?.local_only !== false,
    notion_page_id: '',
    notion_sync_hash: ''
  };
  return {
    ...row,
    notion_sync_hash: projectionHash(row)
  };
}

function buildNotionSourceSpanRow({ bundle = {}, span = {}, occurrence = {}, candidateIds = [] } = {}) {
  const row = {
    projection_schema: PROJECTION_SCHEMA,
    target_database: 'source_spans',
    bundle_id: safeText(bundle?.manifest?.bundle_id),
    source_span_id: safeText(span?.source_span_id),
    source_occurrence_id: safeText(span?.source_occurrence_id),
    source_file: sanitizeSourceFileLabel(occurrence?.source_file),
    source_file_digest: occurrence?.source_file ? sha256(occurrence.source_file) : '',
    source_window: safeText(occurrence?.source_window),
    turn_range: safeText(span?.turn_range),
    message_ids: Array.isArray(span?.message_ids) ? span.message_ids : [],
    speaker: safeText(span?.speaker, 'unknown'),
    excerpt_text: safeText(span?.excerpt_text),
    excerpt_digest: safeText(span?.excerpt_digest),
    linked_candidate_ids: candidateIds,
    source_only: true,
    notion_page_id: '',
    notion_sync_hash: ''
  };
  return {
    ...row,
    notion_sync_hash: projectionHash(row)
  };
}

function buildReviewLedgerRows({ bundle = {} } = {}) {
  const bundleId = safeText(bundle?.manifest?.bundle_id);
  const normalize = (row = {}, state = '') => ({
    projection_schema: PROJECTION_SCHEMA,
    target_database: 'review_ledger',
    bundle_id: bundleId,
    ledger_id: safeText(row?.ledger_id),
    state: safeText(row?.state, state),
    reason: safeText(row?.reason),
    source_kind: safeText(row?.source_kind),
    source_id: safeText(row?.source_id),
    title: safeText(row?.title),
    row_digest: safeText(row?.row_digest),
    review_note: safeText(row?.review_note),
    notion_page_id: '',
    notion_sync_hash: ''
  });
  return [
    ...(Array.isArray(bundle.rejected_ledger) ? bundle.rejected_ledger : []).map((row) => normalize(row, 'rejected')),
    ...(Array.isArray(bundle.hold_ledger) ? bundle.hold_ledger : []).map((row) => normalize(row, 'hold'))
  ].map((row) => ({
    ...row,
    notion_sync_hash: projectionHash(row)
  }));
}

function obsidianFileBase(prefix = '', id = '', title = '') {
  return `${prefix} - ${safeScopeSegment(title, 'untitled')} - ${safeScopeSegment(id, shortHash(title || prefix))}`;
}

function yamlList(values = []) {
  if (!values.length) return '[]';
  return `\n${values.map((item) => `  - "${String(item).replace(/"/g, '\\"')}"`).join('\n')}`;
}

function stripLeadingH1(markdown = '') {
  return safeText(markdown).replace(/^# .+\n+/, '').trim();
}

function renderCardMarkdown({ bundle = {}, card = {}, sourceSpanLinks = [] } = {}) {
  const body = cardBody(card);
  const markdown = stripLeadingH1(body.body_markdown || body.living_fragment);
  return [
    '---',
    `projection_schema: ${PROJECTION_SCHEMA}`,
    `bundle_id: ${safeText(bundle?.manifest?.bundle_id)}`,
    `candidate_id: ${safeText(card?.candidate_id)}`,
    `archive_bucket: ${safeText(card?.archive_bucket, 'stable')}`,
    `frontend_delivery_tier: ${safeText(card?.frontend_delivery_tier, 'guarded_candidate')}`,
    `source_span_ids:${yamlList(sourceSpanIdsForCard(card))}`,
    'canonical_truth: false',
    '---',
    '',
    `# ${safeText(card?.title, 'Untitled portable Warm card')}`,
    '',
    markdown,
    '',
    '## Source Links',
    '',
    ...(sourceSpanLinks.length ? sourceSpanLinks.map((link) => `- [[${link}]]`) : ['- No bounded source span linked.']),
    ''
  ].join('\n');
}

function renderSourceSpanMarkdown({ span = {}, occurrence = {}, linkedCardFiles = [] } = {}) {
  return [
    '---',
    `projection_schema: ${PROJECTION_SCHEMA}`,
    `source_span_id: ${safeText(span?.source_span_id)}`,
    `source_occurrence_id: ${safeText(span?.source_occurrence_id)}`,
    `turn_range: ${safeText(span?.turn_range)}`,
    `speaker: ${safeText(span?.speaker, 'unknown')}`,
    'source_only: true',
    'canonical_truth: false',
    '---',
    '',
    `# Source Span ${safeText(span?.source_span_id)}`,
    '',
    `- Source window: ${safeText(occurrence?.source_window, 'unknown')}`,
    `- Source file: ${sanitizeSourceFileLabel(occurrence?.source_file) || 'unknown'}`,
    `- Turn range: ${safeText(span?.turn_range, 'unknown')}`,
    `- Excerpt digest: ${safeText(span?.excerpt_digest, 'unknown')}`,
    '',
    '## Bounded Excerpt',
    '',
    `> ${safeText(span?.excerpt_text).replace(/\n/g, '\n> ')}`,
    '',
    '## Linked Warm Cards',
    '',
    ...(linkedCardFiles.length ? linkedCardFiles.map((file) => `- [[${file}]]`) : ['- No linked card in this projection.']),
    ''
  ].join('\n');
}

function renderBundleIndex({ bundle = {}, files = {}, warmRows = [], sourceSpanRows = [], ledgerRows = [] } = {}) {
  const outputDir = dirname(files.projection_manifest_json);
  return [
    '# Driftstone Portable Warm Projection',
    '',
    'This folder is a local projection of `portable_warm_bundle.json` with review-backflow anchors.',
    'Patch validation/apply is not implemented in this public build, so projection edits are not canonical bundle changes.',
    'It is not canonical truth and it does not mean anything was written to Notion, Home, Hippocove, or a cold tree.',
    '',
    '## Bundle',
    '',
    `- Bundle ID: ${safeText(bundle?.manifest?.bundle_id)}`,
    `- Schema: ${safeText(bundle?.schema)}`,
    `- Created at: ${safeText(bundle?.manifest?.created_at)}`,
    `- Manifest digest: ${safeText(bundle?.manifest?.manifest_digest)}`,
    '',
    '## Counts',
    '',
    `- Warm cards: ${warmRows.length}`,
    `- Source spans: ${sourceSpanRows.length}`,
    `- Review ledger rows: ${ledgerRows.length}`,
    `- Rejected rows: ${Array.isArray(bundle.rejected_ledger) ? bundle.rejected_ledger.length : 0}`,
    `- HOLD rows: ${Array.isArray(bundle.hold_ledger) ? bundle.hold_ledger.length : 0}`,
    '',
    '## Local Files',
    '',
    ...Object.entries(files).map(([key, value]) => `- ${key}: \`${relativeArtifactPath(outputDir, value)}\``),
    ''
  ].join('\n');
}

function renderWarmCardsReview({ warmRows = [] } = {}) {
  const lines = [
    '# Portable Warm Cards',
    '',
    'Read these as reviewable Driftstone Warm candidates, not final Home memories.',
    ''
  ];
  warmRows.forEach((row, index) => {
    lines.push(
      `## ${index + 1}. ${row.title}`,
      '',
      `- candidate_id: \`${row.candidate_id}\``,
      `- archive_bucket: \`${row.archive_bucket}\``,
      `- frontend_delivery_tier: \`${row.frontend_delivery_tier}\``,
      `- source_span_count: ${row.source_span_count}`,
      '',
      stripLeadingH1(row.body_markdown || row.living_fragment),
      ''
    );
  });
  return lines.join('\n').trimEnd() + '\n';
}

function renderReviewLedger({ ledgerRows = [] } = {}) {
  const lines = [
    '# Rejected And HOLD Ledger',
    '',
    'Rows here are visible review/audit material. They were not silently discarded.',
    ''
  ];
  if (!ledgerRows.length) {
    lines.push('No rejected or HOLD rows in this projection.', '');
    return lines.join('\n');
  }
  ledgerRows.forEach((row) => {
    lines.push(
      `## ${row.ledger_id || 'ledger row'}`,
      '',
      `- state: \`${row.state}\``,
      `- reason: \`${row.reason || 'unknown'}\``,
      `- source_kind: \`${row.source_kind || 'unknown'}\``,
      `- source_id: \`${row.source_id || 'unknown'}\``,
      `- title: ${row.title || 'Untitled'}`,
      ''
    );
  });
  return lines.join('\n');
}

function buildProjection({ bundle = {}, outputDir = '' } = {}) {
  const { occurrencesById, candidateIdsBySpanId } = buildSourceMaps(bundle);
  const warmRows = (Array.isArray(bundle.warm_cards) ? bundle.warm_cards : [])
    .map((card) => buildNotionWarmCardRow({ bundle, card }));
  const sourceSpanRows = (Array.isArray(bundle.source_spans) ? bundle.source_spans : [])
    .map((span) => buildNotionSourceSpanRow({
      bundle,
      span,
      occurrence: occurrencesById.get(safeText(span?.source_occurrence_id)) || {},
      candidateIds: candidateIdsBySpanId.get(safeText(span?.source_span_id)) || []
    }));
  const ledgerRows = buildReviewLedgerRows({ bundle });

  const cardFileById = new Map();
  const spanFileById = new Map();
  warmRows.forEach((row, index) => {
    cardFileById.set(row.candidate_id, obsidianFileBase(`Warm Card ${String(index + 1).padStart(3, '0')}`, row.candidate_id, row.title));
  });
  sourceSpanRows.forEach((row, index) => {
    spanFileById.set(row.source_span_id, obsidianFileBase(`Source Span ${String(index + 1).padStart(3, '0')}`, row.source_span_id, row.source_span_id));
  });

  const projectionFiles = {
    chat_human_entry_md: join(outputDir, '00_chat_human_entry.md'),
    warm_cards_md: join(outputDir, '01_warm_cards.md'),
    review_ledger_md: join(outputDir, '02_review_ledger.md'),
    notion_warm_cards_jsonl: join(outputDir, 'notion', 'portable_warm_cards.jsonl'),
    notion_source_spans_jsonl: join(outputDir, 'notion', 'source_spans.jsonl'),
    notion_review_ledger_jsonl: join(outputDir, 'notion', 'review_ledger.jsonl'),
    roundtrip_map_json: join(outputDir, 'notion', 'candidate_roundtrip_map.json'),
    obsidian_index_md: join(outputDir, 'obsidian', '00_Index.md'),
    projection_manifest_json: join(outputDir, 'projection_manifest.json')
  };

  const roundtripMap = warmRows.map((row) => ({
    candidate_id: row.candidate_id,
    bundle_id: row.bundle_id,
    notion_page_id: '',
    notion_sync_hash: row.notion_sync_hash,
    obsidian_file: `${cardFileById.get(row.candidate_id)}.md`
  }));

  const manifest = {
    schema: PROJECTION_SCHEMA,
    canonical_truth: false,
    projection_kind: 'local_markdown_obsidian_notion_jsonl',
    created_at: safeText(bundle?.manifest?.created_at),
    bundle_id: safeText(bundle?.manifest?.bundle_id),
    bundle_schema: safeText(bundle?.schema),
    bundle_manifest_digest: safeText(bundle?.manifest?.manifest_digest),
    source_manifest_digest: safeText(bundle?.source_manifest?.source_digest),
    counts: {
      warm_cards: warmRows.length,
      source_spans: sourceSpanRows.length,
      review_ledger_rows: ledgerRows.length
    },
    files: Object.fromEntries(
      Object.entries(projectionFiles).map(([key, value]) => [key, relativeArtifactPath(outputDir, value)])
    ),
    write_boundary: {
      local_files_only: true,
      notion_written: false,
      home_written: false,
      hippocove_written: false
    }
  };

  return {
    manifest,
    warmRows,
    sourceSpanRows,
    ledgerRows,
    roundtripMap,
    cardFileById,
    spanFileById,
    occurrencesById,
    files: projectionFiles
  };
}

async function writeProjectionFiles({ bundle = {}, projection = {} } = {}) {
  const notionDir = dirname(projection.files.notion_warm_cards_jsonl);
  const obsidianDir = dirname(projection.files.obsidian_index_md);
  await mkdir(notionDir, { recursive: true });
  await mkdir(join(obsidianDir, 'Warm Cards'), { recursive: true });
  await mkdir(join(obsidianDir, 'Source Spans'), { recursive: true });

  const files = projection.files;
  await writeFile(files.notion_warm_cards_jsonl, toJsonl(projection.warmRows), 'utf8');
  await writeFile(files.notion_source_spans_jsonl, toJsonl(projection.sourceSpanRows), 'utf8');
  await writeFile(files.notion_review_ledger_jsonl, toJsonl(projection.ledgerRows), 'utf8');
  await writeFile(files.roundtrip_map_json, `${JSON.stringify(projection.roundtripMap, null, 2)}\n`, 'utf8');
  await writeFile(files.warm_cards_md, renderWarmCardsReview({ warmRows: projection.warmRows }), 'utf8');
  await writeFile(files.review_ledger_md, renderReviewLedger({ ledgerRows: projection.ledgerRows }), 'utf8');

  const obsidianLines = ['# Driftstone Projection Index', ''];
  for (const row of projection.warmRows) {
    const fileBase = projection.cardFileById.get(row.candidate_id);
    obsidianLines.push(`- [[Warm Cards/${fileBase}|${row.title}]]`);
  }
  obsidianLines.push('');
  await writeFile(files.obsidian_index_md, `${obsidianLines.join('\n')}\n`, 'utf8');

  for (const card of Array.isArray(bundle.warm_cards) ? bundle.warm_cards : []) {
    const candidateId = safeText(card?.candidate_id);
    const fileBase = projection.cardFileById.get(candidateId);
    const sourceSpanLinks = sourceSpanIdsForCard(card)
      .map((spanId) => projection.spanFileById.get(spanId))
      .filter(Boolean)
      .map((name) => `Source Spans/${name}`);
    await writeFile(
      join(obsidianDir, 'Warm Cards', `${fileBase}.md`),
      renderCardMarkdown({ bundle, card, sourceSpanLinks }),
      'utf8'
    );
  }

  for (const span of Array.isArray(bundle.source_spans) ? bundle.source_spans : []) {
    const spanId = safeText(span?.source_span_id);
    const fileBase = projection.spanFileById.get(spanId);
    const linkedCardFiles = (projection.sourceSpanRows.find((row) => row.source_span_id === spanId)?.linked_candidate_ids || [])
      .map((candidateId) => projection.cardFileById.get(candidateId))
      .filter(Boolean)
      .map((name) => `Warm Cards/${name}`);
    await writeFile(
      join(obsidianDir, 'Source Spans', `${fileBase}.md`),
      renderSourceSpanMarkdown({
        span,
        occurrence: projection.occurrencesById.get(safeText(span?.source_occurrence_id)) || {},
        linkedCardFiles
      }),
      'utf8'
    );
  }

  await writeFile(files.chat_human_entry_md, renderBundleIndex({
    bundle,
    files,
    warmRows: projection.warmRows,
    sourceSpanRows: projection.sourceSpanRows,
    ledgerRows: projection.ledgerRows
  }), 'utf8');
  await writeFile(files.projection_manifest_json, `${JSON.stringify(projection.manifest, null, 2)}\n`, 'utf8');
}

export async function exportPortableWarmProjection({
  bundlePath = '',
  bundleDir = '',
  outputRoot = ''
} = {}) {
  let bundleFile;
  try {
    bundleFile = resolveBundleFile({ bundlePath, bundleDir });
  } catch (error) {
    return {
      ok: false,
      schema: 'driftstone_portable_warm_projection_export_v0',
      projection_status: 'blocked_by_input_error',
      error: {
        message: safeText(error?.message, 'bundle_path or bundle_dir is required')
      }
    };
  }

  let bundle;
  try {
    bundle = JSON.parse(await readFile(bundleFile, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      schema: 'driftstone_portable_warm_projection_export_v0',
      projection_status: 'blocked_by_read_error',
      bundle_file: bundleFile,
      error: {
        message: safeText(error?.message, 'Unable to read portable_warm_bundle.json'),
        code: safeText(error?.code)
      }
    };
  }

  const privacyHits = findPrivacyPreflightHits(bundle);
  if (privacyHits.length) {
    return {
      ok: false,
      schema: 'driftstone_portable_warm_projection_export_v0',
      projection_status: 'blocked_by_privacy_preflight',
      bundle_file: bundleFile,
      privacy_preflight: {
        hit_count: privacyHits.length,
        hits: privacyHits
      },
      error: {
        message: 'Bundle contains obvious secret-like values or private absolute paths; review/redact before projection export.'
      }
    };
  }

  const validation = validatePortableWarmBundle(bundle);
  if (!validation.ok || bundle.schema !== BUNDLE_SCHEMA) {
    return {
      ok: false,
      schema: 'driftstone_portable_warm_projection_export_v0',
      projection_status: 'blocked_by_contract_errors',
      bundle_file: bundleFile,
      validation
    };
  }

  const scope = bundle?.manifest?.scope || {};
  let root;
  try {
    root = resolveOutputRoot(outputRoot);
  } catch (error) {
    return {
      ok: false,
      schema: 'driftstone_portable_warm_projection_export_v0',
      projection_status: 'blocked_by_output_boundary',
      bundle_file: bundleFile,
      error: {
        message: safeText(error?.message),
        code: safeText(error?.code)
      }
    };
  }
  const bundleId = safeText(bundle?.manifest?.bundle_id, `bundle_${shortHash(bundleFile)}`);
  const manifestDigestSegment = shortHash(safeText(bundle?.manifest?.manifest_digest, bundleId));
  const outputDir = join(
    root,
    `${safeScopeSegment(scope.owner_id, 'owner')}__${safeScopeSegment(scope.realm_id, 'default')}`,
    `${safeScopeSegment(bundleId, 'bundle')}__${manifestDigestSegment}`
  );
  await mkdir(outputDir, { recursive: true });

  const projection = buildProjection({ bundle, outputDir });
  await writeProjectionFiles({ bundle, projection });

  return {
    ok: true,
    schema: 'driftstone_portable_warm_projection_export_v0',
    projection_status: projection.warmRows.length ? 'projection_written' : 'empty_projection_written',
    bundle_file: bundleFile,
    output: {
      dir: outputDir,
      files: projection.files
    },
    manifest: projection.manifest,
    counts: projection.manifest.counts,
    validation
  };
}

export { PROJECTION_SCHEMA };
