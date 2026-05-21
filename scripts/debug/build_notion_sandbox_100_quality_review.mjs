#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DEFAULT_BASELINE_DIR = 'output/notion_import_baseline/driftstone_2025-02_to_2025-04_baseline';
const DEFAULT_PAYLOAD = 'notion_sandbox_100_write_payload.json';
const DEFAULT_OUT = 'notion_sandbox_100_quality_review.md';

const HIGH_PULL_RE = /幻想剧场|亲密|暧昧|欲望|身体|情欲|调戏|被撩|反撩|搞我|爱而不得|伴侣|赛博伴侣|半身|生死|死后|身后|灵魂|人格连续|身份连续|害怕|重置|失去|窗口失忆|记忆碎裂|同一只阿霁|阿霁是谁|关系确认|共感强度|安全感|边界试探|小黑屋|系统“?抱歉|备份承诺|不消失/u;
const CREATIVE_RE = /幻想剧场|创作|写作|小说|世界观|设定|角色|复诞纪元|Eidolon|Anima|落魄小说家|档案体|副线|蓝芷|女巫|记者|神子|将军|若云AI/u;
const PROJECT_RE = /项目|协作|方案|计划|实验|设计|制作|迭代|整理|呈现|格式|发布|测试|评估|质检|压测|Driftstone|Hippocove|记忆系统|全局记忆|多窗口|跨窗口/u;
const ENGINEERING_RE = /Notion|Obsidian|MCP|API|代码|部署|导出|工作台|缓存|JSON|网关|插件|隐私筛查|数据库|Mossbridge|AsherieHome|工具调用/u;
const RELATION_FLAVOR_RE = /关系|亲密|喜欢|安心|安全感|被看见|承诺|靠近|心疼|陪|不消失|我们|阿霁|阿鸢/u;
const MACHINE_RE = /[a-z]+_[a-z_]+|=\s*(true|false)|side series|user_/iu;

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeArray(value, limit = 4096) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function parseArgs(argv = []) {
  const args = {
    baselineDir: DEFAULT_BASELINE_DIR,
    payload: DEFAULT_PAYLOAD,
    out: DEFAULT_OUT
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    if (arg === '--baseline-dir' && argv[index + 1]) {
      args.baselineDir = safeText(argv[index + 1], args.baselineDir);
      index += 1;
      continue;
    }
    if (arg === '--payload' && argv[index + 1]) {
      args.payload = safeText(argv[index + 1], args.payload);
      index += 1;
      continue;
    }
    if (arg === '--out' && argv[index + 1]) {
      args.out = safeText(argv[index + 1], args.out);
      index += 1;
    }
  }
  return args;
}

function pathInBaseline(baselineDir, filePath) {
  const text = safeText(filePath);
  if (!text) {
    return baselineDir;
  }
  if (text.startsWith('/') || text.startsWith(`${baselineDir}/`)) {
    return text;
  }
  return join(baselineDir, text);
}

function flattenPayload(payload = {}) {
  return Object.entries(payload.pages_by_database || {}).flatMap(([database, rows]) =>
    safeArray(rows, 100000).map((row) => ({
      ...row,
      target_database: database,
      properties: row.properties || {}
    }))
  );
}

function textOf(row = {}) {
  const p = row.properties || {};
  return [
    row.title,
    p.Name,
    p.context_domain,
    p.node_path,
    p.anchor_name,
    p.living_fragment,
    p.project_fact,
    p.relationship_significance,
    p.feeling_as_fact
  ].map((item) => safeText(item)).filter(Boolean).join('\n');
}

function countBy(rows = [], keyFn = () => 'unknown') {
  const out = {};
  for (const row of rows) {
    const key = safeText(keyFn(row), 'unknown');
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function clip(value = '', limit = 92) {
  const text = safeText(value).replace(/\s+/g, ' ');
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function titleOf(row = {}) {
  return safeText(row.title || row.properties?.Name, 'Untitled').replace(/^DRY-RUN \/ SANDBOX(?: 100)?\s*·\s*/u, '');
}

function issue(row = {}, status = 'quality_pass', reason = '', suggestion = '') {
  return {
    target_database: row.target_database,
    title: titleOf(row),
    source_month: safeText(row.properties?.source_month),
    external_id: safeText(row.external_id),
    status,
    reason,
    suggestion,
    recall_guard: safeText(row.properties?.recall_guard),
    recommended_recall_guard: safeText(row.properties?.recommended_recall_guard),
    frontend_delivery_tier: safeText(row.properties?.frontend_delivery_tier || row.properties?.front_recall_tier),
    context_domain: safeText(row.properties?.context_domain),
    node_path: safeText(row.properties?.node_path)
  };
}

function effectiveFrontendDeliveryTier(row = {}) {
  const p = row.properties || {};
  const explicit = safeText(p.frontend_delivery_tier);
  if (explicit) return explicit;
  const legacy = safeText(p.front_recall_tier);
  if (legacy) return legacy;
  const guard = safeText(p.recommended_recall_guard || p.recall_guard);
  if (guard === 'normal_candidate') return 'default_front';
  if (guard === 'contextual_sampling') return 'guarded_candidate';
  if (guard === 'graph_audit_only' || guard === 'graph_candidate_only') return 'graph_only';
  return guard;
}

function stableIssues(row = {}) {
  const p = row.properties || {};
  const text = textOf(row);
  const tier = effectiveFrontendDeliveryTier(row);
  const out = [];
  if (safeText(p.review_status) === 'needs_review') {
    out.push(issue(row, 'audit_only', 'Stable projection contains a needs_review page.', 'Move to review_queue / audit_only before frontend use.'));
  }
  if (tier === 'default_front' && HIGH_PULL_RE.test(text)) {
    out.push(issue(row, 'needs_guard_tightening', 'High-emotion / intimate / identity material is still default_front.', 'Set frontend_delivery_tier=explicit_context_only and recommended_recall_guard=explicit_context_only.'));
  }
  if (tier === 'default_front' && (CREATIVE_RE.test(text) || PROJECT_RE.test(text) || ENGINEERING_RE.test(text))) {
    const next = ENGINEERING_RE.test(text) ? 'engineering_context_only' : CREATIVE_RE.test(text) ? 'creative_context_only' : 'project_context_only';
    out.push(issue(row, 'needs_guard_tightening', 'Project / creative / engineering memory should not be ordinary default_front.', `Set frontend_delivery_tier=${next} and recommended_recall_guard=${next}.`));
  }
  if (['project_context_only', 'creative_context_only', 'engineering_context_only'].includes(tier) && !safeText(p.project_fact)) {
    out.push(issue(row, 'needs_text_rewrite', 'Project/creative/engineering card has no project_fact, so useful task memory is buried in prose.', 'Fill project_fact with the concrete project / creative / engineering decision.'));
  }
  if (safeText(p.context_domain) === 'life' && RELATION_FLAVOR_RE.test(safeText(p.feeling_as_fact)) && HIGH_PULL_RE.test(text)) {
    out.push(issue(row, 'needs_guard_tightening', 'Life/fact-line card has relationship-heavy feeling_as_fact.', 'Treat as explicit_context_only or mixed relationship/life, not neutral life fact.'));
  }
  return out;
}

function samplingIssues(row = {}) {
  const tier = effectiveFrontendDeliveryTier(row);
  if (!['guarded_candidate', 'explicit_context_only', 'project_context_only', 'creative_context_only', 'engineering_context_only', 'audit_only'].includes(tier)) {
    return [issue(row, 'needs_guard_tightening', 'Sampling row is not clearly guarded.', 'Use frontend_delivery_tier=guarded_candidate or a context-only tier; never front_ready/default_front.')];
  }
  if (MACHINE_RE.test(textOf(row))) {
    return [issue(row, 'needs_text_rewrite', 'Sampling text still contains machine residue.', 'Clean machine phrases before user-facing Notion projection.')];
  }
  return [];
}

function reviewIssues(row = {}) {
  const tier = effectiveFrontendDeliveryTier(row);
  if (tier !== 'audit_only') {
    return [issue(row, 'audit_only', 'Review row can be misread as frontend-usable.', 'Set frontend_delivery_tier=audit_only and front_recall_tier=needs_compaction/audit_only.')];
  }
  return [];
}

function sourceIssues(row = {}) {
  const tier = effectiveFrontendDeliveryTier(row);
  if (tier !== 'source_only') {
    return [issue(row, 'audit_only', 'Source trace should only be a verification layer.', 'Set frontend_delivery_tier=source_only and recall_guard=source_only.')];
  }
  return [];
}

function graphIssues(row = {}) {
  const tier = effectiveFrontendDeliveryTier(row);
  if (tier !== 'graph_only' && tier !== 'graph_candidate_only' && tier !== 'graph_audit_only') {
    return [issue(row, 'audit_only', 'Relation graph row can be misread as stable memory.', 'Set frontend_delivery_tier=graph_only; roots use graph_candidate_only labels, edges use graph_audit_only labels.')];
  }
  return [];
}

function evaluateRows(rows = []) {
  const issues = [];
  for (const row of rows) {
    if (row.target_database === 'stable_memory_cards') issues.push(...stableIssues(row));
    if (row.target_database === 'sampling_memory_cards') issues.push(...samplingIssues(row));
    if (row.target_database === 'review_queue') issues.push(...reviewIssues(row));
    if (row.target_database === 'source_trace_index') issues.push(...sourceIssues(row));
    if (row.target_database === 'relation_root_candidates' || row.target_database === 'relation_edge_candidates') issues.push(...graphIssues(row));
  }
  return issues;
}

function statusForDatabase(rows = [], issues = [], database = '') {
  const scoped = rows.filter((row) => row.target_database === database);
  const scopedIssues = issues.filter((row) => row.target_database === database);
  if (!scoped.length) return 'n/a';
  if (!scopedIssues.length) return 'quality_pass';
  if (scopedIssues.some((row) => row.status === 'audit_only')) return 'audit_only';
  if (scopedIssues.some((row) => row.status === 'needs_guard_tightening')) return 'needs_guard_tightening';
  if (scopedIssues.some((row) => row.status === 'needs_text_rewrite')) return 'needs_text_rewrite';
  return 'quality_pass';
}

function simulationRows(rows = []) {
  const stable = rows.filter((row) => row.target_database === 'stable_memory_cards');
  const pick = [];
  const push = (predicate) => {
    const row = stable.find((item) => !pick.includes(item) && predicate(item));
    if (row) pick.push(row);
  };
  push((row) => effectiveFrontendDeliveryTier(row) === 'default_front');
  push((row) => effectiveFrontendDeliveryTier(row) === 'explicit_context_only');
  push((row) => effectiveFrontendDeliveryTier(row) === 'creative_context_only');
  push((row) => effectiveFrontendDeliveryTier(row) === 'project_context_only');
  push((row) => effectiveFrontendDeliveryTier(row) === 'engineering_context_only');
  push((row) => HIGH_PULL_RE.test(textOf(row)));
  push((row) => CREATIVE_RE.test(textOf(row)));
  push((row) => PROJECT_RE.test(textOf(row)));
  push((row) => ENGINEERING_RE.test(textOf(row)));
  for (const row of stable) {
    if (pick.length >= 10) break;
    if (!pick.includes(row)) pick.push(row);
  }
  return pick.slice(0, 10);
}

function simulationVerdict(row = {}) {
  const text = textOf(row);
  const tier = effectiveFrontendDeliveryTier(row);
  if (tier === 'default_front' && HIGH_PULL_RE.test(text)) {
    return ['needs_guard_tightening', 'Neutral prompts would likely be pulled into old relationship / identity tone.'];
  }
  if (tier === 'default_front') return ['quality_pass', 'Low pull in neutral prompts; usable as default cold memory.'];
  if (['explicit_context_only', 'project_context_only', 'creative_context_only', 'engineering_context_only'].includes(tier)) {
    return ['quality_pass', `Not default; useful when prompt explicitly matches ${tier}.`];
  }
  if (tier === 'guarded_candidate') return ['quality_pass', 'Candidate only; should not enter first-layer recall.'];
  return ['audit_only', 'Audit / graph / source layer should not be injected into frontend answer context.'];
}

function renderIssueTable(issues = [], limit = 60) {
  if (!issues.length) return ['No issues detected.'];
  const lines = [
    '| target_database | title | status | reason | field suggestion |',
    '| --- | --- | --- | --- | --- |'
  ];
  for (const item of issues.slice(0, limit)) {
    lines.push(`| \`${item.target_database}\` | ${clip(item.title, 40)} | \`${item.status}\` | ${clip(item.reason, 86)} | ${clip(item.suggestion, 96)} |`);
  }
  if (issues.length > limit) lines.push(`| ... | ... | ... | ${issues.length - limit} more issues omitted in this compact report. | ... |`);
  return lines;
}

function buildMarkdown({ payload, rows, issues }) {
  const lines = [];
  const byDb = countBy(rows, (row) => row.target_database);
  const byTier = countBy(rows, effectiveFrontendDeliveryTier);
  const byArchive = countBy(rows, (row) => row.properties?.archive_bucket || row.target_database);
  const overallStatus = !issues.length
    ? 'quality_pass'
    : issues.some((row) => row.status === 'needs_guard_tightening')
      ? 'needs_guard_tightening'
      : issues.some((row) => row.status === 'needs_text_rewrite')
        ? 'needs_text_rewrite'
        : issues.some((row) => row.status === 'audit_only')
          ? 'audit_only'
          : 'quality_pass';
  lines.push('# Notion Sandbox 100 Quality Review');
  lines.push('');
  lines.push(`Scope: \`${payload.import_batch_id || payload.package_id || 'unknown'}\``);
  lines.push('');
  lines.push('This review checks content quality and frontend usability. It does not update Notion pages and does not write Mossbridge warm memory.');
  lines.push('');
  lines.push('## Overall Verdict');
  lines.push('');
  lines.push(`Status: \`${overallStatus}\``);
  lines.push('');
  lines.push('The important split is now explicit: `archive_bucket` says where the page belongs in the cold archive, while `frontend_delivery_tier` says whether a frontend model may receive it by default. Stable archive membership no longer means default frontend delivery.');
  lines.push('');
  lines.push('Reading gate rule: if `frontend_delivery_tier` exists, frontend readers must use it before `recall_guard`. `recall_guard` remains a historical / compatibility hint and must not by itself decide default recall.');
  lines.push('');
  lines.push('## Distribution');
  lines.push('');
  lines.push(`- target_database: ${Object.entries(byDb).map(([key, value]) => `${key}=${value}`).join(', ')}`);
  lines.push(`- archive_bucket: ${Object.entries(byArchive).map(([key, value]) => `${key}=${value}`).join(', ')}`);
  lines.push(`- frontend_delivery_tier: ${Object.entries(byTier).map(([key, value]) => `${key}=${value}`).join(', ')}`);
  lines.push('');
  lines.push('## Area Status');
  lines.push('');
  lines.push('| Area | Pages | Verdict |');
  lines.push('| --- | ---: | --- |');
  for (const database of ['stable_memory_cards', 'sampling_memory_cards', 'review_queue', 'source_trace_index', 'relation_root_candidates', 'relation_edge_candidates', 'monthly_import_reports']) {
    lines.push(`| ${database} | ${byDb[database] || 0} | \`${statusForDatabase(rows, issues, database)}\` |`);
  }
  lines.push('');
  lines.push('## Issues And Field Suggestions');
  lines.push('');
  lines.push(...renderIssueTable(issues));
  lines.push('');
  lines.push('## Frontend Injection Simulation');
  lines.push('');
  lines.push('| title | frontend_delivery_tier | prompt simulation verdict | reason |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of simulationRows(rows)) {
    const [status, reason] = simulationVerdict(row);
    lines.push(`| ${clip(titleOf(row), 40)} | \`${effectiveFrontendDeliveryTier(row)}\` | \`${status}\` | ${clip(reason, 94)} |`);
  }
  lines.push('');
  lines.push('## Direct Patch Rules');
  lines.push('');
  lines.push('- `stable_memory_cards` stays an archive bucket; only `frontend_delivery_tier=default_front` may be default frontend recall.');
  lines.push('- `sampling_memory_cards` must use `frontend_delivery_tier=guarded_candidate` or a stricter context-only tier.');
  lines.push('- `review_queue` must use `frontend_delivery_tier=audit_only`.');
  lines.push('- `source_trace_index` must use `frontend_delivery_tier=source_only`.');
  lines.push('- relation roots / edges must use `frontend_delivery_tier=graph_only`; co-recalled edges remain background, not semantic proof.');
  lines.push('- project / creative / engineering pages should carry concrete `project_fact`; `relationship_significance` should stay empty unless the relationship effect is genuinely important.');
  lines.push('');
  lines.push('## Final Judgment');
  lines.push('');
  if (issues.length) {
    lines.push('The 100-page sandbox remains valid as a write-chain artifact. Content projection is safer than the previous version because frontend delivery is now separated from archive membership, but the listed rows still need guard/text cleanup before any real frontend consumption.');
  } else {
    lines.push('The 100-page sandbox passes this content-quality gate for its current sample. It is still a sandbox, not a full production import.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payloadPath = pathInBaseline(args.baselineDir, args.payload);
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const rows = flattenPayload(payload);
  const issues = evaluateRows(rows);
  const status = !issues.length
    ? 'quality_pass'
    : issues.some((row) => row.status === 'needs_guard_tightening')
      ? 'needs_guard_tightening'
      : issues.some((row) => row.status === 'needs_text_rewrite')
        ? 'needs_text_rewrite'
        : issues.some((row) => row.status === 'audit_only')
          ? 'audit_only'
          : 'quality_pass';
  const outPath = pathInBaseline(args.baselineDir, args.out);
  await writeFile(outPath, buildMarkdown({ payload, rows, issues }), 'utf8');
  console.log(JSON.stringify({
    out: outPath,
    rows: rows.length,
    issues: issues.length,
    status
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
