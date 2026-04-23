import { getMemoryHomePacket } from './memory-home-service.js';
import { buildMemoryScope } from './scope-contract.js';

function summarizeEntry(homePacket = {}) {
  const homeSummary = homePacket?.home_summary || {};
  const scope = homePacket?.scope || {};
  const nextWork = homePacket?.next_work || {};
  const readPreview = homePacket?.read_preview || {};
  const leafPreview = homePacket?.leaf_preview || {};

  return {
    owner_id: String(scope.owner_id || ''),
    realm_id: String(scope.realm_id || ''),
    bot_id: String(scope.bot_id || ''),
    home_state: String(homeSummary.home_state || homePacket.home_state || ''),
    roots: Number(homeSummary.roots || 0),
    vine_edges: Number(homeSummary.vine_edges || 0),
    translation_pending: Number(homeSummary.translation_pending || 0),
    translation_completed: Number(homeSummary.translation_completed || 0),
    translation_progress_ratio: Number(homeSummary.translation_progress_ratio || 0),
    next_work_type: String(homeSummary.next_work_type || ''),
    next_task_file: String(homeSummary.next_task_file || ''),
    current_bot_leaf_exists: Boolean(homeSummary.current_bot_leaf_exists),
    current_bot_leaf_display_name: String(homeSummary.current_bot_leaf_display_name || ''),
    current_bot_leaf_persona_summary: String(homeSummary.current_bot_leaf_persona_summary || ''),
    read_preview_type: String(homeSummary.read_preview_type || ''),
    read_root_key: String(homeSummary.read_root_key || ''),
    handoff_state:
      String(homeSummary.home_state || homePacket.home_state || '') === 'context_ready'
        ? 'cold_context_ready'
        : String(homeSummary.home_state || homePacket.home_state || '') === 'translation_pending'
          ? 'translation_queue_ready'
          : String(homeSummary.home_state || homePacket.home_state || '') === 'translation_needed'
            ? 'translation_packet_ready'
            : 'scope_ready',
    leaf_preview_available: Boolean(leafPreview && Object.keys(leafPreview).length),
    next_work_available: Boolean(nextWork && Object.keys(nextWork).length),
    read_preview_available: Boolean(readPreview && Object.keys(readPreview).length)
  };
}

function buildHandoff(entrySummary = {}) {
  const homeState = String(entrySummary.home_state || '');
  return {
    stage: String(entrySummary.handoff_state || ''),
    recommended_hot_read:
      homeState === 'context_ready'
        ? 'projection_from_context'
        : homeState === 'translation_pending'
          ? 'wait_or_translate'
          : 'status_only',
    should_pull_context: homeState === 'context_ready',
    should_show_translation_progress:
      homeState === 'translation_pending' || homeState === 'translation_needed',
    current_bot_leaf_display_name: String(entrySummary.current_bot_leaf_display_name || ''),
    current_bot_leaf_persona_summary: String(entrySummary.current_bot_leaf_persona_summary || '')
  };
}

export async function getMemoryEntryPacket({
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
    userId,
    charId,
    mode
  });

  const homePacket = await getMemoryHomePacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    botId: scope.bot_id,
    userId,
    charId,
    mode,
    rootLimit
  });

  if (!homePacket?.ok) {
    return {
      ok: false,
      error: homePacket?.error || 'Entry not found',
      schema: 'memory_entry_packet_v0.1',
      scope
    };
  }

  const entrySummary = summarizeEntry(homePacket);
  return {
    ok: true,
    schema: 'memory_entry_packet_v0.1',
    scope: homePacket.scope || scope,
    entry_summary: entrySummary,
    handoff: buildHandoff(entrySummary),
    home: {
      home_state: homePacket.home_state || '',
      home_summary: homePacket.home_summary || {},
      next_work: homePacket.next_work || null,
      read_preview: homePacket.read_preview || null
    },
    leaf: homePacket.leaf_preview || null,
    scope_hints: homePacket.scope_hints || {}
  };
}
