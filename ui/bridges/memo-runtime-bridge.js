import { getJson, postJson } from '../api-client.js';
import { mergeReviewedClustersWithAi } from './reviewed-merge-bridge.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function summarizeTaskTotals(tasks = {}) {
  return {
    pending: Number(tasks?.pending || 0),
    submitted: Number(tasks?.submitted || 0),
    applied: Number(tasks?.applied || 0),
    failed: Number(tasks?.failed || 0),
    total: Number(tasks?.pending || 0)
      + Number(tasks?.submitted || 0)
      + Number(tasks?.applied || 0)
      + Number(tasks?.failed || 0)
  };
}

async function runTranslationWorkerTask(backendBase, workerPacket, apiConfig, scope) {
  const label = safeText(workerPacket?.summary?.batch_id || workerPacket?.task_file?.split('/').at(-1) || '当前分片');
  const submitted = await postJson(backendBase, '/api/memory/runtime/task/run', {
    scope,
    api: apiConfig,
    task_file: workerPacket.task_file,
    source: {
      label: `${label}__runtime_ai`
    }
  });

  if (!submitted.ok || submitted.payload?.ok === false) {
    return {
      ok: false,
      error: safeText(submitted.payload?.error, `runtime task failed (${submitted.status})`)
    };
  }

  return {
    ok: true,
    payload: submitted.payload
  };
}

export async function runRuntimeParseBridge({
  backendBase,
  scope,
  sourceEnvelope,
  parsePlan,
  apiConfig,
  existing = null,
  shouldPause = async () => false,
  onStage = async () => {},
  onWorkerState = () => {}
}) {
  let ingestPayload = existing?.ingest || null;
  let translationPayload = existing?.translation || null;
  let taskPreparePayload = existing?.taskPrepare || null;
  let drainPayload = existing?.drain || null;
  let reviewedClustersPayload = existing?.reviewedClusters || null;
  let reviewedFinalizePayload = existing?.reviewedFinalize || null;

  if (!ingestPayload) {
    const ingest = await postJson(backendBase, '/api/memory/ingest', {
      scope,
      source: sourceEnvelope.source,
      input: sourceEnvelope.input
    });

    if (!ingest.ok || ingest.payload?.ok === false) {
      throw new Error(safeText(ingest.payload?.error, `ingest failed (${ingest.status})`));
    }
    ingestPayload = ingest.payload;
    await onStage({ type: 'ingest', payload: ingestPayload });
    if (await shouldPause({ stage: 'after-ingest' })) {
      return {
        paused: true,
        ingest: ingestPayload,
        translation: translationPayload,
        taskPrepare: taskPreparePayload,
        drain: drainPayload
      };
    }
  }

  if (!translationPayload) {
    const translation = await postJson(backendBase, '/api/memory/translate', {
      scope,
      source: {
        label: `${sourceEnvelope.source.label}__translate`
      },
      packet_file: safeText(ingestPayload?.ingest?.packet_file),
      target_chars: parsePlan?.targetChars || 2200
    });

    if (!translation.ok || translation.payload?.ok === false) {
      throw new Error(safeText(translation.payload?.error, `translation build failed (${translation.status})`));
    }
    translationPayload = translation.payload;
    await onStage({ type: 'translation', payload: translationPayload });
    if (await shouldPause({ stage: 'after-translation' })) {
      return {
        paused: true,
        ingest: ingestPayload,
        translation: translationPayload,
        taskPrepare: taskPreparePayload,
        drain: drainPayload
      };
    }
  }

  if (!taskPreparePayload) {
    const prepare = await postJson(backendBase, '/api/memory/translate/prepare', {
      scope,
      source: {
        label: `${sourceEnvelope.source.label}__prepare`
      },
      packet_file: safeText(translationPayload?.translation?.packet_file),
      batch: {
        max_slices: parsePlan?.maxSlices || 1,
        max_chars: parsePlan?.maxChars || 2200,
        entry_limit: parsePlan?.entryLimit || 6
      }
    });

    if (!prepare.ok || prepare.payload?.ok === false) {
      throw new Error(safeText(prepare.payload?.error, `task prepare failed (${prepare.status})`));
    }
    taskPreparePayload = prepare.payload;
    await onStage({ type: 'task-prepare', payload: taskPreparePayload });
  }

  if (await shouldPause({ stage: 'after-prepare' })) {
    return {
      paused: true,
      ingest: ingestPayload,
      translation: translationPayload,
      taskPrepare: taskPreparePayload,
      drain: drainPayload
    };
  }

  onWorkerState({
    total: Number(taskPreparePayload?.summary?.batch_count || 0),
    completed: 0,
    failed: 0,
    currentLabel: '',
    mode: 'running'
  });

  while (true) {
    const worker = await getJson(backendBase, '/api/memory/translate/task/next/worker', {
      owner_id: scope.owner_id,
      realm_id: scope.realm_id,
      limit: 20
    });
    if (!worker.ok || worker.payload?.ok === false) {
      throw new Error(safeText(worker.payload?.error, `task fetch failed (${worker.status})`));
    }

    const workerPacket = worker.payload?.next_task || null;
    const statusSummary = summarizeTaskTotals(worker.payload?.status_summary || {});
    const nextIndex = Math.min(
      statusSummary.submitted + statusSummary.applied + statusSummary.failed + 1,
      Math.max(statusSummary.total, 1)
    );

    onWorkerState({
      total: statusSummary.total,
      completed: statusSummary.submitted + statusSummary.applied + statusSummary.failed,
      failed: statusSummary.failed,
      currentLabel: workerPacket?.task_file
        ? `${nextIndex}/${Math.max(statusSummary.total, 1)} · ${safeText(workerPacket?.summary?.batch_id || '当前分片')}`
        : '',
      mode: workerPacket?.task_file ? 'running' : 'idle'
    });

    if (!workerPacket?.task_file) break;

    if (await shouldPause({
      stage: 'before-worker-task',
      workerPacket,
      statusSummary
    })) {
      return {
        paused: true,
        ingest: ingestPayload,
        translation: translationPayload,
        taskPrepare: taskPreparePayload,
        drain: drainPayload,
        reviewedClusters: reviewedClustersPayload,
        reviewedFinalize: reviewedFinalizePayload
      };
    }

    const taskResult = await runTranslationWorkerTask(backendBase, workerPacket, apiConfig, scope);
    await onStage({
      type: 'worker-result',
      payload: taskResult,
      worker_payload: worker.payload
    });

    if (await shouldPause({
      stage: 'after-worker-task',
      workerPacket,
      taskResult,
      statusSummary
    })) {
      return {
        paused: true,
        ingest: ingestPayload,
        translation: translationPayload,
        taskPrepare: taskPreparePayload,
        drain: drainPayload,
        reviewedClusters: reviewedClustersPayload,
        reviewedFinalize: reviewedFinalizePayload
      };
    }
  }

  if (!reviewedClustersPayload) {
    onWorkerState({
      total: 1,
      completed: 0,
      failed: 0,
      currentLabel: '聚合提炼结果',
      mode: 'dedup'
    });

    const clustersResp = await postJson(backendBase, '/api/memory/reviewed/clusters', {
      scope
    });
    if (!clustersResp.ok || clustersResp.payload?.ok === false) {
      throw new Error(safeText(clustersResp.payload?.error, `reviewed clusters failed (${clustersResp.status})`));
    }
    reviewedClustersPayload = clustersResp.payload;
    await onStage({ type: 'reviewed-clusters', payload: reviewedClustersPayload });
  }

  if (await shouldPause({ stage: 'after-reviewed-clusters', reviewedClusters: reviewedClustersPayload })) {
    return {
      paused: true,
      ingest: ingestPayload,
      translation: translationPayload,
      taskPrepare: taskPreparePayload,
      drain: drainPayload,
      reviewedClusters: reviewedClustersPayload,
      reviewedFinalize: reviewedFinalizePayload
    };
  }

  const ambiguousCount = Number(reviewedClustersPayload?.summary?.ambiguous_cluster_count || 0);
  let aiMergeSummary = {
    ai_merges: [],
    ambiguous_count: ambiguousCount,
    ai_used: 0,
    fallback_count: ambiguousCount
  };

  if (!reviewedFinalizePayload) {
    onWorkerState({
      total: Math.max(ambiguousCount, 1),
      completed: 0,
      failed: 0,
      currentLabel: ambiguousCount ? 'AI 去重准备中' : '代码去重收尾中',
      mode: 'dedup'
    });

    aiMergeSummary = await mergeReviewedClustersWithAi({
      backendBase,
      scope,
      clusters: reviewedClustersPayload?.clusters || [],
      apiConfig,
      intervalMs: ambiguousCount > 1 ? 900 : 0,
      onProgress: ({ current, total, aiUsed, fallbackCount, label }) => {
        onWorkerState({
          total,
          completed: current,
          failed: fallbackCount,
          currentLabel: `${current}/${Math.max(total, 1)} · ${safeText(label || '当前簇')}${aiUsed ? ` · AI ${aiUsed}` : ''}`,
          mode: 'dedup'
        });
      }
    });
    await onStage({ type: 'reviewed-ai-merge', payload: aiMergeSummary });

    if (await shouldPause({ stage: 'after-reviewed-ai-merge', reviewedClusters: reviewedClustersPayload, aiMergeSummary })) {
      return {
        paused: true,
        ingest: ingestPayload,
        translation: translationPayload,
        taskPrepare: taskPreparePayload,
        drain: drainPayload,
        reviewedClusters: reviewedClustersPayload,
        reviewedFinalize: reviewedFinalizePayload
      };
    }

    const finalizeResp = await postJson(backendBase, '/api/memory/reviewed/finalize', {
      scope,
      source: {
        label: `${sourceEnvelope.source.label}__reviewed_finalize`
      },
      ai_merges: aiMergeSummary.ai_merges
    });
    if (!finalizeResp.ok || finalizeResp.payload?.ok === false) {
      throw new Error(safeText(finalizeResp.payload?.error, `reviewed finalize failed (${finalizeResp.status})`));
    }
    reviewedFinalizePayload = finalizeResp.payload;
    await onStage({ type: 'reviewed-finalize', payload: reviewedFinalizePayload });
  }

  drainPayload = {
    ok: true,
    mode: 'runtime_ai_reviewed_drain',
    summary: {
      target_chars: parsePlan?.targetChars || 0,
      slice_count: Number(translationPayload?.translation?.slice_count || 0),
      batch_count: Number(taskPreparePayload?.summary?.batch_count || 0),
      reviewed_clusters: Number(reviewedClustersPayload?.summary?.cluster_count || 0),
      ambiguous_clusters: Number(reviewedClustersPayload?.summary?.ambiguous_cluster_count || 0),
      ai_merge_used: Number(aiMergeSummary.ai_used || 0),
      ai_merge_fallback: Number(aiMergeSummary.fallback_count || 0),
      merged_entries: Number(reviewedFinalizePayload?.merged_entries || 0),
      created_roots: Number(reviewedFinalizePayload?.writeback?.summary?.created_roots || 0),
      updated_roots: Number(reviewedFinalizePayload?.writeback?.summary?.updated_roots || 0)
    },
    reviewed_clusters: reviewedClustersPayload,
    reviewed_finalize: reviewedFinalizePayload
  };
  await onStage({ type: 'drain', payload: drainPayload });

  onWorkerState({
    currentLabel: '',
    mode: 'idle'
  });

  return {
    paused: false,
    ingest: ingestPayload,
    translation: translationPayload,
    taskPrepare: taskPreparePayload,
    drain: drainPayload,
    reviewedClusters: reviewedClustersPayload,
    reviewedFinalize: reviewedFinalizePayload
  };
}

export function buildRuntimeMaterialsExport({
  sessionId,
  sourceLabel,
  parsePlan,
  parseDashboard,
  ingest,
  translation,
  taskPrepare,
  parseRun
}) {
  return {
    schema: 'hippocove_runtime_material_export_v0.3',
    exported_at: new Date().toISOString(),
    session_id: sessionId,
    source_label: sourceLabel,
    parse_plan: parsePlan || {},
    parse_dashboard: parseDashboard || {},
    ingest: ingest || null,
    translation: translation || null,
    task_prepare: taskPrepare || null,
    parse_run: parseRun || null
  };
}
