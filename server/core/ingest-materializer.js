import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { INGRESS_DIR, getScopedIngressDir } from './path-config.js';

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

function documentPreview(text, limit = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function buildPacketDoc(packet, meta = {}) {
  return {
    schema: 'hippocove_ingest_packet_v0.1',
    generated_at: meta.generated_at,
    packet_id: packet.packet_id,
    scope: packet.scope,
    source: packet.source,
    input: {
      document_count: packet.input.document_count,
      total_chars: packet.input.total_chars,
      documents: packet.input.documents
    },
    translation: packet.translation,
    writeback: packet.writeback
  };
}

export async function materializeIngressPacket(packet, options = {}) {
  const generatedAt = new Date().toISOString();
  const label = safeSegment(options.label || packet?.packet_id || `packet_${nowStamp()}`);
  const ingressDir = options.owner_id || options.realm_id
    ? getScopedIngressDir(options.owner_id, options.realm_id)
    : INGRESS_DIR;
  const packetDir = join(ingressDir, 'packets', label);
  const docsDir = join(packetDir, 'documents');
  await mkdir(docsDir, { recursive: true });

  const documents = Array.isArray(packet?.input?.documents) ? packet.input.documents : [];
  const docRows = [];
  for (const doc of documents) {
    const docId = safeSegment(doc.doc_id || doc.title || `doc_${docRows.length + 1}`);
    const filePath = join(docsDir, `${docId}.json`);
    const docRecord = {
      schema: 'hippocove_ingest_document_v0.1',
      generated_at: generatedAt,
      packet_id: packet.packet_id,
      doc_id: doc.doc_id,
      title: doc.title || '',
      kind: doc.kind || '',
      created_at: doc.created_at || '',
      char_count: doc.char_count || 0,
      preview: documentPreview(doc.text),
      meta: doc.meta || {},
      text: doc.text || ''
    };
    await writeFile(filePath, `${JSON.stringify(docRecord, null, 2)}\n`, 'utf-8');
    docRows.push({
      doc_id: doc.doc_id,
      title: doc.title || '',
      kind: doc.kind || '',
      created_at: doc.created_at || '',
      char_count: doc.char_count || 0,
      preview: documentPreview(doc.text),
      file: filePath
    });
  }

  const indexDoc = buildPacketDoc({
    ...packet,
    input: {
      ...packet.input,
      documents: docRows
    }
  }, { generated_at: generatedAt });

  const packetFile = join(packetDir, 'packet.json');
  await writeFile(packetFile, `${JSON.stringify(indexDoc, null, 2)}\n`, 'utf-8');
  await writeFile(join(ingressDir, 'latest.json'), `${JSON.stringify({
    schema: 'hippocove_ingest_latest_pointer_v0.1',
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
    document_count: docRows.length,
    scope: {
      owner_id: options.owner_id || '',
      realm_id: options.realm_id || ''
    }
  };
}
