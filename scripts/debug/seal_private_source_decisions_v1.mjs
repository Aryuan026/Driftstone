#!/usr/bin/env node
import { lstat, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRIVATE_SOURCE_REVIEW_MANIFEST_SCHEMA,
  PRIVATE_SOURCE_REVIEW_SCHEMA,
  validateDecisionDocumentAgainstBundle,
  validateReviewCandidate
} from '../lib/driftstone-private-source-review-v1.mjs';
import {
  assertRealPrivateDirectory,
  publishPrivateDirectory
} from '../lib/driftstone-private-output-v1.mjs';
import { sha256 } from '../lib/driftstone-portable-source-packet-v1.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REVIEW_MANIFEST_FILE = 'private_source_review_manifest_v1.json';
const REVIEW_BUNDLE_FILE = 'private_source_review_bundle_v1.json';
const SEAL_MANIFEST_SCHEMA = 'driftstone_private_source_decision_seal_v1';

class DecisionSealError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DecisionSealError';
    this.code = code;
    this.details = details;
  }
}

function safeText(value) {
  return String(value ?? '').replace(/\r/gu, '').trim();
}

function parseArgs(argv = []) {
  const args = {
    reviewDir: '',
    decisionFiles: [],
    outDir: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = safeText(argv[index]);
    const next = argv[index + 1];
    if (argument === '--review-dir' && next) {
      args.reviewDir = resolve(next);
      index += 1;
    } else if (argument === '--decision-file' && next) {
      args.decisionFiles.push(resolve(next));
      index += 1;
    } else if (argument === '--out' && next) {
      args.outDir = resolve(next);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      console.log([
        'Usage:',
        '  node scripts/debug/seal_private_source_decisions_v1.mjs \\',
        '    --review-dir PRIVATE_REVIEW_DIR \\',
        '    --decision-file BROWSER_DOWNLOAD.json [--decision-file ...] \\',
        '    --out PRIVATE_SEALED_DIR',
        '',
        'The output is atomically published outside Git as 0700/0600.'
      ].join('\n'));
      process.exit(0);
    } else if (argument.startsWith('-')) {
      throw new DecisionSealError('argument_unknown', `Unknown argument: ${argument}`);
    }
  }
  if (!args.reviewDir || !args.decisionFiles.length || !args.outDir) {
    throw new DecisionSealError(
      'argument_missing',
      '--review-dir, at least one --decision-file, and --out are required.'
    );
  }
  if (new Set(args.decisionFiles).size !== args.decisionFiles.length) {
    throw new DecisionSealError(
      'decision_file_duplicate',
      'Decision input files must be distinct.'
    );
  }
  return args;
}

function parseJson(bytes, role) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new DecisionSealError(
      `${role}_json_invalid`,
      `${role} is not valid JSON.`,
      { error: error.message }
    );
  }
}

async function loadReviewBundle(reviewDir) {
  const directory = await assertRealPrivateDirectory(reviewDir, 'review_dir');
  const [manifestBytes, bundleBytes] = await Promise.all([
    readFile(join(directory, REVIEW_MANIFEST_FILE)),
    readFile(join(directory, REVIEW_BUNDLE_FILE))
  ]);
  const manifest = parseJson(manifestBytes, 'review_manifest');
  const bundle = parseJson(bundleBytes, 'review_bundle');
  if (manifest.schema !== PRIVATE_SOURCE_REVIEW_MANIFEST_SCHEMA) {
    throw new DecisionSealError(
      'review_manifest_schema_invalid',
      `Review manifest must use ${PRIVATE_SOURCE_REVIEW_MANIFEST_SCHEMA}.`
    );
  }
  const { manifest_sha256: observedManifestDigest, ...manifestPayload } = manifest;
  if (sha256(manifestPayload) !== observedManifestDigest) {
    throw new DecisionSealError(
      'review_manifest_integrity_invalid',
      'Review manifest digest is invalid.'
    );
  }
  if (bundle.schema !== PRIVATE_SOURCE_REVIEW_SCHEMA) {
    throw new DecisionSealError(
      'review_bundle_schema_invalid',
      `Review bundle must use ${PRIVATE_SOURCE_REVIEW_SCHEMA}.`
    );
  }
  const descriptor = manifest.output_files?.[REVIEW_BUNDLE_FILE];
  if (
    !descriptor
    || descriptor.sha256 !== sha256(bundleBytes)
    || descriptor.byte_count !== bundleBytes.byteLength
    || manifest.bundle_id !== bundle.bundle_id
    || manifest.candidates_sha256 !== bundle.candidates_sha256
  ) {
    throw new DecisionSealError(
      'review_bundle_manifest_mismatch',
      'Review bundle bytes and candidate identity must match the review manifest.'
    );
  }
  for (const candidate of bundle.candidates || []) validateReviewCandidate(candidate);
  if (
    bundle.candidate_count !== bundle.candidates.length
    || sha256(bundle.candidates) !== bundle.candidates_sha256
  ) {
    throw new DecisionSealError(
      'review_bundle_candidate_conservation_failed',
      'Review bundle candidate count or digest is invalid.'
    );
  }
  return {
    bundle,
    review_manifest_sha256: sha256(manifestBytes),
    review_bundle_sha256: sha256(bundleBytes)
  };
}

async function loadDecisionInput(filePath, bundle) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new DecisionSealError(
      'decision_input_invalid',
      'Decision input must be a regular file, not a symlink.',
      { file_name: basename(filePath) }
    );
  }
  const bytes = await readFile(filePath);
  const document = parseJson(bytes, 'decision_input');
  let canonical;
  try {
    canonical = validateDecisionDocumentAgainstBundle(bundle, document);
  } catch (error) {
    throw new DecisionSealError(
      error.code || 'decision_validation_failed',
      error.message,
      error.details || {}
    );
  }
  return {
    month_key: canonical.month_key,
    canonical,
    input: {
      file_name: basename(filePath),
      byte_count: bytes.byteLength,
      sha256: sha256(bytes),
      observed_mode: (await stat(filePath)).mode & 0o777
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedReview = await loadReviewBundle(args.reviewDir);
  const decisions = await Promise.all(
    args.decisionFiles.map((filePath) => loadDecisionInput(filePath, loadedReview.bundle))
  );
  const months = decisions.map((item) => item.month_key);
  if (new Set(months).size !== months.length) {
    throw new DecisionSealError(
      'decision_month_duplicate',
      'Only one decision document per month may be sealed.'
    );
  }
  const files = {};
  const outputDescriptors = {};
  for (const item of decisions.sort((left, right) => (
    left.month_key.localeCompare(right.month_key)
  ))) {
    const fileName = `driftstone-portable-source-decisions-${item.month_key}.sealed.json`;
    const content = `${JSON.stringify(item.canonical, null, 2)}\n`;
    files[fileName] = content;
    outputDescriptors[fileName] = {
      byte_count: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(Buffer.from(content, 'utf8')),
      mode: '0600',
      month_key: item.month_key
    };
  }
  const sealPayload = {
    schema: SEAL_MANIFEST_SCHEMA,
    review_bundle_id: loadedReview.bundle.bundle_id,
    review_manifest_sha256: loadedReview.review_manifest_sha256,
    review_bundle_sha256: loadedReview.review_bundle_sha256,
    input_decisions: decisions
      .map((item) => ({ month_key: item.month_key, ...item.input }))
      .sort((left, right) => left.month_key.localeCompare(right.month_key)),
    sealed_outputs: outputDescriptors,
    output_directory_mode: '0700',
    output_file_mode: '0600',
    safe_to_commit: false,
    writes_home: false,
    writes_hippocove: false,
    writes_notion: false,
    writes_cloud: false
  };
  const sealManifest = {
    ...sealPayload,
    manifest_sha256: sha256(sealPayload)
  };
  files['private_source_decision_seal_manifest_v1.json'] =
    `${JSON.stringify(sealManifest, null, 2)}\n`;
  const publishedDir = await publishPrivateDirectory({
    outDir: args.outDir,
    repoRoot: REPO_ROOT,
    files
  });
  console.log(JSON.stringify({
    ok: true,
    schema: SEAL_MANIFEST_SCHEMA,
    review_bundle_id: loadedReview.bundle.bundle_id,
    sealed_months: months.sort(),
    sealed_decision_rows: decisions.reduce(
      (sum, item) => sum + item.canonical.decisions.length,
      0
    ),
    output_directory_mode: '0700',
    output_file_mode: '0600',
    writes_any_destination: false,
    out_dir: publishedDir
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || 'private_decision_seal_failed',
    message: error.message,
    details: error.details || {},
    writes_any_destination: false
  }, null, 2));
  process.exitCode = 1;
});
