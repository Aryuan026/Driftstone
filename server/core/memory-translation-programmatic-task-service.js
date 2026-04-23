import { buildProgrammaticEntriesFromSlices } from './programmatic-translator.js';
import { buildMemoryScope } from './scope-contract.js';
import { failAiTranslationTask, submitAiTranslationTask } from './memory-translation-ai-service.js';
import { getNextPendingTranslationWorkerPacket } from './memory-translation-task-service.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function summarizeTaskFile(taskFile = '') {
  const text = safeText(taskFile);
  return text ? text.split('/').at(-1) || text : '';
}

export async function runNextProgrammaticTranslationTask(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });

  const nextTaskResult = await getNextPendingTranslationWorkerPacket({
    owner_id: scope.owner_id,
    realm_id: scope.realm_id,
    limit: Number(body?.limit || 20)
  });
  const workerPacket = nextTaskResult?.next_task || null;

  if (!workerPacket?.task_file) {
    return {
      ok: true,
      schema: 'hippocove_programmatic_translation_task_run_v0.1',
      scope,
      status: 'idle',
      task_file: '',
      task_label: '',
      parsed_entries: 0,
      accepted_entries: 0,
      home: {},
      home_summary: {},
      latest_status: nextTaskResult?.status_summary || {},
      message: '当前没有待处理的 translator task。'
    };
  }

  const entries = await buildProgrammaticEntriesFromSlices(workerPacket.slices || []);
  const source = {
    label: safeText(body?.source?.label || 'programmatic_task_worker')
  };

  if (!entries.length) {
    const failed = await failAiTranslationTask({
      scope: {
        owner_id: scope.owner_id,
        realm_id: scope.realm_id,
        bot_id: scope.bot_id
      },
      task_file: workerPacket.task_file,
      error_note: safeText(
        body?.error_note,
        'Programmatic task worker found no stable entries for this worker packet.'
      ),
      source
    });

    return {
      ok: Boolean(failed?.ok),
      schema: 'hippocove_programmatic_translation_task_run_v0.1',
      scope: failed?.scope || scope,
      status: 'failed_empty',
      task_file: workerPacket.task_file,
      task_label: summarizeTaskFile(workerPacket.task_file),
      parsed_entries: 0,
      accepted_entries: 0,
      home: failed?.home || {},
      home_summary: failed?.home_summary || {},
      latest_status: nextTaskResult?.status_summary || {},
      error: safeText(failed?.error),
      worker_packet: {
        task_file: workerPacket.task_file,
        summary: workerPacket.summary || {}
      }
    };
  }

  const submitted = await submitAiTranslationTask({
    scope: {
      owner_id: scope.owner_id,
      realm_id: scope.realm_id,
      bot_id: scope.bot_id
    },
    task_file: workerPacket.task_file,
    entries,
    source
  });

  return {
    ok: Boolean(submitted?.ok),
    schema: 'hippocove_programmatic_translation_task_run_v0.1',
    scope: submitted?.scope || scope,
    status: submitted?.ok ? 'submitted' : 'failed',
    task_file: workerPacket.task_file,
    task_label: summarizeTaskFile(workerPacket.task_file),
    parsed_entries: entries.length,
    accepted_entries: Number(submitted?.parsed_entries || 0),
    home: submitted?.home || {},
    home_summary: submitted?.home_summary || {},
    latest_status: nextTaskResult?.status_summary || {},
    error: safeText(submitted?.error),
    worker_packet: {
      task_file: workerPacket.task_file,
      summary: workerPacket.summary || {}
    }
  };
}

export async function drainProgrammaticTranslationTasks(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const maxTasks = Math.max(1, Math.min(Number(body?.max_tasks || 5), 50));
  const runs = [];
  let lastHome = {};
  let lastHomeSummary = {};
  let idle = false;

  for (let idx = 0; idx < maxTasks; idx += 1) {
    const result = await runNextProgrammaticTranslationTask({
      scope: {
        owner_id: scope.owner_id,
        realm_id: scope.realm_id,
        bot_id: scope.bot_id
      },
      limit: body?.limit,
      source: body?.source,
      error_note: body?.error_note
    });

    runs.push({
      task_file: safeText(result?.task_label || result?.task_file),
      status: safeText(result?.status),
      parsed_entries: Number(result?.parsed_entries || 0),
      accepted_entries: Number(result?.accepted_entries || 0),
      home_state: safeText(result?.home_summary?.home_state)
    });

    lastHome = result?.home || lastHome;
    lastHomeSummary = result?.home_summary || lastHomeSummary;

    if (safeText(result?.status) === 'idle') {
      idle = true;
      break;
    }
  }

  return {
    ok: true,
    schema: 'hippocove_programmatic_translation_task_drain_v0.1',
    scope,
    max_tasks: maxTasks,
    run_count: runs.length,
    idle,
    runs,
    home: lastHome,
    home_summary: lastHomeSummary
  };
}
