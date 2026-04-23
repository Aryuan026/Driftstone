import { readFile } from 'fs/promises';
import { join } from 'path';
import { getScopedIngressDir } from './path-config.js';

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

export async function loadLatestIngressPointer({ ownerId = '', realmId = '' } = {}) {
  const ingressDir = getScopedIngressDir(ownerId, realmId);
  const latestFile = join(ingressDir, 'latest.json');
  return readJson(latestFile);
}

export async function loadIngressPacketByFile(packetFile) {
  return readJson(packetFile);
}

export async function loadLatestIngressPacket({ ownerId = '', realmId = '' } = {}) {
  const pointer = await loadLatestIngressPointer({ ownerId, realmId });
  const packetFile = join(pointer.latest_packet, 'packet.json');
  const packet = await loadIngressPacketByFile(packetFile);
  return {
    pointer,
    packetFile,
    packet
  };
}
