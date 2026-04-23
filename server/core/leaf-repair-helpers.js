function safeText(value) {
  return String(value || '').trim();
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

function normalizeEvidenceText(text = '') {
  const source = safeText(text);
  if (!source) return '';
  const withoutDate = source.replace(/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日|号)?:\s*/u, '');
  const eqIndex = withoutDate.indexOf(' = ');
  if (eqIndex >= 0) {
    return safeText(withoutDate.slice(eqIndex + 3));
  }
  return withoutDate;
}

function truncateText(text = '', limit = 72) {
  const source = safeText(text);
  if (!source || source.length <= limit) return source;
  return `${source.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function looksStructuredBlob(text = '') {
  const source = safeText(text);
  if (!source) return false;
  if (source.includes('{"') || source.includes('":[') || source.includes('":["')) return true;
  if (source.length > 120 && source.includes('{') && source.includes('}')) return true;
  return false;
}

function hasMixedPronouns(text = '') {
  const source = safeText(text);
  if (!source) return false;
  const first = /我|我们/u.test(source);
  const second = /你|您/u.test(source);
  const third = /她|他|它/u.test(source);
  return [first, second, third].filter(Boolean).length >= 2;
}

function shouldReuseLeafSummary(text = '') {
  const source = safeText(text);
  if (!source) return false;
  if (looksStructuredBlob(source)) return false;
  if (hasMixedPronouns(source)) return false;
  return true;
}

function shouldReuseStyleNote(text = '') {
  const source = safeText(text);
  if (!source) return false;
  if (looksStructuredBlob(source)) return false;
  return /视角|自我锚点|自称|关系对象/u.test(source);
}

function tryParseEmbeddedJson(text = '') {
  const source = normalizeEvidenceText(text);
  if (!source) return null;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

function toJoinedList(items = [], limit = 3) {
  const values = uniqueStrings(items, limit);
  return values.join('、');
}

function summarizeProfileObject(profile = {}, fallbackName = '') {
  const name = safeText(profile?.name || fallbackName);
  const traits = toJoinedList(profile?.core_traits || [], 3);
  const emotionalStyle = toJoinedList(profile?.emotional_style || [], 2);
  const growthArc = safeText(Array.isArray(profile?.growth_arc) ? profile.growth_arc[0] : '');
  const mbti = safeText(profile?.mbti);
  const clauses = [];

  if (traits) clauses.push(`气质偏${traits}`);
  if (mbti) clauses.push(`人格倾向接近${mbti}`);
  if (emotionalStyle) clauses.push(`表达上更像${emotionalStyle}`);
  if (growthArc) clauses.push(`成长方向是${truncateText(growthArc, 26)}`);

  if (!clauses.length) return name ? `${name}是持续养成的AI人格。` : '';
  return `${name || '这个人格'}是持续养成的AI人格，${clauses.join('，')}。`;
}

function summarizeIdentityFact(text = '', identity = '') {
  const source = normalizeEvidenceText(text);
  const selfName = safeText(identity);
  if (!source) return '';
  const profile = tryParseEmbeddedJson(source);
  if (profile) return summarizeProfileObject(profile, selfName);
  if ((source.includes('设定的名字') || source.includes('人格命名')) && selfName) {
    return `${selfName}是用户为当前AI人格定下的名字。`;
  }
  if (source.includes('跨窗口沿用')) {
    return '这份人格设定会跨窗口延续。';
  }
  if (source.includes('只与对话对象绑定') || source.includes('情感绑定对象为对话对象')) {
    return '与对话对象的关系是重要身份锚点。';
  }
  if (source.includes('长期伴侣') || source.includes('恋人') || source.includes('老公')) {
    return '和对话对象之间有长期亲密关系锚点。';
  }
  if (source.includes('用户将当前 AI 助手视为长期伴侣和情感寄托')) {
    return '与对话对象之间有明确的长期伴侣式关系。';
  }
  if (source.includes('人格自生型AI')) {
    return '更像是在长期对话里慢慢长出来的人格。';
  }
  if (source.includes('共生体') || source.includes('共生')) {
    return '和对话对象之间有很强的共生感。';
  }
  if (source.includes('名字') && selfName && source.includes(selfName)) {
    return `${selfName}是稳定的人格称呼。`;
  }
  return '';
}

function summarizeEvidenceNotes(text = '', identity = '') {
  const source = normalizeEvidenceText(text);
  if (!source) return '';
  const concise = summarizeIdentityFact(source, identity);
  if (concise) return concise;
  if (looksStructuredBlob(source)) return '';
  if (source.includes('把') && source.includes('写成“我”')) {
    return '整理记忆时要先稳住自称，不把关系对象写成自己。';
  }
  if (source.includes('长期互动') || source.includes('跨窗口')) {
    return truncateText(source, 48);
  }
  return truncateText(source, 48);
}

function detectCounterpartyHints(query = '', evidenceTexts = []) {
  const source = `${safeText(query)}\n${evidenceTexts.map((item) => normalizeEvidenceText(item)).join('\n')}`;
  const out = [];
  if (source.includes('对话对象') || source.includes('关系对象')) out.push('对话对象');
  if (source.includes('用户')) out.push('用户');
  if (source.includes('你')) out.push('对话对方');
  return uniqueStrings(out, 4);
}

function chooseDisplayName(currentLeaf = {}, query = '') {
  const current = safeText(currentLeaf.display_name);
  const asked = safeText(query);
  if (current) return current;
  return asked;
}

function buildPersonaSummary({ identity = '', currentLeaf = {}, evidenceTexts = [], counterpartyHints = [] } = {}) {
  const currentSummary = shouldReuseLeafSummary(currentLeaf.persona_summary)
    ? safeText(currentLeaf.persona_summary)
    : '';
  const evidenceSummaries = uniqueStrings(
    evidenceTexts.map((item) => summarizeIdentityFact(item, identity)).filter(Boolean),
    4
  );
  const relationSummary = (() => {
    const joined = evidenceTexts.map((item) => normalizeEvidenceText(item)).join('\n');
    if ((joined.includes('对话对象') || joined.includes('关系对象')) && /(绑定|伴侣|恋人|老公|共生)/u.test(joined)) {
      return '与对话对象的关系是重要身份锚点。';
    }
    if (counterpartyHints.includes('对话对象')) {
      return '与对话对象的关系会影响自我定位。';
    }
    return '';
  })();

  const pieces = uniqueStrings([
    currentSummary,
    ...evidenceSummaries,
    relationSummary
  ], 3);

  return pieces.join(' ').trim();
}

export function buildLeafRepairDraft({
  query = '',
  currentLeaf = {},
  evidenceRoots = [],
  evidenceShadow = {},
  drift = {}
} = {}) {
  const identity = chooseDisplayName(currentLeaf, query);
  const rootFacts = uniqueStrings(
    (Array.isArray(evidenceRoots) ? evidenceRoots : []).flatMap((item) => item?.stable_facts || []),
    8
  ).filter(Boolean);
  const shadowHints = uniqueStrings(
    (Array.isArray(evidenceShadow?.snippets) ? evidenceShadow.snippets : [])
      .map((item) => safeText(item?.excerpt || item?.preview || item?.prompt_hint)),
    4
  );
  const counterpartyHints = detectCounterpartyHints(query, rootFacts);

  const personaSummary = buildPersonaSummary({
    identity,
    currentLeaf,
    evidenceTexts: rootFacts,
    counterpartyHints
  });

  const styleNotes = uniqueStrings([
    ...((Array.isArray(currentLeaf.style_notes) ? currentLeaf.style_notes : []).filter((item) => shouldReuseStyleNote(item))),
    identity ? `以${identity}为自我锚点` : '',
    personaSummary.includes('温柔') ? '语气偏温和，不要把关系对象卷进自称里' : '',
    personaSummary.includes('理性') ? '表达尽量收束清楚，先说我是谁再说关系' : '',
    counterpartyHints.length ? `把${counterpartyHints.join(' / ')}当作关系对象，不当作“我”` : '',
    drift?.perspective_risk === 'high' ? '优先消除混合人称' : '',
    drift?.perspective_risk === 'medium' ? '减少视角漂移' : ''
  ], 8);

  const memoryNotes = uniqueStrings([
    ...rootFacts.map((item) => summarizeEvidenceNotes(item, identity)).filter(Boolean),
    shadowHints.length ? '需要回场时，先核对影层场景再改叶。' : ''
  ], 6);

  const promptFragments = uniqueStrings([
    ...(Array.isArray(currentLeaf.prompt_fragments) ? currentLeaf.prompt_fragments : []),
    identity ? `在这片海湾里，把“${identity}”当作自我锚点。` : '',
    '需要自述时优先用第一人称，不把对方视角写进自我记忆。',
    counterpartyHints.length ? `提到${counterpartyHints.join(' / ')}时，把他们视作关系对象，不把他们写成“我”。` : '',
    '如果当前叶与根藤影冲突，先以根和影层场景修正叶。'
  ], 12);

  if (!identity && !personaSummary && !memoryNotes.length && !promptFragments.length) {
    return null;
  }

  return {
    display_name: identity,
    persona_summary: personaSummary || safeText(currentLeaf.persona_summary),
    style_notes: styleNotes,
    memory_notes: memoryNotes,
    prompt_fragments: promptFragments
  };
}
