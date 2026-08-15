import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CsvParseError,
  parseCsvLine,
  parseCsvRecords,
  parseCsvText,
  parseCsvTextWithDiagnostics
} from '../core/csv-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const conservationScript = join(repoRoot, 'scripts', 'debug', 'regression_reviewed_csv_conservation.mjs');

test('parseCsvText preserves quoted multiline records and escaped quotes', () => {
  const rows = parseCsvText('record_id,title,text\r\nr1,A,"line one\nline two, with comma"\nr2,B,"escaped ""quote"""');

  assert.equal(rows.length, 2);
  assert.equal(rows[0].record_id, 'r1');
  assert.equal(rows[0].text, 'line one\nline two, with comma');
  assert.equal(rows[1].text, 'escaped "quote"');
});

test('parseCsvRecords returns logical CSV records instead of physical lines', () => {
  const records = parseCsvRecords('a,b\n1,"two\nlines"\n3,4\n');

  assert.deepEqual(records, [
    ['a', 'b'],
    ['1', 'two\nlines'],
    ['3', '4']
  ]);
});

test('parseCsvLine remains a single-line compatibility helper', () => {
  assert.deepEqual(parseCsvLine('a,"b,b","c ""quoted"""'), ['a', 'b,b', 'c "quoted"']);
});

test('parseCsvText fails closed for unclosed quotes', () => {
  assert.throws(
    () => parseCsvText('record_id,title\nr1,"unfinished\n'),
    (error) => {
      assert.equal(error instanceof CsvParseError, true);
      assert.equal(error.diagnostics.errors[0].code, 'unclosed_quote');
      return true;
    }
  );
});

test('parseCsvText fails closed for field count mismatches', () => {
  const tooFew = parseCsvTextWithDiagnostics('a,b\n1\n');
  const tooMany = parseCsvTextWithDiagnostics('a,b\n1,2,3\n');

  assert.equal(tooFew.diagnostics.errors[0].code, 'field_count_mismatch');
  assert.equal(tooFew.diagnostics.errors[0].actual_fields, 1);
  assert.equal(tooMany.diagnostics.errors[0].code, 'field_count_mismatch');
  assert.equal(tooMany.diagnostics.errors[0].actual_fields, 3);
  assert.throws(() => parseCsvText('a,b\n1\n'), CsvParseError);
  assert.throws(() => parseCsvText('a,b\n1,2,3\n'), CsvParseError);
});

test('reviewed CSV conservation script writes a passing ledger for explicit input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftstone-reviewed-good-'));
  try {
    const reviewedDir = join(dir, '02_reviewed');
    const outDir = join(dir, 'out');
    await mkdir(reviewedDir, { recursive: true });
    await writeFile(
      join(reviewedDir, 'reviewed_2025-03.csv'),
      'record_id,title,text\nr1,A,"line one\nline two"\nr2,B,plain\n',
      'utf8'
    );

    const result = spawnSync(process.execPath, [
      conservationScript,
      '--reviewed-dir',
      reviewedDir,
      '--expected-total',
      '2',
      '--expected-empty-record-id',
      '0',
      '--expect-month',
      '2025-03=2',
      '--out-dir',
      outDir
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const ledger = JSON.parse(await readFile(join(outDir, 'reviewed_csv_conservation_ledger.json'), 'utf8'));
    const rejectedRows = await readFile(join(outDir, 'reviewed_csv_rejected_rows.jsonl'), 'utf8');
    assert.equal(ledger.ok, true);
    assert.equal(ledger.totals.reviewed_rows, 2);
    assert.equal(ledger.totals.empty_record_id_rows, 0);
    assert.equal(ledger.months['2025-03'].reviewed_rows, 2);
    assert.equal(rejectedRows, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reviewed CSV conservation script replaces old success with failed-closed ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftstone-reviewed-bad-'));
  try {
    const reviewedDir = join(dir, '02_reviewed');
    const outDir = join(dir, 'out');
    await mkdir(reviewedDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'reviewed_csv_conservation_ledger.json'), '{"ok":true,"status":"old_success"}\n', 'utf8');
    await writeFile(join(reviewedDir, 'reviewed_2025-03.csv'), 'record_id,title\nr1,"unfinished\n', 'utf8');

    const result = spawnSync(process.execPath, [
      conservationScript,
      '--reviewed-dir',
      reviewedDir,
      '--out-dir',
      outDir
    ], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    const ledger = JSON.parse(await readFile(join(outDir, 'reviewed_csv_conservation_ledger.json'), 'utf8'));
    const rejectedRows = await readFile(join(outDir, 'reviewed_csv_rejected_rows.jsonl'), 'utf8');
    assert.equal(ledger.ok, false);
    assert.equal(ledger.status, 'failed_closed');
    assert.equal(ledger.errors[0].code, 'unclosed_quote');
    assert.match(rejectedRows, /unclosed_quote/);
    assert.equal(JSON.stringify(ledger).includes('old_success'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
