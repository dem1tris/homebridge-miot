const assert = require('node:assert/strict');
const test = require('node:test');
const IjaiCloudRooms = require('../lib/modules/robotcleaner/devices/IjaiCloudRooms.js');

const DID = '123456789';
const LOGIN_UID = '111222333';
const OWNER_UID = '777888999';
const MAP = '424242';
const WIFI_SN = '12345/ABCDEFGHIJKL';
const MAC = 'AA:BB:CC:DD:EE:FF';
const MAX_BYTES = 5 * 1024 * 1024;
const PRO = '/v2/home/get_interim_file_url_pro';
const PLAIN = '/v2/home/get_interim_file_url';
const credentials = () => ({
  country: 'cn', deviceId: DID,
  session: { ssecurity: 'private-security', userId: LOGIN_UID, serviceToken: 'private-token' }
});
const rooms = (...names) => names.map((name, i) => ({ id: String(i + 10), name, mapId: MAP }));
const snapshot = (uploadedAt, names = ['Kitchen'], mapId = MAP) => ({ mapId, uploadedAt, rooms: rooms(...names).map(room => ({ ...room, mapId })) });
const url = slot => `https://cnbj1.fds.api.xiaomi.com/maps/slot${slot}?private-signature=value`;

function response({ status = 200, location, length, data = Buffer.from('0') } = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: name => name === 'location' ? location ?? null : name === 'content-length' ? length ?? null : null },
    buffer: async () => data,
    body: { destroy() {} }
  };
}

function setup(overrides = {}) {
  const state = { credentials: credentials(), mapId: MAP, owner: OWNER_UID, wifi: WIFI_SN, serialFallback: 'invalid', agentDestroyed: 0, cloudRequests: [], downloads: [], reads: [], sessions: [], decoded: [] };
  const maps = [snapshot(100, ['Old']), snapshot(200, ['Kitchen', 'Bedroom'])];
  const cloud = {
    setServiceToken: session => state.sessions.push(session),
    setCountry: country => { state.country = country; },
    setRequestTimeout: timeout => { state.cloudTimeout = timeout; },
    request: async (route, data) => {
      state.guard(route, data);
      state.cloudRequests.push([route, data]);
      return { code: 0, result: { url: url(data.obj_name.at(-1)) } };
    }
  };
  const readLocal = async (method, params) => {
    state.reads.push([method, params]);
    if (method === 'miIO.info') return { mac: MAC, model: 'ijai.vacuum.v18' };
    assert.equal(method, 'get_properties');
    return params.map(prop => ({ ...prop, code: 0, value: prop.siid === 10 ? state.mapId
      : prop.siid === 7 ? `[0,"${WIFI_SN};${state.owner}"]`
      : prop.piid === 5 ? state.wifi : state.serialFallback }));
  };
  const dependencies = {
    createRequestAgent: async country => { state.agentCountry = country; return { destroy() { state.agentDestroyed++; } }; },
    createCloud: (logger, guard, options) => { state.requestAgent = options?.requestAgent; state.guard = guard; state.logger = logger; return cloud; },
    fetch: async (value, options) => {
      state.downloads.push([value, options]);
      return response({ data: Buffer.from(value.includes('slot1') ? '1' : '0') });
    },
    decode: (data, identity) => { state.decoded.push(identity); return maps[Number(data.toString())]; },
    ...overrides.dependencies
  };
  const client = new IjaiCloudRooms({ deviceId: DID,
    readCredentials: overrides.readCredentials || (async () => state.credentials),
    readLocal: overrides.readLocal || readLocal, dependencies });
  return { client, state, cloud, maps, dependencies, readLocal };
}

test('map discovery requires a credentials provider', () => {
  assert.throws(() => new IjaiCloudRooms({ deviceId: DID, readLocal: async () => {} }), /credentials.*provider/i);
});

test('fresh cloud slots select the newest active map and distinguish login UID from owner UID', async () => {
  const { client, state } = setup();
  assert.deepEqual(await client.getRooms(MAP), rooms('Kitchen', 'Bedroom'));
  assert.deepEqual(state.cloudRequests.map(([, data]) => data.obj_name), [`${LOGIN_UID}/${DID}/0`, `${LOGIN_UID}/${DID}/1`]);
  assert.ok(state.decoded.every(identity => identity.ownerId === OWNER_UID && identity.deviceId === DID && identity.wifiSn === WIFI_SN && identity.mac === MAC));
  assert.equal(state.country, 'cn');
  assert.equal(state.cloudTimeout, 10000);
  assert.ok(state.reads.every(([method]) => ['miIO.info', 'get_properties'].includes(method)));
  assert.ok(state.reads.filter(([method, params]) => method === 'get_properties' && params.some(p => p.siid === 10 && p.piid === 2)).length >= 2);
});

test('the map reader reloads the session and refreshes both signed URLs on every fetch', async () => {
  const { client, state } = setup();
  await client.getRooms(MAP);
  state.credentials.session.serviceToken = 'new-private-token';
  await client.getRooms(MAP);
  assert.equal(state.sessions.length, 2);
  assert.equal(state.sessions[1].serviceToken, 'new-private-token');
  assert.equal(state.cloudRequests.length, 4);
});

test('credentials are bound to the configured robot before any local or cloud read', async () => {
  const { client, state } = setup();
  state.credentials.deviceId = '999';
  await assert.rejects(client.getRooms(MAP), /credentials.*device|device.*credentials/i);
  assert.equal(state.cloudRequests.length, 0);
  assert.equal(state.reads.length, 0);
});

test('credentials provider failures and incomplete sessions are private and stop discovery', async () => {
  const providers = [
    async () => { throw Error('private-security details'); },
    async () => ({ ...credentials(), country: 'unknown' }),
    async () => ({ ...credentials(), session: { userId: LOGIN_UID, ssecurity: 'private-security' } })
  ];
  for (const readCredentials of providers) {
    const { client, state } = setup({ readCredentials });
    await assert.rejects(client.getRooms(MAP), error =>
      error.code === 'XIAOMI_MAP_CREDENTIALS' && !/private-security/.test(error.message));
    assert.deepEqual(state.reads, []);
    assert.deepEqual(state.cloudRequests, []);
  }
});

test('the cloud instance permits only exact map URL reads for its two device slots', async () => {
  const { client, state } = setup();
  await client.getRooms(MAP);
  state.guard(PRO, { obj_name: `${LOGIN_UID}/${DID}/0` });
  state.guard(PLAIN, { obj_name: `${LOGIN_UID}/${DID}/1` });
  for (const [route, data] of [
    ['/miotspec/action', { params: { did: DID, siid: 2, aiid: 1 } }],
    [`/home/rpc/${DID}`, { method: 'app_find' }],
    [PRO, { obj_name: `${OWNER_UID}/${DID}/0` }],
    [PRO, { obj_name: `${LOGIN_UID}/${DID}/2` }],
    [PRO, { obj_name: `${LOGIN_UID}/999/0` }],
    [PRO, { obj_name: `${LOGIN_UID}/${DID}/0`, extra: true }]
  ]) assert.throws(() => state.guard(route, data), /not allowed|denied/i);
});

test('plain URL endpoint is a bounded fallback when pro has no URL or a transport failure', async () => {
  for (const failure of [() => ({ code: -6 }), () => { throw Error('HTTP 503 private-security'); }]) {
    const { client, cloud, state } = setup();
    cloud.request = async (route, data) => {
      state.guard(route, data); state.cloudRequests.push([route, data]);
      if (route === PRO) return failure();
      return { code: 0, result: { url: url(data.obj_name.at(-1)) } };
    };
    assert.equal((await client.getRooms(MAP)).length, 2);
    assert.equal(state.cloudRequests.filter(([route]) => route === PLAIN).length, 2);
  }
});

test('expired cloud authentication fails explicitly without retry login or endpoint fallback', async () => {
  for (const failure of [() => ({ code: 401, message: 'expired token private-token' }), () => { throw Error('Request error with status 403 Forbidden'); }]) {
    const { client, cloud, state } = setup();
    cloud.request = async (route, data) => { state.cloudRequests.push([route, data]); return failure(); };
    await assert.rejects(client.getRooms(MAP), error => error.code === 'XIAOMI_MAP_AUTH_REQUIRED' && !/private-token/.test(error.message));
    assert.ok(state.cloudRequests.every(([route]) => route === PRO));
  }
});

test('download follows validated relative and cross-region FDS redirects without cookies', async () => {
  const { client, state, dependencies } = setup();
  let request = 0;
  dependencies.fetch = async (value, options) => {
    state.downloads.push([value, options]);
    request++;
    if (value.includes('slot0')) return response({ status: 302, location: '/maps/redirected' });
    if (value.includes('redirected')) return response({ status: 307, location: 'https://awsde0.fds.api.xiaomi.com/maps/final' });
    return response({ data: Buffer.from(value.includes('slot1') ? '1' : '0') });
  };
  assert.equal((await client.getRooms(MAP)).length, 2);
  assert.equal(request, 4);
  for (const [, options] of state.downloads) {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.timeout, 15000);
    assert.equal(options.size, MAX_BYTES);
    assert.ok(!options.headers?.Cookie && !options.headers?.cookie && !options.headers?.Authorization);
  }
});

test('all signed URL and redirect hops reject foreign hosts, credentials, IP literals and cleartext', async () => {
  for (const forbidden of ['http://cnbj1.fds.api.xiaomi.com/maps/map', 'https://127.0.0.1/map',
    'https://192.0.2.18/map', 'https://evil.test/map', 'https://cnbj1.fds.api.xiaomi.com.evil.test/map',
    'https://user:password@cnbj1.fds.api.xiaomi.com/map', 'https://cnbj1.fds.api.xiaomi.com:8443/map']) {
    const direct = setup();
    direct.cloud.request = async () => ({ code: 0, result: { url: forbidden } });
    await assert.rejects(direct.client.getRooms(MAP), /map.*unavailable|map.*download|allowed.*host|map.*source/i);
    assert.equal(direct.state.downloads.length, 0);
    const redirected = setup({ dependencies: { fetch: async () => response({ status: 302, location: forbidden }) } });
    await assert.rejects(redirected.client.getRooms(MAP), /map.*unavailable|map.*download|allowed.*host|map.*source/i);
  }
});

test('redirect loops stop after at most five validated redirects per slot', async () => {
  let calls = 0;
  const { client } = setup({ dependencies: { fetch: async () => { calls++; return response({ status: 302, location: '/loop' }); } } });
  await assert.rejects(client.getRooms(MAP), /map.*unavailable|map.*download|map.*source/i);
  assert.equal(calls, 12);
});

test('declared and actual map sizes over five MiB are rejected', async () => {
  for (const result of [response({ length: String(MAX_BYTES + 1) }), response({ data: Buffer.alloc(MAX_BYTES + 1) })]) {
    const { client } = setup({ dependencies: { fetch: async () => result } });
    await assert.rejects(client.getRooms(MAP), /map.*unavailable|map.*download|map.*source/i);
  }
});

test('download timeouts and decoder errors are sanitized and never fall back to legacy room actions', async () => {
  for (const dependencies of [
    { fetch: async () => { throw Error('timeout at ' + url(0)); } },
    { decode: () => { throw Error('bad private-security private-token'); } }
  ]) {
    const { client, state } = setup({ dependencies });
    await assert.rejects(client.getRooms(MAP), error => /map/i.test(error.message) && !/private-|fds|signature/.test(error.message));
    assert.ok(state.reads.every(([method]) => method !== 'action'));
  }
});

test('a valid empty newer roster is authoritative over an older nonempty roster', async () => {
  const { client, maps } = setup(); maps[1] = snapshot(200, []);
  assert.deepEqual(await client.getRooms(MAP), []);
});

test('a newer map for another map ID is never substituted for the requested active map', async () => {
  const { client, maps } = setup(); maps[1] = snapshot(999, ['Wrong'], '123');
  assert.deepEqual(await client.getRooms(MAP), rooms('Old'));
});

test('same-timestamp conflicting active inventories fail instead of guessing', async () => {
  const { client, maps } = setup(); maps[0] = snapshot(200, ['Different']);
  await assert.rejects(client.getRooms(MAP), /conflict|ambiguous/i);
});

test('same-timestamp equal inventories are accepted irrespective of room order', async () => {
  const { client, maps } = setup(); maps[0] = { ...maps[1], rooms: [...maps[1].rooms].reverse() };
  assert.deepEqual((await client.getRooms(MAP)).sort((a, b) => a.id.localeCompare(b.id)), rooms('Kitchen', 'Bedroom'));
});

test('a corrupt slot can be skipped when the other slot is a valid dated active map', async () => {
  const { client, maps } = setup(); maps[0] = null;
  assert.deepEqual(await client.getRooms(MAP), rooms('Kitchen', 'Bedroom'));
});

test('missing upload timestamps cannot establish a fresh authoritative map', async () => {
  const { client, maps } = setup(); maps[0].uploadedAt = null; maps[1].uploadedAt = null;
  await assert.rejects(client.getRooms(MAP), /map.*unavailable|timestamp|map.*source/i);
});

test('an undated valid map cannot be silently ignored when its rooms conflict with the dated map', async () => {
  const { client, maps } = setup(); maps[1].uploadedAt = null;
  await assert.rejects(client.getRooms(MAP), /conflict|ambiguous|timestamp/i);
});

test('an undated duplicate inventory does not prevent using the dated copy', async () => {
  const { client, maps } = setup(); maps[0] = { ...maps[1], uploadedAt: null };
  assert.deepEqual(await client.getRooms(MAP), rooms('Kitchen', 'Bedroom'));
});

test('an active map change before or after download rejects the roster', async () => {
  const before = setup(); before.state.mapId = '456';
  await assert.rejects(before.client.getRooms(MAP), /active map.*changed|active map.*match/i);
  assert.equal(before.state.cloudRequests.length, 0);
  const after = setup();
  const decode = after.dependencies.decode;
  after.dependencies.decode = (...args) => { after.state.mapId = '456'; return decode(...args); };
  await assert.rejects(after.client.getRooms(MAP), /active map.*changed|active map.*match/i);
});

test('serial and owner fallback use verified property values and never put owner UID into object names', async () => {
  const { client, state } = setup();
  state.wifi = 'firmware-invalid'; state.serialFallback = WIFI_SN;
  await client.getRooms(MAP);
  assert.equal(state.decoded[0].wifiSn, WIFI_SN);
  state.serialFallback = 'invalid';
  await client.getRooms(MAP);
  assert.equal(state.decoded.at(-1).wifiSn, WIFI_SN);
  assert.ok(state.cloudRequests.every(([, data]) => data.obj_name.startsWith(LOGIN_UID + '/')));
});

test('invalid local identity and unsuccessful map property reads fail before cloud access', async () => {
  for (const readLocal of [
    async method => method === 'miIO.info' ? { mac: 'not-a-mac' } : [],
    async method => method === 'miIO.info' ? { mac: MAC } : [{ siid: 10, piid: 2, code: -4006, value: MAP }]
  ]) {
    const { client, state } = setup({ readLocal });
    await assert.rejects(client.getRooms(MAP), /identity|active map|serial/i);
    assert.equal(state.cloudRequests.length, 0);
  }
});

test('the login UID is the decryption fallback when firmware does not report an owner UID', async () => {
  const { client, state } = setup(); state.owner = '';
  await client.getRooms(MAP);
  assert.ok(state.decoded.every(identity => identity.ownerId === LOGIN_UID));
});

test('a failed final active-map read does not expose transport error details', async () => {
  let properties = 0;
  const original = setup();
  const { client } = setup({ readLocal: async (method, params) => {
    if (method === 'get_properties' && ++properties === 2) throw Error('private-token transport failure');
    return original.readLocal(method, params);
  } });
  await assert.rejects(client.getRooms(MAP), error => /active map/i.test(error.message) && !/private-token/.test(error.message));
});


test('room discovery scopes and closes its selected API transport', async () => {
  const { client, state } = setup();
  await client.getRooms(MAP);
  assert.equal(state.agentCountry, 'cn');
  assert.ok(state.requestAgent);
  assert.equal(state.agentDestroyed, 1);
});

test('room discovery sends no HTTP when API transport selection fails', async () => {
  const { client, state } = setup({ dependencies: { createRequestAgent: async () => { throw Error('TLS transport unavailable'); } } });
  await assert.rejects(client.getRooms(MAP), /transport|TLS/i);
  assert.equal(state.cloudRequests.length, 0);
});
