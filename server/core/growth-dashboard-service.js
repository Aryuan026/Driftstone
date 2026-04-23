import { mkdir, readdir, readFile, rm, stat } from 'fs/promises';
import { basename, dirname, join, normalize, relative } from 'path';
import { getCardRegistrySnapshot } from './card-registry-service.js';
import { getGrowthLedgerSnapshot } from './growth-ledger-service.js';
import { listGrowthDraftArtifacts } from './growth-draft-store.js';
import { loadWorkbenchCacheRows } from './workbench-cache-service.js';
import { OBSIDIAN_STAGING_ROOT, SCOPED_TRUTH_DIR, getScopedObsidianStagingRoot, safeScopeSegment } from './path-config.js';
import { getFrontRuntimeState } from './front-runtime-state-service.js';
import { getParseRuntimeStateRaw } from './parse-runtime-service.js';
import { getGrowthRuntimeState } from './growth-runtime-service.js';
import { loadLatestIngressPacket } from './ingest-store.js';
import { loadLatestTranslationPacket } from './translation-store.js';
import { loadLatestTranslationTaskPacket } from './translation-task-store.js';
import { loadLatestRuntimeReviewedPacket } from './runtime-reviewed-store.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function scopeMatches(runtimeScope = {}, ownerId = '', realmId = '') {
  if (!safeText(ownerId) || !safeText(realmId)) return true;
  return safeText(runtimeScope?.owner_id || runtimeScope?.ownerId) === safeText(ownerId)
    && safeText(runtimeScope?.realm_id || runtimeScope?.realmId) === safeText(realmId);
}

function sanitizeGrowthRuntime(runtime = null) {
  if (!runtime || typeof runtime !== 'object') return runtime;
  const nextState = runtime.state && typeof runtime.state === 'object' ? clone(runtime.state) : null;
  if (!nextState) return runtime;
  const queueTotal = Math.max(0, Number(nextState.queue_total || (Array.isArray(nextState.queue) ? nextState.queue.length : 0)));
  const queueCompleted = Math.max(0, Math.min(queueTotal, Number(nextState.queue_completed || 0)));
  if (safeText(nextState.phase) === 'completed' || (queueTotal > 0 && queueCompleted >= queueTotal)) {
    nextState.running = false;
    nextState.paused = false;
    nextState.pause_requested = false;
    nextState.item_progress = 100;
  }
  if (queueTotal > 1) {
    nextState.generatedBundle = null;
  }
  return {
    ...runtime,
    state: nextState
  };
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function isInternalProbeScope(ownerId = '', realmId = '') {
  const owner = safeText(ownerId).toLowerCase();
  const realm = safeText(realmId).toLowerCase();
  const text = `${owner} ${realm}`;
  return /(smoke|manual-probe|probe|session-demo|test-sync|parse-runtime-smoke)/i.test(text);
}

async function readLatestActivityStamp(filePath = '') {
  if (!filePath) return '';
  try {
    const meta = await stat(filePath);
    return meta?.mtime?.toISOString?.() || '';
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function buildSourceGroupKey(row = {}) {
  return safeText(
    row.source_window_title
    || row.source_window_id
    || row.source_ref
    || row.topic_labels
    || row.track_id
    || row.event_anchor
    || row.title,
    '未命名来源'
  );
}

function toTimeStamp(value) {
  const text = safeText(value);
  if (!text) return '';
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return text;
  return new Date(parsed).toISOString();
}

function summarizeWorkbenchRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const sourceMap = new Map();
  let personaRows = 0;
  let sqlRows = 0;
  for (const row of list) {
    const layer = safeText(row.layer).toLowerCase();
    if (layer === 'persona') personaRows += 1;
    if (layer === 'sql') sqlRows += 1;
    const key = buildSourceGroupKey(row);
    const current = sourceMap.get(key) || {
      key,
      label: key,
      persona_rows: 0,
      sql_rows: 0,
      total_rows: 0,
      first_time: '',
      last_time: '',
      topic_labels: safeText(row.topic_labels),
      source_ref: safeText(row.source_ref),
      source_window_title: safeText(row.source_window_title),
      source_window_id: safeText(row.source_window_id)
    };
    current.total_rows += 1;
    if (layer === 'persona') current.persona_rows += 1;
    if (layer === 'sql') current.sql_rows += 1;
    const stamp = toTimeStamp(row.time);
    if (stamp && (!current.first_time || stamp < current.first_time)) current.first_time = stamp;
    if (stamp && (!current.last_time || stamp > current.last_time)) current.last_time = stamp;
    sourceMap.set(key, current);
  }
  const source_groups = Array.from(sourceMap.values())
    .sort((a, b) => {
      if (b.total_rows !== a.total_rows) return b.total_rows - a.total_rows;
      return String(a.label || '').localeCompare(String(b.label || ''), 'zh');
    })
    .slice(0, 20);
  return {
    total_rows: list.length,
    persona_rows: personaRows,
    sql_rows: sqlRows,
    source_group_count: sourceMap.size,
    source_groups
  };
}

async function safeLoad(loader, args = {}) {
  try {
    return await loader(args);
  } catch {
    return null;
  }
}

function buildPipelineSummary({ ingest = null, translation = null, tasks = null, reviewed = null } = {}) {
  const ingestPacket = ingest?.packet || {};
  const translationPacket = translation?.packet || {};
  const taskPacket = tasks?.packet || {};
  const reviewedPacket = reviewed?.packet || {};

  const documentCount = Number(ingestPacket?.input?.document_count || ingestPacket?.documents?.length || 0);
  const sliceCount = Number(translationPacket?.summary?.slice_count || translationPacket?.slice_count || 0);
  const taskSummary = taskPacket?.status_summary || {};
  const pending = Number(taskSummary.pending || 0);
  const submitted = Number(taskSummary.submitted || 0);
  const applied = Number(taskSummary.applied || 0);
  const failed = Number(taskSummary.failed || 0);
  const totalTasks = pending + submitted + applied + failed;
  const reviewedSummary = reviewedPacket?.summary || {};
  const itemCount = Number(reviewedSummary.item_count || 0);
  const clusterCount = Number(reviewedSummary.cluster_count || 0);

  const source_groups = [];
  if (ingest) {
    source_groups.push({
      label: '原始记录包',
      total_rows: documentCount || 1,
      persona_rows: 0,
      sql_rows: 0,
      meta: safeText(ingest.pointer?.latest_packet).split('/').slice(-2).join('/'),
      state: 'done'
    });
  }
  if (translation) {
    source_groups.push({
      label: '时间拼装与切片',
      total_rows: sliceCount,
      persona_rows: 0,
      sql_rows: 0,
      meta: `${sliceCount} 片 · ${safeText(translation.pointer?.latest_packet).split('/').slice(-2).join('/')}`,
      state: totalTasks > 0 ? 'done' : 'active'
    });
  }
  if (tasks) {
    source_groups.push({
      label: '提炼任务包',
      total_rows: totalTasks,
      persona_rows: itemCount,
      sql_rows: clusterCount,
      meta: `${submitted + applied + failed}/${totalTasks || 0} 组 · ${safeText(tasks.pointer?.latest_packet).split('/').slice(-2).join('/')}`,
      state: pending > 0 ? 'active' : 'done'
    });
  }
  if (reviewed) {
    source_groups.push({
      label: '材料包',
      total_rows: itemCount,
      persona_rows: itemCount,
      sql_rows: clusterCount,
      meta: `${clusterCount} 组 · ${safeText(reviewed.pointer?.latest_packet).split('/').slice(-2).join('/')}`,
      state: 'done'
    });
  }

  const delivery_groups = [];
  if (sliceCount > 0) {
    delivery_groups.push({
      label: '时间拼装与智能分片',
      meta: `${sliceCount} 片`,
      kinds: [{ kind: 'SLICES', state: totalTasks ? 'done' : 'active' }]
    });
  }
  if (totalTasks > 0) {
    delivery_groups.push({
      label: `提炼任务 ${Math.min(submitted + applied + failed + 1, totalTasks)}/${totalTasks}`,
      meta: `已处理 ${submitted + applied + failed}/${totalTasks}`,
      kinds: [{ kind: 'TASK', state: pending > 0 ? 'active' : 'done' }]
    });
  }
  if (reviewed && (itemCount > 0 || clusterCount > 0)) {
    delivery_groups.push({
      label: 'reviewed 去重与收束',
      meta: `${itemCount} 条 · ${clusterCount} 组`,
      kinds: [{ kind: 'REVIEWED', state: 'done' }]
    });
  }

  const percent = totalTasks > 0
    ? Math.round(((submitted + applied + failed) / totalTasks) * 100)
    : (reviewed ? 100 : translation ? 35 : ingest ? 12 : 0);
  const hasWork = Boolean(ingest || translation || tasks || reviewed);
  const runLabel = reviewed
    ? `这一轮已经整理出 ${itemCount} 条材料`
    : totalTasks > 0
      ? `已处理 ${submitted + applied + failed}/${totalTasks} 组任务`
      : translation
        ? `已切成 ${sliceCount} 片`
        : ingest
          ? '已接住原始记录'
          : '待开始';

  return {
    has_work: hasWork,
    document_count: documentCount,
    slice_count: sliceCount,
    task_total: totalTasks,
    task_pending: pending,
    task_submitted: submitted,
    task_applied: applied,
    task_failed: failed,
    reviewed_item_count: itemCount,
    reviewed_cluster_count: clusterCount,
    percent,
    run_label: runLabel,
    source_groups,
    delivery_groups
  };
}

const STAGING_CARD_DIRS = [
  { folder: '01_Family', card_type: 'family' },
  { folder: '02_Memo', card_type: 'memo' },
  { folder: '03_Case', card_type: 'case' },
  { folder: '04_Fact', card_type: 'fact' }
];
const OBSIDIAN_VAULT_ROOT = OBSIDIAN_STAGING_ROOT;

async function walkMarkdownFiles(dir, bucket = []) {
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    if (!entry) continue;
    const filePath = join(dir, entry.name);
    if (entry.isDirectory?.()) {
      await walkMarkdownFiles(filePath, bucket);
      continue;
    }
    if (entry.isFile?.() && entry.name.toLowerCase().endsWith('.md')) {
      bucket.push(filePath);
    }
  }
  return bucket;
}

function parseMarkdownTitle(raw = '', fallback = '') {
  const text = String(raw || '');
  const frontmatterTitle = text.match(/^---[\s\S]*?^\s*title:\s*(.+?)\s*$/m);
  if (frontmatterTitle?.[1]) return safeText(frontmatterTitle[1], fallback);
  const heading = text.match(/^#\s+(.+?)\s*$/m);
  if (heading?.[1]) return safeText(heading[1], fallback);
  return fallback;
}

function resolveScopedStagingRoot(ownerId = '', realmId = '') {
  return safeText(ownerId) && safeText(realmId)
    ? getScopedObsidianStagingRoot(ownerId, realmId)
    : OBSIDIAN_STAGING_ROOT;
}

async function scanVaultCards(rootDir = OBSIDIAN_VAULT_ROOT, limit = 24, relativeBase = OBSIDIAN_VAULT_ROOT) {
  const cards = [];
  const countByType = new Map();

  for (const item of STAGING_CARD_DIRS) {
    const root = join(rootDir, item.folder);
    const files = await walkMarkdownFiles(root, []);
    countByType.set(item.card_type, files.length);
    for (const filePath of files) {
      try {
        const [meta, raw] = await Promise.all([
          stat(filePath),
          readFile(filePath, 'utf-8')
        ]);
        const fileName = basename(filePath, '.md');
        cards.push({
          title: parseMarkdownTitle(raw, fileName),
          card_type: item.card_type,
          file_path: filePath,
          relative_path: relative(relativeBase, filePath),
          updated_at: meta.mtime.toISOString()
        });
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  cards.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return {
    total: cards.length,
    by_type: Array.from(countByType.entries()).map(([name, count]) => ({ name, count })),
    cards: cards.slice(0, limit)
  };
}

function resolveSafeStagingCardPath(relativePath = '') {
  const normalized = normalize(String(relativePath || '')).replace(/^(\.\.(\/|\\|$))+/, '');
  if (!normalized || normalized.startsWith('..')) return '';
  const full = join(OBSIDIAN_VAULT_ROOT, normalized);
  if (!full.startsWith(OBSIDIAN_VAULT_ROOT)) return '';
  return full;
}

export async function getStagingCardMarkdown({
  relativePath = ''
} = {}) {
  const safeRelativePath = String(relativePath || '').trim();
  const filePath = resolveSafeStagingCardPath(safeRelativePath);
  if (!safeRelativePath || !filePath || !filePath.toLowerCase().endsWith('.md')) {
    return {
      ok: false,
      error: 'Invalid staging card path',
      relative_path: safeRelativePath
    };
  }
  try {
    const markdown = await readFile(filePath, 'utf-8');
    return {
      ok: true,
      relative_path: safeRelativePath,
      file_path: filePath,
      markdown
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: false,
        error: 'Staging card not found',
        relative_path: safeRelativePath
      };
    }
    throw error;
  }
}

export async function clearStagingCards({
  ownerId = '',
  realmId = '',
  cardType = ''
} = {}) {
  const stagingRoot = resolveScopedStagingRoot(ownerId, realmId);
  const before = await scanVaultCards(stagingRoot, 10000, OBSIDIAN_STAGING_ROOT);
  const targetDirs = cardType
    ? STAGING_CARD_DIRS.filter((item) => item.card_type === String(cardType || '').trim().toLowerCase())
    : STAGING_CARD_DIRS;
  for (const item of targetDirs) {
    const root = join(stagingRoot, item.folder);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  }
  const clearedCount = Array.isArray(before?.cards)
    ? before.cards.filter((item) => !cardType || String(item.card_type || '').toLowerCase() === String(cardType || '').trim().toLowerCase()).length
    : Number(before?.total || 0);
  return {
    ok: true,
    cleared_count: clearedCount,
    card_type: safeText(cardType),
    root: stagingRoot
  };
}

async function detectLatestActiveScope() {
  const owners = await safeReaddir(SCOPED_TRUTH_DIR);
  let latest = null;
  for (const ownerDir of owners) {
    if (!ownerDir?.isDirectory?.()) continue;
    const ownerId = ownerDir.name;
    const realms = await safeReaddir(join(SCOPED_TRUTH_DIR, ownerId));
    for (const realmDir of realms) {
      if (!realmDir?.isDirectory?.()) continue;
      const realmId = realmDir.name;
      if (isInternalProbeScope(ownerId, realmId)) continue;
      const rootDir = join(SCOPED_TRUTH_DIR, ownerId, realmId);
      const latestCandidates = await Promise.all([
        readLatestActivityStamp(join(rootDir, 'front_runtime_state', `${safeScopeSegment(realmId, 'default')}.json`)),
        readLatestActivityStamp(join(rootDir, 'parse_runtime_state', `${safeScopeSegment(realmId, 'default')}.json`)),
        readLatestActivityStamp(join(rootDir, 'ingest_packets', 'latest.json')),
        readLatestActivityStamp(join(rootDir, 'translation_packets', 'latest.json')),
        readLatestActivityStamp(join(rootDir, 'translation_tasks', 'latest.json')),
        readLatestActivityStamp(join(rootDir, 'reviewed_packets', 'latest.json')),
        readLatestActivityStamp(join(rootDir, 'growth_ledger', 'latest.json')),
        readLatestActivityStamp(join(rootDir, 'card_registry', 'latest.json')),
        readLatestActivityStamp(join(rootDir, 'growth_drafts')),
        readLatestActivityStamp(join(rootDir, 'growth_runtime_state', `${safeScopeSegment(realmId, 'default')}.json`))
      ]);
      const generatedAt = latestCandidates.filter(Boolean).sort().at(-1) || '';
      if (!generatedAt) continue;
      if (!latest || generatedAt > latest.generated_at) {
        latest = {
          owner_id: ownerId,
          realm_id: realmId,
          generated_at: generatedAt
        };
      }
    }
  }
  return latest;
}

export async function getGrowthDashboardSnapshot({
  ownerId = '',
  realmId = '',
  draftLimit = 10,
  ledgerLimit = 10,
  registryLimit = 12,
  stagingLimit = 24
} = {}) {
  const requestedOwner = safeText(ownerId);
  const requestedRealm = safeText(realmId);
  const activeScope = requestedOwner || requestedRealm
    ? {
        owner_id: requestedOwner,
        realm_id: requestedRealm || 'default',
        generated_at: ''
      }
    : await detectLatestActiveScope();
  const workbenchRows = await loadWorkbenchCacheRows({
    ownerId: activeScope?.owner_id,
    realmId: activeScope?.realm_id,
    fallbackToRuntimeReviewed: Boolean(activeScope),
    preferRuntimeReviewed: Boolean(activeScope)
  });
  const workbench = summarizeWorkbenchRows(workbenchRows);
  const rawFrontRuntime = activeScope
    ? await getFrontRuntimeState({
        ownerId: activeScope.owner_id,
        realmId: activeScope.realm_id
      })
    : null;
  const stagingRoot = resolveScopedStagingRoot(activeScope?.owner_id, activeScope?.realm_id);
  const staging_cards = await scanVaultCards(stagingRoot, stagingLimit, OBSIDIAN_STAGING_ROOT);
  const rawParseRuntime = activeScope
    ? await getParseRuntimeStateRaw({
        ownerId: activeScope.owner_id,
        realmId: activeScope.realm_id
      })
    : null;
  const rawGrowthRuntime = activeScope
    ? await getGrowthRuntimeState({
        ownerId: activeScope.owner_id,
        realmId: activeScope.realm_id
      })
    : null;
  const scopedFrontRuntime = activeScope && scopeMatches(rawFrontRuntime?.active_scope, activeScope.owner_id, activeScope.realm_id) ? rawFrontRuntime : null;
  const scopedParseRuntime = activeScope && scopeMatches(rawParseRuntime?.active_scope, activeScope.owner_id, activeScope.realm_id) ? rawParseRuntime : null;
  const scopedGrowthRuntime = activeScope && scopeMatches(rawGrowthRuntime?.active_scope, activeScope.owner_id, activeScope.realm_id)
    ? sanitizeGrowthRuntime(rawGrowthRuntime)
    : null;
  const mergedFrontState = {
    ...(scopedFrontRuntime?.state && typeof scopedFrontRuntime.state === 'object' ? scopedFrontRuntime.state : {}),
    ...(scopedParseRuntime?.state && typeof scopedParseRuntime.state === 'object' ? scopedParseRuntime.state : {})
  };
  if (scopedGrowthRuntime?.state && typeof scopedGrowthRuntime.state === 'object') {
    const growthState = scopedGrowthRuntime.state;
    mergedFrontState.generationRunning = Boolean(growthState.running);
    if (Number.isFinite(Number(growthState.progress))) {
      mergedFrontState.generationProgress = Number(growthState.progress);
    }
    if (safeText(growthState.label)) {
      mergedFrontState.generationLabel = safeText(growthState.label);
    }
    if (safeText(growthState.phase)) {
      mergedFrontState.generationPhase = safeText(growthState.phase);
    }
    if (safeText(growthState.error)) {
      mergedFrontState.generationError = safeText(growthState.error);
    }
    if (growthState.generatedBundle && typeof growthState.generatedBundle === 'object') {
      mergedFrontState.generatedBundle = clone(growthState.generatedBundle);
    }
  }
  const front_runtime = scopedFrontRuntime || scopedParseRuntime || scopedGrowthRuntime
    ? {
        saved_at: safeText(scopedGrowthRuntime?.saved_at || scopedParseRuntime?.saved_at || scopedFrontRuntime?.saved_at),
        active_scope: scopedGrowthRuntime?.active_scope || scopedParseRuntime?.active_scope || scopedFrontRuntime?.active_scope || null,
        state: mergedFrontState
      }
    : null;

  const parse_pipeline = scopedParseRuntime?.state?.parse_pipeline && typeof scopedParseRuntime.state.parse_pipeline === 'object'
    ? scopedParseRuntime.state.parse_pipeline
    : (activeScope
      ? buildPipelineSummary({
          ingest: await safeLoad(loadLatestIngressPacket, {
            ownerId: activeScope.owner_id,
            realmId: activeScope.realm_id
          }),
          translation: await safeLoad(loadLatestTranslationPacket, {
            ownerId: activeScope.owner_id,
            realmId: activeScope.realm_id
          }),
          tasks: await safeLoad(loadLatestTranslationTaskPacket, {
            ownerId: activeScope.owner_id,
            realmId: activeScope.realm_id
          }),
          reviewed: await safeLoad(loadLatestRuntimeReviewedPacket, {
            ownerId: activeScope.owner_id,
            realmId: activeScope.realm_id
          })
        })
      : buildPipelineSummary({}));

  if (!activeScope) {
    return {
      ok: true,
      workbench,
      front_runtime: front_runtime || null,
      growth_runtime: scopedGrowthRuntime || null,
      parse_pipeline,
      active_scope: null,
      card_registry: {
        summary: {
          total_cards: 0,
          by_type: [],
          recent_cards: []
        },
        cards: []
      },
      growth_ledger: {
        summary: {
          total_entries: 0,
          by_decision: [],
          recent_entries: []
        },
        entries: []
      },
      growth_drafts: {
        total: 0,
        drafts: []
      },
      staging_cards
    };
  }

  const card_registry = await getCardRegistrySnapshot({
    ownerId: activeScope.owner_id,
    realmId: activeScope.realm_id,
    limit: registryLimit
  });
  const growth_ledger = await getGrowthLedgerSnapshot({
    ownerId: activeScope.owner_id,
    realmId: activeScope.realm_id,
    limit: ledgerLimit
  });
  const growth_drafts = await listGrowthDraftArtifacts({
    ownerId: activeScope.owner_id,
    realmId: activeScope.realm_id,
    limit: draftLimit
  });

  return {
    ok: true,
    workbench,
    front_runtime: front_runtime || null,
    growth_runtime: scopedGrowthRuntime || null,
    parse_pipeline,
    active_scope: activeScope,
    card_registry,
    growth_ledger,
    growth_drafts,
    staging_cards
  };
}
