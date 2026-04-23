import { buildMemoryScope } from './scope-contract.js';
import { materializeIngressPacket } from './ingest-materializer.js';
import { writeMemoryEnvelope } from './memory-write-service.js';
import { getMemoryHomePacket } from './memory-home-service.js';
import { normalizeIngestBody } from './runtime-source-assembler.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function stableList(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean)));
}

function safeDocId(value, fallback) {
  const text = safeText(value)
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return text || fallback;
}

function normalizeTs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  const ms = num > 1e12 ? num : num * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function stringifyBundleMessages(messages) {
  const rows = [];
  const windows = new Set();
  for (const item of Array.isArray(messages) ? messages : []) {
    const role = safeText(item?.role || 'unknown');
    const content = safeText(item?.content);
    if (!content) continue;
    const title = safeText(item?.source_window_title);
    if (title) windows.add(title);
    const prefix = title ? `[${title}] ${role}` : role;
    rows.push(`${prefix}: ${content}`);
  }
  return {
    text: rows.join('\n'),
    windows: Array.from(windows)
  };
}

function normalizeDocument(doc = {}, idx = 0) {
  const text = safeText(doc?.text || doc?.content || '');
  if (!text) return null;
  const docId = safeDocId(doc?.doc_id || doc?.title || '', `doc_${idx + 1}`);
  return {
    doc_id: docId,
    title: safeText(doc?.title || docId),
    kind: safeText(doc?.kind || 'text'),
    created_at: safeText(doc?.created_at || doc?.ts || ''),
    char_count: text.length,
    meta: doc?.meta && typeof doc.meta === 'object' ? doc.meta : {},
    text
  };
}

function normalizeBundleItem(item = {}, idx = 0) {
  const payload = stringifyBundleMessages(item?.messages || []);
  const text = safeText(payload.text);
  if (!text) return null;
  const firstTs = Array.isArray(item?.messages)
    ? item.messages.map((row) => normalizeTs(row?.ts)).find(Boolean) || ''
    : '';
  return {
    doc_id: safeDocId(item?.doc_id || item?.title || '', `bundle_${idx + 1}`),
    title: safeText(item?.title || `bundle_${idx + 1}`),
    kind: 'chat_bundle',
    created_at: safeText(item?.created_at || firstTs),
    char_count: text.length,
    meta: {
      message_count: Array.isArray(item?.messages) ? item.messages.length : 0,
      window_titles: payload.windows,
      roles: stableList((item?.messages || []).map((row) => row?.role))
    },
    text
  };
}

function collectDocuments(body = {}) {
  const docs = [];
  const push = (item) => {
    if (item) docs.push(item);
  };

  const input = body?.input && typeof body.input === 'object' ? body.input : {};

  if (safeText(body?.raw_text || input?.raw_text)) {
    push(normalizeDocument({
      doc_id: body?.doc_id || input?.doc_id || 'raw_text',
      title: body?.title || input?.title || body?.source?.label || 'raw_text',
      kind: body?.kind || input?.kind || body?.source?.kind || 'raw_text',
      created_at: body?.created_at || input?.created_at || '',
      text: body?.raw_text || input?.raw_text,
      meta: body?.meta || input?.meta || {}
    }));
  }

  const documents = Array.isArray(body?.documents) ? body.documents : (Array.isArray(input?.documents) ? input.documents : []);
  documents.forEach((doc, idx) => push(normalizeDocument(doc, idx)));

  const bundle = Array.isArray(body?.bundle) ? body.bundle : (Array.isArray(input?.bundle) ? input.bundle : []);
  bundle.forEach((item, idx) => push(normalizeBundleItem(item, idx)));

  return docs.filter(Boolean);
}

function buildPacketId(scope, source) {
  const owner = safeText(scope?.owner_id || 'owner');
  const realm = safeText(scope?.realm_id || 'default');
  const label = safeText(source?.label || source?.kind || 'ingest')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'ingest';
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${owner}__${realm}__${label}__${ts}`;
}

function normalizeTranslation(body = {}) {
  const source = body?.translation && typeof body.translation === 'object' ? body.translation : {};
  const entries = Array.isArray(source?.entries)
    ? source.entries
    : Array.isArray(body?.entries)
      ? body.entries
      : [];
  return {
    status: entries.length > 0 ? 'provided' : 'pending',
    entries
  };
}

export async function ingestMemoryEnvelope(body = {}, options = {}) {
  const normalizedBody = normalizeIngestBody(body);
  const scope = buildMemoryScope({
    ownerId: normalizedBody?.scope?.owner_id,
    realmId: normalizedBody?.scope?.realm_id,
    botId: normalizedBody?.scope?.bot_id,
    mode: 'bot'
  });
  const source = {
    kind: safeText(normalizedBody?.source?.kind || normalizedBody?.kind || 'text_ingest'),
    label: safeText(normalizedBody?.source?.label || normalizedBody?.title || 'ingest'),
    format: safeText(normalizedBody?.source?.format || ''),
    title: safeText(normalizedBody?.source?.title || normalizedBody?.title || '')
  };
  const documents = collectDocuments(normalizedBody);
  const totalChars = documents.reduce((sum, doc) => sum + Number(doc.char_count || 0), 0);
  const translation = normalizeTranslation(normalizedBody);

  const packet = {
    packet_id: buildPacketId(scope, source),
    scope: {
      owner_id: scope.owner_id,
      realm_id: scope.realm_id,
      bot_id: scope.bot_id
    },
    source,
    input: {
      document_count: documents.length,
      total_chars: totalChars,
      documents
    },
    translation: {
      status: translation.status,
      entry_count: translation.entries.length,
      note: translation.entries.length
        ? '已附带标准语言翻译结果，可直接尝试写树。'
        : '已收件，下一步可接标准语言翻译层或 AI 归位层。'
    },
    writeback: {
      status: 'pending',
      summary: null
    }
  };

  const materialized = await materializeIngressPacket(packet, {
    label: options.label || packet.packet_id,
    owner_id: scope.owner_id,
    realm_id: scope.realm_id
  });

  let writeback = null;
  if (translation.entries.length > 0) {
    writeback = await writeMemoryEnvelope({
      scope: packet.scope,
      source: {
        kind: safeText(normalizedBody?.translation?.source_kind || 'normalized_translation'),
        label: safeText(normalizedBody?.translation?.label || packet.source.label)
      },
      entries: translation.entries
    }, {
      label: safeText(options.label || packet.packet_id)
    });
    packet.writeback = {
      status: 'written',
      summary: writeback.summary
    };
    await materializeIngressPacket(packet, {
      label: options.label || packet.packet_id,
      owner_id: scope.owner_id,
      realm_id: scope.realm_id
    });
  }

  const home = writeback?.home?.ok ? writeback.home : await getMemoryHomePacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id,
    botId: scope.bot_id,
    mode: 'bot'
  });

  return {
    ok: true,
    schema: 'hippocove_ingest_result_v0.1',
    packet_id: packet.packet_id,
    scope: {
      ...scope,
      isolation_stage: 'scoped_truth'
    },
    source,
    ingest: {
      packet_dir: materialized.packet_dir,
      packet_file: materialized.packet_file,
      document_count: documents.length,
      total_chars: totalChars,
      next_step: translation.entries.length > 0 ? 'written' : 'translation_needed'
    },
    translation: packet.translation,
    writeback,
    home: home?.ok ? home : {},
    home_summary: home?.ok && home?.home_summary ? home.home_summary : {},
    sample_documents: documents.slice(0, 8).map((doc) => ({
      doc_id: doc.doc_id,
      title: doc.title,
      kind: doc.kind,
      created_at: doc.created_at,
      char_count: doc.char_count
    }))
  };
}
