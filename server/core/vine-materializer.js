import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { SQL_VINES_DIR, getScopedSqlVinesDir } from './path-config.js';

function safeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unnamed';
}

function uniqueStrings(items, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function intersection(a, b, limit = 12) {
  const setB = new Set(Array.isArray(b) ? b.map((item) => String(item || '').trim()).filter(Boolean) : []);
  const out = [];
  for (const item of Array.isArray(a) ? a : []) {
    const text = String(item || '').trim();
    if (!text || !setB.has(text) || out.includes(text)) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function edgeScore(overlap) {
  return (overlap.windows.length * 3) + (overlap.topics.length * 2) + overlap.persona_refs.length;
}

function pickPrimaryRelation(overlap) {
  const weighted = [
    ['shared_window', overlap.windows.length * 3],
    ['shared_topic', overlap.topics.length * 2],
    ['shared_persona_ref', overlap.persona_refs.length]
  ].sort((a, b) => b[1] - a[1]);
  return weighted[0][1] > 0 ? weighted[0][0] : 'related';
}

function shouldKeepEdge(overlap, score) {
  if (overlap.windows.length >= 2) return true;
  if (overlap.topics.length >= 2) return true;
  if (overlap.persona_refs.length >= 2) return true;
  if (overlap.windows.length >= 1 && overlap.topics.length >= 1) return true;
  if (overlap.windows.length >= 1 && overlap.persona_refs.length >= 1) return true;
  if (score >= 4) return true;
  return false;
}

function buildRootStub(card) {
  return {
    root_key: card.root_key,
    canonical_name: card.canonical_name,
    anchor_type: card.anchor_type,
    tree_path: card.tree_path
  };
}

export function buildVineSnapshot(rootCards) {
  const pairs = [];
  const byRoot = new Map();
  const cards = Array.isArray(rootCards) ? rootCards.map((item) => item.card || item).filter(Boolean) : [];

  for (let i = 0; i < cards.length; i += 1) {
    const left = cards[i];
    const leftProv = left?.provenance || {};
    for (let j = i + 1; j < cards.length; j += 1) {
      const right = cards[j];
      const rightProv = right?.provenance || {};
      const overlap = {
        windows: intersection(leftProv.source_windows, rightProv.source_windows, 8),
        topics: intersection(leftProv.topic_ids, rightProv.topic_ids, 8),
        persona_refs: intersection(leftProv.persona_refs, rightProv.persona_refs, 8)
      };
      const score = edgeScore(overlap);
      if (!shouldKeepEdge(overlap, score)) continue;
      const edge = {
        edge_key: `${left.root_key}__${right.root_key}`,
        from_root: buildRootStub(left),
        to_root: buildRootStub(right),
        primary_relation: pickPrimaryRelation(overlap),
        score,
        overlap
      };
      pairs.push(edge);
      if (!byRoot.has(left.root_key)) byRoot.set(left.root_key, []);
      if (!byRoot.has(right.root_key)) byRoot.set(right.root_key, []);
      byRoot.get(left.root_key).push({
        direction: 'out',
        other: buildRootStub(right),
        primary_relation: edge.primary_relation,
        score,
        overlap
      });
      byRoot.get(right.root_key).push({
        direction: 'out',
        other: buildRootStub(left),
        primary_relation: edge.primary_relation,
        score,
        overlap
      });
    }
  }

  for (const [rootKey, edges] of byRoot.entries()) {
    byRoot.set(rootKey, edges.sort((a, b) => b.score - a.score).slice(0, 12));
  }

  return {
    summary: {
      roots: cards.length,
      edges: pairs.length,
      rooted_edges: Array.from(byRoot.values()).reduce((sum, list) => sum + list.length, 0)
    },
    edges: pairs.sort((a, b) => b.score - a.score),
    by_root: Object.fromEntries(byRoot)
  };
}

export async function materializeSqlVines(snapshot, options = {}) {
  const generatedAt = new Date().toISOString();
  const label = safeSegment(options.label || 'snapshot');
  const vinesDir = options.owner_id || options.realm_id
    ? getScopedSqlVinesDir(options.owner_id, options.realm_id)
    : SQL_VINES_DIR;
  const snapshotDir = join(vinesDir, 'snapshots', label);
  await mkdir(snapshotDir, { recursive: true });

  const indexDoc = {
    schema: 'sql_vine_index_v0.1',
    generated_at: generatedAt,
    source_label: options.source_label || '',
    source_roots_snapshot: options.source_roots_snapshot || '',
    scope: {
      owner_id: options.owner_id || '',
      realm_id: options.realm_id || ''
    },
    summary: snapshot?.summary || {},
    by_root: snapshot?.by_root || {},
    edges: snapshot?.edges || []
  };

  const indexFile = join(snapshotDir, 'index.json');
  const latestFile = join(vinesDir, 'latest.json');
  await writeFile(indexFile, `${JSON.stringify(indexDoc, null, 2)}\n`, 'utf-8');
  await writeFile(latestFile, `${JSON.stringify({
    schema: 'sql_vine_latest_pointer_v0.1',
    generated_at: generatedAt,
    latest_snapshot: snapshotDir,
    edge_count: snapshot?.summary?.edges || 0,
    scope: {
      owner_id: options.owner_id || '',
      realm_id: options.realm_id || ''
    }
  }, null, 2)}\n`, 'utf-8');

  return {
    generated_at: generatedAt,
    snapshot_dir: snapshotDir,
    edge_count: snapshot?.summary?.edges || 0,
    index_file: indexFile,
    scope: {
      owner_id: options.owner_id || '',
      realm_id: options.realm_id || ''
    }
  };
}
