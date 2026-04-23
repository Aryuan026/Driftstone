import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { SQL_VINES_DIR, getScopedSqlVinesDir } from './path-config.js';

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

async function resolveVinesDir(options = {}) {
  const ownerId = String(options.ownerId || options.owner_id || '').trim();
  const realmId = String(options.realmId || options.realm_id || '').trim();
  if (ownerId || realmId) {
    const scopedDir = getScopedSqlVinesDir(ownerId, realmId);
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
    dir: SQL_VINES_DIR,
    scope_mode: 'global_fallback',
    owner_id: '',
    realm_id: '',
    exists: true
  };
}

export async function loadLatestVinePointer(options = {}) {
  const storage = await resolveVinesDir(options);
  const pointerPath = join(storage.dir, 'latest.json');
  const pointer = storage.exists
    ? await readJson(pointerPath)
    : {
        schema: 'sql_vine_latest_pointer_v0.1',
        generated_at: '',
        latest_snapshot: '',
        edge_count: 0,
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

export async function loadLatestVineIndex(options = {}) {
  const { pointer, storage, pointer_path } = await loadLatestVinePointer(options);
  const index = pointer.latest_snapshot
    ? await readJson(join(pointer.latest_snapshot, 'index.json'))
    : {
        schema: 'sql_vine_index_v0.1',
        generated_at: '',
        scope: {
          owner_id: storage.owner_id || '',
          realm_id: storage.realm_id || ''
        },
        summary: {},
        by_root: {},
        edges: []
      };
  return {
    pointer,
    storage,
    pointer_path,
    index
  };
}

export async function loadRootVines(rootKey, options = {}) {
  const { index } = await loadLatestVineIndex(options);
  return Array.isArray(index?.by_root?.[rootKey]) ? index.by_root[rootKey] : [];
}
