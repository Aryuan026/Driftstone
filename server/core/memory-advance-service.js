import { getMemoryHomePacket } from './memory-home-service.js';
import { buildMemoryScope } from './scope-contract.js';
import { buildTranslationPacket } from './memory-translation-service.js';
import { prepareAiTranslationTasks } from './memory-translation-ai-service.js';
import { runNextProgrammaticTranslationTask } from './memory-translation-programmatic-task-service.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function taskTotals(translationTasks = {}) {
  const pending = Number(translationTasks?.pending || 0);
  const submitted = Number(translationTasks?.submitted || 0);
  const applied = Number(translationTasks?.applied || 0);
  const failed = Number(translationTasks?.failed || 0);
  return {
    pending,
    submitted,
    applied,
    failed,
    total: pending + submitted + applied + failed
  };
}

export async function advanceMemoryBay(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const sourceLabel = safeText(body?.source?.label || 'memory_advance');
  const rootLimit = Number(body?.root_limit || 8);

  const before = await getMemoryHomePacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    botId: scope.bot_id,
    mode: 'bot',
    rootLimit
  });

  if (!before?.ok) {
    return {
      ok: false,
      schema: 'hippocove_memory_advance_v0.1',
      scope,
      error: safeText(before?.error || 'Bay not found'),
      before
    };
  }

  const beforeTasks = taskTotals(before.translation_tasks || {});
  const hasTranslationPacket = Boolean(before.available?.translation);
  const hasAnyTasks = beforeTasks.total > 0;
  const beforeState = safeText(before.home_state);

  if (beforeState === 'translation_needed') {
    const translated = await buildTranslationPacket({
      scope: {
        owner_id: scope.owner_id,
        realm_id: scope.realm_id,
        bot_id: scope.bot_id
      },
      source: {
        label: `${sourceLabel}__translate`
      }
    });
    return {
      ok: Boolean(translated?.ok),
      schema: 'hippocove_memory_advance_v0.1',
      scope,
      action: 'build_translation_packet',
      before,
      result: translated,
      after: translated?.home || {},
      after_summary: translated?.home_summary || {}
    };
  }

  if (beforeState === 'scope_ready' && hasTranslationPacket && !hasAnyTasks) {
    const prepared = await prepareAiTranslationTasks({
      scope: {
        owner_id: scope.owner_id,
        realm_id: scope.realm_id,
        bot_id: scope.bot_id
      },
      source: {
        label: `${sourceLabel}__prepare`
      }
    });
    return {
      ok: Boolean(prepared?.ok),
      schema: 'hippocove_memory_advance_v0.1',
      scope,
      action: 'prepare_translation_tasks',
      before,
      result: prepared,
      after: prepared?.home || {},
      after_summary: prepared?.home_summary || {}
    };
  }

  if (beforeState === 'translation_pending') {
    const worked = await runNextProgrammaticTranslationTask({
      scope: {
        owner_id: scope.owner_id,
        realm_id: scope.realm_id,
        bot_id: scope.bot_id
      },
      source: {
        label: `${sourceLabel}__programmatic_worker`
      }
    });
    return {
      ok: Boolean(worked?.ok),
      schema: 'hippocove_memory_advance_v0.1',
      scope,
      action: 'run_programmatic_translation_task',
      before,
      result: worked,
      after: worked?.home || {},
      after_summary: worked?.home_summary || {}
    };
  }

  return {
    ok: true,
    schema: 'hippocove_memory_advance_v0.1',
    scope,
    action: 'noop',
    before,
    result: {
      ok: true,
      note: beforeState === 'context_ready'
        ? '当前这片海湾已经可以直接读树了。'
        : '当前没有需要推进的新一步。'
    },
    after: before,
    after_summary: before?.home_summary || {}
  };
}

export async function drainMemoryBay(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const maxSteps = Math.max(1, Math.min(Number(body?.max_steps || 8), 50));
  const stopAt = safeText(body?.stop_at || 'context_ready');
  const runs = [];
  let last = null;
  let reachedStopState = false;
  const before = await getMemoryHomePacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    botId: scope.bot_id,
    mode: 'bot',
    rootLimit: Number(body?.root_limit || 8)
  });

  const beforeState = safeText(before?.home_state);
  if (before?.ok && beforeState === stopAt) {
    return {
      ok: true,
      schema: 'hippocove_memory_advance_drain_v0.1',
      scope,
      max_steps: maxSteps,
      stop_at: stopAt,
      reached_stop_state: true,
      run_count: 0,
      runs,
      final: {
        ok: true,
        action: 'noop',
        before,
        after: before,
        after_summary: before?.home_summary || {},
        result: {
          ok: true,
          note: `当前这片海湾已经停在 ${stopAt}。`
        }
      },
      final_home: before,
      final_home_summary: before?.home_summary || {}
    };
  }

  for (let idx = 0; idx < maxSteps; idx += 1) {
    const result = await advanceMemoryBay({
      ...body,
      scope: {
        owner_id: scope.owner_id,
        realm_id: scope.realm_id,
        bot_id: scope.bot_id
      },
      source: {
        ...(body?.source || {}),
        label: safeText(body?.source?.label || 'memory_advance_drain')
      }
    });

    const afterState = safeText(result?.after_summary?.home_state || result?.after?.home_state || '');
    runs.push({
      step: idx + 1,
      action: safeText(result?.action),
      ok: Boolean(result?.ok),
      before_state: safeText(result?.before?.home_state),
      after_state: afterState,
      next_task_file: safeText(result?.after_summary?.next_task_file)
    });
    last = result;

    if (afterState === stopAt) {
      reachedStopState = true;
      break;
    }
    if (safeText(result?.action) === 'noop') break;
  }

  return {
    ok: true,
    schema: 'hippocove_memory_advance_drain_v0.1',
    scope,
    max_steps: maxSteps,
    stop_at: stopAt,
    reached_stop_state: reachedStopState,
    run_count: runs.length,
    runs,
    final: last || {},
    final_home: last?.after || {},
    final_home_summary: last?.after_summary || {}
  };
}
