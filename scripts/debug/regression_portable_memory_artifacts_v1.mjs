#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  DEFAULT_TEMPORAL_SAMPLE_PLAN,
  buildPortableArtifact,
  buildPortableArtifactBatch,
  exportPortableArtifactsJsonl,
  projectPortableArtifactToMarkdown,
  projectPortableArtifactToNotion,
  sha256,
  verifyLedgerDigest,
  verifyPortableArtifact,
  verifyProjectionConservation
} from '../lib/driftstone-portable-artifact-v1.mjs';

function personaInput(overrides = {}) {
  return {
    month_key: '2025-03',
    layer: 'persona',
    observed_dialogue_types: ['creation', 'relationship_evolution'],
    reviewed_row: {
      layer: 'persona',
      record_id: 'persona-1',
      title: 'Synthetic creative evolution',
      tags: '创作/世界观；关系/共写',
      topic_ids: 'topic-1|topic-2',
      topic_labels: '剧情演化|人物关系',
      expression_fingerprint: 'synthetic-expression-label',
      new_memory_taxonomy: ['synthetic/new-label'],
      review_status: 'reviewed',
      source_refs: 'synthetic-source.json',
      source_window_id: 'window-1',
      source_msg_start: '10',
      source_msg_end: '12',
      summary: 'Synthetic persona continuity.',
      stable_points: 'Keeps the creative detail intact.'
    },
    node: {
      schema: 'synthetic_node_v1',
      node_id: 'node-persona-1',
      source_entry_id: 'persona-1',
      month_key: '2025-03',
      message_id: 'message:persona-1',
      provider: 'chatgpt',
      account_id: 'owner',
      provider_conversation_id: 'conversation:persona-1',
      provider_timezone: 'Asia/Shanghai',
      speaker: 'user',
      title: 'Synthetic creative evolution',
      node_kind: 'identity_anchor',
      source_tags: ['创作/世界观', '关系/共写'],
      source_refs: ['synthetic-source.json', 'window_20250301_msg_1,2'],
      source_trace_ids: ['trace-persona-1'],
      source_span_ids: ['span-persona-1'],
      relationship_significance: 'Synthetic relationship meaning.',
      living_fragment: 'Synthetic scene detail.',
      quality: { review_status: 'reviewed', quality_flags: ['detail-preserved'] }
    },
    candidate: {
      schema: 'synthetic_candidate_v1',
      candidate_id: 'candidate-persona-1',
      source_entry_id: 'persona-1',
      aliases: ['Alias A'],
      memory_type: '自我定义',
      memory_shape: 'self_definition',
      recall_lane: 'character_identity',
      source_refs: ['synthetic-source.json'],
      entities: ['Aji', 'CreativeWorld'],
      import_status: 'reviewed'
    },
    source_traces: [{
      trace_id: 'trace-persona-1',
      canonical_source_span_id: 'span-persona-1',
      source_window_id: 'window-1',
      source_msg_range: '10-12',
      source_refs: ['synthetic-source.json'],
      source_tags: ['trace-tag'],
      topic_label: '剧情演化'
    }],
    source_spans: [{
      source_span_id: 'span-persona-1',
      source_window_id: 'window-1',
      source_msg_range: '10-12',
      source_refs: ['synthetic-source.json']
    }],
    ...overrides
  };
}

function factInput(overrides = {}) {
  return {
    month_key: '2025-09',
    layer: 'sql',
    observed_dialogue_types: ['viewpoint', 'expression'],
    reviewed_row: {
      layer: 'sql',
      record_id: 'fact-1',
      title: 'Synthetic world fact',
      sql_row_kind: 'stable_fact',
      fact_role: 'world_rule',
      fact_key: '',
      fact_value: '',
      text: 'The synthetic city has two moons.',
      summary: 'A creative-world fact, not a work report.',
      stable_points: 'Two moons remain part of the setting.',
      tags: '世界观；剧情事实',
      topic_labels: '创作|设定',
      review_status: 'reviewed',
      source_refs: 'synthetic-world.json',
      linked_entities: 'SyntheticCity|MoonA|MoonB'
    },
    node: {
      schema: 'synthetic_node_v1',
      node_id: 'node-fact-1',
      source_entry_id: 'fact-1',
      month_key: '2025-09',
      title: 'Synthetic world fact',
      node_kind: 'method_or_world_rule_anchor',
      source_refs: ['synthetic-world.json'],
      source_trace_ids: ['trace-fact-1'],
      source_span_ids: ['span-fact-1'],
      structured_slots: {
        subject: 'SyntheticCity',
        object_anchor: 'TwoMoons',
        lane: 'world_rule'
      },
      quality: { review_status: 'reviewed' }
    },
    candidate: {
      schema: 'synthetic_candidate_v1',
      candidate_id: 'candidate-fact-1',
      source_entry_id: 'fact-1',
      candidate_kind: 'cold_archive_memory',
      memory_type: '现实锚点',
      memory_shape: 'anchor_object',
      recall_lane: 'object_anchor_recall',
      raw_machine_fact: '',
      facts: ['The synthetic city has two moons.'],
      entities: ['SyntheticCity', 'MoonA', 'MoonB'],
      source_refs: ['synthetic-world.json'],
      import_status: 'reviewed'
    },
    source_traces: [{
      trace_id: 'trace-fact-1',
      canonical_source_span_id: 'span-fact-1',
      source_window_id: 'window-fact-1',
      source_msg_range: '20-21',
      source_refs: ['synthetic-world.json'],
      topic_label: '创作设定'
    }],
    source_spans: [{
      source_span_id: 'span-fact-1',
      source_window_id: 'window-fact-1',
      source_msg_range: '20-21',
      source_refs: ['synthetic-world.json']
    }],
    ...overrides
  };
}

function factInputForMonth(month) {
  const source = factInput();
  return {
    ...source,
    month_key: month,
    node: { ...source.node, month_key: month },
    candidate: { ...source.candidate, month_key: month }
  };
}

function assertPersonaLosslessAndLabelAudit() {
  const artifact = buildPortableArtifact(personaInput());
  assert.equal(artifact.candidate_lane, 'persona');
  assert.equal(artifact.historical_case_candidate, false);
  assert.equal(artifact.case_extraction_status, 'not_applicable_by_owner_decision');
  assert.equal(artifact.upstream_payloads.reviewed_row.expression_fingerprint, 'synthetic-expression-label');
  assert.equal(artifact.labels.source_fields['reviewed_row.tags'], '创作/世界观；关系/共写');
  assert.deepEqual(
    artifact.labels.unclassified_label_fields['reviewed_row.new_memory_taxonomy'],
    ['synthetic/new-label']
  );
  assert.ok(artifact.labels.exact_field_audit['reviewed_row.new_memory_taxonomy']);
  assert.ok(artifact.labels.normalized_candidates.includes('synthetic/new-label'));
  assert.ok(artifact.source_identity.source_refs.includes('window_20250301_msg_1,2'));
  assert.equal(artifact.source_identity.message_id, 'message:persona-1');
  assert.equal(artifact.source_identity.provider_kind, 'chatgpt');
  assert.equal(artifact.source_identity.provider_account_id, 'owner');
  assert.equal(
    artifact.source_identity.provider_conversation_id,
    'conversation:persona-1'
  );
  assert.equal(artifact.source_identity.provider_timezone, 'Asia/Shanghai');
  assert.equal(artifact.source_identity.source_actor_role, 'user');
  assert.deepEqual(artifact.source_identity.identity_conflicts, []);
  assert.equal(artifact.original_ids.fields['node.node_id'], 'node-persona-1');
  assert.equal(artifact.source_state.fields['node.quality.review_status'], 'reviewed');
  assert.equal(artifact.review.state, 'reviewed');
  assert.equal(artifact.content.text_fields['node.living_fragment'], 'Synthetic scene detail.');
  assert.equal(artifact.authority.canonical_authority_granted, false);
  assert.equal(artifact.graph_hints.canonical_edges_created, 0);
  assert.equal(artifact.graph_hints.runtime_effect, 'none');
  assert.equal(artifact.safety.reads_persona_prompt, false);
  assert.equal(verifyPortableArtifact(artifact), true);
  assert.equal(
    buildPortableArtifact(personaInput()).integrity.canonical_payload_sha256,
    artifact.integrity.canonical_payload_sha256
  );
  assert.equal(verifyPortableArtifact({
    ...artifact,
    content: { ...artifact.content, title: 'tampered' }
  }), false);

  const conflictedInput = personaInput({
    candidate: {
      ...personaInput().candidate,
      provider_conversation_id: 'conversation:other'
    }
  });
  const conflicted = buildPortableArtifact(conflictedInput);
  assert.equal(conflicted.source_identity.provider_conversation_id, '');
  assert.deepEqual(
    conflicted.source_identity.provider_conversation_id_candidates,
    ['conversation:persona-1', 'conversation:other']
  );
  assert.deepEqual(
    conflicted.source_identity.identity_conflicts,
    ['provider_conversation_id']
  );
  assert.ok(
    conflicted.missing_fields.includes(
      'source_identity.provider_conversation_id_conflict'
    )
  );
  assert.equal(conflicted.artifact_state, 'review_only_missing_fields');
}

function assertDomainNeutralStructuredFact() {
  const artifact = buildPortableArtifact(factInput());
  assert.equal(artifact.candidate_lane, 'fact');
  assert.equal(artifact.content.atomic_fact.status, 'present_from_existing_fact_field');
  assert.equal(artifact.content.atomic_fact.primary_text, 'The synthetic city has two moons.');
  assert.equal(artifact.content.atomic_fact.primary_source_field, 'candidate.facts[0]');
  assert.equal(artifact.content.atomic_fact.canonical_fact_granted, false);
  assert.deepEqual(artifact.graph_hints.entity_candidates, ['SyntheticCity', 'MoonA', 'MoonB', 'TwoMoons']);
  assert.equal(
    Object.keys(artifact.content.atomic_fact).filter((key) => key === 'object_candidate').length,
    1
  );

  const genericOnly = factInput({
    reviewed_row: {
      layer: 'sql',
      record_id: 'fact-generic-only',
      title: 'Generic status report',
      summary: 'Work status summary must not become an atomic fact.',
      text: 'A generic prose report.',
      status: 'completed',
      review_status: 'reviewed',
      source_refs: 'generic.json'
    },
    node: {
      node_id: 'node-fact-generic-only',
      source_entry_id: 'fact-generic-only',
      month_key: '2025-09',
      quality: { review_status: 'reviewed' },
      source_refs: ['generic.json']
    },
    candidate: {
      candidate_id: 'candidate-fact-generic-only',
      source_entry_id: 'fact-generic-only',
      facts: []
    },
    source_traces: [],
    source_spans: []
  });
  const missing = buildPortableArtifact(genericOnly);
  assert.equal(missing.content.atomic_fact.status, 'missing');
  assert.equal(missing.content.atomic_fact.primary_text, '');
  assert.ok(missing.missing_fields.includes('content.atomic_fact.primary_text'));

  const objectFact = factInput({
    reviewed_row: {
      layer: 'sql',
      record_id: 'fact-object',
      review_status: 'reviewed',
      source_refs: 'object.json'
    },
    node: {
      node_id: 'node-fact-object',
      source_entry_id: 'fact-object',
      month_key: '2025-09',
      structured_slots: {},
      quality: { review_status: 'reviewed' },
      source_refs: ['object.json']
    },
    candidate: {
      candidate_id: 'candidate-fact-object',
      source_entry_id: 'fact-object',
      facts: [{ subject: 'A', predicate: 'relates_to', object: { id: 'B' } }]
    },
    source_traces: [],
    source_spans: []
  });
  const structured = buildPortableArtifact(objectFact);
  assert.equal(structured.content.atomic_fact.status, 'missing');
  assert.deepEqual(structured.content.atomic_fact.structured_fact_candidates, [{
    source_field: 'candidate.facts[0]',
    value: { object: { id: 'B' }, predicate: 'relates_to', subject: 'A' }
  }]);
  assert.equal(JSON.stringify(structured).includes('[object Object]'), false);
  assert.equal(
    Object.keys(structured.content.atomic_fact).filter((key) => key === 'object_candidate').length,
    1
  );
}

function assertTruthConflictsAndMissingAreRejected() {
  const missingLayer = personaInput({
    layer: '',
    reviewed_row: { ...personaInput().reviewed_row, layer: '' }
  });
  const invalidMonthBase = personaInput();
  const invalidMonth = {
    ...invalidMonthBase,
    month_key: '2025-13',
    reviewed_row: {
      ...invalidMonthBase.reviewed_row,
      month_key: '2025-13'
    },
    node: {
      ...invalidMonthBase.node,
      month_key: '2025-13'
    },
    candidate: {
      ...invalidMonthBase.candidate,
      month_key: '2025-13'
    }
  };
  const batch = buildPortableArtifactBatch([
    personaInput(),
    factInput(),
    { ...personaInput(), layer: 'case' },
    { ...personaInput(), layer: 'fact' },
    { ...personaInput(), month_key: '2025-04' },
    {
      ...personaInput(),
      layer: 'persona',
      node: { ...personaInput().node, layer: 'case' }
    },
    missingLayer,
    invalidMonth
  ]);
  assert.equal(batch.artifacts.length, 2);
  assert.equal(batch.rejected.length, 6);
  assert.equal(batch.ledger.row_conservation_passed, true);
  assert.equal(batch.ledger.historical_case_candidates, 0);
  assert.equal(batch.ledger.by_rejection_code.historical_case_forbidden, 2);
  assert.equal(batch.ledger.by_rejection_code.source_layer_conflict, 1);
  assert.equal(batch.ledger.by_rejection_code.month_key_conflict, 1);
  assert.equal(batch.ledger.by_rejection_code.month_key_invalid, 1);
  assert.equal(batch.ledger.by_rejection_code.source_layer_missing_or_unknown, 1);

  const duplicate = buildPortableArtifactBatch([personaInput(), personaInput()]);
  assert.equal(duplicate.artifacts.length, 1);
  assert.equal(duplicate.rejected[0].rejection_code, 'artifact_identity_duplicate');
}

function assertNonJsonFailsClosed() {
  for (const [field, value] of [
    ['nan', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['non_plain', new Date('2025-03-01T00:00:00Z')]
  ]) {
    const source = personaInput({
      candidate: { ...personaInput().candidate, [field]: value }
    });
    const batch = buildPortableArtifactBatch([source]);
    assert.equal(batch.artifacts.length, 0);
    assert.equal(batch.rejected.length, 1);
    assert.equal(batch.rejected[0].rejection_code, 'non_json_value');
    assert.equal(batch.rejected[0].input_payload_sha256, 'unavailable_non_json_input');
  }
  const circularCandidate = { ...personaInput().candidate };
  circularCandidate.self = circularCandidate;
  const circular = buildPortableArtifactBatch([personaInput({ candidate: circularCandidate })]);
  assert.equal(circular.artifacts.length, 0);
  assert.equal(circular.rejected[0].rejection_code, 'non_json_value');
}

function assertNoForgedAuthorityOrEdges() {
  const malicious = personaInput({
    reviewed_row: {
      ...personaInput().reviewed_row,
      canonical_authority: true,
      canonical_receipt: { id: 'forged' },
      canonical_edge: { from: 'a', to: 'b' }
    },
    node: {
      ...personaInput().node,
      owner_attested: true,
      verified: true,
      canonical_episode_id: 'forged-episode'
    }
  });
  const artifact = buildPortableArtifact(malicious);
  assert.equal(artifact.authority.canonical_authority_granted, false);
  assert.equal(artifact.authority.canonical_receipt, null);
  assert.equal(artifact.graph_hints.canonical_edges_created, 0);
  assert.equal(artifact.graph_hints.canonical_episodes_created, 0);
  assert.equal(artifact.graph_hints.canonical_receipts_created, 0);
  assert.deepEqual(
    artifact.authority.upstream_claims_preserved_not_verified['reviewed_row.canonical_receipt'],
    { id: 'forged' }
  );
  assert.equal(artifact.upstream_payloads.reviewed_row.canonical_edge.from, 'a');
}

function assertProjectionContentBindingAndCanonicalExport() {
  const artifact = buildPortableArtifact(personaInput());
  const notion = projectPortableArtifactToNotion(artifact);
  const markdown = projectPortableArtifactToMarkdown(artifact);
  assert.equal(notion.projection_only, true);
  assert.equal(notion.writes_to_notion, false);
  assert.match(notion.fields.labels_json, /synthetic\/new-label/u);
  assert.equal(markdown.projection_only, true);
  assert.match(markdown.markdown, /versioned JSON artifact remains canonical/u);
  assert.deepEqual(verifyProjectionConservation(artifact, notion), { ok: true, mismatches: [] });
  assert.deepEqual(verifyProjectionConservation(artifact, markdown), { ok: true, mismatches: [] });

  const notionLabelsTampered = {
    ...notion,
    fields: { ...notion.fields, labels_json: '{"forged":true}' }
  };
  const notionAtomicTampered = {
    ...notion,
    fields: { ...notion.fields, atomic_fact_text: 'forged fact' }
  };
  const markdownBodyTampered = {
    ...markdown,
    markdown: `${markdown.markdown}\nforged body\n`
  };
  for (const tampered of [notionLabelsTampered, notionAtomicTampered, markdownBodyTampered]) {
    assert.deepEqual(verifyProjectionConservation(artifact, tampered), {
      ok: false,
      mismatches: ['projection_payload_not_derived_from_canonical_artifact']
    });
  }

  const exported = exportPortableArtifactsJsonl([artifact]);
  const [roundTripped] = exported.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(roundTripped.schema, 'driftstone_portable_memory_artifact_v1');
  assert.equal(roundTripped.artifact_id, artifact.artifact_id);
  assert.equal(verifyPortableArtifact(roundTripped), true);
}

function assertTemporalCoverage() {
  const expected = {
    '2025-03': { creation: 1, relationship_evolution: 1 },
    '2025-09': { viewpoint: 1, expression: 1 }
  };
  const batch = buildPortableArtifactBatch([personaInput(), factInput()], {
    expectedObservedTypeCounts: expected
  });
  assert.equal(batch.ledger.temporal_conservation_passed, true);
  assert.equal(batch.ledger.month_x_observed_dialogue_type['2025-03'].creation, 1);
  assert.equal(batch.ledger.month_x_observed_dialogue_type['2025-09'].viewpoint, 1);
  assert.equal(DEFAULT_TEMPORAL_SAMPLE_PLAN.early_classic_cohort.hardcoded_row_classification, false);
  assert.equal(DEFAULT_TEMPORAL_SAMPLE_PLAN.post_august_cohort.hardcoded_row_classification, false);
  assert.equal(DEFAULT_TEMPORAL_SAMPLE_PLAN.requires_every_type_in_every_month, false);

  const mismatch = buildPortableArtifactBatch([personaInput(), factInput()], {
    expectedObservedTypeCounts: { '2025-03': { creation: 2 } }
  });
  assert.equal(mismatch.ledger.temporal_conservation_passed, false);
  assert.deepEqual(mismatch.ledger.temporal_conservation_mismatches, [{
    month_key: '2025-03',
    observed_dialogue_type: 'creation',
    expected: 2,
    actual: 1
  }]);
}

function runNodeResult(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runNodeOk(args, cwd) {
  const result = await runNodeResult(args, cwd);
  if (result.code !== 0) {
    throw new Error(`CLI failed (${result.code})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function writeCliFixture(root) {
  const sourceDir = join(root, 'processed');
  const reviewedCsv = join(root, 'reviewed.csv');
  await mkdir(sourceDir, { recursive: true });
  const persona = personaInput();
  persona.node.source_trace_ids = ['trace-persona-1', 'trace-persona-2'];
  persona.node.source_span_ids = ['span-persona-1', 'span-persona-2'];
  const trace2 = {
    ...persona.source_traces[0],
    trace_id: 'trace-persona-2',
    canonical_source_span_id: 'span-persona-2',
    source_msg_range: '13-14'
  };
  const span2 = {
    ...persona.source_spans[0],
    source_span_id: 'span-persona-2',
    source_msg_range: '13-14'
  };
  const fact = factInputForMonth('2025-03');
  const nodeOrphan = {
    ...persona.node,
    node_id: 'node-orphan',
    source_entry_id: 'node-orphan-1',
    source_trace_ids: [],
    source_span_ids: []
  };
  const candidateOrphan = {
    ...persona.candidate,
    candidate_id: 'candidate-orphan',
    source_entry_id: 'candidate-orphan-1',
    source_trace_ids: []
  };
  const badLinksNode = {
    ...persona.node,
    node_id: 'node-bad-links',
    source_entry_id: 'bad-links-1',
    source_trace_ids: ['trace-missing', 'trace-ambiguous'],
    source_span_ids: ['span-missing', 'span-ambiguous']
  };
  const ambiguousTrace = {
    ...persona.source_traces[0],
    trace_id: 'trace-ambiguous',
    canonical_source_span_id: ''
  };
  const ambiguousSpan = {
    ...persona.source_spans[0],
    source_span_id: 'span-ambiguous'
  };
  const orphanTrace = {
    ...persona.source_traces[0],
    trace_id: 'trace-orphan',
    canonical_source_span_id: ''
  };
  const orphanSpan = {
    ...persona.source_spans[0],
    source_span_id: 'span-orphan'
  };
  const rowsByFile = {
    '23_asheriehome_memory_nodes.jsonl': [persona.node, fact.node, nodeOrphan, badLinksNode],
    '12_normalized_memory_candidates.jsonl': [persona.candidate, fact.candidate, candidateOrphan],
    '24_source_trace_index.jsonl': [
      persona.source_traces[0],
      trace2,
      fact.source_traces[0],
      ambiguousTrace,
      { ...ambiguousTrace, source_msg_range: '99-100' },
      orphanTrace
    ],
    '16_normalized_source_span_candidates.jsonl': [
      persona.source_spans[0],
      span2,
      fact.source_spans[0],
      ambiguousSpan,
      { ...ambiguousSpan, source_msg_range: '99-100' },
      orphanSpan
    ]
  };
  for (const [file, rows] of Object.entries(rowsByFile)) {
    await writeFile(join(sourceDir, file), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  }
  const header = ['layer', 'record_id', 'title', 'fact_value', 'tags', 'review_status', 'source_refs'];
  const csvRows = [
    header.join(','),
    ['persona', 'persona-1', 'Synthetic persona', '', 'persona-tag', 'reviewed', 'synthetic-source.json'].join(','),
    ['sql', 'fact-1', 'Synthetic fact', 'The city has two moons.', 'fact-tag', 'reviewed', 'synthetic-world.json'].join(','),
    ['persona', 'bad-links-1', 'Bad links', '', 'bad-link-tag', 'reviewed', 'synthetic-source.json'].join(',')
  ];
  await writeFile(reviewedCsv, `${csvRows.join('\n')}\n`, 'utf8');
  return { sourceDir, reviewedCsv };
}

function cliArgs(fixture, outDir, extras = []) {
  return [
    'scripts/debug/build_portable_memory_artifacts_v1.mjs',
    '--source-dir', fixture.sourceDir,
    '--reviewed-csv', fixture.reviewedCsv,
    '--month', '2025-03',
    '--out', outDir,
    ...extras
  ];
}

async function writeProcessedCliFixture(root) {
  const preparedFile = join(root, 'prepared.json');
  const workbenchFile = join(root, 'workbench.json');
  const sourceIndexFile = join(root, 'source-index.json');
  const reviewedCsv = join(root, 'reviewed.csv');
  await mkdir(root, { recursive: true });
  const prepared = [
    {
      chunk_id: 'chunk-1',
      source_bundle_id: 'bundle-1',
      source_ref: 'synthetic-source.json',
      source_md_ref: 'synthetic-source.md',
      source_manifest_kind: 'prepared_test_window',
      source_window_id: 'window-1',
      source_msg_start: 1,
      source_msg_end: 3,
      text: 'Synthetic prepared text must be bound by digest, never copied.'
    },
    {
      chunk_id: 'chunk-orphan',
      source_bundle_id: 'bundle-1',
      source_ref: 'synthetic-source.json',
      source_manifest_kind: 'prepared_test_window',
      source_window_id: 'window-orphan',
      text: 'Synthetic unreferenced prepared text.'
    }
  ];
  const workbench = [
    {
      layer: 'sql',
      record_id: 'processed-sql-1',
      memory_key: 'memory-sql-1',
      anchor_id: 'anchor-sql-1',
      chunk_id: 'chunk-1',
      source_ref: 'synthetic-source.json',
      source_file: 'synthetic_2025-09.json',
      source_window_id: 'window-1',
      sql_row_kind: 'card_master',
      fact_keys: 'world.rule',
      fact_role: 'world_rule',
      text: 'The synthetic archive keeps a blue gate.',
      summary: 'A generic summary is preserved but is not the atomic carrier.',
      decision: 'Keep the exact SQL decision field.',
      topic_ids: ['memory-topic-1', 'source-topic-1'],
      topic_labels: 'synthetic memory taxonomy',
      tags: 'synthetic/tag'
    },
    {
      layer: 'sql',
      record_id: 'processed-sql-generic',
      memory_key: 'memory-sql-generic',
      anchor_id: 'anchor-sql-generic',
      chunk_id: 'chunk-1',
      source_ref: 'synthetic-source.json',
      source_file: 'synthetic_2025-09.json',
      source_window_id: 'window-1',
      sql_row_kind: 'status_note',
      fact_keys: 'status.key',
      fact_role: 'status',
      text: 'Generic status prose must not become an atomic fact.',
      summary: 'Generic summary also must not become an atomic fact.'
    },
    {
      layer: 'persona',
      record_id: 'processed-persona-1',
      memory_key: 'memory-persona-1',
      anchor_id: 'anchor-persona-1',
      chunk_id: 'chunk-1',
      source_ref: 'synthetic-source.json',
      source_file: 'synthetic_2025-09.json',
      source_window_id: 'window-1',
      content_text: 'Synthetic persona card content.',
      expression_fingerprint: 'synthetic-expression',
      tags: 'persona/synthetic'
    },
    {
      layer: 'persona',
      record_id: 'processed-workbench-orphan',
      memory_key: 'memory-orphan',
      anchor_id: 'anchor-workbench-orphan',
      chunk_id: 'chunk-1',
      source_ref: 'synthetic-source.json',
      source_file: 'synthetic_2025-09.json',
      source_window_id: 'window-1',
      content_text: 'Synthetic rejected workbench row.'
    }
  ];
  const anchors = workbench.map((row) => ({
    anchor_id: row.anchor_id,
    record_id: row.record_id,
    memory_key: row.memory_key,
    layer: row.layer,
    chunk_id: row.chunk_id,
    source_bundle_id: 'bundle-1',
    source_ref: row.source_ref,
    source_window_id: row.source_window_id,
    topic_ids: ['source-topic-1'],
    topic_labels: ['synthetic source topic']
  }));
  anchors.push({
    anchor_id: 'anchor-index-only',
    record_id: 'processed-index-only',
    memory_key: 'memory-index-only',
    layer: 'sql',
    chunk_id: 'chunk-1',
    source_bundle_id: 'bundle-1',
    source_ref: 'synthetic-source.json',
    source_window_id: 'window-1',
    topic_ids: ['source-topic-1']
  });
  const sourceIndex = {
    kind: 'synthetic_source_index',
    mode: 'test_only',
    model: 'none',
    anchors,
    source_topic_index: [{
      topic_id: 'source-topic-1',
      topic_label: 'synthetic source topic',
      topic_role: 'test',
      anchor_ids: anchors.map((row) => row.anchor_id),
      chunk_id: 'chunk-1',
      source_bundle_id: 'bundle-1',
      source_window_id: 'window-1'
    }]
  };
  await writeFile(preparedFile, `${JSON.stringify(prepared, null, 2)}\n`, 'utf8');
  await writeFile(workbenchFile, `${JSON.stringify(workbench, null, 2)}\n`, 'utf8');
  await writeFile(sourceIndexFile, `${JSON.stringify(sourceIndex, null, 2)}\n`, 'utf8');
  const headers = [
    'layer',
    'record_id',
    'memory_key',
    'anchor_id',
    'chunk_id',
    'source_ref',
    'source_file',
    'source_window_id',
    'sql_row_kind',
    'fact_keys',
    'fact_role',
    'text',
    'summary',
    'decision',
    'content_text',
    'expression_fingerprint',
    'tags'
  ];
  const rows = [
    headers,
    [
      'sql',
      'processed-sql-1',
      'memory-sql-1',
      'anchor-sql-1',
      'chunk-1',
      'synthetic-source.json',
      'synthetic_2025-09.json',
      'window-1',
      'card_master',
      'world.rule',
      'world_rule',
      'The synthetic archive keeps a blue gate.',
      'A generic summary is preserved but is not the atomic carrier.',
      'Keep the exact SQL decision field.',
      '',
      '',
      'synthetic/sql'
    ],
    [
      'sql',
      'processed-sql-generic',
      'memory-sql-generic',
      'anchor-sql-generic',
      'chunk-1',
      'synthetic-source.json',
      'synthetic_2025-09.json',
      'window-1',
      'status_note',
      'status.key',
      'status',
      'Generic status prose must not become an atomic fact.',
      'Generic summary also must not become an atomic fact.',
      '',
      '',
      '',
      'synthetic/generic'
    ],
    [
      'persona',
      'processed-persona-1',
      'memory-persona-1',
      'anchor-persona-1',
      'chunk-1',
      'synthetic-source.json',
      'synthetic_2025-09.json',
      'window-1',
      '',
      '',
      '',
      '',
      '',
      '',
      'Synthetic persona card content.',
      'synthetic-expression',
      'persona/synthetic'
    ]
  ];
  await writeFile(
    reviewedCsv,
    `${rows.map((row) => row.join(',')).join('\n')}\n`,
    'utf8'
  );
  return { preparedFile, workbenchFile, sourceIndexFile, reviewedCsv };
}

function processedCliArgs(fixture, outDir, extras = []) {
  return [
    'scripts/debug/build_portable_memory_artifacts_v1.mjs',
    '--mode', 'processed',
    '--prepared-file', fixture.preparedFile,
    '--workbench-file', fixture.workbenchFile,
    '--source-index-file', fixture.sourceIndexFile,
    '--reviewed-csv', fixture.reviewedCsv,
    '--month', '2025-09',
    '--out', outDir,
    ...extras
  ];
}

async function readJsonl(file) {
  const raw = await readFile(file, 'utf8');
  if (!raw.trim()) return [];
  return raw.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
}

async function assertThinCliJoinLedgerAndGeneration() {
  const root = '/tmp/driftstone_portable_artifact_v1_regression';
  const outDir = join(root, 'out');
  await rm(root, { recursive: true, force: true });
  const fixture = await writeCliFixture(root);
  await runNodeOk(cliArgs(fixture, outDir), process.cwd());

  const artifacts = await readJsonl(join(outDir, 'portable_memory_artifacts_v1.jsonl'));
  const rejected = await readJsonl(join(outDir, 'portable_memory_rejected_v1.jsonl'));
  const ledger = JSON.parse(await readFile(join(outDir, 'portable_memory_conservation_v1.json'), 'utf8'));
  const manifestRaw = await readFile(join(outDir, 'portable_generation_manifest_v1.json'), 'utf8');
  const defaultFiles = (await readdir(outDir)).sort();
  assert.equal(artifacts.length, 2);
  assert.equal(rejected.length, 3);
  assert.deepEqual(
    rejected.map((row) => row.rejection_code).sort(),
    ['normalized_candidate_orphan', 'reviewed_row_missing', 'source_trace_identity_ambiguous']
  );
  assert.equal(ledger.input_rows, 5);
  assert.equal(ledger.row_conservation_passed, true);
  assert.equal(ledger.output_profile, 'canonical_only');
  assert.deepEqual(defaultFiles, [
    'portable_generation_manifest_v1.json',
    'portable_memory_artifacts_v1.jsonl',
    'portable_memory_conservation_v1.json',
    'portable_memory_rejected_v1.jsonl'
  ]);
  assert.equal(verifyLedgerDigest(ledger), true);
  assert.equal(verifyLedgerDigest({ ...ledger, artifact_rows: ledger.artifact_rows + 1 }), false);
  assert.equal(ledger.source_join.source_traces, 6);
  assert.equal(ledger.source_join.source_spans, 6);
  assert.deepEqual(ledger.source_join.source_trace_identity_ambiguous_ids, ['trace-ambiguous']);
  assert.deepEqual(ledger.source_join.source_span_identity_ambiguous_ids, ['span-ambiguous']);
  assert.deepEqual(ledger.source_join.unresolved_trace_ids, ['trace-missing']);
  assert.deepEqual(ledger.source_join.unresolved_span_ids, ['span-missing']);
  assert.deepEqual(ledger.source_join.orphan_trace_ids, ['trace-orphan']);
  assert.deepEqual(ledger.source_join.orphan_span_ids, ['span-orphan']);
  assert.equal(ledger.source_join.normalized_candidates_without_reviewed_or_node, 1);
  assert.equal(artifacts.every(verifyPortableArtifact), true);
  const personaArtifact = artifacts.find((row) => row.source_identity.source_entry_id === 'persona-1');
  assert.equal(personaArtifact.upstream_payloads.source_traces.length, 2);
  assert.equal(personaArtifact.upstream_payloads.source_spans.length, 2);

  const noReplace = await runNodeResult(cliArgs(fixture, outDir), process.cwd());
  assert.notEqual(noReplace.code, 0);
  assert.match(noReplace.stderr, /output_exists/u);
  assert.equal(
    await readFile(join(outDir, 'portable_generation_manifest_v1.json'), 'utf8'),
    manifestRaw
  );
  await runNodeOk(cliArgs(fixture, outDir, ['--replace']), process.cwd());
  assert.equal(verifyLedgerDigest(
    JSON.parse(await readFile(join(outDir, 'portable_memory_conservation_v1.json'), 'utf8'))
  ), true);

  const artifactPath = join(outDir, 'portable_memory_artifacts_v1.jsonl');
  const artifactRaw = await readFile(artifactPath, 'utf8');
  await writeFile(artifactPath, `${artifactRaw}tampered\n`, 'utf8');
  const outputTampered = await runNodeResult(cliArgs(fixture, outDir, ['--replace']), process.cwd());
  assert.notEqual(outputTampered.code, 0);
  assert.match(outputTampered.stderr, /existing_generation_output_digest_mismatch/u);
  await writeFile(artifactPath, artifactRaw, 'utf8');
  await runNodeOk(cliArgs(fixture, outDir, ['--replace']), process.cwd());

  const unexpectedPath = join(outDir, 'unexpected.txt');
  await writeFile(unexpectedPath, 'synthetic unexpected file\n', 'utf8');
  const unexpected = await runNodeResult(cliArgs(fixture, outDir, ['--replace']), process.cwd());
  assert.notEqual(unexpected.code, 0);
  assert.match(unexpected.stderr, /existing_generation_file_set_mismatch/u);
  await rm(unexpectedPath);
  await runNodeOk(cliArgs(fixture, outDir, ['--replace']), process.cwd());

  const projectionOut = join(root, 'out-with-projections');
  await runNodeOk(
    cliArgs(fixture, projectionOut, ['--with-projections']),
    process.cwd()
  );
  const projectedManifest = JSON.parse(await readFile(
    join(projectionOut, 'portable_generation_manifest_v1.json'),
    'utf8'
  ));
  assert.equal(projectedManifest.output_profile, 'canonical_plus_projections');
  assert.deepEqual((await readdir(projectionOut)).sort(), [
    'portable_generation_manifest_v1.json',
    'portable_markdown_projections_v1.jsonl',
    'portable_memory_artifacts_v1.jsonl',
    'portable_memory_conservation_v1.json',
    'portable_memory_rejected_v1.jsonl',
    'portable_notion_projections_v1.jsonl'
  ]);
  const projectedArtifacts = await readJsonl(
    join(projectionOut, 'portable_memory_artifacts_v1.jsonl')
  );
  const notions = await readJsonl(
    join(projectionOut, 'portable_notion_projections_v1.jsonl')
  );
  const markdowns = await readJsonl(
    join(projectionOut, 'portable_markdown_projections_v1.jsonl')
  );
  assert.equal(notions.length, projectedArtifacts.length);
  assert.equal(markdowns.length, projectedArtifacts.length);
  notions.forEach((projection, index) => {
    assert.deepEqual(
      verifyProjectionConservation(projectedArtifacts[index], projection),
      { ok: true, mismatches: [] }
    );
  });
  markdowns.forEach((projection, index) => {
    assert.deepEqual(
      verifyProjectionConservation(projectedArtifacts[index], projection),
      { ok: true, mismatches: [] }
    );
  });
  const profileMismatch = await runNodeResult(
    cliArgs(fixture, outDir, ['--with-projections', '--replace']),
    process.cwd()
  );
  assert.notEqual(profileMismatch.code, 0);
  assert.match(profileMismatch.stderr, /generation_mismatch/u);

  await writeFile(
    join(fixture.sourceDir, '23_asheriehome_memory_nodes.jsonl'),
    `${await readFile(join(fixture.sourceDir, '23_asheriehome_memory_nodes.jsonl'), 'utf8')}\n`,
    'utf8'
  );
  const mismatched = await runNodeResult(cliArgs(fixture, outDir, ['--replace']), process.cwd());
  assert.notEqual(mismatched.code, 0);
  assert.match(mismatched.stderr, /generation_mismatch/u);
}

async function assertCliDuplicateHeaderAndInvalidJsonFailClosed() {
  const duplicateRoot = '/tmp/driftstone_portable_duplicate_header_v1';
  await rm(duplicateRoot, { recursive: true, force: true });
  const duplicateFixture = await writeCliFixture(duplicateRoot);
  await writeFile(
    duplicateFixture.reviewedCsv,
    'layer,record_id,tags,tags\npersona,persona-1,a,b\n',
    'utf8'
  );
  const duplicateOut = join(duplicateRoot, 'out');
  const duplicateResult = await runNodeResult(cliArgs(duplicateFixture, duplicateOut), process.cwd());
  assert.notEqual(duplicateResult.code, 0);
  const duplicateRejected = await readJsonl(join(duplicateOut, 'portable_memory_rejected_v1.jsonl'));
  assert.equal(duplicateRejected.length, 1);
  assert.equal(duplicateRejected[0].rejection_code, 'reviewed_csv_duplicate_header');
  assert.equal(verifyLedgerDigest(
    JSON.parse(await readFile(join(duplicateOut, 'portable_memory_conservation_v1.json'), 'utf8'))
  ), true);

  const invalidRoot = '/tmp/driftstone_portable_invalid_json_v1';
  await rm(invalidRoot, { recursive: true, force: true });
  const invalidFixture = await writeCliFixture(invalidRoot);
  await writeFile(
    join(invalidFixture.sourceDir, '12_normalized_memory_candidates.jsonl'),
    '{"source_entry_id":"bad","score":NaN}\n',
    'utf8'
  );
  const invalidOut = join(invalidRoot, 'out');
  const invalidResult = await runNodeResult(cliArgs(invalidFixture, invalidOut), process.cwd());
  assert.notEqual(invalidResult.code, 0);
  const invalidRejected = await readJsonl(join(invalidOut, 'portable_memory_rejected_v1.jsonl'));
  assert.equal(invalidRejected.length, 1);
  assert.equal(invalidRejected[0].rejection_code, 'json_parse_error');
}

async function assertProcessedModeFourLayerConservation() {
  const root = '/tmp/driftstone_portable_processed_mode_v1';
  const outDir = join(root, 'out');
  await rm(root, { recursive: true, force: true });
  const fixture = await writeProcessedCliFixture(root);
  await runNodeOk(processedCliArgs(fixture, outDir), process.cwd());
  const artifacts = await readJsonl(join(outDir, 'portable_memory_artifacts_v1.jsonl'));
  const rejected = await readJsonl(join(outDir, 'portable_memory_rejected_v1.jsonl'));
  const ledger = JSON.parse(await readFile(
    join(outDir, 'portable_memory_conservation_v1.json'),
    'utf8'
  ));
  assert.equal(
    (await readdir(outDir)).includes('portable_notion_projections_v1.jsonl'),
    false
  );
  assert.equal(
    (await readdir(outDir)).includes('portable_markdown_projections_v1.jsonl'),
    false
  );
  assert.equal(artifacts.length, 3);
  assert.equal(rejected.length, 2);
  assert.deepEqual(
    rejected.map((row) => row.rejection_code).sort(),
    ['processed_workbench_without_reviewed_row', 'source_index_anchor_orphan']
  );
  assert.equal(ledger.input_mode, 'processed');
  assert.equal(ledger.input_rows, 5);
  assert.equal(ledger.row_conservation_passed, true);
  assert.equal(ledger.historical_case_candidates, 0);
  assert.equal(ledger.source_join.workbench_without_reviewed.length, 1);
  assert.equal(ledger.source_join.source_index_anchor_without_workbench.length, 1);
  assert.deepEqual(ledger.source_join.orphan_prepared_chunk_ids, ['chunk-orphan']);
  assert.equal(ledger.source_join.raw_chat_files_read, 0);
  assert.equal(ledger.source_join.raw_input_boundary_enforced, true);
  assert.equal(ledger.source_join.direct_destination_writes, 0);
  assert.equal(ledger.source_join.prepared_text_bodies_copied, 0);
  assert.equal(ledger.source_join.portable_source_unit_conservation.passed, true);
  assert.equal(ledger.source_join.auxiliary_row_conservation.all_layers_passed, true);
  assert.equal((await stat(outDir)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(outDir, 'portable_memory_artifacts_v1.jsonl'))).mode & 0o777,
    0o600
  );
  const sql = artifacts.find((row) => (
    row.source_identity.source_entry_id === 'processed-sql-1'
  ));
  const generic = artifacts.find((row) => (
    row.source_identity.source_entry_id === 'processed-sql-generic'
  ));
  const persona = artifacts.find((row) => (
    row.source_identity.source_entry_id === 'processed-persona-1'
  ));
  assert.equal(
    sql.content.atomic_fact.status,
    'present_from_structured_sql_card_master_text'
  );
  assert.equal(sql.content.atomic_fact.primary_source_field, 'reviewed_row.text');
  assert.equal(
    sql.content.atomic_fact.primary_text,
    'The synthetic archive keeps a blue gate.'
  );
  assert.equal(
    sql.upstream_payloads.workbench_records[0].decision,
    'Keep the exact SQL decision field.'
  );
  assert.equal(sql.upstream_payloads.source_index_anchors.length, 1);
  assert.equal(sql.upstream_payloads.source_index_topics.length, 1);
  assert.deepEqual(
    sql.source_identity.memory_taxonomy_topic_ids,
    ['memory-topic-1', 'source-topic-1']
  );
  assert.deepEqual(sql.source_identity.source_index_topic_ids, ['source-topic-1']);
  assert.equal(Object.hasOwn(sql.source_identity, 'source_topic_ids'), false);
  assert.equal(sql.upstream_payloads.prepared_windows.length, 1);
  assert.equal(Object.hasOwn(sql.upstream_payloads.prepared_windows[0], 'text'), false);
  assert.equal(
    sql.upstream_payloads.prepared_windows[0]
      .prepared_text_binding
      .copied_to_portable_artifact,
    false
  );
  assert.equal(generic.content.atomic_fact.status, 'missing');
  assert.equal(generic.content.atomic_fact.primary_text, '');
  assert.ok(generic.missing_fields.includes('content.atomic_fact.primary_text'));
  assert.equal(generic.artifact_state, 'review_only_missing_fields');
  assert.equal(
    persona.content.atomic_fact.status,
    'not_applicable_to_persona_lane'
  );
  assert.equal(persona.upstream_payloads.workbench_records[0].content_text, (
    'Synthetic persona card content.'
  ));
  assert.equal(
    artifacts.every((row) => (
      row.case_extraction_status === 'not_applicable_by_owner_decision'
      && row.safety.writes_home === false
      && row.safety.writes_notion === false
      && row.safety.writes_hippocove === false
    )),
    true
  );

  const mixedMode = await runNodeResult([
    ...processedCliArgs(fixture, join(root, 'mixed')),
    '--source-dir', root
  ], process.cwd());
  assert.notEqual(mixedMode.code, 0);
  assert.match(mixedMode.stderr, /input_mode_mixed/u);

  const rawDir = join(root, '00_bundle_raw');
  await mkdir(rawDir, { recursive: true });
  const rawNamedPrepared = join(rawDir, 'synthetic-raw.json');
  await writeFile(
    rawNamedPrepared,
    await readFile(fixture.preparedFile, 'utf8'),
    'utf8'
  );
  const rawInput = await runNodeResult(processedCliArgs(
    { ...fixture, preparedFile: rawNamedPrepared },
    join(root, 'raw-input')
  ), process.cwd());
  assert.notEqual(rawInput.code, 0);
  assert.match(rawInput.stderr, /raw_chat_input_forbidden/u);

  const wrongShapePrepared = join(root, 'wrong-shape-prepared.json');
  await writeFile(
    wrongShapePrepared,
    `${JSON.stringify([{ role: 'user', content: 'Synthetic raw-shaped row.' }])}\n`,
    'utf8'
  );
  const wrongShape = await runNodeResult(processedCliArgs(
    { ...fixture, preparedFile: wrongShapePrepared },
    join(root, 'wrong-shape')
  ), process.cwd());
  assert.notEqual(wrongShape.code, 0);
  assert.match(wrongShape.stderr, /processed_prepared_shape_invalid/u);
}

async function main() {
  assertPersonaLosslessAndLabelAudit();
  assertDomainNeutralStructuredFact();
  assertTruthConflictsAndMissingAreRejected();
  assertNonJsonFailsClosed();
  assertNoForgedAuthorityOrEdges();
  assertProjectionContentBindingAndCanonicalExport();
  assertTemporalCoverage();
  await assertThinCliJoinLedgerAndGeneration();
  await assertCliDuplicateHeaderAndInvalidJsonFailClosed();
  await assertProcessedModeFourLayerConservation();
  console.log(JSON.stringify({
    ok: true,
    checks: 10,
    assertions: [
      'lossless_payload_label_audit_and_unknown_label_conservation',
      'domain_neutral_structured_atomic_fact_only',
      'layer_month_case_override_conflicts_rejected',
      'non_json_values_fail_closed',
      'no_forged_authority_edge_episode_or_receipt',
      'projection_content_binding_and_canonical_jsonl_export',
      'month_x_observed_type_conservation',
      'full_trace_span_join_orphan_ledger_and_generation_replace',
      'duplicate_csv_header_and_invalid_json_cli_fail_closed',
      'explicit_processed_mode_four_layer_conservation_and_sql_card_master_fact'
    ],
    writes_any_destination: false
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.stack || error || 'unknown error'),
    writes_any_destination: false
  }, null, 2));
  process.exitCode = 1;
});
