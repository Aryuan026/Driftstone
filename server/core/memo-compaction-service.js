import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import { exportGrowthScopeBundleToObsidianStaging } from './obsidian-export-service.js';
import { OBSIDIAN_STAGING_ROOT, getScopedObsidianStagingRoot, safeScopeSegment } from './path-config.js';

const COMPACT_INDEX_DIR = '00_Index';
const COMPACT_MEMO_DIR = '02_Memo';
const COMPACT_TRACE_DIR = '98_SourceTrace';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function safeArray(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeText(item))
    .filter(Boolean)
    .slice(0, Math.max(0, Number(limit || 0)));
}

function uniqueStrings(values = [], limit = 256) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(values) ? values : []) {
    const text = safeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizePathValue(value = '') {
  return String(value || '').replace(/\\/g, '/');
}

function cleanInlineText(value = '') {
  return String(value || '')
    .replace(/\[object Object\]/g, '')
    .replace(/[*_`>#]+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(value = '', limit = 72) {
  const text = cleanInlineText(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function renderYamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

function renderYamlArray(key, values = []) {
  const list = safeArray(values, 512);
  if (!list.length) return `${key}: []`;
  return `${key}:\n${list.map((item) => `  - ${renderYamlScalar(item)}`).join('\n')}`;
}

function relativeToVault(filePath = '') {
  return normalizePathValue(relative(OBSIDIAN_STAGING_ROOT, filePath));
}

function relativeToScopeRoot(scopeRoot = '', filePath = '') {
  return normalizePathValue(relative(scopeRoot, filePath));
}

function toObsidianLink(bundlePath = '', alias = '') {
  const target = normalizePathValue(bundlePath).replace(/\.md$/i, '');
  if (!target) return safeText(alias);
  const safeAlias = safeText(alias);
  return safeAlias ? `[[${target}|${safeAlias}]]` : `[[${target}]]`;
}

async function ensureParent(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

async function readUtf8IfExists(filePath) {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function walkMarkdownFiles(dir, bucket = []) {
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    if (!entry) continue;
    const filePath = join(dir, entry.name);
    if (entry.isDirectory?.()) {
      await walkMarkdownFiles(filePath, bucket);
      continue;
    }
    if (entry.isFile?.() && entry.name.toLowerCase().endsWith('.md')) {
      bucket.push(filePath);
    }
  }
  return bucket;
}

function parseMarkdownTitle(raw = '', fallback = '') {
  const text = String(raw || '');
  const frontmatterTitle = text.match(/^---[\s\S]*?^\s*title:\s*(.+?)\s*$/m);
  if (frontmatterTitle?.[1]) return safeText(frontmatterTitle[1].replace(/^["']|["']$/g, ''), fallback);
  const heading = text.match(/^#\s+(.+?)\s*$/m);
  if (heading?.[1]) return safeText(heading[1], fallback);
  return fallback;
}

function parseFrontmatterScalar(raw = '', key = '', fallback = '') {
  const text = String(raw || '');
  const pattern = new RegExp(`^---[\\s\\S]*?^\\s*${key}:\\s*(.+?)\\s*$`, 'm');
  const match = text.match(pattern);
  if (!match?.[1]) return fallback;
  return safeText(match[1].replace(/^["']|["']$/g, ''), fallback);
}

function parseFrontmatterArray(raw = '', key = '') {
  const text = String(raw || '');
  const block = text.match(new RegExp(`^---[\\s\\S]*?^\\s*${key}:\\s*\\n([\\s\\S]*?)(?=^\\s*[A-Za-z0-9_]+:\\s|^---\\s*$)`, 'm'));
  if (!block?.[1]) return [];
  return block[1]
    .split('\n')
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] || '')
    .map((line) => safeText(line.replace(/^["']|["']$/g, '')))
    .filter(Boolean);
}

function extractMarkdownSection(raw = '', heading = '') {
  const text = String(raw || '');
  const marker = `## ${heading}`;
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const bodyStart = text.indexOf('\n', start);
  if (bodyStart < 0) return '';
  const rest = text.slice(bodyStart + 1);
  const nextMatch = rest.match(/^##\s+/m);
  if (!nextMatch || nextMatch.index === undefined) return rest.trim();
  return rest.slice(0, nextMatch.index).trim();
}

function parseMarkdownBulletSection(raw = '', heading = '') {
  const section = extractMarkdownSection(raw, heading);
  if (!section) return [];
  return section
    .split('\n')
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] || '')
    .map((line) => safeText(line))
    .filter(Boolean);
}

function parseWikiLinks(raw = '') {
  const links = [];
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let match;
  while ((match = pattern.exec(String(raw || '')))) {
    const bundlePath = safeText(match[1]);
    if (!bundlePath) continue;
    links.push({
      bundle_path: bundlePath.toLowerCase().endsWith('.md') ? bundlePath : `${bundlePath}.md`,
      alias: safeText(match[2])
    });
  }
  return links;
}

function normalizeSemanticText(value = '') {
  return cleanInlineText(value)
    .replace(/\b(user|assistant|tool)\b/giu, ' ')
    .replace(/__/g, ' ')
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalSemanticKey(value = '') {
  return normalizeSemanticText(value)
    .replace(/\b(user|assistant|tool|chat|bundle)\b/giu, ' ')
    .replace(/\b\d{1,3}\b/gu, ' ')
    .replace(/[·:：,，、;；.。!?！？"'“”‘’()[\]{}<>《》【】/\\-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenizeSemanticTerms(value = '') {
  const text = canonicalSemanticKey(value);
  if (!text) return [];
  const parts = text.split(/\s+/).filter((item) => item.length > 1);
  if (parts.length >= 4) return uniqueStrings(parts, 64);
  const hanText = text.replace(/\s+/g, '');
  const bigrams = [];
  for (let index = 0; index < hanText.length - 1; index += 1) {
    bigrams.push(hanText.slice(index, index + 2));
    if (bigrams.length >= 64) break;
  }
  return uniqueStrings([...parts, ...bigrams], 64);
}

function buildTextBigrams(value = '') {
  const compact = canonicalSemanticKey(value).replace(/\s+/g, '');
  const out = new Set();
  for (let index = 0; index < compact.length - 1; index += 1) {
    out.add(compact.slice(index, index + 2));
    if (out.size >= 64) break;
  }
  return out;
}

function buildTextSignature(value = '') {
  const compact = normalizeSemanticText(value).replace(/\s+/g, '');
  const out = new Set();
  for (let index = 0; index < compact.length - 1; index += 1) {
    out.add(compact.slice(index, index + 2));
    if (out.size >= 256) break;
  }
  if (!out.size && compact) out.add(compact);
  return out;
}

function intersectionSize(left, right) {
  const leftSet = left instanceof Set ? left : new Set(Array.isArray(left) ? left : []);
  const rightSet = right instanceof Set ? right : new Set(Array.isArray(right) ? right : []);
  let total = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) total += 1;
  }
  return total;
}

function diceSimilarity(left, right) {
  const leftSet = left instanceof Set ? left : new Set(Array.isArray(left) ? left : []);
  const rightSet = right instanceof Set ? right : new Set(Array.isArray(right) ? right : []);
  if (!leftSet.size || !rightSet.size) return 0;
  return (2 * intersectionSize(leftSet, rightSet)) / (leftSet.size + rightSet.size);
}

function renderBulletSection(lines, heading, values = []) {
  const list = safeArray(values, 32);
  if (!list.length) return;
  lines.push(`## ${heading}`, '');
  lines.push(...list.map((item) => `- ${item}`));
  lines.push('');
}

function renderRawSection(lines, heading, rawSection = '') {
  const text = String(rawSection || '').trim();
  if (!text) return;
  lines.push(`## ${heading}`, '');
  lines.push(text, '');
}

function buildFamilyTag(family = '') {
  const text = safeScopeSegment(family, '');
  return text ? `family/${text}` : '';
}

function buildShapeTag(shapeKey = '') {
  const text = safeText(shapeKey);
  return text ? `shape/${text}` : '';
}

function buildCompactBundleRoot(ownerId = '', realmId = '', rootDir = '') {
  const rawRoot = safeText(
    rootDir,
    ownerId && realmId ? getScopedObsidianStagingRoot(ownerId, realmId) : OBSIDIAN_STAGING_ROOT
  );
  return `${rawRoot}__compact`;
}

async function ensureRawBundle({ ownerId = '', realmId = '', rootDir = '' } = {}) {
  const rawRoot = safeText(
    rootDir,
    ownerId && realmId ? getScopedObsidianStagingRoot(ownerId, realmId) : OBSIDIAN_STAGING_ROOT
  );
  const memoDir = join(rawRoot, COMPACT_MEMO_DIR);
  const existingMemoFiles = await walkMarkdownFiles(memoDir, []);
  if (existingMemoFiles.length) {
    return { ok: true, raw_root: rawRoot };
  }
  const result = await exportGrowthScopeBundleToObsidianStaging({
    ownerId,
    realmId,
    cardType: 'memo',
    rootDir: rawRoot,
    overwrite: true,
    includeContent: false
  });
  if (!result?.ok) return result;
  return { ok: true, raw_root: rawRoot };
}

async function loadRawBundleNotes(rawRoot = '') {
  const files = await walkMarkdownFiles(rawRoot, []);
  const memos = [];
  const memoEntries = [];
  const traces = new Map();
  for (const filePath of files) {
    const raw = await readUtf8IfExists(filePath);
    if (raw === null) continue;
    const bundlePath = relativeToScopeRoot(rawRoot, filePath);
    if (bundlePath.startsWith(`${COMPACT_MEMO_DIR}/`)) {
      memoEntries.push({
        raw,
        file_path: filePath,
        bundle_path: normalizePathValue(bundlePath)
      });
      continue;
    }
    if (bundlePath.startsWith(`${COMPACT_TRACE_DIR}/`)) {
      traces.set(normalizePathValue(bundlePath), {
        kind: 'source_trace',
        trace_id: parseFrontmatterScalar(raw, 'trace_id', ''),
        title: parseMarkdownTitle(raw, basename(filePath, '.md')),
        trace_role: parseFrontmatterScalar(raw, 'trace_role', ''),
        source_packet_id: parseFrontmatterScalar(raw, 'source_packet_id', ''),
        source_slice_id: parseFrontmatterScalar(raw, 'source_slice_id', ''),
        source_title: parseFrontmatterScalar(raw, 'source_title', ''),
        source_created_at: parseFrontmatterScalar(raw, 'source_created_at', ''),
        source_ref: parseFrontmatterScalar(raw, 'source_ref', ''),
        tags: parseFrontmatterArray(raw, 'tags'),
        source_topics: parseFrontmatterArray(raw, 'source_topics'),
        summary_block: extractMarkdownSection(raw, '摘要'),
        excerpt_block: extractMarkdownSection(raw, '原文节选'),
        raw,
        export_file: filePath,
        bundle_path: normalizePathValue(bundlePath),
        relative_path: relativeToVault(filePath)
      });
    }
  }
  for (const entry of memoEntries) {
    const title = parseMarkdownTitle(entry.raw, basename(entry.file_path, '.md'));
    const traceLinks = parseMarkdownBulletSection(entry.raw, '原文回溯')
      .flatMap((line) => parseWikiLinks(line))
      .map((item) => normalizePathValue(item.bundle_path));
    const traceNotes = traceLinks.map((link) => traces.get(link)).filter(Boolean);
    const note = {
      kind: 'memo',
      title,
      memo_id: parseFrontmatterScalar(entry.raw, 'memo_id', ''),
      family: parseFrontmatterScalar(entry.raw, 'family', ''),
      memory_shape: parseFrontmatterScalar(entry.raw, 'memory_shape', 'scene_event'),
      shape_label: parseFrontmatterScalar(entry.raw, 'shape_label', '事件切片'),
      generated_at: parseFrontmatterScalar(entry.raw, 'generated_at', ''),
      inject_short: safeText(String(entry.raw).match(/^>\s+(.+?)\s*$/m)?.[1]),
      snapshot: extractMarkdownSection(entry.raw, '记忆正文'),
      context: extractMarkdownSection(entry.raw, '触发场景'),
      memory_type_block: extractMarkdownSection(entry.raw, '记忆类型'),
      recall_when_block: extractMarkdownSection(entry.raw, '适合召回'),
      relationship_meaning_block: extractMarkdownSection(entry.raw, '关系意义'),
      scene_handles: parseMarkdownBulletSection(entry.raw, '场景锚点'),
      recall_facts: parseMarkdownBulletSection(entry.raw, '事实锚点'),
      activation_triggers: parseMarkdownBulletSection(entry.raw, '召回线索'),
      voice_fingerprint: parseMarkdownBulletSection(entry.raw, '语气指纹'),
      nearby_links: parseMarkdownBulletSection(entry.raw, '近邻记忆')
        .flatMap((line) => parseWikiLinks(line))
        .map((item) => normalizePathValue(item.bundle_path)),
      trace_links: traceLinks,
      source_slice_ids: uniqueStrings(traceNotes.map((item) => item.source_slice_id), 256),
      source_refs: uniqueStrings(traceNotes.map((item) => item.source_ref), 256),
      source_topics: uniqueStrings(traceNotes.flatMap((item) => safeArray(item.source_topics, 16)), 64),
      raw: entry.raw,
      export_file: entry.file_path,
      bundle_path: entry.bundle_path,
      relative_path: relativeToVault(entry.file_path)
    };
    memos.push(note);
  }
  return {
    raw_root: rawRoot,
    memo_notes: memos.sort((a, b) => String(a.bundle_path || '').localeCompare(String(b.bundle_path || ''), 'zh')),
    trace_map: traces
  };
}

function buildMemoDescriptor(note = {}) {
  const cueText = [
    safeText(note.title),
    safeText(note.inject_short),
    safeText(note.snapshot),
    ...safeArray(note.activation_triggers, 8),
    ...safeArray(note.recall_facts, 4),
    ...safeArray(note.scene_handles, 4)
  ].join(' ');
  const semanticText = [safeText(note.title), safeText(note.snapshot), safeText(note.inject_short)].join(' ');
  return {
    ...note,
    nearby_set: new Set(safeArray(note.nearby_links, 16).map((item) => normalizePathValue(item))),
    trace_set: new Set(safeArray(note.trace_links, 32).map((item) => normalizePathValue(item))),
    source_slice_set: new Set(safeArray(note.source_slice_ids, 64).map((item) => safeText(item))),
    source_ref_set: new Set(safeArray(note.source_refs, 64).map((item) => safeText(item))),
    trigger_set: new Set(safeArray(note.activation_triggers, 16).map((item) => canonicalSemanticKey(item)).filter(Boolean)),
    scene_set: new Set(safeArray(note.scene_handles, 16).map((item) => canonicalSemanticKey(item)).filter(Boolean)),
    topic_set: new Set(safeArray(note.source_topics, 32).map((item) => canonicalSemanticKey(item)).filter(Boolean)),
    title_key: canonicalSemanticKey(note.title),
    terms: new Set(tokenizeSemanticTerms(cueText)),
    bigrams: buildTextBigrams(cueText),
    signature_set: buildTextSignature(semanticText),
    body_length: safeText(note.snapshot).length,
    fact_count: safeArray(note.recall_facts, 16).length
  };
}

function scoreMemoAffinity(left = {}, right = {}) {
  if (!left || !right) return 0;
  let score = 0;
  if (safeText(left.family) && safeText(left.family) === safeText(right.family)) score += 0.4;
  if (safeText(left.memory_shape) && safeText(left.memory_shape) === safeText(right.memory_shape)) score += 0.9;
  const sharedSlices = intersectionSize(left.source_slice_set, right.source_slice_set);
  const sharedRefs = intersectionSize(left.source_ref_set, right.source_ref_set);
  const sharedTriggers = intersectionSize(left.trigger_set, right.trigger_set);
  const sharedScenes = intersectionSize(left.scene_set, right.scene_set);
  const sharedTopics = intersectionSize(left.topic_set, right.topic_set);
  const sharedTerms = intersectionSize(left.terms, right.terms);
  const sharedBigrams = intersectionSize(left.bigrams, right.bigrams);
  score += Math.min(sharedSlices, 8) * 0.95;
  score += Math.min(sharedRefs, 8) * 0.65;
  score += Math.min(sharedTriggers, 3) * 0.75;
  score += Math.min(sharedScenes, 3) * 0.8;
  score += Math.min(sharedTopics, 4) * 0.4;
  score += Math.min(sharedTerms, 6) * 0.18;
  score += Math.min(sharedBigrams, 8) * 0.08;
  return score;
}

function semanticThresholdForShape(shape = '') {
  const key = safeText(shape, 'scene_event');
  if (key === 'scene_event') return 0.18;
  if (key === 'relation_milestone') return 0.17;
  if (key === 'self_definition') return 0.172;
  if (key === 'anchor_object') return 0.17;
  if (key === 'worldview_protocol') return 0.168;
  if (key === 'preference_profile') return 0.168;
  return 0.17;
}

function clusterLimitForShape(shape = '') {
  const key = safeText(shape, 'scene_event');
  if (key === 'scene_event') return 3;
  if (key === 'relation_milestone') return 2;
  if (key === 'self_definition') return 2;
  return 2;
}

function shouldCompactTogether(left = {}, right = {}) {
  const shape = safeText(left.memory_shape);
  if (shape !== safeText(right.memory_shape)) return false;
  const score = scoreMemoAffinity(left, right);
  const sharedSlices = intersectionSize(left.source_slice_set, right.source_slice_set);
  const sharedRefs = intersectionSize(left.source_ref_set, right.source_ref_set);
  const sharedScenes = intersectionSize(left.scene_set, right.scene_set);
  const sharedTerms = intersectionSize(left.terms, right.terms);
  const sharedTopics = intersectionSize(left.topic_set, right.topic_set);
  const semanticDice = diceSimilarity(left.signature_set, right.signature_set);
  const sharedEvidence = Math.max(sharedSlices, sharedRefs);
  const minimumEvidence = shape === 'scene_event' ? 5 : 6;
  const semanticThreshold = semanticThresholdForShape(shape);
  const titleOverlap =
    left.title_key &&
    right.title_key &&
    (left.title_key.includes(right.title_key) || right.title_key.includes(left.title_key));
  if (sharedEvidence < minimumEvidence) return false;
  if (semanticDice >= semanticThreshold) return true;
  if (titleOverlap && semanticDice >= semanticThreshold - 0.015) return true;
  if (sharedScenes >= 2 && sharedTerms >= 4 && sharedTopics >= 1 && semanticDice >= semanticThreshold - 0.01 && score >= 8.5) {
    return true;
  }
  return false;
}

function chooseClusterPrimary(notes = []) {
  const items = Array.isArray(notes) ? notes : [];
  if (!items.length) return null;
  return items.slice().sort((left, right) => {
    const leftScore = (left.body_length || 0) + (left.fact_count || 0) * 14 + (left.trace_set?.size || 0) * 18;
    const rightScore = (right.body_length || 0) + (right.fact_count || 0) * 14 + (right.trace_set?.size || 0) * 18;
    return rightScore - leftScore || String(left.title || '').localeCompare(String(right.title || ''), 'zh');
  })[0];
}

function buildSharedCueList(cluster = []) {
  const counter = new Map();
  const push = (value, weight = 1) => {
    const text = safeText(value);
    if (!text) return;
    counter.set(text, (counter.get(text) || 0) + weight);
  };
  for (const note of Array.isArray(cluster) ? cluster : []) {
    safeArray(note.activation_triggers, 6).forEach((item) => push(item, 2));
    safeArray(note.scene_handles, 4).forEach((item) => push(item, 1));
  }
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([text]) => text)
    .slice(0, 4);
}

function summarizeClusterMembers(cluster = [], primary = null) {
  return (Array.isArray(cluster) ? cluster : [])
    .filter((item) => item.bundle_path !== primary?.bundle_path)
    .map((item) => {
      const traceCount =
        item.trace_set?.size ||
        safeArray(item.source_slice_ids, 64).length ||
        safeArray(item.trace_links, 64).length ||
        0;
      return `${item.title} · 回溯 ${traceCount} 份`;
    })
    .slice(0, 8);
}

function buildClusterList(descriptors = []) {
  const items = Array.isArray(descriptors) ? descriptors : [];
  const ordered = items
    .slice()
    .sort((a, b) =>
      String(a.generated_at || '').localeCompare(String(b.generated_at || '')) ||
      String(a.title || '').localeCompare(String(b.title || ''), 'zh')
    );
  const clusters = [];
  for (const item of ordered) {
    let bestCluster = null;
    let bestScore = -Infinity;
    for (const cluster of clusters) {
      if (!Array.isArray(cluster) || !cluster.length) continue;
      if (safeText(cluster[0].memory_shape) !== safeText(item.memory_shape)) continue;
      if (cluster.length >= clusterLimitForShape(item.memory_shape)) continue;
      const primary = chooseClusterPrimary(cluster);
      const directMatch = shouldCompactTogether(item, primary);
      const neighborMatches = cluster.filter((member) => shouldCompactTogether(item, member)).length;
      if (!directMatch && neighborMatches < 1) continue;
      const clusterScore = scoreMemoAffinity(item, primary) + neighborMatches * 1.2;
      if (clusterScore > bestScore) {
        bestScore = clusterScore;
        bestCluster = cluster;
      }
    }
    if (bestCluster) {
      bestCluster.push(item);
      continue;
    }
    clusters.push([item]);
  }
  return clusters
    .map((group) => group.slice().sort((a, b) => String(a.generated_at || '').localeCompare(String(b.generated_at || ''))))
    .sort((a, b) => b.length - a.length || String(a[0]?.title || '').localeCompare(String(b[0]?.title || ''), 'zh'));
}

function buildCompactMemoBundlePath(primary = {}, clusterId = '') {
  const safeTitle = safeScopeSegment(primary.title, 'memory-card').slice(0, 56);
  const safeId = safeScopeSegment(primary.memo_id || clusterId, 'memo').slice(-28);
  return join(COMPACT_MEMO_DIR, `${safeTitle}__${safeId}.md`);
}

function buildCompactTraceBundlePath(trace = {}) {
  const safeTitle = safeScopeSegment(trace.title || trace.source_title || '原文回溯', 'source-trace').slice(0, 56);
  const safeId = safeScopeSegment(trace.source_slice_id || trace.trace_id || trace.bundle_path || 'trace', 'trace').slice(-40);
  return join(COMPACT_TRACE_DIR, `${safeTitle}__${safeId}.md`);
}

function renderCompactTraceMarkdown(trace = {}, memoMeta = {}) {
  const traceTags = uniqueStrings([
    ...safeArray(trace.tags, 16),
    'source-backtrace',
    buildFamilyTag(memoMeta.family)
  ], 24);
  const lines = ['---'];
  lines.push(`note_type: ${renderYamlScalar('source_backtrace')}`);
  lines.push(`trace_id: ${renderYamlScalar(trace.trace_id || trace.source_slice_id)}`);
  lines.push(`title: ${renderYamlScalar(trace.title)}`);
  lines.push(`memo_id: ${renderYamlScalar(memoMeta.memo_id)}`);
  lines.push(`memo_title: ${renderYamlScalar(memoMeta.title)}`);
  lines.push(`trace_role: ${renderYamlScalar(trace.trace_role)}`);
  lines.push(`source_packet_id: ${renderYamlScalar(trace.source_packet_id)}`);
  lines.push(`source_slice_id: ${renderYamlScalar(trace.source_slice_id)}`);
  lines.push(`source_title: ${renderYamlScalar(trace.source_title)}`);
  lines.push(`source_created_at: ${renderYamlScalar(trace.source_created_at)}`);
  lines.push(`source_ref: ${renderYamlScalar(trace.source_ref)}`);
  lines.push(renderYamlArray('tags', traceTags));
  lines.push(renderYamlArray('source_topics', safeArray(trace.source_topics, 24)));
  lines.push('---', '', `# ${safeText(trace.title, '原文回溯')}`, '');
  lines.push('## 对应记忆卡', '');
  lines.push(`- ${toObsidianLink(memoMeta.bundle_path, memoMeta.title)}`, '');
  lines.push('## 溯源标签', '');
  lines.push(`- 角色：${safeText(trace.trace_role, '关联溯源')}`);
  lines.push(`- 切片：${safeText(trace.source_slice_id, '未标注切片')}`);
  lines.push(`- 来源窗口：${safeText(trace.source_title, '未标注来源窗口')}`);
  if (safeText(trace.source_created_at)) lines.push(`- 时间：${safeText(trace.source_created_at)}`);
  if (safeText(trace.source_ref)) lines.push(`- 原始文件：\`${safeText(trace.source_ref)}\``);
  lines.push('');
  renderBulletSection(lines, '主题标签', safeArray(trace.source_topics, 24));
  renderRawSection(lines, '摘要', trace.summary_block);
  renderRawSection(lines, '原文节选', trace.excerpt_block);
  return `${lines.join('\n').trim()}\n`;
}

function buildCompactTraceFiles(cluster = [], traceMap = new Map(), compactRoot = '', memoMeta = {}) {
  const traceTargets = (Array.isArray(cluster) ? cluster : [])
    .flatMap((item) => safeArray(item.trace_links, 64).map((trace) => normalizePathValue(trace)));
  const traceIdentityMap = new Map();
  for (const bundlePath of traceTargets) {
    const trace = traceMap.get(bundlePath);
    if (!trace) continue;
    const identity = safeText(trace.source_ref || trace.source_slice_id || trace.trace_id || bundlePath);
    if (!identity || traceIdentityMap.has(identity)) continue;
    traceIdentityMap.set(identity, trace);
  }
  return Array.from(traceIdentityMap.values())
    .map((trace) => {
      const bundlePath = buildCompactTraceBundlePath(trace);
      const exportFile = join(compactRoot, bundlePath);
      return {
        kind: 'source_trace',
        title: trace.title,
        bundle_path: normalizePathValue(bundlePath),
        export_file: exportFile,
        relative_path: relativeToVault(exportFile),
        markdown: renderCompactTraceMarkdown(trace, memoMeta)
      };
    })
    .filter(Boolean);
}

function renderCompactMemoMarkdown(cluster = [], primary = {}, clusterId = '', traceFiles = []) {
  const members = Array.isArray(cluster) ? cluster : [];
  const mergedTriggers = uniqueStrings(members.flatMap((item) => safeArray(item.activation_triggers, 10)), 10);
  const mergedScenes = uniqueStrings(members.flatMap((item) => safeArray(item.scene_handles, 8)), 8);
  const mergedFacts = uniqueStrings(members.flatMap((item) => safeArray(item.recall_facts, 8)), 8);
  const mergedVoice = uniqueStrings(members.flatMap((item) => safeArray(item.voice_fingerprint, 8)), 8);
  const compactNoteLinks = (Array.isArray(traceFiles) ? traceFiles : []).map((item) => `${toObsidianLink(item.bundle_path, item.title)} · 回溯`);
  const noteTags = uniqueStrings([
    'memory-card',
    'memory-card-compact',
    buildFamilyTag(primary.family),
    buildShapeTag(primary.memory_shape)
  ], 16);
  const lines = ['---'];
  lines.push(`note_type: ${renderYamlScalar('memory_card_compact')}`);
  lines.push(`memo_id: ${renderYamlScalar(primary.memo_id)}`);
  lines.push(`title: ${renderYamlScalar(primary.title)}`);
  lines.push(`family: ${renderYamlScalar(primary.family)}`);
  lines.push(`memory_shape: ${renderYamlScalar(primary.memory_shape)}`);
  lines.push(`shape_label: ${renderYamlScalar(primary.shape_label)}`);
  lines.push(`generated_at: ${renderYamlScalar(primary.generated_at)}`);
  lines.push(`compact_cluster_id: ${renderYamlScalar(clusterId)}`);
  lines.push(`compact_member_count: ${renderYamlScalar(String(members.length))}`);
  lines.push(renderYamlArray('tags', noteTags));
  lines.push(renderYamlArray('activation_triggers', mergedTriggers));
  lines.push(renderYamlArray('voice_fingerprint', mergedVoice));
  lines.push('---', '', `# ${primary.title}`, '');

  if (primary.inject_short) {
    lines.push(`> ${primary.inject_short}`, '');
  }

  renderRawSection(lines, '记忆类型', primary.memory_type_block);
  lines.push('## 整编说明', '');
  lines.push(`- 这张主记忆收起了 ${Math.max(0, members.length - 1)} 张近邻卡。`);
  lines.push(`- 整编簇编号：${clusterId}`);
  lines.push(`- 保留策略：优先留下正文更完整、回溯更扎实的那张，其他近邻卡收进下面这一栏。`, '');

  lines.push('## 记忆正文', '');
  lines.push(primary.snapshot || '（这张整编卡还没有拿到可读正文。）', '');

  if (primary.context) {
    lines.push('## 触发场景', '');
    lines.push(primary.context, '');
  }

  renderRawSection(lines, '适合召回', primary.recall_when_block);
  renderRawSection(lines, '关系意义', primary.relationship_meaning_block);
  renderBulletSection(lines, '场景锚点', mergedScenes);
  renderBulletSection(lines, '事实锚点', mergedFacts);
  renderBulletSection(lines, '召回线索', mergedTriggers);
  renderBulletSection(lines, '语气指纹', mergedVoice);
  renderBulletSection(lines, '收起的近邻记忆', summarizeClusterMembers(members, primary));
  renderBulletSection(lines, '原文回溯', compactNoteLinks);
  return `${lines.join('\n').trim()}\n`;
}

function renderCompactIndexMarkdown({
  ownerId = '',
  realmId = '',
  rawMemoCount = 0,
  clusterRecords = []
} = {}) {
  const records = Array.isArray(clusterRecords) ? clusterRecords : [];
  const lines = ['---'];
  lines.push(`note_type: ${renderYamlScalar('compact_export_index')}`);
  lines.push(`title: ${renderYamlScalar('记忆整编导览')}`);
  lines.push(`scope_owner: ${renderYamlScalar(ownerId)}`);
  lines.push(`scope_realm: ${renderYamlScalar(realmId)}`);
  lines.push(renderYamlArray('tags', ['compact-export-index']));
  lines.push('---', '', '# 记忆整编导览', '');
  lines.push(`- 工作台：${ownerId || 'default-owner'} / ${realmId || 'default'}`);
  lines.push(`- 原始记忆卡：${rawMemoCount} 张`);
  lines.push(`- 整编后主记忆：${records.length} 张`);
  lines.push(`- 折叠近邻卡：${Math.max(0, rawMemoCount - records.length)} 张`, '');

  const groups = new Map();
  for (const item of records) {
    const key = safeText(item.shape_label, '事件切片');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  lines.push('## 主记忆卡', '');
  for (const [shapeLabel, items] of groups.entries()) {
    lines.push(`### ${shapeLabel}`, '');
    for (const item of items) {
      const cueLine = item.shared_cues.length ? ` · ${item.shared_cues.slice(0, 2).join(' / ')}` : '';
      lines.push(`- ${toObsidianLink(item.bundle_path, item.title)} · 覆盖 ${item.member_count} 张原始卡${cueLine}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

async function writeBundleFiles(files = [], overwrite = true) {
  for (const item of Array.isArray(files) ? files : []) {
    const nextContent = `${String(item.markdown || '').replace(/\s+$/u, '')}\n`;
    if (!overwrite) {
      const existing = await readUtf8IfExists(item.export_file);
      if (existing !== null && existing !== nextContent) {
        return {
          ok: false,
          error: 'Compact export target already exists',
          conflict: {
            title: item.title,
            export_file: item.export_file,
            bundle_path: item.bundle_path
          }
        };
      }
    }
  }
  for (const item of Array.isArray(files) ? files : []) {
    await ensureParent(item.export_file);
    await writeFile(item.export_file, `${String(item.markdown || '').replace(/\s+$/u, '')}\n`, 'utf-8');
  }
  return { ok: true };
}

async function clearCompactBundleDirs(rootDir = '') {
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(join(rootDir, COMPACT_INDEX_DIR), { recursive: true });
  await mkdir(join(rootDir, COMPACT_MEMO_DIR), { recursive: true });
  await mkdir(join(rootDir, COMPACT_TRACE_DIR), { recursive: true });
}

function buildCompactionSnapshotFromNotes(notes = [], traceMap = new Map(), ownerId = '', realmId = '', rawRoot = '', compactRoot = '') {
  const descriptors = notes.map((item) => buildMemoDescriptor(item));
  const clusters = buildClusterList(descriptors);
  const records = clusters.map((cluster, index) => {
    const primary = chooseClusterPrimary(cluster);
    const clusterId = `compact_${String(index + 1).padStart(3, '0')}`;
    const compactBundlePath = buildCompactMemoBundlePath(primary, clusterId);
    const sharedCues = buildSharedCueList(cluster);
    const traceTargets = uniqueStrings(cluster.flatMap((item) => safeArray(item.trace_links, 64)), 4096);
    return {
      cluster_id: clusterId,
      shape_label: safeText(primary?.shape_label, '事件切片'),
      memory_shape: safeText(primary?.memory_shape, 'scene_event'),
      member_count: cluster.length,
      raw_member_count: cluster.length,
      primary_memo_id: safeText(primary?.memo_id),
      title: safeText(primary?.title, '未命名主记忆'),
      preview: clipText(primary?.snapshot || primary?.inject_short, 88),
      generated_at: safeText(primary?.generated_at),
      family: safeText(primary?.family),
      bundle_path: normalizePathValue(compactBundlePath),
      export_file: join(compactRoot, compactBundlePath),
      raw_bundle_path: safeText(primary?.bundle_path),
      raw_export_file: safeText(primary?.export_file),
      raw: primary?.raw || '',
      memory_type_block: primary?.memory_type_block || '',
      recall_when_block: primary?.recall_when_block || '',
      relationship_meaning_block: primary?.relationship_meaning_block || '',
      primary_note: primary,
      members: cluster.map((item) => ({
        memo_id: safeText(item.memo_id),
        title: safeText(item.title),
        preview: clipText(item.snapshot || item.inject_short, 88),
        bundle_path: safeText(item.bundle_path),
        trace_count: item.trace_set?.size || 0,
        is_primary: item.bundle_path === primary?.bundle_path
      })),
      shared_cues: sharedCues,
      trace_targets: traceTargets,
      trace_count: traceTargets.length
    };
  });
  return {
    ok: true,
    schema: 'memo_compaction_packet_v0.1',
    scope: {
      owner_id: safeText(ownerId),
      realm_id: safeText(realmId, 'default')
    },
    raw_root: rawRoot,
    compact_root: compactRoot,
    raw_memo_count: notes.length,
    raw_source_note_count: traceMap.size,
    compact_memo_count: records.length,
    reduced_count: Math.max(0, notes.length - records.length),
    clusters: records
  };
}

export async function buildMemoCompactionPacket({
  ownerId = '',
  realmId = '',
  rootDir = ''
} = {}) {
  const ensured = await ensureRawBundle({ ownerId, realmId, rootDir });
  if (!ensured?.ok) return ensured;
  const rawRoot = safeText(ensured.raw_root);
  const compactRoot = buildCompactBundleRoot(ownerId, realmId, rootDir);
  const loaded = await loadRawBundleNotes(rawRoot);
  return buildCompactionSnapshotFromNotes(
    loaded.memo_notes,
    loaded.trace_map,
    ownerId,
    realmId,
    rawRoot,
    compactRoot
  );
}

export async function exportMemoCompactBundle({
  ownerId = '',
  realmId = '',
  rootDir = '',
  overwrite = true,
  includeContent = false
} = {}) {
  const packet = await buildMemoCompactionPacket({ ownerId, realmId, rootDir });
  if (!packet?.ok) return packet;
  const loaded = await loadRawBundleNotes(packet.raw_root);
  const traceMap = loaded.trace_map;
  const compactRoot = safeText(packet.compact_root);
  if (overwrite) {
    await clearCompactBundleDirs(compactRoot);
  }
  const files = [];
  for (const cluster of packet.clusters) {
    const noteObjects = cluster.members
      .map((member) => loaded.memo_notes.find((item) => item.memo_id === member.memo_id && item.bundle_path === member.bundle_path))
      .filter(Boolean);
    const traceFiles = buildCompactTraceFiles(
      noteObjects,
      traceMap,
      compactRoot,
      {
        memo_id: cluster.primary_memo_id,
        title: cluster.title,
        family: cluster.family,
        bundle_path: cluster.bundle_path
      }
    );
    const markdown = renderCompactMemoMarkdown(noteObjects, cluster.primary_note, cluster.cluster_id, traceFiles);
    files.push({
      kind: 'memo',
      title: cluster.title,
      memo_id: cluster.primary_memo_id,
      cluster_id: cluster.cluster_id,
      export_file: cluster.export_file,
      relative_path: relativeToVault(cluster.export_file),
      bundle_path: cluster.bundle_path,
      markdown
    });
    traceFiles.forEach((item) => files.push(item));
  }
  const indexMarkdown = renderCompactIndexMarkdown({
    ownerId,
    realmId,
    rawMemoCount: packet.raw_memo_count,
    clusterRecords: packet.clusters
  });
  const indexBundlePath = join(COMPACT_INDEX_DIR, '记忆整编导览.md');
  const indexFile = join(compactRoot, indexBundlePath);
  files.push({
    kind: 'index',
    title: '记忆整编导览',
    export_file: indexFile,
    relative_path: relativeToVault(indexFile),
    bundle_path: normalizePathValue(indexBundlePath),
    markdown: indexMarkdown
  });
  const dedupedFiles = [];
  const seen = new Set();
  for (const item of files) {
    const key = normalizePathValue(item.bundle_path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedupedFiles.push(item);
  }
  const writeResult = await writeBundleFiles(dedupedFiles, overwrite);
  if (!writeResult.ok) {
    return {
      ok: false,
      error: writeResult.error,
      conflict: writeResult.conflict,
      raw_root: packet.raw_root,
      compact_root: compactRoot
    };
  }
  return {
    ok: true,
    schema: 'memo_compact_bundle_v0.1',
    scope: packet.scope,
    raw_root: packet.raw_root,
    compact_root: compactRoot,
    raw_memo_count: packet.raw_memo_count,
    raw_source_note_count: packet.raw_source_note_count,
    compact_memo_count: packet.compact_memo_count,
    reduced_count: packet.reduced_count,
    bundle_name: `${safeScopeSegment(realmId || 'growth', 'growth')}-obsidian-compact-md-bundle.zip`,
    files: dedupedFiles.map((item) => ({
      ...item,
      markdown: includeContent ? item.markdown : undefined
    })),
    clusters: packet.clusters.map((item) => ({
      cluster_id: item.cluster_id,
      title: item.title,
      shape_label: item.shape_label,
      member_count: item.member_count,
      shared_cues: item.shared_cues,
      bundle_path: item.bundle_path
    }))
  };
}
