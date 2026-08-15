import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPortableWarmBundle } from '../core/portable-warm-bundle-builder.js';
import { validatePortableWarmBundle } from '../core/portable-warm-bundle-contract.js';

function buildGrowthDraftArtifact(overrides = {}) {
  return {
    artifact_id: 'memo_synthetic_001',
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
