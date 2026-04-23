import { mkdir, readFile, writeFile, access } from 'fs/promises';
import { dirname, join } from 'path';
import { getScopedLeafBotFile, getScopedLeafDir } from './path-config.js';

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

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

function normalizeLeafRecord(record = {}, scope = {}, source = {}) {
  return {
    schema: 'memory_leaf_packet_v0.1',
    updated_at: new Date().toISOString(),
    scope: {
      owner_id: safeText(scope.owner_id || ''),
      realm_id: safeText(scope.realm_id || 'default'),
      bot_id: safeText(scope.bot_id || '')
    },
    source: {
      kind: safeText(source.kind || 'leaf_write_contract'),
      label: safeText(source.label || '')
    },
    leaf: {
      display_name: safeText(record.display_name || ''),
      persona_summary: safeText(record.persona_summary || ''),
      style_notes: uniqueStrings(record.style_notes || []),
      memory_notes: uniqueStrings(record.memory_notes || []),
      prompt_fragments: uniqueStrings(record.prompt_fragments || [], 32)
    }
  };
}

export async function loadLeafPacket({ ownerId = '', realmId = '', botId = '', owner_id = '', realm_id = '', bot_id = '' } = {}) {
  const resolvedOwner = safeText(ownerId || owner_id || '');
  const resolvedRealm = safeText(realmId || realm_id || 'default');
  const resolvedBot = safeText(botId || bot_id || '');
  const file = getScopedLeafBotFile(resolvedOwner, resolvedRealm, resolvedBot);
  if (!(await fileExists(file))) {
    return {
      ok: true,
      found: false,
      file,
      dir: getScopedLeafDir(resolvedOwner, resolvedRealm),
      packet: normalizeLeafRecord({}, {
        owner_id: resolvedOwner,
        realm_id: resolvedRealm,
        bot_id: resolvedBot
      }, {})
    };
  }
  return {
    ok: true,
    found: true,
    file,
    dir: getScopedLeafDir(resolvedOwner, resolvedRealm),
    packet: await readJson(file)
  };
}

export async function loadLeafIndex({ ownerId = '', realmId = '', owner_id = '', realm_id = '' } = {}) {
  const resolvedOwner = safeText(ownerId || owner_id || '');
  const resolvedRealm = safeText(realmId || realm_id || 'default');
  const dir = getScopedLeafDir(resolvedOwner, resolvedRealm);
  const indexFile = join(dir, 'index.json');
  if (!(await fileExists(indexFile))) {
    return {
      ok: true,
      found: false,
      dir,
      file: indexFile,
      index: {
        schema: 'memory_leaf_index_v0.1',
        owner_id: resolvedOwner,
        realm_id: resolvedRealm,
        leaves: []
      }
    };
  }
  return {
    ok: true,
    found: true,
    dir,
    file: indexFile,
    index: await readJson(indexFile)
  };
}

export async function writeLeafPacket({ scope = {}, source = {}, leaf = {}, mergeMode = 'merge' } = {}) {
  const current = await loadLeafPacket(scope);
  const previous = current.packet || {};
  const previousLeaf = previous.leaf || {};
  const replace = String(mergeMode || 'merge') === 'replace';
  const merged = normalizeLeafRecord({
    display_name: leaf.display_name || previousLeaf.display_name || '',
    persona_summary: leaf.persona_summary || previousLeaf.persona_summary || '',
    style_notes: replace ? (leaf.style_notes || []) : [...(previousLeaf.style_notes || []), ...(leaf.style_notes || [])],
    memory_notes: replace ? (leaf.memory_notes || []) : [...(previousLeaf.memory_notes || []), ...(leaf.memory_notes || [])],
    prompt_fragments: replace ? (leaf.prompt_fragments || []) : [...(previousLeaf.prompt_fragments || []), ...(leaf.prompt_fragments || [])]
  }, {
    owner_id: scope.owner_id || previous.scope?.owner_id || '',
    realm_id: scope.realm_id || previous.scope?.realm_id || 'default',
    bot_id: scope.bot_id || previous.scope?.bot_id || ''
  }, {
    kind: source.kind || previous.source?.kind || 'leaf_write_contract',
    label: source.label || previous.source?.label || ''
  });

  await writeJson(current.file, merged);

  const indexFile = join(current.dir, 'index.json');
  const index = (await fileExists(indexFile)) ? await readJson(indexFile) : {
    schema: 'memory_leaf_index_v0.1',
    owner_id: merged.scope.owner_id,
    realm_id: merged.scope.realm_id,
    leaves: []
  };
  const leaves = Array.isArray(index.leaves) ? index.leaves : [];
  const nextLeaves = leaves.filter((item) => String(item?.bot_id || '') !== merged.scope.bot_id);
  nextLeaves.push({
    bot_id: merged.scope.bot_id,
    display_name: merged.leaf.display_name,
    persona_summary: merged.leaf.persona_summary,
    updated_at: merged.updated_at,
    file: current.file
  });
  nextLeaves.sort((a, b) => String(a.bot_id || '').localeCompare(String(b.bot_id || '')));
  await writeJson(indexFile, {
    schema: 'memory_leaf_index_v0.1',
    owner_id: merged.scope.owner_id,
    realm_id: merged.scope.realm_id,
    leaves: nextLeaves
  });

  return {
    ok: true,
    schema: 'memory_leaf_write_result_v0.1',
    found_before: current.found,
    merge_mode: replace ? 'replace' : 'merge',
    file: current.file,
    index_file: indexFile,
    packet: merged
  };
}
