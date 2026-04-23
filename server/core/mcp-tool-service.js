import { readFile } from 'fs/promises';
import { basename, resolve } from 'path';
import { ingestMemoryEnvelope } from './memory-ingest-service.js';
import { buildTranslationPacket } from './memory-translation-service.js';
import { failAiTranslationTask, prepareAiTranslationTasks } from './memory-translation-ai-service.js';
import { runRuntimeAiTranslationTask, runRuntimeReviewedMerge } from './memory-runtime-ai-service.js';
import { finalizeRuntimeReviewedEntries, getRuntimeReviewedClusters, appendRuntimeReviewedEntries } from './memory-reviewed-service.js';
import { getMemoryHomePacket } from './memory-home-service.js';
import { getMemoryContextPacket } from './memory-context-service.js';
import { getGrowthContextPacket } from './growth-context-service.js';
import { buildGrowthTaskPacket } from './growth-task-service.js';
import { generateGrowthDraft } from './growth-generate-service.js';
import { getCardRegistrySnapshot, upsertCardRegistryEntry } from './card-registry-service.js';
import { appendGrowthLedgerEntry, getGrowthLedgerSnapshot } from './growth-ledger-service.js';
import { commitGrowthDecision } from './growth-commit-service.js';
import { getGrowthDraftArtifact, listGrowthDraftArtifacts } from './growth-draft-store.js';
import { exportGrowthDraftToObsidianStaging } from './obsidian-export-service.js';
import { getNextPendingTranslationWorkerPacket, getTranslationTaskWorkerPacket } from './memory-translation-task-service.js';
import {
  loadRuntimeApiConfig,
  loadRuntimeApiProfiles
} from './runtime-api-profile-store.js';
import {
  buildFingerprintCandidatePoolForWorkspace,
  generateLanguageFingerprintForWorkspace,
  generateSoulDraftForWorkspace,
  getPersonaWorkspaceSnapshot,
  savePersonaWorkspaceState
} from './persona-workspace-service.js';
import {
  getScopedIngressDir,
  getScopedReviewedDir,
  getScopedTranslationDir,
  getScopedTranslationTaskDir,
  getScopedTruthDir
} from './path-config.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function isProgrammaticMode(mode = '') {
  const text = safeText(mode, 'local_programmatic').toLowerCase();
  return text === 'local_programmatic' || text === 'mock' || text === 'programmatic';
}

function buildProgrammaticApi() {
  return {
    baseUrl: 'mock://programmatic',
    apiKey: '',
    model: 'local-programmatic'
  };
}

function sanitizeApiProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    name: safeText(profile.name),
    baseUrl: trimTrailingSlash(profile.baseUrl || ''),
    model: safeText(profile.model, 'gpt-4o-mini'),
    updated_at: safeText(profile.updated_at),
    has_api_key: Boolean(safeText(profile.apiKey))
  };
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function bundleToPlainText(bundle = []) {
  return bundle.map((windowBlock, index) => {
    const messages = Array.isArray(windowBlock?.messages) ? windowBlock.messages : [];
    const lines = messages.map((msg) => {
      const role = safeText(msg?.role || msg?.author?.role || 'unknown');
      const content = Array.isArray(msg?.content?.parts)
        ? msg.content.parts.join('\n')
        : safeText(msg?.content || msg?.text || msg?.message || '');
      return `${role}: ${content}`;
    }).filter(Boolean);
    return `## Window ${index + 1}\n${lines.join('\n')}`;
  }).join('\n\n');
}

function documentsToPlainText(documents = []) {
  return documents.map((doc, index) => {
    const content = safeText(doc?.text || doc?.content || doc?.raw_text);
    return `## Document ${index + 1}\n${content}`;
  }).join('\n\n');
}

function detectJsonInput(parsed) {
  if (Array.isArray(parsed)) {
    if (parsed.every((item) => item && Array.isArray(item.messages))) {
      const messageCount = parsed.reduce((sum, item) => sum + item.messages.length, 0);
      const plainText = bundleToPlainText(parsed);
      return {
        sourceKind: 'chat_bundle',
        sourceFormat: 'application/json',
        ingestInput: { bundle: parsed },
        plainText,
        description: `${parsed.length} 组窗口 / ${messageCount} 条消息`,
        stats: {
          bundleCount: parsed.length,
          messageCount,
          documentCount: 0,
          rawTextCount: 0,
          monthlyReady: true
        }
      };
    }
    if (parsed.every((item) => item && (typeof item.text === 'string' || typeof item.content === 'string'))) {
      const plainText = documentsToPlainText(parsed);
      return {
        sourceKind: 'document',
        sourceFormat: 'application/json',
        ingestInput: { documents: parsed },
        plainText,
        description: `${parsed.length} 条 document`,
        stats: {
          bundleCount: 0,
          messageCount: 0,
          documentCount: parsed.length,
          rawTextCount: 0,
          monthlyReady: false
        }
      };
    }
  }

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.bundle)) {
      const messageCount = parsed.bundle.reduce((sum, item) => sum + (Array.isArray(item?.messages) ? item.messages.length : 0), 0);
      return {
        sourceKind: 'chat_bundle',
        sourceFormat: 'application/json',
        ingestInput: { bundle: parsed.bundle },
        plainText: bundleToPlainText(parsed.bundle),
        description: `${parsed.bundle.length} 组窗口 / ${messageCount} 条消息`,
        stats: {
          bundleCount: parsed.bundle.length,
          messageCount,
          documentCount: 0,
          rawTextCount: 0,
          monthlyReady: true
        }
      };
    }
    if (Array.isArray(parsed.documents)) {
      return {
        sourceKind: 'document',
        sourceFormat: 'application/json',
        ingestInput: { documents: parsed.documents },
        plainText: documentsToPlainText(parsed.documents),
        description: `${parsed.documents.length} 条 document`,
        stats: {
          bundleCount: 0,
          messageCount: 0,
          documentCount: parsed.documents.length,
          rawTextCount: 0,
          monthlyReady: false
        }
      };
    }
    if (Array.isArray(parsed.messages)) {
      return {
        sourceKind: 'chat_bundle',
        sourceFormat: 'application/json',
        ingestInput: { bundle: [parsed] },
        plainText: bundleToPlainText([parsed]),
        description: `1 组窗口 / ${parsed.messages.length} 条消息`,
        stats: {
          bundleCount: 1,
          messageCount: parsed.messages.length,
          documentCount: 0,
          rawTextCount: 0,
          monthlyReady: true
        }
      };
    }
    if (typeof parsed.raw_text === 'string' || typeof parsed.text === 'string' || typeof parsed.content === 'string') {
      const raw = safeText(parsed.raw_text || parsed.text || parsed.content);
      return {
        sourceKind: 'document',
        sourceFormat: 'application/json',
        ingestInput: { raw_text: raw },
        plainText: raw,
        description: `${raw.length} chars`,
        stats: {
          bundleCount: 0,
          messageCount: 0,
          documentCount: 0,
          rawTextCount: 1,
          monthlyReady: false
        }
      };
    }
  }

  return null;
}

async function normalizeSingleInputFile(filePath) {
  const fullPath = resolve(filePath);
  const name = basename(fullPath);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const text = await readFile(fullPath, 'utf8');
  if (ext === 'json') {
    try {
      const parsed = JSON.parse(text);
      const detected = detectJsonInput(parsed);
      if (detected) {
        return {
          path: fullPath,
          name,
          ...detected
        };
      }
    } catch {
      // fall through
    }
  }

  return {
    path: fullPath,
    name,
    sourceKind: ext === 'md' ? 'document' : 'raw_text',
    sourceFormat: ext === 'md' ? 'text/markdown' : 'text/plain',
    ingestInput: { raw_text: text },
    plainText: text,
    description: `${text.length} chars`,
    stats: {
      bundleCount: 0,
      messageCount: 0,
      documentCount: 0,
      rawTextCount: 1,
      monthlyReady: false
    }
  };
}

function buildCombinedSourceKind(parts = []) {
  const kinds = new Set(parts.map((item) => item.sourceKind).filter(Boolean));
  if (kinds.size === 1) return Array.from(kinds)[0];
  if (kinds.has('chat_bundle')) return 'chat_bundle';
  if (kinds.has('document')) return 'document';
  return 'raw_text';
}

function buildCombinedSourceFormat(parts = []) {
  const formats = Array.from(new Set(parts.map((item) => item.sourceFormat).filter(Boolean)));
  return formats.length === 1 ? formats[0] : 'application/json';
}

export async function normalizeInputFiles(filePaths = []) {
  const list = Array.from(filePaths || []).map((item) => safeText(item)).filter(Boolean);
  if (!list.length) {
    throw new Error('file_paths is required');
  }

  const parts = await Promise.all(list.map((item) => normalizeSingleInputFile(item)));
  if (parts.length === 1) return parts[0];

  const bundle = [];
  const documents = [];
  const plainTextParts = [];
  let bundleCount = 0;
  let messageCount = 0;
  let documentCount = 0;
  let rawTextCount = 0;

  parts.forEach((part, index) => {
    const input = part.ingestInput || {};
    if (Array.isArray(input.bundle)) {
      bundle.push(...input.bundle);
      bundleCount += input.bundle.length;
      messageCount += input.bundle.reduce((sum, item) => sum + (Array.isArray(item?.messages) ? item.messages.length : 0), 0);
    }
    if (Array.isArray(input.documents)) {
      documents.push(...input.documents);
      documentCount += input.documents.length;
    }
    if (typeof input.raw_text === 'string' && safeText(input.raw_text)) {
      documents.push({
        doc_id: `upload_${index + 1}`,
        title: part.name,
        kind: 'text',
        text: input.raw_text
      });
      rawTextCount += 1;
      documentCount += 1;
    }
    if (part.plainText) {
      plainTextParts.push(`## ${part.name}\n${part.plainText}`);
    }
  });

  const ingestInput = {};
  if (bundle.length) ingestInput.bundle = bundle;
  if (documents.length) ingestInput.documents = documents;

  return {
    name: `${parts.length} 个文件`,
    fileNames: parts.map((item) => item.name),
    sourceKind: buildCombinedSourceKind(parts),
    sourceFormat: buildCombinedSourceFormat(parts),
    ingestInput,
    plainText: plainTextParts.join('\n\n'),
    description: [
      `${parts.length} 个文件`,
      bundleCount ? `${bundleCount} 组窗口` : '',
      messageCount ? `${messageCount} 条消息` : '',
      documentCount && !bundleCount ? `${documentCount} 条文本` : '',
      bundleCount ? '已是窗口包，可直接按月拼接' : ''
    ].filter(Boolean).join(' / '),
    stats: {
      bundleCount,
      messageCount,
      documentCount,
      rawTextCount,
      monthlyReady: bundle.length > 0
    }
  };
}

export async function listRuntimeApiProfilesForTool() {
  const [profiles, currentConfig] = await Promise.all([
    loadRuntimeApiProfiles(),
    loadRuntimeApiConfig()
  ]);
  return {
    profiles: profiles.map((item) => sanitizeApiProfile(item)).filter(Boolean),
    current_config: sanitizeApiProfile({
      ...(currentConfig || {}),
      name: safeText(currentConfig?.name, '当前已载入配置')
    }),
    local_programmatic: sanitizeApiProfile({
      ...buildProgrammaticApi(),
      name: '__local_programmatic__',
      updated_at: ''
    })
  };
}

async function resolveApiSelection({ mode = 'local_programmatic', apiProfileName = '' } = {}) {
  if (isProgrammaticMode(mode)) return buildProgrammaticApi();
  const [profiles, currentConfig] = await Promise.all([
    loadRuntimeApiProfiles(),
    loadRuntimeApiConfig()
  ]);
  const requestedName = safeText(apiProfileName);
  const named = profiles.find((item) => item.name === requestedName);
  const currentMatchesRequested = requestedName
    && safeText(currentConfig?.profile_name) === requestedName;
  const chosen = currentMatchesRequested ? currentConfig : (named || currentConfig);
  if (!chosen?.baseUrl || !chosen?.model) {
    throw new Error('没有找到可用的 API 方案');
  }
  return {
    baseUrl: trimTrailingSlash(chosen.baseUrl),
    apiKey: typeof chosen.apiKey === 'string' ? chosen.apiKey : '',
    model: safeText(chosen.model, 'gpt-4o-mini')
  };
}

function buildScope({ ownerId = '', realmId = '', botId = '' } = {}) {
  return {
    owner_id: safeText(ownerId, 'mcp-runtime'),
    realm_id: safeText(realmId, `session-${nowStamp()}`),
    bot_id: safeText(botId, 'assistant')
  };
}

async function maybeReadLatestPacket(dir) {
  try {
    const pointer = await readJson(`${dir}/latest.json`);
    const latestDir = safeText(pointer?.latest_packet);
    if (!latestDir) return null;
    const packet = await readJson(`${latestDir}/packet.json`);
    return {
      pointer,
      packet_dir: latestDir,
      packet
    };
  } catch {
    return null;
  }
}

export async function inspectPipelineScope({
  ownerId = '',
  realmId = '',
  botId = 'assistant'
} = {}) {
  const scope = buildScope({ ownerId, realmId, botId });
  const [ingest, translation, tasks, reviewed, home] = await Promise.all([
    maybeReadLatestPacket(getScopedIngressDir(scope.owner_id, scope.realm_id)),
    maybeReadLatestPacket(getScopedTranslationDir(scope.owner_id, scope.realm_id)),
    maybeReadLatestPacket(getScopedTranslationTaskDir(scope.owner_id, scope.realm_id)),
    maybeReadLatestPacket(getScopedReviewedDir(scope.owner_id, scope.realm_id)),
    getMemoryHomePacket({
      ownerId: scope.owner_id,
      realmId: scope.realm_id,
      botId: scope.bot_id,
      mode: 'bot'
    }).catch(() => ({}))
  ]);

  return {
    scope,
    scope_dir: getScopedTruthDir(scope.owner_id, scope.realm_id),
    ingest: ingest ? {
      packet_dir: ingest.packet_dir,
      summary: ingest.packet?.input
        ? {
            document_count: Number(ingest.packet.input.document_count || 0),
            total_chars: Number(ingest.packet.input.total_chars || 0)
          }
        : {}
    } : null,
    translation: translation ? {
      packet_dir: translation.packet_dir,
      summary: translation.packet?.summary || {}
    } : null,
    tasks: tasks ? {
      packet_dir: tasks.packet_dir,
      status_summary: tasks.packet?.status_summary || {},
      summary: tasks.packet?.summary || {}
    } : null,
    reviewed: reviewed ? {
      packet_dir: reviewed.packet_dir,
      summary: reviewed.packet?.summary || {},
      finalized_at: safeText(reviewed.packet?.finalized_at)
    } : null,
    home: home?.ok ? home.home_summary || {} : {}
  };
}

export async function prepareHistorySource({
  filePaths = [],
  ownerId = '',
  realmId = '',
  botId = '',
  targetChars = 30000,
  maxSlices = 2,
  maxChars = 60000,
  entryLimit = 8
} = {}) {
  const normalized = await normalizeInputFiles(filePaths);
  const scope = buildScope({ ownerId, realmId, botId });
  const sourceLabel = normalized.stats?.monthlyReady ? 'monthly-window-bundle' : 'multi-source-bundle';

  const ingest = await ingestMemoryEnvelope({
    scope,
    source: {
      kind: normalized.sourceKind,
      label: sourceLabel,
      format: normalized.sourceFormat
    },
    input: normalized.ingestInput
  }, {
    label: sourceLabel
  });

  const translation = await buildTranslationPacket({
    scope,
    source: {
      label: `${sourceLabel}__translate`
    },
    packet_file: ingest.ingest?.packet_file,
    target_chars: Math.max(1200, Number(targetChars || 30000))
  });

  const prepare = await prepareAiTranslationTasks({
    scope,
    source: {
      label: `${sourceLabel}__prepare`
    },
    packet_file: translation.translation?.packet_file,
    batch: {
      max_slices: Math.max(1, Number(maxSlices || 2)),
      max_chars: Math.max(1200, Number(maxChars || 60000)),
      entry_limit: Math.max(1, Number(entryLimit || 8))
    }
  });

  const next = await getNextPendingTranslationWorkerPacket({
    owner_id: scope.owner_id,
    realm_id: scope.realm_id
  });

  return {
    ok: true,
    scope,
    input: {
      files: normalized.fileNames || [normalized.name],
      description: normalized.description,
      stats: normalized.stats || {}
    },
    ingest: ingest.ingest || {},
    translation: translation.translation || {},
    prepare: prepare.summary || {},
    next_task: next?.next_task || null,
    status_summary: next?.status_summary || {}
  };
}

export async function pullTranslationTaskForTool({
  ownerId = '',
  realmId = '',
  botId = '',
  taskFile = ''
} = {}) {
  if (safeText(taskFile)) {
    return getTranslationTaskWorkerPacket(safeText(taskFile));
  }
  return getNextPendingTranslationWorkerPacket({
    owner_id: safeText(ownerId),
    realm_id: safeText(realmId),
    bot_id: safeText(botId, 'assistant')
  });
}

export async function submitTranslationEntriesForTool({
  taskFile = '',
  entries = [],
  rawOutput = '',
  ownerId = '',
  realmId = '',
  botId = '',
  sourceLabel = 'mcp_translation_submit'
} = {}) {
  const scope = buildScope({ ownerId, realmId, botId });
  const appended = await appendRuntimeReviewedEntries({
    task_file: safeText(taskFile),
    entries: Array.isArray(entries) ? entries : undefined,
    raw_output: safeText(rawOutput),
    scope,
    source: {
      label: safeText(sourceLabel, 'mcp_translation_submit')
    }
  });
  const next = await getNextPendingTranslationWorkerPacket({
    owner_id: scope.owner_id,
    realm_id: scope.realm_id
  });
  return {
    ...appended,
    next_task: next?.next_task || null,
    status_summary: next?.status_summary || {}
  };
}

export async function failTranslationTaskForTool({
  taskFile = '',
  error = '',
  rawOutput = '',
  ownerId = '',
  realmId = '',
  botId = '',
  sourceLabel = 'mcp_translation_fail'
} = {}) {
  const scope = buildScope({ ownerId, realmId, botId });
  const failed = await failAiTranslationTask({
    task_file: safeText(taskFile),
    error: safeText(error, 'Translator worker failed before submission.'),
    raw_output: safeText(rawOutput),
    scope,
    source: {
      label: safeText(sourceLabel, 'mcp_translation_fail')
    }
  });
  const next = await getNextPendingTranslationWorkerPacket({
    owner_id: scope.owner_id,
    realm_id: scope.realm_id
  });
  return {
    ...failed,
    next_task: next?.next_task || null,
    status_summary: next?.status_summary || {}
  };
}

export async function listReviewedClustersForTool({
  ownerId = '',
  realmId = '',
  botId = ''
} = {}) {
  return getRuntimeReviewedClusters({
    scope: buildScope({ ownerId, realmId, botId })
  });
}

export async function finalizeReviewedEntriesForTool({
  ownerId = '',
  realmId = '',
  botId = '',
  aiMerges = []
} = {}) {
  return finalizeRuntimeReviewedEntries({
    scope: buildScope({ ownerId, realmId, botId }),
    ai_merges: Array.isArray(aiMerges) ? aiMerges : [],
    source: {
      label: 'mcp_reviewed_finalize'
    }
  });
}

export async function runHistoryPipeline({
  filePaths = [],
  mode = 'local_programmatic',
  apiProfileName = '',
  ownerId = '',
  realmId = '',
  botId = '',
  targetChars = 30000,
  maxSlices = 2,
  maxChars = 60000,
  entryLimit = 8
} = {}) {
  const normalized = await normalizeInputFiles(filePaths);
  const scope = buildScope({ ownerId, realmId, botId });
  const api = await resolveApiSelection({ mode, apiProfileName });
  const sourceLabel = normalized.stats?.monthlyReady ? 'monthly-window-bundle' : 'multi-source-bundle';

  const ingest = await ingestMemoryEnvelope({
    scope,
    source: {
      kind: normalized.sourceKind,
      label: sourceLabel,
      format: normalized.sourceFormat
    },
    input: normalized.ingestInput
  }, {
    label: sourceLabel
  });

  const translation = await buildTranslationPacket({
    scope,
    source: {
      label: `${sourceLabel}__translate`
    },
    packet_file: ingest.ingest?.packet_file,
    target_chars: Math.max(1200, Number(targetChars || 30000))
  });

  const prepare = await prepareAiTranslationTasks({
    scope,
    source: {
      label: `${sourceLabel}__prepare`
    },
    packet_file: translation.translation?.packet_file,
    batch: {
      max_slices: Math.max(1, Number(maxSlices || 2)),
      max_chars: Math.max(1200, Number(maxChars || 60000)),
      entry_limit: Math.max(1, Number(entryLimit || 8))
    }
  });

  let taskRuns = 0;
  let taskFailures = 0;
  while (true) {
    const result = await runRuntimeAiTranslationTask({
      scope,
      api,
      source: {
        label: `${sourceLabel}__runtime`
      }
    });
    if (safeText(result?.status) === 'idle') break;
    taskRuns += 1;
    if (!result?.ok) taskFailures += 1;
  }

  const clusters = await getRuntimeReviewedClusters({ scope });
  const aiMerges = [];
  for (const cluster of Array.isArray(clusters?.clusters) ? clusters.clusters : []) {
    if (!cluster?.ambiguous || Number(cluster.entry_count || 0) <= 1) continue;
    const merge = await runRuntimeReviewedMerge({
      scope,
      cluster_id: cluster.cluster_id,
      api
    });
    if (merge?.entry) {
      aiMerges.push({
        cluster_id: cluster.cluster_id,
        entry: merge.entry,
        used_ai: Boolean(merge.used_ai),
        fallback: Boolean(merge.fallback)
      });
    }
  }

  const finalize = await finalizeRuntimeReviewedEntries({
    scope,
    source: {
      label: `${sourceLabel}__reviewed_finalize`
    },
    ai_merges: aiMerges
  });

  return {
    ok: true,
    mode: isProgrammaticMode(mode) ? 'local_programmatic' : 'api_profile',
    api_model: safeText(api.model),
    scope,
    input: {
      files: normalized.fileNames || [normalized.name],
      description: normalized.description,
      stats: normalized.stats || {}
    },
    ingest: ingest.ingest || {},
    translation: translation.translation || {},
    prepare: prepare.summary || {},
    task_runs: taskRuns,
    task_failures: taskFailures,
    reviewed_summary: clusters.summary || {},
    ai_merge_count: aiMerges.length,
    finalize: {
      merged_entries: finalize.merged_entries || 0,
      writeback_summary: finalize.writeback?.summary || {}
    },
    scope_dir: getScopedTruthDir(scope.owner_id, scope.realm_id)
  };
}

export async function getMemoryContextForTool({
  key = '',
  query = '',
  ownerId = '',
  realmId = '',
  botId = '',
  mode = 'mcp'
} = {}) {
  return getMemoryContextPacket({
    key,
    query,
    ownerId,
    realmId,
    botId,
    mode
  });
}

export async function getPersonaWorkspaceStateForTool({
  includePersonaRows = false,
  rowLimit = 12
} = {}) {
  return getPersonaWorkspaceSnapshot({
    includePersonaRows,
    rowLimit
  });
}

export async function getGrowthContextForTool({
  key = '',
  query = '',
  ownerId = '',
  realmId = '',
  botId = '',
  userId = '',
  charId = '',
  includePersonaRows = true,
  rowLimit = 12
} = {}) {
  return getGrowthContextPacket({
    key,
    query,
    ownerId,
    realmId,
    botId,
    userId,
    charId,
    includePersonaRows,
    rowLimit
  });
}

export async function buildGrowthTaskForTool({
  ownerId = '',
  realmId = '',
  botId = '',
  userId = '',
  charId = '',
  key = '',
  query = '',
  familyId = '',
  cardType = 'memo',
  packetId = '',
  includePersonaRows = false,
  rowLimit = 8
} = {}) {
  return buildGrowthTaskPacket({
    ownerId,
    realmId,
    botId,
    userId,
    charId,
    key,
    query,
    familyId,
    cardType,
    packetId,
    includePersonaRows,
    rowLimit
  });
}

export async function generateGrowthDraftForTool({
  ownerId = '',
  realmId = '',
  botId = '',
  userId = '',
  charId = '',
  key = '',
  query = '',
  familyId = '',
  cardType = 'memo',
  packetId = '',
  includePersonaRows = true,
  rowLimit = 8,
  apiProfileName = '',
  mode = '',
  commit = false,
  exportToObsidian = false,
  exportRoot = '',
  overwriteExport = false
} = {}) {
  return generateGrowthDraft({
    ownerId,
    realmId,
    botId,
    userId,
    charId,
    key,
    query,
    familyId,
    cardType,
    packetId,
    includePersonaRows,
    rowLimit,
    apiProfileName,
    mode,
    commit,
    exportToObsidian,
    exportRoot,
    overwriteExport
  });
}

export async function listGrowthDraftsForTool({
  ownerId = '',
  realmId = '',
  cardType = '',
  limit = 12
} = {}) {
  return listGrowthDraftArtifacts({
    ownerId,
    realmId,
    cardType,
    limit
  });
}

export async function getGrowthDraftForTool({
  ownerId = '',
  realmId = '',
  cardType = 'memo',
  artifactId = ''
} = {}) {
  return getGrowthDraftArtifact({
    ownerId,
    realmId,
    cardType,
    artifactId
  });
}

export async function exportGrowthDraftToObsidianForTool({
  ownerId = '',
  realmId = '',
  cardType = 'memo',
  artifactId = '',
  rootDir = '',
  overwrite = false
} = {}) {
  return exportGrowthDraftToObsidianStaging({
    ownerId,
    realmId,
    cardType,
    artifactId,
    rootDir,
    overwrite
  });
}

export async function getCardRegistryForTool({
  ownerId = '',
  realmId = '',
  limit = 12
} = {}) {
  return getCardRegistrySnapshot({
    ownerId,
    realmId,
    limit
  });
}

export async function upsertCardRegistryEntryForTool({
  ownerId = '',
  realmId = '',
  entry = {}
} = {}) {
  const result = await upsertCardRegistryEntry({
    ownerId,
    realmId,
    entry
  });
  return {
    ok: true,
    entry: result.entry,
    summary: result.registry?.summary || {}
  };
}

export async function getGrowthLedgerForTool({
  ownerId = '',
  realmId = '',
  limit = 20
} = {}) {
  return getGrowthLedgerSnapshot({
    ownerId,
    realmId,
    limit
  });
}

export async function appendGrowthLedgerEntryForTool({
  ownerId = '',
  realmId = '',
  entry = {}
} = {}) {
  const result = await appendGrowthLedgerEntry({
    ownerId,
    realmId,
    entry
  });
  return {
    ok: true,
    entry: result.entry,
    summary: result.ledger?.summary || {}
  };
}

export async function commitGrowthDecisionForTool({
  ownerId = '',
  realmId = '',
  decision = '',
  packetId = '',
  reason = '',
  nextHint = '',
  actor = '',
  source = '',
  cardEntry = {},
  ledgerEntry = {}
} = {}) {
  return commitGrowthDecision({
    ownerId,
    realmId,
    decision,
    packetId,
    reason,
    nextHint,
    actor,
    source,
    cardEntry,
    ledgerEntry
  });
}

export async function savePersonaWorkspaceStateForTool({
  charName = '',
  userName = '',
  personaCard = '',
  languageFingerprint = '',
  fingerprintCandidatePool = ''
} = {}) {
  const state = await savePersonaWorkspaceState({
    char_name: charName,
    user_name: userName,
    persona_card: personaCard,
    language_fingerprint: languageFingerprint,
    fingerprint_candidate_pool: fingerprintCandidatePool
  });
  return { ok: true, state };
}

export async function buildFingerprintCandidatePoolForTool({
  save = true
} = {}) {
  return buildFingerprintCandidatePoolForWorkspace({ save });
}

export async function generateSoulDraftForTool({
  apiProfileName = '',
  save = true
} = {}) {
  return generateSoulDraftForWorkspace({
    apiProfileName,
    save
  });
}

export async function generateLanguageFingerprintForTool({
  apiProfileName = '',
  save = true,
  candidatePool = ''
} = {}) {
  return generateLanguageFingerprintForWorkspace({
    apiProfileName,
    save,
    candidatePool
  });
}
