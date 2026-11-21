const assert = require('node:assert/strict');
const test = require('node:test');
const MiCloud = require('../lib/protocol/MiCloud.js');
const MiotDevice = require('../lib/protocol/MiotDevice.js');
const { MissingMiCloudCredentials } = require('../lib/utils/Errors.js');

const logger = { info() {}, warn() {}, error() {}, debug() {}, deepDebug() {}, table() {} };
const cachedSession = { ssecurity: 'test-security', userId: '123', serviceToken: 'cached-session' };
const loginSession = { ...cachedSession, serviceToken: 'configured-session' };

function localDevice(deviceConfig, session = cachedSession) {
  const device = new MiotDevice('127.0.0.1', 'test-token', '123456789', 'ijai.vacuum.v18', 'Robot', logger);
  device.localConnected = true;
  device.setMiCloudConfig({ global: { country: 'us' }, device: deviceConfig, cachedSession: session });
  return device;
}

test('session acquisition honors the opt-in cache and region without sending any device request', async t => {
  const device = localDevice({ country: 'de', useCachedSession: true });
  const existingControlClient = new MiCloud(logger);
  device.miCloud = existingControlClient;
  t.mock.method(MiCloud.prototype, 'login', () => assert.fail('cached session should be used'));
  const request = t.mock.method(MiCloud.prototype, 'request', () => assert.fail('session acquisition sent a device request'));

  const { country, session } = await device.getMiCloudSession();
  assert.equal(country, 'de');
  for (const field of Object.keys(cachedSession)) assert.equal(session[field], cachedSession[field]);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(device.miCloud, existingControlClient);
  assert.equal(device.localConnected, true);
  assert.equal(device.shouldUseMiCloud(), false);
});

test('session acquisition uses configured login when cached sessions are disabled', async t => {
  const device = localDevice({ username: 'test-user', password: 'test-password', useCachedSession: false });
  const login = t.mock.method(MiCloud.prototype, 'login', async function(username, password) {
    assert.equal(username, 'test-user');
    assert.equal(password, 'test-password');
    this.logger.deepDebug('private account response');
    this.setServiceToken(loginSession);
  });
  const debug = t.mock.method(logger, 'deepDebug');
  const request = t.mock.method(MiCloud.prototype, 'request', () => assert.fail('login must not include a device request'));
  const save = t.mock.method(device, '_saveReachabilitySession', () => assert.fail('session caching is disabled'));

  const { country, session } = await device.getMiCloudSession();
  assert.equal(country, 'us');
  assert.equal(session.serviceToken, loginSession.serviceToken);
  assert.equal(login.mock.callCount(), 1);
  assert.equal(debug.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(device.miCloudConfig.cachedSession, cachedSession);
  assert.equal(device.localConnected, true);
});

test('disabled cloud and cached sessions without opt-in deny session access before login', async t => {
  const login = t.mock.method(MiCloud.prototype, 'login', () => assert.fail('login should be denied'));
  const unconfigured = localDevice({ useCachedSession: false });
  const disabled = localDevice({ country: 'ru', useCachedSession: true, username: 'test-user', password: 'test-password' });
  disabled.disableMiCloud();

  await assert.rejects(unconfigured.getMiCloudSession(), MissingMiCloudCredentials);
  await assert.rejects(disabled.getMiCloudSession(), MissingMiCloudCredentials);
  assert.equal(login.mock.callCount(), 0);
});

test('an unusable cached session with no configured credentials fails before any device request', async t => {
  const device = localDevice({ useCachedSession: true }, { userId: '123' });
  const login = t.mock.method(MiCloud.prototype, 'login', () => assert.fail('no credentials are configured'));
  const request = t.mock.method(MiCloud.prototype, 'request', () => assert.fail('unusable session sent a device request'));

  await assert.rejects(device.getMiCloudSession(), MissingMiCloudCredentials);
  assert.equal(login.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 0);
});

test('a session extraction error propagates and closes only the temporary cloud client', async t => {
  const device = localDevice({ useCachedSession: true });
  const extractionError = new Error('session extraction failed');
  t.mock.method(MiCloud.prototype, 'getServiceToken', () => { throw extractionError; });
  const logout = t.mock.method(MiCloud.prototype, 'logout');

  await assert.rejects(device.getMiCloudSession(), extractionError);
  assert.equal(logout.mock.callCount(), 1);
  assert.equal(device.miCloud, undefined);
  assert.equal(device.localConnected, true);
});
