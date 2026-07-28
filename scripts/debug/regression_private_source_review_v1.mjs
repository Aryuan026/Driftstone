#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PRIVATE_SOURCE_REVIEW_MANIFEST_SCHEMA,
  PRIVATE_SOURCE_REVIEW_SCHEMA,
  buildDecisionDocument,
  buildPrivateReviewManifest,
  buildPrivateSourceReviewBundle,
  renderPrivateSourceReviewHtml
} from '../lib/driftstone-private-source-review-v1.mjs';
import {
  HUMAN_DECISIONS_SCHEMA,
  PORTABLE_SOURCE_CANDIDATE_SCHEMA,
  PORTABLE_SOURCE_PACKET_SCHEMA,
  sha256,
  stableJson
} from '../lib/driftstone-portable-source-packet-v1.mjs';
import {
  DRIFTSTONE_HOME_WARM_INTAKE_SCHEMA,
  buildHomeWarmIntake
} from '../lib/driftstone-home-warm-intake-v1.mjs';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const cli = join(repoRoot, 'scripts/debug/build_private_source_review_v1.mjs');
const sealCli = join(repoRoot, 'scripts/debug/seal_private_source_decisions_v1.mjs');
let checks = 0;

function equal(actual, expected, message = '') {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

function ok(value, message = '') {
  assert.ok(value, message);
  checks += 1;
}

function candidate(month, index, sourceState) {
  const candidateId = `dspc_${sha256(`${month}:${index}`).slice(0, 32)}`;
  const recordId = `record-${month}-${index}`;
  const payload = {
    schema: PORTABLE_SOURCE_CANDIDATE_SCHEMA,
    candidate_id: candidateId,
    month_key: month,
    candidate_lane: index % 2 ? 'fact' : 'persona',
    historical_case_extraction_status: 'not_applicable_by_owner_decision',
    upstream: {
      workbench_row: {
        record_id: recordId,
        title: `Synthetic ${month} ${index}`,
        text: index === 1
          ? 'private </script><script>throw new Error("xss")</script> text'
          : `Private candidate body ${month} ${index}`,
        source_msg_start: index,
        source_msg_end: index,
        source_bundle_id: `bundle-${month}`,
        source_window_id: `window-${month}`,
        layer: index % 2 ? 'sql' : 'persona'
      },
      workbench_row_index: index,
      reviewed_rows: [{
        record_id: recordId,
        title: `Reviewed ${index}`,
        text: `Reviewed body ${index}`,
        family_id: `family-${month}-${Math.floor(index / 2)}`,
        family_kind: 'persona_sql_family',
        source_msg_start: index,
        source_msg_end: index
      }],
      reviewed_row_refs: [],
      source_index_anchors: [{
        record_id: recordId,
        source_msg_start: index + 1,
        source_msg_end: index + 1,
        chunk_msg_start: index,
        chunk_msg_end: index
      }],
      source_index_anchor_refs: [],
      prepared_windows: [{
        chunk_id: `chunk-${month}-${index}`,
        name: `Prepared ${index}`,
        source_msg_start: Math.max(0, index - 2),
        source_msg_end: index,
        text_chars: 42,
        text_sha256: sha256(`prepared-${month}-${index}`)
      }]
    },
    canonical_labels: {
      tags: ['#完整标签', `#month/${month}`, '#third'],
      tag_sources: [],
      fact_keys: ['fact_one', 'fact_two', 'fact_three'],
      fact_key_sources: [],
      tags_are_complete_upstream_projection: true,
      fact_keys_are_complete_upstream_projection: true,
      canonical_fact_key_limit: null,
      canonical_tag_limit: null
    },
    source_evidence: {
      state: sourceState,
      incomplete_reasons: sourceState === 'source_incomplete'
        ? ['source_anchor[0]_source_range_unknown']
        : [],
      raw_span_state: sourceState === 'source_bound'
        ? 'source_span_resolved'
        : 'source_range_unresolved',
      raw_message_refs: sourceState === 'source_bound' ? [`rawmsg_${'a'.repeat(32)}`] : [],
      raw_message_count: sourceState === 'source_bound' ? 1 : 0,
      raw_message_content_sha256: sourceState === 'source_bound' ? [sha256('raw')] : [],
      source_span_sha256: sourceState === 'source_bound' ? sha256(['raw']) : ''
    },
    human_review: {
      visible_choice_required: sourceState === 'source_incomplete',
      state: sourceState === 'source_incomplete'
        ? 'awaiting_human_choice'
        : 'upstream_reviewed_pre_admission_pending',
      allowed_approval_authorities: ['human_attested', 'legacy_import'],
      eligible_for_hippocove_pre_admission: sourceState === 'source_bound'
    },
    graph_hints: {
      schema: 'driftstone_hippocove_pre_admission_graph_hints_v1',
      candidate_id: candidateId,
      source_record_id: recordId,
      candidate_only: true,
      hippocove_pre_admission_required: true,
      canonical_edges_created: 0,
      canonical_episodes_created: 0,
      canonical_authority_granted: false,
      canonical_receipts_created: 0,
      trace: {
        raw_span_state: sourceState === 'source_bound'
          ? 'source_span_resolved'
          : 'source_range_unresolved',
        raw_message_refs: sourceState === 'source_bound' ? [`rawmsg_${'a'.repeat(32)}`] : [],
        raw_span_sha256: sourceState === 'source_bound' ? sha256(['raw']) : '',
        raw_message_count: sourceState === 'source_bound' ? 1 : 0,
        source_refs: []
      },
      span: {
        candidate_window_local_msg_ranges: [`${index}-${index}`],
        reviewed_window_local_msg_ranges: [`${index}-${index}`],
        prepared_context_window_local_msg_ranges: [`${Math.max(0, index - 2)}-${index}`],
        anchor_source_ref_msg_ranges: index ? [`${index + 1}-${index + 1}`] : [],
        anchor_window_local_chunk_ranges: [`${index}-${index}`],
        source_bundle_ids: [`bundle-${month}`],
        source_window_ids: [`window-${month}`]
      },
      authority: {
        source_state: sourceState,
        direct_canonical_authority: false
      },
      review: {},
      structured_candidates: {
        entities: [],
        topic_labels: [],
        tags: ['#完整标签', `#month/${month}`, '#third'],
        fact_keys: ['fact_one', 'fact_two', 'fact_three']
      }
    },
    safety: {
      runtime_effect: 'none',
      writes_home: false,
      writes_hippocove: false,
      writes_notion: false,
      creates_canonical_edges: false,
      creates_canonical_receipts: false
    }
  };
  return {
    ...payload,
    integrity: {
      canonical_payload_sha256: sha256(payload)
    }
  };
}

const months = ['2025-03', '2025-08', '2025-11'];
const candidates = months.flatMap((month) => [
  candidate(month, 0, 'source_incomplete'),
  candidate(month, 1, 'source_bound')
]);
const packetSources = months.map((month) => ({
  month_key: month,
  generation_id: `driftstone-source-v1:${sha256(month)}`,
  packet_sha256: sha256(`packet:${month}`),
  candidates_sha256: sha256(candidates.filter((row) => row.month_key === month)),
  candidate_count: 2
}));

const bundle = buildPrivateSourceReviewBundle({
  packetSources,
  candidates,
  generatedAt: '2026-07-28T00:00:00.000Z'
});
equal(bundle.schema, PRIVATE_SOURCE_REVIEW_SCHEMA);
equal(bundle.candidate_count, 6);
equal(bundle.candidate_counts_by_month, {
  '2025-03': 2,
  '2025-08': 2,
  '2025-11': 2
});
equal(bundle.candidate_counts_by_source_state, {
  source_bound: 3,
  source_incomplete: 3
});
equal(bundle.writes_home, false);
equal(bundle.writes_hippocove, false);
equal(bundle.writes_notion, false);
equal(bundle.writes_cloud, false);
equal(bundle.event_family_count, 3);
equal(bundle.event_family_counts_by_pair_state, {
  paired: 3,
  persona_only: 0,
  fact_only: 0
});
equal(bundle.home_warm_candidate_templates.length, 3);
equal(
  bundle.home_warm_candidate_templates[0].template.event_family.schema,
  'driftstone_event_family.v0'
);
equal(
  bundle.home_warm_candidate_templates[0].template.event_family.sql_member_refs[0]
    .payload_digest.length,
  64
);

const html = renderPrivateSourceReviewHtml(bundle);
const bundleJson = `${JSON.stringify(bundle, null, 2)}\n`;
ok(html.includes('Prepared context · 仅上下文'));
ok(html.includes('Exact evidence · 候选自身'));
ok(html.includes('canonical_payload_sha256'));
ok(html.includes("connect-src 'none'"));
ok(!html.includes('</script><script>throw'), 'Private text must not break out of the data script.');
ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//u.test(html), 'Review HTML must have no network path.');
ok(html.includes('source_bound 已有证据，不能降权'));

const incompleteCandidate = candidates.find(
  (row) => row.month_key === '2025-03' && row.source_evidence.state === 'source_incomplete'
);
const sourceBoundCandidate = candidates.find(
  (row) => row.month_key === '2025-03' && row.source_evidence.state === 'source_bound'
);
const decisionDoc = buildDecisionDocument({
  monthKey: '2025-03',
  candidates,
  reviewer: 'owner',
  decisions: [{
    candidate_id: incompleteCandidate.candidate_id,
    decision: 'approve',
    authority: 'human_attested',
    decided_at: '2026-07-28T00:00:00Z',
    note: 'synthetic note'
  }]
});
equal(decisionDoc.schema, HUMAN_DECISIONS_SCHEMA);
equal(decisionDoc.month_key, '2025-03');
equal(decisionDoc.decisions[0].candidate_id, incompleteCandidate.candidate_id);
equal(
  decisionDoc.decisions[0].canonical_payload_sha256,
  incompleteCandidate.integrity.canonical_payload_sha256
);
assert.throws(() => buildDecisionDocument({
  monthKey: '2025-03',
  candidates,
  decisions: [{
    candidate_id: sourceBoundCandidate.candidate_id,
    decision: 'approve',
    authority: 'legacy_import'
  }]
}), (error) => error?.code === 'source_bound_approval_invalid');
checks += 1;
const holdFactDecisionDoc = buildDecisionDocument({
  monthKey: '2025-03',
  candidates,
  decisions: [{
    candidate_id: sourceBoundCandidate.candidate_id,
    decision: 'hold',
    note: ''
  }]
});
const intakeWithFactHold = buildHomeWarmIntake({
  bundle,
  decisionDocuments: [holdFactDecisionDoc],
  generatedAt: '2026-07-28T00:00:00.000Z'
});
equal(intakeWithFactHold.included_fact_candidate_count, 2);
equal(intakeWithFactHold.excluded_fact_candidate_count, 1);

const intakeWithoutApproval = buildHomeWarmIntake({
  bundle,
  decisionDocuments: [],
  generatedAt: '2026-07-28T00:00:00.000Z'
});
equal(intakeWithoutApproval.schema, DRIFTSTONE_HOME_WARM_INTAKE_SCHEMA);
equal(intakeWithoutApproval.included_persona_candidate_count, 0);
equal(intakeWithoutApproval.excluded_persona_candidate_count, 3);
equal(intakeWithoutApproval.source_fact_candidate_count, 3);
equal(intakeWithoutApproval.conservation.persona_equation_passed, true);
equal(intakeWithoutApproval.conservation.fact_equation_passed, true);
equal(intakeWithoutApproval.included_fact_candidate_count, 3);
equal(intakeWithoutApproval.excluded_fact_candidate_count, 0);

const intakeWithApproval = buildHomeWarmIntake({
  bundle,
  decisionDocuments: [decisionDoc],
  generatedAt: '2026-07-28T00:00:00.000Z'
});
equal(intakeWithApproval.included_persona_candidate_count, 1);
equal(intakeWithApproval.excluded_persona_candidate_count, 2);
equal(intakeWithApproval.event_family_intakes.length, 1);
equal(
  intakeWithApproval.event_family_intakes[0].persona_candidates[0]
    .authority_decision.canonical_authority_granted,
  false
);
equal(
  intakeWithApproval.event_family_intakes[0].persona_candidates[0]
    .warm_rewrite_candidate.event_family.sql_member_refs[0].payload_digest,
  sourceBoundCandidate.integrity.canonical_payload_sha256
);
equal(
  intakeWithApproval.event_family_intakes[0].persona_candidates[0]
    .warm_rewrite_candidate.event_family.event_family_digest,
  undefined
);
const fixtureOptionIndex = process.argv.indexOf('--emit-home-event-family-fixture');
let emittedHomeFixture = null;
if (fixtureOptionIndex >= 0) {
  const fixturePath = resolve(process.argv[fixtureOptionIndex + 1] || '');
  if (
    !fixturePath.startsWith(`${resolve(tmpdir())}/`)
    && !fixturePath.startsWith('/private/tmp/')
  ) {
    throw new Error('home_event_family_fixture_must_be_private_tmp');
  }
  const fixturePacket = intakeWithApproval.event_family_intakes[0]
    .persona_candidates[0].warm_rewrite_candidate;
  const fixtureBytes = `${JSON.stringify(fixturePacket, null, 2)}\n`;
  await writeFile(fixturePath, fixtureBytes, { mode: 0o600 });
  await chmod(fixturePath, 0o600);
  emittedHomeFixture = {
    path: fixturePath,
    byte_count: Buffer.byteLength(fixtureBytes, 'utf8'),
    sha256: sha256(Buffer.from(fixtureBytes, 'utf8')),
    mode: '0600',
    producer: 'buildHomeWarmIntake -> buildPortableWarmRewriteCandidate'
  };
}

function resealCandidate(base, mutate) {
  const { integrity: _ignored, ...payload } = JSON.parse(JSON.stringify(base));
  mutate(payload);
  return {
    ...payload,
    integrity: {
      canonical_payload_sha256: sha256(payload)
    }
  };
}

const titleCollisionCandidates = [
  resealCandidate(candidate('2025-12', 2, 'source_bound'), (payload) => {
    payload.upstream.workbench_row.title = 'Same title';
    payload.upstream.reviewed_rows[0].title = 'Same title';
    payload.upstream.reviewed_rows[0].family_id = 'family-2025-12-a';
  }),
  resealCandidate(candidate('2025-12', 4, 'source_bound'), (payload) => {
    payload.upstream.workbench_row.title = 'Same title';
    payload.upstream.reviewed_rows[0].title = 'Same title';
    payload.upstream.reviewed_rows[0].family_id = 'family-2025-12-b';
  })
];
const titleCollisionBundle = buildPrivateSourceReviewBundle({
  packetSources: [{
    month_key: '2025-12',
    generation_id: `driftstone-source-v1:${sha256('2025-12')}`,
    packet_sha256: sha256('packet:2025-12'),
    candidates_sha256: sha256(titleCollisionCandidates),
    candidate_count: 2
  }],
  candidates: titleCollisionCandidates,
  generatedAt: '2026-07-28T00:00:00.000Z'
});
equal(titleCollisionBundle.event_family_count, 2);
equal(titleCollisionBundle.title_collision_warnings.length, 1);
equal(
  titleCollisionBundle.title_collision_warnings[0].automatic_merge_allowed,
  false
);
const sourceBoundAutoIntake = buildHomeWarmIntake({
  bundle: titleCollisionBundle,
  decisionDocuments: [],
  generatedAt: '2026-07-28T00:00:00.000Z'
});
equal(sourceBoundAutoIntake.included_persona_candidate_count, 2);
equal(sourceBoundAutoIntake.excluded_persona_candidate_count, 0);
equal(
  sourceBoundAutoIntake.event_family_intakes.every(
    (family) => family.pair_state === 'persona_only'
  ),
  true
);

const factApprovalCandidates = [
  candidate('2025-10', 0, 'source_bound'),
  candidate('2025-10', 1, 'source_incomplete')
];
const factApprovalBundle = buildPrivateSourceReviewBundle({
  packetSources: [{
    month_key: '2025-10',
    generation_id: `driftstone-source-v1:${sha256('2025-10')}`,
    packet_sha256: sha256('packet:2025-10'),
    candidates_sha256: sha256(factApprovalCandidates),
    candidate_count: 2
  }],
  candidates: factApprovalCandidates,
  generatedAt: '2026-07-28T00:00:00.000Z'
});
const factBlockedIntake = buildHomeWarmIntake({
  bundle: factApprovalBundle,
  decisionDocuments: [],
  generatedAt: '2026-07-28T00:00:00.000Z'
});
equal(factBlockedIntake.included_persona_candidate_count, 1);
equal(factBlockedIntake.included_fact_candidate_count, 0);
equal(factBlockedIntake.excluded_fact_candidate_count, 1);
equal(factBlockedIntake.event_family_intakes[0].pair_state, 'persona_only');
const factApprovalDecision = buildDecisionDocument({
  monthKey: '2025-10',
  candidates: factApprovalCandidates,
  decisions: [{
    candidate_id: factApprovalCandidates[1].candidate_id,
    decision: 'approve',
    authority: 'legacy_import',
    reviewer: 'owner'
  }]
});
const factApprovedIntake = buildHomeWarmIntake({
  bundle: factApprovalBundle,
  decisionDocuments: [factApprovalDecision],
  generatedAt: '2026-07-28T00:00:00.000Z'
});
equal(factApprovedIntake.included_fact_candidate_count, 1);
equal(factApprovedIntake.excluded_fact_candidate_count, 0);
equal(factApprovedIntake.event_family_intakes[0].pair_state, 'paired');
equal(
  factApprovedIntake.eligible_fact_facets[0]
    .authority_decision.canonical_authority_granted,
  false
);

const conflictingFamilyCandidate = resealCandidate(
  candidate('2025-12', 6, 'source_bound'),
  (payload) => {
    payload.upstream.reviewed_rows.push({
      ...payload.upstream.reviewed_rows[0],
      family_id: 'conflicting-family'
    });
  }
);
assert.throws(() => buildPrivateSourceReviewBundle({
  packetSources: [{
    month_key: '2025-12',
    generation_id: 'conflict',
    packet_sha256: sha256('conflict'),
    candidates_sha256: sha256([conflictingFamilyCandidate]),
    candidate_count: 1
  }],
  candidates: [conflictingFamilyCandidate]
}), (error) => error?.code === 'event_family_id_conflict');
checks += 1;

const manifest = buildPrivateReviewManifest({
  bundle,
  html,
  bundleJson,
  sourceFiles: packetSources
});
equal(manifest.schema, PRIVATE_SOURCE_REVIEW_MANIFEST_SCHEMA);
equal(manifest.output_files['index.html'].sha256, sha256(Buffer.from(html)));
equal(
  manifest.output_files['private_source_review_bundle_v1.json'].sha256,
  sha256(Buffer.from(bundleJson))
);
equal(manifest.output_directory_mode, '0700');
equal(manifest.output_file_mode, '0600');
equal(manifest.safe_to_commit_generated_output, false);

const temporaryRoot = await mkdtemp(join(tmpdir(), 'driftstone-private-review-regression-'));
const packetDirs = [];
for (const month of months) {
  const packetDir = join(temporaryRoot, `packet-${month}`);
  await mkdir(packetDir, { mode: 0o700 });
  packetDirs.push(packetDir);
  const monthCandidates = candidates.filter((row) => row.month_key === month);
  const candidatesText = `${monthCandidates.map((row) => stableJson(row)).join('\n')}\n`;
  const packetPayload = {
    schema: PORTABLE_SOURCE_PACKET_SCHEMA,
    month_key: month,
    candidate_counts: {
      emitted_candidates: monthCandidates.length
    }
  };
  const packet = {
    ...packetPayload,
    integrity: {
      packet_payload_sha256: sha256(packetPayload)
    }
  };
  const packetText = `${JSON.stringify(packet, null, 2)}\n`;
  const generationPayload = {
    schema: 'driftstone_portable_source_generation_manifest_v1',
    generation_id: `driftstone-source-v1:${sha256(month)}`,
    output_files: {
      'portable_source_packet_v1.json': {
        byte_count: Buffer.byteLength(packetText),
        sha256: sha256(Buffer.from(packetText)),
        mode: '0600'
      },
      'portable_source_candidates_v1.jsonl': {
        byte_count: Buffer.byteLength(candidatesText),
        sha256: sha256(Buffer.from(candidatesText)),
        mode: '0600'
      }
    }
  };
  const generationManifest = {
    ...generationPayload,
    manifest_sha256: sha256(generationPayload)
  };
  await writeFile(join(packetDir, 'portable_source_packet_v1.json'), packetText, {
    mode: 0o600
  });
  await writeFile(join(packetDir, 'portable_source_candidates_v1.jsonl'), candidatesText, {
    mode: 0o600
  });
  await writeFile(
    join(packetDir, 'portable_source_generation_manifest_v1.json'),
    `${JSON.stringify(generationManifest, null, 2)}\n`,
    { mode: 0o600 }
  );
}

const outputDir = join(temporaryRoot, 'review-output');
const cliArgs = [
  cli,
  ...packetDirs.flatMap((directory) => ['--packet-dir', directory]),
  '--expected-count', '6',
  '--out', outputDir
];
const run = spawnSync(process.execPath, cliArgs, {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(run.status, 0, run.stderr);
equal((await stat(outputDir)).mode & 0o777, 0o700);
equal((await stat(join(outputDir, 'index.html'))).mode & 0o777, 0o600);
equal(
  (await stat(join(outputDir, 'private_source_review_bundle_v1.json'))).mode & 0o777,
  0o600
);
equal(
  (await stat(join(outputDir, 'private_source_review_manifest_v1.json'))).mode & 0o777,
  0o600
);
const generatedManifest = JSON.parse(
  await readFile(join(outputDir, 'private_source_review_manifest_v1.json'), 'utf8')
);
equal(generatedManifest.candidate_count, 6);
equal(generatedManifest.safe_to_commit_generated_output, false);
equal(generatedManifest.writes_home, false);
equal(generatedManifest.writes_hippocove, false);

const browserDecisionFile = join(temporaryRoot, 'browser-download-2025-03.json');
await writeFile(browserDecisionFile, `${JSON.stringify(decisionDoc, null, 2)}\n`, {
  mode: 0o644
});
await chmod(browserDecisionFile, 0o644);
equal((await stat(browserDecisionFile)).mode & 0o777, 0o644);
const sealedOutput = join(temporaryRoot, 'sealed-decisions');
const sealRun = spawnSync(process.execPath, [
  sealCli,
  '--review-dir', outputDir,
  '--decision-file', browserDecisionFile,
  '--out', sealedOutput
], {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(sealRun.status, 0, sealRun.stderr);
equal((await stat(sealedOutput)).mode & 0o777, 0o700);
const sealedDecisionFile = join(
  sealedOutput,
  'driftstone-portable-source-decisions-2025-03.sealed.json'
);
equal((await stat(sealedDecisionFile)).mode & 0o777, 0o600);
equal(
  JSON.parse(await readFile(sealedDecisionFile, 'utf8')),
  decisionDoc,
  'Sealed decision content must preserve the canonical monthly decision document.'
);
const sealedIntakeFile = join(sealedOutput, 'driftstone_home_warm_intake_v1.json');
equal((await stat(sealedIntakeFile)).mode & 0o777, 0o600);
const sealedIntake = JSON.parse(await readFile(sealedIntakeFile, 'utf8'));
equal(sealedIntake.schema, DRIFTSTONE_HOME_WARM_INTAKE_SCHEMA);
equal(sealedIntake.included_persona_candidate_count, 1);
equal(sealedIntake.conservation.persona_equation_passed, true);

const alteredDecisionFile = join(temporaryRoot, 'altered-browser-download.json');
const alteredDecision = JSON.parse(JSON.stringify(decisionDoc));
alteredDecision.decisions[0].canonical_payload_sha256 = '0'.repeat(64);
await writeFile(alteredDecisionFile, `${JSON.stringify(alteredDecision, null, 2)}\n`, {
  mode: 0o644
});
const alteredSealRun = spawnSync(process.execPath, [
  sealCli,
  '--review-dir', outputDir,
  '--decision-file', alteredDecisionFile,
  '--out', join(temporaryRoot, 'altered-seal-output')
], {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(alteredSealRun.status, 1);
ok(alteredSealRun.stderr.includes('decision_candidate_binding_mismatch'));

const repeat = spawnSync(process.execPath, cliArgs, {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(repeat.status, 1);
ok(repeat.stderr.includes('private_output_exists_or_unavailable'));

const repoOutput = join(repoRoot, 'output', 'must-not-create-private-review');
const repoRun = spawnSync(process.execPath, [
  cli,
  ...packetDirs.flatMap((directory) => ['--packet-dir', directory]),
  '--expected-count', '6',
  '--out', repoOutput
], {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(repoRun.status, 1);
ok(repoRun.stderr.includes('private_output_inside_repo'));

const symlinkParent = join(temporaryRoot, 'repo-output-link');
await symlink(join(repoRoot, 'output'), symlinkParent, 'dir');
const symlinkEscapeRun = spawnSync(process.execPath, [
  cli,
  ...packetDirs.flatMap((directory) => ['--packet-dir', directory]),
  '--expected-count', '6',
  '--out', join(symlinkParent, 'must-not-create-private-review')
], {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(symlinkEscapeRun.status, 1);
ok(symlinkEscapeRun.stderr.includes('private_output_inside_repo'));

const schemaManifestFile = join(
  packetDirs[1],
  'portable_source_generation_manifest_v1.json'
);
const schemaManifestOriginal = await readFile(schemaManifestFile, 'utf8');
const schemaManifest = JSON.parse(schemaManifestOriginal);
schemaManifest.schema = 'wrong_generation_manifest';
const { manifest_sha256: _oldSchemaDigest, ...schemaPayload } = schemaManifest;
schemaManifest.manifest_sha256 = sha256(schemaPayload);
await writeFile(schemaManifestFile, `${JSON.stringify(schemaManifest, null, 2)}\n`, {
  mode: 0o600
});
const wrongSchemaRun = spawnSync(process.execPath, [
  cli,
  ...packetDirs.flatMap((directory) => ['--packet-dir', directory]),
  '--expected-count', '6',
  '--out', join(temporaryRoot, 'wrong-schema-output')
], {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(wrongSchemaRun.status, 1);
ok(wrongSchemaRun.stderr.includes('source_generation_manifest_schema_invalid'));
await writeFile(schemaManifestFile, schemaManifestOriginal, { mode: 0o600 });

const mixedPacketFile = join(packetDirs[0], 'portable_source_packet_v1.json');
const mixedPacket = JSON.parse(await readFile(mixedPacketFile, 'utf8'));
const { integrity: _oldPacketIntegrity, ...mixedPayload } = mixedPacket;
mixedPayload.same_month_other_generation = true;
const validMixedPacket = {
  ...mixedPayload,
  integrity: {
    packet_payload_sha256: sha256(mixedPayload)
  }
};
await writeFile(mixedPacketFile, `${JSON.stringify(validMixedPacket, null, 2)}\n`, {
  mode: 0o600
});
const mixedPacketRun = spawnSync(process.execPath, [
  cli,
  ...packetDirs.flatMap((directory) => ['--packet-dir', directory]),
  '--expected-count', '6',
  '--out', join(temporaryRoot, 'mixed-packet-output')
], {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(mixedPacketRun.status, 1);
ok(mixedPacketRun.stderr.includes('source_packet_digest_invalid'));

console.log(JSON.stringify({
  ok: true,
  checks,
  schema: PRIVATE_SOURCE_REVIEW_SCHEMA,
  decision_schema: HUMAN_DECISIONS_SCHEMA,
  emitted_home_event_family_fixture: emittedHomeFixture,
  private_output_only: true,
  model_called: false,
  writes_any_destination: false
}, null, 2));
