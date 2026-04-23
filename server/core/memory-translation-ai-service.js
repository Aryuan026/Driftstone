import { readFile } from 'fs/promises';
import { buildMemoryScope } from './scope-contract.js';
import { loadLatestTranslationPacket, loadTranslationPacketByFile } from './translation-store.js';
import { buildTranslatorContract, normalizeTranslationEntries } from './translation-contract.js';
import {
  buildTranslationAiFallbackPrompt,
  buildTranslationAiResponseFormat,
  buildTranslationAiSystemPrompt,
  buildTranslationAiUserPrompt,
  extractJsonObject,
  parseTranslationNoteEntries,
  summarizeTask
} from './translation-ai-contract.js';
import { applyTranslationEntries } from './memory-translation-service.js';
import { materializeTranslationTasks } from './translation-task-materializer.js';
import { loadTranslationTaskByFile, updateTranslationTaskStatus } from './translation-task-store.js';
import { getMemoryHomePacket } from './memory-home-service.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

async function loadSliceText(slice = {}) {
  if (safeText(slice?.text)) return safeText(slice.text);
  if (!safeText(slice?.file)) return '';
  try {
    const raw = await readFile(slice.file, 'utf-8');
    const parsed = JSON.parse(raw);
    return safeText(parsed?.text || '');
  } catch {
    return '';
  }
}

async function hydratePacket(packet = {}) {
  const slices = [];
  for (const slice of Array.isArray(packet?.slices) ? packet.slices : []) {
    slices.push({
      ...slice,
      text: await loadSliceText(slice)
    });
  }
  return {
    ...packet,
    slices
  };
}

async function resolveTranslationPacket(body = {}, taskContext = null) {
  if (safeText(taskContext?.packet_file)) {
    return {
      packetFile: taskContext.packet_file,
      packet: await loadTranslationPacketByFile(taskContext.packet_file)
    };
  }
  if (safeText(body.packet_file)) {
    return {
      packetFile: body.packet_file,
      packet: await loadTranslationPacketByFile(body.packet_file)
    };
  }
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const latest = await loadLatestTranslationPacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id
  });
  return {
    packetFile: latest.packetFile,
    packet: latest.packet
  };
}

function buildBatches(slices, { maxSlices = 2, maxChars = 9000 } = {}) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const slice of slices) {
    const nextChars = currentChars + Number(slice.char_count || 0);
    if (current.length && (current.length >= maxSlices || nextChars > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(slice);
    currentChars += Number(slice.char_count || 0);
  }
  if (current.length) batches.push(current);
  return batches;
}

function parseAiEntries(rawOutput) {
  const extracted = extractJsonObject(rawOutput);
  if (extracted && typeof extracted === 'object' && Array.isArray(extracted.entries)) {
    return {
      mode: 'json_schema',
      entries: extracted.entries
    };
  }
  return {
    mode: 'placement_note',
    entries: parseTranslationNoteEntries(rawOutput)
  };
}

async function markTaskAsSubmitted(taskFile, sourceLabel = '') {
  if (!safeText(taskFile)) return null;
  return updateTranslationTaskStatus(taskFile, (task) => ({
    ...task,
    status: 'submitted',
    lifecycle: {
      ...(task.lifecycle || {}),
      submitted_at: new Date().toISOString()
    },
    submit: {
      ...(task.submit || {}),
      source_label: safeText(sourceLabel || task?.summary?.batch_id || '')
    }
  }));
}

async function markTaskAsFailed(taskFile, {
  parseMode = '',
  parsedEntries = 0,
  sourceLabel = '',
  reason = '',
  rawOutput = ''
} = {}) {
  if (!safeText(taskFile)) return null;
  return updateTranslationTaskStatus(taskFile, (task) => ({
    ...task,
    status: 'failed',
    lifecycle: {
      ...(task.lifecycle || {}),
      failed_at: new Date().toISOString()
    },
    submit: {
      ...(task.submit || {}),
      parse_mode: parseMode,
      parsed_entries: Number(parsedEntries || 0),
      source_label: safeText(sourceLabel || task?.submit?.source_label || ''),
      error_note: safeText(reason),
      raw_preview: rawOutput ? safeText(rawOutput).slice(0, 500) : ''
    },
    writeback: {
      ok: false,
      created_roots: 0,
      updated_roots: 0,
      total_roots: 0,
      vine_edges: 0
    }
  }));
}

export async function parseAiTranslationTaskSubmission(body = {}, options = {}) {
  let taskContext = null;
  const taskFile = safeText(body?.task_file);
  const sourceLabel = safeText(body?.source?.label);

  if (taskFile) {
    taskContext = await loadTranslationTaskByFile(taskFile);
    if (options.markSubmitted !== false) {
      await markTaskAsSubmitted(taskFile, sourceLabel);
    }
  }

  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id || taskContext?.scope?.owner_id,
    realmId: body?.scope?.realm_id || taskContext?.scope?.realm_id,
    botId: body?.scope?.bot_id || taskContext?.scope?.bot_id,
    mode: 'bot'
  });
  const { packet, packetFile } = await resolveTranslationPacket(body, taskContext);
  const rawOutput = safeText(body?.raw_output || '');
  const parsed = Array.isArray(body?.entries)
    ? { mode: 'direct_entries', entries: body.entries }
    : parseAiEntries(rawOutput);

  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    const reason = safeText(body?.error || body?.error_note || 'No translation entries parsed from translator output.');
    if (taskFile && options.markFailure !== false) {
      await markTaskAsFailed(taskFile, {
        parseMode: parsed.mode,
        parsedEntries: 0,
        sourceLabel,
        reason,
        rawOutput
      });
    }

    const failureHome = await getMemoryHomePacket({
      ownerId: scope.owner_id || packet?.scope?.owner_id || '',
      realmId: scope.realm_id || packet?.scope?.realm_id || 'default',
      botId: scope.bot_id || packet?.scope?.bot_id || '',
      mode: 'bot'
    });

    return {
      ok: false,
      schema: 'hippocove_translation_ai_parse_v0.1',
      error: reason,
      scope: {
        ...scope,
        isolation_stage: 'translation_packet'
      },
      packet_file: packetFile,
      task_file: taskFile,
      batch_id: taskContext?.summary?.batch_id || '',
      parse_mode: parsed.mode,
      parsed_entries: 0,
      entries: [],
      home: failureHome?.ok ? failureHome : {},
      home_summary: failureHome?.ok && failureHome?.home_summary ? failureHome.home_summary : {},
      translator_contract: buildTranslatorContract()
    };
  }

  const normalizedEntries = normalizeTranslationEntries(parsed.entries, packet);
  return {
    ok: true,
    schema: 'hippocove_translation_ai_parse_v0.1',
    scope: {
      ...scope,
      isolation_stage: 'translation_packet'
    },
    packet_file: packetFile,
    task_file: taskFile,
    batch_id: taskContext?.summary?.batch_id || '',
    parse_mode: parsed.mode,
    parsed_entries: normalizedEntries.length,
    entries: normalizedEntries,
    translator_contract: buildTranslatorContract()
  };
}

export async function prepareAiTranslationTasks(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const { packet, packetFile } = await resolveTranslationPacket(body);
  const hydrated = await hydratePacket(packet);
  const maxSlices = Math.max(1, Number(body?.batch?.max_slices || 2));
  const maxChars = Math.max(1200, Number(body?.batch?.max_chars || 9000));
  const entryLimit = Math.max(1, Number(body?.batch?.entry_limit || 6));
  const batches = buildBatches(hydrated.slices || [], { maxSlices, maxChars });
  const translatorContract = buildTranslatorContract();

  const tasks = batches.map((batch, idx) => {
    const task = {
      batch_id: `${safeText(hydrated.packet_id)}__batch_${String(idx + 1).padStart(3, '0')}`,
      entry_limit: entryLimit,
      slices: batch
    };
    return {
      ...summarizeTask(task),
      task,
      translator_contract: translatorContract,
      ai_contract: {
        system_prompt: buildTranslationAiSystemPrompt(),
        fallback_prompt: buildTranslationAiFallbackPrompt(),
        user_prompt: buildTranslationAiUserPrompt(task, translatorContract),
        response_format: buildTranslationAiResponseFormat()
      }
    };
  });

  const payload = {
    ok: true,
    schema: 'hippocove_translation_ai_prepare_v0.1',
    scope: {
      ...scope,
      isolation_stage: 'translation_packet'
    },
    packet_file: packetFile,
    packet_id: safeText(hydrated.packet_id),
    summary: {
      slice_count: hydrated.slices.length,
      batch_count: tasks.length,
      max_slices: maxSlices,
      max_chars: maxChars,
      entry_limit: entryLimit
    },
    tasks
  };

  const materialized = await materializeTranslationTasks(payload, {
    label: safeText(body?.source?.label || `${safeText(hydrated.packet_id)}__ai_tasks`),
    owner_id: scope.owner_id || hydrated?.scope?.owner_id || '',
    realm_id: scope.realm_id || hydrated?.scope?.realm_id || 'default'
  });

  const taskFileByBatch = new Map(
    (materialized.tasks || []).map((task) => [task.batch_id, task.file])
  );

  const home = await getMemoryHomePacket({
    ownerId: scope.owner_id || hydrated?.scope?.owner_id || '',
    realmId: scope.realm_id || hydrated?.scope?.realm_id || 'default',
    botId: scope.bot_id || hydrated?.scope?.bot_id || '',
    mode: 'bot'
  });

  return {
    ...payload,
    tasks: tasks.map((task) => ({
      ...task,
      task_file: taskFileByBatch.get(task.batch_id) || ''
    })),
    home: home?.ok ? home : {},
    home_summary: home?.ok && home?.home_summary ? home.home_summary : {},
    task_packet: {
      packet_dir: materialized.packet_dir,
      packet_file: materialized.packet_file,
      task_count: materialized.task_count
    }
  };
}

export async function submitAiTranslationTask(body = {}) {
  const parsedPayload = await parseAiTranslationTaskSubmission(body, {
    markSubmitted: true,
    markFailure: true
  });
  if (!parsedPayload?.ok) {
    return {
      ...parsedPayload,
      schema: 'hippocove_translation_ai_submit_v0.1',
      writeback: {
        ok: false,
        summary: {
          input_entries: 0,
          accepted_entries: 0,
          rejected_entries: 0,
          created_roots: 0,
          updated_roots: 0,
          total_roots: 0,
          vine_edges: 0
        }
      }
    };
  }

  const payload = await applyTranslationEntries({
    packet_file: parsedPayload.packet_file,
    scope: parsedPayload.scope,
    source: {
      label: safeText(body?.source?.label || parsedPayload.batch_id || 'translation_ai_submit')
    },
    entries: parsedPayload.entries
  });

  if (safeText(parsedPayload.task_file)) {
    await updateTranslationTaskStatus(parsedPayload.task_file, (task) => ({
      ...task,
      status: payload?.writeback?.ok ? 'applied' : 'failed',
      lifecycle: {
        ...(task.lifecycle || {}),
        applied_at: payload?.writeback?.ok ? new Date().toISOString() : (task.lifecycle?.applied_at || ''),
        failed_at: payload?.writeback?.ok ? (task.lifecycle?.failed_at || '') : new Date().toISOString()
      },
      submit: {
        ...(task.submit || {}),
        parse_mode: parsedPayload.parse_mode,
        parsed_entries: Array.isArray(parsedPayload.entries) ? parsedPayload.entries.length : 0,
        source_label: safeText(body?.source?.label || task?.submit?.source_label || '')
      },
      writeback: {
        ok: Boolean(payload?.writeback?.ok),
        created_roots: Number(payload?.writeback?.summary?.created_roots || 0),
        updated_roots: Number(payload?.writeback?.summary?.updated_roots || 0),
        total_roots: Number(payload?.writeback?.summary?.total_roots || 0),
        vine_edges: Number(payload?.writeback?.summary?.vine_edges || 0)
      }
    }));
  }

  return {
    ok: true,
    schema: 'hippocove_translation_ai_submit_v0.1',
    scope: payload.scope,
    packet_file: parsedPayload.packet_file,
    task_file: parsedPayload.task_file,
    batch_id: parsedPayload.batch_id,
    parse_mode: parsedPayload.parse_mode,
    parsed_entries: Array.isArray(parsedPayload.entries) ? parsedPayload.entries.length : 0,
    writeback: payload.writeback,
    home: payload.home || {},
    home_summary: payload.home_summary || {},
    translator_contract: buildTranslatorContract()
  };
}

export async function failAiTranslationTask(body = {}) {
  const taskFile = safeText(body?.task_file);
  if (!taskFile) {
    return {
      ok: false,
      error: 'task_file is required',
      schema: 'hippocove_translation_ai_fail_v0.1'
    };
  }

  const taskContext = await loadTranslationTaskByFile(taskFile);
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id || taskContext?.scope?.owner_id,
    realmId: body?.scope?.realm_id || taskContext?.scope?.realm_id,
    botId: body?.scope?.bot_id || taskContext?.scope?.bot_id,
    mode: 'bot'
  });
  const reason = safeText(body?.error || body?.error_note || 'Translator worker failed before submission.');
  const rawPreview = safeText(body?.raw_output || '').slice(0, 500);

  await updateTranslationTaskStatus(taskFile, (task) => ({
    ...task,
    status: 'failed',
    lifecycle: {
      ...(task.lifecycle || {}),
      failed_at: new Date().toISOString()
    },
    submit: {
      ...(task.submit || {}),
      source_label: safeText(body?.source?.label || task?.submit?.source_label || ''),
      error_note: reason,
      raw_preview: rawPreview
    },
    writeback: {
      ok: false,
      created_roots: 0,
      updated_roots: 0,
      total_roots: 0,
      vine_edges: 0
    }
  }));

  const home = await getMemoryHomePacket({
    ownerId: scope.owner_id || taskContext?.scope?.owner_id || '',
    realmId: scope.realm_id || taskContext?.scope?.realm_id || 'default',
    botId: scope.bot_id || taskContext?.scope?.bot_id || '',
    mode: 'bot'
  });

  return {
    ok: true,
    schema: 'hippocove_translation_ai_fail_v0.1',
    scope: {
      ...scope,
      isolation_stage: 'translation_packet'
    },
    task_file: taskFile,
    batch_id: taskContext?.summary?.batch_id || '',
    error: reason,
    home: home?.ok ? home : {},
    home_summary: home?.ok && home?.home_summary ? home.home_summary : {},
    translator_contract: buildTranslatorContract()
  };
}
