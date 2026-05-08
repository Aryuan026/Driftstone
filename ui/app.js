import { getJson, postJson } from './api-client.js';
import { buildRuntimeMaterialsExport } from './bridges/memo-runtime-bridge.js';

const STORAGE_KEY = 'hippocove-runtime-flow-v7';
const RUNTIME_BUILD_LABEL = 'build 20260508b';
const DIRECT_SOURCE_FILE_LIMIT_BYTES = 20 * 1024 * 1024;
const START_PARSE_PAYLOAD_LIMIT_BYTES = 28 * 1024 * 1024;
const SHARED_API_STORAGE_KEY = 'hippocove_api_config';
const API_PROFILES_STORAGE_KEY = 'hippocove_api_profiles';
const LEGACY_PERSONA_CARD_STORAGE_KEY = 'hippocove_main_persona_card';
const LEGACY_LANGUAGE_FINGERPRINT_STORAGE_KEY = 'hippocove_main_language_fingerprint';
const LEGACY_BOT_NAME_STORAGE_KEY = 'hippocove_main_bot_name';
const LEGACY_USER_NAME_STORAGE_KEY = 'hippocove_main_user_name';
const LOCAL_BACKEND = window.location.origin;
const RUNTIME_API_PROFILE_PATH = '/api/runtime/api-profiles';
const RUNTIME_PERSONA_WORKSPACE_PATH = '/api/runtime/persona-workspace';
const RUNTIME_GROWTH_DASHBOARD_PATH = '/api/runtime/growth-dashboard';
const RUNTIME_GROWTH_RUNTIME_PATH = '/api/runtime/growth-runtime';
const RUNTIME_FRONT_STATE_PATH = '/api/runtime/front-runtime-state';
const RUNTIME_LOCAL_RESET_PATH = '/api/runtime/local-reset';
const RUNTIME_PARSE_RUNTIME_PATH = '/api/runtime/parse-runtime';
const RUNTIME_OBSIDIAN_EXPORT_BUNDLE_PATH = '/api/runtime/obsidian-export/bundle';
const RUNTIME_MEMO_COMPACT_EXPORT_PATH = '/api/runtime/memo-compact/export';
const SHOULD_RESET_LOCAL_RUNTIME = new URLSearchParams(window.location.search).get('reset_local') === '1';
const INTERNAL_OWNER_ID = 'history-to-obsidian';
const INTERNAL_BOT_ID = 'assistant';
const SHARED_API_PROFILE_NAME = '__runtime_shared__';
const SHARED_API_PROFILE_LABEL = '当前已载入配置';
const LOCAL_PROGRAMMATIC_PROFILE = {
  name: '__local_programmatic__',
  displayName: '本地快检（不走外部 API）',
  baseUrl: 'mock://programmatic',
  apiKey: '',
  model: 'local-programmatic',
  updated_at: '9999-12-31T23:59:59.000Z'
};

const els = {
  runtimeStamp: document.querySelector('#runtimeStamp'),
  resetLocalWorkspaceBtn: document.querySelector('#resetLocalWorkspaceBtn'),
  apiProfileSelect: document.querySelector('#apiProfileSelect'),
  apiProfilesMeta: document.querySelector('#apiProfilesMeta'),
  apiModelDisplay: document.querySelector('#apiModelDisplay'),
  testApiBtn: document.querySelector('#testApiBtn'),
  apiStatusPill: document.querySelector('#apiStatusPill'),
  apiTestResultText: document.querySelector('#apiTestResultText'),
  conversationFile: document.querySelector('#conversationFile'),
  fileStatus: document.querySelector('#fileStatus'),
  startParseBtn: document.querySelector('#startParseBtn'),
  pauseParseBtn: document.querySelector('#pauseParseBtn'),
  resumeParseBtn: document.querySelector('#resumeParseBtn'),
  exportMaterialsBtn: document.querySelector('#exportMaterialsBtn'),
  parseStatusPill: document.querySelector('#parseStatusPill'),
  parseSummary: document.querySelector('#parseSummary'),
  parseProgressFill: document.querySelector('#parseProgressFill'),
  parseProgressText: document.querySelector('#parseProgressText'),
  parseProgressDetail: document.querySelector('#parseProgressDetail'),
  parseStatusBand: document.querySelector('#parseStatusBand'),
  materialNote: document.querySelector('#materialNote'),
  personaBridgeSummary: document.querySelector('#personaBridgeSummary'),
  personaBridgeMeta: document.querySelector('#personaBridgeMeta'),
  compactBridgeMeta: document.querySelector('#compactBridgeMeta'),
  compactBridgeSummary: document.querySelector('#compactBridgeSummary'),
  generationStatusPill: document.querySelector('#generationStatusPill'),
  generationProgressFill: document.querySelector('#generationProgressFill'),
  generationProgressText: document.querySelector('#generationProgressText'),
  generationProgressDetail: document.querySelector('#generationProgressDetail'),
  generateMemoryBtn: document.querySelector('#generateMemoryBtn'),
  downloadBundleBtn: document.querySelector('#downloadBundleBtn'),
  frontGrowthStatusPill: document.querySelector('#frontGrowthStatusPill'),
  frontGrowthVisual: document.querySelector('#frontGrowthVisual')
};

const state = {
  loadedFile: null,
  sessionId: '',
  active_scope: null,
  parseDashboard: null,
  lastIngest: null,
  lastDrain: null,
  lastTranslation: null,
  lastTaskPrepare: null,
  parseRunning: false,
  parsePaused: false,
  parsePauseRequested: false,
  parsePoller: null,
  parseError: '',
  parsePlan: null,
  parseWorkerState: {
    total: 0,
    completed: 0,
    failed: 0,
    currentLabel: '',
    mode: 'idle'
  },
  apiStatusLabel: '未测试',
  apiStatusTone: 'stable',
  generationRunning: false,
  generationProgress: 0,
  generationLabel: '未开始',
  generatedBundle: null,
  persistTimer: null,
  lastSavedAt: '',
  activeApiProfileName: '',
  apiProfiles: [],
  runtimeSharedApiConfig: null,
  apiProfilesError: '',
  personaWorkspaceSnapshot: null,
  growthDashboardSnapshot: null,
  growthDashboardError: '',
  growthDashboardPoller: null
};

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getRuntimeModeLabel() {
  if (window.location.protocol === 'file:') return 'file';
  return safeText(window.location.host, 'local');
}

function renderRuntimeStamp() {
  if (!els.runtimeStamp) return;
  els.runtimeStamp.textContent = `${RUNTIME_BUILD_LABEL} · ${getRuntimeModeLabel()}`;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatStamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function prettyChars(count) {
  const num = Number(count || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 字';
  if (num >= 10000) return `${(num / 10000).toFixed(1)} 万字`;
  return `${num} 字`;
}

function prettyBytes(bytes) {
  const num = Number(bytes || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  if (num >= 1024 * 1024 * 1024) return `${(num / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (num >= 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)} MB`;
  if (num >= 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${num} B`;
}

function createSourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function describeSourceError(error, file) {
  const raw = safeText(error?.message || error, '文件读取失败。');
  let reason = raw;
  let action = '请重新选择 `.md`、`.txt`、Driftstone 原料包 JSON，或 PawTrail 导出的窗口/月包。';

  if (error?.code === 'SOURCE_TOO_LARGE') {
    reason = '这个文件太大，不适合直接丢进 Driftstone 前台。';
    action = '请先到旧实验台的“对话导出器”做按月拼接，再把生成的窗口/月包带回这里；PawTrail 也可以作为在线拆包入口。';
  } else if (error?.code === 'CHATGPT_EXPORT') {
    reason = '检测到这是 ChatGPT 原始 conversations.json。';
    action = '请先点右上角“旧实验台”，在第一个“对话导出器”页面做按月拼接；之后再把导出的窗口/月包上传到这里。';
  } else if (error?.code === 'INVALID_JSON') {
    reason = '这个 JSON 没有读完整，或格式已经损坏。';
    action = '请重新下载/导出文件；如果是 ChatGPT 原始导出，请先用旧实验台“对话导出器”读取。';
  } else if (error?.code === 'PAYLOAD_TOO_LARGE' || /request body too large/i.test(raw)) {
    reason = '这批素材太大，启动解析时没法一次送进本地后端。';
    action = '请减少本次上传文件数量，或先在旧实验台按月/按窗口拆成更小的包后分批处理。';
  } else if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    reason = '前台没有连上本地后端。';
    action = '请确认本地启动脚本还开着，然后刷新页面重试。';
  }

  const name = file && file.name ? `\n文件：${file.name}` : '';
  const detail = raw && raw !== reason ? `\n排查细节：${raw}` : '';
  return `读取失败：${reason}\n下一步：${action}${name}${detail}`;
}

function estimateJsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function createSessionId() {
  return `session-${Date.now()}`;
}

function readStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function readSharedApiConfig() {
  try {
    return JSON.parse(localStorage.getItem(SHARED_API_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function sanitizeApiProfiles(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((item) => ({
      name: safeText(item?.name),
      baseUrl: trimTrailingSlash(item?.baseUrl || ''),
      apiKey: typeof item?.apiKey === 'string' ? item.apiKey : '',
      model: safeText(item?.model, 'gpt-4o-mini'),
      updated_at: safeText(item?.updated_at, '')
    }))
    .filter((item) => item.name && item.baseUrl);
}

function readLocalApiProfiles() {
  try {
    const raw = localStorage.getItem(API_PROFILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.profiles) ? parsed.profiles : []);
    return sanitizeApiProfiles(list);
  } catch {
    return [];
  }
}

function writeLocalApiProfiles(list = []) {
  localStorage.setItem(API_PROFILES_STORAGE_KEY, JSON.stringify(sanitizeApiProfiles(list)));
}

function clearLocalApiProfilesMirror() {
  try {
    localStorage.removeItem(API_PROFILES_STORAGE_KEY);
    localStorage.removeItem(SHARED_API_STORAGE_KEY);
  } catch {}
}

function clearLocalWorkspaceMirror() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_PERSONA_CARD_STORAGE_KEY);
    localStorage.removeItem(LEGACY_LANGUAGE_FINGERPRINT_STORAGE_KEY);
    localStorage.removeItem(LEGACY_BOT_NAME_STORAGE_KEY);
    localStorage.removeItem(LEGACY_USER_NAME_STORAGE_KEY);
  } catch {}
}

function stripResetQueryFlag() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('reset_local');
    window.history.replaceState({}, '', url.toString());
  } catch {}
}

async function resetLocalRuntimeMirror(options = {}) {
  const strictBackend = options.strictBackend === true;
  stopPolling();
  window.clearTimeout(state.growthDashboardPoller);
  state.parsePoller = null;
  state.growthDashboardPoller = null;
  clearLocalApiProfilesMirror();
  clearLocalWorkspaceMirror();
  let backendError = null;
  try {
    await postJson(LOCAL_BACKEND, RUNTIME_LOCAL_RESET_PATH, {});
  } catch (error) {
    backendError = error;
  }
  state.loadedFile = null;
  state.apiProfiles = [];
  state.apiProfilesError = '';
  state.activeApiProfileName = '';
  state.runtimeSharedApiConfig = null;
  state.personaWorkspaceSnapshot = null;
  state.growthDashboardSnapshot = null;
  state.growthDashboardError = '';
  state.sessionId = '';
  state.active_scope = null;
  state.parseDashboard = null;
  state.parseRunning = false;
  state.parsePaused = false;
  state.parsePauseRequested = false;
  state.parsePlan = null;
  state.parseWorkerState = {
    total: 0,
    completed: 0,
    failed: 0,
    currentLabel: '',
    mode: 'idle'
  };
  state.parseError = '';
  state.lastIngest = null;
  state.lastDrain = null;
  state.lastTranslation = null;
  state.lastTaskPrepare = null;
  state.generationRunning = false;
  state.generatedBundle = null;
  state.generationLabel = '未开始';
  state.generationProgress = 0;
  state.lastSavedAt = '';
  stripResetQueryFlag();
  if (backendError && strictBackend) {
    throw new Error(`浏览器镜像已经清掉了，但本地后端没接住重置：${safeText(backendError?.message, 'unknown error')}`);
  }
}

async function handleVisibleLocalReset() {
  const confirmed = window.confirm('这会清空本机 API 方案、提取缓存、运行记录和导出草稿。继续吗？');
  if (!confirmed) return;
  const button = els.resetLocalWorkspaceBtn;
  const originalLabel = safeText(button?.textContent, '重置本地工作台');
  if (button) {
    button.disabled = true;
    button.textContent = '重置中...';
  }
  try {
    await resetLocalRuntimeMirror({ strictBackend: true });
    const url = new URL(window.location.href);
    url.searchParams.delete('reset_local');
    url.searchParams.set('ts', String(Date.now()));
    window.location.replace(url.toString());
  } catch (error) {
    setApiStatus('重置失败', 'stable', safeText(error?.message, '本地工作台重置失败。'));
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

function getApiProfiles() {
  return state.apiProfiles.length ? state.apiProfiles : readLocalApiProfiles();
}

function getSharedApiConfigForView() {
  const localShared = readSharedApiConfig();
  if (trimTrailingSlash(localShared?.baseUrl || '')) return localShared;
  return state.runtimeSharedApiConfig || {};
}

function buildSharedApiFallbackProfile(shared = getSharedApiConfigForView()) {
  const baseUrl = trimTrailingSlash(shared?.baseUrl || '');
  if (!baseUrl) return null;
  return {
    name: SHARED_API_PROFILE_NAME,
    displayName: SHARED_API_PROFILE_LABEL,
    baseUrl,
    apiKey: typeof shared?.apiKey === 'string' ? shared.apiKey : '',
    model: safeText(shared?.model, 'gpt-4o-mini'),
    updated_at: ''
  };
}

function getApiProfilesForView() {
  const profiles = [LOCAL_PROGRAMMATIC_PROFILE, ...getApiProfiles().filter((item) => item.name !== LOCAL_PROGRAMMATIC_PROFILE.name)];
  const sharedProfile = buildSharedApiFallbackProfile();
  if (!sharedProfile) return profiles;
  const hasSameProfile = profiles.some((item) => (
    item.baseUrl === sharedProfile.baseUrl
    && item.apiKey === sharedProfile.apiKey
    && item.model === sharedProfile.model
  ));
  if (hasSameProfile) return profiles;
  return [sharedProfile, ...profiles];
}

async function fetchRuntimeApiProfiles() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1800);
  let resp;
  try {
    const url = new URL(RUNTIME_API_PROFILE_PATH, `${LOCAL_BACKEND}/`).toString();
    const raw = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });
    const payload = await raw.json().catch(() => ({}));
    resp = {
      ok: raw.ok,
      status: raw.status,
      url,
      payload
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('读取本地接口超时');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  if (!resp.ok) {
    throw new Error(safeText(resp.payload?.error, `load failed (${resp.status})`));
  }
  return {
    profiles: sanitizeApiProfiles(resp.payload?.profiles),
    currentConfig: resp.payload?.current_config && typeof resp.payload.current_config === 'object'
      ? {
          baseUrl: trimTrailingSlash(resp.payload.current_config.baseUrl || ''),
          apiKey: typeof resp.payload.current_config.apiKey === 'string' ? resp.payload.current_config.apiKey : '',
          model: safeText(resp.payload.current_config.model, 'gpt-4o-mini')
        }
      : null
  };
}

async function saveRuntimeApiProfiles(list = [], currentConfig = null) {
  const resp = await postJson(LOCAL_BACKEND, RUNTIME_API_PROFILE_PATH, {
    profiles: sanitizeApiProfiles(list),
    current_config: currentConfig
  });
  if (!resp.ok) {
    throw new Error(safeText(resp.payload?.error, `save failed (${resp.status})`));
  }
  return {
    profiles: sanitizeApiProfiles(resp.payload?.profiles),
    currentConfig: resp.payload?.current_config && typeof resp.payload.current_config === 'object'
      ? {
          baseUrl: trimTrailingSlash(resp.payload.current_config.baseUrl || ''),
          apiKey: typeof resp.payload.current_config.apiKey === 'string' ? resp.payload.current_config.apiKey : '',
          model: safeText(resp.payload.current_config.model, 'gpt-4o-mini')
        }
      : null
  };
}

async function hydrateApiProfiles() {
  state.apiProfilesError = '';
  try {
    const remoteState = await fetchRuntimeApiProfiles();
    state.runtimeSharedApiConfig = remoteState.currentConfig;
    const remoteHasProfiles = remoteState.profiles.length > 0;
    const remoteHasCurrentConfig = Boolean(trimTrailingSlash(remoteState.currentConfig?.baseUrl || ''));
    if (!remoteHasProfiles && !remoteHasCurrentConfig) {
      state.apiProfiles = [];
      state.runtimeSharedApiConfig = null;
      clearLocalApiProfilesMirror();
      return [];
    }
    if (remoteState.profiles.length) {
      state.apiProfiles = remoteState.profiles;
      writeLocalApiProfiles(remoteState.profiles);
      return remoteState.profiles;
    }
    if (remoteHasCurrentConfig) {
      state.apiProfiles = [];
      writeLocalApiProfiles([]);
      try {
        localStorage.setItem(SHARED_API_STORAGE_KEY, JSON.stringify(remoteState.currentConfig));
      } catch {}
      return [];
    }
  } catch {
    const localProfiles = readLocalApiProfiles();
    state.apiProfilesError = '没连到本地读取接口';
    state.apiProfiles = localProfiles;
    state.runtimeSharedApiConfig = null;
    return localProfiles;
  }
  state.apiProfiles = [];
  state.runtimeSharedApiConfig = null;
  return [];
}

function renderApiProfiles(selectedName = '') {
  const profiles = [...getApiProfilesForView()].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const current = safeText(selectedName);
  els.apiProfileSelect.innerHTML = profiles.length
    ? '<option value="">请选择方案</option>'
    : '<option value="">暂无已保存方案</option>';

  profiles.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.name;
    opt.textContent = item.displayName || item.name;
    els.apiProfileSelect.appendChild(opt);
  });

  if (current && profiles.some((item) => item.name === current)) {
    els.apiProfileSelect.value = current;
  }

  if (els.apiProfilesMeta) {
    els.apiProfilesMeta.textContent = profiles.length ? `已读取 ${profiles.length} 个` : '未读到方案';
  }
}

function getDefaultApiProfileName() {
  const sharedApi = getSharedApiConfigForView();
  const matched = findMatchingApiProfileName(sharedApi);
  if (matched) return matched;
  const list = getApiProfilesForView();
  return list.length ? list[0].name : '';
}

function syncApiModelDisplay(modelName = '') {
  els.apiModelDisplay.value = safeText(modelName);
}

function getSelectedApiProfile() {
  const selected = safeText(els.apiProfileSelect.value || state.activeApiProfileName);
  if (!selected) return null;
  return getApiProfilesForView().find((item) => item.name === selected) || null;
}

function saveSharedApiConfig() {
  const profile = getSelectedApiProfile();
  const shared = getSharedApiConfigForView();
  const model = safeText(profile?.model || shared.model, 'gpt-4o-mini');
  const payload = {
    baseUrl: trimTrailingSlash(profile?.baseUrl || shared.baseUrl || ''),
    apiKey: typeof profile?.apiKey === 'string' ? profile.apiKey : safeText(shared.apiKey),
    model
  };
  syncApiModelDisplay(model);
  localStorage.setItem(SHARED_API_STORAGE_KEY, JSON.stringify(payload));
}

function getPrefsSnapshot() {
  return {
    apiProfileName: els.apiProfileSelect.value
  };
}

function readLegacyPersonaContext() {
  return {
    charName: safeText(localStorage.getItem(LEGACY_BOT_NAME_STORAGE_KEY), ''),
    userName: safeText(localStorage.getItem(LEGACY_USER_NAME_STORAGE_KEY), ''),
    personaCard: safeText(localStorage.getItem(LEGACY_PERSONA_CARD_STORAGE_KEY), ''),
    languageFingerprint: safeText(localStorage.getItem(LEGACY_LANGUAGE_FINGERPRINT_STORAGE_KEY), '')
  };
}

function buildPersonaWorkspaceFallback() {
  const legacy = readLegacyPersonaContext();
  return {
    source: 'local_fallback',
    error: '',
    state: {
      char_name: legacy.charName,
      user_name: legacy.userName,
      persona_card: legacy.personaCard,
      language_fingerprint: legacy.languageFingerprint,
      fingerprint_candidate_pool: ''
    },
    persona_cache: {
      total_rows: 0,
      preview: []
    }
  };
}

async function hydratePersonaWorkspace() {
  try {
    const resp = await getJson(LOCAL_BACKEND, RUNTIME_PERSONA_WORKSPACE_PATH, {
      include_persona_rows: true,
      row_limit: 8
    });
    if (!resp.ok) {
      throw new Error(safeText(resp.payload?.error, `load failed (${resp.status})`));
    }
    state.personaWorkspaceSnapshot = {
      source: 'remote',
      error: '',
      state: resp.payload?.state && typeof resp.payload.state === 'object' ? resp.payload.state : {},
      persona_cache: resp.payload?.persona_cache && typeof resp.payload.persona_cache === 'object'
        ? resp.payload.persona_cache
        : { total_rows: 0, preview: [] }
    };
    return state.personaWorkspaceSnapshot;
  } catch (error) {
    const fallback = buildPersonaWorkspaceFallback();
    fallback.error = safeText(error?.message, '共享人格桌面暂时没连上');
    state.personaWorkspaceSnapshot = fallback;
    return fallback;
  }
}

function getPersonaWorkspaceView() {
  const snapshot = state.personaWorkspaceSnapshot || buildPersonaWorkspaceFallback();
  const current = snapshot?.state || {};
  return {
    source: safeText(snapshot?.source, 'local_fallback'),
    error: safeText(snapshot?.error),
    charName: safeText(current.char_name),
    userName: safeText(current.user_name),
    personaCard: safeText(current.persona_card),
    languageFingerprint: safeText(current.language_fingerprint),
    fingerprintCandidatePool: safeText(current.fingerprint_candidate_pool),
    personaCacheTotal: Number(snapshot?.persona_cache?.total_rows || 0),
    personaCachePreview: Array.isArray(snapshot?.persona_cache?.preview) ? snapshot.persona_cache.preview : []
  };
}

function countMeaningfulLines(text) {
  return safeText(text)
    .split('\n')
    .map((line) => safeText(line))
    .filter(Boolean).length;
}

function renderPersonaBridgePanel() {
  if (!els.personaBridgeSummary || !els.personaBridgeMeta) return;
  const workspace = getPersonaWorkspaceView();
  const parts = [];
  if (workspace.charName || workspace.userName) {
    parts.push([workspace.charName, workspace.userName].filter(Boolean).join(' / '));
  }
  if (workspace.personaCard) {
    parts.push(`人格卡 ${workspace.personaCard.length} 字`);
  }
  if (workspace.languageFingerprint) {
    parts.push(`指纹 ${countMeaningfulLines(workspace.languageFingerprint)} 行`);
  }
  if (workspace.source === 'remote' && workspace.personaCacheTotal > 0) {
    parts.push(`Persona 缓存 ${workspace.personaCacheTotal} 条`);
  }
  if (workspace.source === 'remote' && parts.length) {
    els.personaBridgeSummary.textContent = `当前桌面：${parts.join(' · ')}`;
    els.personaBridgeMeta.textContent = '请在旧实验台收集表达指纹、汇总人格卡草稿。这里默认读取共享桌面的最新内容。';
  } else if (workspace.source === 'local_fallback' && parts.length) {
    els.personaBridgeSummary.textContent = `旧实验台本地有草稿，但共享桌面还没跟上。先打开一次人格工位，让它把最新内容同步过来。`;
    els.personaBridgeMeta.textContent = '请在旧实验台收集表达指纹、汇总人格卡草稿。';
  } else {
    els.personaBridgeSummary.textContent = '还没读到共享人格桌面，请先去旧实验台补人设卡和语言指纹。';
    els.personaBridgeMeta.textContent = '请在旧实验台收集表达指纹、汇总人格卡草稿。';
  }
}

function hasParseCheckpoint() {
  return Boolean(state.sessionId && (state.lastIngest || state.lastTranslation || state.lastTaskPrepare || state.lastDrain));
}

function persistState() {
  state.lastSavedAt = new Date().toISOString();
  const activeScope = getCurrentParseScope();
  const payload = {
    prefs: getPrefsSnapshot(),
    sessionId: state.sessionId,
    active_scope: activeScope,
    parseDashboard: state.parseDashboard,
    lastIngest: state.lastIngest,
    lastDrain: state.lastDrain,
    lastTranslation: state.lastTranslation,
    lastTaskPrepare: state.lastTaskPrepare,
    parsePlan: state.parsePlan,
    parseWorkerState: state.parseWorkerState,
    parseRunning: Boolean(state.parseRunning),
    parsePaused: state.parsePaused,
    parsePauseRequested: state.parsePauseRequested,
    parseError: state.parseError,
    generationRunning: Boolean(state.generationRunning),
    generatedBundle: state.generatedBundle,
    generationLabel: state.generationLabel,
    generationProgress: state.generationProgress,
    savedAt: state.lastSavedAt
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  syncFrontRuntimeStateToBackend(payload).catch(() => {});
}

function flushStateNow(options = {}) {
  const activeScope = getCurrentParseScope();
  const hasGeneratedBundleOverride = Object.prototype.hasOwnProperty.call(options, 'generatedBundle');
  const payload = {
    prefs: getPrefsSnapshot(),
    sessionId: state.sessionId,
    active_scope: activeScope,
    parseDashboard: state.parseDashboard,
    lastIngest: state.lastIngest,
    lastDrain: state.lastDrain,
    lastTranslation: state.lastTranslation,
    lastTaskPrepare: state.lastTaskPrepare,
    parsePlan: state.parsePlan,
    parseWorkerState: state.parseWorkerState,
    parseRunning: Boolean(options.parseRunning ?? state.parseRunning),
    parsePaused: Boolean(options.parsePaused ?? state.parsePaused),
    parsePauseRequested: Boolean(options.parsePauseRequested ?? state.parsePauseRequested),
    parseError: safeText(options.parseError ?? state.parseError),
    generationRunning: Boolean(options.generationRunning ?? state.generationRunning),
    generatedBundle: hasGeneratedBundleOverride ? options.generatedBundle : state.generatedBundle,
    generationLabel: safeText(options.generationLabel ?? state.generationLabel),
    generationProgress: Number(options.generationProgress ?? state.generationProgress ?? 0),
    savedAt: new Date().toISOString()
  };
  state.lastSavedAt = payload.savedAt;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(`${LOCAL_BACKEND}${RUNTIME_FRONT_STATE_PATH}`, blob);
      return;
    }
  } catch {}
  syncFrontRuntimeStateToBackend(payload).catch(() => {});
}

async function syncFrontRuntimeStateToBackend(payload) {
  await postJson(
    LOCAL_BACKEND,
    RUNTIME_FRONT_STATE_PATH,
    payload && typeof payload === 'object' ? payload : {}
  );
}

function schedulePersist() {
  window.clearTimeout(state.persistTimer);
  state.persistTimer = window.setTimeout(() => {
    persistState();
  }, 180);
}

function setApiStatus(label, tone = 'stable', text = '') {
  state.apiStatusLabel = label;
  state.apiStatusTone = tone;
  els.apiStatusPill.textContent = label;
  els.apiStatusPill.className = `status-pill ${tone}`;
  if (els.apiTestResultText) {
    els.apiTestResultText.textContent = text || '当前还没测试。';
  }
}

function setParseStatus(label, tone = 'stable') {
  els.parseStatusPill.textContent = label;
  els.parseStatusPill.className = `status-pill ${tone}`;
}

function setGenerationStatus(label, tone = 'stable') {
  els.generationStatusPill.textContent = label;
  els.generationStatusPill.className = `status-pill ${tone}`;
}

function updateFileStatus() {
  if (state.loadedFile) {
    els.fileStatus.textContent = `${state.loadedFile.name} · ${state.loadedFile.description}`;
    return;
  }
  els.fileStatus.textContent = '上传提取源文件（.md / .txt / .json）。';
}

function isMockApiConfig(config = {}) {
  const baseUrl = trimTrailingSlash(config?.baseUrl || '').toLowerCase();
  const model = safeText(config?.model).toLowerCase();
  return baseUrl.startsWith('mock://') || baseUrl.startsWith('local://') || model === 'local-programmatic' || model === '__programmatic__';
}

function buildPreviewText(text, limit = 3200) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}\n\n...[这里只显示部分内容，解析时仍会使用完整文本]`;
}

function bundleToPlainText(bundle = []) {
  return bundle.map((windowBlock, index) => {
    const messages = Array.isArray(windowBlock?.messages) ? windowBlock.messages : [];
    const lines = messages.map((msg) => {
      const role = safeText(msg?.role || msg?.author?.role || 'unknown');
      const content = Array.isArray(msg?.content?.parts)
        ? msg.content.parts.join('\n')
        : safeText(msg?.content || msg?.text || msg?.message || '');
      return `${role}: ${content}`;
    }).filter(Boolean);
    return `## Window ${index + 1}\n${lines.join('\n')}`;
  }).join('\n\n');
}

function documentsToPlainText(documents = []) {
  return documents.map((doc, index) => {
    const content = safeText(doc?.text || doc?.content || doc?.raw_text);
    return `## Document ${index + 1}\n${content}`;
  }).join('\n\n');
}

function detectJsonInput(parsed) {
  if (Array.isArray(parsed)) {
    if (parsed.every((item) => item && Array.isArray(item.messages))) {
      const messageCount = parsed.reduce((sum, item) => sum + item.messages.length, 0);
      const plainText = bundleToPlainText(parsed);
      return {
        sourceKind: 'chat_bundle',
        sourceFormat: 'application/json',
        ingestInput: { bundle: parsed },
        description: `${parsed.length} 组窗口 / ${messageCount} 条消息`,
        stats: {
          bundleCount: parsed.length,
          messageCount,
          documentCount: 0,
          rawTextCount: 0,
          monthlyReady: true
        },
        plainText,
        previewText: buildPreviewText(plainText)
      };
    }
    if (parsed.every((item) => item && (typeof item.text === 'string' || typeof item.content === 'string'))) {
      const plainText = documentsToPlainText(parsed);
      return {
        sourceKind: 'document',
        sourceFormat: 'application/json',
        ingestInput: { documents: parsed },
        description: `${parsed.length} 条 document`,
        stats: {
          bundleCount: 0,
          messageCount: 0,
          documentCount: parsed.length,
          rawTextCount: 0,
          monthlyReady: false
        },
        plainText,
        previewText: buildPreviewText(plainText)
      };
    }
  }

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.bundle)) {
      const messageCount = parsed.bundle.reduce((sum, item) => sum + (Array.isArray(item?.messages) ? item.messages.length : 0), 0);
      const plainText = bundleToPlainText(parsed.bundle);
      return {
        sourceKind: 'chat_bundle',
        sourceFormat: 'application/json',
        ingestInput: { bundle: parsed.bundle },
        description: `${parsed.bundle.length} 组窗口 / ${messageCount} 条消息`,
        stats: {
          bundleCount: parsed.bundle.length,
          messageCount,
          documentCount: 0,
          rawTextCount: 0,
          monthlyReady: true
        },
        plainText,
        previewText: buildPreviewText(plainText)
      };
    }
    if (Array.isArray(parsed.documents)) {
      const plainText = documentsToPlainText(parsed.documents);
      return {
        sourceKind: 'document',
        sourceFormat: 'application/json',
        ingestInput: { documents: parsed.documents },
        description: `${parsed.documents.length} 条 document`,
        stats: {
          bundleCount: 0,
          messageCount: 0,
          documentCount: parsed.documents.length,
          rawTextCount: 0,
          monthlyReady: false
        },
        plainText,
        previewText: buildPreviewText(plainText)
      };
    }
    if (Array.isArray(parsed.messages)) {
      const plainText = bundleToPlainText([parsed]);
      return {
        sourceKind: 'chat_bundle',
        sourceFormat: 'application/json',
        ingestInput: { bundle: [parsed] },
        description: `1 组窗口 / ${parsed.messages.length} 条消息`,
        stats: {
          bundleCount: 1,
          messageCount: parsed.messages.length,
          documentCount: 0,
          rawTextCount: 0,
          monthlyReady: true
        },
        plainText,
        previewText: buildPreviewText(plainText)
      };
    }
    if (typeof parsed.raw_text === 'string' || typeof parsed.text === 'string' || typeof parsed.content === 'string') {
      const raw = safeText(parsed.raw_text || parsed.text || parsed.content);
      return {
        sourceKind: 'document',
        sourceFormat: 'application/json',
        ingestInput: { raw_text: raw },
        description: prettyChars(raw.length),
        stats: {
          bundleCount: 0,
          messageCount: 0,
          documentCount: 0,
          rawTextCount: 1,
          monthlyReady: false
        },
        plainText: raw,
        previewText: buildPreviewText(raw)
      };
    }
  }

  return null;
}

function looksLikeChatGptExport(parsed) {
  const conversations = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.conversations)
      ? parsed.conversations
      : parsed?.mapping
        ? [parsed]
        : [];
  return conversations.some((item) => item && item.mapping && typeof item.mapping === 'object');
}

async function normalizeConversationFile(file) {
  const name = safeText(file?.name, 'upload');
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (Number(file?.size || 0) > DIRECT_SOURCE_FILE_LIMIT_BYTES) {
    throw createSourceError(
      'SOURCE_TOO_LARGE',
      `${name} 有 ${prettyBytes(file.size)}，超过 Driftstone 前台建议的 ${prettyBytes(DIRECT_SOURCE_FILE_LIMIT_BYTES)}。`
    );
  }
  const text = await file.text();
  const defaultFormat = file?.type
    || (ext === 'json'
      ? 'application/json'
      : ext === 'md'
        ? 'text/markdown'
        : ext === 'doc'
          ? 'application/msword'
          : 'text/plain');

  if (ext === 'json' || defaultFormat === 'application/json') {
    try {
      const parsed = JSON.parse(text);
      if (looksLikeChatGptExport(parsed)) {
        throw createSourceError('CHATGPT_EXPORT', '这是 ChatGPT 原始 conversations.json。');
      }
      const detected = detectJsonInput(parsed);
      if (detected) {
        return {
          name,
          sourceKind: detected.sourceKind,
          sourceFormat: detected.sourceFormat,
          ingestInput: detected.ingestInput,
          previewText: detected.previewText,
          plainText: detected.plainText,
          description: detected.description
        };
      }
    } catch (error) {
      if (error?.code) throw error;
      throw createSourceError('INVALID_JSON', error?.message || 'Invalid JSON');
    }
  }

  return {
    name,
    sourceKind: ext === 'md' ? 'document' : 'raw_text',
    sourceFormat: defaultFormat,
    ingestInput: { raw_text: text },
    previewText: buildPreviewText(text),
    plainText: text,
    description: prettyChars(text.length),
    stats: {
      bundleCount: 0,
      messageCount: 0,
      documentCount: 0,
      rawTextCount: 1,
      monthlyReady: false
    }
  };
}

function buildCombinedSourceKind(parts = []) {
  const kinds = new Set(parts.map((item) => item.sourceKind).filter(Boolean));
  if (kinds.size === 1) return Array.from(kinds)[0];
  if (kinds.has('chat_bundle')) return 'chat_bundle';
  if (kinds.has('document')) return 'document';
  return 'raw_text';
}

function buildCombinedSourceFormat(parts = []) {
  const formats = Array.from(new Set(parts.map((item) => item.sourceFormat).filter(Boolean)));
  return formats.length === 1 ? formats[0] : 'application/json';
}

async function normalizeConversationFiles(files = []) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) throw new Error('请先选择文件。');
  if (list.length === 1) return normalizeConversationFile(list[0]);

  const parts = await Promise.all(list.map((file) => normalizeConversationFile(file)));
  const bundle = [];
  const documents = [];
  const plainTextParts = [];
  let bundleCount = 0;
  let messageCount = 0;
  let documentCount = 0;
  let rawTextCount = 0;

  parts.forEach((part, index) => {
    const input = part.ingestInput || {};
    if (Array.isArray(input.bundle)) {
      bundle.push(...input.bundle);
      bundleCount += input.bundle.length;
      messageCount += input.bundle.reduce((sum, item) => sum + (Array.isArray(item?.messages) ? item.messages.length : 0), 0);
    }
    if (Array.isArray(input.documents)) {
      documents.push(...input.documents);
      documentCount += input.documents.length;
    }
    if (typeof input.raw_text === 'string' && safeText(input.raw_text)) {
      documents.push({
        doc_id: `upload_${index + 1}`,
        title: part.name,
        kind: 'text',
        text: input.raw_text
      });
      rawTextCount += 1;
      documentCount += 1;
    }
    if (part.plainText) {
      plainTextParts.push(`## ${part.name}\n${part.plainText}`);
    }
  });

  const ingestInput = {};
  if (bundle.length) ingestInput.bundle = bundle;
  if (documents.length) ingestInput.documents = documents;

  const monthlyReady = bundle.length > 0;
  const descriptionParts = [`${list.length} 个文件`];
  if (bundleCount) descriptionParts.push(`${bundleCount} 组窗口`);
  if (messageCount) descriptionParts.push(`${messageCount} 条消息`);
  if (documentCount && !bundleCount) descriptionParts.push(`${documentCount} 条文本`);
  if (monthlyReady) descriptionParts.push('已是窗口包，可直接按月拼接');

  return {
    name: `${list.length} 个文件`,
    sourceKind: buildCombinedSourceKind(parts),
    sourceFormat: buildCombinedSourceFormat(parts),
    ingestInput,
    previewText: buildPreviewText(plainTextParts.join('\n\n')),
    plainText: plainTextParts.join('\n\n'),
    description: descriptionParts.join(' / '),
    fileNames: list.map((file) => safeText(file.name)),
    stats: {
      bundleCount,
      messageCount,
      documentCount,
      rawTextCount,
      monthlyReady
    }
  };
}

function getSourceLabel() {
  if (state.loadedFile?.fileNames?.length) {
    if (state.loadedFile.stats?.monthlyReady) return 'monthly-window-bundle';
    return `multi-upload-${state.loadedFile.fileNames.length}`;
  }
  if (state.loadedFile?.name) {
    return state.loadedFile.name.replace(/\.[^.]+$/, '') || 'manual-session';
  }
  return 'manual-session';
}

function getSourceEnvelope() {
  if (state.loadedFile) {
    return {
      source: {
        kind: state.loadedFile.sourceKind,
        label: getSourceLabel(),
        format: state.loadedFile.sourceFormat
      },
      input: state.loadedFile.ingestInput
    };
  }

  throw new Error('请先上传文件。');
}

function getSourcePlainText() {
  return state.loadedFile ? safeText(state.loadedFile.plainText) : '';
}

function scoreEmotionSnippet(text) {
  const raw = safeText(text);
  if (!raw) return 0;
  let score = 0;
  score += Math.min(raw.length / 32, 6);
  if (/[我你他她我们你们]/.test(raw)) score += 2;
  if (/[！!？?…]/.test(raw)) score += 2;
  if (/(喜欢|想|怕|爱|抱|靠近|记得|不想|真的|不是|可是|如果|怎么|为什么|委屈|难过|开心|温柔|难受|想你|舍不得)/.test(raw)) score += 4;
  if (/(哈哈|嘿|呀|啦|嘛|咯|呢)/.test(raw)) score += 1.5;
  if (/(请参考|作为AI|保持理智|以下是|建议你)/i.test(raw)) score -= 4;
  return score;
}

function extractFingerprintCandidates(text) {
  const raw = safeText(text);
  if (!raw) return [];
  const units = raw
    .split(/\n{2,}/)
    .flatMap((block) => block.split(/(?<=[。！？!?…])/))
    .map((item) => safeText(item))
    .filter((item) => item.length >= 16 && item.length <= 180);

  const unique = [];
  const seen = new Set();
  units.forEach((item) => {
    const key = item.replace(/\s+/g, '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    unique.push(item);
  });

  return unique
    .map((item, index) => ({
      id: `cand-${index + 1}`,
      text: item,
      score: scoreEmotionSnippet(item)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function getFingerprintMode() {
  return 'legacy_workbench';
}

function renderFingerprintMode() {
  return;
}

function renderFingerprintCandidates() {
  return;
}

function refreshFingerprintCandidates() {
  return;
}

function getSelectedCandidateTexts() {
  return [];
}

function buildFingerprintDraft(snippets = []) {
  const lines = snippets
    .map((item) => safeText(item))
    .filter(Boolean)
    .map((item) => item.split(/[。！？!?…]/)[0]?.trim() || item)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 6)
    .slice(0, 4);

  return lines.join('\n');
}

function buildParseScope() {
  if (!state.sessionId) state.sessionId = createSessionId();
  return {
    owner_id: INTERNAL_OWNER_ID,
    realm_id: state.sessionId,
    bot_id: INTERNAL_BOT_ID
  };
}

function normalizeScopeShape(scope = null) {
  if (!scope || typeof scope !== 'object') return null;
  const ownerId = safeText(scope.owner_id || scope.ownerId, INTERNAL_OWNER_ID);
  const realmId = safeText(scope.realm_id || scope.realmId || scope.sessionId, '');
  const botId = safeText(scope.bot_id || scope.botId, INTERNAL_BOT_ID);
  if (!realmId) return null;
  return {
    owner_id: ownerId,
    realm_id: realmId,
    bot_id: botId
  };
}

function scopesMatch(left = null, right = null) {
  const normalizedLeft = normalizeScopeShape(left);
  const normalizedRight = normalizeScopeShape(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    safeText(normalizedLeft.owner_id) === safeText(normalizedRight.owner_id)
    && safeText(normalizedLeft.realm_id) === safeText(normalizedRight.realm_id)
  );
}

function extractPayloadScope(value = null) {
  if (!value || typeof value !== 'object') return null;
  return normalizeScopeShape(
    value.active_scope
    || value.scope
    || {
      owner_id: value.owner_id || value.ownerId,
      realm_id: value.realm_id || value.realmId || value.sessionId
    }
  );
}

function isScopeBoundPayloadStale(value = null, activeScope = null) {
  const normalizedActiveScope = normalizeScopeShape(activeScope);
  const payloadScope = extractPayloadScope(value);
  if (!normalizedActiveScope || !payloadScope) return false;
  return !scopesMatch(payloadScope, normalizedActiveScope);
}

function buildRecoveredParseRuntimeFragments(snapshot = {}) {
  const activeScope = normalizeScopeShape(snapshot?.active_scope);
  const pipeline = snapshot?.parse_pipeline || {};
  if (!activeScope || !pipeline?.has_work) {
    return {
      activeScope: activeScope || null,
      lastIngest: null,
      lastTranslation: null,
      lastTaskPrepare: null,
      lastDrain: null
    };
  }

  const documentCount = Number(pipeline.document_count || 0);
  const sliceCount = Number(pipeline.slice_count || 0);
  const taskTotal = Number(pipeline.task_total || 0);
  const reviewedItemCount = Number(pipeline.reviewed_item_count || 0);
  const reviewedClusterCount = Number(pipeline.reviewed_cluster_count || 0);

  return {
    activeScope,
    lastIngest: documentCount > 0 ? {
      ok: true,
      scope: activeScope,
      ingest: { document_count: documentCount }
    } : null,
    lastTranslation: sliceCount > 0 ? {
      ok: true,
      scope: activeScope,
      translation: { slice_count: sliceCount }
    } : null,
    lastTaskPrepare: taskTotal > 0 ? {
      ok: true,
      scope: activeScope,
      summary: { batch_count: taskTotal }
    } : null,
    lastDrain: (reviewedItemCount > 0 || reviewedClusterCount > 0) ? {
      ok: true,
      scope: activeScope,
      summary: {
        item_count: reviewedItemCount,
        cluster_count: reviewedClusterCount
      },
      merged_entries: reviewedItemCount
    } : null
  };
}

function getCurrentParseScope() {
  return normalizeScopeShape(
    state.active_scope
    || state.growthDashboardSnapshot?.active_scope
    || state.parseDashboard?.active_scope
    || (safeText(state.sessionId) ? {
      owner_id: INTERNAL_OWNER_ID,
      realm_id: state.sessionId,
      bot_id: INTERNAL_BOT_ID
    } : null)
  );
}

function applyParseRuntimeSnapshot(payload = {}) {
  const activeScope = payload?.active_scope && typeof payload.active_scope === 'object'
    ? payload.active_scope
    : null;
  const runtimeState = payload?.state && typeof payload.state === 'object'
    ? payload.state
    : null;
  const runtimeConfig = payload?.runtime_config && typeof payload.runtime_config === 'object'
    ? payload.runtime_config
    : {};

  const authoritativeScope = normalizeScopeShape(
    state.active_scope
    || runtimeState?.active_scope
    || runtimeState?.parseDashboard?.active_scope
    || activeScope
  );
  if (safeText(authoritativeScope?.realm_id)) {
    state.sessionId = safeText(authoritativeScope.realm_id);
    state.active_scope = authoritativeScope;
  }

  const shouldPreserveRecoveredParseState = !runtimeState
    && state.growthDashboardSnapshot?.parse_pipeline?.has_work
    && scopesMatch(authoritativeScope || activeScope, state.growthDashboardSnapshot?.active_scope);

  if (shouldPreserveRecoveredParseState) {
    if (!state.parseDashboard) {
      state.parseDashboard = buildRecoveredParseDashboard(state.growthDashboardSnapshot || {});
    }
  } else {
    state.parseDashboard = runtimeState?.parseDashboard && typeof runtimeState.parseDashboard === 'object'
      ? runtimeState.parseDashboard
      : null;
    state.lastIngest = runtimeState?.lastIngest || null;
    state.lastTranslation = runtimeState?.lastTranslation || null;
    state.lastTaskPrepare = runtimeState?.lastTaskPrepare || null;
    state.lastDrain = runtimeState?.lastDrain || null;
  }
  state.parsePlan = runtimeState?.parsePlan || runtimeConfig.parse_plan || state.parsePlan || null;
  state.parseWorkerState = {
    total: Number(runtimeState?.parseWorkerState?.total || 0),
    completed: Number(runtimeState?.parseWorkerState?.completed || 0),
    failed: Number(runtimeState?.parseWorkerState?.failed || 0),
    currentLabel: safeText(runtimeState?.parseWorkerState?.currentLabel || ''),
    mode: safeText(runtimeState?.parseWorkerState?.mode || 'idle')
  };
  state.parseError = safeText(runtimeState?.parseError || '');
  state.parsePaused = Boolean(runtimeState?.parsePaused);
  state.parsePauseRequested = Boolean(runtimeState?.parsePauseRequested);
  state.parseRunning = Boolean(runtimeState?.parseRunning);
}

async function fetchParseRuntimeState() {
  const scope = getCurrentParseScope();
  const resp = await getJson(
    LOCAL_BACKEND,
    RUNTIME_PARSE_RUNTIME_PATH,
    scope ? scope : {}
  );
  if (!resp.ok) {
    throw new Error(safeText(resp.payload?.error, `load failed (${resp.status})`));
  }
  applyParseRuntimeSnapshot(resp.payload || {});
  renderAll();
  schedulePersist();
  return resp.payload || {};
}

async function startParseRuntimeRequest({ scope, sourceEnvelope, parsePlan, apiConfig }) {
  const resp = await postJson(LOCAL_BACKEND, `${RUNTIME_PARSE_RUNTIME_PATH}/start`, {
    scope,
    source_envelope: sourceEnvelope,
    parse_plan: parsePlan,
    api_config: apiConfig
  });
  if (!resp.ok) {
    throw new Error(safeText(resp.payload?.error, `start failed (${resp.status})`));
  }
  applyParseRuntimeSnapshot(resp.payload || {});
  return resp.payload || {};
}

async function pauseParseRuntimeRequest(scope) {
  const resp = await postJson(LOCAL_BACKEND, `${RUNTIME_PARSE_RUNTIME_PATH}/pause`, {
    scope
  });
  if (!resp.ok) {
    throw new Error(safeText(resp.payload?.error, `pause failed (${resp.status})`));
  }
  applyParseRuntimeSnapshot(resp.payload || {});
  return resp.payload || {};
}

async function resumeParseRuntimeRequest(scope, apiConfig = {}) {
  const resp = await postJson(LOCAL_BACKEND, `${RUNTIME_PARSE_RUNTIME_PATH}/resume`, {
    scope,
    api_config: apiConfig
  });
  if (!resp.ok) {
    throw new Error(safeText(resp.payload?.error, `resume failed (${resp.status})`));
  }
  applyParseRuntimeSnapshot(resp.payload || {});
  return resp.payload || {};
}

function summarizeOverview(payload = {}) {
  const source = payload?.source || {};
  return {
    rootCount: Number(source.root_count || 0),
    vineCount: Number(source.vine_edge_count || 0)
  };
}

function summarizeTaskBoard(payload = {}) {
  const summary = payload?.status_summary || {};
  return {
    pending: Number(summary.pending || 0),
    submitted: Number(summary.submitted || 0),
    applied: Number(summary.applied || 0),
    failed: Number(summary.failed || 0),
    total: Number(summary.pending || 0)
      + Number(summary.submitted || 0)
      + Number(summary.applied || 0)
      + Number(summary.failed || 0)
  };
}

function formatHomeStateLabel(value) {
  const raw = safeText(value, 'scope_ready');
  const labels = {
    scope_ready: '未开始',
    source_ready: '已入包',
    translation_needed: '待分片',
    translation_pending: '解析中',
    translation_submitted: '处理中',
    context_ready: '可继续',
    tree_ready: '已完成'
  };
  return labels[raw] || raw;
}

function buildSmartChunkPlan(file = state.loadedFile) {
  const charCount = Number(file?.plainText?.length || 0);
  const isChat = file?.sourceKind === 'chat_bundle';
  const targetChars = isChat
    ? (charCount > 18000 ? 2400 : charCount > 9000 ? 2200 : 1800)
    : (charCount > 18000 ? 3200 : charCount > 9000 ? 2800 : 2200);
  const maxSlices = isChat ? 2 : 1;
  const maxChars = Math.max(targetChars * maxSlices + 600, targetChars);
  const estimate = charCount > 0 ? Math.max(1, Math.ceil(charCount / targetChars)) : 0;
  return {
    targetChars,
    maxSlices,
    maxChars,
    entryLimit: 6,
    estimatedSlices: estimate,
    strategyLabel: isChat ? '按聊天行智能分片' : '按段落智能分片',
    monthlyReady: Boolean(file?.stats?.monthlyReady)
  };
}

function renderParseStatusBand(items = []) {
  if (!els.parseStatusBand) return;
  const list = Array.isArray(items) && items.length
    ? items
    : [
        { label: '历史记录', value: '未上传' },
        { label: '智能分片', value: '未开始' },
        { label: '解析', value: '未开始' },
        { label: '去重', value: '未开始' },
        { label: '完成', value: '未完成' },
        { label: '当前状态', value: '未开始' },
        { label: '当前内容', value: '0 条' },
        { label: '任务数', value: '0' }
      ];

  els.parseStatusBand.innerHTML = list.map((item) => `
    <span class="parse-status-item" data-tone="${escapeHtml(item.tone || 'stable')}">
      <span class="parse-status-label">${escapeHtml(item.label || '')}</span>
      <span class="parse-status-value">${escapeHtml(item.value || '')}</span>
    </span>
  `).join('');
}

function deriveParseModel() {
  const dashboard = state.parseDashboard || {};
  const home = dashboard.home || {};
  const available = home.available || {};
  const taskBoard = summarizeTaskBoard(dashboard.tasks || {});
  const overview = summarizeOverview(dashboard.overview || {});
  const homeState = safeText(home.home_state);
  const chunkPlan = state.parsePlan || buildSmartChunkPlan();
  const preparedSummary = state.lastTaskPrepare?.summary || {};
  const translationSummary = state.lastTranslation?.translation || {};
  const workerState = state.parseWorkerState || {};
  const hasSource = Boolean(getSourcePlainText());
  const hasIngest = Boolean(available.ingest || state.lastIngest?.ok);
  const hasTranslation = Boolean(available.translation);
  const hasMaterials = overview.rootCount > 0 || homeState === 'context_ready' || homeState === 'tree_ready';
  const tasksRunning = taskBoard.total > 0 && (taskBoard.pending > 0 || taskBoard.submitted > 0);

  let percent = 0;
  let label = state.parseError ? '解析失败' : '未开始';
  let detail = state.parseError || '开始后会先检查输入形态；窗口包会直接按月拼接，普通原始记录再进入智能分片、逐片提炼和 reviewed 去重。';
  let tone = state.parseError ? 'error' : 'stable';

  if (hasSource) {
    percent = 10;
    label = '已上传';
    detail = chunkPlan.monthlyReady
      ? '已识别为窗口包，准备直接按时间拼成月包，再进入后续处理。'
      : `已接到原始记录，准备先按时间拼总文件，再按${chunkPlan.strategyLabel}。`;
    tone = 'ready';
  }
  if (hasIngest) {
    percent = Math.max(percent, 22);
    label = '解析中';
    detail = chunkPlan.monthlyReady
      ? '窗口包已经入包，正在做按月时间拼接并生成分片。'
      : '原始记录已经入包，正在按时间拼总文件并生成分片。';
  }
  if (hasTranslation || translationSummary.slice_count || preparedSummary.batch_count) {
    percent = Math.max(percent, 42);
    label = '处理中';
    detail = preparedSummary.batch_count
      ? `时间拼装和智能分片已完成，已生成 ${preparedSummary.batch_count} 组提炼任务。`
      : `智能分片已生成 ${translationSummary.slice_count || chunkPlan.estimatedSlices || 0} 片。`;
    tone = 'live';
  }
  if (taskBoard.total > 0) {
    const handled = taskBoard.submitted + taskBoard.applied + taskBoard.failed;
    const ratio = taskBoard.total ? handled / taskBoard.total : 0;
    percent = Math.max(percent, 52 + Math.round(ratio * 36));
    detail = safeText(home?.home_state) === 'translation_submitted'
      ? '逐片提炼已经跑完，正在做 reviewed 去重整合。'
      : workerState.currentLabel
      ? `正在处理 ${workerState.currentLabel}。`
      : `正在逐片处理，已完成 ${handled} / ${taskBoard.total}。`;
  }
  if (hasMaterials) {
    percent = 100;
    label = '已完成';
    detail = overview.rootCount > 0 ? `已完成提炼和去重，整理出 ${overview.rootCount} 条内容，可以继续写人格记忆。` : '这一步已经完成。';
    tone = 'ready';
  } else if (state.parsePaused) {
    label = '已暂停';
    detail = workerState.currentLabel
      ? `已在 ${workerState.currentLabel} 之后停下，可以从断点继续。`
      : '已把这轮进度停在中间产物上，可以从断点继续。';
    tone = 'stable';
  } else if (state.parsePauseRequested) {
    label = '暂停中';
    detail = workerState.currentLabel
      ? `暂停请求已经记下，当前这片 ${workerState.currentLabel} 跑完就会停。`
      : '暂停请求已经记下，处理完当前步骤就会停下。';
    tone = 'live';
  } else if (state.parseRunning) {
    tone = 'live';
    label = '处理中';
  }

  if (state.parseError) {
    percent = Math.max(percent, hasSource ? 10 : 0);
    label = '解析失败';
    detail = state.parseError;
    tone = 'error';
  }

  const steps = [
    {
      label: '历史记录',
      value: hasIngest ? '已入包' : hasSource ? '已上传' : '未上传',
      note: state.loadedFile ? state.loadedFile.name : (hasSource ? '已粘贴内容' : ''),
      state: hasSource ? 'done' : 'pending'
    },
    {
      label: '智能分片',
      value: preparedSummary.batch_count
        ? `${translationSummary.slice_count || chunkPlan.estimatedSlices || 0} 片`
        : translationSummary.slice_count
          ? `${translationSummary.slice_count} 片`
          : hasSource
            ? `预计 ${chunkPlan.estimatedSlices || 0} 片`
            : '未开始',
      note: hasSource ? chunkPlan.strategyLabel : '',
      state: translationSummary.slice_count || preparedSummary.batch_count ? 'done' : (hasSource ? 'current' : 'pending')
    },
    {
      label: '解析',
      value: taskBoard.total
        ? `${Math.min(taskBoard.submitted + taskBoard.applied + taskBoard.failed + (workerState.currentLabel ? 1 : 0), taskBoard.total)}/${taskBoard.total}`
        : preparedSummary.batch_count
          ? '待开始'
          : hasIngest
            ? '生成中'
            : '未开始',
      note: workerState.currentLabel || '',
      state: taskBoard.total ? (hasMaterials ? 'done' : 'current') : ((hasIngest || preparedSummary.batch_count) ? 'current' : 'pending')
    },
    {
      label: '去重',
      value: hasMaterials ? '已完成' : (taskBoard.submitted > 0 || homeState === 'translation_submitted') ? '整合中' : taskBoard.total ? '待开始' : '未开始',
      note: taskBoard.submitted || taskBoard.applied || taskBoard.failed ? `已提炼 ${taskBoard.submitted + taskBoard.applied}，失败 ${taskBoard.failed}` : '',
      state: hasMaterials ? 'done' : (taskBoard.total ? 'current' : 'pending')
    },
    {
      label: '完成',
      value: hasMaterials ? '可继续' : '未完成',
      note: hasMaterials ? `${overview.rootCount} 条内容` : '',
      state: hasMaterials ? 'done' : ((hasTranslation || taskBoard.total) ? 'current' : 'pending')
    }
  ];

  return { percent, label, detail, tone, steps, overview, taskBoard, home };
}

function renderParsePanel() {
  const parse = deriveParseModel();
  setParseStatus(parse.label, parse.tone);
  els.parseSummary.textContent = parse.detail;
  els.parseProgressFill.style.width = `${parse.percent}%`;
  els.parseProgressText.textContent = `${parse.percent}%`;
  els.parseProgressDetail.textContent = parse.label;

  const statusItems = [
    ...parse.steps.map((step) => ({
      label: step.label,
      value: step.value,
      tone: step.state === 'current' ? 'live' : step.state === 'done' ? 'ready' : 'stable'
    })),
    {
      label: '当前状态',
      value: state.parseError
        ? '失败'
        : state.parsePaused
          ? '已暂停'
          : state.parsePauseRequested
            ? '暂停中'
        : (parse.taskBoard.failed > 0 && parse.taskBoard.pending === 0 && parse.overview.rootCount === 0)
          ? `失败 ${parse.taskBoard.failed}`
          : formatHomeStateLabel(parse.home.home_state || (state.parseRunning ? 'translation_pending' : 'scope_ready')),
      tone: state.parseError ? 'error' : parse.tone
    },
    {
      label: '当前内容',
      value: `${parse.overview.rootCount} 条`,
      tone: parse.overview.rootCount > 0 ? 'ready' : 'stable'
    },
    {
      label: '任务数',
      value: parse.taskBoard.total
        ? `${parse.taskBoard.submitted + parse.taskBoard.applied + parse.taskBoard.failed}/${parse.taskBoard.total}`
        : '0',
      tone: parse.taskBoard.total ? 'live' : 'stable'
    }
  ];
  renderParseStatusBand(statusItems);

  const chunkPlan = state.parsePlan || buildSmartChunkPlan();
  const preparedSummary = state.lastTaskPrepare?.summary || {};
  const translationSummary = state.lastTranslation?.translation || {};
  const currentApi = getActiveApiConfig();
  const taskGroupCount = Math.max(Number(preparedSummary.batch_count || 0), Number(parse.taskBoard.total || 0));
  const sliceCount = Number(translationSummary.slice_count || chunkPlan.estimatedSlices || 0);
  const chunkPieces = taskGroupCount
    ? `后台已缓存本轮中间产物 · ${chunkPlan.monthlyReady ? '先按月拼接窗口包' : '先按时间拼总文件'}，再以${chunkPlan.strategyLabel}切成 ${sliceCount} 片，整理成 ${taskGroupCount} 组任务，后面继续进 reviewed 去重`
    : state.loadedFile
      ? `会先写入本轮缓存，并${chunkPlan.monthlyReady ? '按月拼接窗口包' : '按时间拼总文件'}，再按 ${chunkPlan.strategyLabel} 处理，预计 ${chunkPlan.estimatedSlices || 0} 片，每片约 ${chunkPlan.targetChars} 字`
      : '';
  const apiPiece = currentApi?.model ? `当前模型：${currentApi.model}` : '';
  const resumePiece = hasParseCheckpoint() ? '中途可暂停，也能从断点继续' : '';
  els.materialNote.textContent = [chunkPieces, apiPiece, resumePiece].filter(Boolean).join(' · ');
  els.materialNote.hidden = !els.materialNote.textContent;
}

function clipInlineText(value, max = 64) {
  const text = safeText(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildGenerationRuntimeView(snapshot = state.growthDashboardSnapshot || {}) {
  const growthState = snapshot?.growth_runtime?.state && typeof snapshot.growth_runtime.state === 'object'
    ? snapshot.growth_runtime.state
    : null;
  const frontState = snapshot?.front_runtime?.state && typeof snapshot.front_runtime.state === 'object'
    ? snapshot.front_runtime.state
    : null;
  const runtimeState = growthState || frontState || null;
  const queue = Array.isArray(runtimeState?.queue) ? runtimeState.queue : [];
  const queueTotal = Math.max(0, Number(runtimeState?.queue_total || queue.length || 0));
  const queueCompleted = Math.max(0, Math.min(queueTotal, Number(runtimeState?.queue_completed || 0)));
  const queuePointer = Math.max(0, Math.min(queueTotal, Number(runtimeState?.queue_pointer || 0)));
  const running = Boolean(runtimeState?.running ?? runtimeState?.generationRunning ?? state.generationRunning);
  const paused = Boolean(runtimeState?.paused);
  const phase = safeText(runtimeState?.phase || '');
  const errorText = safeText(runtimeState?.error ?? runtimeState?.generationError, '');
  const progress = Math.max(0, Math.min(100, Number(runtimeState?.progress ?? runtimeState?.generationProgress ?? state.generationProgress ?? 0)));
  const currentItem = runtimeState?.current_item && typeof runtimeState.current_item === 'object'
    ? runtimeState.current_item
    : (queuePointer < queue.length ? queue[queuePointer] : null);
  const currentItemLabel = clipInlineText(
    currentItem?.label || currentItem?.title || currentItem?.source_focus || '',
    72
  );
  const queueActive = queueTotal > 0;
  const multiQueue = queueTotal > 1;
  let currentIndex = 0;
  if (queueActive) {
    if (running) currentIndex = Math.min(queuePointer + 1, queueTotal);
    else if (queueCompleted >= queueTotal) currentIndex = queueTotal;
    else currentIndex = Math.min(queuePointer + 1, queueTotal);
  }

  const runtimeBundle = runtimeState?.generatedBundle && typeof runtimeState.generatedBundle === 'object'
    ? runtimeState.generatedBundle
    : state.generatedBundle;
  const generatedBundle = multiQueue ? null : runtimeBundle;
  const stagedTotal = Math.max(0, Number(snapshot?.staging_cards?.total || 0));

  let meterText = `${progress}%`;
  let detailText = safeText(runtimeState?.generationLabel ?? runtimeState?.label, state.generationLabel);
  let statusLabel = generatedBundle ? '可下载' : '未开始';
  let statusTone = generatedBundle ? 'ready' : 'stable';
  let buttonLabel = generatedBundle ? '重新生成' : '开始生成';

  if (queueActive) {
    meterText = `${queueCompleted}/${queueTotal}`;
    if (running) {
      detailText = `正在写第 ${currentIndex}/${queueTotal} 张 · ${currentItemLabel || '当前材料'}`;
      statusLabel = '生长中';
      statusTone = 'live';
      buttonLabel = '生长中';
    } else if (phase === 'failed') {
      detailText = `卡在第 ${currentIndex || Math.min(queueCompleted + 1, queueTotal)}/${queueTotal} 张 · ${clipInlineText(errorText || currentItemLabel || '这一张没接住', 72)}`;
      statusLabel = '待继续';
      statusTone = 'error';
      buttonLabel = '继续生成';
    } else if (paused || phase === 'paused') {
      detailText = `停在第 ${currentIndex || Math.min(queueCompleted + 1, queueTotal)}/${queueTotal} 张前 · ${currentItemLabel || '可以从断点继续'}`;
      statusLabel = '已暂停';
      statusTone = 'stable';
      buttonLabel = '继续生成';
    } else if (queueCompleted >= queueTotal) {
      detailText = stagedTotal
        ? `这轮 ${queueTotal} 张已经顺序写完 · 已落库 ${stagedTotal} 张`
        : `这轮 ${queueTotal} 张已经顺序写完 · 当前产物仍以草稿为主`;
      statusLabel = '已完成';
      statusTone = 'ready';
      buttonLabel = '重新生成';
    } else if (queueCompleted > 0) {
      detailText = `已经写到第 ${queueCompleted}/${queueTotal} 张 · ${currentItemLabel || safeText(runtimeState?.label, '可以继续往后推')}`;
      statusLabel = '待继续';
      statusTone = 'stable';
      buttonLabel = '继续生成';
    } else {
      detailText = `已排好 ${queueTotal} 张生长队列`;
      statusLabel = '待开始';
      statusTone = 'stable';
      buttonLabel = '开始生成';
    }
  } else if (running) {
    statusLabel = '生成中';
    statusTone = 'live';
    buttonLabel = '生成中';
  }

  return {
    running,
    paused,
    phase,
    progress,
    meterText,
    detailText,
    statusLabel,
    statusTone,
    buttonLabel,
    queueActive,
    queueTotal,
    queueCompleted,
    currentIndex,
    generatedBundle
  };
}

function renderGenerationPanel() {
  const workspace = getPersonaWorkspaceView();
  const canGenerate = Boolean(workspace.personaCard);
  const runtimeView = buildGenerationRuntimeView();
  const scope = getCurrentParseScope() || buildParseScope();
  const draftTotal = Number(state.growthDashboardSnapshot?.growth_drafts?.total || 0);
  const stagedTotal = Number(state.growthDashboardSnapshot?.staging_cards?.total || 0);
  const registryTotal = Number(state.growthDashboardSnapshot?.card_registry?.summary?.total_cards || 0);
  const availableMemoTotal = Math.max(draftTotal, stagedTotal, registryTotal);
  const canDownloadGrowthBundle = !runtimeView.running
    && Boolean(scope?.realm_id)
    && availableMemoTotal > 0;
  state.generatedBundle = runtimeView.generatedBundle;

  els.generateMemoryBtn.disabled = runtimeView.running || !canGenerate;
  els.generateMemoryBtn.textContent = canGenerate ? runtimeView.buttonLabel : '开始生成';
  els.downloadBundleBtn.disabled = !(runtimeView.generatedBundle || canDownloadGrowthBundle) || runtimeView.running;
  els.generationProgressFill.style.width = `${runtimeView.progress}%`;
  els.generationProgressText.textContent = runtimeView.meterText;
  els.generationProgressDetail.textContent = runtimeView.detailText;
  if (els.compactBridgeMeta) {
    els.compactBridgeMeta.textContent = canDownloadGrowthBundle
      ? '这一步会先把太像的卡收成主记忆，再把整编后的 Obsidian 包交给你。'
      : '主卡写完后，会先去旧实验台的“记忆整编”里收成更适合召回的主记忆。';
  }
  if (els.compactBridgeSummary) {
    if (runtimeView.running) {
      els.compactBridgeSummary.textContent = `这轮还在生长中，停下后会把 ${Math.max(availableMemoTotal, runtimeView.queueTotal || 0)} 张原始卡再收紧一遍。`;
    } else if (canDownloadGrowthBundle) {
      els.compactBridgeSummary.textContent = `当前这轮可继续整编 ${availableMemoTotal} 张卡；下载按钮默认拿整编后的主记忆包。`;
    } else {
      els.compactBridgeSummary.textContent = '这一步会先把太像的卡收一遍，再把整编后的包交给你。';
    }
  }

  if (!canGenerate) {
    setGenerationStatus('待同步', 'stable');
    return;
  }

  setGenerationStatus(runtimeView.statusLabel, runtimeView.statusTone);
}

function buildFrontGrowthGraph(snapshot = {}) {
  function hashString(text = '') {
    let hash = 2166136261;
    const src = String(text || '');
    for (let i = 0; i < src.length; i += 1) {
      hash ^= src.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function between(seed, min, max) {
    const ratio = (seed % 10000) / 10000;
    return min + (max - min) * ratio;
  }

  const drafts = Array.isArray(snapshot?.growth_drafts?.drafts) ? snapshot.growth_drafts.drafts : [];
  const staged = Array.isArray(snapshot?.staging_cards?.cards) ? snapshot.staging_cards.cards : [];
  const seen = new Set();
  const allCards = [];

  drafts.forEach((item) => {
    const title = safeText(item?.title, '未命名草稿');
    const cardType = safeText(item?.card_type, 'memo').toLowerCase();
    const key = `draft::${title}::${cardType}`;
    if (seen.has(key)) return;
    seen.add(key);
    allCards.push({
      id: safeText(item?.artifact_id, key),
      title,
      card_type: cardType,
      source: 'draft',
      stamp: safeText(item?.generated_at)
    });
  });

  staged.forEach((item) => {
    const title = safeText(item?.title, '未命名主卡');
    const cardType = safeText(item?.card_type, 'memo').toLowerCase();
    const key = `staged::${safeText(item?.file_path, `${title}:${cardType}`)}`;
    if (seen.has(key)) return;
    seen.add(key);
    allCards.push({
      id: safeText(item?.file_path, key),
      title,
      card_type: cardType,
      source: 'staged',
      stamp: safeText(item?.updated_at)
    });
  });

  allCards.sort((a, b) => String(b.stamp || '').localeCompare(String(a.stamp || '')));
  const cards = allCards.slice(0, 40);

  const root = { x: 320, y: 152, r: 4.4 };
  const anchors = {
    memo: { x: 196, y: 96, radius: 90 },
    family: { x: 214, y: 228, radius: 74 },
    fact: { x: 438, y: 92, radius: 74 },
    case: { x: 462, y: 214, radius: 68 }
  };

  const grouped = new Map();
  cards.forEach((item) => {
    const key = anchors[item.card_type] ? item.card_type : 'memo';
    const list = grouped.get(key) || [];
    list.push(item);
    grouped.set(key, list);
  });

  const hubs = Object.entries(anchors)
    .map(([cardType, anchor]) => ({
      id: `${cardType}-hub`,
      card_type: cardType,
      x: anchor.x,
      y: anchor.y,
      r: Math.max(2.3, 2.3 + ((grouped.get(cardType)?.length || 0) * 0.18))
    }))
    .filter((item) => (grouped.get(item.card_type)?.length || 0) > 0);

  const stars = [];
  hubs.forEach((hub) => {
    const anchor = anchors[hub.card_type];
    const list = grouped.get(hub.card_type) || [];
    list.forEach((item, index) => {
      const seed = hashString(`${item.id}::${index}`);
      const angle = ((seed % 360) + index * 37) * (Math.PI / 180);
      const radius = between(seed >>> 1, 18, anchor.radius);
      stars.push({
        id: item.id,
        title: item.title,
        source: item.source,
        card_type: hub.card_type,
        x: Math.round(anchor.x + Math.cos(angle) * radius),
        y: Math.round(anchor.y + Math.sin(angle) * radius),
        r: item.source === 'draft' ? 2.7 : 2.1,
        parent: hub.id
      });
    });
  });

  const ambientCount = Math.min(190, 42 + cards.length * 4);
  const ambient = Array.from({ length: ambientCount }).map((_, index) => {
    const seed = hashString(`ambient::${cards.length}::${index}`);
    return {
      x: Math.round(between(seed, 10, 630)),
      y: Math.round(between(seed >>> 1, 10, 294)),
      r: between(seed >>> 2, 0.45, 1.75),
      a: between(seed >>> 3, 0.12, 0.7)
    };
  });

  return {
    root,
    hubs,
    stars,
    ambient,
    counts: {
      memo: cards.filter((item) => item.card_type === 'memo').length,
      family: cards.filter((item) => item.card_type === 'family').length,
      fact: cards.filter((item) => item.card_type === 'fact').length,
      case: cards.filter((item) => item.card_type === 'case').length
    },
    total: cards.length
  };
}

function renderGrowthWatchPanel() {
  if (!els.frontGrowthVisual || !els.frontGrowthStatusPill) return;
  const snapshot = state.growthDashboardSnapshot || {};
  const graph = buildFrontGrowthGraph(snapshot);
  const activeScope = snapshot?.active_scope || null;
  let label = '待命';
  let tone = 'stable';
  if (state.growthDashboardError) {
    label = '未连上';
    tone = 'stable';
  } else if (graph.total) {
    label = '生长中';
    tone = 'live';
  } else if (activeScope) {
    label = '已接入';
    tone = 'stable';
  }
  els.frontGrowthStatusPill.textContent = label;
  els.frontGrowthStatusPill.className = `status-pill ${tone}`;
  const ambient = graph.ambient.map((item) => `
    <circle class="front-growth-ambient" cx="${item.x}" cy="${item.y}" r="${item.r}" opacity="${item.a}"></circle>
  `).join('');
  const rootLinks = graph.hubs.map((hub) => `
    <line class="front-growth-link root" x1="${graph.root.x}" y1="${graph.root.y}" x2="${hub.x}" y2="${hub.y}"></line>
  `).join('');
  const starLinks = graph.stars.map((item) => {
    const parent = graph.hubs.find((hub) => hub.id === item.parent) || graph.root;
    return `<line class="front-growth-link star ${item.source === 'draft' ? 'active' : ''}" x1="${parent.x}" y1="${parent.y}" x2="${item.x}" y2="${item.y}"></line>`;
  }).join('');
  const hubs = graph.hubs.map((hub) => `
    <circle class="front-growth-node hub ${hub.card_type}" cx="${hub.x}" cy="${hub.y}" r="${hub.r}"></circle>
  `).join('');
  const stars = graph.stars.map((item) => `
    <circle class="front-growth-node star ${item.card_type} ${item.source === 'draft' ? 'active' : 'stable'}" cx="${item.x}" cy="${item.y}" r="${item.r}">
      <title>${escapeHtml(item.title)}</title>
    </circle>
  `).join('');
  const workspace = getPersonaWorkspaceView();
  const memoryName = safeText(workspace.charName, 'Companion');
  const helperText = state.growthDashboardError
    ? escapeHtml(state.growthDashboardError)
    : '半壁星河与卿度，一念灵犀两心知';

  els.frontGrowthVisual.innerHTML = `
    <div class="front-growth-shell">
      <svg class="front-growth-map" viewBox="0 0 640 304" role="img" aria-label="Obsidian 星图">
        <rect class="front-growth-bg" x="0" y="0" width="640" height="304" rx="14"></rect>
        ${ambient}
        <circle class="front-growth-glow" cx="${graph.root.x}" cy="${graph.root.y}" r="92"></circle>
        ${rootLinks}
        ${starLinks}
        ${hubs}
        <circle class="front-growth-node root active" cx="${graph.root.x}" cy="${graph.root.y}" r="${graph.root.r}"></circle>
        ${stars}
      </svg>
      <div class="front-growth-overlay">
        <div class="front-growth-caption">${escapeHtml(memoryName)}-Memory</div>
        <div class="front-growth-counts">
          <span>Memo ${graph.counts.memo}</span>
          <span>Family ${graph.counts.family}</span>
          <span>Fact ${graph.counts.fact}</span>
          <span>Case ${graph.counts.case}</span>
        </div>
        <div class="front-growth-hint">${helperText}</div>
      </div>
    </div>
  `;
}

function syncGenerationRuntimeFromSnapshot(snapshot = {}) {
  const runtimeState = snapshot?.growth_runtime?.state && typeof snapshot.growth_runtime.state === 'object'
    ? snapshot.growth_runtime.state
    : (snapshot?.front_runtime?.state && typeof snapshot.front_runtime.state === 'object'
      ? snapshot.front_runtime.state
      : null);
  if (!runtimeState) return false;

  const running = Boolean(runtimeState.generationRunning ?? runtimeState.running);
  const progress = Number(runtimeState.generationProgress ?? runtimeState.progress ?? (running ? state.generationProgress : 0));
  const queueTotal = Math.max(0, Number(runtimeState.queue_total || 0));
  const queueCompleted = Math.max(0, Math.min(queueTotal, Number(runtimeState.queue_completed || 0)));
  const scope = getCurrentParseScope() || normalizeScopeShape(snapshot?.active_scope) || null;
  const expectedRealm = safeText(scope?.realm_id, '');
  const runtimeBundle = runtimeState.generatedBundle && typeof runtimeState.generatedBundle === 'object'
    ? runtimeState.generatedBundle
    : null;
  const bundleRealm = safeText(runtimeBundle?.session_id || runtimeBundle?.growth_result?.task?.realm_id, '');
  const generatedBundle = queueTotal > 1
    ? null
    : runtimeBundle && (!expectedRealm || !bundleRealm || bundleRealm === expectedRealm)
    ? runtimeBundle
    : null;
  const errorText = safeText(runtimeState.generationError ?? runtimeState.error, '');
  const nextLabel = errorText
    ? `生成失败：${errorText}`
    : safeText(
      runtimeState.generationLabel ?? runtimeState.label,
      generatedBundle ? '这张卡已经写完' : (running ? '已送去后台生长' : state.generationLabel)
    );

  let changed = false;
  if (state.generationRunning !== running) {
    state.generationRunning = running;
    changed = true;
  }
  if (Number.isFinite(progress) && state.generationProgress !== Math.max(0, Math.min(100, progress))) {
    state.generationProgress = Math.max(0, Math.min(100, progress));
    changed = true;
  }
  if (nextLabel && state.generationLabel !== nextLabel) {
    state.generationLabel = nextLabel;
    changed = true;
  }
  if (generatedBundle && JSON.stringify(state.generatedBundle || null) !== JSON.stringify(generatedBundle)) {
    state.generatedBundle = generatedBundle;
    changed = true;
  }
  if (running && state.generatedBundle) {
    state.generatedBundle = null;
    changed = true;
  } else if (!running && !generatedBundle && state.generatedBundle) {
    state.generatedBundle = null;
    changed = true;
  }
  if (changed) {
    schedulePersist();
  }
  return changed;
}

function renderAll() {
  syncParseControlButtons();
  updateFileStatus();
  renderParsePanel();
  renderPersonaBridgePanel();
  renderGenerationPanel();
  renderGrowthWatchPanel();
}

function buildRecoveredParseDashboard(snapshot = {}) {
  const pipeline = snapshot?.parse_pipeline || {};
  if (!pipeline || !pipeline.has_work) return null;
  const activeScope = snapshot?.active_scope && typeof snapshot.active_scope === 'object' ? snapshot.active_scope : null;
  const reviewedItemCount = Number(pipeline.reviewed_item_count || 0);
  const reviewedClusterCount = Number(pipeline.reviewed_cluster_count || 0);
  const taskPending = Number(pipeline.task_pending || 0);
  const taskSubmitted = Number(pipeline.task_submitted || 0);
  const taskApplied = Number(pipeline.task_applied || 0);
  const taskFailed = Number(pipeline.task_failed || 0);
  const homeState = reviewedItemCount > 0
    ? 'context_ready'
    : pipeline.task_total > 0
      ? (taskPending > 0 ? 'translation_pending' : 'translation_submitted')
      : pipeline.slice_count > 0
        ? 'translation_pending'
        : pipeline.document_count > 0
          ? 'source_ready'
          : 'scope_ready';
  return {
    active_scope: activeScope,
    home: {
      ok: true,
      home_state: homeState,
      available: {
        ingest: pipeline.document_count > 0,
        translation: pipeline.slice_count > 0,
        tasks: pipeline.task_total > 0,
        reviewed: reviewedItemCount > 0
      }
    },
    home_summary: {},
    overview: {
      ok: true,
      source: {
        root_count: reviewedItemCount,
        vine_edge_count: reviewedClusterCount
      }
    },
    tasks: {
      ok: true,
      status_summary: {
        pending: taskPending,
        submitted: taskSubmitted,
        applied: taskApplied,
        failed: taskFailed
      }
    }
  };
}

function recoverSessionFromGrowthSnapshot(snapshot = {}) {
  const recoveredFragments = buildRecoveredParseRuntimeFragments(snapshot);
  const activeScope = recoveredFragments.activeScope;
  const pipeline = snapshot?.parse_pipeline || {};
  if (!activeScope || !pipeline?.has_work) return false;
  const realmId = safeText(activeScope.realm_id);
  if (!realmId) return false;

  let changed = false;
  if (safeText(state.sessionId) !== realmId) {
    state.sessionId = realmId;
    changed = true;
  }
  const currentScope = state.active_scope && typeof state.active_scope === 'object' ? state.active_scope : {};
  if (
    safeText(currentScope.owner_id || currentScope.ownerId) !== safeText(activeScope.owner_id)
    || safeText(currentScope.realm_id || currentScope.realmId) !== realmId
  ) {
    state.active_scope = {
      owner_id: safeText(activeScope.owner_id),
      realm_id: realmId
    };
    changed = true;
  }
  const parseDashboardScope = normalizeScopeShape(state.parseDashboard?.active_scope);
  if (
    state.parseDashboard
    && (
      safeText(parseDashboardScope?.owner_id) !== safeText(activeScope.owner_id)
      || safeText(parseDashboardScope?.realm_id) !== realmId
    )
  ) {
    state.parseDashboard = buildRecoveredParseDashboard(snapshot);
    changed = true;
  } else if (!state.parseDashboard) {
    state.parseDashboard = buildRecoveredParseDashboard(snapshot);
    changed = true;
  }
  if (
    recoveredFragments.lastIngest
    && (
      !state.lastIngest
      || isScopeBoundPayloadStale(state.lastIngest, activeScope)
      || Number(state.lastIngest?.ingest?.document_count || 0) !== Number(recoveredFragments.lastIngest?.ingest?.document_count || 0)
    )
  ) {
    state.lastIngest = recoveredFragments.lastIngest;
    changed = true;
  }
  if (
    recoveredFragments.lastTranslation
    && (
      !state.lastTranslation
      || isScopeBoundPayloadStale(state.lastTranslation, activeScope)
      || Number(state.lastTranslation?.translation?.slice_count || 0) !== Number(recoveredFragments.lastTranslation?.translation?.slice_count || 0)
    )
  ) {
    state.lastTranslation = recoveredFragments.lastTranslation;
    changed = true;
  }
  if (
    recoveredFragments.lastTaskPrepare
    && (
      !state.lastTaskPrepare
      || isScopeBoundPayloadStale(state.lastTaskPrepare, activeScope)
      || Number(state.lastTaskPrepare?.summary?.batch_count || 0) !== Number(recoveredFragments.lastTaskPrepare?.summary?.batch_count || 0)
    )
  ) {
    state.lastTaskPrepare = recoveredFragments.lastTaskPrepare;
    changed = true;
  }
  if (
    recoveredFragments.lastDrain
    && (
      !state.lastDrain
      || isScopeBoundPayloadStale(state.lastDrain, activeScope)
      || Number(state.lastDrain?.summary?.item_count || 0) !== Number(recoveredFragments.lastDrain?.summary?.item_count || 0)
      || Number(state.lastDrain?.summary?.cluster_count || 0) !== Number(recoveredFragments.lastDrain?.summary?.cluster_count || 0)
    )
  ) {
    state.lastDrain = recoveredFragments.lastDrain;
    changed = true;
  }
  if (!state.parsePlan && Number(pipeline.slice_count || 0) > 0) {
    state.parsePlan = {
      targetChars: 2200,
      maxSlices: 2,
      maxChars: 5000,
      entryLimit: 6,
      estimatedSlices: Number(pipeline.slice_count || 0),
      strategyLabel: '按时间拼装后分片',
      monthlyReady: true
    };
    changed = true;
  }
  if (changed) {
    flushStateNow({
      parseRunning: state.parseRunning,
      parsePaused: state.parsePaused,
      parsePauseRequested: state.parsePauseRequested,
      parseError: state.parseError,
      generationRunning: state.generationRunning,
      generationProgress: state.generationProgress,
      generationLabel: state.generationLabel,
      generatedBundle: state.generatedBundle
    });
  }
  return changed;
}

async function refreshGrowthDashboard() {
  try {
    const scopedParams = state.sessionId ? buildParseScope() : {};
    let payload = null;
    if (state.sessionId) {
      const scopedResp = await getJson(LOCAL_BACKEND, RUNTIME_GROWTH_DASHBOARD_PATH, scopedParams);
      if (!scopedResp.ok) throw new Error(safeText(scopedResp.payload?.error, `load failed (${scopedResp.status})`));
      payload = scopedResp.payload && typeof scopedResp.payload === 'object' ? scopedResp.payload : null;
      const scopedHasWork = Boolean(payload?.parse_pipeline?.has_work);
      if (!scopedHasWork && !state.parseDashboard) {
        const latestResp = await getJson(LOCAL_BACKEND, RUNTIME_GROWTH_DASHBOARD_PATH, {});
        if (latestResp.ok && latestResp.payload && typeof latestResp.payload === 'object' && latestResp.payload?.parse_pipeline?.has_work) {
          payload = latestResp.payload;
        }
      }
    } else {
      const resp = await getJson(LOCAL_BACKEND, RUNTIME_GROWTH_DASHBOARD_PATH, {});
      if (!resp.ok) throw new Error(safeText(resp.payload?.error, `load failed (${resp.status})`));
      payload = resp.payload && typeof resp.payload === 'object' ? resp.payload : null;
    }
    state.growthDashboardSnapshot = payload;
    recoverSessionFromGrowthSnapshot(state.growthDashboardSnapshot || {});
    syncGenerationRuntimeFromSnapshot(state.growthDashboardSnapshot || {});
    state.growthDashboardError = '';
  } catch (error) {
    state.growthDashboardError = safeText(error?.message, '主卡生长看板暂时没跟上');
  }
  renderGenerationPanel();
  renderGrowthWatchPanel();
}

async function warmRuntimeViews() {
  await Promise.allSettled([
    refreshGrowthDashboard(),
    refreshParseDashboard()
  ]);
  renderAll();
}

function stopGrowthDashboardPolling() {
  if (state.growthDashboardPoller) {
    window.clearTimeout(state.growthDashboardPoller);
    state.growthDashboardPoller = null;
  }
}

function startGrowthDashboardPolling() {
  stopGrowthDashboardPolling();
  const tick = async () => {
    await refreshGrowthDashboard().catch(() => {});
    const delay = (state.parseRunning || state.generationRunning) ? 1400 : 4200;
    state.growthDashboardPoller = window.setTimeout(tick, delay);
  };
  state.growthDashboardPoller = window.setTimeout(tick, 0);
}

async function refreshParseDashboard() {
  const payload = await fetchParseRuntimeState();
  const runtimeState = payload?.state && typeof payload.state === 'object' ? payload.state : null;
  if (!runtimeState && state.growthDashboardSnapshot?.parse_pipeline?.has_work) {
    recoverSessionFromGrowthSnapshot(state.growthDashboardSnapshot || {});
  }
  return payload?.state?.parseDashboard || state.parseDashboard;
}

function startPolling() {
  window.clearInterval(state.parsePoller);
  state.parsePoller = window.setInterval(() => {
    refreshParseDashboard().catch(() => {});
  }, 1200);
}

function stopPolling() {
  window.clearInterval(state.parsePoller);
  state.parsePoller = null;
}

async function requestParsePause() {
  if (!state.parseRunning) return;
  state.parsePauseRequested = true;
  renderAll();
  schedulePersist();
  const scope = getCurrentParseScope();
  if (!scope) return;
  try {
    await pauseParseRuntimeRequest(scope);
  } catch (error) {
    state.parseError = safeText(error?.message, '暂停失败');
  }
  renderAll();
  schedulePersist();
}

function syncParseControlButtons() {
  if (els.startParseBtn) {
    els.startParseBtn.disabled = state.parseRunning;
    els.startParseBtn.textContent = state.parsePaused ? '重新开始解析' : '开始解析';
  }
  if (els.pauseParseBtn) {
    els.pauseParseBtn.disabled = !state.parseRunning;
    els.pauseParseBtn.textContent = state.parsePauseRequested ? '暂停中...' : '暂停处理';
  }
  if (els.resumeParseBtn) {
    els.resumeParseBtn.disabled = state.parseRunning || !state.parsePaused || !hasParseCheckpoint();
  }
}

function setParseRunning(value) {
  state.parseRunning = Boolean(value);
  syncParseControlButtons();
  renderAll();
  schedulePersist();
}

async function startParse() {
  const envelope = getSourceEnvelope();
  const activeApi = getActiveApiConfig();
  if (!activeApi?.baseUrl) {
    throw new Error('先在上面选一个可用的 API 方案。');
  }
  state.sessionId = createSessionId();
  state.parseDashboard = null;
  state.lastIngest = null;
  state.lastTranslation = null;
  state.lastTaskPrepare = null;
  state.lastDrain = null;
  state.generatedBundle = null;
  state.parseError = '';
  state.parsePaused = false;
  state.parsePauseRequested = false;
  state.parsePlan = buildSmartChunkPlan(state.loadedFile);
  state.parseWorkerState = {
    total: 0,
    completed: 0,
    failed: 0,
    currentLabel: '',
    mode: 'running'
  };
  state.generationProgress = 0;
  state.generationLabel = '未开始';
  const scope = buildParseScope();
  const payloadBytes = estimateJsonBytes({
    scope,
    source_envelope: envelope,
    parse_plan: state.parsePlan,
    api_config: activeApi
  });
  if (payloadBytes > START_PARSE_PAYLOAD_LIMIT_BYTES) {
    throw createSourceError(
      'PAYLOAD_TOO_LARGE',
      `本次解析请求约 ${prettyBytes(payloadBytes)}，超过建议上限 ${prettyBytes(START_PARSE_PAYLOAD_LIMIT_BYTES)}。`
    );
  }

  setParseRunning(true);
  startPolling();
  renderAll();
  flushStateNow({
    parseRunning: true,
    parsePaused: false,
    parsePauseRequested: false,
    parseError: ''
  });

  try {
    await startParseRuntimeRequest({
      scope,
      sourceEnvelope: envelope,
      parsePlan: state.parsePlan,
      apiConfig: activeApi
    });
    await refreshParseDashboard();
    refreshFingerprintCandidates();
  } catch (error) {
    state.parseError = describeSourceError(error, state.loadedFile);
    stopPolling();
    state.parsePaused = false;
    state.parsePauseRequested = false;
    setParseRunning(false);
    throw error;
  } finally {
    renderAll();
    flushStateNow({
      parseRunning: state.parseRunning,
      parsePaused: state.parsePaused,
      parsePauseRequested: state.parsePauseRequested,
      parseError: state.parseError
    });
  }
}

async function resumeParse() {
  if (state.parseRunning || !hasParseCheckpoint() || !state.parsePaused) return;
  const activeApi = getActiveApiConfig();
  if (!activeApi?.baseUrl) {
    throw new Error('先在上面选一个可用的 API 方案。');
  }

  const scope = buildParseScope();
  state.parseError = '';
  state.parsePaused = false;
  state.parsePauseRequested = false;
  state.parseWorkerState = {
    ...state.parseWorkerState,
    mode: 'running'
  };

  setParseRunning(true);
  startPolling();
  renderAll();
  flushStateNow({
    parseRunning: true,
    parsePaused: false,
    parsePauseRequested: false,
    parseError: ''
  });

  try {
    await resumeParseRuntimeRequest(scope, activeApi);
    await refreshParseDashboard();
    refreshFingerprintCandidates();
  } catch (error) {
    state.parseError = describeSourceError(error, state.loadedFile);
    stopPolling();
    state.parsePaused = true;
    state.parsePauseRequested = false;
    setParseRunning(false);
    throw error;
  } finally {
    renderAll();
    flushStateNow({
      parseRunning: state.parseRunning,
      parsePaused: state.parsePaused,
      parsePauseRequested: state.parsePauseRequested,
      parseError: state.parseError
    });
  }
}

function downloadText(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const ZIP_ENCODER = new TextEncoder();
const ZIP_CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function safeArchiveName(name, fallback) {
  const raw = String(name || '').trim() || fallback;
  return raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function zipToUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return ZIP_ENCODER.encode(String(data || ''));
}

function zipCrc32Of(data) {
  const bytes = zipToUint8(data);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = ZIP_CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function getZipDosDateTime() {
  const now = new Date();
  const year = Math.max(1980, now.getFullYear());
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const seconds = Math.floor(now.getSeconds() / 2);
  const dosTime = ((hours & 0x1F) << 11) | ((minutes & 0x3F) << 5) | (seconds & 0x1F);
  const dosDate = (((year - 1980) & 0x7F) << 9) | ((month & 0x0F) << 5) | (day & 0x1F);
  return { dosTime, dosDate };
}

function buildZipBlob(files = []) {
  const entries = (files || [])
    .map((item) => ({
      name: String(item?.name || '').trim(),
      bytes: zipToUint8(item?.data || '')
    }))
    .filter((item) => item.name);
  if (!entries.length) return new Blob([], { type: 'application/zip' });

  const localParts = [];
  const centralParts = [];
  const { dosTime, dosDate } = getZipDosDateTime();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = ZIP_ENCODER.encode(entry.name);
    const rawSize = entry.bytes.length;
    const crc = zipCrc32Of(entry.bytes);
    const method = 0;
    const compressedSize = rawSize;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, rawSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    localParts.push(local, entry.bytes);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, rawSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);
    offset += local.length + compressedSize;
  }

  const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
}

function downloadZipFiles(files = [], zipFilename = 'obsidian-export.zip') {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return false;
  downloadBlob(buildZipBlob(list), zipFilename);
  return true;
}

function exportMaterials() {
  const payload = buildRuntimeMaterialsExport({
    sessionId: state.sessionId,
    sourceLabel: getSourceLabel(),
    parsePlan: state.parsePlan,
    parseDashboard: state.parseDashboard,
    ingest: state.lastIngest,
    translation: state.lastTranslation,
    taskPrepare: state.lastTaskPrepare,
    parseRun: state.lastDrain
  });
  downloadText(`materials-${state.sessionId || 'draft'}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'application/json;charset=utf-8');
}

function findMatchingApiProfileName(config) {
  const current = {
    baseUrl: trimTrailingSlash(config?.baseUrl || ''),
    apiKey: typeof config?.apiKey === 'string' ? config.apiKey : '',
    model: safeText(config?.model, 'gpt-4o-mini')
  };
  return getApiProfilesForView().find((item) => (
    item.baseUrl === current.baseUrl
    && item.apiKey === current.apiKey
    && item.model === current.model
  ))?.name || '';
}

function getActiveApiConfig() {
  const profile = getSelectedApiProfile();
  if (profile) {
    return {
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model: safeText(profile.model, 'gpt-4o-mini')
    };
  }

  const shared = readSharedApiConfig();
  if (shared.baseUrl) {
    return {
      baseUrl: trimTrailingSlash(shared.baseUrl),
      apiKey: typeof shared.apiKey === 'string' ? shared.apiKey : '',
      model: safeText(shared.model, 'gpt-4o-mini')
    };
  }

  if (state.runtimeSharedApiConfig?.baseUrl) {
    return {
      baseUrl: trimTrailingSlash(state.runtimeSharedApiConfig.baseUrl),
      apiKey: typeof state.runtimeSharedApiConfig.apiKey === 'string' ? state.runtimeSharedApiConfig.apiKey : '',
      model: safeText(state.runtimeSharedApiConfig.model, 'gpt-4o-mini')
    };
  }

  return null;
}

function applySelectedApiProfile(profileName, options = {}) {
  const profile = getApiProfilesForView().find((item) => item.name === safeText(profileName));
  if (!profile) {
    state.activeApiProfileName = '';
    syncApiModelDisplay(readSharedApiConfig().model || '');
    if (!options.silent) {
      setApiStatus('未选择', 'stable', '请选择一个已保存方案。');
    }
    saveSharedApiConfig();
    return;
  }

  state.activeApiProfileName = profile.name;
  els.apiProfileSelect.value = profile.name;
  syncApiModelDisplay(safeText(options.model || profile.model, profile.model));
  saveSharedApiConfig();
  if (!options.silent) {
    setApiStatus('已选择', 'stable', `已选中「${profile.displayName || profile.name}」。`);
  }
}

async function testApi() {
  const config = getActiveApiConfig();
  if (!config?.baseUrl) {
    setApiStatus('未选择', 'stable', '先选一个已保存方案，再测试连接。');
    return;
  }

  if (isMockApiConfig(config)) {
    setApiStatus('本地快检', 'ready', '这套模式不走外部 API，只用于验收流程是否连通。');
    saveSharedApiConfig();
    return;
  }

  const original = els.testApiBtn.textContent;
  els.testApiBtn.disabled = true;
  els.testApiBtn.textContent = '测试中...';
  setApiStatus('测试中', 'live', '正在测试连接。');

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const resp = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '你是测试助手。' },
          { role: 'user', content: '请用一句话确认 API 已连接。' }
        ],
        temperature: 0.2
      })
    });

    if (!resp.ok) throw new Error(`API Error ${resp.status}`);
    await resp.json();
    setApiStatus('连接正常', 'ready', '连接正常，可以继续。');
    saveSharedApiConfig();
  } catch (error) {
    setApiStatus('连接失败', 'error', `连接失败：${error.message}`);
  } finally {
    els.testApiBtn.disabled = false;
    els.testApiBtn.textContent = original;
    schedulePersist();
  }
}

async function generateMemoryBundle() {
  await hydratePersonaWorkspace();
  const workspace = getPersonaWorkspaceView();
  const personaSeed = workspace.personaCard;
  if (!personaSeed) {
    state.generationLabel = '请先让旧实验台把人格工位同步上来';
    renderGenerationPanel();
    return;
  }
  if (!state.sessionId) {
    state.generationLabel = '先跑完一轮解析，再来生成人格记忆';
    renderGenerationPanel();
    return;
  }

  const runtimeView = buildGenerationRuntimeView();
  const shouldResume = runtimeView.queueActive
    && runtimeView.queueCompleted < runtimeView.queueTotal
    && !runtimeView.running
    && (runtimeView.paused || runtimeView.phase === 'failed' || runtimeView.queueCompleted > 0);

  state.generationRunning = true;
  state.generatedBundle = null;
  state.generationProgress = shouldResume && runtimeView.queueTotal
    ? Math.max(1, Math.min(99, Math.round((runtimeView.queueCompleted / runtimeView.queueTotal) * 100)))
    : 4;
  state.generationLabel = shouldResume && runtimeView.queueTotal
    ? `准备从第 ${Math.min(runtimeView.queueCompleted + 1, runtimeView.queueTotal)}/${runtimeView.queueTotal} 张继续`
    : '已接住这轮生长请求，正在进后厨排题面';
  renderGenerationPanel();
  flushStateNow({
    generationRunning: true,
    generationProgress: state.generationProgress,
    generationLabel: state.generationLabel,
    generatedBundle: null
  });
  await refreshGrowthDashboard().catch(() => {});

  try {
    const currentApi = getActiveApiConfig();
    const scope = getCurrentParseScope() || buildParseScope();
    const selectedProfile = getSelectedApiProfile();

    const body = {
      ...scope,
      card_type: 'memo',
      include_persona_rows: true,
      row_limit: 8,
      commit: true,
      save_artifact: true,
      export_to_obsidian: true,
      overwrite_export: true
    };

    if (selectedProfile?.name && selectedProfile.name !== LOCAL_PROGRAMMATIC_PROFILE.name) {
      body.api_profile_name = selectedProfile.name;
    }
    if (selectedProfile?.name === LOCAL_PROGRAMMATIC_PROFILE.name || currentApi?.baseUrl === LOCAL_PROGRAMMATIC_PROFILE.baseUrl) {
      body.mode = 'local_programmatic';
    }

    const actionPath = shouldResume ? `${RUNTIME_GROWTH_RUNTIME_PATH}/resume` : `${RUNTIME_GROWTH_RUNTIME_PATH}/start`;
    const resp = await postJson(LOCAL_BACKEND, actionPath, body);
    if (!resp.ok) {
      throw new Error(safeText(resp.payload?.error, `生成失败 (${resp.status})`));
    }
    const runtimeSnapshot = resp.payload && typeof resp.payload === 'object' ? resp.payload : {};
    syncGenerationRuntimeFromSnapshot(runtimeSnapshot);
    flushStateNow({
      generationRunning: true,
      generationProgress: state.generationProgress,
      generationLabel: state.generationLabel,
      generatedBundle: state.generatedBundle
    });
    await refreshGrowthDashboard().catch(() => {});
  } catch (error) {
    state.generationLabel = safeText(error?.message, '生成失败');
    state.generationProgress = 0;
    flushStateNow({
      generationRunning: false,
      generationProgress: state.generationProgress,
      generationLabel: state.generationLabel
    });
  }
  renderGenerationPanel();
}

async function downloadGrowthScopeBundle() {
  const scope = getCurrentParseScope() || buildParseScope();
  if (!scope?.owner_id || !scope?.realm_id) {
    throw new Error('当前还没有可导出的工作台。');
  }
  const resp = await postJson(LOCAL_BACKEND, RUNTIME_MEMO_COMPACT_EXPORT_PATH, {
    ...scope,
    overwrite: true,
    include_content: true
  });
  if (!resp.ok) {
    throw new Error(safeText(resp.payload?.error, `导出失败 (${resp.status})`));
  }
  const payload = resp.payload && typeof resp.payload === 'object' ? resp.payload : {};
  const files = Array.isArray(payload.files) ? payload.files : [];
  const zipFiles = files
    .filter((item) => String(item?.bundle_path || '').trim() && typeof item?.markdown === 'string')
    .map((item) => ({
      name: String(item.bundle_path || '').trim(),
      data: item.markdown
    }));
  if (!downloadZipFiles(
    zipFiles,
    safeArchiveName(payload.bundle_name || `${scope.realm_id || 'growth'}-obsidian-compact-md-bundle.zip`, 'growth-obsidian-compact-md-bundle.zip')
  )) {
    throw new Error('导出包里还没有可下载的笔记。');
  }
  state.generationLabel = `已把 ${Number(payload.raw_memo_count || 0)} 张原始卡收成 ${Number(payload.compact_memo_count || 0)} 张主记忆`
    + (Number(payload.raw_source_note_count || 0) ? ` · ${Number(payload.raw_source_note_count || 0)} 份原文回溯` : '');
  renderGenerationPanel();
  await refreshGrowthDashboard().catch(() => {});
}

async function downloadBundle() {
  const scope = getCurrentParseScope() || buildParseScope();
  const draftTotal = Number(state.growthDashboardSnapshot?.growth_drafts?.total || 0);
  const stagedTotal = Number(state.growthDashboardSnapshot?.staging_cards?.total || 0);
  const registryTotal = Number(state.growthDashboardSnapshot?.card_registry?.summary?.total_cards || 0);
  if (scope?.realm_id && (draftTotal > 0 || stagedTotal > 0 || registryTotal > 0)) {
    await downloadGrowthScopeBundle();
    return;
  }
  if (!state.generatedBundle) return;
  const lines = [
    '---',
    `title: Obsidian Persona Memory Draft`,
    `generated_at: ${state.generatedBundle.generated_at}`,
    `source_label: ${state.generatedBundle.source_label || ''}`,
    `session_id: ${state.generatedBundle.session_id || ''}`,
    '---',
    '',
    '# 当前身份锚点',
    '',
    `- {{char}}：${state.generatedBundle.identity_anchor?.char_name || '未填写'}`,
    `- {{user}}：${state.generatedBundle.identity_anchor?.user_name || '未填写'}`,
    '',
    '# 人设卡',
    '',
    state.generatedBundle.persona_seed || '',
    '',
    '# 表达指纹',
    '',
    state.generatedBundle.voice_fingerprint || '（这里还没有填）',
    '',
    '# 指纹候选片段',
    ''
  ];

  const snippets = Array.isArray(state.generatedBundle.selected_source_snippets)
    ? state.generatedBundle.selected_source_snippets
    : [];

  if (snippets.length) {
    snippets.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  } else {
    lines.push('（这里还没有另外选中的片段）');
  }

  lines.push(
    '',
    '# 这轮内容摘要',
    '',
    `- 当前阶段：${state.generatedBundle.parse_summary.stage || '未开始'}`,
    `- 内容条目数：${state.generatedBundle.parse_summary.material_count || 0}`,
    `- 关联线索数：${state.generatedBundle.parse_summary.related_count || 0}`,
    '',
    '# 原文节选',
    '',
    state.generatedBundle.source_excerpt || '（无）',
    ''
  );

  downloadText(`obsidian-memory-draft-${state.sessionId || 'draft'}.md`, `${lines.join('\n')}\n`, 'text/markdown;charset=utf-8');
}

function bindInputs() {
  els.apiProfileSelect.addEventListener('change', () => {
    applySelectedApiProfile(els.apiProfileSelect.value);
    renderGenerationPanel();
    schedulePersist();
  });

  els.conversationFile.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      state.loadedFile = null;
      state.parsePlan = null;
      renderAll();
      return;
    }

    try {
      const normalized = await normalizeConversationFiles(files);
      state.loadedFile = normalized;
      state.parsePlan = buildSmartChunkPlan(normalized);
      state.lastIngest = null;
      state.lastTranslation = null;
      state.lastTaskPrepare = null;
      state.lastDrain = null;
      state.parseDashboard = null;
      state.parseError = '';
      state.parseWorkerState = {
        total: 0,
        completed: 0,
        failed: 0,
        currentLabel: '',
        mode: 'idle'
      };
      renderAll();
      schedulePersist();
    } catch (error) {
      state.loadedFile = null;
      state.parsePlan = null;
      els.fileStatus.textContent = describeSourceError(error, files[0]);
    }
  });

}

function bindButtons() {
  if (els.resetLocalWorkspaceBtn) {
    els.resetLocalWorkspaceBtn.addEventListener('click', () => {
      handleVisibleLocalReset().catch((error) => {
        setApiStatus('重置失败', 'stable', safeText(error?.message, '本地工作台重置失败。'));
      });
    });
  }
  els.testApiBtn.addEventListener('click', () => {
    testApi();
  });

  els.startParseBtn.addEventListener('click', () => {
    startParse().catch((error) => {
      state.parseError = describeSourceError(error, state.loadedFile);
      stopPolling();
      state.parsePaused = false;
      state.parsePauseRequested = false;
      setParseRunning(false);
      renderAll();
    });
  });

  if (els.pauseParseBtn) {
    els.pauseParseBtn.addEventListener('click', () => {
      requestParsePause().catch((error) => {
        state.parseError = safeText(error?.message, '暂停失败');
        renderAll();
      });
    });
  }

  if (els.resumeParseBtn) {
    els.resumeParseBtn.addEventListener('click', () => {
      resumeParse().catch((error) => {
        state.parseError = describeSourceError(error, state.loadedFile);
        stopPolling();
        state.parsePaused = true;
        state.parsePauseRequested = false;
        setParseRunning(false);
        renderAll();
      });
    });
  }

  els.exportMaterialsBtn.addEventListener('click', () => {
    exportMaterials();
  });

  els.generateMemoryBtn.addEventListener('click', () => {
    generateMemoryBundle().catch((error) => {
      state.generationRunning = false;
      state.generationProgress = 0;
      state.generationLabel = `生成失败：${error.message}`;
      renderGenerationPanel();
    });
  });

  els.downloadBundleBtn.addEventListener('click', () => {
    downloadBundle().catch((error) => {
      state.generationLabel = safeText(error?.message, '导出失败');
      renderGenerationPanel();
    });
  });
}

async function refreshApiProfileView(options = {}) {
  const preserveSelection = options.preserveSelection !== false;
  const currentSelection = preserveSelection
    ? safeText(els.apiProfileSelect.value || state.activeApiProfileName)
    : '';

  const optimisticProfiles = getApiProfilesForView();
  const optimisticSelection = safeText(
    currentSelection
      || getDefaultApiProfileName()
      || '',
    ''
  );
  renderApiProfiles(optimisticSelection);
  if (optimisticProfiles.length) {
    setApiStatus('已选择', 'stable', `先显示本地方案，共 ${optimisticProfiles.length} 个。`);
  } else {
    setApiStatus('读取中', 'stable', '正在和本地后端对表。');
  }

  await hydrateApiProfiles();
  const sharedApi = getSharedApiConfigForView();

  const preferredProfile = safeText(
    currentSelection
      || getDefaultApiProfileName()
      || '',
    ''
  );

  renderApiProfiles(preferredProfile);

  if (preferredProfile) {
    applySelectedApiProfile(preferredProfile, { silent: true });
    const currentProfile = getSelectedApiProfile();
    setApiStatus('已选择', 'stable', `已选中「${currentProfile?.displayName || currentProfile?.name || preferredProfile}」。`);
    return;
  }

  state.activeApiProfileName = '';
  syncApiModelDisplay(sharedApi.model || '');

  if (getApiProfilesForView().length) {
    setApiStatus('未选择', 'stable', '请选择一个已保存方案。');
    return;
  }

  if (sharedApi.baseUrl) {
    setApiStatus('无方案', 'stable', '当前接口配置已载入。');
    return;
  }

  if (window.location.protocol === 'file:') {
    setApiStatus('无方案', 'stable', '这页最好从同源服务打开，不要直接双击文件。');
    return;
  }

  if (state.apiProfilesError) {
    setApiStatus('无方案', 'stable', state.apiProfilesError);
    return;
  }

  setApiStatus('无方案', 'stable', '还没读到已保存方案。');
}

async function hydrate() {
  if (SHOULD_RESET_LOCAL_RUNTIME) {
    await resetLocalRuntimeMirror();
  }
  renderRuntimeStamp();
  const localSaved = readStorage();
  let saved = localSaved;
  try {
    const remoteResp = await getJson(LOCAL_BACKEND, RUNTIME_FRONT_STATE_PATH, {});
    const remoteState = remoteResp?.payload?.state && typeof remoteResp.payload.state === 'object'
      ? remoteResp.payload.state
      : null;
    const localSavedAt = Date.parse(safeText(localSaved?.savedAt || localSaved?.saved_at));
    const remoteSavedAt = Date.parse(safeText(remoteResp?.payload?.saved_at || remoteState?.savedAt));
    if (
      remoteResp?.ok
      && remoteState
      && (
        !Number.isFinite(localSavedAt)
        || (Number.isFinite(remoteSavedAt) && remoteSavedAt >= localSavedAt)
      )
    ) {
      saved = {
        ...localSaved,
        ...remoteState,
        prefs: remoteState.prefs || localSaved?.prefs || {},
        savedAt: safeText(remoteResp.payload.saved_at || remoteState.savedAt || localSaved?.savedAt)
      };
    }
    const remoteLooksBlank = Boolean(
      remoteResp?.ok
      && !remoteState
      && !normalizeScopeShape(remoteResp?.payload?.active_scope)
      && !safeText(remoteResp?.payload?.saved_at)
    );
    if (remoteLooksBlank) {
      saved = {};
      clearLocalWorkspaceMirror();
    }
  } catch {}
  const prefs = saved?.prefs || {};

  state.sessionId = safeText(saved.sessionId, '');
  state.active_scope = normalizeScopeShape(saved.active_scope) || null;
  state.parseDashboard = saved.parseDashboard || null;
  state.lastIngest = saved.lastIngest || null;
  state.lastDrain = saved.lastDrain || null;
  state.lastTranslation = saved.lastTranslation || null;
  state.lastTaskPrepare = saved.lastTaskPrepare || null;
  state.parsePlan = saved.parsePlan || null;
  state.parsePaused = Boolean(saved.parsePaused);
  state.parsePauseRequested = Boolean(saved.parsePauseRequested);
  state.parseWorkerState = saved.parseWorkerState || {
    total: 0,
    completed: 0,
    failed: 0,
    currentLabel: '',
    mode: 'idle'
  };
  state.parseError = safeText(saved.parseError, '');
  state.generationRunning = Boolean(saved.generationRunning);
  state.generatedBundle = saved.generatedBundle || null;
  state.generationProgress = Number(saved.generationProgress || 0);
  state.generationLabel = safeText(saved.generationLabel, '未开始');
  state.lastSavedAt = safeText(saved.savedAt, '');

  if (prefs.apiProfileName) {
    state.activeApiProfileName = safeText(prefs.apiProfileName);
  }

  await Promise.all([
    refreshApiProfileView({
      preserveSelection: Boolean(prefs.apiProfileName)
    }),
    hydratePersonaWorkspace()
  ]);

  renderAll();
  if (state.sessionId || state.parseDashboard || state.generatedBundle || state.generationRunning) {
    flushStateNow({
      parseRunning: state.parseRunning,
      parsePaused: state.parsePaused,
      parsePauseRequested: state.parsePauseRequested,
      parseError: state.parseError,
      generationRunning: state.generationRunning,
      generationProgress: state.generationProgress,
      generationLabel: state.generationLabel,
      generatedBundle: state.generatedBundle
    });
  }
}

bindInputs();
bindButtons();

window.addEventListener('pagehide', () => {
  flushStateNow({
    parseRunning: state.parseRunning,
    parsePaused: state.parsePaused,
    parsePauseRequested: state.parsePauseRequested,
    parseError: state.parseError,
    generationRunning: state.generationRunning,
    generationProgress: state.generationProgress,
    generationLabel: state.generationLabel,
    generatedBundle: state.generatedBundle
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  flushStateNow({
    parseRunning: state.parseRunning,
    parsePaused: state.parsePaused,
    parsePauseRequested: state.parsePauseRequested,
    parseError: state.parseError,
    generationRunning: state.generationRunning,
    generationProgress: state.generationProgress,
    generationLabel: state.generationLabel,
    generatedBundle: state.generatedBundle
  });
});

hydrate().finally(() => {
  window.setTimeout(() => {
    warmRuntimeViews().catch(() => {
      renderAll();
    });
    startGrowthDashboardPolling();
  }, 0);
});

window.addEventListener('focus', () => {
  Promise.all([
    refreshApiProfileView({ preserveSelection: true }),
    hydratePersonaWorkspace(),
    refreshGrowthDashboard(),
    refreshParseDashboard().catch(() => null)
  ]).catch(() => {}).finally(() => {
    renderAll();
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    Promise.all([
      refreshApiProfileView({ preserveSelection: true }),
      hydratePersonaWorkspace(),
      refreshGrowthDashboard(),
      refreshParseDashboard().catch(() => null)
    ]).catch(() => {}).finally(() => {
      renderAll();
    });
  } else {
    stopGrowthDashboardPolling();
    return;
  }
  startGrowthDashboardPolling();
});
