const assert = require('node:assert/strict');
const test = require('node:test');
const https = require('node:https');

// Load a dedicated MiCloud copy with a fake HTTP fetch; no sockets or credentials.
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
const miCloudPath = require.resolve('../lib/protocol/MiCloud.js');
const originalFetch = require.cache[fetchPath].exports;
const requests = [];
let MiCloud;
try {
  require.cache[fetchPath].exports = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ code: 0 }), text: async () => 'synthetic' };
  };
  delete require.cache[miCloudPath];
  MiCloud = require(miCloudPath);
} finally {
  require.cache[fetchPath].exports = originalFetch;
  delete require.cache[miCloudPath];
}

test('optional request agent is scoped to this client and both API encodings', async () => {
  const globalAgent = https.globalAgent;
  const requestAgent = {};
  const logger = { debug() {}, deepDebug() {} };
  const client = new MiCloud(logger, () => {}, { requestAgent });
  client.setServiceToken({ serviceToken: 'synthetic', ssecurity: Buffer.alloc(16).toString('base64'), userId: '123' });
  client._decryptRc4 = () => JSON.stringify({ code: 0 });
  await client._requestUnencrypted('/v2/home/get_interim_file_url_pro', { obj_name: 'synthetic' });
  await client._requestEncrypted('/miotspec/action', { params: {} });
  assert.equal(requests.length, 2);
  for (const { options } of requests.splice(0)) {
    assert.equal(options.agent, requestAgent);
    assert.equal(options.redirect, 'follow');
  }
  assert.equal(https.globalAgent, globalAgent);
  assert.equal(new MiCloud(logger).requestAgent, undefined);
});

test('default API requests share the existing keep-alive agent across clients and encodings', async () => {
  const logger = { debug() {}, deepDebug() {} };
  const session = { serviceToken: 'synthetic', ssecurity: Buffer.alloc(16).toString('base64'), userId: '123' };
  const first = new MiCloud(logger);
  const second = new MiCloud(logger);
  first.setServiceToken(session);
  second.setServiceToken(session);
  second._decryptRc4 = () => JSON.stringify({ code: 0 });
  await first._requestUnencrypted('/miotspec/prop/get', { params: [] });
  await second._requestEncrypted('/miotspec/prop/get', { params: [] });
  const [one, two] = requests.splice(0);
  assert.ok(one.options.agent instanceof https.Agent);
  assert.equal(one.options.agent.keepAlive, true);
  assert.equal(one.options.agent.keepAliveMsecs, 30000);
  assert.equal(one.options.agent.maxSockets, 8);
  assert.equal(two.options.agent, one.options.agent);
});

test('the request guard rejects both API encodings before transport', async () => {
  const denial = new Error('request denied');
  const client = new MiCloud({ debug() {}, deepDebug() {} }, () => { throw denial; });
  const data = { params: [] };
  await assert.rejects(client.request('/denied', data), denial);
  await assert.rejects(client._requestUnencrypted('/denied', data), denial);
  await assert.rejects(client._requestEncrypted('/denied', data), denial);
  assert.deepEqual(requests, []);
});
