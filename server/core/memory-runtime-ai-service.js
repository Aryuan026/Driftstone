import { appendRuntimeReviewedEntries, getRuntimeReviewedClusters } from './memory-reviewed-service.js';
import { buildMemoryScope } from './scope-contract.js';
import { failAiTranslationTask } from './memory-translation-ai-service.js';
import { buildProgrammaticEntriesFromSlices } from './programmatic-translator.js';
import {
  getNextPendingTranslationWorkerPacket,
  getTranslationTaskWorkerPacket
} from './memory-translation-task-service.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function summarizeTaskFile(taskFile = '') {
  const text = safeText(taskFile);
  return text ? text.split('/').at(-1) || text : '';
}

async function readMaybeJson(resp) {
  const raw = await resp.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function buildApiErrorMessage(payload = {}, fallback = '') {
  return safeText(
    payload?.error?.message
      || payload?.error?.code
      || payload?.error
      || payload?.message
      || payload?.raw
      || fallback,
    fallback
  );
}

function extractModelOutput(payload = {}) {
  const message = payload?.choices?.[0]?.message?.content;
  if (typeof message === 'string') return message.trim();
  if (Array.isArray(message)) {
    return message
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text') return item.text || '';
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

function normalizeApiConfig(api = {}) {
  const baseUrl = safeText(api?.baseUrl).replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey: typeof api?.apiKey === 'string' ? api.apiKey : '',
    model: safeText(api?.model, 'gpt-4o-mini')
  };
}

function isProgrammaticApi(api = {}) {
  const config = normalizeApiConfig(api);
  const base = safeText(config.baseUrl).toLowerCase();
  const model = safeText(config.model).toLowerCase();
  return base.startsWith('mock://') || base.startsWith('local://') || model === 'local-programmatic' || model === '__programmatic__';
}

async function requestModelCompletion({
  api = {},
  systemPrompt = '',
  userPrompt = '',
  responseFormat = null,
  temperature = 0.2
} = {}) {
  const config = normalizeApiConfig(api);
  if (!config.baseUrl || !config.model) {
    throw new Error('缺少可用的 API 配置');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: safeText(systemPrompt) },
      { role: 'user', content: safeText(userPrompt) }
    ],
    temperature
  };

  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const payload = await readMaybeJson(resp);
  if (!resp.ok) {
    throw new Error(buildApiErrorMessage(payload, `API Error ${resp.status}`));
  }
  const rawOutput = extractModelOutput(payload);
  if (!rawOutput) {
    throw new Error('模型返回了空内容');
  }
  return rawOutput;
}

function tryParseJsonObject(raw = '') {
  const text = safeText(raw);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildReviewedClusterInput(cluster = {}) {
  return {
    cluster_id: safeText(cluster.cluster_id),
    root_key: safeText(cluster.root_key),
    entry_count: Number(cluster.entry_count || 0),
    entries: (Array.isArray(cluster.items) ? cluster.items : []).map((item) => ({
      item_id: safeText(item.item_id),
      task_file: safeText(item.task_file),
      batch_id: safeText(item.batch_id),
      signature: safeText(item.signature),
      entry: item.entry || {}
    }))
  };
}

async function requestReviewedMerge(cluster = {}, api = {}) {
  const systemPrompt = [
    '你是记忆条目去冗余整合器。',
    '目标：把同一个 cluster 里的多条记忆条目合并成 1 条，不丢失关键事实、时间边界、近期更新和溯源信息。',
    '输出要求：只输出 1 个 JSON 对象，不要解释，不要 markdown。',
    '字段要求：尽量沿用输入字段，必须保留 anchor_type、canonical_name、first_seen_at、last_seen_at、stable_facts、recent_updates、provenance、conflict_hint。',
    '合并原则：优先保留信息更多、更具体、更可追溯的内容；冲突保留 conflict_hint=true。'
  ].join('\n');

  const rawOutput = await requestModelCompletion({
    api,
    systemPrompt,
    userPrompt: JSON.stringify(buildReviewedClusterInput(cluster), null, 2),
    temperature: 0.1
  });
  const parsed = tryParseJsonObject(rawOutput);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型返回的去重结果不是 JSON 对象');
  }
  return parsed;
}

export async function runRuntimeAiTranslationTask(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });

  const taskResult = safeText(body?.task_file)
    ? await getTranslationTaskWorkerPacket(safeText(body.task_file))
    : await getNextPendingTranslationWorkerPacket({
        owner_id: scope.owner_id,
        realm_id: scope.realm_id,
        limit: Number(body?.limit || 20)
      });

  const workerPacket = safeText(body?.task_file)
    ? taskResult
    : taskResult?.next_task || null;

  if (!workerPacket?.task_file) {
    return {
      ok: true,
      schema: 'hippocove_runtime_ai_task_run_v0.1',
      scope,
      status: 'idle',
      task_file: '',
      task_label: '',
      parsed_entries: 0,
      reviewed: {},
      home: {},
      home_summary: {},
      latest_status: taskResult?.status_summary || {},
      message: '当前没有待处理的提炼任务。'
    };
  }

  const label = safeText(workerPacket?.summary?.batch_id || summarizeTaskFile(workerPacket.task_file) || '当前分片');
  let rawOutput = '';
  try {
    if (isProgrammaticApi(body?.api)) {
      const entries = await buildProgrammaticEntriesFromSlices(workerPacket.slices || []);
      if (!entries.length) {
        throw new Error('本地快检没有从当前分片提取出稳定条目');
      }
      const appended = await appendRuntimeReviewedEntries({
        scope,
        task_file: workerPacket.task_file,
        entries,
        source: {
          label: safeText(body?.source?.label || `${label}__runtime_programmatic`)
        }
      });

      return {
        ok: Boolean(appended?.ok),
        schema: 'hippocove_runtime_ai_task_run_v0.1',
        scope: appended?.scope || scope,
        status: appended?.ok ? 'submitted' : 'failed',
        task_file: workerPacket.task_file,
        task_label: summarizeTaskFile(workerPacket.task_file),
        batch_id: safeText(workerPacket?.summary?.batch_id),
        parsed_entries: Number(appended?.parsed_entries || entries.length || 0),
        reviewed: appended?.reviewed || {},
        home: appended?.home || {},
        home_summary: appended?.home_summary || {},
        latest_status: taskResult?.status_summary || {},
        error: safeText(appended?.error)
      };
    }

    const aiContract = workerPacket?.ai_contract || {};
    try {
      rawOutput = await requestModelCompletion({
        api: body?.api,
        systemPrompt: aiContract.system_prompt,
        userPrompt: aiContract.user_prompt,
        responseFormat: aiContract.response_format,
        temperature: 0.2
      });
    } catch (_) {
      rawOutput = await requestModelCompletion({
        api: body?.api,
        systemPrompt: [safeText(aiContract.system_prompt), safeText(aiContract.fallback_prompt)].filter(Boolean).join('\n\n'),
        userPrompt: aiContract.user_prompt,
        temperature: 0.1
      });
    }

    const appended = await appendRuntimeReviewedEntries({
      scope,
      task_file: workerPacket.task_file,
      raw_output: rawOutput,
      source: {
        label: safeText(body?.source?.label || `${label}__runtime_ai`)
      }
    });

    return {
      ok: Boolean(appended?.ok),
      schema: 'hippocove_runtime_ai_task_run_v0.1',
      scope: appended?.scope || scope,
      status: appended?.ok ? 'submitted' : 'failed',
      task_file: workerPacket.task_file,
      task_label: summarizeTaskFile(workerPacket.task_file),
      batch_id: safeText(workerPacket?.summary?.batch_id),
      parsed_entries: Number(appended?.parsed_entries || 0),
      reviewed: appended?.reviewed || {},
      home: appended?.home || {},
      home_summary: appended?.home_summary || {},
      latest_status: taskResult?.status_summary || {},
      error: safeText(appended?.error)
    };
  } catch (error) {
    const failed = await failAiTranslationTask({
      scope,
      task_file: workerPacket.task_file,
      raw_output: rawOutput,
      error_note: safeText(error.message, 'runtime ai worker failed'),
      source: {
        label: safeText(body?.source?.label || `${label}__runtime_ai_fail`)
      }
    });

    return {
      ok: false,
      schema: 'hippocove_runtime_ai_task_run_v0.1',
      scope: failed?.scope || scope,
      status: 'failed',
      task_file: workerPacket.task_file,
      task_label: summarizeTaskFile(workerPacket.task_file),
      batch_id: safeText(workerPacket?.summary?.batch_id),
      parsed_entries: 0,
      reviewed: {},
      home: failed?.home || {},
      home_summary: failed?.home_summary || {},
      latest_status: taskResult?.status_summary || {},
      error: safeText(error.message, 'runtime ai worker failed')
    };
  }
}

export async function runRuntimeReviewedMerge(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const clustersPayload = await getRuntimeReviewedClusters({ scope });
  const clusterId = safeText(body?.cluster_id);
  const cluster = (Array.isArray(clustersPayload?.clusters) ? clustersPayload.clusters : [])
    .find((item) => safeText(item.cluster_id) === clusterId);

  if (!clusterId || !cluster) {
    return {
      ok: false,
      schema: 'hippocove_runtime_reviewed_merge_v0.1',
      scope,
      error: 'cluster_id not found'
    };
  }

  if (isProgrammaticApi(body?.api)) {
    return {
      ok: true,
      schema: 'hippocove_runtime_reviewed_merge_v0.1',
      scope,
      cluster_id: clusterId,
      used_ai: false,
      fallback: true,
      entry: cluster.merged_entry || null
    };
  }

  if (!cluster.ambiguous || Number(cluster.entry_count || 0) <= 1) {
    return {
      ok: true,
      schema: 'hippocove_runtime_reviewed_merge_v0.1',
      scope,
      cluster_id: clusterId,
      used_ai: false,
      fallback: true,
      entry: cluster.merged_entry || null
    };
  }

  try {
    const entry = await requestReviewedMerge(cluster, body?.api);
    return {
      ok: true,
      schema: 'hippocove_runtime_reviewed_merge_v0.1',
      scope,
      cluster_id: clusterId,
      used_ai: true,
      fallback: false,
      entry
    };
  } catch {
    return {
      ok: true,
      schema: 'hippocove_runtime_reviewed_merge_v0.1',
      scope,
      cluster_id: clusterId,
      used_ai: false,
      fallback: true,
      entry: cluster.merged_entry || null
    };
  }
}
