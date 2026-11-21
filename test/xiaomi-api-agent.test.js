const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Duplex } = require('node:stream');
const https = require('node:https');
const { createXiaomiApiAgent } = require('../lib/protocol/XiaomiApiAgent.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const addresses = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];

function setup(options = {}) {
  const state = { dns: [], probes: [], lookups: [], timers: new Set() };
  const dependencies = {
    resolve4: async hostname => { state.dns.push(hostname); return options.addresses || addresses; },
    tlsConnect: args => {
      const socket = options.httpSockets ? new FakeTlsSocket() : new EventEmitter();
      socket.authorized = true;
      if (!options.httpSockets) {
        socket.destroyed = false;
        socket.destroy = () => { socket.destroyed = true; };
        socket.write = () => assert.fail('TLS probes must never send HTTP or credentials');
      }
      state.probes.push({ args, socket });
      return socket;
    },
    lookup: (...args) => { state.lookups.push(args); args.at(-1)(null, '203.0.113.5', 4); },
    setTimeout: (callback, milliseconds) => { const timer = { callback, milliseconds }; state.timers.add(timer); return timer; },
    clearTimeout: timer => state.timers.delete(timer),
    ...options.dependencies
  };
  return { dependencies, state };
}

class FakeTlsSocket extends Duplex {
  constructor() {
    super();
    this.authorized = true;
    this.encrypted = true;
    this.connecting = false;
    this.writes = [];
    this.reply = true;
  }
  _read() {}
  _write(chunk, encoding, callback) {
    this.writes.push(chunk.toString());
    callback();
    if (this.reply && this.writes.join('').includes('\r\n\r\n')) {
      this.reply = false;
      queueMicrotask(() => this.push('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK'));
    }
  }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}

function connection(agent, options = {}) {
  return new Promise((resolve, reject) => {
    const returned = agent.createConnection({ host: 'api.io.mi.com', port: 443, servername: 'api.io.mi.com', ...options },
      (error, socket) => error ? reject(error) : resolve(socket));
    assert.equal(returned, undefined, 'the agent must not return a socket before its asynchronous handoff');
  });
}

async function failThreeRounds(state, fail) {
  for (let round = 0; round < 3; round++) {
    await tick();
    for (const probe of state.probes.filter(probe => !probe.socket.destroyed)) fail(probe);
  }
}

function lookup(agent, hostname, options) {
  return new Promise((resolve, reject) => {
    const callback = (error, address, family) => error ? reject(error) : resolve({ address, family });
    if (options === undefined) agent.options.lookup(hostname, callback);
    else agent.options.lookup(hostname, options, callback);
  });
}

test('parallel validated TLS probes keep the winner for HTTP and destroy only losers', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick();
  assert.equal(state.probes.length, 3);
  for (const probe of state.probes) {
    assert.equal(probe.args.port, 443);
    assert.equal(probe.args.servername, 'api.io.mi.com');
    assert.equal(probe.args.rejectUnauthorized, true);
    assert.ok(addresses.includes(probe.args.host));
    assert.equal(probe.args.family, 4);
    assert.ok(!('headers' in probe.args) && !('path' in probe.args) && !('checkServerIdentity' in probe.args));
  }
  state.probes[1].socket.emit('secureConnect');
  const agent = await pending;
  assert.ok(agent instanceof https.Agent);
  assert.equal(agent.keepAlive, false);
  assert.equal(agent.options.rejectUnauthorized, true);
  assert.deepEqual(await lookup(agent, 'api.io.mi.com'), { address: addresses[1], family: 4 });
  assert.equal(state.probes[1].socket.destroyed, false);
  assert.ok(state.probes.filter((probe, index) => index !== 1).every(probe => probe.socket.destroyed));
  assert.strictEqual(await connection(agent), state.probes[1].socket);
  assert.equal(state.probes.length, 3);
  assert.equal(state.timers.size, 0);
  agent.destroy();
});

test('country selects only the exact known regional Xiaomi API hostname', async () => {
  for (const country of ['ru', 'us', 'tw', 'sg', 'cn', 'de', 'in', 'i2']) {
    const { dependencies, state } = setup({ addresses: [addresses[0]] });
    const pending = createXiaomiApiAgent(country, dependencies);
    await tick();
    const hostname = country === 'cn' ? 'api.io.mi.com' : country + '.api.io.mi.com';
    assert.deepEqual(state.dns, [hostname]);
    assert.equal(state.probes[0].args.servername, hostname);
    state.probes[0].socket.emit('secureConnect');
    (await pending).destroy();
  }
});

test('invalid countries fail before DNS or TLS', async () => {
  for (const country of ['', undefined, 'other', 'CN', 'cn.evil.test', 'https://api.io.mi.com']) {
    const { dependencies, state } = setup();
    await assert.rejects(createXiaomiApiAgent(country, dependencies), /country|region/i);
    assert.equal(state.dns.length, 0);
    assert.equal(state.probes.length, 0);
  }
});

test('every agent resolves fresh DNS and does not reuse an old address choice', async () => {
  const { dependencies, state } = setup();
  let current = addresses[0];
  dependencies.resolve4 = async hostname => { state.dns.push(hostname); return [current]; };
  const first = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const firstAgent = await first;
  current = addresses[2];
  const second = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[1].socket.emit('secureConnect');
  const secondAgent = await second;
  assert.equal(state.dns.length, 2);
  assert.deepEqual(await lookup(firstAgent, 'api.io.mi.com'), { address: addresses[0], family: 4 });
  assert.deepEqual(await lookup(secondAgent, 'api.io.mi.com'), { address: addresses[2], family: 4 });
  firstAgent.destroy(); secondAgent.destroy();
});

test('DNS duplicates and non-IPv4 values are removed and no more than eight addresses are probed', async () => {
  const values = ['bad', '::1', '1.2.3.999', ...Array.from({ length: 12 }, (_, i) => `198.51.100.${i + 1}`), addresses[0]];
  const { dependencies, state } = setup({ addresses: values });
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick();
  assert.equal(state.probes.length, 8);
  assert.equal(new Set(state.probes.map(probe => probe.args.host)).size, 8);
  state.probes[0].socket.emit('secureConnect');
  (await pending).destroy();
});

test('empty or invalid DNS answers fail without initiating TLS', async () => {
  for (const value of [[], ['bad', '::1'], null]) {
    const { dependencies, state } = setup({ dependencies: { resolve4: async () => value } });
    await assert.rejects(createXiaomiApiAgent('cn', dependencies), error => error.code === 'XIAOMI_API_UNAVAILABLE');
    assert.equal(state.probes.length, 0);
    assert.equal(state.timers.size, 0);
  }
});

test('DNS exceptions are sanitized without leaking resolver details', async () => {
  const { dependencies, state } = setup({ dependencies: { resolve4: async () => { throw Error('private resolver details'); } } });
  await assert.rejects(createXiaomiApiAgent('cn', dependencies), error => error.code === 'XIAOMI_API_UNAVAILABLE' && !/private resolver/.test(error.message));
  assert.equal(state.probes.length, 0);
  assert.equal(state.timers.size, 0);
});

test('DNS waiting is bounded and late resolution cannot launch probes', async () => {
  let finishDns;
  const { dependencies, state } = setup({ dependencies: { resolve4: () => new Promise(resolve => { finishDns = resolve; }) } });
  const pending = createXiaomiApiAgent('cn', dependencies);
  const rejection = assert.rejects(pending, error => error.code === 'XIAOMI_API_UNAVAILABLE');
  await tick();
  assert.equal(state.timers.size, 1);
  const [timer] = state.timers;
  assert.equal(timer.milliseconds, 2000);
  timer.callback();
  await rejection;
  finishDns(addresses); await tick();
  assert.equal(state.probes.length, 0);
  assert.equal(state.timers.size, 0);
});

test('unauthorized secureConnect cannot win against a certificate-validated probe', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick();
  state.probes[0].socket.authorized = false;
  state.probes[0].socket.emit('secureConnect');
  assert.equal(state.probes[0].socket.destroyed, true);
  state.probes[2].socket.emit('secureConnect');
  const agent = await pending;
  assert.deepEqual(await lookup(agent, 'api.io.mi.com'), { address: addresses[2], family: 4 });
  agent.destroy();
});

test('all TLS failures reject with one sanitized error and close every socket', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  const rejection = assert.rejects(pending, error => error.code === 'XIAOMI_API_UNAVAILABLE' && !/private certificate/.test(error.message));
  await failThreeRounds(state, probe => probe.socket.emit('error', Error('private certificate failure')));
  await rejection;
  assert.equal(state.probes.length, 9);
  assert.ok(state.probes.every(probe => probe.socket.destroyed));
  assert.equal(state.timers.size, 0);
});

test('TLS stalls expire at an absolute two-second deadline and cancel all timers', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  const rejection = assert.rejects(pending, error => error.code === 'XIAOMI_API_UNAVAILABLE');
  for (let round = 0; round < 3; round++) {
    await tick();
    assert.equal(state.timers.size, 3);
    for (const timer of [...state.timers]) {
      assert.equal(timer.milliseconds, 2000);
      timer.callback();
    }
  }
  await rejection;
  assert.ok(state.probes.every(probe => probe.socket.destroyed));
  assert.equal(state.timers.size, 0);
});

test('early TLS closes and synchronous connect exceptions are handled without hanging', async () => {
  const { dependencies, state } = setup();
  const connect = dependencies.tlsConnect;
  dependencies.tlsConnect = options => {
    if (options.host === addresses[0]) throw Error('private connect failure');
    return connect(options);
  };
  const pending = createXiaomiApiAgent('cn', dependencies);
  const rejection = assert.rejects(pending, error => error.code === 'XIAOMI_API_UNAVAILABLE');
  await failThreeRounds(state, probe => probe.socket.emit('close'));
  await rejection;
  assert.equal(state.timers.size, 0);
});

test('late and repeated probe errors remain handled after selecting a winner', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  for (const probe of state.probes) {
    assert.doesNotThrow(() => probe.socket.emit('error', Error('late probe error')));
    assert.doesNotThrow(() => probe.socket.emit('error', Error('second late error')));
    probe.socket.emit('close');
  }
  agent.destroy();
});

test('a failed TLS-only round can succeed on the next round before any HTTP socket is handed out', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick();
  for (const probe of state.probes) probe.socket.emit('error', Error('transient TLS failure'));
  await tick();
  assert.equal(state.probes.length, 6);
  state.probes[4].socket.emit('secureConnect');
  const agent = await pending;
  assert.strictEqual(await connection(agent), state.probes[4].socket);
  assert.equal(state.dns.length, 1);
  agent.destroy();
});

test('a real HTTPS ClientRequest writes exactly once to the already-verified winner', async t => {
  t.mock.method(https.Agent.prototype, 'createConnection', () => assert.fail('HTTP must reuse a verified socket without opening an ordinary connection'));
  const { dependencies, state } = setup({ httpSockets: true });
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[1].socket.emit('secureConnect');
  const agent = await pending;
  assert.ok(state.probes.every(probe => probe.socket.writes.length === 0));
  await new Promise((resolve, reject) => {
    const request = https.request({ hostname: 'api.io.mi.com', path: '/app/read-only-test', method: 'POST', agent }, response => {
      response.resume(); response.on('end', resolve); response.on('error', reject);
    });
    request.on('error', reject); request.end('synthetic-data');
  });
  assert.equal(state.probes.length, 3);
  assert.equal(state.probes[1].socket.writes.join('').match(/POST /g).length, 1);
  assert.ok(state.probes.filter((probe, index) => index !== 1).every(probe => probe.socket.writes.length === 0));
  agent.destroy();
});

test('a second connection gets a distinct verified socket without reusing or writing to probes', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  const first = await connection(agent);
  const secondPending = connection(agent);
  await tick();
  assert.equal(state.probes.length, 6);
  state.probes[5].socket.emit('secureConnect');
  assert.strictEqual(await secondPending, state.probes[5].socket);
  assert.notStrictEqual(first, state.probes[5].socket);
  assert.equal(state.dns.length, 1);
  agent.destroy();
});

test('a closed warm winner is replaced before any HTTP handoff', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  state.probes[0].socket.destroy();
  const next = connection(agent);
  await tick();
  assert.equal(state.probes.length, 6);
  state.probes[4].socket.emit('secureConnect');
  assert.strictEqual(await next, state.probes[4].socket);
  agent.destroy();
});

test('destroy closes an unused warm winner and refuses new connections without TLS probes', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  agent.destroy();
  assert.equal(state.probes[0].socket.destroyed, true);
  await assert.rejects(connection(agent), error => error.code === 'XIAOMI_API_UNAVAILABLE');
  assert.equal(state.probes.length, 3);
});

test('destroy cancels pending probes and prevents late socket handoff or retry rounds', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  await connection(agent);
  const next = connection(agent);
  const rejection = assert.rejects(next, error => error.code === 'XIAOMI_API_UNAVAILABLE');
  await tick();
  assert.equal(state.probes.length, 6);
  agent.destroy();
  for (const probe of state.probes.slice(3)) {
    probe.socket.emit('secureConnect');
    probe.socket.emit('error', Error('late probe error'));
  }
  await rejection; await tick();
  assert.ok(state.probes.slice(3).every(probe => probe.socket.destroyed));
  assert.equal(state.probes.length, 6);
  assert.equal(state.timers.size, 0);
});

test('destroy during warm handoff rejects the callback instead of returning a closed socket', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  const handoff = connection(agent);
  const rejection = assert.rejects(handoff, error => error.code === 'XIAOMI_API_UNAVAILABLE');
  agent.destroy();
  await rejection;
  assert.equal(state.probes[0].socket.destroyed, true);
});

test('an HTTP failure after handoff is never replayed or replaced by another connection', async t => {
  t.mock.method(https.Agent.prototype, 'createConnection', () => assert.fail('HTTP must reuse a verified socket without opening an ordinary connection'));
  const { dependencies, state } = setup({ httpSockets: true });
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  const winner = state.probes[0].socket;
  winner.reply = false;
  const requestFailed = new Promise(resolve => {
    const request = https.request({ hostname: 'api.io.mi.com', path: '/app/synthetic-action', method: 'POST', agent });
    request.on('error', resolve);
    request.end('synthetic-data');
  });
  await tick();
  assert.equal(winner.writes.join('').match(/POST /g).length, 1);
  winner.destroy(Error('synthetic connection lost'));
  await requestFailed; await tick();
  assert.equal(state.probes.length, 3);
  assert.equal(winner.writes.join('').match(/POST /g).length, 1);
  agent.destroy();
});

test('foreign hosts retain the ordinary HTTPS connection path without taking the warm socket', async t => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  const fallbackSocket = {};
  let calls = 0;
  t.mock.method(https.Agent.prototype, 'createConnection', options => {
    calls++; assert.equal(options.host, 'other.example'); return fallbackSocket;
  });
  assert.strictEqual(agent.createConnection({ host: 'other.example', port: 443 }, () => {}), fallbackSocket);
  assert.equal(calls, 1);
  assert.strictEqual(await connection(agent), state.probes[0].socket);
  agent.destroy();
});

test('the pinned lookup supports single and all-address callbacks and is asynchronous', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  let synchronous = true;
  const all = new Promise((resolve, reject) => agent.options.lookup('api.io.mi.com', { all: true }, (error, values) => {
    assert.equal(synchronous, false); if (error) reject(error); else resolve(values);
  }));
  synchronous = false;
  assert.deepEqual(await all, [{ address: addresses[0], family: 4 }]);
  assert.deepEqual(await lookup(agent, 'api.io.mi.com', 4), { address: addresses[0], family: 4 });
  assert.equal(state.lookups.length, 0);
  agent.destroy();
});

test('other hosts retain normal DNS lookup instead of receiving the Xiaomi address', async () => {
  const { dependencies, state } = setup();
  const pending = createXiaomiApiAgent('cn', dependencies);
  await tick(); state.probes[0].socket.emit('secureConnect');
  const agent = await pending;
  for (const hostname of ['other.example', 'de.api.io.mi.com', 'api.io.mi.com.other.example']) {
    assert.deepEqual(await lookup(agent, hostname, { family: 4 }), { address: '203.0.113.5', family: 4 });
    assert.equal(state.lookups.at(-1)[0], hostname);
    assert.deepEqual(state.lookups.at(-1)[1], { family: 4 });
  }
  agent.destroy();
});
