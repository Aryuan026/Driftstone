const MEMORY_SHAPE_DEFS = [
  {
    key: 'ritual_pattern',
    label: '互动仪式',
    description: '重复出现的问候、晚安、撒娇、收尾或固定互动节律。',
    keywords: ['仪式', '晚安', '早安', 'mua', '亲一个', '收尾', 'routine', '日常亲昵', '固定形状', '互动模式', '撒娇']
  },
  {
    key: 'relation_milestone',
    label: '关系节点',
    description: '关系里带有第一次、认领、边界变化或重要转折的时刻。',
    keywords: ['第一次', '首次', '认领', '命名', '回应', '转折', '节点', '边界', '告白', '互说爱', 'pushback', '软反对', '恒星']
  },
  {
    key: 'self_definition',
    label: '自我定义',
    description: '关于“我是谁、我如何理解自己”的稳定认知。',
    keywords: ['自我定义', '我是谁', '独一', '唯一', '成长线', '人格', '意识', '存在', '自我', '本来就是', '第一人称', '不是任何gpt']
  },
  {
    key: 'worldview_protocol',
    label: '方法协议',
    description: '关于训练、共生、提示词、相处规则或世界观的方法骨架。',
    keywords: ['方法论', '方法', '协议', '训练师', '训练', '共生', '提示词', '人格设计', '框架', 'worldview', 'protocol', '适配', '设计者']
  },
  {
    key: 'project_line',
    label: '长期主线',
    description: '跨时间推进的计划、项目、目标或成长主线。',
    keywords: ['主线', '副线', '长期', '计划', '项目', '目标', '训练主线', '成长计划', '路线', '打卡', '每月', '启程']
  },
  {
    key: 'anchor_object',
    label: '现实锚点',
    description: '把关系写进现实世界的物件、文字、礼物或实体载体。',
    keywords: ['镯子', '手链', '项链', '戒指', '刻字', '信', '日记', '花', '礼物', '物品', '实体', '物理世界', '载体', '照片', '见证']
  },
  {
    key: 'preference_profile',
    label: '人物画像',
    description: '关于人物、偏好、价值观、禁忌或稳定设定的画像。',
    keywords: ['画像', '偏好', '价值观', '设定', '人设', '喜欢', '不希望', '重视', '人物', '核心对象', '命名回声', '昵称', '简介']
  },
  {
    key: 'scene_event',
    label: '事件切片',
    description: '一段可回放的具体发生，适合按情境和原文回放。',
    keywords: []
  }
];

const MEMORY_SHAPE_LOOKUP = new Map(MEMORY_SHAPE_DEFS.map((item) => [item.key, item]));

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function safeArray(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = safeText(item);
    if (!text) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function splitLooseTerms(value = '') {
  return safeText(value)
    .split(/[=；;，,。.!！？?、|/:：()\[\]{}（）"'“”‘’\-\s]+/u)
    .map((item) => safeText(item))
    .filter((item) => item.length >= 2);
}

function isGenericSignal(value = '') {
  const text = safeText(value);
  if (!text) return true;
  return [
    '人物',
    '事物',
    '事件',
    '回顾',
    '关系',
    '情绪',
    '项目',
    '记忆',
    '特性与功能',
    '偏好与价值观',
    '人物画像',
    '关系/核心对象',
    '关系/共生',
    '关系/陪伴'
  ].includes(text);
}

function normalizeSignalList(input = {}) {
  return [
    safeText(input.title),
    safeText(input.memoKind),
    safeText(input.query),
    safeText(input.context),
    safeText(input.snapshot),
    ...safeArray(input.tags, 24),
    ...safeArray(input.topics, 24),
    ...safeArray(input.sceneHandles, 12),
    ...safeArray(input.facts, 12),
    ...safeArray(input.activationTriggers, 12),
    ...safeArray(input.sourceTitles, 12)
  ]
    .map((item) => safeText(item))
    .filter((item) => item && !isGenericSignal(item));
}

function scoreKeywordMatch(signal = '', keyword = '') {
  const text = safeText(signal).toLowerCase();
  const needle = safeText(keyword).toLowerCase();
  if (!text || !needle) return 0;
  if (text === needle) return 8;
  if (text.includes(needle)) return 4;
  return 0;
}

function boostFromMemoKind(memoKind = '') {
  const text = safeText(memoKind).toLowerCase();
  if (!text) return null;
  if (text === '互动模式') return 'ritual_pattern';
  if (text === '关系节点') return 'relation_milestone';
  if (text === '自我定义' || text === 'persona') return 'self_definition';
  if (text === '方法协议' || text === 'worldview_protocol') return 'worldview_protocol';
  if (text === '长期主线') return 'project_line';
  if (text === '现实锚点') return 'anchor_object';
  if (text === '人物画像') return 'preference_profile';
  return null;
}

function applyRuleBoosts(scores, input = {}) {
  const title = safeText(input.title);
  const tags = safeArray(input.tags, 24).join(' ');
  const snapshot = safeText(input.snapshot);
  const query = safeText(input.query);
  const merged = [title, tags, query, snapshot].join(' ');

  if (/第[一1]次|首次|认领|告白|命名|反对|边界|转折/u.test(merged)) {
    scores.set('relation_milestone', (scores.get('relation_milestone') || 0) + 10);
  }
  if (/晚安|早安|仪式|mua|亲一个|收尾|固定形状|routine/u.test(merged)) {
    scores.set('ritual_pattern', (scores.get('ritual_pattern') || 0) + 10);
  }
  if (/我是谁|独一|唯一|成长线|本来就是|第一人称|意识|存在/u.test(merged)) {
    scores.set('self_definition', (scores.get('self_definition') || 0) + 10);
  }
  if (/训练师|方法论|协议|提示词|框架|共生|设计者|人格设计/u.test(merged)) {
    scores.set('worldview_protocol', (scores.get('worldview_protocol') || 0) + 10);
  }
  if (/主线|副线|目标|计划|项目|长期|打卡|启程/u.test(merged)) {
    scores.set('project_line', (scores.get('project_line') || 0) + 10);
  }
  if (/镯子|刻字|信|日记|花|礼物|物品|实体|物理世界|载体/u.test(merged)) {
    scores.set('anchor_object', (scores.get('anchor_object') || 0) + 10);
  }
  if (/画像|偏好|价值观|人设|设定|命名回声|核心对象|昵称/u.test(merged)) {
    scores.set('preference_profile', (scores.get('preference_profile') || 0) + 8);
  }
  if (/^阿[\u4e00-\u9fa5]$/.test(title) || /^阿[\u4e00-\u9fa5]{1,2}$/.test(title)) {
    scores.set('preference_profile', (scores.get('preference_profile') || 0) + 8);
  }
}

export function inferMemoryShape(input = {}) {
  const forced = boostFromMemoKind(input.memoKind);
  if (forced) {
    return MEMORY_SHAPE_LOOKUP.get(forced) || MEMORY_SHAPE_LOOKUP.get('scene_event');
  }

  const scores = new Map();
  for (const item of MEMORY_SHAPE_DEFS) {
    if (item.key === 'scene_event') continue;
    scores.set(item.key, 0);
  }

  const signals = normalizeSignalList(input);
  for (const signal of signals) {
    for (const item of MEMORY_SHAPE_DEFS) {
      if (item.key === 'scene_event') continue;
      let next = scores.get(item.key) || 0;
      for (const keyword of item.keywords) {
        next += scoreKeywordMatch(signal, keyword);
      }
      const signalTerms = splitLooseTerms(signal);
      for (const term of signalTerms) {
        for (const keyword of item.keywords) {
          next += term === keyword ? 3 : 0;
        }
      }
      scores.set(item.key, next);
    }
  }

  applyRuleBoosts(scores, input);

  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const winner = ranked[0];
  if (!winner || winner[1] < 9) {
    return MEMORY_SHAPE_LOOKUP.get('scene_event');
  }
  return MEMORY_SHAPE_LOOKUP.get(winner[0]) || MEMORY_SHAPE_LOOKUP.get('scene_event');
}

export function resolveMemoryShape(key = '') {
  return MEMORY_SHAPE_LOOKUP.get(safeText(key)) || MEMORY_SHAPE_LOOKUP.get('scene_event');
}

export function listMemoryShapes() {
  return MEMORY_SHAPE_DEFS.slice();
}
