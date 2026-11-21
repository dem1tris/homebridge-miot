const { createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { TextDecoder } = require('node:util');

const MAX_MAP_BYTES = 16 * 1024 * 1024;
const MAX_CIPHER_BYTES = 2 * MAX_MAP_BYTES + 128 * 1024;
const MAX_BASE64_BYTES = 4 * Math.ceil(MAX_CIPHER_BYTES / 3);
const MAX_FIELDS = 100000;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function asBytes(value) {
  if (!(value instanceof Uint8Array)) {
    throw new Error('IJAI map input must contain bytes.');
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function strictBase64(value) {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function ciphertext(raw) {
  let result;
  if (typeof raw === 'string') {
    if (raw.length > MAX_BASE64_BYTES) throw new Error('IJAI map input exceeds the size limit.');
    result = strictBase64(raw);
    if (!result) throw new Error('IJAI map text must use strict Base64.');
  } else {
    const data = asBytes(raw);
    if (data.length > MAX_BASE64_BYTES) throw new Error('IJAI map input exceeds the size limit.');
    result = strictBase64(data.toString('latin1')) || data;
  }
  if (result.length > MAX_CIPHER_BYTES) throw new Error('IJAI map ciphertext exceeds the size limit.');
  if (!result.length || result.length % 16 !== 0) throw new Error('IJAI map ciphertext has an invalid block length.');
  return result;
}

function keyInput(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !value.length || value.length > 256 || value.includes('+')) {
    throw new Error('Missing or invalid IJAI map key metadata.');
  }
  return value;
}

function mapKey({ wifiSn, ownerId, mac }, deviceId) {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(mac + '0v18'), null);
  const seed = Buffer.concat([cipher.update(`${wifiSn}+${ownerId}+${deviceId}`, 'utf8'), cipher.final()]);
  return createHash('md5').update(seed.toString('base64'), 'utf8').digest();
}

function decryptHex(data, metadata, deviceId) {
  const decipher = createDecipheriv('aes-128-ecb', mapKey(metadata, deviceId), null);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  const hex = utf8.decode(plaintext);
  if (!hex.length || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Invalid decrypted IJAI map hex.');
  }
  return Buffer.from(hex, 'hex');
}

function decodeIjaiV18Map(raw, options = {}) {
  const metadata = {
    wifiSn: keyInput(options?.wifiSn),
    ownerId: keyInput(options?.ownerId),
    deviceId: keyInput(options?.deviceId)
  };
  if (typeof options.mac !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$|^[0-9a-f]{12}$/i.test(options.mac)) {
    throw new Error('Missing or invalid IJAI map MAC metadata.');
  }
  metadata.mac = options.mac.replace(/:/g, '').toLowerCase();
  const encrypted = ciphertext(raw);
  let compressed;
  try {
    compressed = decryptHex(encrypted, metadata, metadata.deviceId);
  } catch {
    // v18 firmware also uploads maps encrypted with DID "0" (Map Extractor issue #696).
    try {
      compressed = decryptHex(encrypted, metadata, '0');
    } catch {
      throw new Error('Unable to decrypt the IJAI v18 map.');
    }
  }

  let protobuf;
  try {
    const inflated = inflateSync(compressed, { maxOutputLength: MAX_MAP_BYTES, info: true });
    if (inflated.engine.bytesWritten !== compressed.length) {
      throw new Error('Trailing compressed IJAI map data.');
    }
    protobuf = inflated.buffer;
  } catch {
    throw new Error('Unable to inflate the IJAI map within the size limit.');
  }
  return parseIjaiRobotMap(protobuf);
}

function readVarint(data, position) {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (position.offset >= data.length) throw new Error('Truncated IJAI protobuf varint.');
    const byte = data[position.offset++];
    if (i === 9 && byte > 1) throw new Error('IJAI protobuf varint exceeds uint64.');
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (byte < 128) {
      if (i > 0 && byte === 0) throw new Error('Noncanonical IJAI protobuf varint.');
      return value;
    }
  }
  throw new Error('IJAI protobuf varint exceeds its byte limit.');
}

function visitFields(data, budget, visit) {
  const position = { offset: 0 };
  while (position.offset < data.length) {
    if (++budget.fields > MAX_FIELDS) throw new Error('IJAI protobuf exceeds the field count limit.');
    const tag = readVarint(data, position);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field < 1 || field > 0x1fffffff) throw new Error('Invalid IJAI protobuf field number.');
    let value;
    if (wire === 0) {
      value = readVarint(data, position);
    } else {
      let length;
      if (wire === 2) length = readVarint(data, position);
      else if (wire === 1) length = 8n;
      else if (wire === 5) length = 4n;
      else throw new Error('Unsupported IJAI protobuf wire type.');
      if (length > BigInt(data.length - position.offset)) throw new Error('Truncated IJAI protobuf field.');
      const end = position.offset + Number(length);
      value = data.subarray(position.offset, end);
      position.offset = end;
    }
    visit(field, wire, value);
  }
}

function uint32(wire, value) {
  if (wire !== 0 || value > 0xffffffffn) throw new Error('Invalid IJAI protobuf uint32 field.');
  return Number(value);
}

function message(wire, value) {
  if (wire !== 2) throw new Error('Invalid IJAI protobuf message field.');
  return value;
}

function uniqueField(seen, field) {
  if (seen.has(field)) throw new Error('Duplicate IJAI protobuf metadata field.');
  seen.add(field);
}

function parseRoom(data, budget) {
  let id;
  let name = '';
  const seen = new Set();
  visitFields(data, budget, (field, wire, value) => {
    if (field === 1) {
      uniqueField(seen, field);
      id = uint32(wire, value);
    } else if (field === 2) {
      uniqueField(seen, field);
      name = utf8.decode(message(wire, value));
    }
  });
  if (id === undefined || id < 1 || id > 255) throw new Error('Invalid IJAI map room ID.');
  return { id: String(id), name };
}

function parseIjaiRobotMap(raw) {
  const data = asBytes(raw);
  if (data.length > MAX_MAP_BYTES) throw new Error('IJAI map exceeds the size limit.');
  const budget = { fields: 0 };
  const seen = new Set();
  const roomIds = new Set();
  const rooms = [];
  let mapId;
  let uploadedAt = null;

  visitFields(data, budget, (field, wire, value) => {
    if (field === 2 || field === 3) {
      uniqueField(seen, field);
      const nestedSeen = new Set();
      visitFields(message(wire, value), budget, (nestedField, nestedWire, nestedValue) => {
        if (field === 3 && nestedField === 1) {
          uniqueField(nestedSeen, nestedField);
          mapId = uint32(nestedWire, nestedValue);
        } else if (field === 2 && nestedField === 2) {
          uniqueField(nestedSeen, nestedField);
          uploadedAt = uint32(nestedWire, nestedValue);
        }
      });
    } else if (field === 12) {
      if (rooms.length >= 255) throw new Error('IJAI map exceeds the room count limit.');
      const room = parseRoom(message(wire, value), budget);
      if (roomIds.has(room.id)) throw new Error('Duplicate IJAI map room ID.');
      roomIds.add(room.id);
      rooms.push(room);
    }
  });
  if (mapId === undefined || mapId === 0) throw new Error('Missing or invalid IJAI embedded map ID.');
  const mapKey = String(mapId);
  return { mapId: mapKey, uploadedAt, rooms: rooms.map(room => ({ ...room, mapId: mapKey })) };
}

module.exports = { decodeIjaiV18Map, parseIjaiRobotMap };
