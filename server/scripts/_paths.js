import { access } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROJECT_ROOT, STAGE_DIRS } from '../core/path-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export { PROJECT_ROOT };

export const SCRIPTS_DIR = __dirname;
export const AUDIT_CHECKPOINTS_DIR = join(PROJECT_ROOT, 'docs', 'audits', 'checkpoints');
export const DEFAULT_SMOKE_BUNDLE_FILE = join(STAGE_DIRS.bundle_raw, 'memsrc_2025-02_bundle.json');

export async function assertLocalFixtureExists(filePath) {
  try {
    await access(filePath);
  } catch {
    throw new Error(
      [
        `Missing local fixture bundle: ${filePath}`,
        'Place your private sample bundle under',
        '`data/local_fixtures/stage_dropbox/00_bundle_raw/`',
        'or pass a bundle path explicitly to the script.'
      ].join(' ')
    );
  }
}
