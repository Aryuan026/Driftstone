import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { buildMemoryScope } from './scope-contract.js';
import { RUNTIME_SAVE_DIR, getScopedTruthDir, safeScopeSegment } from './path-config.js';
import { ingestMemoryEnvelope } from './memory-ingest-service.js';
import { buildTranslationPacket } from './memory-translation-service.js';
import { prepareAiTranslationTasks } from './memory-translation-ai-service.js';
import { getLatestTranslationTaskPacketStatus, getNextPendingTranslationWorkerPacket } from './memory-translation-task-service.js';
import { runRuntimeAiTranslationTask, runRuntimeReviewedMerge } from './memory-runtime-ai-service.js';
import { finalizeRuntimeReviewedEntries, getRuntimeReviewedClusters } from './memory-reviewed-service.js';

const PARSE_RUNTIME_STATE_DIR = join(RUNTIME_SAVE_DIR, 'parse_runtime_state');
const PARSE_RUNTIME_STATE_FILE = join(PARSE_RUNTIME_STATE_DIR, 'latest.json');
const workerMap = new Map();

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function buildScope(input = {}) {
  return buildMemoryScope({
    ownerId: input?.owner_id || input?.ownerId,
    realmId: input?.realm_id || input?.realmId,
    botId: input?.bot_id || input?.botId,
    mode: 'bot'
  });
}

function scopeKey(scope = {}) {
  return `${safeText(scope.owner_id, 'history-to-obsidian')}::${safeText(scope.realm_id, 'default')}`;
}

function getScopedRuntimeStateFile(ownerId = '', realmId = '') {
  if (!ownerId || !realmId) return '';
  return join(
    getScopedTruthDir(ownerId, realmId),
    'parse_runtime_state',
    `${safeScopeSegment(realmId, 'default')}.json`
  );
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeParsePlan(plan = {}) {
  const normalized = plan && typeof plan === 'object' ? { ...plan } : {};
  return {
    targetChars: Math.max(1200, toNumber(normalized.targetChars || normalized.target_chars, 2200)),
    maxSlices: Math.max(1, toNumber(normalized.maxSlices || normalized.max_slices, 2)),
    maxChars: Math.max(1200, toNumber(normalized.maxChars || normalized.max_chars, 5000)),
    estimatedSlices: Math.max(0, toNumber(normalized.estimatedSlices || normalized.estimated_slices, 0)),
    strategyLabel: safeText(normalized.strategyLabel || normalized.strategy_label || '平衡分片'),
    monthlyReady: Boolean(normalized.monthlyReady ?? normalized.monthly_ready),
    entryLimit: Math.max(1, toNumber(normalized.entryLimit || normalized.entry_limit, 6))
  };
}

function normalizeApiConfig(api = {}) {
  const baseUrl = safeText(api?.baseUrl || api?.base_url).replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey: typeof api?.apiKey === 'string' ? api.apiKey : (typeof api?.api_key === 'string' ? api.api_key : ''),
    model: safeText(api?.model, '')
  };
}

function normalizeSourceEnvelope(envelope = {}) {
  const source = envelope?.source && typeof envelope.source === 'object' ? envelope.source : {};
  const input = envelope?.input && typeof envelope.input === 'object' ? envelope.input : {};
  return {
    source: {
      kind: safeText(source.kind, 'multi_upload'),
      label: safeText(source.label, 'manual-session'),
      format: safeText(source.format, 'json')
    },
    input: clone(input) || {}
  };
}

function extractHome(stageResult = {}) {
  if (stageResult?.home && typeof stageResult.home === 'object' && stageResult.home.ok !== false) {
    return clone(stageResult.home);
  }
  return null;
}

function extractHomeSummary(stageResult = {}) {
  if (stageResult?.home_summary && typeof stageResult.home_summary === 'object') {
    return clone(stageResult.home_summary);
  }
  return {};
}

function buildOverviewFromFinalize(finalizeResult = {}) {
  const writeback = finalizeResult?.writeback?.summary || finalizeResult?.writeback || {};
  return {
    ok: true,
    source: {
      root_count: toNumber(writeback.total_roots || writeback.created_roots || 0, 0),
      vine_edge_count: toNumber(writeback.vine_edges || 0, 0)
    }
  };
}

function summarizeTaskStatus(tasks = {}) {
  const summary = tasks?.status_summary || {};
  return {
    pending: toNumber(summary.pending, 0),
    submitted: toNumber(summary.submitted, 0),
    applied: toNumber(summary.applied, 0),
    failed: toNumber(summary.failed, 0)
  };
}

function buildPipelineSummaryFromRuntime(state = {}) {
  const ingest = state?.lastIngest?.ingest || state?.lastIngest || {};
  const translation = state?.lastTranslation?.translation || state?.lastTranslation || {};
  const prepareSummary = state?.lastTaskPrepare?.summary || {};
  const taskStatus = summarizeTaskStatus(state?.parseDashboard?.tasks || {});
  const reviewedSummary = state?.lastReviewedFinalize?.summary || state?.lastReviewedClusters?.summary || {};
  const documentCount = toNumber(ingest.document_count, 0);
  const sliceCount = toNumber(translation.slice_count, 0);
  const taskTotal = taskStatus.pending + taskStatus.submitted + taskStatus.applied + taskStatus.failed
    || toNumber(prepareSummary.batch_count, 0);
  const reviewedItemCount = toNumber(reviewedSummary.item_count, 0);
  const reviewedClusterCount = toNumber(reviewedSummary.cluster_count, 0);
  const hasWork = Boolean(
    documentCount
    || sliceCount
    || taskTotal
    || reviewedItemCount
    || state?.parseRunning
    || state?.parsePaused
    || state?.parsePauseRequested
  );

  const handled = taskStatus.submitted + taskStatus.applied + taskStatus.failed;
  const percent = reviewedItemCount > 0
    ? 100
    : taskTotal > 0
      ? Math.round((handled / taskTotal) * 100)
      : sliceCount > 0
        ? 35
        : documentCount > 0
          ? 12
          : 0;

  const sourceGroups = [];
  if (documentCount > 0) {
    sourceGroups.push({
      label: '原始记录包',
      total_rows: documentCount,
      persona_rows: 0,
      sql_rows: 0,
      meta: safeText(ingest.packet_file).split('/').slice(-2).join('/'),
      state: 'done'
    });
  }
  if (sliceCount > 0) {
    sourceGroups.push({
      label: '时间拼装与切片',
      total_rows: sliceCount,
      persona_rows: 0,
      sql_rows: 0,
      meta: `${sliceCount} 片 · ${safeText(translation.packet_file).split('/').slice(-2).join('/')}`,
      state: taskTotal > 0 ? 'done' : 'active'
    });
  }
  if (taskTotal > 0) {
    sourceGroups.push({
      label: '提炼任务包',
      total_rows: taskTotal,
      persona_rows: reviewedItemCount,
      sql_rows: reviewedClusterCount,
      meta: `${handled}/${taskTotal} 组`,
      state: taskStatus.pending > 0 ? 'active' : 'done'
    });
  }
  if (reviewedItemCount > 0 || reviewedClusterCount > 0) {
    sourceGroups.push({
      label: '材料包',
      total_rows: reviewedItemCount,
      persona_rows: reviewedItemCount,
      sql_rows: reviewedClusterCount,
      meta: `${reviewedClusterCount} 组`,
      state: 'done'
    });
  }

  const deliveryGroups = [];
  if (sliceCount > 0) {
    deliveryGroups.push({
      label: '时间拼装与智能分片',
      meta: `${sliceCount} 片`,
      kinds: [{ kind: 'SLICES', state: taskTotal > 0 ? 'done' : 'active' }]
    });
  }
  if (taskTotal > 0) {
    const currentLabel = safeText(state?.parseWorkerState?.currentLabel);
    deliveryGroups.push({
      label: currentLabel || `第 ${Math.min(handled + 1, taskTotal)}/${taskTotal} 组任务`,
      meta: `已处理 ${handled}/${taskTotal}`,
      kinds: [{ kind: 'TASK', state: taskStatus.pending > 0 ? 'active' : 'done' }]
    });
  }
  if (reviewedItemCount > 0 || reviewedClusterCount > 0) {
    deliveryGroups.push({
      label: 'reviewed 去重与收束',
      meta: `${reviewedItemCount} 条 · ${reviewedClusterCount} 组`,
      kinds: [{ kind: 'REVIEWED', state: 'done' }]
    });
  }

  const runLabel = reviewedItemCount > 0
    ? `这一轮已经整理出 ${reviewedItemCount} 条材料`
    : taskTotal > 0
      ? (safeText(state?.parseWorkerState?.currentLabel) || `已处理 ${handled}/${taskTotal} 组任务`)
      : sliceCount > 0
        ? `已切成 ${sliceCount} 片`
        : documentCount > 0
          ? '已接住原始记录'
          : '待开始';

  return {
    has_work: hasWork,
    document_count: documentCount,
    slice_count: sliceCount,
    task_total: taskTotal,
    task_pending: taskStatus.pending,
    task_submitted: taskStatus.submitted,
    task_applied: taskStatus.applied,
    task_failed: taskStatus.failed,
    reviewed_item_count: reviewedItemCount,
    reviewed_cluster_count: reviewedClusterCount,
    percent,
    run_label: runLabel,
    source_groups: sourceGroups,
    delivery_groups: deliveryGroups
  };
}

function buildParseDashboard(scope = {}, state = {}) {
  const home = extractHome(state.lastReviewedFinalize)
    || extractHome(state.lastReviewedClusters)
    || extractHome(state.lastDrain)
    || extractHome(state.lastTaskPrepare)
    || extractHome(state.lastTranslation)
    || extractHome(state.lastIngest)
    || {};
  const homeSummary = extractHomeSummary(state.lastReviewedFinalize)
    || extractHomeSummary(state.lastReviewedClusters)
    || extractHomeSummary(state.lastDrain)
    || extractHomeSummary(state.lastTaskPrepare)
    || extractHomeSummary(state.lastTranslation)
    || extractHomeSummary(state.lastIngest)
    || {};
  const taskStatus = state.tasksStatus || buildEmptyTaskStatus(scope);
  return {
    active_scope: {
      owner_id: scope.owner_id,
      realm_id: scope.realm_id,
      bot_id: scope.bot_id
    },
    home: Object.keys(home).length
      ? home
      : {
          ok: true,
          home_state: state.lastReviewedFinalize?.ok ? 'context_ready' : (state.lastTranslation?.ok ? 'translation_pending' : 'scope_ready')
        },
    home_summary: homeSummary,
    overview: buildOverviewFromFinalize(state.lastReviewedFinalize),
    tasks: taskStatus
  };
}

function buildEmptyTaskStatus(scope = {}) {
  return {
    ok: true,
    scope: {
      owner_id: scope.owner_id,
      realm_id: scope.realm_id
    },
    latest: {
      generated_at: '',
      packet_file: '',
      packet_dir: ''
    },
    summary: {},
    status_summary: {
      pending: 0,
      submitted: 0,
      applied: 0,
      failed: 0
    },
    next_work: {
      next_pending_task: null,
      last_applied_task: null
    },
    tasks: []
  };
}

function normalizeRuntimePayload(scope = {}, existing = {}) {
  const state = existing?.state && typeof existing.state === 'object' ? { ...existing.state } : {};
  const payload = {
    saved_at: new Date().toISOString(),
    active_scope: {
      owner_id: scope.owner_id,
      realm_id: scope.realm_id,
      bot_id: scope.bot_id
    },
    state: {
      sessionId: safeText(state.sessionId || scope.realm_id),
      parseRunning: Boolean(state.parseRunning),
      parsePaused: Boolean(state.parsePaused),
      parsePauseRequested: Boolean(state.parsePauseRequested),
      parseError: safeText(state.parseError),
      parsePlan: normalizeParsePlan(state.parsePlan),
      parseWorkerState: {
        total: toNumber(state?.parseWorkerState?.total, 0),
        completed: toNumber(state?.parseWorkerState?.completed, 0),
        failed: toNumber(state?.parseWorkerState?.failed, 0),
        currentLabel: safeText(state?.parseWorkerState?.currentLabel),
        mode: safeText(state?.parseWorkerState?.mode, 'idle')
      },
      lastIngest: clone(state.lastIngest) || null,
      lastTranslation: clone(state.lastTranslation) || null,
      lastTaskPrepare: clone(state.lastTaskPrepare) || null,
      lastReviewedClusters: clone(state.lastReviewedClusters) || null,
      lastReviewedFinalize: clone(state.lastReviewedFinalize) || null,
      lastDrain: clone(state.lastDrain) || null,
      tasksStatus: clone(state.tasksStatus) || buildEmptyTaskStatus(scope)
    },
    runtime_config: {
      source_envelope: normalizeSourceEnvelope(existing?.runtime_config?.source_envelope),
      parse_plan: normalizeParsePlan(existing?.runtime_config?.parse_plan),
      api_config: normalizeApiConfig(existing?.runtime_config?.api_config)
    }
  };
  payload.state.parseDashboard = buildParseDashboard(scope, payload.state);
  payload.state.parse_pipeline = buildPipelineSummaryFromRuntime(payload.state);
  return payload;
}

function patchRuntimePayload(payload = {}, patch = {}) {
  const scope = buildScope(payload?.active_scope || patch?.active_scope || {});
  const next = normalizeRuntimePayload(scope, payload);
  if (patch?.state && typeof patch.state === 'object') {
    Object.assign(next.state, patch.state);
  }
  if (patch?.runtime_config && typeof patch.runtime_config === 'object') {
    next.runtime_config = {
      ...next.runtime_config,
      ...patch.runtime_config
    };
  }
  next.saved_at = new Date().toISOString();
  next.state.parsePlan = normalizeParsePlan(next.state.parsePlan);
  next.runtime_config.parse_plan = normalizeParsePlan(next.runtime_config.parse_plan);
  next.runtime_config.api_config = normalizeApiConfig(next.runtime_config.api_config);
  next.runtime_config.source_envelope = normalizeSourceEnvelope(next.runtime_config.source_envelope);
  next.state.parseDashboard = buildParseDashboard(scope, next.state);
  next.state.parse_pipeline = buildPipelineSummaryFromRuntime(next.state);
  return next;
}

async function writeRuntimePayload(payload = {}) {
  const scope = payload?.active_scope || {};
  await mkdir(PARSE_RUNTIME_STATE_DIR, { recursive: true });
  await writeFile(PARSE_RUNTIME_STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  if (scope?.owner_id && scope?.realm_id) {
    const scopedFile = getScopedRuntimeStateFile(scope.owner_id, scope.realm_id);
    const scopedDir = join(getScopedTruthDir(scope.owner_id, scope.realm_id), 'parse_runtime_state');
    await mkdir(scopedDir, { recursive: true });
    await writeFile(scopedFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
  return payload;
}

async function loadRuntimePayload(scope = {}) {
  const ownerId = safeText(scope.owner_id || scope.ownerId);
  const realmId = safeText(scope.realm_id || scope.realmId);
  if (ownerId && realmId) {
    const scoped = await readJsonIfExists(getScopedRuntimeStateFile(ownerId, realmId));
    if (scoped) return normalizeRuntimePayload(buildScope(scoped.active_scope || scope), scoped);
    return null;
  }
  const latest = await readJsonIfExists(PARSE_RUNTIME_STATE_FILE);
  if (!latest) return null;
  return normalizeRuntimePayload(buildScope(latest.active_scope || scope), latest);
}

async function updateRuntimeState(scope = {}, updater) {
  const current = (await loadRuntimePayload(scope)) || normalizeRuntimePayload(buildScope(scope), {
    state: {},
    runtime_config: {}
  });
  const next = typeof updater === 'function' ? await updater(current) : current;
  return writeRuntimePayload(next);
}

async function refreshTaskStatus(scope = {}) {
  try {
    return await getLatestTranslationTaskPacketStatus({
      owner_id: scope.owner_id,
      realm_id: scope.realm_id,
      limit: 12
    });
  } catch {
    return buildEmptyTaskStatus(scope);
  }
}

async function settlePause(scope = {}, reason = '') {
  return updateRuntimeState(scope, (current) => patchRuntimePayload(current, {
    state: {
      parseRunning: false,
      parsePaused: true,
      parsePauseRequested: false,
      parseError: '',
      parseWorkerState: {
        ...current.state.parseWorkerState,
        currentLabel: '',
        mode: 'paused'
      },
      lastDrain: {
        ...(current.state.lastDrain || {}),
        ok: true,
        paused: true,
        reason: safeText(reason)
      }
    }
  }));
}

async function markCompleted(scope = {}, extra = {}) {
  return updateRuntimeState(scope, (current) => patchRuntimePayload(current, {
    state: {
      parseRunning: false,
      parsePaused: false,
      parsePauseRequested: false,
      parseError: '',
      parseWorkerState: {
        ...current.state.parseWorkerState,
        currentLabel: '',
        mode: 'idle'
      },
      ...extra
    }
  }));
}

async function markRuntimeError(scope = {}, message = '') {
  return updateRuntimeState(scope, (current) => patchRuntimePayload(current, {
    state: {
      parseRunning: false,
      parsePaused: Boolean(current.state.parsePaused),
      parsePauseRequested: false,
      parseError: safeText(message, 'parse runtime failed'),
      parseWorkerState: {
        ...current.state.parseWorkerState,
        currentLabel: '',
        mode: 'idle'
      }
    }
  }));
}

async function syncStateAfterStage(scope = {}, patch = {}) {
  return updateRuntimeState(scope, async (current) => {
    const next = patchRuntimePayload(current, patch);
    next.state.tasksStatus = await refreshTaskStatus(scope);
    next.state.parseDashboard = buildParseDashboard(scope, next.state);
    next.state.parse_pipeline = buildPipelineSummaryFromRuntime(next.state);
    return next;
  });
}

async function runParseRuntimeWorker(scope = {}) {
  const normalizedScope = buildScope(scope);
  try {
    while (true) {
      let runtime = await loadRuntimePayload(normalizedScope);
      if (!runtime?.state?.parseRunning) break;
      if (runtime.state.parsePauseRequested) {
        await settlePause(normalizedScope, '当前步骤跑完后已停下');
        break;
      }
      const sourceEnvelope = normalizeSourceEnvelope(runtime.runtime_config?.source_envelope);
      const parsePlan = normalizeParsePlan(runtime.runtime_config?.parse_plan);
      const apiConfig = normalizeApiConfig(runtime.runtime_config?.api_config);
      const state = runtime.state || {};

      if (!state.lastIngest?.ok) {
        const result = await ingestMemoryEnvelope({
          ...sourceEnvelope,
          scope: normalizedScope
        });
        await syncStateAfterStage(normalizedScope, {
          state: {
            lastIngest: result,
            parseWorkerState: {
              ...state.parseWorkerState,
              currentLabel: '接住原始记录',
              mode: 'running'
            }
          }
        });
        continue;
      }

      if (!state.lastTranslation?.ok) {
        const result = await buildTranslationPacket({
          scope: normalizedScope,
          packet_file: state.lastIngest?.ingest?.packet_file,
          source: { label: safeText(sourceEnvelope?.source?.label, 'translation') },
          target_chars: parsePlan.targetChars
        });
        await syncStateAfterStage(normalizedScope, {
          state: {
            lastTranslation: result,
            parseWorkerState: {
              ...state.parseWorkerState,
              currentLabel: '时间拼装与切片',
              mode: 'running'
            }
          }
        });
        continue;
      }

      if (!state.lastTaskPrepare?.ok) {
        const result = await prepareAiTranslationTasks({
          scope: normalizedScope,
          packet_file: state.lastTranslation?.translation?.packet_file,
          source: { label: safeText(sourceEnvelope?.source?.label, 'ai_tasks') },
          batch: {
            max_slices: parsePlan.maxSlices,
            max_chars: parsePlan.maxChars,
            entry_limit: parsePlan.entryLimit
          }
        });
        await syncStateAfterStage(normalizedScope, {
          state: {
            lastTaskPrepare: result,
            parseWorkerState: {
              total: toNumber(result?.summary?.batch_count, 0),
              completed: 0,
              failed: 0,
              currentLabel: '生成提炼任务包',
              mode: 'running'
            }
          }
        });
        continue;
      }

      const taskStatus = await refreshTaskStatus(normalizedScope);
      const summary = summarizeTaskStatus(taskStatus);
      const handled = summary.submitted + summary.applied + summary.failed;
      await syncStateAfterStage(normalizedScope, {
        state: {
          tasksStatus: taskStatus,
          parseWorkerState: {
            ...state.parseWorkerState,
            total: summary.pending + summary.submitted + summary.applied + summary.failed,
            completed: handled,
            failed: summary.failed,
            currentLabel: safeText(taskStatus?.next_work?.next_pending_task?.batch_id || state?.parseWorkerState?.currentLabel),
            mode: 'running'
          }
        }
      });

      if (summary.pending > 0) {
        const nextTask = await getNextPendingTranslationWorkerPacket({
          owner_id: normalizedScope.owner_id,
          realm_id: normalizedScope.realm_id,
          limit: 1
        });
        const currentLabel = safeText(nextTask?.next_task?.summary?.batch_id || nextTask?.next_task?.task_label || '当前分片');
        await syncStateAfterStage(normalizedScope, {
          state: {
            parseWorkerState: {
              ...state.parseWorkerState,
              total: summary.pending + summary.submitted + summary.applied + summary.failed,
              completed: handled,
              failed: summary.failed,
              currentLabel,
              mode: 'running'
            }
          }
        });
        const result = await runRuntimeAiTranslationTask({
          scope: normalizedScope,
          api: apiConfig,
          source: { label: `${safeText(sourceEnvelope?.source?.label, 'runtime')}__runtime_ai` }
        });
        await syncStateAfterStage(normalizedScope, {
          state: {
            lastDrain: result
          }
        });
        continue;
      }

      const clusters = await getRuntimeReviewedClusters({ scope: normalizedScope });
      await syncStateAfterStage(normalizedScope, {
        state: {
          lastReviewedClusters: clusters,
          parseWorkerState: {
            ...state.parseWorkerState,
            currentLabel: 'reviewed 去重与收束',
            mode: 'running'
          }
        }
      });

      if (runtime.state.parsePauseRequested) {
        await settlePause(normalizedScope, '去重前已停下');
        break;
      }

      const ambiguous = Array.isArray(clusters?.clusters)
        ? clusters.clusters.filter((item) => item?.ambiguous && toNumber(item?.entry_count, 0) > 1)
        : [];
      const aiMerges = {};
      for (const cluster of ambiguous) {
        runtime = await loadRuntimePayload(normalizedScope);
        if (!runtime?.state?.parseRunning || runtime?.state?.parsePauseRequested) {
          await settlePause(normalizedScope, '去重中途停在断点');
          return;
        }
        await syncStateAfterStage(normalizedScope, {
          state: {
            parseWorkerState: {
              ...runtime.state.parseWorkerState,
              currentLabel: safeText(cluster.cluster_id, 'reviewed 合并'),
              mode: 'running'
            }
          }
        });
        const merged = await runRuntimeReviewedMerge({
          scope: normalizedScope,
          cluster_id: cluster.cluster_id,
          api: apiConfig
        });
        if (merged?.entry) {
          aiMerges[cluster.cluster_id] = merged.entry;
        }
      }

      const finalize = await finalizeRuntimeReviewedEntries({
        scope: normalizedScope,
        source: { label: `${safeText(sourceEnvelope?.source?.label, 'runtime')}__reviewed_finalize` },
        ai_merges: aiMerges
      });
      await markCompleted(normalizedScope, {
        lastReviewedFinalize: finalize,
        lastDrain: finalize
      });
      break;
    }
  } catch (error) {
    await markRuntimeError(normalizedScope, safeText(error?.message, 'parse runtime failed'));
  } finally {
    workerMap.delete(scopeKey(normalizedScope));
  }
}

function kickParseRuntimeWorker(scope = {}) {
  const normalizedScope = buildScope(scope);
  const key = scopeKey(normalizedScope);
  if (workerMap.has(key)) return;
  const runner = runParseRuntimeWorker(normalizedScope);
  workerMap.set(key, runner);
}

export async function getParseRuntimeStateRaw({ ownerId = '', realmId = '' } = {}) {
  const scope = buildScope({
    owner_id: ownerId,
    realm_id: realmId
  });
  return loadRuntimePayload(scope);
}

export async function getParseRuntimeState({ ownerId = '', realmId = '' } = {}) {
  const payload = await getParseRuntimeStateRaw({ ownerId, realmId });
  return payload || {
    saved_at: '',
    active_scope: null,
    state: null,
    runtime_config: {
      source_envelope: { source: {}, input: {} },
      parse_plan: normalizeParsePlan({}),
      api_config: normalizeApiConfig({})
    }
  };
}

export async function startParseRuntime(body = {}) {
  const scope = buildScope(body?.scope || {});
  const sourceEnvelope = normalizeSourceEnvelope(body?.source_envelope || body?.sourceEnvelope || body);
  const parsePlan = normalizeParsePlan(body?.parse_plan || body?.parsePlan);
  const apiConfig = normalizeApiConfig(body?.api_config || body?.apiConfig || body?.api);
  const current = await loadRuntimePayload(scope);
  const payload = patchRuntimePayload(
    current || normalizeRuntimePayload(scope, { state: {}, runtime_config: {} }),
    {
      state: {
        sessionId: safeText(scope.realm_id),
        parseRunning: true,
        parsePaused: false,
        parsePauseRequested: false,
        parseError: '',
        parsePlan,
        parseWorkerState: {
          total: 0,
          completed: 0,
          failed: 0,
          currentLabel: '接住原始记录',
          mode: 'running'
        },
        lastIngest: null,
        lastTranslation: null,
        lastTaskPrepare: null,
        lastReviewedClusters: null,
        lastReviewedFinalize: null,
        lastDrain: null,
        tasksStatus: buildEmptyTaskStatus(scope)
      },
      runtime_config: {
        source_envelope: sourceEnvelope,
        parse_plan: parsePlan,
        api_config: apiConfig
      }
    }
  );
  await writeRuntimePayload(payload);
  kickParseRuntimeWorker(scope);
  return payload;
}

export async function pauseParseRuntime(body = {}) {
  const scope = buildScope(body?.scope || body || {});
  const payload = await updateRuntimeState(scope, (current) => patchRuntimePayload(current, {
    state: {
      parsePauseRequested: true,
      parseError: ''
    }
  }));
  kickParseRuntimeWorker(scope);
  return payload;
}

export async function resumeParseRuntime(body = {}) {
  const scope = buildScope(body?.scope || body || {});
  const current = await loadRuntimePayload(scope);
  const payload = patchRuntimePayload(
    current || normalizeRuntimePayload(scope, { state: {}, runtime_config: {} }),
    {
      state: {
        parseRunning: true,
        parsePaused: false,
        parsePauseRequested: false,
        parseError: '',
        parseWorkerState: {
          ...(current?.state?.parseWorkerState || {}),
          currentLabel: safeText(current?.state?.parseWorkerState?.currentLabel || '从断点继续'),
          mode: 'running'
        }
      },
      runtime_config: {
        api_config: {
          ...(current?.runtime_config?.api_config || {}),
          ...normalizeApiConfig(body?.api_config || body?.apiConfig || body?.api || {})
        }
      }
    }
  );
  await writeRuntimePayload(payload);
  kickParseRuntimeWorker(scope);
  return payload;
}
