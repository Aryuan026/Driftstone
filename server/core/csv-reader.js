export function parseCsvLine(line) {
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

export function parseCsvText(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    if (!cols.some((col) => String(col || '').trim())) continue;
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cols[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
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

