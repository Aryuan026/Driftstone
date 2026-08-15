function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hashString(text = '') {
  let hash = 2166136261;
  const src = String(text || '');
  for (let i = 0; i < src.length; i += 1) {
    hash ^= src.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function between(seed, min, max) {
  const ratio = (seed % 10000) / 10000;
  return min + (max - min) * ratio;
}

function normalizeCardType(value = '') {
  const text = safeText(value, 'memo').toLowerCase();
  if (['family', 'fact', 'case', 'memo'].includes(text)) return text;
  return 'memo';
}

function collectMapCards(snapshot = {}) {
  const drafts = Array.isArray(snapshot?.growth_drafts?.drafts) ? snapshot.growth_drafts.drafts : [];
  const staged = Array.isArray(snapshot?.staging_cards?.cards) ? snapshot.staging_cards.cards : [];
  const seen = new Set();
  const allCards = [];

  drafts.forEach((item) => {
    const title = safeText(item?.title, '未命名温记忆草稿');
    const cardType = normalizeCardType(item?.card_type);
    const key = `draft::${safeText(item?.artifact_id, `${title}:${cardType}`)}`;
    if (seen.has(key)) return;
    seen.add(key);
    allCards.push({
      id: safeText(item?.artifact_id, key),
      title,
      card_type: cardType,
      source: 'draft',
      importance: safeText(item?.importance, 'draft'),
      stamp: safeText(item?.generated_at)
    });
  });

  staged.forEach((item) => {
    const title = safeText(item?.title, '未命名温记忆卡');
    const cardType = normalizeCardType(item?.card_type);
    const key = `staged::${safeText(item?.file_path, `${title}:${cardType}`)}`;
    if (seen.has(key)) return;
    seen.add(key);
    allCards.push({
      id: safeText(item?.file_path, key),
      title,
      card_type: cardType,
      source: 'staged',
      importance: safeText(item?.importance, 'normal'),
      stamp: safeText(item?.updated_at)
    });
  });

  return allCards
    .sort((a, b) => String(b.stamp || '').localeCompare(String(a.stamp || '')))
    .slice(0, 64);
}

export function buildMemoryStarMapModel(snapshot = {}) {
  const cards = collectMapCards(snapshot);
  const root = { x: 480, y: 238, r: 5.4 };
  const anchors = {
    memo: { x: 278, y: 154, radius: 136, label: '温记忆卡' },
    family: { x: 318, y: 332, radius: 110, label: '人格线索' },
    fact: { x: 684, y: 156, radius: 112, label: '证据事实' },
    case: { x: 720, y: 324, radius: 104, label: '复核轨迹' }
  };

  const grouped = new Map();
  cards.forEach((item) => {
    const key = anchors[item.card_type] ? item.card_type : 'memo';
    const list = grouped.get(key) || [];
    list.push(item);
    grouped.set(key, list);
  });

  const hubs = Object.entries(anchors)
    .map(([cardType, anchor]) => ({
      id: `${cardType}-hub`,
      card_type: cardType,
      label: anchor.label,
      x: anchor.x,
      y: anchor.y,
      r: Math.max(3.4, 3.4 + ((grouped.get(cardType)?.length || 0) * 0.16))
    }))
    .filter((item) => (grouped.get(item.card_type)?.length || 0) > 0);

  const stars = [];
  hubs.forEach((hub) => {
    const anchor = anchors[hub.card_type];
    const list = grouped.get(hub.card_type) || [];
    list.forEach((item, index) => {
      const seed = hashString(`${item.id}::${index}`);
      const angle = ((seed % 360) + index * 37) * (Math.PI / 180);
      const radius = between(seed >>> 1, 24, anchor.radius);
      stars.push({
        id: item.id,
        title: item.title,
        source: item.source,
        card_type: hub.card_type,
        importance: item.importance,
        x: Math.round(anchor.x + Math.cos(angle) * radius),
        y: Math.round(anchor.y + Math.sin(angle) * radius),
        r: item.importance === 'major' ? 4.2 : item.source === 'draft' ? 3.3 : 2.55,
        parent: hub.id
      });
    });
  });

  const starById = new Map(stars.map((star) => [star.id, star]));
  const explicitEdges = (Array.isArray(snapshot?.explicit_relationships?.edges)
    ? snapshot.explicit_relationships.edges
    : [])
    .map((edge) => {
      const from = starById.get(safeText(edge?.from_id));
      const to = starById.get(safeText(edge?.to_id));
      if (!from || !to) return null;
      return {
        from,
        to,
        kind: safeText(edge?.kind, 'explicit_relationship')
      };
    })
    .filter(Boolean);

  const ambientCount = Math.min(260, 64 + cards.length * 4);
  const ambient = Array.from({ length: ambientCount }).map((_, index) => {
    const seed = hashString(`ambient::${cards.length}::${index}`);
    return {
      x: Math.round(between(seed, 12, 948)),
      y: Math.round(between(seed >>> 1, 12, 464)),
      r: between(seed >>> 2, 0.45, 1.9),
      a: between(seed >>> 3, 0.12, 0.72)
    };
  });

  return {
    root,
    hubs,
    stars,
    explicitEdges,
    ambient,
    counts: {
      draft: cards.filter((item) => item.source === 'draft').length,
      committed: cards.filter((item) => item.source === 'staged').length,
      memo: cards.filter((item) => item.card_type === 'memo').length,
      family: cards.filter((item) => item.card_type === 'family').length,
      fact: cards.filter((item) => item.card_type === 'fact').length,
      case: cards.filter((item) => item.card_type === 'case').length
    },
    total: cards.length
  };
}

export function renderMemoryStarMap({
  visualEl,
  statusEl,
  snapshot = {},
  workspace = {},
  errorText = ''
} = {}) {
  if (!visualEl || !statusEl) return;

  const graph = buildMemoryStarMapModel(snapshot);
  const activeScope = snapshot?.active_scope || null;
  let label = '待开始';
  let tone = 'stable';
  if (errorText) {
    label = '未连接';
    tone = 'stable';
  } else if (snapshot?.demo?.synthetic) {
    label = '演示星图';
    tone = 'live';
  } else if (graph.total) {
    label = '运行中';
    tone = 'live';
  } else if (activeScope) {
    label = '已连接范围';
    tone = 'stable';
  }
  statusEl.textContent = label;
  statusEl.className = `status-pill ${tone}`;

  const ambient = graph.ambient.map((item) => `
    <circle class="front-growth-ambient" cx="${item.x}" cy="${item.y}" r="${item.r}" opacity="${item.a}"></circle>
  `).join('');
  const visualAffinityLinks = graph.stars.map((item) => {
    const parent = graph.hubs.find((hub) => hub.id === item.parent) || graph.root;
    return `<line class="front-growth-link affinity ${item.source === 'draft' ? 'active' : ''}" x1="${parent.x}" y1="${parent.y}" x2="${item.x}" y2="${item.y}"></line>`;
  }).join('');
  const canonicalLinks = graph.explicitEdges.map((edge) => `
    <line class="front-growth-link canonical" x1="${edge.from.x}" y1="${edge.from.y}" x2="${edge.to.x}" y2="${edge.to.y}">
      <title>${escapeHtml(edge.kind)}</title>
    </line>
  `).join('');
  const hubs = graph.hubs.map((hub) => `
    <circle class="front-growth-node hub ${hub.card_type}" cx="${hub.x}" cy="${hub.y}" r="${hub.r}">
      <title>${escapeHtml(hub.label)}</title>
    </circle>
  `).join('');
  const stars = graph.stars.map((item) => `
    <circle class="front-growth-node star ${item.card_type} ${item.source === 'draft' ? 'active' : 'stable'} ${item.importance === 'major' ? 'major' : ''}" cx="${item.x}" cy="${item.y}" r="${item.r}">
      <title>${escapeHtml(item.title)}</title>
    </circle>
  `).join('');
  const memoryName = snapshot?.demo?.synthetic ? '合成演示' : safeText(workspace.charName, '便携温记忆');
  const helperText = errorText
    ? escapeHtml(errorText)
    : snapshot?.demo?.synthetic
      ? '这些星点来自虚构素材。实线表示演示关系；虚线和距离只表示视觉亲近感。'
      : graph.total
      ? '星点是温记忆投影；附近的云雾只表示视觉亲近感，不代表真实关系边。'
      : '选择历史、运行提取后，温记忆卡会在这里变成可追溯的星点。';

  visualEl.innerHTML = `
    <div class="front-growth-shell">
      <svg class="front-growth-map" viewBox="0 0 960 480" role="img" aria-label="记忆星图">
        <defs>
          <radialGradient id="memoryMapGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="rgba(255,255,255,0.2)"></stop>
            <stop offset="100%" stop-color="rgba(255,255,255,0)"></stop>
          </radialGradient>
        </defs>
        <rect class="front-growth-bg" x="0" y="0" width="960" height="480" rx="28"></rect>
        ${ambient}
        <circle class="front-growth-glow" cx="${graph.root.x}" cy="${graph.root.y}" r="142"></circle>
        ${visualAffinityLinks}
        ${canonicalLinks}
        ${hubs}
        <circle class="front-growth-node root active" cx="${graph.root.x}" cy="${graph.root.y}" r="${graph.root.r}"></circle>
        ${stars}
      </svg>
      <div class="front-growth-overlay">
        <p class="front-growth-eyebrow">记忆星图</p>
        <div class="front-growth-caption">${escapeHtml(memoryName)}的星盘</div>
        <div class="front-growth-counts">
          <span>${graph.counts.committed} 已成卡</span>
          <span>${graph.counts.draft} 生长中</span>
          <span>${graph.counts.fact} 证据</span>
          <span>${graph.counts.case} 复核</span>
        </div>
        <div class="front-growth-hint">${helperText}</div>
      </div>
    </div>
  `;
}

export function renderMemoryRunDock({ dockEl, run = {} } = {}) {
  if (!dockEl) return;

  const tone = safeText(run.tone, 'stable');
  const progress = Math.max(0, Math.min(100, Number(run.progress || 0)));
  const steps = Array.isArray(run.steps) && run.steps.length
    ? run.steps
    : [
        { label: '选历史', state: 'current' },
        { label: '整理', state: 'pending' },
        { label: '复核', state: 'pending' },
        { label: '导出', state: 'pending' }
      ];
  const metrics = Array.isArray(run.metrics) ? run.metrics.slice(0, 4) : [];

  dockEl.dataset.tone = tone;
  dockEl.innerHTML = `
    <div class="memory-run-copy">
      <p class="memory-run-kicker">${escapeHtml(run.phaseLabel || '待开始')}</p>
      <h3>${escapeHtml(run.headline || '先选择一份历史素材。')}</h3>
      <p>${escapeHtml(run.detail || '先接住原文，再整理可审的温记忆和来源证据。')}</p>
    </div>
    <div class="memory-run-meter">
      <div class="memory-run-progress" aria-hidden="true">
        <span style="width: ${progress}%;"></span>
      </div>
      <span class="memory-run-percent">${Math.round(progress)}%</span>
    </div>
    <div class="memory-run-steps">
      ${steps.map((step) => `
        <span data-state="${escapeHtml(step.state || 'pending')}">${escapeHtml(step.label || '')}</span>
      `).join('')}
    </div>
    <a class="memory-run-details" href="${escapeHtml(run.detailsHref || '#workflowControls')}">${escapeHtml(run.detailsLabel || '查看步骤')}</a>
    ${metrics.length ? `
      <div class="memory-run-metrics">
        ${metrics.map((item) => `
          <span><strong>${escapeHtml(item.value || '0')}</strong>${escapeHtml(item.label || '')}</span>
        `).join('')}
      </div>
    ` : ''}
  `;
}
