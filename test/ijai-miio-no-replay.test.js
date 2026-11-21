const assert = require('node:assert/strict');
const test = require('node:test');
const MiioProtocol = require('../lib/protocol/MiioProtocol.js');

const address = '192.0.2.18';
const logger = { debug() {}, deepDebug() {} };

// Exercise send and incoming replies with an in-memory transport.
function mockProtocol(handshake, onSend = () => {}) {
  const protocol = Object.create(MiioProtocol.prototype);
  const requests = [];
  protocol.logger = logger;
  protocol._devices = new Map();
  protocol.handshake = handshake;
  protocol._send = async (ip, request) => {
    requests.push({ ...request });
    onSend((reply) => protocol._onData(ip, Buffer.from(JSON.stringify({ id: request.id, ...reply }))));
  };
  return { protocol, requests };
}

test('Miio retries zero sends a timed-out physical action once', async () => {
  const { protocol, requests } = mockProtocol(async () => {});
  await assert.rejects(protocol.send(address, 'action', { siid: 3, aiid: 1 }, { retries: 0, timeout: 5 }),
    { code: 'timeout' });
  assert.equal(requests.length, 1);
  assert.equal(protocol.getDevice(address)._promises.size, 0);
});

test('Miio retries zero never sends the physical action after a handshake timeout', async () => {
  const { protocol, requests } = mockProtocol(async () => {
    throw Object.assign(new Error('Handshake timeout'), { code: 'timeout' });
  });
  await assert.rejects(protocol.send(address, 'action', { siid: 3, aiid: 1 }, { retries: 0, timeout: 5 }),
    { code: 'timeout' });
  assert.deepEqual(requests, []);
  assert.equal(protocol.getDevice(address)._promises.size, 0);
});

test('Miio retry sends only after the next successful handshake', async () => {
  let attempts = 0;
  const { protocol, requests } = mockProtocol(async () => {
    if (attempts++ === 0) throw Object.assign(new Error('Handshake timeout'), { code: 'timeout' });
  }, reply => queueMicrotask(() => reply({ result: { code: 0 } })));
  assert.deepEqual(await protocol.send(address, 'get_properties', [], { retries: 1, timeout: 5 }), { code: 0 });
  assert.equal(attempts, 2);
  assert.equal(requests.length, 1);
});

test('Miio keeps retrying busy polls with a default retry budget', async () => {
  let attempts = 0;
  const { protocol, requests } = mockProtocol(async () => {}, reply => queueMicrotask(() => {
    if (attempts++ === 0) reply({ error: { code: -30012, message: 'busy.' } });
    else reply({ result: [{ code: 0 }] });
  }));
  assert.deepEqual(await protocol.send(address, 'get_properties', [], { timeout: 5 }), [{ code: 0 }]);
  assert.equal(requests.length, 2);
});

test('Miio retries zero prevents replay on a retryable busy response', async () => {
  const { protocol, requests } = mockProtocol(async () => {}, reply => queueMicrotask(() => {
    reply({ error: { code: -30012, message: 'busy.' } });
  }));
  await assert.rejects(protocol.send(address, 'set_properties', [], { retries: 0, timeout: 5 }));
  assert.equal(requests.length, 1);
});
