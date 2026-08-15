import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUNDLE_SCHEMA,
  buildPortableWarmBundleContractPacket,
  validatePortableWarmBundle
} from '../core/portable-warm-bundle-contract.js';

function buildValidBundle(overrides = {}) {
  return {
    schema: BUNDLE_SCHEMA,
    manifest: {
      bundle_id: 'bundle_synthetic_001',
      created_at: '2026-08-15T00:00:00.000Z',
      manifest_digest: 'sha256:synthetic'
    },
    source_manifest: {
      source_count: 1,
      source_digest: 'sha256:source'
    },
    persona_authority: {
      persona_digest: 'sha256:persona',
      language_fingerprint_digest: 'sha256:fingerprint',
      authority: 'user_supplied_optional'
    },
    warm_cards: [
      {
        candidate_id: 'warm_candidate_001',
        title: 'Synthetic card',
        archive_bucket: 'stable',
        frontend_delivery_tier: 'explicit_context_only',
        portable_warm_card: {
          body_markdown: 'Synthetic portable warm card body.',
          living_fragment: 'Synthetic scene fragment.',
          feeling_as_fact: 'Synthetic feeling fact.',
          future_use_hint: 'Use only as synthetic fixture.',
          voice_fingerprint_refs: ['sha256:fingerprint'],
          persona_refs: ['sha256:persona']
        },
        source_refs: {
          source_occurrence_ids: ['occurrence_001'],
          source_span_ids: ['span_001']
        },
        privacy: {
          local_only: true
        },
        quality: {
          source_bound: true,
          source_complete: true
        },
        home_import_policy: {
          direct_write_allowed: false,
          state: 'review_only'
        }
      }
    ],
    source_occurrences: [
      {
        source_occurrence_id: 'occurrence_001',
        source_id: 'source_001',
        source_kind: 'synthetic_fixture',
        source_file: 'synthetic.jsonl',
        source_window: 'Synthetic window',
        turn_range: '1-1',
        message_ids: ['message_001'],
        source_time: '2026-08-15T00:00:00.000Z',
        digest: 'sha256:occurrence'
      }
    ],
    source_spans: [
      {
        source_span_id: 'span_001',
        source_occurrence_id: 'occurrence_001',
        turn_range: '1-1',
        message_ids: ['message_001'],
        speaker: 'assistant',
        excerpt_text: 'Synthetic bounded excerpt.',
        excerpt_digest: 'sha256:span',
        bounds: {
          start: 0,
          end: 26
        }
      }
    ],
    rejected_ledger: [],
    hold_ledger: [],
    projection_roundtrip: {
      notion: {
        candidate_id_map: []
      }
    },
    conservation: {
      input_rows: 1,
      accepted_rows: 1,
      rejected_rows: 0,
      hold_rows: 0
    },
    ...overrides
  };
}

test('portable warm bundle contract exposes public projection boundaries', () => {
  const packet = buildPortableWarmBundleContractPacket();
  assert.equal(packet.ok, true);
  assert.equal(packet.product_boundary.projections_are_truth, false);
  assert.equal(packet.notion_projection_proposal.canonical_truth, false);
  assert.match(packet.product_boundary.public_truth_artifact, /JSON\/JSONL/);
  assert.ok(packet.product_boundary.forbidden_public_authority.includes('Home warm direct write'));
});

test('valid synthetic portable warm bundle passes focused validation', () => {
  const result = validatePortableWarmBundle(buildValidBundle());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.warm_cards, 1);
  assert.equal(result.counts.source_spans, 1);
});

test('public bundle rejects cold graph writer lineage fields', () => {
  const result = validatePortableWarmBundle(buildValidBundle({
    relation_roots: [{ root_id: 'private_root' }]
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path.endsWith('.relation_roots')));
});

test('public bundle rejects Home direct-write authority', () => {
  const bundle = buildValidBundle();
  bundle.warm_cards[0].home_import_policy.direct_write_allowed = true;
  const result = validatePortableWarmBundle(bundle);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path.includes('direct_write_allowed')));
});
