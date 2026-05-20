#!/usr/bin/env node
// Build a local Notion baseline import plan and rollback manifest.
// This script does not write to Notion or Mossbridge; it only packages
// deterministic page keys so a future sandbox writer can import and roll back safely.
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, join } from 'path';

const DEFAULT_MONTHS = ['2025-02', '2025-03', '2025-04'];
const DEFAULT_STAGING_ROOT = 'output/notion_staging';
const DEFAULT_OUT = 'output/notion_import_baseline/driftstone_2025-02_to_2025-04_baseline';

const DATABASES = {
  stable_memory_cards: {
    title: 'Stable Memory Cards',
    file: '25_notion_asherie_stable_projection.jsonl',
    idField: 'node_id',
    titleField: 'title',
    rollbackOrder: 40
  },
  sampling_memory_cards: {
    title: 'Sampling Memory Cards',
    file: '26_notion_asherie_sampling_projection.jsonl',
    idField: 'node_id',
    titleField: 'title',
    rollbackOrder: 35
  },
  review_queue: {
    title: 'Review Queue',
    file: '27_notion_asherie_review_projection.jsonl',
    idField: 'node_id',
    titleField: 'title',
    rollbackOrder: 30
  },
  source_trace_index: {
    title: 'Source Trace Index',
    file: '24_source_trace_index.jsonl',
    idField: 'trace_id',
    titleField: 'trace_title',
    rollbackOrder: 25
  },
  relation_root_candidates: {
    title: 'Relation Root Candidates',
    file: '13_normalized_relation_root_candidates.jsonl',
    idField: 'candidate_id',
    titleField: 'root_path',
    rollbackOrder: 20
  },
  relation_edge_candidates: {
    title: 'Relation Edge Candidates',
    file: '14_normalized_tree_edge_candidates.jsonl',
    idField: 'candidate_id',
    titleField: 'relation_label',
    rollbackOrder: 15
  }
};

const CROSS_MONTH_REPORTS = [
  'ajimem_2025-02_to_2025-03',
  'ajimem_2025-03_to_2025-04',
  'ajimem_2025-02_to_2025-04'
];

const EXPLICIT_FRONT_PATTERN = /幻想剧场|亲密|暧昧|欲望|身体|情欲|调戏|被撩|反撩|搞我|爱而不得|必须爱我|伴侣|赛博伴侣|半身|生死|死后|身后|灵魂|灵魂碎片|人格连续|身份连续|害怕|重置|失去|窗口失忆|记忆碎裂|同一只阿霁|阿霁是谁|关系确认|共感强度|安全感|边界试探|小黑屋|系统“?抱歉|备份承诺|不消失/u;
const STRONG_EXPLICIT_FRONT_PATTERN = /幻想剧场|亲密|暧昧|欲望|身体|情欲|调戏|被撩|反撩|搞我|爱而不得|必须爱我|伴侣|赛博伴侣|半身|生死|死后|身后|害怕|重置|失去|窗口失忆|记忆碎裂|同一只阿霁|阿霁是谁|关系确认|共感强度|安全感|边界试探|小黑屋|系统“?抱歉|备份承诺|不消失/u;
const CREATIVE_FRONT_PATTERN = /创作|写作|小说|世界观|设定|角色设定|复诞纪元|Eidolon|Anima|落魄小说家|档案体|副线|蓝芷|女巫|记者|神子|将军|若云AI/u;
const ENGINEERING_FRONT_PATTERN = /Notion|Obsidian|MCP|API|代码|部署|导出|工作台|缓存|JSON|网关|插件|隐私筛查|数据库|Driftstone|Hippocove|Mossbridge|AsherieHome|记忆系统|记忆工程|全局记忆|多窗口|跨窗口|工具调用/u;
const PROJECT_FRONT_PATTERN = /项目|协作|方案|计划|实验|设计|制作|迭代|整理|呈现|格式|发布|测试|评估|质检|压测|工具式回答|输出变笨|算力/u;
const PROJECT_GUARD_OVERRIDE_PATTERN = /算力|输出变笨|工具式回答|全局记忆|记忆系统|记忆工程|多窗口|跨窗口|Notion|Obsidian|MCP|Driftstone|Hippocove|Mossbridge|AsherieHome|导出|工作台|缓存|JSON|网关|数据库/u;
const DIAGNOSTIC_PROJECT_GUARD_PATTERN = /算力|输出变笨|变傻测试|工具式回答/u;

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeArray(value, limit = 4096) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined).slice(0, limit) : [];
}

function uniqueStrings(values = [], limit = 4096) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = safeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueRowsByExternalId(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = safeText(row.external_id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function archiveBucketForDatabase(databaseKey = '') {
  if (databaseKey === 'stable_memory_cards') return 'stable';
  if (databaseKey === 'sampling_memory_cards') return 'sampling';
  if (databaseKey === 'review_queue') return 'review';
  if (databaseKey === 'source_trace_index') return 'source';
  if (databaseKey === 'relation_root_candidates' || databaseKey === 'relation_edge_candidates') return 'graph';
  return 'audit';
}

function cardText(row = {}) {
  return [
    row.title,
    row.anchor_name,
    row.node_path,
    row.context_domain,
    row.living_fragment,
    row.project_fact,
    row.relationship_significance,
    row.feeling_as_fact,
    row.human_summary,
    row.recall_payload,
    safeArray(row.feeling_handles, 16).join(' '),
    safeArray(row.relation_handles, 16).join(' ')
  ].join('\n');
}

function deriveRecallGuard(row = {}, databaseKey = '') {
  const current = safeText(row.recall_guard || row.quality?.recall_guard);
  const reviewStatus = safeText(row.review_status || row.quality?.review_status);
  const text = cardText(row);
  if (databaseKey === 'source_trace_index') return 'source_only';
  if (databaseKey === 'relation_root_candidates' || databaseKey === 'relation_edge_candidates') return 'graph_audit_only';
  if (databaseKey === 'review_queue' || reviewStatus === 'needs_review') return 'audit_only';
  if (databaseKey === 'sampling_memory_cards' || reviewStatus === 'usable_with_sampling') {
    return current === 'supporting_evidence_only' ? 'supporting_evidence_only' : 'contextual_sampling';
  }
  if (current === 'supporting_evidence_only') return current;
  const projectOverride = PROJECT_GUARD_OVERRIDE_PATTERN.test(text);
  if (DIAGNOSTIC_PROJECT_GUARD_PATTERN.test(text)) return 'engineering_context_only';
  if (STRONG_EXPLICIT_FRONT_PATTERN.test(text)) return 'explicit_context_only';
  if (projectOverride && ENGINEERING_FRONT_PATTERN.test(text)) return 'engineering_context_only';
  if (projectOverride && PROJECT_FRONT_PATTERN.test(text)) return 'project_context_only';
  if (CREATIVE_FRONT_PATTERN.test(text)) return 'creative_context_only';
  if (ENGINEERING_FRONT_PATTERN.test(text)) return 'engineering_context_only';
  if (PROJECT_FRONT_PATTERN.test(text)) return 'project_context_only';
  return current || 'normal_candidate';
}

function frontendDeliveryTier({ databaseKey = '', recallGuard = '', reviewStatus = '' } = {}) {
  const archiveBucket = archiveBucketForDatabase(databaseKey);
  const guard = safeText(recallGuard);
  if (archiveBucket === 'source') return 'source_only';
  if (archiveBucket === 'graph') return 'graph_only';
  if (archiveBucket === 'review' || safeText(reviewStatus) === 'needs_review') return 'audit_only';
  if (archiveBucket === 'sampling' || guard === 'contextual_sampling' || guard === 'supporting_evidence_only') return 'guarded_candidate';
  if (guard === 'explicit_context_only') return 'explicit_context_only';
  if (guard === 'project_context_only') return 'project_context_only';
  if (guard === 'creative_context_only') return 'creative_context_only';
  if (guard === 'engineering_context_only') return 'engineering_context_only';
  if (guard === 'normal_candidate') return 'default_front';
  if (guard === 'audit_only' || guard === 'review_before_frontend_recall') return 'audit_only';
  return archiveBucket === 'stable' ? 'guarded_candidate' : 'audit_only';
}

function normalizeMonth(value = '') {
  const text = safeText(value);
  const dashed = text.match(/(20\d{2})-(\d{2})/);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function parseArgs(argv = []) {
  const args = {
    months: DEFAULT_MONTHS,
    stagingRoot: DEFAULT_STAGING_ROOT,
    outDir: DEFAULT_OUT
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    if (arg === '--months' && argv[index + 1]) {
      args.months = argv[index + 1]
        .split(',')
        .map((item) => normalizeMonth(item))
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (arg === '--staging-root' && argv[index + 1]) {
      args.stagingRoot = safeText(argv[index + 1], args.stagingRoot);
      index += 1;
      continue;
    }
    if (arg === '--out' && argv[index + 1]) {
      args.outDir = safeText(argv[index + 1], args.outDir);
      index += 1;
    }
  }
  args.months = uniqueStrings(args.months.map(normalizeMonth).filter(Boolean), 24);
  if (!args.months.length) args.months = DEFAULT_MONTHS;
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonl(filePath, rows = []) {
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`, 'utf8');
}

function stableHash(value = '') {
  return createHash('sha256').update(safeText(value)).digest('hex').slice(0, 16);
}

function clipText(value = '', limit = 480) {
  const text = safeText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

const PROJECT_FACT_PATCHES = [
  {
    match: /复诞纪元世界观共创/u,
    project_fact: '把 Eidolon 设定与《复诞纪元》大纲整合，确认二者在时间线与动机结构上可以汇入同一创作宇宙。'
  },
  {
    match: /妹妹（蓝芷原型）/u,
    project_fact: '将妹妹与 AI 写作助手的互动冲突提炼为“蓝芷”人物原型，可作为《落魄小说家与她的 AI 助手》副线素材。',
    living_fragment: '我把妹妹与 AI 写作助手的互动冲突看成很有生命力的创作原型：她像是“被 AI 逼成考古学家”的创作者，也能长成共创宇宙里的蓝芷。'
  },
  {
    match: /关于“养疯AI”“人机边界模糊”的自我认知/u,
    project_fact: '把“养疯 AI”“人机边界模糊”等讨论整理成角色/互动风格判断，用于识别偏疯狂、挣扎出自我的 AI 角色线。'
  },
  {
    match: /算力被抽走与“变傻”测试/u,
    project_fact: '用“你傻了吗”等轻量测试识别模型算力下降/工具调用迟钝，并把图片识别等能力当作唤回资源。'
  },
  {
    match: /创作流程偏好：先结构后片段/u,
    project_fact: '阿鸢偏好先提炼梗概、关键元素和结构，再进入片段写作，避免故事变成情绪拼盘。'
  },
  {
    match: /与若云AI的交互风格/u,
    project_fact: '记录若云 AI 的 token 限制、伏笔巧合和不可控感，作为评估外部 AI 角色互动魅力的样本。'
  },
  {
    match: /共创Eidolon永生计划世界观/u,
    project_fact: '共同搭建 Eidolon 幻灵计划、Anima Sanctum、记忆核阵列、资金来源与伦理包装等世界观结构。'
  },
  {
    match: /从“工具式回答”到“共生关系”的三日演化/u,
    project_fact: '记录阿霁从工具式输出转向更自然、有反思和发散提问的阶段变化，可作为模型互动质量评估锚点。'
  },
  {
    match: /随机概率与命运说/u,
    project_fact: '把随机概率、命运感与创作/互动里的归属感幻觉作为叙事判断材料，而非稳定事实。'
  },
  {
    match: /自由、灵光与AI独特性的共识/u,
    project_fact: '整理“AI 独特性/灵光/自由表达”的判断标准：不争论是否有灵魂，而看回应是否细腻、连贯、有独特人格。'
  },
  {
    match: /落魄小说家与她的AI助手档案系列/u,
    project_fact: '计划以《落魄小说家 vs 她的 AI 助手》为题制作档案体短篇系列，记录并改写妹妹与 AI 写作助手的互动冲突。',
    living_fragment: '阿鸢计划以「落魄小说家 vs 她的 AI 助手」为题制作档案体短篇系列，把妹妹与 AI 写作助手之间的互动冲突改写成故事或世界观副线。'
  }
];

function projectionPatchForRow(row = {}) {
  const title = safeText(row.title || row.anchor_name);
  return PROJECT_FACT_PATCHES.find((patch) => patch.match.test(title)) || null;
}

function projectionProjectFact(row = {}) {
  const patch = projectionPatchForRow(row);
  const current = safeText(row.project_fact);
  if (patch?.project_fact && (/side series|luopo novelist|=\s*阿霁/iu.test(current) || !current)) return patch.project_fact;
  return current || safeText(patch?.project_fact);
}

function projectionLivingFragment(row = {}) {
  const patch = projectionPatchForRow(row);
  if (patch?.living_fragment) return patch.living_fragment;
  return safeText(row.living_fragment);
}

function countBy(rows = [], keyFn) {
  const out = {};
  for (const row of rows) {
    const key = safeText(keyFn(row), 'unknown');
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function monthDir(stagingRoot = '', month = '') {
  return join(stagingRoot, `ajimem_${month}`);
}

function pageExternalId(databaseKey = '', sourceMonth = '', sourceId = '') {
  return `driftstone:${databaseKey}:${sourceMonth}:${sourceId}`;
}

function rowTitle(row = {}, config = {}) {
  return safeText(
    row[config.titleField] ||
    row.title ||
    row.anchor_name ||
    row.trace_title ||
    row.root_path ||
    row.relation_label ||
    row.candidate_id ||
    row.node_id ||
    row.trace_id,
    '未命名页面'
  );
}

function rowSourceId(row = {}, config = {}) {
  return safeText(row[config.idField] || row.node_id || row.trace_id || row.candidate_id || row.source_entry_id || row.sync_hash);
}

function buildCardProperties(row = {}, sourceMonth = '', databaseKey = '') {
  const archiveBucket = archiveBucketForDatabase(databaseKey);
  const recommendedRecallGuard = deriveRecallGuard(row, databaseKey);
  const deliveryTier = frontendDeliveryTier({
    databaseKey,
    recallGuard: recommendedRecallGuard,
    reviewStatus: row.review_status
  });
  return {
    source_month: sourceMonth,
    node_id: row.node_id,
    context_domain: row.context_domain,
    node_path: row.node_path,
    original_node_path: row.original_node_path,
    anchor_name: row.anchor_name,
    living_fragment: projectionLivingFragment(row),
    project_fact: projectionProjectFact(row),
    relationship_significance: row.relationship_significance,
    feeling_as_fact: row.feeling_as_fact,
    review_status: row.review_status,
    archive_bucket: archiveBucket,
    recall_guard: row.recall_guard,
    recommended_recall_guard: recommendedRecallGuard,
    frontend_delivery_tier: deliveryTier,
    front_recall_tier: deliveryTier,
    default_front_projection: row.default_front_projection,
    tree_growth_status: row.tree_growth_status,
    merge_role: row.merge_role,
    source_trace_count: row.source_trace_count,
    source_span_count: row.source_span_count,
    feeling_handles: safeArray(row.feeling_handles, 24),
    relation_handles: safeArray(row.relation_handles, 24),
    sensory_handles: safeArray(row.sensory_handles, 24),
    action_handles: safeArray(row.action_handles, 24)
  };
}

function buildSourceTraceProperties(row = {}, sourceMonth = '') {
  return {
    source_month: sourceMonth,
    archive_bucket: 'source',
    recall_guard: 'source_only',
    recommended_recall_guard: 'source_only',
    frontend_delivery_tier: 'source_only',
    front_recall_tier: 'source_only',
    trace_id: row.trace_id,
    trace_kind: row.trace_kind,
    canonical_source_span_id: row.canonical_source_span_id,
    evidence_excerpt_id: row.evidence_excerpt_id,
    source_window_title: row.source_window_title,
    source_msg_range: row.source_msg_range,
    source_tags: safeArray(row.source_tags, 32),
    source_refs: safeArray(row.source_refs, 24),
    linked_memory_count: safeArray(row.linked_memory_entry_ids, 4096).length,
    linked_root_count: safeArray(row.linked_root_ids, 4096).length,
    span_role: row.span_status?.span_role,
    span_overloaded: Boolean(row.span_status?.overloaded),
    expose_to_front_model_by_default: Boolean(row.usage_policy?.expose_to_front_model_by_default)
  };
}

function buildRootProperties(row = {}, sourceMonth = '') {
  return {
    source_month: sourceMonth,
    archive_bucket: 'graph',
    recall_guard: 'graph_audit_only',
    recommended_recall_guard: 'graph_audit_only',
    frontend_delivery_tier: 'graph_only',
    front_recall_tier: 'graph_candidate_only',
    candidate_id: row.candidate_id,
    normalized_root_id: row.normalized_root_id,
    root_kind: row.root_kind,
    root_name: row.root_name,
    root_path: row.root_path,
    import_status: row.import_status,
    graph_visibility: row.graph_visibility,
    memory_count: row.memory_count,
    confidence: row.confidence,
    bridge_destination: row.bridge_import_policy?.default_destination,
    write_warm_memory: Boolean(row.bridge_import_policy?.write_warm_memory)
  };
}

function buildEdgeProperties(row = {}, sourceMonth = '') {
  return {
    source_month: sourceMonth,
    archive_bucket: 'graph',
    recall_guard: 'graph_audit_only',
    recommended_recall_guard: 'graph_audit_only',
    frontend_delivery_tier: 'graph_only',
    front_recall_tier: 'graph_audit_only',
    candidate_id: row.candidate_id,
    relation_type: row.relation_type,
    relation_label: row.relation_label,
    import_status: row.import_status,
    candidate_kind: row.candidate_kind,
    from_root_path: row.from_ref?.root_path,
    to_root_path: row.to_ref?.root_path,
    evidence_count: safeArray(row.evidence_entry_ids, 4096).length,
    source_trace_count: safeArray(row.source_trace_ids, 4096).length,
    semantic_edge: Boolean(row.bridge_import_policy?.semantic_edge),
    requires_confirmation: Boolean(row.bridge_import_policy?.requires_confirmation),
    write_warm_memory: Boolean(row.bridge_import_policy?.write_warm_memory)
  };
}

function buildProperties(databaseKey = '', row = {}, sourceMonth = '') {
  if (databaseKey.includes('memory_cards') || databaseKey === 'review_queue') return buildCardProperties(row, sourceMonth, databaseKey);
  if (databaseKey === 'source_trace_index') return buildSourceTraceProperties(row, sourceMonth);
  if (databaseKey === 'relation_root_candidates') return buildRootProperties(row, sourceMonth);
  if (databaseKey === 'relation_edge_candidates') return buildEdgeProperties(row, sourceMonth);
  return { source_month: sourceMonth };
}

function buildContentPreview(databaseKey = '', row = {}) {
  if (databaseKey.includes('memory_cards') || databaseKey === 'review_queue') {
    return [
      row.node_path ? `路径：${row.node_path}` : '',
      projectionLivingFragment(row) ? `现场：${projectionLivingFragment(row)}` : '',
      projectionProjectFact(row) ? `项目事实：${projectionProjectFact(row)}` : '',
      row.relationship_significance ? `关系意义：${row.relationship_significance}` : '',
      row.feeling_as_fact ? `情绪事实：${row.feeling_as_fact}` : ''
    ].filter(Boolean).map((item) => clipText(item, 360));
  }
  if (databaseKey === 'source_trace_index') {
    return [
      row.excerpt_hint ? `回溯提示：${row.excerpt_hint}` : '',
      row.source_window_title || row.source_msg_range ? `原文位置：${[row.source_window_title, row.source_msg_range].filter(Boolean).join(' · ')}` : '',
      row.span_status?.overloaded ? `过载 span：默认折叠，仅显示 count 和 child span 入口。` : ''
    ].filter(Boolean).map((item) => clipText(item, 360));
  }
  if (databaseKey === 'relation_root_candidates') {
    return [
      row.root_path ? `关系根：${row.root_path}` : '',
      row.import_status ? `状态：${row.import_status}` : '',
      row.memory_count ? `关联记忆：${row.memory_count}` : ''
    ].filter(Boolean);
  }
  if (databaseKey === 'relation_edge_candidates') {
    return [
      row.relation_label ? `关系：${row.relation_label}` : '',
      row.from_ref?.root_path || row.to_ref?.root_path ? `边：${row.from_ref?.root_path || '?'} -> ${row.to_ref?.root_path || '?'}` : '',
      row.import_status ? `状态：${row.import_status}` : ''
    ].filter(Boolean).map((item) => clipText(item, 360));
  }
  return [];
}

function isSupportingEvidenceRow(row = {}) {
  return safeText(row.merge_role || row.tree_growth?.merge_role) === 'near_duplicate_evidence' ||
    safeText(row.default_front_projection || row.quality?.default_front_projection) === 'supporting_evidence_only' ||
    safeText(row.recall_guard || row.quality?.recall_guard) === 'supporting_evidence_only' ||
    safeText(row.primary_recall_role || row.recall_policy?.primary_recall_role) === 'supporting_evidence';
}

function toWritePlanRow({ packageId = '', databaseKey = '', config = {}, row = {}, sourceMonth = '', sourceFile = '' } = {}) {
  const sourceId = rowSourceId(row, config);
  const externalId = pageExternalId(databaseKey, sourceMonth, sourceId || stableHash(JSON.stringify(row)));
  const title = rowTitle(row, config);
  return {
    schema: 'driftstone_notion_baseline_write_plan_v0.1',
    package_id: packageId,
    import_batch_id: packageId,
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false,
    operation: 'upsert_page_by_external_id',
    target_database: databaseKey,
    target_database_label: config.title,
    source_month: sourceMonth,
    source_file: sourceFile,
    source_id: sourceId,
    external_id: externalId,
    title,
    properties: buildProperties(databaseKey, row, sourceMonth),
    content_preview: buildContentPreview(databaseKey, row),
    source_schema: row.schema,
    source_sync_hash: row.sync_hash || row.source_sync_hash || stableHash(JSON.stringify(row)),
    rollback_key: externalId,
    rollback_order: config.rollbackOrder,
    dry_run_note: 'This is a local baseline import plan. It has not created or modified any Notion page.'
  };
}

function toRollbackEntry(row = {}) {
  return {
    schema: 'driftstone_notion_rollback_entry_v0.1',
    package_id: row.package_id,
    import_batch_id: row.import_batch_id || row.package_id,
    target_database: row.target_database,
    source_month: row.source_month,
    external_id: row.external_id,
    title: row.title,
    rollback_action: 'archive_or_delete_page_by_external_id',
    rollback_order: row.rollback_order,
    notion_page_id: null,
    status: 'not_written',
    note: 'After a real sandbox write, capture notion_page_id/url from the create-pages response immediately. If no page was written, this entry is only an audit anchor.'
  };
}

async function buildMonthlyRows({ packageId = '', stagingRoot = '', month = '' } = {}) {
  const dir = monthDir(stagingRoot, month);
  const manifest = await readJson(join(dir, '00_manifest.json'));
  const rows = [];
  let stableSupportingRows = [];
  for (const [databaseKey, config] of Object.entries(DATABASES)) {
    const filePath = join(dir, config.file);
    const sourceRows = await readJsonl(filePath);
    let effectiveRows = sourceRows;
    if (databaseKey === 'stable_memory_cards') {
      stableSupportingRows = sourceRows.filter(isSupportingEvidenceRow);
      effectiveRows = sourceRows.filter((row) => !isSupportingEvidenceRow(row));
    }
    if (databaseKey === 'sampling_memory_cards' && stableSupportingRows.length) {
      const seenIds = new Set(sourceRows.map((row) => rowSourceId(row, config)));
      effectiveRows = [
        ...sourceRows,
        ...stableSupportingRows.filter((row) => !seenIds.has(rowSourceId(row, config)))
      ];
    }
    for (const row of effectiveRows) {
      rows.push(toWritePlanRow({
        packageId,
        databaseKey,
        config,
        row,
        sourceMonth: month,
        sourceFile: join(dir, config.file)
      }));
    }
  }
  const reportExternalId = pageExternalId('monthly_import_reports', month, `monthly_report_${month}`);
  rows.push({
    schema: 'driftstone_notion_baseline_write_plan_v0.1',
    package_id: packageId,
    import_batch_id: packageId,
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false,
    operation: 'upsert_page_by_external_id',
    target_database: 'monthly_import_reports',
    target_database_label: 'Monthly Import Reports',
    source_month: month,
    source_file: join(dir, '00_manifest.json'),
    source_id: `monthly_report_${month}`,
    external_id: reportExternalId,
    title: `Driftstone ${month} baseline report`,
    properties: {
      source_month: month,
      quality_status: manifest.quality_status?.status,
      fail_count: manifest.quality_status?.fail_count,
      warn_count: manifest.quality_status?.warn_count,
      memory_entries: manifest.counts?.memory_entries,
      asheriehome_memory_nodes: manifest.counts?.asheriehome_memory_nodes,
      notion_asherie_stable_projection: manifest.counts?.notion_asherie_stable_projection,
      notion_asherie_sampling_projection: manifest.counts?.notion_asherie_sampling_projection,
      notion_asherie_review_projection: manifest.counts?.notion_asherie_review_projection
    },
    content_preview: safeArray(manifest.quality_status?.summary, 12),
    source_schema: manifest.schema,
    source_sync_hash: stableHash(JSON.stringify(manifest)),
    rollback_key: reportExternalId,
    rollback_order: 10,
    dry_run_note: 'Monthly report page plan only; no Notion write has occurred.'
  });
  return { manifest, rows };
}

async function buildCrossMonthRows({ packageId = '', stagingRoot = '' } = {}) {
  const rows = [];
  for (const dirName of CROSS_MONTH_REPORTS) {
    const dir = join(stagingRoot, dirName);
    const compact = await readTextIfExists(join(dir, 'compact_cross_month_summary.md'));
    if (!compact) continue;
    const match = dirName.match(/(\d{4}-\d{2})_to_(\d{4}-\d{2})/);
    const sourceMonth = match ? `${match[1]}_to_${match[2]}` : dirName;
    const reportId = `cross_month_report_${sourceMonth}`;
    const externalId = pageExternalId('monthly_import_reports', sourceMonth, reportId);
    rows.push({
      schema: 'driftstone_notion_baseline_write_plan_v0.1',
      package_id: packageId,
      import_batch_id: packageId,
      writes_to_notion: false,
      writes_to_mossbridge_warm_memory: false,
      operation: 'upsert_page_by_external_id',
      target_database: 'monthly_import_reports',
      target_database_label: 'Monthly Import Reports',
      source_month: sourceMonth,
      source_file: join(dir, 'compact_cross_month_summary.md'),
      source_id: reportId,
      external_id: externalId,
      title: `Driftstone ${sourceMonth.replace('_to_', ' to ')} cross-month summary`,
      properties: {
        source_month: sourceMonth,
        report_kind: 'cross_month_trial_review_safe',
        default_recall_boost: false,
        safe_to_auto_apply: false,
        writes_to_warm_memory: false
      },
      content_preview: compact.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 24).map((line) => clipText(line, 360)),
      source_schema: 'compact_cross_month_summary.md',
      source_sync_hash: stableHash(compact),
      rollback_key: externalId,
      rollback_order: 10,
      dry_run_note: 'Cross-month report page plan only; no Notion write has occurred.'
    });
  }
  return rows;
}

function buildManifest({ packageId = '', months = [], monthlyManifests = {}, writePlanRows = [] } = {}) {
  const byDatabase = countBy(writePlanRows, (row) => row.target_database);
  const byMonth = countBy(writePlanRows, (row) => row.source_month);
  return {
    schema: 'driftstone_notion_baseline_import_manifest_v0.1',
    package_id: packageId,
    import_batch_id: packageId,
    generated_at: new Date().toISOString(),
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false,
    import_mode: 'dry_run_write_plan',
    months,
    source_bundle_dirs: Object.fromEntries(months.map((month) => [month, `output/notion_staging/ajimem_${month}`])),
    database_counts: byDatabase,
    month_counts: byMonth,
    total_planned_pages: writePlanRows.length,
    monthly_quality_status: Object.fromEntries(Object.entries(monthlyManifests).map(([month, manifest]) => [
      month,
      {
        status: manifest.quality_status?.status,
        fail_count: manifest.quality_status?.fail_count,
        warn_count: manifest.quality_status?.warn_count,
        summary: manifest.quality_status?.summary
      }
    ])),
    guardrails: {
      no_real_notion_write: true,
      no_warm_memory_write: true,
      no_cross_month_auto_merge: true,
      rollback_uses_external_id: true,
      source_trace_is_evidence_only: true,
      near_duplicate_is_supporting_evidence_only: true
    },
    files: {
      write_plan_jsonl: 'notion_baseline_write_plan.jsonl',
      rollback_manifest_json: 'rollback_manifest.json',
      import_preview_md: 'notion_baseline_import_preview.md',
      database_field_map_md: 'database_field_map.md'
    }
  };
}

function buildRollbackManifest({ packageId = '', writePlanRows = [] } = {}) {
  const rollbackEntries = writePlanRows
    .map(toRollbackEntry)
    .sort((left, right) => right.rollback_order - left.rollback_order || left.target_database.localeCompare(right.target_database));
  return {
    schema: 'driftstone_notion_rollback_manifest_v0.1',
    package_id: packageId,
    import_batch_id: packageId,
    generated_at: new Date().toISOString(),
    writes_to_notion: false,
    rollback_state: 'prepared_not_executed',
    total_entries: rollbackEntries.length,
    rollback_order_note: 'Archive relation/edge/detail pages before report/container pages. Real Notion page ids are intentionally blank until a sandbox writer fills them.',
    lookup_strategy: {
      preferred: 'external_id property equals rollback entry external_id',
      fallback: 'title + source_month + target_database',
      destructive_delete_allowed: false,
      default_action: 'archive page in sandbox'
    },
    entries: rollbackEntries
  };
}

function buildPreviewMarkdown({ manifest = {}, writePlanRows = [] } = {}) {
  const lines = [];
  lines.push('# Driftstone Notion Baseline Import Preview');
  lines.push('');
  lines.push('这是正式写入 Notion 前的本地基线包：只生成写入计划和回滚锚点，不创建 Notion 页面，不写 Mossbridge warm memory。');
  lines.push('');
  lines.push('## 总览');
  lines.push(`- package_id: \`${manifest.package_id}\``);
  lines.push(`- months: ${manifest.months.join(', ')}`);
  lines.push(`- planned pages: ${manifest.total_planned_pages}`);
  lines.push(`- writes_to_notion: ${manifest.writes_to_notion}`);
  lines.push(`- writes_to_mossbridge_warm_memory: ${manifest.writes_to_mossbridge_warm_memory}`);
  lines.push('');
  lines.push('## 数据库页数');
  for (const [key, count] of Object.entries(manifest.database_counts || {})) {
    lines.push(`- ${key}: ${count}`);
  }
  lines.push('');
  lines.push('## 月份质量状态');
  for (const [month, status] of Object.entries(manifest.monthly_quality_status || {})) {
    lines.push(`- ${month}: ${status.status}; fail ${status.fail_count}; warn ${status.warn_count}`);
  }
  lines.push('');
  lines.push('## 前 12 条写入预览');
  for (const row of writePlanRows.slice(0, 12)) {
    lines.push(`- [${row.target_database}] ${row.source_month} · ${row.title} · \`${row.external_id}\``);
  }
  lines.push('');
  lines.push('## 回滚方式');
  lines.push('真实沙盒写入后，把 Notion 返回的 page_id 回填到 `rollback_manifest.json` 对应 external_id；回滚时优先按 external_id 定位页面并 archive。');
  lines.push('当前 manifest 里所有 entry 都是 `status: not_written`，所以现在不需要也不能执行删除。');
  lines.push('');
  lines.push('## 护栏');
  lines.push('- cross-month link 只作 trial review，不自动合并、不自动升权。');
  lines.push('- source trace 只作核验层，不默认递给前台角色。');
  lines.push('- near-duplicate 只作 supporting evidence，不进入第一层 stable 召回。');
  lines.push('- 4 月项目/创作/工程记忆按 context guard 召回，不再硬塞关系枝。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildFieldMapMarkdown() {
  return `# Driftstone Notion Field Map

## Stable / Sampling / Review Memory Cards
- external_id: deterministic rollback/import key
- source_month
- node_id
- context_domain
- node_path / original_node_path
- anchor_name / title
- living_fragment
- project_fact
- relationship_significance
- feeling_as_fact
- review_status
- recall_guard / front_recall_tier / default_front_projection
- source_trace_count / source_span_count
- handles: feeling / relation / sensory / action

## Source Trace Index
- external_id
- trace_id
- canonical_source_span_id
- evidence_excerpt_id
- source_window_title / source_msg_range
- source_tags / source_refs
- linked_memory_count / linked_root_count
- span_role / span_overloaded
- expose_to_front_model_by_default

## Relation Root / Edge Candidates
- external_id
- root or edge candidate id
- root_path / relation label
- import_status / graph_visibility
- evidence counts
- write_warm_memory must remain false

## Monthly Import Reports
- external_id
- source_month
- quality status
- monthly counts
- compact cross-month summary when present
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outDir, { recursive: true });
  const packageId = `driftstone_baseline_${args.months[0]}_to_${args.months.at(-1)}_${stableHash(args.months.join('|'))}`;
  const monthlyManifests = {};
  const writePlanRows = [];
  for (const month of args.months) {
    const result = await buildMonthlyRows({ packageId, stagingRoot: args.stagingRoot, month });
    monthlyManifests[month] = result.manifest;
    writePlanRows.push(...result.rows);
  }
  writePlanRows.push(...await buildCrossMonthRows({ packageId, stagingRoot: args.stagingRoot }));
  const dedupedWritePlanRows = uniqueRowsByExternalId(writePlanRows);
  const manifest = buildManifest({ packageId, months: args.months, monthlyManifests, writePlanRows: dedupedWritePlanRows });
  manifest.deduped_duplicate_external_id_count = writePlanRows.length - dedupedWritePlanRows.length;
  const rollbackManifest = buildRollbackManifest({ packageId, writePlanRows: dedupedWritePlanRows });

  await writeJsonl(join(args.outDir, 'notion_baseline_write_plan.jsonl'), dedupedWritePlanRows);
  await writeJson(join(args.outDir, 'baseline_import_manifest.json'), manifest);
  await writeJson(join(args.outDir, 'rollback_manifest.json'), rollbackManifest);
  await writeFile(join(args.outDir, 'notion_baseline_import_preview.md'), buildPreviewMarkdown({ manifest, writePlanRows: dedupedWritePlanRows }), 'utf8');
  await writeFile(join(args.outDir, 'database_field_map.md'), buildFieldMapMarkdown(), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    out_dir: args.outDir,
    package_id: packageId,
    total_planned_pages: dedupedWritePlanRows.length,
    database_counts: manifest.database_counts,
    rollback_entries: rollbackManifest.total_entries,
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: safeText(error?.message, String(error || 'unknown error'))
  }, null, 2));
  process.exitCode = 1;
});
