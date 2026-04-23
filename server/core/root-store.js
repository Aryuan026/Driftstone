import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { SQL_ROOTS_DIR, getScopedSqlRootsDir } from './path-config.js';
import { loadFamilyLedger, findFamilyRefsForRoot, findLinkedPersonaRefsForRoot } from './family-store.js';
import { getAtomicFactsForRoot } from './atomic-fact-store.js';

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRootsDir(options = {}) {
  const ownerId = String(options.ownerId || options.owner_id || '').trim();
  const realmId = String(options.realmId || options.realm_id || '').trim();
  if (ownerId || realmId) {
    const scopedDir = getScopedSqlRootsDir(ownerId, realmId);
    const scopedPointer = join(scopedDir, 'latest.json');
    if (await fileExists(scopedPointer)) {
      return {
        dir: scopedDir,
        scope_mode: 'scoped',
        owner_id: ownerId,
        realm_id: realmId,
        exists: true
      };
    }
    return {
      dir: scopedDir,
      scope_mode: 'scoped_empty',
      owner_id: ownerId,
      realm_id: realmId,
      exists: false
    };
  }
  return {
    dir: SQL_ROOTS_DIR,
    scope_mode: 'global_fallback',
    owner_id: '',
    realm_id: '',
    exists: true
  };
}

export async function loadLatestRootPointer(options = {}) {
  const storage = await resolveRootsDir(options);
  const pointerPath = join(storage.dir, 'latest.json');
  const pointer = storage.exists
    ? await readJson(pointerPath)
    : {
        schema: 'sql_root_latest_pointer_v0.1',
        generated_at: '',
        latest_snapshot: '',
        root_count: 0,
        scope: {
          owner_id: storage.owner_id || '',
          realm_id: storage.realm_id || ''
        }
      };
  return {
    pointer,
    storage,
    pointer_path: pointerPath
  };
}

export async function loadLatestRootIndex(options = {}) {
  const { pointer, storage, pointer_path } = await loadLatestRootPointer(options);
  const indexPath = pointer.latest_snapshot ? join(pointer.latest_snapshot, 'index.json') : '';
  const index = indexPath
    ? await readJson(indexPath)
    : {
        schema: 'sql_root_index_v0.1',
        generated_at: '',
        scope: {
          owner_id: storage.owner_id || '',
          realm_id: storage.realm_id || ''
        },
        summary: {},
        roots: []
      };
  return {
    pointer,
    storage,
    pointer_path,
    index,
    index_path: indexPath
  };
}

export async function loadRootCardByFile(filePath) {
  return readJson(filePath);
}

export async function loadRootCardByKey(rootKey, options = {}) {
  const { index, storage } = await loadLatestRootIndex(options);
  const hit = (Array.isArray(index?.roots) ? index.roots : []).find((item) => item.root_key === rootKey);
  if (!hit?.file) return null;
  const card = await loadRootCardByFile(hit.file);
  const ownerId = String(options.ownerId || options.owner_id || '').trim();
  const realmId = String(options.realmId || options.realm_id || '').trim();
  const familyLedgerHit = await loadFamilyLedger({ ownerId, realmId });
  const familyRefs = findFamilyRefsForRoot(card, familyLedgerHit?.ledger || {});
  const linkedPersonaRefs = findLinkedPersonaRefsForRoot(card, familyLedgerHit?.ledger || {});
  const atomicFactHit = await getAtomicFactsForRoot(card, {
    ownerId,
    realmId,
    familyRefs
  });
  return {
    card: {
      ...card,
      family_refs: familyRefs,
      linked_persona_refs: linkedPersonaRefs,
      atomic_facts: atomicFactHit.facts,
      atomic_fact_conflict_keys: atomicFactHit.conflict_keys,
      family_related_atomic_facts: atomicFactHit.family_related_facts,
      family_related_atomic_conflict_keys: atomicFactHit.family_related_conflict_keys
    },
    index_row: hit,
    storage
  };
}

export async function loadAllRootCards(options = {}) {
  const { index, storage } = await loadLatestRootIndex(options);
  const roots = Array.isArray(index?.roots) ? index.roots : [];
  const cards = [];
  for (const item of roots) {
    if (!item?.file) continue;
    const card = await loadRootCardByFile(item.file);
    cards.push({
      index_row: item,
      card,
      storage
    });
  }
  return cards;
}

export async function searchRootCards(query, options = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 20;
  const { index } = await loadLatestRootIndex(options);
  const roots = Array.isArray(index?.roots) ? index.roots : [];
  if (!needle) return roots.slice(0, limit);
  return roots
    .filter((item) => {
      const hay = `${item.root_key || ''} ${item.canonical_name || ''} ${item.anchor_type || ''} ${item.tree_path || ''}`.toLowerCase();
      return hay.includes(needle);
    })
    .slice(0, limit);
}
