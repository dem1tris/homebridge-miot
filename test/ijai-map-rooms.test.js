const assert = require('node:assert/strict');
const test = require('node:test');
const { createCipheriv, createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { decodeIjaiV18Map, parseIjaiRobotMap } = require('../lib/modules/robotcleaner/devices/IjaiMapDecoder.js');
const { getIjaiRooms } = require('../lib/modules/robotcleaner/devices/IjaiCloudRooms.js');

const identity = { wifiSn: '12345/ABCDEFGHIJKL', ownerId: '200', deviceId: '300', mac: 'AA:BB:CC:DD:EE:FF' };
function varint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  while (remaining >= 128n) {
    bytes.push(Number(remaining & 127n) | 128);
    remaining >>= 7n;
  }
  return Buffer.from([...bytes, Number(remaining)]);
}
const integer = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field, value) => Buffer.concat([varint(field * 8 + 2), varint(Buffer.byteLength(value)), Buffer.from(value)]);
function map(rooms = [[10, 'Kitchen']], mapId = 42, uploadedAt = 7) {
  return Buffer.concat([
    bytes(3, integer(1, mapId)), ...(uploadedAt === null ? [] : [bytes(2, integer(2, uploadedAt))]),
    ...rooms.map(([id, name]) => bytes(12, Buffer.concat([integer(1, id), bytes(2, name)])))
  ]);
}
function encrypt(data, metadata = identity) {
  const seedCipher = createCipheriv('aes-128-ecb', Buffer.from('aabbccddeeff0v18'), null);
  const seed = Buffer.concat([seedCipher.update(`${metadata.wifiSn}+${metadata.ownerId}+${metadata.deviceId}`), seedCipher.final()]);
  const key = createHash('md5').update(seed.toString('base64')).digest();
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(deflateSync(data).toString('hex')), cipher.final()]);
}

test('decodes an independent AES vector and the documented zero-DID map variant', () => {
  // Produced independently with OpenSSL AES-128-ECB, Python MD5 and zlib.
  const vector = 'a98V0CYy7Cg5vEwrQ672Q94dDs6Z3r3jmeYopCSEdS5pd9Oku1xMDs5iFuV45OgYnTuabUxacFjiAj6z9hLDMg==';
  const expected = { mapId: '42', uploadedAt: 7, rooms: [{ id: '10', name: 'Kitchen', mapId: '42' }] };
  assert.deepEqual(decodeIjaiV18Map(vector, { ...identity, wifiSn: 'SYNTHETIC-SN' }), expected);
  const raw = encrypt(map(), { ...identity, deviceId: '0' });
  for (const input of [raw, raw.toString('base64'), Buffer.from(raw.toString('base64'))]) {
    assert.deepEqual(decodeIjaiV18Map(input, identity), expected);
  }
});

test('reads named rooms while ignoring unrelated raster fields', () => {
  const unknown = Buffer.concat([integer(100, 0xffffffffffffffffn), bytes(101, 'raster'), varint(102 * 8 + 5), Buffer.alloc(4)]);
  const decoded = parseIjaiRobotMap(Buffer.concat([unknown, map([[10, 'Комната А'], [12, 'Комната Б']])]));
  assert.deepEqual(decoded.rooms.map(({ id, name }) => [id, name]), [['10', 'Комната А'], ['12', 'Комната Б']]);
  assert.deepEqual(parseIjaiRobotMap(map([])).rooms, []);
});

test('rejects truncated, oversized and invalid map data', () => {
  const valid = map();
  for (const bad of [valid.subarray(0, valid.length - 1), map([], 0), map([[0, 'bad']]), map([[256, 'bad']]), map([[10, 'a'], [10, 'b']]), Buffer.from([0x80])]) {
    assert.throws(() => parseIjaiRobotMap(bad));
  }
  assert.throws(() => parseIjaiRobotMap(Buffer.alloc(16 * 1024 * 1024 + 1)), /large|limit/i);
  assert.throws(() => decodeIjaiV18Map(encrypt(Buffer.alloc(16 * 1024 * 1024 + 1)), identity));
  assert.throws(() => decodeIjaiV18Map(encrypt(valid), { ...identity, ownerId: 'wrong' }));
});

function fixture() {
  const state = { mapId: '42', slots: [encrypt(map([[10, 'Old']], 42, 1)), encrypt(map([[10, 'Kitchen'], [12, 'Bedroom']], 42, 2))], requests: [] };
  const cloud = {
    getServiceToken: () => ({ userId: '100' }),
    getInterimFile: async (objectName, pro = false) => {
      state.requests.push([objectName, pro]);
      return state.slots[Number(objectName.at(-1))];
    }
  };
  const readLocal = async (method, params) => {
    if (method === 'miIO.info') return { mac: identity.mac };
    assert.equal(method, 'get_properties');
    return params.map(property => ({ ...property, code: 0, value: property.siid === 10 ? state.mapId
      : property.siid === 7 ? `[0,"${identity.wifiSn};${identity.ownerId}"]`
      : property.piid === 5 ? identity.wifiSn : '' }));
  };
  return { state, cloud, readLocal, discover: () => getIjaiRooms(cloud, identity.deviceId, readLocal, '42') };
}

test('uses the standard downloader and newest active map, with login and owner IDs kept distinct', async () => {
  const { state, discover } = fixture();
  assert.deepEqual((await discover()).map(room => room.name), ['Kitchen', 'Bedroom']);
  assert.deepEqual(state.requests, [['100/300/0', true], ['100/300/1', true]]);
  state.slots[1] = encrypt(map([], 42, 3));
  assert.deepEqual(await discover(), [], 'a newer empty roster must not restore old rooms');
  state.slots[1] = encrypt(map([[20, 'Other floor']], 43, 4));
  assert.deepEqual((await discover()).map(room => room.name), ['Old']);
  state.slots[1] = encrypt(map([[10, 'Undated']], 42, null));
  await assert.rejects(discover(), /conflict/i, 'an undated conflicting roster cannot establish freshness');
});

test('falls back to the plain file endpoint and can skip a damaged rotating slot', async () => {
  const { state, cloud, discover } = fixture();
  const download = cloud.getInterimFile;
  cloud.getInterimFile = async (name, pro) => {
    if (pro) throw new Error('pro endpoint unavailable');
    return download(name, pro);
  };
  state.slots[0] = Buffer.from('invalid');
  assert.deepEqual((await discover()).map(room => room.name), ['Kitchen', 'Bedroom']);
  assert.ok(state.requests.every(([, pro]) => pro === false));
  state.slots[1] = Buffer.from('invalid');
  await assert.rejects(discover(), /map/i);
});

test('rejects conflicting uploads and an active map change during download', async () => {
  const { state, cloud, discover } = fixture();
  state.slots[0] = encrypt(map([[10, 'Conflicting']], 42, 2));
  await assert.rejects(discover(), /conflict/i);
  state.slots[0] = encrypt(map([[10, 'Old']], 42, 1));
  const download = cloud.getInterimFile;
  cloud.getInterimFile = async (...args) => {
    const result = await download(...args);
    state.mapId = '43';
    return result;
  };
  await assert.rejects(discover(), /map.*changed|active map/i);
});
