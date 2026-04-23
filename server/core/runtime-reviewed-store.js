import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { getScopedReviewedDir } from './path-config.js';

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

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

export async function loadLatestRuntimeReviewedPointer({ ownerId = '', realmId = '' } = {}) {
  const dir = getScopedReviewedDir(ownerId, realmId);
  return readJson(join(dir, 'latest.json'));
}

export async function loadLatestRuntimeReviewedPacket({ ownerId = '', realmId = '' } = {}) {
  const pointer = await loadLatestRuntimeReviewedPointer({ ownerId, realmId });
  const packetFile = join(pointer.latest_packet, 'packet.json');
  const packet = await readJson(packetFile);
  return { pointer, packetFile, packet };
}

export async function ensureRuntimeReviewedPacket({
  ownerId = '',
  realmId = '',
  scope = {},
  label = ''
} = {}) {
  try {
    const loaded = await loadLatestRuntimeReviewedPacket({ ownerId, realmId });
    if (!loaded?.packet?.finalized_at) {
      return loaded;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const dir = getScopedReviewedDir(ownerId, realmId);
  const packetDir = join(dir, 'packets', safeSegment(label || `reviewed_${nowStamp()}`));
  await mkdir(packetDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const packet = {
    schema: 'hippocove_runtime_reviewed_packet_v0.1',
    generated_at: generatedAt,
    updated_at: generatedAt,
    finalized_at: '',
    scope: {
      owner_id: String(scope?.owner_id || ownerId || '').trim(),
      realm_id: String(scope?.realm_id || realmId || '').trim(),
      bot_id: String(scope?.bot_id || '').trim()
    },
    source: {
      label: String(label || '').trim()
    },
    summary: {
      append_count: 0,
      item_count: 0,
      cluster_count: 0,
      ambiguous_cluster_count: 0,
      merged_entry_count: 0
    },
    tasks: [],
    items: [],
    finalized_entries: []
  };

  const packetFile = join(packetDir, 'packet.json');
  await writeFile(packetFile, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
  await writeFile(join(dir, 'latest.json'), `${JSON.stringify({
    schema: 'hippocove_runtime_reviewed_latest_pointer_v0.1',
    generated_at: generatedAt,
    latest_packet: packetDir,
    scope: packet.scope
  }, null, 2)}\n`, 'utf-8');

  return {
    pointer: {
      generated_at: generatedAt,
      latest_packet: packetDir,
      scope: packet.scope
    },
    packetFile,
    packet
  };
}

export async function saveRuntimeReviewedPacket(packetFile, packet = {}) {
  await writeFile(packetFile, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
  return packet;
}
