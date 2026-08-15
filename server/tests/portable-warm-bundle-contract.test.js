import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  BUNDLE_SCHEMA,
  buildPortableWarmLedgerId,
  buildPortableWarmBundleContractPacket,
  validatePortableWarmBundle
} from '../core/portable-warm-bundle-contract.js';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value || '')).digest('hex')}`;
}

function digestObject(value) {
  return sha256(stableJson(value));
}

function withoutKey(value = {}, key = '') {
  const copy = { ...(value || {}) };
  delete copy[key];
  return copy;
}

function sealBundle(bundle) {
  const sealed = {
    ...bundle,
    source_occurrences: (Array.isArray(bundle.source_occurrences) ? bundle.source_occurrences : []).map((occurrence) => {
      const next = {
        ...occurrence,
        source_file_digest: occurrence.source_file_digest ?? (occurrence.source_file ? sha256(occurrence.source_file) : '')
      };
      return {
        ...next,
        digest: digestObject(withoutKey(next, 'digest'))
      };
    }),
    manifest: {
      candidate_count: Array.isArray(bundle.warm_cards) ? bundle.warm_cards.length : 0,
      source_span_count: Array.isArray(bundle.source_spans) ? bundle.source_spans.length : 0,
      ...(bundle.manifest || {}),
      manifest_digest: ''
    },
    source_manifest: {
      source_count: Array.isArray(bundle.source_occurrences) ? bundle.source_occurrences.length : 0,
      source_occurrence_count: Array.isArray(bundle.source_occurrences) ? bundle.source_occurrences.length : 0,
      source_span_count: Array.isArray(bundle.source_spans) ? bundle.source_spans.length : 0,
      ...(bundle.source_manifest || {}),
      source_digest: ''
    },
    conservation: {
      input_growth_draft_rows: 1,
      input_reviewed_rows: 0,
      input_rows: 1,
      accepted_rows: Array.isArray(bundle.warm_cards) ? bundle.warm_cards.length : 0,
      rejected_rows: Array.isArray(bundle.rejected_ledger) ? bundle.rejected_ledger.length : 0,
      hold_rows: Array.isArray(bundle.hold_ledger) ? bundle.hold_ledger.length : 0,
      source_occurrence_count: Array.isArray(bundle.source_occurrences) ? bundle.source_occurrences.length : 0,
      source_span_count: Array.isArray(bundle.source_spans) ? bundle.source_spans.length : 0,
      ...(bundle.conservation || {})
    }
  };
  sealed.source_manifest.source_digest = digestObject({
    source_occurrences: sealed.source_occurrences,
    source_spans: sealed.source_spans
  });
  sealed.manifest.manifest_digest = digestObject({
    ...sealed,
    manifest: {
      ...sealed.manifest,
      manifest_digest: ''
    }
  });
  return sealed;
}

function resealBundlePreservingShape(bundle) {
  const sealed = JSON.parse(JSON.stringify(bundle));
  if (sealed.source_manifest) {
    sealed.source_manifest.source_digest = digestObject({
      source_occurrences: sealed.source_occurrences,
      source_spans: sealed.source_spans
    });
  }
  if (sealed.manifest) {
    sealed.manifest.manifest_digest = digestObject({
      ...sealed,
      manifest: {
        ...sealed.manifest,
        manifest_digest: ''
      }
    });
  }
  return sealed;
}

function resealBundleIncludingOccurrenceDigests(bundle) {
  const sealed = JSON.parse(JSON.stringify(bundle));
  if (Array.isArray(sealed.source_occurrences)) {
    sealed.source_occurrences = sealed.source_occurrences.map((occurrence) => {
      const next = {
        ...occurrence,
        source_file_digest: occurrence.source_file_digest ?? (occurrence.source_file ? sha256(occurrence.source_file) : '')
      };
      return {
        ...next,
        digest: digestObject(withoutKey(next, 'digest'))
      };
    });
  }
  return resealBundlePreservingShape(sealed);
}

function buildValidBundle(overrides = {}) {
  return sealBundle({
    schema: BUNDLE_SCHEMA,
    manifest: {
      bundle_id: 'bundle_synthetic_001',
      created_at: '2026-08-15T00:00:00.000Z',
      generator: 'synthetic_contract_fixture',
      scope: {
        owner_id: 'owner',
        realm_id: 'realm',
        bot_id: ''
      },
      manifest_digest: ''
    },
    source_manifest: {
      source_count: 1,
      source_occurrence_count: 1,
      source_span_count: 1,
      source_digest: ''
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
          local_only: true,
          projection_requires_user_action: true
        },
        quality: {
          source_bound: true,
          source_complete: true,
          source_span_count: 1,
          source_incomplete: false
        },
        home_import_policy: {
          direct_write_allowed: false,
          state: 'review_only',
          reason: 'Synthetic public fixture is review-only.'
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
        excerpt_digest: sha256('Synthetic bounded excerpt.'),
        bounds: {
          start: 0,
          end: 'Synthetic bounded excerpt.'.length,
          unit: 'utf16_code_units'
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
      hold_rows: 0,
      source_occurrence_count: 1,
      source_span_count: 1
    },
    ...overrides
  });
}

function buildLedgerRow({
  state = 'hold',
  sourceKind = 'growth_draft',
  sourceId = 'synthetic_source',
  title = 'Synthetic hold',
  reason = 'missing_bounded_source_span'
} = {}) {
  return {
    ledger_id: buildPortableWarmLedgerId({
      state,
      sourceKind,
      sourceId,
      title,
      reason
    }),
    state,
    reason,
    source_kind: sourceKind,
    source_id: sourceId,
    ...(state === 'hold' ? { title } : {}),
    row_digest: sha256(`${state}:${sourceKind}:${sourceId}:${title}:${reason}`),
    review_note: 'Synthetic ledger fixture.'
  };
}

function buildHoldOnlyBundle() {
  const hold = buildLedgerRow({
    state: 'hold',
    sourceKind: 'growth_draft',
    sourceId: 'hold_source_001',
    title: 'Synthetic hold',
    reason: 'missing_bounded_source_span'
  });
  return buildValidBundle({
    warm_cards: [],
    source_occurrences: [],
    source_spans: [],
    source_manifest: {
      source_count: 0,
      source_occurrence_count: 0,
      source_span_count: 0,
      source_digest: ''
    },
    hold_ledger: [hold],
    rejected_ledger: [],
    conservation: {
      input_growth_draft_rows: 1,
      input_reviewed_rows: 0,
      input_rows: 1,
      accepted_rows: 0,
      rejected_rows: 0,
      hold_rows: 1,
      source_occurrence_count: 0,
      source_span_count: 0
    }
  });
}

function buildRejectedOnlyBundle() {
  const rejected = buildLedgerRow({
    state: 'rejected',
    sourceKind: 'reviewed_row',
    sourceId: 'rejected_source_001',
    reason: 'invalid_reviewed_row'
  });
  return buildValidBundle({
    warm_cards: [],
    source_occurrences: [],
    source_spans: [],
    source_manifest: {
      source_count: 0,
      source_occurrence_count: 0,
      source_span_count: 0,
      source_digest: ''
    },
    hold_ledger: [],
    rejected_ledger: [rejected],
    conservation: {
      input_growth_draft_rows: 0,
      input_reviewed_rows: 1,
      input_rows: 1,
      accepted_rows: 0,
      rejected_rows: 1,
      hold_rows: 0,
      source_occurrence_count: 0,
      source_span_count: 0
    }
  });
}

function buildTwoCardBundle() {
  const aText = 'Synthetic bounded excerpt A.';
  const bText = 'Synthetic bounded excerpt B.';
  const card = (id, title, occurrenceId, spanId, messageId) => ({
    candidate_id: id,
    title,
    archive_bucket: 'stable',
    frontend_delivery_tier: 'explicit_context_only',
    portable_warm_card: {
      body_markdown: `${title} body.`,
      living_fragment: `${title} fragment.`,
      feeling_as_fact: `${title} feeling.`,
      future_use_hint: `${title} hint.`,
      voice_fingerprint_refs: ['sha256:fingerprint'],
      persona_refs: ['sha256:persona']
    },
    source_refs: {
      source_occurrence_ids: [occurrenceId],
      source_span_ids: [spanId]
    },
    privacy: {
      local_only: true,
      projection_requires_user_action: true
    },
    quality: {
      source_bound: true,
      source_complete: true,
      source_span_count: 1,
      source_incomplete: false
    },
    home_import_policy: {
      direct_write_allowed: false,
      state: 'review_only',
      reason: 'Synthetic public fixture is review-only.'
    }
  });
  return buildValidBundle({
    warm_cards: [
      card('warm_candidate_a', 'Synthetic card A', 'occurrence_a', 'span_a', 'message_a'),
      card('warm_candidate_b', 'Synthetic card B', 'occurrence_b', 'span_b', 'message_b')
    ],
    source_occurrences: [
      {
        source_occurrence_id: 'occurrence_a',
        source_id: 'source_a',
        source_kind: 'synthetic_fixture',
        source_file: 'synthetic-a.jsonl',
        source_window: 'Synthetic window A',
        turn_range: '1-1',
        message_ids: ['message_a'],
        source_time: '2026-08-15T00:00:00.000Z',
        digest: 'sha256:occurrence-a'
      },
      {
        source_occurrence_id: 'occurrence_b',
        source_id: 'source_b',
        source_kind: 'synthetic_fixture',
        source_file: 'synthetic-b.jsonl',
        source_window: 'Synthetic window B',
        turn_range: '2-2',
        message_ids: ['message_b'],
        source_time: '2026-08-15T00:00:00.000Z',
        digest: 'sha256:occurrence-b'
      }
    ],
    source_spans: [
      {
        source_span_id: 'span_a',
        source_occurrence_id: 'occurrence_a',
        turn_range: '1-1',
        message_ids: ['message_a'],
        speaker: 'assistant',
        excerpt_text: aText,
        excerpt_digest: sha256(aText),
        bounds: {
          start: 0,
          end: aText.length,
          unit: 'utf16_code_units'
        }
      },
      {
        source_span_id: 'span_b',
        source_occurrence_id: 'occurrence_b',
        turn_range: '2-2',
        message_ids: ['message_b'],
        speaker: 'assistant',
        excerpt_text: bText,
        excerpt_digest: sha256(bText),
        bounds: {
          start: 0,
          end: bText.length,
          unit: 'utf16_code_units'
        }
      }
    ],
    conservation: {
      input_growth_draft_rows: 2,
      input_reviewed_rows: 0,
      input_rows: 2,
      accepted_rows: 2,
      rejected_rows: 0,
      hold_rows: 0,
      source_occurrence_count: 2,
      source_span_count: 2
    }
  });
}

function buildMultiSpanSameOccurrenceBundle() {
  const first = 'Synthetic bounded excerpt one.';
  const second = 'Synthetic bounded excerpt two.';
  const bundle = buildValidBundle();
  bundle.warm_cards[0].source_refs.source_span_ids = ['span_001', 'span_002'];
  bundle.warm_cards[0].quality.source_span_count = 2;
  bundle.source_spans = [
    bundle.source_spans[0],
    {
      source_span_id: 'span_002',
      source_occurrence_id: 'occurrence_001',
      turn_range: '1-1',
      message_ids: ['message_001'],
      speaker: 'assistant',
      excerpt_text: second,
      excerpt_digest: sha256(second),
      bounds: {
        start: 0,
        end: second.length,
        unit: 'utf16_code_units'
      }
    }
  ];
  bundle.source_spans[0].excerpt_text = first;
  bundle.source_spans[0].excerpt_digest = sha256(first);
  bundle.source_spans[0].bounds.end = first.length;
  bundle.manifest.source_span_count = 2;
  bundle.source_manifest.source_span_count = 2;
  bundle.conservation.source_span_count = 2;
  return resealBundleIncludingOccurrenceDigests(bundle);
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
  const bundle = buildValidBundle();
  const result = validatePortableWarmBundle(bundle);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.warm_cards, 1);
  assert.equal(result.counts.source_spans, 1);
  assert.equal(JSON.stringify(bundle).includes('PRIVATE_BODY'), false);
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

test('public bundle rejects tampered manifest, spans, counts, and card refs', () => {
  const bundle = buildValidBundle();
  bundle.manifest.manifest_digest = 'sha256:forged';
  bundle.source_spans[0].excerpt_text = 'Tampered bounded excerpt.';
  bundle.conservation.accepted_rows = 99;
  bundle.warm_cards[0].source_refs.source_span_ids = ['missing-span'];

  const result = validatePortableWarmBundle(bundle);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'manifest.manifest_digest'));
  assert.ok(result.errors.some((item) => item.path === 'source_spans[0].excerpt_digest'));
  assert.ok(result.errors.some((item) => item.path === 'conservation.accepted_rows'));
  assert.ok(result.errors.some((item) => item.path.includes('source_span_ids')));
});

test('public bundle rejects nested unknown/private fields after reseal', () => {
  const bundle = buildValidBundle();
  bundle.warm_cards[0].private_payload = 'PRIVATE_BODY';
  bundle.warm_cards[0].portable_warm_card.private_payload = 'PRIVATE_BODY';

  const result = validatePortableWarmBundle(resealBundlePreservingShape(bundle));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'warm_cards[0].private_payload'));
  assert.ok(result.errors.some((item) => item.path === 'warm_cards[0].portable_warm_card.private_payload'));
});

test('public bundle rejects private cold-tree import policy fields after reseal', () => {
  const bundle = buildValidBundle();
  bundle.warm_cards[0].hippocove_import_policy = {
    direct_write_allowed: false,
    state: 'review_only',
    reason: 'private downstream policy must not be part of the public portable contract'
  };

  const result = validatePortableWarmBundle(resealBundlePreservingShape(bundle));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'warm_cards[0].hippocove_import_policy'));
});

test('public bundle requires canonical conservation counts after reseal', () => {
  const bundle = buildValidBundle();
  delete bundle.conservation.accepted_rows;
  delete bundle.conservation.input_rows;

  const result = validatePortableWarmBundle(resealBundlePreservingShape(bundle));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'conservation.accepted_rows'));
  assert.ok(result.errors.some((item) => item.path === 'conservation.input_rows'));
});

test('public bundle rejects forged source occurrence digest after reseal', () => {
  const bundle = buildValidBundle();
  bundle.source_occurrences[0].digest = 'sha256:forged-occurrence';

  const result = validatePortableWarmBundle(resealBundlePreservingShape(bundle));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'source_occurrences[0].digest'));
});

test('public bundle rejects contradictory accepted-card source quality after reseal', () => {
  const bundle = buildValidBundle();
  bundle.warm_cards[0].quality.source_incomplete = true;

  const result = validatePortableWarmBundle(resealBundlePreservingShape(bundle));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'warm_cards[0].quality.source_incomplete'));
});

test('public bundle rejects required schema deletions after reseal', () => {
  const bundle = buildValidBundle();
  delete bundle.manifest.created_at;
  delete bundle.manifest.generator;
  delete bundle.manifest.scope;
  delete bundle.warm_cards[0].privacy;
  delete bundle.warm_cards[0].home_import_policy;
  delete bundle.warm_cards[0].portable_warm_card.body_markdown;
  delete bundle.warm_cards[0].portable_warm_card.living_fragment;
  delete bundle.source_occurrences[0].source_kind;
  delete bundle.source_occurrences[0].source_file_digest;
  delete bundle.source_occurrences[0].turn_range;
  delete bundle.source_occurrences[0].message_ids;
  delete bundle.source_occurrences[0].source_time;
  delete bundle.source_spans[0].turn_range;
  delete bundle.source_spans[0].message_ids;
  delete bundle.source_spans[0].speaker;
  bundle.source_spans[0].bounds = {
    start: 1,
    end: 1
  };

  const result = validatePortableWarmBundle(resealBundlePreservingShape(bundle));
  const paths = new Set(result.errors.map((item) => item.path));

  assert.equal(result.ok, false);
  [
    'manifest.created_at',
    'manifest.generator',
    'manifest.scope',
    'warm_cards[0].privacy',
    'warm_cards[0].home_import_policy',
    'warm_cards[0].portable_warm_card.body_markdown',
    'warm_cards[0].portable_warm_card.living_fragment',
    'source_occurrences[0].source_kind',
    'source_occurrences[0].source_file_digest',
    'source_occurrences[0].turn_range',
    'source_occurrences[0].message_ids',
    'source_occurrences[0].source_time',
    'source_spans[0].turn_range',
    'source_spans[0].message_ids',
    'source_spans[0].speaker',
    'source_spans[0].bounds.start',
    'source_spans[0].bounds.end',
    'source_spans[0].bounds.unit'
  ].forEach((path) => {
    assert.equal(paths.has(path), true, `expected validation error at ${path}`);
  });
});

test('public bundle rejects private sentinel array elements after full reseal', () => {
  const bundle = buildValidBundle();
  bundle.warm_cards[0].portable_warm_card.voice_fingerprint_refs = [{ PRIVATE_BODY: 'sentinel' }];
  bundle.warm_cards[0].portable_warm_card.persona_refs = [{ PRIVATE_BODY: 'sentinel' }];
  bundle.source_occurrences[0].message_ids = [{ PRIVATE_BODY: 'sentinel' }];
  bundle.source_spans[0].message_ids = [{ PRIVATE_BODY: 'sentinel' }];
  bundle.projection_roundtrip.notion.candidate_id_map = [
    {
      candidate_id: 'x',
      PRIVATE_BODY: 'sentinel'
    }
  ];

  const result = validatePortableWarmBundle(resealBundleIncludingOccurrenceDigests(bundle));
  const paths = new Set(result.errors.map((item) => item.path));

  assert.equal(result.ok, false);
  [
    'warm_cards[0].portable_warm_card.voice_fingerprint_refs[0]',
    'warm_cards[0].portable_warm_card.persona_refs[0]',
    'source_occurrences[0].message_ids[0]',
    'source_spans[0].message_ids[0]',
    'projection_roundtrip.notion.candidate_id_map'
  ].forEach((path) => {
    assert.equal(paths.has(path), true, `expected validation error at ${path}`);
  });
});

test('public bundle rejects private source_file paths after full reseal', () => {
  const privateSources = [
    '/Users/alice/private/history.jsonl',
    '/home/alice/private/history.jsonl',
    'C:\\Users\\Alice\\private\\history.jsonl',
    '\\\\server\\share\\private\\history.jsonl'
  ];
  for (const sourceFile of privateSources) {
    const bundle = buildValidBundle();
    bundle.source_occurrences[0].source_file = sourceFile;
    bundle.source_occurrences[0].source_file_digest = sha256(sourceFile);
    const result = validatePortableWarmBundle(resealBundleIncludingOccurrenceDigests(bundle));
    assert.equal(result.ok, false, `expected private path rejection for ${sourceFile}`);
    assert.ok(result.errors.some((item) => item.path === 'source_occurrences[0].source_file'));
  }
});

test('public bundle rejects duplicate string refs after full reseal', () => {
  const bundle = buildValidBundle();
  bundle.warm_cards[0].portable_warm_card.voice_fingerprint_refs = ['sha256:fingerprint', 'sha256:fingerprint'];
  bundle.warm_cards[0].portable_warm_card.persona_refs = ['sha256:persona', 'sha256:persona'];
  bundle.warm_cards[0].source_refs.source_occurrence_ids = ['occurrence_001', 'occurrence_001'];
  bundle.warm_cards[0].source_refs.source_span_ids = ['span_001', 'span_001'];
  bundle.source_occurrences[0].message_ids = ['message_001', 'message_001'];
  bundle.source_spans[0].message_ids = ['message_001', 'message_001'];

  const result = validatePortableWarmBundle(resealBundleIncludingOccurrenceDigests(bundle));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'warm_cards[0].portable_warm_card.voice_fingerprint_refs[1]'));
  assert.ok(result.errors.some((item) => item.path === 'warm_cards[0].portable_warm_card.persona_refs[1]'));
  assert.ok(result.errors.some((item) => item.path === 'warm_cards[0].source_refs.source_occurrence_ids[1]'));
  assert.ok(result.errors.some((item) => item.path === 'warm_cards[0].source_refs.source_span_ids[1]'));
  assert.ok(result.errors.some((item) => item.path === 'source_occurrences[0].message_ids[1]'));
  assert.ok(result.errors.some((item) => item.path === 'source_spans[0].message_ids[1]'));
});

test('public bundle accepts deterministic hold and rejected ledger rows', () => {
  assert.equal(validatePortableWarmBundle(buildHoldOnlyBundle()).ok, true);
  assert.equal(validatePortableWarmBundle(buildRejectedOnlyBundle()).ok, true);
});

test('public bundle rejects hold ledger row drift after full reseal', () => {
  const stateBundle = buildHoldOnlyBundle();
  stateBundle.hold_ledger[0].state = 'rejected';
  const stateResult = validatePortableWarmBundle(resealBundlePreservingShape(stateBundle));
  assert.equal(stateResult.ok, false);
  assert.ok(stateResult.errors.some((item) => item.path === 'hold_ledger[0].state'));

  const reasonBundle = buildHoldOnlyBundle();
  reasonBundle.hold_ledger[0].reason = 'owner_approved';
  const reasonResult = validatePortableWarmBundle(resealBundlePreservingShape(reasonBundle));
  assert.equal(reasonResult.ok, false);
  assert.ok(reasonResult.errors.some((item) => item.path === 'hold_ledger[0].ledger_id'));

  const sourceBundle = buildHoldOnlyBundle();
  sourceBundle.hold_ledger[0].source_id = 'another_source';
  const sourceResult = validatePortableWarmBundle(resealBundlePreservingShape(sourceBundle));
  assert.equal(sourceResult.ok, false);
  assert.ok(sourceResult.errors.some((item) => item.path === 'hold_ledger[0].ledger_id'));

  const digestBundle = buildHoldOnlyBundle();
  digestBundle.hold_ledger[0].row_digest = 'not-a-digest';
  const digestResult = validatePortableWarmBundle(resealBundlePreservingShape(digestBundle));
  assert.equal(digestResult.ok, false);
  assert.ok(digestResult.errors.some((item) => item.path === 'hold_ledger[0].row_digest'));
});

test('public bundle rejects ledger rows moved across hold and rejected arrays', () => {
  const holdMoved = buildHoldOnlyBundle();
  holdMoved.rejected_ledger = holdMoved.hold_ledger;
  holdMoved.hold_ledger = [];
  holdMoved.conservation.rejected_rows = 1;
  holdMoved.conservation.hold_rows = 0;
  const holdMovedResult = validatePortableWarmBundle(resealBundlePreservingShape(holdMoved));
  assert.equal(holdMovedResult.ok, false);
  assert.ok(holdMovedResult.errors.some((item) => item.path === 'rejected_ledger[0].state'));

  const rejectedMoved = buildRejectedOnlyBundle();
  rejectedMoved.hold_ledger = rejectedMoved.rejected_ledger;
  rejectedMoved.rejected_ledger = [];
  rejectedMoved.conservation.rejected_rows = 0;
  rejectedMoved.conservation.hold_rows = 1;
  const rejectedMovedResult = validatePortableWarmBundle(resealBundlePreservingShape(rejectedMoved));
  assert.equal(rejectedMovedResult.ok, false);
  assert.ok(rejectedMovedResult.errors.some((item) => item.path === 'hold_ledger[0].state'));
});

test('public bundle rejects extra cross-card source occurrence attribution after full reseal', () => {
  const bundle = buildTwoCardBundle();
  bundle.warm_cards[0].source_refs.source_occurrence_ids.push('occurrence_b');

  const result = validatePortableWarmBundle(resealBundleIncludingOccurrenceDigests(bundle));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'warm_cards[0].source_refs.source_occurrence_ids'));
});

test('public bundle accepts multiple source spans from one occurrence', () => {
  const result = validatePortableWarmBundle(buildMultiSpanSameOccurrenceBundle());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});
