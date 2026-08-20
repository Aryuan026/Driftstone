import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { isAbsolute, join, resolve } from 'path';
import {
  BUNDLE_SCHEMA,
  buildPortableWarmLedgerId,
  normalizePortableWarmBundleForRead,
  validatePortableWarmBundle
} from './portable-warm-bundle-contract.js';
import { buildGrowthLogicalCandidateId, getGrowthDraftArtifact, listGrowthDraftArtifacts } from './growth-draft-store.js';
import { PROJECT_ROOT, safeScopeSegment } from './path-config.js';
import { loadLatestRuntimeReviewedPacket } from './runtime-reviewed-store.js';

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

function uniqueStrings(values = [], limit = 128) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function textLength(value = '') {
  return String(value || '').length;
}

function digestObject(value) {
  return sha256(stableJson(value));
}

function isPrivatePathLike(text = '') {
  return Boolean(
    isAbsolute(text)
    || /^[A-Za-z]:[\\/]/u.test(text)
    || /^\\\\[^\\]+\\[^\\]+/u.test(text)
    || text.includes('/Users/')
    || text.includes('/home/')
    || text.includes('/srv/')
    || text.includes('\\')
    || text.includes('/')
  );
}

function sanitizeSourceFileLabel(value = '') {
  const text = safeText(value);
  if (!text) return '';
  if (!isPrivatePathLike(text)) return text;
  const normalized = text.replace(/[\\/]+$/u, '');
  const parts = normalized.split(/[\\/]+/u).filter(Boolean);
  return parts[parts.length - 1] || 'local_source';
}

function pickFirstText(values = [], fallback = '') {
  for (const value of values) {
    const text = safeText(value);
    if (text) return text;
  }
  return fallback;
}

function inferCandidateTitle(artifact = {}) {
  const draft = artifact?.draft || {};
  return pickFirstText([
    draft?.frontmatter?.title,
    draft?.card_entry?.title,
    artifact?.title,
    draft?.target_card_id,
    artifact?.artifact_id
  ], 'Untitled portable Warm card');
}

function inferLivingFragment(artifact = {}) {
  const draft = artifact?.draft || {};
  return pickFirstText([
    draft?.body?.snapshot,
    draft?.snapshot,
    draft?.card_entry?.summary_for_growth,
    draft?.frontmatter?.inject_short,
    artifact?.summary_for_growth
  ]);
}

function inferFutureUseHint(artifact = {}) {
  const draft = artifact?.draft || {};
  const followUp = Array.isArray(draft?.body?.follow_up)
    ? draft.body.follow_up
    : (Array.isArray(draft?.follow_up) ? draft.follow_up : []);
  return pickFirstText([
    draft?.next_hint,
    followUp[0],
    draft?.reason
  ]);
}

function inferFrontendDeliveryTier(artifact = {}) {
  const draft = artifact?.draft || {};
  return pickFirstText([
    draft?.card_entry?.frontend_delivery_tier,
    draft?.frontmatter?.frontend_delivery_tier,
    artifact?.frontend_delivery_tier
  ], 'guarded_candidate');
}

function inferArchiveBucket(artifact = {}) {
  const draft = artifact?.draft || {};
  return pickFirstText([
    draft?.card_entry?.archive_bucket,
    draft?.frontmatter?.archive_bucket,
    artifact?.archive_bucket
  ], 'stable');
}

function renderPortableCardMarkdown({ title = '', livingFragment = '', feelingAsFact = '', futureUseHint = '', markdown = '' } = {}) {
  const existing = safeText(markdown);
  if (existing) return existing;
  const lines = [`# ${safeText(title, 'Portable Warm Card')}`, ''];
  if (livingFragment) lines.push(livingFragment, '');
  if (feelingAsFact) lines.push('## Feeling as fact', '', feelingAsFact, '');
  if (futureUseHint) lines.push('## Future use', '', futureUseHint, '');
  return lines.join('\n').trim();
}

function collectSnippetLists(container = {}) {
  const lists = [];
  if (Array.isArray(container?.source_scene_snippets)) lists.push(container.source_scene_snippets);
  if (Array.isArray(container?.source_snippets)) lists.push(container.source_snippets);
  return lists.flat();
}

function collectGrowthSourceSnippets(artifact = {}) {
  const task = artifact?.task || {};
  const draft = artifact?.draft || {};
  const containers = [
    draft?.source_review?.primary_evidence,
    draft?.source_review?.related_evidence,
    task?.evidence?.primary,
    task?.evidence?.related,
    task,
    draft
  ];
  const snippets = [];
  for (const container of containers) {
    snippets.push(...collectSnippetLists(container));
  }
  return snippets.filter((item) => isPlainObject(item));
}

function normalizeSnippet(snippet = {}) {
  const sourceWindow = pickFirstText([
    snippet.source_window_title,
    snippet.source_window,
    snippet.source_window_id
  ]);
  const sourceFile = pickFirstText([
    snippet.file,
    snippet.source_file,
    snippet.source_ref
  ]);
  const turnRange = pickFirstText([
    snippet.source_msg_range,
    snippet.turn_range,
    snippet.message_range
  ]);
  const excerptText = pickFirstText([
    snippet.excerpt_text,
    snippet.source_quote,
    snippet.quote_text,
    snippet.excerpt_hint
  ]);
  return {
    source_bundle_id: safeText(snippet.source_bundle_id || snippet.bundle_id),
    source_file: sanitizeSourceFileLabel(sourceFile),
    source_file_digest: sourceFile ? sha256(sourceFile) : '',
    source_window: sourceWindow,
    turn_range: turnRange,
    message_ids: Array.isArray(snippet.message_ids) ? uniqueStrings(snippet.message_ids, 64) : [],
    source_time: pickFirstText([snippet.source_time, snippet.time, snippet.date]),
    speaker: pickFirstText([snippet.speaker, snippet.role], 'unknown'),
    excerpt_text: excerptText,
    raw: snippet
  };
}

function isReliableSnippet(snippet = {}) {
  return Boolean(
    safeText(snippet.excerpt_text)
    && safeText(snippet.turn_range)
    && (safeText(snippet.source_window) || safeText(snippet.source_file))
  );
}

function registerSourceSpan(state, snippet = {}) {
  const sourceIdSeed = stableJson({
    source_bundle_id: snippet.source_bundle_id,
    source_file: snippet.source_file,
    source_file_digest: snippet.source_file_digest,
    source_window: snippet.source_window
  });
  const sourceOccurrenceId = `occ_${shortHash(stableJson({
    sourceIdSeed,
    turn_range: snippet.turn_range
  }))}`;
  if (!state.sourceOccurrenceMap.has(sourceOccurrenceId)) {
    const occurrence = {
      source_occurrence_id: sourceOccurrenceId,
      source_id: `source_${shortHash(sourceIdSeed)}`,
      source_kind: 'growth_source_snippet',
      source_file: safeText(snippet.source_file),
      source_file_digest: safeText(snippet.source_file_digest),
      source_window: safeText(snippet.source_window),
      turn_range: safeText(snippet.turn_range),
      message_ids: Array.isArray(snippet.message_ids) ? snippet.message_ids : [],
      source_time: safeText(snippet.source_time)
    };
    state.sourceOccurrenceMap.set(sourceOccurrenceId, {
      ...occurrence,
      digest: digestObject(occurrence)
    });
  }

  const sourceSpanId = `span_${shortHash(stableJson({
    source_occurrence_id: sourceOccurrenceId,
    speaker: snippet.speaker,
    turn_range: snippet.turn_range,
    excerpt_text: snippet.excerpt_text
  }))}`;
  if (!state.sourceSpanMap.has(sourceSpanId)) {
    state.sourceSpanMap.set(sourceSpanId, {
      source_span_id: sourceSpanId,
      source_occurrence_id: sourceOccurrenceId,
      turn_range: safeText(snippet.turn_range),
      message_ids: Array.isArray(snippet.message_ids) ? snippet.message_ids : [],
      speaker: safeText(snippet.speaker, 'unknown'),
      excerpt_text: safeText(snippet.excerpt_text),
      excerpt_digest: sha256(snippet.excerpt_text),
      bounds: {
        start: 0,
        end: textLength(snippet.excerpt_text),
        unit: 'utf16_code_units'
      }
    });
  }
  return { sourceOccurrenceId, sourceSpanId };
}

function buildHoldEntry({ sourceKind = '', sourceId = '', title = '', reason = '', row = {} } = {}) {
  return {
    ledger_id: buildPortableWarmLedgerId({
      state: 'hold',
      sourceKind,
      sourceId,
      title,
      reason
    }),
    state: 'hold',
    reason: safeText(reason, 'requires_review'),
    source_kind: safeText(sourceKind),
    source_id: safeText(sourceId),
    title: safeText(title),
    row_digest: digestObject(row),
    review_note: 'Not emitted as a portable Warm card until source span evidence is bounded.'
  };
}

function buildRejectedEntry({ sourceKind = '', sourceId = '', reason = '', row = {} } = {}) {
  return {
    ledger_id: buildPortableWarmLedgerId({
      state: 'rejected',
      sourceKind,
      sourceId,
      reason
    }),
    state: 'rejected',
    reason: safeText(reason, 'invalid_candidate'),
    source_kind: safeText(sourceKind),
    source_id: safeText(sourceId),
    row_digest: digestObject(row)
  };
}

function addGrowthDraftArtifact(state, artifact = {}) {
  const artifactId = safeText(artifact?.artifact_id || artifact?.json_file);
  const logicalCandidateId = buildGrowthLogicalCandidateId({
    cardType: safeText(artifact?.task?.card_type || artifact?.draft?.card_entry?.card_type, 'memo'),
    familyId: safeText(artifact?.draft?.frontmatter?.family || artifact?.draft?.card_entry?.family_id || artifact?.task?.family_id, 'unassigned'),
    task: artifact?.task || {},
    draft: artifact?.draft || {}
  });
  if (!logicalCandidateId) {
    state.rejected_ledger.push(buildRejectedEntry({
      sourceKind: 'growth_draft',
      sourceId: `missing_identity_${shortHash(stableJson(artifact))}`,
      reason: 'missing_stable_candidate_identity',
      row: artifact
    }));
    return;
  }
  const title = inferCandidateTitle(artifact);
  const livingFragment = inferLivingFragment(artifact);
  if (!title || !livingFragment) {
    state.rejected_ledger.push(buildRejectedEntry({
      sourceKind: 'growth_draft',
      sourceId: artifactId || logicalCandidateId,
      reason: 'missing_title_or_living_fragment',
      row: artifact
    }));
    return;
  }

  const decision = safeText(artifact?.draft?.decision).toLowerCase();
  if (decision === 'skip' || decision === 'hold') {
    state.hold_ledger.push(buildHoldEntry({
      sourceKind: 'growth_draft',
      sourceId: artifactId || logicalCandidateId,
      title,
      reason: `growth_decision_${decision}`,
      row: artifact
    }));
    return;
  }

  const snippets = collectGrowthSourceSnippets(artifact).map((item) => normalizeSnippet(item));
  const reliableSnippets = snippets.filter((item) => isReliableSnippet(item));
  if (!reliableSnippets.length) {
    state.hold_ledger.push(buildHoldEntry({
      sourceKind: 'growth_draft',
      sourceId: artifactId || logicalCandidateId,
      title,
      reason: 'missing_bounded_source_span',
      row: artifact
    }));
    return;
  }
  if (snippets.length !== reliableSnippets.length) {
    state.hold_ledger.push(buildHoldEntry({
      sourceKind: 'growth_draft',
      sourceId: artifactId || logicalCandidateId,
      title,
      reason: 'mixed_source_quality_requires_review',
      row: artifact
    }));
    return;
  }

  const sourceOccurrenceIds = [];
  const sourceSpanIds = [];
  for (const snippet of reliableSnippets) {
    const registered = registerSourceSpan(state, snippet);
    sourceOccurrenceIds.push(registered.sourceOccurrenceId);
    sourceSpanIds.push(registered.sourceSpanId);
  }

  const draft = artifact?.draft || {};
  const feelingAsFact = pickFirstText([
    draft?.card_entry?.feeling_as_fact,
    draft?.feeling_as_fact,
    draft?.body?.feeling_as_fact,
    draft?.body?.context
  ]);
  const futureUseHint = inferFutureUseHint(artifact);
  const candidateId = `warm_${shortHash(stableJson({
    source: 'growth_draft',
    logical_candidate_id: logicalCandidateId
  }))}`;
  state.warm_cards.push({
    candidate_id: candidateId,
    title,
    archive_bucket: inferArchiveBucket(artifact),
    frontend_delivery_tier: inferFrontendDeliveryTier(artifact),
    portable_warm_card: {
      body_markdown: renderPortableCardMarkdown({
        title,
        livingFragment,
        feelingAsFact,
        futureUseHint,
        markdown: artifact?.markdown || draft?.markdown
      }),
      living_fragment: livingFragment,
      feeling_as_fact: feelingAsFact,
      future_use_hint: futureUseHint,
      voice_fingerprint_refs: uniqueStrings(draft?.card_entry?.voice_fingerprint_refs || draft?.frontmatter?.voice_fingerprint || [], 32),
      persona_refs: uniqueStrings(draft?.card_entry?.persona_refs || [], 32)
    },
    source_refs: {
      source_occurrence_ids: uniqueStrings(sourceOccurrenceIds, 256),
      source_span_ids: uniqueStrings(sourceSpanIds, 256)
    },
    privacy: {
      local_only: true,
      projection_requires_user_action: true
    },
    quality: {
      source_bound: true,
      source_complete: true,
      source_span_count: uniqueStrings(sourceSpanIds, 256).length,
      source_incomplete: false
    },
    home_import_policy: {
      direct_write_allowed: false,
      state: 'review_only',
      reason: 'Public Driftstone emits portable candidates only; Home canonical write is out of scope.'
    }
  });
}

function reviewedEntryTitle(entry = {}) {
  return pickFirstText([
    entry?.canonical_name,
    entry?.slot_path,
    entry?.secondary_slot,
    entry?.anchor_type
  ], 'Reviewed candidate');
}

function collectReviewedRows(packet = {}) {
  if (Array.isArray(packet?.finalized_entries) && packet.finalized_entries.length) {
    return packet.finalized_entries.map((entry, index) => ({
      source_id: `finalized_entries[${index}]`,
      entry
    }));
  }
  return (Array.isArray(packet?.items) ? packet.items : []).map((item, index) => ({
    source_id: safeText(item?.item_id, `items[${index}]`),
    entry: item?.entry || {}
  }));
}

function addReviewedPacketRows(state, packet = {}) {
  for (const row of collectReviewedRows(packet)) {
    const title = reviewedEntryTitle(row.entry);
    state.hold_ledger.push(buildHoldEntry({
      sourceKind: 'reviewed_entry',
      sourceId: row.source_id,
      title,
      reason: 'reviewed_entry_missing_bounded_source_span',
      row
    }));
  }
}

function buildManifest({ scope = {}, generatedAt = '', bundleId = '', state }) {
  const sourceOccurrences = Array.from(state.sourceOccurrenceMap.values());
  const sourceSpans = Array.from(state.sourceSpanMap.values());
  const sourceManifest = {
    source_count: sourceOccurrences.length,
    source_occurrence_count: sourceOccurrences.length,
    source_span_count: sourceSpans.length,
    source_digest: digestObject({ source_occurrences: sourceOccurrences, source_spans: sourceSpans })
  };
  const conservation = {
    input_growth_draft_rows: state.input_growth_draft_rows,
    input_reviewed_rows: state.input_reviewed_rows,
    input_rows: state.input_growth_draft_rows + state.input_reviewed_rows,
    accepted_rows: state.warm_cards.length,
    rejected_rows: state.rejected_ledger.length,
    hold_rows: state.hold_ledger.length,
    source_occurrence_count: sourceOccurrences.length,
    source_span_count: sourceSpans.length
  };
  const manifest = {
    bundle_id: bundleId,
    created_at: generatedAt,
    generator: 'driftstone_portable_warm_bundle_builder',
    scope: {
      owner_id: safeText(scope?.owner_id || scope?.ownerId),
      realm_id: safeText(scope?.realm_id || scope?.realmId, 'default'),
      bot_id: safeText(scope?.bot_id || scope?.botId)
    },
    candidate_count: state.warm_cards.length,
    source_span_count: sourceSpans.length,
    manifest_digest: ''
  };
  return { manifest, sourceManifest, conservation, sourceOccurrences, sourceSpans };
}

export function buildPortableWarmBundle({
  scope = {},
  growthDraftArtifacts = [],
  reviewedPacket = null,
  generatedAt = new Date().toISOString(),
  bundleId = ''
} = {}) {
  const state = {
    warm_cards: [],
    rejected_ledger: [],
    hold_ledger: [],
    sourceOccurrenceMap: new Map(),
    sourceSpanMap: new Map(),
    input_growth_draft_rows: Array.isArray(growthDraftArtifacts) ? growthDraftArtifacts.length : 0,
    input_reviewed_rows: Array.isArray(reviewedPacket?.finalized_entries)
      ? reviewedPacket.finalized_entries.length
      : (Array.isArray(reviewedPacket?.items) ? reviewedPacket.items.length : 0)
  };

  for (const artifact of Array.isArray(growthDraftArtifacts) ? growthDraftArtifacts : []) {
    addGrowthDraftArtifact(state, artifact);
  }
  if (reviewedPacket) addReviewedPacketRows(state, reviewedPacket);

  const resolvedBundleId = safeText(bundleId) || `bundle_${safeScopeSegment(scope?.owner_id || scope?.ownerId, 'owner')}_${safeScopeSegment(scope?.realm_id || scope?.realmId, 'default')}_${shortHash(stableJson({
    generatedAt,
    warm_cards: state.warm_cards.map((card) => card.candidate_id),
    hold: state.hold_ledger.map((item) => item.ledger_id),
    rejected: state.rejected_ledger.map((item) => item.ledger_id)
  }))}`;
  const {
    manifest,
    sourceManifest,
    conservation,
    sourceOccurrences,
    sourceSpans
  } = buildManifest({
    scope,
    generatedAt,
    bundleId: resolvedBundleId,
    state
  });
  const bundleWithoutDigest = {
    schema: BUNDLE_SCHEMA,
    manifest,
    source_manifest: sourceManifest,
    persona_authority: {
      authority: 'optional_user_supplied_or_runtime_digest',
      persona_digest: '',
      language_fingerprint_digest: ''
    },
    warm_cards: state.warm_cards,
    source_occurrences: sourceOccurrences,
    source_spans: sourceSpans,
    rejected_ledger: state.rejected_ledger,
    hold_ledger: state.hold_ledger,
    projection_roundtrip: {
      notion: {
        candidate_id_map: []
      }
    },
    conservation
  };
  const manifestDigest = digestObject({
    ...bundleWithoutDigest,
    manifest: {
      ...manifest,
      manifest_digest: ''
    }
  });
  return {
    ...bundleWithoutDigest,
    manifest: {
      ...manifest,
      manifest_digest: manifestDigest
    }
  };
}

function toJsonl(rows = []) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`;
}

function countByReason(rows = []) {
  return rows.reduce((counts, row) => {
    const reason = safeText(row?.reason, 'unknown');
    counts[reason] = Number(counts[reason] || 0) + 1;
    return counts;
  }, {});
}

function summarizeLedgerRows(rows = [], limit = 5) {
  return (Array.isArray(rows) ? rows : []).slice(0, Math.max(0, Number(limit || 5))).map((row) => ({
    ledger_id: safeText(row?.ledger_id),
    state: safeText(row?.state),
    reason: safeText(row?.reason),
    source_kind: safeText(row?.source_kind),
    source_id: safeText(row?.source_id),
    title: safeText(row?.title)
  }));
}

function buildSourceSpanIndex(sourceSpans = []) {
  return new Set((Array.isArray(sourceSpans) ? sourceSpans : []).map((span) => safeText(span?.source_span_id)).filter(Boolean));
}

function countCardsWithMissingSourceRefs(bundle = {}) {
  const sourceSpanIds = buildSourceSpanIndex(bundle.source_spans);
  return (Array.isArray(bundle.warm_cards) ? bundle.warm_cards : []).filter((card) => {
    const refs = Array.isArray(card?.source_refs?.source_span_ids) ? card.source_refs.source_span_ids : [];
    return refs.length === 0 || refs.some((id) => !sourceSpanIds.has(safeText(id)));
  }).length;
}

function countBoundedSourceSpans(bundle = {}) {
  return (Array.isArray(bundle.source_spans) ? bundle.source_spans : []).filter((span) => (
    safeText(span?.source_occurrence_id)
    && safeText(span?.turn_range)
    && safeText(span?.excerpt_text)
  )).length;
}

function buildBundleInspection({ bundle = {}, bundleFile = '', sampleLimit = 5 } = {}) {
  const normalized = normalizePortableWarmBundleForRead(bundle);
  const readBundle = normalized.bundle || bundle;
  const validation = normalized.validation;
  const rejectedRows = Array.isArray(readBundle.rejected_ledger) ? readBundle.rejected_ledger : [];
  const holdRows = Array.isArray(readBundle.hold_ledger) ? readBundle.hold_ledger : [];
  const missingSourceRefCards = countCardsWithMissingSourceRefs(readBundle);
  const boundedSourceSpans = countBoundedSourceSpans(readBundle);
  const acceptedRows = Array.isArray(readBundle.warm_cards) ? readBundle.warm_cards.length : 0;
  const ledgerCount = rejectedRows.length + holdRows.length;
  const artifactStatus = validation.ok
    ? (acceptedRows || ledgerCount ? 'valid_bundle' : 'valid_empty_bundle')
    : 'invalid_bundle';
  let projectionReadiness = 'blocked_by_contract_errors';
  if (validation.ok && !acceptedRows && !ledgerCount) {
    projectionReadiness = 'nothing_to_project';
  } else if (validation.ok) {
    projectionReadiness = ledgerCount ? 'ready_with_review_ledgers' : 'ready';
  }

  return {
    ok: validation.ok,
    schema: 'driftstone_portable_warm_bundle_inspection_v0',
    bundle_file: safeText(bundleFile),
    artifact_status: artifactStatus,
    projection_readiness: projectionReadiness,
    validation,
    read_compatibility: validation.read_compatibility,
    manifest: readBundle?.manifest || {},
    counts: {
      ...validation.counts,
      input_rows: Number(readBundle?.conservation?.input_rows || 0),
      accepted_rows: acceptedRows,
      rejected_rows: rejectedRows.length,
      hold_rows: holdRows.length
    },
    source_reliability: {
      bounded_source_spans: boundedSourceSpans,
      source_spans: Array.isArray(readBundle.source_spans) ? readBundle.source_spans.length : 0,
      warm_cards_missing_source_refs: missingSourceRefCards,
      source_complete: validation.ok && missingSourceRefCards === 0
    },
    ledgers: {
      rejected_by_reason: countByReason(rejectedRows),
      hold_by_reason: countByReason(holdRows),
      rejected_samples: summarizeLedgerRows(rejectedRows, sampleLimit),
      hold_samples: summarizeLedgerRows(holdRows, sampleLimit)
    },
    next_actions: validation.ok && projectionReadiness === 'nothing_to_project'
      ? [
          'No portable Warm cards, rejected rows, or HOLD rows were found in this bundle.',
          'Inspect the pipeline scope before exporting projections.'
        ]
      : validation.ok
      ? [
          ledgerCount ? 'Review rejected_ledger and hold_ledger before treating the bundle as clean.' : '',
          'Export Markdown/Obsidian/Notion projections from this bundle when the user asks.',
          'Do not write Home, Hippocove, Notion, or legacy cold graph surfaces from this inspection.'
        ].filter(Boolean)
      : [
          'Fix contract validation errors before projection export.',
          'Do not use this bundle as canonical memory evidence.'
        ]
  };
}

function resolveBundleFile({ bundlePath = '', bundleDir = '' } = {}) {
  const explicitPath = safeText(bundlePath);
  if (explicitPath) return resolve(explicitPath);
  const dir = safeText(bundleDir);
  if (dir) return resolve(dir, 'portable_warm_bundle.json');
  throw new Error('bundle_path or bundle_dir is required');
}

async function writePortableWarmBundleFiles({ bundle = {}, outputRoot = '' } = {}) {
  const root = resolve(outputRoot || join(PROJECT_ROOT, 'output', 'portable_warm_bundles'));
  const scope = bundle?.manifest?.scope || {};
  const dir = join(
    root,
    `${safeScopeSegment(scope.owner_id, 'owner')}__${safeScopeSegment(scope.realm_id, 'default')}`,
    safeScopeSegment(bundle?.manifest?.bundle_id, 'bundle')
  );
  await mkdir(dir, { recursive: true });
  const files = {
    bundle_json: join(dir, 'portable_warm_bundle.json'),
    manifest_json: join(dir, 'manifest.json'),
    warm_cards_jsonl: join(dir, 'warm_cards.jsonl'),
    source_occurrences_jsonl: join(dir, 'source_occurrences.jsonl'),
    source_spans_jsonl: join(dir, 'source_spans.jsonl'),
    rejected_ledger_jsonl: join(dir, 'rejected_ledger.jsonl'),
    hold_ledger_jsonl: join(dir, 'hold_ledger.jsonl')
  };
  await writeFile(files.bundle_json, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  await writeFile(files.manifest_json, `${JSON.stringify(bundle.manifest, null, 2)}\n`, 'utf8');
  await writeFile(files.warm_cards_jsonl, toJsonl(bundle.warm_cards), 'utf8');
  await writeFile(files.source_occurrences_jsonl, toJsonl(bundle.source_occurrences), 'utf8');
  await writeFile(files.source_spans_jsonl, toJsonl(bundle.source_spans), 'utf8');
  await writeFile(files.rejected_ledger_jsonl, toJsonl(bundle.rejected_ledger), 'utf8');
  await writeFile(files.hold_ledger_jsonl, toJsonl(bundle.hold_ledger), 'utf8');
  return { dir, files };
}

export async function inspectPortableWarmBundle({
  bundlePath = '',
  bundleDir = '',
  sampleLimit = 5
} = {}) {
  let bundleFile;
  try {
    bundleFile = resolveBundleFile({ bundlePath, bundleDir });
  } catch (error) {
    return {
      ok: false,
      schema: 'driftstone_portable_warm_bundle_inspection_v0',
      bundle_file: '',
      artifact_status: 'missing_bundle_reference',
      projection_readiness: 'blocked_by_input_error',
      error: {
        message: safeText(error?.message, 'bundle_path or bundle_dir is required')
      },
      next_actions: [
        'Pass bundle_path for portable_warm_bundle.json or bundle_dir for the exported bundle directory.'
      ]
    };
  }
  let bundle;
  try {
    bundle = JSON.parse(await readFile(bundleFile, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      schema: 'driftstone_portable_warm_bundle_inspection_v0',
      bundle_file: bundleFile,
      artifact_status: 'unreadable_bundle',
      projection_readiness: 'blocked_by_read_error',
      error: {
        message: safeText(error?.message, 'Unable to read portable_warm_bundle.json'),
        code: safeText(error?.code)
      },
      next_actions: [
        'Check that bundle_path points to portable_warm_bundle.json or bundle_dir contains that file.',
        'Do not use a stale previous bundle as this run output.'
      ]
    };
  }
  return buildBundleInspection({ bundle, bundleFile, sampleLimit });
}

export async function exportPortableWarmBundle({
  ownerId = '',
  realmId = '',
  botId = '',
  cardType = 'memo',
  limit = 200,
  outputRoot = '',
  writeFiles = true
} = {}) {
  const scope = {
    owner_id: safeText(ownerId),
    realm_id: safeText(realmId, 'default'),
    bot_id: safeText(botId)
  };
  const catalog = await listGrowthDraftArtifacts({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    cardType,
    limit
  });
  const growthDraftArtifacts = [];
  for (const row of Array.isArray(catalog?.drafts) ? catalog.drafts : []) {
    const artifact = await getGrowthDraftArtifact({
      ownerId: scope.owner_id,
      realmId: scope.realm_id,
      cardType: row.card_type || cardType,
      artifactId: row.artifact_id
    });
    if (artifact?.ok) growthDraftArtifacts.push(artifact);
  }
  let reviewedPacket = null;
  try {
    reviewedPacket = (await loadLatestRuntimeReviewedPacket({
      ownerId: scope.owner_id,
      realmId: scope.realm_id
    }))?.packet || null;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const bundle = buildPortableWarmBundle({
    scope,
    growthDraftArtifacts,
    reviewedPacket
  });
  const validation = validatePortableWarmBundle(bundle);
  const written = writeFiles
    ? await writePortableWarmBundleFiles({ bundle, outputRoot })
    : { dir: '', files: {} };
  return {
    ok: validation.ok,
    schema: 'driftstone_portable_warm_bundle_export_v0',
    bundle,
    validation,
    output: written,
    counts: validation.counts,
    conservation: bundle.conservation
  };
}
