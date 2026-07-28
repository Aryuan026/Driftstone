import {
  deriveEventFamilyIdentity,
  safeText,
  sha256,
  stableJson,
  verifyPortableSourceCandidate
} from './driftstone-portable-source-packet-v1.mjs';

export const DRIFTSTONE_EVENT_FAMILY_SCHEMA = 'driftstone_event_family_v1';
export const DRIFTSTONE_HOME_WARM_INTAKE_SCHEMA = 'driftstone_home_warm_intake_v1';
export const DRIFTSTONE_WARM_REWRITE_CANDIDATE_SCHEMA =
  'driftstone_warm_rewrite_candidate_v0';

const APPROVAL_AUTHORITIES = new Set(['human_attested', 'legacy_import']);

export class DriftstoneHomeWarmIntakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DriftstoneHomeWarmIntakeError';
    this.code = code;
    this.details = details;
  }
}

function safeArray(value, limit = 4096) {
  return Array.isArray(value)
    ? value.filter((item) => item !== null && item !== undefined).slice(0, limit)
    : [];
}

function uniqueStrings(values = [], limit = 4096) {
  const seen = new Set();
  const output = [];
  for (const value of safeArray(values).flat(Infinity)) {
    const text = safeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function firstText(...values) {
  for (const value of values) {
    const text = safeText(value);
    if (text) return text;
  }
  return '';
}

function firstInteger(...values) {
  for (const value of values) {
    if (value === '' || value === null || value === undefined) continue;
    const number = Number(value);
    if (Number.isInteger(number)) return number;
  }
  return null;
}

function candidateTitle(candidate = {}) {
  const row = candidate?.upstream?.workbench_row || {};
  return firstText(
    row.title,
    row.card_name,
    row.anchor_name,
    row.fact_key,
    candidate?.upstream?.reviewed_rows?.[0]?.title,
    row.record_id
  );
}

function normalizedTitle(value) {
  return safeText(value)
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function memberSourceKeys(candidate = {}) {
  const workbench = candidate?.upstream?.workbench_row || {};
  const reviewed = safeArray(candidate?.upstream?.reviewed_rows);
  const anchors = safeArray(candidate?.upstream?.source_index_anchors);
  const prepared = safeArray(candidate?.upstream?.prepared_windows);
  const allRows = [workbench, ...reviewed, ...anchors, ...prepared];
  return {
    source_bundle_ids: uniqueStrings([
      candidate?.graph_hints?.span?.source_bundle_ids,
      allRows.map((row) => row?.source_bundle_id)
    ]),
    source_window_ids: uniqueStrings([
      candidate?.graph_hints?.span?.source_window_ids,
      allRows.map((row) => row?.source_window_id)
    ]),
    chunk_ids: uniqueStrings([
      allRows.map((row) => row?.chunk_id),
      prepared.map((row) => row?.chunk_id)
    ]),
    source_refs: uniqueStrings([
      allRows.map((row) => row?.source_ref),
      allRows.map((row) => row?.source_refs)
    ]),
    message_ranges: uniqueStrings([
      candidate?.graph_hints?.span?.candidate_window_local_msg_ranges,
      candidate?.graph_hints?.span?.reviewed_window_local_msg_ranges,
      (() => {
        const start = firstInteger(
          workbench.source_msg_start,
          workbench.msg_start,
          workbench.chunk_msg_start
        );
        const end = firstInteger(
          workbench.source_msg_end,
          workbench.msg_end,
          workbench.chunk_msg_end
        );
        return start === null || end === null ? '' : `${start}-${end}`;
      })()
    ])
  };
}

function memberEventKeys(candidate = {}) {
  const rows = [
    candidate?.upstream?.workbench_row,
    ...safeArray(candidate?.upstream?.reviewed_rows)
  ];
  return {
    event_anchors: uniqueStrings(rows.map((row) => row?.event_anchor)),
    link_ids: uniqueStrings(rows.map((row) => row?.link_id)),
    track_ids: uniqueStrings(rows.map((row) => row?.track_id)),
    upstream_family_ids: uniqueStrings(rows.map((row) => row?.family_id))
  };
}

function familyMember(candidate = {}) {
  return {
    candidate_id: safeText(candidate.candidate_id),
    canonical_payload_sha256: safeText(candidate?.integrity?.canonical_payload_sha256),
    record_id: safeText(candidate?.upstream?.workbench_row?.record_id),
    month_key: safeText(candidate.month_key),
    lane: safeText(candidate.candidate_lane),
    title: candidateTitle(candidate),
    source_state: safeText(candidate?.source_evidence?.state),
    source_keys: memberSourceKeys(candidate),
    event_keys: memberEventKeys(candidate)
  };
}

export function buildEventFamilies(candidates = []) {
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new DriftstoneHomeWarmIntakeError(
      'event_family_candidates_required',
      'Event family construction requires at least one candidate.'
    );
  }
  const groups = new Map();
  for (const candidate of candidates) {
    if (!verifyPortableSourceCandidate(candidate)) {
      throw new DriftstoneHomeWarmIntakeError(
        'event_family_candidate_integrity_invalid',
        'Event family members must preserve a valid portable candidate digest.',
        { candidate_id: safeText(candidate?.candidate_id) }
      );
    }
    const identity = deriveEventFamilyIdentity(candidate);
    if (!groups.has(identity.family_key)) {
      groups.set(identity.family_key, {
        identity,
        candidates: []
      });
    }
    groups.get(identity.family_key).candidates.push(candidate);
  }
  return [...groups.values()]
    .map(({ identity, candidates: members }) => {
      const orderedMembers = members.slice().sort((left, right) => (
        left.candidate_lane.localeCompare(right.candidate_lane)
        || left.candidate_id.localeCompare(right.candidate_id)
      ));
      const memberRefs = orderedMembers.map(familyMember);
      const personaCount = memberRefs.filter((member) => member.lane === 'persona').length;
      const factCount = memberRefs.filter((member) => member.lane === 'fact').length;
      const pairState = personaCount && factCount
        ? 'paired'
        : (personaCount ? 'persona_only' : 'fact_only');
      const familyPayload = {
        schema: DRIFTSTONE_EVENT_FAMILY_SCHEMA,
        family_id: identity.family_key,
        identity_basis: identity.basis,
        identity_confidence: identity.confidence,
        identity_key_material: identity.key_material,
        reviewed_family_kind: identity.reviewed_family_kind,
        month_key: safeText(orderedMembers[0]?.month_key),
        pair_state: pairState,
        persona_member_count: personaCount,
        fact_member_count: factCount,
        member_count: memberRefs.length,
        member_refs: memberRefs,
        event_keys: {
          event_anchors: uniqueStrings(
            memberRefs.map((member) => member.event_keys.event_anchors)
          ),
          link_ids: uniqueStrings(memberRefs.map((member) => member.event_keys.link_ids)),
          track_ids: uniqueStrings(memberRefs.map((member) => member.event_keys.track_ids)),
          upstream_family_ids: uniqueStrings(
            memberRefs.map((member) => member.event_keys.upstream_family_ids)
          )
        },
        source_keys: {
          source_bundle_ids: uniqueStrings(
            memberRefs.map((member) => member.source_keys.source_bundle_ids)
          ),
          source_window_ids: uniqueStrings(
            memberRefs.map((member) => member.source_keys.source_window_ids)
          ),
          chunk_ids: uniqueStrings(memberRefs.map((member) => member.source_keys.chunk_ids)),
          source_refs: uniqueStrings(
            memberRefs.map((member) => member.source_keys.source_refs)
          ),
          message_ranges: uniqueStrings(
            memberRefs.map((member) => member.source_keys.message_ranges)
          )
        },
        deterministic_identity_is_source_grouping_not_semantic_equivalence: true,
        paired_facets_remain_independent: true
      };
      return {
        ...familyPayload,
        family_digest_sha256: sha256(familyPayload)
      };
    })
    .sort((left, right) => (
      left.month_key.localeCompare(right.month_key)
      || left.family_id.localeCompare(right.family_id)
    ));
}

export function buildTitleCollisionWarnings(families = []) {
  const titleFamilies = new Map();
  for (const family of families) {
    for (const member of safeArray(family.member_refs)) {
      const titleKey = normalizedTitle(member.title);
      if (!titleKey) continue;
      if (!titleFamilies.has(titleKey)) titleFamilies.set(titleKey, new Map());
      const byFamily = titleFamilies.get(titleKey);
      if (!byFamily.has(family.family_id)) byFamily.set(family.family_id, []);
      byFamily.get(family.family_id).push({
        candidate_id: member.candidate_id,
        lane: member.lane,
        title: member.title
      });
    }
  }
  return [...titleFamilies.entries()]
    .filter(([, byFamily]) => byFamily.size > 1)
    .map(([titleKey, byFamily]) => ({
      warning_code: 'same_title_across_distinct_event_families',
      normalized_title_sha256: sha256(titleKey),
      family_count: byFamily.size,
      family_members: [...byFamily.entries()]
        .map(([familyId, members]) => ({
          family_id: familyId,
          members
        }))
        .sort((left, right) => left.family_id.localeCompare(right.family_id)),
      automatic_merge_allowed: false
    }))
    .sort((left, right) => (
      left.normalized_title_sha256.localeCompare(right.normalized_title_sha256)
    ));
}

export function buildWarmRewriteCandidatePacket({
  row = {},
  node = {},
  candidate = {},
  lineage = {},
  sourceAuthority = {},
  eventFamily = null,
  pairedSqlFacets = []
} = {}) {
  const reviewRowId = safeText(row.review_row_id);
  const packet = {
    schema: DRIFTSTONE_WARM_REWRITE_CANDIDATE_SCHEMA,
    candidate_id: reviewRowId
      ? reviewRowId.replace(/^home_review\./u, 'warm_rewrite_candidate.')
      : `warm_rewrite_candidate.${sha256({
        source_entry_id: safeText(row.source_entry_id),
        candidate_claim: safeText(row.candidate_claim)
      }).slice(0, 32)}`,
    review_row_id: reviewRowId,
    source_entry_id: safeText(row.source_entry_id),
    assimilation_status: 'not_sent',
    candidate_only: true,
    writes_warm_memory: false,
    final_body_markdown_generated: false,
    persona_prompt_read_by_driftstone: false,
    requires_home_runtime_persona: true,
    source_material: {
      source_quote: safeText(row.source_quote),
      excerpt_text: safeText(row.excerpt_text),
      excerpt_hint: safeText(row.excerpt_hint),
      source_quote_available: Boolean(sourceAuthority.source_quote_available),
      source_quote_kind: safeText(sourceAuthority.source_quote_kind),
      source_quote_is_raw_or_bounded_source: Boolean(sourceAuthority.source_quote_available),
      quote_recovery_status: safeText(row.quote_recovery_status),
      quote_recovery_reason: safeText(row.quote_recovery_reason),
      turn_range: safeText(row.turn_range),
      source_window: safeText(row.source_window),
      source_file: safeText(row.source_file),
      source_trace_id: safeText(row.source_trace_id),
      source_span_id: safeText(row.source_span_id)
    },
    candidate_material: {
      candidate_claim: safeText(row.candidate_claim),
      living_fragment: safeText(node.living_fragment),
      project_fact: safeText(node.project_fact),
      relationship_significance: safeText(node.relationship_significance),
      feeling_as_fact: safeText(node.feeling_as_fact),
      candidate_claim_is_source_quote: false,
      living_fragment_is_source_quote: false
    },
    event_material: safeText(node.living_fragment || row.candidate_claim),
    emotion_or_viewpoint: firstText(
      node.feeling_as_fact,
      node.relationship_significance,
      candidate.human_summary_cn,
      candidate.summary
    ),
    future_continuity_hint: firstText(
      node.front_context_hint,
      node.recall_payload,
      safeArray(node.activation_triggers, 4).join(' / ')
    ),
    owner_or_source_authority: {
      authority_kind: safeText(sourceAuthority.authority_kind),
      can_be_answer_evidence: Boolean(sourceAuthority.can_be_answer_evidence),
      reason: safeText(sourceAuthority.can_be_answer_evidence_reason),
      answer_evidence_candidate: Boolean(sourceAuthority.answer_evidence_candidate),
      source_quote_available: Boolean(sourceAuthority.source_quote_available),
      exact_bounded_claim_conservation: Boolean(
        sourceAuthority.exact_bounded_claim_conservation
      ),
      action_receipt_claim_id: safeText(sourceAuthority.action_receipt_claim?.claim_id),
      canonical_action_receipt_id: ''
    },
    lineage: {
      message_id: safeText(lineage.message_id),
      message_id_kind: safeText(lineage.message_id_kind),
      raw_message_id: safeText(lineage.raw_message_id),
      raw_message_id_kind: safeText(lineage.raw_message_id_kind),
      exchange_id: safeText(lineage.exchange_id),
      exchange_identity_kind: safeText(lineage.exchange_identity_kind),
      source_time: safeText(lineage.source_time),
      conversation_id: safeText(lineage.conversation_id),
      conversation_identity_kind: safeText(lineage.conversation_identity_kind),
      source_local_conversation_id_claim: safeText(
        lineage.source_local_conversation_id_claim
      ),
      episode_id: safeText(lineage.episode_id),
      episode_identity_kind: safeText(lineage.episode_identity_kind),
      source_local_episode_id_claim: safeText(lineage.source_local_episode_id_claim),
      scope_id: safeText(lineage.scope_id)
    },
    episode_refs: eventFamily?.family_id ? [eventFamily.family_id] : [],
    event_family: eventFamily || null,
    paired_sql_facets: safeArray(pairedSqlFacets),
    quality_hints: {
      review_status: safeText(row.review_status),
      home_lane: safeText(row.home_lane),
      promotion_status: safeText(row.promotion_status),
      import_policy_state: safeText(row.import_policy_state),
      write_risk: safeText(row.write_risk),
      evidence_strength: safeText(row.evidence_strength),
      source_incomplete: Boolean(row.source_incomplete),
      mixed_split_required: row.home_lane === 'mixed_split_required',
      recommended_home_action: row.home_lane === 'mixed_split_required'
        ? 'split_before_warm_rewrite'
        : (sourceAuthority.can_be_answer_evidence
          ? 'home_runtime_persona_rewrite_after_review'
          : 'owner_visible_review_before_any_evidence_use')
    }
  };
  return packet;
}

function portableFacetMaterial(candidate = {}) {
  const row = candidate?.upstream?.workbench_row || {};
  return {
    title: candidateTitle(candidate),
    fact_key: safeText(row.fact_key),
    fact_value: safeText(row.fact_value),
    text: firstText(row.text, row.content, row.content_text, row.summary),
    stable_points: safeArray(row.stable_points),
    update_points: safeArray(row.update_points),
    expression_fingerprint: safeText(row.expression_fingerprint)
  };
}

function homeFamilyMemberSource(member = {}) {
  return {
    source_ref: safeText(member?.source_keys?.source_refs?.[0]),
    source_window_id: safeText(member?.source_keys?.source_window_ids?.[0]),
    chunk_id: safeText(member?.source_keys?.chunk_ids?.[0]),
    event_anchor: safeText(member?.event_keys?.event_anchors?.[0]),
    link_id: safeText(member?.event_keys?.link_ids?.[0])
  };
}

export function buildHomeEventFamilyProjection({
  family,
  personaCandidate,
  factCandidates = []
} = {}) {
  if (!family?.family_id || !verifyPortableSourceCandidate(personaCandidate)) {
    throw new DriftstoneHomeWarmIntakeError(
      'home_event_family_projection_invalid',
      'A Home event-family projection requires a rich family and valid persona candidate.'
    );
  }
  const personaMember = family.member_refs.find(
    (member) => member.candidate_id === personaCandidate.candidate_id
  );
  if (!personaMember) {
    throw new DriftstoneHomeWarmIntakeError(
      'home_event_family_persona_binding_missing',
      'The persona candidate must be a member of its rich event family.'
    );
  }
  const warmCandidateId = `warm_rewrite_candidate.${personaCandidate.candidate_id}`;
  const personaSource = homeFamilyMemberSource(personaMember);
  const personaMemberRef = {
    record_id: personaMember.record_id,
    candidate_id: warmCandidateId,
    title: personaMember.title,
    ...personaSource,
    fact_key: '',
    fact_value: '',
    payload_digest: personaCandidate.integrity.canonical_payload_sha256
  };
  const sqlMemberRefs = factCandidates.map((candidate) => {
    const member = family.member_refs.find(
      (item) => item.candidate_id === candidate.candidate_id
    );
    if (!member || !verifyPortableSourceCandidate(candidate)) {
      throw new DriftstoneHomeWarmIntakeError(
        'home_event_family_sql_binding_invalid',
        'Every SQL sibling must preserve a valid rich-family candidate binding.',
        { candidate_id: safeText(candidate?.candidate_id) }
      );
    }
    const material = portableFacetMaterial(candidate);
    return {
      record_id: member.record_id,
      candidate_id: member.candidate_id,
      title: member.title,
      ...homeFamilyMemberSource(member),
      fact_key: material.fact_key,
      fact_value: firstText(material.fact_value, material.text),
      payload_digest: candidate.integrity.canonical_payload_sha256
    };
  });
  return {
    schema: 'driftstone_event_family.v0',
    family_id: family.family_id,
    family_kind: 'persona_sql_family',
    family_anchor_id: personaMember.record_id || warmCandidateId,
    family_anchor_title: personaMember.title,
    persona_member_refs: [personaMemberRef],
    sql_member_refs: sqlMemberRefs,
    source_refs: uniqueStrings([
      family?.source_keys?.source_refs,
      family?.source_keys?.source_window_ids,
      family?.source_keys?.chunk_ids
    ], 64),
    event_anchor: safeText(family?.event_keys?.event_anchors?.[0]),
    link_id: safeText(family?.event_keys?.link_ids?.[0]),
    pair_state: sqlMemberRefs.length ? 'paired' : 'persona_only',
    factual_context_only: true,
    persona_rewrite_may_modify_sql: false,
    home_answer_evidence_authority: 'not_granted'
  };
}

export function buildPortableWarmRewriteCandidate({
  candidate,
  eventFamily,
  pairedFactCandidates = []
} = {}) {
  if (!verifyPortableSourceCandidate(candidate) || candidate.candidate_lane !== 'persona') {
    throw new DriftstoneHomeWarmIntakeError(
      'portable_persona_candidate_invalid',
      'Home warm rewrite candidates must originate from a valid persona candidate.'
    );
  }
  const row = candidate.upstream.workbench_row || {};
  const sourceKeys = memberSourceKeys(candidate);
  const candidateClaim = firstText(
    row.content,
    row.text,
    row.content_text,
    row.summary,
    row.background,
    safeArray(row.stable_points).join('\n')
  );
  const pairedSqlFacets = pairedFactCandidates.map((factCandidate) => ({
    schema: 'driftstone_sql_sibling_facet_v1',
    source_candidate_binding: {
      record_id: safeText(factCandidate?.upstream?.workbench_row?.record_id),
      candidate_id: safeText(factCandidate.candidate_id),
      canonical_payload_sha256: safeText(
        factCandidate?.integrity?.canonical_payload_sha256
      )
    },
    family_id: safeText(eventFamily?.family_id),
    facet_material: portableFacetMaterial(factCandidate),
    source_state: safeText(factCandidate?.source_evidence?.state),
    independent_fact_facet: true,
    mixed_into_persona_candidate_material: false,
    canonical_authority_granted: false
  }));
  const homeEventFamily = buildHomeEventFamilyProjection({
    family: eventFamily,
    personaCandidate: candidate,
    factCandidates: pairedFactCandidates
  });
  return buildWarmRewriteCandidatePacket({
    row: {
      review_row_id: `home_review.${candidate.candidate_id}`,
      source_entry_id: candidate.candidate_id,
      candidate_claim: candidateClaim,
      excerpt_text: candidateClaim,
      excerpt_hint: candidateTitle(candidate),
      source_quote: '',
      source_window: sourceKeys.source_window_ids[0] || '',
      source_file: sourceKeys.source_bundle_ids[0] || '',
      turn_range: sourceKeys.message_ranges[0] || '',
      source_incomplete: candidate.source_evidence.state === 'source_incomplete',
      review_status: safeText(row.review_status),
      home_lane: 'warm',
      promotion_status: 'candidate_only',
      import_policy_state: 'review_only',
      write_risk: 'home_runtime_review_required',
      evidence_strength: candidate.source_evidence.state
    },
    node: {
      living_fragment: candidateClaim,
      project_fact: '',
      relationship_significance: firstText(
        row.relation_to_user,
        row.relationship_significance
      ),
      feeling_as_fact: firstText(row.affect, row.feeling_as_fact),
      front_context_hint: firstText(row.pattern, row.future_continuity_hint),
      activation_triggers: safeArray(row.activation_triggers)
    },
    candidate: {
      human_summary_cn: safeText(row.summary),
      summary: safeText(row.summary)
    },
    lineage: {
      message_id: safeText(row.message_id),
      raw_message_id: safeText(row.raw_message_id),
      exchange_id: safeText(row.exchange_id),
      source_time: safeText(row.source_time || row.timestamp),
      conversation_id: safeText(row.conversation_id),
      episode_id: safeText(row.episode_id),
      scope_id: safeText(row.scope_id)
    },
    sourceAuthority: {
      authority_kind: candidate.source_evidence.state === 'source_bound'
        ? 'source_bound_candidate'
        : 'source_incomplete_candidate',
      can_be_answer_evidence: false,
      can_be_answer_evidence_reason: 'home_review_and_canonical_commit_required',
      answer_evidence_candidate: candidate.source_evidence.state === 'source_bound',
      source_quote_available: false,
      exact_bounded_claim_conservation: false
    },
    eventFamily: homeEventFamily,
    pairedSqlFacets
  });
}

function decisionMapFromDocuments(bundle, decisionDocuments) {
  const candidatesById = new Map(
    bundle.candidates.map((candidate) => [candidate.candidate_id, candidate])
  );
  const decisions = new Map();
  for (const document of safeArray(decisionDocuments)) {
    for (const entry of safeArray(document?.decisions)) {
      const candidate = candidatesById.get(safeText(entry.candidate_id));
      if (
        !candidate
        || safeText(entry.record_id)
          !== safeText(candidate?.upstream?.workbench_row?.record_id)
        || safeText(entry.canonical_payload_sha256)
          !== safeText(candidate?.integrity?.canonical_payload_sha256)
      ) {
        throw new DriftstoneHomeWarmIntakeError(
          'intake_decision_binding_mismatch',
          'Intake decisions must preserve record_id, candidate_id, and candidate digest.',
          { candidate_id: safeText(entry.candidate_id) }
        );
      }
      if (decisions.has(candidate.candidate_id)) {
        throw new DriftstoneHomeWarmIntakeError(
          'intake_decision_duplicate',
          'Only one sealed decision may bind a candidate.',
          { candidate_id: candidate.candidate_id }
        );
      }
      decisions.set(candidate.candidate_id, entry);
    }
  }
  return decisions;
}

function eligibility(candidate, decision) {
  const sourceState = candidate.source_evidence.state;
  const action = safeText(decision?.decision).toLowerCase();
  const authority = safeText(decision?.authority).toLowerCase();
  if (sourceState === 'source_bound') {
    if (action === 'hold' || action === 'reject') {
      return { eligible: false, reason: `explicit_${action}`, authority: '' };
    }
    if (action === 'approve') {
      throw new DriftstoneHomeWarmIntakeError(
        'source_bound_approval_invalid',
        'Source-bound candidates cannot be downgraded to human approval authority.',
        { candidate_id: candidate.candidate_id }
      );
    }
    return {
      eligible: true,
      reason: 'source_bound_auto_eligible',
      authority: 'source_bound_candidate'
    };
  }
  if (action === 'approve' && APPROVAL_AUTHORITIES.has(authority)) {
    return {
      eligible: true,
      reason: 'source_incomplete_owner_approved',
      authority
    };
  }
  return {
    eligible: false,
    reason: action === 'hold' || action === 'reject'
      ? `explicit_${action}`
      : 'source_incomplete_owner_approval_required',
    authority: ''
  };
}

export function buildHomeWarmIntake({
  bundle,
  decisionDocuments = [],
  generatedAt = new Date().toISOString()
} = {}) {
  if (!bundle || !Array.isArray(bundle.candidates) || !bundle.candidates.length) {
    throw new DriftstoneHomeWarmIntakeError(
      'intake_review_bundle_invalid',
      'Home warm intake requires a private review bundle with candidates.'
    );
  }
  const decisions = decisionMapFromDocuments(bundle, decisionDocuments);
  const families = Array.isArray(bundle.event_families) && bundle.event_families.length
    ? bundle.event_families
    : buildEventFamilies(bundle.candidates);
  const candidatesById = new Map(
    bundle.candidates.map((candidate) => [candidate.candidate_id, candidate])
  );
  const eventFamilyIntakes = [];
  const excludedPersonaCandidates = [];
  const excludedFactCandidates = [];
  const eligibleFactFacets = [];
  const factOnlyFamilies = [];
  for (const family of families) {
    const memberCandidates = family.member_refs
      .map((member) => candidatesById.get(member.candidate_id))
      .filter(Boolean);
    const personaCandidates = memberCandidates.filter(
      (candidate) => candidate.candidate_lane === 'persona'
    );
    const sourceFactCandidates = memberCandidates.filter(
      (candidate) => candidate.candidate_lane === 'fact'
    );
    const factCandidates = [];
    for (const factCandidate of sourceFactCandidates) {
      const result = eligibility(
        factCandidate,
        decisions.get(factCandidate.candidate_id)
      );
      const binding = {
        record_id: safeText(factCandidate.upstream.workbench_row.record_id),
        candidate_id: factCandidate.candidate_id,
        canonical_payload_sha256: factCandidate.integrity.canonical_payload_sha256
      };
      if (!result.eligible) {
        excludedFactCandidates.push({
          source_candidate_binding: binding,
          family_id: family.family_id,
          exclusion_reason: result.reason
        });
        continue;
      }
      factCandidates.push(factCandidate);
      eligibleFactFacets.push({
        source_candidate_binding: binding,
        family_id: family.family_id,
        authority_decision: {
          source_state: factCandidate.source_evidence.state,
          eligibility_reason: result.reason,
          authority: result.authority,
          canonical_authority_granted: false,
          can_be_answer_evidence: false,
          approval_does_not_create_canonical_authority: true
        },
        facet_material: portableFacetMaterial(factCandidate),
        independent_fact_facet: true,
        mixed_into_persona_candidate_material: false
      });
    }
    if (!personaCandidates.length) {
      if (factCandidates.length) {
        factOnlyFamilies.push({
          family_id: family.family_id,
          family_digest_sha256: family.family_digest_sha256,
          pair_state: 'fact_only',
          fact_member_refs: family.member_refs.filter((member) => (
            factCandidates.some(
              (candidate) => candidate.candidate_id === member.candidate_id
            )
          )),
          warm_candidate_created: false,
          reason: 'fact_only_family'
        });
      }
      continue;
    }
    const included = [];
    for (const personaCandidate of personaCandidates) {
      const decision = decisions.get(personaCandidate.candidate_id);
      const result = eligibility(personaCandidate, decision);
      const binding = {
        record_id: safeText(personaCandidate.upstream.workbench_row.record_id),
        candidate_id: personaCandidate.candidate_id,
        canonical_payload_sha256:
          personaCandidate.integrity.canonical_payload_sha256
      };
      if (!result.eligible) {
        excludedPersonaCandidates.push({
          source_candidate_binding: binding,
          family_id: family.family_id,
          exclusion_reason: result.reason
        });
        continue;
      }
      included.push({
        source_candidate_binding: binding,
        authority_decision: {
          source_state: personaCandidate.source_evidence.state,
          eligibility_reason: result.reason,
          authority: result.authority,
          owner_decision_present: Boolean(decision),
          owner_decision: safeText(decision?.decision),
          reviewer: safeText(decision?.reviewer),
          decided_at: safeText(decision?.decided_at),
          canonical_authority_granted: false,
          can_be_answer_evidence: false,
          approval_does_not_create_canonical_authority: true
        },
        warm_rewrite_candidate: buildPortableWarmRewriteCandidate({
          candidate: personaCandidate,
          eventFamily: family,
          pairedFactCandidates: factCandidates
        })
      });
    }
    if (included.length) {
      eventFamilyIntakes.push({
        family_id: family.family_id,
        family_digest_sha256: family.family_digest_sha256,
        source_pair_state: family.pair_state,
        pair_state: factCandidates.length ? 'paired' : 'persona_only',
        persona_candidates: included,
        paired_sql_facets: factCandidates.map((candidate) => ({
          source_candidate_binding: {
            record_id: safeText(candidate.upstream.workbench_row.record_id),
            candidate_id: candidate.candidate_id,
            canonical_payload_sha256: candidate.integrity.canonical_payload_sha256
          },
          facet_material: portableFacetMaterial(candidate),
          independent_fact_facet: true,
          mixed_into_persona_candidate_material: false
        }))
      });
    }
  }
  const includedPersonaCount = eventFamilyIntakes.reduce(
    (sum, family) => sum + family.persona_candidates.length,
    0
  );
  const personaCandidateCount = bundle.candidates.filter(
    (candidate) => candidate.candidate_lane === 'persona'
  ).length;
  const factCandidateCount = bundle.candidates.filter(
    (candidate) => candidate.candidate_lane === 'fact'
  ).length;
  const includedFactCount = eligibleFactFacets.length;
  const intakePayload = {
    schema: DRIFTSTONE_HOME_WARM_INTAKE_SCHEMA,
    generated_at: safeText(generatedAt),
    review_bundle_id: safeText(bundle.bundle_id),
    review_candidates_sha256: safeText(bundle.candidates_sha256),
    source_candidate_count: bundle.candidates.length,
    source_persona_candidate_count: personaCandidateCount,
    source_fact_candidate_count: factCandidateCount,
    event_family_count: families.length,
    included_persona_candidate_count: includedPersonaCount,
    excluded_persona_candidate_count: excludedPersonaCandidates.length,
    included_fact_candidate_count: includedFactCount,
    excluded_fact_candidate_count: excludedFactCandidates.length,
    conservation: {
      persona_equation_passed:
        personaCandidateCount === includedPersonaCount + excludedPersonaCandidates.length,
      fact_equation_passed:
        factCandidateCount === includedFactCount + excludedFactCandidates.length,
      fact_candidates_preserved_as_independent_facets: includedFactCount,
      event_families_preserved: families.length
    },
    event_family_intakes: eventFamilyIntakes,
    excluded_persona_candidates: excludedPersonaCandidates,
    eligible_fact_facets: eligibleFactFacets,
    excluded_fact_candidates: excludedFactCandidates,
    fact_only_families: factOnlyFamilies,
    title_collision_warnings: Array.isArray(bundle.title_collision_warnings)
      ? bundle.title_collision_warnings
      : buildTitleCollisionWarnings(families),
    safety: {
      private_local_only: true,
      safe_to_commit_generated_output: false,
      calls_home_api: false,
      writes_home: false,
      writes_warm_memory: false,
      reads_home_runtime_persona: false,
      final_warm_body_markdown_generated: false,
      paired_sql_facets_remain_independent: true,
      owner_approval_does_not_create_canonical_authority: true
    }
  };
  if (!intakePayload.conservation.persona_equation_passed) {
    throw new DriftstoneHomeWarmIntakeError(
      'intake_persona_conservation_failed',
      'Every persona candidate must be included or explicitly excluded.'
    );
  }
  if (!intakePayload.conservation.fact_equation_passed) {
    throw new DriftstoneHomeWarmIntakeError(
      'intake_fact_conservation_failed',
      'Every fact candidate must be included or explicitly excluded.'
    );
  }
  return {
    ...intakePayload,
    intake_id: `dshi_${sha256(intakePayload).slice(0, 32)}`,
    intake_payload_sha256: sha256(intakePayload),
    deterministic_projection_sha256: sha256(stableJson({
      review_bundle_id: intakePayload.review_bundle_id,
      event_family_intakes: intakePayload.event_family_intakes,
      excluded_persona_candidates: intakePayload.excluded_persona_candidates,
      eligible_fact_facets: intakePayload.eligible_fact_facets,
      excluded_fact_candidates: intakePayload.excluded_fact_candidates,
      fact_only_families: intakePayload.fact_only_families
    }))
  };
}
