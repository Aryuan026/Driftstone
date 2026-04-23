import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { getScopedTranslationTaskDir } from './path-config.js';

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

export async function loadTranslationTaskPacketByFile(packetFile) {
  return readJson(packetFile);
}

export async function loadTranslationTaskByFile(taskFile) {
  return readJson(taskFile);
}

export async function loadLatestTranslationTaskPointer({ ownerId = '', realmId = '', owner_id = '', realm_id = '' } = {}) {
  const normalizedOwnerId = String(ownerId || owner_id || '').trim();
  const normalizedRealmId = String(realmId || realm_id || '').trim();
  const taskDir = getScopedTranslationTaskDir(normalizedOwnerId, normalizedRealmId);
  const latestFile = join(taskDir, 'latest.json');
  return readJson(latestFile);
}

export async function loadLatestTranslationTaskPacket({ ownerId = '', realmId = '', owner_id = '', realm_id = '' } = {}) {
  const normalizedOwnerId = String(ownerId || owner_id || '').trim();
  const normalizedRealmId = String(realmId || realm_id || '').trim();
  const pointer = await loadLatestTranslationTaskPointer({
    ownerId: normalizedOwnerId,
    realmId: normalizedRealmId
  });
  const packetFile = join(pointer.latest_packet, 'packet.json');
  const packet = await loadTranslationTaskPacketByFile(packetFile);
  return {
    pointer,
    packetFile,
    packet
  };
}

function buildStatusSummary(tasks = []) {
  const summary = {
    pending: 0,
    submitted: 0,
    applied: 0,
    failed: 0
  };
  for (const task of tasks) {
    const status = String(task?.status || 'pending').trim().toLowerCase();
    if (status in summary) summary[status] += 1;
    else summary.pending += 1;
  }
  return summary;
}

export async function updateTranslationTaskStatus(taskFile, updater) {
  const task = await loadTranslationTaskByFile(taskFile);
  const nextTask = typeof updater === 'function' ? (await updater(task)) || task : task;
  await writeFile(taskFile, `${JSON.stringify(nextTask, null, 2)}\n`, 'utf-8');

  const packetFile = nextTask?.task_packet_file || task?.task_packet_file || '';
  let packet = null;
  if (packetFile) {
    packet = await loadTranslationTaskPacketByFile(packetFile);
    packet.tasks = (Array.isArray(packet.tasks) ? packet.tasks : []).map((row) => {
      if (row.file !== taskFile) return row;
      return {
        ...row,
        status: nextTask?.status || row.status || 'pending',
        submitted_at: nextTask?.lifecycle?.submitted_at || row.submitted_at || '',
        applied_at: nextTask?.lifecycle?.applied_at || row.applied_at || '',
        failed_at: nextTask?.lifecycle?.failed_at || row.failed_at || ''
      };
    });
    packet.status_summary = buildStatusSummary(packet.tasks);
    await writeFile(packetFile, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
  }

  return {
    task: nextTask,
    packet
  };
}
