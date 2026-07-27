#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { spawn } from 'child_process';

const DEFAULT_SOURCE_DIR = '/Users/mac/Documents/Codex/0-github/202604-Driftstone/output/notion_staging/ajimem_2025-03';
const DEFAULT_DROPBOX = '/Users/mac/Documents/Ajimem';
const DEFAULT_WORKBENCH = '/Users/mac/Documents/Codex/0-github/202604-Driftstone/data/local_fixtures/stage_dropbox/01_workbench/memory-export-core_20250301_20250331_26p-workbench.json';
const DEFAULT_SOURCE_INDEX = '/Users/mac/Documents/Codex/0-github/202604-Driftstone/data/local_fixtures/stage_dropbox/01_source_index/memory-export-core_20250301_20250331_26p-source-index.json';

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function parseArgs(argv = []) {
  const args = {
    sourceDir: safeText(process.env.DRIFTSTONE_HOME_REVIEW_SOURCE_DIR, DEFAULT_SOURCE_DIR),
    dropboxDir: safeText(process.env.HIPPOCOVE_STAGE_DROPBOX, DEFAULT_DROPBOX),
    workbenchFile: DEFAULT_WORKBENCH,
    sourceIndexFile: DEFAULT_SOURCE_INDEX,
    outDir: '/tmp/driftstone_home_lineage_regression'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--source-dir' && next) {
      args.sourceDir = next;
      index += 1;
    } else if (arg === '--dropbox' && next) {
      args.dropboxDir = next;
      index += 1;
    } else if (arg === '--workbench-file' && next) {
      args.workbenchFile = next;
      index += 1;
    } else if (arg === '--source-index-file' && next) {
      args.sourceIndexFile = next;
      index += 1;
    } else if (arg === '--out' && next) {
      args.outDir = next;
      index += 1;
    }
  }
  return args;
}

function runNode(args, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${args.join(' ')}\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertNoFinalWarmBody(row) {
  assert.ok(row.warm_rewrite_candidate, 'missing warm_rewrite_candidate');
  assert.equal(Object.prototype.hasOwnProperty.call(row.warm_rewrite_candidate, 'body_markdown'), false);
  assert.equal(row.warm_rewrite_candidate.final_body_markdown_generated, false);
  assert.equal(row.warm_rewrite_candidate.persona_prompt_read_by_driftstone, false);
  assert.equal(row.warm_rewrite_candidate.requires_home_runtime_persona, true);
  assert.ok(row.warm_rewrite_candidate.source_material, 'missing source_material split');
  assert.ok(row.warm_rewrite_candidate.candidate_material, 'missing candidate_material split');
  assert.equal(row.warm_rewrite_candidate.candidate_material.living_fragment_is_source_quote, false);
  assert.equal(row.warm_rewrite_candidate.candidate_material.candidate_claim_is_source_quote, false);
}

function lineageKeyFor(row = {}) {
  return JSON.stringify({
    review_row_id: row.review_row_id,
    message_id: row.message_id,
    message_id_kind: row.message_id_kind,
    raw_message_id: row.raw_message_id,
    exchange_id: row.exchange_id,
    exchange_identity_kind: row.exchange_identity_kind,
    conversation_id: row.conversation_id,
    conversation_identity_kind: row.conversation_identity_kind,
    source_local_conversation_id_claim: row.source_local_conversation_id_claim,
    source_window_scope_id: row.source_window_scope_id,
    episode_id: row.episode_id,
    episode_identity_kind: row.episode_identity_kind,
    source_local_episode_id_claim: row.source_local_episode_id_claim,
    scope_id: row.scope_id,
    scope_identity_kind: row.scope_identity_kind,
    scope_source_field: row.scope_source_field
  });
}

async function assertMarchLineage(args) {
  await rm(args.outDir, { recursive: true, force: true });
  await runNode([
    'scripts/debug/build_home_import_review_rows.mjs',
    '--source-dir', args.sourceDir,
    '--month', '2025-03',
    '--out', args.outDir,
    '--dropbox', args.dropboxDir,
    '--workbench-file', args.workbenchFile,
    '--source-index-file', args.sourceIndexFile
  ]);
  const rows = await readJsonl(join(args.outDir, 'home_import_review_rows.jsonl'));
  const candidates = await readJsonl(join(args.outDir, 'home_import_candidates.jsonl'));
  assert.equal(rows.length, 308);
  assert.equal(candidates.length, 308);
  assert.equal(rows.filter((row) => row.reliable_home_source_span).length, 195);
  assert.equal(rows.filter((row) => row.source_incomplete).length, 113);
  assert.equal(rows.filter((row) => row.home_lane === 'mixed_split_required').length, 164);
  assert.equal(rows.filter((row) => row.import_policy_state === 'candidate_ready').length, 44);
  assert.equal(rows.filter((row) => row.import_policy_state === 'direct_write_allowed').length, 0);
  assert.equal(rows.every((row) => row.lineage && row.source_authority && row.warm_rewrite_candidate), true);
  assert.equal(rows.every((row) => row.message_id && row.exchange_id && row.scope_id), true);
  assert.equal(rows.every((row) => row.raw_message_id), true);
  assert.equal(rows.every((row) => row.message_id.startsWith('driftstone:')), true);
  assert.equal(rows.every((row) => row.exchange_id.startsWith('driftstone:')), true);
  assert.equal(rows.every((row) => row.message_id !== row.raw_message_id), true);
  assert.equal(rows.filter((row) => row.source_authority.source_quote_available).length, 195);
  assert.equal(rows.filter((row) => row.source_authority.answer_evidence_candidate).length, 195);
  assert.equal(rows.filter((row) => row.source_authority.can_be_answer_evidence).length, 0);
  assert.equal(rows.every((row) => row.source_authority.exact_bounded_claim_conservation === false), true);
  assert.equal(rows.every((row) => row.source_authority.canonical_action_receipt === null), true);
  assert.equal(rows.every((row) => row.canonical_action_receipt === null), true);
  assert.equal(rows.every((row) => row.action_receipt_claim === null), true);
  assert.equal(rows.every((row) => row.conversation_id === ''), true);
  assert.equal(rows.every((row) => row.conversation_identity_kind === 'unknown'), true);
  assert.equal(rows.every((row) => row.lineage.conversation_identity_kind === 'unknown'), true);
  assert.equal(rows.every((row) => row.source_window_scope_id), true);
  assert.equal(rows.every((row) => row.lineage.source_window_scope_id === row.source_window_scope_id), true);
  assert.equal(rows.every((row) => row.scope_identity_kind === 'driftstone_source_scope'), true);
  rows.forEach(assertNoFinalWarmBody);
  candidates.forEach(assertNoFinalWarmBody);

  const secondOutDir = `${args.outDir}_second`;
  await rm(secondOutDir, { recursive: true, force: true });
  await runNode([
    'scripts/debug/build_home_import_review_rows.mjs',
    '--source-dir', args.sourceDir,
    '--month', '2025-03',
    '--out', secondOutDir,
    '--dropbox', args.dropboxDir,
    '--workbench-file', args.workbenchFile,
    '--source-index-file', args.sourceIndexFile
  ]);
  const secondRows = await readJsonl(join(secondOutDir, 'home_import_review_rows.jsonl'));
  assert.deepEqual(
    rows.map(lineageKeyFor).sort(),
    secondRows.map(lineageKeyFor).sort()
  );
}

async function writeSyntheticReceiptSource(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const node = {
    schema: 'synthetic',
    node_id: 'node.synthetic-receipt',
    source_entry_id: 'synthetic-record-1',
    source_system: 'driftstone',
    source_bundle_role: 'old_history_cold_archive',
    node_kind: 'memory_node',
    node_path: 'Synthetic / Receipt',
    anchor_name: 'Synthetic receipt',
    title: 'Synthetic receipt',
    month_key: '2025-03',
    episode_key: 'episode.synthetic',
    scope_id: 'node.scope.synthetic',
    living_fragment: 'Synthetic event material for regression.',
    feeling_as_fact: 'Synthetic feeling for regression.',
    source_trace_ids: ['trace.synthetic-receipt'],
    source_span_ids: ['span.synthetic-receipt'],
    source_refs: ['window_20250301_msg_1-2'],
    quality: { review_status: 'ready_for_cold_archive' },
    canonical_action_receipt: {
      namespace: 'driftstone.test',
      receipt_id: 'receipt-1',
      action_id: 'action-1',
      action_type: 'test_action',
      actor: 'assistant',
      source_trace_id: 'trace.synthetic-receipt',
      source_span_id: 'span.synthetic-receipt',
      source_ref: 'window_20250301_msg_1-2',
      message_id: 'window_20250301_msg_1-2'
    }
  };
  const candidate = {
    candidate_id: 'candidate.synthetic-receipt',
    source_entry_id: 'synthetic-record-1',
    month_key: '2025-03',
    title: 'Synthetic receipt',
    summary: 'Synthetic summary.'
  };
  const trace = {
    trace_id: 'trace.synthetic-receipt',
    canonical_source_span_id: 'span.synthetic-receipt',
    source_window_id: 'window.synthetic',
    source_window_title: 'Synthetic window',
    source_msg_range: '1-2',
    conversation_id: 'trace.fake-provider-conversation',
    episode_id: 'trace.fake-provider-episode',
    excerpt_text: 'Synthetic quote.',
    source_refs: ['window_20250301_msg_1-2'],
    linked_memory_entry_ids: ['synthetic-record-1']
  };
  const span = {
    source_span_id: 'span.synthetic-receipt',
    source_window_id: 'window.synthetic',
    source_window_title: 'Synthetic window',
    source_msg_range: '1-2',
    conversation_id: 'span.fake-provider-conversation',
    episode_id: 'span.fake-provider-episode',
    source_refs: ['window_20250301_msg_1-2'],
    linked_memory_entry_ids: ['synthetic-record-1']
  };
  await writeFile(join(dir, '23_asheriehome_memory_nodes.jsonl'), `${JSON.stringify(node)}\n`, 'utf8');
  await writeFile(join(dir, '12_normalized_memory_candidates.jsonl'), `${JSON.stringify(candidate)}\n`, 'utf8');
  await writeFile(join(dir, '24_source_trace_index.jsonl'), `${JSON.stringify(trace)}\n`, 'utf8');
  await writeFile(join(dir, '16_normalized_source_span_candidates.jsonl'), `${JSON.stringify(span)}\n`, 'utf8');
}

async function assertForgedCanonicalReceiptDoesNotVerify(args) {
  const sourceDir = '/tmp/driftstone_home_lineage_synthetic_source';
  const outDir = '/tmp/driftstone_home_lineage_synthetic_out';
  await writeSyntheticReceiptSource(sourceDir);
  await rm(outDir, { recursive: true, force: true });
  await runNode([
    'scripts/debug/build_home_import_review_rows.mjs',
    '--source-dir', sourceDir,
    '--month', '2025-03',
    '--out', outDir,
    '--dropbox', args.dropboxDir,
    '--workbench-file', args.workbenchFile,
    '--source-index-file', args.sourceIndexFile
  ]);
  const [row] = await readJsonl(join(outDir, 'home_import_review_rows.jsonl'));
  assert.equal(row.canonical_action_receipt, null);
  assert.ok(row.action_receipt_claim);
  assert.equal(row.action_receipt_claim.claim_id, 'driftstone.test:receipt-1');
  assert.equal(row.action_receipt_claim.verification_state, 'unverified_action_outcome');
  assert.equal(row.action_receipt_claim.canonical_authority_granted, false);
  assert.equal(row.role, 'action_receipt_claim');
  assert.equal(row.role_source, 'unverified_action_receipt_claim');
  assert.equal(row.topology_authority, 'source_backed_narration_noncanonical');
  assert.equal(row.source_authority.authority_kind, 'action_receipt_claim');
  assert.equal(row.source_authority.action_receipt_claim.claim_id, 'driftstone.test:receipt-1');
  assert.equal(row.source_authority.canonical_action_receipt, null);
  assert.equal(row.source_authority.source_quote_available, true);
  assert.equal(row.source_authority.answer_evidence_candidate, true);
  assert.equal(row.source_authority.can_be_answer_evidence, false);
  assert.equal(row.source_authority.can_be_answer_evidence_reason, 'source_quote_available_but_claim_conservation_unverified');
  assert.equal(row.conversation_id, '');
  assert.equal(row.conversation_identity_kind, 'unknown');
  assert.equal(row.source_local_conversation_id_claim, 'trace.fake-provider-conversation');
  assert.equal(row.source_local_conversation_id_claim_kind, 'source_local_unverified_claim');
  assert.equal(row.episode_id, '');
  assert.equal(row.episode_identity_kind, 'driftstone_episode_key');
  assert.equal(row.source_local_episode_id_claim, 'trace.fake-provider-episode');
  assert.equal(row.source_local_episode_id_claim_kind, 'source_local_unverified_claim');
  assert.equal(row.scope_id, 'node.scope.synthetic');
  assert.equal(row.scope_identity_kind, 'source_local_node_scope_claim');
  assert.equal(row.scope_source_field, 'node.scope_id');
  assert.equal(row.raw_message_id, 'window_20250301_msg_1-2');
  assert.equal(row.message_id.startsWith('driftstone:'), true);
  assert.notEqual(row.message_id, row.raw_message_id);
  assert.ok(row.source_window_scope_id);
  assertNoFinalWarmBody(row);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assert.ok(existsSync(args.sourceDir), `source dir not found: ${args.sourceDir}`);
  await assertMarchLineage(args);
  await assertForgedCanonicalReceiptDoesNotVerify(args);
  console.log(JSON.stringify({
    ok: true,
    checked: [
      'march_lineage_packets',
      'warm_rewrite_candidate_no_body_markdown',
      'no_persona_read_flag',
      'bounded_quote_not_auto_answer_evidence',
      'forged_canonical_receipt_negative',
      'unknown_conversation_identity_regression',
      'source_local_conversation_episode_not_provider_owned',
      'lineage_ids_stable_across_two_runs'
    ]
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: safeText(error?.message, String(error || 'unknown error'))
  }, null, 2));
  process.exitCode = 1;
});
