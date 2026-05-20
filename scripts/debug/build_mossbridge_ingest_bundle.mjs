#!/usr/bin/env node
// Build a conservative Mossbridge ingest bundle from Driftstone/AsherieHome
// machine JSON. This does not write Notion or Mossbridge; it only creates a
// stable fallback package for a future Mossbridge adapter.
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DEFAULT_MONTHS = ['2025-02', '2025-03', '2025-04'];
const DEFAULT_STAGING_ROOT = 'output/notion_staging';
const DEFAULT_OUT = 'output/mossbridge_ingest/driftstone_2025-02_to_2025-04_mossbridge_ingest_bundle';
const SCHEMA = 'driftstone_mossbridge_ingest_bundle_v0.1';

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
    outDir: DEFAULT_OUT,
    userId: 'owner',
    realmId: 'default',
    agentId: 'moss',
    sourceClient: 'driftstone'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    const next = argv[index + 1];
    if (arg === '--months' && next) {
      args.months = next.split(',').map(normalizeMonth).filter(Boolean);
      index += 1;
      continue;
    }
    if (arg === '--staging-root' && next) {
      args.stagingRoot = safeText(next, args.stagingRoot);
      index += 1;
      continue;
    }
    if (arg === '--out' && next) {
      args.outDir = safeText(next, args.outDir);
      index += 1;
      continue;
    }
    if (arg === '--user-id' && next) {
      args.userId = safeText(next, args.userId);
      index += 1;
      continue;
    }
    if (arg === '--realm-id' && next) {
      args.realmId = safeText(next, args.realmId);
      index += 1;
      continue;
    }
    if (arg === '--agent-id' && next) {
      args.agentId = safeText(next, args.agentId);
      index += 1;
      continue;
    }
  }
  args.months = uniqueStrings(args.months.map(normalizeMonth).filter(Boolean), 48);
  if (!args.months.length) args.months = DEFAULT_MONTHS;
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonOptional(filePath, fallback = {}) {
  try {
    return await readJson(filePath);
  } catch {
    return fallback;
  }
}

async function readJsonlOptional(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function writeJsonl(filePath, rows = []) {
  const text = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await writeFile(filePath, text, 'utf8');
}

function reviewStatusOf(node = {}) {
  return safeText(node.quality?.review_status || node.review_status, 'needs_review');
}

function isSupportingEvidence(node = {}) {
  return node.tree_growth?.merge_role === 'near_duplicate_evidence'
    || node.recall_policy?.primary_recall_role === 'supporting_evidence'
    || safeText(node.quality?.recall_guard || node.recall_guard) === 'supporting_evidence_only'
    || safeText(node.quality?.tree_growth_status) === 'fold_under_canonical';
}

function importStatusForNode(node = {}) {
  if (reviewStatusOf(node) === 'needs_review') return 'rejected';
  if (isSupportingEvidence(node)) return 'evidence_only';
  return 'candidate';
}

function targetLayerForNode(node = {}) {
  const text = [
    node.context_domain,
    node.node_kind,
    node.node_path,
    node.recall_lane,
    node.memory_shape,
    node.quality?.context_domain
  ].map((item) => safeText(item)).join('\n');
  if (/工程|engineering|工具|MCP|Notion|Obsidian|Driftstone|Hippocove|Mossbridge|记忆系统|记忆工程/u.test(text)) {
    return 'case_index';
  }
  if (/项目|project|创作|creative|世界观|小说|复诞纪元|Eidolon|story_or_project_anchor/u.test(text)) {
    return 'case_index';
  }
  if (/scene_replay|事件切片|event|episode/u.test(text)) return 'episode_journal';
  if (/life|现实锚点|fact_line|observation/u.test(text)) return 'observation_journal';
  return 'warm_memory';
}

function compactBodyMarkdown(node = {}) {
  const rows = [
    ['Path', node.node_path],
    ['Living fragment', node.living_fragment],
    ['Project fact', node.project_fact],
    ['Relationship significance', node.relationship_significance],
    ['Feeling as fact', node.feeling_as_fact],
    ['Recall payload', node.recall_payload]
  ].filter(([, value]) => safeText(value));
  return rows.map(([label, value]) => `**${label}:** ${safeText(value)}`).join('\n\n');
}

function rootNames(rootRefs = []) {
  return uniqueStrings(safeArray(rootRefs, 128).map((root) => root.root_name || root.root_path || root.root_id), 64);
}

function tagsForNode(node = {}) {
  return uniqueStrings([
    node.context_domain,
    node.node_kind,
    node.node_path,
    node.anchor_name,
    ...safeArray(node.feeling_handles, 24),
    ...safeArray(node.sensory_handles, 24),
    ...safeArray(node.action_handles, 24),
    ...safeArray(node.relation_handles, 24),
    ...safeArray(node.source_tags, 64)
  ], 96);
}

function provenanceRefs(node = {}) {
  return {
    source_trace_ids: uniqueStrings(node.source_trace_ids, 128),
    source_span_ids: uniqueStrings(node.source_span_ids, 128),
    source_refs: uniqueStrings(node.source_refs, 128),
    source_entry_id: safeText(node.source_entry_id),
    sync_hash: safeText(node.sync_hash)
  };
}

function baseMemoryRecord(node = {}, targetLayer = 'warm_memory') {
  const status = importStatusForNode(node);
  const reviewStatus = reviewStatusOf(node);
  return {
    schema: 'driftstone_mossbridge_memory_record_v0.1',
    material_id: safeText(node.node_id || node.source_entry_id),
    source_entry_id: safeText(node.source_entry_id),
    source_system: 'driftstone',
    source_bundle_role: safeText(node.source_bundle_role, 'old_history_cold_archive'),
    target_layer: targetLayer,
    import_status: status,
    review_status: reviewStatus,
    title: safeText(node.title || node.anchor_name || node.node_path, 'Untitled memory'),
    summary: safeText(node.human_summary || node.front_context_hint || node.living_fragment || node.recall_payload),
    body_markdown: compactBodyMarkdown(node),
    recall_text: safeText(node.recall_payload || node.front_context_hint || node.living_fragment),
    front_recall_text: safeText(node.front_context_hint || node.recall_payload || node.living_fragment),
    machine_index_text: safeText(node.machine_index_text),
    node_path: safeText(node.node_path),
    anchor_name: safeText(node.anchor_name),
    context_domain: safeText(node.context_domain || node.quality?.context_domain),
    certainty_state: status === 'candidate' && reviewStatus === 'ready_for_cold_archive' ? 'candidate_anchor' : 'candidate',
    pinned: false,
    tags: tagsForNode(node),
    entities: rootNames(node.root_refs),
    aliases: uniqueStrings(node.activation_triggers, 32),
    activation_triggers: uniqueStrings(node.activation_triggers, 32),
    provenance_refs: provenanceRefs(node),
    episode_refs: uniqueStrings([node.episode_key], 16),
    case_refs: uniqueStrings(safeArray(node.root_refs, 64)
      .filter((root) => /story_arc|method_protocol|project|world_rule/u.test(safeText(root.root_kind)))
      .map((root) => root.root_id || root.source_root_id), 32),
    source_trace_ids: uniqueStrings(node.source_trace_ids, 128),
    source_span_ids: uniqueStrings(node.source_span_ids, 128),
    expose_source_trace_to_front_model_by_default: false,
    original_record: {
      schema: safeText(node.schema),
      node_id: safeText(node.node_id),
      tree_growth: node.tree_growth || null,
      recall_policy: node.recall_policy || null,
      bridge_import_policy: node.bridge_import_policy || null
    }
  };
}

function memoryTreeRootRecord(root = {}) {
  const status = safeText(root.import_status) === 'rejected' ? 'rejected' : 'candidate';
  return {
    schema: 'driftstone_mossbridge_relation_root_v0.1',
    material_id: safeText(root.normalized_root_id || root.candidate_id || root.source_root_id),
    source_root_id: safeText(root.source_root_id),
    source_system: 'driftstone',
    target_layer: 'memory_tree',
    import_status: status,
    root_kind: safeText(root.root_kind),
    root_name: safeText(root.root_name),
    root_path: safeText(root.root_path),
    aliases: uniqueStrings(root.aliases, 64),
    tags: uniqueStrings([root.root_kind, root.root_path, ...safeArray(root.recall_keywords, 32)], 96),
    summary: safeArray(root.summary_hints, 3).join('\n'),
    recall_keywords: uniqueStrings(root.recall_keywords, 128),
    evidence_entry_ids: uniqueStrings(root.memory_entry_ids, 256),
    source_trace_ids: uniqueStrings(root.source_trace_ids, 256),
    confidence: safeText(root.confidence, 'candidate'),
    graph_visibility: safeText(root.graph_visibility, 'candidate'),
    no_recall_boost_before_review: true
  };
}

function memoryTreeEdgeRecord(edge = {}) {
  const semantic = Boolean(edge.bridge_import_policy?.semantic_edge);
  const active = safeText(edge.import_status) === 'active_candidate';
  const importStatus = semantic && active ? 'candidate' : 'evidence_only';
  const strength = Number(edge.strength || edge.confidence || 0);
  return {
    schema: 'driftstone_mossbridge_relation_edge_v0.1',
    material_id: safeText(edge.candidate_id || edge.source_vine_id),
    source_vine_id: safeText(edge.source_vine_id),
    source_system: 'driftstone',
    target_layer: 'memory_tree',
    import_status: importStatus,
    relation_type: safeText(edge.relation_type || edge.relation_label),
    relation_label: safeText(edge.relation_label || edge.relation_type),
    from_ref: edge.from_ref || null,
    to_ref: edge.to_ref || null,
    confidence: Math.max(0, Math.min(1, strength / 100 || (semantic ? 0.5 : 0.15))),
    strength,
    evidence_entry_ids: uniqueStrings(edge.evidence_entry_ids, 512),
    source_trace_ids: uniqueStrings(edge.source_trace_ids, 512),
    semantic_edge: semantic,
    no_recall_boost_before_review: true,
    requires_confirmation: true,
    notes: semantic && active
      ? 'Candidate semantic edge; do not boost before review.'
      : 'Evidence/background edge only; never treat as stable semantic fact.'
  };
}

function sourceTraceRecord(trace = {}, sourceClient = 'driftstone') {
  return {
    schema: 'driftstone_mossbridge_source_trace_v0.1',
    material_id: safeText(trace.trace_id),
    trace_id: safeText(trace.trace_id),
    target_layer: 'raw_transcript_archive',
    import_status: 'evidence_only',
    source_client: sourceClient,
    conversation_id: safeText(trace.source_window_id || trace.source_bundle_id),
    source_window_id: safeText(trace.source_window_id),
    source_window_title: safeText(trace.source_window_title || trace.trace_title),
    source_msg_range: safeText(trace.source_msg_range),
    message_id: safeText(trace.trace_id),
    role: 'evidence',
    text: safeText(trace.excerpt_text || trace.excerpt_hint),
    excerpt_text: safeText(trace.excerpt_text),
    excerpt_hint: safeText(trace.excerpt_hint),
    local_date: normalizeMonth(trace.source_bundle_id || trace.chunk_id || ''),
    source_refs: uniqueStrings(trace.source_refs, 128),
    source_tags: uniqueStrings(trace.source_tags, 128),
    linked_memory_entry_ids: uniqueStrings(trace.linked_memory_entry_ids, 512),
    linked_root_ids: uniqueStrings(trace.linked_root_ids, 512),
    canonical_source_span_id: safeText(trace.canonical_source_span_id),
    expose_to_front_model_by_default: false,
    read_as_evidence_only: true
  };
}

function sourceSpanRecord(span = {}, sourceClient = 'driftstone') {
  return {
    schema: 'driftstone_mossbridge_source_span_v0.1',
    material_id: safeText(span.source_span_id || span.candidate_id),
    source_span_id: safeText(span.source_span_id),
    parent_source_span_id: safeText(span.parent_source_span_id),
    target_layer: 'raw_transcript_archive',
    import_status: 'evidence_only',
    source_client: sourceClient,
    conversation_id: safeText(span.source_window_id || span.source_bundle_id),
    source_window_id: safeText(span.source_window_id),
    source_window_title: safeText(span.source_window_title),
    source_msg_range: safeText(span.source_msg_range),
    source_bundle_id: safeText(span.source_bundle_id),
    chunk_ids: uniqueStrings(span.chunk_ids, 128),
    source_trace_ids: uniqueStrings(span.source_trace_ids, 512),
    evidence_excerpt_ids: uniqueStrings(span.evidence_excerpt_ids, 512),
    linked_memory_entry_ids: uniqueStrings(span.linked_memory_entry_ids, 512),
    linked_root_ids: uniqueStrings(span.linked_root_ids, 512),
    source_refs: uniqueStrings(span.source_refs, 128),
    expose_to_front_model_by_default: false,
    read_as_evidence_only: true
  };
}

function countBy(rows = [], getter = (row) => row) {
  const out = {};
  for (const row of rows) {
    const key = safeText(typeof getter === 'function' ? getter(row) : row?.[getter], 'unknown');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function sampleQueries({ warmMemory, caseIndex, episodeJournal, observationJournal, roots } = {}) {
  const candidates = [
    ...warmMemory.slice(0, 4),
    ...caseIndex.slice(0, 3),
    ...episodeJournal.slice(0, 2),
    ...observationJournal.slice(0, 2),
    ...roots.slice(0, 4)
  ];
  return candidates.slice(0, 12).map((row) => ({
    schema: 'driftstone_mossbridge_sample_query_v0.1',
    query: safeText(row.title || row.root_name || row.root_path || row.anchor_name, 'memory lookup'),
    expected_layer: safeText(row.target_layer),
    expected_ids: [safeText(row.material_id)].filter(Boolean),
    should_not_expand_evidence_by_default: true
  }));
}

async function loadMonthBundle(stagingRoot, month) {
  const dir = join(stagingRoot, `ajimem_${month}`);
  return {
    month,
    manifest: await readJsonOptional(join(dir, '00_manifest.json'), {}),
    nodes: await readJsonlOptional(join(dir, '23_asheriehome_memory_nodes.jsonl')),
    roots: await readJsonlOptional(join(dir, '13_normalized_relation_root_candidates.jsonl')),
    edges: await readJsonlOptional(join(dir, '14_normalized_tree_edge_candidates.jsonl')),
    sourceTraces: await readJsonlOptional(join(dir, '24_source_trace_index.jsonl')),
    sourceSpans: await readJsonlOptional(join(dir, '16_normalized_source_span_candidates.jsonl'))
  };
}

function uniqueByMaterialId(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = safeText(row.material_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundles = [];
  for (const month of args.months) {
    bundles.push(await loadMonthBundle(args.stagingRoot, month));
  }

  const warmMemory = [];
  const ongoingTracks = [];
  const episodeJournal = [];
  const observationJournal = [];
  const caseIndex = [];
  const memoryTreeRoots = [];
  const memoryTreeEdges = [];
  const sourceTraces = [];
  const sourceSpans = [];

  for (const bundle of bundles) {
    for (const node of bundle.nodes) {
      const targetLayer = targetLayerForNode(node);
      const record = baseMemoryRecord(node, targetLayer);
      if (targetLayer === 'case_index') caseIndex.push(record);
      else if (targetLayer === 'episode_journal') episodeJournal.push(record);
      else if (targetLayer === 'observation_journal') observationJournal.push(record);
      else warmMemory.push(record);
    }
    for (const root of bundle.roots) memoryTreeRoots.push(memoryTreeRootRecord(root));
    for (const edge of bundle.edges) memoryTreeEdges.push(memoryTreeEdgeRecord(edge));
    for (const trace of bundle.sourceTraces) sourceTraces.push(sourceTraceRecord(trace, args.sourceClient));
    for (const span of bundle.sourceSpans) sourceSpans.push(sourceSpanRecord(span, args.sourceClient));
  }

  const output = {
    warmMemory: uniqueByMaterialId(warmMemory),
    ongoingTracks,
    episodeJournal: uniqueByMaterialId(episodeJournal),
    observationJournal: uniqueByMaterialId(observationJournal),
    caseIndex: uniqueByMaterialId(caseIndex),
    memoryTreeRoots: uniqueByMaterialId(memoryTreeRoots),
    memoryTreeEdges: uniqueByMaterialId(memoryTreeEdges),
    sourceTraces: uniqueByMaterialId(sourceTraces),
    sourceSpans: uniqueByMaterialId(sourceSpans)
  };

  const qa = sampleQueries({
    warmMemory: output.warmMemory.filter((row) => row.import_status === 'candidate'),
    caseIndex: output.caseIndex.filter((row) => row.import_status === 'candidate'),
    episodeJournal: output.episodeJournal.filter((row) => row.import_status === 'candidate'),
    observationJournal: output.observationJournal.filter((row) => row.import_status === 'candidate'),
    roots: output.memoryTreeRoots.filter((row) => row.import_status === 'candidate')
  });

  const counts = {
    warm_memory: output.warmMemory.length,
    ongoing_tracks: output.ongoingTracks.length,
    episode_journal: output.episodeJournal.length,
    observation_journal: output.observationJournal.length,
    case_index: output.caseIndex.length,
    memory_tree_roots: output.memoryTreeRoots.length,
    memory_tree_edges: output.memoryTreeEdges.length,
    source_traces: output.sourceTraces.length,
    source_spans: output.sourceSpans.length,
    sample_queries: qa.length
  };

  const allRuntimeRows = [
    ...output.warmMemory,
    ...output.ongoingTracks,
    ...output.episodeJournal,
    ...output.observationJournal,
    ...output.caseIndex,
    ...output.memoryTreeRoots,
    ...output.memoryTreeEdges
  ];
  const qualityReport = {
    schema: 'driftstone_mossbridge_ingest_quality_report_v0.1',
    status: 'prepared_conservative_candidate_bundle',
    counts,
    import_status_distribution: countBy([...allRuntimeRows, ...output.sourceTraces, ...output.sourceSpans], 'import_status'),
    target_layer_distribution: countBy([...allRuntimeRows, ...output.sourceTraces, ...output.sourceSpans], 'target_layer'),
    accepted_count: allRuntimeRows.filter((row) => row.import_status === 'accepted').length,
    direct_runtime_write_safe: false,
    notes: [
      'No record is marked accepted in this first bridge profile.',
      'Old-history nodes are candidate/rejected/evidence_only only; Mossbridge must review or map before activation.',
      'Source traces and spans are evidence_only raw_transcript_archive records and must not be injected into frontend context by default.',
      'Notion projection remains a human/ChatGPT view; this bundle is the machine handoff.'
    ]
  };

  const manifest = {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    source: {
      project: 'Driftstone',
      source_profile: 'asheriehome_json_primary_with_notion_projection',
      staging_root: args.stagingRoot,
      months: args.months
    },
    source_identity: {
      userId: args.userId,
      realmId: args.realmId,
      agentId: args.agentId
    },
    writes_to_notion: false,
    writes_to_mossbridge_warm_memory: false,
    imports_overflow_links: false,
    direct_runtime_activation: false,
    default_import_policy: {
      accepted_records: 0,
      candidate_records_require_review: true,
      rejected_records_audit_only: true,
      evidence_records_front_exposure_default: false
    },
    files: {
      warm_memory: 'normalized/warm_memory.jsonl',
      ongoing_tracks: 'normalized/ongoing_tracks.jsonl',
      episode_journal: 'normalized/episode_journal.jsonl',
      observation_journal: 'normalized/observation_journal.jsonl',
      case_index: 'normalized/case_index.jsonl',
      memory_tree_roots: 'normalized/memory_tree_roots.jsonl',
      memory_tree_edges: 'normalized/memory_tree_edges.jsonl',
      source_traces: 'evidence/source_traces.jsonl',
      source_spans: 'evidence/source_spans.jsonl',
      sample_queries: 'qa/sample_queries.jsonl',
      quality_report: 'qa/quality_report.json'
    },
    counts
  };

  await mkdir(join(args.outDir, 'normalized'), { recursive: true });
  await mkdir(join(args.outDir, 'evidence'), { recursive: true });
  await mkdir(join(args.outDir, 'qa'), { recursive: true });

  await writeJson(join(args.outDir, 'manifest.json'), manifest);
  await writeJsonl(join(args.outDir, 'normalized', 'warm_memory.jsonl'), output.warmMemory);
  await writeJsonl(join(args.outDir, 'normalized', 'ongoing_tracks.jsonl'), output.ongoingTracks);
  await writeJsonl(join(args.outDir, 'normalized', 'episode_journal.jsonl'), output.episodeJournal);
  await writeJsonl(join(args.outDir, 'normalized', 'observation_journal.jsonl'), output.observationJournal);
  await writeJsonl(join(args.outDir, 'normalized', 'case_index.jsonl'), output.caseIndex);
  await writeJsonl(join(args.outDir, 'normalized', 'memory_tree_roots.jsonl'), output.memoryTreeRoots);
  await writeJsonl(join(args.outDir, 'normalized', 'memory_tree_edges.jsonl'), output.memoryTreeEdges);
  await writeJsonl(join(args.outDir, 'evidence', 'source_traces.jsonl'), output.sourceTraces);
  await writeJsonl(join(args.outDir, 'evidence', 'source_spans.jsonl'), output.sourceSpans);
  await writeJsonl(join(args.outDir, 'qa', 'sample_queries.jsonl'), qa);
  await writeJson(join(args.outDir, 'qa', 'quality_report.json'), qualityReport);

  console.log(JSON.stringify({
    ok: true,
    out_dir: args.outDir,
    schema: SCHEMA,
    counts,
    accepted_count: 0,
    direct_runtime_activation: false
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: safeText(error?.message, String(error || 'unknown error'))
  }, null, 2));
  process.exitCode = 1;
});
