#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { parseCsvLine, parseCsvText, parseCsvTextWithDiagnostics } from '../../server/core/csv-reader.js';

const EXPECTED_REVIEWED_TOTAL = 16274;
const EXPECTED_MONTH_ROWS = {
  '2025-02': 573,
  '2025-03': 308,
  '2025-04': 575,
  '2025-05': 653,
  '2025-06': 1255,
  '2025-07': 1386,
  '2025-08': 1777,
  '2025-09': 2197,
  '2025-10': 2017,
  '2025-11': 2198,
  '2025-12': 1513,
  '2026-01': 1335,
  '2026-02': 487
};

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function parseArgs(argv = []) {
  const out = {
    dropboxDir: process.env.HIPPOCOVE_STAGE_DROPBOX || '/Users/mac/Documents/Ajimem'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = safeText(argv[index]);
    if (arg === '--dropbox' && argv[index + 1]) {
      out.dropboxDir = safeText(argv[index + 1], out.dropboxDir);
      index += 1;
    }
  }
  return out;
}

function monthFromName(name = '') {
  const text = safeText(name);
  const compact = text.match(/(20\d{2})(\d{2})/u);
  if (compact) return `${compact[1]}-${compact[2]}`;
  const dashed = text.match(/(20\d{2})-(\d{2})/u);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;
  return '';
}

function assertQuotedMultilineParser() {
  const csv = [
    'record_id,title,body',
    'r1,"first line',
    'second line","comma, kept"',
    'r2,"escaped ""quote""",plain'
  ].join('\n');
  const rows = parseCsvText(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].record_id, 'r1');
  assert.equal(rows[0].body, 'comma, kept');
  assert.equal(rows[0].title, 'first line\nsecond line');
  assert.equal(rows[1].title, 'escaped "quote"');
}

function assertSingleLineCompatibilityHelper() {
  const cols = parseCsvLine('a,"b,b","escaped ""quote"""');
  assert.deepEqual(cols, ['a', 'b,b', 'escaped "quote"']);
}

function assertMalformedCsvDiagnostics() {
  const unclosed = parseCsvTextWithDiagnostics('record_id,title\nr1,"unterminated');
  assert.equal(unclosed.rows.length, 0);
  assert.equal(unclosed.diagnostics.errors.some((error) => error.code === 'unclosed_quote'), true);
  assert.throws(() => parseCsvText('record_id,title\nr1,"unterminated'), /Malformed CSV input/u);

  const tooFew = parseCsvTextWithDiagnostics('record_id,title,body\nr1,title-only');
  assert.equal(tooFew.rows.length, 0);
  assert.equal(tooFew.diagnostics.errors.some((error) => error.code === 'field_count_mismatch' && error.actual_fields === 2), true);
  assert.throws(() => parseCsvText('record_id,title,body\nr1,title-only'), /Malformed CSV input/u);

  const tooMany = parseCsvTextWithDiagnostics('record_id,title\nr1,title,extra');
  assert.equal(tooMany.rows.length, 0);
  assert.equal(tooMany.diagnostics.errors.some((error) => error.code === 'field_count_mismatch' && error.actual_fields === 3), true);
  assert.throws(() => parseCsvText('record_id,title\nr1,title,extra'), /Malformed CSV input/u);
}

async function main() {
  assertQuotedMultilineParser();
  assertSingleLineCompatibilityHelper();
  assertMalformedCsvDiagnostics();
  const args = parseArgs(process.argv.slice(2));
  const reviewedDir = join(args.dropboxDir, '02_reviewed');
  assert.ok(existsSync(reviewedDir), `reviewed dir not found: ${reviewedDir}`);

  const files = (await readdir(reviewedDir))
    .filter((name) => !name.startsWith('.') && name.toLowerCase().endsWith('.csv'))
    .sort();
  assert.equal(files.length, Object.keys(EXPECTED_MONTH_ROWS).length, 'unexpected reviewed csv month count');

  const months = [];
  let totalRows = 0;
  let emptyRecordIdRows = 0;
  for (const file of files) {
    const month = monthFromName(file);
    const raw = await readFile(join(reviewedDir, file), 'utf8');
    const parsed = parseCsvTextWithDiagnostics(raw);
    const rows = parsed.rows;
    const emptyRecordId = rows.filter((row) => !safeText(row.record_id)).length;
    months.push({
      month,
      file,
      rows: rows.length,
      empty_record_id_rows: emptyRecordId,
      physical_lines: parsed.diagnostics.physical_lines,
      csv_records: parsed.diagnostics.csv_records
    });
    assert.equal(rows.length, EXPECTED_MONTH_ROWS[month], `${file} row conservation failed`);
    assert.equal(emptyRecordId, 0, `${file} produced empty record_id pseudo rows`);
    totalRows += rows.length;
    emptyRecordIdRows += emptyRecordId;
  }

  assert.equal(totalRows, EXPECTED_REVIEWED_TOTAL, '13-month reviewed total mismatch');
  assert.equal(emptyRecordIdRows, 0, 'empty record_id pseudo rows must stay zero');
  console.log(JSON.stringify({
    ok: true,
    dropbox_dir: args.dropboxDir,
    reviewed_rows: totalRows,
    empty_record_id_rows: emptyRecordIdRows,
    months
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: safeText(error?.message, String(error || 'unknown error'))
  }, null, 2));
  process.exitCode = 1;
});
