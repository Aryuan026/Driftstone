#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPrivateReviewManifest,
  buildPrivateSourceReviewBundle,
  renderPrivateSourceReviewHtml
} from '../lib/driftstone-private-source-review-v1.mjs';
import {
  assertRealPrivateDirectory,
  publishPrivateDirectory
} from '../lib/driftstone-private-output-v1.mjs';
import {
  sha256,
  stableJson,
  verifyPortableSourcePacket
} from '../lib/driftstone-portable-source-packet-v1.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PACKET_FILE = 'portable_source_packet_v1.json';
const CANDIDATES_FILE = 'portable_source_candidates_v1.jsonl';
const GENERATION_MANIFEST_FILE = 'portable_source_generation_manifest_v1.json';
const GENERATION_MANIFEST_SCHEMA = 'driftstone_portable_source_generation_manifest_v1';
const EXPECTED_CANARY_COUNT = 36;
const EXPECTED_PACKET_COUNT = 3;

class ReviewCliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReviewCliError';
    this.code = code;
    this.details = details;
  }
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').replace(/\r/gu, '').trim();
  return text || fallback;
}

function parseArgs(argv = []) {
  const args = {
    packetDirs: [],
    outDir: '',
    expectedCount: EXPECTED_CANARY_COUNT
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = safeText(argv[index]);
    const next = argv[index + 1];
    if (argument === '--packet-dir' && next) {
      args.packetDirs.push(resolve(next));
      index += 1;
    } else if (argument === '--out' && next) {
      args.outDir = resolve(next);
      index += 1;
    } else if (argument === '--expected-count' && next) {
      args.expectedCount = Number(next);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      console.log([
        'Usage:',
        '  node scripts/debug/build_private_source_review_v1.mjs \\',
        '    --packet-dir PRIVATE_PACKET_DIR --packet-dir PRIVATE_PACKET_DIR \\',
        '    --packet-dir PRIVATE_PACKET_DIR --out PRIVATE_OUTPUT_DIR',
        '',
        'This review UI is local-only. It does not call a model or write any destination.'
      ].join('\n'));
      process.exit(0);
    } else if (argument.startsWith('-')) {
      throw new ReviewCliError('argument_unknown', `Unknown argument: ${argument}`);
    }
  }
  if (args.packetDirs.length !== EXPECTED_PACKET_COUNT) {
    throw new ReviewCliError(
      'packet_dir_count_invalid',
      `This canary review requires exactly ${EXPECTED_PACKET_COUNT} packet directories.`
    );
  }
  if (!args.outDir) {
    throw new ReviewCliError('output_required', '--out is required.');
  }
  if (!Number.isInteger(args.expectedCount) || args.expectedCount <= 0) {
    throw new ReviewCliError(
      'expected_count_invalid',
      '--expected-count must be a positive integer.'
    );
  }
  if (new Set(args.packetDirs).size !== args.packetDirs.length) {
    throw new ReviewCliError(
      'packet_dir_duplicate',
      'Packet directories must be distinct.'
    );
  }
  return args;
}

function parseJson(raw, role) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ReviewCliError(
      `${role}_json_invalid`,
      `${role} is not valid JSON.`,
      { error: error.message }
    );
  }
}

function parseJsonl(raw, role) {
  const rows = [];
  for (const [index, line] of raw.split(/\n/gu).entries()) {
    if (!line.trim()) continue;
    rows.push(parseJson(line, `${role}[${index}]`));
  }
  return rows;
}

async function assertPrivatePacketDirectory(directory) {
  try {
    return await assertRealPrivateDirectory(directory, 'packet_dir');
  } catch (error) {
    throw new ReviewCliError(
      error.code || 'packet_dir_invalid',
      error.message,
      { packet_dir: basename(directory) }
    );
  }
}

async function loadPacketDirectory(directory) {
  const sourceDir = await assertPrivatePacketDirectory(directory);
  const packetPath = resolve(sourceDir, PACKET_FILE);
  const candidatesPath = resolve(sourceDir, CANDIDATES_FILE);
  const manifestPath = resolve(sourceDir, GENERATION_MANIFEST_FILE);
  const [packetBytes, candidateBytes, manifestBytes] = await Promise.all([
    readFile(packetPath),
    readFile(candidatesPath),
    readFile(manifestPath)
  ]);
  const packet = parseJson(packetBytes.toString('utf8'), 'source_packet');
  const candidates = parseJsonl(candidateBytes.toString('utf8'), 'source_candidates');
  const manifest = parseJson(manifestBytes.toString('utf8'), 'source_generation_manifest');
  if (manifest.schema !== GENERATION_MANIFEST_SCHEMA) {
    throw new ReviewCliError(
      'source_generation_manifest_schema_invalid',
      `Source generation manifest must use ${GENERATION_MANIFEST_SCHEMA}.`,
      { packet_dir: basename(sourceDir) }
    );
  }
  if (!verifyPortableSourcePacket(packet)) {
    throw new ReviewCliError(
      'source_packet_integrity_invalid',
      'Source packet integrity digest is invalid.',
      { packet_dir: basename(sourceDir) }
    );
  }
  const {
    manifest_sha256: observedManifestDigest,
    ...manifestPayload
  } = manifest;
  if (sha256(manifestPayload) !== observedManifestDigest) {
    throw new ReviewCliError(
      'source_generation_manifest_integrity_invalid',
      'Source generation manifest digest is invalid.',
      { packet_dir: basename(sourceDir) }
    );
  }
  const packetDescriptor = manifest.output_files?.[PACKET_FILE];
  const candidateDescriptor = manifest.output_files?.[CANDIDATES_FILE];
  if (
    !packetDescriptor
    || packetDescriptor.sha256 !== sha256(packetBytes)
    || packetDescriptor.byte_count !== packetBytes.byteLength
  ) {
    throw new ReviewCliError(
      'source_packet_digest_invalid',
      'Source packet bytes do not match the exact generation manifest.',
      { packet_dir: basename(sourceDir) }
    );
  }
  if (
    !candidateDescriptor
    || candidateDescriptor.sha256 !== sha256(candidateBytes)
    || candidateDescriptor.byte_count !== candidateBytes.byteLength
  ) {
    throw new ReviewCliError(
      'source_candidates_digest_invalid',
      'Source candidate bytes do not match the generation manifest.',
      { packet_dir: basename(sourceDir) }
    );
  }
  if (packet.candidate_counts?.emitted_candidates !== candidates.length) {
    throw new ReviewCliError(
      'source_candidate_count_mismatch',
      'Source packet emitted count does not match candidate JSONL.',
      { month_key: packet.month_key }
    );
  }
  if (candidates.some((candidate) => candidate.month_key !== packet.month_key)) {
    throw new ReviewCliError(
      'source_candidate_month_mismatch',
      'Candidate month does not match its packet month.',
      { month_key: packet.month_key }
    );
  }
  return {
    packet,
    candidates,
    sourceDescriptor: {
      month_key: packet.month_key,
      generation_id: safeText(manifest.generation_id),
      packet_sha256: sha256(packetBytes),
      candidates_sha256: sha256(candidateBytes),
      candidate_count: candidates.length
    },
    sourceFile: {
      month_key: packet.month_key,
      packet_file: PACKET_FILE,
      packet_sha256: sha256(packetBytes),
      candidates_file: CANDIDATES_FILE,
      candidates_sha256: sha256(candidateBytes),
      generation_manifest_file: GENERATION_MANIFEST_FILE,
      generation_manifest_sha256: sha256(manifestBytes)
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await Promise.all(args.packetDirs.map(loadPacketDirectory));
  const months = loaded.map(({ packet }) => packet.month_key);
  if (new Set(months).size !== months.length) {
    throw new ReviewCliError(
      'source_packet_month_duplicate',
      'The review bundle requires distinct packet months.'
    );
  }
  const candidates = loaded.flatMap(({ candidates: rows }) => rows);
  if (candidates.length !== args.expectedCount) {
    throw new ReviewCliError(
      'review_candidate_count_mismatch',
      'Private review candidate count differs from the explicit expected count.',
      { expected: args.expectedCount, observed: candidates.length }
    );
  }
  const bundle = buildPrivateSourceReviewBundle({
    packetSources: loaded.map(({ sourceDescriptor }) => sourceDescriptor),
    candidates
  });
  const html = renderPrivateSourceReviewHtml(bundle);
  const bundleJson = `${JSON.stringify(bundle, null, 2)}\n`;
  const manifest = buildPrivateReviewManifest({
    bundle,
    html,
    bundleJson,
    sourceFiles: loaded.map(({ sourceFile }) => sourceFile)
      .sort((left, right) => left.month_key.localeCompare(right.month_key))
  });
  const publishedDir = await publishPrivateDirectory({
    outDir: args.outDir,
    repoRoot: REPO_ROOT,
    files: {
      'index.html': html,
      'private_source_review_bundle_v1.json': bundleJson,
      'private_source_review_manifest_v1.json': `${JSON.stringify(manifest, null, 2)}\n`
    }
  });
  console.log(JSON.stringify({
    ok: true,
    schema: bundle.schema,
    bundle_id: bundle.bundle_id,
    months: Object.keys(bundle.candidate_counts_by_month),
    candidates: bundle.candidate_count,
    source_bound: bundle.candidate_counts_by_source_state.source_bound,
    source_incomplete: bundle.candidate_counts_by_source_state.source_incomplete,
    decision_schema: bundle.decisions_schema,
    output_directory_mode: '0700',
    output_file_mode: '0600',
    model_called: false,
    writes_home: false,
    writes_hippocove: false,
    writes_notion: false,
    writes_cloud: false,
    out_dir: publishedDir
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || 'private_review_build_failed',
    message: error.message,
    details: error.details || {},
    model_called: false,
    writes_any_destination: false
  }, null, 2));
  process.exitCode = 1;
});
