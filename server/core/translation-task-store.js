import { lstat, readFile, realpath, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { getScopedTranslationTaskDir } from './path-config.js';

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

function safeText(value) {
  return String(value || '').trim();
}

function hasParentPathSegment(filePath = '') {
  return String(filePath || '').split(/[\\/]+/u).includes('..');
}

function isInsideDir(child = '', parent = '') {
  const rel = relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function canonicalTaskError() {
  return new Error('task_file is not a canonical translation task');
}

function assertExactPacketScope(packet = {}, {
  ownerId = '',
  realmId = '',
  botId = ''
} = {}) {
  const scope = packet?.scope || {};
  if (
    safeText(scope.owner_id) !== safeText(ownerId)
    || safeText(scope.realm_id || 'default') !== safeText(realmId || 'default')
    || safeText(scope.bot_id) !== safeText(botId)
  ) {
    throw canonicalTaskError();
  }
}

export async function loadTranslationTaskPacketByFile(packetFile) {
  return readJson(packetFile);
}

export async function loadTranslationTaskByFile(taskFile) {
  return readJson(taskFile);
}

export async function loadCanonicalTranslationTaskRecordByFile(taskFile) {
  const requested = safeText(taskFile);
  if (!requested || hasParentPathSegment(requested)) throw canonicalTaskError();

  let realTaskFile = '';
  try {
    const resolvedTaskFile = resolve(requested);
    const taskStat = await lstat(resolvedTaskFile);
    if (taskStat.isSymbolicLink()) throw canonicalTaskError();
    realTaskFile = await realpath(resolvedTaskFile);
  } catch (error) {
    if (error?.message === canonicalTaskError().message) throw error;
    throw canonicalTaskError();
  }

  const taskDir = dirname(realTaskFile);
  const packetDir = dirname(taskDir);
  const packetFile = join(packetDir, 'packet.json');
  let realPacketFile = '';
  let packet = null;
  try {
    const packetStat = await lstat(packetFile);
    if (packetStat.isSymbolicLink()) throw canonicalTaskError();
    realPacketFile = await realpath(packetFile);
    packet = await loadTranslationTaskPacketByFile(realPacketFile);
  } catch (error) {
    if (error?.message === canonicalTaskError().message) throw error;
    throw canonicalTaskError();
  }

  const scope = packet?.scope || {};
  const ownerId = safeText(scope.owner_id);
  const realmId = safeText(scope.realm_id || 'default');
  const botId = safeText(scope.bot_id);
  if (!ownerId || !realmId) throw canonicalTaskError();

  let scopedTaskDir = '';
  try {
    scopedTaskDir = await realpath(getScopedTranslationTaskDir(ownerId, realmId, botId));
  } catch {
    throw canonicalTaskError();
  }
  if (!isInsideDir(realTaskFile, scopedTaskDir) || !isInsideDir(realPacketFile, scopedTaskDir)) {
    throw canonicalTaskError();
  }

  let taskRow = null;
  for (const row of Array.isArray(packet.tasks) ? packet.tasks : []) {
    const rowFile = safeText(row?.file);
    if (!rowFile) continue;
    const realRowFile = await realpath(rowFile).catch(() => '');
    if (realRowFile === realTaskFile) {
      taskRow = row;
      break;
    }
  }
  if (!taskRow) throw canonicalTaskError();

  let task = null;
  try {
    task = await loadTranslationTaskByFile(realTaskFile);
  } catch {
    throw canonicalTaskError();
  }
  const realTaskPacketFile = await realpath(safeText(task?.task_packet_file)).catch(() => '');
  if (realTaskPacketFile !== realPacketFile) throw canonicalTaskError();

  return {
    taskFile: realTaskFile,
    packetFile: realPacketFile,
    packet,
    taskRow,
    task
  };
}

export async function loadCanonicalTranslationTaskByFile(taskFile) {
  return (await loadCanonicalTranslationTaskRecordByFile(taskFile)).task;
}

export async function loadLatestTranslationTaskPointer({
  ownerId = '',
  realmId = '',
  botId = '',
  owner_id = '',
  realm_id = '',
  bot_id = ''
} = {}) {
  const normalizedOwnerId = String(ownerId || owner_id || '').trim();
  const normalizedRealmId = String(realmId || realm_id || '').trim();
  const normalizedBotId = String(botId || bot_id || '').trim();
  const taskDir = getScopedTranslationTaskDir(normalizedOwnerId, normalizedRealmId, normalizedBotId);
  const latestFile = join(taskDir, 'latest.json');
  return readJson(latestFile);
}

export async function loadLatestTranslationTaskPacket({
  ownerId = '',
  realmId = '',
  botId = '',
  owner_id = '',
  realm_id = '',
  bot_id = ''
} = {}) {
  const normalizedOwnerId = String(ownerId || owner_id || '').trim();
  const normalizedRealmId = String(realmId || realm_id || '').trim();
  const normalizedBotId = String(botId || bot_id || '').trim();
  const pointer = await loadLatestTranslationTaskPointer({
    ownerId: normalizedOwnerId,
    realmId: normalizedRealmId,
    botId: normalizedBotId
  });
  const packetFile = join(pointer.latest_packet, 'packet.json');
  const packet = await loadTranslationTaskPacketByFile(packetFile);
  assertExactPacketScope(packet, {
    ownerId: normalizedOwnerId,
    realmId: normalizedRealmId,
    botId: normalizedBotId
  });
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
  const record = await loadCanonicalTranslationTaskRecordByFile(taskFile);
  const task = record.task;
  const nextTask = typeof updater === 'function' ? (await updater(task)) || task : task;
  await writeFile(record.taskFile, `${JSON.stringify({
    ...nextTask,
    task_packet_file: record.packetFile
  }, null, 2)}\n`, 'utf-8');

  const packet = record.packet || null;
  const nextRows = [];
  for (const row of Array.isArray(packet.tasks) ? packet.tasks : []) {
    const realRowFile = await realpath(safeText(row?.file)).catch(() => '');
    if (realRowFile !== record.taskFile) {
      nextRows.push(row);
      continue;
    }
    nextRows.push({
      ...row,
      status: nextTask?.status || row.status || 'pending',
      submitted_at: nextTask?.lifecycle?.submitted_at || row.submitted_at || '',
      applied_at: nextTask?.lifecycle?.applied_at || row.applied_at || '',
      failed_at: nextTask?.lifecycle?.failed_at || row.failed_at || ''
    });
  }
  packet.tasks = nextRows;
  packet.status_summary = buildStatusSummary(packet.tasks);
  await writeFile(record.packetFile, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');

  return {
    task: {
      ...nextTask,
      task_packet_file: record.packetFile
    },
    packet
  };
}
