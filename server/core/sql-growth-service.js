import { getStageSummary, getTruthStoreOverview, listReviewedFiles } from './truth-store.js';
import { getReviewedSummary, loadReviewedDataset } from './reviewed-store.js';
import { buildGrowthSnapshot } from './growth-engine.js';
import { materializeSqlRoots } from './root-materializer.js';
import { loadAllRootCards, loadLatestRootPointer } from './root-store.js';
import { buildVineSnapshot, materializeSqlVines } from './vine-materializer.js';

export async function getBackendHealth() {
  return {
    ok: true,
    area: 'hippocove-backend',
    mode: 'local-json-runtime-save',
    message: '后端骨架已起，默认使用本地 runtime save 与仓内示例目录。'
  };
}

export async function getSqlGrowthSummary() {
  const overview = await getTruthStoreOverview();
  return {
    ...overview,
    next_focus: [
      'normalized placement record',
      'monthly writeback',
      'AI placement',
      'canonicalization',
      'relation edges'
    ],
    architecture_shape: {
      backend_core: true,
      page_shell: true,
      mcp_ready: true,
      persona_entry_ready: true
    }
  };
}

export async function getSqlGrowthFixtures() {
  return getStageSummary();
}

export async function getReviewedCatalog() {
  const [catalog, summary] = await Promise.all([
    listReviewedFiles(),
    getReviewedSummary()
  ]);
  return {
    ...catalog,
    totals: summary.totals,
    months: summary.months.map((item) => ({
      month_key: item.month_key,
      file: item.file,
      rows: item.rows,
      layers: item.layers,
      sql_evolution: item.sql_evolution
    }))
  };
}

export async function getReviewedDeepSummary() {
  return getReviewedSummary();
}

export async function getGrowthWritebackPreview() {
  const dataset = await loadReviewedDataset({ layers: ['sql'] });
  const snapshot = buildGrowthSnapshot(dataset.rows, dataset.files);
  return {
    source: {
      reviewed_dir: dataset.files.length ? 'stage_dropbox/02_reviewed' : '',
      months: dataset.files.length,
      sql_rows: dataset.rows.length
    },
    summary: snapshot.summary,
    sample_roots: snapshot.roots.slice(0, 12).map((root) => ({
      root_key: root.root_key,
      tree_path: root.tree_path,
      anchor_type: root.anchor_type,
      canonical_name: root.canonical_name,
      version_count: root.version_count,
      branch_count: root.branch_count,
      evolution_status: root.evolution_status,
      first_seen_at: root.first_seen_at,
      last_seen_at: root.last_seen_at,
      stable_facts: root.stable_facts.slice(0, 4),
      source_batches: root.source_batches.slice(0, 6)
    })),
    sample_placement_records: snapshot.placement_records.slice(0, 12).map((record) => ({
      key: record.key,
      anchor_type: record.anchor_type,
      canonical_name: record.canonical_name,
      action: record.action,
      confidence: record.confidence,
      evidence_batches: record.evidence_set.batches.length,
      evidence_windows: record.evidence_set.windows.length,
      stable_fact_candidates: record.stable_fact_candidates.slice(0, 3)
    }))
  };
}

export async function materializeGrowthTruthSnapshot(options = {}) {
  const dataset = await loadReviewedDataset({ layers: ['sql'] });
  const snapshot = buildGrowthSnapshot(dataset.rows, dataset.files);
  const materialized = await materializeSqlRoots(snapshot, {
    label: options.label || 'reviewed_13m',
    source_kind: 'reviewed_growth_writeback',
    source_label: 'stage_dropbox/02_reviewed',
    owner_id: options.owner_id || '',
    realm_id: options.realm_id || ''
  });
  return {
    source: {
      reviewed_dir: 'stage_dropbox/02_reviewed',
      months: dataset.files.length,
      sql_rows: dataset.rows.length
    },
    summary: snapshot.summary,
    materialized
  };
}

export async function materializeVineTruthSnapshot(options = {}) {
  const cards = await loadAllRootCards({
    ownerId: options.owner_id,
    realmId: options.realm_id
  });
  const { pointer: rootsPointer } = await loadLatestRootPointer({
    ownerId: options.owner_id,
    realmId: options.realm_id
  });
  const snapshot = buildVineSnapshot(cards);
  const materialized = await materializeSqlVines(snapshot, {
    label: options.label || 'reviewed_13m',
    source_label: 'truth_layer/sql_roots',
    source_roots_snapshot: rootsPointer.latest_snapshot,
    owner_id: options.owner_id || '',
    realm_id: options.realm_id || ''
  });
  return {
    summary: snapshot.summary,
    materialized
  };
}
