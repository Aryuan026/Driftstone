import {
  isGenericName,
  isPlainDateName,
  normalizeAnchorType,
  normalizeCompact,
  pickEarlierDate,
  pickLaterDate,
  splitSqlGrowthTokens,
  sqlGrowthDateValue,
  sqlGrowthDisplayBucket,
  sqlGrowthNormalizeTreePathSegment,
  sqlGrowthStableFactTokens,
  sqlGrowthSummaryText,
  sqlGrowthUniqueStrings
} from './growth-helpers.js';

function batchOrderMap(filesMeta) {
  const map = new Map();
  (Array.isArray(filesMeta) ? filesMeta : []).forEach((file, idx) => {
    const name = String(file?.name || file?.file || '').trim();
    if (name) map.set(name, idx);
  });
  return map;
}

function canonicalTitle(row) {
  return String(
    row?.anchor_name
    || row?.card_name
    || row?.title
    || row?.anchor_type
    || '未命名卡'
  ).trim() || '未命名卡';
}

function buildGroupKey(typeKey, title) {
  return `${typeKey || 'unknown'}::${normalizeCompact(title) || 'unnamed'}`;
}

function decidePlacementAction(record) {
  const typeKey = String(record.anchor_type || '').trim();
  const candidateTrunk = ['person', 'thing', 'event', 'rule'].includes(typeKey);
  const crossMonthSignal = record.evidence_set.batches.length >= 2
    || (record.evidence_set.windows.length >= 2 && record.source_rows >= 2);
  const maintainable = record.stable_fact_candidates.length > 0;
  const nameQuality = !isGenericName(record.canonical_name) && !isPlainDateName(record.canonical_name);

  if (typeKey === 'time' || !candidateTrunk) {
    return { action: 'archive', action_label: '留月档', confidence: '低' };
  }
  if (crossMonthSignal && maintainable && nameQuality) {
    return { action: 'promote_a', action_label: '建议升主卡', confidence: '高' };
  }
  if (!crossMonthSignal && !maintainable) {
    return { action: 'archive', action_label: '留月档', confidence: '低' };
  }
  return { action: 'observe', action_label: '先观察', confidence: crossMonthSignal || maintainable ? '中' : '低' };
}

export function buildGrowthGroups(rows, filesMeta = []) {
  const order = batchOrderMap(filesMeta);
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const typeKey = normalizeAnchorType(row.anchor_type || row.card_type || row.raw?.anchor_type || row.raw?.card_type);
    const title = canonicalTitle(row);
    const key = buildGroupKey(typeKey, title);
    if (!map.has(key)) {
      map.set(key, {
        key,
        title,
        cardType: row.card_type || row.anchor_type || '',
        type_key: typeKey,
        firstSeen: '',
        lastSeen: '',
        rows: []
      });
    }
    const group = map.get(key);
    group.rows.push(row);
    group.firstSeen = pickEarlierDate(group.firstSeen, sqlGrowthDateValue(row.first_seen_at || row.time));
    group.lastSeen = pickLaterDate(group.lastSeen, sqlGrowthDateValue(row.last_seen_at || row.time));
  });

  return Array.from(map.values()).sort((a, b) => {
    const rankA = order.has(a.rows[0]?.source_file) ? order.get(a.rows[0]?.source_file) : 9999;
    const rankB = order.has(b.rows[0]?.source_file) ? order.get(b.rows[0]?.source_file) : 9999;
    if (rankA !== rankB) return rankA - rankB;
    if (a.firstSeen !== b.firstSeen) return String(a.firstSeen || '').localeCompare(String(b.firstSeen || ''));
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

export function buildPlacementRecords(groups, filesMeta = []) {
  const order = batchOrderMap(filesMeta);
  return (Array.isArray(groups) ? groups : []).map((group) => {
    const rows = Array.isArray(group.rows) ? group.rows.slice() : [];
    const batchHitsMap = new Map();
    const evidence = {
      batches: new Set(),
      windows: new Set(),
      topics: new Set(),
      families: new Set(),
      source_refs: new Set()
    };
    rows.forEach((row) => {
      const batch = String(row?.source_file || row?.batch_tag || '未知批次').trim() || '未知批次';
      if (!batchHitsMap.has(batch)) {
        batchHitsMap.set(batch, {
          batch,
          rows: [],
          first_seen_at: '',
          last_seen_at: '',
          stable_facts: new Set(),
          summaries: [],
          source_refs: new Set(),
          source_windows: new Set(),
          topics: new Set(),
          families: new Set()
        });
      }
      const hit = batchHitsMap.get(batch);
      hit.rows.push(row);
      hit.first_seen_at = pickEarlierDate(hit.first_seen_at, sqlGrowthDateValue(row.first_seen_at || row.time));
      hit.last_seen_at = pickLaterDate(hit.last_seen_at, sqlGrowthDateValue(row.last_seen_at || row.time));
      sqlGrowthStableFactTokens(row.stable_points).forEach((item) => hit.stable_facts.add(item));
      const summary = sqlGrowthSummaryText(row);
      if (summary) hit.summaries.push(summary);
      splitSqlGrowthTokens(row.source_ref).forEach((item) => {
        hit.source_refs.add(item);
        evidence.source_refs.add(item);
      });
      splitSqlGrowthTokens(row.source_window_id).forEach((item) => {
        hit.source_windows.add(item);
        evidence.windows.add(item);
      });
      splitSqlGrowthTokens(row.topic_ids).forEach((item) => {
        hit.topics.add(item);
        evidence.topics.add(item);
      });
      if (row.family_id || row.family_anchor_title) {
        const family = String(row.family_anchor_title || row.family_id || '').trim();
        if (family) {
          hit.families.add(family);
          evidence.families.add(family);
        }
      }
      evidence.batches.add(batch);
    });

    const batchHits = Array.from(batchHitsMap.values())
      .map((hit) => ({
        batch: hit.batch,
        first_seen_at: hit.first_seen_at,
        last_seen_at: hit.last_seen_at,
        stable_facts: sqlGrowthUniqueStrings(Array.from(hit.stable_facts), 6),
        summaries: sqlGrowthUniqueStrings(hit.summaries, 4),
        source_refs: sqlGrowthUniqueStrings(Array.from(hit.source_refs), 12),
        source_windows: sqlGrowthUniqueStrings(Array.from(hit.source_windows), 12),
        topics: sqlGrowthUniqueStrings(Array.from(hit.topics), 12),
        families: sqlGrowthUniqueStrings(Array.from(hit.families), 6),
        row_count: hit.rows.length
      }))
      .sort((a, b) => {
        const rankA = order.has(a.batch) ? order.get(a.batch) : 9999;
        const rankB = order.has(b.batch) ? order.get(b.batch) : 9999;
        if (rankA !== rankB) return rankA - rankB;
        return String(a.first_seen_at || '').localeCompare(String(b.first_seen_at || ''));
      });

    const candidateTrunk = ['person', 'thing', 'event', 'rule'].includes(group.type_key)
      ? sqlGrowthDisplayBucket(group.type_key)
      : '';
    const rootKey = candidateTrunk ? `${group.type_key}::${normalizeCompact(group.title)}` : '';
    const record = {
      key: group.key,
      title: group.title,
      raw_type: group.cardType,
      anchor_type: group.type_key,
      canonical_name: group.title,
      candidate_trunk: candidateTrunk,
      candidate_secondary_slot: '',
      candidate_secondary_slot_key: '',
      slot_owner_hint: '',
      slot_path: '',
      action: 'observe',
      action_label: '先观察',
      confidence: '低',
      first_seen_at: group.firstSeen || '',
      last_seen_at: group.lastSeen || '',
      evidence_set: {
        batches: sqlGrowthUniqueStrings(Array.from(evidence.batches)),
        windows: sqlGrowthUniqueStrings(Array.from(evidence.windows)),
        topics: sqlGrowthUniqueStrings(Array.from(evidence.topics)),
        families: sqlGrowthUniqueStrings(Array.from(evidence.families)),
        source_refs: sqlGrowthUniqueStrings(Array.from(evidence.source_refs), 20)
      },
      stable_fact_candidates: sqlGrowthUniqueStrings(rows.flatMap((row) => sqlGrowthStableFactTokens(row.stable_points)), 8),
      batch_hits: batchHits,
      source_rows: rows.length,
      root_key: rootKey,
      can_root: false
    };
    const decision = decidePlacementAction(record);
    record.action = decision.action;
    record.action_label = decision.action_label;
    record.confidence = decision.confidence;
    record.can_root = Boolean(rootKey && decision.action === 'promote_a');
    return record;
  });
}

export function buildWritebackRoots(placementRecords) {
  const roots = [];
  const rootMap = new Map();
  (Array.isArray(placementRecords) ? placementRecords : [])
    .filter((record) => record?.can_root && record.root_key)
    .sort((a, b) => {
      if (a.first_seen_at !== b.first_seen_at) return String(a.first_seen_at || '').localeCompare(String(b.first_seen_at || ''));
      return String(a.canonical_name || '').localeCompare(String(b.canonical_name || ''));
    })
    .forEach((record) => {
      const hits = Array.isArray(record.batch_hits) ? record.batch_hits : [];
      if (!hits.length) return;
      let root = rootMap.get(record.root_key);
      const seed = hits[0];
      if (!root) {
        root = {
          root_key: record.root_key,
          tree_path: `trunk/${record.anchor_type}/${sqlGrowthNormalizeTreePathSegment(record.canonical_name)}`,
          anchor_type: record.anchor_type,
          canonical_name: record.canonical_name,
          candidate_trunk: record.candidate_trunk,
          candidate_secondary_slot: record.candidate_secondary_slot,
          slot_path: record.slot_path,
          slot_owner_hint: record.slot_owner_hint,
          first_seen_at: seed.first_seen_at || record.first_seen_at || '',
          last_seen_at: seed.last_seen_at || record.last_seen_at || '',
          version_count: 1,
          evolution_status: hits.length > 1 ? 'updated' : (record.stable_fact_candidates.length ? 'stable' : 'volatile'),
          stable_facts: sqlGrowthUniqueStrings(seed.stable_facts.length ? seed.stable_facts : record.stable_fact_candidates, 6),
          recent_updates: [],
          source_batches: [seed.batch],
          source_refs: sqlGrowthUniqueStrings(seed.source_refs, 20),
          source_windows: sqlGrowthUniqueStrings(seed.source_windows, 20),
          topic_ids: sqlGrowthUniqueStrings(seed.topics, 20),
          persona_refs: sqlGrowthUniqueStrings(seed.families.length ? seed.families : record.evidence_set.families, 8),
          source_group_keys: [record.key],
          seed_batch: seed.batch,
          branch_count: 0,
          conflict_hint: false
        };
        rootMap.set(record.root_key, root);
        roots.push(root);
      } else if (!root.source_group_keys.includes(record.key)) {
        root.source_group_keys.push(record.key);
      }

      hits.slice(root.version_count === 1 && root.seed_batch === seed.batch ? 1 : 0).forEach((hit) => {
        const incomingStable = sqlGrowthUniqueStrings(hit.stable_facts, 6);
        const rootStableNorm = new Set((root.stable_facts || []).map((item) => normalizeCompact(item)));
        const hasConflict = incomingStable.length > 0
          && root.stable_facts.length > 0
          && !incomingStable.some((item) => rootStableNorm.has(normalizeCompact(item)));
        const updateEntry = {
          batch: hit.batch,
          first_seen_at: hit.first_seen_at || '',
          last_seen_at: hit.last_seen_at || '',
          summaries: sqlGrowthUniqueStrings(hit.summaries, 3),
          stable_facts: incomingStable,
          source_refs: sqlGrowthUniqueStrings(hit.source_refs, 12),
          source_windows: sqlGrowthUniqueStrings(hit.source_windows, 12),
          topics: sqlGrowthUniqueStrings(hit.topics, 12),
          persona_refs: sqlGrowthUniqueStrings(hit.families, 6),
          conflict_hint: hasConflict
        };
        root.recent_updates.push(updateEntry);
        root.branch_count += 1;
        root.version_count += 1;
        root.last_seen_at = pickLaterDate(root.last_seen_at, hit.last_seen_at || hit.first_seen_at || '');
        root.source_batches = sqlGrowthUniqueStrings(root.source_batches.concat(hit.batch));
        root.source_refs = sqlGrowthUniqueStrings(root.source_refs.concat(hit.source_refs), 24);
        root.source_windows = sqlGrowthUniqueStrings(root.source_windows.concat(hit.source_windows), 24);
        root.topic_ids = sqlGrowthUniqueStrings(root.topic_ids.concat(hit.topics), 24);
        root.persona_refs = sqlGrowthUniqueStrings(root.persona_refs.concat(hit.families), 10);
        if (hasConflict) {
          root.conflict_hint = true;
        } else if (incomingStable.length) {
          root.stable_facts = sqlGrowthUniqueStrings(root.stable_facts.concat(incomingStable), 8);
        }
      });

      if (root.version_count > 1) root.evolution_status = 'updated';
      else if (!root.stable_facts.length) root.evolution_status = 'volatile';
    });

  return roots.sort((a, b) => {
    if (b.version_count !== a.version_count) return b.version_count - a.version_count;
    return String(a.canonical_name || '').localeCompare(String(b.canonical_name || ''));
  });
}

export function buildGrowthSnapshot(sqlRows, filesMeta = []) {
  const groups = buildGrowthGroups(sqlRows, filesMeta);
  const placementRecords = buildPlacementRecords(groups, filesMeta);
  const roots = buildWritebackRoots(placementRecords);
  return {
    groups,
    placement_records: placementRecords,
    roots,
    summary: {
      sql_rows: Array.isArray(sqlRows) ? sqlRows.length : 0,
      groups: groups.length,
      promote_a: placementRecords.filter((item) => item.action === 'promote_a').length,
      observe: placementRecords.filter((item) => item.action === 'observe').length,
      archive: placementRecords.filter((item) => item.action === 'archive').length,
      roots: roots.length,
      branched_roots: roots.filter((item) => item.branch_count > 0).length
    }
  };
}
