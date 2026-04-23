import {
  getLatestTranslationTaskPacketStatus,
  getNextPendingTranslationTask,
  getNextPendingTranslationWorkerPacket,
  getTranslationTaskStatus,
  getTranslationTaskWorkerPacket
} from '../../core/memory-translation-task-service.js';

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

export async function handleMemoryTranslationTaskRoute(req, res, url) {
  if (
    url.pathname !== '/api/memory/translate/tasks/latest' &&
    url.pathname !== '/api/memory/translate/task/next/worker' &&
    url.pathname !== '/api/memory/translate/task/next' &&
    url.pathname !== '/api/memory/translate/task/worker' &&
    url.pathname !== '/api/memory/translate/task'
  ) return false;

  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }

  if (url.pathname === '/api/memory/translate/tasks/latest') {
    const payload = await getLatestTranslationTaskPacketStatus({
      owner_id: url.searchParams.get('owner_id') || '',
      realm_id: url.searchParams.get('realm_id') || '',
      limit: Number(url.searchParams.get('limit') || 20)
    });
    json(res, 200, payload);
    return true;
  }

  if (url.pathname === '/api/memory/translate/task/next') {
    const payload = await getNextPendingTranslationTask({
      owner_id: url.searchParams.get('owner_id') || '',
      realm_id: url.searchParams.get('realm_id') || '',
      limit: Number(url.searchParams.get('limit') || 20)
    });
    json(res, 200, payload);
    return true;
  }

  if (url.pathname === '/api/memory/translate/task/next/worker') {
    const payload = await getNextPendingTranslationWorkerPacket({
      owner_id: url.searchParams.get('owner_id') || '',
      realm_id: url.searchParams.get('realm_id') || '',
      limit: Number(url.searchParams.get('limit') || 20)
    });
    json(res, 200, payload);
    return true;
  }

  if (url.pathname === '/api/memory/translate/task/worker') {
    const taskFile = String(url.searchParams.get('task_file') || '').trim();
    if (!taskFile) {
      json(res, 400, { ok: false, error: 'task_file is required' });
      return true;
    }
    const payload = await getTranslationTaskWorkerPacket(taskFile);
    json(res, 200, payload);
    return true;
  }

  const taskFile = String(url.searchParams.get('task_file') || '').trim();
  if (!taskFile) {
    json(res, 400, { ok: false, error: 'task_file is required' });
    return true;
  }

  const payload = await getTranslationTaskStatus(taskFile);
  json(res, 200, payload);
  return true;
}
