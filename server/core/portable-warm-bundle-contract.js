const CONTRACT_VERSION = 'portable_warm_bundle_v0';
const BUNDLE_SCHEMA = 'driftstone_portable_warm_bundle_v0';

const FORBIDDEN_PUBLIC_KEYS = new Set([
  'cold_root',
  'cold_roots',
  'cold_tree',
  'cluster',
  'clusters',
  'hippocove_receipt',
  'hippocove_receipts',
  'home_write',
  'home_writes',
  'relation_edge',
  'relation_edges',
  'relation_root',
  'relation_roots',
  'snapshot',
  'snapshots',
  'vine',
  'vines',
  'vine_edge',
  'vine_edges'
]);

const REQUIRED_BUNDLE_ARRAYS = [
  'warm_cards',
  'source_occurrences',
  'source_spans',
  'rejected_ledger',
  'hold_ledger'
];

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function walkForbiddenKeys(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForbiddenKeys(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isPlainObject(value)) return;
  Object.entries(value).forEach(([key, child]) => {
    const lowerKey = key.toLowerCase();
    if (FORBIDDEN_PUBLIC_KEYS.has(lowerKey)) {
      pushError(errors, `${path}.${key}`, 'Public Driftstone bundle must not carry Home/Hippocove cold graph writer fields.');
    }
    walkForbiddenKeys(child, `${path}.${key}`, errors);
  });
}

function validateWarmCard(card, index, errors, warnings) {
  const basePath = `warm_cards[${index}]`;
  if (!safeText(card?.candidate_id)) {
    pushError(errors, `${basePath}.candidate_id`, 'candidate_id is required for projection roundtrip and review patching.');
  }
  if (!safeText(card?.title)) {
    pushError(errors, `${basePath}.title`, 'title is required for human review surfaces.');
  }
  if (!isPlainObject(card?.portable_warm_card)) {
    pushError(errors, `${basePath}.portable_warm_card`, 'portable_warm_card object is required.');
  }
  const sourceSpanIds = card?.source_refs?.source_span_ids;
  if (!Array.isArray(sourceSpanIds) || sourceSpanIds.length === 0) {
    pushError(errors, `${basePath}.source_refs.source_span_ids`, 'at least one source_span_id is required.');
  }
  if (card?.home_import_policy?.direct_write_allowed === true) {
    pushError(errors, `${basePath}.home_import_policy.direct_write_allowed`, 'Public bundle must not grant Home direct-write authority.');
  }
  if (card?.hippocove_import_policy?.direct_write_allowed === true) {
    pushError(errors, `${basePath}.hippocove_import_policy.direct_write_allowed`, 'Public bundle must not grant Hippocove direct-write authority.');
  }
  if (!safeText(card?.frontend_delivery_tier)) {
    warnings.push({
      path: `${basePath}.frontend_delivery_tier`,
      message: 'frontend_delivery_tier is recommended so projections do not treat stable archive as default frontend recall.'
    });
  }
}

function validateSourceOccurrence(item, index, errors) {
  const basePath = `source_occurrences[${index}]`;
  if (!safeText(item?.source_occurrence_id)) {
    pushError(errors, `${basePath}.source_occurrence_id`, 'source_occurrence_id is required.');
  }
  if (!safeText(item?.source_id)) {
    pushError(errors, `${basePath}.source_id`, 'source_id is required.');
  }
  if (!safeText(item?.source_file) && !safeText(item?.source_window)) {
    pushError(errors, `${basePath}.source_file`, 'source_file or source_window is required.');
  }
  if (!safeText(item?.digest)) {
    pushError(errors, `${basePath}.digest`, 'digest is required for source occurrence integrity.');
  }
}

function validateSourceSpan(item, index, errors) {
  const basePath = `source_spans[${index}]`;
  if (!safeText(item?.source_span_id)) {
    pushError(errors, `${basePath}.source_span_id`, 'source_span_id is required.');
  }
  if (!safeText(item?.source_occurrence_id)) {
    pushError(errors, `${basePath}.source_occurrence_id`, 'source_occurrence_id is required.');
  }
  if (!safeText(item?.excerpt_text) && !safeText(item?.excerpt_digest)) {
    pushError(errors, `${basePath}.excerpt_text`, 'bounded excerpt_text or excerpt_digest is required.');
  }
}

export function buildPortableWarmBundleContractPacket() {
  return {
    ok: true,
    schema: 'driftstone_portable_warm_bundle_contract_packet_v0',
    contract_version: CONTRACT_VERSION,
    product_boundary: {
      public_truth_artifact: 'JSON/JSONL bundle + manifest + rejected/HOLD ledger',
      projections_are_truth: false,
      allowed_projections: ['jsonl', 'markdown_obsidian', 'notion'],
      forbidden_public_authority: [
        'Home warm direct write',
        'Hippocove cold tree write',
        'Cold roots / relation graph / vine ownership',
        'private Asherie schema, paths, data, or receipts'
      ],
      persona_policy: 'optional digest-bound persona and language fingerprint may inform portable Warm cards; public Driftstone does not apply private Home canonical warm memory.'
    },
    artifact_contract: {
      schema: BUNDLE_SCHEMA,
      required_top_level: [
        'schema',
        'manifest',
        'source_manifest',
        'persona_authority',
        'warm_cards',
        'source_occurrences',
        'source_spans',
        'rejected_ledger',
        'hold_ledger',
        'projection_roundtrip',
        'conservation'
      ],
      warm_card_required_fields: [
        'candidate_id',
        'title',
        'archive_bucket',
        'frontend_delivery_tier',
        'portable_warm_card',
        'source_refs',
        'privacy',
        'quality',
        'home_import_policy'
      ],
      portable_warm_card_fields: [
        'body_markdown',
        'living_fragment',
        'feeling_as_fact',
        'future_use_hint',
        'voice_fingerprint_refs',
        'persona_refs'
      ],
      source_occurrence_required_fields: [
        'source_occurrence_id',
        'source_id',
        'source_kind',
        'source_file',
        'source_window',
        'turn_range',
        'message_ids',
        'source_time',
        'digest'
      ],
      source_span_required_fields: [
        'source_span_id',
        'source_occurrence_id',
        'turn_range',
        'message_ids',
        'speaker',
        'excerpt_text',
        'excerpt_digest',
        'bounds'
      ],
      ledgers: {
        rejected_ledger: 'Rows that failed parsing, conservation, source recovery, privacy gate, or owner HOLD.',
        hold_ledger: 'Rows intentionally paused for owner review; never silently discarded.'
      }
    },
    notion_projection_proposal: {
      canonical_truth: false,
      default_write_boundary: 'local export only until user explicitly connects Notion',
      databases: [
        {
          name: 'Driftstone Bundle Index',
          purpose: 'One row per portable bundle; points back to manifest and local artifact digest.',
          key_fields: ['bundle_id', 'schema', 'created_at', 'manifest_digest', 'candidate_count', 'source_span_count']
        },
        {
          name: 'Portable Warm Cards',
          purpose: 'Human/Chat-readable Warm card projection; not Home canonical memory.',
          key_fields: [
            'candidate_id',
            'bundle_id',
            'title',
            'archive_bucket',
            'frontend_delivery_tier',
            'review_status',
            'source_span_count',
            'notion_page_id',
            'notion_sync_hash'
          ]
        },
        {
          name: 'Source Occurrences',
          purpose: 'Source file/window/turn occurrence index for readback.',
          key_fields: ['source_occurrence_id', 'bundle_id', 'source_kind', 'source_file', 'source_window', 'digest']
        },
        {
          name: 'Source Spans',
          purpose: 'Bounded excerpt audit layer; source-only, not frontend default recall.',
          key_fields: ['source_span_id', 'source_occurrence_id', 'turn_range', 'speaker', 'excerpt_digest']
        },
        {
          name: 'Review Ledger',
          purpose: 'Rejected/HOLD/manual review/update-backflow records.',
          key_fields: ['ledger_id', 'candidate_id', 'state', 'reason', 'review_note', 'base_digest']
        }
      ],
      roundtrip: {
        stable_key: 'candidate_id',
        projection_keys: ['notion_database_id', 'notion_page_id', 'notion_sync_hash', 'last_synced_at'],
        review_backflow: 'Notion review exports must return candidate_id + base_digest + patch fields; core applies only after local validation.'
      },
      privacy: {
        default: 'local-only',
        notion_write: 'explicit user action only',
        source_span_display: 'bounded excerpts only; source occurrence can remain local path/digest without full raw text'
      }
    }
  };
}

export function validatePortableWarmBundle(bundle = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(bundle)) {
    return {
      ok: false,
      schema: 'driftstone_portable_warm_bundle_validation_v0',
      errors: [{ path: '$', message: 'Bundle must be a JSON object.' }],
      warnings: []
    };
  }

  if (bundle.schema !== BUNDLE_SCHEMA) {
    pushError(errors, 'schema', `schema must be ${BUNDLE_SCHEMA}.`);
  }
  if (!isPlainObject(bundle.manifest) || !safeText(bundle.manifest.bundle_id)) {
    pushError(errors, 'manifest.bundle_id', 'manifest.bundle_id is required.');
  }
  if (!isPlainObject(bundle.source_manifest)) {
    pushError(errors, 'source_manifest', 'source_manifest is required.');
  }
  REQUIRED_BUNDLE_ARRAYS.forEach((key) => {
    if (!Array.isArray(bundle[key])) pushError(errors, key, `${key} must be an array.`);
  });
  walkForbiddenKeys(bundle, '$', errors);
  (Array.isArray(bundle.warm_cards) ? bundle.warm_cards : []).forEach((card, index) => {
    validateWarmCard(card, index, errors, warnings);
  });
  (Array.isArray(bundle.source_occurrences) ? bundle.source_occurrences : []).forEach((item, index) => {
    validateSourceOccurrence(item, index, errors);
  });
  (Array.isArray(bundle.source_spans) ? bundle.source_spans : []).forEach((item, index) => {
    validateSourceSpan(item, index, errors);
  });

  return {
    ok: errors.length === 0,
    schema: 'driftstone_portable_warm_bundle_validation_v0',
    contract_version: CONTRACT_VERSION,
    errors,
    warnings,
    counts: {
      warm_cards: Array.isArray(bundle.warm_cards) ? bundle.warm_cards.length : 0,
      source_occurrences: Array.isArray(bundle.source_occurrences) ? bundle.source_occurrences.length : 0,
      source_spans: Array.isArray(bundle.source_spans) ? bundle.source_spans.length : 0,
      rejected_ledger: Array.isArray(bundle.rejected_ledger) ? bundle.rejected_ledger.length : 0,
      hold_ledger: Array.isArray(bundle.hold_ledger) ? bundle.hold_ledger.length : 0
    }
  };
}

export { BUNDLE_SCHEMA, CONTRACT_VERSION };
