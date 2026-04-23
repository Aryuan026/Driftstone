import { readdir, stat } from 'fs/promises';
import { basename } from 'path';
import { STAGE_DIRS, STAGE_DROPBOX_DIR } from './path-config.js';

const STAGE_META = {
  bundle_raw: { label: '第0轮 bundle', dir: STAGE_DIRS.bundle_raw },
  prepared_bundle: { label: '第1轮 prepared', dir: STAGE_DIRS.prepared_bundle },
  workbench: { label: '第1轮 workbench', dir: STAGE_DIRS.workbench },
  source_index: { label: '第1轮 source index', dir: STAGE_DIRS.source_index },
  reviewed: { label: '第2轮 reviewed', dir: STAGE_DIRS.reviewed }
};

function extractMonthKey(name) {
  const text = String(name || '');
  const dash = text.match(/(20\d{2})-(\d{2})/);
  if (dash) return `${dash[1]}-${dash[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

async function listFiles(dir) {
  try {
    const names = (await readdir(dir)).filter((name) => !name.startsWith('.'));
    const files = [];
    for (const name of names) {
      const filePath = `${dir}/${name}`;
      const meta = await stat(filePath);
      if (!meta.isFile()) continue;
      files.push({
        name,
        month_key: extractMonthKey(name),
        bytes: meta.size,
        updated_at: meta.mtime.toISOString()
      });
    }
    files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return files;
  } catch {
    return [];
  }
}

export async function getStageSummary() {
  const stages = [];
  for (const [key, meta] of Object.entries(STAGE_META)) {
    const files = await listFiles(meta.dir);
    const monthKeys = Array.from(new Set(files.map((file) => file.month_key).filter(Boolean))).sort();
    stages.push({
      key,
      label: meta.label,
      dir: meta.dir,
      count: files.length,
      month_keys: monthKeys,
      files
    });
  }
  return {
    root_dir: STAGE_DROPBOX_DIR,
    stages
  };
}

export async function listReviewedFiles() {
  const files = await listFiles(STAGE_DIRS.reviewed);
  return {
    dir: STAGE_DIRS.reviewed,
    count: files.length,
    files
  };
}

export async function getTruthStoreOverview() {
  const stageSummary = await getStageSummary();
  const reviewed = stageSummary.stages.find((stage) => stage.key === 'reviewed') || { count: 0, month_keys: [], files: [] };
  return {
    truth_store: 'json-file-dropbox',
    root_dir: stageSummary.root_dir,
    stage_counts: stageSummary.stages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      count: stage.count,
      months: stage.month_keys.length
    })),
    reviewed_months: reviewed.month_keys,
    reviewed_count: reviewed.count,
    note: '上游 marker 视为接口合同；后端先围绕 stage_dropbox 和 reviewed 月档长骨架。'
  };
}

