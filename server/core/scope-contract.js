function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeReaderMode(mode) {
  const text = String(mode || '').trim().toLowerCase();
  if (!text) return 'bot';
  if (text === 'main_bot' || text === 'bot' || text === 'reader_bot') return 'bot';
  if (text === 'persona_helper' || text === 'persona') return 'persona_helper';
  if (text === 'mcp' || text === 'agent') return 'mcp';
  return text;
}

export function buildMemoryScope({
  ownerId = '',
  realmId = '',
  botId = '',
  mode = '',
  userId = '',
  charId = ''
} = {}) {
  const owner_id = normalizeText(ownerId || userId);
  const realm_id = normalizeText(realmId, 'default');
  const bot_id = normalizeText(botId || charId);
  const reader_mode = normalizeReaderMode(mode);

  return {
    owner_id,
    realm_id,
    bot_id,
    reader_mode,
    isolation_stage: 'envelope_only',
    note: '当前真相层已支持按 owner+realm 分湾落库；bot_id 先主要影响叶层读取与后续人格写回。'
  };
}
