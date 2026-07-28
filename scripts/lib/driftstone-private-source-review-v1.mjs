import { createHash } from 'node:crypto';
import {
  HUMAN_DECISIONS_SCHEMA,
  PORTABLE_SOURCE_CANDIDATE_SCHEMA,
  sha256,
  stableJson,
  verifyPortableSourceCandidate
} from './driftstone-portable-source-packet-v1.mjs';
import {
  buildEventFamilies,
  buildPortableWarmRewriteCandidate,
  buildTitleCollisionWarnings
} from './driftstone-home-warm-intake-v1.mjs';

export const PRIVATE_SOURCE_REVIEW_SCHEMA = 'driftstone_private_source_review_bundle_v1';
export const PRIVATE_SOURCE_REVIEW_MANIFEST_SCHEMA =
  'driftstone_private_source_review_manifest_v1';

const ALLOWED_DECISIONS = new Set(['approve', 'hold', 'reject']);
const ALLOWED_AUTHORITIES = new Set(['human_attested', 'legacy_import']);

export class PrivateSourceReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PrivateSourceReviewError';
    this.code = code;
    this.details = details;
  }
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').replace(/\r/gu, '').trim();
  return text || fallback;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => safeText(value)).filter(Boolean))];
}

function bytesSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function scriptSha256Base64(value) {
  return createHash('sha256').update(value, 'utf8').digest('base64');
}

function escapeInlineScriptJson(value) {
  return stableJson(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

export function validateReviewCandidate(candidate = {}) {
  if (candidate.schema !== PORTABLE_SOURCE_CANDIDATE_SCHEMA) {
    throw new PrivateSourceReviewError(
      'candidate_schema_invalid',
      `Review candidates must use ${PORTABLE_SOURCE_CANDIDATE_SCHEMA}.`
    );
  }
  if (!verifyPortableSourceCandidate(candidate)) {
    throw new PrivateSourceReviewError(
      'candidate_integrity_invalid',
      'Candidate canonical payload digest is invalid.',
      { candidate_id: safeText(candidate.candidate_id) }
    );
  }
  const candidateId = safeText(candidate.candidate_id);
  const recordId = safeText(candidate.upstream?.workbench_row?.record_id);
  const monthKey = safeText(candidate.month_key);
  if (!candidateId || !recordId || !/^\d{4}-\d{2}$/u.test(monthKey)) {
    throw new PrivateSourceReviewError(
      'candidate_identity_invalid',
      'Candidate review identity requires candidate_id, record_id, and YYYY-MM month_key.',
      { candidate_id: candidateId, record_id: recordId, month_key: monthKey }
    );
  }
  if (!['source_bound', 'source_incomplete'].includes(candidate.source_evidence?.state)) {
    throw new PrivateSourceReviewError(
      'candidate_source_state_invalid',
      'Candidate source evidence must be source_bound or source_incomplete.',
      { candidate_id: candidateId, source_state: candidate.source_evidence?.state }
    );
  }
  return true;
}

export function buildPrivateSourceReviewBundle({
  packetSources = [],
  candidates = [],
  generatedAt = new Date().toISOString()
} = {}) {
  if (!Array.isArray(packetSources) || !packetSources.length) {
    throw new PrivateSourceReviewError(
      'packet_sources_required',
      'At least one source packet descriptor is required.'
    );
  }
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new PrivateSourceReviewError(
      'review_candidates_required',
      'At least one candidate is required.'
    );
  }
  const candidateIds = new Set();
  const recordIdsByMonth = new Set();
  for (const candidate of candidates) {
    validateReviewCandidate(candidate);
    const candidateId = safeText(candidate.candidate_id);
    const recordIdentity = `${candidate.month_key}\u0000${candidate.upstream.workbench_row.record_id}`;
    if (candidateIds.has(candidateId)) {
      throw new PrivateSourceReviewError(
        'candidate_id_duplicate',
        'A private review bundle cannot contain duplicate candidate_id values.',
        { candidate_id: candidateId }
      );
    }
    if (recordIdsByMonth.has(recordIdentity)) {
      throw new PrivateSourceReviewError(
        'record_id_duplicate_in_month',
        'Decision export requires one candidate per record_id within each month.',
        {
          month_key: candidate.month_key,
          record_id: candidate.upstream.workbench_row.record_id
        }
      );
    }
    candidateIds.add(candidateId);
    recordIdsByMonth.add(recordIdentity);
  }
  const months = uniqueStrings(candidates.map((candidate) => candidate.month_key)).sort();
  const packetMonths = uniqueStrings(packetSources.map((source) => source.month_key)).sort();
  if (stableJson(months) !== stableJson(packetMonths)) {
    throw new PrivateSourceReviewError(
      'packet_candidate_month_mismatch',
      'Packet source months must exactly match candidate months.',
      { packet_months: packetMonths, candidate_months: months }
    );
  }
  const countsByMonth = Object.fromEntries(months.map((month) => [
    month,
    candidates.filter((candidate) => candidate.month_key === month).length
  ]));
  const countsByLane = Object.fromEntries(
    uniqueStrings(candidates.map((candidate) => candidate.candidate_lane))
      .sort()
      .map((lane) => [
        lane,
        candidates.filter((candidate) => candidate.candidate_lane === lane).length
      ])
  );
  const countsBySourceState = Object.fromEntries(
    ['source_bound', 'source_incomplete'].map((state) => [
      state,
      candidates.filter((candidate) => candidate.source_evidence.state === state).length
    ])
  );
  const orderedCandidates = candidates.slice().sort((left, right) => (
    left.month_key.localeCompare(right.month_key)
    || left.candidate_lane.localeCompare(right.candidate_lane)
    || left.candidate_id.localeCompare(right.candidate_id)
  ));
  const eventFamilies = buildEventFamilies(orderedCandidates);
  const candidatesById = new Map(
    orderedCandidates.map((candidate) => [candidate.candidate_id, candidate])
  );
  const candidateFamilyIndex = Object.fromEntries(
    eventFamilies.flatMap((family) => family.member_refs.map((member) => [
      member.candidate_id,
      family.family_id
    ]))
  );
  const titleCollisionWarnings = buildTitleCollisionWarnings(eventFamilies);
  const homeWarmCandidateTemplates = eventFamilies.flatMap((family) => {
    const familyCandidates = family.member_refs
      .map((member) => candidatesById.get(member.candidate_id))
      .filter(Boolean);
    const factCandidates = familyCandidates.filter(
      (candidate) => candidate.candidate_lane === 'fact'
    );
    return familyCandidates
      .filter((candidate) => candidate.candidate_lane === 'persona')
      .map((candidate) => ({
        source_candidate_binding: {
          record_id: safeText(candidate.upstream.workbench_row.record_id),
          candidate_id: candidate.candidate_id,
          canonical_payload_sha256: candidate.integrity.canonical_payload_sha256
        },
        family_id: family.family_id,
        template: buildPortableWarmRewriteCandidate({
          candidate,
          eventFamily: family,
          pairedFactCandidates: factCandidates
        })
      }));
  });
  const packetDescriptors = packetSources
    .map((source) => ({
      month_key: safeText(source.month_key),
      generation_id: safeText(source.generation_id),
      packet_sha256: safeText(source.packet_sha256),
      candidates_sha256: safeText(source.candidates_sha256),
      candidate_count: Number(source.candidate_count || 0)
    }))
    .sort((left, right) => left.month_key.localeCompare(right.month_key));
  const bundlePayload = {
    schema: PRIVATE_SOURCE_REVIEW_SCHEMA,
    generated_at: safeText(generatedAt),
    private_local_only: true,
    safe_to_commit_generated_output: false,
    source_packet_count: packetDescriptors.length,
    packet_sources: packetDescriptors,
    candidate_count: orderedCandidates.length,
    candidate_counts_by_month: countsByMonth,
    candidate_counts_by_lane: countsByLane,
    candidate_counts_by_source_state: countsBySourceState,
    decisions_schema: HUMAN_DECISIONS_SCHEMA,
    allowed_decisions: ['approve', 'hold', 'reject'],
    allowed_approval_authorities: ['human_attested', 'legacy_import'],
    writes_home: false,
    writes_hippocove: false,
    writes_notion: false,
    writes_cloud: false,
    event_family_count: eventFamilies.length,
    event_family_counts_by_pair_state: Object.fromEntries(
      ['paired', 'persona_only', 'fact_only'].map((state) => [
        state,
        eventFamilies.filter((family) => family.pair_state === state).length
      ])
    ),
    event_families: eventFamilies,
    candidate_family_index: candidateFamilyIndex,
    title_collision_warnings: titleCollisionWarnings,
    home_warm_candidate_templates: homeWarmCandidateTemplates,
    candidates: orderedCandidates
  };
  return {
    ...bundlePayload,
    bundle_id: `dsreview_${sha256(bundlePayload).slice(0, 32)}`,
    candidates_sha256: sha256(orderedCandidates)
  };
}

export function buildDecisionDocument({
  monthKey,
  reviewer = 'owner',
  candidates = [],
  decisions = []
} = {}) {
  const month = safeText(monthKey);
  if (!/^\d{4}-\d{2}$/u.test(month)) {
    throw new PrivateSourceReviewError(
      'decision_month_invalid',
      'Decision export month must use YYYY-MM form.'
    );
  }
  if (!Array.isArray(decisions)) {
    throw new PrivateSourceReviewError(
      'decisions_array_required',
      'Decision export requires a decisions array.'
    );
  }
  const candidatesById = new Map();
  for (const candidate of candidates) {
    validateReviewCandidate(candidate);
    if (candidate.month_key === month) {
      candidatesById.set(candidate.candidate_id, candidate);
    }
  }
  const seen = new Set();
  const normalized = decisions.map((decision, index) => {
    const candidateId = safeText(decision?.candidate_id);
    const candidate = candidatesById.get(candidateId);
    if (!candidate) {
      throw new PrivateSourceReviewError(
        'decision_candidate_missing',
        'Decision must bind a candidate from the exported month.',
        { decision_index: index, candidate_id: candidateId }
      );
    }
    const recordId = safeText(candidate.upstream.workbench_row.record_id);
    const action = safeText(decision?.decision).toLowerCase();
    const authority = safeText(decision?.authority).toLowerCase();
    if (seen.has(recordId)) {
      throw new PrivateSourceReviewError(
        'decision_record_id_duplicate',
        'A month decision file cannot contain duplicate record_id values.',
        { record_id: recordId }
      );
    }
    seen.add(recordId);
    if (!ALLOWED_DECISIONS.has(action)) {
      throw new PrivateSourceReviewError(
        'decision_action_invalid',
        'Decision must be approve, hold, or reject.',
        { record_id: recordId, decision: action }
      );
    }
    if (action === 'approve' && !ALLOWED_AUTHORITIES.has(authority)) {
      throw new PrivateSourceReviewError(
        'decision_authority_invalid',
        'Approve requires human_attested or legacy_import.',
        { record_id: recordId, authority }
      );
    }
    if (action === 'approve' && candidate.source_evidence.state === 'source_bound') {
      throw new PrivateSourceReviewError(
        'source_bound_approval_invalid',
        'A source-bound candidate cannot be downgraded to human-attested or legacy-import authority.',
        { candidate_id: candidateId, record_id: recordId }
      );
    }
    return {
      record_id: recordId,
      candidate_id: candidateId,
      canonical_payload_sha256: candidate.integrity.canonical_payload_sha256,
      decision: action,
      authority: action === 'approve' ? authority : '',
      reviewer: safeText(decision.reviewer, safeText(reviewer, 'owner')),
      decided_at: safeText(decision.decided_at),
      note: safeText(decision.note)
    };
  });
  return {
    schema: HUMAN_DECISIONS_SCHEMA,
    month_key: month,
    decisions: normalized
  };
}

export function validateDecisionDocumentAgainstBundle(bundle = {}, document = {}) {
  if (bundle.schema !== PRIVATE_SOURCE_REVIEW_SCHEMA || !Array.isArray(bundle.candidates)) {
    throw new PrivateSourceReviewError(
      'review_bundle_schema_invalid',
      `Decision sealing requires ${PRIVATE_SOURCE_REVIEW_SCHEMA}.`
    );
  }
  if (document?.schema !== HUMAN_DECISIONS_SCHEMA) {
    throw new PrivateSourceReviewError(
      'decision_schema_invalid',
      `Decision document must use ${HUMAN_DECISIONS_SCHEMA}.`
    );
  }
  const month = safeText(document.month_key);
  if (!bundle.candidate_counts_by_month?.[month] || !Array.isArray(document.decisions)) {
    throw new PrivateSourceReviewError(
      'decision_month_or_array_invalid',
      'Decision month must belong to the review bundle and decisions must be an array.',
      { month_key: month }
    );
  }
  const candidatesById = new Map(
    bundle.candidates
      .filter((candidate) => candidate.month_key === month)
      .map((candidate) => [candidate.candidate_id, candidate])
  );
  for (const [index, entry] of document.decisions.entries()) {
    const candidate = candidatesById.get(safeText(entry?.candidate_id));
    if (
      !candidate
      || safeText(entry.record_id) !== safeText(candidate.upstream.workbench_row.record_id)
      || safeText(entry.canonical_payload_sha256)
        !== safeText(candidate.integrity.canonical_payload_sha256)
    ) {
      throw new PrivateSourceReviewError(
        'decision_candidate_binding_mismatch',
        'Decision record_id, candidate_id, and canonical payload digest must match the frozen review candidate.',
        { decision_index: index, candidate_id: safeText(entry?.candidate_id) }
      );
    }
  }
  return buildDecisionDocument({
    monthKey: month,
    candidates: bundle.candidates,
    decisions: document.decisions
  });
}

function browserRuntime() {
const bundle = REVIEW_BUNDLE;
const candidateById = new Map(bundle.candidates.map((candidate) => [candidate.candidate_id, candidate]));
const familyById = new Map(
  (Array.isArray(bundle.event_families) ? bundle.event_families : [])
    .map((family) => [family.family_id, family])
);
const familyIdByCandidate = new Map(Object.entries(bundle.candidate_family_index || {}));
const recordByMonth = new Map(bundle.candidates.map((candidate) => [
  candidate.month_key + "\u0000" + candidate.upstream.workbench_row.record_id,
  candidate.candidate_id
]));
const draftKey = "driftstone-private-review:" + bundle.bundle_id;
const state = {
  selectedId: bundle.candidates[0]?.candidate_id || "",
  reviewer: "owner",
  decisions: {},
  month: "all",
  lane: "all",
  sourceState: "all",
  decision: "all",
  query: ""
};
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const array = (value) => Array.isArray(value) ? value : [];
const text = (value, fallback = "") => String(value ?? "").trim() || fallback;
const pretty = (value) => JSON.stringify(value, null, 2);
const bodyFields = [
  ["title", "标题"], ["text", "正文"], ["content_text", "内容"],
  ["summary", "摘要"], ["background", "背景"], ["fact_value", "事实值"],
  ["stable_points", "稳定内容"], ["update_points", "变化内容"],
  ["note", "备注"], ["reflection_note", "感受 / 复盘"],
  ["relation_to_user", "关系位置"], ["expression_fingerprint", "表达指纹"]
];
function displayTitle(candidate) {
  const row = candidate.upstream.workbench_row || {};
  return text(row.title || row.card_name || row.anchor_name || row.fact_key, row.record_id);
}
function decisionLabel(entry) {
  if (!entry?.decision) return "未决定";
  if (entry.decision === "approve") return entry.authority === "human_attested"
    ? "认可 · 人类确认" : "认可 · 历史导入";
  if (entry.decision === "hold") return "暂留";
  return "拒绝";
}
function loadDraft() {
  try {
    const parsed = JSON.parse(localStorage.getItem(draftKey) || "{}");
    state.reviewer = text(parsed.reviewer, "owner");
    for (const [candidateId, entry] of Object.entries(parsed.decisions || {})) {
      const candidate = candidateById.get(candidateId);
      if (!candidate) continue;
      if (!["approve", "hold", "reject", ""].includes(text(entry.decision))) continue;
      if (entry.decision === "approve" && candidate.source_evidence.state === "source_bound") continue;
      state.decisions[candidateId] = {
        decision: text(entry.decision),
        authority: text(entry.authority),
        reviewer: text(entry.reviewer, state.reviewer),
        decided_at: text(entry.decided_at),
        note: text(entry.note)
      };
    }
  } catch {}
}
function saveDraft() {
  try {
    localStorage.setItem(draftKey, JSON.stringify({
      reviewer: state.reviewer,
      decisions: state.decisions
    }));
  } catch {}
}
function candidateSearchText(candidate) {
  return [
    displayTitle(candidate), candidate.month_key, candidate.candidate_lane,
    candidate.source_evidence.state,
    ...array(candidate.canonical_labels.tags),
    ...array(candidate.canonical_labels.fact_keys),
    pretty(candidate.upstream.workbench_row || {}),
    pretty(candidate.upstream.reviewed_rows || [])
  ].join("\n").toLowerCase();
}
function visibleCandidates() {
  const query = state.query.toLowerCase();
  return bundle.candidates.filter((candidate) => {
    const entry = state.decisions[candidate.candidate_id] || {};
    return (state.month === "all" || candidate.month_key === state.month)
      && (state.lane === "all" || candidate.candidate_lane === state.lane)
      && (state.sourceState === "all" || candidate.source_evidence.state === state.sourceState)
      && (state.decision === "all"
        || (state.decision === "undecided" ? !entry.decision : entry.decision === state.decision))
      && (!query || candidateSearchText(candidate).includes(query));
  });
}
function chip(value, tone = "") {
  return '<span class="chip ' + esc(tone) + '">' + esc(value) + "</span>";
}
function renderStats() {
  const decided = Object.values(state.decisions).filter((entry) => entry.decision).length;
  const incomplete = bundle.candidate_counts_by_source_state.source_incomplete || 0;
  $("#stats").innerHTML = [
    chip(bundle.candidate_count + " 条候选"),
    chip(Number(bundle.event_family_count || 0) + " 个事件家族"),
    chip(Number(bundle.event_family_counts_by_pair_state?.paired || 0) + " 个双投影", "ok"),
    chip(decided + " 条已决定", decided ? "ok" : ""),
    chip(incomplete + " 条缺源可人审", incomplete ? "warn" : ""),
    chip(array(bundle.title_collision_warnings).length + " 组跨家族同名提醒",
      array(bundle.title_collision_warnings).length ? "warn" : ""),
    chip("CASE 0"),
    chip("来源 / authority 海关 · 无写入")
  ].join("");
}
function renderFilters() {
  const months = Object.keys(bundle.candidate_counts_by_month);
  const lanes = Object.keys(bundle.candidate_counts_by_lane);
  $("#monthFilter").innerHTML = '<option value="all">全部月份</option>'
    + months.map((month) => '<option value="' + esc(month) + '">' + esc(month) + "</option>").join("");
  $("#laneFilter").innerHTML = '<option value="all">全部类型</option>'
    + lanes.map((lane) => '<option value="' + esc(lane) + '">' + esc(lane) + "</option>").join("");
}
function renderList() {
  const rows = visibleCandidates();
  if (!rows.some((candidate) => candidate.candidate_id === state.selectedId)) {
    state.selectedId = rows[0]?.candidate_id || "";
  }
  $("#visibleCount").textContent = "当前显示 " + rows.length + " / " + bundle.candidate_count;
  const visibleIds = new Set(rows.map((candidate) => candidate.candidate_id));
  const familyIds = [...new Set(rows.map((candidate) => familyIdByCandidate.get(candidate.candidate_id)))]
    .filter(Boolean);
  $("#candidateList").innerHTML = familyIds.map((familyId) => {
    const family = familyById.get(familyId);
    const members = array(family?.member_refs)
      .map((member) => candidateById.get(member.candidate_id))
      .filter((candidate) => candidate && visibleIds.has(candidate.candidate_id));
    return '<section class="family-row"><div class="candidate-kicker">'
      + esc(family?.month_key || "") + " · " + esc(family?.pair_state || "")
      + " · " + esc(family?.identity_basis || "") + "</div>"
      + members.map((candidate) => {
        const entry = state.decisions[candidate.candidate_id] || {};
        const active = candidate.candidate_id === state.selectedId ? " active" : "";
        const sourceTone = candidate.source_evidence.state === "source_bound" ? "ok" : "warn";
        return '<button class="candidate-row' + active + '" data-candidate-id="'
          + esc(candidate.candidate_id) + '">'
          + '<span class="candidate-kicker">' + esc(candidate.candidate_lane) + "</span>"
          + '<strong>' + esc(displayTitle(candidate)) + "</strong>"
          + '<span class="candidate-meta">' + chip(candidate.source_evidence.state, sourceTone)
          + chip(decisionLabel(entry), entry.decision ? "decision" : "") + "</span></button>";
      }).join("") + "</section>";
  }).join("") || '<div class="empty">没有符合当前筛选的候选。</div>';
  document.querySelectorAll("[data-candidate-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.candidateId;
      renderList();
      renderDetail();
    });
  });
}
function bodySections(row) {
  return bodyFields.map(([field, label]) => {
    const value = row?.[field];
    const rendered = Array.isArray(value) ? value.join("\n") : text(value);
    return rendered ? '<div class="body-field"><span>' + esc(label)
      + '</span><div class="body-copy">' + esc(rendered) + "</div></div>" : "";
  }).filter(Boolean).join("");
}
function rangeRows(label, ranges, tone = "") {
  return '<div class="range-row"><span>' + esc(label) + "</span><div>"
    + (array(ranges).length ? array(ranges).map((range) => chip(range, tone)).join("") : chip("无", "muted"))
    + "</div></div>";
}
function renderDetail() {
  const candidate = candidateById.get(state.selectedId);
  if (!candidate) {
    $("#detail").innerHTML = '<div class="empty">从左边选择一条候选。</div>';
    return;
  }
  const row = candidate.upstream.workbench_row || {};
  const evidence = candidate.source_evidence || {};
  const graph = candidate.graph_hints || {};
  const span = graph.span || {};
  const entry = state.decisions[candidate.candidate_id] || {};
  const reviewed = array(candidate.upstream.reviewed_rows);
  const prepared = array(candidate.upstream.prepared_windows);
  const family = familyById.get(familyIdByCandidate.get(candidate.candidate_id));
  const siblingCandidates = array(family?.member_refs)
    .map((member) => candidateById.get(member.candidate_id))
    .filter((member) => member && member.candidate_id !== candidate.candidate_id);
  const familyWarnings = array(bundle.title_collision_warnings).filter((warning) => (
    array(warning.family_members).some((item) => item.family_id === family?.family_id)
  ));
  const sourceTone = evidence.state === "source_bound" ? "ok" : "warn";
  $("#detail").innerHTML = `
    <header class="detail-head">
      <div><div class="eyebrow">${esc(candidate.month_key)} · ${esc(candidate.candidate_lane)}</div>
      <h2>${esc(displayTitle(candidate))}</h2></div>
      <div>${chip(evidence.state, sourceTone)} ${chip(decisionLabel(entry), entry.decision ? "decision" : "")}</div>
    </header>
    <section class="panel">
      <h3>同一事件的平行投影</h3>
      <div class="boundary">${chip(family?.pair_state || "unknown")}
        ${chip(family?.identity_basis || "unknown")}
        ${chip(family?.identity_confidence || "unknown")}</div>
      <p class="explain">persona 与 SQL/fact 是同一事件的 sibling facets；这里并排查看，但不会把事实字段混进人格正文。</p>
      ${siblingCandidates.map((sibling) => `<button class="candidate-row" data-candidate-id="${esc(sibling.candidate_id)}">
        <span class="candidate-kicker">${esc(sibling.candidate_lane)}</span>
        <strong>${esc(displayTitle(sibling))}</strong>
        <span class="candidate-meta">${chip(sibling.source_evidence.state,
          sibling.source_evidence.state === "source_bound" ? "ok" : "warn")}</span>
      </button>`).join("") || '<div class="empty">这是 persona-only / fact-only 家族，没有 sibling facet。</div>'}
      ${familyWarnings.length
        ? '<div class="warning">同名内容也出现在其他 event family；仅提示碰撞，禁止自动合并。</div>'
        : ""}
      <details><summary>event family 结构</summary><pre>${esc(pretty(family || {}))}</pre></details>
    </section>
    <section class="panel">
      <h3>候选正文</h3>
      ${bodySections(row) || '<div class="empty">工作台行没有可见正文；展开结构化原行复核。</div>'}
      ${reviewed.map((review, index) => `<details><summary>reviewed 文本 ${index + 1}</summary>${bodySections(review)
        || '<pre>' + esc(pretty(review)) + "</pre>"}</details>`).join("")}
    </section>
    <section class="panel">
      <h3>完整标签</h3>
      <div class="label-block"><span>tags · ${array(candidate.canonical_labels.tags).length}</span>
        <div>${array(candidate.canonical_labels.tags).map((value) => chip(value)).join("") || chip("无", "muted")}</div></div>
      <div class="label-block"><span>fact keys · ${array(candidate.canonical_labels.fact_keys).length}</span>
        <div>${array(candidate.canonical_labels.fact_keys).map((value) => chip(value)).join("") || chip("无", "muted")}</div></div>
    </section>
    <section class="panel evidence-grid">
      <div>
        <h3>Exact evidence · 候选自身</h3>
        <p class="explain">只绑定 workbench 的候选窄跨度；prepared 的上下文不会混进这里。</p>
        ${rangeRows("candidate range", span.candidate_window_local_msg_ranges, "ok")}
        ${rangeRows("reviewed range", span.reviewed_window_local_msg_ranges)}
        <div class="range-row"><span>raw messages</span><strong>${Number(evidence.raw_message_count || 0)}</strong></div>
        <div class="range-row"><span>raw refs</span><div class="mono wrap">${array(evidence.raw_message_refs).map(esc).join("<br>") || "无"}</div></div>
        <div class="range-row"><span>span hash</span><div class="mono wrap">${esc(evidence.source_span_sha256 || "无")}</div></div>
      </div>
      <div>
        <h3>Prepared context · 仅上下文</h3>
        <p class="explain">帮助理解候选所在窗口，但不获得 exact evidence 权限。</p>
        ${rangeRows("prepared range", span.prepared_context_window_local_msg_ranges, "context")}
        ${prepared.map((item) => `<div class="context-card">
          <strong>${esc(item.name || item.chunk_id)}</strong>
          <span>${esc(item.source_window_title || item.source_window_id)}</span>
          <span>${Number(item.text_chars || 0)} chars · ${esc(item.text_sha256 || "")}</span>
        </div>`).join("") || '<div class="empty">没有 prepared context。</div>'}
      </div>
    </section>
    <section class="panel">
      <h3>Source / evidence 可见范围</h3>
      ${array(evidence.incomplete_reasons).length
        ? '<div class="warning"><strong>缺源原因</strong><br>' + array(evidence.incomplete_reasons).map(esc).join("<br>") + "</div>"
        : '<div class="success">各层显式范围当前相容；可进入 Home intake，但仍不是 canonical memory。</div>'}
      ${rangeRows("anchor source-ref", span.anchor_source_ref_msg_ranges)}
      ${rangeRows("anchor chunk", span.anchor_window_local_chunk_ranges)}
      ${rangeRows("source bundles", span.source_bundle_ids)}
      ${rangeRows("source windows", span.source_window_ids)}
      <details><summary>source index anchors</summary><pre>${esc(pretty(candidate.upstream.source_index_anchors || []))}</pre></details>
    </section>
    <section class="panel">
      <h3>Graph hints · 冷树 sibling 输入</h3>
      <div class="boundary">${chip("candidate_only")} ${chip("pre-admission")}
        ${chip("edges " + Number(graph.canonical_edges_created || 0))}
        ${chip("episodes " + Number(graph.canonical_episodes_created || 0))}
        ${chip("receipts " + Number(graph.canonical_receipts_created || 0))}</div>
      <details open><summary>结构化 hints</summary><pre>${esc(pretty(graph.structured_candidates || {}))}</pre></details>
      <details><summary>完整 graph hint</summary><pre>${esc(pretty(graph))}</pre></details>
    </section>
    <section class="panel decision-panel">
      <h3>人类决定</h3>
      <div class="decision-buttons">
        ${evidence.state === "source_incomplete" ? `
        <button data-action="approve" data-authority="human_attested">认可 · human_attested</button>
        <button data-action="approve" data-authority="legacy_import">认可 · legacy_import</button>` : `
        <span class="success">已有 source evidence，无需人证降权。</span>`}
        <button data-action="hold">暂留</button>
        <button data-action="reject">拒绝</button>
        <button data-action="clear" class="quiet">清空</button>
      </div>
      <label>备注<textarea id="decisionNote" rows="5" placeholder="保留你判断时需要带到下一层的信息。">${esc(entry.note || "")}</textarea></label>
      <p class="explain">source_incomplete 的认可只允许进入 sealed Home intake；不会生成 canonical authority、answer evidence、最终温卡正文或记忆写入。</p>
    </section>
    <details class="panel"><summary>完整候选 JSON</summary><pre>${esc(pretty(candidate))}</pre></details>
  `;
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => setDecision(
      candidate,
      button.dataset.action,
      button.dataset.authority || ""
    ));
  });
  document.querySelectorAll("#detail [data-candidate-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.candidateId;
      renderList();
      renderDetail();
    });
  });
  $("#decisionNote").addEventListener("input", (event) => {
    const current = state.decisions[candidate.candidate_id] || {
      decision: "", authority: "", reviewer: state.reviewer, decided_at: ""
    };
    state.decisions[candidate.candidate_id] = { ...current, note: event.target.value };
    saveDraft();
  });
}
function setDecision(candidate, action, authority = "") {
  const existing = state.decisions[candidate.candidate_id] || {};
  if (action === "approve" && candidate.source_evidence.state === "source_bound") {
    $("#notice").textContent = "source_bound 已有证据，不能降权为 human approval authority。";
    return;
  }
  if (action === "clear") {
    delete state.decisions[candidate.candidate_id];
  } else {
    state.decisions[candidate.candidate_id] = {
      decision: action,
      authority: action === "approve" ? authority : "",
      reviewer: state.reviewer,
      decided_at: new Date().toISOString(),
      note: text($("#decisionNote")?.value, existing.note || "")
    };
  }
  saveDraft();
  renderStats();
  renderList();
  renderDetail();
}
function decisionDocument(month) {
  const decisions = bundle.candidates
    .filter((candidate) => candidate.month_key === month)
    .map((candidate) => {
      const entry = state.decisions[candidate.candidate_id];
      if (!entry?.decision) return null;
      if (entry.decision === "approve" && candidate.source_evidence.state === "source_bound") {
        throw new Error("source_bound 已有证据，不能降权为 human_attested / legacy_import。");
      }
      return {
        record_id: candidate.upstream.workbench_row.record_id,
        candidate_id: candidate.candidate_id,
        canonical_payload_sha256: candidate.integrity.canonical_payload_sha256,
        decision: entry.decision,
        authority: entry.decision === "approve" ? entry.authority : "",
        reviewer: text(entry.reviewer, state.reviewer),
        decided_at: text(entry.decided_at),
        note: text(entry.note)
      };
    })
    .filter(Boolean);
  return {
    schema: bundle.decisions_schema,
    month_key: month,
    decisions
  };
}
function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportMonth(month) {
  try {
    downloadJson("driftstone-portable-source-decisions-" + month + ".json", decisionDocument(month));
    $("#notice").textContent = "";
  } catch (error) {
    $("#notice").textContent = "导出失败：" + error.message;
  }
}
async function importDecisionFiles(files) {
  for (const file of files) {
    const doc = JSON.parse(await file.text());
    if (doc.schema !== bundle.decisions_schema || !bundle.candidate_counts_by_month[doc.month_key]) {
      throw new Error("决定文件 schema 或月份不属于当前 36 条审查包。");
    }
    for (const entry of array(doc.decisions)) {
      if (!["approve", "hold", "reject"].includes(entry.decision)) {
        throw new Error("决定文件包含不支持的 decision。");
      }
      if (entry.decision === "approve"
        && !["human_attested", "legacy_import"].includes(entry.authority)) {
        throw new Error("approve 必须带 human_attested 或 legacy_import。");
      }
      const candidateId = recordByMonth.get(doc.month_key + "\u0000" + entry.record_id);
      if (!candidateId) throw new Error("决定文件包含当前审查包之外的 record_id。");
      const candidate = candidateById.get(candidateId);
      if (entry.candidate_id !== candidateId
        || entry.canonical_payload_sha256 !== candidate.integrity.canonical_payload_sha256) {
        throw new Error("决定文件与当前冻结候选的 ID / digest 不一致。");
      }
      if (entry.decision === "approve" && candidate.source_evidence.state === "source_bound") {
        throw new Error("source_bound 已有证据，不能套用 human approval authority。");
      }
      state.decisions[candidateId] = {
        decision: entry.decision,
        authority: entry.decision === "approve" ? entry.authority : "",
        reviewer: text(entry.reviewer, state.reviewer),
        decided_at: text(entry.decided_at),
        note: text(entry.note)
      };
    }
  }
  saveDraft();
  renderStats();
  renderList();
  renderDetail();
}
function bind() {
  $("#reviewer").value = state.reviewer;
  $("#reviewer").addEventListener("input", (event) => {
    state.reviewer = text(event.target.value, "owner");
    saveDraft();
  });
  for (const [selector, key] of [
    ["#monthFilter", "month"], ["#laneFilter", "lane"],
    ["#sourceFilter", "sourceState"], ["#decisionFilter", "decision"]
  ]) {
    $(selector).addEventListener("change", (event) => {
      state[key] = event.target.value;
      renderList();
      renderDetail();
    });
  }
  $("#search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderList();
    renderDetail();
  });
  $("#exportMonth").addEventListener("click", () => {
    const month = state.month === "all" ? bundle.candidates[0].month_key : state.month;
    exportMonth(month);
  });
  $("#exportAll").addEventListener("click", () => {
    Object.keys(bundle.candidate_counts_by_month).forEach((month, index) => {
      setTimeout(() => exportMonth(month), index * 250);
    });
  });
  $("#importDecisions").addEventListener("change", (event) => {
    importDecisionFiles(array(event.target.files)).catch((error) => {
      $("#notice").textContent = "导入失败：" + error.message;
    });
  });
  $("#clearDraft").addEventListener("click", () => {
    if (!confirm("清空当前审查包在这个浏览器里的全部决定与备注？")) return;
    state.decisions = {};
    try { localStorage.removeItem(draftKey); } catch {}
    renderStats(); renderList(); renderDetail();
  });
}
loadDraft();
renderFilters();
bind();
renderStats();
renderList();
renderDetail();
}

function reviewStyles() {
  return String.raw`
:root {
  color-scheme: light;
  --bg: #f4f0e8; --paper: #fffdf8; --ink: #292620; --muted: #756f65;
  --line: #dcd3c5; --accent: #6f6657; --green: #e4f0e5; --green-ink: #385a40;
  --warn: #fff0cf; --warn-ink: #76571d; --blue: #e5edf5; --shadow: 0 16px 40px #493e2b14;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.62 system-ui, -apple-system, "PingFang SC", sans-serif; }
button, input, select, textarea { font: inherit; color: inherit; }
button, select, input, textarea { border: 1px solid var(--line); border-radius: 10px; background: var(--paper); }
button { cursor: pointer; padding: 8px 12px; }
button:hover { border-color: var(--accent); }
.topbar { position: sticky; top: 0; z-index: 5; padding: 16px 22px; background: #f4f0e8ed; backdrop-filter: blur(16px); border-bottom: 1px solid var(--line); }
.titleline { display: flex; align-items: end; justify-content: space-between; gap: 18px; }
h1, h2, h3 { margin: 0; font-family: ui-serif, "Songti SC", serif; font-weight: 650; }
h1 { font-size: 24px; } h2 { font-size: 25px; line-height: 1.3; } h3 { font-size: 17px; margin-bottom: 12px; }
.subtitle, .explain, .eyebrow, .candidate-kicker, .candidate-meta, .context-card span { color: var(--muted); font-size: 13px; }
.stats, .boundary { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.toolbar { display: grid; grid-template-columns: 1.2fr repeat(4, minmax(120px, .7fr)); gap: 9px; margin-top: 13px; }
.toolbar input, .toolbar select { width: 100%; padding: 9px 10px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
.actions label { display: flex; align-items: center; gap: 8px; }
.actions input { padding: 7px 9px; width: 120px; }
.file-label { padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); cursor: pointer; }
.file-label input { display: none; }
.layout { display: grid; grid-template-columns: minmax(250px, 340px) minmax(0, 1fr); min-height: calc(100vh - 185px); }
.sidebar { border-right: 1px solid var(--line); padding: 16px; }
#visibleCount { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
.family-row { border: 1px solid var(--line); border-radius: 14px; padding: 9px; margin-bottom: 10px; background: #faf7f0; }
.family-row > .candidate-kicker { display: block; padding: 2px 4px 8px; }
.candidate-row { display: flex; text-align: left; width: 100%; flex-direction: column; gap: 4px; padding: 13px; margin-bottom: 8px; box-shadow: none; }
.candidate-row.active { border-color: #8b7758; box-shadow: inset 3px 0 #8b7758; }
.candidate-row strong { line-height: 1.35; }
.candidate-meta { display: flex; flex-wrap: wrap; gap: 4px; }
.detail { padding: 22px; max-width: 1120px; width: 100%; margin: 0 auto; }
.detail-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 16px; }
.panel { background: var(--paper); border: 1px solid var(--line); border-radius: 16px; padding: 17px; margin-bottom: 14px; box-shadow: var(--shadow); }
.body-field { display: grid; grid-template-columns: 110px 1fr; gap: 12px; padding: 10px 0; border-top: 1px solid #eee8df; }
.body-field:first-of-type { border-top: 0; }
.body-field > span, .label-block > span, .range-row > span { color: var(--muted); font-size: 12px; }
.body-copy { white-space: pre-wrap; }
.label-block { margin: 10px 0; }
.label-block > div { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.chip { display: inline-block; border-radius: 999px; padding: 2px 8px; background: #ede7dc; font-size: 12px; margin: 2px; }
.chip.ok, .success { background: var(--green); color: var(--green-ink); }
.chip.warn, .warning { background: var(--warn); color: var(--warn-ink); }
.chip.context { background: var(--blue); }
.chip.decision { background: #eadff3; }
.chip.muted { color: var(--muted); }
.evidence-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
.range-row { display: grid; grid-template-columns: 125px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid #eee8df; }
.context-card { display: grid; gap: 2px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; margin-top: 8px; }
.warning, .success { padding: 11px; border-radius: 10px; margin-bottom: 10px; }
.decision-buttons { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 12px; }
.decision-buttons button { background: #f0e8dc; }
.decision-buttons .quiet { background: transparent; }
label { color: var(--muted); font-size: 13px; }
textarea { display: block; width: 100%; padding: 10px; margin-top: 5px; resize: vertical; }
details { margin-top: 10px; }
summary { cursor: pointer; color: #5e5549; }
pre, .mono { font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { overflow: auto; white-space: pre-wrap; border-radius: 10px; background: #f4f0e8; padding: 12px; max-height: 460px; }
.wrap { overflow-wrap: anywhere; }
.empty { color: var(--muted); padding: 14px; }
#notice { color: var(--warn-ink); }
@media (max-width: 860px) {
  .toolbar { grid-template-columns: 1fr 1fr; }
  .layout { grid-template-columns: 1fr; }
  .sidebar { border-right: 0; border-bottom: 1px solid var(--line); max-height: 38vh; overflow: auto; }
  .evidence-grid { grid-template-columns: 1fr; }
  .body-field, .range-row { grid-template-columns: 1fr; gap: 3px; }
}
`;
}

export function renderPrivateSourceReviewHtml(bundle = {}) {
  if (bundle.schema !== PRIVATE_SOURCE_REVIEW_SCHEMA || !Array.isArray(bundle.candidates)) {
    throw new PrivateSourceReviewError(
      'review_bundle_schema_invalid',
      `Renderer requires ${PRIVATE_SOURCE_REVIEW_SCHEMA}.`
    );
  }
  const runtime = `const REVIEW_BUNDLE = ${escapeInlineScriptJson(bundle)};\n(${browserRuntime.toString()})();`;
  const runtimeCspHash = scriptSha256Base64(runtime);
  const title = `Driftstone 私密人审 · ${bundle.candidate_count} 条`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${runtimeCspHash}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${title}</title>
  <style>${reviewStyles()}</style>
</head>
<body>
  <header class="topbar">
    <div class="titleline">
      <div><h1>Driftstone 私密来源海关</h1><div class="subtitle">${bundle.candidate_count} 条历史候选 · persona / SQL 平行投影 · sealed 后才生成 Home intake</div></div>
      <div id="stats" class="stats"></div>
    </div>
    <div class="toolbar">
      <input id="search" type="search" placeholder="搜索正文、标题、标签或 fact key">
      <select id="monthFilter"></select>
      <select id="laneFilter"></select>
      <select id="sourceFilter">
        <option value="all">全部 source 状态</option>
        <option value="source_bound">source_bound</option>
        <option value="source_incomplete">source_incomplete</option>
      </select>
      <select id="decisionFilter">
        <option value="all">全部决定</option>
        <option value="undecided">未决定</option>
        <option value="approve">已认可</option>
        <option value="hold">暂留</option>
        <option value="reject">拒绝</option>
      </select>
    </div>
    <div class="actions">
      <label>reviewer <input id="reviewer" value="owner"></label>
      <button id="exportMonth">下载当前月临时决定</button>
      <button id="exportAll">下载三个月临时决定</button>
      <label class="file-label">导入决定文件<input id="importDecisions" type="file" accept="application/json,.json" multiple></label>
      <button id="clearDraft">清空浏览器草稿</button>
      <span id="notice"></span>
    </div>
    <div class="subtitle">浏览器下载通常是 0644 未密封临时文件；用 seal CLI 校验三重绑定并落成仓外 0600 文件后，才可作为耐久决定输入。</div>
  </header>
  <main class="layout">
    <aside class="sidebar"><div id="visibleCount"></div><div id="candidateList"></div></aside>
    <article id="detail" class="detail"></article>
  </main>
  <script>${runtime}</script>
</body>
</html>
`;
}

export function buildPrivateReviewManifest({
  bundle,
  html,
  bundleJson,
  sourceFiles = []
} = {}) {
  const outputDescriptor = {
    'index.html': {
      byte_count: Buffer.byteLength(html, 'utf8'),
      sha256: bytesSha256(Buffer.from(html, 'utf8')),
      mode: '0600'
    },
    'private_source_review_bundle_v1.json': {
      byte_count: Buffer.byteLength(bundleJson, 'utf8'),
      sha256: bytesSha256(Buffer.from(bundleJson, 'utf8')),
      mode: '0600'
    }
  };
  const payload = {
    schema: PRIVATE_SOURCE_REVIEW_MANIFEST_SCHEMA,
    bundle_id: bundle.bundle_id,
    review_schema: bundle.schema,
    candidate_count: bundle.candidate_count,
    candidate_counts_by_month: bundle.candidate_counts_by_month,
    candidates_sha256: bundle.candidates_sha256,
    source_files: sourceFiles,
    output_files: outputDescriptor,
    expected_output_file_set: [
      'index.html',
      'private_source_review_bundle_v1.json',
      'private_source_review_manifest_v1.json'
    ],
    output_directory_mode: '0700',
    output_file_mode: '0600',
    contains_private_memory_material: true,
    safe_to_commit_generated_output: false,
    writes_home: false,
    writes_hippocove: false,
    writes_notion: false,
    writes_cloud: false
  };
  return {
    ...payload,
    manifest_sha256: sha256(payload)
  };
}
