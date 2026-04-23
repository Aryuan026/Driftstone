import { upsertCardRegistryEntry } from './card-registry-service.js';
import { appendGrowthLedgerEntry } from './growth-ledger-service.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function uniqueStrings(items, limit = 24) {
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

function normalizeDecision(value) {
  const text = safeText(value, 'touch').toLowerCase();
  if (['new', 'create'].includes(text)) return 'new';
  if (['update', 'patch', 'revise'].includes(text)) return 'update';
  if (['rewrite', 'rewrite_card'].includes(text)) return 'rewrite';
  if (['merge', 'merge_into'].includes(text)) return 'merge';
  if (['skip', 'hold'].includes(text)) return 'skip';
  if (['delete', 'archive'].includes(text)) return 'delete';
  return text || 'touch';
}

function shouldTouchRegistry(decision, cardEntry = {}) {
  if (decision === 'skip') return false;
  if (decision === 'touch') {
    return Boolean(
      safeText(cardEntry.card_id)
      || safeText(cardEntry.title)
      || safeText(cardEntry.summary_for_growth || cardEntry.summary)
    );
  }
  return true;
}

function buildRegistryEntry(input = {}, decision = 'touch', actor = 'unknown') {
  const entry = {
    ...input,
    card_id: safeText(input.card_id),
    card_type: safeText(input.card_type || input.type, 'memo'),
    family_id: safeText(input.family_id || input.family, 'unassigned'),
    title: safeText(input.title, input.card_id ? '已存在卡片' : '未命名卡片'),
    status: safeText(input.status, decision === 'delete' ? 'archived' : 'draft'),
    phase: safeText(input.phase),
    summary_for_growth: safeText(input.summary_for_growth || input.summary || input.inject_short),
    inject_short: safeText(input.inject_short),
    voice_fingerprint: uniqueStrings(input.voice_fingerprint, 12),
    tags: uniqueStrings(input.tags, 24),
    related_card_ids: uniqueStrings(input.related_card_ids, 24),
    source_packet_id: safeText(input.source_packet_id || input.packet_id),
    source_refs: uniqueStrings(input.source_refs, 24),
    last_action: decision,
    last_actor: safeText(actor, 'unknown')
  };
  if (decision === 'delete' && !entry.status) entry.status = 'archived';
  return entry;
}

function buildLedgerEntry({
  decision = 'touch',
  packetId = '',
  familyId = '',
  cardType = 'memo',
  targetCardId = '',
  reason = '',
  nextHint = '',
  actor = '',
  source = '',
  tags = [],
  relatedCardIds = [],
  payload = {}
} = {}) {
  return {
    packet_id: safeText(packetId),
    family_id: safeText(familyId, 'unassigned'),
    card_type: safeText(cardType, 'memo'),
    decision: normalizeDecision(decision),
    target_card_id: safeText(targetCardId),
    reason: safeText(reason),
    next_hint: safeText(nextHint),
    actor: safeText(actor, 'unknown'),
    source: safeText(source),
    tags: uniqueStrings(tags, 24),
    related_card_ids: uniqueStrings(relatedCardIds, 24),
    payload: payload && typeof payload === 'object' ? payload : {}
  };
}

export async function commitGrowthDecision({
  ownerId = '',
  realmId = '',
  decision = 'touch',
  packetId = '',
  reason = '',
  nextHint = '',
  actor = '',
  source = '',
  cardEntry = {},
  ledgerEntry = {}
} = {}) {
  const normalizedDecision = normalizeDecision(decision);
  const normalizedCardEntry = buildRegistryEntry(cardEntry, normalizedDecision, actor);

  let registryHit = null;
  if (shouldTouchRegistry(normalizedDecision, normalizedCardEntry)) {
    registryHit = await upsertCardRegistryEntry({
      ownerId,
      realmId,
      entry: normalizedCardEntry
    });
  }

  const committedCard = registryHit?.entry || null;
  const ledgerHit = await appendGrowthLedgerEntry({
    ownerId,
    realmId,
    entry: buildLedgerEntry({
      decision: normalizedDecision,
      packetId,
      familyId: safeText(
        committedCard?.family_id
          || normalizedCardEntry.family_id
          || ledgerEntry.family_id
      ),
      cardType: safeText(
        committedCard?.card_type
          || normalizedCardEntry.card_type
          || ledgerEntry.card_type,
        'memo'
      ),
      targetCardId: safeText(
        committedCard?.card_id
          || normalizedCardEntry.card_id
          || ledgerEntry.target_card_id
      ),
      reason,
      nextHint,
      actor,
      source,
      tags: uniqueStrings([
        ...(Array.isArray(normalizedCardEntry.tags) ? normalizedCardEntry.tags : []),
        ...(Array.isArray(ledgerEntry.tags) ? ledgerEntry.tags : [])
      ], 24),
      relatedCardIds: uniqueStrings([
        ...(Array.isArray(normalizedCardEntry.related_card_ids) ? normalizedCardEntry.related_card_ids : []),
        ...(Array.isArray(ledgerEntry.related_card_ids) ? ledgerEntry.related_card_ids : [])
      ], 24),
      payload: {
        card_title: safeText(committedCard?.title || normalizedCardEntry.title),
        summary_for_growth: safeText(committedCard?.summary_for_growth || normalizedCardEntry.summary_for_growth),
        ...((ledgerEntry && typeof ledgerEntry.payload === 'object' && ledgerEntry.payload !== null) ? ledgerEntry.payload : {})
      }
    })
  });

  return {
    ok: true,
    decision: normalizedDecision,
    card: committedCard,
    registry_summary: registryHit?.registry?.summary || null,
    ledger_entry: ledgerHit.entry,
    ledger_summary: ledgerHit.ledger?.summary || null
  };
}
