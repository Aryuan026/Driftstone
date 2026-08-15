import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildPortableWarmBundle, inspectPortableWarmBundle } from '../core/portable-warm-bundle-builder.js';
import { validatePortableWarmBundle } from '../core/portable-warm-bundle-contract.js';

function buildGrowthDraftArtifact(overrides = {}) {
  return {
    artifact_id: 'memo_synthetic_001',
    logical_candidate_id: 'warm_logic_synthetic_001',
    generated_at: '2026-08-15T00:00:00.000Z',
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    task: {},
    draft: {
      decision: 'new',
      frontmatter: {
        title: 'Synthetic warm memory'
      },
      body: {
        snapshot: 'A bounded synthetic scene is remembered with enough warmth to review.',
        context: 'The scene matters because it keeps a concrete feeling attached to the trace.',
        follow_up: ['Use only when the synthetic test asks for this card.']
      },
      source_review: {
        primary_evidence: {
          source_scene_snippets: [
            {
              source_bundle_id: 'bundle_001',
              file: 'synthetic-source.json',
              source_window_title: 'Synthetic window',
              source_msg_range: '12-13',
              speaker: 'assistant',
              excerpt_text: 'This is the exact bounded synthetic source quote.'
            }
          ]
        }
      }
    },
    ...overrides
  };
}

test('builder emits a valid bundle from source-bounded growth drafts', () => {
  const bundle = buildPortableWarmBundle({
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    generatedAt: '2026-08-15T00:00:00.000Z',
    growthDraftArtifacts: [buildGrowthDraftArtifact()]
  });
  const validation = validatePortableWarmBundle(bundle);
  assert.equal(validation.ok, true);
  assert.equal(bundle.warm_cards.length, 1);
  assert.equal(bundle.source_occurrences.length, 1);
  assert.equal(bundle.source_spans.length, 1);
  assert.equal(bundle.hold_ledger.length, 0);
  assert.equal(bundle.warm_cards[0].source_refs.source_span_ids[0], bundle.source_spans[0].source_span_id);
  assert.equal(bundle.source_spans[0].excerpt_text, 'This is the exact bounded synthetic source quote.');
  assert.equal(bundle.warm_cards[0].home_import_policy.direct_write_allowed, false);
});

test('builder keeps candidate_id stable across title and body edits', () => {
  const first = buildPortableWarmBundle({
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    generatedAt: '2026-08-15T00:00:00.000Z',
    growthDraftArtifacts: [buildGrowthDraftArtifact()]
  });
  const second = buildPortableWarmBundle({
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    generatedAt: '2026-08-15T00:00:00.000Z',
    growthDraftArtifacts: [
      buildGrowthDraftArtifact({
        artifact_id: 'memo_synthetic_002',
        draft: {
          ...buildGrowthDraftArtifact().draft,
          frontmatter: {
            title: 'Synthetic warm memory, edited title'
          },
          body: {
            ...buildGrowthDraftArtifact().draft.body,
            snapshot: 'The same synthetic artifact has an edited living fragment.'
          }
        }
      })
    ]
  });

  assert.equal(validatePortableWarmBundle(first).ok, true);
  assert.equal(validatePortableWarmBundle(second).ok, true);
  assert.equal(first.warm_cards[0].candidate_id, second.warm_cards[0].candidate_id);
  assert.notEqual(first.manifest.manifest_digest, second.manifest.manifest_digest);
});

test('builder keeps candidate_id stable across per-run task ids when source lineage matches', () => {
  const firstArtifact = buildGrowthDraftArtifact({
    artifact_id: 'memo_synthetic_run_001',
    task: {
      task_id: 'run_specific_task_one',
      card_type: 'memo',
      family_id: 'synthetic-family'
    }
  });
  const secondArtifact = buildGrowthDraftArtifact({
    artifact_id: 'memo_synthetic_run_002',
    task: {
      task_id: 'run_specific_task_two',
      card_type: 'memo',
      family_id: 'synthetic-family'
    }
  });
  delete firstArtifact.logical_candidate_id;
  delete secondArtifact.logical_candidate_id;

  const first = buildPortableWarmBundle({
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    generatedAt: '2026-08-15T00:00:00.000Z',
    growthDraftArtifacts: [firstArtifact]
  });
  const second = buildPortableWarmBundle({
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    generatedAt: '2026-08-15T00:00:00.000Z',
    growthDraftArtifacts: [secondArtifact]
  });

  assert.equal(validatePortableWarmBundle(first).ok, true);
  assert.equal(validatePortableWarmBundle(second).ok, true);
  assert.equal(first.warm_cards[0].candidate_id, second.warm_cards[0].candidate_id);
});

test('builder rejects growth drafts without stable candidate identity', () => {
  const artifact = buildGrowthDraftArtifact();
  delete artifact.artifact_id;
  delete artifact.logical_candidate_id;
  artifact.draft.source_review.primary_evidence.source_scene_snippets = [];
  const bundle = buildPortableWarmBundle({
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    generatedAt: '2026-08-15T00:00:00.000Z',
    growthDraftArtifacts: [artifact]
  });
  const validation = validatePortableWarmBundle(bundle);
  assert.equal(validation.ok, true);
  assert.equal(bundle.warm_cards.length, 0);
  assert.equal(bundle.rejected_ledger.length, 1);
  assert.equal(bundle.rejected_ledger[0].reason, 'missing_stable_candidate_identity');
});

test('builder sanitizes source_file before it enters the canonical bundle', () => {
  const privateSources = [
    { source: '/Users/alice/private/history.jsonl', label: 'history.jsonl' },
    { source: '/home/alice/private/history.jsonl', label: 'history.jsonl' },
    { source: 'C:\\Users\\Alice\\private\\history.jsonl', label: 'history.jsonl' },
    { source: '\\\\server\\share\\private\\history.jsonl', label: 'history.jsonl' }
  ];
  for (const item of privateSources) {
    const artifact = buildGrowthDraftArtifact();
    artifact.draft.source_review.primary_evidence.source_scene_snippets[0].file = item.source;
    const bundle = buildPortableWarmBundle({
      scope: {
        owner_id: 'owner',
        realm_id: 'realm'
      },
      generatedAt: '2026-08-15T00:00:00.000Z',
      growthDraftArtifacts: [artifact]
    });
    const body = JSON.stringify(bundle);
    assert.equal(validatePortableWarmBundle(bundle).ok, true);
    assert.equal(bundle.source_occurrences[0].source_file, item.label);
    assert.match(bundle.source_occurrences[0].source_file_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(body.includes('/Users/alice'), false);
    assert.equal(body.includes('/home/alice'), false);
    assert.equal(body.includes('C:\\Users\\Alice'), false);
    assert.equal(body.includes('\\\\server\\share'), false);
  }
});

test('builder holds growth drafts without bounded source spans', () => {
  const bundle = buildPortableWarmBundle({
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    generatedAt: '2026-08-15T00:00:00.000Z',
    growthDraftArtifacts: [
      buildGrowthDraftArtifact({
        draft: {
          decision: 'new',
          frontmatter: {
            title: 'Source incomplete card'
          },
          body: {
            snapshot: 'This card has text but no bounded source evidence.'
          },
          source_review: {
            primary_evidence: {
              source_scene_snippets: [
                {
                  source_window_title: 'Synthetic window',
                  excerpt_text: 'Unbounded quote has no turn range.'
                }
              ]
            }
          }
        }
      })
    ]
  });
  const validation = validatePortableWarmBundle(bundle);
  assert.equal(validation.ok, true);
  assert.equal(bundle.warm_cards.length, 0);
  assert.equal(bundle.hold_ledger.length, 1);
  assert.equal(bundle.hold_ledger[0].reason, 'missing_bounded_source_span');
  assert.equal(bundle.conservation.input_growth_draft_rows, 1);
  assert.equal(bundle.conservation.hold_rows, 1);
});

test('builder holds mixed source quality instead of publishing contradictory completeness', () => {
  const mixedArtifact = buildGrowthDraftArtifact({
    draft: {
      decision: 'new',
      frontmatter: {
        title: 'Mixed source card'
      },
      body: {
        snapshot: 'This card mixes one bounded source and one incomplete source.'
      },
      source_review: {
        primary_evidence: {
          source_scene_snippets: [
            {
              source_bundle_id: 'bundle_001',
              file: 'synthetic-source.json',
              source_window_title: 'Synthetic window',
              source_msg_range: '12-13',
              speaker: 'assistant',
              excerpt_text: 'This exact source quote is bounded.'
            },
            {
              source_bundle_id: 'bundle_001',
              file: 'synthetic-source.json',
              source_window_title: 'Synthetic window',
              speaker: 'assistant',
              excerpt_text: 'This source quote has no turn range.'
            }
          ]
        }
      }
    }
  });
  const bundle = buildPortableWarmBundle({
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    generatedAt: '2026-08-15T00:00:00.000Z',
    growthDraftArtifacts: [mixedArtifact]
  });
  const validation = validatePortableWarmBundle(bundle);
  assert.equal(validation.ok, true);
  assert.equal(bundle.warm_cards.length, 0);
  assert.equal(bundle.hold_ledger.length, 1);
  assert.equal(bundle.hold_ledger[0].reason, 'mixed_source_quality_requires_review');
});

test('builder keeps reviewed entries as HOLD until source spans are recoverable', () => {
  const bundle = buildPortableWarmBundle({
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    generatedAt: '2026-08-15T00:00:00.000Z',
    reviewedPacket: {
      finalized_entries: [
        {
          anchor_type: 'person',
          canonical_name: 'Synthetic reviewed row',
          stable_facts: ['Reviewed rows alone do not prove exact source spans.']
        }
      ]
    }
  });
  const validation = validatePortableWarmBundle(bundle);
  assert.equal(validation.ok, true);
  assert.equal(bundle.warm_cards.length, 0);
  assert.equal(bundle.hold_ledger.length, 1);
  assert.equal(bundle.hold_ledger[0].reason, 'reviewed_entry_missing_bounded_source_span');
  assert.equal(bundle.conservation.input_reviewed_rows, 1);
});

test('inspector summarizes a local bundle without writing projection targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftstone-bundle-inspect-'));
  try {
    const bundle = buildPortableWarmBundle({
      scope: {
        owner_id: 'owner',
        realm_id: 'realm'
      },
      generatedAt: '2026-08-15T00:00:00.000Z',
      growthDraftArtifacts: [buildGrowthDraftArtifact()]
    });
    const bundlePath = join(dir, 'portable_warm_bundle.json');
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

    const inspection = await inspectPortableWarmBundle({
      bundleDir: dir
    });

    assert.equal(inspection.ok, true);
    assert.equal(inspection.schema, 'driftstone_portable_warm_bundle_inspection_v0');
    assert.equal(inspection.artifact_status, 'valid_bundle');
    assert.equal(inspection.projection_readiness, 'ready');
    assert.equal(inspection.counts.warm_cards, 1);
    assert.equal(inspection.source_reliability.source_complete, true);
    assert.equal(inspection.source_reliability.bounded_source_spans, 1);
    const inspectionText = JSON.stringify(inspection);
    assert.equal(inspectionText.includes('This is the exact bounded synthetic source quote.'), false);
    assert.equal(inspectionText.includes('A bounded synthetic scene is remembered'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('inspector fails closed for unreadable or malformed bundle files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftstone-bundle-bad-'));
  try {
    const bundlePath = join(dir, 'portable_warm_bundle.json');
    await writeFile(bundlePath, '{not json}\n', 'utf8');

    const inspection = await inspectPortableWarmBundle({
      bundlePath
    });

    assert.equal(inspection.ok, false);
    assert.equal(inspection.artifact_status, 'unreadable_bundle');
    assert.equal(inspection.projection_readiness, 'blocked_by_read_error');
    assert.match(inspection.error.message, /JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('inspector fails closed when no bundle reference is provided', async () => {
  const inspection = await inspectPortableWarmBundle();
  assert.equal(inspection.ok, false);
  assert.equal(inspection.artifact_status, 'missing_bundle_reference');
  assert.equal(inspection.projection_readiness, 'blocked_by_input_error');
});

test('inspector reports a valid empty bundle as nothing to project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftstone-bundle-empty-'));
  try {
    const bundle = buildPortableWarmBundle({
      scope: {
        owner_id: 'owner',
        realm_id: 'realm'
      },
      generatedAt: '2026-08-15T00:00:00.000Z'
    });
    const bundlePath = join(dir, 'portable_warm_bundle.json');
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

    const inspection = await inspectPortableWarmBundle({
      bundlePath
    });

    assert.equal(inspection.ok, true);
    assert.equal(inspection.artifact_status, 'valid_empty_bundle');
    assert.equal(inspection.projection_readiness, 'nothing_to_project');
    assert.equal(inspection.counts.accepted_rows, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
