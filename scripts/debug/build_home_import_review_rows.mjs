#!/usr/bin/env node
// Build Driftstone -> Home import review artifacts.
// Local/read-only customs table only: no Home, Notion, warm, or cold writes.
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, rename, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';

const EXPECTED_REVIEWED_TOTAL = 16274;
const DEFAULT_OUT_DIR = 'output/home_import_review/driftstone_home_import_review_v0';
const DEFAULT_DROPBOX_DIR = '/Users/mac/Documents/Ajimem';
const DEFAULT_WORKBENCH_FILE = 'data/local_fixtures/stage_dropbox/01_workbench/memory-export-core_20250301_20250331_26p-workbench.json';
const DEFAULT_SOURCE_INDEX_FILE = 'data/local_fixtures/stage_dropbox/01_source_index/memory-export-core_20250301_20250331_26p-source-index.json';
const REVIEW_ROW_SCHEMA = 'driftstone_home_import_review_row_v0';
const SOURCE_SCHEMA = 'driftstone_home_import_source_diagnostic_v0';
const EPISODE_SCHEMA = 'driftstone_home_import_episode_review_v0';
const CANDIDATE_SCHEMA = 'driftstone_home_import_candidate_review_v0';
const REJECTED_SCHEMA = 'driftstone_home_import_rejected_row_v0';
const REQUIRED_SOURCE_FILES = [
  '23_asheriehome_memory_nodes.jsonl',
  '12_normalized_memory_candidates.jsonl',
  '24_source_trace_index.jsonl',
  '16_normalized_source_span_candidates.jsonl'
];

class InputFailure extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'InputFailure';
    this.kind = kind;
    this.details = details;
  }
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').replace(/\r/g, '').trim();
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

function firstText(...values) {
  for (const value of values) {
    const text = safeText(value);
    if (text) return text;
  }
  return '';
}

function monthFromText(value = '') {
  const text = safeText(value);
  const dashed = text.match(/(20\d{2})-(\d{2})/u);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/u);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function parseArgs(argv = []) {
  const args = {
    sourceDir: safeText(process.env.DRIFTSTONE_HOME_REVIEW_SOURCE_DIR),
    outDir: safeText(process.env.DRIFTSTONE_HOME_REVIEW_OUT_DIR, DEFAULT_OUT_DIR),
    dropboxDir: safeText(process.env.HIPPOCOVE_STAGE_DROPBOX, DEFAULT_DROPBOX_DIR),
    sourceClient: 'driftstone',
    workbenchFile: DEFAULT_WORKBENCH_FILE,
    sourceIndexFile: DEFAULT_SOURCE_INDEX_FILE,
    month: '',
    allowLegacyAjimemAll: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    const next = argv[index + 1];
    if (arg === '--source-dir' && next) {
      args.sourceDir = safeText(next, args.sourceDir);
      index += 1;
    } else if (arg === '--out' && next) {
      args.outDir = safeText(next, args.outDir);
      index += 1;
    } else if (arg === '--dropbox' && next) {
      args.dropboxDir = safeText(next, args.dropboxDir);
      index += 1;
    } else if (arg === '--source-client' && next) {
      args.sourceClient = safeText(next, args.sourceClient);
      index += 1;
    } else if (arg === '--workbench-file' && next) {
      args.workbenchFile = safeText(next, args.workbenchFile);
      index += 1;
    } else if (arg === '--source-index-file' && next) {
      args.sourceIndexFile = safeText(next, args.sourceIndexFile);
      index += 1;
    } else if (arg === '--month' && next) {
      args.month = safeText(next, args.month);
      index += 1;
    } else if (arg === '--allow-legacy-ajimem-all') {
      args.allowLegacyAjimemAll = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  let validationFailure = null;
  if (!args.sourceDir) {
    validationFailure = new InputFailure('input_missing', 'Missing required --source-dir. Refusing fake ajimem_all default.', {
      input: '--source-dir',
      reason: 'source_dir_must_be_explicit'
    });
  }
  const sourceBase = basename(resolve(args.sourceDir));
  const inferredMonth = monthFromText(sourceBase);
  if (!args.month && inferredMonth) args.month = inferredMonth;
  if (!validationFailure && !args.month) {
    validationFailure = new InputFailure('input_missing', 'Missing required --month for source bundle.', {
      input: '--month',
      source_dir: args.sourceDir,
      reason: 'month_must_be_explicit_when_source_dir_is_not_month_named'
    });
  }
  if (!validationFailure && sourceBase === 'ajimem_all' && !args.allowLegacyAjimemAll) {
    validationFailure = new InputFailure('input_ambiguous', '`ajimem_all` is a legacy March fixture name; pass --month and --allow-legacy-ajimem-all to use it explicitly.', {
      source_dir: args.sourceDir,
      month: args.month,
      reason: 'forbid_default_fake_full_bundle'
    });
  }
  args.validationFailure = validationFailure;
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/debug/build_home_import_review_rows.mjs --source-dir DIR --month YYYY-MM [--out DIR]

Builds local Driftstone -> Home review artifacts only.
No Home writes, Notion writes, cold-tree writes, warm-memory writes, or API calls.

The legacy output/notion_staging/ajimem_all fixture is not a real all-month
bundle. To use it for March compatibility checks, pass:
  --source-dir output/notion_staging/ajimem_all --month 2025-03 --allow-legacy-ajimem-all`);
}

function inputRejection(kind, details = {}) {
  return {
    schema: REJECTED_SCHEMA,
    rejection_kind: kind,
    import_policy_state: 'review_only',
    assimilation_status: 'not_sent',
    ...details
  };
}

async function readJsonRequired(filePath, label) {
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new InputFailure('input_missing', `Missing required JSON input: ${label}`, {
      input_file: label,
      input_path: filePath,
      cause: safeText(error?.message)
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new InputFailure('input_parse_error', `Invalid JSON input: ${label}`, {
      input_file: label,
      input_path: filePath,
      cause: safeText(error?.message)
    });
  }
}

async function readJsonlRequired(filePath, label) {
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new InputFailure('input_missing', `Missing required JSONL input: ${label}`, {
      input_file: label,
      input_path: filePath,
      cause: safeText(error?.message)
    });
  }
  const rows = [];
  const lines = raw.split(/\r?\n/u);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new InputFailure('input_parse_error', `Invalid JSONL input: ${label}:${lineNo + 1}`, {
        input_file: label,
        input_path: filePath,
        line: lineNo + 1,
        cause: safeText(error?.message)
      });
    }
  }
  return rows;
}

async function writeJsonl(filePath, rows = []) {
  const text = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await writeFile(filePath, text, 'utf8');
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath, text) {
  await writeFile(filePath, `${String(text || '').trimEnd()}\n`, 'utf8');
}

async function publishOutputDir(tempDir, outDir) {
  await mkdir(dirname(outDir), { recursive: true });
  const backupDir = `${outDir}.previous-${process.pid}-${Date.now()}`;
  let hadExisting = false;
  if (existsSync(outDir)) {
    hadExisting = true;
    await rename(outDir, backupDir);
  }
  try {
    await rename(tempDir, outDir);
    if (hadExisting) await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (hadExisting && existsSync(backupDir) && !existsSync(outDir)) {
      await rename(backupDir, outDir);
    }
    throw error;
  }
}

async function withTempOutput(outDir, writer) {
  const parent = dirname(resolve(outDir));
  await mkdir(parent, { recursive: true });
  const tempDir = await mkdtemp(join(parent, `.${basename(outDir)}.tmp-`));
  try {
    const result = await writer(tempDir);
    await publishOutputDir(tempDir, outDir);
    return result;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function countBy(rows = [], getter = (row) => row) {
  const out = {};
  for (const row of rows) {
    const key = safeText(typeof getter === 'function' ? getter(row) : row?.[getter], 'unknown');
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([left], [right]) => left.localeCompare(right)));
}

function asArrayFromObjectList(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (value && typeof value === 'object') {
    return Object.values(value).filter((item) => item && typeof item === 'object');
  }
  return [];
}

function sourceRefMessageId(refs = []) {
  for (const ref of safeArray(refs, 64)) {
    const text = safeText(ref);
    const match = text.match(/window_\d{8}_msg_[0-9,\-]+/u);
    if (match) return match[0];
  }
  return '';
}

function sourceFileFromRefs(refs = []) {
  return firstText(...safeArray(refs, 64).filter((ref) => /\.(csv|md|json|jsonl)$/iu.test(safeText(ref))));
}

function sourceQuoteKind(trace = {}) {
  if (safeText(trace.excerpt_text)) return 'excerpt_text';
  if (safeText(trace.excerpt_hint)) return 'excerpt_hint';
  return 'missing';
}

function parseQuoteRefs(value) {
  const text = safeText(value);
  if (!text) return [];
  return text
    .split(/\s*[；;]\s*/u)
    .map((item) => safeText(item))
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(user|char|assistant|other|system)\s*:\s*(.+)$/iu);
      return {
        role: match ? match[1].toLowerCase() : '',
        quote_text: match ? safeText(match[2]) : item,
        raw_quote_ref: item
      };
    })
    .filter((item) => safeText(item.quote_text));
}

function workbenchQuoteRecovery(workbenchRow = {}) {
  const quoteRefs = parseQuoteRefs(workbenchRow.quote_refs);
  if (!quoteRefs.length) {
    return {
      quote_text: '',
      role: '',
      quote_refs: [],
      quote_recovery_status: 'not_found',
      quote_recovery_source: '',
      quote_recovery_reason: 'workbench_row_has_no_quote_refs'
    };
  }
  const bounded = quoteRefs.slice(0, 3);
  return {
    quote_text: bounded.map((item) => item.raw_quote_ref || item.quote_text).join('；'),
    role: bounded.length === 1 ? bounded[0].role : 'multi',
    quote_refs: bounded,
    quote_recovery_status: 'recovered',
    quote_recovery_source: 'workbench.quote_refs',
    quote_recovery_reason: 'bounded_quote_refs_recovered_from_workbench'
  };
}

function scopedKey(month, kind, value) {
  const monthText = safeText(month);
  const valueText = safeText(value);
  return monthText && valueText ? `${monthText}::${kind}::${valueText}` : '';
}

function scopedWindowRangeKey(month, row = {}, recordId = '') {
  const windowId = firstText(row.source_window_id, row.source_window_title);
  const start = safeText(row.source_msg_start);
  const end = safeText(row.source_msg_end);
  const record = safeText(recordId || row.record_id || row.source_entry_id || row.memory_key || row.anchor_id);
  return month && windowId && start && end && record
    ? `${month}::window_range_record::${windowId}::${start}-${end}::${record}`
    : '';
}

function addLookup(lookup, ambiguous, key, row) {
  const text = safeText(key);
  if (!text || ambiguous.has(text)) return;
  if (lookup.has(text) && lookup.get(text) !== row) {
    lookup.delete(text);
    ambiguous.add(text);
    return;
  }
  lookup.set(text, row);
}

function buildScopedWorkbenchLookup(workbenchRows = [], defaultMonth = '') {
  const lookup = new Map();
  const ambiguous = new Set();
  for (const row of asArrayFromObjectList(workbenchRows)) {
    const month = firstText(monthFromText(row.time), monthFromText(row.source_file), defaultMonth);
    for (const key of [row.record_id, row.source_entry_id, row.memory_key, row.anchor_id]) {
      addLookup(lookup, ambiguous, scopedKey(month, 'record', key), row);
    }
    for (const key of [row.source_ref, row.source_md_ref]) {
      addLookup(lookup, ambiguous, scopedKey(month, 'source_ref', key), row);
    }
    addLookup(lookup, ambiguous, scopedWindowRangeKey(month, row), row);
  }
  return { lookup, ambiguous };
}

function buildScopedSourceIndexLookup(sourceIndex = {}, defaultMonth = '') {
  const anchors = asArrayFromObjectList(sourceIndex?.anchors);
  const lookup = new Map();
  const ambiguous = new Set();
  for (const row of anchors) {
    const month = firstText(monthFromText(row.source_ref), defaultMonth);
    for (const key of [row.record_id, row.memory_key, row.anchor_id]) {
      addLookup(lookup, ambiguous, scopedKey(month, 'record', key), row);
    }
    addLookup(lookup, ambiguous, scopedKey(month, 'source_ref', row.source_ref), row);
    addLookup(lookup, ambiguous, scopedWindowRangeKey(month, row), row);
  }
  return { lookup, ambiguous };
}

function lookupByScopedKeys(scopedLookup, keys = []) {
  for (const key of keys) {
    const text = safeText(key);
    if (text && scopedLookup.lookup.has(text)) return scopedLookup.lookup.get(text);
  }
  return {};
}

function sourceIndexSummary(sourceIndex = {}) {
  const anchors = asArrayFromObjectList(sourceIndex?.anchors);
  const topics = asArrayFromObjectList(sourceIndex?.source_topic_index);
  return {
    kind: safeText(sourceIndex?.kind),
    mode: safeText(sourceIndex?.mode),
    anchor_count: anchors.length,
    topic_count: topics.length,
    has_anchor_turns: anchors.some((row) => row.source_msg_start || row.source_msg_end),
    has_verbatim_quote_text: anchors.some((row) => safeText(row.quote_text || row.source_quote || row.text))
  };
}

function buildSourceDiagnosticFromTrace(trace = {}, span = {}, {
  sourceClient = 'driftstone',
  workbenchRow = {},
  sourceIndexAnchor = {}
} = {}) {
  const sourceRefs = uniqueStrings([
    ...safeArray(trace.source_refs, 64),
    ...safeArray(span.source_refs, 64),
    workbenchRow.source_ref,
    sourceIndexAnchor.source_ref
  ], 128);
  const recovered = workbenchQuoteRecovery(workbenchRow);
  const quote = firstText(recovered.quote_text, trace.excerpt_text, trace.excerpt_hint);
  const quoteKind = recovered.quote_text ? 'workbench_quote_refs' : sourceQuoteKind(trace);
  const messageId = sourceRefMessageId(sourceRefs);
  const recordId = firstText(
    workbenchRow.record_id,
    sourceIndexAnchor.record_id,
    trace.source_window_id,
    span.source_window_id,
    trace.source_bundle_id,
    span.source_bundle_id
  );
  const turnRange = firstText(
    trace.source_msg_range,
    span.source_msg_range,
    workbenchRow.source_msg_start && workbenchRow.source_msg_end ? `${workbenchRow.source_msg_start}-${workbenchRow.source_msg_end}` : '',
    sourceIndexAnchor.source_msg_start && sourceIndexAnchor.source_msg_end ? `${sourceIndexAnchor.source_msg_start}-${sourceIndexAnchor.source_msg_end}` : ''
  );
  const hasStableSource = Boolean(recordId || messageId || turnRange);
  const hasVerbatimQuote = ['excerpt_text', 'workbench_quote_refs'].includes(quoteKind) && Boolean(quote);
  const reliable = Boolean(hasStableSource && messageId && hasVerbatimQuote);
  let reason = 'reliable_verbatim_quote_with_stable_message_id';
  if (!quote) reason = 'missing_quote_text';
  else if (!hasVerbatimQuote) reason = 'excerpt_hint_is_not_verbatim_quote';
  else if (!messageId) reason = 'missing_message_or_record_id_equivalent';
  else if (!hasStableSource) reason = 'missing_stable_source_id';

  return {
    schema: SOURCE_SCHEMA,
    source_record_id: firstText(trace.trace_id, span.source_span_id),
    source_record_kind: trace.trace_id ? 'source_trace' : 'source_span',
    assimilation_status: 'not_sent',
    import_policy_state: 'review_only',
    promotion_status: 'evidence_only',
    source_client: sourceClient,
    source_trace_id: safeText(trace.trace_id),
    source_span_id: firstText(trace.canonical_source_span_id, span.source_span_id),
    parent_source_span_id: safeText(span.parent_source_span_id),
    source_window: firstText(trace.source_window_title, span.source_window_title),
    source_window_id: firstText(trace.source_window_id, span.source_window_id),
    source_file: firstText(sourceFileFromRefs(sourceRefs), workbenchRow.source_file),
    source_bundle_id: firstText(trace.source_bundle_id, span.source_bundle_id),
    turn_range: turnRange,
    stable_source_id: firstText(recordId, messageId),
    record_id_equivalent: recordId,
    message_id_equivalent: messageId,
    source_quote: quote,
    excerpt_text: safeText(trace.excerpt_text),
    excerpt_hint: safeText(trace.excerpt_hint),
    source_quote_kind: quoteKind,
    quote_recovery_status: recovered.quote_recovery_status,
    quote_recovery_source: recovered.quote_recovery_source,
    quote_recovery_reason: recovered.quote_recovery_reason,
    quote_refs: recovered.quote_refs,
    source_msg_start: safeText(workbenchRow.source_msg_start || sourceIndexAnchor.source_msg_start),
    source_msg_end: safeText(workbenchRow.source_msg_end || sourceIndexAnchor.source_msg_end),
    source_refs: sourceRefs,
    reliable_home_source_span: reliable,
    reliable_home_source_span_reason: reason,
    source_incomplete: !reliable,
    linked_memory_entry_ids: uniqueStrings([
      ...safeArray(trace.linked_memory_entry_ids, 4096),
      ...safeArray(span.linked_memory_entry_ids, 4096)
    ], 4096),
    linked_root_ids: uniqueStrings([
      ...safeArray(trace.linked_root_ids, 4096),
      ...safeArray(span.linked_root_ids, 4096)
    ], 4096),
    usage_policy: {
      evidence_only: true,
      expose_to_front_model_by_default: false,
      emits_home_organ_packet: false
    }
  };
}

function firstTraceForNode(node = {}, traceLookup = new Map()) {
  for (const traceId of safeArray(node.source_trace_ids, 64)) {
    const trace = traceLookup.get(safeText(traceId));
    if (trace) return trace;
  }
  return null;
}

function firstSpanForNode(node = {}, trace = {}, spanLookup = new Map()) {
  for (const spanId of safeArray(node.source_span_ids, 64)) {
    const span = spanLookup.get(safeText(spanId));
    if (span) return span;
  }
  const traceSpanId = safeText(trace.canonical_source_span_id);
  return traceSpanId ? spanLookup.get(traceSpanId) || null : null;
}

function laneSignals(node = {}, candidate = {}) {
  const text = [
    node.title,
    node.node_path,
    node.living_fragment,
    node.project_fact,
    node.relationship_significance,
    node.feeling_as_fact,
    node.recall_payload,
    node.human_summary,
    candidate.memory_type,
    candidate.memory_shape,
    candidate.recall_lane,
    candidate.raw_machine_fact,
    safeArray(candidate.facts, 8).join(' ')
  ].map((item) => safeText(item)).join('\n');
  return {
    relationship: /关系|亲密|共生|伴侣|灵魂|人格连续|身份连续|窗口重置|害怕(?:遗忘|忘记|消失)|边界|承诺|安抚|失去|陪伴/u.test(text),
    project: /项目|工程|代码|Notion|MCP|Driftstone|Hippocove|Mossbridge|Home|API|导出|投影|迁移|工作台|调试|服务器/u.test(text),
    creative: /创作|小说|世界观|角色|剧情|设定|复诞纪元|Eidolon|RP|故事|剧场/u.test(text),
    episode: /事件切片|scene_replay|第一次|那次|当时|场景|窗口|episode|event/u.test(text),
    warm_contract: /互动规则|互动契约|相处策略|不追问|边界策略|承接|回应方式|称呼|不要叫|备份承诺|下次/u.test(text),
    cold_fact: /stable_fact|fact_line|raw_machine_fact|SQL|事实|fact_key|fact_value|现实锚点/u.test(text),
    emotional: /难过|害怕|焦虑|委屈|心疼|失落|震撼|高情绪|炽热|亲密|爱而不得|痛|不安/u.test(text),
    case_progress: /stage|status|next_action|下一步|进度|方案|问题|解决|issue|solution|action_step|artifact/u.test(text),
    ongoing: /ongoing|进行中|未完成|待办|继续|跟进|active|blocked|paused|悬挂|开放线/u.test(text),
    preference: /偏好|喜欢|不喜欢|习惯|倾向|风格|审美|称呼偏好|写作偏好/u.test(text),
    observation: /观察|可能|暂时|最近|短期|推测|像是|倾向于|状态/u.test(text)
  };
}

function mixedLaneReasons(node = {}, candidate = {}) {
  const signals = laneSignals(node, candidate);
  const reasons = [];
  if (signals.relationship && (signals.project || signals.creative)) {
    reasons.push(signals.project ? 'relationship_plus_project' : 'relationship_plus_creative');
  }
  if (signals.episode && signals.warm_contract) reasons.push('episode_plus_warm_contract');
  if (signals.cold_fact && signals.emotional) reasons.push('cold_fact_plus_emotional_meaning');
  if (signals.case_progress && signals.ongoing) reasons.push('case_progress_plus_ongoing');
  if (signals.preference && signals.observation) reasons.push('user_preference_plus_one_off_observation');
  return uniqueStrings(reasons, 12);
}

function splitLanesForReasons(reasons = []) {
  const lanes = [];
  for (const reason of reasons) {
    if (reason === 'relationship_plus_project') lanes.push('cold_review_candidate', 'case_index');
    if (reason === 'relationship_plus_creative') lanes.push('cold_review_candidate', 'case_index');
    if (reason === 'episode_plus_warm_contract') lanes.push('episode_journal', 'interaction_contract');
    if (reason === 'cold_fact_plus_emotional_meaning') lanes.push('cold_review_candidate', 'episode_journal');
    if (reason === 'case_progress_plus_ongoing') lanes.push('case_index', 'ongoing_track');
    if (reason === 'user_preference_plus_one_off_observation') lanes.push('user_preference', 'observation_journal');
  }
  return uniqueStrings(lanes, 8);
}

function hasMixedSignals(node = {}, candidate = {}) {
  return mixedLaneReasons(node, candidate).length > 0;
}

function inferSceneType(node = {}, candidate = {}) {
  const text = [
    node.context_domain,
    node.node_kind,
    node.node_path,
    node.title,
    node.project_fact,
    node.relationship_significance,
    node.feeling_as_fact,
    candidate.recall_lane,
    candidate.memory_shape
  ].map((item) => safeText(item)).join('\n');
  if (/代码|工程|API|MCP|server|Notion|Home|Driftstone|Hippocove|Mossbridge|技术|调试/u.test(text)) return 'technical_decision';
  if (/项目|进度|方案|计划|导出|投影|迁移|工作台/u.test(text)) return 'project_progress';
  if (/创作|小说|世界观|角色|剧情|设定|复诞纪元|Eidolon/u.test(text)) return 'creative_collaboration';
  if (/关系确认|共生|伴侣|人格连续|窗口|重置|灵魂|身份/u.test(text)) return 'relationship_confirmation';
  if (/难过|害怕|焦虑|委屈|心疼|失落|安抚|承接/u.test(text)) return 'emotional_support';
  if (/事实|偏好|习惯|喜欢|不喜欢|规则/u.test(text)) return 'fact_update';
  return 'episode_or_memory_candidate';
}

function inferSingleHomeLane(node = {}, candidate = {}) {
  const text = [
    node.context_domain,
    node.node_kind,
    node.node_path,
    node.title,
    node.anchor_name,
    node.project_fact,
    node.relationship_significance,
    node.feeling_as_fact,
    node.living_fragment,
    candidate.memory_type,
    candidate.memory_shape,
    candidate.recall_lane,
    candidate.raw_machine_fact
  ].map((item) => safeText(item)).join('\n');
  const reviewStatus = safeText(node.quality?.review_status);
  if (!safeText(node.title || node.anchor_name || node.living_fragment) && reviewStatus === 'needs_review') return 'discard';
  if (/互动规则|互动契约|相处策略|不追问|边界|承接|回应方式|叫.*用户|主人|态度识别|备份承诺/u.test(text)) {
    return 'interaction_contract';
  }
  if (/决策风格|选择风格|判断方式|先结构|工作流|流程偏好|case_handling|复盘|收尾/u.test(text)) {
    return 'decision_style';
  }
  if (/偏好|喜欢|不喜欢|习惯|审美|称呼偏好|写作偏好|创作流程偏好/u.test(text)) {
    return 'user_preference';
  }
  if (/case_handling|处理风格|调试风格|协作边界/u.test(text)) return 'case_handling_style';
  if (/项目|工程|代码|Notion|MCP|Driftstone|Hippocove|Mossbridge|API|导出|投影|世界观|创作|小说|复诞纪元|Eidolon/u.test(text)) {
    return 'case_index';
  }
  if (/ongoing|进行中|下一步|待办|暂停|blocked|paused|继续|未完成/u.test(text)) return 'ongoing_track';
  if (/观察|暂时|最近|倾向|可能|心情|状态|短期/u.test(text)) return 'observation_journal';
  if (/事件|episode|场景|窗口|那次|第一次|当时|scene_replay|event/u.test(text)) return 'episode_journal';
  if (/stable_fact|fact_line|事实|SQL|raw_machine_fact/u.test(text)) return 'cold_review_candidate';
  if (/人格|身份|自我定义|关系|共生|灵魂|连续性|伴侣|亲密/u.test(text)) return 'cold_review_candidate';
  return 'episode_journal';
}

function inferHomeLane(node = {}, candidate = {}) {
  if (hasMixedSignals(node, candidate)) return 'mixed_split_required';
  return inferSingleHomeLane(node, candidate);
}

function inferPromotionStatus(homeLane, node = {}) {
  const reviewStatus = safeText(node.quality?.review_status);
  if (homeLane === 'discard') return 'discard';
  if (homeLane === 'mixed_split_required') return 'mixed_split_required';
  if (reviewStatus === 'needs_review') return 'needs_review';
  if (homeLane === 'case_index') return 'case_layer';
  if (homeLane === 'episode_journal') return 'episode_only';
  if (homeLane === 'observation_journal') return 'observation_candidate';
  if (homeLane === 'ongoing_track') return 'ongoing_candidate';
  return 'cold_candidate';
}

function targetHintForLane(homeLane) {
  const map = {
    warm_diary: 'home.warm_memory.reviewed_warm_diary',
    interaction_contract: 'home.warm_memory.interaction_contract_candidate',
    user_preference: 'home.warm_memory.user_preference_candidate',
    decision_style: 'home.warm_memory.decision_style_candidate',
    case_handling_style: 'home.warm_memory.case_handling_style_candidate',
    cold_fact: 'home.cold_tree.cold_fact_review',
    cold_review_candidate: 'home.cold_tree.cold_review_candidate',
    episode_journal: 'home.episode_journal.review_candidate',
    case_index: 'home.case_index.review_candidate',
    observation_journal: 'home.observation_journal.review_candidate',
    ongoing_track: 'home.ongoing_track.review_candidate',
    discard: 'home.discard.review_log',
    mixed_split_required: 'home.review.split_required'
  };
  return map[homeLane] || 'home.review.unmapped';
}

function inferEvidenceStrength(sourceDiagnostic = {}, node = {}) {
  if (sourceDiagnostic.reliable_home_source_span) return 'strong';
  if (safeText(sourceDiagnostic.source_quote)) return 'medium_source_incomplete';
  if (safeArray(node.source_trace_ids, 64).length || safeArray(node.source_refs, 64).length) return 'weak_trace_only';
  return 'weak_source_missing';
}

function inferDurabilityHint(homeLane, node = {}) {
  const reviewStatus = safeText(node.quality?.review_status);
  if (homeLane === 'discard') return 'not_durable';
  if (homeLane === 'observation_journal') return 'temporary_revisable';
  if (homeLane === 'episode_journal') return 'episodic';
  if (homeLane === 'case_index' || homeLane === 'ongoing_track') return 'project_scoped';
  if (reviewStatus === 'ready_for_cold_archive') return 'durable_candidate';
  return 'tentative';
}

function inferWriteRisk({ homeLane, node = {}, sourceDiagnostic = {} } = {}) {
  const text = [
    homeLane,
    node.title,
    node.node_path,
    node.living_fragment,
    node.relationship_significance,
    node.feeling_as_fact,
    node.quality?.frontend_delivery_tier,
    node.quality?.recall_guard
  ].map((item) => safeText(item)).join('\n');
  if (homeLane === 'mixed_split_required' || sourceDiagnostic.source_incomplete) return 'high';
  if (/explicit_context_only|亲密|幻想剧场|灵魂|人格连续|重置|害怕|伴侣|生死|身份|共生/u.test(text)) return 'high';
  if (homeLane === 'warm_diary' || homeLane === 'interaction_contract' || homeLane === 'cold_review_candidate') return 'medium';
  if (homeLane === 'case_index' || homeLane === 'ongoing_track') return 'medium';
  return 'low';
}

function inferImportPolicyState({ homeLane, node = {}, sourceDiagnostic = {} } = {}) {
  if (homeLane === 'discard') return 'review_only';
  if (homeLane === 'mixed_split_required') return 'review_only';
  if (safeText(node.quality?.review_status) === 'needs_review') return 'review_only';
  if (!sourceDiagnostic.reliable_home_source_span) return 'review_only';
  return 'candidate_ready';
}

function importReasonForRow({ homeLane, importPolicyState, sourceDiagnostic, node }) {
  const reasons = ['historical_bulk_no_direct_write'];
  if (homeLane === 'mixed_split_required') reasons.push('mixed_signals_require_split');
  if (safeText(node.quality?.review_status) === 'needs_review') reasons.push('needs_review_in_source_quality');
  if (sourceDiagnostic.source_incomplete) reasons.push(`source_incomplete:${sourceDiagnostic.reliable_home_source_span_reason}`);
  if (importPolicyState === 'candidate_ready') reasons.push('eligible_for_home_adapter_review_only');
  else reasons.push('kept_for_review_not_home_write');
  return reasons.join('; ');
}

function candidateClaimForNode(node = {}, candidate = {}) {
  return firstText(
    node.project_fact,
    node.relationship_significance,
    node.feeling_as_fact,
    node.living_fragment,
    candidate.raw_machine_fact,
    candidate.summary,
    node.human_summary,
    node.recall_payload
  );
}

function buildReviewRow({ node, candidate = {}, trace = {}, span = {}, sourceDiagnostic }) {
  const homeLane = inferHomeLane(node, candidate);
  const mixedReasons = mixedLaneReasons(node, candidate);
  const fallbackSingleLane = inferSingleHomeLane(node, candidate);
  const promotionStatus = inferPromotionStatus(homeLane, node);
  const importPolicyState = inferImportPolicyState({ homeLane, node, sourceDiagnostic });
  const writeRisk = inferWriteRisk({ homeLane, node, sourceDiagnostic });
  const rowId = `home_review.${safeText(node.node_id || node.source_entry_id || candidate.candidate_id)}`;
  return {
    schema: REVIEW_ROW_SCHEMA,
    review_row_id: rowId,
    source_entry_id: safeText(node.source_entry_id || candidate.source_entry_id),
    source_system: 'driftstone',
    source_bundle_role: safeText(node.source_bundle_role || candidate.source_bundle_role, 'old_history_cold_archive'),
    assimilation_status: 'not_sent',
    home_lane: homeLane,
    fallback_single_home_lane: fallbackSingleLane,
    mixed_lane_reasons: mixedReasons,
    suggested_split_lanes: splitLanesForReasons(mixedReasons),
    scene_type: inferSceneType(node, candidate),
    candidate_claim: candidateClaimForNode(node, candidate),
    evidence_strength: inferEvidenceStrength(sourceDiagnostic, node),
    durability_hint: inferDurabilityHint(homeLane, node),
    write_risk: writeRisk,
    promotion_status: promotionStatus,
    target_hint: targetHintForLane(homeLane),
    import_policy_state: importPolicyState,
    import_reason: importReasonForRow({ homeLane, importPolicyState, sourceDiagnostic, node }),
    source_trace_id: safeText(trace.trace_id),
    source_span_id: firstText(trace.canonical_source_span_id, span.source_span_id),
    source_quote: safeText(sourceDiagnostic.source_quote),
    excerpt_text: safeText(sourceDiagnostic.excerpt_text),
    quote_recovery_status: safeText(sourceDiagnostic.quote_recovery_status),
    quote_recovery_source: safeText(sourceDiagnostic.quote_recovery_source),
    quote_recovery_reason: safeText(sourceDiagnostic.quote_recovery_reason),
    turn_range: safeText(sourceDiagnostic.turn_range),
    source_window: safeText(sourceDiagnostic.source_window),
    source_file: safeText(sourceDiagnostic.source_file),
    reliable_home_source_span: Boolean(sourceDiagnostic.reliable_home_source_span),
    reliable_home_source_span_reason: safeText(sourceDiagnostic.reliable_home_source_span_reason),
    source_incomplete: Boolean(sourceDiagnostic.source_incomplete),
    source_diagnostic_id: safeText(sourceDiagnostic.source_record_id),
    review_status: safeText(node.quality?.review_status || candidate.quality?.review_status || candidate.import_status),
    archive_bucket: safeText(node.quality?.archive_bucket || node.notion_projection?.archive_bucket),
    frontend_delivery_tier: safeText(node.quality?.frontend_delivery_tier || node.quality?.front_recall_tier || node.notion_projection?.frontend_delivery_tier || node.recall_policy?.front_delivery_tier),
    recall_guard: safeText(node.quality?.recall_guard || node.recall_policy?.guard),
    context_domain: safeText(node.context_domain || node.quality?.context_domain),
    node_path: safeText(node.node_path),
    anchor_name: safeText(node.anchor_name),
    title: safeText(node.title || candidate.title || node.anchor_name),
    month_key: safeText(node.month_key || candidate.month_key),
    episode_key: safeText(node.episode_key),
    living_fragment: safeText(node.living_fragment),
    project_fact: safeText(node.project_fact),
    relationship_significance: safeText(node.relationship_significance),
    feeling_as_fact: safeText(node.feeling_as_fact),
    source_trace_ids: uniqueStrings(node.source_trace_ids, 128),
    source_span_ids: uniqueStrings(node.source_span_ids, 128),
    source_refs: uniqueStrings(node.source_refs || candidate.source_refs, 128),
    original_ids: {
      node_id: safeText(node.node_id),
      normalized_candidate_id: safeText(candidate.candidate_id),
      sync_hash: safeText(node.sync_hash || candidate.sync_keys?.sync_hash)
    },
    safety: {
      emits_home_organ_packet: false,
      writes_warm_memory: false,
      writes_cold_tree: false,
      writes_notion: false,
      calls_home_api: false,
      direct_write_allowed: false
    }
  };
}

function buildCandidateRow(row = {}) {
  return {
    schema: CANDIDATE_SCHEMA,
    candidate_review_id: row.review_row_id.replace(/^home_review\./u, 'home_candidate.'),
    review_row_id: row.review_row_id,
    assimilation_status: 'not_sent',
    home_lane: row.home_lane,
    import_policy_state: row.import_policy_state,
    promotion_status: row.promotion_status,
    target_hint: row.target_hint,
    candidate_claim: row.candidate_claim,
    write_risk: row.write_risk,
    evidence_strength: row.evidence_strength,
    reliable_home_source_span: row.reliable_home_source_span,
    source_incomplete: row.source_incomplete,
    source_trace_id: row.source_trace_id,
    source_span_id: row.source_span_id,
    title: row.title,
    month_key: row.month_key,
    context_domain: row.context_domain,
    note: 'Review candidate only; not a Home organ packet.'
  };
}

function buildEpisodes(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const episodeKey = safeText(row.episode_key, `episode_from_${row.month_key || 'unknown'}`);
    const existing = grouped.get(episodeKey) || {
      schema: EPISODE_SCHEMA,
      episode_review_id: `home_episode_review.${episodeKey}`,
      episode_key: episodeKey,
      assimilation_status: 'not_sent',
      import_policy_state: 'review_only',
      promotion_status: 'episode_review_only',
      source_months: [],
      scene_types: [],
      home_lanes: [],
      titles: [],
      review_row_ids: [],
      source_trace_ids: [],
      source_span_ids: [],
      source_incomplete_count: 0,
      reliable_source_count: 0,
      candidate_count: 0,
      emits_home_organ_packet: false
    };
    existing.source_months = uniqueStrings([...existing.source_months, row.month_key], 24);
    existing.scene_types = uniqueStrings([...existing.scene_types, row.scene_type], 24);
    existing.home_lanes = uniqueStrings([...existing.home_lanes, row.home_lane], 24);
    existing.titles = uniqueStrings([...existing.titles, row.title], 12);
    existing.review_row_ids = uniqueStrings([...existing.review_row_ids, row.review_row_id], 4096);
    existing.source_trace_ids = uniqueStrings([...existing.source_trace_ids, ...safeArray(row.source_trace_ids, 128)], 4096);
    existing.source_span_ids = uniqueStrings([...existing.source_span_ids, ...safeArray(row.source_span_ids, 128)], 4096);
    existing.source_incomplete_count += row.source_incomplete ? 1 : 0;
    existing.reliable_source_count += row.reliable_home_source_span ? 1 : 0;
    existing.candidate_count += 1;
    grouped.set(episodeKey, existing);
  }
  return Array.from(grouped.values()).map((episode) => ({
    ...episode,
    import_policy_state: episode.reliable_source_count > 0 ? 'candidate_ready' : 'review_only',
    source_reliability_summary: `${episode.reliable_source_count}/${episode.candidate_count} rows reliable`
  }));
}

function makeLookup(rows = [], keyGetter = (row) => row.id) {
  const lookup = new Map();
  for (const row of rows) {
    const key = safeText(keyGetter(row));
    if (key && !lookup.has(key)) lookup.set(key, row);
  }
  return lookup;
}

function scopedKeysForEntry(month, row = {}, values = []) {
  const keys = [];
  for (const value of values) keys.push(scopedKey(month, 'record', value));
  for (const value of safeArray(row.source_refs, 16)) keys.push(scopedKey(month, 'source_ref', value));
  return keys.filter(Boolean);
}

function workbenchKeysForNode(node = {}, candidate = {}, trace = {}, month = '') {
  return scopedKeysForEntry(month, trace, [
    node.source_entry_id,
    candidate.source_entry_id,
    node.original_ids?.node_id,
    node.node_id,
    ...safeArray(trace.linked_memory_entry_ids, 16)
  ]);
}

function sourceIndexKeysForNode(node = {}, candidate = {}, trace = {}, workbenchRow = {}, month = '') {
  return [
    ...scopedKeysForEntry(month, trace, [
      node.source_entry_id,
      candidate.source_entry_id,
      safeArray(trace.linked_memory_entry_ids, 8)[0]
    ]),
    scopedKey(month, 'source_ref', workbenchRow.source_ref),
    ...safeArray(trace.source_refs, 16).map((ref) => scopedKey(month, 'source_ref', ref))
  ].filter(Boolean);
}

function renderTable(counts = {}) {
  const entries = Object.entries(counts);
  if (!entries.length) return '| value | count |\n| --- | --- |\n| none | 0 |';
  return ['| value | count |', '| --- | --- |', ...entries.map(([key, value]) => `| ${key} | ${value} |`)].join('\n');
}

function sampleRows(rows = [], limit = 5) {
  return rows.slice(0, limit).map((row) => (
    `- ${row.review_row_id}: lane=${row.home_lane}, policy=${row.import_policy_state}, ` +
    `source=${row.reliable_home_source_span ? 'reliable' : `incomplete:${row.reliable_home_source_span_reason}`}`
  )).join('\n');
}

function renderSourceQuoteRecoveryReport({ args, rows, sources, sourceIndexMeta, workbenchRows }) {
  const quoteStatusCounts = countBy(sources, 'quote_recovery_status');
  const quoteKindCounts = countBy(sources, 'source_quote_kind');
  const reliabilityCounts = countBy(sources, (row) => row.reliable_home_source_span ? 'home_grade_reliable' : 'not_home_grade');
  const rowReliabilityCounts = countBy(rows, (row) => row.reliable_home_source_span ? 'home_grade_reliable' : 'not_home_grade');
  const recoveredRows = rows.filter((row) => row.reliable_home_source_span).slice(0, 8);
  const unrecoveredRows = rows.filter((row) => !row.reliable_home_source_span).slice(0, 8);
  return `# Source Quote Recovery Audit

Generated at: ${new Date().toISOString()}

## Where Original Text Lives

- Machine bundle: \`${args.sourceDir}\`
- Workbench fixture: \`${args.workbenchFile}\`
- Source index fixture: \`${args.sourceIndexFile}\`

Current finding:

- \`workbench.json\` contains extracted rows with \`record_id\`, \`source_ref\`, \`source_msg_start/end\`, and often bounded \`quote_refs\`.
- \`source_index.json\` contains anchors and topic ranges, useful for turn lookup, but does not itself carry full verbatim window text.
- \`source_trace_index\` often carries \`excerpt_hint\`, useful for audit but not treated as verbatim source text.

## Source Index Snapshot

- workbench rows: ${asArrayFromObjectList(workbenchRows).length}
- source index anchors: ${sourceIndexMeta.anchor_count}
- source index topics: ${sourceIndexMeta.topic_count}
- source index has anchor turns: ${sourceIndexMeta.has_anchor_turns}
- source index has verbatim quote text: ${sourceIndexMeta.has_verbatim_quote_text}

## Source Diagnostics Counts

### Quote Recovery Status

${renderTable(quoteStatusCounts)}

### Quote Kind

${renderTable(quoteKindCounts)}

### Source Diagnostic Reliability

${renderTable(reliabilityCounts)}

### Review Row Reliability

${renderTable(rowReliabilityCounts)}

## Rows With Bounded Review Evidence

${recoveredRows.map((row) => `- ${row.review_row_id}: ${row.source_window} ${row.turn_range} · ${row.source_trace_id}`).join('\n') || '- none'}

## Rows Still Blocked

${unrecoveredRows.map((row) => `- ${row.review_row_id}: reason=${row.reliable_home_source_span_reason} · source=${row.source_trace_id || row.source_span_id}`).join('\n') || '- none'}

## Missing Fields

- Full raw window text is not present in the current source trace/span files.
- Some source traces only have \`excerpt_hint\`, not bounded/verbatim \`excerpt_text\`.
- Some rows have ranges like \`483-588\`, but this exporter only proves the extracted bounded quote refs, not every turn in the range.
- Home-grade spans should eventually include \`quote_text\`, \`record_id\`, \`message_id\`, \`source_window\`, \`turn_range\`, and a stable text hash.
`;
}

function renderMixedLaneAuditReport({ rows }) {
  const mixedRows = rows.filter((row) => row.home_lane === 'mixed_split_required');
  const reasonCounts = countBy(mixedRows.flatMap((row) => row.mixed_lane_reasons || []));
  const splitLaneCounts = countBy(mixedRows.flatMap((row) => row.suggested_split_lanes || []));
  const samples = mixedRows.slice(0, 16);
  return `# Mixed-lane Splitting Audit

Generated at: ${new Date().toISOString()}

## Verdict

The classifier catches cross-lane signal pairs and marks them for splitting rather than silently choosing one lane.

## Mixed Counts

- mixed rows: ${mixedRows.length}

## Mixed Reasons

${renderTable(reasonCounts)}

## Suggested Split Lanes

${renderTable(splitLaneCounts)}

## Sample Before / After Rows

${samples.map((row) => `### ${row.review_row_id}

- before fallback lane: \`${row.fallback_single_home_lane}\`
- after audit lane: \`${row.home_lane}\`
- reasons: ${safeArray(row.mixed_lane_reasons, 8).join(', ')}
- suggested split lanes: ${safeArray(row.suggested_split_lanes, 8).join(', ')}
- source: ${row.reliable_home_source_span ? 'bounded review quote available' : `blocked: ${row.reliable_home_source_span_reason}`}
`).join('\n') || 'No mixed rows found.'}

## Proposed Split Rules

- relationship + project/creative: split into relationship/cold candidate and case/project candidate.
- episode + warm contract: keep the scene in episode_journal and extract the reusable rule into interaction_contract.
- cold fact + emotional meaning: keep the atomic claim in cold_review_candidate and move the emotional meaning to episode or guarded relationship candidate.
- case progress + ongoing: write the project event to case_index and the open thread to ongoing_track.
- user preference + one-off observation: keep durable preference separately from tentative observation.

No Home packets are emitted by this audit.
`;
}

function renderReport({ args, rows, sources, episodes, candidates, rejected, ledger, paths }) {
  const homeLaneCounts = countBy(rows, 'home_lane');
  const policyCounts = countBy(rows, 'import_policy_state');
  const sourceReliabilityCounts = countBy(rows, (row) => row.reliable_home_source_span ? 'reliable' : 'source_incomplete');
  const writeRiskCounts = countBy(rows, 'write_risk');
  const sourceReasonCounts = countBy(rows, 'reliable_home_source_span_reason');
  const quoteRecoveryCounts = countBy(rows, 'quote_recovery_status');
  const mixedCount = homeLaneCounts.mixed_split_required || 0;
  const directWriteCount = rows.filter((row) => row.import_policy_state === 'direct_write_allowed').length;
  return `# Driftstone -> Home Import Review Artifacts v0

Generated at: ${new Date().toISOString()}

Source dir: \`${args.sourceDir}\`

Source month: \`${args.month}\`

Output dir: \`${args.outDir}\`

## Safety

- Home API calls: none
- Notion writes: none
- Warm-memory writes: none
- Cold-tree writes: none
- Home organ packets emitted: none
- All review rows assimilation_status: \`not_sent\`
- Direct write rows: ${directWriteCount}

## Output Files

- \`${paths.reviewRows}\`
- \`${paths.sources}\`
- \`${paths.episodes}\`
- \`${paths.candidates}\`
- \`${paths.rejected}\`
- \`${paths.ledger}\`
- \`${paths.sourceQuoteRecoveryReport}\`
- \`${paths.mixedLaneAudit}\`
- \`${paths.report}\`

## Counts

- review rows: ${rows.length}
- source diagnostics: ${sources.length}
- episode review groups: ${episodes.length}
- candidate review rows: ${candidates.length}
- rejected/review-only rows: ${rejected.length}
- mixed split required: ${mixedCount}

## Counts by Home Lane

${renderTable(homeLaneCounts)}

## Counts by Import Policy State

${renderTable(policyCounts)}

## Counts by Source Reliability

${renderTable(sourceReliabilityCounts)}

## Counts by Source Reliability Reason

${renderTable(sourceReasonCounts)}

## Counts by Quote Recovery Status

${renderTable(quoteRecoveryCounts)}

## Counts by Write Risk

${renderTable(writeRiskCounts)}

## Conservation

- reviewed rows: ${ledger.reviewed_rows}
- expected reviewed rows: ${ledger.expected_reviewed_rows}
- empty record_id rows: ${ledger.empty_record_id_rows}
- conservation passed: ${ledger.conservation_passed}

## Sample Rows

${sampleRows(rows, 8) || 'No rows generated.'}

## Concrete Blockers

- Rows with \`source_incomplete=true\` cannot become Home reliable source spans yet.
- \`excerpt_hint\` is treated as a diagnostic hint, not a verbatim quote.
- \`mixed_split_required\` rows must be split before any Home lane adapter can use them.
- Historical bulk rows remain \`review_only\` or \`candidate_ready\`; none are direct writes.

## Next Gate

Review this artifact with Chat/human control room. The smallest safe patch after review is a Home adapter dry-run that validates these rows against Home schemas without writing Home organs.
`;
}

function validateRows(rows = []) {
  const missing = [];
  for (const row of rows) {
    for (const key of [
      'assimilation_status',
      'home_lane',
      'scene_type',
      'candidate_claim',
      'evidence_strength',
      'durability_hint',
      'write_risk',
      'promotion_status',
      'target_hint',
      'import_policy_state',
      'import_reason'
    ]) {
      if (!safeText(row[key]) && typeof row[key] !== 'boolean') missing.push(`${row.review_row_id}:${key}`);
    }
    if (row.assimilation_status !== 'not_sent') {
      throw new Error(`Invalid assimilation_status for ${row.review_row_id}: ${row.assimilation_status}`);
    }
    if (row.import_policy_state === 'direct_write_allowed') {
      throw new Error(`Direct write is forbidden in v0: ${row.review_row_id}`);
    }
    if (row.home_lane === 'mixed_split_required' && row.promotion_status !== 'mixed_split_required') {
      throw new Error(`Mixed row not visibly marked: ${row.review_row_id}`);
    }
  }
  if (missing.length) {
    throw new Error(`Missing required review row fields:\n${missing.slice(0, 50).join('\n')}`);
  }
}

async function buildConservationLedger(args) {
  process.env.HIPPOCOVE_STAGE_DROPBOX = args.dropboxDir;
  const { loadReviewedDataset } = await import('../../server/core/reviewed-store.js');
  const dataset = await loadReviewedDataset({});
  const months = dataset.months.map((month) => {
    const emptyRecordIdRows = month.rows.filter((row) => !safeText(row.record_id)).length;
    return {
      month_key: month.month_key,
      file: month.file,
      rows: month.rows.length,
      empty_record_id_rows: emptyRecordIdRows
    };
  });
  const totalRows = dataset.rows.length;
  const emptyRecordIdRows = dataset.rows.filter((row) => !safeText(row.record_id)).length;
  return {
    schema: 'driftstone_home_import_conservation_ledger_v0',
    source_dir: args.sourceDir,
    source_month: args.month,
    dropbox_dir: args.dropboxDir,
    expected_reviewed_rows: EXPECTED_REVIEWED_TOTAL,
    reviewed_rows: totalRows,
    empty_record_id_rows: emptyRecordIdRows,
    conservation_passed: totalRows === EXPECTED_REVIEWED_TOTAL && emptyRecordIdRows === 0,
    months
  };
}

async function safeConservationLedger(args, error) {
  try {
    return await buildConservationLedger(args);
  } catch (ledgerError) {
    return {
      schema: 'driftstone_home_import_conservation_ledger_v0',
      source_dir: args.sourceDir,
      source_month: args.month,
      dropbox_dir: args.dropboxDir,
      expected_reviewed_rows: EXPECTED_REVIEWED_TOTAL,
      reviewed_rows: 0,
      empty_record_id_rows: null,
      conservation_passed: false,
      ledger_error: safeText(ledgerError?.message),
      input_error: safeText(error?.message),
      diagnostics: ledgerError?.diagnostics || ledgerError?.details || null
    };
  }
}

async function writeFailClosed(args, error, ledger) {
  const kind = error?.kind || (error?.name === 'CsvParseError' ? 'csv_parse_error' : 'input_failure');
  const rejected = [inputRejection(kind, {
    message: safeText(error?.message, String(error || 'unknown error')),
    ...(error?.details || {}),
    diagnostics: error?.diagnostics || error?.details?.diagnostics || null
  })];
  if (kind !== 'conservation_failed' && ledger && ledger.conservation_passed === false) {
    rejected.push(inputRejection('conservation_failed', {
      reviewed_rows: ledger.reviewed_rows,
      expected_reviewed_rows: ledger.expected_reviewed_rows,
      empty_record_id_rows: ledger.empty_record_id_rows,
      diagnostics: ledger.diagnostics || null
    }));
  }
  await withTempOutput(args.outDir, async (tempDir) => {
    await writeJsonl(join(tempDir, 'home_import_review_rows.jsonl'), []);
    await writeJsonl(join(tempDir, 'home_import_sources.jsonl'), []);
    await writeJsonl(join(tempDir, 'home_import_episodes.jsonl'), []);
    await writeJsonl(join(tempDir, 'home_import_candidates.jsonl'), []);
    await writeJsonl(join(tempDir, 'home_import_rejected.jsonl'), rejected);
    await writeJson(join(tempDir, 'home_import_conservation_ledger.json'), ledger);
    await writeText(join(tempDir, 'home_import_sample_report.md'), `# Driftstone -> Home Import Review Artifacts v0

Status: fail-closed

No Home, Notion, warm-memory, or cold-tree write was attempted.

Rejected rows: ${rejected.length}

Primary rejection: ${kind}

Conservation passed: ${ledger.conservation_passed}

Failure artifacts replaced any previous output directory so old success rows cannot masquerade as this run.`);
  });
  return { rejected, ledger };
}

function rejectedFromRow(row) {
  if (row.import_policy_state === 'candidate_ready') return null;
  return {
    schema: REJECTED_SCHEMA,
    review_row_id: row.review_row_id,
    source_entry_id: row.source_entry_id,
    home_lane: row.home_lane,
    import_policy_state: row.import_policy_state,
    rejection_reasons: row.import_reason.split(';').map((item) => item.trim()).filter(Boolean),
    source_incomplete: row.source_incomplete,
    reliable_home_source_span: row.reliable_home_source_span,
    assimilation_status: 'not_sent'
  };
}

async function buildArtifacts(args) {
  const requiredPaths = REQUIRED_SOURCE_FILES.map((file) => ({ file, path: join(args.sourceDir, file) }));
  for (const item of requiredPaths) {
    if (!existsSync(item.path)) {
      throw new InputFailure('input_missing', `Missing required source file: ${item.file}`, {
        input_file: item.file,
        input_path: item.path
      });
    }
  }
  const conservationLedger = await buildConservationLedger(args);
  if (!conservationLedger.conservation_passed) {
    throw new InputFailure('conservation_failed', 'Reviewed CSV conservation failed', {
      reviewed_rows: conservationLedger.reviewed_rows,
      expected_reviewed_rows: conservationLedger.expected_reviewed_rows,
      empty_record_id_rows: conservationLedger.empty_record_id_rows
    });
  }

  const [nodes, normalizedCandidates, sourceTraces, sourceSpans, workbenchData, sourceIndexData] = await Promise.all([
    readJsonlRequired(join(args.sourceDir, '23_asheriehome_memory_nodes.jsonl'), '23_asheriehome_memory_nodes.jsonl'),
    readJsonlRequired(join(args.sourceDir, '12_normalized_memory_candidates.jsonl'), '12_normalized_memory_candidates.jsonl'),
    readJsonlRequired(join(args.sourceDir, '24_source_trace_index.jsonl'), '24_source_trace_index.jsonl'),
    readJsonlRequired(join(args.sourceDir, '16_normalized_source_span_candidates.jsonl'), '16_normalized_source_span_candidates.jsonl'),
    readJsonRequired(args.workbenchFile, 'workbench.json'),
    readJsonRequired(args.sourceIndexFile, 'source_index.json')
  ]);
  if (!nodes.length) {
    throw new InputFailure('input_empty', `No asheriehome memory nodes found in ${args.sourceDir}`, {
      input_file: '23_asheriehome_memory_nodes.jsonl',
      input_path: join(args.sourceDir, '23_asheriehome_memory_nodes.jsonl')
    });
  }

  const candidateLookup = makeLookup(normalizedCandidates, (row) => row.source_entry_id);
  const traceLookup = makeLookup(sourceTraces, (row) => row.trace_id);
  const spanLookup = makeLookup(sourceSpans, (row) => row.source_span_id);
  const workbenchRows = asArrayFromObjectList(workbenchData);
  const workbenchLookup = buildScopedWorkbenchLookup(workbenchRows, args.month);
  const sourceIndexLookup = buildScopedSourceIndexLookup(sourceIndexData || {}, args.month);
  const sourceIndexMeta = sourceIndexSummary(sourceIndexData || {});
  const sourcesById = new Map();
  const rows = [];

  for (const node of nodes) {
    const month = firstText(node.month_key, args.month);
    const candidate = candidateLookup.get(safeText(node.source_entry_id)) || {};
    const trace = firstTraceForNode(node, traceLookup) || {};
    const span = firstSpanForNode(node, trace, spanLookup) || {};
    const workbenchRow = lookupByScopedKeys(workbenchLookup, workbenchKeysForNode(node, candidate, trace, month));
    const sourceIndexAnchor = lookupByScopedKeys(sourceIndexLookup, sourceIndexKeysForNode(node, candidate, trace, workbenchRow, month));
    const sourceDiagnostic = buildSourceDiagnosticFromTrace(trace, span, {
      sourceClient: args.sourceClient,
      workbenchRow,
      sourceIndexAnchor
    });
    if (sourceDiagnostic.source_record_id && !sourcesById.has(sourceDiagnostic.source_record_id)) {
      sourcesById.set(sourceDiagnostic.source_record_id, sourceDiagnostic);
    }
    rows.push(buildReviewRow({ node, candidate, trace, span, sourceDiagnostic }));
  }

  for (const trace of sourceTraces) {
    const month = firstText(monthFromText(trace.source_refs?.[0]), args.month);
    const span = spanLookup.get(safeText(trace.canonical_source_span_id)) || {};
    const workbenchRow = lookupByScopedKeys(workbenchLookup, scopedKeysForEntry(month, trace, safeArray(trace.linked_memory_entry_ids, 16)));
    const sourceIndexAnchor = lookupByScopedKeys(sourceIndexLookup, [
      ...safeArray(trace.source_refs, 16).map((ref) => scopedKey(month, 'source_ref', ref)),
      ...scopedKeysForEntry(month, trace, safeArray(trace.linked_memory_entry_ids, 16))
    ]);
    const diagnostic = buildSourceDiagnosticFromTrace(trace, span, {
      sourceClient: args.sourceClient,
      workbenchRow,
      sourceIndexAnchor
    });
    if (diagnostic.source_record_id && !sourcesById.has(diagnostic.source_record_id)) {
      sourcesById.set(diagnostic.source_record_id, diagnostic);
    }
  }

  for (const span of sourceSpans) {
    const month = firstText(monthFromText(span.source_refs?.[0]), args.month);
    const workbenchRow = lookupByScopedKeys(workbenchLookup, scopedKeysForEntry(month, span, safeArray(span.linked_memory_entry_ids, 16)));
    const sourceIndexAnchor = lookupByScopedKeys(sourceIndexLookup, [
      ...safeArray(span.source_refs, 16).map((ref) => scopedKey(month, 'source_ref', ref)),
      ...scopedKeysForEntry(month, span, safeArray(span.linked_memory_entry_ids, 16))
    ]);
    const diagnostic = buildSourceDiagnosticFromTrace({}, span, {
      sourceClient: args.sourceClient,
      workbenchRow,
      sourceIndexAnchor
    });
    if (diagnostic.source_record_id && !sourcesById.has(diagnostic.source_record_id)) {
      sourcesById.set(diagnostic.source_record_id, diagnostic);
    }
  }

  validateRows(rows);
  const sources = Array.from(sourcesById.values());
  const episodes = buildEpisodes(rows);
  const candidates = rows
    .filter((row) => row.home_lane !== 'discard')
    .map(buildCandidateRow);
  const rejected = rows.map(rejectedFromRow).filter(Boolean);
  const directWriteRows = rows.filter((row) => row.import_policy_state === 'direct_write_allowed' || row.assimilation_status !== 'not_sent');
  if (directWriteRows.length) {
    throw new Error(`safety invariant failed: ${directWriteRows.length} direct/sent rows`);
  }

  conservationLedger.output_counts = {
    review_rows: rows.length,
    source_diagnostics: sources.length,
    episode_groups: episodes.length,
    candidate_review_rows: candidates.length,
    rejected_rows: rejected.length
  };
  conservationLedger.source_lookup = {
    mode: 'month_scoped_composite_keys',
    month: args.month,
    workbench_rows: workbenchRows.length,
    workbench_ambiguous_keys: workbenchLookup.ambiguous.size,
    source_index_ambiguous_keys: sourceIndexLookup.ambiguous.size
  };

  return {
    rows,
    sources,
    episodes,
    candidates,
    rejected,
    ledger: conservationLedger,
    sourceIndexMeta,
    workbenchRows
  };
}

async function writeArtifacts(args, artifacts) {
  const { rows, sources, episodes, candidates, rejected, ledger, sourceIndexMeta, workbenchRows } = artifacts;
  return withTempOutput(args.outDir, async (tempDir) => {
    const paths = {
      reviewRows: join(args.outDir, 'home_import_review_rows.jsonl'),
      sources: join(args.outDir, 'home_import_sources.jsonl'),
      episodes: join(args.outDir, 'home_import_episodes.jsonl'),
      candidates: join(args.outDir, 'home_import_candidates.jsonl'),
      rejected: join(args.outDir, 'home_import_rejected.jsonl'),
      ledger: join(args.outDir, 'home_import_conservation_ledger.json'),
      sourceQuoteRecoveryReport: join(args.outDir, 'home_import_source_quote_recovery_report.md'),
      mixedLaneAudit: join(args.outDir, 'home_import_mixed_lane_audit.md'),
      report: join(args.outDir, 'home_import_sample_report.md')
    };
    await writeJsonl(join(tempDir, 'home_import_review_rows.jsonl'), rows);
    await writeJsonl(join(tempDir, 'home_import_sources.jsonl'), sources);
    await writeJsonl(join(tempDir, 'home_import_episodes.jsonl'), episodes);
    await writeJsonl(join(tempDir, 'home_import_candidates.jsonl'), candidates);
    await writeJsonl(join(tempDir, 'home_import_rejected.jsonl'), rejected);
    await writeJson(join(tempDir, 'home_import_conservation_ledger.json'), ledger);
    await writeText(join(tempDir, 'home_import_source_quote_recovery_report.md'), renderSourceQuoteRecoveryReport({
      args,
      rows,
      sources,
      sourceIndexMeta,
      workbenchRows
    }));
    await writeText(join(tempDir, 'home_import_mixed_lane_audit.md'), renderMixedLaneAuditReport({ rows }));
    await writeText(join(tempDir, 'home_import_sample_report.md'), renderReport({
      args,
      rows,
      sources,
      episodes,
      candidates,
      rejected,
      ledger,
      paths
    }));
  });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.validationFailure) throw args.validationFailure;
    const artifacts = await buildArtifacts(args);
    await writeArtifacts(args, artifacts);
    const { rows, sources, episodes, candidates, rejected, ledger } = artifacts;
    console.log(JSON.stringify({
      ok: true,
      outDir: args.outDir,
      source_month: args.month,
      review_rows: rows.length,
      sources: sources.length,
      episodes: episodes.length,
      candidates: candidates.length,
      rejected_rows: rejected.length,
      by_home_lane: countBy(rows, 'home_lane'),
      by_import_policy_state: countBy(rows, 'import_policy_state'),
      by_source_reliability: countBy(rows, (row) => row.reliable_home_source_span ? 'reliable' : 'source_incomplete'),
      by_quote_recovery_status: countBy(rows, 'quote_recovery_status'),
      by_write_risk: countBy(rows, 'write_risk'),
      mixed_split_required: rows.filter((row) => row.home_lane === 'mixed_split_required').length,
      conservation: {
        reviewed_rows: ledger.reviewed_rows,
        expected_reviewed_rows: ledger.expected_reviewed_rows,
        empty_record_id_rows: ledger.empty_record_id_rows,
        passed: ledger.conservation_passed
      }
    }, null, 2));
  } catch (error) {
    if (!args) {
      console.error(JSON.stringify({
        ok: false,
        error: safeText(error?.message, String(error || 'unknown error')),
        kind: error?.kind || 'argument_error'
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    const ledger = await safeConservationLedger(args, error);
    await writeFailClosed(args, error, ledger);
    console.error(JSON.stringify({
      ok: false,
      outDir: args.outDir,
      error: safeText(error?.message, String(error || 'unknown error')),
      kind: error?.kind || error?.name || 'input_failure',
      fail_closed: true
    }, null, 2));
    process.exitCode = 1;
  }
}

main();
