import { readFile } from 'fs/promises';
import { loadLatestIngressPacket, loadIngressPacketByFile } from './ingest-store.js';
import { buildMemoryScope } from './scope-contract.js';
import { materializeTranslationPacket } from './translation-materializer.js';
import { buildTranslatorContract, normalizeTranslationEntries } from './translation-contract.js';
import { writeMemoryEnvelope } from './memory-write-service.js';
import { getMemoryHomePacket } from './memory-home-service.js';

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function previewText(text, limit = 140) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function splitChatLines(text, targetChars) {
  const lines = String(text || '').split('\n').filter((line) => line.trim());
  const slices = [];
  let current = [];
  let currentLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (current.length && currentLen + lineLen > targetChars) {
      slices.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length) slices.push(current.join('\n'));
  return slices;
}

function splitParagraphs(text, targetChars) {
  const paras = String(text || '')
    .split(/\n\s*\n/g)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!paras.length) return splitChatLines(text, targetChars);
  const slices = [];
  let current = [];
  let currentLen = 0;
  for (const para of paras) {
    const paraLen = para.length + 2;
    if (current.length && currentLen + paraLen > targetChars) {
      slices.push(current.join('\n\n'));
      current = [];
      currentLen = 0;
    }
    current.push(para);
    currentLen += paraLen;
  }
  if (current.length) slices.push(current.join('\n\n'));
  return slices;
}

function splitDocument(doc, targetChars) {
  const text = safeText(doc?.text);
  if (!text) return [];
  const rawSlices = doc?.kind === 'chat_bundle'
    ? splitChatLines(text, targetChars)
    : splitParagraphs(text, targetChars);

  const slices = [];
  let cursor = 0;
  rawSlices.forEach((sliceText, idx) => {
    const start = cursor;
    const end = start + sliceText.length;
    cursor = end;
    slices.push({
      slice_id: `${doc.doc_id}__${String(idx + 1).padStart(3, '0')}`,
      doc_id: doc.doc_id,
      title: doc.title || '',
      kind: doc.kind || '',
      created_at: doc.created_at || '',
      start_char: start,
      end_char: end,
      char_count: sliceText.length,
      prompt_hint: `${doc.kind || 'document'} / ${doc.title || doc.doc_id} / slice ${idx + 1}`,
      text: sliceText
    });
  });
  return slices;
}

async function loadDocText(doc = {}) {
  if (safeText(doc?.text)) return safeText(doc.text);
  if (!safeText(doc?.file)) return '';
  try {
    const raw = await readFile(doc.file, 'utf-8');
    const parsed = JSON.parse(raw);
    return safeText(parsed?.text || '');
  } catch {
    return '';
  }
}

async function extractDocuments(packet = {}) {
  const docs = Array.isArray(packet?.input?.documents) ? packet.input.documents : [];
  const normalized = [];
  for (const doc of docs) {
    const text = await loadDocText(doc);
    normalized.push({
      doc_id: safeText(doc.doc_id),
      title: safeText(doc.title || doc.doc_id),
      kind: safeText(doc.kind || 'text'),
      created_at: safeText(doc.created_at || ''),
      char_count: Number(doc.char_count || 0),
      text,
      file: safeText(doc.file || '')
    });
  }
  return normalized.filter((doc) => doc.doc_id && doc.text);
}

async function resolvePacket(body = {}) {
  if (safeText(body.packet_file)) {
    const packet = await loadIngressPacketByFile(body.packet_file);
    return {
      packet,
      packetFile: body.packet_file
    };
  }

  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const latest = await loadLatestIngressPacket({
    ownerId: scope.owner_id,
    realmId: scope.realm_id
  });
  return {
    packet: latest.packet,
    packetFile: latest.packetFile
  };
}

export async function buildTranslationPacket(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const { packet: ingestPacket, packetFile } = await resolvePacket(body);
  const targetChars = Math.max(1200, Number(body?.target_chars || 8000));
  const docs = await extractDocuments(ingestPacket);
  const slices = docs.flatMap((doc) => splitDocument(doc, targetChars));

  const translationPacket = {
    packet_id: `${ingestPacket.packet_id}__translate`,
    ingest_packet_id: ingestPacket.packet_id,
    scope: {
      owner_id: scope.owner_id || ingestPacket?.scope?.owner_id || '',
      realm_id: scope.realm_id || ingestPacket?.scope?.realm_id || 'default',
      bot_id: scope.bot_id || ingestPacket?.scope?.bot_id || ''
    },
    source: {
      kind: 'translation_packet',
      label: safeText(body?.source?.label || ingestPacket?.source?.label || ingestPacket?.packet_id || 'translation'),
      ingest_packet_file: packetFile
    },
    summary: {
      document_count: docs.length,
      slice_count: slices.length,
      total_chars: docs.reduce((sum, doc) => sum + Number(doc.char_count || 0), 0),
      target_chars: targetChars,
      note: '这是一份给标准语言翻译层/AI 归位层使用的中间包。'
    },
    output_contract: {
      target_route: '/api/memory/write',
      expected_entry_schema: 'normalized_placement_entry_v0.1',
      note: '翻译层只需要把切片翻成 entries，后端写树合同已经稳定。'
    },
    slices
  };

  const materialized = await materializeTranslationPacket(translationPacket, {
    label: safeText(body?.source?.label || translationPacket.packet_id),
    owner_id: translationPacket.scope.owner_id,
    realm_id: translationPacket.scope.realm_id
  });

  const home = await getMemoryHomePacket({
    ownerId: translationPacket.scope.owner_id,
    realmId: translationPacket.scope.realm_id,
    botId: translationPacket.scope.bot_id,
    mode: 'bot'
  });

  return {
    ok: true,
    schema: 'hippocove_translation_result_v0.1',
    packet_id: translationPacket.packet_id,
    ingest_packet_id: translationPacket.ingest_packet_id,
    scope: {
      ...scope,
      isolation_stage: 'scoped_truth'
    },
    translation: {
      packet_dir: materialized.packet_dir,
      packet_file: materialized.packet_file,
      document_count: docs.length,
      slice_count: slices.length,
      target_chars: targetChars,
      next_step: 'ai_or_translator_to_entries'
    },
    home: home?.ok ? home : {},
    home_summary: home?.ok && home?.home_summary ? home.home_summary : {},
    translator_contract: buildTranslatorContract(),
    output_contract: translationPacket.output_contract,
    sample_slices: slices.slice(0, 8).map((slice) => ({
      slice_id: slice.slice_id,
      doc_id: slice.doc_id,
      title: slice.title,
      kind: slice.kind,
      char_count: slice.char_count,
      prompt_hint: slice.prompt_hint,
      preview: previewText(slice.text)
    }))
  };
}

async function resolveTranslationPacket(body = {}) {
  if (safeText(body.packet_file)) {
    const raw = await readFile(body.packet_file, 'utf-8');
    return {
      packetFile: body.packet_file,
      packet: JSON.parse(raw)
    };
  }
  throw new Error('translation packet_file is required');
}

export async function applyTranslationEntries(body = {}) {
  const scope = buildMemoryScope({
    ownerId: body?.scope?.owner_id,
    realmId: body?.scope?.realm_id,
    botId: body?.scope?.bot_id,
    mode: 'bot'
  });
  const { packet, packetFile } = await resolveTranslationPacket(body);
  const normalizedEntries = normalizeTranslationEntries(body?.entries, packet);
  const writeback = await writeMemoryEnvelope({
    scope: {
      owner_id: scope.owner_id || packet?.scope?.owner_id || '',
      realm_id: scope.realm_id || packet?.scope?.realm_id || 'default',
      bot_id: scope.bot_id || packet?.scope?.bot_id || ''
    },
    source: {
      kind: 'translation_packet',
      label: safeText(body?.source?.label || packet?.source?.label || packet?.packet_id || 'translation_packet')
    },
    entries: normalizedEntries
  }, {
    label: safeText(body?.source?.label || packet?.source?.label || packet?.packet_id || 'translation_packet')
  });

  return {
    ok: true,
    schema: 'hippocove_translation_apply_result_v0.1',
    scope: {
      ...scope,
      isolation_stage: 'scoped_truth'
    },
    packet_file: packetFile,
    accepted_entries: normalizedEntries.length,
    translator_contract: buildTranslatorContract(),
    writeback,
    home: writeback?.home || {},
    home_summary: writeback?.home_summary || {}
  };
}
