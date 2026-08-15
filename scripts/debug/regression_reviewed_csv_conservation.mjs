#!/usr/bin/env node

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

import { firstValue, parseCsvTextWithDiagnostics } from '../../server/core/csv-reader.js';

const LEDGER_FILE = 'reviewed_csv_conservation_ledger.json';
const REJECTED_FILE = 'reviewed_csv_rejected_rows.jsonl';

function monthKeyFromName(name) {
  const text = String(name || '');
  const dash = text.match(/(20\d{2})-(\d{2})/);
  if (dash) return `${dash[1]}-${dash[2]}`;
  const compact = text.match(/(20\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return 'unknown';
}

function usage() {
  return [
    'Usage:',
    '  node scripts/debug/regression_reviewed_csv_conservation.mjs --reviewed-dir <dir> [options]',
    '  node scripts/debug/regression_reviewed_csv_conservation.mjs --dropbox <dir> [options]',
    '',
    'Options:',
    '  --month YYYY-MM                  Limit to one reviewed month. Repeatable.',
    '  --expected-total N               Fail if reviewed row count differs.',
    '  --expected-empty-record-id N      Fail if empty record_id count differs.',
    '  --expect-month YYYY-MM=N         Fail if one month count differs. Repeatable.',
    '  --out-dir <dir>                  Atomically write ledger and rejected rows.',
    '',
    'This diagnostic requires an explicit source directory. It never defaults to a private corpus path.'
  ].join('\n');
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {
    monthFilters: new Set(),
    expectedMonths: {}
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--reviewed-dir') {
      options.reviewedDir = takeValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--dropbox') {
      options.dropbox = takeValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--month') {
      options.monthFilters.add(takeValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--expected-total') {
      options.expectedTotal = parseInteger(takeValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--expected-empty-record-id') {
      options.expectedEmptyRecordId = parseInteger(takeValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--expect-month') {
      const value = takeValue(argv, index, arg);
      const match = value.match(/^(20\d{2}-\d{2})=(\d+)$/);
      if (!match) throw new Error('--expect-month must look like YYYY-MM=N');
      options.expectedMonths[match[1]] = parseInteger(match[2], arg);
      index += 1;
      continue;
    }
    if (arg === '--out-dir') {
      options.outDir = takeValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function atomicWrite(path, content) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, path);
}

async function writeOutputFiles(outDir, ledger, rejectedRows) {
  const targetDir = resolve(outDir);
  await mkdir(targetDir, { recursive: true });
  const rejectedText = rejectedRows.length
    ? `${rejectedRows.map((row) => JSON.stringify(row)).join('\n')}\n`
    : '';
  await atomicWrite(join(targetDir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`);
  await atomicWrite(join(targetDir, REJECTED_FILE), rejectedText);
}

function buildFailureReport(error, options = {}) {
  const reviewedDir = options.reviewedDir
    ? resolve(options.reviewedDir)
    : options.dropbox
      ? resolve(join(options.dropbox, '02_reviewed'))
      : null;
  return {
    schema: 'driftstone_reviewed_csv_conservation_v0',
    ok: false,
    status: 'input_error',
    generated_at: new Date().toISOString(),
    reviewed_dir: reviewedDir,
    errors: [
      {
        code: 'input_error',
        message: error && error.message ? error.message : String(error)
      }
    ],
    files: [],
    totals: {
      reviewed_rows: 0,
      empty_record_id_rows: 0
    },
    months: {},
    rejected_rows_file: REJECTED_FILE
  };
}

function buildExpectedErrors(totals, months, options) {
  const errors = [];
  if (options.expectedTotal !== undefined && totals.reviewed_rows !== options.expectedTotal) {
    errors.push({
      code: 'expected_total_mismatch',
      expected: options.expectedTotal,
      actual: totals.reviewed_rows
    });
  }
  if (options.expectedEmptyRecordId !== undefined && totals.empty_record_id_rows !== options.expectedEmptyRecordId) {
    errors.push({
      code: 'expected_empty_record_id_mismatch',
      expected: options.expectedEmptyRecordId,
      actual: totals.empty_record_id_rows
    });
  }
  for (const [month, expected] of Object.entries(options.expectedMonths || {})) {
    const actual = months[month]?.reviewed_rows || 0;
    if (actual !== expected) {
      errors.push({
        code: 'expected_month_mismatch',
        month,
        expected,
        actual
      });
    }
  }
  return errors;
}

async function buildLedger(options) {
  if (!options.reviewedDir && !options.dropbox) {
    throw new Error('Pass --reviewed-dir or --dropbox; no default reviewed corpus is assumed.');
  }
  if (options.reviewedDir && options.dropbox) {
    throw new Error('Pass only one of --reviewed-dir or --dropbox.');
  }

  const reviewedDir = resolve(options.reviewedDir || join(options.dropbox, '02_reviewed'));
  const names = (await readdir(reviewedDir))
    .filter((name) => !name.startsWith('.') && name.toLowerCase().endsWith('.csv'))
    .sort();
  const selectedNames = names.filter((name) => {
    if (!options.monthFilters.size) return true;
    return options.monthFilters.has(monthKeyFromName(name));
  });

  const rejectedRows = [];
  const files = [];
  const months = {};
  const totals = {
    reviewed_rows: 0,
    empty_record_id_rows: 0
  };

  if (!selectedNames.length) {
    rejectedRows.push({
      code: 'no_reviewed_csv_files',
      reviewed_dir: reviewedDir,
      month_filters: Array.from(options.monthFilters)
    });
  }

  for (const name of selectedNames) {
    const filePath = join(reviewedDir, name);
    const month = monthKeyFromName(name);
    const raw = await readFile(filePath, 'utf8');
    const parsed = parseCsvTextWithDiagnostics(raw);
    const fileErrors = parsed.diagnostics.errors.map((error) => ({
      code: error.code || 'csv_parse_error',
      file: name,
      month,
      line: error.line || null,
      record_index: error.record_index ?? null,
      expected_fields: error.expected_fields ?? null,
      actual_fields: error.actual_fields ?? null,
      message: error.message || 'CSV parse error'
    }));
    rejectedRows.push(...fileErrors);
    if (fileErrors.length) {
      files.push({
        file: name,
        month,
        status: 'malformed_csv',
        reviewed_rows: 0,
        empty_record_id_rows: 0,
        diagnostics: parsed.diagnostics
      });
      continue;
    }

    const emptyRecordIdRows = parsed.rows.filter((row) => !firstValue(row, ['record_id'])).length;
    totals.reviewed_rows += parsed.rows.length;
    totals.empty_record_id_rows += emptyRecordIdRows;
    months[month] = months[month] || {
      reviewed_rows: 0,
      empty_record_id_rows: 0,
      files: []
    };
    months[month].reviewed_rows += parsed.rows.length;
    months[month].empty_record_id_rows += emptyRecordIdRows;
    months[month].files.push(name);
    files.push({
      file: name,
      month,
      status: 'accepted',
      reviewed_rows: parsed.rows.length,
      empty_record_id_rows: emptyRecordIdRows,
      diagnostics: parsed.diagnostics
    });
  }

  const expectedErrors = buildExpectedErrors(totals, months, options);
  const errors = [
    ...rejectedRows.map((row) => ({
      code: row.code,
      file: row.file || null,
      month: row.month || null,
      message: row.message || row.code
    })),
    ...expectedErrors
  ];
  const ok = errors.length === 0;

  return {
    ledger: {
      schema: 'driftstone_reviewed_csv_conservation_v0',
      ok,
      status: ok ? 'pass' : 'failed_closed',
      generated_at: new Date().toISOString(),
      reviewed_dir: reviewedDir,
      month_filters: Array.from(options.monthFilters),
      expected: {
        reviewed_rows: options.expectedTotal ?? null,
        empty_record_id_rows: options.expectedEmptyRecordId ?? null,
        months: options.expectedMonths || {}
      },
      totals,
      months,
      files,
      errors,
      rejected_rows_file: REJECTED_FILE
    },
    rejectedRows
  };
}

async function main() {
  let options = {};
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const { ledger, rejectedRows } = await buildLedger(options);
    if (options.outDir) await writeOutputFiles(options.outDir, ledger, rejectedRows);
    console.log(JSON.stringify(ledger, null, 2));
    process.exitCode = ledger.ok ? 0 : 1;
  } catch (error) {
    const ledger = buildFailureReport(error, options);
    if (options.outDir) await writeOutputFiles(options.outDir, ledger, []);
    console.error(error && error.message ? error.message : String(error));
    console.log(JSON.stringify(ledger, null, 2));
    process.exitCode = 2;
  }
}

await main();
