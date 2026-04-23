import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { getScopedTranslationTaskDir } from './path-config.js';

function safeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unnamed';
}

function taskOrdinalName(index) {
  return `task_${String(index + 1).padStart(4, '0')}`;
}

export async function materializeTranslationTasks(payload = {}, options = {}) {
  const generatedAt = new Date().toISOString();
  const ownerId = options.owner_id || '';
  const realmId = options.realm_id || '';
  const tasksDir = getScopedTranslationTaskDir(ownerId, realmId);
  const label = safeSegment(options.label || payload?.packet_id || `task_${Date.now()}`);
  const packetDir = join(tasksDir, 'packets', label);
  const taskFilesDir = join(packetDir, 'tasks');
  await mkdir(taskFilesDir, { recursive: true });

  const taskDocs = [];
  for (const [index, task] of (Array.isArray(payload?.tasks) ? payload.tasks : []).entries()) {
    const taskFile = join(taskFilesDir, `${taskOrdinalName(index)}.json`);
    const taskDoc = {
      schema: 'hippocove_translation_task_v0.1',
      generated_at: generatedAt,
      packet_id: payload.packet_id || '',
      packet_file: payload.packet_file || '',
      task_packet_file: '',
      task_index: index + 1,
      status: 'pending',
      lifecycle: {
        prepared_at: generatedAt,
        submitted_at: '',
        applied_at: '',
        failed_at: ''
      },
      submit: {
        parse_mode: '',
        parsed_entries: 0,
        source_label: ''
      },
      writeback: {
        ok: false,
        created_roots: 0,
        updated_roots: 0,
        total_roots: 0,
        vine_edges: 0
      },
      scope: payload.scope || {},
      summary: {
        batch_id: task.batch_id || '',
        slice_count: task.slice_count || 0,
        total_chars: task.total_chars || 0,
        previews: Array.isArray(task.previews) ? task.previews : []
      },
      translator_contract: payload.translator_contract || {},
      ai_contract: task.ai_contract || {},
      task: task.task || {}
    };
    taskDocs.push({
      file: taskFile,
      doc: taskDoc,
      row: {
      task_index: index + 1,
      batch_id: task.batch_id || '',
      slice_count: task.slice_count || 0,
      total_chars: task.total_chars || 0,
      file: taskFile
      }
    });
  }

  const packetDoc = {
    schema: 'hippocove_translation_task_packet_v0.1',
    generated_at: generatedAt,
    packet_id: payload.packet_id || '',
    packet_file: payload.packet_file || '',
    scope: payload.scope || {},
    summary: payload.summary || {},
    translator_contract: payload.translator_contract || {},
    status_summary: {
      pending: taskDocs.length,
      submitted: 0,
      applied: 0,
      failed: 0
    },
    tasks: []
  };

  const packetFile = join(packetDir, 'packet.json');
  packetDoc.tasks = taskDocs.map(({ row }) => ({
    ...row,
    packet_file: packetFile,
    status: 'pending',
    submitted_at: '',
    applied_at: '',
    failed_at: ''
  }));
  const taskPacketRows = packetDoc.tasks;
  for (const [index, taskRow] of taskPacketRows.entries()) {
    const taskDoc = taskDocs[index].doc;
    taskDoc.task_packet_file = packetFile;
    await writeFile(taskRow.file, `${JSON.stringify(taskDoc, null, 2)}\n`, 'utf-8');
  }
  await writeFile(packetFile, `${JSON.stringify(packetDoc, null, 2)}\n`, 'utf-8');
  await writeFile(join(tasksDir, 'latest.json'), `${JSON.stringify({
    schema: 'hippocove_translation_task_latest_pointer_v0.1',
    generated_at: generatedAt,
    latest_packet: packetDir,
    scope: {
      owner_id: ownerId,
      realm_id: realmId
    }
  }, null, 2)}\n`, 'utf-8');

  return {
    generated_at: generatedAt,
    packet_dir: packetDir,
    packet_file: packetFile,
    task_count: taskPacketRows.length,
    tasks: taskPacketRows,
    scope: {
      owner_id: ownerId,
      realm_id: realmId
    }
  };
}
