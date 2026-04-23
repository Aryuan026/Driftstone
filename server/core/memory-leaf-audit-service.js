import { getMemoryContextPacket } from './memory-context-service.js';
import { getMemoryRootPacket } from './memory-read-service.js';
import { getMemoryLeafPacket } from './memory-leaf-service.js';
import { loadAllRootCards } from './root-store.js';
import { buildMemoryScope } from './scope-contract.js';
import { buildLeafRepairDraft } from './leaf-repair-helpers.js';

function safeText(value) {
  return String(value || '').trim();
}

function normalizeText(value) {
  return safeText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function compactText(value) {
  return normalizeText(value).replace(/[\s\p{P}\p{S}]+/gu, '');
}

function uniqueStrings(items, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function scoreNeedles(corpus = '', needles = []) {
  const hay = compactText(corpus);
  if (!hay) return { score: 0, hits: [] };
  const hits = [];
  let weight = 0;
  let maxWeight = 0;
  for (const needle of needles) {
    const token = compactText(needle);
    if (!token) continue;
    const tokenWeight = token.length >= 3 ? 2 : 1;
    maxWeight += tokenWeight;
    if (hay.includes(token)) {
      hits.push(needle);
      weight += tokenWeight;
    }
  }
  if (!maxWeight) return { score: 0, hits: [] };
  return {
    score: Number((weight / maxWeight).toFixed(4)),
    hits
  };
}

function countSubstrings(text = '', needles = []) {
  let hay = safeText(text);
  if (!hay) return 0;
  hay = hay
    .replace(/其他/g, '')
    .replace(/其它/g, '');
  let count = 0;
  for (const needle of needles) {
    const token = safeText(needle);
    if (!token) continue;
    const matches = hay.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'));
    count += matches ? matches.length : 0;
  }
  return count;
}

function detectPerspectiveDrift(leaf = {}, personaQuery = '') {
  const corpus = [
    leaf?.display_name,
    leaf?.persona_summary,
    ...(Array.isArray(leaf?.style_notes) ? leaf.style_notes : []),
    ...(Array.isArray(leaf?.memory_notes) ? leaf.memory_notes : [])
  ].map((item) => safeText(item)).filter(Boolean).join('\n');

  const firstPerson = countSubstrings(corpus, ['我', '本霁', '本鸢']);
  const secondPerson = countSubstrings(corpus, ['你', '您']);
  const thirdPerson = countSubstrings(corpus, ['她', '他', '它']);
  const selfName = countSubstrings(corpus, [personaQuery]);
  const activeBuckets = [firstPerson, secondPerson, thirdPerson].filter((count) => count > 0).length;
  const risk = activeBuckets >= 3 ? 'high' : activeBuckets === 2 ? 'medium' : 'low';

  return {
    first_person_hits: firstPerson,
    second_person_hits: secondPerson,
    third_person_hits: thirdPerson,
    self_name_hits: selfName,
    perspective_risk: risk,
    drift_flags: uniqueStrings([
      activeBuckets >= 2 ? 'mixed_pronouns' : '',
      thirdPerson > 0 ? 'third_person_present' : '',
      secondPerson > 0 ? 'dialogue_perspective_present' : '',
      selfName === 0 && safeText(personaQuery) ? 'self_name_missing' : ''
    ].filter(Boolean), 8)
  };
}

function buildRootCorpus(card = {}) {
  const recentUpdates = Array.isArray(card?.recent_updates) ? card.recent_updates : [];
  return [
    card?.root_key,
    card?.canonical_name,
    card?.anchor_type,
    card?.trunk,
    card?.slot_path,
    ...(Array.isArray(card?.stable_facts) ? card.stable_facts : []),
    ...recentUpdates.flatMap((item) => [
      ...(Array.isArray(item?.summaries) ? item.summaries : []),
      ...(Array.isArray(item?.stable_facts) ? item.stable_facts : [])
    ])
  ].map((item) => safeText(item)).filter(Boolean).join(' ');
}

function summarizeRootHit(hit = {}) {
  return {
    root_key: safeText(hit?.root_key),
    canonical_name: safeText(hit?.canonical_name),
    anchor_type: safeText(hit?.anchor_type),
    score: Number(hit?.score || 0),
    hits: uniqueStrings(hit?.hits, 8),
    stable_facts: uniqueStrings(hit?.stable_facts, 4)
  };
}

async function findEvidenceRoots(needles = [], options = {}) {
  const rows = await loadAllRootCards(options);
  const hits = [];
  const personaQuery = safeText(options.query || '');
  for (const row of rows) {
    const card = row?.card || {};
    const scored = scoreNeedles(buildRootCorpus(card), needles);
    if (scored.score <= 0) continue;
    const canonical = safeText(card.canonical_name);
    let boosted = scored.score;
    if (personaQuery) {
      if (canonical === personaQuery) boosted += 1;
      else if (canonical.includes(personaQuery)) boosted += 0.6;
      if (safeText(card.root_key).includes(personaQuery)) boosted += 0.4;
    }
    if (card.anchor_type === 'thing' || card.anchor_type === 'person') boosted += 0.2;
    if (card.anchor_type === 'event') boosted -= 0.15;
    hits.push({
      root_key: safeText(card.root_key),
      canonical_name: safeText(card.canonical_name),
      anchor_type: safeText(card.anchor_type),
      score: Number(boosted.toFixed(4)),
      hits: scored.hits,
      stable_facts: uniqueStrings(card.stable_facts, 4)
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 6);
}

export async function auditMemoryLeaf({
  ownerId = '',
  realmId = '',
  botId = '',
  mode = 'bot',
  query = ''
} = {}) {
  const scope = buildMemoryScope({ ownerId, realmId, botId, mode });
  const leafPacket = await getMemoryLeafPacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    botId: scope.bot_id,
    mode
  });
  const leaf = leafPacket?.leaf || {};
  const personaQuery = safeText(query || leaf.display_name || scope.bot_id);
  const needles = uniqueStrings([
    personaQuery,
    leaf.display_name,
    scope.bot_id
  ].filter(Boolean), 8);

  const evidenceRoots = await findEvidenceRoots(needles, {
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    query: personaQuery
  });

  let topContext = null;
  let topRootPacket = null;
  if (evidenceRoots[0]?.root_key) {
    topRootPacket = await getMemoryRootPacket(evidenceRoots[0].root_key, {
      ownerId: scope.owner_id,
      realmId: scope.realm_id
    });
    topContext = await getMemoryContextPacket({
      key: evidenceRoots[0].root_key,
      ownerId: scope.owner_id,
      realmId: scope.realm_id,
      botId: scope.bot_id,
      mode
    });
  }

  const drift = detectPerspectiveDrift(leaf, personaQuery);
  const shadowSnippets = Array.isArray(topContext?.context?.shadow_snippets)
    ? topContext.context.shadow_snippets.slice(0, 4)
    : [];
  const familyRefs = Array.isArray(topRootPacket?.packet?.root?.family_refs)
    ? topRootPacket.packet.root.family_refs
    : [];
  const linkedPersonaRows = Array.isArray(topRootPacket?.packet?.leaf_hints?.linked_persona_refs)
    ? topRootPacket.packet.leaf_hints.linked_persona_refs
    : [];
  const familyPathUsed = familyRefs.length > 0 && linkedPersonaRows.length > 0;
  const repairReadiness = !leafPacket?.found
    ? 'no_leaf'
    : evidenceRoots.length === 0 && shadowSnippets.length === 0
      ? 'blind_leaf'
      : 'evidence_ready';
  const repairDraft = buildLeafRepairDraft({
    query: personaQuery,
    currentLeaf: leaf,
    evidenceRoots,
    evidenceShadow: {
      source: safeText(topContext?.context?.shadow_source),
      snippets: shadowSnippets
    },
    drift
  });

  return {
    ok: true,
    schema: 'memory_leaf_audit_packet_v0.1',
    scope,
    query: personaQuery,
    repair_readiness: repairReadiness,
    self_repair_supported: Boolean(repairDraft),
    leaf_found: !!leafPacket?.found,
    drift,
    current_leaf: {
      display_name: safeText(leaf.display_name),
      persona_summary: safeText(leaf.persona_summary),
      style_notes: uniqueStrings(leaf.style_notes, 6),
      memory_notes: uniqueStrings(leaf.memory_notes, 6),
      prompt_fragments: uniqueStrings(leaf.prompt_fragments, 8)
    },
    evidence_roots: evidenceRoots.map(summarizeRootHit),
    evidence_shadow: {
      source: safeText(topContext?.context?.shadow_source),
      snippets: shadowSnippets
    },
    family_path_used: familyPathUsed,
    linked_persona_family_refs: familyRefs,
    linked_persona_rows: linkedPersonaRows,
    repair_draft: repairDraft,
    repair_hint: repairReadiness === 'evidence_ready'
      ? (repairDraft
        ? '现在已经能根据根、藤、影生成一份纠叶草稿，下一步是让它稳定改回叶里。'
        : '现在已经能把根、藤、影证据收成一包给 bot 看，但还没有真正自动改写叶。')
      : '现在还没有足够的根藤影证据来支撑叶层修正。'
  };
}
