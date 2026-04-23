import { readFile } from 'fs/promises';
import { join } from 'path';
import { getScopedTranslationDir } from './path-config.js';

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

export async function loadTranslationPacketByFile(packetFile) {
  return readJson(packetFile);
}

export async function loadLatestTranslationPointer({ ownerId = '', realmId = '' } = {}) {
  const translationDir = getScopedTranslationDir(ownerId, realmId);
  const latestFile = join(translationDir, 'latest.json');
  return readJson(latestFile);
}

export async function loadLatestTranslationPacket({ ownerId = '', realmId = '' } = {}) {
  const pointer = await loadLatestTranslationPointer({ ownerId, realmId });
  const packetFile = join(pointer.latest_packet, 'packet.json');
  const packet = await loadTranslationPacketByFile(packetFile);
  return {
    pointer,
    packetFile,
    packet
  };
}
