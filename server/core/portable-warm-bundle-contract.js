import { createHash } from 'crypto';

const CONTRACT_VERSION = 'portable_warm_bundle_v0';
const BUNDLE_SCHEMA = 'driftstone_portable_warm_bundle_v0';

const ALLOWED_TOP_LEVEL_KEYS = new Set([
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
]);

const REQUIRED_TOP_LEVEL_KEYS = [
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
];

const FORBIDDEN_PUBLIC_KEYS = new Set([
  'canonical_action_receipt',
  'canonical_receipt',
  'cold_root',
  'cold_roots',
  'cold_tree',
  'cluster',
  'clusters',
  'hippocove_receipt',
  'hippocove_receipts',
  'home_write',
  'home_writes',
  'owner_receipt',
  'private_authority',
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

const KEYSETS = {
  manifest: new Set(['bundle_id', 'created_at', 'generator', 'scope', 'candidate_count', 'source_span_count', 'manifest_digest']),
  manifest_scope: new Set(['owner_id', 'realm_id', 'bot_id']),
  source_manifest: new Set(['source_count', 'source_occurrence_count', 'source_span_count', 'source_digest']),
  persona_authority: new Set(['authority', 'persona_digest', 'language_fingerprint_digest']),
  warm_card: new Set([
    'candidate_id',
    'title',
    'archive_bucket',
    'frontend_delivery_tier',
    'portable_warm_card',
    'source_refs',
    'privacy',
    'quality',
    'home_import_policy'
  ]),
  portable_warm_card: new Set([
    'body_markdown',
    'living_fragment',
    'feeling_as_fact',
    'future_use_hint',
    'voice_fingerprint_refs',
    'persona_refs'
  ]),
  source_refs: new Set(['source_occurrence_ids', 'source_span_ids']),
  privacy: new Set(['local_only', 'projection_requires_user_action']),
  quality: new Set(['source_bound', 'source_complete', 'source_span_count', 'source_incomplete']),
  import_policy: new Set(['direct_write_allowed', 'state', 'reason']),
  source_occurrence: new Set([
    'source_occurrence_id',
    'source_id',
    'source_kind',
    'source_file',
    'source_file_digest',
    'source_window',
    'turn_range',
    'message_ids',
    'source_time',
    'digest'
  ]),
  source_span: new Set([
    'source_span_id',
    'source_occurrence_id',
    'turn_range',
    'message_ids',
    'speaker',
    'excerpt_text',
    'excerpt_digest',
    'bounds'
  ]),
  bounds: new Set(['start', 'end', 'unit']),
  ledger: new Set(['ledger_id', 'state', 'reason', 'source_kind', 'source_id', 'title', 'row_digest', 'review_note']),
  projection_roundtrip: new Set(['notion']),
  projection_roundtrip_notion: new Set(['candidate_id_map']),
  conservation: new Set([
    'input_growth_draft_rows',
    'input_reviewed_rows',
    'input_rows',
    'accepted_rows',
    'rejected_rows',
    'hold_rows',
    'source_occurrence_count',
    'source_span_count'
  ])
};

const REQUIRED_KEYS = {
  manifest: ['bundle_id', 'created_at', 'generator', 'scope', 'candidate_count', 'source_span_count', 'manifest_digest'],
  manifest_scope: ['owner_id', 'realm_id', 'bot_id'],
  source_manifest: ['source_count', 'source_occurrence_count', 'source_span_count', 'source_digest'],
  persona_authority: ['authority', 'persona_digest', 'language_fingerprint_digest'],
  warm_card: [
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
  portable_warm_card: ['body_markdown', 'living_fragment'],
  source_refs: ['source_occurrence_ids', 'source_span_ids'],
  privacy: ['local_only', 'projection_requires_user_action'],
  quality: ['source_bound', 'source_complete', 'source_span_count', 'source_incomplete'],
  import_policy: ['direct_write_allowed', 'state', 'reason'],
  source_occurrence: [
    'source_occurrence_id',
    'source_id',
    'source_kind',
    'source_file',
    'source_file_digest',
    'source_window',
    'turn_range',
    'message_ids',
    'source_time',
    'digest'
  ],
  source_span: [
    'source_span_id',
    'source_occurrence_id',
    'turn_range',
    'message_ids',
    'speaker',
    'excerpt_text',
    'excerpt_digest',
    'bounds'
  ],
  bounds: ['start', 'end', 'unit'],
  ledger: ['ledger_id', 'state', 'reason', 'source_kind', 'source_id', 'row_digest'],
  projection_roundtrip: ['notion'],
  projection_roundtrip_notion: ['candidate_id_map'],
  conservation: [
    'input_growth_draft_rows',
    'input_reviewed_rows',
    'input_rows',
    'accepted_rows',
    'rejected_rows',
    'hold_rows',
    'source_occurrence_count',
    'source_span_count'
  ]
};

const REQUIRED_COUNT_PATHS = [
  'manifest.candidate_count',
  'manifest.source_span_count',
  'source_manifest.source_count',
  'source_manifest.source_occurrence_count',
  'source_manifest.source_span_count',
  'conservation.input_growth_draft_rows',
  'conservation.input_reviewed_rows',
  'conservation.input_rows',
  'conservation.accepted_rows',
  'conservation.rejected_rows',
  'conservation.hold_rows',
  'conservation.source_occurrence_count',
  'conservation.source_span_count'
];

const MAX_REF_STRING_LENGTH = 512;
const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const LEGACY_3B_COMPATIBILITY = {
  mode: 'legacy_v0_read_only_compat',
  public_driftstone_version: '3b8ace5b9f098a891889fec3cd3bb7a817daf8be',
  stripped_field: 'hippocove_import_policy'
};

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value || '')).digest('hex')}`;
}

function shortHash(value, length = 16) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function digestObject(value) {
  return sha256(stableJson(value));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export function buildPortableWarmLedgerId({
  state = '',
  sourceKind = '',
  sourceId = '',
  title = '',
  reason = ''
} = {}) {
  const normalizedState = safeText(state);
  if (normalizedState === 'hold') {
    return `hold_${shortHash(stableJson({
      sourceKind: safeText(sourceKind),
      sourceId: safeText(sourceId),
      title: safeText(title),
      reason: safeText(reason)
    }))}`;
  }
  if (normalizedState === 'rejected') {
    return `reject_${shortHash(stableJson({
      sourceKind: safeText(sourceKind),
      sourceId: safeText(sourceId),
      reason: safeText(reason)
    }))}`;
  }
  return '';
}

function withoutKey(value = {}, key = '') {
  const copy = { ...(value || {}) };
  delete copy[key];
  return copy;
}

function digestStoredSourceOccurrence(item = {}) {
  return digestObject(withoutKey(item, 'digest'));
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function validateAllowedKeys(value, allowedKeys, path, errors) {
  if (!isPlainObject(value)) return;
  Object.keys(value).forEach((key) => {
    if (!allowedKeys.has(key)) {
      pushError(errors, `${path}.${key}`, `unknown field ${key} is not part of the public portable Warm bundle contract.`);
    }
  });
}

function validateRequiredKeys(value, requiredKeys, path, errors) {
  if (!isPlainObject(value)) return;
  requiredKeys.forEach((key) => {
    if (!(key in value)) {
      pushError(errors, `${path}.${key}`, `${path}.${key} is required.`);
    }
  });
}

function validateRequiredObject(value, path, errors) {
  if (!isPlainObject(value)) {
    pushError(errors, path, `${path} object is required.`);
    return false;
  }
  return true;
}

function validateStringField(root, key, path, errors, { allowEmpty = false } = {}) {
  if (!isPlainObject(root) || !(key in root)) return;
  if (typeof root[key] !== 'string') {
    pushError(errors, `${path}.${key}`, `${path}.${key} must be a string.`);
    return;
  }
  if (!allowEmpty && !safeText(root[key])) {
    pushError(errors, `${path}.${key}`, `${path}.${key} must be a non-empty string.`);
  }
}

function validateArrayField(root, key, path, errors, { allowEmpty = true } = {}) {
  if (!isPlainObject(root) || !(key in root)) return;
  if (!Array.isArray(root[key])) {
    pushError(errors, `${path}.${key}`, `${path}.${key} must be an array.`);
    return;
  }
  if (!allowEmpty && root[key].length === 0) {
    pushError(errors, `${path}.${key}`, `${path}.${key} must not be empty.`);
  }
}

function validateStringArrayField(root, key, path, errors, { allowEmpty = true, maxLength = MAX_REF_STRING_LENGTH } = {}) {
  validateArrayField(root, key, path, errors, { allowEmpty });
  if (!isPlainObject(root) || !Array.isArray(root[key])) return;
  const seen = new Set();
  root[key].forEach((item, index) => {
    const itemPath = `${path}.${key}[${index}]`;
    if (typeof item !== 'string') {
      pushError(errors, itemPath, `${itemPath} must be a string.`);
      return;
    }
    const text = item.trim();
    if (!text) {
      pushError(errors, itemPath, `${itemPath} must be a non-empty string.`);
      return;
    }
    if (text.length > maxLength) {
      pushError(errors, itemPath, `${itemPath} must be at most ${maxLength} characters.`);
    }
    if (seen.has(text)) {
      pushError(errors, itemPath, `${itemPath} must be unique.`);
    }
    seen.add(text);
  });
}

function validateBooleanField(root, key, path, errors, expected = undefined) {
  if (!isPlainObject(root) || !(key in root)) return;
  if (typeof root[key] !== 'boolean') {
    pushError(errors, `${path}.${key}`, `${path}.${key} must be a boolean.`);
    return;
  }
  if (expected !== undefined && root[key] !== expected) {
    pushError(errors, `${path}.${key}`, `${path}.${key} must be ${expected}.`);
  }
}

function validateIntegerField(root, key, path, errors, { min = 0 } = {}) {
  if (!isPlainObject(root) || !(key in root)) return null;
  if (!Number.isInteger(root[key]) || root[key] < min) {
    pushError(errors, `${path}.${key}`, `${path}.${key} must be a non-negative integer.`);
    return null;
  }
  return root[key];
}

function validateDigestField(root, key, path, errors) {
  if (!isPlainObject(root) || !(key in root)) return;
  if (typeof root[key] !== 'string' || !SHA256_DIGEST_RE.test(root[key])) {
    pushError(errors, `${path}.${key}`, `${path}.${key} must be a lowercase sha256:64hex digest.`);
  }
}

function isPrivateSourceFileLabel(value = '') {
  const text = safeText(value);
  if (!text) return false;
  return Boolean(
    text.includes('/')
    || text.includes('\\')
    || /^[A-Za-z]:[\\/]/u.test(text)
    || /^\\\\[^\\]+\\[^\\]+/u.test(text)
    || text.includes('/Users/')
    || text.includes('/home/')
    || text.includes('/srv/')
  );
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
  validateAllowedKeys(card, KEYSETS.warm_card, basePath, errors);
  validateRequiredKeys(card, REQUIRED_KEYS.warm_card, basePath, errors);
  validateAllowedKeys(card?.portable_warm_card, KEYSETS.portable_warm_card, `${basePath}.portable_warm_card`, errors);
  validateRequiredObject(card?.portable_warm_card, `${basePath}.portable_warm_card`, errors);
  validateRequiredKeys(card?.portable_warm_card, REQUIRED_KEYS.portable_warm_card, `${basePath}.portable_warm_card`, errors);
  validateAllowedKeys(card?.source_refs, KEYSETS.source_refs, `${basePath}.source_refs`, errors);
  validateRequiredObject(card?.source_refs, `${basePath}.source_refs`, errors);
  validateRequiredKeys(card?.source_refs, REQUIRED_KEYS.source_refs, `${basePath}.source_refs`, errors);
  validateAllowedKeys(card?.privacy, KEYSETS.privacy, `${basePath}.privacy`, errors);
  validateRequiredObject(card?.privacy, `${basePath}.privacy`, errors);
  validateRequiredKeys(card?.privacy, REQUIRED_KEYS.privacy, `${basePath}.privacy`, errors);
  validateAllowedKeys(card?.quality, KEYSETS.quality, `${basePath}.quality`, errors);
  validateRequiredObject(card?.quality, `${basePath}.quality`, errors);
  validateRequiredKeys(card?.quality, REQUIRED_KEYS.quality, `${basePath}.quality`, errors);
  validateAllowedKeys(card?.home_import_policy, KEYSETS.import_policy, `${basePath}.home_import_policy`, errors);
  validateRequiredObject(card?.home_import_policy, `${basePath}.home_import_policy`, errors);
  validateRequiredKeys(card?.home_import_policy, REQUIRED_KEYS.import_policy, `${basePath}.home_import_policy`, errors);
  ['candidate_id', 'title', 'archive_bucket', 'frontend_delivery_tier'].forEach((key) => {
    validateStringField(card, key, basePath, errors);
  });
  ['body_markdown', 'living_fragment'].forEach((key) => {
    validateStringField(card?.portable_warm_card, key, `${basePath}.portable_warm_card`, errors);
  });
  ['feeling_as_fact', 'future_use_hint'].forEach((key) => {
    validateStringField(card?.portable_warm_card, key, `${basePath}.portable_warm_card`, errors, { allowEmpty: true });
  });
  validateStringArrayField(card?.portable_warm_card, 'voice_fingerprint_refs', `${basePath}.portable_warm_card`, errors);
  validateStringArrayField(card?.portable_warm_card, 'persona_refs', `${basePath}.portable_warm_card`, errors);
  validateStringArrayField(card?.source_refs, 'source_occurrence_ids', `${basePath}.source_refs`, errors, { allowEmpty: false });
  validateStringArrayField(card?.source_refs, 'source_span_ids', `${basePath}.source_refs`, errors, { allowEmpty: false });
  validateBooleanField(card?.privacy, 'local_only', `${basePath}.privacy`, errors, true);
  validateBooleanField(card?.privacy, 'projection_requires_user_action', `${basePath}.privacy`, errors, true);
  validateBooleanField(card?.quality, 'source_bound', `${basePath}.quality`, errors, true);
  validateBooleanField(card?.quality, 'source_complete', `${basePath}.quality`, errors, true);
  validateBooleanField(card?.quality, 'source_incomplete', `${basePath}.quality`, errors, false);
  validateIntegerField(card?.quality, 'source_span_count', `${basePath}.quality`, errors);
  validateBooleanField(card?.home_import_policy, 'direct_write_allowed', `${basePath}.home_import_policy`, errors, false);
  validateStringField(card?.home_import_policy, 'state', `${basePath}.home_import_policy`, errors);
  validateStringField(card?.home_import_policy, 'reason', `${basePath}.home_import_policy`, errors);
  if (!safeText(card?.candidate_id)) {
    pushError(errors, `${basePath}.candidate_id`, 'candidate_id is required for projection identity and future review patching.');
  }
  if (!safeText(card?.title)) {
    pushError(errors, `${basePath}.title`, 'title is required for human review surfaces.');
  }
  if (!isPlainObject(card?.portable_warm_card)) {
    pushError(errors, `${basePath}.portable_warm_card`, 'portable_warm_card object is required.');
  }
  const sourceSpanIds = Array.isArray(card?.source_refs?.source_span_ids) ? card.source_refs.source_span_ids : [];
  if (sourceSpanIds.length === 0) {
    pushError(errors, `${basePath}.source_refs.source_span_ids`, 'at least one source_span_id is required.');
  }
  if (card?.home_import_policy?.direct_write_allowed === true) {
    pushError(errors, `${basePath}.home_import_policy.direct_write_allowed`, 'Public bundle must not grant Home direct-write authority.');
  }
  if (card?.quality?.source_bound !== true) {
    pushError(errors, `${basePath}.quality.source_bound`, 'accepted portable Warm cards must be source_bound=true.');
  }
  if (card?.quality?.source_complete !== true) {
    pushError(errors, `${basePath}.quality.source_complete`, 'accepted portable Warm cards must be source_complete=true.');
  }
  if (card?.quality?.source_incomplete !== false) {
    pushError(errors, `${basePath}.quality.source_incomplete`, 'accepted portable Warm cards must be source_incomplete=false.');
  }
  if (Number(card?.quality?.source_span_count) !== sourceSpanIds.length) {
    pushError(errors, `${basePath}.quality.source_span_count`, 'quality.source_span_count must match source_refs.source_span_ids length.');
  }
  if (!safeText(card?.frontend_delivery_tier)) {
    warnings.push({
      path: `${basePath}.frontend_delivery_tier`,
      message: 'frontend_delivery_tier is recommended so projections do not treat stable archive as default frontend recall.'
    });
  }
}

function stripLegacyReadOnlyCompatibilityFields(bundle = {}) {
  const normalizedBundle = cloneJson(bundle);
  const errors = [];
  const strippedFields = [];
  (Array.isArray(normalizedBundle?.warm_cards) ? normalizedBundle.warm_cards : []).forEach((card, index) => {
    if (!isPlainObject(card) || !Object.prototype.hasOwnProperty.call(card, 'hippocove_import_policy')) return;
    const path = `warm_cards[${index}].hippocove_import_policy`;
    const policy = card.hippocove_import_policy;
    validateRequiredObject(policy, path, errors);
    validateAllowedKeys(policy, KEYSETS.import_policy, path, errors);
    validateRequiredKeys(policy, REQUIRED_KEYS.import_policy, path, errors);
    validateBooleanField(policy, 'direct_write_allowed', path, errors, false);
    validateStringField(policy, 'state', path, errors);
    validateStringField(policy, 'reason', path, errors);
    strippedFields.push({
      path,
      field: LEGACY_3B_COMPATIBILITY.stripped_field
    });
    delete card.hippocove_import_policy;
  });
  return { bundle: normalizedBundle, errors, strippedFields };
}

function withRecomputedManifestDigest(bundle = {}) {
  const next = cloneJson(bundle);
  if (isPlainObject(next?.manifest)) {
    next.manifest.manifest_digest = digestObject({
      ...next,
      manifest: {
        ...next.manifest,
        manifest_digest: ''
      }
    });
  }
  return next;
}

export function normalizePortableWarmBundleForRead(bundle = {}) {
  const strictValidation = validatePortableWarmBundle(bundle);
  if (strictValidation.ok) {
    const readCompatibility = {
      mode: 'current_contract',
      stripped_fields: []
    };
    return {
      ok: true,
      bundle,
      validation: {
        ...strictValidation,
        read_compatibility: readCompatibility
      },
      read_compatibility: readCompatibility
    };
  }

  const legacy = stripLegacyReadOnlyCompatibilityFields(bundle);
  if (!legacy.strippedFields.length) {
    const readCompatibility = {
      mode: 'strict_rejected',
      stripped_fields: []
    };
    return {
      ok: false,
      bundle,
      validation: {
        ...strictValidation,
        read_compatibility: readCompatibility
      },
      read_compatibility: readCompatibility
    };
  }

  const strippedFieldPaths = new Set(legacy.strippedFields.map((item) => item.path));
  const nonCompatibilityErrors = strictValidation.errors.filter((error) => !strippedFieldPaths.has(error.path));
  const readCompatibility = {
    ...LEGACY_3B_COMPATIBILITY,
    disposition: 'stripped_before_read_only_inspection_or_projection',
    current_write_contract: 'rejected_by_validatePortableWarmBundle',
    original_manifest_digest: safeText(bundle?.manifest?.manifest_digest),
    stripped_fields: legacy.strippedFields
  };
  if (nonCompatibilityErrors.length) {
    return {
      ok: false,
      bundle,
      validation: {
        ...strictValidation,
        read_compatibility: {
          ...readCompatibility,
          mode: 'legacy_v0_rejected_non_compat_errors'
        }
      },
      read_compatibility: {
        ...readCompatibility,
        mode: 'legacy_v0_rejected_non_compat_errors'
      }
    };
  }
  if (legacy.errors.length) {
    return {
      ok: false,
      bundle: legacy.bundle,
      validation: {
        ...strictValidation,
        errors: [...strictValidation.errors, ...legacy.errors],
        read_compatibility: readCompatibility
      },
      read_compatibility: readCompatibility
    };
  }

  const normalizedBundle = withRecomputedManifestDigest(legacy.bundle);
  readCompatibility.normalized_manifest_digest = safeText(normalizedBundle?.manifest?.manifest_digest);
  const normalizedValidation = validatePortableWarmBundle(normalizedBundle);
  return {
    ok: normalizedValidation.ok,
    bundle: normalizedBundle,
    validation: {
      ...normalizedValidation,
      read_compatibility: readCompatibility
    },
    read_compatibility: readCompatibility
  };
}

function validateSourceOccurrence(item, index, errors) {
  const basePath = `source_occurrences[${index}]`;
  validateAllowedKeys(item, KEYSETS.source_occurrence, basePath, errors);
  validateRequiredKeys(item, REQUIRED_KEYS.source_occurrence, basePath, errors);
  ['source_occurrence_id', 'source_id', 'source_kind', 'turn_range', 'digest'].forEach((key) => {
    validateStringField(item, key, basePath, errors);
  });
  ['source_file', 'source_file_digest', 'source_window', 'source_time'].forEach((key) => {
    validateStringField(item, key, basePath, errors, { allowEmpty: true });
  });
  validateStringArrayField(item, 'message_ids', basePath, errors);
  if (safeText(item?.source_file) && !safeText(item?.source_file_digest)) {
    pushError(errors, `${basePath}.source_file_digest`, 'source_file_digest is required when source_file is present.');
  }
  if (safeText(item?.source_file_digest) && !SHA256_DIGEST_RE.test(item.source_file_digest)) {
    pushError(errors, `${basePath}.source_file_digest`, 'source_file_digest must be a lowercase sha256:64hex digest.');
  }
  if (isPrivateSourceFileLabel(item?.source_file)) {
    pushError(errors, `${basePath}.source_file`, 'source_file must be a sanitized label, not a local or private path.');
  }
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
  } else {
    const expectedDigest = digestStoredSourceOccurrence(item);
    if (item.digest !== expectedDigest) {
      pushError(errors, `${basePath}.digest`, 'digest must match the stored canonical source occurrence projection.');
    }
  }
}

function validateSourceSpan(item, index, errors) {
  const basePath = `source_spans[${index}]`;
  validateAllowedKeys(item, KEYSETS.source_span, basePath, errors);
  validateRequiredKeys(item, REQUIRED_KEYS.source_span, basePath, errors);
  ['source_span_id', 'source_occurrence_id', 'turn_range', 'speaker', 'excerpt_text', 'excerpt_digest'].forEach((key) => {
    validateStringField(item, key, basePath, errors);
  });
  validateStringArrayField(item, 'message_ids', basePath, errors);
  validateAllowedKeys(item?.bounds, KEYSETS.bounds, `${basePath}.bounds`, errors);
  validateRequiredKeys(item?.bounds, REQUIRED_KEYS.bounds, `${basePath}.bounds`, errors);
  if (!safeText(item?.source_span_id)) {
    pushError(errors, `${basePath}.source_span_id`, 'source_span_id is required.');
  }
  if (!safeText(item?.source_occurrence_id)) {
    pushError(errors, `${basePath}.source_occurrence_id`, 'source_occurrence_id is required.');
  }
  if (!safeText(item?.excerpt_text) && !safeText(item?.excerpt_digest)) {
    pushError(errors, `${basePath}.excerpt_text`, 'bounded excerpt_text or excerpt_digest is required.');
  }
  if (safeText(item?.excerpt_text) && safeText(item?.excerpt_digest)) {
    const expectedDigest = sha256(item.excerpt_text);
    if (item.excerpt_digest !== expectedDigest) {
      pushError(errors, `${basePath}.excerpt_digest`, 'excerpt_digest must match excerpt_text.');
    }
  }
  if (!isPlainObject(item?.bounds)) {
    pushError(errors, `${basePath}.bounds`, 'bounds are required for source span integrity.');
    return;
  }
  const start = Number(item.bounds.start);
  const end = Number(item.bounds.end);
  validateIntegerField(item.bounds, 'start', `${basePath}.bounds`, errors);
  validateIntegerField(item.bounds, 'end', `${basePath}.bounds`, errors);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    pushError(errors, `${basePath}.bounds`, 'bounds.start/end must be a valid non-negative range.');
  }
  if (start !== 0) {
    pushError(errors, `${basePath}.bounds.start`, 'bounds.start must be 0 for stored bounded excerpts.');
  }
  if (safeText(item?.excerpt_text) && end !== String(item.excerpt_text || '').length) {
    pushError(errors, `${basePath}.bounds.end`, 'bounds.end must match excerpt_text UTF-16 length.');
  }
  if (item.bounds.unit !== 'utf16_code_units') {
    pushError(errors, `${basePath}.bounds.unit`, 'bounds.unit must be utf16_code_units.');
  }
}

function validateUniqueIds(rows = [], field = '', basePath = '', errors = []) {
  const seen = new Set();
  rows.forEach((row, index) => {
    const id = safeText(row?.[field]);
    if (!id) return;
    if (seen.has(id)) {
      pushError(errors, `${basePath}[${index}].${field}`, `${field} must be unique.`);
    }
    seen.add(id);
  });
  return seen;
}

function validateTopLevelKeys(bundle = {}, errors = []) {
  REQUIRED_TOP_LEVEL_KEYS.forEach((key) => {
    if (!(key in bundle)) {
      pushError(errors, key, `${key} is required by the public portable Warm bundle contract.`);
    }
  });
  Object.keys(bundle).forEach((key) => {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      pushError(errors, key, `unknown top-level field ${key} is not part of the public portable Warm bundle contract.`);
    }
  });
}

function validateRequiredObjectKeys(bundle = {}, errors = []) {
  validateAllowedKeys(bundle.manifest, KEYSETS.manifest, 'manifest', errors);
  validateRequiredObject(bundle.manifest, 'manifest', errors);
  validateRequiredKeys(bundle.manifest, REQUIRED_KEYS.manifest, 'manifest', errors);
  ['bundle_id', 'created_at', 'generator', 'manifest_digest'].forEach((key) => {
    validateStringField(bundle.manifest, key, 'manifest', errors);
  });
  validateAllowedKeys(bundle?.manifest?.scope, KEYSETS.manifest_scope, 'manifest.scope', errors);
  validateRequiredObject(bundle?.manifest?.scope, 'manifest.scope', errors);
  validateRequiredKeys(bundle?.manifest?.scope, REQUIRED_KEYS.manifest_scope, 'manifest.scope', errors);
  ['owner_id', 'realm_id', 'bot_id'].forEach((key) => {
    validateStringField(bundle?.manifest?.scope, key, 'manifest.scope', errors, { allowEmpty: true });
  });
  validateAllowedKeys(bundle.source_manifest, KEYSETS.source_manifest, 'source_manifest', errors);
  validateRequiredObject(bundle.source_manifest, 'source_manifest', errors);
  validateRequiredKeys(bundle.source_manifest, REQUIRED_KEYS.source_manifest, 'source_manifest', errors);
  validateStringField(bundle.source_manifest, 'source_digest', 'source_manifest', errors);
  validateAllowedKeys(bundle.persona_authority, KEYSETS.persona_authority, 'persona_authority', errors);
  validateRequiredObject(bundle.persona_authority, 'persona_authority', errors);
  validateRequiredKeys(bundle.persona_authority, REQUIRED_KEYS.persona_authority, 'persona_authority', errors);
  ['authority', 'persona_digest', 'language_fingerprint_digest'].forEach((key) => {
    validateStringField(bundle.persona_authority, key, 'persona_authority', errors, { allowEmpty: true });
  });
  validateAllowedKeys(bundle.projection_roundtrip, KEYSETS.projection_roundtrip, 'projection_roundtrip', errors);
  validateRequiredObject(bundle.projection_roundtrip, 'projection_roundtrip', errors);
  validateRequiredKeys(bundle.projection_roundtrip, REQUIRED_KEYS.projection_roundtrip, 'projection_roundtrip', errors);
  validateAllowedKeys(bundle?.projection_roundtrip?.notion, KEYSETS.projection_roundtrip_notion, 'projection_roundtrip.notion', errors);
  validateRequiredObject(bundle?.projection_roundtrip?.notion, 'projection_roundtrip.notion', errors);
  validateRequiredKeys(bundle?.projection_roundtrip?.notion, REQUIRED_KEYS.projection_roundtrip_notion, 'projection_roundtrip.notion', errors);
  validateArrayField(bundle?.projection_roundtrip?.notion, 'candidate_id_map', 'projection_roundtrip.notion', errors);
  if (Array.isArray(bundle?.projection_roundtrip?.notion?.candidate_id_map) && bundle.projection_roundtrip.notion.candidate_id_map.length !== 0) {
    pushError(errors, 'projection_roundtrip.notion.candidate_id_map', 'candidate_id_map must be empty in v0 because local review patch apply is not implemented.');
  }
  validateAllowedKeys(bundle.conservation, KEYSETS.conservation, 'conservation', errors);
  validateRequiredObject(bundle.conservation, 'conservation', errors);
  validateRequiredKeys(bundle.conservation, REQUIRED_KEYS.conservation, 'conservation', errors);
  validateLedgerRows(bundle.rejected_ledger, 'rejected_ledger', 'rejected', errors);
  validateLedgerRows(bundle.hold_ledger, 'hold_ledger', 'hold', errors);
}

function validateLedgerRows(rows = [], basePath = '', expectedState = '', errors = []) {
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const rowPath = `${basePath}[${index}]`;
    validateAllowedKeys(row, KEYSETS.ledger, rowPath, errors);
    validateRequiredKeys(row, REQUIRED_KEYS.ledger, rowPath, errors);
    ['ledger_id', 'state', 'reason', 'source_kind', 'source_id', 'row_digest'].forEach((key) => {
      validateStringField(row, key, rowPath, errors);
    });
    validateStringField(row, 'title', rowPath, errors, { allowEmpty: true });
    validateStringField(row, 'review_note', rowPath, errors, { allowEmpty: true });
    validateDigestField(row, 'row_digest', rowPath, errors);
    if (safeText(row?.state) !== expectedState) {
      pushError(errors, `${rowPath}.state`, `${rowPath}.state must be ${expectedState}.`);
    }
    const expectedLedgerId = buildPortableWarmLedgerId({
      state: expectedState,
      sourceKind: row?.source_kind,
      sourceId: row?.source_id,
      title: row?.title,
      reason: row?.reason
    });
    if (safeText(row?.ledger_id) && row.ledger_id !== expectedLedgerId) {
      pushError(errors, `${rowPath}.ledger_id`, `${rowPath}.ledger_id must match the deterministic ledger identity.`);
    }
  });
}

function validateManifestDigests(bundle = {}, errors = []) {
  const sourceOccurrences = Array.isArray(bundle.source_occurrences) ? bundle.source_occurrences : [];
  const sourceSpans = Array.isArray(bundle.source_spans) ? bundle.source_spans : [];
  const expectedSourceDigest = digestObject({
    source_occurrences: sourceOccurrences,
    source_spans: sourceSpans
  });
  if (!safeText(bundle?.source_manifest?.source_digest)) {
    pushError(errors, 'source_manifest.source_digest', 'source_manifest.source_digest is required.');
  } else if (bundle.source_manifest.source_digest !== expectedSourceDigest) {
    pushError(errors, 'source_manifest.source_digest', 'source_manifest.source_digest must match source_occurrences + source_spans.');
  }

  const manifestWithoutDigest = {
    ...(bundle.manifest || {}),
    manifest_digest: ''
  };
  const expectedManifestDigest = digestObject({
    ...bundle,
    manifest: manifestWithoutDigest
  });
  if (!safeText(bundle?.manifest?.manifest_digest)) {
    pushError(errors, 'manifest.manifest_digest', 'manifest.manifest_digest is required.');
  } else if (bundle.manifest.manifest_digest !== expectedManifestDigest) {
    pushError(errors, 'manifest.manifest_digest', 'manifest.manifest_digest must match the full canonical bundle content.');
  }
}

function getPathValue(root = {}, path = '') {
  return path.split('.').reduce((value, key) => (isPlainObject(value) ? value[key] : undefined), root);
}

function validateRequiredCount(bundle = {}, path = '', errors = []) {
  const value = getPathValue(bundle, path);
  if (value === undefined || value === null || value === '') {
    pushError(errors, path, `${path} is required.`);
    return null;
  }
  const numeric = Number(value);
  if (typeof value !== 'number' || !Number.isInteger(numeric) || numeric < 0) {
    pushError(errors, path, `${path} must be a non-negative integer.`);
    return null;
  }
  return numeric;
}

function validateCounts(bundle = {}, errors = []) {
  const warmCards = Array.isArray(bundle.warm_cards) ? bundle.warm_cards : [];
  const sourceOccurrences = Array.isArray(bundle.source_occurrences) ? bundle.source_occurrences : [];
  const sourceSpans = Array.isArray(bundle.source_spans) ? bundle.source_spans : [];
  const rejected = Array.isArray(bundle.rejected_ledger) ? bundle.rejected_ledger : [];
  const hold = Array.isArray(bundle.hold_ledger) ? bundle.hold_ledger : [];
  const manifest = bundle.manifest || {};
  const sourceManifest = bundle.source_manifest || {};
  const conservation = bundle.conservation || {};

  const countValues = new Map(REQUIRED_COUNT_PATHS.map((path) => [path, validateRequiredCount(bundle, path, errors)]));
  const expected = [
    ['manifest.candidate_count', manifest.candidate_count, warmCards.length],
    ['manifest.source_span_count', manifest.source_span_count, sourceSpans.length],
    ['source_manifest.source_count', sourceManifest.source_count, sourceOccurrences.length],
    ['source_manifest.source_occurrence_count', sourceManifest.source_occurrence_count, sourceOccurrences.length],
    ['source_manifest.source_span_count', sourceManifest.source_span_count, sourceSpans.length],
    ['conservation.accepted_rows', conservation.accepted_rows, warmCards.length],
    ['conservation.rejected_rows', conservation.rejected_rows, rejected.length],
    ['conservation.hold_rows', conservation.hold_rows, hold.length],
    ['conservation.source_occurrence_count', conservation.source_occurrence_count, sourceOccurrences.length],
    ['conservation.source_span_count', conservation.source_span_count, sourceSpans.length]
  ];

  for (const [path, value, actual] of expected) {
    if (countValues.get(path) === null) continue;
    if (Number(value) !== actual) pushError(errors, path, `${path} must equal ${actual}.`);
  }
  const inputRows = countValues.get('conservation.input_rows');
  const growthRows = countValues.get('conservation.input_growth_draft_rows');
  const reviewedRows = countValues.get('conservation.input_reviewed_rows');
  const acceptedRows = countValues.get('conservation.accepted_rows');
  const rejectedRows = countValues.get('conservation.rejected_rows');
  const holdRows = countValues.get('conservation.hold_rows');
  if (inputRows !== null && growthRows !== null && reviewedRows !== null && inputRows !== growthRows + reviewedRows) {
    pushError(errors, 'conservation.input_rows', 'conservation.input_rows must equal input_growth_draft_rows + input_reviewed_rows.');
  }
  if (inputRows !== null && acceptedRows !== null && rejectedRows !== null && holdRows !== null && inputRows !== acceptedRows + rejectedRows + holdRows) {
    pushError(errors, 'conservation.input_rows', 'conservation.input_rows must equal accepted_rows + rejected_rows + hold_rows.');
  }
}

function validateReferences(bundle = {}, errors = []) {
  const occurrenceIds = validateUniqueIds(bundle.source_occurrences, 'source_occurrence_id', 'source_occurrences', errors);
  const spanIds = validateUniqueIds(bundle.source_spans, 'source_span_id', 'source_spans', errors);
  validateUniqueIds(bundle.warm_cards, 'candidate_id', 'warm_cards', errors);
  validateUniqueIds(bundle.rejected_ledger, 'ledger_id', 'rejected_ledger', errors);
  validateUniqueIds(bundle.hold_ledger, 'ledger_id', 'hold_ledger', errors);

  const spanOccurrenceById = new Map();
  (Array.isArray(bundle.source_spans) ? bundle.source_spans : []).forEach((span, index) => {
    const spanId = safeText(span?.source_span_id);
    const occurrenceId = safeText(span?.source_occurrence_id);
    if (occurrenceId && !occurrenceIds.has(occurrenceId)) {
      pushError(errors, `source_spans[${index}].source_occurrence_id`, 'source_span must reference an existing source_occurrence_id.');
    }
    if (spanId) spanOccurrenceById.set(spanId, occurrenceId);
  });

  (Array.isArray(bundle.warm_cards) ? bundle.warm_cards : []).forEach((card, index) => {
    const sourceSpanIds = Array.isArray(card?.source_refs?.source_span_ids) ? card.source_refs.source_span_ids : [];
    const sourceOccurrenceIds = Array.isArray(card?.source_refs?.source_occurrence_ids) ? card.source_refs.source_occurrence_ids : [];
    const sourceOccurrenceIdSet = new Set(sourceOccurrenceIds.map((item) => safeText(item)).filter(Boolean));
    const expectedOccurrenceIdSet = new Set();
    sourceOccurrenceIds.forEach((occurrenceId, occurrenceIndex) => {
      const id = safeText(occurrenceId);
      if (id && !occurrenceIds.has(id)) {
        pushError(errors, `warm_cards[${index}].source_refs.source_occurrence_ids[${occurrenceIndex}]`, 'card source_occurrence_id must exist.');
      }
    });
    sourceSpanIds.forEach((spanId, spanIndex) => {
      const id = safeText(spanId);
      if (!id || !spanIds.has(id)) {
        pushError(errors, `warm_cards[${index}].source_refs.source_span_ids[${spanIndex}]`, 'card source_span_id must exist.');
        return;
      }
      const occurrenceId = spanOccurrenceById.get(id);
      if (occurrenceId) expectedOccurrenceIdSet.add(occurrenceId);
      if (sourceOccurrenceIdSet.size && occurrenceId && !sourceOccurrenceIdSet.has(occurrenceId)) {
        pushError(errors, `warm_cards[${index}].source_refs.source_span_ids[${spanIndex}]`, 'card source_span_id must belong to one of the card source_occurrence_ids.');
      }
    });
    const missingOccurrenceIds = Array.from(expectedOccurrenceIdSet).filter((item) => !sourceOccurrenceIdSet.has(item));
    const extraOccurrenceIds = Array.from(sourceOccurrenceIdSet).filter((item) => !expectedOccurrenceIdSet.has(item));
    if (missingOccurrenceIds.length || extraOccurrenceIds.length) {
      pushError(errors, `warm_cards[${index}].source_refs.source_occurrence_ids`, 'card source_occurrence_ids must exactly match the occurrences proven by source_span_ids.');
    }
  });
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
        'source_file_digest',
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
          key_fields: ['source_occurrence_id', 'bundle_id', 'source_kind', 'source_file', 'source_file_digest', 'source_window', 'digest']
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
        review_backflow: 'Future Notion review exports must return candidate_id + base_digest + patch fields; this public build does not yet apply review patches.'
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
  validateTopLevelKeys(bundle, errors);
  if (!isPlainObject(bundle.manifest) || !safeText(bundle.manifest.bundle_id)) {
    pushError(errors, 'manifest.bundle_id', 'manifest.bundle_id is required.');
  }
  if (!isPlainObject(bundle.source_manifest)) {
    pushError(errors, 'source_manifest', 'source_manifest is required.');
  }
  REQUIRED_BUNDLE_ARRAYS.forEach((key) => {
    if (!Array.isArray(bundle[key])) pushError(errors, key, `${key} must be an array.`);
  });
  validateRequiredObjectKeys(bundle, errors);
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
  validateReferences(bundle, errors);
  validateCounts(bundle, errors);
  validateManifestDigests(bundle, errors);

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
