import { auditMemoryLeaf } from './memory-leaf-audit-service.js';
import { writeMemoryLeafEnvelope } from './memory-leaf-service.js';
import { buildLeafRepairDraft } from './leaf-repair-helpers.js';

export async function previewMemoryLeafRepair({
  ownerId = '',
  realmId = '',
  botId = '',
  mode = 'bot',
  query = ''
} = {}) {
  const audit = await auditMemoryLeaf({ ownerId, realmId, botId, mode, query });
  const draft = buildLeafRepairDraft({
    query: audit?.query,
    currentLeaf: audit?.current_leaf || {},
    evidenceRoots: audit?.evidence_roots || [],
    evidenceShadow: audit?.evidence_shadow || {},
    drift: audit?.drift || {}
  });

  return {
    ok: true,
    schema: 'memory_leaf_repair_preview_v0.1',
    scope: audit?.scope || {},
    query: audit?.query || '',
    repair_supported: Boolean(draft),
    audit,
    draft
  };
}

export async function applyMemoryLeafRepair({
  ownerId = '',
  realmId = '',
  botId = '',
  mode = 'bot',
  query = '',
  source = {}
} = {}) {
  const preview = await previewMemoryLeafRepair({ ownerId, realmId, botId, mode, query });
  if (!preview.draft) {
    return {
      ok: false,
      error: 'No repair draft available',
      scope: preview.scope,
      audit: preview.audit
    };
  }

  const result = await writeMemoryLeafEnvelope({
    scope: {
      owner_id: preview.scope?.owner_id || ownerId,
      realm_id: preview.scope?.realm_id || realmId,
      bot_id: preview.scope?.bot_id || botId
    },
    source: {
      kind: source.kind || 'leaf_repair_apply',
      label: source.label || 'memory_leaf_repair'
    },
    leaf: preview.draft,
    merge_mode: 'replace'
  });

  return {
    ok: true,
    schema: 'memory_leaf_repair_apply_result_v0.1',
    scope: preview.scope,
    query: preview.query,
    repair_supported: true,
    merge_mode: result.merge_mode || 'replace',
    draft: preview.draft,
    written: result.written || 'updated',
    leaf: result.leaf,
    storage: result.storage,
    audit: preview.audit
  };
}
