import { loadLatestTranslationTaskPacket, loadTranslationTaskByFile } from './translation-task-store.js';

function buildEmptyTranslationTaskStatus(options = {}) {
  return {
    ok: true,
    schema: 'hippocove_translation_task_packet_status_v0.1',
    scope: {
      owner_id: String(options.ownerId || options.owner_id || ''),
      realm_id: String(options.realmId || options.realm_id || '')
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

function uniqueStrings(items, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function summarizeTaskRow(row = {}) {
  return {
    task_index: Number(row.task_index || 0),
    batch_id: String(row.batch_id || ''),
    status: String(row.status || 'pending'),
    slice_count: Number(row.slice_count || 0),
    total_chars: Number(row.total_chars || 0),
    submitted_at: String(row.submitted_at || ''),
    applied_at: String(row.applied_at || ''),
    failed_at: String(row.failed_at || ''),
    task_file: String(row.file || '')
  };
}

function summarizeTaskDoc(task = {}) {
  return {
    schema: 'hippocove_translation_task_read_v0.1',
    task_file: String(task?.task_packet_file ? task?.task?.task_file || '' : task?.file || ''),
    status: String(task?.status || 'pending'),
    scope: task?.scope || {},
    summary: {
      batch_id: String(task?.summary?.batch_id || ''),
      slice_count: Number(task?.summary?.slice_count || 0),
      total_chars: Number(task?.summary?.total_chars || 0),
      previews: Array.isArray(task?.summary?.previews) ? task.summary.previews : []
    },
    lifecycle: task?.lifecycle || {},
    submit: task?.submit || {},
    writeback: task?.writeback || {},
    next_work: {
      needs_submission: String(task?.status || 'pending') === 'pending',
      needs_retry: String(task?.status || 'pending') === 'failed'
    }
  };
}

function summarizeSlice(slice = {}) {
  return {
    slice_id: String(slice?.slice_id || ''),
    title: String(slice?.title || ''),
    kind: String(slice?.kind || ''),
    created_at: String(slice?.created_at || ''),
    char_count: Number(slice?.char_count || 0),
    text: String(slice?.text || '')
  };
}

export async function getLatestTranslationTaskPacketStatus(options = {}) {
  let pointer = null;
  let packetFile = '';
  let packet = null;
  try {
    const loaded = await loadLatestTranslationTaskPacket({
      ownerId: options.ownerId,
      realmId: options.realmId,
      owner_id: options.owner_id,
      realm_id: options.realm_id
    });
    pointer = loaded.pointer;
    packetFile = loaded.packetFile;
    packet = loaded.packet;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return buildEmptyTranslationTaskStatus(options);
    }
    throw error;
  }

  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 20;
  const tasks = Array.isArray(packet?.tasks) ? packet.tasks : [];
  const summarized = tasks.map(summarizeTaskRow);
  const nextPending = summarized.find((task) => task.status === 'pending') || null;
  const lastApplied = summarized
    .filter((task) => task.applied_at)
    .sort((a, b) => String(b.applied_at).localeCompare(String(a.applied_at)))[0] || null;

  return {
    ok: true,
    schema: 'hippocove_translation_task_packet_status_v0.1',
    scope: packet?.scope || pointer?.scope || {},
    latest: {
      generated_at: String(packet?.generated_at || pointer?.generated_at || ''),
      packet_file: packetFile,
      packet_dir: String(pointer?.latest_packet || '')
    },
    summary: packet?.summary || {},
    status_summary: packet?.status_summary || {
      pending: 0,
      submitted: 0,
      applied: 0,
      failed: 0
    },
    next_work: {
      next_pending_task: nextPending,
      last_applied_task: lastApplied
    },
    tasks: summarized.slice(0, limit)
  };
}

export async function getTranslationTaskStatus(taskFile) {
  const task = await loadTranslationTaskByFile(taskFile);
  const normalizedTask = {
    ...task,
    file: taskFile
  };
  const response = summarizeTaskDoc(normalizedTask);
  response.task_file = taskFile;
  response.slice_ids = uniqueStrings(
    (Array.isArray(task?.task?.slices) ? task.task.slices : []).map((slice) => slice?.slice_id),
    24
  );
  response.packet_file = String(task?.packet_file || '');
  response.task_packet_file = String(task?.task_packet_file || '');
  return {
    ok: true,
    ...response
  };
}

export async function getTranslationTaskWorkerPacket(taskFile) {
  const task = await loadTranslationTaskByFile(taskFile);
  return {
    ok: true,
    schema: 'hippocove_translation_worker_packet_v0.1',
    task_file: taskFile,
    status: String(task?.status || 'pending'),
    scope: task?.scope || {},
    summary: {
      batch_id: String(task?.summary?.batch_id || ''),
      slice_count: Number(task?.summary?.slice_count || 0),
      total_chars: Number(task?.summary?.total_chars || 0),
      previews: Array.isArray(task?.summary?.previews) ? task.summary.previews : []
    },
    translator_contract: task?.translator_contract || {},
    ai_contract: task?.ai_contract || {},
    slices: (Array.isArray(task?.task?.slices) ? task.task.slices : []).map(summarizeSlice),
    submit_contract: {
      route: '/api/memory/translate/submit',
      payload_hint: {
        task_file: taskFile,
        source_label: String(task?.summary?.batch_id || '')
      }
    }
  };
}

export async function getNextPendingTranslationTask(options = {}) {
  const latest = await getLatestTranslationTaskPacketStatus(options);
  const nextTask = latest?.next_work?.next_pending_task || null;
  if (!nextTask?.task_file) {
    return {
      ok: true,
      schema: 'hippocove_translation_task_next_v0.1',
      scope: latest.scope || {},
      latest: latest.latest || {},
      status_summary: latest.status_summary || {},
      next_task: null
    };
  }

  const detail = await getTranslationTaskStatus(nextTask.task_file);
  return {
    ok: true,
    schema: 'hippocove_translation_task_next_v0.1',
    scope: latest.scope || {},
    latest: latest.latest || {},
    status_summary: latest.status_summary || {},
    next_task: detail
  };
}

export async function getNextPendingTranslationWorkerPacket(options = {}) {
  const latest = await getLatestTranslationTaskPacketStatus(options);
  const nextTask = latest?.next_work?.next_pending_task || null;
  if (!nextTask?.task_file) {
    return {
      ok: true,
      schema: 'hippocove_translation_worker_packet_next_v0.1',
      scope: latest.scope || {},
      latest: latest.latest || {},
      status_summary: latest.status_summary || {},
      next_task: null
    };
  }

  const workerPacket = await getTranslationTaskWorkerPacket(nextTask.task_file);
  return {
    ok: true,
    schema: 'hippocove_translation_worker_packet_next_v0.1',
    scope: latest.scope || {},
    latest: latest.latest || {},
    status_summary: latest.status_summary || {},
    next_task: workerPacket
  };
}
