import { handleMemoryAdvanceRoute } from './product/memory-advance.js';
import { handleMemoryIngestRoute } from './product/memory-ingest.js';
import { handleMemoryReadRoute } from './product/memory-read.js';
import { handleMemoryReviewedRoute } from './product/memory-reviewed.js';
import { handleMemoryRuntimeRoute } from './product/memory-runtime.js';
import { handleMemoryTranslateRoute } from './product/memory-translate.js';
import { handleMemoryTranslationTaskRoute } from './product/memory-translation-tasks.js';
import { handleMemoryWriteRoute } from './product/memory-write.js';
import { handleRuntimeApiProfilesRoute } from './product/runtime-api-profiles.js';
import { handleRuntimePersonaWorkspaceRoute } from './product/runtime-persona-workspace.js';
import { handleMemoryLeafRoute } from './diagnostic/memory-leaf.js';
import { handleSqlGrowthRoute } from './diagnostic/sql-growth.js';

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

const ROUTE_GROUPS = [
  {
    id: 'meta',
    label: 'Runtime Meta',
    lane: 'product',
    note: '供新运行时页面读取的最小路由目录。',
    handler: handleMetaRoute,
    routes: [
      { method: 'GET', path: '/api/meta/routes', summary: '列出产品/调试路由分区。' }
    ]
  },
  {
    id: 'runtime-ui',
    label: 'Runtime UI Lane',
    lane: 'product',
    note: '前台与旧实验台共用的轻量界面存档。',
    handler: async (req, res, url) => {
      if (await handleRuntimeApiProfilesRoute(req, res, url)) return true;
      if (await handleRuntimePersonaWorkspaceRoute(req, res, url)) return true;
      return false;
    },
    routes: [
      { method: 'GET', path: '/api/runtime/api-profiles', summary: '读取已保存 API 方案。' },
      { method: 'POST', path: '/api/runtime/api-profiles', summary: '覆盖保存 API 方案。' },
      { method: 'GET', path: '/api/runtime/persona-workspace', summary: '读取人格工位当前状态。' },
      { method: 'GET', path: '/api/runtime/parse-runtime', summary: '读取共享解析运行时状态。' },
      { method: 'GET', path: '/api/runtime/growth-context', summary: '给 agent 读取人格工位 + memory context 的生长上下文包。' },
      { method: 'GET', path: '/api/runtime/growth-task', summary: '生成一张可直接交给 agent 的卡片生长工单。' },
      { method: 'GET', path: '/api/runtime/growth-dashboard', summary: '读取主卡生长看板快照。' },
      { method: 'GET', path: '/api/runtime/staging-card', summary: '读取一张已入库主卡的 Markdown 正文。' },
      { method: 'GET', path: '/api/runtime/card-registry', summary: '读取当前 scope 的卡片目录。' },
      { method: 'GET', path: '/api/runtime/growth-ledger', summary: '读取当前 scope 的生长日志。' },
      { method: 'GET', path: '/api/runtime/growth-drafts', summary: '列出当前 scope 最近的卡片生长草稿。' },
      { method: 'GET', path: '/api/runtime/growth-draft', summary: '读取一张具体的卡片生长草稿。' },
      { method: 'POST', path: '/api/runtime/persona-workspace', summary: '保存人格工位当前状态。' },
      { method: 'POST', path: '/api/runtime/parse-runtime/start', summary: '启动一轮共享解析运行时。' },
      { method: 'POST', path: '/api/runtime/parse-runtime/pause', summary: '请求共享解析运行时暂停。' },
      { method: 'POST', path: '/api/runtime/parse-runtime/resume', summary: '从共享断点继续解析运行时。' },
      { method: 'POST', path: '/api/runtime/persona-workspace/cache', summary: '同步旧工作台 Persona 缓存到共享后端。' },
      { method: 'POST', path: '/api/runtime/persona-workspace/candidate-pool', summary: '根据 Persona 缓存生成语言指纹候选池。' },
      { method: 'POST', path: '/api/runtime/persona-workspace/generate-soul', summary: '根据 Persona 缓存与当前 API 生成 soul 草稿。' },
      { method: 'POST', path: '/api/runtime/persona-workspace/generate-language-fingerprint', summary: '根据候选池与当前 API 生成人格语言指纹。' },
      { method: 'POST', path: '/api/runtime/card-registry', summary: '写入或更新一条卡片目录记录。' },
      { method: 'POST', path: '/api/runtime/growth-ledger', summary: '追加一条生长决策日志。' },
      { method: 'POST', path: '/api/runtime/growth-commit', summary: '一次动作同时更新卡片目录与生长日志。' },
      { method: 'POST', path: '/api/runtime/growth-generate', summary: '生成一份可审的卡片生长草稿，必要时可直接 commit。' },
      { method: 'POST', path: '/api/runtime/growth-draft/review', summary: '给某张生长草稿写入人工并入指导与保留证据。' },
      { method: 'POST', path: '/api/runtime/growth-drafts/clear', summary: '清空当前 scope 下累积的生长草稿，不动已入库主卡。' },
      { method: 'POST', path: '/api/runtime/staging-cards/clear', summary: '清空 staging 里的已入库主卡，用于重新测试。' },
      { method: 'POST', path: '/api/runtime/obsidian-export', summary: '把某张生长草稿导出到 Obsidian staging 目录。' },
      { method: 'POST', path: '/api/runtime/obsidian-export/bundle', summary: '把当前 scope 的整包记忆卡导出为原始 Obsidian 包。' },
      { method: 'GET', path: '/api/runtime/memo-compact', summary: '读取当前 scope 的记忆整编预览包。' },
      { method: 'POST', path: '/api/runtime/memo-compact/export', summary: '导出当前 scope 的二次去重整编包。' },
      { method: 'POST', path: '/api/runtime/local-reset', summary: '清空本地 runtime_save 与 Obsidian staging，用于彻底重置当前工作台。' }
    ]
  },
  {
    id: 'memory-read',
    label: 'Memory Read Lane',
    lane: 'product',
    note: '读 bay / root / context / home / search 这条主路。',
    handler: handleMemoryReadRoute,
    routes: [
      { method: 'GET', path: '/api/memory/overview', summary: '读当前 memory bay 总览。' },
      { method: 'GET', path: '/api/memory/scopes', summary: '列出 scope。' },
      { method: 'GET', path: '/api/memory/scope', summary: '读单个 scope 卡。' },
      { method: 'GET', path: '/api/memory/home', summary: '读产品面 home 包。' },
      { method: 'GET', path: '/api/memory/entry', summary: '读入口页聚合卡。' },
      { method: 'GET', path: '/api/memory/search', summary: '按 query 搜索根。' },
      { method: 'GET', path: '/api/memory/root', summary: '读单个 root。' },
      { method: 'GET', path: '/api/memory/context', summary: '组装 bot/context 包。' },
      { method: 'GET', path: '/api/memory/shadow', summary: '回场读影层切片。' },
      { method: 'GET', path: '/api/memory/audit/recall', summary: '召回自检。' }
    ]
  },
  {
    id: 'memory-pipeline',
    label: 'Memory Pipeline Lane',
    lane: 'product',
    note: 'ingest -> translate -> write -> advance 这条写入主路。',
    handler: handleMemoryAdvanceRoute,
    routes: [
      { method: 'POST', path: '/api/memory/advance', summary: '让 bay 往前推进一格。' },
      { method: 'POST', path: '/api/memory/advance/drain', summary: '连续推进到目标状态。' }
    ]
  },
  {
    id: 'memory-ingest',
    label: 'Memory Ingest Lane',
    lane: 'product',
    note: '把原文收成稳定收件包。',
    handler: handleMemoryIngestRoute,
    routes: [
      { method: 'POST', path: '/api/memory/ingest', summary: '写入 ingest packet。' }
    ]
  },
  {
    id: 'memory-runtime',
    label: 'Runtime Worker Lane',
    lane: 'product',
    note: '前台只和本地后端说话，真正的模型调用在这里代跑。',
    handler: handleMemoryRuntimeRoute,
    routes: [
      { method: 'POST', path: '/api/memory/runtime/task/run', summary: '执行下一张 runtime AI 提炼任务。' },
      { method: 'POST', path: '/api/memory/runtime/reviewed/merge', summary: '对单个 reviewed cluster 运行 AI 合并。' }
    ]
  },
  {
    id: 'memory-reviewed',
    label: 'Reviewed Merge Lane',
    lane: 'product',
    note: '批后去冗余与最终写入前的中间层。',
    handler: handleMemoryReviewedRoute,
    routes: [
      { method: 'POST', path: '/api/memory/reviewed/append', summary: '把单批提炼结果落进 reviewed 中间层。' },
      { method: 'POST', path: '/api/memory/reviewed/clusters', summary: '读取当前 reviewed 候选簇。' },
      { method: 'POST', path: '/api/memory/reviewed/finalize', summary: '完成去冗余并正式写入。' }
    ]
  },
  {
    id: 'memory-translate',
    label: 'Memory Translate Lane',
    lane: 'product',
    note: '翻译包、AI 任务单、程序化翻译都走这里。',
    handler: handleMemoryTranslateRoute,
    routes: [
      { method: 'POST', path: '/api/memory/translate', summary: '从 ingest packet 生成 translation packet。' },
      { method: 'POST', path: '/api/memory/translate/prepare', summary: '生成 AI 翻译任务单。' },
      { method: 'POST', path: '/api/memory/translate/submit', summary: '提交 AI 翻译结果。' },
      { method: 'POST', path: '/api/memory/translate/fail', summary: '标记 AI 翻译失败。' },
      { method: 'POST', path: '/api/memory/translate/apply', summary: '应用翻译结果并送进写入层。' },
      { method: 'POST', path: '/api/memory/translate/programmatic', summary: '直接跑程序化 translator。' },
      { method: 'POST', path: '/api/memory/translate/programmatic/task/run', summary: '执行下一张程序化任务单。' },
      { method: 'POST', path: '/api/memory/translate/programmatic/task/drain', summary: '持续清空程序化任务队列。' }
    ]
  },
  {
    id: 'memory-translation-tasks',
    label: 'Translation Task Board',
    lane: 'product',
    note: '翻译任务看板与 worker 包读取。',
    handler: handleMemoryTranslationTaskRoute,
    routes: [
      { method: 'GET', path: '/api/memory/translate/tasks/latest', summary: '查看最近任务状态。' },
      { method: 'GET', path: '/api/memory/translate/task/next', summary: '取下一张 pending 任务。' },
      { method: 'GET', path: '/api/memory/translate/task/next/worker', summary: '取下一张 worker 任务包。' },
      { method: 'GET', path: '/api/memory/translate/task/worker', summary: '按文件读取 worker 包。' },
      { method: 'GET', path: '/api/memory/translate/task', summary: '按文件读取任务状态。' }
    ]
  },
  {
    id: 'memory-write',
    label: 'Memory Write Lane',
    lane: 'product',
    note: '标准合同写入根和藤。',
    handler: handleMemoryWriteRoute,
    routes: [
      { method: 'POST', path: '/api/memory/write', summary: '按标准合同写入 memory truth。' }
    ]
  },
  {
    id: 'memory-leaf',
    label: 'Leaf Audit Lane',
    lane: 'diagnostic',
    note: '叶层查看、审计与修补，先归入调试侧。',
    handler: handleMemoryLeafRoute,
    routes: [
      { method: 'GET', path: '/api/memory/leaf', summary: '读 leaf 包。' },
      { method: 'GET', path: '/api/memory/leaf/audit', summary: '叶层审计。' },
      { method: 'GET', path: '/api/memory/leaf/repair', summary: '预览叶层修补。' },
      { method: 'POST', path: '/api/memory/leaf/repair/apply', summary: '应用叶层修补。' },
      { method: 'POST', path: '/api/memory/leaf/write', summary: '直接写 leaf。' }
    ]
  },
  {
    id: 'sql-growth',
    label: 'SQL Growth Debug Lane',
    lane: 'diagnostic',
    note: '当前中级版仍保留的 SQL growth 调试接口。',
    handler: handleSqlGrowthRoute,
    routes: [
      { method: 'GET', path: '/api/health', summary: '后端健康检查。' },
      { method: 'GET', path: '/api/dev/sql-growth/summary', summary: 'SQL growth 总览。' },
      { method: 'GET', path: '/api/dev/sql-growth/fixtures', summary: 'SQL growth fixture 列表。' },
      { method: 'GET', path: '/api/dev/sql-growth/reviewed', summary: 'reviewed 目录总览。' },
      { method: 'GET', path: '/api/dev/sql-growth/reviewed-summary', summary: 'reviewed 深度汇总。' },
      { method: 'GET', path: '/api/dev/sql-growth/writeback-preview', summary: 'writeback 预览。' }
    ]
  }
];

function buildRouteCatalog() {
  return ROUTE_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    lane: group.lane,
    note: group.note,
    routes: group.routes.map((route) => ({ ...route }))
  }));
}

async function handleMetaRoute(req, res, url) {
  if (url.pathname !== '/api/meta/routes') return false;
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }
  json(res, 200, {
    ok: true,
    groups: buildRouteCatalog()
  });
  return true;
}

export async function dispatchRegisteredRoute(req, res, url) {
  for (const group of ROUTE_GROUPS) {
    if (await group.handler(req, res, url)) return true;
  }
  return false;
}

export function buildNotFoundPayload() {
  return {
    ok: false,
    error: 'Not found',
    groups: buildRouteCatalog(),
    routes: ROUTE_GROUPS.flatMap((group) =>
      group.routes.map((route) => `${route.method} ${route.path}`)
    )
  };
}
