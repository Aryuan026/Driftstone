import { createHash } from 'node:crypto';

export const PORTABLE_SOURCE_PACKET_SCHEMA = 'driftstone_portable_source_packet_v1';
export const PORTABLE_SOURCE_CANDIDATE_SCHEMA = 'driftstone_portable_source_candidate_v1';
export const RAW_DISPOSITION_SCHEMA = 'driftstone_raw_message_disposition_v1';
export const WORKBENCH_REVIEW_LEDGER_SCHEMA = 'driftstone_workbench_review_conservation_v1';
export const HUMAN_REVIEW_QUEUE_SCHEMA = 'driftstone_source_human_review_queue_v1';
export const BOUNDED_PROJECTION_SCHEMA = 'driftstone_bounded_memory_projection_v1';
export const SOURCE_REJECTION_SCHEMA = 'driftstone_portable_source_rejection_v1';
export const HUMAN_DECISIONS_SCHEMA = 'driftstone_portable_source_decisions_v1';

const ALLOWED_MEMORY_LANES = new Set(['persona', 'sql', 'fact']);
const ALLOWED_HUMAN_AUTHORITIES = new Set(['human_attested', 'legacy_import']);
const ALLOWED_HUMAN_DECISIONS = new Set(['approve', 'hold', 'reject']);

export class PortableSourcePacketError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PortableSourcePacketError';
    this.code = code;
    this.details = details;
  }
}

export function safeText(value, fallback = '') {
  const text = String(value ?? '').replace(/\r/gu, '').trim();
  return text || fallback;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, path = '$', ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PortableSourcePacketError(
        'non_json_value',
        'Non-finite numbers are forbidden in canonical source packets.',
        { path }
      );
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new PortableSourcePacketError(
      'non_json_value',
      'Canonical source packets accept JSON-compatible values only.',
      { path, value_kind: typeof value }
    );
  }
  if (ancestors.has(value)) {
    throw new PortableSourcePacketError(
      'non_json_value',
      'Circular values are forbidden in canonical source packets.',
      { path }
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalize(item, `${path}[${index}]`, ancestors));
    }
    if (!isPlainObject(value)) {
      throw new PortableSourcePacketError(
        'non_json_value',
        'Non-plain objects are forbidden in canonical source packets.',
        { path, value_kind: value.constructor?.name || 'non_plain_object' }
      );
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
  return createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableJson(value))
    .digest('hex');
}

function jsonClone(value) {
  return JSON.parse(stableJson(value ?? null));
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values.flat(Infinity)) {
    const text = safeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function splitDelimited(value) {
  if (Array.isArray(value)) return uniqueStrings(value.flatMap(splitDelimited));
  if (isPlainObject(value)) return [stableJson(value)];
  const text = safeText(value);
  if (!text) return [];
  return uniqueStrings(text.split(/\s*(?:[|,，;；]|\n)\s*/gu));
}

export function parseFactKeysFull(value) {
  return splitDelimited(value);
}

export function parseTagsFull(value) {
  if (Array.isArray(value)) return uniqueStrings(value.flatMap(parseTagsFull));
  const text = safeText(value);
  if (!text) return [];
  // Historical exports use both whitespace-separated hashtags and mixed
  // comma/pipe/plain-label forms. Treat every explicit delimiter as a
  // boundary; never switch into a "hashtags only" mode that drops siblings.
  return uniqueStrings(
    text
      .split(/\s*(?:[|,，;；]|\s+|\n)\s*/gu)
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function firstText(...values) {
  for (const value of values) {
    const text = safeText(value);
    if (text) return text;
  }
  return '';
}

function finiteInteger(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function normalizeLane(value) {
  const lane = safeText(value).toLowerCase();
  if (lane === 'sql' || lane === 'fact') return 'fact';
  if (lane === 'persona') return 'persona';
  if (lane === 'case') return 'case';
  return lane || 'unknown';
}

export function deriveEventFamilyIdentity(candidate = {}) {
  const workbench = candidate?.upstream?.workbench_row || {};
  const reviewedRows = Array.isArray(candidate?.upstream?.reviewed_rows)
    ? candidate.upstream.reviewed_rows
    : [];
  const prepared = Array.isArray(candidate?.upstream?.prepared_windows)
    ? candidate.upstream.prepared_windows
    : [];
  const monthKey = safeText(candidate.month_key);
  const reviewedFamilyIds = uniqueStrings(reviewedRows.map((row) => row?.family_id));
  const reviewedFamilyKinds = uniqueStrings(reviewedRows.map((row) => row?.family_kind));
  if (reviewedFamilyIds.length > 1) {
    throw new PortableSourcePacketError(
      'event_family_id_conflict',
      'A candidate with conflicting reviewed family_id values cannot be grouped silently.',
      {
        candidate_id: safeText(candidate.candidate_id),
        month_key: monthKey,
        family_ids: reviewedFamilyIds,
        family_kinds: reviewedFamilyKinds
      }
    );
  }
  const sourceBundleId = safeText(
    workbench.source_bundle_id
    || candidate?.graph_hints?.span?.source_bundle_ids?.[0]
  );
  const chunkId = safeText(
    workbench.chunk_id
    || prepared[0]?.chunk_id
  );
  const sourceWindowId = safeText(
    workbench.source_window_id
    || candidate?.graph_hints?.span?.source_window_ids?.[0]
    || prepared[0]?.source_window_id
  );
  const sourceStart = finiteInteger(
    workbench.source_msg_start
    ?? workbench.msg_start
    ?? workbench.chunk_msg_start
  );
  const sourceEnd = finiteInteger(
    workbench.source_msg_end
    ?? workbench.msg_end
    ?? workbench.chunk_msg_end
  );
  let basis = 'candidate_fallback';
  let confidence = 'identity_only';
  let keyMaterial = {
    month_key: monthKey,
    candidate_id: safeText(candidate.candidate_id)
  };
  if (reviewedFamilyIds.length === 1) {
    basis = 'reviewed_family_id';
    confidence = 'upstream_reviewed_family';
    keyMaterial = {
      month_key: monthKey,
      reviewed_family_id: reviewedFamilyIds[0]
    };
  } else if (sourceBundleId && chunkId) {
    basis = 'source_bundle_chunk';
    confidence = 'deterministic_source_group';
    keyMaterial = {
      month_key: monthKey,
      source_bundle_id: sourceBundleId,
      chunk_id: chunkId
    };
  } else if (
    sourceBundleId
    && sourceWindowId
    && sourceStart !== null
    && sourceEnd !== null
  ) {
    basis = 'source_window_range';
    confidence = 'bounded_source_fallback';
    keyMaterial = {
      month_key: monthKey,
      source_bundle_id: sourceBundleId,
      source_window_id: sourceWindowId,
      source_msg_start: sourceStart,
      source_msg_end: sourceEnd
    };
  }
  return {
    basis,
    confidence,
    reviewed_family_kind: reviewedFamilyKinds.length === 1 ? reviewedFamilyKinds[0] : '',
    key_material: keyMaterial,
    family_key: `dsevent_${sha256({ basis, ...keyMaterial }).slice(0, 32)}`
  };
}

function multiMap(rows, keyFn) {
  const map = new Map();
  rows.forEach((row, index) => {
    const key = safeText(keyFn(row, index));
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ row, index });
  });
  return map;
}

function rowRef(kind, row, index) {
  return {
    kind,
    row_index: index,
    record_id: safeText(row?.record_id),
    row_sha256: sha256(row)
  };
}

function rangeDescriptor(row = {}) {
  return {
    source_bundle_id: safeText(row.source_bundle_id),
    source_window_id: safeText(row.source_window_id),
    source_msg_start: finiteInteger(row.source_msg_start),
    source_msg_end: finiteInteger(row.source_msg_end)
  };
}

function rangesCompatible(left = {}, right = {}) {
  return Boolean(
    left.source_bundle_id
    && right.source_bundle_id
    && left.source_bundle_id === right.source_bundle_id
    && left.source_window_id
    && right.source_window_id
    && left.source_window_id === right.source_window_id
  );
}

function rawMessageIdentity(bundle = {}, message = {}, bundleIndex = 0, messageIndex = 0) {
  const sourceMessageIndex = finiteInteger(message.source_msg_index);
  return {
    bundle_index: bundleIndex,
    message_ordinal: messageIndex,
    source_bundle_id: safeText(bundle.source_bundle_id || bundle.id),
    source_window_id: safeText(message.source_window_id),
    source_msg_index: sourceMessageIndex,
    role: safeText(message.role),
    timestamp: safeText(message.ts),
    content_chars: String(message.content ?? '').length,
    content_sha256: sha256(String(message.content ?? ''))
  };
}

function rawMessageKey(identity = {}) {
  return stableJson({
    source_bundle_id: identity.source_bundle_id,
    source_window_id: identity.source_window_id,
    source_msg_index: identity.source_msg_index,
    bundle_index: identity.bundle_index,
    message_ordinal: identity.message_ordinal
  });
}

function preparedChunkCoversMessage(chunk = {}, identity = {}) {
  const range = rangeDescriptor(chunk);
  if (range.source_msg_start === null || range.source_msg_end === null) return false;
  if (identity.source_msg_index === null) return false;
  if (!rangesCompatible(range, identity)) return false;
  return (
    identity.source_msg_index >= range.source_msg_start
    && identity.source_msg_index <= range.source_msg_end
  );
}

function buildRawDisposition(rawBundles = [], preparedRows = []) {
  const entries = [];
  const rawMessages = [];
  rawBundles.forEach((bundle, bundleIndex) => {
    const messages = Array.isArray(bundle?.messages) ? bundle.messages : [];
    messages.forEach((message, messageIndex) => {
      rawMessages.push({
        bundle,
        message,
        identity: rawMessageIdentity(bundle, message, bundleIndex, messageIndex)
      });
    });
  });

  const chunksByWindow = new Map();
  const chunksWithoutWindow = [];
  preparedRows.forEach((chunk, index) => {
    const windowId = safeText(chunk?.source_window_id);
    const wrapped = { row: chunk, index };
    if (!windowId) {
      chunksWithoutWindow.push(wrapped);
      return;
    }
    if (!chunksByWindow.has(windowId)) chunksByWindow.set(windowId, []);
    chunksByWindow.get(windowId).push(wrapped);
  });

  const coveredMessageKeys = new Set();
  const chunkCoverageCounts = new Array(preparedRows.length).fill(0);
  for (const item of rawMessages) {
    const candidates = [
      ...(chunksByWindow.get(item.identity.source_window_id) || []),
      ...chunksWithoutWindow
    ];
    const covering = candidates.filter(({ row }) => preparedChunkCoversMessage(row, item.identity));
    if (covering.length) {
      coveredMessageKeys.add(rawMessageKey(item.identity));
      covering.forEach(({ index }) => {
        chunkCoverageCounts[index] += 1;
      });
    }
    entries.push({
      schema: RAW_DISPOSITION_SCHEMA,
      message_ref: `rawmsg_${sha256(item.identity).slice(0, 32)}`,
      source_identity: item.identity,
      coverage_state: covering.length
        ? 'covered_by_prepared'
        : 'not_covered_pending_review',
      prepared_chunk_ids: uniqueStrings(covering.map(({ row }) => row.chunk_id)),
      prepared_row_indexes: covering.map(({ index }) => index),
      disposition: covering.length ? 'represented_in_prepared_layer' : '',
      human_review: covering.length
        ? {
          required: false,
          state: 'not_required_for_raw_to_prepared_conservation'
        }
        : {
          required: true,
          state: 'pending_human_disposition',
          choices: [
            'context_only',
            'low_signal',
            'duplicate_or_boundary_overlap',
            'source_incomplete_candidate',
            'include_in_future_reprocessing'
          ],
          missing_source_is_called_loss: false
        }
    });
  }

  const preparedCoverage = preparedRows.map((row, index) => ({
    chunk_id: safeText(row.chunk_id),
    prepared_row_index: index,
    matched_raw_message_count: chunkCoverageCounts[index],
    status: chunkCoverageCounts[index] > 0
      ? 'matched_raw_messages'
      : 'prepared_without_raw_match_pending_review'
  }));
  const coveredCount = coveredMessageKeys.size;
  return {
    entries,
    preparedCoverage,
    conservation: {
      raw_messages: rawMessages.length,
      covered_by_prepared: coveredCount,
      not_covered_pending_review: rawMessages.length - coveredCount,
      equation_passed: rawMessages.length === coveredCount + (rawMessages.length - coveredCount),
      prepared_rows: preparedRows.length,
      prepared_with_raw_match: preparedCoverage.filter((row) => row.matched_raw_message_count > 0).length,
      prepared_without_raw_match_pending_review: preparedCoverage
        .filter((row) => row.matched_raw_message_count === 0)
        .length,
      missing_messages_called_lost: false
    },
    rawMessages
  };
}

function normalizeHumanDecisions(input = {}, monthKey = '') {
  if (!input || !Object.keys(input).length) return new Map();
  if (input.schema !== HUMAN_DECISIONS_SCHEMA) {
    throw new PortableSourcePacketError(
      'human_decisions_schema_invalid',
      `Human decisions must use ${HUMAN_DECISIONS_SCHEMA}.`
    );
  }
  if (safeText(input.month_key) !== monthKey) {
    throw new PortableSourcePacketError(
      'human_decisions_month_mismatch',
      'Human decisions month does not match the source packet month.',
      { expected: monthKey, observed: safeText(input.month_key) }
    );
  }
  if (!Array.isArray(input.decisions)) {
    throw new PortableSourcePacketError(
      'human_decisions_array_required',
      'Human decisions must contain a decisions array.'
    );
  }
  const output = new Map();
  input.decisions.forEach((decision, index) => {
    const recordId = safeText(decision?.record_id);
    const candidateId = safeText(decision?.candidate_id);
    const canonicalPayloadSha256 = safeText(decision?.canonical_payload_sha256);
    const action = safeText(decision?.decision).toLowerCase();
    const authority = safeText(decision?.authority).toLowerCase();
    if (!recordId) {
      throw new PortableSourcePacketError(
        'human_decision_record_id_missing',
        'Every human decision needs an exact record_id.',
        { decision_index: index }
      );
    }
    if (output.has(recordId)) {
      throw new PortableSourcePacketError(
        'human_decision_duplicate',
        'A record_id may have only one human decision per packet.',
        { record_id: recordId }
      );
    }
    if (!/^dspc_[0-9a-f]{32}$/u.test(candidateId)) {
      throw new PortableSourcePacketError(
        'human_decision_candidate_id_invalid',
        'Every human decision must bind the frozen dspc_ candidate_id.',
        { record_id: recordId, candidate_id: candidateId }
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(canonicalPayloadSha256)) {
      throw new PortableSourcePacketError(
        'human_decision_candidate_digest_invalid',
        'Every human decision must bind the frozen candidate canonical payload digest.',
        { record_id: recordId }
      );
    }
    if (!ALLOWED_HUMAN_DECISIONS.has(action)) {
      throw new PortableSourcePacketError(
        'human_decision_invalid',
        'Human decision must be approve, hold, or reject.',
        { record_id: recordId, decision: action }
      );
    }
    if (action === 'approve' && !ALLOWED_HUMAN_AUTHORITIES.has(authority)) {
      throw new PortableSourcePacketError(
        'human_decision_authority_invalid',
        'Approved source-incomplete candidates require human_attested or legacy_import authority.',
        { record_id: recordId, authority }
      );
    }
    output.set(recordId, {
      candidate_id: candidateId,
      canonical_payload_sha256: canonicalPayloadSha256,
      decision: action,
      authority: action === 'approve' ? authority : '',
      reviewer: safeText(decision.reviewer, 'owner'),
      decided_at: safeText(decision.decided_at),
      note: safeText(decision.note)
    });
  });
  return output;
}

function matchCandidateRawSpan(rawMessages, workbench) {
  const descriptor = rangeDescriptor(workbench);
  if (descriptor.source_msg_start === null || descriptor.source_msg_end === null) {
    return {
      messages: [],
      state: 'source_range_missing',
      reasons: ['source_msg_range_missing']
    };
  }
  const matched = rawMessages.filter(({ identity }) => (
    rangesCompatible(descriptor, identity)
    && identity.source_msg_index !== null
    && identity.source_msg_index >= descriptor.source_msg_start
    && identity.source_msg_index <= descriptor.source_msg_end
  ));
  if (!matched.length) {
    return {
      messages: [],
      state: 'source_range_unresolved',
      reasons: ['source_msg_range_has_no_raw_match']
    };
  }
  return {
    messages: matched,
    state: 'source_span_resolved',
    reasons: []
  };
}

function explicitRange(row = {}) {
  const start = finiteInteger(row.source_msg_start);
  const end = finiteInteger(row.source_msg_end);
  return start === null || end === null ? null : { start, end };
}

function anchorChunkRange(row = {}) {
  const start = finiteInteger(row.chunk_msg_start);
  const end = finiteInteger(row.chunk_msg_end);
  return start === null || end === null ? null : { start, end };
}

function rangesDisjoint(left, right) {
  if (!left || !right) return false;
  return Math.max(left.start, right.start) > Math.min(left.end, right.end);
}

function rangeContains(outer, inner) {
  if (!outer || !inner) return true;
  return outer.start <= inner.start && outer.end >= inner.end;
}

function lineageConsistencyReasons({
  workbench,
  reviewedRows,
  anchors,
  preparedRows,
  rawMessages
}) {
  const allRows = [workbench, ...reviewedRows, ...anchors, ...preparedRows];
  const bundleIds = uniqueStrings(allRows.map((row) => row?.source_bundle_id));
  const windowIds = uniqueStrings(allRows.map((row) => row?.source_window_id));
  const reasons = [];
  const workbenchRange = explicitRange(workbench);
  if (!safeText(workbench.source_bundle_id)) reasons.push('workbench_source_bundle_missing');
  if (!safeText(workbench.source_window_id)) reasons.push('workbench_source_window_missing');
  if (!workbenchRange) reasons.push('workbench_source_range_missing');
  if (bundleIds.length > 1) reasons.push('cross_layer_source_bundle_conflict');
  if (windowIds.length > 1) reasons.push('cross_layer_source_window_conflict');

  for (const [index, reviewed] of reviewedRows.entries()) {
    const range = explicitRange(reviewed);
    if (!safeText(reviewed.source_bundle_id)) {
      reasons.push(`reviewed[${index}]_source_bundle_missing`);
    }
    if (!safeText(reviewed.source_window_id)) {
      reasons.push(`reviewed[${index}]_source_window_missing`);
    }
    if (!range) {
      reasons.push(`reviewed[${index}]_source_range_missing`);
    } else if (rangesDisjoint(workbenchRange, range)) {
      reasons.push(`reviewed[${index}]_source_range_conflict`);
    }
  }
  for (const [index, anchor] of anchors.entries()) {
    const sourceRange = explicitRange(anchor);
    const chunkRange = anchorChunkRange(anchor);
    if (!safeText(anchor.source_bundle_id)) {
      reasons.push(`source_anchor[${index}]_source_bundle_missing`);
    }
    if (!safeText(anchor.source_window_id)) {
      reasons.push(`source_anchor[${index}]_source_window_missing`);
    }
    if (!sourceRange) {
      reasons.push(`source_anchor[${index}]_source_range_missing`);
    } else if (sourceRange.start <= 0 || sourceRange.end <= 0) {
      reasons.push(`source_anchor[${index}]_source_range_unknown`);
    } else {
      const rawAnchorMatches = rawMessages.filter(({ identity }) => (
        identity.source_bundle_id === safeText(anchor.source_bundle_id)
        && identity.source_window_id === safeText(anchor.source_window_id)
        && identity.source_msg_index !== null
        && identity.source_msg_index >= sourceRange.start
        && identity.source_msg_index <= sourceRange.end
      ));
      if (!rawAnchorMatches.length) {
        reasons.push(`source_anchor[${index}]_raw_source_range_unresolved`);
      }
    }
    if (!chunkRange) {
      reasons.push(`source_anchor[${index}]_chunk_range_missing`);
    } else if (rangesDisjoint(workbenchRange, chunkRange)) {
      reasons.push(`source_anchor[${index}]_chunk_range_conflict`);
    }
  }
  if (workbenchRange) {
    for (const [index, prepared] of preparedRows.entries()) {
      const range = explicitRange(prepared);
      if (!safeText(prepared.source_bundle_id)) {
        reasons.push(`prepared[${index}]_source_bundle_missing`);
      }
      if (!safeText(prepared.source_window_id)) {
        reasons.push(`prepared[${index}]_source_window_missing`);
      }
      if (!range) {
        reasons.push(`prepared[${index}]_source_range_missing`);
      } else if (!rangeContains(range, workbenchRange)) {
        reasons.push(`prepared[${index}]_range_does_not_cover_workbench`);
        break;
      }
    }
  }
  return uniqueStrings(reasons);
}

function collectStructuredValues(rows, fieldNames, parser = splitDelimited) {
  const values = [];
  const sources = [];
  for (const { kind, rowIndex, row } of rows) {
    for (const field of fieldNames) {
      const parsed = parser(row?.[field]);
      if (!parsed.length) continue;
      values.push(...parsed);
      sources.push({
        source: `${kind}[${rowIndex}].${field}`,
        values: parsed
      });
    }
  }
  return {
    values: uniqueStrings(values),
    sources
  };
}

function collectGraphHints({
  candidateId,
  recordId,
  workbench,
  reviewedRows,
  anchors,
  preparedRows,
  sourceSpan,
  sourceState,
  reviewState,
  authority,
  fullTags,
  fullFactKeys
}) {
  const structuredRows = [
    { kind: 'workbench', rowIndex: 0, row: workbench },
    ...reviewedRows.map((row, rowIndex) => ({ kind: 'reviewed', rowIndex, row })),
    ...anchors.map((row, rowIndex) => ({ kind: 'source_anchor', rowIndex, row }))
  ];
  const entities = collectStructuredValues(
    structuredRows,
    ['linked_entities', 'entity_refs']
  ).values;
  const topicLabels = collectStructuredValues(
    structuredRows,
    ['topic_ids', 'topic_labels', 'category', 'anchor_type']
  ).values;
  const sourceRefs = collectStructuredValues(
    [
      ...structuredRows,
      ...preparedRows.map((row, rowIndex) => ({ kind: 'prepared', rowIndex, row }))
    ],
    [
      'source_ref',
      'source_refs',
      'source_md_ref',
      'source_bundle_id',
      'source_window_id',
      'chunk_id',
      'anchor_id'
    ]
  ).values;
  const upstreamReviewStates = collectStructuredValues(
    structuredRows,
    ['review_status', 'review_state', 'review_decision', 'status']
  ).values;
  const upstreamAuthorityCandidates = collectStructuredValues(
    structuredRows,
    ['authority', 'source_authority', 'review_authority', 'authority_tier']
  ).values;
  return {
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
      source_refs: sourceRefs,
      raw_span_state: sourceSpan.state,
      raw_message_refs: sourceSpan.messages.map((item) => (
        `rawmsg_${sha256(item.identity).slice(0, 32)}`
      )),
      raw_span_sha256: sourceSpan.messages.length
        ? sha256(sourceSpan.messages.map((item) => item.identity.content_sha256))
        : '',
      raw_message_count: sourceSpan.messages.length
    },
    span: {
      source_bundle_ids: uniqueStrings([
        workbench.source_bundle_id,
        reviewedRows.map((row) => row.source_bundle_id),
        anchors.map((row) => row.source_bundle_id),
        preparedRows.map((row) => row.source_bundle_id)
      ]),
      source_window_ids: uniqueStrings([
        workbench.source_window_id,
        reviewedRows.map((row) => row.source_window_id),
        anchors.map((row) => row.source_window_id),
        preparedRows.map((row) => row.source_window_id)
      ]),
      candidate_window_local_msg_ranges: uniqueStrings([workbench].map((row) => {
        const start = finiteInteger(row?.source_msg_start);
        const end = finiteInteger(row?.source_msg_end);
        return start === null || end === null ? '' : `${start}-${end}`;
      })),
      reviewed_window_local_msg_ranges: uniqueStrings(reviewedRows.map((row) => {
        const start = finiteInteger(row?.source_msg_start);
        const end = finiteInteger(row?.source_msg_end);
        return start === null || end === null ? '' : `${start}-${end}`;
      })),
      prepared_context_window_local_msg_ranges: uniqueStrings(
        preparedRows.map((row) => {
          const start = finiteInteger(row?.source_msg_start);
          const end = finiteInteger(row?.source_msg_end);
          return start === null || end === null ? '' : `${start}-${end}`;
        })
      ),
      anchor_source_ref_msg_ranges: uniqueStrings(anchors.map((row) => {
        const start = finiteInteger(row?.source_msg_start);
        const end = finiteInteger(row?.source_msg_end);
        return start === null || end === null || start <= 0 || end <= 0
          ? ''
          : `${start}-${end}`;
      })),
      anchor_window_local_chunk_ranges: uniqueStrings(anchors.map((row) => {
        const start = finiteInteger(row?.chunk_msg_start);
        const end = finiteInteger(row?.chunk_msg_end);
        return start === null || end === null ? '' : `${start}-${end}`;
      }))
    },
    authority: {
      source_state: sourceState,
      candidate_authority: authority,
      review_state: reviewState,
      upstream_authority_candidates: upstreamAuthorityCandidates,
      direct_canonical_authority: false
    },
    review: {
      packet_review_state: reviewState,
      upstream_structured_states: upstreamReviewStates,
      human_review_required: sourceState === 'source_incomplete'
        && reviewState === 'awaiting_human_choice'
    },
    structured_candidates: {
      entities,
      topic_labels: topicLabels,
      tags: fullTags,
      fact_keys: fullFactKeys
    }
  };
}

function finalizeCandidate(payload) {
  const canonicalPayloadSha256 = sha256(payload);
  return {
    ...payload,
    integrity: {
      canonical_payload_sha256: canonicalPayloadSha256
    }
  };
}

export function verifyPortableSourceCandidate(candidate = {}) {
  if (candidate?.schema !== PORTABLE_SOURCE_CANDIDATE_SCHEMA) return false;
  const expected = safeText(candidate?.integrity?.canonical_payload_sha256);
  if (!/^[0-9a-f]{64}$/u.test(expected)) return false;
  const { integrity: _ignored, ...payload } = candidate;
  return sha256(payload) === expected;
}

export function buildBoundedProjection(candidate, {
  factKeyLimit = 64,
  notionTagLimit = 24
} = {}) {
  if (!verifyPortableSourceCandidate(candidate)) {
    throw new PortableSourcePacketError(
      'candidate_integrity_invalid',
      'Bounded projections require a valid canonical source candidate.'
    );
  }
  function bounded(values, limit) {
    const retained = values.slice(0, limit);
    const omitted = values.slice(limit);
    return {
      canonical_count: values.length,
      limit,
      retained,
      retained_count: retained.length,
      truncated: omitted.length > 0,
      omitted_count: omitted.length,
      omitted_values_sha256: omitted.length ? sha256(omitted) : ''
    };
  }
  return {
    schema: BOUNDED_PROJECTION_SCHEMA,
    projection_only: true,
    canonical_candidate_id: candidate.candidate_id,
    canonical_candidate_sha256: candidate.integrity.canonical_payload_sha256,
    runtime_atomic_fact_keys: bounded(candidate.canonical_labels.fact_keys, factKeyLimit),
    notion_tags: bounded(candidate.canonical_labels.tags, notionTagLimit),
    safety: {
      projection_is_canonical: false,
      silent_truncation_allowed: false,
      source_candidate_mutated: false,
      writes_runtime: false,
      writes_notion: false
    }
  };
}

function deterministicSample(candidates, monthKey, limit) {
  if (!Number.isInteger(limit) || limit <= 0 || candidates.length <= limit) return [...candidates];
  const byFamily = new Map();
  for (const candidate of candidates) {
    const identity = deriveEventFamilyIdentity(candidate);
    if (!byFamily.has(identity.family_key)) {
      byFamily.set(identity.family_key, {
        identity,
        candidates: []
      });
    }
    byFamily.get(identity.family_key).candidates.push(candidate);
  }
  const families = [...byFamily.values()].map((family) => {
    const byLane = new Map();
    for (const candidate of family.candidates) {
      if (!byLane.has(candidate.candidate_lane)) {
        byLane.set(candidate.candidate_lane, []);
      }
      byLane.get(candidate.candidate_lane).push(candidate);
    }
    const representatives = [...byLane.keys()]
      .sort()
      .map((lane) => byLane.get(lane).sort((left, right) => (
        sha256(`${monthKey}:${left.candidate_id}`).localeCompare(
          sha256(`${monthKey}:${right.candidate_id}`)
        )
      ))[0]);
    return {
      ...family,
      representatives,
      source_incomplete: representatives.some(
        (candidate) => candidate.source_evidence.state === 'source_incomplete'
      ),
      max_tags: Math.max(
        0,
        ...representatives.map((candidate) => candidate.canonical_labels.tags.length)
      ),
      max_fact_keys: Math.max(
        0,
        ...representatives.map((candidate) => candidate.canonical_labels.fact_keys.length)
      )
    };
  });
  families.sort((left, right) => (
    Number(right.source_incomplete) - Number(left.source_incomplete)
    || right.max_tags - left.max_tags
    || right.max_fact_keys - left.max_fact_keys
    || sha256(`${monthKey}:${left.identity.family_key}`).localeCompare(
      sha256(`${monthKey}:${right.identity.family_key}`)
    )
  ));
  const selected = [];
  const selectedIds = new Set();
  const selectedFamilies = new Set();
  const familyByKey = new Map(
    families.map((family) => [family.identity.family_key, family])
  );
  function addFamily(family) {
    if (!family || selectedFamilies.has(family.identity.family_key)) return false;
    const available = family.representatives.filter(
      (candidate) => !selectedIds.has(candidate.candidate_id)
    );
    if (!available.length || selected.length + available.length > limit) return false;
    for (const candidate of available) {
      selected.push(candidate);
      selectedIds.add(candidate.candidate_id);
    }
    selectedFamilies.add(family.identity.family_key);
    return true;
  }
  const originalByLane = new Map();
  for (const candidate of candidates) {
    if (!originalByLane.has(candidate.candidate_lane)) {
      originalByLane.set(candidate.candidate_lane, []);
    }
    originalByLane.get(candidate.candidate_lane).push(candidate);
  }
  for (const lane of [...originalByLane.keys()].sort()) {
    const boundaryCandidate = originalByLane.get(lane).find(
      (candidate) => candidate.source_evidence.state === 'source_incomplete'
    );
    if (boundaryCandidate) {
      addFamily(
        familyByKey.get(deriveEventFamilyIdentity(boundaryCandidate).family_key)
      );
    }
  }
  for (const family of families) {
    if (selected.length >= limit) break;
    addFamily(family);
  }
  if (selected.length < limit) {
    const remaining = candidates
      .filter((candidate) => !selectedIds.has(candidate.candidate_id))
      .sort((left, right) => (
        sha256(`${monthKey}:${left.candidate_id}`).localeCompare(
          sha256(`${monthKey}:${right.candidate_id}`)
        )
      ));
    for (const candidate of remaining) {
      if (selected.length >= limit) break;
      selected.push(candidate);
      selectedIds.add(candidate.candidate_id);
    }
  }
  return selected;
}

function buildCandidate({
  monthKey,
  workbench,
  workbenchIndex,
  reviewedMatches,
  anchorMatches,
  preparedMatches,
  rawMessages,
  humanDecision
}) {
  const reviewedRows = reviewedMatches.map(({ row }) => row);
  const anchors = anchorMatches.map(({ row }) => row);
  const structuredRows = [
    { kind: 'workbench', rowIndex: workbenchIndex, row: workbench },
    ...reviewedMatches.map(({ row, index }) => ({ kind: 'reviewed', rowIndex: index, row }))
  ];
  const laneValues = uniqueStrings(structuredRows.map(({ row }) => normalizeLane(row.layer)));
  const lane = laneValues.includes('case')
    ? 'case'
    : (laneValues.includes('persona') ? 'persona' : (laneValues.includes('fact') ? 'fact' : laneValues[0]));
  if (lane === 'case') {
    return {
      rejection: {
        schema: SOURCE_REJECTION_SCHEMA,
        code: 'historical_case_not_applicable_by_owner_decision',
        record_id: safeText(workbench.record_id),
        workbench_row_index: workbenchIndex,
        source_row_sha256: sha256(workbench),
        historical_case_candidate_created: false
      }
    };
  }
  if (!ALLOWED_MEMORY_LANES.has(safeText(workbench.layer).toLowerCase()) && lane === 'unknown') {
    return {
      rejection: {
        schema: SOURCE_REJECTION_SCHEMA,
        code: 'candidate_lane_unknown',
        record_id: safeText(workbench.record_id),
        workbench_row_index: workbenchIndex,
        source_row_sha256: sha256(workbench)
      }
    };
  }

  const recordId = safeText(workbench.record_id);
  const fullTags = collectStructuredValues(
    structuredRows,
    ['tags', 'source_tags', 'topic_labels'],
    parseTagsFull
  );
  const fullFactKeys = collectStructuredValues(
    structuredRows,
    ['fact_keys', 'fact_key'],
    parseFactKeysFull
  );
  const sourceSpan = matchCandidateRawSpan(rawMessages, workbench);
  const lineageConflictReasons = lineageConsistencyReasons({
    workbench,
    reviewedRows,
    anchors,
    preparedRows: preparedMatches.map(({ row }) => row),
    rawMessages
  });
  const sourceIncompleteReasons = [];
  if (!recordId) sourceIncompleteReasons.push('record_id_missing');
  if (!reviewedRows.length) sourceIncompleteReasons.push('reviewed_row_missing');
  if (!anchorMatches.length) sourceIncompleteReasons.push('source_index_anchor_missing');
  if (!preparedMatches.length) sourceIncompleteReasons.push('prepared_chunk_missing');
  sourceIncompleteReasons.push(...sourceSpan.reasons);
  sourceIncompleteReasons.push(...lineageConflictReasons);
  const sourceState = sourceIncompleteReasons.length ? 'source_incomplete' : 'source_bound';

  let reviewState = sourceState === 'source_incomplete'
    ? 'awaiting_human_choice'
    : 'upstream_reviewed_pre_admission_pending';
  let authority = sourceState === 'source_incomplete'
    ? 'legacy_import_candidate'
    : 'source_bound_candidate';
  let eligibleForPreAdmission = sourceState === 'source_bound';
  if (humanDecision) {
    if (humanDecision.decision === 'approve') {
      reviewState = 'human_approved_for_pre_admission';
      authority = humanDecision.authority;
      eligibleForPreAdmission = true;
    } else if (humanDecision.decision === 'reject') {
      reviewState = 'human_rejected';
      eligibleForPreAdmission = false;
    } else {
      reviewState = 'human_hold';
      eligibleForPreAdmission = false;
    }
  }

  const candidateId = `dspc_${sha256({
    month_key: monthKey,
    record_id: recordId,
    workbench_row_index: workbenchIndex,
    workbench_row_sha256: sha256(workbench),
    reviewed_row_sha256: reviewedRows.map((row) => sha256(row))
  }).slice(0, 32)}`;
  const payload = {
    schema: PORTABLE_SOURCE_CANDIDATE_SCHEMA,
    candidate_id: candidateId,
    month_key: monthKey,
    candidate_lane: lane,
    historical_case_extraction_status: 'not_applicable_by_owner_decision',
    upstream: {
      workbench_row: jsonClone(workbench),
      workbench_row_index: workbenchIndex,
      reviewed_rows: reviewedRows.map(jsonClone),
      reviewed_row_refs: reviewedMatches.map(({ row, index }) => rowRef('reviewed', row, index)),
      source_index_anchors: anchors.map(jsonClone),
      source_index_anchor_refs: anchorMatches.map(({ row, index }) => rowRef('source_index_anchor', row, index)),
      prepared_windows: preparedMatches.map(({ row }) => {
        const { text, ...metadata } = row;
        return {
          ...jsonClone(metadata),
          text_chars: String(text ?? '').length,
          text_sha256: sha256(String(text ?? ''))
        };
      })
    },
    canonical_labels: {
      tags: fullTags.values,
      tag_sources: fullTags.sources,
      fact_keys: fullFactKeys.values,
      fact_key_sources: fullFactKeys.sources,
      tags_are_complete_upstream_projection: true,
      fact_keys_are_complete_upstream_projection: true,
      canonical_fact_key_limit: null,
      canonical_tag_limit: null
    },
    source_evidence: {
      state: sourceState,
      incomplete_reasons: uniqueStrings(sourceIncompleteReasons),
      raw_span_state: sourceSpan.state,
      raw_message_refs: sourceSpan.messages.map((item) => (
        `rawmsg_${sha256(item.identity).slice(0, 32)}`
      )),
      raw_message_count: sourceSpan.messages.length,
      raw_message_content_sha256: sourceSpan.messages.map((item) => item.identity.content_sha256),
      source_span_sha256: sourceSpan.messages.length
        ? sha256(sourceSpan.messages.map((item) => item.identity.content_sha256))
        : ''
    },
    human_review: {
      visible_choice_required: sourceState === 'source_incomplete' && !humanDecision,
      state: reviewState,
      decision: humanDecision?.decision || '',
      authority: humanDecision?.authority || '',
      reviewer: humanDecision?.reviewer || '',
      decided_at: humanDecision?.decided_at || '',
      note: humanDecision?.note || '',
      allowed_approval_authorities: ['human_attested', 'legacy_import'],
      source_incomplete_is_automatically_blocked: false,
      eligible_for_hippocove_pre_admission: eligibleForPreAdmission
    },
    graph_hints: collectGraphHints({
      candidateId,
      recordId,
      workbench,
      reviewedRows,
      anchors,
      preparedRows: preparedMatches.map(({ row }) => row),
      sourceSpan,
      sourceState,
      reviewState,
      authority,
      fullTags: fullTags.values,
      fullFactKeys: fullFactKeys.values
    }),
    safety: {
      runtime_effect: 'none',
      writes_home: false,
      writes_hippocove: false,
      writes_notion: false,
      creates_canonical_edges: false,
      creates_canonical_receipts: false
    }
  };
  return { candidate: finalizeCandidate(payload) };
}

export function buildPortableSourcePacket({
  monthKey,
  fiveLayerManifest,
  rawBundles = [],
  preparedRows = [],
  workbenchRows = [],
  sourceIndex = {},
  reviewedRows = [],
  humanDecisions = {},
  sampleLimit = 0
} = {}) {
  const month = safeText(monthKey);
  if (!/^\d{4}-\d{2}$/u.test(month)) {
    throw new PortableSourcePacketError(
      'month_key_invalid',
      'Portable source packets require month_key in YYYY-MM form.'
    );
  }
  if (!Array.isArray(rawBundles) || !Array.isArray(preparedRows) || !Array.isArray(workbenchRows)) {
    throw new PortableSourcePacketError(
      'five_layer_shape_invalid',
      'Raw, prepared, and workbench inputs must be arrays.'
    );
  }
  if (!isPlainObject(sourceIndex)) {
    throw new PortableSourcePacketError(
      'source_index_shape_invalid',
      'Source index input must be an object.'
    );
  }
  if (!Array.isArray(reviewedRows)) {
    throw new PortableSourcePacketError(
      'reviewed_shape_invalid',
      'Reviewed input must be an array.'
    );
  }

  const decisionsByRecord = normalizeHumanDecisions(humanDecisions, month);
  const sourceAnchors = Array.isArray(sourceIndex.anchors) ? sourceIndex.anchors : [];
  const sourceTopics = Array.isArray(sourceIndex.source_topic_index)
    ? sourceIndex.source_topic_index
    : [];
  const workbenchByRecord = multiMap(workbenchRows, (row) => row.record_id);
  const ambiguousWorkbenchRecordIds = [...workbenchByRecord.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([recordId, rows]) => ({
      record_id: recordId,
      workbench_row_indexes: rows.map(({ index }) => index)
    }));
  if (ambiguousWorkbenchRecordIds.length) {
    throw new PortableSourcePacketError(
      'workbench_record_id_ambiguous',
      'A workbench record_id may identify only one source row; reviewed rows cannot fan out across duplicate workbench identities.',
      {
        ambiguous_record_count: ambiguousWorkbenchRecordIds.length,
        ambiguous_records: ambiguousWorkbenchRecordIds.slice(0, 100)
      }
    );
  }
  const reviewedByRecord = multiMap(reviewedRows, (row) => row.record_id);
  const anchorByRecord = multiMap(sourceAnchors, (row) => row.record_id);
  const preparedByChunk = multiMap(preparedRows, (row) => row.chunk_id);
  const ambiguousPreparedChunkIds = [...preparedByChunk.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([chunkId, rows]) => ({
      chunk_id: chunkId,
      prepared_row_indexes: rows.map(({ index }) => index),
      source_bundle_ids: uniqueStrings(rows.map(({ row }) => row.source_bundle_id)),
      source_window_ids: uniqueStrings(rows.map(({ row }) => row.source_window_id))
    }));
  if (ambiguousPreparedChunkIds.length) {
    throw new PortableSourcePacketError(
      'prepared_chunk_id_ambiguous',
      'A prepared chunk_id may identify only one source window; ambiguous chunks cannot be joined into candidates.',
      {
        ambiguous_chunk_count: ambiguousPreparedChunkIds.length,
        ambiguous_chunks: ambiguousPreparedChunkIds.slice(0, 100)
      }
    );
  }
  const rawDisposition = buildRawDisposition(rawBundles, preparedRows);
  const workbenchReviewLedger = [];
  const rejected = [];
  const allCandidates = [];
  const matchedReviewedIndexes = new Set();
  const matchedAnchorIndexes = new Set();
  const matchedPreparedIndexes = new Set();

  workbenchRows.forEach((workbench, workbenchIndex) => {
    const recordId = safeText(workbench.record_id);
    const reviewedMatches = recordId ? (reviewedByRecord.get(recordId) || []) : [];
    reviewedMatches.forEach(({ index }) => matchedReviewedIndexes.add(index));
    const anchorMatches = recordId ? (anchorByRecord.get(recordId) || []) : [];
    anchorMatches.forEach(({ index }) => matchedAnchorIndexes.add(index));
    const chunkIds = uniqueStrings([
      workbench.chunk_id,
      reviewedMatches.map(({ row }) => row.chunk_id),
      anchorMatches.map(({ row }) => row.chunk_id)
    ]);
    const preparedMatches = chunkIds.flatMap((chunkId) => preparedByChunk.get(chunkId) || []);
    preparedMatches.forEach(({ index }) => matchedPreparedIndexes.add(index));
    const decision = decisionsByRecord.get(recordId);
    const candidateInput = {
      monthKey: month,
      workbench,
      workbenchIndex,
      reviewedMatches,
      anchorMatches,
      preparedMatches,
      rawMessages: rawDisposition.rawMessages
    };
    const baseline = buildCandidate(candidateInput);
    if (decision && !baseline.candidate) {
      throw new PortableSourcePacketError(
        'human_decision_target_not_candidate',
        'Human decision target does not produce a portable source candidate.',
        { record_id: recordId }
      );
    }
    if (
      decision
      && (
        decision.candidate_id !== baseline.candidate.candidate_id
        || decision.canonical_payload_sha256
          !== baseline.candidate.integrity.canonical_payload_sha256
      )
    ) {
      throw new PortableSourcePacketError(
        'human_decision_candidate_binding_mismatch',
        'Human decision does not match the current frozen candidate identity and payload.',
        {
          record_id: recordId,
          expected_candidate_id: baseline.candidate.candidate_id,
          observed_candidate_id: decision.candidate_id,
          expected_canonical_payload_sha256:
            baseline.candidate.integrity.canonical_payload_sha256,
          observed_canonical_payload_sha256: decision.canonical_payload_sha256
        }
      );
    }
    if (
      decision?.decision === 'approve'
      && baseline.candidate.source_evidence.state === 'source_bound'
    ) {
      throw new PortableSourcePacketError(
        'human_decision_source_bound_approval_invalid',
        'Source-bound candidates already carry source evidence and cannot be downgraded to human-attested or legacy-import authority.',
        { record_id: recordId, candidate_id: baseline.candidate.candidate_id }
      );
    }
    const built = decision
      ? buildCandidate({ ...candidateInput, humanDecision: decision })
      : baseline;
    if (built.rejection) rejected.push(built.rejection);
    if (built.candidate) allCandidates.push(built.candidate);
    workbenchReviewLedger.push({
      schema: WORKBENCH_REVIEW_LEDGER_SCHEMA,
      workbench_row_index: workbenchIndex,
      record_id: recordId,
      workbench_row_sha256: sha256(workbench),
      reviewed_match_count: reviewedMatches.length,
      reviewed_row_refs: reviewedMatches.map(({ row, index }) => rowRef('reviewed', row, index)),
      conservation_state: reviewedMatches.length === 0
        ? 'zero_reviewed_rows_pending_review'
        : (reviewedMatches.length === 1 ? 'one_reviewed_row' : 'multiple_reviewed_rows'),
      zero_to_many_mapping_preserved: true
    });
  });

  reviewedRows.forEach((row, index) => {
    if (matchedReviewedIndexes.has(index)) return;
    rejected.push({
      schema: SOURCE_REJECTION_SCHEMA,
      code: 'reviewed_row_without_workbench',
      record_id: safeText(row.record_id),
      reviewed_row_index: index,
      source_row_sha256: sha256(row),
      row_preserved_in_rejection_ledger: true
    });
  });
  sourceAnchors.forEach((row, index) => {
    if (matchedAnchorIndexes.has(index)) return;
    rejected.push({
      schema: SOURCE_REJECTION_SCHEMA,
      code: 'source_index_anchor_without_workbench',
      record_id: safeText(row.record_id),
      source_index_anchor_index: index,
      source_row_sha256: sha256(row),
      row_preserved_in_rejection_ledger: true
    });
  });
  preparedRows.forEach((row, index) => {
    if (matchedPreparedIndexes.has(index)) return;
    rejected.push({
      schema: SOURCE_REJECTION_SCHEMA,
      code: 'prepared_chunk_without_candidate_reference',
      chunk_id: safeText(row.chunk_id),
      prepared_row_index: index,
      source_row_sha256: sha256(row),
      row_preserved_in_rejection_ledger: true
    });
  });
  for (const recordId of decisionsByRecord.keys()) {
    if (!workbenchRows.some((row) => safeText(row.record_id) === recordId)) {
      throw new PortableSourcePacketError(
        'human_decision_target_missing',
        'Human decision record_id does not exist in the workbench input.',
        { record_id: recordId }
      );
    }
  }

  const candidates = deterministicSample(allCandidates, month, sampleLimit);
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidate_id));
  const humanReviewQueue = candidates
    .filter((candidate) => candidate.human_review.visible_choice_required)
    .map((candidate) => ({
      schema: HUMAN_REVIEW_QUEUE_SCHEMA,
      review_item_id: `dspr_${sha256(candidate.candidate_id).slice(0, 32)}`,
      candidate_id: candidate.candidate_id,
      record_id: safeText(candidate.upstream.workbench_row.record_id),
      candidate_lane: candidate.candidate_lane,
      source_evidence_state: candidate.source_evidence.state,
      incomplete_reasons: candidate.source_evidence.incomplete_reasons,
      visible_context: {
        title: firstText(
          candidate.upstream.workbench_row.title,
          candidate.upstream.workbench_row.card_name,
          candidate.upstream.reviewed_rows[0]?.title
        ),
        text: firstText(
          candidate.upstream.workbench_row.text,
          candidate.upstream.workbench_row.fact_value,
          candidate.upstream.reviewed_rows[0]?.text
        ),
        month_key: month
      },
      choices: [
        { decision: 'approve', authority: 'human_attested' },
        { decision: 'approve', authority: 'legacy_import' },
        { decision: 'hold', authority: '' },
        { decision: 'reject', authority: '' }
      ],
      writes_any_destination: false
    }));
  const projections = candidates.map((candidate) => buildBoundedProjection(candidate));
  const emittedReviewedIndexes = new Set(
    candidates.flatMap((candidate) => candidate.upstream.reviewed_row_refs.map((ref) => ref.row_index))
  );
  const zeroReviewRows = workbenchReviewLedger.filter((row) => row.reviewed_match_count === 0).length;
  const mappedReviewRows = matchedReviewedIndexes.size;
  const sourceCompleteCandidates = allCandidates.filter(
    (candidate) => candidate.source_evidence.state === 'source_bound'
  ).length;
  const sourceIncompleteCandidates = allCandidates.length - sourceCompleteCandidates;
  const fullTagCount = allCandidates.reduce(
    (sum, candidate) => sum + candidate.canonical_labels.tags.length,
    0
  );
  const fullFactKeyCount = allCandidates.reduce(
    (sum, candidate) => sum + candidate.canonical_labels.fact_keys.length,
    0
  );
  const packetPayload = {
    schema: PORTABLE_SOURCE_PACKET_SCHEMA,
    month_key: month,
    generation_profile: Number.isInteger(sampleLimit) && sampleLimit > 0
      ? 'representative_canary'
      : 'full_processed_packet',
    sample_limit: Number.isInteger(sampleLimit) && sampleLimit > 0 ? sampleLimit : 0,
    five_layer_manifest: jsonClone(fiveLayerManifest),
    lane_contract: {
      native_lanes: ['persona', 'fact'],
      sql_normalizes_to_fact: true,
      historical_case_candidates: 0,
      historical_case_extraction_status: 'not_applicable_by_owner_decision',
      keyword_case_reconstruction_allowed: false
    },
    candidate_counts: {
      full_candidates_before_sampling: allCandidates.length,
      emitted_candidates: candidates.length,
      emitted_candidate_ids: [...candidateIds].sort(),
      source_bound_candidates_full: sourceCompleteCandidates,
      source_incomplete_candidates_full: sourceIncompleteCandidates,
      source_incomplete_candidates_emitted: candidates.filter(
        (candidate) => candidate.source_evidence.state === 'source_incomplete'
      ).length,
      human_review_queue_items_emitted: humanReviewQueue.length,
      human_approved_for_pre_admission_full: allCandidates.filter(
        (candidate) => candidate.human_review.state === 'human_approved_for_pre_admission'
      ).length,
      eligible_for_hippocove_pre_admission_full: allCandidates.filter(
        (candidate) => candidate.human_review.eligible_for_hippocove_pre_admission
      ).length
    },
    conservation: {
      raw_to_prepared: rawDisposition.conservation,
      workbench_to_reviewed: {
        workbench_rows: workbenchRows.length,
        with_one_or_more_reviewed_rows: workbenchRows.length - zeroReviewRows,
        with_zero_reviewed_rows_pending_review: zeroReviewRows,
        equation_passed: workbenchRows.length === (
          workbenchRows.length - zeroReviewRows + zeroReviewRows
        ),
        reviewed_rows: reviewedRows.length,
        reviewed_rows_matched_to_workbench: mappedReviewRows,
        reviewed_rows_without_workbench: reviewedRows.length - mappedReviewRows,
        reviewed_equation_passed: reviewedRows.length === (
          mappedReviewRows + (reviewedRows.length - mappedReviewRows)
        ),
        emitted_sample_reviewed_row_refs: emittedReviewedIndexes.size,
        zero_to_many_mapping_preserved: true
      },
      source_index: {
        anchors: sourceAnchors.length,
        anchors_matched_to_workbench: matchedAnchorIndexes.size,
        anchors_without_workbench: sourceAnchors.length - matchedAnchorIndexes.size,
        topics: sourceTopics.length
      },
      prepared_candidate_join: {
        prepared_rows: preparedRows.length,
        candidate_referenced_rows: matchedPreparedIndexes.size,
        unreferenced_rows: preparedRows.length - matchedPreparedIndexes.size
      },
      canonical_labels: {
        full_tag_occurrences_after_candidate_dedupe: fullTagCount,
        full_fact_key_occurrences_after_candidate_dedupe: fullFactKeyCount,
        canonical_tag_limit: null,
        canonical_fact_key_limit: null,
        bounded_projection_is_separate: true,
        silent_truncation_allowed: false
      }
    },
    boundary: {
      reads_existing_processed_layers_only: true,
      reruns_model_extraction: false,
      contains_private_candidate_text: true,
      git_safe_generated_output: false,
      hippocove_pre_admission_only: true,
      writes_home: false,
      writes_hippocove: false,
      writes_notion: false,
      writes_cloud_drive: false,
      creates_canonical_memory: false
    }
  };
  const packet = {
    ...packetPayload,
    integrity: {
      packet_payload_sha256: sha256(packetPayload)
    }
  };
  return {
    packet,
    candidates,
    rawDisposition: rawDisposition.entries,
    preparedCoverage: rawDisposition.preparedCoverage,
    workbenchReviewLedger,
    humanReviewQueue,
    projections,
    rejected
  };
}

export function verifyPortableSourcePacket(packet = {}) {
  if (packet?.schema !== PORTABLE_SOURCE_PACKET_SCHEMA) return false;
  const expected = safeText(packet?.integrity?.packet_payload_sha256);
  if (!/^[0-9a-f]{64}$/u.test(expected)) return false;
  const { integrity: _ignored, ...payload } = packet;
  return sha256(payload) === expected;
}

export function serializeJsonl(rows = []) {
  return rows.length ? `${rows.map((row) => stableJson(row)).join('\n')}\n` : '';
}
