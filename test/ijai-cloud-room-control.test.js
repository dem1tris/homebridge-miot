const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const MiCloud = require('../lib/protocol/MiCloud.js');
const IjaiCloudRoomControl = require('../lib/modules/robotcleaner/devices/IjaiCloudRoomControl.js');

const DID = '123456789';
const ROUTE = '/miotspec/action';
const params = () => ({ did: DID, siid: 7, aiid: 3, in: ['10,11', 0, 1] });
const credentials = () => ({ country: 'cn', deviceId: DID,
  session: { userId: '111222333', ssecurity: 'private-security', serviceToken: 'private-token' } });

function setup(overrides = {}) {
  const state = { credentials: credentials(), reads: 0, agentDestroyed: 0, requests: [], instances: [], loginCalls: 0, result: { code: 0, result: { code: 0, out: [] } } };
  const dependencies = {
    createRequestAgent: async country => { state.agentCountry = country; return { destroy() { state.agentDestroyed++; } }; },
    createCloud: (logger, guard, options) => {
      state.requestAgent = options?.requestAgent;
      const instance = {
        logger, guard,
        setServiceToken: value => { instance.session = value; },
        setCountry: value => { instance.country = value; },
        setRequestTimeout: value => { instance.timeout = value; },
        login: () => { state.loginCalls++; throw Error('must not log in'); },
        refreshServiceToken: () => { state.loginCalls++; throw Error('must not refresh'); },
        request: async (route, data) => {
          guard(route, data);
          state.requests.push([route, data]);
          return state.result;
        }
      };
      state.instances.push(instance);
      return instance;
    }
  };
  const client = new IjaiCloudRoomControl({ deviceId: DID,
    readCredentials: overrides.readCredentials || (async () => { state.reads++; return state.credentials; }), dependencies });
  return { client, state, dependencies };
}

test('one successful room action preserves the verified envelope and returns the device result', async () => {
  const { client, state } = setup();
  assert.strictEqual(await client.sendRoomCleanAction(params()), state.result.result);
  assert.deepEqual(state.requests, [[ROUTE, { params: params() }]]);
  assert.equal(state.instances[0].country, 'cn');
  assert.equal(state.instances[0].timeout, 10000);
  assert.equal(state.loginCalls, 0);
});

test('every explicit action rereads credentials and uses its own quiet cloud session', async () => {
  const { client, state } = setup();
  await client.sendRoomCleanAction(params());
  state.credentials = { ...credentials(), session: { ...credentials().session, serviceToken: 'new-private-token' } };
  await client.sendRoomCleanAction({ ...params(), in: ['255', 0, 1] });
  assert.equal(state.reads, 2);
  assert.equal(state.instances.length, 2);
  assert.equal(state.instances[1].session.serviceToken, 'new-private-token');
  assert.equal(state.requests.length, 2);
  for (const method of ['debug', 'deepDebug', 'info', 'warn', 'error', 'table']) {
    assert.equal(state.instances[0].logger[method]('private-token'), undefined);
  }
});

test('constructing room control requires a device ID and credential reader', () => {
  for (const options of [{}, { deviceId: DID }, { deviceId: 'wrong', readCredentials: async () => credentials() }]) {
    assert.throws(() => new IjaiCloudRoomControl(options), /device|credentials/i);
  }
});

test('invalid action shape is refused before reading credentials or creating a cloud session', async () => {
  const invalid = [null, [], {}, { ...params(), did: '999' }, { ...params(), did: Number(DID) },
    { ...params(), siid: 2 }, { ...params(), aiid: 1 }, { ...params(), siid: '7' },
    { ...params(), extra: true }, { ...params(), in: ['10', 0] }, { ...params(), in: ['10', 0, 1, 1] },
    { ...params(), in: ['10', '0', 1] }, { ...params(), in: ['10', 0, '1'] },
    { ...params(), in: ['10', 1, 1] }, { ...params(), in: ['10', 0, 3] },
    Object.assign(Object.create({ surprise: true }), params()),
    Object.defineProperty(params(), 'hidden', { value: true }), { ...params(), [Symbol('extra')]: true }];
  for (const value of invalid) {
    const { client, state } = setup();
    await assert.rejects(client.sendRoomCleanAction(value), /room.*action|action.*allowed/i);
    assert.equal(state.reads, 0);
    assert.equal(state.instances.length, 0);
  }
});

test('room IDs must be canonical unique positive CSV values in the range 1 through 255', async () => {
  for (const ids of ['', '0', '256', '-1', '01', '10,10', '10, 11', '10,', ',10', '1.5', '1e2', '10\n', ['10'], 10]) {
    const { client, state } = setup();
    await assert.rejects(client.sendRoomCleanAction({ ...params(), in: [ids, 0, 1] }), /room.*action|action.*allowed/i);
    assert.equal(state.reads, 0);
  }
  const { client, state } = setup();
  await client.sendRoomCleanAction({ ...params(), in: ['1,255', 0, 1] });
  assert.equal(state.requests.length, 1);
});

test('credentials must remain bound to this robot and complete before any request', async () => {
  for (const value of [null, { ...credentials(), deviceId: '999' }, { ...credentials(), country: 'other' },
    { ...credentials(), session: {} }, { ...credentials(), session: { ...credentials().session, serviceToken: '' } }]) {
    const { client, state } = setup({ readCredentials: async () => value });
    await assert.rejects(client.sendRoomCleanAction(params()), /credentials|device/i);
    assert.equal(state.requests.length, 0);
    assert.equal(state.instances.length, 0);
  }
});

test('credential reader errors cannot expose session contents or private file paths', async () => {
  const { client, state } = setup({ readCredentials: async () => { throw Error('/private/session.json private-token'); } });
  await assert.rejects(client.sendRoomCleanAction(params()), error => /credentials/i.test(error.message) && !/private-token|session\.json/.test(error.message));
  assert.equal(state.instances.length, 0);
});

test('each cloud guard permits only its one exact action and rejects unrelated routes or mutations', async () => {
  const { client, state } = setup();
  await client.sendRoomCleanAction(params());
  const guard = state.instances[0].guard;
  guard(ROUTE, { params: params() });
  for (const [route, data] of [
    ['/home/rpc/' + DID, { params: params() }], ['/miotspec/prop/set', { params: params() }],
    ['/v2/home/get_interim_file_url_pro', { obj_name: '111222333/' + DID + '/0' }],
    [ROUTE, params()], [ROUTE, { params: params(), extra: true }],
    [ROUTE, { params: { ...params(), in: ['10', 0, 1] } }],
    [ROUTE, { params: { ...params(), in: ['11,10', 0, 1] } }],
    [ROUTE, { params: { ...params(), did: '999' } }], [ROUTE, { params: { ...params(), aiid: 1 } }]
  ]) assert.throws(() => guard(route, data), /allowed|denied/i);
});

test('the allowed action is snapshotted before asynchronous credential reads', async () => {
  const action = params();
  const { client, state } = setup({ readCredentials: async () => {
    action.did = '999'; action.in[0] = '12'; return credentials();
  } });
  await client.sendRoomCleanAction(action);
  assert.deepEqual(state.requests, [[ROUTE, { params: params() }]]);
});

test('both outer and device codes must be numeric zero for a successful result', async () => {
  for (const result of [null, {}, { code: 0 }, { code: -1, result: { code: 0 } },
    { result: { code: 0 } }, { code: '0', result: { code: 0 } },
    { code: 0, result: { code: '0' } }, { code: 0, result: { code: -1, message: 'private-token' } }]) {
    const { client, state } = setup(); state.result = result;
    await assert.rejects(client.sendRoomCleanAction(params()), error => /room.*action|cloud.*request/i.test(error.message) && !/private-token/.test(error.message));
    assert.equal(state.requests.length, 1);
    assert.equal(state.loginCalls, 0);
  }
});

test('transport failures are sanitized and never retried or followed by an automatic login', async () => {
  const { client, state, dependencies } = setup();
  const createCloud = dependencies.createCloud;
  dependencies.createCloud = (...args) => {
    const cloud = createCloud(...args);
    cloud.request = async (route, data) => { state.requests.push([route, data]); throw Error('timeout private-token https://private-url'); };
    return cloud;
  };
  await assert.rejects(client.sendRoomCleanAction(params()), error => /room.*action|cloud.*request/i.test(error.message) && !/private-token|private-url/.test(error.message));
  assert.equal(state.requests.length, 1);
  assert.equal(state.instances.length, 1);
  assert.equal(state.loginCalls, 0);
});

test('authentication failures explain that login must be refreshed without exposing secrets', async () => {
  for (const failure of [{ code: 401, message: 'private-token' }, { code: 403 },
    new Error('Request error with status 401 private-token'), new Error('You are not logged in!')]) {
    const { client, state, dependencies } = setup();
    const createCloud = dependencies.createCloud;
    dependencies.createCloud = (...args) => {
      const cloud = createCloud(...args);
      cloud.request = async (route, data) => {
        state.requests.push([route, data]);
        if (failure instanceof Error) throw failure;
        return failure;
      };
      return cloud;
    };
    await assert.rejects(client.sendRoomCleanAction(params()), error => error.code === 'XIAOMI_MAP_AUTH_REQUIRED' && /login/i.test(error.message) && !/private-token/.test(error.message));
    assert.equal(state.requests.length, 1);
    assert.equal(state.loginCalls, 0);
  }
});


test('native room pause uses the same scoped cloud envelope with operation 2', async () => {
  const { client, state } = setup();
  const pause = { ...params(), in: ['10,11', 0, 2] };
  await client.sendRoomCleanAction(pause);
  assert.deepEqual(state.requests, [[ROUTE, { params: pause }]]);
  assert.throws(() => state.instances[0].guard(ROUTE, { params: params() }), /not allowed/i);
});

test('global pause allows an empty CSV only for operation 2 and keeps its request guard exact', async () => {
  const { client, state } = setup();
  const pause = { ...params(), in: ['', 0, 2] };
  await client.sendRoomCleanAction(pause);
  assert.deepEqual(state.requests, [[ROUTE, { params: pause }]]);
  const guard = state.instances[0].guard;
  for (const input of [['', 0, 1], ['', 0, 0], ['', 0, 3], ['', 1, 2], ['10', 0, 2]]) {
    assert.throws(() => guard(ROUTE, { params: { ...params(), in: input } }), /not allowed/i);
  }
  assert.equal(state.requests.length, 1);
});


test('room control selects transport before its single HTTP action and closes it', async () => {
  const { client, state } = setup();
  await client.sendRoomCleanAction(params());
  assert.equal(state.agentCountry, 'cn');
  assert.ok(state.requestAgent);
  assert.equal(state.requests.length, 1);
  assert.equal(state.agentDestroyed, 1);
});

test('failed TLS selection prevents the physical HTTP request', async () => {
  const { client, state, dependencies } = setup();
  dependencies.createRequestAgent = async () => { throw Error('TLS transport unavailable'); };
  await assert.rejects(client.sendRoomCleanAction(params()), /could not be confirmed/i);
  assert.equal(state.requests.length, 0);
});

test('HTTP 307 and 308 redirects cannot replay a physical room action', async t => {
  const requests = [];
  let redirectStatus = 307;
  const server = http.createServer((request, response) => {
    requests.push([request.method, request.url]);
    request.resume();
    if (request.url === ROUTE) response.writeHead(redirectStatus, { Location: '/redirect-target?private-token' });
    response.end('synthetic');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const client = new IjaiCloudRoomControl({
    deviceId: DID,
    readCredentials: async () => credentials(),
    dependencies: {
      createRequestAgent: async () => new http.Agent(),
      createCloud: (logger, guard, options) => {
        const cloud = new MiCloud(logger, guard, options);
        cloud._getApiUrl = () => `http://127.0.0.1:${server.address().port}`;
        cloud._generateEncSignature = () => 'synthetic';
        cloud._decryptRc4 = () => JSON.stringify({ code: 0, result: { code: 0 } });
        return cloud;
      }
    }
  });

  for (const status of [307, 308]) {
    redirectStatus = status;
    const [result] = await Promise.allSettled([client.sendRoomCleanAction(params())]);
    assert.deepEqual(requests.splice(0), [['POST', ROUTE]]);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /could not be confirmed/);
    assert.doesNotMatch(result.reason.message, /private-token/);
  }
});
