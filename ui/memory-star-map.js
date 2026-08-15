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
    const title = safeText(item?.title, 'Untitled Warm draft');
    const cardType = normalizeCardType(item?.card_type);
    const key = `draft::${safeText(item?.artifact_id, `${title}:${cardType}`)}`;
    if (seen.has(key)) return;
    seen.add(key);
    allCards.push({
      id: safeText(item?.artifact_id, key),
      title,
      card_type: cardType,
      source: 'draft',
      stamp: safeText(item?.generated_at)
    });
  });

  staged.forEach((item) => {
    const title = safeText(item?.title, 'Untitled Warm card');
    const cardType = normalizeCardType(item?.card_type);
    const key = `staged::${safeText(item?.file_path, `${title}:${cardType}`)}`;
    if (seen.has(key)) return;
    seen.add(key);
    allCards.push({
      id: safeText(item?.file_path, key),
      title,
      card_type: cardType,
      source: 'staged',
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
    memo: { x: 278, y: 154, radius: 136, label: 'Warm cards' },
    family: { x: 318, y: 332, radius: 110, label: 'Persona cues' },
    fact: { x: 684, y: 156, radius: 112, label: 'Evidence facts' },
    case: { x: 720, y: 324, radius: 104, label: 'Review trails' }
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
        x: Math.round(anchor.x + Math.cos(angle) * radius),
        y: Math.round(anchor.y + Math.sin(angle) * radius),
        r: item.source === 'draft' ? 3.3 : 2.55,
        parent: hub.id
      });
    });
  });

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
  let label = 'Ready';
  let tone = 'stable';
  if (errorText) {
    label = 'Disconnected';
    tone = 'stable';
  } else if (graph.total) {
    label = 'Live map';
    tone = 'live';
  } else if (activeScope) {
    label = 'Scope linked';
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
  const hubs = graph.hubs.map((hub) => `
    <circle class="front-growth-node hub ${hub.card_type}" cx="${hub.x}" cy="${hub.y}" r="${hub.r}">
      <title>${escapeHtml(hub.label)}</title>
    </circle>
  `).join('');
  const stars = graph.stars.map((item) => `
    <circle class="front-growth-node star ${item.card_type} ${item.source === 'draft' ? 'active' : 'stable'}" cx="${item.x}" cy="${item.y}" r="${item.r}">
      <title>${escapeHtml(item.title)}</title>
    </circle>
  `).join('');
  const memoryName = safeText(workspace.charName, 'Portable Warm');
  const helperText = errorText
    ? escapeHtml(errorText)
    : graph.total
      ? 'Stars are durable Warm-card projections. Nearby nebulae show visual affinity, not canonical edges.'
      : 'Choose history, run extraction, then watch Warm cards appear as durable stars.';

  visualEl.innerHTML = `
    <div class="front-growth-shell">
      <svg class="front-growth-map" viewBox="0 0 960 480" role="img" aria-label="Memory Star Map">
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
        ${hubs}
        <circle class="front-growth-node root active" cx="${graph.root.x}" cy="${graph.root.y}" r="${graph.root.r}"></circle>
        ${stars}
      </svg>
      <div class="front-growth-overlay">
        <p class="front-growth-eyebrow">Memory Star Map</p>
        <div class="front-growth-caption">${escapeHtml(memoryName)} memory field</div>
        <div class="front-growth-counts">
          <span>${graph.counts.committed} committed</span>
          <span>${graph.counts.draft} forming</span>
          <span>${graph.counts.fact} evidence</span>
          <span>${graph.counts.case} review</span>
        </div>
        <div class="front-growth-hint">${helperText}</div>
      </div>
    </div>
  `;
}
