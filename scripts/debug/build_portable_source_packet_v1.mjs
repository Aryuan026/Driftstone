#!/usr/bin/env node
// Build a private, read-only source packet from Driftstone's five existing monthly layers.
// This adapter does not rerun extraction and does not write Home, Hippocove, Notion, or cloud storage.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
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
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseCsvTextWithDiagnostics } from '../../server/core/csv-reader.js';
import {
  HUMAN_DECISIONS_SCHEMA,
  PortableSourcePacketError,
  buildPortableSourcePacket,
  safeText,
  serializeJsonl,
  sha256,
  stableJson,
  verifyPortableSourcePacket
} from '../lib/driftstone-portable-source-packet-v1.mjs';

const GENERATION_MANIFEST_SCHEMA = 'driftstone_portable_source_generation_manifest_v1';
const MONTH_PATTERN = /^\d{4}-\d{2}$/u;
const CLI_SOURCE_FILE = fileURLToPath(import.meta.url);
const LIBRARY_SOURCE_FILE = fileURLToPath(
  new URL('../lib/driftstone-portable-source-packet-v1.mjs', import.meta.url)
);
const CSV_READER_SOURCE_FILE = fileURLToPath(
  new URL('../../server/core/csv-reader.js', import.meta.url)
);
const OUTPUT_FILES = Object.freeze({
  packet: 'portable_source_packet_v1.json',
  candidates: 'portable_source_candidates_v1.jsonl',
  rawDisposition: 'portable_source_raw_disposition_v1.jsonl',
  preparedCoverage: 'portable_source_prepared_coverage_v1.jsonl',
  workbenchReviewLedger: 'portable_source_workbench_review_ledger_v1.jsonl',
  humanReviewQueue: 'portable_source_human_review_queue_v1.jsonl',
  projections: 'portable_source_bounded_projections_v1.jsonl',
  rejected: 'portable_source_rejected_v1.jsonl'
});

class CliBoundaryError extends PortableSourcePacketError {}

function parseArgs(argv = []) {
  const args = {
    rawFile: '',
    preparedFile: '',
    workbenchFile: '',
    sourceIndexFile: '',
    reviewedCsv: '',
    humanDecisionsFile: '',
    month: '',
    outDir: '',
    canaryLimit: 0,
    replace: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = safeText(argv[index]);
    const next = argv[index + 1];
    if (argument === '--raw-file' && next) {
      args.rawFile = resolve(next);
      index += 1;
    } else if (argument === '--prepared-file' && next) {
      args.preparedFile = resolve(next);
      index += 1;
    } else if (argument === '--workbench-file' && next) {
      args.workbenchFile = resolve(next);
      index += 1;
    } else if (argument === '--source-index-file' && next) {
      args.sourceIndexFile = resolve(next);
      index += 1;
    } else if (argument === '--reviewed-csv' && next) {
      args.reviewedCsv = resolve(next);
      index += 1;
    } else if (argument === '--human-decisions' && next) {
      args.humanDecisionsFile = resolve(next);
      index += 1;
    } else if (argument === '--month' && next) {
      args.month = safeText(next);
      index += 1;
    } else if (argument === '--out' && next) {
      args.outDir = resolve(next);
      index += 1;
    } else if (argument === '--canary-limit' && next) {
      args.canaryLimit = Number(next);
      index += 1;
    } else if (argument === '--replace') {
      args.replace = true;
    } else if (argument === '--help' || argument === '-h') {
      console.log([
        'Usage:',
        '  node scripts/debug/build_portable_source_packet_v1.mjs \\',
        '    --raw-file FILE --prepared-file FILE --workbench-file FILE \\',
        '    --source-index-file FILE --reviewed-csv FILE \\',
        '    --month YYYY-MM --out DIR \\',
        '    [--human-decisions FILE] [--canary-limit N] [--replace]',
        '',
        `Human decisions schema: ${HUMAN_DECISIONS_SCHEMA}`
      ].join('\n'));
      process.exit(0);
    } else if (argument.startsWith('-')) {
      throw new CliBoundaryError('argument_unknown', `Unknown argument: ${argument}`);
    }
  }
  for (const field of [
    'rawFile',
    'preparedFile',
    'workbenchFile',
    'sourceIndexFile',
    'reviewedCsv',
    'month',
    'outDir'
  ]) {
    if (!args[field]) {
      throw new CliBoundaryError(
        'argument_missing',
        `Missing required argument: ${field}`
      );
    }
  }
  if (!MONTH_PATTERN.test(args.month)) {
    throw new CliBoundaryError('month_key_invalid', 'Month must use YYYY-MM form.');
  }
  if (!Number.isInteger(args.canaryLimit) || args.canaryLimit < 0) {
    throw new CliBoundaryError(
      'canary_limit_invalid',
      'Canary limit must be a non-negative integer.'
    );
  }
  return args;
}

function parseJsonStrict(raw, role) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliBoundaryError('json_parse_error', `Invalid JSON input for ${role}.`, {
      input_role: role,
      cause: safeText(error?.message)
    });
  }
  stableJson(parsed);
  return parsed;
}

function requireArray(value, role) {
  if (!Array.isArray(value)) {
    throw new CliBoundaryError(
      'json_array_required',
      `${role} input must be an array.`,
      { input_role: role }
    );
  }
  value.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new CliBoundaryError(
        'json_row_not_object',
        `${role} rows must be objects.`,
        { input_role: role, row_index: index }
      );
    }
  });
  return value;
}

function parseReviewedCsvStrict(raw) {
  const parsed = parseCsvTextWithDiagnostics(raw);
  if (parsed.diagnostics.errors.length) {
    throw new CliBoundaryError(
      'reviewed_csv_parse_error',
      'Reviewed CSV failed strict parsing.',
      { diagnostics: parsed.diagnostics }
    );
  }
  const counts = new Map();
  for (const header of parsed.headers) {
    const key = safeText(header);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const duplicateHeaders = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([header, count]) => ({ header, count }));
  if (duplicateHeaders.length) {
    throw new CliBoundaryError(
      'reviewed_csv_duplicate_header',
      'Reviewed CSV contains duplicate headers; last-wins parsing is forbidden.',
      { duplicate_headers: duplicateHeaders }
    );
  }
  if (parsed.headers.some((header) => !safeText(header))) {
    throw new CliBoundaryError(
      'reviewed_csv_empty_header',
      'Reviewed CSV contains an empty header.'
    );
  }
  return parsed;
}

function keyUnion(rows = []) {
  return [...new Set(rows.flatMap((row) => Object.keys(row || {})))].sort();
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function assertSemanticRows(role, rows, validate) {
  const invalid = rows
    .map((row, index) => ({
      row_index: index,
      violations: validate(row, index)
    }))
    .filter((entry) => entry.violations.length);
  if (invalid.length) {
    throw new CliBoundaryError(
      `${role.replaceAll('.', '_')}_semantic_shape_invalid`,
      `${role} input does not satisfy its minimum semantic role boundary.`,
      {
        input_role: role,
        invalid_row_count: invalid.length,
        first_invalid_rows: invalid.slice(0, 20)
      }
    );
  }
}

function validMemoryLane(value) {
  return ['persona', 'sql', 'fact', 'case'].includes(safeText(value).toLowerCase());
}

function uniqueText(values = []) {
  return [...new Set(values.map((value) => safeText(value)).filter(Boolean))].sort();
}

function describeLayer(role, parsed, rawBuffer, fileName) {
  const base = {
    role,
    file_name: fileName,
    byte_count: rawBuffer.byteLength,
    sha256: sha256(rawBuffer)
  };
  if (role === 'raw') {
    const rows = requireArray(parsed, role);
    assertSemanticRows(role, rows, (row) => {
      const violations = [];
      if (!safeText(row.source_bundle_id)) violations.push('source_bundle_id_missing');
      if (!safeText(row.month)) violations.push('month_missing');
      if (!Array.isArray(row.messages)) {
        violations.push('messages_array_missing');
        return violations;
      }
      row.messages.forEach((message, messageIndex) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          violations.push(`messages[${messageIndex}]_not_object`);
          return;
        }
        if (!safeText(message.role)) violations.push(`messages[${messageIndex}].role_missing`);
        if (!Number.isInteger(Number(message.source_msg_index))) {
          violations.push(`messages[${messageIndex}].source_msg_index_invalid`);
        }
        if (!own(message, 'content') || typeof message.content !== 'string') {
          violations.push(`messages[${messageIndex}].content_string_missing`);
        }
      });
      return violations;
    });
    const messages = rows.flatMap((row) => Array.isArray(row.messages) ? row.messages : []);
    const rowKeys = keyUnion(rows);
    const messageKeys = keyUnion(messages);
    return {
      ...base,
      detected_schema: {
        top_level: 'array',
        bundle_rows: rows.length,
        message_rows: messages.length,
        row_keys: rowKeys,
        row_keys_sha256: sha256(rowKeys),
        message_keys: messageKeys,
        message_keys_sha256: sha256(messageKeys),
        source_manifest_kinds: uniqueText(rows.map((row) => row.source_manifest_kind))
      }
    };
  }
  if (role === 'prepared' || role === 'workbench') {
    const rows = requireArray(parsed, role);
    if (role === 'prepared') {
      assertSemanticRows(role, rows, (row) => {
        const violations = [];
        if (!safeText(row.chunk_id)) violations.push('chunk_id_missing');
        if (!safeText(row.source_bundle_id)) violations.push('source_bundle_id_missing');
        if (!safeText(row.source_manifest_kind)) violations.push('source_manifest_kind_missing');
        if (!safeText(row.source_window_id)) violations.push('source_window_id_missing');
        if (own(row, 'record_id') || own(row, 'layer')) {
          violations.push('workbench_identity_fields_present');
        }
        const start = Number(row.source_msg_start);
        const end = Number(row.source_msg_end);
        if (!Number.isInteger(start)) violations.push('source_msg_start_invalid');
        if (!Number.isInteger(end)) violations.push('source_msg_end_invalid');
        if (Number.isInteger(start) && Number.isInteger(end) && start > end) {
          violations.push('source_msg_range_reversed');
        }
        if (!own(row, 'text') || typeof row.text !== 'string') {
          violations.push('text_string_missing');
        }
        return violations;
      });
    } else {
      assertSemanticRows(role, rows, (row) => {
        const violations = [];
        if (!safeText(row.record_id)) violations.push('record_id_missing');
        if (!validMemoryLane(row.layer)) violations.push('structured_layer_invalid');
        return violations;
      });
    }
    const rowKeys = keyUnion(rows);
    return {
      ...base,
      detected_schema: {
        top_level: 'array',
        row_count: rows.length,
        row_keys: rowKeys,
        row_keys_sha256: sha256(rowKeys),
        source_manifest_kinds: uniqueText(rows.map((row) => row.source_manifest_kind)),
        structured_layers: uniqueText(rows.map((row) => row.layer))
      }
    };
  }
  if (role === 'source_index') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliBoundaryError(
        'source_index_object_required',
        'Source index input must be an object.'
      );
    }
    const anchors = requireArray(parsed.anchors, 'source_index.anchors');
    const topics = requireArray(parsed.source_topic_index, 'source_index.source_topic_index');
    assertSemanticRows('source_index.anchors', anchors, (row) => {
      const violations = [];
      if (!safeText(row.record_id)) violations.push('record_id_missing');
      if (!safeText(row.anchor_id)) violations.push('anchor_id_missing');
      if (!safeText(row.chunk_id)) violations.push('chunk_id_missing');
      if (!validMemoryLane(row.layer)) violations.push('structured_layer_invalid');
      return violations;
    });
    assertSemanticRows('source_index.source_topic_index', topics, (row) => (
      safeText(row.topic_id) ? [] : ['topic_id_missing']
    ));
    const anchorKeys = keyUnion(anchors);
    const topicKeys = keyUnion(topics);
    return {
      ...base,
      detected_schema: {
        top_level: 'object',
        top_level_keys: Object.keys(parsed).sort(),
        anchor_rows: anchors.length,
        source_topic_rows: topics.length,
        anchor_keys: anchorKeys,
        anchor_keys_sha256: sha256(anchorKeys),
        source_topic_keys: topicKeys,
        source_topic_keys_sha256: sha256(topicKeys),
        kind: safeText(parsed.kind),
        mode: safeText(parsed.mode)
      }
    };
  }
  throw new CliBoundaryError('input_role_unknown', `Unknown source input role: ${role}`);
}

function describeReviewedLayer(parsed, rawBuffer, fileName) {
  assertSemanticRows('reviewed', parsed.rows, (row) => {
    const violations = [];
    if (!safeText(row.record_id)) violations.push('record_id_missing');
    if (!validMemoryLane(row.layer)) violations.push('structured_layer_invalid');
    return violations;
  });
  const rowKeys = [...parsed.headers].sort();
  return {
    role: 'reviewed',
    file_name: fileName,
    byte_count: rawBuffer.byteLength,
    sha256: sha256(rawBuffer),
    detected_schema: {
      top_level: 'csv',
      row_count: parsed.rows.length,
      header_count: parsed.headers.length,
      headers: parsed.headers,
      headers_sha256: sha256(parsed.headers),
      row_keys_sha256: sha256(rowKeys),
      structured_layers: uniqueText(parsed.rows.map((row) => row.layer)),
      parser_error_count: parsed.diagnostics.errors.length,
      parser_malformed_record_count: Array.isArray(parsed.diagnostics.malformed_records)
        ? parsed.diagnostics.malformed_records.length
        : 0
    }
  };
}

function assertMonthTruth(month, {
  rawBundles,
  preparedRows,
  workbenchRows,
  sourceIndex,
  reviewedRows
}) {
  const explicit = [];
  rawBundles.forEach((row, index) => {
    if (safeText(row.month)) explicit.push({ source: `raw[${index}].month`, value: safeText(row.month) });
  });
  function sourceBundleMonth(value) {
    const match = safeText(value).match(/(?:^|[._-])(\d{4}-\d{2})(?:[._-]|$)/u);
    return match?.[1] || '';
  }
  for (const [name, rows] of [
    ['prepared', preparedRows],
    ['workbench', workbenchRows],
    ['source_index.anchors', sourceIndex.anchors || []],
    ['reviewed', reviewedRows]
  ]) {
    rows.forEach((row, index) => {
      const value = sourceBundleMonth(row.source_bundle_id);
      if (value) explicit.push({ source: `${name}[${index}].source_bundle_id`, value });
    });
  }
  const conflicts = explicit.filter((entry) => entry.value !== month);
  if (conflicts.length) {
    throw new CliBoundaryError(
      'month_truth_conflict',
      'Explicit source-bundle month conflicts with --month.',
      {
        expected_month: month,
        conflict_count: conflicts.length,
        first_conflicts: conflicts.slice(0, 20)
      }
    );
  }
  if (!explicit.length) {
    throw new CliBoundaryError(
      'month_truth_missing',
      'No explicit source-bundle month was available to verify --month.'
    );
  }
}

async function readInputs(args) {
  const requested = {
    raw: args.rawFile,
    prepared: args.preparedFile,
    workbench: args.workbenchFile,
    source_index: args.sourceIndexFile,
    reviewed: args.reviewedCsv
  };
  if (args.humanDecisionsFile) requested.human_decisions = args.humanDecisionsFile;
  for (const [role, filePath] of Object.entries(requested)) {
    if (!existsSync(filePath)) {
      throw new CliBoundaryError('input_missing', `Missing source input: ${role}`, {
        input_role: role,
        input_file: basename(filePath)
      });
    }
  }
  const canonicalPaths = Object.fromEntries(
    await Promise.all(Object.entries(requested).map(async ([role, filePath]) => [
      role,
      await realpath(filePath)
    ]))
  );
  const rolesByCanonicalPath = new Map();
  for (const [role, canonicalPath] of Object.entries(canonicalPaths)) {
    if (!rolesByCanonicalPath.has(canonicalPath)) rolesByCanonicalPath.set(canonicalPath, []);
    rolesByCanonicalPath.get(canonicalPath).push(role);
  }
  const pathAliases = [...rolesByCanonicalPath.entries()]
    .filter(([, roles]) => roles.length > 1)
    .map(([canonicalPath, roles]) => ({
      file_name: basename(canonicalPath),
      input_roles: roles.sort()
    }));
  if (pathAliases.length) {
    throw new CliBoundaryError(
      'input_role_path_alias',
      'Each source-packet input role must resolve to a distinct canonical file.',
      { aliased_inputs: pathAliases }
    );
  }
  const buffers = Object.fromEntries(
    await Promise.all(Object.entries(canonicalPaths).map(async ([role, filePath]) => [
      role,
      await readFile(filePath)
    ]))
  );
  const parsed = {
    rawBundles: requireArray(parseJsonStrict(buffers.raw.toString('utf8'), 'raw'), 'raw'),
    preparedRows: requireArray(
      parseJsonStrict(buffers.prepared.toString('utf8'), 'prepared'),
      'prepared'
    ),
    workbenchRows: requireArray(
      parseJsonStrict(buffers.workbench.toString('utf8'), 'workbench'),
      'workbench'
    ),
    sourceIndex: parseJsonStrict(buffers.source_index.toString('utf8'), 'source_index'),
    reviewed: parseReviewedCsvStrict(buffers.reviewed.toString('utf8')),
    humanDecisions: buffers.human_decisions
      ? parseJsonStrict(buffers.human_decisions.toString('utf8'), 'human_decisions')
      : {}
  };
  describeLayer('source_index', parsed.sourceIndex, buffers.source_index, basename(requested.source_index));
  assertMonthTruth(args.month, {
    ...parsed,
    reviewedRows: parsed.reviewed.rows
  });
  const layers = {
    raw: describeLayer('raw', parsed.rawBundles, buffers.raw, basename(requested.raw)),
    prepared: describeLayer(
      'prepared',
      parsed.preparedRows,
      buffers.prepared,
      basename(requested.prepared)
    ),
    workbench: describeLayer(
      'workbench',
      parsed.workbenchRows,
      buffers.workbench,
      basename(requested.workbench)
    ),
    source_index: describeLayer(
      'source_index',
      parsed.sourceIndex,
      buffers.source_index,
      basename(requested.source_index)
    ),
    reviewed: describeReviewedLayer(
      parsed.reviewed,
      buffers.reviewed,
      basename(requested.reviewed)
    )
  };
  const fiveLayerManifestPayload = {
    schema: 'driftstone_five_layer_source_manifest_v1',
    month_key: args.month,
    layers,
    layer_count: Object.keys(layers).length,
    all_input_files_read_only: true,
    raw_text_copied_into_manifest: false
  };
  const fiveLayerManifest = {
    ...fiveLayerManifestPayload,
    manifest_sha256: sha256(fiveLayerManifestPayload)
  };
  const decisionsDigest = buffers.human_decisions
    ? {
      file_name: basename(requested.human_decisions),
      byte_count: buffers.human_decisions.byteLength,
      sha256: sha256(buffers.human_decisions)
    }
    : null;
  const implementation = Object.fromEntries(
    await Promise.all([
      ['builder_cli', CLI_SOURCE_FILE],
      ['source_packet_library', LIBRARY_SOURCE_FILE],
      ['reviewed_csv_parser', CSV_READER_SOURCE_FILE]
    ].map(async ([role, filePath]) => {
      const raw = await readFile(filePath);
      return [role, {
        file_name: basename(filePath),
        byte_count: raw.byteLength,
        sha256: sha256(raw)
      }];
    }))
  );
  fiveLayerManifest.builder_implementation = implementation;
  fiveLayerManifest.human_decisions_input = decisionsDigest;
  fiveLayerManifest.manifest_sha256 = sha256({
    schema: fiveLayerManifest.schema,
    month_key: fiveLayerManifest.month_key,
    layers: fiveLayerManifest.layers,
    layer_count: fiveLayerManifest.layer_count,
    all_input_files_read_only: fiveLayerManifest.all_input_files_read_only,
    raw_text_copied_into_manifest: fiveLayerManifest.raw_text_copied_into_manifest,
    builder_implementation: implementation,
    human_decisions_input: decisionsDigest
  });
  const generationId = `driftstone-source-v1:${sha256({
    month_key: args.month,
    five_layer_manifest_sha256: fiveLayerManifest.manifest_sha256,
    human_decisions: decisionsDigest,
    generation_profile: args.canaryLimit > 0 ? 'representative_canary' : 'full_processed_packet',
    canary_limit: args.canaryLimit
  })}`;
  return {
    ...parsed,
    fiveLayerManifest,
    generationId,
    decisionsDigest
  };
}

function renderedFiles(built) {
  return {
    [OUTPUT_FILES.packet]: `${JSON.stringify(built.packet, null, 2)}\n`,
    [OUTPUT_FILES.candidates]: serializeJsonl(built.candidates),
    [OUTPUT_FILES.rawDisposition]: serializeJsonl(built.rawDisposition),
    [OUTPUT_FILES.preparedCoverage]: serializeJsonl(built.preparedCoverage),
    [OUTPUT_FILES.workbenchReviewLedger]: serializeJsonl(built.workbenchReviewLedger),
    [OUTPUT_FILES.humanReviewQueue]: serializeJsonl(built.humanReviewQueue),
    [OUTPUT_FILES.projections]: serializeJsonl(built.projections),
    [OUTPUT_FILES.rejected]: serializeJsonl(built.rejected)
  };
}

function generationManifest(generationId, files) {
  const payload = {
    schema: GENERATION_MANIFEST_SCHEMA,
    generation_id: generationId,
    output_files: Object.fromEntries(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fileName, text]) => [
          fileName,
          {
            byte_count: Buffer.byteLength(text),
            sha256: sha256(text),
            mode: '0600'
          }
        ])
    ),
    output_directory_mode: '0700',
    contains_private_memory_material: true,
    safe_to_commit_generated_output: false,
    writes_any_destination: false
  };
  return {
    ...payload,
    manifest_sha256: sha256(payload)
  };
}

function verifyGenerationManifest(manifest) {
  if (manifest?.schema !== GENERATION_MANIFEST_SCHEMA) return false;
  const { manifest_sha256: expected, ...payload } = manifest;
  return /^[0-9a-f]{64}$/u.test(safeText(expected)) && sha256(payload) === expected;
}

async function identityOrNull(path, role = 'path') {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new CliBoundaryError(
        `${role}_symlink_forbidden`,
        `${role} may not be a symbolic link.`,
        { path: basename(path) }
      );
    }
    return {
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      mode: metadata.mode,
      is_directory: metadata.isDirectory()
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.is_directory === right.is_directory
  );
}

async function requireDirectoryIdentity(path, role) {
  const identity = await identityOrNull(path, role);
  if (!identity || !identity.is_directory) {
    throw new CliBoundaryError(
      `${role}_not_directory`,
      `${role} must exist as a real directory.`,
      { path: basename(path) }
    );
  }
  return identity;
}

async function assertIdentity(path, expected, code) {
  const observed = await identityOrNull(path, 'owned_path');
  if (!sameIdentity(observed, expected)) {
    throw new CliBoundaryError(
      code,
      'Filesystem object identity changed during atomic publication.',
      {
        path: basename(path),
        expected,
        observed
      }
    );
  }
  return observed;
}

async function validateGenerationDirectory(directory, generationId) {
  const identityBefore = await requireDirectoryIdentity(directory, 'existing_output');
  const manifestFile = join(directory, 'portable_source_generation_manifest_v1.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  } catch (error) {
    throw new CliBoundaryError(
      'existing_generation_manifest_invalid',
      'Existing generation cannot be replaced without a valid manifest.',
      { cause: safeText(error?.message) }
    );
  }
  if (!verifyGenerationManifest(manifest)) {
    throw new CliBoundaryError(
      'existing_generation_manifest_invalid',
      'Existing generation manifest digest is invalid.'
    );
  }
  if (manifest.generation_id !== generationId) {
    throw new CliBoundaryError(
      'generation_mismatch',
      'Replacement is allowed only for the exact same input generation.',
      {
        existing_generation_id: manifest.generation_id,
        requested_generation_id: generationId
      }
    );
  }
  const requiredOutputNames = Object.values(OUTPUT_FILES).sort();
  const manifestOutputNames = Object.keys(manifest.output_files || {}).sort();
  if (stableJson(manifestOutputNames) !== stableJson(requiredOutputNames)) {
    throw new CliBoundaryError(
      'existing_generation_output_contract_mismatch',
      'Existing generation manifest does not contain the exact v1 output contract.',
      {
        expected_output_files: requiredOutputNames,
        observed_output_files: manifestOutputNames
      }
    );
  }
  const expectedNames = new Set([
    ...Object.keys(manifest.output_files || {}),
    basename(manifestFile)
  ]);
  const observedNames = new Set(await readdir(directory));
  const extras = [...observedNames].filter((name) => !expectedNames.has(name)).sort();
  const missing = [...expectedNames].filter((name) => !observedNames.has(name)).sort();
  if (extras.length || missing.length) {
    throw new CliBoundaryError(
      'existing_generation_file_set_mismatch',
      'Existing generation file set does not match its manifest.',
      { extras, missing }
    );
  }
  for (const [fileName, descriptor] of Object.entries(manifest.output_files || {})) {
    const raw = await readFile(join(directory, fileName));
    if (sha256(raw) !== descriptor.sha256 || raw.byteLength !== descriptor.byte_count) {
      throw new CliBoundaryError(
        'existing_generation_output_digest_mismatch',
        'Existing output no longer matches its manifest.',
        { output_file: fileName }
      );
    }
  }
  const identityAfter = await requireDirectoryIdentity(directory, 'existing_output');
  if (!sameIdentity(identityBefore, identityAfter)) {
    throw new CliBoundaryError(
      'output_identity_changed',
      'Existing output identity changed while it was being verified.'
    );
  }
  return identityAfter;
}

async function removeOwnedDirectory(directory, expectedIdentity, {
  requireGenerationId = ''
} = {}) {
  await assertIdentity(directory, expectedIdentity, 'owned_directory_identity_changed');
  if (requireGenerationId) {
    const verifiedIdentity = await validateGenerationDirectory(directory, requireGenerationId);
    if (!sameIdentity(verifiedIdentity, expectedIdentity)) {
      throw new CliBoundaryError(
        'owned_directory_identity_changed',
        'Owned directory changed before cleanup.'
      );
    }
  }
  await rm(directory, { recursive: true, force: false });
}

async function publish(args, generationId, files) {
  const parent = dirname(args.outDir);
  await mkdir(parent, { recursive: true });
  const parentIdentity = await requireDirectoryIdentity(parent, 'output_parent');
  const initialOutputIdentity = await identityOrNull(args.outDir, 'output_target');
  if (initialOutputIdentity && !initialOutputIdentity.is_directory) {
    throw new CliBoundaryError(
      'output_target_not_directory',
      'Output target exists but is not a directory.'
    );
  }
  if (initialOutputIdentity && !args.replace) {
    throw new CliBoundaryError(
      'output_exists',
      'Output directory exists. Refusing silent overwrite.',
      { out_dir: args.outDir }
    );
  }
  if (initialOutputIdentity) {
    await validateGenerationDirectory(args.outDir, generationId);
  }
  const temporary = await mkdtemp(join(parent, `.${basename(args.outDir)}.tmp-`));
  await chmod(temporary, 0o700);
  const temporaryIdentity = await requireDirectoryIdentity(temporary, 'temporary_output');
  const manifest = generationManifest(generationId, files);
  let backup = '';
  let backupIdentity = null;
  let published = false;
  try {
    for (const [fileName, text] of Object.entries(files)) {
      await writeFile(join(temporary, fileName), text, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
    }
    await writeFile(
      join(temporary, 'portable_source_generation_manifest_v1.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      }
    );
    if (
      process.env.NODE_ENV === 'test'
      && Number.isInteger(Number(process.env.DRIFTSTONE_SOURCE_PACKET_TEST_PUBLISH_PAUSE_MS))
      && Number(process.env.DRIFTSTONE_SOURCE_PACKET_TEST_PUBLISH_PAUSE_MS) > 0
    ) {
      await delay(Math.min(
        Number(process.env.DRIFTSTONE_SOURCE_PACKET_TEST_PUBLISH_PAUSE_MS),
        2000
      ));
    }
    await assertIdentity(parent, parentIdentity, 'output_parent_identity_changed');
    if (initialOutputIdentity) {
      backup = join(
        parent,
        `.${basename(args.outDir)}.verified-backup-${process.pid}-${randomUUID()}`
      );
      if (await identityOrNull(backup, 'backup_target')) {
        throw new CliBoundaryError(
          'backup_target_exists',
          'Unique backup target unexpectedly exists.'
        );
      }
      await rename(args.outDir, backup);
      backupIdentity = await requireDirectoryIdentity(backup, 'claimed_backup');
      try {
        const verifiedBackupIdentity = await validateGenerationDirectory(backup, generationId);
        if (!sameIdentity(backupIdentity, verifiedBackupIdentity)) {
          throw new CliBoundaryError(
            'claimed_backup_identity_changed',
            'Claimed replacement target changed during verification.'
          );
        }
      } catch (error) {
        if (!(await identityOrNull(args.outDir, 'output_target'))) {
          await assertIdentity(backup, backupIdentity, 'claimed_backup_identity_changed');
          await rename(backup, args.outDir);
          backup = '';
          backupIdentity = null;
        }
        throw error;
      }
    } else if (await identityOrNull(args.outDir, 'output_target')) {
      throw new CliBoundaryError(
        'output_appeared_during_publish',
        'Output target appeared while the new generation was being built.'
      );
    }
    await assertIdentity(parent, parentIdentity, 'output_parent_identity_changed');
    await assertIdentity(temporary, temporaryIdentity, 'temporary_output_identity_changed');
    if (await identityOrNull(args.outDir, 'output_target')) {
      throw new CliBoundaryError(
        'output_appeared_during_publish',
        'Output target appeared before the atomic publish rename.'
      );
    }
    await rename(temporary, args.outDir);
    published = true;
    await chmod(args.outDir, 0o700);
    await assertIdentity(args.outDir, temporaryIdentity, 'published_output_identity_changed');
    if (backup) {
      await removeOwnedDirectory(backup, backupIdentity, {
        requireGenerationId: generationId
      });
      backup = '';
      backupIdentity = null;
    }
  } catch (error) {
    const currentTemporaryIdentity = await identityOrNull(temporary, 'temporary_output');
    if (!published && sameIdentity(currentTemporaryIdentity, temporaryIdentity)) {
      await removeOwnedDirectory(temporary, temporaryIdentity);
    }
    if (backup && backupIdentity && !(await identityOrNull(args.outDir, 'output_target'))) {
      const currentBackupIdentity = await identityOrNull(backup, 'claimed_backup');
      if (sameIdentity(currentBackupIdentity, backupIdentity)) {
        await rename(backup, args.outDir);
        backup = '';
        backupIdentity = null;
      }
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await readInputs(args);
  const built = buildPortableSourcePacket({
    monthKey: args.month,
    fiveLayerManifest: loaded.fiveLayerManifest,
    rawBundles: loaded.rawBundles,
    preparedRows: loaded.preparedRows,
    workbenchRows: loaded.workbenchRows,
    sourceIndex: loaded.sourceIndex,
    reviewedRows: loaded.reviewed.rows,
    humanDecisions: loaded.humanDecisions,
    sampleLimit: args.canaryLimit
  });
  if (!verifyPortableSourcePacket(built.packet)) {
    throw new CliBoundaryError(
      'packet_integrity_invalid',
      'Built packet failed its own canonical digest check.'
    );
  }
  await publish(args, loaded.generationId, renderedFiles(built));
  console.log(JSON.stringify({
    ok: true,
    schema: built.packet.schema,
    month_key: built.packet.month_key,
    generation_id: loaded.generationId,
    generation_profile: built.packet.generation_profile,
    candidates: built.candidates.length,
    source_incomplete_candidates_full:
      built.packet.candidate_counts.source_incomplete_candidates_full,
    source_incomplete_candidates_emitted:
      built.packet.candidate_counts.source_incomplete_candidates_emitted,
    human_review_queue_items_emitted: built.humanReviewQueue.length,
    historical_case_candidates: 0,
    reruns_model_extraction: false,
    writes_home: false,
    writes_hippocove: false,
    writes_notion: false,
    out_dir: args.outDir
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: safeText(error?.code, error?.name || 'error'),
    error: safeText(error?.message, String(error || 'unknown error')),
    details: error?.details || {},
    reruns_model_extraction: false,
    writes_any_destination: false
  }, null, 2));
  process.exitCode = 1;
});
