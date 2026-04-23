import { buildMemoryScope } from './scope-contract.js';
import { loadLeafPacket, writeLeafPacket } from './leaf-store.js';

function safeText(value) {
  return String(value || '').trim();
}

function uniqueStrings(items, limit = 24) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function summarizeLeaf(packet = {}) {
  const leaf = packet.leaf || {};
  const scope = packet.scope || {};
  return {
    bot_id: safeText(scope.bot_id || ''),
    display_name: safeText(leaf.display_name || ''),
    persona_summary: safeText(leaf.persona_summary || ''),
    style_notes: uniqueStrings(leaf.style_notes || []),
    memory_notes: uniqueStrings(leaf.memory_notes || []),
    prompt_fragments: uniqueStrings(leaf.prompt_fragments || [], 32),
    updated_at: safeText(packet.updated_at || ''),
    source: packet.source || {}
  };
}

export async function getMemoryLeafPacket({ ownerId = '', realmId = '', botId = '', userId = '', charId = '' } = {}) {
  const scope = buildMemoryScope({ ownerId, realmId, botId, userId, charId, mode: 'bot' });
  const leafHit = await loadLeafPacket({ owner_id: scope.owner_id, realm_id: scope.realm_id, bot_id: scope.bot_id });
  return {
    ok: true,
    schema: 'memory_leaf_packet_v0.1',
    found: !!leafHit.found,
    scope: {
      ...scope,
      isolation_stage: scope.bot_id ? 'bot_leaf_scoped' : scope.isolation_stage
    },
    leaf: summarizeLeaf(leafHit.packet),
    storage: {
      file: leafHit.file,
      dir: leafHit.dir
    }
  };
}

export async function writeMemoryLeafEnvelope(envelope = {}) {
  const scope = buildMemoryScope({
    ownerId: envelope?.scope?.owner_id,
    realmId: envelope?.scope?.realm_id,
    botId: envelope?.scope?.bot_id,
    mode: 'bot'
  });
  const source = envelope?.source || {};
  const result = await writeLeafPacket({
    scope,
    source,
    leaf: envelope?.leaf || {},
    mergeMode: envelope?.merge_mode || 'merge'
  });
  return {
    ok: true,
    schema: 'memory_leaf_write_result_v0.1',
    scope: {
      ...scope,
      isolation_stage: scope.bot_id ? 'bot_leaf_scoped' : scope.isolation_stage
    },
    source: {
      kind: safeText(source.kind || 'leaf_write_contract'),
      label: safeText(source.label || '')
    },
    merge_mode: safeText(result.merge_mode || envelope?.merge_mode || 'merge'),
    written: result.found_before ? 'updated' : 'created',
    leaf: summarizeLeaf(result.packet),
    storage: {
      file: result.file,
      index_file: result.index_file
    }
  };
}
