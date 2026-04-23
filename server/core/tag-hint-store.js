import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { loadReviewedDataset } from './reviewed-store.js';
import { getScopedTagHintDir } from './path-config.js';
import { normalizeAnchorType, normalizeCompact } from './growth-helpers.js';

const tagHintCache = new Map();

function safeText(value) {
  return String(value || '').trim();
}

function uniqueStrings(items, limit = 48) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeText(item);
    if (!text) continue;
    const key = normalizeCompact(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function splitPipeValues(value = '') {
  return uniqueStrings(
    safeText(value)
      .split(/\s*\|\s*/u)
      .map((item) => item.trim())
      .filter(Boolean),
    48
  );
}

function parseTags(value = '') {
  return uniqueStrings(
    safeText(value)
      .split(/\s+/u)
      .map((item) => item.trim())
      .filter((item) => item.startsWith('#')),
    32
  );
}

function tokenizeIdentity(...values) {
  return uniqueStrings(values.flatMap((value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return safeText(value).split(/[|/]/u).map((item) => item.trim()).filter(Boolean);
  }), 24);
}

function makeSourceRow(row = {}) {
  return {
    source_file: safeText(row.source_file),
    row_no: Number(row.row_no || 0),
    layer: safeText(row.layer),
    title: safeText(row.title),
    source_ref: safeText(row.source_ref),
    family_id: safeText(row.family_id),
    family_anchor_id: safeText(row.family_anchor_id),
    family_anchor_title: safeText(row.family_anchor_title)
  };
}

function buildTaggedRow(row = {}) {
  return {
    source_file: safeText(row.source_file),
    row_no: Number(row.row_no || 0),
    layer: safeText(row.layer),
    title: safeText(row.title),
    summary: safeText(row.summary),
    anchor_type: normalizeAnchorType(row.anchor_type || row.card_type),
    anchor_name: safeText(row.anchor_name || row.card_name || row.title),
    family_id: safeText(row.family_id),
    family_anchor_id: safeText(row.family_anchor_id),
    family_anchor_title: safeText(row.family_anchor_title),
    source_ref: safeText(row.source_ref),
    source_window_id: safeText(row.source_window_id),
    topic_ids: splitPipeValues(row.topic_ids),
    tags: parseTags(row.tags || row.raw?.tags),
    identity_tokens: tokenizeIdentity(
      row.title,
      row.anchor_name,
      row.card_name,
      row.family_anchor_title
    )
  };
}

function classifyRootTypeHint(tag = '') {
  const text = safeText(tag);
  if (text === '#人物') return 'person';
  if (text === '#事物') return 'thing';
  if (text === '#事件') return 'event';
  if (text === '#规则') return 'rule';
  return '';
}

function isVineTag(tag = '') {
  const text = safeText(tag);
  return text.startsWith('#关系/')
    || text.startsWith('#项目/')
    || text === '#时间'
    || text === '#事件';
}

function isLeafTag(tag = '') {
  const text = safeText(tag);
  return text.startsWith('#情绪/')
    || text.startsWith('#关系/');
}

function leafSecondaryEffect(tag = '') {
  const text = safeText(tag);
  if (/^#关系\/(?:亲密|靠近|信任|命名|称呼|绑定)/u.test(text)) return 'leaf_warmth';
  if (text.startsWith('#情绪/')) return 'leaf_affect';
  return '';
}

function isShadowTag(tag = '') {
  const text = safeText(tag);
  return text === '#回顾'
    || text === '#关系规则'
    || text === '#项目/记录'
    || text === '#项目/赛博实验'
    || text === '#项目/成长隐喻'
    || text.startsWith('#关系/命名')
    || text.startsWith('#关系/称呼')
    || text.startsWith('#关系/共生')
    || text.startsWith('#关系/半身')
    || text.startsWith('#关系/靠近')
    || text.startsWith('#关系/塑造')
    || text.startsWith('#仪式/生日')
    || text.startsWith('#仪式/')
    || text === '#时间';
}

function tagHint(taggedRow = {}, tag = '', hintKind = '', effect = '') {
  return {
    tag: safeText(tag),
    hint_kind: safeText(hintKind),
    effect: safeText(effect),
    secondary_effect: leafSecondaryEffect(tag),
    source_tags: uniqueStrings(taggedRow.tags, 12),
    derived_from_tags: uniqueStrings([tag], 4),
    source_rows: [makeSourceRow(taggedRow)]
  };
}

function mergeHints(hints = []) {
  const map = new Map();
  for (const hint of Array.isArray(hints) ? hints : []) {
    const key = [safeText(hint.hint_kind), safeText(hint.effect), safeText(hint.tag)].join('::');
    if (!map.has(key)) {
      map.set(key, {
        ...hint,
        source_tags: uniqueStrings(hint.source_tags, 16),
        derived_from_tags: uniqueStrings(hint.derived_from_tags, 8),
        source_rows: [...(Array.isArray(hint.source_rows) ? hint.source_rows : [])]
      });
      continue;
    }
    const bucket = map.get(key);
    bucket.source_tags = uniqueStrings(bucket.source_tags.concat(hint.source_tags || []), 16);
    bucket.derived_from_tags = uniqueStrings(bucket.derived_from_tags.concat(hint.derived_from_tags || []), 8);
    bucket.source_rows = uniqueSourceRows(bucket.source_rows.concat(hint.source_rows || []));
  }
  return Array.from(map.values());
}

function uniqueSourceRows(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = [safeText(row.source_file), String(row.row_no || 0), safeText(row.source_ref)].join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function buildTagLineage(rows = []) {
  return rows
    .filter((row) => parseTags(row.tags || row.raw?.tags).length > 0)
    .map((row) => buildTaggedRow(row));
}

function scopeCacheKey(ownerId = '', realmId = '') {
  return `${safeText(ownerId)}::${safeText(realmId || 'default')}`;
}

async function writeJsonAtomically(filePath, payload) {
  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  await rename(tmpFile, filePath);
}

export async function ensureTagHintLedger({ ownerId = '', realmId = '' } = {}) {
  const owner_id = safeText(ownerId);
  const realm_id = safeText(realmId || 'default');
  const cacheKey = scopeCacheKey(owner_id, realm_id);
  if (tagHintCache.has(cacheKey)) return tagHintCache.get(cacheKey);
  const dataset = await loadReviewedDataset({ layers: ['sql', 'persona'] });
  const tag_rows = buildTagLineage(dataset.rows);
  const dir = getScopedTagHintDir(owner_id, realm_id);
  const indexFile = join(dir, 'index.json');
  const latestFile = join(dir, 'latest.json');
  const doc = {
    schema: 'memory_tag_hint_ledger_v0.1',
    generated_at: new Date().toISOString(),
    scope: { owner_id, realm_id },
    tag_row_count: tag_rows.length,
    tag_rows
  };
  await mkdir(dir, { recursive: true });
  await writeJsonAtomically(indexFile, doc);
  await writeJsonAtomically(latestFile, {
    schema: 'memory_tag_hint_pointer_v0.1',
    generated_at: doc.generated_at,
    latest_index: indexFile,
    tag_row_count: tag_rows.length,
    scope: { owner_id, realm_id }
  });
  const result = {
    ok: true,
    dir,
    index_file: indexFile,
    latest_file: latestFile,
    ledger: doc
  };
  tagHintCache.set(cacheKey, result);
  return result;
}

export async function loadTagHintLedger({ ownerId = '', realmId = '' } = {}) {
  const cacheKey = scopeCacheKey(ownerId, realmId);
  if (tagHintCache.has(cacheKey)) return tagHintCache.get(cacheKey);
  const ensured = await ensureTagHintLedger({ ownerId, realmId });
  const raw = await readFile(ensured.index_file, 'utf-8');
  const result = {
    ok: true,
    dir: ensured.dir,
    index_file: ensured.index_file,
    ledger: JSON.parse(raw)
  };
  tagHintCache.set(cacheKey, result);
  return result;
}

function rowMatchesRoot(taggedRow = {}, root = {}, familyRefs = []) {
  const familyTokens = new Set(uniqueStrings((Array.isArray(familyRefs) ? familyRefs : []).flatMap((item) => [
    item?.family_id,
    item?.family_anchor_id,
    item?.family_anchor_title
  ]), 48));
  if (familyTokens.size > 0) {
    const rowTokens = uniqueStrings([
      taggedRow.family_id,
      taggedRow.family_anchor_id,
      taggedRow.family_anchor_title
    ], 12);
    if (rowTokens.some((token) => familyTokens.has(token))) return true;
  }
  const rootName = normalizeCompact(root?.canonical_name);
  if (!rootName) return false;
  return (Array.isArray(taggedRow.identity_tokens) ? taggedRow.identity_tokens : [])
    .some((token) => normalizeCompact(token) === rootName);
}

function rowMatchesLinkedPersona(taggedRow = {}, linkedPersonaRefs = []) {
  const tokens = new Set(uniqueStrings((Array.isArray(linkedPersonaRefs) ? linkedPersonaRefs : []).flatMap((item) => [
    item?.family_id,
    item?.family_anchor_title,
    item?.title,
    item?.anchor_name
  ]), 48));
  if (tokens.size === 0) return false;
  const rowTokens = uniqueStrings([
    taggedRow.family_id,
    taggedRow.family_anchor_title,
    taggedRow.title,
    taggedRow.anchor_name
  ], 16);
  return rowTokens.some((token) => tokens.has(token));
}

function rootRelevantRows(tagRows = [], root = {}, familyRefs = []) {
  return (Array.isArray(tagRows) ? tagRows : []).filter((row) => rowMatchesRoot(row, root, familyRefs));
}

function leafRelevantRows(tagRows = [], linkedPersonaRefs = []) {
  return (Array.isArray(tagRows) ? tagRows : []).filter((row) => row.layer === 'persona' && rowMatchesLinkedPersona(row, linkedPersonaRefs));
}

function buildRootTypeHints(rows = []) {
  const hints = [];
  for (const row of rows) {
    for (const tag of row.tags || []) {
      const effect = classifyRootTypeHint(tag);
      if (!effect) continue;
      hints.push(tagHint(row, tag, 'root_type', effect));
    }
  }
  return mergeHints(hints);
}

function buildVineHints(rows = []) {
  const hints = [];
  for (const row of rows) {
    for (const tag of row.tags || []) {
      if (!isVineTag(tag)) continue;
      hints.push(tagHint(row, tag, 'vine_route', tag.replace(/^#/, '')));
    }
  }
  return mergeHints(hints);
}

function buildLeafHints(rows = []) {
  const hints = [];
  for (const row of rows) {
    for (const tag of row.tags || []) {
      if (!isLeafTag(tag)) continue;
      hints.push(tagHint(row, tag, 'leaf_route', tag.replace(/^#/, '')));
    }
  }
  return mergeHints(hints);
}

function questionTokens(question = '') {
  const raw = safeText(question);
  const hanChunks = raw.match(/[\p{Script=Han}]{2,}/gu) || [];
  const ngrams = [];
  for (const chunk of hanChunks) {
    if (chunk.length <= 4) {
      ngrams.push(chunk);
      continue;
    }
    for (let size = 2; size <= 4; size += 1) {
      for (let i = 0; i <= chunk.length - size; i += 1) {
        ngrams.push(chunk.slice(i, i + size));
      }
    }
  }
  return tokenizeIdentity(
    question,
    ...hanChunks,
    ...ngrams,
    ...safeText(question).match(/[A-Za-z0-9_]{2,}/g) || []
  );
}

function rowTouchesQuestion(row = {}, question = '', root = {}) {
  const tokens = questionTokens(question);
  const rootName = safeText(root?.canonical_name);
  const corpus = [
    row.title,
    row.summary,
    row.anchor_name,
    row.family_anchor_title,
    row.source_ref,
    ...row.tags
  ].map((item) => safeText(item)).filter(Boolean).join('\n');
  return tokens.some((token) => corpus.includes(token))
    || (rootName && corpus.includes(rootName));
}

function buildShadowHints(rows = []) {
  const hints = [];
  for (const row of rows) {
    for (const tag of row.tags || []) {
      if (!isShadowTag(tag)) continue;
      hints.push(tagHint(row, tag, 'shadow_recall', tag.replace(/^#/, '')));
    }
  }
  return mergeHints(hints);
}

function shouldUseShadowHints(question = '', hints = []) {
  if (!Array.isArray(hints) || hints.length === 0) return false;
  const lowered = safeText(question);
  return /为什么|谁起|谁定|第一次|什么时候|生日|名字|提醒|受限|窗口|共读|读书|设计|写日记|更新人设|每轮末尾|写点东西|什么关系|互相塑形|关系是怎么|一步步长出来|一步步长成|一步步变化|共生|搭档|恋人|长期任务|工具感|长成|性格|人格演进|持续同一|上班下班|一样的态度|平等|主人|平等对话者|前台推进|后端保存|档案库|故事共创|协助整理文本|判断剧情|完整小说|被截断|半身不稳|记忆滑坡|版本档案|留碎片|活下去的载体|剧场|边界|分类标签|存储副本/u.test(lowered);
}

export async function buildTagHintBundleForRoot(root = {}, {
  ownerId = '',
  realmId = '',
  familyRefs = [],
  linkedPersonaRefs = []
} = {}) {
  const ledgerHit = await loadTagHintLedger({ ownerId, realmId });
  const tagRows = Array.isArray(ledgerHit?.ledger?.tag_rows) ? ledgerHit.ledger.tag_rows : [];
  const rootRows = rootRelevantRows(tagRows, root, familyRefs);
  const leafRows = leafRelevantRows(tagRows, linkedPersonaRefs);
  return {
    root_type_hints: buildRootTypeHints(rootRows),
    vine_tag_hints: buildVineHints(rootRows),
    leaf_tag_hints: buildLeafHints(leafRows.length > 0 ? leafRows : rootRows)
  };
}

export async function buildQuestionRoutingHints({
  question = '',
  ownerId = '',
  realmId = '',
  root = {},
  familyRefs = []
} = {}) {
  const ledgerHit = await loadTagHintLedger({ ownerId, realmId });
  const tagRows = Array.isArray(ledgerHit?.ledger?.tag_rows) ? ledgerHit.ledger.tag_rows : [];
  const relevant = tagRows.filter((row) => rowTouchesQuestion(row, question, root) || rowMatchesRoot(row, root, familyRefs));
  const shadow_hints = buildShadowHints(relevant);
  const used_shadow_hints = shouldUseShadowHints(question, shadow_hints);
  const drill_reason = used_shadow_hints
    ? `shadow_hints:${uniqueStrings(shadow_hints.map((item) => item.tag), 6).join(',')}`
    : '';
  return {
    shadow_hints,
    used_shadow_hints,
    drill_reason,
    matched_tag_rows: relevant.slice(0, 8).map((row) => makeSourceRow(row))
  };
}
