import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { getScopedGrowthDraftDir, safeScopeSegment } from './path-config.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeTitleSeed(value = '') {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[\s…，。、“”"'()（）【】\-_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(value = '', limit = 24) {
  const text = normalizeTitleSeed(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function buildArtifactId({ cardType = 'memo', familyId = '', title = '', taskId = '' } = {}) {
  return [
    safeScopeSegment(cardType, 'memo'),
    safeScopeSegment(familyId, 'general').slice(0, 24),
    safeScopeSegment(title || taskId, 'draft').slice(0, 48),
    nowStamp()
  ].join('_');
}

async function writeUtf8(filePath, text = '') {
  await writeFile(filePath, String(text || ''), 'utf-8');
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
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

function buildDraftSummary(doc = {}, fileInfo = {}) {
  const draft = doc?.draft || {};
  const task = doc?.task || {};
  const rawTitle = safeText(draft?.frontmatter?.title || draft?.card_entry?.title, '未命名草稿');
  const sourcePacketId = safeText(draft?.frontmatter?.source_packet_id || draft?.card_entry?.source_packet_id);
  const sourceFocus = safeText(task?.source_focus || task?.query || task?.key);
  const primarySummary = draft?.source_review?.primary_evidence?.summary || {};
  const relatedSummary = draft?.source_review?.related_evidence?.summary || {};
  const evidenceCount = Number(primarySummary?.persona?.count || 0)
    + Number(primarySummary?.sql?.count || 0)
    + Number(primarySummary?.source?.count || 0)
    + Number(relatedSummary?.persona?.count || 0)
    + Number(relatedSummary?.sql?.count || 0)
    + Number(relatedSummary?.source?.count || 0);
  const derivedTitle = (() => {
    if (rawTitle && rawTitle !== 'workspace_only') return rawTitle;
    const candidates = [
      draft?.frontmatter?.inject_short,
      draft?.body?.snapshot,
      draft?.card_entry?.summary_for_growth,
      sourceFocus
    ];
    for (const candidate of candidates) {
      const clipped = clipText(candidate, 26);
      if (clipped && clipped !== 'workspace_only') return clipped;
    }
    return rawTitle || '未命名草稿';
  })();
  const staleWorkspaceOnly = (
    (rawTitle === 'workspace_only' || sourceFocus === 'workspace_only')
    && !sourcePacketId
    && evidenceCount === 0
  );
  return {
    artifact_id: safeText(fileInfo.artifact_id),
    generated_at: safeText(doc?.generated_at),
    card_type: safeText(task?.card_type || draft?.card_entry?.card_type, 'memo'),
    family_id: safeText(draft?.frontmatter?.family || draft?.card_entry?.family_id, 'unassigned'),
    title: derivedTitle,
    raw_title: rawTitle,
    summary_for_growth: safeText(
      draft?.card_entry?.summary_for_growth
      || draft?.frontmatter?.inject_short
      || draft?.body?.snapshot
    ),
    inject_short: safeText(draft?.frontmatter?.inject_short),
    snapshot: safeText(draft?.body?.snapshot),
    source_focus: sourceFocus,
    source_packet_id: sourcePacketId,
    evidence_count: evidenceCount,
    stale_workspace_only: staleWorkspaceOnly,
    decision: safeText(draft?.decision),
    reason: safeText(draft?.reason),
    target_card_id: safeText(draft?.target_card_id || draft?.card_entry?.card_id),
    markdown_file: safeText(fileInfo.markdown_file),
    json_file: safeText(fileInfo.json_file)
  };
}

export async function saveGrowthDraftArtifact({
  ownerId = '',
  realmId = '',
  cardType = 'memo',
  familyId = '',
  task = {},
  draft = {},
  api = {}
} = {}) {
  const artifactId = buildArtifactId({
    cardType,
    familyId,
    title: draft?.frontmatter?.title || draft?.target_card_id || '',
    taskId: task?.task_id || ''
  });
  const baseDir = join(
    getScopedGrowthDraftDir(ownerId, realmId),
    safeScopeSegment(cardType, 'memo')
  );
  await mkdir(baseDir, { recursive: true });

  const markdownFile = join(baseDir, `${artifactId}.md`);
  const jsonFile = join(baseDir, `${artifactId}.json`);
  const markdown = safeText(draft?.markdown);
  const payload = {
    schema: 'growth_draft_artifact_v0.1',
    generated_at: new Date().toISOString(),
    scope: {
      owner_id: safeText(ownerId),
      realm_id: safeText(realmId, 'default')
    },
    task,
    api,
    draft
  };

  await writeUtf8(markdownFile, markdown ? `${markdown}\n` : '');
  await writeUtf8(jsonFile, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    ok: true,
    artifact_id: artifactId,
    dir: baseDir,
    markdown_file: markdownFile,
    json_file: jsonFile
  };
}

export async function listGrowthDraftArtifacts({
  ownerId = '',
  realmId = '',
  cardType = '',
  limit = 12
} = {}) {
  const baseDir = getScopedGrowthDraftDir(ownerId, realmId);
  const typeDirs = cardType
    ? [{ name: safeScopeSegment(cardType, 'memo'), isDirectory: () => true }]
    : await safeReaddir(baseDir);

  const rows = [];
  for (const dirent of typeDirs) {
    if (!dirent?.isDirectory?.()) continue;
    const currentDir = join(baseDir, dirent.name);
    const children = await safeReaddir(currentDir);
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith('.json')) continue;
      const artifactId = child.name.slice(0, -5);
      const jsonFile = join(currentDir, child.name);
      const markdownFile = join(currentDir, `${artifactId}.md`);
      const doc = await readJsonIfExists(jsonFile, null);
      if (!doc) continue;
      rows.push(buildDraftSummary(doc, {
        artifact_id: artifactId,
        json_file: jsonFile,
        markdown_file: markdownFile
      }));
    }
  }

  rows.sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')));
  return {
    ok: true,
    schema: 'growth_draft_catalog_v0.1',
    scope: {
      owner_id: safeText(ownerId),
      realm_id: safeText(realmId, 'default')
    },
    total: rows.length,
    drafts: rows.slice(0, Math.max(1, Number(limit || 12)))
  };
}

export async function getGrowthDraftArtifact({
  ownerId = '',
  realmId = '',
  cardType = 'memo',
  artifactId = ''
} = {}) {
  const normalizedCardType = safeScopeSegment(cardType, 'memo');
  const safeArtifactId = safeText(artifactId);
  if (!safeArtifactId) {
    throw new Error('artifactId is required');
  }
  const baseDir = join(getScopedGrowthDraftDir(ownerId, realmId), normalizedCardType);
  const jsonFile = join(baseDir, `${safeArtifactId}.json`);
  const markdownFile = join(baseDir, `${safeArtifactId}.md`);
  const doc = await readJsonIfExists(jsonFile, null);
  if (!doc) {
    return {
      ok: false,
      error: 'Growth draft not found',
      scope: {
        owner_id: safeText(ownerId),
        realm_id: safeText(realmId, 'default')
      },
      artifact_id: safeArtifactId
    };
  }
  let markdown = '';
  try {
    markdown = await readFile(markdownFile, 'utf-8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    ok: true,
    schema: 'growth_draft_artifact_v0.1',
    artifact_id: safeArtifactId,
    generated_at: safeText(doc?.generated_at),
    scope: doc.scope || {
      owner_id: safeText(ownerId),
      realm_id: safeText(realmId, 'default')
    },
    task: doc.task || {},
    api: doc.api || {},
    draft: doc.draft || {},
    markdown,
    markdown_file: markdownFile,
    json_file: jsonFile
  };
}

export async function updateGrowthDraftHumanReview({
  ownerId = '',
  realmId = '',
  cardType = 'memo',
  artifactId = '',
  review = {}
} = {}) {
  const normalizedCardType = safeScopeSegment(cardType, 'memo');
  const safeArtifactId = safeText(artifactId);
  if (!safeArtifactId) throw new Error('artifactId is required');
  const baseDir = join(getScopedGrowthDraftDir(ownerId, realmId), normalizedCardType);
  const jsonFile = join(baseDir, `${safeArtifactId}.json`);
  const doc = await readJsonIfExists(jsonFile, null);
  if (!doc) {
    return {
      ok: false,
      error: 'Growth draft not found',
      artifact_id: safeArtifactId
    };
  }
  const next = {
    ...doc,
    human_review: {
      merge_target_card_id: safeText(review?.merge_target_card_id || review?.mergeTargetCardId),
      merge_target_title: safeText(review?.merge_target_title || review?.mergeTargetTitle),
      include_source_refs: Array.isArray(review?.include_source_refs)
        ? review.include_source_refs.map((item) => safeText(item)).filter(Boolean)
        : [],
      include_related_refs: Array.isArray(review?.include_related_refs)
        ? review.include_related_refs.map((item) => safeText(item)).filter(Boolean)
        : [],
      note: safeText(review?.note),
      updated_at: new Date().toISOString()
    }
  };
  await writeUtf8(jsonFile, `${JSON.stringify(next, null, 2)}\n`);
  return {
    ok: true,
    artifact_id: safeArtifactId,
    human_review: next.human_review,
    json_file: jsonFile
  };
}

export async function clearGrowthDraftArtifacts({
  ownerId = '',
  realmId = '',
  cardType = ''
} = {}) {
  const before = await listGrowthDraftArtifacts({
    ownerId,
    realmId,
    cardType,
    limit: 10000
  });
  const targetDir = cardType
    ? join(getScopedGrowthDraftDir(ownerId, realmId), safeScopeSegment(cardType, 'memo'))
    : getScopedGrowthDraftDir(ownerId, realmId);
  await rm(targetDir, { recursive: true, force: true });
  return {
    ok: true,
    scope: {
      owner_id: safeText(ownerId),
      realm_id: safeText(realmId, 'default')
    },
    card_type: safeText(cardType),
    cleared_count: Number(before?.total || 0)
  };
}
