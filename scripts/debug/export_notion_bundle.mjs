#!/usr/bin/env node
// Debug-only helper: export a machine-readable Notion-style bundle from
// reviewed/cache snapshots without touching the main UI flow.

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeMonth(value = '') {
  const text = safeText(value);
  if (!text) return '';
  const dashed = text.match(/(20\d{2})-(\d{2})/);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return '';
}

function parseArgs(argv = []) {
  const out = {
    monthHints: [],
    rootDir: '',
    dropboxDir: '',
    overwrite: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    if (!arg) continue;
    if (arg === '--month' && argv[index + 1]) {
      const month = normalizeMonth(argv[index + 1]);
      if (month) out.monthHints.push(month);
      index += 1;
      continue;
    }
    if (arg === '--root' && argv[index + 1]) {
      out.rootDir = safeText(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--dropbox' && argv[index + 1]) {
      out.dropboxDir = safeText(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--no-overwrite') {
      out.overwrite = false;
      continue;
    }
  }
  out.monthHints = Array.from(new Set(out.monthHints));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dropboxDir) {
    process.env.HIPPOCOVE_STAGE_DROPBOX = args.dropboxDir;
  }
  const { exportNotionMemoryCoreBundle } = await import('../../server/core/notion-export-service.js');
  const result = await exportNotionMemoryCoreBundle({
    monthHints: args.monthHints,
    rootDir: args.rootDir,
    overwrite: args.overwrite
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: safeText(error?.message, String(error || 'unknown error'))
  }, null, 2));
  process.exitCode = 1;
});
