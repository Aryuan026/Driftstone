import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export class PrivateOutputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PrivateOutputError';
    this.code = code;
    this.details = details;
  }
}

function pathIsInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function canonicalPrivateOutputTarget(outDir, repoRoot) {
  const requested = resolve(outDir);
  const canonicalRepo = await realpath(repoRoot);
  const canonicalParent = await realpath(dirname(requested));
  const canonicalTarget = resolve(canonicalParent, basename(requested));
  if (pathIsInside(canonicalRepo, canonicalTarget)) {
    throw new PrivateOutputError(
      'private_output_inside_repo',
      'Private output must remain outside the canonical Git worktree.'
    );
  }
  if (await lstatOrNull(requested)) {
    throw new PrivateOutputError(
      'private_output_exists_or_unavailable',
      'Private output target must not already exist.'
    );
  }
  return {
    canonical_parent: canonicalParent,
    canonical_target: canonicalTarget
  };
}

export async function publishPrivateDirectory({
  outDir,
  repoRoot,
  files = {}
} = {}) {
  const target = await canonicalPrivateOutputTarget(outDir, repoRoot);
  const temporary = await mkdtemp(
    join(target.canonical_parent, `.${basename(target.canonical_target)}.tmp-`)
  );
  await chmod(temporary, 0o700);
  try {
    for (const [fileName, content] of Object.entries(files)) {
      if (!fileName || basename(fileName) !== fileName) {
        throw new PrivateOutputError(
          'private_output_filename_invalid',
          'Private output file names must be simple basenames.',
          { file_name: fileName }
        );
      }
      await writeFile(join(temporary, fileName), content, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
      await chmod(join(temporary, fileName), 0o600);
    }
    if (await lstatOrNull(target.canonical_target)) {
      throw new PrivateOutputError(
        'private_output_exists_or_unavailable',
        'Private output target appeared before atomic publish.'
      );
    }
    await rename(temporary, target.canonical_target);
    await chmod(target.canonical_target, 0o700);
    return target.canonical_target;
  } catch (error) {
    const temporaryInfo = await lstatOrNull(temporary);
    if (temporaryInfo?.isDirectory() && !temporaryInfo.isSymbolicLink()) {
      await rm(temporary, { recursive: true, force: false });
    }
    throw error;
  }
}

export async function assertRealPrivateDirectory(directory, label = 'private_directory') {
  const requestedInfo = await lstat(directory);
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
    throw new PrivateOutputError(
      `${label}_invalid`,
      'Private input must be a real directory, not a symlink.'
    );
  }
  return realpath(directory);
}

export async function readPrivateFile(directory, fileName) {
  return readFile(join(directory, fileName));
}
