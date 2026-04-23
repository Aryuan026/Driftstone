(function () {
  function batchOrderMap(filesMeta) {
    const map = new Map();
    (filesMeta || []).forEach((file, idx) => {
      const name = String((file && file.name) || '').trim();
      if (name) map.set(name, idx);
    });
    return map;
  }

  function buildPlacementRecords(groups, diagnostics, filesMeta, helpers) {
    const h = helpers || {};
    const diagMap = new Map((diagnostics || []).map((item) => [item.key, item]));
    const order = batchOrderMap(filesMeta);
    return (groups || []).map((group) => {
      const diagnosis = diagMap.get(group.key) || null;
      const typeKey = diagnosis ? String(diagnosis.type_key || '').trim() : h.normalizeSqlGrowthCardType(group.cardType);
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
        const batch = String((row && row.sourceFile) || '未知批次').trim() || '未知批次';
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
        hit.first_seen_at = h.pickEarlierDate(hit.first_seen_at, h.sqlGrowthDateValue(row.first_seen_at || row.time));
        hit.last_seen_at = h.pickLaterDate(hit.last_seen_at, h.sqlGrowthDateValue(row.last_seen_at || row.time));
        h.sqlGrowthStableFactTokens(row.stable_points).forEach((item) => hit.stable_facts.add(item));
        const summary = h.sqlGrowthSummaryText(row);
        if (summary) hit.summaries.push(summary);
        h.splitSqlGrowthTokens(row.source_ref).forEach((item) => {
          hit.source_refs.add(item);
          evidence.source_refs.add(item);
        });
        h.splitSqlGrowthTokens(row.source_window_id).forEach((item) => {
          hit.source_windows.add(item);
          evidence.windows.add(item);
        });
        h.splitSqlGrowthTokens(row.topic_ids).forEach((item) => {
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
          stable_facts: h.sqlGrowthUniqueStrings(Array.from(hit.stable_facts), 6),
          summaries: h.sqlGrowthUniqueStrings(hit.summaries, 4),
          source_refs: h.sqlGrowthUniqueStrings(Array.from(hit.source_refs), 12),
          source_windows: h.sqlGrowthUniqueStrings(Array.from(hit.source_windows), 12),
          topics: h.sqlGrowthUniqueStrings(Array.from(hit.topics), 12),
          families: h.sqlGrowthUniqueStrings(Array.from(hit.families), 6),
          row_count: hit.rows.length
        }))
        .sort((a, b) => {
          const rankA = order.has(a.batch) ? order.get(a.batch) : 9999;
          const rankB = order.has(b.batch) ? order.get(b.batch) : 9999;
          if (rankA !== rankB) return rankA - rankB;
          return String(a.first_seen_at || '').localeCompare(String(b.first_seen_at || ''));
        });
      const candidateTrunk = ['person', 'thing', 'event', 'rule'].includes(typeKey)
        ? h.sqlGrowthDisplayBucket({ type_key: typeKey })
        : '';
      const canonicalName = String(group.title || '').trim() || '未命名主卡';
      const rootKey = candidateTrunk ? `${typeKey}::${h.normalizeCompact(canonicalName)}` : '';
      return {
        key: group.key,
        title: group.title,
        raw_type: group.cardType,
        anchor_type: typeKey,
        canonical_name: canonicalName,
        candidate_trunk: candidateTrunk,
        candidate_secondary_slot: diagnosis ? String(diagnosis.secondary_slot || '').trim() : '',
        candidate_secondary_slot_key: diagnosis ? String(diagnosis.secondary_slot_key || '').trim() : '',
        slot_owner_hint: diagnosis ? String(diagnosis.slot_owner_hint || '').trim() : '',
        slot_path: diagnosis ? String(diagnosis.slot_path || '').trim() : '',
        subject_focus: diagnosis ? String(diagnosis.subject_focus || '').trim() : '',
        subject_entities: diagnosis ? (Array.isArray(diagnosis.subject_entities) ? diagnosis.subject_entities.slice() : []) : [],
        subject_confidence: diagnosis ? String(diagnosis.subject_confidence || '').trim() : '低',
        perspective_risk: diagnosis ? String(diagnosis.perspective_risk || '').trim() : '低',
        perspective_markers: diagnosis ? (Array.isArray(diagnosis.perspective_markers) ? diagnosis.perspective_markers.slice() : []) : [],
        depron_hint: diagnosis ? String(diagnosis.depron_hint || '').trim() : '',
        leaf_repair_needed: diagnosis ? !!diagnosis.leaf_repair_needed : false,
        action: diagnosis ? diagnosis.action : 'observe',
        action_label: diagnosis ? diagnosis.action_label : '先观察',
        confidence: diagnosis ? diagnosis.confidence : '低',
        ai_review_needed: diagnosis ? h.sqlGrowthNeedsAiReview(diagnosis) : false,
        ai_review_priority: diagnosis ? h.sqlGrowthAiPriority(diagnosis) : 'low',
        display_badge: diagnosis ? h.sqlGrowthDisplayBadge(diagnosis) : h.sqlGrowthDisplayBucket({ type_key: typeKey }),
        placement_hint: diagnosis ? String(diagnosis.placement_hint || '').trim() : '',
        root_key: rootKey,
        can_root: Boolean(rootKey && diagnosis && diagnosis.action === 'promote_a'),
        first_seen_at: group.firstSeen || '',
        last_seen_at: group.lastSeen || '',
        evidence_set: {
          batches: h.sqlGrowthUniqueStrings(Array.from(evidence.batches)),
          windows: h.sqlGrowthUniqueStrings(Array.from(evidence.windows)),
          topics: h.sqlGrowthUniqueStrings(Array.from(evidence.topics)),
          families: h.sqlGrowthUniqueStrings(Array.from(evidence.families)),
          source_refs: h.sqlGrowthUniqueStrings(Array.from(evidence.source_refs), 20)
        },
        stable_fact_candidates: h.sqlGrowthUniqueStrings(rows.flatMap((row) => h.sqlGrowthStableFactTokens(row.stable_points)), 8),
        batch_hits: batchHits,
        source_rows: rows.length
      };
    });
  }

  function buildWritebackDemo(placementRecords, helpers) {
    const h = helpers || {};
    const roots = [];
    const rootMap = new Map();
    (placementRecords || [])
      .filter((record) => record && record.can_root && record.root_key)
      .sort((a, b) => {
        const firstA = String(a.first_seen_at || '').trim();
        const firstB = String(b.first_seen_at || '').trim();
        if (firstA !== firstB) return firstA.localeCompare(firstB);
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
            tree_path: `trunk/${record.anchor_type}/${h.sqlGrowthNormalizeTreePathSegment(record.canonical_name)}`,
            anchor_type: record.anchor_type,
            canonical_name: record.canonical_name,
            candidate_trunk: record.candidate_trunk,
            candidate_secondary_slot: record.candidate_secondary_slot,
            slot_path: record.slot_path,
            slot_owner_hint: record.slot_owner_hint,
            subject_focus: record.subject_focus || '',
            subject_entities: Array.isArray(record.subject_entities) ? record.subject_entities.slice(0, 8) : [],
            subject_confidence: record.subject_confidence || '低',
            perspective_risk: record.perspective_risk || '低',
            perspective_markers: Array.isArray(record.perspective_markers) ? record.perspective_markers.slice(0, 8) : [],
            depron_hint: record.depron_hint || '',
            first_seen_at: seed.first_seen_at || record.first_seen_at || '',
            last_seen_at: seed.last_seen_at || record.last_seen_at || '',
            version_count: 1,
            evolution_status: hits.length > 1 ? 'updated' : (record.stable_fact_candidates.length ? 'stable' : 'volatile'),
            stable_facts: h.sqlGrowthUniqueStrings(seed.stable_facts.length ? seed.stable_facts : record.stable_fact_candidates, 6),
            recent_updates: [],
            source_batches: [seed.batch],
            source_refs: h.sqlGrowthUniqueStrings(seed.source_refs, 20),
            source_windows: h.sqlGrowthUniqueStrings(seed.source_windows, 20),
            topic_ids: h.sqlGrowthUniqueStrings(seed.topics, 20),
            persona_refs: h.sqlGrowthUniqueStrings(seed.families.length ? seed.families : record.evidence_set.families, 8),
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
          const incomingStable = h.sqlGrowthUniqueStrings(hit.stable_facts, 6);
          const rootStableNorm = new Set((root.stable_facts || []).map((item) => h.normalizeCompact(item)));
          const hasConflict = incomingStable.length > 0
            && root.stable_facts.length > 0
            && !incomingStable.some((item) => rootStableNorm.has(h.normalizeCompact(item)));
          const updateEntry = {
            batch: hit.batch,
            first_seen_at: hit.first_seen_at || '',
            last_seen_at: hit.last_seen_at || '',
            summaries: h.sqlGrowthUniqueStrings(hit.summaries, 3),
            stable_facts: incomingStable,
            source_refs: h.sqlGrowthUniqueStrings(hit.source_refs, 12),
            source_windows: h.sqlGrowthUniqueStrings(hit.source_windows, 12),
            topics: h.sqlGrowthUniqueStrings(hit.topics, 12),
            persona_refs: h.sqlGrowthUniqueStrings(hit.families, 6),
            conflict_hint: hasConflict
          };
          root.recent_updates.push(updateEntry);
          root.branch_count += 1;
          root.version_count += 1;
          root.last_seen_at = h.pickLaterDate(root.last_seen_at, hit.last_seen_at || hit.first_seen_at || '');
          root.source_batches = h.sqlGrowthUniqueStrings(root.source_batches.concat(hit.batch));
          root.source_refs = h.sqlGrowthUniqueStrings(root.source_refs.concat(hit.source_refs), 24);
          root.source_windows = h.sqlGrowthUniqueStrings(root.source_windows.concat(hit.source_windows), 24);
          root.topic_ids = h.sqlGrowthUniqueStrings(root.topic_ids.concat(hit.topics), 24);
          root.persona_refs = h.sqlGrowthUniqueStrings(root.persona_refs.concat(hit.families), 10);
          if (hasConflict) {
            root.conflict_hint = true;
          } else if (incomingStable.length) {
            root.stable_facts = h.sqlGrowthUniqueStrings(root.stable_facts.concat(incomingStable), 8);
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

  window.SqlGrowthCore = {
    buildPlacementRecords,
    buildWritebackDemo
  };
})();
