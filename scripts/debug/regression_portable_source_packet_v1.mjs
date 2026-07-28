#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BOUNDED_PROJECTION_SCHEMA,
  HUMAN_DECISIONS_SCHEMA,
  PORTABLE_SOURCE_CANDIDATE_SCHEMA,
  PORTABLE_SOURCE_PACKET_SCHEMA,
  buildBoundedProjection,
  buildPortableSourcePacket,
  parseFactKeysFull,
  parseTagsFull,
  sha256,
  verifyPortableSourceCandidate,
  verifyPortableSourcePacket
} from '../lib/driftstone-portable-source-packet-v1.mjs';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const cli = join(repoRoot, 'scripts/debug/build_portable_source_packet_v1.mjs');
let checks = 0;

function ok(value, message) {
  assert.ok(value, message);
  checks += 1;
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function renderCsv(rows) {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))
  ].join('\n') + '\n';
}

function waitForChild(child) {
  return new Promise((resolveChild) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolveChild({ status, stdout, stderr }));
  });
}

async function waitForDirectoryEntry(parent, predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const names = await readdir(parent);
    const matched = names.find(predicate);
    if (matched) return matched;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error('Timed out waiting for publisher fault-injection checkpoint.');
}

function syntheticInputs() {
  const tags = Array.from({ length: 30 }, (_, index) => `#tag_${String(index + 1).padStart(2, '0')}`);
  const facts = Array.from({ length: 70 }, (_, index) => `fact_${String(index + 1).padStart(2, '0')}`);
  const rawBundles = [{
    id: 'bundle-2025-03',
    month: '2025-03',
    source_bundle_id: 'src.2025-03.bundle',
    source_manifest_kind: 'month_bundle',
    messages: [
      { role: 'user', content: 'synthetic one', source_msg_index: 0, source_window_id: 'w1', ts: '2025-03-01T00:00:00Z' },
      { role: 'assistant', content: 'synthetic two', source_msg_index: 1, source_window_id: 'w1', ts: '2025-03-01T00:01:00Z' },
      { role: 'user', content: 'synthetic three', source_msg_index: 2, source_window_id: 'w1', ts: '2025-03-01T00:02:00Z' },
      { role: 'assistant', content: 'synthetic unaccounted', source_msg_index: 3, source_window_id: 'w1', ts: '2025-03-01T00:03:00Z' }
    ]
  }];
  const preparedRows = [
    {
      chunk_id: 'chunk-1',
      source_bundle_id: 'src.2025-03.bundle',
      source_manifest_kind: 'month_bundle',
      source_window_id: 'w1',
      source_msg_start: 0,
      source_msg_end: 2,
      text: 'synthetic prepared text'
    },
    {
      chunk_id: 'chunk-unused',
      source_bundle_id: 'src.2025-03.bundle',
      source_manifest_kind: 'month_bundle',
      source_window_id: 'w1',
      source_msg_start: 90,
      source_msg_end: 91,
      text: 'synthetic unused prepared text'
    }
  ];
  const workbenchRows = [
    {
      record_id: 'record-persona',
      layer: 'persona',
      title: 'Synthetic persona',
      text: 'Synthetic candidate body',
      tags: tags.join(' '),
      fact_keys: facts.join('|'),
      chunk_id: 'chunk-1',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 0,
      source_msg_end: 1
    },
    {
      record_id: 'record-incomplete',
      layer: 'sql',
      title: 'Synthetic incomplete fact',
      text: 'Synthetic incomplete candidate body',
      fact_keys: 'incomplete_key',
      chunk_id: 'chunk-missing',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 10,
      source_msg_end: 11
    },
    {
      record_id: 'record-zero-review',
      layer: 'sql',
      title: 'Synthetic no review',
      text: 'Synthetic no review body',
      fact_keys: 'zero_review_key',
      chunk_id: 'chunk-1',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 2,
      source_msg_end: 2
    },
    {
      record_id: 'record-case',
      layer: 'case',
      title: 'Synthetic forbidden historical case',
      text: 'Synthetic case body',
      chunk_id: 'chunk-1',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 1,
      source_msg_end: 1
    }
  ];
  const anchors = [
    ...workbenchRows.map((row, index) => ({
      record_id: row.record_id,
      layer: row.layer,
      anchor_id: `anchor-${index + 1}`,
      chunk_id: row.chunk_id,
      source_bundle_id: row.source_bundle_id,
      source_window_id: row.source_window_id,
      // source_msg_* is the source-ref message namespace. Zero is an
      // upstream unknown sentinel, so the synthetic positive path starts at
      // the next resolvable source message while chunk_msg_* retains the
      // workbench-local range.
      source_msg_start: row.record_id === 'record-persona' ? 1 : row.source_msg_start,
      source_msg_end: row.record_id === 'record-persona' ? 1 : row.source_msg_end,
      chunk_msg_start: row.source_msg_start,
      chunk_msg_end: row.source_msg_end,
      topic_ids: 'topic-1'
    })),
    {
      record_id: 'record-anchor-orphan',
      layer: 'persona',
      anchor_id: 'anchor-orphan',
      chunk_id: 'chunk-unused',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 90,
      source_msg_end: 91,
      chunk_msg_start: 90,
      chunk_msg_end: 91
    }
  ];
  const sourceIndex = {
    kind: 'synthetic_source_index',
    mode: 'test',
    anchors,
    source_topic_index: [{
      topic_id: 'topic-1',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 0,
      source_msg_end: 2
    }]
  };
  const reviewedRows = [
    {
      record_id: 'record-persona',
      layer: 'persona',
      title: 'Synthetic persona review A',
      text: 'Synthetic reviewed body A',
      tags: tags.join(' '),
      fact_keys: facts.join('|'),
      chunk_id: 'chunk-1',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 0,
      source_msg_end: 1,
      review_status: 'reviewed'
    },
    {
      record_id: 'record-persona',
      layer: 'persona',
      title: 'Synthetic persona review B',
      text: 'Synthetic reviewed body B',
      tags: '#second_review',
      fact_keys: 'second_review_key',
      chunk_id: 'chunk-1',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 0,
      source_msg_end: 1,
      review_status: 'reviewed'
    },
    {
      record_id: 'record-incomplete',
      layer: 'sql',
      title: 'Synthetic incomplete review',
      text: 'Synthetic incomplete reviewed body',
      fact_keys: 'incomplete_key',
      chunk_id: 'chunk-missing',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 10,
      source_msg_end: 11,
      review_status: 'reviewed'
    },
    {
      record_id: 'record-case',
      layer: 'case',
      title: 'Synthetic case review',
      text: 'Synthetic case reviewed body',
      chunk_id: 'chunk-1',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 1,
      source_msg_end: 1,
      review_status: 'reviewed'
    },
    {
      record_id: 'record-reviewed-orphan',
      layer: 'persona',
      title: 'Synthetic reviewed orphan',
      text: 'Synthetic orphan body',
      chunk_id: 'chunk-unused',
      source_bundle_id: 'src.2025-03.bundle',
      source_window_id: 'w1',
      source_msg_start: 90,
      source_msg_end: 91,
      review_status: 'reviewed'
    }
  ];
  const fiveLayerManifest = {
    schema: 'driftstone_five_layer_source_manifest_v1',
    month_key: '2025-03',
    layer_count: 5,
    layers: {
      raw: { sha256: sha256(rawBundles), detected_schema: { message_rows: 4 } },
      prepared: { sha256: sha256(preparedRows), detected_schema: { row_count: 2 } },
      workbench: { sha256: sha256(workbenchRows), detected_schema: { row_count: 4 } },
      source_index: { sha256: sha256(sourceIndex), detected_schema: { anchor_rows: 5 } },
      reviewed: { sha256: sha256(reviewedRows), detected_schema: { row_count: 5 } }
    }
  };
  return {
    tags,
    facts,
    rawBundles,
    preparedRows,
    workbenchRows,
    sourceIndex,
    reviewedRows,
    fiveLayerManifest
  };
}

const fixture = syntheticInputs();
equal(parseFactKeysFull(fixture.facts.join('|')).length, 70, 'Full fact-key parser must not stop at 64.');
equal(parseTagsFull(fixture.tags.join(' ')).length, 30, 'Full tag parser must not stop at 24.');
equal(
  parseTagsFull('#alpha, beta|#gamma plain'),
  ['#alpha', 'beta', '#gamma', 'plain'],
  'Mixed tag delimiters must not switch into a hashtags-only lossy mode.'
);

const built = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows,
  workbenchRows: fixture.workbenchRows,
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows
});
equal(built.packet.schema, PORTABLE_SOURCE_PACKET_SCHEMA);
ok(verifyPortableSourcePacket(built.packet), 'Packet digest must verify.');
equal(built.packet.lane_contract.historical_case_candidates, 0);
equal(
  built.packet.lane_contract.historical_case_extraction_status,
  'not_applicable_by_owner_decision'
);
equal(built.candidates.length, 3, 'Case input must not become a historical CASE candidate.');
ok(
  built.rejected.some((row) => row.code === 'historical_case_not_applicable_by_owner_decision'),
  'Explicit historical CASE input must be preserved as a rejection, not reconstructed.'
);

const personaCandidate = built.candidates.find(
  (candidate) => candidate.upstream.workbench_row.record_id === 'record-persona'
);
equal(personaCandidate.schema, PORTABLE_SOURCE_CANDIDATE_SCHEMA);
ok(verifyPortableSourceCandidate(personaCandidate), 'Candidate digest must verify.');
equal(personaCandidate.upstream.reviewed_rows.length, 2, 'Zero-to-many reviewed mapping must preserve both rows.');
equal(personaCandidate.canonical_labels.fact_keys.length, 71, 'Canonical facts preserve all 70 plus the second review key.');
equal(personaCandidate.canonical_labels.tags.length, 31, 'Canonical tags preserve all 30 plus the second review tag.');
equal(personaCandidate.canonical_labels.canonical_fact_key_limit, null);
equal(personaCandidate.canonical_labels.canonical_tag_limit, null);
equal(personaCandidate.graph_hints.hippocove_pre_admission_required, true);
equal(personaCandidate.graph_hints.canonical_edges_created, 0);
equal(personaCandidate.graph_hints.canonical_authority_granted, false);
ok(personaCandidate.graph_hints.review.upstream_structured_states.includes('reviewed'));
equal(personaCandidate.graph_hints.authority.direct_canonical_authority, false);

const bounded = buildBoundedProjection(personaCandidate);
equal(bounded.schema, BOUNDED_PROJECTION_SCHEMA);
equal(bounded.runtime_atomic_fact_keys.retained_count, 64);
equal(bounded.runtime_atomic_fact_keys.omitted_count, 7);
equal(bounded.runtime_atomic_fact_keys.truncated, true);
equal(bounded.notion_tags.retained_count, 24);
equal(bounded.notion_tags.omitted_count, 7);
equal(bounded.notion_tags.truncated, true);
equal(bounded.safety.silent_truncation_allowed, false);

equal(built.packet.conservation.raw_to_prepared.raw_messages, 4);
equal(built.packet.conservation.raw_to_prepared.covered_by_prepared, 3);
equal(built.packet.conservation.raw_to_prepared.not_covered_pending_review, 1);
equal(built.packet.conservation.raw_to_prepared.missing_messages_called_lost, false);
equal(
  built.rawDisposition.find((row) => row.source_identity.source_msg_index === 3).human_review.state,
  'pending_human_disposition'
);
equal(
  built.packet.conservation.workbench_to_reviewed.with_zero_reviewed_rows_pending_review,
  1
);
equal(
  built.workbenchReviewLedger.find((row) => row.record_id === 'record-persona').reviewed_match_count,
  2
);
equal(
  built.workbenchReviewLedger.find((row) => row.record_id === 'record-zero-review').conservation_state,
  'zero_reviewed_rows_pending_review'
);

const incomplete = built.candidates.find(
  (candidate) => candidate.upstream.workbench_row.record_id === 'record-incomplete'
);
equal(incomplete.source_evidence.state, 'source_incomplete');
equal(incomplete.human_review.visible_choice_required, true);
equal(incomplete.human_review.source_incomplete_is_automatically_blocked, false);
equal(incomplete.human_review.eligible_for_hippocove_pre_admission, false);
ok(
  built.humanReviewQueue.some((row) => row.record_id === 'record-incomplete'),
  'Source-incomplete candidate must be human-visible.'
);

const approved = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows,
  workbenchRows: fixture.workbenchRows,
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows,
  humanDecisions: {
    schema: HUMAN_DECISIONS_SCHEMA,
    month_key: '2025-03',
    decisions: [{
      record_id: 'record-incomplete',
      decision: 'approve',
      authority: 'human_attested',
      reviewer: 'owner',
      decided_at: '2026-07-28T00:00:00Z'
    }]
  }
});
const approvedCandidate = approved.candidates.find(
  (candidate) => candidate.upstream.workbench_row.record_id === 'record-incomplete'
);
equal(approvedCandidate.human_review.state, 'human_approved_for_pre_admission');
equal(approvedCandidate.human_review.authority, 'human_attested');
equal(approvedCandidate.human_review.eligible_for_hippocove_pre_admission, true);
equal(approvedCandidate.graph_hints.authority.direct_canonical_authority, false);

const conflictingLineage = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows.map((row) => row.chunk_id === 'chunk-1'
    ? {
      ...row,
      source_bundle_id: 'src.2025-04.bundle',
      source_window_id: 'w-other',
      source_msg_start: 10,
      source_msg_end: 11
    }
    : row),
  workbenchRows: fixture.workbenchRows,
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows.map((row) => row.record_id === 'record-persona'
    ? {
      ...row,
      source_bundle_id: 'src.2025-04.bundle',
      source_window_id: 'w-other',
      source_msg_start: 10,
      source_msg_end: 11
    }
    : row)
});
const conflictingCandidate = conflictingLineage.candidates.find(
  (candidate) => candidate.upstream.workbench_row.record_id === 'record-persona'
);
equal(conflictingCandidate.source_evidence.state, 'source_incomplete');
ok(conflictingCandidate.source_evidence.incomplete_reasons.includes('cross_layer_source_bundle_conflict'));
ok(conflictingCandidate.source_evidence.incomplete_reasons.includes('cross_layer_source_window_conflict'));
ok(
  conflictingCandidate.source_evidence.incomplete_reasons.some(
    (reason) => reason.includes('source_range_conflict')
      || reason.includes('range_does_not_cover_workbench')
  )
);
equal(conflictingCandidate.graph_hints.authority.direct_canonical_authority, false);

const anchorRangeConflict = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows,
  workbenchRows: fixture.workbenchRows,
  sourceIndex: {
    ...fixture.sourceIndex,
    anchors: fixture.sourceIndex.anchors.map((row) => row.record_id === 'record-persona'
      ? { ...row, chunk_msg_start: 90, chunk_msg_end: 91 }
      : row)
  },
  reviewedRows: fixture.reviewedRows
});
const anchorConflictCandidate = anchorRangeConflict.candidates.find(
  (candidate) => candidate.upstream.workbench_row.record_id === 'record-persona'
);
equal(anchorConflictCandidate.source_evidence.state, 'source_incomplete');
ok(
  anchorConflictCandidate.source_evidence.incomplete_reasons.includes(
    'source_anchor[0]_chunk_range_conflict'
  )
);

const sourceRefOffsetInputs = {
  rawBundles: [{
    ...fixture.rawBundles[0],
    messages: [1600, 1601, 1602].map((sourceMessageIndex, index) => ({
      ...fixture.rawBundles[0].messages[index],
      source_msg_index: sourceMessageIndex
    }))
  }],
  preparedRows: [{
    ...fixture.preparedRows[0],
    source_msg_start: 1600,
    source_msg_end: 1602
  }],
  workbenchRows: [{
    ...fixture.workbenchRows[0],
    source_msg_start: 1602,
    source_msg_end: 1602
  }],
  sourceIndex: {
    ...fixture.sourceIndex,
    anchors: [{
      ...fixture.sourceIndex.anchors[0],
      source_msg_start: 1602,
      source_msg_end: 1602,
      chunk_msg_start: 1602,
      chunk_msg_end: 1602
    }]
  },
  reviewedRows: fixture.reviewedRows
    .filter((row) => row.record_id === 'record-persona')
    .map((row) => ({
      ...row,
      source_msg_start: 1602,
      source_msg_end: 1602
    }))
};
const sourceRefOffset = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  ...sourceRefOffsetInputs
});
const sourceRefOffsetCandidate = sourceRefOffset.candidates[0];
equal(
  sourceRefOffsetCandidate.source_evidence.state,
  'source_bound',
  'Anchor source-ref index must resolve independently of its raw array ordinal.'
);
equal(
  sourceRefOffsetCandidate.source_evidence.raw_message_count,
  1,
  'Candidate exact evidence must use its narrow workbench span, not union the prepared context.'
);
equal(
  sourceRefOffsetCandidate.graph_hints.trace.raw_message_refs.length,
  1,
  'Graph exact raw refs must exclude wider prepared context messages.'
);
equal(
  sourceRefOffsetCandidate.graph_hints.span.candidate_window_local_msg_ranges,
  ['1602-1602']
);
equal(
  sourceRefOffsetCandidate.graph_hints.span.prepared_context_window_local_msg_ranges,
  ['1600-1602']
);
equal(
  sourceRefOffset.packet.conservation.raw_to_prepared.covered_by_prepared,
  3,
  'Prepared coverage conservation must keep the full context window.'
);
ok(
  !sourceRefOffsetCandidate.source_evidence.incomplete_reasons.includes(
    'source_anchor[0]_raw_source_range_unresolved'
  ),
  'A raw source_msg_index of 1602 must resolve even when message_ordinal is zero.'
);
equal(
  sourceRefOffsetCandidate.graph_hints.span.anchor_source_ref_msg_ranges,
  ['1602-1602']
);

const unknownAnchorRange = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows,
  workbenchRows: fixture.workbenchRows,
  sourceIndex: {
    ...fixture.sourceIndex,
    anchors: fixture.sourceIndex.anchors.map((row) => row.record_id === 'record-persona'
      ? { ...row, source_msg_start: 0, source_msg_end: 0 }
      : row)
  },
  reviewedRows: fixture.reviewedRows
});
const unknownAnchorCandidate = unknownAnchorRange.candidates.find(
  (candidate) => candidate.upstream.workbench_row.record_id === 'record-persona'
);
equal(unknownAnchorCandidate.source_evidence.state, 'source_incomplete');
ok(
  unknownAnchorCandidate.source_evidence.incomplete_reasons.includes(
    'source_anchor[0]_source_range_unknown'
  ),
  'Anchor 0/0 is an unknown sentinel and must not resolve via raw ordinal zero.'
);
equal(
  unknownAnchorCandidate.graph_hints.span.anchor_source_ref_msg_ranges,
  [],
  'Unknown anchor ranges must not be emitted as graph expansion hints.'
);

const reviewedEvidenceMissing = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows,
  workbenchRows: fixture.workbenchRows,
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows.map((row) => {
    if (row.record_id !== 'record-persona') return row;
    const copy = { ...row };
    delete copy.source_bundle_id;
    delete copy.source_window_id;
    delete copy.source_msg_start;
    delete copy.source_msg_end;
    return copy;
  })
});
const missingReviewedEvidenceCandidate = reviewedEvidenceMissing.candidates.find(
  (candidate) => candidate.upstream.workbench_row.record_id === 'record-persona'
);
equal(missingReviewedEvidenceCandidate.source_evidence.state, 'source_incomplete');
ok(
  missingReviewedEvidenceCandidate.source_evidence.incomplete_reasons.includes(
    'reviewed[0]_source_bundle_missing'
  )
);
ok(
  missingReviewedEvidenceCandidate.source_evidence.incomplete_reasons.includes(
    'reviewed[0]_source_range_missing'
  )
);

const rawWindowMissing = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles.map((bundle) => ({
    ...bundle,
    messages: bundle.messages.map((message) => {
      const copy = { ...message };
      delete copy.source_window_id;
      return copy;
    })
  })),
  preparedRows: fixture.preparedRows,
  workbenchRows: fixture.workbenchRows,
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows
});
const rawWindowMissingCandidate = rawWindowMissing.candidates.find(
  (candidate) => candidate.upstream.workbench_row.record_id === 'record-persona'
);
equal(rawWindowMissingCandidate.source_evidence.state, 'source_incomplete');
equal(rawWindowMissingCandidate.source_evidence.raw_span_state, 'source_range_unresolved');

assert.throws(() => buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows,
  workbenchRows: fixture.workbenchRows,
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows,
  humanDecisions: {
    schema: HUMAN_DECISIONS_SCHEMA,
    month_key: '2025-03',
    decisions: [{
      record_id: 'record-incomplete',
      decision: 'approve',
      authority: 'source_bound'
    }]
  }
}), (error) => error?.code === 'human_decision_authority_invalid');
checks += 1;

assert.throws(() => buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows,
  workbenchRows: [
    fixture.workbenchRows[0],
    { ...fixture.workbenchRows[0], title: 'Duplicate workbench identity' }
  ],
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows
}), (error) => error?.code === 'workbench_record_id_ambiguous');
checks += 1;

assert.throws(() => buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: [
    fixture.preparedRows[0],
    { ...fixture.preparedRows[0], source_window_id: 'ambiguous-window' }
  ],
  workbenchRows: fixture.workbenchRows,
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows
}), (error) => error?.code === 'prepared_chunk_id_ambiguous');
checks += 1;

const canaryOne = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows,
  workbenchRows: fixture.workbenchRows,
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows,
  sampleLimit: 2
});
const canaryTwo = buildPortableSourcePacket({
  monthKey: '2025-03',
  fiveLayerManifest: fixture.fiveLayerManifest,
  rawBundles: fixture.rawBundles,
  preparedRows: fixture.preparedRows,
  workbenchRows: fixture.workbenchRows,
  sourceIndex: fixture.sourceIndex,
  reviewedRows: fixture.reviewedRows,
  sampleLimit: 2
});
equal(canaryOne.packet.generation_profile, 'representative_canary');
equal(canaryOne.candidates.length, 2);
equal(
  canaryOne.candidates.map((candidate) => candidate.candidate_id),
  canaryTwo.candidates.map((candidate) => candidate.candidate_id),
  'Canary sampling must be deterministic.'
);
equal(canaryOne.packet.candidate_counts.full_candidates_before_sampling, 3);

const temporaryRoot = await mkdtemp(join(tmpdir(), 'driftstone-source-packet-regression-'));
const rawFile = join(temporaryRoot, 'memsrc_2025-03_bundle.json');
const preparedFile = join(temporaryRoot, 'memsrc_2025-03_bundle-prepared.json');
const workbenchFile = join(temporaryRoot, 'memory-export-core_20250301_20250331-workbench.json');
const sourceIndexFile = join(temporaryRoot, 'memory-export-core_20250301_20250331-source-index.json');
const reviewedFile = join(temporaryRoot, '202503reviewed-memory-reviewed.csv');
const decisionsFile = join(temporaryRoot, 'human-decisions.json');
const outputDir = join(temporaryRoot, 'private-output');
await writeFile(rawFile, JSON.stringify(fixture.rawBundles), 'utf8');
await writeFile(preparedFile, JSON.stringify(fixture.preparedRows), 'utf8');
await writeFile(workbenchFile, JSON.stringify(fixture.workbenchRows), 'utf8');
await writeFile(sourceIndexFile, JSON.stringify(fixture.sourceIndex), 'utf8');
await writeFile(reviewedFile, renderCsv(fixture.reviewedRows), 'utf8');
await writeFile(decisionsFile, JSON.stringify({
  schema: HUMAN_DECISIONS_SCHEMA,
  month_key: '2025-03',
  decisions: [{
    record_id: 'record-incomplete',
    decision: 'approve',
    authority: 'legacy_import',
    reviewer: 'owner'
  }]
}), 'utf8');

const cliArguments = [
  cli,
  '--raw-file', rawFile,
  '--prepared-file', preparedFile,
  '--workbench-file', workbenchFile,
  '--source-index-file', sourceIndexFile,
  '--reviewed-csv', reviewedFile,
  '--human-decisions', decisionsFile,
  '--month', '2025-03',
  '--out', outputDir,
  '--canary-limit', '2'
];
const run = spawnSync(process.execPath, cliArguments, {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(run.status, 0, run.stderr || 'CLI should succeed.');
const outputPacket = JSON.parse(await readFile(join(outputDir, 'portable_source_packet_v1.json'), 'utf8'));
equal(outputPacket.five_layer_manifest.layer_count, 5);
equal(Object.keys(outputPacket.five_layer_manifest.layers).sort(), [
  'prepared',
  'raw',
  'reviewed',
  'source_index',
  'workbench'
]);
ok(
  Object.values(outputPacket.five_layer_manifest.layers).every(
    (layer) => /^[0-9a-f]{64}$/u.test(layer.sha256) && layer.byte_count > 0
  ),
  'Every source layer must carry exact bytes and checksum.'
);
equal(
  Object.keys(outputPacket.five_layer_manifest.builder_implementation).sort(),
  ['builder_cli', 'reviewed_csv_parser', 'source_packet_library'],
  'Generation identity must bind every code path that parses or builds candidates.'
);
equal(outputPacket.boundary.reruns_model_extraction, false);
equal(outputPacket.boundary.writes_home, false);
equal(outputPacket.boundary.writes_hippocove, false);
equal(outputPacket.boundary.writes_notion, false);
equal((await stat(outputDir)).mode & 0o777, 0o700);
for (const fileName of await (await import('node:fs/promises')).readdir(outputDir)) {
  equal((await stat(join(outputDir, fileName))).mode & 0o777, 0o600);
}

const rawDispositionText = await readFile(
  join(outputDir, 'portable_source_raw_disposition_v1.jsonl'),
  'utf8'
);
ok(!rawDispositionText.includes('synthetic unaccounted'), 'Raw message text must not be copied into the disposition ledger.');
ok(rawDispositionText.includes(sha256('synthetic unaccounted')), 'Raw message content hash must remain available.');

const secondRun = spawnSync(process.execPath, cliArguments, {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(secondRun.status, 1, 'Nonempty output must not be silently overwritten.');
ok(secondRun.stderr.includes('output_exists'));

const replacementRun = spawnSync(process.execPath, [...cliArguments, '--replace'], {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(replacementRun.status, 0, replacementRun.stderr || 'Exact same generation may replace its verified output.');

const outputManifestFile = join(outputDir, 'portable_source_generation_manifest_v1.json');
const weakenedManifest = JSON.parse(await readFile(outputManifestFile, 'utf8'));
delete weakenedManifest.output_files['portable_source_rejected_v1.jsonl'];
const { manifest_sha256: _oldManifestDigest, ...weakenedPayload } = weakenedManifest;
weakenedManifest.manifest_sha256 = sha256(weakenedPayload);
await writeFile(outputManifestFile, `${JSON.stringify(weakenedManifest, null, 2)}\n`, 'utf8');
const weakenedReplacement = spawnSync(process.execPath, [...cliArguments, '--replace'], {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(weakenedReplacement.status, 1);
ok(weakenedReplacement.stderr.includes('existing_generation_output_contract_mismatch'));

const wrongMonth = spawnSync(process.execPath, [
  ...cliArguments.filter((value, index, array) => (
    !(array[index - 1] === '--month') && value !== '--month'
  )),
  '--month', '2025-04',
  '--out', join(temporaryRoot, 'wrong-month-output')
], {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(wrongMonth.status, 1);
ok(wrongMonth.stderr.includes('month_truth_conflict'));

const aliasedRoleArguments = [...cliArguments];
aliasedRoleArguments[aliasedRoleArguments.indexOf('--prepared-file') + 1] = workbenchFile;
aliasedRoleArguments[aliasedRoleArguments.indexOf('--out') + 1] = join(
  temporaryRoot,
  'aliased-role-output'
);
const aliasedRoleRun = spawnSync(process.execPath, aliasedRoleArguments, {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(aliasedRoleRun.status, 1);
ok(aliasedRoleRun.stderr.includes('input_role_path_alias'));

const wrongPreparedFile = join(temporaryRoot, 'distinct-wrong-prepared.json');
await writeFile(wrongPreparedFile, JSON.stringify(fixture.workbenchRows), 'utf8');
const wrongPreparedArguments = [...cliArguments];
wrongPreparedArguments[wrongPreparedArguments.indexOf('--prepared-file') + 1] = wrongPreparedFile;
wrongPreparedArguments[wrongPreparedArguments.indexOf('--out') + 1] = join(
  temporaryRoot,
  'wrong-prepared-output'
);
const wrongPreparedRun = spawnSync(process.execPath, wrongPreparedArguments, {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(wrongPreparedRun.status, 1);
ok(wrongPreparedRun.stderr.includes('prepared_semantic_shape_invalid'));

const raceOutput = join(temporaryRoot, 'race-output');
const raceOriginal = join(temporaryRoot, 'race-output-original-concurrent');
const raceArguments = [...cliArguments];
raceArguments[raceArguments.indexOf('--out') + 1] = raceOutput;
const raceInitial = spawnSync(process.execPath, raceArguments, {
  cwd: repoRoot,
  encoding: 'utf8'
});
equal(raceInitial.status, 0, raceInitial.stderr || 'Race fixture generation should succeed.');
const raceChild = spawn(process.execPath, [...raceArguments, '--replace'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    DRIFTSTONE_SOURCE_PACKET_TEST_PUBLISH_PAUSE_MS: '500'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const raceResultPromise = waitForChild(raceChild);
await waitForDirectoryEntry(
  temporaryRoot,
  (name) => name.startsWith('.race-output.tmp-')
);
await rename(raceOutput, raceOriginal);
await mkdir(raceOutput, { mode: 0o700 });
await writeFile(join(raceOutput, 'concurrent-owner-data'), 'must survive\n', 'utf8');
const raceResult = await raceResultPromise;
equal(raceResult.status, 1, 'Concurrent replacement must fail closed.');
ok(
  raceResult.stderr.includes('existing_generation_manifest_invalid'),
  raceResult.stderr || 'Claimed concurrent directory must fail exact backup verification.'
);
equal(
  await readFile(join(raceOutput, 'concurrent-owner-data'), 'utf8'),
  'must survive\n',
  'Publisher must restore and preserve the concurrently substituted directory.'
);
ok(
  (await stat(raceOriginal)).isDirectory(),
  'The independently moved verified generation must remain untouched.'
);
const raceLeftovers = (await readdir(temporaryRoot)).filter(
  (name) => name.startsWith('.race-output.tmp-')
    || name.startsWith('.race-output.verified-backup-')
);
equal(raceLeftovers, [], 'Failed replacement must not leave owned temp/backup debris.');

console.log(JSON.stringify({
  ok: true,
  checks,
  schema: PORTABLE_SOURCE_PACKET_SCHEMA,
  reruns_model_extraction: false,
  writes_any_destination: false
}, null, 2));
