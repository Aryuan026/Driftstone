import { readdir } from 'fs/promises';
import { join } from 'path';
import { SCOPED_TRUTH_DIR } from './path-config.js';
import { loadLatestRootPointer, loadLatestRootIndex } from './root-store.js';
import { loadLatestVinePointer } from './vine-store.js';
import { loadLatestIngressPointer } from './ingest-store.js';
import { loadLatestTranslationPointer } from './translation-store.js';
import { loadLatestTranslationTaskPacket } from './translation-task-store.js';
import { loadLeafIndex } from './leaf-store.js';

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeLoad(loader, fallback = null) {
  try {
    return await loader();
  } catch {
    return fallback;
  }
}

function safeText(value) {
  return String(value || '').trim();
}

function summarizeTaskPacket(packet) {
  const summary = packet?.status_summary || {};
  return {
    pending: Number(summary.pending || 0),
    submitted: Number(summary.submitted || 0),
    applied: Number(summary.applied || 0),
    failed: Number(summary.failed || 0)
  };
}

function summarizeRootRows(rows = [], limit = 8) {
  return rows.slice(0, limit).map((row) => ({
    root_key: row.root_key || '',
    canonical_name: row.canonical_name || '',
    anchor_type: row.anchor_type || '',
    tree_path: row.tree_path || '',
    version_count: Number(row.version_count || 0),
    last_seen_at: row.last_seen_at || ''
  }));
}

function summarizeLeafIndex(index, { botId = '', limit = 8 } = {}) {
  const leaves = Array.isArray(index?.leaves) ? index.leaves : [];
  const currentBotId = safeText(botId || '');
  const bots = leaves.slice(0, limit).map((item) => ({
    bot_id: safeText(item?.bot_id || ''),
    display_name: safeText(item?.display_name || ''),
    updated_at: safeText(item?.updated_at || ''),
    file: safeText(item?.file || '')
  }));
  const currentBot = currentBotId
    ? leaves.find((item) => safeText(item?.bot_id || '') === currentBotId) || null
    : null;
  return {
    total: leaves.length,
    bots,
    current_bot: currentBot ? {
      bot_id: safeText(currentBot.bot_id || ''),
      display_name: safeText(currentBot.display_name || ''),
      persona_summary: safeText(currentBot.persona_summary || ''),
      updated_at: safeText(currentBot.updated_at || ''),
      file: safeText(currentBot.file || '')
    } : {
      bot_id: currentBotId,
      display_name: '',
      persona_summary: '',
      updated_at: '',
      file: ''
    },
    current_bot_exists: Boolean(currentBot)
  };
}

export async function listMemoryScopes({ ownerId = '' } = {}) {
  const owners = await safeReaddir(SCOPED_TRUTH_DIR);
  const ownerFilter = String(ownerId || '').trim();
  const scopeRows = [];

  for (const ownerDirent of owners) {
    if (!ownerDirent.isDirectory()) continue;
    const currentOwner = ownerDirent.name;
    if (ownerFilter && currentOwner !== ownerFilter) continue;

    const ownerPath = join(SCOPED_TRUTH_DIR, currentOwner);
    const realms = await safeReaddir(ownerPath);
    for (const realmDirent of realms) {
      if (!realmDirent.isDirectory()) continue;
      const currentRealm = realmDirent.name;

      const rootPointer = await safeLoad(
        () => loadLatestRootPointer({ ownerId: currentOwner, realmId: currentRealm }),
        null
      );
      const vinePointer = await safeLoad(
        () => loadLatestVinePointer({ ownerId: currentOwner, realmId: currentRealm }),
        null
      );
      const ingestPointer = await safeLoad(
        () => loadLatestIngressPointer({ ownerId: currentOwner, realmId: currentRealm }),
        null
      );
      const translationPointer = await safeLoad(
        () => loadLatestTranslationPointer({ ownerId: currentOwner, realmId: currentRealm }),
        null
      );
      const taskPacket = await safeLoad(
        () => loadLatestTranslationTaskPacket({ ownerId: currentOwner, realmId: currentRealm }),
        null
      );
      const leafIndex = await safeLoad(
        () => loadLeafIndex({ ownerId: currentOwner, realmId: currentRealm }),
        null
      );

      scopeRows.push({
        owner_id: currentOwner,
        realm_id: currentRealm,
        roots: Number(rootPointer?.pointer?.root_count || 0),
        vine_edges: Number(vinePointer?.pointer?.edge_count || 0),
        latest_root_at: rootPointer?.pointer?.generated_at || '',
        latest_vine_at: vinePointer?.pointer?.generated_at || '',
        latest_ingest_at: ingestPointer?.generated_at || ingestPointer?.pointer?.generated_at || '',
        latest_translation_at: translationPointer?.generated_at || translationPointer?.pointer?.generated_at || '',
        translation_tasks: summarizeTaskPacket(taskPacket?.packet),
        leafs: {
          total: Number((leafIndex?.index?.leaves || []).length || 0)
        },
        available: {
          roots: !!rootPointer?.pointer?.latest_snapshot,
          vines: !!vinePointer?.pointer?.latest_snapshot,
          ingest: !!ingestPointer?.latest_packet,
          translation: !!translationPointer?.latest_packet,
          translation_tasks: !!taskPacket?.packetFile,
          leafs: !!leafIndex?.found
        }
      });
    }
  }

  scopeRows.sort((a, b) => {
    if (a.owner_id !== b.owner_id) return a.owner_id.localeCompare(b.owner_id);
    return a.realm_id.localeCompare(b.realm_id);
  });

  return {
    ok: true,
    schema: 'memory_scope_catalog_v0.1',
    count: scopeRows.length,
    scopes: scopeRows
  };
}

export async function getMemoryScopePacket({ ownerId = '', realmId = '', botId = '', rootLimit = 8 } = {}) {
  const normalizedOwnerId = String(ownerId || '').trim();
  const normalizedRealmId = String(realmId || '').trim();
  const normalizedBotId = String(botId || '').trim();

  if (!normalizedOwnerId || !normalizedRealmId) {
    return {
      ok: false,
      error: 'Missing owner_id or realm_id'
    };
  }

  const rootPointer = await safeLoad(
    () => loadLatestRootPointer({ ownerId: normalizedOwnerId, realmId: normalizedRealmId }),
    null
  );
  const rootIndex = await safeLoad(
    () => loadLatestRootIndex({ ownerId: normalizedOwnerId, realmId: normalizedRealmId }),
    null
  );
  const vinePointer = await safeLoad(
    () => loadLatestVinePointer({ ownerId: normalizedOwnerId, realmId: normalizedRealmId }),
    null
  );
  const ingestPointer = await safeLoad(
    () => loadLatestIngressPointer({ ownerId: normalizedOwnerId, realmId: normalizedRealmId }),
    null
  );
  const translationPointer = await safeLoad(
    () => loadLatestTranslationPointer({ ownerId: normalizedOwnerId, realmId: normalizedRealmId }),
    null
  );
  const taskPacket = await safeLoad(
    () => loadLatestTranslationTaskPacket({ ownerId: normalizedOwnerId, realmId: normalizedRealmId }),
    null
  );
  const leafIndex = await safeLoad(
    () => loadLeafIndex({ ownerId: normalizedOwnerId, realmId: normalizedRealmId }),
    null
  );

  const roots = Array.isArray(rootIndex?.index?.roots) ? rootIndex.index.roots : [];
  const taskSummary = summarizeTaskPacket(taskPacket?.packet);
  const leafSummary = summarizeLeafIndex(leafIndex?.index, {
    botId: normalizedBotId,
    limit: Math.max(1, Number(rootLimit || 8))
  });
  const available = {
    roots: !!rootPointer?.pointer?.latest_snapshot,
    vines: !!vinePointer?.pointer?.latest_snapshot,
    ingest: !!ingestPointer?.latest_packet,
    translation: !!translationPointer?.latest_packet,
    translation_tasks: !!taskPacket?.packetFile,
    leafs: !!leafIndex?.found
  };

  const exists = Object.values(available).some(Boolean);
  if (!exists) {
    return {
      ok: false,
      error: 'Scope not found',
      scope: {
        owner_id: normalizedOwnerId,
        realm_id: normalizedRealmId,
        bot_id: normalizedBotId
      }
    };
  }

  return {
    ok: true,
    schema: 'memory_scope_packet_v0.1',
    scope: {
      owner_id: normalizedOwnerId,
      realm_id: normalizedRealmId,
      bot_id: normalizedBotId
    },
    summary: {
      roots: Number(rootPointer?.pointer?.root_count || 0),
      vine_edges: Number(vinePointer?.pointer?.edge_count || 0),
      latest_root_at: rootPointer?.pointer?.generated_at || '',
      latest_vine_at: vinePointer?.pointer?.generated_at || '',
      latest_ingest_at: ingestPointer?.generated_at || ingestPointer?.pointer?.generated_at || '',
      latest_translation_at: translationPointer?.generated_at || translationPointer?.pointer?.generated_at || '',
      leaf_total: Number(leafSummary.total || 0)
    },
    translation_tasks: taskSummary,
    leafs: leafSummary,
    available,
    samples: {
      roots: summarizeRootRows(roots, Math.max(1, Number(rootLimit || 8)))
    },
    hints: {
      next_translation_stage:
        taskSummary.pending > 0
          ? 'translation_tasks_pending'
          : available.translation
            ? 'translation_ready_or_done'
            : available.ingest
              ? 'translation_needed'
              : available.roots || available.vines
                ? 'tree_exists'
                : 'empty',
      recommended_read:
        taskSummary.pending > 0
          ? '/api/memory/translate/task/next/worker'
          : '/api/memory/context',
      current_bot_leaf_state:
        normalizedBotId
          ? (leafSummary.current_bot_exists ? 'leaf_ready' : 'leaf_missing')
          : 'bot_unspecified'
    }
  };
}
