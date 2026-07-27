export class CsvParseError extends Error {
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'CsvParseError';
    this.diagnostics = diagnostics;
  }
}

export function parseCsvLine(line) {
  // Single-line compatibility helper only. Use parseCsvText/parseCsvRecords
  // for real reviewed CSV files because reviewed rows can contain newlines.
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function scanCsvRecords(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '');
  const records = [];
  const recordStarts = [];
  const errors = [];
  let current = '';
  let fields = [];
  let inQuotes = false;
  let recordStartLine = 1;
  let lineNo = 1;

  function pushField() {
    fields.push(current);
    current = '';
  }

  function pushRecord() {
    pushField();
    records.push(fields);
    recordStarts.push(recordStartLine);
    fields = [];
    recordStartLine = lineNo;
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const ch = normalized[index];
    if (inQuotes) {
      if (ch === '"') {
        const next = normalized[index + 1];
        if (next === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') lineNo += 1;
        if (ch === '\r') {
          if (normalized[index + 1] === '\n') index += 1;
          lineNo += 1;
        }
        current += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      pushField();
      continue;
    }
    if (ch === '\n') {
      pushRecord();
      lineNo += 1;
      recordStartLine = lineNo;
      continue;
    }
    if (ch === '\r') {
      if (normalized[index + 1] === '\n') index += 1;
      pushRecord();
      lineNo += 1;
      recordStartLine = lineNo;
      continue;
    }
    current += ch;
  }

  if (inQuotes) {
    errors.push({
      code: 'unclosed_quote',
      message: 'CSV ended while inside a quoted field',
      line: recordStartLine
    });
  }
  if (current.length || fields.length || normalized.length) pushRecord();
  const filteredRecords = [];
  const filteredStarts = [];
  records.forEach((record, index) => {
    if (!record.some((col) => String(col || '').length > 0)) return;
    filteredRecords.push(record);
    filteredStarts.push(recordStarts[index]);
  });
  return {
    records: filteredRecords,
    record_starts: filteredStarts,
    errors
  };
}

export function parseCsvRecords(text) {
  return scanCsvRecords(text).records;
}

export function parseCsvTextWithDiagnostics(text) {
  const scanned = scanCsvRecords(text);
  const { records } = scanned;
  const diagnostics = {
    physical_lines: String(text || '').split(/\r?\n/).length,
    csv_records: records.length,
    data_records: 0,
    errors: [...scanned.errors],
    malformed_records: []
  };
  if (!records.length) {
    return {
      headers: [],
      rows: [],
      diagnostics
    };
  }

  const headers = records[0];
  if (diagnostics.errors.some((error) => error.code === 'unclosed_quote')) {
    return {
      headers,
      rows: [],
      diagnostics
    };
  }
  const rows = [];
  for (let i = 1; i < records.length; i += 1) {
    const cols = records[i];
    if (!cols.some((col) => String(col || '').trim())) continue;
    if (cols.length !== headers.length) {
      diagnostics.malformed_records.push({
        code: 'field_count_mismatch',
        message: `CSV record has ${cols.length} fields; expected ${headers.length}`,
        record_index: i,
        line: scanned.record_starts[i] || i + 1,
        expected_fields: headers.length,
        actual_fields: cols.length
      });
      diagnostics.errors.push(diagnostics.malformed_records[diagnostics.malformed_records.length - 1]);
      continue;
    }
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cols[idx] ?? '';
    });
    rows.push(row);
  }
  diagnostics.data_records = rows.length;
  return {
    headers,
    rows,
    diagnostics
  };
}

export function parseCsvText(text) {
  const parsed = parseCsvTextWithDiagnostics(text);
  if (parsed.diagnostics.errors.length) {
    throw new CsvParseError('Malformed CSV input', parsed.diagnostics);
  }
  return parsed.rows;
}

export function firstValue(row, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    const value = row && Object.prototype.hasOwnProperty.call(row, key) ? row[key] : '';
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

export function toInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}
