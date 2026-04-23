import { mkdir, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { OBSIDIAN_STAGING_ROOT, RUNTIME_SAVE_DIR } from './path-config.js';

async function clearDirectoryContents(rootDir = '') {
  await mkdir(rootDir, { recursive: true });
  const entries = await readdir(rootDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries.map((entry) => (
    rm(join(rootDir, entry.name), { recursive: true, force: true })
  )));
  return entries.map((entry) => entry.name);
}

export async function resetLocalRuntimeState() {
  const [runtimeSaveEntries, exportEntries] = await Promise.all([
    clearDirectoryContents(RUNTIME_SAVE_DIR),
    clearDirectoryContents(OBSIDIAN_STAGING_ROOT)
  ]);

  return {
    ok: true,
    cleared: {
      runtime_save: runtimeSaveEntries,
      obsidian_staging: exportEntries
    }
  };
}
