import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { RUNTIME_SAVE_DIR, getScopedTruthDir, safeScopeSegment } from './path-config.js';
import { generateGrowthDraft } from './growth-generate-service.js';
import { loadLatestTranslationTaskPacket, loadTranslationTaskByFile } from './translation-task-store.js';

const GROWTH_RUNTIME_STATE_DIR = join(RUNTIME_SAVE_DIR, 'growth_runtime_state');
const GROWTH_RUNTIME_STATE_FILE = join(GROWTH_RUNTIME_STATE_DIR, 'latest.json');
const workerMap = new Map();

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function hasOwn(input, key) {
  return Boolean(input) && Object.prototype.hasOwnProperty.call(input, key);
}

function hasAnyOwn(input, keys = []) {
  return (Array.isArray(keys) ? keys : []).some((key) => hasOwn(input, key));
}

function clipText(value, limit = 72) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function scopeKey(scope = {}) {
  return `${safeText(scope.owner_id, 'history-to-obsidian')}::${safeText(scope.realm_id, 'default')}`;
}

function normalizeScope(input = {}) {
  const ownerId = safeText(input?.owner_id || input?.ownerId, 'history-to-obsidian');
  const realmId = safeText(input?.realm_id || input?.realmId || input?.sessionId, '');
  if (!realmId) {
    throw new Error('缺少可用的 growth scope');
  }
  return {
    owner_id: ownerId,
    realm_id: realmId
  };
}

function normalizeGrowthRuntimeOptions(options = {}) {
  return {
    ownerId: safeText(options?.ownerId || options?.owner_id),
    realmId: safeText(options?.realmId || options?.realm_id || options?.sessionId || options?.session_id),
    botId: safeText(options?.botId || options?.bot_id),
    userId: safeText(options?.userId || options?.user_id),
    charId: safeText(options?.charId || options?.char_id),
    key: safeText(options?.key),
    query: safeText(options?.query),
    familyId: safeText(options?.familyId || options?.family_id),
    cardType: safeText(options?.cardType || options?.card_type, 'memo'),
    packetId: safeText(options?.packetId || options?.packet_id),
    includePersonaRows: options?.includePersonaRows ?? options?.include_persona_rows ?? true,
    rowLimit: Math.max(1, toNumber(options?.rowLimit ?? options?.row_limit, 8)),
    apiProfileName: safeText(options?.apiProfileName || options?.api_profile_name),
    mode: safeText(options?.mode),
    commit: toBoolean(options?.commit, false),
    saveArtifact: options?.saveArtifact ?? options?.save_artifact ?? true,
    exportToObsidian: options?.exportToObsidian ?? options?.export_to_obsidian ?? false,
    exportRoot: safeText(options?.exportRoot || options?.export_root),
    overwriteExport: options?.overwriteExport ?? options?.overwrite_export ?? false
  };
}

function mergeResumeGrowthRuntimeOptions(previousOptions = {}, rawOptions = {}, scope = {}) {
  const hasPrevious = previousOptions && typeof previousOptions === 'object' && Object.keys(previousOptions).length > 0;
  const normalizedPrevious = hasPrevious ? normalizeGrowthRuntimeOptions(previousOptions) : {};
  const normalizedNext = normalizeGrowthRuntimeOptions(rawOptions);
  const merged = {
    ...normalizedPrevious
  };
  const stringFields = [
    ['ownerId', ['ownerId', 'owner_id']],
    ['realmId', ['realmId', 'realm_id', 'sessionId', 'session_id']],
    ['botId', ['botId', 'bot_id']],
    ['userId', ['userId', 'user_id']],
    ['charId', ['charId', 'char_id']],
    ['key', ['key']],
    ['query', ['query']],
    ['familyId', ['familyId', 'family_id']],
    ['cardType', ['cardType', 'card_type']],
    ['packetId', ['packetId', 'packet_id']],
    ['apiProfileName', ['apiProfileName', 'api_profile_name']],
    ['mode', ['mode']],
    ['exportRoot', ['exportRoot', 'export_root']]
  ];
  for (const [field, aliases] of stringFields) {
    if (hasAnyOwn(rawOptions, aliases)) merged[field] = normalizedNext[field];
  }
  const booleanFields = [
    ['includePersonaRows', ['includePersonaRows', 'include_persona_rows']],
    ['commit', ['commit']],
    ['saveArtifact', ['saveArtifact', 'save_artifact']],
    ['exportToObsidian', ['exportToObsidian', 'export_to_obsidian']],
    ['overwriteExport', ['overwriteExport', 'overwrite_export']]
  ];
  for (const [field, aliases] of booleanFields) {
    if (hasAnyOwn(rawOptions, aliases)) merged[field] = normalizedNext[field];
  }
  if (hasAnyOwn(rawOptions, ['rowLimit', 'row_limit'])) {
    merged.rowLimit = normalizedNext.rowLimit;
  }
  if (!hasPrevious) {
    return {
      ...normalizedNext,
      ownerId: safeText(scope.owner_id || normalizedNext.ownerId),
      realmId: safeText(scope.realm_id || normalizedNext.realmId)
    };
  }
  return {
    ...merged,
    ownerId: safeText(scope.owner_id || merged.ownerId),
    realmId: safeText(scope.realm_id || merged.realmId)
  };
}

function getScopedRuntimeStateFile(ownerId = '', realmId = '') {
  if (!ownerId || !realmId) return '';
  return join(
    getScopedTruthDir(ownerId, realmId),
    'growth_runtime_state',
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

function buildStatePayload(scope = {}, state = {}) {
  return {
    saved_at: new Date().toISOString(),
    active_scope: clone(scope),
    state: clone(state) || {}
  };
}

async function persistGrowthRuntimeState(scope = {}, state = {}) {
  const payload = buildStatePayload(scope, state);
  await mkdir(GROWTH_RUNTIME_STATE_DIR, { recursive: true });
  await writeFile(GROWTH_RUNTIME_STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  if (scope?.owner_id && scope?.realm_id) {
    const scopedRoot = join(getScopedTruthDir(scope.owner_id, scope.realm_id), 'growth_runtime_state');
    await mkdir(scopedRoot, { recursive: true });
    await writeFile(
      getScopedRuntimeStateFile(scope.owner_id, scope.realm_id),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    );
  }
  return payload;
}

function buildCompletionBundle(scope = {}, result = {}) {
  if (!result || typeof result !== 'object' || result.ok === false) return null;
  const draft = result.draft && typeof result.draft === 'object' ? result.draft : {};
  return {
    schema: 'hippocove_growth_runtime_bundle_v0.1',
    generated_at: safeText(draft.generated_at || new Date().toISOString()),
    source_label: 'growth-runtime',
    session_id: safeText(scope.realm_id),
    growth_result: {
      ok: true,
      task: clone(result.task || {}),
      api: clone(result.api || {}),
      draft: clone(draft),
      committed: Boolean(result.committed),
      exported: Boolean(result.exported)
    },
    export_result: clone(result.export_result || null),
    artifact: clone(result.artifact || null)
  };
}

function buildRequestOptionState(options = {}) {
  const normalized = normalizeGrowthRuntimeOptions(options);
  return {
    owner_id: safeText(normalized.ownerId),
    realm_id: safeText(normalized.realmId),
    bot_id: safeText(normalized.botId),
    user_id: safeText(normalized.userId),
    char_id: safeText(normalized.charId),
    key: safeText(normalized.key),
    query: safeText(normalized.query),
    family_id: safeText(normalized.familyId),
    card_type: safeText(normalized.cardType, 'memo'),
    packet_id: safeText(normalized.packetId),
    include_persona_rows: Boolean(normalized.includePersonaRows),
    row_limit: Math.max(1, toNumber(normalized.rowLimit, 8)),
    api_profile_name: safeText(normalized.apiProfileName),
    mode: safeText(normalized.mode),
    commit: Boolean(normalized.commit),
    save_artifact: normalized.saveArtifact !== false,
    export_to_obsidian: Boolean(normalized.exportToObsidian),
    export_root: safeText(normalized.exportRoot),
    overwrite_export: Boolean(normalized.overwriteExport)
  };
}

function normalizeQueueItem(item = {}, index = 0) {
  return {
    queue_id: safeText(item.queue_id || item.batch_id || `growth-item-${index + 1}`),
    task_index: Math.max(1, toNumber(item.task_index || index + 1, index + 1)),
    batch_id: safeText(item.batch_id),
    task_file: safeText(item.task_file),
    source_status: safeText(item.source_status || 'pending'),
    title: safeText(item.title, `第 ${index + 1} 组材料`),
    label: safeText(item.label, safeText(item.title, `第 ${index + 1} 组材料`)),
    preview: safeText(item.preview),
    key: safeText(item.key),
    query: safeText(item.query),
    slice_count: Math.max(0, toNumber(item.slice_count, 0)),
    total_chars: Math.max(0, toNumber(item.total_chars, 0)),
    runtime_status: safeText(item.runtime_status || 'pending'),
    error: safeText(item.error),
    artifact_id: safeText(item.artifact_id),
    target_card_id: safeText(item.target_card_id),
    source_focus: safeText(item.source_focus || item.title),
    export_file: safeText(item.export_file),
    started_at: safeText(item.started_at),
    finished_at: safeText(item.finished_at)
  };
}

function normalizeQueue(items = []) {
  return (Array.isArray(items) ? items : []).map((item, index) => normalizeQueueItem(item, index));
}

function deriveQueueTitle(taskDoc = {}, row = {}) {
  const previews = Array.isArray(taskDoc?.summary?.previews) ? taskDoc.summary.previews : [];
  const slices = Array.isArray(taskDoc?.task?.slices) ? taskDoc.task.slices : [];
  return safeText(
    previews[0]?.title
    || slices[0]?.title
    || row?.batch_id
    || `第 ${Number(row?.task_index || 0) || 1} 组材料`,
    `第 ${Number(row?.task_index || 0) || 1} 组材料`
  );
}

function deriveQueuePreview(taskDoc = {}) {
  const previews = Array.isArray(taskDoc?.summary?.previews) ? taskDoc.summary.previews : [];
  const slices = Array.isArray(taskDoc?.task?.slices) ? taskDoc.task.slices : [];
  return safeText(
    previews[0]?.preview
    || previews[1]?.preview
    || slices[0]?.preview
    || slices[1]?.preview
    || ''
  );
}

function deriveQueueQuery(taskDoc = {}, title = '', preview = '') {
  const slices = Array.isArray(taskDoc?.task?.slices) ? taskDoc.task.slices : [];
  const promptHint = safeText(slices[0]?.prompt_hint);
  return safeText([title, preview, promptHint].filter(Boolean).join(' · '));
}

async function buildGrowthRuntimeQueue(scope = {}, options = {}) {
  const normalizedOptions = normalizeGrowthRuntimeOptions(options);
  try {
    const latest = await loadLatestTranslationTaskPacket({
      ownerId: scope.owner_id,
      realmId: scope.realm_id
    });
    const rows = Array.isArray(latest?.packet?.tasks) ? latest.packet.tasks : [];
    const taskDocs = await Promise.all(rows.map(async (row = {}) => ({
      row,
      doc: await loadTranslationTaskByFile(row.file)
    })));
    const queue = taskDocs.map(({ row, doc }, index) => {
      const title = deriveQueueTitle(doc, row);
      const preview = deriveQueuePreview(doc);
      const label = preview ? `${title} · ${clipText(preview, 28)}` : title;
      return normalizeQueueItem({
        queue_id: safeText(row.batch_id || `growth-item-${index + 1}`),
        task_index: Number(row.task_index || index + 1),
        batch_id: safeText(row.batch_id),
        task_file: safeText(row.file),
        source_status: safeText(row.status || 'pending'),
        title,
        label,
        preview: clipText(preview, 120),
        key: title,
        query: deriveQueueQuery(doc, title, preview),
        slice_count: Number(doc?.summary?.slice_count || row.slice_count || 0),
        total_chars: Number(doc?.summary?.total_chars || row.total_chars || 0)
      }, index);
    }).filter((item) => item.queue_id && item.label);
    if (queue.length) return queue;
  } catch {
    // fall back to a single generic queue item below
  }
  const fallbackLabel = clipText(
    safeText(normalizedOptions.query || normalizedOptions.key || '共享工作台这轮材料'),
    36
  ) || '共享工作台这轮材料';
  return [
    normalizeQueueItem({
      queue_id: `growth-item-${Date.now()}`,
      task_index: 1,
      batch_id: safeText(normalizedOptions.packetId),
      source_status: 'ready',
      title: fallbackLabel,
      label: fallbackLabel,
      preview: '',
      key: safeText(normalizedOptions.key),
      query: safeText(normalizedOptions.query)
    }, 0)
  ];
}

function getQueueProgress({ itemIndex = 0, total = 0, itemProgress = 0 } = {}) {
  if (!total) return Math.max(0, Math.min(100, toNumber(itemProgress, 0)));
  const index = Math.max(0, Math.min(total - 1, toNumber(itemIndex, 0)));
  const ratio = (index + Math.max(0, Math.min(100, toNumber(itemProgress, 0))) / 100) / total;
  const percent = Math.round(ratio * 100);
  if (percent <= 0 && total > 0) return 1;
  return Math.max(1, Math.min(99, percent));
}

function buildQueueStatusLabel(item = {}, itemIndex = 0, total = 0, phaseLabel = '') {
  const prefix = total > 0 ? `第 ${itemIndex + 1}/${total} 张` : '当前这张';
  const title = safeText(item?.title || item?.label, '未命名材料');
  const suffix = safeText(phaseLabel);
  return [prefix, title, suffix].filter(Boolean).join(' · ');
}

function buildQueueSummary(queue = []) {
  const items = normalizeQueue(queue);
  const total = items.length;
  const completed = items.filter((item) => ['done', 'staged'].includes(item.runtime_status)).length;
  const failed = items.filter((item) => item.runtime_status === 'failed').length;
  const exported = items.filter((item) => item.export_file).length;
  return {
    total,
    completed,
    failed,
    exported
  };
}

export async function getGrowthRuntimeState({ ownerId = '', realmId = '' } = {}) {
  const requestedOwner = safeText(ownerId);
  const requestedRealm = safeText(realmId);
  if (requestedOwner && requestedRealm) {
    return readJsonIfExists(getScopedRuntimeStateFile(requestedOwner, requestedRealm));
  }
  return readJsonIfExists(GROWTH_RUNTIME_STATE_FILE);
}

async function updateGrowthRuntimeState(scope = {}, patch = {}) {
  const current = await getGrowthRuntimeState({
    ownerId: scope.owner_id,
    realmId: scope.realm_id
  });
  const nextState = {
    ...(current?.state && typeof current.state === 'object' ? current.state : {}),
    ...(patch && typeof patch === 'object' ? patch : {})
  };
  return persistGrowthRuntimeState(scope, nextState);
}

function buildPhaseState(phase = '', progress = 0, label = '', extra = {}) {
  return {
    running: true,
    paused: false,
    pause_requested: false,
    phase: safeText(phase),
    progress: Math.max(0, Math.min(100, Number(progress || 0))),
    item_progress: Math.max(0, Math.min(100, Number(extra?.item_progress || 0))),
    label: safeText(label),
    error: '',
    generatedBundle: null,
    ...clone(extra)
  };
}

async function readPauseRequested(scope = {}) {
  const latest = await getGrowthRuntimeState({
    ownerId: scope.owner_id,
    realmId: scope.realm_id
  });
  return Boolean(latest?.state?.pause_requested);
}

async function runGrowthRuntimeJob(scope = {}, options = {}, existingState = null) {
  const normalizedOptions = normalizeGrowthRuntimeOptions({
    ...options,
    ownerId: scope.owner_id,
    realmId: scope.realm_id
  });
  const baseMeta = {
    card_type: safeText(normalizedOptions.cardType, 'memo')
  };
  try {
    const restoredQueue = normalizeQueue(existingState?.state?.queue);
    const queue = restoredQueue.length
      ? restoredQueue
      : await buildGrowthRuntimeQueue(scope, normalizedOptions);
    if (!queue.length) {
      await persistGrowthRuntimeState(scope, {
        running: false,
        paused: false,
        pause_requested: false,
        phase: 'completed',
        progress: 100,
        item_progress: 100,
        label: '这轮没有可递送的材料。',
        error: '',
        queue: [],
        queue_total: 0,
        queue_pointer: 0,
        queue_completed: 0,
        queue_failed: 0,
        current_item: null,
        finished_at: new Date().toISOString(),
        generatedBundle: null,
        request_options: buildRequestOptionState(normalizedOptions),
        ...baseMeta
      });
      return;
    }
    let pointer = Math.max(0, Math.min(
      queue.length - 1,
      toNumber(existingState?.state?.queue_pointer, 0)
    ));
    if (toNumber(existingState?.state?.queue_pointer, 0) >= queue.length) {
      pointer = queue.length;
    }
    const startedAt = safeText(existingState?.state?.started_at, new Date().toISOString());

    for (let index = pointer; index < queue.length; index += 1) {
      const item = normalizeQueueItem(queue[index], index);
      queue[index] = {
        ...item,
        runtime_status: 'running',
        error: '',
        started_at: new Date().toISOString()
      };
      const currentLabel = buildQueueStatusLabel(item, index, queue.length, '正在整理这张卡的题面');
      await persistGrowthRuntimeState(scope, {
        running: true,
        paused: false,
        pause_requested: Boolean(existingState?.state?.pause_requested),
        phase: 'preparing_task',
        progress: getQueueProgress({ itemIndex: index, total: queue.length, itemProgress: 8 }),
        item_progress: 8,
        label: currentLabel,
        error: '',
        started_at: startedAt,
        finished_at: '',
        queue,
        queue_total: queue.length,
        queue_pointer: index,
        queue_completed: index,
        queue_failed: buildQueueSummary(queue).failed,
        current_item: clone(item),
        generatedBundle: null,
        request_options: buildRequestOptionState(normalizedOptions),
        ...baseMeta
      });

      try {
        const result = await generateGrowthDraft({
          ...normalizedOptions,
          ownerId: scope.owner_id,
          realmId: scope.realm_id,
          key: safeText(item.key || normalizedOptions.key),
          query: safeText(item.query || normalizedOptions.query),
          packetId: safeText(item.batch_id || normalizedOptions.packetId || item.queue_id),
          onStatus: async (status = {}) => {
            await updateGrowthRuntimeState(scope, {
              running: true,
              paused: false,
              phase: safeText(status.phase),
              progress: getQueueProgress({
                itemIndex: index,
                total: queue.length,
                itemProgress: Number(status.progress || 0)
              }),
              item_progress: Math.max(0, Math.min(100, Number(status.progress || 0))),
              label: buildQueueStatusLabel(item, index, queue.length, safeText(status.label)),
              detail: {
                ...(status?.detail && typeof status.detail === 'object' ? clone(status.detail) : {}),
                queue_index: index + 1,
                queue_total: queue.length,
                queue_label: item.label,
                queue_title: item.title
              },
              queue_total: queue.length,
              queue_pointer: index,
              queue_completed: index,
              current_item: clone(item),
              request_options: buildRequestOptionState(normalizedOptions),
              ...baseMeta
            });
          }
        });
        const generatedBundle = buildCompletionBundle(scope, result);
        const shouldExposeBundle = queue.length <= 1;
        queue[index] = {
          ...item,
          runtime_status: result?.export_result?.ok ? 'staged' : 'done',
          artifact_id: safeText(result?.artifact?.artifact_id),
          target_card_id: safeText(result?.task?.target_card_id || result?.draft?.target_card_id),
          source_focus: safeText(result?.task?.source_focus || item.source_focus || item.title),
          export_file: safeText(result?.export_result?.export_file),
          finished_at: new Date().toISOString()
        };
        const summary = buildQueueSummary(queue);
        const nextPointer = index + 1;
        const pauseRequested = await readPauseRequested(scope);
        if (pauseRequested && nextPointer < queue.length) {
          await persistGrowthRuntimeState(scope, {
            running: false,
            paused: true,
            pause_requested: false,
            phase: 'paused',
            progress: Math.max(1, Math.min(99, Math.round((summary.completed / queue.length) * 100))),
            item_progress: 100,
            label: `已停在第 ${summary.completed}/${queue.length} 张后，可从断点继续`,
            error: '',
            finished_at: new Date().toISOString(),
            queue,
            queue_total: queue.length,
            queue_pointer: nextPointer,
            queue_completed: summary.completed,
            queue_failed: summary.failed,
            current_item: null,
            generatedBundle: shouldExposeBundle ? generatedBundle : null,
            request_options: buildRequestOptionState(normalizedOptions),
            result: {
              ok: true,
              task: clone(result?.task || {}),
              api: clone(result?.api || {}),
              artifact: clone(result?.artifact || null),
              export_result: clone(result?.export_result || null),
              committed: Boolean(result?.committed),
              exported: Boolean(result?.exported || result?.export_result?.ok)
            },
            ...baseMeta
          });
          return;
        }
        await persistGrowthRuntimeState(scope, {
          running: nextPointer < queue.length,
          paused: false,
          pause_requested: false,
          phase: nextPointer >= queue.length ? 'completed' : 'ready_next',
          progress: nextPointer >= queue.length
            ? 100
            : Math.max(1, Math.min(99, Math.round((summary.completed / queue.length) * 100))),
          item_progress: 100,
          label: nextPointer >= queue.length
            ? (summary.exported
              ? `${summary.completed} 张已经按顺序写完，并有 ${summary.exported} 张落到 Obsidian staging`
              : `${summary.completed} 张已经按顺序写完`)
            : `已写完第 ${summary.completed}/${queue.length} 张，正在排下一张`,
          error: '',
          finished_at: nextPointer >= queue.length ? new Date().toISOString() : '',
          queue,
          queue_total: queue.length,
          queue_pointer: nextPointer,
          queue_completed: summary.completed,
          queue_failed: summary.failed,
          current_item: null,
          generatedBundle: shouldExposeBundle && nextPointer >= queue.length ? generatedBundle : null,
            request_options: buildRequestOptionState(normalizedOptions),
            result: {
              ok: true,
              task: clone(result?.task || {}),
              api: clone(result?.api || {}),
              artifact: clone(result?.artifact || null),
              export_result: clone(result?.export_result || null),
              committed: Boolean(result?.committed),
              exported: Boolean(result?.exported || result?.export_result?.ok)
            },
          ...baseMeta
        });
      } catch (error) {
        queue[index] = {
          ...item,
          runtime_status: 'failed',
          error: safeText(error?.message, '未知错误'),
          finished_at: new Date().toISOString()
        };
        const summary = buildQueueSummary(queue);
        await persistGrowthRuntimeState(scope, {
          running: false,
          paused: false,
          pause_requested: false,
          phase: 'failed',
          progress: Math.max(1, Math.min(99, Math.round((summary.completed / queue.length) * 100))),
          item_progress: 0,
          label: buildQueueStatusLabel(item, index, queue.length, '这一张没接住'),
          error: safeText(error?.message, '未知错误'),
          finished_at: new Date().toISOString(),
          queue,
          queue_total: queue.length,
          queue_pointer: index,
          queue_completed: summary.completed,
          queue_failed: summary.failed,
          current_item: clone(item),
          generatedBundle: null,
          request_options: buildRequestOptionState(normalizedOptions),
          ...baseMeta
        });
        return;
      }
    }
  } finally {
    workerMap.delete(scopeKey(scope));
  }
}

export async function startGrowthRuntime(options = {}) {
  const normalizedOptions = normalizeGrowthRuntimeOptions(options);
  const scope = normalizeScope(normalizedOptions);
  const key = scopeKey(scope);
  const current = await getGrowthRuntimeState({
    ownerId: scope.owner_id,
    realmId: scope.realm_id
  });
  if (workerMap.has(key) && current?.state?.running) {
    return current;
  }
  const queue = await buildGrowthRuntimeQueue(scope, normalizedOptions);
  const payload = await persistGrowthRuntimeState(
    scope,
    buildPhaseState('queued', 1, queue.length > 1
      ? `已接住这轮生长请求，准备按顺序写 ${queue.length} 张`
      : '已接住这轮生长请求，正在进后厨排题面', {
      started_at: new Date().toISOString(),
      finished_at: '',
      card_type: safeText(normalizedOptions.cardType, 'memo'),
      request_options: buildRequestOptionState(normalizedOptions),
      queue,
      queue_total: queue.length,
      queue_pointer: 0,
      queue_completed: 0,
      queue_failed: 0,
      current_item: queue[0] ? clone(queue[0]) : null
    })
  );
  const job = runGrowthRuntimeJob(scope, normalizedOptions, payload);
  workerMap.set(key, { job, started_at: Date.now() });
  return payload;
}

export async function pauseGrowthRuntime(options = {}) {
  const normalizedOptions = normalizeGrowthRuntimeOptions(options);
  const scope = normalizeScope(normalizedOptions);
  const current = await getGrowthRuntimeState({
    ownerId: scope.owner_id,
    realmId: scope.realm_id
  });
  if (!current?.state) {
    return persistGrowthRuntimeState(scope, {
      running: false,
      paused: false,
      pause_requested: false,
      phase: 'idle',
      progress: 0,
      item_progress: 0,
      label: '还没有进行中的主卡生长。',
      error: '',
      queue: [],
      queue_total: 0,
      queue_pointer: 0,
      queue_completed: 0,
      queue_failed: 0,
      current_item: null,
      card_type: safeText(normalizedOptions.cardType, 'memo')
    });
  }
  if (current.state.running) {
    return updateGrowthRuntimeState(scope, {
      pause_requested: true,
      paused: false,
      label: '已记下暂停请求，这一张写完就会停下来。'
    });
  }
  if (current.state.paused) {
    return current;
  }
  return updateGrowthRuntimeState(scope, {
    paused: true,
    pause_requested: false,
    label: '当前没有正在写的卡，已停在原地。'
  });
}

export async function resumeGrowthRuntime(options = {}) {
  const normalizedOptions = normalizeGrowthRuntimeOptions(options);
  const scope = normalizeScope(normalizedOptions);
  const key = scopeKey(scope);
  const current = await getGrowthRuntimeState({
    ownerId: scope.owner_id,
    realmId: scope.realm_id
  });
  if (workerMap.has(key) && current?.state?.running) {
    return current;
  }
  const queue = normalizeQueue(current?.state?.queue);
  const pointer = Math.max(0, toNumber(current?.state?.queue_pointer, 0));
  if (!queue.length || pointer >= queue.length) {
    return persistGrowthRuntimeState(scope, {
      ...(current?.state && typeof current.state === 'object' ? current.state : {}),
      running: false,
      paused: false,
      pause_requested: false,
      phase: 'completed',
      progress: 100,
      item_progress: 100,
      label: queue.length ? '这轮已经全部写完了。' : '这一轮还没有可继续的队列。',
      current_item: null,
      queue,
      queue_total: queue.length,
      queue_pointer: Math.min(pointer, queue.length),
      queue_completed: Math.min(pointer, queue.length),
      queue_failed: buildQueueSummary(queue).failed,
      card_type: safeText(current?.state?.card_type || normalizedOptions.cardType, 'memo'),
      request_options: current?.state?.request_options || buildRequestOptionState(normalizedOptions)
    });
  }
  const resumedOptions = mergeResumeGrowthRuntimeOptions(
    current?.state?.request_options && typeof current.state.request_options === 'object'
      ? current.state.request_options
      : {},
    options,
    scope
  );
  const payload = await persistGrowthRuntimeState(scope, {
    ...(current?.state && typeof current.state === 'object' ? current.state : {}),
    running: true,
    paused: false,
    pause_requested: false,
    phase: 'queued',
    progress: Math.max(1, Math.min(99, Math.round((pointer / queue.length) * 100))),
    item_progress: 0,
    label: `已从第 ${pointer + 1}/${queue.length} 张继续排队`,
    error: '',
    finished_at: '',
    queue,
    queue_total: queue.length,
    queue_pointer: pointer,
    queue_completed: pointer,
    queue_failed: buildQueueSummary(queue).failed,
    current_item: clone(queue[pointer]),
    card_type: safeText(resumedOptions.cardType || current?.state?.card_type, 'memo'),
    request_options: buildRequestOptionState(resumedOptions)
  });
  const job = runGrowthRuntimeJob(scope, resumedOptions, payload);
  workerMap.set(key, { job, started_at: Date.now() });
  return payload;
}
