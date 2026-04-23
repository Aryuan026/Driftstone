import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SERVER_DIR = join(__dirname, '..');
export const PROJECT_ROOT = join(__dirname, '..', '..');
const ENV_DATA_ROOT = process.env.HIPPOCOVE_DATA_ROOT || '';
const ENV_OUTPUT_ROOT = process.env.HIPPOCOVE_OUTPUT_ROOT || '';
export const DATA_DIR = ENV_DATA_ROOT || join(PROJECT_ROOT, 'data');
export const LOCAL_FIXTURES_DIR = join(DATA_DIR, 'local_fixtures');
export const RUNTIME_SAVE_DIR = join(DATA_DIR, 'runtime_save');
export const DEFAULT_STAGE_DROPBOX_DIR = join(LOCAL_FIXTURES_DIR, 'stage_dropbox');
const OUTPUT_DIR = ENV_OUTPUT_ROOT || join(PROJECT_ROOT, 'output');
export const DEFAULT_OBSIDIAN_ROOT = join(OUTPUT_DIR, 'obsidian_staging');
const ENV_STAGE_DROPBOX = process.env.HIPPOCOVE_STAGE_DROPBOX || '';
const ENV_OBSIDIAN_ROOT = process.env.HIPPOCOVE_OBSIDIAN_ROOT || '';
const STAGE_ROOT_CANDIDATES = [
  ENV_STAGE_DROPBOX,
  DEFAULT_STAGE_DROPBOX_DIR
];

function resolveStageDropboxDir() {
  for (const dir of STAGE_ROOT_CANDIDATES) {
    if (!dir) continue;
    const reviewedDir = join(dir, '02_reviewed');
    const workbenchDir = join(dir, '01_workbench');
    if (existsSync(reviewedDir) && existsSync(workbenchDir)) {
      return dir;
    }
  }
  return STAGE_ROOT_CANDIDATES[0];
}

export const STAGE_DROPBOX_DIR = resolveStageDropboxDir();
export const TRUTH_LAYER_DIR = join(RUNTIME_SAVE_DIR, 'truth_layer');
export const SQL_ROOTS_DIR = join(TRUTH_LAYER_DIR, 'sql_roots');
export const SQL_VINES_DIR = join(TRUTH_LAYER_DIR, 'sql_vines');
export const FAMILY_LEDGER_DIR = join(TRUTH_LAYER_DIR, 'family_ledger');
export const ATOMIC_FACT_DIR = join(TRUTH_LAYER_DIR, 'atomic_facts');
export const TAG_HINT_DIR = join(TRUTH_LAYER_DIR, 'tag_hints');
export const CARD_REGISTRY_DIR = join(TRUTH_LAYER_DIR, 'card_registry');
export const GROWTH_LEDGER_DIR = join(TRUTH_LAYER_DIR, 'growth_ledger');
export const GROWTH_DRAFT_DIR = join(TRUTH_LAYER_DIR, 'growth_drafts');
export const SCOPED_TRUTH_DIR = join(TRUTH_LAYER_DIR, 'scopes');
export const INGRESS_DIR = join(TRUTH_LAYER_DIR, 'ingest_packets');
export const OBSIDIAN_STAGING_ROOT = ENV_OBSIDIAN_ROOT || DEFAULT_OBSIDIAN_ROOT;

mkdirSync(RUNTIME_SAVE_DIR, { recursive: true });
mkdirSync(DEFAULT_STAGE_DROPBOX_DIR, { recursive: true });
mkdirSync(OBSIDIAN_STAGING_ROOT, { recursive: true });

export const STAGE_DIRS = {
  bundle_raw: join(STAGE_DROPBOX_DIR, '00_bundle_raw'),
  prepared_bundle: join(STAGE_DROPBOX_DIR, '01_prepared_bundle'),
  workbench: join(STAGE_DROPBOX_DIR, '01_workbench'),
  source_index: join(STAGE_DROPBOX_DIR, '01_source_index'),
  reviewed: join(STAGE_DROPBOX_DIR, '02_reviewed')
};

export function safeScopeSegment(value, fallback = 'default') {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return text || fallback;
}

export function getScopedTruthDir(ownerId = '', realmId = '') {
  return join(
    SCOPED_TRUTH_DIR,
    safeScopeSegment(ownerId, 'default-owner'),
    safeScopeSegment(realmId, 'default')
  );
}

export function getScopedSqlRootsDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'sql_roots');
}

export function getScopedSqlVinesDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'sql_vines');
}

export function getScopedFamilyLedgerDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'family_ledger');
}

export function getScopedAtomicFactDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'atomic_facts');
}

export function getScopedTagHintDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'tag_hints');
}

export function getScopedCardRegistryDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'card_registry');
}

export function getScopedGrowthLedgerDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'growth_ledger');
}

export function getScopedGrowthDraftDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'growth_drafts');
}

export function getScopedIngressDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'ingest_packets');
}

export function getScopedTranslationDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'translation_packets');
}

export function getScopedTranslationTaskDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'translation_tasks');
}

export function getScopedReviewedDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'reviewed_packets');
}

export function getScopedObsidianStagingRoot(ownerId = '', realmId = '') {
  const scopedOwner = safeScopeSegment(ownerId, 'default-owner');
  const scopedRealm = safeScopeSegment(realmId, 'default');
  return join(OBSIDIAN_STAGING_ROOT, `${scopedOwner}__${scopedRealm}`);
}

export function getScopedLeafDir(ownerId = '', realmId = '') {
  return join(getScopedTruthDir(ownerId, realmId), 'leaf_profiles');
}

export function getScopedLeafBotsDir(ownerId = '', realmId = '') {
  return join(getScopedLeafDir(ownerId, realmId), 'bots');
}

export function getScopedLeafBotFile(ownerId = '', realmId = '', botId = '') {
  return join(
    getScopedLeafBotsDir(ownerId, realmId),
    `${safeScopeSegment(botId, 'default-bot')}.json`
  );
}
