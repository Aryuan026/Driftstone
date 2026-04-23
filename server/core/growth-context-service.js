import { getMemoryContextPacket } from './memory-context-service.js';
import { getMemoryHomePacket } from './memory-home-service.js';
import { getPersonaWorkspaceSnapshot } from './persona-workspace-service.js';
import { getCardRegistrySnapshot } from './card-registry-service.js';
import { getGrowthLedgerSnapshot } from './growth-ledger-service.js';
import { listGrowthDraftArtifacts } from './growth-draft-store.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function clipText(text, limit = 240) {
  const safe = String(text || '').replace(/\s+/g, ' ').trim();
  if (!safe) return '';
  if (safe.length <= limit) return safe;
  return `${safe.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function splitLines(text, limit = 6) {
  return String(text || '')
    .split(/\n+/)
    .map((item) => safeText(item))
    .filter(Boolean)
    .slice(0, limit);
}

function buildFingerprintCandidatePreview(text = '') {
  const lines = splitLines(text, 18);
  const kept = lines.filter((line) => {
    return !/^当前主角[:：]/.test(line)
      && !/^关系核心[:：]/.test(line)
      && !/^Persona 缓存总量[:：]/.test(line)
      && !/^请把下面这些内容当成语言指纹候选池/.test(line);
  });
  return kept.slice(0, 10);
}

function inferMonthHints(value = '') {
  const text = String(value || '').trim();
  if (!text) return [];
  const dash = text.match(/(20\d{2})-(\d{2})/);
  if (dash) return [`${dash[1]}-${dash[2]}`];
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return [`${compact[1]}-${compact[2]}`];
  return [];
}

function summarizeWorkspaceSnapshot(snapshot = {}) {
  const state = snapshot?.state || {};
  return {
    char_name: safeText(state.char_name, 'Companion'),
    user_name: safeText(state.user_name, 'You'),
    persona_card: String(state.persona_card || '').trim(),
    language_fingerprint: String(state.language_fingerprint || '').trim(),
    fingerprint_candidate_pool: String(state.fingerprint_candidate_pool || '').trim(),
    persona_card_preview: clipText(state.persona_card, 240),
    language_fingerprint_preview: clipText(state.language_fingerprint, 240),
    fingerprint_candidate_preview: buildFingerprintCandidatePreview(state.fingerprint_candidate_pool),
    persona_cache_total: Number(snapshot?.persona_cache?.total_rows || 0),
    persona_cache_preview: Array.isArray(snapshot?.persona_cache?.preview) ? snapshot.persona_cache.preview : [],
    persona_cache_rows: Array.isArray(snapshot?.persona_cache?.context_rows) ? snapshot.persona_cache.context_rows : []
  };
}

function summarizeRegistrySnapshot(snapshot = {}) {
  return {
    total_cards: Number(snapshot?.summary?.total_cards || 0),
    by_type: Array.isArray(snapshot?.summary?.by_type) ? snapshot.summary.by_type : [],
    by_family: Array.isArray(snapshot?.summary?.by_family) ? snapshot.summary.by_family : [],
    recent_cards: Array.isArray(snapshot?.summary?.recent_cards) ? snapshot.summary.recent_cards : []
  };
}

function summarizeLedgerSnapshot(snapshot = {}) {
  return {
    total_entries: Number(snapshot?.summary?.total_entries || 0),
    by_decision: Array.isArray(snapshot?.summary?.by_decision) ? snapshot.summary.by_decision : [],
    last_entry_at: safeText(snapshot?.summary?.last_entry_at),
    recent_entries: Array.isArray(snapshot?.summary?.recent_entries) ? snapshot.summary.recent_entries : []
  };
}

function summarizeGrowthDrafts(snapshot = {}) {
  return {
    total: Number(snapshot?.total || 0),
    drafts: Array.isArray(snapshot?.drafts) ? snapshot.drafts : []
  };
}

function buildGrowthHints({
  workspace = {},
  cardRegistry = {},
  growthLedger = {},
  homePacket = {},
  contextPacket = null,
  growthDrafts = {},
  key = '',
  query = ''
} = {}) {
  const hints = [];
  if (!workspace.persona_card) hints.push('人格卡还没生成，先补 soul 草稿。');
  if (!workspace.language_fingerprint) hints.push('语言指纹还没整理，后面写卡容易掉回通用腔。');
  if (!workspace.persona_cache_total) hints.push('共享 Persona 缓存还是空的，先让旧工作台把工作台原料同步过来。');
  if (!Number(cardRegistry.total_cards || 0)) hints.push('卡片目录还是空的，后面每次写卡都会像第一次开工。');
  if (!Number(growthLedger.total_entries || 0)) hints.push('生长日志还是空的，下一张卡暂时还记不住刚刚做过的判断。');
  if (Number(cardRegistry.total_cards || 0) || Number(growthLedger.total_entries || 0)) {
    hints.push('判完一张卡之后，用 commit_growth_decision 一次把卡片目录和生长日志同时更新。');
  }
  if (Number(growthDrafts.total || 0)) {
    hints.push('最近草稿也在抽屉里，先翻一眼再下笔，别把刚写过的句子又端上来。');
  }
  if (!key && !query) hints.push('当前没有指定 root/query；这包更适合先做人格和缓存核对，不适合直接长具体卡。');
  if (homePacket?.home_state === 'translation_pending') hints.push('翻译任务板还有待跑任务，卡生长前最好先让原料层再往前走一段。');
  if (contextPacket?.ok) hints.push('memory context 已就位，后面可以直接按这包去判 new/update/merge。');
  return hints;
}

export async function getGrowthContextPacket({
  key = '',
  query = '',
  ownerId = '',
  realmId = '',
  botId = '',
  userId = '',
  charId = '',
  includePersonaRows = true,
  rowLimit = 12,
  includePersonaContextRows = true,
  contextRowLimit = 120
} = {}) {
  const monthHints = inferMonthHints(realmId);
  const [workspaceSnapshot, homePacket] = await Promise.all([
    getPersonaWorkspaceSnapshot({
      includePersonaRows,
      rowLimit,
      includePersonaContextRows,
      contextRowLimit,
      monthHints,
      ownerId,
      realmId
    }),
    getMemoryHomePacket({
      ownerId,
      realmId,
      botId,
      userId,
      charId,
      mode: 'mcp',
      rootLimit: 8
    })
  ]);

  const contextPacket = (safeText(key) || safeText(query))
    ? await getMemoryContextPacket({
        key,
        query,
        ownerId,
        realmId,
        botId,
        userId,
        charId,
        mode: 'mcp'
      })
    : null;

  const workspace = summarizeWorkspaceSnapshot(workspaceSnapshot);
  const resolvedScope = homePacket?.scope || {
    owner_id: safeText(ownerId || userId),
    realm_id: safeText(realmId, 'default'),
    bot_id: safeText(botId || charId)
  };
  const [cardRegistrySnapshot, growthLedgerSnapshot, growthDraftSnapshot] = await Promise.all([
    getCardRegistrySnapshot({
      ownerId: resolvedScope.owner_id,
      realmId: resolvedScope.realm_id,
      limit: 12
    }),
    getGrowthLedgerSnapshot({
      ownerId: resolvedScope.owner_id,
      realmId: resolvedScope.realm_id,
      limit: 16
    }),
    listGrowthDraftArtifacts({
      ownerId: resolvedScope.owner_id,
      realmId: resolvedScope.realm_id,
      limit: 8
    })
  ]);
  const cardRegistry = summarizeRegistrySnapshot(cardRegistrySnapshot);
  const growthLedger = summarizeLedgerSnapshot(growthLedgerSnapshot);
  const growthDrafts = summarizeGrowthDrafts(growthDraftSnapshot);

  return {
    ok: true,
    schema: 'persona_growth_context_packet_v0.1',
    scope: resolvedScope,
    workspace,
    card_registry: cardRegistry,
    growth_ledger: growthLedger,
    memory_home: homePacket?.ok ? {
      home_state: safeText(homePacket.home_state),
      home_summary: homePacket.home_summary || {},
      next_work: homePacket.next_work || null,
      read_preview: homePacket.read_preview || null
    } : {
      home_state: 'unavailable',
      home_summary: {},
      next_work: null,
      read_preview: null
    },
    memory_context: contextPacket && contextPacket.ok ? contextPacket : null,
    query_seed: {
      key: safeText(key),
      query: safeText(query)
    },
    hints: buildGrowthHints({
    workspace,
    cardRegistry,
    growthLedger,
    growthDrafts,
    homePacket,
    contextPacket,
    key,
    query
    }),
    growth_drafts: growthDrafts
  };
}
