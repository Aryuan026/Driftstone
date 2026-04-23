export function normalizeCompact(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').trim();
}

export function normalizeAnchorType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw === 'person' || raw.includes('人物')) return 'person';
  if (raw === 'thing' || raw.includes('事物')) return 'thing';
  if (raw === 'event' || raw.includes('事件')) return 'event';
  if (raw === 'rule' || raw.includes('规则')) return 'rule';
  if (raw === 'time' || raw.includes('时间')) return 'time';
  return 'unknown';
}

export function sqlGrowthDisplayBucket(typeKey) {
  if (typeKey === 'person') return '人物';
  if (typeKey === 'thing') return '事物';
  if (typeKey === 'event') return '事件';
  if (typeKey === 'rule') return '规则';
  return '待归位';
}

export function splitSqlGrowthTokens(value) {
  return String(value || '')
    .split(/[|,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function sqlGrowthUniqueStrings(values, limit = 999) {
  const out = [];
  const seen = new Set();
  (Array.isArray(values) ? values : []).forEach((value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const key = normalizeCompact(text);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  });
  return out.slice(0, limit);
}

export function normalizeDateLiteral(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const m = text.match(/^(20\d{2})[\/.-年](\d{1,2})(?:[\/.-月](\d{1,2}))?/);
  if (!m) return text;
  const year = m[1];
  const month = String(Number(m[2])).padStart(2, '0');
  const day = m[3] ? String(Number(m[3])).padStart(2, '0') : '01';
  return `${year}-${month}-${day}`;
}

export function sqlGrowthDateValue(value) {
  return normalizeDateLiteral(value) || String(value || '').trim();
}

export function pickEarlierDate(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return String(a).localeCompare(String(b)) <= 0 ? a : b;
}

export function pickLaterDate(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return String(a).localeCompare(String(b)) >= 0 ? a : b;
}

export function sqlGrowthNormalizeTreePathSegment(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[\/\\]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unnamed';
}

export function sqlGrowthStableFactTokens(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return sqlGrowthUniqueStrings(
    text
      .split(/\s*\|\s*|\n+/)
      .map((item) => item.trim())
      .filter(Boolean),
    8
  );
}

export function sqlGrowthSummaryText(row) {
  return String(
    row?.summary
    || row?.content_text
    || row?.text
    || row?.stable_points
    || row?.update_points
    || row?.title
    || row?.card_name
    || ''
  ).trim();
}

export function isPlainDateName(name) {
  const text = String(name || '').trim();
  if (!text) return false;
  return /^(\d{4}[-/.年]\d{1,2}([-.\/月]\d{1,2}日?)?|\d{4}年\d{1,2}月(\d{1,2}日)?|\d{1,2}月\d{1,2}日)$/.test(text);
}

export function isGenericName(name) {
  const compact = normalizeCompact(name);
  if (!compact) return true;
  const generic = [
    '感觉', '感受', '重要', '修改', '变化', '记录', '事件', '关系', '规则',
    '偏好', '状态', '情况', '内容', '信息', '想法', '问题', '体验', '东西'
  ];
  if (isPlainDateName(name)) return true;
  return generic.some((word) => {
    const normalized = normalizeCompact(word);
    return compact === normalized || compact.startsWith(normalized);
  });
}
