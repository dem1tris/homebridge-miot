const { createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { TextDecoder } = require('node:util');

const MAX_MAP_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function decryptMap(encrypted, { wifiSn, ownerId, mac }, deviceId) {
  const seedCipher = createCipheriv('aes-128-ecb', Buffer.from(mac + '0v18'), null);
  const seed = Buffer.concat([seedCipher.update(`${wifiSn}+${ownerId}+${deviceId}`), seedCipher.final()]);
  const key = createHash('md5').update(seed.toString('base64')).digest();
  const cipher = createDecipheriv('aes-128-ecb', key, null);
  const hex = utf8.decode(Buffer.concat([cipher.update(encrypted), cipher.final()]));
  if (!hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('Invalid decrypted IJAI map.');
  }
  return Buffer.from(hex, 'hex');
}

function decodeIjaiV18Map(raw, metadata) {
  if (!raw?.length || raw.length > 3 * MAX_MAP_BYTES) throw new Error('Invalid IJAI map size.');
  const data = Buffer.from(raw);
  const text = data.toString('utf8').trim();
  const encrypted = /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? Buffer.from(text, 'base64') : data;
  const identity = { ...metadata, mac: String(metadata.mac || '').replace(/:/g, '').toLowerCase() };
  if (!/^[0-9a-f]{12}$/.test(identity.mac) || !identity.wifiSn || !identity.ownerId || !identity.deviceId) {
    throw new Error('Missing IJAI map identity.');
  }
  let compressed;
  try {
    compressed = decryptMap(encrypted, identity, identity.deviceId);
  } catch {
    // Some v18 firmware uploads maps encrypted with DID "0" (Map Extractor #696).
    try {
      compressed = decryptMap(encrypted, identity, '0');
    } catch {
      throw new Error('Unable to decrypt the IJAI map.');
    }
  }
  return parseIjaiRobotMap(inflateSync(compressed, { maxOutputLength: MAX_MAP_BYTES }));
}

function readVarint(data, cursor) {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (cursor.offset >= data.length) throw new Error('Truncated IJAI map field.');
    const byte = data[cursor.offset++];
    if (i === 9 && byte > 1) throw new Error('Invalid IJAI map integer.');
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (byte < 128) return value;
  }
  throw new Error('Invalid IJAI map integer.');
}

// Only the protobuf wire types used by map metadata, rooms and raster data are needed.
function* fields(data) {
  if (!Buffer.isBuffer(data)) throw new Error('Invalid IJAI map message.');
  const cursor = { offset: 0 };
  while (cursor.offset < data.length) {
    const tag = readVarint(data, cursor);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!field || field > 0x1fffffff) throw new Error('Invalid IJAI map field.');
    let value;
    if (wire === 0) {
      value = readVarint(data, cursor);
    } else {
      const length = wire === 2 ? readVarint(data, cursor) : wire === 1 ? 8n : wire === 5 ? 4n : -1n;
      if (length < 0n || length > BigInt(data.length - cursor.offset)) throw new Error('Invalid IJAI map field length.');
      value = data.subarray(cursor.offset, cursor.offset + Number(length));
      cursor.offset += Number(length);
    }
    yield [field, wire, value];
  }
}

function uint32(value) {
  if (typeof value !== 'bigint' || value > 0xffffffffn) throw new Error('Invalid IJAI map ID or timestamp.');
  return Number(value);
}

function parseIjaiRobotMap(data) {
  if (data.length > MAX_MAP_BYTES) throw new Error('IJAI map exceeds the size limit.');
  let mapId;
  let uploadedAt = null;
  const rooms = [];
  const roomIds = new Set();
  for (const [field, wire, value] of fields(data)) {
    if ([2, 3, 12].includes(field) && wire !== 2) throw new Error('Invalid IJAI map message.');
    if (field === 2 || field === 3) {
      for (const [nestedField, , nestedValue] of fields(value)) {
        if (field === 2 && nestedField === 2) uploadedAt = uint32(nestedValue);
        if (field === 3 && nestedField === 1) mapId = uint32(nestedValue);
      }
    } else if (field === 12) {
      let id;
      let name = '';
      for (const [roomField, , roomValue] of fields(value)) {
        if (roomField === 1) id = uint32(roomValue);
        if (roomField === 2) {
          if (!Buffer.isBuffer(roomValue)) throw new Error('Invalid IJAI room name.');
          name = utf8.decode(roomValue);
        }
      }
      if (!id || id > 255 || roomIds.has(id)) throw new Error('Invalid or duplicate IJAI room ID.');
      roomIds.add(id);
      rooms.push({ id: String(id), name });
    }
  }
  if (!mapId) throw new Error('Missing IJAI embedded map ID.');
  return { mapId: String(mapId), uploadedAt, rooms: rooms.map(room => ({ ...room, mapId: String(mapId) })) };
}

module.exports = { decodeIjaiV18Map, parseIjaiRobotMap };
