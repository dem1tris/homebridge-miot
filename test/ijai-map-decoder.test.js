const assert = require('node:assert/strict');
const test = require('node:test');
const { createCipheriv, createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { decodeIjaiV18Map, parseIjaiRobotMap } = require('../lib/modules/robotcleaner/devices/IjaiMapDecoder.js');

const metadata = { wifiSn: 'SYNTHETIC-SN', ownerId: '200', deviceId: '300', mac: 'AA:BB:CC:DD:EE:FF' };
const maxMapBytes = 16 * 1024 * 1024;

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  while (remaining >= 128n) {
    bytes.push(Number(remaining & 127n) | 128);
    remaining >>= 7n;
  }
  return Buffer.from([...bytes, Number(remaining)]);
}

function integer(field, value) {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function bytes(field, value) {
  const content = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(content.length), content]);
}

function room(id, name) {
  return bytes(12, Buffer.concat([integer(1, id), bytes(2, Buffer.from(name))]));
}

function map(rooms = [], mapId = 42, uploadedAt = 7) {
  return Buffer.concat([
    bytes(3, integer(1, mapId)),
    bytes(2, integer(2, uploadedAt)),
    ...rooms
  ]);
}

function encryptText(text, deviceId = metadata.deviceId) {
  const seedCipher = createCipheriv('aes-128-ecb', Buffer.from('aabbccddeeff0v18'), null);
  const seed = Buffer.concat([seedCipher.update(`${metadata.wifiSn}+${metadata.ownerId}+${deviceId}`, 'utf8'), seedCipher.final()]);
  const key = createHash('md5').update(seed.toString('base64')).digest();
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(text), cipher.final()]);
}

function encryptMap(protobuf, deviceId) {
  return encryptText(Buffer.from(deflateSync(protobuf).toString('hex')), deviceId);
}

test('IJAI protobuf returns every named room from the embedded map', () => {
  const data = map([room(10, 'Комната А'), room(11, 'Комната Б'), room(13, 'Комната В'), room(12, 'Комната Г')], 424242, 1700000000);
  assert.deepEqual(parseIjaiRobotMap(data), {
    mapId: '424242',
    uploadedAt: 1700000000,
    rooms: [
      { id: '10', name: 'Комната А', mapId: '424242' },
      { id: '11', name: 'Комната Б', mapId: '424242' },
      { id: '13', name: 'Комната В', mapId: '424242' },
      { id: '12', name: 'Комната Г', mapId: '424242' }
    ]
  });
});

test('IJAI decoder matches a fixed OpenSSL AES vector with synthetic metadata', () => {
  // Generated independently with openssl enc AES-128-ECB/PKCS7, Python MD5 and zlib.
  const raw = 'a98V0CYy7Cg5vEwrQ672Q94dDs6Z3r3jmeYopCSEdS5pd9Oku1xMDs5iFuV45OgYnTuabUxacFjiAj6z9hLDMg==';
  assert.deepEqual(decodeIjaiV18Map(raw, metadata), {
    mapId: '42', uploadedAt: 7, rooms: [{ id: '10', name: 'Kitchen', mapId: '42' }]
  });
});

test('IJAI decoder accepts raw ciphertext and strict base64 bytes', () => {
  const raw = encryptMap(map([room(10, 'Комната А'), room(11, 'Комната Б')]));
  for (const input of [raw, new Uint8Array(raw), raw.toString('base64'), Buffer.from(raw.toString('base64'))]) {
    assert.deepEqual(decodeIjaiV18Map(input, metadata).rooms.map(({ id, name }) => [id, name]), [
      ['10', 'Комната А'], ['11', 'Комната Б']
    ]);
  }
});

test('IJAI decoder accepts a large base64 map raster within its input budget', () => {
  const raster = Buffer.alloc(2000000);
  let state = 42;
  for (let i = 0; i < raster.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    raster[i] = state & 255;
  }
  const raw = encryptMap(Buffer.concat([map(), bytes(4, raster)]));
  assert.deepEqual(decodeIjaiV18Map(raw.toString('base64'), metadata).rooms, []);
});

test('IJAI v18 uses the documented zero DID decryption fallback', () => {
  assert.deepEqual(decodeIjaiV18Map(encryptMap(map(), '0'), metadata), {
    mapId: '42', uploadedAt: 7, rooms: []
  });
});

test('IJAI protobuf preserves an empty roster and distinguishes an absent timestamp', () => {
  assert.deepEqual(parseIjaiRobotMap(bytes(3, integer(1, 42))), { mapId: '42', uploadedAt: null, rooms: [] });
  assert.equal(parseIjaiRobotMap(map([], 42, 0)).uploadedAt, 0);
});

test('IJAI protobuf skips valid unknown wire fields', () => {
  const unknown = Buffer.concat([
    integer(100, 0xffffffffffffffffn),
    varint(101 * 8 + 1), Buffer.alloc(8),
    bytes(102, Buffer.from('opaque map raster')),
    varint(103 * 8 + 5), Buffer.alloc(4)
  ]);
  const data = Buffer.concat([unknown, map([bytes(12, Buffer.concat([integer(1, 10), unknown]))])]);
  assert.deepEqual(parseIjaiRobotMap(data).rooms, [{ id: '10', name: '', mapId: '42' }]);
});

test('IJAI protobuf rejects invalid or duplicate map metadata', () => {
  for (const data of [
    Buffer.alloc(0), map([], 0), map([], 0x100000000n),
    Buffer.concat([map(), bytes(3, integer(1, 43))]),
    bytes(3, Buffer.concat([integer(1, 42), integer(1, 43)])),
    Buffer.concat([map(), bytes(2, integer(2, 8))]),
    Buffer.concat([bytes(3, integer(1, 42)), bytes(2, Buffer.concat([integer(2, 7), integer(2, 8)]))])
  ]) assert.throws(() => parseIjaiRobotMap(data));
});

test('IJAI protobuf rejects invalid and duplicate rooms', () => {
  for (const rooms of [
    [room(0, 'zero')], [room(256, 'overflow')], [bytes(12, bytes(2, Buffer.from('missing ID')))],
    [room(10, 'a'), room(10, 'b')],
    [bytes(12, Buffer.concat([integer(1, 10), integer(1, 11)]))],
    [bytes(12, Buffer.concat([integer(1, 10), bytes(2, Buffer.from('a')), bytes(2, Buffer.from('b'))]))]
  ]) assert.throws(() => parseIjaiRobotMap(map(rooms)));
});

test('IJAI protobuf rejects invalid UTF-8 names', () => {
  assert.throws(() => parseIjaiRobotMap(map([bytes(12, Buffer.concat([integer(1, 10), bytes(2, [0xc3, 0x28])]))])));
});

test('IJAI protobuf rejects malformed tags, types, lengths and varints', () => {
  for (const bad of [
    [0], [0x80], [0x08, ...Array(11).fill(0xff)], [0x08, ...Array(9).fill(0xff), 2],
    [0x08, 0x80, 0], [0x0b], [0x0f], [0x09, 0], [0x0d, 0], [0x0a, 2, 0],
    [0x18, 42], [0x1a, 2, 0x0a, 0], [0x62, 2, 0x0a, 0]
  ]) assert.throws(() => parseIjaiRobotMap(Buffer.concat([map(), Buffer.from(bad)])));
});

test('IJAI protobuf rejects truncated messages', () => {
  const data = map([room(10, 'Комната А')]);
  assert.throws(() => parseIjaiRobotMap(data.subarray(0, data.length - 1)));
});

test('IJAI protobuf bounds input bytes and total field count', () => {
  assert.throws(() => parseIjaiRobotMap(Buffer.alloc(maxMapBytes + 1)), /limit|large/i);
  const manyFields = Buffer.concat([map(), Buffer.alloc(200002, 0x08)]);
  assert.throws(() => parseIjaiRobotMap(manyFields), /limit|fields/i);
});

test('IJAI decoder rejects wrong keys without exposing key metadata', () => {
  const raw = encryptMap(map());
  assert.throws(() => decodeIjaiV18Map(raw, { ...metadata, ownerId: 'wrong-owner-secret' }), err => {
    assert.doesNotMatch(err.message, /SYNTHETIC|wrong-owner|AA:BB/);
    return true;
  });
});

test('IJAI decoder rejects malformed base64, ciphertext and decrypted hex', () => {
  for (const raw of ['', 'YWJj===', 'YW Jj', 'YR==', Buffer.alloc(15), encryptText(Buffer.from('deadbeefz0')), encryptText(Buffer.from([0xc3, 0x28]))]) {
    assert.throws(() => decodeIjaiV18Map(raw, metadata));
  }
});

test('IJAI decoder bounds inflation and compressed input size', () => {
  assert.throws(() => decodeIjaiV18Map(encryptMap(Buffer.alloc(maxMapBytes + 1)), metadata), /limit|large|inflate/i);
  assert.throws(() => decodeIjaiV18Map(Buffer.alloc(2 * maxMapBytes + 128 * 1024 + 1), metadata), /limit|large/i);
});

test('IJAI decoder rejects truncated and trailing compressed data', () => {
  const compressed = deflateSync(map());
  for (const malformed of [compressed.subarray(0, compressed.length - 1), Buffer.concat([compressed, Buffer.from([1, 2])])]) {
    assert.throws(() => decodeIjaiV18Map(encryptText(Buffer.from(malformed.toString('hex'))), metadata));
  }
});

test('IJAI protobuf accepts every available room ID exactly once', () => {
  const rooms = Array.from({ length: 255 }, (_, i) => room(i + 1, ''));
  assert.equal(parseIjaiRobotMap(map(rooms)).rooms.length, 255);
  assert.throws(() => parseIjaiRobotMap(map([...rooms, room(1, '')])), /limit|duplicate/i);
});

test('IJAI decoder rejects missing or invalid key inputs', () => {
  for (const options of [undefined, {}, { ...metadata, wifiSn: '' }, { ...metadata, mac: 'invalid' }, { ...metadata, deviceId: {} }]) {
    assert.throws(() => decodeIjaiV18Map(encryptMap(map()), options));
  }
});
