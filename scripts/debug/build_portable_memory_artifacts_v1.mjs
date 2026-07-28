#!/usr/bin/env node
// Thin, local-only adapter over already processed Driftstone persona/sql rows.
// It does not rerun extraction or write Home, Notion, Hippocove, or cloud storage.
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseCsvTextWithDiagnostics } from '../../server/core/csv-reader.js';
import {
  buildPortableArtifactBatch,
  exportPortableArtifactsJsonl,
  finalizeContractDigest,
  finalizeLedgerDigest,
  projectPortableArtifactToMarkdown,
  projectPortableArtifactToNotion,
  sha256,
  serializeJsonl,
  stableJson,
  verifyContractDigest,
  verifyLedgerDigest
} from '../lib/driftstone-portable-artifact-v1.mjs';

const GENERATION_SCHEMA = 'driftstone_portable_generation_manifest_v1';
const STAGING_REQUIRED_FILES = [
  '23_asheriehome_memory_nodes.jsonl',
  '12_normalized_memory_candidates.jsonl',
  '24_source_trace_index.jsonl',
  '16_normalized_source_span_candidates.jsonl'
];
const INPUT_MODES = new Set(['staging', 'processed']);

class CliBoundaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CliBoundaryError';
    this.code = code;
    this.details = details;
  }
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function uniqueStrings(...values) {
  return [...new Set(values.flatMap((value) => (
    Array.isArray(value) ? value : [value]
  )).map((value) => safeText(value)).filter(Boolean))];
}

function parseArgs(argv = []) {
  const args = {
    mode: 'staging',
    sourceDir: '',
    preparedFile: '',
    workbenchFile: '',
    sourceIndexFile: '',
    reviewedCsv: '',
    month: '',
    outDir: '',
    withProjections: false,
    replace: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    const next = argv[index + 1];
    if (arg === '--mode' && next) {
      args.mode = safeText(next).toLowerCase();
      index += 1;
    } else if (arg === '--source-dir' && next) {
      args.sourceDir = resolve(next);
      index += 1;
    } else if (arg === '--prepared-file' && next) {
      args.preparedFile = resolve(next);
      index += 1;
    } else if (arg === '--workbench-file' && next) {
      args.workbenchFile = resolve(next);
      index += 1;
    } else if (arg === '--source-index-file' && next) {
      args.sourceIndexFile = resolve(next);
      index += 1;
    } else if (arg === '--reviewed-csv' && next) {
      args.reviewedCsv = resolve(next);
      index += 1;
    } else if (arg === '--month' && next) {
      args.month = safeText(next);
      index += 1;
    } else if (arg === '--out' && next) {
      args.outDir = resolve(next);
      index += 1;
    } else if (arg === '--replace') {
      args.replace = true;
    } else if (arg === '--with-projections') {
      args.withProjections = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage:',
        '  staging (legacy default):',
        '    node scripts/debug/build_portable_memory_artifacts_v1.mjs --mode staging --source-dir DIR --reviewed-csv FILE --month YYYY-MM --out DIR [--with-projections] [--replace]',
        '  processed four-layer input:',
        '    node scripts/debug/build_portable_memory_artifacts_v1.mjs --mode processed --prepared-file FILE --workbench-file FILE --source-index-file FILE --reviewed-csv FILE --month YYYY-MM --out DIR [--with-projections] [--replace]'
      ].join('\n'));
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new CliBoundaryError('argument_unknown', `Unknown argument: ${arg}`);
    }
  }
  if (!INPUT_MODES.has(args.mode)) {
    throw new CliBoundaryError('input_mode_unknown', `Unknown input mode: ${args.mode}`);
  }
  const required = args.mode === 'processed'
    ? ['preparedFile', 'workbenchFile', 'sourceIndexFile', 'reviewedCsv', 'month', 'outDir']
    : ['sourceDir', 'reviewedCsv', 'month', 'outDir'];
  for (const key of required) {
    if (!args[key]) throw new CliBoundaryError('argument_missing', `Missing required argument: ${key}`);
  }
  if (args.mode === 'processed' && args.sourceDir) {
    throw new CliBoundaryError(
      'input_mode_mixed',
      'Processed mode does not accept --source-dir; explicit four-layer files are required.'
    );
  }
  if (
    args.mode === 'staging'
    && [args.preparedFile, args.workbenchFile, args.sourceIndexFile].some(Boolean)
  ) {
    throw new CliBoundaryError(
      'input_mode_mixed',
      'Staging mode does not accept processed-layer file arguments.'
    );
  }
  return args;
}

async function isNonemptyDir(dir) {
  try {
    return (await readdir(dir)).length > 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertOutputPolicy(args) {
  if (await isNonemptyDir(args.outDir) && !args.replace) {
    throw new CliBoundaryError(
      'output_exists',
      'Output directory is nonempty. Refusing silent overwrite; use --replace for the same verified generation.',
      { out_dir: args.outDir }
    );
  }
}

function parseJsonlStrict(raw, fileName) {
  const rows = [];
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new CliBoundaryError('json_parse_error', 'Invalid JSONL input.', {
        input_file: fileName,
        line: index + 1,
        cause: safeText(error?.message)
      });
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new CliBoundaryError('json_row_not_object', 'Every JSONL row must be an object.', {
        input_file: fileName,
        line: index + 1
      });
    }
    // stableJson enforces finite numbers, plain objects, and JSON-only values.
    stableJson(row);
    rows.push(row);
  }
  return rows;
}

function parseJsonStrict(raw, fileName) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliBoundaryError('json_parse_error', 'Invalid JSON input.', {
      input_file: fileName,
      cause: safeText(error?.message)
    });
  }
  stableJson(parsed);
  return parsed;
}

function requireArray(value, fileName, field = '$') {
  if (!Array.isArray(value)) {
    throw new CliBoundaryError('json_array_required', 'Processed input must contain an array.', {
      input_file: fileName,
      field
    });
  }
  value.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new CliBoundaryError('json_row_not_object', 'Every processed row must be an object.', {
        input_file: fileName,
        field,
        row_index: index
      });
    }
  });
  return value;
}

function pathContainsSegment(filePath, segment) {
  return resolve(filePath).split(/[\\/]+/u).includes(segment);
}

function requireProcessedPreparedShape(rows, fileName) {
  const requiredFields = [
    'chunk_id',
    'source_bundle_id',
    'source_manifest_kind',
    'source_window_id'
  ];
  const invalidRows = rows
    .map((row, index) => ({
      index,
      missing_fields: requiredFields.filter((field) => !safeText(row[field]))
    }))
    .filter((row) => row.missing_fields.length);
  if (invalidRows.length) {
    throw new CliBoundaryError(
      'processed_prepared_shape_invalid',
      'Prepared input is not a processed prepared-bundle layer.',
      {
        input_file: fileName,
        invalid_row_count: invalidRows.length,
        first_invalid_rows: invalidRows.slice(0, 20)
      }
    );
  }
  return rows;
}

function parseReviewedCsvStrict(raw, fileName) {
  const parsed = parseCsvTextWithDiagnostics(raw);
  if (parsed.diagnostics.errors.length) {
    throw new CliBoundaryError('reviewed_csv_parse_error', 'Reviewed CSV failed strict parsing.', {
      input_file: fileName,
      diagnostics: parsed.diagnostics
    });
  }
  const headerCounts = new Map();
  for (const header of parsed.headers) {
    const key = safeText(header);
    headerCounts.set(key, (headerCounts.get(key) || 0) + 1);
  }
  const duplicateHeaders = [...headerCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([header, count]) => ({ header, count }));
  if (duplicateHeaders.length) {
    throw new CliBoundaryError(
      'reviewed_csv_duplicate_header',
      'Reviewed CSV contains duplicate headers; last-wins parsing is forbidden.',
      { input_file: fileName, duplicate_headers: duplicateHeaders }
    );
  }
  if (parsed.headers.some((header) => !safeText(header))) {
    throw new CliBoundaryError('reviewed_csv_empty_header', 'Reviewed CSV contains an empty header.', {
      input_file: fileName
    });
  }
  return parsed.rows;
}

async function loadRawInputs(args) {
  const rolePaths = args.mode === 'processed'
    ? {
      prepared: args.preparedFile,
      workbench: args.workbenchFile,
      source_index: args.sourceIndexFile,
      reviewed: args.reviewedCsv
    }
    : {
      nodes: join(args.sourceDir, STAGING_REQUIRED_FILES[0]),
      candidates: join(args.sourceDir, STAGING_REQUIRED_FILES[1]),
      traces: join(args.sourceDir, STAGING_REQUIRED_FILES[2]),
      spans: join(args.sourceDir, STAGING_REQUIRED_FILES[3]),
      reviewed: args.reviewedCsv
    };
  for (const [role, filePath] of Object.entries(rolePaths)) {
    if (!existsSync(filePath)) {
      throw new CliBoundaryError('input_missing', `Missing ${args.mode} source file: ${role}`, {
        input_role: role,
        input_file: basename(filePath)
      });
    }
  }
  const canonicalRolePaths = Object.fromEntries(
    await Promise.all(Object.entries(rolePaths).map(async ([role, filePath]) => [
      role,
      await realpath(filePath)
    ]))
  );
  if (args.mode === 'processed') {
    const rawRoles = Object.entries(canonicalRolePaths)
      .filter(([, filePath]) => pathContainsSegment(filePath, '00_bundle_raw'))
      .map(([role, filePath]) => ({ role, file_name: basename(filePath) }));
    if (rawRoles.length) {
      throw new CliBoundaryError(
        'raw_chat_input_forbidden',
        'Processed mode refuses files from 00_bundle_raw.',
        { raw_input_roles: rawRoles }
      );
    }
  }
  const rawEntries = await Promise.all(Object.entries(rolePaths).map(async ([role, filePath]) => [
    role,
    await readFile(canonicalRolePaths[role], 'utf8')
  ]));
  const rawByRole = Object.fromEntries(rawEntries);
  const inputDigests = Object.fromEntries(
    Object.entries(rawByRole)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, raw]) => [
        role,
        {
          file_name: basename(rolePaths[role]),
          sha256: sha256(raw)
        }
      ])
  );
  const generationId = `driftstone-portable-v1:${sha256({
    input_mode: args.mode,
    month_key: args.month,
    input_files: inputDigests,
    output_profile: args.withProjections
      ? 'canonical_plus_projections'
      : 'canonical_only'
  })}`;
  return { rawByRole, inputDigests, generationId, rolePaths };
}

function parseLoadedInputs(args, loaded) {
  if (args.mode === 'processed') {
    const prepared = parseJsonStrict(loaded.rawByRole.prepared, basename(args.preparedFile));
    const workbench = parseJsonStrict(loaded.rawByRole.workbench, basename(args.workbenchFile));
    const sourceIndex = parseJsonStrict(
      loaded.rawByRole.source_index,
      basename(args.sourceIndexFile)
    );
    if (!sourceIndex || typeof sourceIndex !== 'object' || Array.isArray(sourceIndex)) {
      throw new CliBoundaryError(
        'source_index_object_required',
        'Processed source-index input must be an object.'
      );
    }
    const { anchors, source_topic_index: sourceTopics, ...sourceIndexMetadata } = sourceIndex;
    return {
      prepared: requireProcessedPreparedShape(
        requireArray(prepared, basename(args.preparedFile)),
        basename(args.preparedFile)
      ),
      workbench: requireArray(workbench, basename(args.workbenchFile)),
      sourceAnchors: requireArray(anchors, basename(args.sourceIndexFile), 'anchors'),
      sourceTopics: requireArray(
        sourceTopics,
        basename(args.sourceIndexFile),
        'source_topic_index'
      ),
      sourceIndexMetadata,
      reviewedRows: parseReviewedCsvStrict(
        loaded.rawByRole.reviewed,
        basename(args.reviewedCsv)
      )
    };
  }
  return {
    nodes: parseJsonlStrict(loaded.rawByRole.nodes, STAGING_REQUIRED_FILES[0]),
    candidates: parseJsonlStrict(loaded.rawByRole.candidates, STAGING_REQUIRED_FILES[1]),
    traces: parseJsonlStrict(loaded.rawByRole.traces, STAGING_REQUIRED_FILES[2]),
    spans: parseJsonlStrict(loaded.rawByRole.spans, STAGING_REQUIRED_FILES[3]),
    reviewedRows: parseReviewedCsvStrict(
      loaded.rawByRole.reviewed,
      basename(args.reviewedCsv)
    )
  };
}

function uniqueLookup(rows, keyName) {
  const lookup = new Map();
  const ambiguous = new Set();
  for (const row of rows) {
    const key = safeText(row?.[keyName]);
    if (!key) continue;
    if (lookup.has(key)) {
      lookup.delete(key);
      ambiguous.add(key);
      continue;
    }
    if (!ambiguous.has(key)) lookup.set(key, row);
  }
  return { lookup, ambiguous };
}

function resolveAll(descriptor, ids) {
  const resolved = [];
  const ambiguous = [];
  const unresolved = [];
  for (const id of uniqueStrings(ids)) {
    if (descriptor.ambiguous.has(id)) {
      ambiguous.push(id);
    } else if (descriptor.lookup.has(id)) {
      resolved.push(descriptor.lookup.get(id));
    } else {
      unresolved.push(id);
    }
  }
  return { resolved, ambiguous, unresolved };
}

function sourceLinks(node, candidate, traceById, spanById) {
  const traceIds = uniqueStrings(node.source_trace_ids, candidate.source_trace_ids);
  const traces = resolveAll(traceById, traceIds);
  const spanIds = uniqueStrings(
    node.source_span_ids,
    candidate.source_span_ids,
    traces.resolved.map((row) => row.canonical_source_span_id)
  );
  const spans = resolveAll(spanById, spanIds);
  return { traceIds, spanIds, traces, spans };
}

function firstValidationError({
  sourceEntryId,
  reviewedBySource,
  nodeBySource,
  candidateBySource,
  links
}) {
  const candidates = [
    reviewedBySource.ambiguous.has(sourceEntryId) && {
      code: 'reviewed_identity_ambiguous',
      message: 'More than one reviewed row uses the same record_id.'
    },
    nodeBySource.ambiguous.has(sourceEntryId) && {
      code: 'node_identity_ambiguous',
      message: 'More than one processed node uses the same source_entry_id.'
    },
    candidateBySource.ambiguous.has(sourceEntryId) && {
      code: 'candidate_identity_ambiguous',
      message: 'More than one normalized candidate uses the same source_entry_id.'
    },
    links.traces.ambiguous.length && {
      code: 'source_trace_identity_ambiguous',
      message: 'A referenced source trace ID is ambiguous.',
      details: { ambiguous_trace_ids: links.traces.ambiguous }
    },
    links.traces.unresolved.length && {
      code: 'source_trace_unresolved',
      message: 'A referenced source trace ID is unresolved.',
      details: { unresolved_trace_ids: links.traces.unresolved }
    },
    links.spans.ambiguous.length && {
      code: 'source_span_identity_ambiguous',
      message: 'A referenced source span ID is ambiguous.',
      details: { ambiguous_span_ids: links.spans.ambiguous }
    },
    links.spans.unresolved.length && {
      code: 'source_span_unresolved',
      message: 'A referenced source span ID is unresolved.',
      details: { unresolved_span_ids: links.spans.unresolved }
    }
  ].find(Boolean);
  if (!candidates) return null;
  return {
    ...candidates,
    details: { source_entry_id: sourceEntryId || 'missing', ...(candidates.details || {}) }
  };
}

function buildJoinedInputs(args, parsed) {
  const { nodes, candidates, traces, spans, reviewedRows } = parsed;
  const nodeBySource = uniqueLookup(nodes, 'source_entry_id');
  const candidateBySource = uniqueLookup(candidates, 'source_entry_id');
  const reviewedBySource = uniqueLookup(reviewedRows, 'record_id');
  const traceById = uniqueLookup(traces, 'trace_id');
  const spanById = uniqueLookup(spans, 'source_span_id');
  const reviewedSourceIds = new Set(reviewedRows.map((row) => safeText(row.record_id)).filter(Boolean));
  const nodeSourceIds = new Set(nodes.map((row) => safeText(row.source_entry_id)).filter(Boolean));
  const referencedTraceIds = new Set();
  const referencedSpanIds = new Set();
  const unresolvedTraceIds = new Set();
  const unresolvedSpanIds = new Set();
  const inputs = [];

  function recordLinks(links) {
    links.traceIds.forEach((id) => referencedTraceIds.add(id));
    links.spanIds.forEach((id) => referencedSpanIds.add(id));
    links.traces.unresolved.forEach((id) => unresolvedTraceIds.add(id));
    links.spans.unresolved.forEach((id) => unresolvedSpanIds.add(id));
  }

  function makeInput({ reviewedRow = {}, node = {}, candidate = {}, validationError = null }) {
    const links = sourceLinks(node, candidate, traceById, spanById);
    recordLinks(links);
    return {
      month_key: args.month,
      layer: reviewedRow.layer || '',
      reviewed_row: reviewedRow,
      node,
      candidate,
      source_traces: links.traces.resolved,
      source_spans: links.spans.resolved,
      metadata: {
        observed_dialogue_types: [],
        observed_dialogue_type_state: 'missing_not_inferred_from_text'
      },
      validation_error: typeof validationError === 'function' ? validationError(links) : validationError
    };
  }

  for (const reviewedRow of reviewedRows) {
    const sourceEntryId = safeText(reviewedRow.record_id);
    const node = nodeBySource.lookup.get(sourceEntryId) || {};
    const candidate = candidateBySource.lookup.get(sourceEntryId) || {};
    inputs.push(makeInput({
      reviewedRow,
      node,
      candidate,
      validationError: (links) => firstValidationError({
        sourceEntryId,
        reviewedBySource,
        nodeBySource,
        candidateBySource,
        links
      })
    }));
  }

  for (const node of nodes) {
    const sourceEntryId = safeText(node.source_entry_id);
    if (sourceEntryId && reviewedSourceIds.has(sourceEntryId)) continue;
    const candidate = candidateBySource.lookup.get(sourceEntryId) || {};
    inputs.push(makeInput({
      node,
      candidate,
      validationError: {
        code: 'reviewed_row_missing',
        message: 'A processed node has no reviewed CSV row.',
        details: { source_entry_id: sourceEntryId || 'missing' }
      }
    }));
  }

  for (const candidate of candidates) {
    const sourceEntryId = safeText(candidate.source_entry_id);
    if (
      (sourceEntryId && reviewedSourceIds.has(sourceEntryId))
      || (sourceEntryId && nodeSourceIds.has(sourceEntryId))
    ) {
      continue;
    }
    inputs.push(makeInput({
      candidate,
      validationError: {
        code: 'normalized_candidate_orphan',
        message: 'A normalized candidate has neither a reviewed row nor a processed node.',
        details: { source_entry_id: sourceEntryId || 'missing' }
      }
    }));
  }

  const traceIdsInFile = new Set(traces.map((row) => safeText(row.trace_id)).filter(Boolean));
  const spanIdsInFile = new Set(spans.map((row) => safeText(row.source_span_id)).filter(Boolean));
  const sourceJoin = {
    reviewed_rows: reviewedRows.length,
    processed_nodes: nodes.length,
    normalized_candidates: candidates.length,
    source_traces: traces.length,
    source_spans: spans.length,
    reviewed_identity_ambiguous_ids: [...reviewedBySource.ambiguous].sort(),
    node_identity_ambiguous_ids: [...nodeBySource.ambiguous].sort(),
    candidate_identity_ambiguous_ids: [...candidateBySource.ambiguous].sort(),
    source_trace_identity_ambiguous_ids: [...traceById.ambiguous].sort(),
    source_span_identity_ambiguous_ids: [...spanById.ambiguous].sort(),
    source_trace_rows_without_id: traces.filter((row) => !safeText(row.trace_id)).length,
    source_span_rows_without_id: spans.filter((row) => !safeText(row.source_span_id)).length,
    unresolved_trace_ids: [...unresolvedTraceIds].sort(),
    unresolved_span_ids: [...unresolvedSpanIds].sort(),
    orphan_trace_ids: [...traceIdsInFile].filter((id) => !referencedTraceIds.has(id)).sort(),
    orphan_span_ids: [...spanIdsInFile].filter((id) => !referencedSpanIds.has(id)).sort(),
    processed_nodes_without_reviewed_row: nodes.filter((row) => (
      !reviewedSourceIds.has(safeText(row.source_entry_id))
    )).length,
    normalized_candidates_without_reviewed_or_node: candidates.filter((row) => {
      const id = safeText(row.source_entry_id);
      return !reviewedSourceIds.has(id) && !nodeSourceIds.has(id);
    }).length
  };
  return { inputs, sourceJoin };
}

function splitReferenceValues(...values) {
  const out = [];
  for (const value of values.flat(Infinity)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      out.push(...splitReferenceValues(value));
      continue;
    }
    if (typeof value === 'object') continue;
    const text = safeText(value);
    if (!text) continue;
    if (text.startsWith('[') && text.endsWith(']')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          out.push(...splitReferenceValues(parsed));
          continue;
        }
      } catch {
        // The strict CSV field remains preserved; this helper only resolves explicit IDs.
      }
    }
    out.push(...text.split(/\s*(?:[,，;；|]|\n)\s*/u).filter(Boolean));
  }
  return uniqueStrings(out);
}

function preparedWindowLineage(row = {}) {
  const { text, ...sourceFields } = row;
  return {
    ...sourceFields,
    prepared_text_binding: {
      copied_to_portable_artifact: false,
      present: typeof text === 'string' && text.length > 0,
      utf8_sha256: typeof text === 'string' ? sha256(text) : '',
      character_count: typeof text === 'string' ? [...text].length : 0
    }
  };
}

function firstProcessedValidationError({
  sourceEntryId,
  reviewedById,
  workbenchById,
  anchorById,
  chunks,
  topics
}) {
  const candidates = [
    reviewedById.ambiguous.has(sourceEntryId) && {
      code: 'reviewed_identity_ambiguous',
      message: 'More than one reviewed row uses the same record_id.'
    },
    workbenchById.ambiguous.has(sourceEntryId) && {
      code: 'workbench_identity_ambiguous',
      message: 'More than one workbench row uses the same record_id.'
    },
    anchorById.ambiguous.has(sourceEntryId) && {
      code: 'source_index_anchor_identity_ambiguous',
      message: 'More than one source-index anchor uses the same record_id.'
    },
    !workbenchById.lookup.has(sourceEntryId) && {
      code: 'workbench_record_unresolved',
      message: 'Reviewed row has no exact record_id match in the workbench.'
    },
    !anchorById.lookup.has(sourceEntryId) && {
      code: 'source_index_anchor_unresolved',
      message: 'Reviewed row has no exact record_id match in the source index.'
    },
    chunks.ambiguous.length && {
      code: 'prepared_chunk_identity_ambiguous',
      message: 'A referenced prepared chunk ID is ambiguous.',
      details: { ambiguous_chunk_ids: chunks.ambiguous }
    },
    chunks.unresolved.length && {
      code: 'prepared_chunk_unresolved',
      message: 'A referenced prepared chunk ID is unresolved.',
      details: { unresolved_chunk_ids: chunks.unresolved }
    },
    topics.ambiguous.length && {
      code: 'source_topic_identity_ambiguous',
      message: 'A referenced source topic ID is ambiguous.',
      details: { ambiguous_topic_ids: topics.ambiguous }
    },
    topics.unresolved.length && {
      code: 'source_topic_unresolved',
      message: 'A referenced source topic ID is unresolved.',
      details: { unresolved_topic_ids: topics.unresolved }
    }
  ].find(Boolean);
  if (!candidates) return null;
  return {
    ...candidates,
    details: { source_entry_id: sourceEntryId || 'missing', ...(candidates.details || {}) }
  };
}

function buildProcessedJoinedInputs(args, parsed) {
  const {
    prepared,
    workbench,
    sourceAnchors,
    sourceTopics,
    sourceIndexMetadata,
    reviewedRows
  } = parsed;
  const reviewedById = uniqueLookup(reviewedRows, 'record_id');
  const workbenchById = uniqueLookup(workbench, 'record_id');
  const anchorById = uniqueLookup(sourceAnchors, 'record_id');
  const preparedByChunk = uniqueLookup(prepared, 'chunk_id');
  const topicById = uniqueLookup(sourceTopics, 'topic_id');
  const reviewedIds = new Set(reviewedRows.map((row) => safeText(row.record_id)).filter(Boolean));
  const workbenchIds = new Set(workbench.map((row) => safeText(row.record_id)).filter(Boolean));
  const anchorIds = new Set(sourceAnchors.map((row) => safeText(row.record_id)).filter(Boolean));
  const preparedIds = new Set(prepared.map((row) => safeText(row.chunk_id)).filter(Boolean));
  const topicIdsInFile = new Set(sourceTopics.map((row) => safeText(row.topic_id)).filter(Boolean));
  const referencedChunkIds = new Set();
  const referencedTopicIds = new Set();
  const unresolvedChunkIds = new Set();
  const unresolvedTopicIds = new Set();
  const inputs = [];

  function joinedFor(reviewedRow = {}, workbenchRow = {}, anchor = {}) {
    const chunkIds = splitReferenceValues(
      reviewedRow.chunk_id,
      workbenchRow.chunk_id,
      anchor.chunk_id
    );
    // reviewed/workbench topic IDs are memory-taxonomy labels in this corpus.
    // Only source-index anchor topic_ids address source_topic_index rows.
    const topicIds = splitReferenceValues(anchor.topic_ids);
    const chunks = resolveAll(preparedByChunk, chunkIds);
    const topics = resolveAll(topicById, topicIds);
    chunkIds.forEach((id) => referencedChunkIds.add(id));
    topicIds.forEach((id) => referencedTopicIds.add(id));
    chunks.unresolved.forEach((id) => unresolvedChunkIds.add(id));
    topics.unresolved.forEach((id) => unresolvedTopicIds.add(id));
    return { chunkIds, topicIds, chunks, topics };
  }

  function makeInput({
    reviewedRow = {},
    workbenchRow = {},
    anchor = {},
    validationError = null
  }) {
    const joined = joinedFor(reviewedRow, workbenchRow, anchor);
    return {
      month_key: args.month,
      layer: reviewedRow.layer || workbenchRow.layer || anchor.layer || '',
      reviewed_row: reviewedRow,
      workbench_records: Object.keys(workbenchRow).length ? [workbenchRow] : [],
      source_index_anchors: Object.keys(anchor).length ? [anchor] : [],
      source_index_topics: joined.topics.resolved,
      prepared_windows: joined.chunks.resolved.map(preparedWindowLineage),
      source_index_metadata: sourceIndexMetadata,
      metadata: {
        observed_dialogue_types: [],
        observed_dialogue_type_state: 'missing_not_inferred_from_text',
        upstream_review_state: Object.keys(reviewedRow).length
          ? 'reviewed_csv_source_row'
          : ''
      },
      validation_error: typeof validationError === 'function'
        ? validationError(joined)
        : validationError
    };
  }

  for (const reviewedRow of reviewedRows) {
    const sourceEntryId = safeText(reviewedRow.record_id);
    const workbenchRow = workbenchById.lookup.get(sourceEntryId) || {};
    const anchor = anchorById.lookup.get(sourceEntryId) || {};
    inputs.push(makeInput({
      reviewedRow,
      workbenchRow,
      anchor,
      validationError: (joined) => firstProcessedValidationError({
        sourceEntryId,
        reviewedById,
        workbenchById,
        anchorById,
        chunks: joined.chunks,
        topics: joined.topics
      })
    }));
  }

  for (const workbenchRow of workbench) {
    const sourceEntryId = safeText(workbenchRow.record_id);
    if (sourceEntryId && reviewedIds.has(sourceEntryId)) continue;
    const anchor = anchorById.lookup.get(sourceEntryId) || {};
    inputs.push(makeInput({
      workbenchRow,
      anchor,
      validationError: {
        code: sourceEntryId
          ? 'processed_workbench_without_reviewed_row'
          : 'processed_workbench_identity_missing',
        message: sourceEntryId
          ? 'A processed workbench row has no reviewed CSV row.'
          : 'A processed workbench row has no record_id.',
        details: { source_entry_id: sourceEntryId || 'missing' }
      }
    }));
  }

  for (const anchor of sourceAnchors) {
    const sourceEntryId = safeText(anchor.record_id);
    if (
      sourceEntryId
      && (reviewedIds.has(sourceEntryId) || workbenchIds.has(sourceEntryId))
    ) {
      continue;
    }
    inputs.push(makeInput({
      anchor,
      validationError: {
        code: sourceEntryId
          ? 'source_index_anchor_orphan'
          : 'source_index_anchor_identity_missing',
        message: sourceEntryId
          ? 'A source-index anchor has neither a reviewed row nor a workbench row.'
          : 'A source-index anchor has no record_id.',
        details: { source_entry_id: sourceEntryId || 'missing' }
      }
    }));
  }

  const sourceJoin = {
    input_mode: 'processed',
    reviewed_rows: reviewedRows.length,
    workbench_rows: workbench.length,
    source_index_anchor_rows: sourceAnchors.length,
    source_index_topic_rows: sourceTopics.length,
    prepared_window_rows: prepared.length,
    portable_source_units: inputs.length,
    reviewed_identity_ambiguous_ids: [...reviewedById.ambiguous].sort(),
    workbench_identity_ambiguous_ids: [...workbenchById.ambiguous].sort(),
    source_index_anchor_identity_ambiguous_ids: [...anchorById.ambiguous].sort(),
    prepared_chunk_identity_ambiguous_ids: [...preparedByChunk.ambiguous].sort(),
    source_topic_identity_ambiguous_ids: [...topicById.ambiguous].sort(),
    reviewed_rows_without_id: reviewedRows.filter((row) => !safeText(row.record_id)).length,
    workbench_rows_without_id: workbench.filter((row) => !safeText(row.record_id)).length,
    source_index_anchor_rows_without_id: sourceAnchors.filter((row) => !safeText(row.record_id)).length,
    prepared_rows_without_chunk_id: prepared.filter((row) => !safeText(row.chunk_id)).length,
    source_topic_rows_without_topic_id: sourceTopics.filter((row) => !safeText(row.topic_id)).length,
    reviewed_without_workbench: [...reviewedIds].filter((id) => !workbenchIds.has(id)).sort(),
    reviewed_without_source_index_anchor: [...reviewedIds].filter((id) => !anchorIds.has(id)).sort(),
    workbench_without_reviewed: [...workbenchIds].filter((id) => !reviewedIds.has(id)).sort(),
    source_index_anchor_without_reviewed: [...anchorIds].filter((id) => !reviewedIds.has(id)).sort(),
    source_index_anchor_without_workbench: [...anchorIds].filter((id) => !workbenchIds.has(id)).sort(),
    workbench_without_source_index_anchor: [...workbenchIds].filter((id) => !anchorIds.has(id)).sort(),
    unresolved_prepared_chunk_ids: [...unresolvedChunkIds].sort(),
    unresolved_source_topic_ids: [...unresolvedTopicIds].sort(),
    orphan_prepared_chunk_ids: [...preparedIds]
      .filter((id) => !referencedChunkIds.has(id))
      .sort(),
    orphan_source_topic_ids: [...topicIdsInFile]
      .filter((id) => !referencedTopicIds.has(id))
      .sort(),
    prepared_text_bodies_copied: 0,
    raw_chat_files_read: 0,
    raw_input_boundary_enforced: true,
    processed_input_classification: {
      prepared: 'processed_prepared_bundle',
      workbench: 'processed_workbench',
      source_index: 'processed_source_index',
      reviewed: 'reviewed_csv'
    },
    direct_destination_writes: 0
  };
  const expectedPortableSourceUnits = (
    reviewedRows.length
    + workbench.filter((row) => {
      const id = safeText(row.record_id);
      return !id || !reviewedIds.has(id);
    }).length
    + sourceAnchors.filter((row) => {
      const id = safeText(row.record_id);
      return !id || (!reviewedIds.has(id) && !workbenchIds.has(id));
    }).length
  );
  sourceJoin.portable_source_unit_conservation = {
    expected_units: expectedPortableSourceUnits,
    emitted_units: inputs.length,
    passed: expectedPortableSourceUnits === inputs.length
  };
  const workbenchJoinedRows = workbench.filter((row) => (
    safeText(row.record_id) && reviewedIds.has(safeText(row.record_id))
  )).length;
  const workbenchRejectedRows = workbench.length - workbenchJoinedRows;
  const anchorsJoinedRows = sourceAnchors.filter((row) => {
    const id = safeText(row.record_id);
    return id && (reviewedIds.has(id) || workbenchIds.has(id));
  }).length;
  const anchorsRejectedRows = sourceAnchors.length - anchorsJoinedRows;
  sourceJoin.auxiliary_row_conservation = {
    workbench: {
      input_rows: workbench.length,
      joined_to_reviewed_rows: workbenchJoinedRows,
      rejected_unreviewed_or_identity_missing_rows: workbenchRejectedRows,
      passed: workbench.length === workbenchJoinedRows + workbenchRejectedRows
    },
    source_index_anchors: {
      input_rows: sourceAnchors.length,
      joined_to_reviewed_or_workbench_rows: anchorsJoinedRows,
      rejected_orphan_or_identity_missing_rows: anchorsRejectedRows,
      passed: sourceAnchors.length === anchorsJoinedRows + anchorsRejectedRows
    },
    prepared_windows: {
      input_rows: prepared.length,
      identified_rows: prepared.filter((row) => safeText(row.chunk_id)).length,
      identity_missing_rows: prepared.filter((row) => !safeText(row.chunk_id)).length,
      passed: prepared.length === (
        prepared.filter((row) => safeText(row.chunk_id)).length
        + prepared.filter((row) => !safeText(row.chunk_id)).length
      )
    },
    source_index_topics: {
      input_rows: sourceTopics.length,
      identified_rows: sourceTopics.filter((row) => safeText(row.topic_id)).length,
      identity_missing_rows: sourceTopics.filter((row) => !safeText(row.topic_id)).length,
      passed: sourceTopics.length === (
        sourceTopics.filter((row) => safeText(row.topic_id)).length
        + sourceTopics.filter((row) => !safeText(row.topic_id)).length
      )
    },
    all_layers_passed: true
  };
  sourceJoin.auxiliary_row_conservation.all_layers_passed = [
    sourceJoin.auxiliary_row_conservation.workbench.passed,
    sourceJoin.auxiliary_row_conservation.source_index_anchors.passed,
    sourceJoin.auxiliary_row_conservation.prepared_windows.passed,
    sourceJoin.auxiliary_row_conservation.source_index_topics.passed
  ].every(Boolean);
  return { inputs, sourceJoin };
}

function verifyManifest(manifest) {
  return manifest?.schema === GENERATION_SCHEMA
    && verifyContractDigest(manifest, 'manifest_sha256');
}

async function validateExistingGeneration(args, generationId) {
  if (!(await isNonemptyDir(args.outDir))) return;
  if (!args.replace) {
    throw new CliBoundaryError('output_exists', 'Output directory is nonempty.', {
      out_dir: args.outDir
    });
  }
  const manifestPath = join(args.outDir, 'portable_generation_manifest_v1.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new CliBoundaryError(
      'existing_generation_manifest_invalid',
      'Existing output cannot be replaced without a valid generation manifest.',
      { cause: safeText(error?.message) }
    );
  }
  if (!verifyManifest(manifest)) {
    throw new CliBoundaryError(
      'existing_generation_manifest_invalid',
      'Existing generation manifest digest is invalid.'
    );
  }
  if (manifest.generation_id !== generationId) {
    throw new CliBoundaryError(
      'generation_mismatch',
      'Explicit replacement is allowed only for the same input generation.',
      { existing_generation_id: manifest.generation_id, requested_generation_id: generationId }
    );
  }
  const manifestFile = 'portable_generation_manifest_v1.json';
  const expectedFiles = new Set([
    ...Object.keys(manifest.output_files || {}),
    manifestFile
  ]);
  const actualFiles = await readdir(args.outDir);
  const unexpectedFiles = actualFiles.filter((file) => !expectedFiles.has(file)).sort();
  const missingFiles = [...expectedFiles].filter((file) => !actualFiles.includes(file)).sort();
  if (unexpectedFiles.length || missingFiles.length) {
    throw new CliBoundaryError(
      'existing_generation_file_set_mismatch',
      'Existing generation file set does not match its manifest.',
      { unexpected_files: unexpectedFiles, missing_files: missingFiles }
    );
  }
  for (const [file, expectedDigest] of Object.entries(manifest.output_files || {})) {
    const actual = sha256(await readFile(join(args.outDir, file), 'utf8'));
    if (actual !== expectedDigest) {
      throw new CliBoundaryError(
        'existing_generation_output_digest_mismatch',
        'Existing generation output digest does not match its manifest.',
        { output_file: file }
      );
    }
  }
}

async function publishAtomically(args, generationId, files) {
  await validateExistingGeneration(args, generationId);
  const parent = dirname(args.outDir);
  await mkdir(parent, { recursive: true });
  const tempDir = await mkdtemp(join(parent, `.${basename(args.outDir)}.tmp-`));
  try {
    for (const [file, text] of Object.entries(files)) {
      await writeFile(join(tempDir, file), text, {
        encoding: 'utf8',
        mode: 0o600
      });
    }
    const outputDigests = Object.fromEntries(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, text]) => [file, sha256(text)])
    );
    const manifest = finalizeContractDigest({
      schema: GENERATION_SCHEMA,
      generation_id: generationId,
      output_profile: args.withProjections
        ? 'canonical_plus_projections'
        : 'canonical_only',
      output_files: outputDigests
    }, 'manifest_sha256');
    await writeFile(
      join(tempDir, 'portable_generation_manifest_v1.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );

    const hadExisting = existsSync(args.outDir);
    const backupDir = `${args.outDir}.previous-${process.pid}`;
    if (hadExisting) await rename(args.outDir, backupDir);
    try {
      await rename(tempDir, args.outDir);
      if (hadExisting) await rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      if (hadExisting && existsSync(backupDir) && !existsSync(args.outDir)) {
        await rename(backupDir, args.outDir);
      }
      throw error;
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function buildPersistedFiles({
  args,
  loaded,
  built,
  sourceJoin
}) {
  const ledger = finalizeLedgerDigest({
    ...built.ledger,
    generation_id: loaded.generationId,
    input_mode: args.mode,
    output_profile: args.withProjections
      ? 'canonical_plus_projections'
      : 'canonical_only',
    input_files: loaded.inputDigests,
    source_dir_name: args.sourceDir ? basename(args.sourceDir) : '',
    processed_input_files: args.mode === 'processed'
      ? {
        prepared: basename(args.preparedFile),
        workbench: basename(args.workbenchFile),
        source_index: basename(args.sourceIndexFile)
      }
      : {},
    reviewed_csv_name: basename(args.reviewedCsv),
    source_join: sourceJoin
  });
  if (!verifyLedgerDigest(ledger)) {
    throw new CliBoundaryError('ledger_digest_invalid', 'Final persisted ledger digest did not verify.');
  }
  const files = {
    'portable_memory_artifacts_v1.jsonl': exportPortableArtifactsJsonl(built.artifacts),
    'portable_memory_rejected_v1.jsonl': serializeJsonl(built.rejected),
    'portable_memory_conservation_v1.json': `${JSON.stringify(ledger, null, 2)}\n`
  };
  if (args.withProjections) {
    files['portable_notion_projections_v1.jsonl'] = serializeJsonl(
      built.artifacts.map(projectPortableArtifactToNotion)
    );
    files['portable_markdown_projections_v1.jsonl'] = serializeJsonl(
      built.artifacts.map(projectPortableArtifactToMarkdown)
    );
  }
  return files;
}

async function persistBoundaryFailure(args, loaded, error) {
  const built = buildPortableArtifactBatch([{
    month_key: args.month,
    validation_error: {
      code: safeText(error?.code, 'input_boundary_error'),
      message: safeText(error?.message, 'Input boundary failed.'),
      details: error?.details || {}
    }
  }]);
  const sourceJoin = {
    boundary_failure: true,
    failure_code: safeText(error?.code, 'input_boundary_error')
  };
  const files = buildPersistedFiles({ args, loaded, built, sourceJoin });
  await publishAtomically(args, loaded.generationId, files);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertOutputPolicy(args);
  const loaded = await loadRawInputs(args);
  let parsed;
  try {
    parsed = parseLoadedInputs(args, loaded);
  } catch (error) {
    await persistBoundaryFailure(args, loaded, error);
    throw error;
  }
  const joined = args.mode === 'processed'
    ? buildProcessedJoinedInputs(args, parsed)
    : buildJoinedInputs(args, parsed);
  const built = buildPortableArtifactBatch(joined.inputs);
  const files = buildPersistedFiles({
    args,
    loaded,
    built,
    sourceJoin: joined.sourceJoin
  });
  await publishAtomically(args, loaded.generationId, files);
  console.log(JSON.stringify({
    ok: true,
    input_mode: args.mode,
    output_profile: args.withProjections
      ? 'canonical_plus_projections'
      : 'canonical_only',
    generation_id: loaded.generationId,
    artifacts: built.artifacts.length,
    rejected: built.rejected.length,
    historical_case_candidates: built.ledger.historical_case_candidates,
    missing_atomic_fact: built.ledger.artifacts_missing_atomic_fact,
    writes_any_destination: false,
    out_dir: args.outDir
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: safeText(error?.code, error?.name || 'error'),
    error: safeText(error?.message, String(error || 'unknown error')),
    writes_any_destination: false
  }, null, 2));
  process.exitCode = 1;
});
