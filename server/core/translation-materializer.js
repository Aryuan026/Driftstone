import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { getScopedTruthDir } from './path-config.js';

function safeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unnamed';
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function previewText(text, limit = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export async function materializeTranslationPacket(packet, options = {}) {
  const generatedAt = new Date().toISOString();
  const scopeDir = getScopedTruthDir(options.owner_id, options.realm_id);
  const translationDir = join(scopeDir, 'translation_packets');
  const label = safeSegment(options.label || packet?.packet_id || `translation_${nowStamp()}`);
  const packetDir = join(translationDir, 'packets', label);
  const slicesDir = join(packetDir, 'slices');
  await mkdir(slicesDir, { recursive: true });

  const sliceRows = [];
  for (const slice of Array.isArray(packet?.slices) ? packet.slices : []) {
    const sliceId = safeSegment(slice.slice_id || `slice_${sliceRows.length + 1}`);
    const filePath = join(slicesDir, `${sliceId}.json`);
    const sliceDoc = {
      schema: 'hippocove_translation_slice_v0.1',
      generated_at: generatedAt,
      packet_id: packet.packet_id,
      slice_id: slice.slice_id,
      doc_id: slice.doc_id,
      title: slice.title || '',
      kind: slice.kind || '',
      created_at: slice.created_at || '',
      start_char: slice.start_char || 0,
      end_char: slice.end_char || 0,
      char_count: slice.char_count || 0,
      prompt_hint: slice.prompt_hint || '',
      preview: previewText(slice.text),
      text: slice.text || ''
    };
    await writeFile(filePath, `${JSON.stringify(sliceDoc, null, 2)}\n`, 'utf-8');
    sliceRows.push({
      slice_id: slice.slice_id,
      doc_id: slice.doc_id,
      title: slice.title || '',
      kind: slice.kind || '',
      created_at: slice.created_at || '',
      start_char: slice.start_char || 0,
      end_char: slice.end_char || 0,
      char_count: slice.char_count || 0,
      prompt_hint: slice.prompt_hint || '',
      preview: previewText(slice.text),
      file: filePath
    });
  }

  const packetDoc = {
    schema: 'hippocove_translation_packet_v0.1',
    generated_at: generatedAt,
    packet_id: packet.packet_id,
    ingest_packet_id: packet.ingest_packet_id,
    scope: packet.scope,
    source: packet.source,
    summary: packet.summary,
    output_contract: packet.output_contract,
    slices: sliceRows
  };

  const packetFile = join(packetDir, 'packet.json');
  await writeFile(packetFile, `${JSON.stringify(packetDoc, null, 2)}\n`, 'utf-8');
  await writeFile(join(translationDir, 'latest.json'), `${JSON.stringify({
    schema: 'hippocove_translation_latest_pointer_v0.1',
    generated_at: generatedAt,
    latest_packet: packetDir,
    scope: {
      owner_id: options.owner_id || '',
      realm_id: options.realm_id || ''
    }
  }, null, 2)}\n`, 'utf-8');

  return {
    generated_at: generatedAt,
    packet_dir: packetDir,
    packet_file: packetFile,
    slice_count: sliceRows.length,
    scope: {
      owner_id: options.owner_id || '',
      realm_id: options.realm_id || ''
    }
  };
}
