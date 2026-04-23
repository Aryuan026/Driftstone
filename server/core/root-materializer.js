import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { SQL_ROOTS_DIR, getScopedSqlRootsDir } from './path-config.js';

function safeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unnamed';
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function buildRootCardDoc(root, meta = {}) {
  return {
    schema: 'sql_root_card_v0.1',
    generated_at: meta.generated_at,
    source_kind: meta.source_kind || 'reviewed_growth_writeback',
    source_label: meta.source_label || '',
    root_key: root.root_key,
    tree_path: root.tree_path,
    anchor_type: root.anchor_type,
    canonical_name: root.canonical_name,
    trunk: root.candidate_trunk || '',
    secondary_slot: root.candidate_secondary_slot || '',
    slot_path: root.slot_path || '',
    slot_owner_hint: root.slot_owner_hint || '',
    first_seen_at: root.first_seen_at || '',
    last_seen_at: root.last_seen_at || '',
    version_count: root.version_count || 0,
    branch_count: root.branch_count || 0,
    evolution_status: root.evolution_status || '',
    stable_facts: Array.isArray(root.stable_facts) ? root.stable_facts : [],
    recent_updates: Array.isArray(root.recent_updates) ? root.recent_updates : [],
    provenance: {
      source_batches: Array.isArray(root.source_batches) ? root.source_batches : [],
      source_refs: Array.isArray(root.source_refs) ? root.source_refs : [],
      source_windows: Array.isArray(root.source_windows) ? root.source_windows : [],
      topic_ids: Array.isArray(root.topic_ids) ? root.topic_ids : [],
      persona_refs: Array.isArray(root.persona_refs) ? root.persona_refs : [],
      source_group_keys: Array.isArray(root.source_group_keys) ? root.source_group_keys : []
    },
    conflict_hint: !!root.conflict_hint
  };
}

export async function materializeSqlRoots(snapshot, options = {}) {
  const generatedAt = new Date().toISOString();
  const label = safeSegment(options.label || `snapshot_${nowStamp()}`);
  const rootsDir = options.owner_id || options.realm_id
    ? getScopedSqlRootsDir(options.owner_id, options.realm_id)
    : SQL_ROOTS_DIR;
  const snapshotDir = join(rootsDir, 'snapshots', label);
  const cardsDir = join(snapshotDir, 'cards');
  await mkdir(cardsDir, { recursive: true });

  const roots = Array.isArray(snapshot?.roots) ? snapshot.roots : [];
  const indexRows = [];

  for (const root of roots) {
    const typeDir = join(cardsDir, safeSegment(root.anchor_type || 'unknown'));
    await mkdir(typeDir, { recursive: true });
    const filename = `${safeSegment(root.canonical_name)}__${safeSegment(root.root_key)}.json`;
    const filePath = join(typeDir, filename);
    const doc = buildRootCardDoc(root, {
      generated_at: generatedAt,
      source_kind: options.source_kind || 'reviewed_growth_writeback',
      source_label: options.source_label || ''
    });
    await writeFile(filePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
    indexRows.push({
      root_key: doc.root_key,
      tree_path: doc.tree_path,
      anchor_type: doc.anchor_type,
      canonical_name: doc.canonical_name,
      version_count: doc.version_count,
      branch_count: doc.branch_count,
      evolution_status: doc.evolution_status,
      file: filePath
    });
  }

  const indexDoc = {
    schema: 'sql_root_index_v0.1',
    generated_at: generatedAt,
    source_kind: options.source_kind || 'reviewed_growth_writeback',
    source_label: options.source_label || '',
    scope: {
      owner_id: options.owner_id || '',
      realm_id: options.realm_id || ''
    },
    summary: snapshot?.summary || {},
    roots: indexRows
  };
  await writeFile(join(snapshotDir, 'index.json'), `${JSON.stringify(indexDoc, null, 2)}\n`, 'utf-8');
  await writeFile(join(rootsDir, 'latest.json'), `${JSON.stringify({
    schema: 'sql_root_latest_pointer_v0.1',
    generated_at: generatedAt,
    latest_snapshot: snapshotDir,
    root_count: indexRows.length,
    scope: {
      owner_id: options.owner_id || '',
      realm_id: options.realm_id || ''
    }
  }, null, 2)}\n`, 'utf-8');

  return {
    generated_at: generatedAt,
    snapshot_dir: snapshotDir,
    root_count: indexRows.length,
    index_file: join(snapshotDir, 'index.json'),
    scope: {
      owner_id: options.owner_id || '',
      realm_id: options.realm_id || ''
    }
  };
}
