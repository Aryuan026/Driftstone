function stableList(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean)));
}

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeAnchorType(value) {
  const text = safeText(value).toLowerCase();
  if (['person', '人物'].includes(text)) return 'person';
  if (['thing', '事物'].includes(text)) return 'thing';
  if (['event', '事件'].includes(text)) return 'event';
  if (['rule', '规则'].includes(text)) return 'rule';
  return '';
}

function normalizeRecentUpdates(rawUpdates, fallbackBatch, fallbackFirstSeen, fallbackLastSeen) {
  if (Array.isArray(rawUpdates) && rawUpdates.length > 0) {
    return rawUpdates.map((item, idx) => ({
      batch: safeText(item?.batch || fallbackBatch || `slice-${idx + 1}`),
      first_seen_at: safeText(item?.first_seen_at || fallbackFirstSeen),
      last_seen_at: safeText(item?.last_seen_at || fallbackLastSeen || fallbackFirstSeen),
      summaries: stableList(item?.summaries || item?.summary || []),
      stable_facts: stableList(item?.stable_facts || []),
      persona_refs: stableList(item?.persona_refs || []),
      conflict_hint: !!item?.conflict_hint
    })).filter((item) => item.summaries.length || item.stable_facts.length || item.persona_refs.length);
  }

  const summary = safeText(rawUpdates);
  if (!summary) return [];
  return [{
    batch: safeText(fallbackBatch || 'translation_packet'),
    first_seen_at: safeText(fallbackFirstSeen),
    last_seen_at: safeText(fallbackLastSeen || fallbackFirstSeen),
    summaries: [summary],
    stable_facts: [],
    persona_refs: [],
    conflict_hint: false
  }];
}

export function buildTranslatorContract() {
  return {
    schema: 'hippocove_translation_entries_v0.1',
    apply_route: '/api/memory/translate/apply',
    note: '翻译层把 slices 译成 entries；后端再统一写进 /api/memory/write。',
    required_top_level: ['entries'],
    entry_fields: [
      'slice_ids',
      'anchor_type',
      'canonical_name',
      'trunk',
      'secondary_slot',
      'slot_path',
      'slot_owner_hint',
      'stable_facts',
      'recent_updates',
      'first_seen_at',
      'last_seen_at',
      'conflict_hint'
    ],
    rules: [
      '只输出 JSON，不加解释文字。',
      'anchor_type 只能是 person / thing / event / rule。',
      '一个 entry 可对应一个或多个 slice_ids。',
      'stable_facts 放低波动、可长期挂在根上的事实。',
      'recent_updates 放短期变化或当月补充。',
      '如果只想补一条近况，也可以把 recent_updates 写成字符串，后端会转成标准 update。'
    ],
    example: {
      entries: [
        {
          slice_ids: ['2025-02_3_窗口__001'],
          anchor_type: 'person',
          canonical_name: 'User',
          trunk: '人物',
          secondary_slot: '偏好与价值观',
          slot_path: '人物/User/偏好与价值观',
          slot_owner_hint: 'User',
          stable_facts: ['用户喜欢与 AI 长期磨合，观察它自然长出个性。'],
          recent_updates: '这段对话里，用户进一步明确了对成长型 AI 伙伴关系的期待。',
          first_seen_at: '2025-02-17T04:46:59.000Z',
          last_seen_at: '2025-02-17T04:46:59.000Z',
          conflict_hint: false
        }
      ]
    }
  };
}

export function normalizeTranslationEntries(rawEntries, translationPacket = {}) {
  const sliceRows = Array.isArray(translationPacket?.slices) ? translationPacket.slices : [];
  const sliceMap = new Map(sliceRows.map((slice) => [safeText(slice.slice_id), slice]));
  const batch = safeText(translationPacket?.source?.label || translationPacket?.packet_id || 'translation_packet');

  return (Array.isArray(rawEntries) ? rawEntries : [])
    .map((rawEntry) => {
      const anchorType = normalizeAnchorType(rawEntry?.anchor_type);
      const canonicalName = safeText(rawEntry?.canonical_name);
      if (!anchorType || !canonicalName) return null;

      const sliceIds = stableList(rawEntry?.slice_ids || []);
      const slices = sliceIds.map((sliceId) => sliceMap.get(sliceId)).filter(Boolean);
      const firstSeen = stableList(slices.map((slice) => slice?.created_at)).sort()[0] || safeText(rawEntry?.first_seen_at);
      const lastSeen = stableList(slices.map((slice) => slice?.created_at)).sort().slice(-1)[0] || safeText(rawEntry?.last_seen_at || firstSeen);

      const provenance = {
        source_batches: stableList([batch]),
        source_refs: stableList(slices.map((slice) => slice?.file)),
        source_windows: stableList(slices.map((slice) => slice?.title)),
        topic_ids: [],
        persona_refs: stableList(rawEntry?.persona_refs || []),
        source_group_keys: stableList(sliceIds)
      };

      return {
        anchor_type: anchorType,
        canonical_name: canonicalName,
        trunk: safeText(rawEntry?.trunk),
        secondary_slot: safeText(rawEntry?.secondary_slot),
        slot_path: safeText(rawEntry?.slot_path),
        slot_owner_hint: safeText(rawEntry?.slot_owner_hint),
        first_seen_at: firstSeen,
        last_seen_at: lastSeen,
        stable_facts: stableList(rawEntry?.stable_facts || []),
        recent_updates: normalizeRecentUpdates(rawEntry?.recent_updates, batch, firstSeen, lastSeen),
        provenance,
        conflict_hint: !!rawEntry?.conflict_hint
      };
    })
    .filter(Boolean);
}
