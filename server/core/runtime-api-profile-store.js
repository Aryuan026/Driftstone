import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { RUNTIME_SAVE_DIR } from './path-config.js';

export const RUNTIME_API_PROFILE_FILE = join(RUNTIME_SAVE_DIR, 'ui_api_profiles.json');
export const RUNTIME_API_CONFIG_FILE = join(RUNTIME_SAVE_DIR, 'ui_api_config.json');

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeProfile(item = {}, index = 0) {
  const name = safeText(item?.name, `方案 ${index + 1}`);
  const baseUrl = trimTrailingSlash(item?.baseUrl || '');
  if (!name || !baseUrl) return null;
  return {
    name,
    baseUrl,
    apiKey: typeof item?.apiKey === 'string' ? item.apiKey : '',
    model: safeText(item?.model, 'gpt-4o-mini'),
    updated_at: safeText(item?.updated_at, new Date().toISOString())
  };
}

function normalizeProfileList(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((item, index) => normalizeProfile(item, index))
    .filter(Boolean);
}

function normalizeApiConfig(item = {}) {
  const baseUrl = trimTrailingSlash(item?.baseUrl || '');
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: typeof item?.apiKey === 'string' ? item.apiKey : '',
    model: safeText(item?.model, 'gpt-4o-mini'),
    profile_name: safeText(item?.profile_name || item?.profileName),
    updated_at: safeText(item?.updated_at, new Date().toISOString())
  };
}

function tryParseJson(raw = '') {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractLooseJsonArray(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  const direct = tryParseJson(text);
  if (Array.isArray(direct)) return direct;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const sliced = tryParseJson(text.slice(start, end + 1));
  return Array.isArray(sliced) ? sliced : null;
}

function extractLooseJsonObject(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  const direct = tryParseJson(text);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

  const candidates = [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }

  const keyStart = text.search(/"?baseUrl"?\s*:/);
  const lastBrace = text.lastIndexOf('}');
  if (keyStart >= 0) {
    const fragment = text.slice(keyStart, lastBrace > keyStart ? lastBrace + 1 : text.length).trim();
    if (fragment) {
      candidates.push(`{${fragment.replace(/^\{+/, '').replace(/\}+$/u, '')}}`);
    }
  }

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }

  const fieldPatterns = {
    baseUrl: /"?baseUrl"?\s*:\s*"([^"]*)"/u,
    apiKey: /"?apiKey"?\s*:\s*"([^"]*)"/u,
    model: /"?model"?\s*:\s*"([^"]*)"/u,
    profile_name: /"?(?:profile_name|profileName)"?\s*:\s*"([^"]*)"/u,
    updated_at: /"?updated_at"?\s*:\s*"([^"]*)"/u
  };
  const loose = {};
  Object.entries(fieldPatterns).forEach(([key, pattern]) => {
    const match = text.match(pattern);
    if (!match?.[1]) return;
    loose[key] = match[1];
  });
  return Object.keys(loose).length ? loose : null;
}

export async function loadRuntimeApiProfiles() {
  try {
    const raw = await readFile(RUNTIME_API_PROFILE_FILE, 'utf8');
    const parsed = extractLooseJsonArray(raw);
    const normalized = normalizeProfileList(parsed || []);
    if (parsed && String(raw) !== `${JSON.stringify(normalized, null, 2)}\n`) {
      await mkdir(RUNTIME_SAVE_DIR, { recursive: true });
      await writeFile(RUNTIME_API_PROFILE_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    }
    return normalized;
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function saveRuntimeApiProfiles(list = []) {
  const clean = normalizeProfileList(list);
  await mkdir(RUNTIME_SAVE_DIR, { recursive: true });
  await writeFile(RUNTIME_API_PROFILE_FILE, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  return clean;
}

export async function loadRuntimeApiConfig() {
  try {
    const raw = await readFile(RUNTIME_API_CONFIG_FILE, 'utf8');
    const parsed = extractLooseJsonObject(raw);
    const normalized = normalizeApiConfig(parsed);
    if (!normalized) return null;
    const cleanText = `${JSON.stringify(normalized, null, 2)}\n`;
    if (String(raw) !== cleanText) {
      await mkdir(RUNTIME_SAVE_DIR, { recursive: true });
      await writeFile(RUNTIME_API_CONFIG_FILE, cleanText, 'utf8');
    }
    return normalized;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveRuntimeApiConfig(config = {}) {
  const clean = normalizeApiConfig(config);
  await mkdir(RUNTIME_SAVE_DIR, { recursive: true });
  if (!clean) {
    await writeFile(RUNTIME_API_CONFIG_FILE, 'null\n', 'utf8');
    return null;
  }
  await writeFile(RUNTIME_API_CONFIG_FILE, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  return clean;
}
