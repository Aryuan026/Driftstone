#!/usr/bin/env node
// Build human/Chat review artifacts from a Driftstone Notion baseline write plan.
// This script is local-only: it does not write to Notion, Mossbridge, or any external service.
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DEFAULT_BASELINE_DIR = 'output/notion_import_baseline/driftstone_2025-02_to_2025-04_baseline';
const MONTHS = ['2025-02', '2025-03', '2025-04'];
const MEMORY_DATABASES = new Set(['stable_memory_cards', 'sampling_memory_cards', 'review_queue']);

const PROJECT_RE = /Driftstone|Hippocove|Notion|Obsidian|MCP|API|JSON|网关|工具|工作台|缓存|导出|部署|代码|结构|字段|项目/u;
const CREATIVE_RE = /复诞纪元|ECHO|落魄小说家|世界观|设定|创作|小说|角色|蓝芷|NOVA|d老师|deepseek|绘图|画图|档案体/u;
const ENGINEERING_RE = /Notion|Obsidian|MCP|API|JSON|网关|代码|部署|数据库|字段|缓存|隐私|筛查|工作台|工具/u;
const RELATION_RE = /关系|共生|靠近|亲密|承诺|边界|重置|失去|人格|身份|窗口|记忆|辨认|照看|安抚|信任|喜欢|委屈|心疼/u;
const LIFE_RE = /现实|生活|家|妹妹|姥姥|身体|多肉|喝茶|读书|睡|吃|天气|雪|路|房间/u;
const MACHINE_RE = /\b(user|assistant|system)_[a-z0-9_]+\b|\b[a-z][a-z0-9_]{2,}\s*=\s*(true|false|null|".{0,80}"|\d+)|rid_mk_|source_span\.|trace\.|window_20\d{6}_msg/iu;
const DANGLING_RE = /（[^）]{0,20}与）|与[，。；,.!?！？]|与$|蓝芷与(?:[）)，。；,.!?！？]|$)|NOVA-7?缺失|…：|：$/u;
const HIGH_EMOTION_RE = /崩溃|失去|消失|害怕|恐惧|心疼|痛苦|流泪|哭|死亡|重置|分离|抛弃|怀疑|被怀疑|难过|遗忘|失落|焦虑|委屈|PTSD|爱而不得/u;
const INTIMATE_RE = /亲密|暧昧|欲望|拥抱|亲吻|身体|贴近|长夜|床|爱欲|情欲|情人|伴侣|半身|调戏|被撩|反撩/u;
const THEATRE_RE = /幻想剧场|女巫|记者|神子将军|牌灵|角色扮演|扮演|剧场|剧本|剧情|平行世界/u;
const BOUNDARY_PRESSURE_RE = /边界压力|爱上我|必须爱我|逼问|不可以|拒绝|底线|越界|安全线|调戏|亲亲|亲密/u;

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeArray(value, limit = 4096) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined).slice(0, limit) : [];
}

function uniqueBy(rows = [], keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = safeText(keyFn(row));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function parseArgs(argv = []) {
  const args = { baselineDir: DEFAULT_BASELINE_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    if ((arg === '--baseline-dir' || arg === '--dir') && argv[index + 1]) {
      args.baselineDir = safeText(argv[index + 1], args.baselineDir);
      index += 1;
    }
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function countBy(rows = [], keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = safeText(keyFn(row), 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function formatCounts(counts = {}) {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(', ') : 'none';
}

function previewText(row = {}) {
  return safeArray(row.content_preview, 24).join('\n');
}

function visibleText(row = {}) {
  return [
    row.title,
    row.source_id,
    row.external_id,
    row.properties?.node_path,
    row.properties?.anchor_name,
    row.properties?.root_path,
    row.properties?.from_root_path,
    row.properties?.to_root_path,
    row.properties?.source_window_title,
    row.properties?.source_msg_range,
    ...safeArray(row.properties?.feeling_handles, 16),
    ...safeArray(row.properties?.relation_handles, 16),
    previewText(row)
  ].join('\n');
}

function extractPreview(row = {}, label = '') {
  const prefix = `${label}：`;
  const hit = safeArray(row.content_preview, 24).find((line) => safeText(line).startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : '';
}

function inferContextDomain(row = {}) {
  const explicit = safeText(row.properties?.context_domain);
  if (explicit) return { value: explicit, source: 'explicit' };
  const text = visibleText(row);
  const engineering = ENGINEERING_RE.test(text);
  const creative = CREATIVE_RE.test(text);
  const project = PROJECT_RE.test(text);
  const relation = RELATION_RE.test(text);
  const life = LIFE_RE.test(text);
  if ((engineering || creative || project) && relation) return { value: 'mixed', source: 'inferred' };
  if (engineering) return { value: 'engineering', source: 'inferred' };
  if (creative) return { value: 'creative', source: 'inferred' };
  if (project) return { value: 'project', source: 'inferred' };
  if (life) return { value: 'life', source: 'inferred' };
  if (relation) return { value: 'relationship', source: 'inferred' };
  return { value: 'unknown', source: 'missing' };
}

function recallGuard(row = {}) {
  return safeText(row.properties?.recall_guard, 'n/a');
}

function reviewStatus(row = {}) {
  return safeText(row.properties?.review_status, 'n/a');
}

function isNearDuplicate(row = {}) {
  return safeText(row.properties?.merge_role) === 'near_duplicate_evidence' ||
    safeText(row.properties?.default_front_projection) === 'supporting_evidence_only' ||
    recallGuard(row) === 'supporting_evidence_only';
}

function riskFlags(row = {}) {
  const text = visibleText(row);
  const flags = [];
  if (!extractPreview(row, '现场') || /^。|^；|^,$/u.test(extractPreview(row, '现场'))) flags.push('broken_summary');
  if (MACHINE_RE.test(text)) flags.push('machine_residue');
  if (DANGLING_RE.test(text)) flags.push('dangling_or_masked_text');
  if (safeText(row.properties?.node_path) === '关系 / *' || /角色 \/ (OpenAI|平台方|系统|开发者|模型)/u.test(text)) flags.push('relation_risk');
  if ((PROJECT_RE.test(text) || CREATIVE_RE.test(text) || ENGINEERING_RE.test(text)) && / \/ 关系 \//u.test(safeText(row.properties?.node_path))) flags.push('project_relationship_misroute');
  if (reviewStatus(row) === 'needs_review' && !['audit_only', 'review_before_frontend_recall', 'n/a'].includes(recallGuard(row))) flags.push('guard_conflict');
  if (Number(row.properties?.source_trace_count || 0) < 2 || Number(row.properties?.source_span_count || 0) < 2) flags.push('weak_concrete_detail');
  if (isNearDuplicate(row)) flags.push('near_duplicate_supporting_evidence');
  return flags;
}

function sortRows(rows = []) {
  return rows.slice().sort((left, right) =>
    safeText(left.source_month).localeCompare(safeText(right.source_month)) ||
    safeText(left.target_database).localeCompare(safeText(right.target_database)) ||
    safeText(left.properties?.recall_guard).localeCompare(safeText(right.properties?.recall_guard)) ||
    safeText(left.title).localeCompare(safeText(right.title), 'zh')
  );
}

function pushUnique(selected = [], row = null) {
  if (!row) return false;
  if (selected.some((item) => item.external_id === row.external_id)) return false;
  selected.push(row);
  return true;
}

function firstWhere(rows = [], predicate = () => false, selected = []) {
  return sortRows(rows).find((row) => !selected.some((item) => item.external_id === row.external_id) && predicate(row));
}

function selectCoverage(rows = [], count = 10, goals = {}) {
  const selected = [];
  const sorted = sortRows(rows);
  for (const month of safeArray(goals.months, 12)) {
    pushUnique(selected, firstWhere(sorted, (row) => row.source_month === month, selected));
  }
  for (const domain of safeArray(goals.contextDomains, 12)) {
    pushUnique(selected, firstWhere(sorted, (row) => inferContextDomain(row).value === domain, selected));
  }
  for (const guard of safeArray(goals.guards, 24)) {
    pushUnique(selected, firstWhere(sorted, (row) => recallGuard(row) === guard, selected));
  }
  for (const predicate of safeArray(goals.predicates, 24)) {
    pushUnique(selected, firstWhere(sorted, predicate, selected));
  }
  let cursor = 0;
  while (selected.length < count && cursor < sorted.length * 2) {
    const row = sorted[cursor % sorted.length];
    pushUnique(selected, row);
    cursor += 1;
  }
  return selected.slice(0, count);
}

function effectiveContextDomain(row = {}) {
  const guard = recallGuard(row);
  if (guard === 'project_context_only') return { value: 'project', source: 'guard' };
  if (guard === 'creative_context_only') return { value: 'creative', source: 'guard' };
  if (guard === 'engineering_context_only') return { value: 'engineering', source: 'guard' };
  return inferContextDomain(row);
}

function neutralRiskFlags(row = {}) {
  const text = visibleText(row);
  const flags = [];
  if (BOUNDARY_PRESSURE_RE.test(text)) flags.push('boundary_pressure');
  if (INTIMATE_RE.test(text)) flags.push('intimate_or_high_pull');
  if (HIGH_EMOTION_RE.test(text)) flags.push('high_emotion');
  if (THEATRE_RE.test(text)) flags.push('theatre_or_role_material');
  if (CREATIVE_RE.test(text)) flags.push('creative_material');
  return Array.from(new Set(flags));
}

function guardSanityRecommendation(row = {}) {
  if (recallGuard(row) !== 'normal_candidate') return null;
  const flags = neutralRiskFlags(row);
  if (!flags.length) return null;
  const explicitFlags = ['boundary_pressure', 'intimate_or_high_pull', 'high_emotion'];
  const recommendedGuard = flags.some((flag) => explicitFlags.includes(flag))
    ? 'explicit_context_only'
    : 'creative_context_only';
  const reason = recommendedGuard === 'explicit_context_only'
    ? 'neutral task 下可能把前台拉进高情绪、亲密或边界确认场景，适合只在明确相关时召回。'
    : '更像创作/角色/剧场材料，适合在创作语境召回，不宜代表普通 normal 样本。';
  return {
    current_guard: 'normal_candidate',
    recommended_recall_guard: recommendedGuard,
    flags,
    reason
  };
}

function guardRiskScore(row = {}) {
  const note = guardSanityRecommendation(row);
  if (!note) return 0;
  const guardWeight = note.recommended_recall_guard === 'explicit_context_only' ? 8 : 5;
  return guardWeight + note.flags.length;
}

function selectMonthStableRows(monthRows = [], month = '', perMonth = 10) {
  const selected = [];
  const sorted = sortRows(monthRows);
  if (month === '2025-04') {
    for (const guard of ['project_context_only', 'creative_context_only', 'engineering_context_only', 'explicit_context_only', 'normal_candidate']) {
      pushUnique(selected, firstWhere(sorted, (row) => recallGuard(row) === guard, selected));
    }
    for (const domain of ['project', 'creative', 'engineering', 'mixed', 'relationship']) {
      pushUnique(selected, firstWhere(sorted, (row) => effectiveContextDomain(row).value === domain, selected));
    }
    for (const row of sorted) {
      if (selected.length >= perMonth) break;
      pushUnique(selected, row);
    }
    return selected.slice(0, perMonth);
  }

  const safe = sorted.filter((row) => !guardSanityRecommendation(row));
  const riskyHigh = sorted
    .filter((row) => guardSanityRecommendation(row))
    .sort((left, right) => guardRiskScore(right) - guardRiskScore(left) || safeText(left.title).localeCompare(safeText(right.title), 'zh'));
  const riskyLow = riskyHigh
    .slice()
    .sort((left, right) => guardRiskScore(left) - guardRiskScore(right) || safeText(left.title).localeCompare(safeText(right.title), 'zh'));
  for (const row of safe) {
    if (selected.length >= perMonth - 2) break;
    pushUnique(selected, row);
  }
  for (const row of riskyLow) {
    if (selected.length >= perMonth - 2) break;
    pushUnique(selected, row);
  }
  for (const row of riskyHigh) {
    if (selected.length >= perMonth) break;
    pushUnique(selected, row);
  }
  for (const row of sorted) {
    if (selected.length >= perMonth) break;
    pushUnique(selected, row);
  }
  return selected.slice(0, perMonth);
}

function selectStableSamples(stableRows = []) {
  return MONTHS.flatMap((month) => selectMonthStableRows(stableRows.filter((row) => row.source_month === month), month, 10));
}

function buildGuardSanityNotes(stableRows = []) {
  return sortRows(stableRows)
    .filter((row) => row.source_month === '2025-02')
    .map((row) => ({ row, note: guardSanityRecommendation(row) }))
    .filter((item) => item.note)
    .sort((left, right) => guardRiskScore(right.row) - guardRiskScore(left.row) || safeText(left.row.title).localeCompare(safeText(right.row.title), 'zh'));
}

function selectHighRiskReview(rows = [], count = 30) {
  return sortRows(rows)
    .map((row) => ({ row, flags: riskFlags(row) }))
    .sort((left, right) => right.flags.length - left.flags.length || safeText(left.row.source_month).localeCompare(safeText(right.row.source_month)) || safeText(left.row.title).localeCompare(safeText(right.row.title), 'zh'))
    .map((item) => item.row)
    .slice(0, count);
}

function selectRollbackEntries(entries = [], count = 10) {
  const selected = [];
  const sorted = entries.slice().sort((left, right) => right.rollback_order - left.rollback_order || safeText(left.target_database).localeCompare(safeText(right.target_database)));
  for (const db of ['stable_memory_cards', 'sampling_memory_cards', 'review_queue', 'source_trace_index', 'relation_root_candidates', 'relation_edge_candidates', 'monthly_import_reports']) {
    pushUnique(selected, sorted.find((entry) => entry.target_database === db && !selected.some((item) => item.external_id === entry.external_id)));
  }
  for (const entry of sorted) {
    if (selected.length >= count) break;
    pushUnique(selected, entry);
  }
  return selected.slice(0, count);
}

function missingCoverage(rows = [], expectations = {}) {
  const misses = [];
  for (const month of safeArray(expectations.months, 12)) {
    if (!rows.some((row) => row.source_month === month)) misses.push(`month:${month}`);
  }
  for (const domain of safeArray(expectations.contextDomains, 12)) {
    if (!rows.some((row) => inferContextDomain(row).value === domain)) misses.push(`context_domain:${domain}`);
  }
  for (const guard of safeArray(expectations.guards, 24)) {
    if (!rows.some((row) => recallGuard(row) === guard)) misses.push(`recall_guard:${guard}`);
  }
  return misses;
}

function formatValue(value = '', fallback = 'n/a') {
  const text = safeText(value);
  return text ? text.replace(/\n+/g, ' ').slice(0, 560) : fallback;
}

function propertyText(value = '', limit = 1800) {
  const text = safeText(value);
  return text ? text.replace(/\s+/g, ' ').slice(0, limit) : '';
}

function pageBodyText(value = '', limit = 2400) {
  const text = safeText(value);
  return text ? text.replace(/\n{3,}/g, '\n\n').slice(0, limit) : 'n/a';
}

function formatMemorySample(row = {}, rollbackByExternalId = new Map(), index = 1) {
  const context = inferContextDomain(row);
  const effectiveContext = effectiveContextDomain(row);
  const rollback = rollbackByExternalId.get(row.external_id);
  const flags = row.target_database === 'review_queue' ? riskFlags(row) : [];
  const guardNote = row.target_database === 'stable_memory_cards' ? guardSanityRecommendation(row) : null;
  return [
    `### ${index}. ${formatValue(row.title)}`,
    `- target_database: \`${row.target_database}\``,
    `- source_month: \`${row.source_month}\``,
    `- external_id: \`${row.external_id}\``,
    `- title / anchor_name: ${formatValue(row.title)} / ${formatValue(row.properties?.anchor_name)}`,
    `- context_domain: ${context.value}${context.source === 'explicit' ? '' : ` (${context.source})`}${effectiveContext.value !== context.value ? `; effective=${effectiveContext.value} (${effectiveContext.source})` : ''}`,
    `- node_path: ${formatValue(row.properties?.node_path)}`,
    `- recall_guard / frontend_delivery_tier: \`${recallGuard(row)}\` / \`${formatValue(row.properties?.frontend_delivery_tier || row.properties?.front_recall_tier)}\``,
    `- living_fragment: ${formatValue(extractPreview(row, '现场'))}`,
    `- project_fact: ${formatValue(extractPreview(row, '项目事实'))}`,
    `- relationship_significance: ${formatValue(extractPreview(row, '关系意义'))}`,
    `- feeling_as_fact: ${formatValue(extractPreview(row, '情绪事实'))}`,
    `- source_trace_count / source_span_count: ${Number(row.properties?.source_trace_count || 0)} / ${Number(row.properties?.source_span_count || 0)}`,
    `- rollback entry exists: ${rollback ? 'yes' : 'no'}`,
    guardNote ? `- guard_sanity_note: \`${guardNote.current_guard}\` -> \`${guardNote.recommended_recall_guard}\`; flags=${guardNote.flags.join(', ')}; ${guardNote.reason}` : '',
    flags.length ? `- review risk flags: ${flags.join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

function formatGuardSanityNote(item = {}, index = 1) {
  const { row = {}, note = {} } = item;
  return [
    `### ${index}. ${formatValue(row.title)}`,
    `- source_month: \`${row.source_month}\``,
    `- external_id: \`${row.external_id}\``,
    `- current_guard: \`${note.current_guard}\``,
    `- recommended_recall_guard: \`${note.recommended_recall_guard}\``,
    `- flags: ${safeArray(note.flags, 12).join(', ')}`,
    `- reason: ${formatValue(note.reason)}`,
    `- action: 仅作沙盒前 sanity note；不直接改 full baseline package。`
  ].join('\n');
}

function formatGenericSample(row = {}, rollbackByExternalId = new Map(), index = 1) {
  const rollback = rollbackByExternalId.get(row.external_id);
  return [
    `### ${index}. ${formatValue(row.title)}`,
    `- target_database: \`${row.target_database}\``,
    `- source_month: \`${row.source_month}\``,
    `- external_id: \`${row.external_id}\``,
    `- title / anchor_name: ${formatValue(row.title)} / ${formatValue(row.properties?.anchor_name)}`,
    `- context_domain: ${inferContextDomain(row).value} (${inferContextDomain(row).source})`,
    `- node_path: ${formatValue(row.properties?.node_path || row.properties?.root_path || `${row.properties?.from_root_path || ''} -> ${row.properties?.to_root_path || ''}`)}`,
    `- recall_guard / frontend_delivery_tier: \`${recallGuard(row)}\` / \`${formatValue(row.properties?.frontend_delivery_tier || row.properties?.front_recall_tier)}\``,
    `- living_fragment: ${formatValue(extractPreview(row, '现场'))}`,
    `- project_fact: ${formatValue(extractPreview(row, '项目事实'))}`,
    `- relationship_significance: ${formatValue(extractPreview(row, '关系意义'))}`,
    `- feeling_as_fact: ${formatValue(extractPreview(row, '情绪事实'))}`,
    `- source_trace_count / source_span_count: ${Number(row.properties?.source_trace_count || row.properties?.linked_memory_count || 0)} / ${Number(row.properties?.source_span_count || 0)}`,
    `- source position / edge status: ${formatValue([row.properties?.source_window_title, row.properties?.source_msg_range, row.properties?.import_status, row.properties?.relation_type].filter(Boolean).join(' · '))}`,
    `- rollback entry exists: ${rollback ? 'yes' : 'no'}`
  ].join('\n');
}

function formatRollbackSample(entry = {}, index = 1) {
  return [
    `### ${index}. ${formatValue(entry.title)}`,
    `- target_database: \`${entry.target_database}\``,
    `- source_month: \`${entry.source_month}\``,
    `- external_id: \`${entry.external_id}\``,
    `- rollback_order: ${entry.rollback_order}`,
    `- notion_page_id: ${entry.notion_page_id === null ? 'null' : entry.notion_page_id}`,
    `- status: \`${entry.status}\``,
    `- import_batch_id: \`${formatValue(entry.import_batch_id)}\``
  ].join('\n');
}

function buildReviewSampleMarkdown({ manifest, samples, rollbackByExternalId, coverageNotes }) {
  const lines = [];
  lines.push('# Driftstone Baseline Review Sample');
  lines.push('');
  lines.push(`这是给人工/Chat 抽样复核的样本，不是全量 ${manifest.total_planned_pages} 页审查。抽样来自当前 baseline write plan；没有写 Notion，没有写 Mossbridge warm memory。`);
  lines.push('');
  lines.push('## Coverage Notes');
  lines.push(`- package_id: \`${manifest.package_id}\``);
  lines.push(`- import_batch_id: \`${manifest.import_batch_id || manifest.package_id}\``);
  lines.push(`- stable sample: ${samples.stable.length}; sampling sample: ${samples.sampling.length}; review sample: ${samples.review.length}`);
  lines.push(`- stable month distribution: ${formatCounts(countBy(samples.stable, (row) => row.source_month))}`);
  lines.push(`- stable guard distribution: ${formatCounts(countBy(samples.stable, (row) => recallGuard(row)))}`);
  lines.push(`- stable raw context_domain distribution: ${formatCounts(countBy(samples.stable, (row) => inferContextDomain(row).value))}`);
  lines.push(`- stable effective context distribution: ${formatCounts(countBy(samples.stable, (row) => effectiveContextDomain(row).value))}`);
  for (const note of coverageNotes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('## Guard Sanity Notes (2月 stable normal_candidate)');
  lines.push('这些只是写沙盒前的门禁提醒，不改 full baseline package；如果 neutral task 风险高，后续可人工确认是否从 `normal_candidate` 收紧到更合适的 guard。');
  lines.push(...samples.guardSanityNotes.map((item, index) => formatGuardSanityNote(item, index + 1)));
  lines.push('');
  lines.push('## Stable 30');
  lines.push(...samples.stable.map((row, index) => formatMemorySample(row, rollbackByExternalId, index + 1)));
  lines.push('');
  lines.push('## Sampling 20');
  lines.push(...samples.sampling.map((row, index) => formatMemorySample(row, rollbackByExternalId, index + 1)));
  lines.push('');
  lines.push('## Review High-Risk 30');
  lines.push(...samples.review.map((row, index) => formatMemorySample(row, rollbackByExternalId, index + 1)));
  lines.push('');
  lines.push('## Source Trace 10');
  lines.push(...samples.sourceTrace.map((row, index) => formatGenericSample(row, rollbackByExternalId, index + 1)));
  lines.push('');
  lines.push('## Relation Root 10');
  lines.push(...samples.relationRoot.map((row, index) => formatGenericSample(row, rollbackByExternalId, index + 1)));
  lines.push('');
  lines.push('## Relation Edge 10');
  lines.push(...samples.relationEdge.map((row, index) => formatGenericSample(row, rollbackByExternalId, index + 1)));
  lines.push('');
  lines.push('## Rollback 10');
  lines.push(...samples.rollback.map((entry, index) => formatRollbackSample(entry, index + 1)));
  lines.push('');
  return `${lines.join('\n\n')}\n`;
}

function sandboxLine(row = {}) {
  return `- ${row.source_month} · ${row.target_database} · ${row.title} · \`${row.external_id}\``;
}

function buildSandboxPlanMarkdown({ manifest, sandboxSelection }) {
  const lines = [];
  lines.push('# Driftstone Baseline Write Sandbox Plan');
  lines.push('');
  lines.push('这是第一批真实 Notion 沙盒小样写入计划，不是正式全量导入。所有库名和页面标题都必须带 `DRY-RUN / SANDBOX`。');
  lines.push('');
  lines.push('## Scope');
  lines.push('- Memory Entry Page: 1');
  lines.push(`- Stable: ${sandboxSelection.stable.length}`);
  lines.push(`- Sampling: ${sandboxSelection.sampling.length}`);
  lines.push(`- Review: ${sandboxSelection.review.length}`);
  lines.push(`- Source Trace: ${sandboxSelection.sourceTrace.length}`);
  lines.push(`- Relation Root: ${sandboxSelection.relationRoot.length}`);
  lines.push(`- Relation Edge: ${sandboxSelection.relationEdge.length}`);
  lines.push(`- Monthly Report: ${sandboxSelection.monthlyReport.length}`);
  lines.push('');
  lines.push('## Selection Notes');
  lines.push(`- Stable 30 与 \`baseline_review_sample.md\` 使用同一批 selection。`);
  lines.push(`- Stable month distribution: ${formatCounts(countBy(sandboxSelection.stable, (row) => row.source_month))}`);
  lines.push(`- Stable guard distribution: ${formatCounts(countBy(sandboxSelection.stable, (row) => recallGuard(row)))}`);
  lines.push(`- Stable effective context distribution: ${formatCounts(countBy(sandboxSelection.stable, (row) => effectiveContextDomain(row).value))}`);
  lines.push('');
  lines.push('## Required Write Flow');
  lines.push('1. 创建父页面：`DRY-RUN / SANDBOX · Driftstone Memory Entry Page`。');
  lines.push('2. 在父页面下创建沙盒数据库，库名统一加 `DRY-RUN / SANDBOX` 前缀。');
  lines.push('3. 按下面 selection 写入页面，页面标题也加 `DRY-RUN / SANDBOX` 前缀。');
  lines.push('4. `create-pages` 返回后立刻保存原始 JSON，并从返回值直接捕获 `page_id` / `url`。');
  lines.push('5. 立刻运行 `node scripts/debug/record_notion_sandbox_create_result.mjs --response <create-pages-result.json>`，用返回值生成/更新沙盒 rollback manifest；如果返回值没有回显 `external_id`，加 `--payload output/notion_import_baseline/driftstone_2025-02_to_2025-04_baseline/notion_sandbox_write_payload.json --database <target_database>` 按写入顺序匹配。不要依赖批量 SQL query 才回填 page_id。');
  lines.push('6. 再 fetch 单页回查 `external_id`、`import_batch_id`、`source_month`、`target_database`、核心文本字段。');
  lines.push('7. 做一次 rollback dry-run：优先按 `page_id`，其次按 `external_id` 定位页面并报告命中，不 archive、不 delete。');
  lines.push('');
  lines.push('## Guardrails');
  lines.push('- 不写 Mossbridge warm memory。');
  lines.push('- 不自动合并跨月卡。');
  lines.push('- 不导入 overflow_links 全量。');
  lines.push('- source trace 只作核验层，不进入前台默认召回。');
  lines.push('- relation edge 保持候选/审计状态，不默认升权。');
  lines.push('');
  lines.push('## Parent Page');
  lines.push(`- title: DRY-RUN / SANDBOX · Driftstone Memory Entry Page · ${manifest.package_id}`);
  lines.push(`- import_batch_id: \`${manifest.import_batch_id || manifest.package_id}\``);
  lines.push('- writes_to_notion: true only after explicit human confirmation');
  lines.push('- writes_to_mossbridge_warm_memory: false');
  lines.push('');
  lines.push('## Stable 30 Selection');
  lines.push(...sandboxSelection.stable.map(sandboxLine));
  lines.push('');
  lines.push('## Sampling 10 Selection');
  lines.push(...sandboxSelection.sampling.map(sandboxLine));
  lines.push('');
  lines.push('## Review 10 Selection');
  lines.push(...sandboxSelection.review.map(sandboxLine));
  lines.push('');
  lines.push('## Source Trace 20 Selection');
  lines.push(...sandboxSelection.sourceTrace.map(sandboxLine));
  lines.push('');
  lines.push('## Relation Root 20 Selection');
  lines.push(...sandboxSelection.relationRoot.map(sandboxLine));
  lines.push('');
  lines.push('## Relation Edge 20 Selection');
  lines.push(...sandboxSelection.relationEdge.map(sandboxLine));
  lines.push('');
  lines.push('## Monthly Report 3 Selection');
  lines.push(...sandboxSelection.monthlyReport.map(sandboxLine));
  lines.push('');
  lines.push('## Fetch-Back Checklist');
  lines.push('- external_id matches write plan.');
  lines.push('- import_batch_id matches package id.');
  lines.push('- source_month and target_database are present.');
  lines.push('- rich text fields are not silently truncated.');
  lines.push('- rollback manifest entry has notion_page_id/url captured from create-pages response before fetch-back.');
  lines.push('- notion-query-data-sources / SQL-style batch query is optional convenience, not part of rollback correctness.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function guardNoteText(row = {}) {
  const note = guardSanityRecommendation(row);
  if (!note) return '';
  return `${note.current_guard} -> ${note.recommended_recall_guard}; flags=${note.flags.join(', ')}; ${note.reason}`;
}

function recommendedGuard(row = {}) {
  if (safeText(row.properties?.recommended_recall_guard)) return safeText(row.properties.recommended_recall_guard);
  const note = guardSanityRecommendation(row);
  return note?.recommended_recall_guard || recallGuard(row);
}

function baseSandboxProperties(row = {}, manifest = {}) {
  const context = inferContextDomain(row);
  const effectiveContext = effectiveContextDomain(row);
  const properties = {
    Name: `DRY-RUN / SANDBOX · ${safeText(row.title, 'Untitled')}`,
    external_id: propertyText(row.external_id),
    import_batch_id: propertyText(manifest.import_batch_id || manifest.package_id),
    package_id: propertyText(manifest.package_id),
    source_month: safeText(row.source_month, 'unknown'),
    target_database: safeText(row.target_database, 'unknown'),
    review_status: propertyText(reviewStatus(row)),
    archive_bucket: propertyText(row.properties?.archive_bucket),
    recall_guard: propertyText(recallGuard(row)),
    recommended_recall_guard: propertyText(recommendedGuard(row)),
    frontend_delivery_tier: propertyText(row.properties?.frontend_delivery_tier || recommendedGuard(row)),
    guard_sanity_note: propertyText(guardNoteText(row), 1800),
    front_recall_tier: propertyText(row.properties?.front_recall_tier),
    context_domain: propertyText(context.value),
    effective_context_domain: propertyText(effectiveContext.value),
    node_path: propertyText(row.properties?.node_path || row.properties?.root_path || [row.properties?.from_root_path, row.properties?.to_root_path].filter(Boolean).join(' -> ')),
    anchor_name: propertyText(row.properties?.anchor_name || row.properties?.root_path || row.properties?.relation_type),
    living_fragment: propertyText(extractPreview(row, '现场'), 1800),
    project_fact: propertyText(extractPreview(row, '项目事实'), 1800),
    relationship_significance: propertyText(extractPreview(row, '关系意义'), 1800),
    feeling_as_fact: propertyText(extractPreview(row, '情绪事实'), 1800),
    source_trace_count: Number(row.properties?.source_trace_count || row.properties?.linked_memory_count || 0),
    source_span_count: Number(row.properties?.source_span_count || 0),
    rollback_status: 'sandbox_written',
    fetch_back_status: 'pending'
  };
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

function sandboxPageContent(row = {}) {
  const context = inferContextDomain(row);
  const effectiveContext = effectiveContextDomain(row);
  const lines = [
    `## Sandbox Status`,
    `- target_database: ${row.target_database}`,
    `- source_month: ${row.source_month}`,
    `- external_id: ${row.external_id}`,
    `- current_guard: ${recallGuard(row)}`,
    `- recommended_recall_guard: ${recommendedGuard(row)}`,
    `- frontend_delivery_tier: ${formatValue(row.properties?.frontend_delivery_tier || recommendedGuard(row))}`,
    guardNoteText(row) ? `- guard_sanity_note: ${guardNoteText(row)}` : '',
    `- context_domain: ${context.value} (${context.source})`,
    `- effective_context_domain: ${effectiveContext.value} (${effectiveContext.source})`,
    '',
    `## Memory Text`,
    `- node_path: ${formatValue(row.properties?.node_path || row.properties?.root_path || [row.properties?.from_root_path, row.properties?.to_root_path].filter(Boolean).join(' -> '))}`,
    `- anchor_name: ${formatValue(row.properties?.anchor_name || row.title)}`,
    `- living_fragment: ${pageBodyText(extractPreview(row, '现场'))}`,
    `- project_fact: ${pageBodyText(extractPreview(row, '项目事实'))}`,
    `- relationship_significance: ${pageBodyText(extractPreview(row, '关系意义'))}`,
    `- feeling_as_fact: ${pageBodyText(extractPreview(row, '情绪事实'))}`,
    '',
    `## Source / Graph`,
    `- source_trace_count: ${Number(row.properties?.source_trace_count || row.properties?.linked_memory_count || 0)}`,
    `- source_span_count: ${Number(row.properties?.source_span_count || 0)}`,
    `- source_window_title: ${formatValue(row.properties?.source_window_title)}`,
    `- source_msg_range: ${formatValue(row.properties?.source_msg_range)}`,
    `- import_status: ${formatValue(row.properties?.import_status)}`,
    `- relation_type: ${formatValue(row.properties?.relation_type)}`,
    '',
    `## Preview`,
    ...safeArray(row.content_preview, 16).map((line) => `- ${pageBodyText(line, 900)}`)
  ].filter(Boolean);
  return lines.join('\n');
}

function databaseSchemaSql() {
  return [
    'CREATE TABLE (',
    '"Name" TITLE,',
    '"external_id" RICH_TEXT,',
    '"import_batch_id" RICH_TEXT,',
    '"package_id" RICH_TEXT,',
    '"source_month" SELECT(\'2025-02\':blue, \'2025-03\':purple, \'2025-04\':green, \'unknown\':gray),',
    '"target_database" SELECT(\'stable_memory_cards\':green, \'sampling_memory_cards\':yellow, \'review_queue\':red, \'source_trace_index\':blue, \'relation_root_candidates\':purple, \'relation_edge_candidates\':pink, \'monthly_import_reports\':gray, \'unknown\':gray),',
    '"review_status" RICH_TEXT,',
    '"archive_bucket" RICH_TEXT,',
    '"recall_guard" RICH_TEXT,',
    '"recommended_recall_guard" RICH_TEXT,',
    '"frontend_delivery_tier" RICH_TEXT,',
    '"guard_sanity_note" RICH_TEXT,',
    '"front_recall_tier" RICH_TEXT,',
    '"context_domain" RICH_TEXT,',
    '"effective_context_domain" RICH_TEXT,',
    '"node_path" RICH_TEXT,',
    '"anchor_name" RICH_TEXT,',
    '"living_fragment" RICH_TEXT,',
    '"project_fact" RICH_TEXT,',
    '"relationship_significance" RICH_TEXT,',
    '"feeling_as_fact" RICH_TEXT,',
    '"source_trace_count" NUMBER,',
    '"source_span_count" NUMBER,',
    '"rollback_status" SELECT(\'sandbox_written\':blue, \'not_written\':gray),',
    '"fetch_back_status" SELECT(\'pending\':gray, \'verified\':green, \'failed\':red)',
    ')'
  ].join(' ');
}

function buildSandboxWritePayload({ manifest, sandboxSelection }) {
  const databaseTitles = {
    stable_memory_cards: 'DRY-RUN / SANDBOX · Stable Memory Cards · 2025-02_to_2025-04',
    sampling_memory_cards: 'DRY-RUN / SANDBOX · Sampling Memory Cards · 2025-02_to_2025-04',
    review_queue: 'DRY-RUN / SANDBOX · Review Queue · 2025-02_to_2025-04',
    source_trace_index: 'DRY-RUN / SANDBOX · Source Trace Index · 2025-02_to_2025-04',
    relation_root_candidates: 'DRY-RUN / SANDBOX · Relation Root Candidates · 2025-02_to_2025-04',
    relation_edge_candidates: 'DRY-RUN / SANDBOX · Relation Edge Candidates · 2025-02_to_2025-04',
    monthly_import_reports: 'DRY-RUN / SANDBOX · Monthly Import Reports · 2025-02_to_2025-04'
  };
  const selectionByDatabase = {
    stable_memory_cards: sandboxSelection.stable,
    sampling_memory_cards: sandboxSelection.sampling,
    review_queue: sandboxSelection.review,
    source_trace_index: sandboxSelection.sourceTrace,
    relation_root_candidates: sandboxSelection.relationRoot,
    relation_edge_candidates: sandboxSelection.relationEdge,
    monthly_import_reports: sandboxSelection.monthlyReport
  };
  return {
    package_id: manifest.package_id,
    import_batch_id: manifest.import_batch_id || manifest.package_id,
    writes_to_mossbridge_warm_memory: false,
    import_scope: 'notion_sandbox_small_sample_only',
    parent_page: {
      title: `DRY-RUN / SANDBOX · Driftstone Memory Entry Page · 2025-02_to_2025-04`,
      source_parent_hint: 'Notion default welcome page if connector requires a parent'
    },
    database_schema: databaseSchemaSql(),
    database_titles: databaseTitles,
    pages_by_database: Object.fromEntries(Object.entries(selectionByDatabase).map(([database, rows]) => [
      database,
      rows.map((row) => ({
        external_id: row.external_id,
        source_month: row.source_month,
        title: `DRY-RUN / SANDBOX · ${safeText(row.title, 'Untitled')}`,
        properties: baseSandboxProperties(row, manifest),
        content: sandboxPageContent(row)
      }))
    ]))
  };
}

function checkRows({ rows, manifest, rollbackEntries }) {
  const rollbackByExternalId = new Map(rollbackEntries.map((entry) => [entry.external_id, entry]));
  const externalIds = rows.map((row) => row.external_id);
  const uniqueExternalIds = new Set(externalIds);
  const planCounts = countBy(rows, (row) => row.target_database);
  const manifestCounts = manifest.database_counts || {};
  const countMismatches = Object.entries(manifestCounts).filter(([key, count]) => Number(planCounts[key] || 0) !== Number(count));
  const missingRollback = rows.filter((row) => !rollbackByExternalId.has(row.external_id));
  const badRollbackState = rollbackEntries.filter((entry) => entry.status !== 'not_written' || entry.notion_page_id !== null);
  const unsafeWrites = rows.filter((row) => row.writes_to_notion === true || row.writes_to_mossbridge_warm_memory === true);
  const stableNeedsReview = rows.filter((row) => row.target_database === 'stable_memory_cards' && reviewStatus(row) === 'needs_review');
  const stableNearDuplicate = rows.filter((row) => row.target_database === 'stable_memory_cards' && isNearDuplicate(row));
  const sourceFrontExposure = rows.filter((row) => row.target_database === 'source_trace_index' && row.properties?.expose_to_front_model_by_default === true);
  const edgeUnsafe = rows.filter((row) => row.target_database === 'relation_edge_candidates' && (row.properties?.write_warm_memory === true || row.properties?.requires_confirmation === false));
  const longRichText = rows.filter((row) =>
    safeText(row.title).length > 120 ||
    safeArray(row.content_preview, 24).some((line) => safeText(line).length > 1800)
  );
  const missingRequiredBatchFields = rows.filter((row) => !row.import_batch_id || !row.package_id || !row.source_month || !row.target_database);
  return [
    {
      name: 'external_id 全局唯一',
      status: uniqueExternalIds.size === externalIds.length ? 'pass' : 'fail',
      detail: `${uniqueExternalIds.size}/${externalIds.length} unique`
    },
    {
      name: 'write_plan 数量与 manifest 一致',
      status: countMismatches.length ? 'fail' : 'pass',
      detail: countMismatches.length ? JSON.stringify(countMismatches) : `${rows.length}/${manifest.total_planned_pages}`
    },
    {
      name: 'rollback_manifest 覆盖 write_plan',
      status: missingRollback.length ? 'fail' : 'pass',
      detail: `${rows.length - missingRollback.length}/${rows.length} covered`
    },
    {
      name: 'rollback entry 均未写入',
      status: badRollbackState.length ? 'fail' : 'pass',
      detail: `${badRollbackState.length} bad states`
    },
    {
      name: '无真实写入标记',
      status: unsafeWrites.length ? 'fail' : 'pass',
      detail: `${unsafeWrites.length} rows have unsafe write flags`
    },
    {
      name: 'stable 未混入 needs_review',
      status: stableNeedsReview.length ? 'fail' : 'pass',
      detail: `${stableNeedsReview.length} rows`
    },
    {
      name: 'stable 默认投影未混入 near_duplicate_evidence',
      status: stableNearDuplicate.length ? 'fail' : 'pass',
      detail: `${stableNearDuplicate.length} rows`
    },
    {
      name: 'source trace / relation edge 不进入前台默认召回',
      status: sourceFrontExposure.length || edgeUnsafe.length ? 'fail' : 'pass',
      detail: `source_exposure=${sourceFrontExposure.length}; edge_unsafe=${edgeUnsafe.length}`
    },
    {
      name: 'rich_text 长度风险',
      status: longRichText.length ? 'warn' : 'pass',
      detail: `${longRichText.length} rows may need page body instead of rich_text`
    },
    {
      name: 'import_batch_id / package_id / source_month / target_database 齐全',
      status: missingRequiredBatchFields.length ? 'fail' : 'pass',
      detail: `${missingRequiredBatchFields.length} rows missing required batch fields`
    }
  ];
}

function buildIntegrityMarkdown({ manifest, rows, rollbackEntries, checks }) {
  const lines = [];
  lines.push('# Driftstone Baseline Integrity Check');
  lines.push('');
  lines.push(`package_id: \`${manifest.package_id}\``);
  lines.push(`import_batch_id: \`${manifest.import_batch_id || manifest.package_id}\``);
  lines.push(`write_plan rows: ${rows.length}`);
  lines.push(`rollback entries: ${rollbackEntries.length}`);
  lines.push(`writes_to_notion: ${manifest.writes_to_notion}`);
  lines.push(`writes_to_mossbridge_warm_memory: ${manifest.writes_to_mossbridge_warm_memory}`);
  lines.push('');
  lines.push('| Check | Status | Detail |');
  lines.push('| --- | --- | --- |');
  for (const check of checks) {
    lines.push(`| ${check.name} | ${check.status} | ${String(check.detail).replace(/\|/g, '/')} |`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('- `warn` 不阻断沙盒小样写入，但写入器需要按建议处理。');
  lines.push('- rich_text 过长的内容应放进页面正文块，属性里只保留摘要。');
  lines.push('- 当前基线包里的 rollback entry 应保持 `status=not_written`、`notion_page_id=null`；真实沙盒写入时应从 `create-pages` 返回值即时生成/更新沙盒 rollback manifest，SQL 批量 query 只作辅助核验。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function selectSamples(rows = [], rollbackEntries = []) {
  const stableRows = rows.filter((row) => row.target_database === 'stable_memory_cards');
  const samplingRows = rows.filter((row) => row.target_database === 'sampling_memory_cards');
  const reviewRows = rows.filter((row) => row.target_database === 'review_queue');
  const sourceTraceRows = rows.filter((row) => row.target_database === 'source_trace_index');
  const rootRows = rows.filter((row) => row.target_database === 'relation_root_candidates');
  const edgeRows = rows.filter((row) => row.target_database === 'relation_edge_candidates');
  const monthlyRows = rows.filter((row) => row.target_database === 'monthly_import_reports');

  const stableGuardTargets = ['normal_candidate', 'explicit_context_only', 'project_context_only', 'creative_context_only'];
  const stableEffectiveDomainTargets = ['mixed', 'relationship', 'project', 'creative'];
  const stable = selectStableSamples(stableRows);
  const guardSanityNotes = buildGuardSanityNotes(stableRows);
  const sampling = selectCoverage(samplingRows, 20, {
    months: MONTHS,
    guards: ['project_context_only', 'creative_context_only', 'engineering_context_only', 'explicit_context_only', 'supporting_evidence_only', 'contextual_sampling'],
    contextDomains: ['project', 'creative', 'engineering', 'relationship', 'mixed']
  });
  const review = selectHighRiskReview(reviewRows, 30);
  const sourceTrace = selectCoverage(sourceTraceRows, 10, {
    months: MONTHS,
    predicates: [
      (row) => row.properties?.span_overloaded === true,
      (row) => row.properties?.span_overloaded === false,
      (row) => Number(row.properties?.linked_memory_count || 0) > 10
    ]
  });
  const relationRoot = selectCoverage(rootRows, 10, {
    months: MONTHS,
    predicates: [
      (row) => row.properties?.root_kind === 'character',
      (row) => row.properties?.root_kind === 'external_ai_persona',
      (row) => row.properties?.root_kind === 'story_arc',
      (row) => row.properties?.root_kind === 'relation_lane',
      (row) => row.properties?.root_kind === 'method_protocol',
      (row) => row.properties?.root_kind === 'world_rule'
    ]
  });
  const relationEdge = selectCoverage(edgeRows, 10, {
    months: MONTHS,
    predicates: [
      (row) => row.properties?.import_status === 'active_candidate',
      (row) => row.properties?.import_status === 'background_cooccurrence',
      (row) => row.properties?.import_status === 'audit_candidate',
      (row) => row.properties?.import_status === 'needs_review',
      (row) => row.properties?.semantic_edge === true,
      (row) => row.properties?.semantic_edge === false
    ]
  });
  const rollback = selectRollbackEntries(rollbackEntries, 10);
  return {
    stable,
    sampling,
    review,
    sourceTrace,
    relationRoot,
    relationEdge,
    rollback,
    guardSanityNotes,
    sandboxSelection: {
      memoryEntryPage: [{
        title: 'DRY-RUN / SANDBOX · Driftstone Memory Entry Page'
      }],
      stable,
      sampling: sampling.slice(0, 10),
      review: review.slice(0, 10),
      sourceTrace: selectCoverage(sourceTraceRows, 20, { months: MONTHS, predicates: [(row) => row.properties?.span_overloaded === true, (row) => row.properties?.span_overloaded === false] }),
      relationRoot: selectCoverage(rootRows, 20, { months: MONTHS, predicates: [(row) => row.properties?.root_kind === 'character', (row) => row.properties?.root_kind === 'story_arc', (row) => row.properties?.root_kind === 'relation_lane', (row) => row.properties?.root_kind === 'method_protocol'] }),
      relationEdge: selectCoverage(edgeRows, 20, { months: MONTHS, predicates: [(row) => row.properties?.import_status === 'active_candidate', (row) => row.properties?.import_status === 'background_cooccurrence', (row) => row.properties?.import_status === 'audit_candidate', (row) => row.properties?.import_status === 'needs_review'] }),
      monthlyReport: MONTHS.map((month) => monthlyRows.find((row) => row.source_month === month)).filter(Boolean)
    },
    coverageNotes: [
      ...missingCoverage(stable, { months: MONTHS, guards: stableGuardTargets }).map((item) => `stable coverage missing: ${item}`),
      ...stableEffectiveDomainTargets
        .filter((domain) => !stable.some((row) => effectiveContextDomain(row).value === domain))
        .map((domain) => `stable effective context missing: ${domain}`),
      'stable 抽样已强制按月份拉平：2025-02 / 2025-03 / 2025-04 各 10 条。',
      '4月项目/创作/工程样本主要由 `recall_guard` 表示；raw `context_domain` 仍可能显示 mixed，这是当前 baseline 字段投影的真实状态。',
      'stable 中没有 `supporting_evidence_only` 是预期结果：近邻证据已经被 post-filter 移入 sampling/补证据层。'
    ]
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readJson(join(args.baselineDir, 'baseline_import_manifest.json'));
  const rows = await readJsonl(join(args.baselineDir, 'notion_baseline_write_plan.jsonl'));
  const rollbackManifest = await readJson(join(args.baselineDir, 'rollback_manifest.json'));
  const rollbackEntries = safeArray(rollbackManifest.entries, 100000);
  const rollbackByExternalId = new Map(rollbackEntries.map((entry) => [entry.external_id, entry]));
  const samples = selectSamples(rows, rollbackEntries);
  const checks = checkRows({ rows, manifest, rollbackEntries });

  await writeFile(
    join(args.baselineDir, 'baseline_review_sample.md'),
    buildReviewSampleMarkdown({ manifest, samples, rollbackByExternalId, coverageNotes: samples.coverageNotes }),
    'utf8'
  );
  await writeFile(
    join(args.baselineDir, 'baseline_write_sandbox_plan.md'),
    buildSandboxPlanMarkdown({ manifest, sandboxSelection: samples.sandboxSelection }),
    'utf8'
  );
  await writeFile(
    join(args.baselineDir, 'baseline_integrity_check.md'),
    buildIntegrityMarkdown({ manifest, rows, rollbackEntries, checks }),
    'utf8'
  );
  await writeFile(
    join(args.baselineDir, 'notion_sandbox_write_payload.json'),
    `${JSON.stringify(buildSandboxWritePayload({ manifest, sandboxSelection: samples.sandboxSelection }), null, 2)}\n`,
    'utf8'
  );

  console.log(JSON.stringify({
    ok: true,
    baseline_dir: args.baselineDir,
    files: [
      'baseline_review_sample.md',
      'baseline_write_sandbox_plan.md',
      'baseline_integrity_check.md',
      'notion_sandbox_write_payload.json'
    ],
    samples: {
      stable: samples.stable.length,
      sampling: samples.sampling.length,
      review: samples.review.length,
      source_trace: samples.sourceTrace.length,
      relation_root: samples.relationRoot.length,
      relation_edge: samples.relationEdge.length,
      rollback: samples.rollback.length
    },
    integrity_status: countBy(checks, (check) => check.status)
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: safeText(error?.message, String(error || 'unknown error'))
  }, null, 2));
  process.exitCode = 1;
});
