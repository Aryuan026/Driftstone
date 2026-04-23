import { getMemoryContextPacket } from './memory-context-service.js';
import { getMemoryScopePacket } from './memory-scope-service.js';
import { getNextPendingTranslationWorkerPacket } from './memory-translation-task-service.js';
import { buildMemoryScope } from './scope-contract.js';

function buildEmptyScopePacket(scope = {}) {
  const currentBotId = String(scope?.bot_id || '');
  return {
    ok: true,
    schema: 'memory_scope_packet_v0.1',
    scope: {
      owner_id: String(scope?.owner_id || ''),
      realm_id: String(scope?.realm_id || ''),
      bot_id: currentBotId
    },
    summary: {
      roots: 0,
      vine_edges: 0,
      latest_root_at: '',
      latest_vine_at: '',
      latest_ingest_at: '',
      latest_translation_at: '',
      leaf_total: 0
    },
    translation_tasks: {
      pending: 0,
      submitted: 0,
      applied: 0,
      failed: 0
    },
    leafs: {
      total: 0,
      bots: [],
      current_bot: {
        bot_id: currentBotId,
        display_name: '',
        persona_summary: '',
        updated_at: '',
        file: ''
      },
      current_bot_exists: false
    },
    available: {
      roots: false,
      vines: false,
      ingest: false,
      translation: false,
      translation_tasks: false,
      leafs: false
    },
    samples: {
      roots: []
    },
    hints: {
      next_translation_stage: 'empty',
      recommended_read: '/api/memory/context',
      current_bot_leaf_state: currentBotId ? 'leaf_missing' : 'bot_unspecified'
    }
  };
}

function pickRootPreview(scopePacket = {}) {
  const roots = Array.isArray(scopePacket?.samples?.roots) ? scopePacket.samples.roots : [];
  return roots[0] || null;
}

function summarizeWorkerTask(task = {}) {
  return {
    task_file: String(task?.task_file || ''),
    status: String(task?.status || ''),
    scope: task?.scope || {},
    summary: task?.summary || {},
    submit_contract: task?.submit_contract || {}
  };
}

function summarizeLeafHome(scopePacket = {}) {
  const leafs = scopePacket?.leafs || {};
  const currentBot = leafs?.current_bot || {};
  return {
    total: Number(leafs?.total || 0),
    current_bot_id: String(currentBot?.bot_id || ''),
    current_bot_leaf_exists: Boolean(leafs?.current_bot_exists),
    current_bot_leaf_display_name: String(currentBot?.display_name || ''),
    current_bot_leaf_persona_summary: String(currentBot?.persona_summary || ''),
    current_bot_leaf_updated_at: String(currentBot?.updated_at || '')
  };
}

function buildMemoryHomeSummary({
  homeState = '',
  nextWorkerTask = null,
  contextPreview = null,
  scopePacket = {}
} = {}) {
  const summary = scopePacket?.summary || {};
  const translationTasks = scopePacket?.translation_tasks || {};
  const leafHome = summarizeLeafHome(scopePacket);
  const pending = Number(translationTasks?.pending || 0);
  const submitted = Number(translationTasks?.submitted || 0);
  const applied = Number(translationTasks?.applied || 0);
  const failed = Number(translationTasks?.failed || 0);
  const total = pending + submitted + applied + failed;
  const completed = applied + failed;
  const progressRatio = total > 0 ? Number((completed / total).toFixed(4)) : 0;
  return {
    home_state: String(homeState || ''),
    next_work_type: nextWorkerTask ? 'translation_worker_task' : '',
    next_task_file: String(nextWorkerTask?.task_file || ''),
    read_preview_type: contextPreview ? 'context_preview' : '',
    read_root_key: String(contextPreview?.root_key || ''),
    roots: Number(summary?.roots || 0),
    vine_edges: Number(summary?.vine_edges || 0),
    leaf_total: Number(leafHome.total || 0),
    current_bot_id: String(leafHome.current_bot_id || ''),
    current_bot_leaf_exists: Boolean(leafHome.current_bot_leaf_exists),
    current_bot_leaf_display_name: String(leafHome.current_bot_leaf_display_name || ''),
    current_bot_leaf_persona_summary: String(leafHome.current_bot_leaf_persona_summary || ''),
    current_bot_leaf_updated_at: String(leafHome.current_bot_leaf_updated_at || ''),
    translation_pending: pending,
    translation_submitted: submitted,
    translation_applied: applied,
    translation_failed: failed,
    translation_total: total,
    translation_completed: completed,
    translation_progress_ratio: progressRatio
  };
}

export async function getMemoryHomePacket({
  ownerId = '',
  realmId = '',
  botId = '',
  userId = '',
  charId = '',
  mode = 'bot',
  rootLimit = 8
} = {}) {
  const scope = buildMemoryScope({
    ownerId,
    realmId,
    botId,
    mode,
    userId,
    charId
  });

  const scopePacket = await getMemoryScopePacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    botId: scope.bot_id,
    rootLimit
  });

  const resolvedScopePacket =
    scopePacket?.ok ? scopePacket
    : scopePacket?.error === 'Scope not found' ? buildEmptyScopePacket(scope)
    : null;

  if (!scopePacket?.ok) {
    if (resolvedScopePacket) {
      return buildMemoryHomePacketFromScope({
        scope,
        scopePacket: resolvedScopePacket,
        userId,
        charId,
        mode,
        rootLimit
      });
    }
    return {
      ok: false,
      error: scopePacket?.error || 'Scope not found',
      schema: 'memory_home_packet_v0.1',
      scope
    };
  }

  return buildMemoryHomePacketFromScope({
    scope,
    scopePacket: resolvedScopePacket,
    userId,
    charId,
    mode,
    rootLimit
  });
}

async function buildMemoryHomePacketFromScope({
  scope = {},
  scopePacket = {},
  userId = '',
  charId = '',
  mode = 'bot',
  rootLimit = 8
} = {}) {

  let nextTaskPacket = {
    ok: true,
    next_task: null,
    status_summary: {
      pending: 0,
      submitted: 0,
      applied: 0,
      failed: 0
    }
  };
  try {
    nextTaskPacket = await getNextPendingTranslationWorkerPacket({
      owner_id: scope.owner_id,
      realm_id: scope.realm_id,
      limit: Math.max(20, Number(rootLimit || 8))
    });
  } catch {
    nextTaskPacket = {
      ok: true,
      next_task: null,
      status_summary: scopePacket.translation_tasks || {
        pending: 0,
        submitted: 0,
        applied: 0,
        failed: 0
      }
    };
  }

  const nextWorkerTask = nextTaskPacket?.next_task || null;
  const rootPreview = pickRootPreview(scopePacket);
  let contextPreview = null;

  if (!nextWorkerTask && rootPreview?.root_key) {
    const contextPacket = await getMemoryContextPacket({
      key: rootPreview.root_key,
      mode,
      ownerId: scope.owner_id,
      realmId: scope.realm_id,
      botId: scope.bot_id,
      userId,
      charId
    });
    if (contextPacket?.ok) {
      contextPreview = {
        root_key: contextPacket.root_key,
        seed: contextPacket.seed || null,
        intent: contextPacket.intent || '',
        context: contextPacket.context || {}
      };
    }
  }

  const nextStage = scopePacket?.hints?.next_translation_stage || '';
  const submittedCount = Number((nextTaskPacket?.status_summary || scopePacket.translation_tasks || {}).submitted || 0);
  const homeState =
    nextWorkerTask ? 'translation_pending'
    : submittedCount > 0 ? 'translation_submitted'
    : contextPreview ? 'context_ready'
    : nextStage === 'translation_needed' ? 'translation_needed'
    : nextStage === 'tree_exists' ? 'tree_ready'
    : 'scope_ready';

  const homeSummary = buildMemoryHomeSummary({
    homeState,
    nextWorkerTask,
    contextPreview,
    scopePacket
  });

  return {
    ok: true,
    schema: 'memory_home_packet_v0.1',
    scope,
    home_state: homeState,
    home_summary: homeSummary,
    summary: scopePacket.summary || {},
    available: scopePacket.available || {},
    translation_tasks: scopePacket.translation_tasks || {},
    leafs: scopePacket.leafs || {},
    leaf_preview: scopePacket?.leafs?.current_bot_exists ? (scopePacket?.leafs?.current_bot || null) : null,
    scope_hints: scopePacket.hints || {},
    samples: scopePacket.samples || { roots: [] },
    next_work: nextWorkerTask ? {
      type: 'translation_worker_task',
      task: summarizeWorkerTask(nextWorkerTask)
    } : null,
    read_preview: contextPreview ? {
      type: 'context_preview',
      packet: contextPreview
    } : null
  };
}
