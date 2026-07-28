import { createHash } from 'node:crypto';

export const PORTABLE_ARTIFACT_SCHEMA = 'driftstone_portable_memory_artifact_v1';
export const PORTABLE_REJECTION_SCHEMA = 'driftstone_portable_memory_rejection_v1';
export const PORTABLE_LEDGER_SCHEMA = 'driftstone_portable_memory_conservation_v1';
export const NOTION_PROJECTION_SCHEMA = 'driftstone_portable_notion_projection_v1';
export const MARKDOWN_PROJECTION_SCHEMA = 'driftstone_portable_markdown_projection_v1';

export class PortableArtifactError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PortableArtifactError';
    this.code = code;
    this.details = details;
  }
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').replace(/\r/g, '').trim();
  return text || fallback;
}

function explicitObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = [], limit = 4096) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = safeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function firstText(...values) {
  for (const value of values) {
    const text = safeText(value);
    if (text) return text;
  }
  return '';
}

function canonicalize(value, path = '$', ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PortableArtifactError('non_json_value', 'Non-finite numbers are forbidden in canonical JSON.', {
        path,
        value_kind: String(value)
      });
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new PortableArtifactError('non_json_value', 'Canonical JSON accepts only JSON-compatible values.', {
      path,
      value_kind: typeof value
    });
  }
  if (ancestors.has(value)) {
    throw new PortableArtifactError('non_json_value', 'Circular values are forbidden in canonical JSON.', {
      path,
      value_kind: 'circular_reference'
    });
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalize(item, `${path}[${index}]`, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PortableArtifactError('non_json_value', 'Non-plain objects are forbidden in canonical JSON.', {
        path,
        value_kind: value.constructor?.name || 'non_plain_object'
      });
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key], `${path}.${key}`, ancestors)])
    );
  } finally {
    ancestors.delete(value);
  }
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function jsonClone(value) {
  return JSON.parse(stableJson(value ?? null));
}

function splitListValue(value) {
  if (Array.isArray(value)) return uniqueStrings(value.flatMap((item) => splitListValue(item)));
  if (value && typeof value === 'object') return [stableJson(value)];
  const text = safeText(value);
  if (!text) return [];
  return uniqueStrings(text.split(/\s*(?:[,，;；|]|\n)\s*/u));
}

const LABEL_FIELD_NAMES = new Set([
  'action_handles',
  'activation_triggers',
  'aliases',
  'anchor_type',
  'archive_bucket',
  'batch_tag',
  'candidate_kind',
  'card_type',
  'category',
  'companion_voice_tier',
  'context_domain',
  'dialogue_type',
  'dialogue_types',
  'evolution_status',
  'expression_fingerprint',
  'fact_role',
  'family_kind',
  'feeling_handles',
  'front_recall_tier',
  'import_status',
  'layer',
  'linked_entities',
  'memory_shape',
  'memory_type',
  'node_kind',
  'quality_flags',
  'recall_guard',
  'recall_lane',
  'relation_handles',
  'relation_path',
  'relation_vine_ids',
  'review_status',
  'root_refs',
  'scene_anchor',
  'sensory_handles',
  'source_tags',
  'span_role',
  'sql_row_kind',
  'tags',
  'target_layer',
  'topic_exposure_priorities',
  'topic_ids',
  'topic_label',
  'topic_labels',
  'topic_role'
]);

function visitObject(value, visitor, path = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitObject(item, visitor, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    visitor({ key, path: childPath, value: child });
    if (child && typeof child === 'object') visitObject(child, visitor, childPath);
  }
}

function collectExactFields(payloads, predicate) {
  const fields = {};
  for (const [payloadName, payload] of Object.entries(payloads)) {
    visitObject(payload, ({ key, path, value }) => {
      if (!predicate(key, value)) return;
      fields[`${payloadName}.${path}`] = jsonClone(value);
    });
  }
  return canonicalize(fields);
}

function collectExactFieldAudit(payloads) {
  const fields = {};
  for (const [payloadName, payload] of Object.entries(payloads)) {
    visitObject(payload, ({ path, value }) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return;
      const fieldPath = `${payloadName}.${path}`;
      fields[fieldPath] = {
        value_type: Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value),
        value_sha256: sha256(value)
      };
    });
  }
  return canonicalize(fields);
}

function collectLabels(payloads) {
  const sourceFields = collectExactFields(payloads, (key) => LABEL_FIELD_NAMES.has(key));
  const exactFieldAudit = collectExactFieldAudit(payloads);
  const unclassifiedLabelPattern = /(?:tag|label|taxonomy|class|type|kind|lane|domain|category|topic|shape|role|tier|bucket|guard|status|state|flag|handle)$/iu;
  const unclassifiedLabelFields = collectExactFields(payloads, (key) => (
    !LABEL_FIELD_NAMES.has(key) && unclassifiedLabelPattern.test(key)
  ));
  const normalizedCandidates = uniqueStrings(
    [...Object.values(sourceFields), ...Object.values(unclassifiedLabelFields)]
      .flatMap((value) => splitListValue(value))
  );
  return {
    preservation_state: 'exact_source_fields_full_payload_audit_plus_normalized_candidates',
    source_fields: sourceFields,
    unclassified_label_fields: unclassifiedLabelFields,
    exact_field_audit: exactFieldAudit,
    normalized_candidates: normalizedCandidates,
    source_field_count: Object.keys(sourceFields).length,
    unclassified_label_field_count: Object.keys(unclassifiedLabelFields).length,
    exact_field_audit_count: Object.keys(exactFieldAudit).length,
    normalized_candidate_count: normalizedCandidates.length
  };
}

function collectOriginalIdentifiers(payloads) {
  const identifierPattern = /(?:^|_)(?:id|ids|key|keys|ref|refs|hash)$/u;
  const fields = collectExactFields(payloads, (key, value) => (
    identifierPattern.test(key)
    && (typeof value === 'string' || typeof value === 'number' || Array.isArray(value))
  ));
  return {
    preservation_state: 'exact_source_fields',
    fields,
    field_count: Object.keys(fields).length
  };
}

function collectStateFields(payloads) {
  const statePattern = /(?:state|status|policy|quality|review|stage|tier|guard|bucket)$/u;
  return collectExactFields(payloads, (key) => statePattern.test(key));
}

function collectAuthorityClaims(payloads) {
  const authorityPattern = /(?:authority|attested|receipt|canonical|verified|approval|owner)$/u;
  return collectExactFields(payloads, (key) => authorityPattern.test(key));
}

function collectTextFields(payloads) {
  const textPattern = /(?:^|_)(?:text|title|summary|fragment|fact|value|note|decision|background|points|claim|quote|content|reflection)$/u;
  return collectExactFields(payloads, (key, value) => (
    textPattern.test(key)
    && (typeof value === 'string' || Array.isArray(value))
  ));
}

function normalizeLayer(value) {
  const layer = safeText(value).toLowerCase();
  if (layer === 'persona') return { source_layer: 'persona', candidate_lane: 'persona' };
  if (['sql', 'fact', 'atomic_fact'].includes(layer)) return { source_layer: layer, candidate_lane: 'fact' };
  if (['case', 'case_index', 'case_event'].includes(layer)) {
    throw new PortableArtifactError(
      'historical_case_forbidden',
      'Historical CASE extraction is not part of the owner-approved Driftstone contract.',
      { source_layer: layer }
    );
  }
  throw new PortableArtifactError(
    'source_layer_missing_or_unknown',
    'An explicit persona or sql/fact source layer is required; text inference is forbidden.',
    { source_layer: layer || 'missing' }
  );
}

function monthFromText(value = '') {
  const text = safeText(value);
  const dashed = text.match(/(20\d{2})-(\d{2})/u);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/u);
  return compact ? `${compact[1]}-${compact[2]}` : '';
}

function resolveLayerTruth(
  input,
  reviewedRow,
  node,
  candidate,
  workbenchRecords = [],
  sourceIndexAnchors = []
) {
  const supplied = [
    ['reviewed_row.layer', reviewedRow.layer],
    ['node.layer', node.layer],
    ['candidate.layer', candidate.layer],
    ...workbenchRecords.map((row, index) => [
      `workbench_records[${index}].layer`,
      row.layer
    ]),
    ...sourceIndexAnchors.map((row, index) => [
      `source_index_anchors[${index}].layer`,
      row.layer
    ]),
    ['input.layer', input.layer]
  ].filter(([, value]) => safeText(value));
  if (!supplied.length) return normalizeLayer('');
  const normalized = supplied.map(([source, value]) => {
    try {
      return { source, raw: safeText(value), ...normalizeLayer(value) };
    } catch (error) {
      if (error instanceof PortableArtifactError) {
        error.details = { ...error.details, source_field: source };
      }
      throw error;
    }
  });
  const lanes = uniqueStrings(normalized.map((item) => item.candidate_lane));
  if (lanes.length !== 1) {
    throw new PortableArtifactError(
      'source_layer_conflict',
      'Persistent source layers disagree; input overrides cannot choose a winner.',
      { supplied: normalized }
    );
  }
  const preferred = normalized.find((item) => item.source === 'reviewed_row.layer')
    || normalized.find((item) => item.source === 'node.layer')
    || normalized.find((item) => item.source === 'candidate.layer')
    || normalized[0];
  return {
    source_layer: preferred.source_layer,
    candidate_lane: preferred.candidate_lane
  };
}

function resolveMonthTruth(
  input,
  reviewedRow,
  node,
  candidate,
  workbenchRecords = []
) {
  const supplied = [
    ['reviewed_row.month_key', reviewedRow.month_key],
    ['reviewed_row.source_file', monthFromText(reviewedRow.source_file)],
    ['node.month_key', node.month_key],
    ['candidate.month_key', candidate.month_key],
    ...workbenchRecords.flatMap((row, index) => [
      [`workbench_records[${index}].month_key`, row.month_key],
      [`workbench_records[${index}].source_file`, monthFromText(row.source_file)]
    ]),
    ['input.month_key', input.month_key]
  ]
    .map(([source, value]) => [source, monthFromText(value) || safeText(value)])
    .filter(([, value]) => safeText(value));
  const months = uniqueStrings(supplied.map(([, value]) => value));
  if (months.length > 1) {
    throw new PortableArtifactError(
      'month_key_conflict',
      'Persistent month identities disagree; input overrides cannot choose a winner.',
      { supplied: supplied.map(([source, value]) => ({ source, month_key: value })) }
    );
  }
  const monthKey = months[0] || '';
  if (monthKey && !/^20\d{2}-(?:0[1-9]|1[0-2])$/u.test(monthKey)) {
    throw new PortableArtifactError(
      'month_key_invalid',
      'Month identity must use a real YYYY-MM value.',
      { month_key: monthKey, supplied: supplied.map(([source, value]) => ({ source, month_key: value })) }
    );
  }
  return monthKey;
}

function artifactIdPart(value) {
  return encodeURIComponent(safeText(value, 'missing')).replace(/%/gu, '~');
}

function textCandidate(path, value) {
  if (value && typeof value === 'object') return null;
  const text = safeText(value);
  return text ? { source_field: path, text } : null;
}

function scalarText(value) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return '';
  return safeText(value);
}

function structuredFactCandidate(path, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    source_field: path,
    value: jsonClone(value)
  };
}

function factTextFromStructured(value = {}) {
  return firstText(
    scalarText(value.fact_value),
    scalarText(value.value),
    scalarText(value.claim),
    scalarText(value.text)
  );
}

function sqlCardMasterTextCandidate(path, row = {}) {
  if (safeText(row.layer).toLowerCase() !== 'sql') return null;
  if (safeText(row.sql_row_kind).toLowerCase() !== 'card_master') return null;
  if (!safeText(row.fact_keys) || !safeText(row.fact_role)) return null;
  return textCandidate(`${path}.text`, row.text);
}

function buildAtomicFact({
  lane,
  reviewedRow,
  node,
  candidate,
  workbenchRecords = []
}) {
  if (lane !== 'fact') {
    return {
      status: 'not_applicable_to_persona_lane',
      primary_text: '',
      primary_source_field: '',
      fact_text_candidates: [],
      structured_fact_candidates: [],
      subject_candidate: '',
      predicate_candidate: '',
      object_candidate: '',
      canonical_fact_granted: false
    };
  }

  const facts = safeArray(candidate.facts);
  const structuredFacts = facts
    .map((value, index) => structuredFactCandidate(`candidate.facts[${index}]`, value))
    .filter(Boolean);
  const factTexts = facts.flatMap((value, index) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const text = factTextFromStructured(value);
      return text ? [textCandidate(`candidate.facts[${index}]`, text)] : [];
    }
    return [textCandidate(`candidate.facts[${index}]`, value)].filter(Boolean);
  });
  const candidates = [
    textCandidate('reviewed_row.fact_value', reviewedRow.fact_value),
    ...workbenchRecords.map((row, index) => (
      textCandidate(`workbench_records[${index}].fact_value`, row.fact_value)
    )),
    textCandidate('candidate.raw_machine_fact', candidate.raw_machine_fact),
    ...factTexts,
    textCandidate('node.project_fact', node.project_fact),
    sqlCardMasterTextCandidate('reviewed_row', reviewedRow),
    ...workbenchRecords.map((row, index) => (
      sqlCardMasterTextCandidate(`workbench_records[${index}]`, row)
    ))
  ].filter(Boolean);
  const deduped = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = item.text;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  const primary = deduped[0] || { source_field: '', text: '' };
  const firstStructured = structuredFacts[0]?.value || {};
  const primaryStatus = primary.source_field.endsWith('.text')
    ? 'present_from_structured_sql_card_master_text'
    : 'present_from_existing_fact_field';
  return {
    status: primary.text ? primaryStatus : 'missing',
    primary_text: primary.text,
    primary_source_field: primary.source_field,
    fact_text_candidates: deduped,
    structured_fact_candidates: structuredFacts,
    subject_candidate: firstText(
      scalarText(firstStructured.subject),
      node.structured_slots?.subject,
      reviewedRow.linked_entities,
      ...workbenchRecords.map((row) => row.linked_entities)
    ),
    predicate_candidate: firstText(
      scalarText(firstStructured.predicate),
      reviewedRow.fact_key,
      reviewedRow.fact_keys,
      reviewedRow.fact_role,
      reviewedRow.sql_row_kind,
      ...workbenchRecords.flatMap((row) => [
        row.fact_key,
        row.fact_keys,
        row.fact_role,
        row.sql_row_kind
      ])
    ),
    object_candidate: firstText(
      scalarText(firstStructured.object),
      scalarText(firstStructured.fact_value),
      scalarText(firstStructured.value),
      reviewedRow.fact_value,
      node.structured_slots?.object_anchor,
      ...workbenchRecords.map((row) => row.fact_value)
    ),
    canonical_fact_granted: false
  };
}

function candidateValues(...values) {
  return uniqueStrings(values.flatMap((value) => splitListValue(value)));
}

function referenceValues(...values) {
  const flattened = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      flattened.push(...referenceValues(...value));
      continue;
    }
    if (value && typeof value === 'object') {
      flattened.push(stableJson(value));
      continue;
    }
    const text = safeText(value);
    if (!text) continue;
    flattened.push(...text.split(/\s*(?:[;；|]|\n)\s*/u));
  }
  return uniqueStrings(flattened);
}

function buildGraphHints({
  reviewedRow,
  node,
  candidate,
  sourceTraces,
  sourceSpans,
  workbenchRecords = [],
  sourceIndexAnchors = [],
  sourceIndexTopics = [],
  preparedWindows = [],
  atomicFact
}) {
  const rootNames = safeArray(node.root_refs).map((item) => (
    item && typeof item === 'object' ? firstText(item.root_name, item.root_id) : safeText(item)
  ));
  return {
    schema: 'driftstone_graph_hints_v1',
    authority: 'candidate_hints_only_noncanonical',
    runtime_effect: 'none',
    canonical_edges_created: 0,
    canonical_episodes_created: 0,
    canonical_authority_granted: false,
    canonical_receipts_created: 0,
    entity_candidates: candidateValues(
      candidate.entities,
      reviewedRow.linked_entities,
      workbenchRecords.map((row) => row.linked_entities),
      workbenchRecords.map((row) => row.entity_refs),
      node.structured_slots?.subject,
      node.structured_slots?.object_anchor,
      rootNames
    ),
    predicate_candidates: candidateValues(
      reviewedRow.fact_key,
      reviewedRow.fact_keys,
      reviewedRow.fact_role,
      reviewedRow.sql_row_kind,
      workbenchRecords.flatMap((row) => [
        row.fact_key,
        row.fact_keys,
        row.fact_role,
        row.sql_row_kind
      ]),
      atomicFact.predicate_candidate
    ),
    frame_candidates: candidateValues(
      candidate.memory_shape,
      candidate.recall_lane,
      node.node_kind,
      reviewedRow.anchor_type,
      workbenchRecords.map((row) => row.anchor_type),
      sourceIndexAnchors.map((row) => row.layer)
    ),
    claim_candidates: candidateValues(
      atomicFact.fact_text_candidates.map((item) => item.text),
      reviewedRow.summary,
      workbenchRecords.map((row) => row.summary),
      node.relationship_significance,
      node.feeling_as_fact
    ),
    citation_candidates: referenceValues(
      reviewedRow.source_refs,
      candidate.source_refs,
      node.source_refs,
      workbenchRecords.flatMap((row) => [
        row.source_refs,
        row.source_ref,
        row.source_bundle_id,
        row.source_window_id,
        row.chunk_id
      ]),
      sourceIndexAnchors.flatMap((row) => [
        row.source_ref,
        row.source_bundle_id,
        row.source_window_id,
        row.chunk_id
      ]),
      preparedWindows.flatMap((row) => [
        row.source_ref,
        row.source_bundle_id,
        row.source_window_id,
        row.chunk_id
      ]),
      sourceTraces.flatMap((row) => safeArray(row.source_refs)),
      sourceSpans.flatMap((row) => safeArray(row.source_refs))
    ),
    concept_candidates: candidateValues(
      reviewedRow.topic_labels,
      reviewedRow.tags,
      workbenchRecords.map((row) => row.topic_labels),
      workbenchRecords.map((row) => row.tags),
      node.source_tags,
      sourceIndexTopics.map((row) => row.topic_label),
      sourceIndexTopics.map((row) => row.topic_keywords),
      sourceTraces.map((row) => row.topic_label),
      sourceTraces.flatMap((row) => safeArray(row.source_tags))
    ),
    reply_to_message_id_candidate: firstText(
      reviewedRow.reply_to_message_id,
      node.reply_to_message_id,
      candidate.reply_to_message_id,
      ...sourceTraces.map((row) => row.reply_to_message_id),
      ...sourceSpans.map((row) => row.reply_to_message_id)
    ),
    previous_message_id_candidate: firstText(
      reviewedRow.previous_message_id,
      node.previous_message_id,
      candidate.previous_message_id
    ),
    next_message_id_candidate: firstText(
      reviewedRow.next_message_id,
      node.next_message_id,
      candidate.next_message_id
    ),
    scope_candidates: candidateValues(
      reviewedRow.scope_id,
      node.scope_id,
      candidate.scope_id,
      sourceTraces.map((row) => row.source_window_id),
      sourceSpans.map((row) => row.source_window_id),
      reviewedRow.source_window_id
      ,
      workbenchRecords.map((row) => row.source_window_id),
      sourceIndexAnchors.map((row) => row.source_window_id),
      preparedWindows.map((row) => row.source_window_id)
    ),
    support_candidates: referenceValues(
      reviewedRow.supporting_source_refs,
      candidate.supporting_source_refs,
      candidate.primary_source_refs
    ),
    negative_candidates: referenceValues(
      reviewedRow.negative_source_refs,
      candidate.negative_source_refs,
      node.negative_source_refs
    )
  };
}

function buildSourceIdentity({
  monthKey,
  reviewedRow,
  node,
  candidate,
  sourceTraces,
  sourceSpans,
  workbenchRecords = [],
  sourceIndexAnchors = [],
  sourceIndexTopics = [],
  preparedWindows = []
}) {
  const sourceEntryId = firstText(
    reviewedRow.record_id,
    node.source_entry_id,
    candidate.source_entry_id,
    ...workbenchRecords.map((row) => row.record_id),
    ...sourceIndexAnchors.map((row) => row.record_id)
  );
  const messageIds = referenceValues(
    reviewedRow.message_id,
    node.message_id,
    candidate.message_id,
    workbenchRecords.map((row) => row.message_id),
    sourceTraces.map((row) => row.message_id),
    sourceSpans.map((row) => row.message_id)
  );
  const providerKinds = candidateValues(
    reviewedRow.provider_kind,
    reviewedRow.provider,
    node.provider_kind,
    node.provider,
    candidate.provider_kind,
    candidate.provider,
    workbenchRecords.map((row) => firstText(row.provider_kind, row.provider)),
    sourceTraces.map((row) => firstText(row.provider_kind, row.provider)),
    sourceSpans.map((row) => firstText(row.provider_kind, row.provider))
  );
  const providerAccountIds = candidateValues(
    reviewedRow.provider_account_id,
    reviewedRow.account_id,
    node.provider_account_id,
    node.account_id,
    candidate.provider_account_id,
    candidate.account_id,
    workbenchRecords.map((row) => firstText(row.provider_account_id, row.account_id)),
    sourceTraces.map((row) => firstText(row.provider_account_id, row.account_id)),
    sourceSpans.map((row) => firstText(row.provider_account_id, row.account_id))
  );
  const providerConversationIds = candidateValues(
    reviewedRow.provider_conversation_id,
    node.provider_conversation_id,
    candidate.provider_conversation_id,
    candidate.source_window?.provider_conversation_id,
    workbenchRecords.map((row) => row.provider_conversation_id),
    sourceTraces.map((row) => row.provider_conversation_id),
    sourceSpans.map((row) => row.provider_conversation_id)
  );
  const providerTimezones = candidateValues(
    reviewedRow.provider_timezone,
    node.provider_timezone,
    candidate.provider_timezone,
    workbenchRecords.map((row) => row.provider_timezone),
    sourceTraces.map((row) => row.provider_timezone),
    sourceSpans.map((row) => row.provider_timezone)
  );
  const sourceActorRoles = candidateValues(
    sourceTraces.map((row) => firstText(row.source_actor_role, row.speaker, row.role)),
    sourceSpans.map((row) => firstText(row.source_actor_role, row.speaker, row.role)),
    reviewedRow.source_actor_role,
    reviewedRow.speaker,
    node.source_actor_role,
    node.speaker,
    candidate.source_actor_role,
    candidate.speaker
    ,
    workbenchRecords.map((row) => firstText(row.source_actor_role, row.speaker, row.role))
  );
  const identityConflicts = [
    providerKinds.length > 1 ? 'provider_kind' : '',
    providerAccountIds.length > 1 ? 'provider_account_id' : '',
    providerConversationIds.length > 1 ? 'provider_conversation_id' : '',
    providerTimezones.length > 1 ? 'provider_timezone' : ''
  ].filter(Boolean);
  const sourceRefs = referenceValues(
    reviewedRow.source_refs,
    reviewedRow.merged_source_refs,
    reviewedRow.source_ref,
    node.source_refs,
    candidate.source_refs,
    candidate.primary_source_refs,
    candidate.supporting_source_refs,
    workbenchRecords.flatMap((row) => [
      row.source_refs,
      row.source_ref,
      row.source_md_ref
    ]),
    sourceIndexAnchors.map((row) => row.source_ref),
    preparedWindows.flatMap((row) => [row.source_ref, row.source_md_ref]),
    sourceTraces.flatMap((row) => safeArray(row.source_refs)),
    sourceSpans.flatMap((row) => safeArray(row.source_refs))
  );
  return {
    month_key: monthKey,
    source_entry_id: sourceEntryId,
    source_system: firstText(
      node.source_system,
      candidate.source_system,
      ...workbenchRecords.map((row) => row.source_system),
      ...sourceSpans.map((row) => row.source_system),
      'driftstone'
    ),
    message_id: messageIds.length === 1 ? messageIds[0] : '',
    message_ids: messageIds,
    provider_kind: providerKinds.length === 1 ? providerKinds[0] : '',
    provider_kind_candidates: providerKinds,
    provider_account_id: providerAccountIds.length === 1 ? providerAccountIds[0] : '',
    provider_account_id_candidates: providerAccountIds,
    provider_conversation_id: providerConversationIds.length === 1
      ? providerConversationIds[0]
      : '',
    provider_conversation_id_candidates: providerConversationIds,
    provider_timezone: providerTimezones.length === 1 ? providerTimezones[0] : '',
    provider_timezone_candidates: providerTimezones,
    source_actor_role: sourceActorRoles.length === 1 ? sourceActorRoles[0] : (
      sourceActorRoles.length > 1 ? 'multi' : ''
    ),
    source_actor_role_candidates: sourceActorRoles,
    identity_conflicts: identityConflicts,
    source_bundle_role: firstText(
      node.source_bundle_role,
      candidate.source_bundle_role,
      ...preparedWindows.map((row) => row.source_manifest_kind)
    ),
    source_bundle_ids: referenceValues(
      reviewedRow.source_bundle_id,
      reviewedRow.merged_source_bundle_ids,
      workbenchRecords.map((row) => row.source_bundle_id),
      sourceIndexAnchors.map((row) => row.source_bundle_id),
      preparedWindows.map((row) => row.source_bundle_id),
      sourceTraces.map((row) => row.source_bundle_id),
      sourceSpans.map((row) => row.source_bundle_id)
    ),
    source_window_ids: referenceValues(
      reviewedRow.source_window_id,
      reviewedRow.merged_source_window_ids,
      node.source_window_id,
      candidate.source_window?.source_window_id,
      workbenchRecords.map((row) => row.source_window_id),
      sourceIndexAnchors.map((row) => row.source_window_id),
      preparedWindows.map((row) => row.source_window_id),
      sourceTraces.map((row) => row.source_window_id),
      sourceSpans.map((row) => row.source_window_id)
    ),
    source_msg_ranges: candidateValues(
      reviewedRow.source_msg_start && reviewedRow.source_msg_end
        ? `${reviewedRow.source_msg_start}-${reviewedRow.source_msg_end}`
        : '',
      candidate.source_window?.source_msg_range,
      workbenchRecords.map((row) => (
        row.source_msg_start && row.source_msg_end
          ? `${row.source_msg_start}-${row.source_msg_end}`
          : ''
      )),
      sourceIndexAnchors.map((row) => (
        row.source_msg_start && row.source_msg_end
          ? `${row.source_msg_start}-${row.source_msg_end}`
          : ''
      )),
      sourceTraces.map((row) => row.source_msg_range),
      sourceSpans.map((row) => row.source_msg_range)
    ),
    source_trace_ids: referenceValues(
      node.source_trace_ids,
      candidate.source_trace_ids,
      sourceTraces.map((row) => row.trace_id),
      sourceSpans.flatMap((row) => safeArray(row.source_trace_ids))
    ),
    source_span_ids: referenceValues(
      node.source_span_ids,
      sourceTraces.map((row) => row.canonical_source_span_id),
      sourceSpans.map((row) => row.source_span_id),
      sourceSpans.map((row) => row.parent_source_span_id)
    ),
    source_anchor_ids: referenceValues(
      workbenchRecords.map((row) => row.anchor_id),
      sourceIndexAnchors.map((row) => row.anchor_id)
    ),
    memory_taxonomy_topic_ids: referenceValues(
      reviewedRow.topic_ids,
      workbenchRecords.map((row) => row.topic_ids)
    ),
    source_index_topic_ids: referenceValues(
      sourceIndexAnchors.map((row) => row.topic_ids),
      sourceIndexTopics.map((row) => row.topic_id)
    ),
    prepared_chunk_ids: referenceValues(
      reviewedRow.chunk_id,
      workbenchRecords.map((row) => row.chunk_id),
      sourceIndexAnchors.map((row) => row.chunk_id),
      preparedWindows.map((row) => row.chunk_id)
    ),
    source_refs: sourceRefs,
    source_time: firstText(
      reviewedRow.time,
      node.time_anchor,
      ...workbenchRecords.map((row) => row.time)
    ),
    original_source_file: firstText(
      reviewedRow.source_file,
      reviewedRow.source_md_ref,
      ...workbenchRecords.flatMap((row) => [row.source_file, row.source_md_ref]),
      ...preparedWindows.map((row) => row.source_md_ref)
    )
  };
}

function explicitObservedDialogueTypes(input = {}) {
  const metadata = explicitObject(input.metadata);
  return candidateValues(
    input.observed_dialogue_types,
    metadata.observed_dialogue_types,
    metadata.observed_dialogue_type,
    input.reviewed_row?.dialogue_types,
    input.reviewed_row?.dialogue_type
  );
}

function buildArtifactBase(input = {}) {
  const validationError = explicitObject(input.validation_error);
  if (safeText(validationError.code)) {
    throw new PortableArtifactError(
      validationError.code,
      safeText(validationError.message, 'Input join validation failed.'),
      explicitObject(validationError.details)
    );
  }
  const reviewedRow = explicitObject(input.reviewed_row);
  const node = explicitObject(input.node);
  const candidate = explicitObject(input.candidate);
  const workbenchRecords = safeArray(input.workbench_records).map((row) => explicitObject(row));
  const sourceIndexAnchors = safeArray(input.source_index_anchors).map((row) => explicitObject(row));
  const sourceIndexTopics = safeArray(input.source_index_topics).map((row) => explicitObject(row));
  const preparedWindows = safeArray(input.prepared_windows).map((row) => explicitObject(row));
  const sourceIndexMetadata = explicitObject(input.source_index_metadata);
  const sourceTraces = (
    safeArray(input.source_traces).length
      ? safeArray(input.source_traces)
      : (Object.keys(explicitObject(input.source_trace)).length ? [input.source_trace] : [])
  ).map((row) => explicitObject(row));
  const sourceSpans = (
    safeArray(input.source_spans).length
      ? safeArray(input.source_spans)
      : (Object.keys(explicitObject(input.source_span)).length ? [input.source_span] : [])
  ).map((row) => explicitObject(row));
  const payloads = {
    reviewed_row: reviewedRow,
    node,
    candidate,
    source_traces: sourceTraces,
    source_spans: sourceSpans,
    workbench_records: workbenchRecords,
    source_index_anchors: sourceIndexAnchors,
    source_index_topics: sourceIndexTopics,
    prepared_windows: preparedWindows,
    source_index_metadata: sourceIndexMetadata
  };
  // Validate the complete producer boundary once before field walkers run.
  stableJson(payloads);
  const { source_layer: sourceLayer, candidate_lane: candidateLane } = resolveLayerTruth(
    input,
    reviewedRow,
    node,
    candidate,
    workbenchRecords,
    sourceIndexAnchors
  );
  const monthKey = resolveMonthTruth(input, reviewedRow, node, candidate, workbenchRecords);
  const sourceIdentity = buildSourceIdentity({
    monthKey,
    reviewedRow,
    node,
    candidate,
    sourceTraces,
    sourceSpans,
    workbenchRecords,
    sourceIndexAnchors,
    sourceIndexTopics,
    preparedWindows
  });
  if (!sourceIdentity.source_entry_id) {
    throw new PortableArtifactError(
      'source_identity_missing',
      'No source_entry_id/record_id is available; a synthetic identity must not be invented.',
      { month_key: monthKey || 'missing' }
    );
  }
  if (!monthKey) {
    throw new PortableArtifactError(
      'month_key_missing',
      'No month key is available; temporal coverage cannot be conserved.',
      { source_entry_id: sourceIdentity.source_entry_id }
    );
  }

  const atomicFact = buildAtomicFact({
    lane: candidateLane,
    reviewedRow,
    node,
    candidate,
    workbenchRecords
  });
  const labels = collectLabels(payloads);
  const originalIds = collectOriginalIdentifiers(payloads);
  const graphHints = buildGraphHints({
    reviewedRow,
    node,
    candidate,
    sourceTraces,
    sourceSpans,
    workbenchRecords,
    sourceIndexAnchors,
    sourceIndexTopics,
    preparedWindows,
    atomicFact
  });
  const observedDialogueTypes = explicitObservedDialogueTypes(input);
  const textFields = collectTextFields(payloads);
  const sourceStateFields = collectStateFields(payloads);
  const upstreamAuthorityClaims = collectAuthorityClaims(payloads);
  const missingFields = [];
  if (!sourceIdentity.source_refs.length) missingFields.push('source_identity.source_refs');
  const processedLineage = workbenchRecords.length
    || sourceIndexAnchors.length
    || sourceIndexTopics.length
    || preparedWindows.length;
  if (processedLineage) {
    if (!sourceIdentity.source_anchor_ids.length) missingFields.push('source_identity.source_anchor_ids');
    if (!sourceIdentity.prepared_chunk_ids.length) missingFields.push('source_identity.prepared_chunk_ids');
  } else {
    if (!sourceIdentity.source_trace_ids.length) missingFields.push('source_identity.source_trace_ids');
    if (!sourceIdentity.source_span_ids.length) missingFields.push('source_identity.source_span_ids');
  }
  for (const field of sourceIdentity.identity_conflicts) {
    missingFields.push(`source_identity.${field}_conflict`);
  }
  const reviewState = firstText(
    reviewedRow.review_status,
    node.quality?.review_status,
    candidate.quality?.review_status,
    candidate.import_status,
    input.metadata?.upstream_review_state
  );
  if (!reviewState) {
    missingFields.push('review.state');
  }
  if (candidateLane === 'fact' && atomicFact.status === 'missing') {
    missingFields.push('content.atomic_fact.primary_text');
  }

  const upstreamPayloadSha = sha256(payloads);
  const exactTextPayloadSha = sha256(textFields);
  const dedupeCandidateSha = sha256({
    candidate_lane: candidateLane,
    text_fields: Object.values(textFields).map((value) => (
      typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : value
    ))
  });
  const artifactId = [
    'driftstone',
    'portable',
    'v1',
    artifactIdPart(monthKey),
    artifactIdPart(candidateLane),
    artifactIdPart(sourceIdentity.source_entry_id)
  ].join(':');

  return {
    schema: PORTABLE_ARTIFACT_SCHEMA,
    contract_version: 1,
    artifact_id: artifactId,
    candidate_lane: candidateLane,
    source_layer: sourceLayer,
    historical_case_candidate: false,
    case_extraction_status: 'not_applicable_by_owner_decision',
    artifact_state: missingFields.length ? 'review_only_missing_fields' : 'candidate_ready_for_owner_review',
    assimilation_status: 'not_sent',
    source_identity: sourceIdentity,
    original_ids: originalIds,
    source_state: {
      preservation_state: 'exact_source_fields',
      fields: sourceStateFields
    },
    authority: {
      state: 'candidate_only_unverified',
      canonical_authority_granted: false,
      canonical_receipt: null,
      upstream_claims_preserved_not_verified: upstreamAuthorityClaims
    },
    review: {
      state: firstText(reviewState, 'missing'),
      owner_approved_for_write: false,
      final_destination_receipt: null,
      source_fields: canonicalize({
        reviewed_row_review_status: reviewedRow.review_status ?? '',
        node_quality: node.quality ?? null,
        candidate_quality: candidate.quality ?? null,
        candidate_import_status: candidate.import_status ?? '',
        upstream_review_state: input.metadata?.upstream_review_state ?? ''
      })
    },
    labels,
    content: {
      preservation_state: 'exact_source_fields_plus_original_payloads',
      title: firstText(reviewedRow.title, node.title, candidate.title, reviewedRow.card_name),
      text_fields: textFields,
      atomic_fact: atomicFact
    },
    graph_hints: graphHints,
    temporal_coverage: {
      month_key: monthKey,
      observed_dialogue_types: observedDialogueTypes,
      observed_dialogue_type_state: observedDialogueTypes.length ? 'explicit_metadata' : 'missing_not_inferred_from_text'
    },
    dedupe: {
      policy: 'candidate_hash_only_no_auto_merge',
      upstream_payload_sha256: upstreamPayloadSha,
      exact_text_fields_sha256: exactTextPayloadSha,
      dedupe_candidate_sha256: dedupeCandidateSha
    },
    missing_fields: missingFields.sort(),
    upstream_payloads: jsonClone(payloads),
    safety: {
      writes_home: false,
      writes_notion: false,
      writes_hippocove: false,
      writes_cloud_drive: false,
      emits_canonical_edge: false,
      emits_canonical_episode: false,
      emits_canonical_authority: false,
      emits_canonical_receipt: false,
      reads_persona_prompt: false
    }
  };
}

export function buildPortableArtifact(input = {}) {
  const base = buildArtifactBase(input);
  return {
    ...base,
    integrity: {
      canonical_payload_sha256: sha256(base),
      canonical_serialization: 'sorted_object_keys_arrays_preserve_order_utf8_json',
      upstream_payload_sha256: base.dedupe.upstream_payload_sha256
    }
  };
}

export function verifyPortableArtifact(artifact = {}) {
  if (artifact.schema !== PORTABLE_ARTIFACT_SCHEMA) return false;
  const expected = safeText(artifact.integrity?.canonical_payload_sha256);
  const { integrity, ...base } = artifact;
  return Boolean(expected && expected === sha256(base));
}

export function exportPortableArtifactsJsonl(artifacts = []) {
  safeArray(artifacts).forEach((artifact, index) => {
    if (!verifyPortableArtifact(artifact)) {
      throw new PortableArtifactError(
        'artifact_integrity_invalid',
        'Canonical JSONL export accepts only verified portable artifacts.',
        { artifact_index: index, artifact_id: safeText(artifact?.artifact_id) }
      );
    }
  });
  return serializeJsonl(artifacts);
}

export function serializeJsonl(rows = []) {
  return safeArray(rows).length ? `${safeArray(rows).map((row) => stableJson(row)).join('\n')}\n` : '';
}

function rejectionFor(input, error, index) {
  const reviewedRow = explicitObject(input?.reviewed_row);
  const node = explicitObject(input?.node);
  const candidate = explicitObject(input?.candidate);
  const workbenchRecords = safeArray(input?.workbench_records).map((row) => explicitObject(row));
  const sourceIndexAnchors = safeArray(input?.source_index_anchors).map((row) => explicitObject(row));
  const identity = firstText(
    reviewedRow.record_id,
    node.source_entry_id,
    candidate.source_entry_id,
    ...workbenchRecords.map((row) => row.record_id),
    ...sourceIndexAnchors.map((row) => row.record_id)
  );
  let inputPayloadSha = 'unavailable_non_json_input';
  try {
    inputPayloadSha = sha256(input);
  } catch {
    // The rejection code already records the canonical JSON boundary failure.
  }
  return {
    schema: PORTABLE_REJECTION_SCHEMA,
    input_index: index,
    source_entry_id: identity,
    month_key: firstText(
      input?.month_key,
      node.month_key,
      candidate.month_key,
      ...workbenchRecords.map((row) => monthFromText(row.source_file))
    ),
    rejection_code: safeText(error?.code, 'build_error'),
    rejection_message: safeText(error?.message, 'Portable artifact build failed.'),
    details: jsonClone(error?.details || {}),
    input_payload_sha256: inputPayloadSha,
    assimilation_status: 'not_sent',
    writes_any_destination: false
  };
}

function countBy(rows, getter) {
  const counts = {};
  for (const row of rows) {
    const key = safeText(getter(row), 'missing');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function observedTypeCounts(artifacts) {
  const counts = {};
  for (const artifact of artifacts) {
    const month = safeText(artifact.temporal_coverage?.month_key, 'missing');
    const types = artifact.temporal_coverage?.observed_dialogue_types?.length
      ? artifact.temporal_coverage.observed_dialogue_types
      : ['unclassified'];
    counts[month] ||= {};
    for (const type of types) counts[month][type] = (counts[month][type] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([month, values]) => [
        month,
        Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)))
      ])
  );
}

function compareExpectedObservedTypes(actual = {}, expected = {}) {
  const mismatches = [];
  for (const [month, expectedTypes] of Object.entries(expected || {})) {
    for (const [type, expectedCount] of Object.entries(expectedTypes || {})) {
      const actualCount = Number(actual?.[month]?.[type] || 0);
      if (actualCount !== Number(expectedCount || 0)) {
        mismatches.push({
          month_key: month,
          observed_dialogue_type: type,
          expected: Number(expectedCount || 0),
          actual: actualCount
        });
      }
    }
  }
  return mismatches;
}

export const DEFAULT_TEMPORAL_SAMPLE_PLAN = Object.freeze({
  schema: 'driftstone_temporal_sample_plan_v1',
  semantics: 'owner_supplied_sampling_metadata_not_row_content_truth',
  early_classic_cohort: {
    months: ['2025-02', '2025-03', '2025-04'],
    owner_context_hints: ['evolution', 'creation', 'story_or_plot'],
    hardcoded_row_classification: false
  },
  post_august_cohort: {
    starts_at: '2025-08',
    owner_context_hints: ['viewpoint', 'expression'],
    hardcoded_row_classification: false
  },
  completion_gate: 'per_month_x_explicit_observed_dialogue_type_conservation',
  requires_every_type_in_every_month: false
});

export function finalizeContractDigest(value = {}, digestField = 'payload_sha256') {
  const payload = { ...explicitObject(value) };
  delete payload[digestField];
  return {
    ...canonicalize(payload),
    [digestField]: sha256(payload)
  };
}

export function verifyContractDigest(value = {}, digestField = 'payload_sha256') {
  const expected = safeText(value?.[digestField]);
  if (!expected) return false;
  const payload = { ...explicitObject(value) };
  delete payload[digestField];
  return expected === sha256(payload);
}

export function finalizeLedgerDigest(ledger = {}) {
  return finalizeContractDigest(ledger, 'ledger_sha256');
}

export function verifyLedgerDigest(ledger = {}) {
  return verifyContractDigest(ledger, 'ledger_sha256');
}

export function buildPortableArtifactBatch(inputs = [], {
  expectedObservedTypeCounts = {},
  temporalSamplePlan = DEFAULT_TEMPORAL_SAMPLE_PLAN
} = {}) {
  const artifacts = [];
  const rejected = [];
  const artifactIds = new Set();
  safeArray(inputs).forEach((input, index) => {
    try {
      const artifact = buildPortableArtifact(input);
      if (artifactIds.has(artifact.artifact_id)) {
        throw new PortableArtifactError(
          'artifact_identity_duplicate',
          'Two input rows resolve to the same portable artifact identity.',
          { artifact_id: artifact.artifact_id }
        );
      }
      artifactIds.add(artifact.artifact_id);
      artifacts.push(artifact);
    } catch (error) {
      rejected.push(rejectionFor(input, error, index));
    }
  });
  const actualObservedTypeCounts = observedTypeCounts(artifacts);
  const temporalMismatches = compareExpectedObservedTypes(actualObservedTypeCounts, expectedObservedTypeCounts);
  const ledgerBase = {
    schema: PORTABLE_LEDGER_SCHEMA,
    input_rows: safeArray(inputs).length,
    artifact_rows: artifacts.length,
    rejected_rows: rejected.length,
    row_conservation_passed: safeArray(inputs).length === artifacts.length + rejected.length,
    artifacts_with_valid_integrity: artifacts.filter(verifyPortableArtifact).length,
    historical_case_candidates: artifacts.filter((row) => row.historical_case_candidate).length,
    by_candidate_lane: countBy(artifacts, (row) => row.candidate_lane),
    by_month: countBy(artifacts, (row) => row.source_identity?.month_key),
    by_artifact_state: countBy(artifacts, (row) => row.artifact_state),
    by_rejection_code: countBy(rejected, (row) => row.rejection_code),
    artifacts_missing_atomic_fact: artifacts.filter((row) => row.missing_fields.includes('content.atomic_fact.primary_text')).length,
    artifacts_with_missing_fields: artifacts.filter((row) => row.missing_fields.length).length,
    month_x_observed_dialogue_type: actualObservedTypeCounts,
    expected_month_x_observed_dialogue_type: canonicalize(expectedObservedTypeCounts),
    temporal_conservation_mismatches: temporalMismatches,
    temporal_conservation_passed: temporalMismatches.length === 0,
    temporal_sample_plan: jsonClone(temporalSamplePlan),
    writes_any_destination: false
  };
  const ledger = finalizeLedgerDigest(ledgerBase);
  return { artifacts, rejected, ledger };
}

function projectionConservation(artifact) {
  return {
    label_source_field_count: artifact.labels.source_field_count,
    unclassified_label_field_count: artifact.labels.unclassified_label_field_count,
    exact_field_audit_count: artifact.labels.exact_field_audit_count,
    label_candidate_count: artifact.labels.normalized_candidate_count,
    original_id_field_count: artifact.original_ids.field_count,
    source_ref_count: artifact.source_identity.source_refs.length,
    text_field_count: Object.keys(artifact.content.text_fields).length
  };
}

function withProjectionIntegrity(projection) {
  return {
    ...projection,
    projection_integrity: {
      payload_sha256: sha256(projection),
      canonical_artifact_sha256: projection.canonical_artifact_sha256
    }
  };
}

export function projectPortableArtifactToNotion(artifact = {}) {
  if (!verifyPortableArtifact(artifact)) {
    throw new PortableArtifactError('artifact_integrity_invalid', 'Notion projection requires a valid portable artifact.');
  }
  return withProjectionIntegrity({
    schema: NOTION_PROJECTION_SCHEMA,
    projection_only: true,
    adapter_target: 'notion_fields',
    writes_to_notion: false,
    canonical_source_schema: artifact.schema,
    round_trip_key: artifact.artifact_id,
    canonical_artifact_sha256: artifact.integrity.canonical_payload_sha256,
    fields: {
      title: artifact.content.title,
      artifact_id: artifact.artifact_id,
      candidate_lane: artifact.candidate_lane,
      source_layer: artifact.source_layer,
      month_key: artifact.source_identity.month_key,
      source_entry_id: artifact.source_identity.source_entry_id,
      artifact_state: artifact.artifact_state,
      review_state: artifact.review.state,
      labels_json: stableJson({
        classified: artifact.labels.source_fields,
        unclassified: artifact.labels.unclassified_label_fields,
        exact_field_audit: artifact.labels.exact_field_audit
      }),
      normalized_label_candidates: artifact.labels.normalized_candidates,
      source_refs_json: stableJson(artifact.source_identity.source_refs),
      original_ids_json: stableJson(artifact.original_ids.fields),
      missing_fields: artifact.missing_fields,
      atomic_fact_text: artifact.content.atomic_fact.primary_text,
      canonical_artifact_sha256: artifact.integrity.canonical_payload_sha256
    },
    conservation: projectionConservation(artifact),
    safety: {
      projection_is_canonical_memory: false,
      may_grant_authority: false,
      may_create_receipt: false
    }
  });
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

export function projectPortableArtifactToMarkdown(artifact = {}) {
  if (!verifyPortableArtifact(artifact)) {
    throw new PortableArtifactError('artifact_integrity_invalid', 'Markdown projection requires a valid portable artifact.');
  }
  const labelLines = artifact.labels.normalized_candidates.map((value) => `  - ${yamlScalar(value)}`);
  const sourceLines = artifact.source_identity.source_refs.map((value) => `  - ${yamlScalar(value)}`);
  const textCandidates = artifact.content.atomic_fact.fact_text_candidates.map((item) => `- ${item.text}`);
  const markdown = [
    '---',
    `projection_schema: ${yamlScalar(MARKDOWN_PROJECTION_SCHEMA)}`,
    'projection_only: true',
    `round_trip_key: ${yamlScalar(artifact.artifact_id)}`,
    `canonical_artifact_sha256: ${yamlScalar(artifact.integrity.canonical_payload_sha256)}`,
    `candidate_lane: ${yamlScalar(artifact.candidate_lane)}`,
    `source_layer: ${yamlScalar(artifact.source_layer)}`,
    `month_key: ${yamlScalar(artifact.source_identity.month_key)}`,
    ...(labelLines.length ? ['labels:', ...labelLines] : ['labels: []']),
    ...(sourceLines.length ? ['source_refs:', ...sourceLines] : ['source_refs: []']),
    '---',
    '',
    `# ${artifact.content.title || artifact.source_identity.source_entry_id}`,
    '',
    'This file is a downstream projection. The versioned JSON artifact remains canonical.',
    '',
    ...(textCandidates.length ? ['## Atomic fact candidates', '', ...textCandidates, ''] : [])
  ].join('\n');
  return withProjectionIntegrity({
    schema: MARKDOWN_PROJECTION_SCHEMA,
    projection_only: true,
    adapter_target: 'markdown',
    writes_to_cloud_drive: false,
    canonical_source_schema: artifact.schema,
    round_trip_key: artifact.artifact_id,
    canonical_artifact_sha256: artifact.integrity.canonical_payload_sha256,
    markdown,
    conservation: projectionConservation(artifact),
    safety: {
      projection_is_canonical_memory: false,
      may_grant_authority: false,
      may_create_receipt: false
    }
  });
}

export function verifyProjectionConservation(artifact = {}, projection = {}) {
  if (!verifyPortableArtifact(artifact)) return { ok: false, mismatches: ['artifact_integrity_invalid'] };
  let expectedProjection;
  if (projection.schema === NOTION_PROJECTION_SCHEMA) {
    expectedProjection = projectPortableArtifactToNotion(artifact);
  } else if (projection.schema === MARKDOWN_PROJECTION_SCHEMA) {
    expectedProjection = projectPortableArtifactToMarkdown(artifact);
  } else {
    return { ok: false, mismatches: ['projection_schema'] };
  }
  const mismatches = stableJson(expectedProjection) === stableJson(projection)
    ? []
    : ['projection_payload_not_derived_from_canonical_artifact'];
  return { ok: mismatches.length === 0, mismatches };
}
