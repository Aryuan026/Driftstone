import { applyTranslationEntries, buildTranslationPacket } from '../../core/memory-translation-service.js';
import { failAiTranslationTask, prepareAiTranslationTasks, submitAiTranslationTask } from '../../core/memory-translation-ai-service.js';
import { drainProgrammaticTranslationTasks, runNextProgrammaticTranslationTask } from '../../core/memory-translation-programmatic-task-service.js';
import { runProgrammaticTranslation } from '../../core/programmatic-translator.js';

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export async function handleMemoryTranslateRoute(req, res, url) {
  if (
    url.pathname !== '/api/memory/translate' &&
    url.pathname !== '/api/memory/translate/prepare' &&
    url.pathname !== '/api/memory/translate/apply' &&
    url.pathname !== '/api/memory/translate/submit' &&
    url.pathname !== '/api/memory/translate/fail' &&
    url.pathname !== '/api/memory/translate/programmatic' &&
    url.pathname !== '/api/memory/translate/programmatic/task/run' &&
    url.pathname !== '/api/memory/translate/programmatic/task/drain'
  ) return false;

  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }

  const body = await readJsonBody(req);
  const payload = url.pathname === '/api/memory/translate/apply'
    ? await applyTranslationEntries(body)
    : url.pathname === '/api/memory/translate/prepare'
      ? await prepareAiTranslationTasks(body)
      : url.pathname === '/api/memory/translate/submit'
        ? await submitAiTranslationTask(body)
      : url.pathname === '/api/memory/translate/fail'
        ? await failAiTranslationTask(body)
    : url.pathname === '/api/memory/translate/programmatic/task/run'
      ? await runNextProgrammaticTranslationTask(body)
    : url.pathname === '/api/memory/translate/programmatic/task/drain'
      ? await drainProgrammaticTranslationTasks(body)
    : url.pathname === '/api/memory/translate/programmatic'
      ? await runProgrammaticTranslation(body)
      : await buildTranslationPacket(body);
  json(res, 200, payload);
  return true;
}
