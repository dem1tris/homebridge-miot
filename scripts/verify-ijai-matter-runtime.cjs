// Usage: node scripts/verify-ijai-matter-runtime.cjs /absolute/path/to/homebridge
// Requires an existing Homebridge 2.4.0 installation with Matter 0.17.9.
// Run in its own process. The node and all device transport below are offline.
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pluginArgument = path.resolve(__dirname, '..');
const homebridgeArgument = process.argv[2];
const homebridgeDir = homebridgeArgument && path.resolve(homebridgeArgument);
const label = 'Offline Matter vacuum';
const UUID = '98511312-e1e0-49f3-aaaf-0d26e1dfe000';
const FAKE_IP = '192.0.2.18';
const FAKE_DID = '42';
const logger = { info() {}, warn() {}, error() {}, debug() {}, deepDebug() {}, table() {} };

function blockNetwork() {
  const attempts = [];
  const deny = operation => () => {
    attempts.push(operation);
    throw new Error(`Network operations are forbidden during this check: ${operation}`);
  };
  dgram.createSocket = deny('UDP socket');
  dgram.Socket.prototype.bind = deny('UDP bind');
  dgram.Socket.prototype.send = deny('UDP send');
  dgram.Socket.prototype.connect = deny('UDP connect');
  net.Socket.prototype.connect = deny('TCP connect');
  net.Server.prototype.listen = deny('TCP listen');
  globalThis.fetch = deny('fetch');
  syncBuiltinESMExports();
  return attempts;
}

function importInstalled(...segments) {
  return import(pathToFileURL(path.join(homebridgeDir, ...segments)).href);
}

async function openOfflineNode() {
  const homebridge = require(path.join(homebridgeDir, 'package.json'));
  const matterPackage = require(path.join(homebridgeDir, 'node_modules/@matter/main/package.json'));
  assert.equal(homebridge.version, '2.4.0');
  assert.equal(matterPackage.version, '0.17.9');

  const [matter, general, protocol] = await Promise.all(['main', 'general', 'protocol'].map(name =>
    importInstalled(`node_modules/@matter/${name}/dist/esm/index.js`)));
  // ServerNode.create loads MdnsService during construction. Install an inert
  // service before constructing the node. Never start the node or the HB server.
  const environment = new general.Environment('vacuum-runtime-check', general.Environment.default);
  class MemoryOnlyStorage extends general.MockStorageService {
    get hasFilesystem() { return false; }
  }
  environment.set(general.StorageService, new MemoryOnlyStorage(environment));
  environment.root.set(protocol.MdnsService, { close() {} });
  return matter.ServerNode.create({
    id: 'validation',
    environment,
    basicInformation: { nodeLabel: label, productName: label, serialNumber: 'offline-check' },
  });
}

async function makeVacuum(pluginDir) {
  const MiotDevice = require(path.join(pluginDir, 'lib/protocol/MiotDevice.js'));
  const MiioProtocol = require(path.join(pluginDir, 'lib/protocol/MiioProtocol.js'));
  const Vacuum = require(path.join(pluginDir, 'lib/modules/robotcleaner/devices/ijai.vacuum.v18.js'));
  const createSocket = MiioProtocol.prototype.createSocket;
  let miot;
  try {
    MiioProtocol.prototype.createSocket = () => {};
    miot = new MiotDevice(FAKE_IP, '0'.repeat(32), FAKE_DID, 'ijai.vacuum.v18', label, logger);
  } finally {
    MiioProtocol.prototype.createSocket = createSocket;
  }
  miot.localConnected = true;
  miot.pollProperties = async () => {};
  const adapter = new Vacuum(miot, label, logger);
  const calls = [];
  const fixture = {
    mapId: 42,
    status: 1,
    rooms: [{ id: 10, name: 'Kitchen' }, { id: 12, name: 'Hall' }],
    rejectAction: false,
  };
  const protocol = miot.miioProtocol;
  protocol.handshake = async () => true;
  protocol._send = async (ip, request) => {
    assert.equal(ip, FAKE_IP);
    const { id, method, params } = request;
    const pending = protocol.getDevice(ip)._promises.get(id);
    calls.push([method, structuredClone(params)]);
    if (method === 'miIO.info') {
      pending.resolve({ mac: 'AA:BB:CC:DD:EE:FF', model: 'ijai.vacuum.v18' });
    } else if (method === 'get_properties') {
      pending.resolve(params.map(item => ({ ...item, code: 0, value: item.siid === 10 ? fixture.mapId
        : item.siid === 1 ? '12345/ABCDEFGHIJKL'
        : item.siid === 7 ? '[0,"12345/ABCDEFGHIJKL;100"]'
        : item.siid === 2 && item.piid === 8 ? 0 : fixture.status })));
    } else if (method === 'set_properties') {
      pending.resolve(params.map(item => ({ ...item, code: 0 })));
    } else if (method === 'action') {
      pending.resolve({ code: fixture.rejectAction ? -4006 : 0 });
    } else {
      pending.reject(new Error(`Unexpected fake transport call: ${method}`));
    }
  };
  const cloudRequests = [];
  const session = { userId: '100', ssecurity: 'offline-security', serviceToken: 'offline-token' };
  miot.getMiCloudSession = async () => ({ country: 'cn', session });
  adapter.configureMatterRoomSource({ matterRoomDiscoveryMiCloud: true });
  const createRequestAgent = async () => ({ destroy() {} });
  adapter.matterRoomControl.dependencies = {
    createRequestAgent,
    createCloud: (log, guard, options) => ({
      setServiceToken: value => assert.deepEqual(value, session),
      setCountry: value => assert.equal(value, 'cn'),
      setRequestTimeout() {},
      request: async (route, data) => {
        assert.equal(options.requestRedirect, 'error');
        guard(route, data);
        calls.push(['action', structuredClone(data.params)]);
        cloudRequests.push([route, structuredClone(data)]);
        return { code: 0, result: { code: fixture.rejectAction ? -4006 : 0 } };
      },
    }),
  };
  adapter.matterRoomSource.dependencies = {
    createRequestAgent,
    createCloud: (log, guard) => ({
      setServiceToken: value => assert.deepEqual(value, session),
      setCountry: value => assert.equal(value, 'cn'),
      setRequestTimeout() {},
      request: async (route, data) => {
        guard(route, data);
        cloudRequests.push([route, structuredClone(data)]);
        return { code: 0, result: { url: `https://cnbj1.fds.api.xiaomi.com/offline/${data.obj_name.at(-1)}` } };
      },
    }),
    fetch: async url => ({
      status: 200, ok: true, headers: { get: () => null }, body: { destroy() {} },
      buffer: async () => Buffer.from(url.at(-1)),
    }),
    decode: data => ({ mapId: fixture.mapId, uploadedAt: 100 + Number(data.toString()), rooms: fixture.rooms }),
  };
  await adapter.initDevice();
  miot.forceLocalConnection();
  adapter.getProperty('map:cur-map-id').updateInternalValue(fixture.mapId);
  adapter.statusProp().updateInternalValue(fixture.status);
  adapter.faultProp().updateInternalValue(0);
  adapter.batteryLevelProp().updateInternalValue(-1);
  assert.deepEqual(calls, [], 'device construction should send nothing');
  return { adapter, miot, calls, fixture, cloudRequests };
}

async function registerOffline(node, preferencesFile, pluginDir, adapter) {
  const [{ MatterAPIImpl }, { MatterServer }] = await Promise.all([
    importInstalled('dist/matter/MatterAPIImpl.js'), importInstalled('dist/matter/server.js'),
  ]);
  const wrapperClass = require(path.join(pluginDir, 'lib/modules/robotcleaner/RobotCleanerMatterAccessory.js'));
  const server = new MatterServer({ uniqueId: '021122334455', externalAccessory: true });
  server.serverNode = node;
  const events = new EventEmitter();
  const api = new MatterAPIImpl(events);
  events._matterManager = { hasActiveMatter: () => true, getExternalServer: uuid => uuid === UUID ? server : undefined };
  events._resolveExternalRegistration = id => {
    const resolve = events._pendingExternalRegistrations.get(id);
    events._pendingExternalRegistrations.delete(id);
    resolve();
  };
  let registration;
  events.on('publishExternalMatterAccessories', (accessories, id) => {
    registration = server.registerPlatformAccessories('homebridge-miot', 'ExternalMatter', accessories);
    registration.then(() => events._resolveExternalRegistration(id), () => events._resolveExternalRegistration(id));
  });

  const pending = new Set();
  const deliveryErrors = [];
  const deliveries = new Map();
  let dropServiceArea = false;
  events.on('updateMatterAccessoryState', (uuid, cluster, attributes, partId) => {
    deliveries.set(cluster, (deliveries.get(cluster) ?? 0) + 1);
    if (cluster === 'serviceArea' && dropServiceArea) {
      dropServiceArea = false;
      return;
    }
    const update = server.updateAccessoryState(uuid, cluster, attributes, partId)
      .catch(error => deliveryErrors.push(error))
      .finally(() => pending.delete(update));
    pending.add(update);
  });
  async function drain() {
    while (pending.size) await Promise.all([...pending]);
    assert.deepEqual(deliveryErrors, [], 'all dispatched Matter state writes must validate at the endpoint');
  }

  const wrapper = new wrapperClass(label, adapter, UUID, { matterRoomDiscoveryMiCloud: true }, { matter: api }, logger, { firmwareRev: '4.3.3' }, null,
    { roomCacheFile: preferencesFile });
  await wrapper.init();
  await api.registerPlatformAccessories('homebridge-miot', 'Miot', [wrapper.getMatterAccessory()]);
  assert.ok(registration, 'the public Matter API must route the vacuum through its standalone publication event');
  await registration;
  const endpoint = server.accessories.get(UUID).endpoint;
  // matter.js 0.17.9 persistent readonly views can retain an expired nested
  // list entry after shrink/regrow. A fresh transaction reads the actual cluster.
  const read = cluster => endpoint.act(agent => JSON.parse(JSON.stringify(agent[cluster].state)));
  const invoke = (cluster, command, args) => endpoint.act(agent => agent[cluster][command](args));
  const restoreFromPreferences = async () => {
    const restored = new wrapperClass(label, adapter, UUID, { matterRoomDiscoveryMiCloud: true },
      { matter: api }, logger, { firmwareRev: '4.3.3' }, null,
      { roomCacheFile: preferencesFile, existingMatterStorage: true });
    await restored.init();
    return restored.getMatterAccessory();
  };
  return { wrapper, read, invoke, drain, deliveries, restoreFromPreferences,
    dropNextAreas: () => { dropServiceArea = true; } };

}

async function verifyRuntime(runtime, { adapter, miot, calls, fixture, cloudRequests }) {
  const { wrapper, read, invoke, drain, deliveries, restoreFromPreferences, dropNextAreas } = runtime;
  const state = 'rvcOperationalState';
  const cleanMode = 'rvcCleanMode';
  const runMode = 'rvcRunMode';
  const area = 'serviceArea';
  const powerSource = 'powerSource';
  const run = mode => invoke(runMode, 'changeToMode', { newMode: mode });
  const select = ids => invoke(area, 'selectAreas', { newAreas: ids });
  const setMode = mode => invoke(cleanMode, 'changeToMode', { newMode: mode });
  const poll = async () => { await wrapper._syncMatterState(); await drain(); };
  const success = result => assert.equal(result?.status, 0, JSON.stringify(result));
  const operationalSuccess = result => assert.equal(result?.commandResponseState?.errorStateId, 0);
  const assertDiscoveryOnly = captured => {
    assert.ok(captured.length >= 3, 'cloud discovery verifies the local identity and active map');
    assert.ok(captured.every(([method]) => ['miIO.info', 'get_properties'].includes(method)));
  };

  assert.equal((await read(powerSource)).batPercentRemaining, null);
  assert.equal((await read(powerSource)).batChargeState, 0);
  assert.equal((await read(area)).supportedAreas.length, 0);
  assert.deepEqual(calls, [], 'registration must not contact the device');
  dropNextAreas();
  await wrapper._refreshDiscoveredRooms();
  await drain();
  assert.equal((await read(area)).supportedAreas.length, 0);
  await poll();
  const serviceArea = await read(area);
  assert.deepEqual(serviceArea.supportedMaps.map(map => map.mapId), [42]);
  assert.deepEqual(serviceArea.supportedAreas.map(room => room.areaInfo.locationInfo.locationName), ['Kitchen', 'Hall']);
  assert.equal(serviceArea.currentArea, null);
  assert.equal(serviceArea.progress, undefined);
  const kitchenId = serviceArea.supportedAreas[0].areaId;
  assert.ok(kitchenId > 65534 && kitchenId <= 0xffffffff);
  assertDiscoveryOnly(calls.splice(0));
  const deliveredAfterDiscovery = new Map(deliveries);
  await poll();
  assert.deepEqual(deliveries, deliveredAfterDiscovery, 'unchanged real endpoint attributes must not be rewritten');

  success(await select([kitchenId]));
  await drain();
  assert.deepEqual((await read(area)).selectedAreas, [kitchenId]);
  assert.equal((await read(area)).progress, undefined);
  await assert.rejects(select([10]), /not known|unsupported/i);
  await assert.rejects(invoke(area, 'skipArea', { skippedArea: kitchenId }), /not supported/i);
  // Exercise commands through actual Matter behaviors with captured LAN and cloud transport.
  // The process cannot open sockets.
  success(await select([]));
  const presets = (await read(cleanMode)).supportedModes;
  assert.deepEqual(presets.map(mode => mode.mode), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const expectedActions = [3, 6, 5, 3, 3, 6, 6, 5, 5];
  const expectedSettings = [null, null, null, [5, 0], [5, 3], [6, 0], [6, 2], [5, 0], [5, 3]];
  for (const { mode, label: name } of presets) {
    success(await setMode(mode));
    await drain();
    assert.equal((await read(cleanMode)).currentMode, mode, name);
    success(await run(1));
    await drain();
    const captured = calls.splice(0);
    const settings = expectedSettings[mode];
    assert.equal(captured.length, settings ? 3 : 2, name);
    assert.equal(captured[0][0], 'set_properties');
    assert.deepEqual(captured[0][1], [{ did: FAKE_DID, siid: 2, piid: 4, value: { 3: 0, 6: 2, 5: 1 }[expectedActions[mode]] }]);
    if (settings) assert.deepEqual(captured[1][1], [{ did: FAKE_DID, siid: 7, piid: settings[0], value: settings[1] }]);
    assert.deepEqual(captured.at(-1), ['action', { did: FAKE_DID, siid: 2, aiid: expectedActions[mode], in: [] }]);
    await poll();
  }

  fixture.status = 5;
  adapter.statusProp().updateInternalValue(5);
  operationalSuccess(await invoke(state, 'pause'));
  await drain();
  assert.deepEqual(calls.splice(0).at(-1), ['action', { did: FAKE_DID, siid: 7, aiid: 3, in: ['', 0, 2] }]);
  fixture.status = 2;
  adapter.statusProp().updateInternalValue(2);
  await poll();
  operationalSuccess(await invoke(state, 'resume'));
  await drain();
  assert.deepEqual(calls.splice(0).at(-1), ['action', { did: FAKE_DID, siid: 2, aiid: 1, in: [] }]);
  fixture.status = 1;
  adapter.statusProp().updateInternalValue(1);
  await poll();

  success(await select([kitchenId]));
  await drain();
  success(await run(1));
  await drain();
  assert.deepEqual(calls.splice(0).at(-1), ['action', { did: FAKE_DID, siid: 7, aiid: 3, in: ['10', 0, 1] }]);
  fixture.status = 5;
  adapter.statusProp().updateInternalValue(5);
  operationalSuccess(await invoke(state, 'pause'));
  await drain();
  const pauseCalls = calls.splice(0);
  assert.equal(pauseCalls[0][0], 'get_properties');
  assert.deepEqual(pauseCalls.at(-1), ['action', { did: FAKE_DID, siid: 7, aiid: 3, in: ['10', 0, 2] }]);
  fixture.status = 2;
  adapter.statusProp().updateInternalValue(2);
  await poll();
  assert.equal((await read(state)).operationalState, 2);
  operationalSuccess(await invoke(state, 'resume'));
  await drain();
  assert.deepEqual(calls.splice(0).at(-1), ['action', { did: FAKE_DID, siid: 7, aiid: 3, in: ['10', 0, 1] }]);
  operationalSuccess(await invoke(state, 'goHome'));
  await drain();
  assert.deepEqual(calls.splice(0), [['action', { did: FAKE_DID, siid: 3, aiid: 1, in: [] }]]);

  adapter.statusProp().updateInternalValue(1);
  fixture.mapId = 43;
  fixture.rooms = [{ id: 10, name: 'Office' }];
  adapter.getProperty('map:cur-map-id').updateInternalValue(fixture.mapId);
  await wrapper._refreshDiscoveredRooms();
  await drain();
  const newAreas = (await read(area)).supportedAreas;
  assert.equal(newAreas.length, 1);
  assert.notEqual(newAreas[0].areaId, kitchenId);
  await assert.rejects(select([kitchenId]), /not known|unsupported/i);
  await assert.rejects(run(1), /select rooms/i);
  assertDiscoveryOnly(calls.splice(0));

  adapter.statusProp().updateInternalValue(4);
  adapter.batteryLevelProp().updateInternalValue(51);
  await poll();
  assert.equal((await read(powerSource)).batPercentRemaining, 102);
  assert.equal((await read(powerSource)).batChargeState, 1);
  assert.equal((await read(state)).operationalState, 65);
  adapter.batteryLevelProp().updateInternalValue(100);
  adapter.faultProp().updateInternalValue(2105);
  await poll();
  assert.equal((await read(powerSource)).batChargeState, 2);
  assert.equal((await read(state)).operationalState, 66);
  assert.equal((await read(state)).operationalError.errorStateId, 0);
  adapter.faultProp().updateInternalValue(2345);
  await poll();
  assert.equal((await read(state)).operationalState, 3);
  assert.match((await read(state)).operationalError.errorStateDetails, /2345/);
  adapter.faultProp().updateInternalValue(0);
  adapter.statusProp().updateInternalValue(1);
  await poll();
  assert.equal((await read(powerSource)).batChargeState, 3);
  assert.equal((await read(state)).operationalError.errorStateId, 0);
  assert.equal((await read(state)).operationalError.errorStateDetails, undefined);
  fixture.rejectAction = true;
  await assert.rejects(invoke(state, 'goHome'));
  await drain();
  assert.equal((await read(state)).operationalState, 0);
  assert.equal(calls.splice(0).length, 1, 'an unsuccessful action should not take a fallback path');
  // The uploaded-map source must publish all rooms through the actual Matter endpoint.
  fixture.rejectAction = false;
  fixture.rooms = [
    { id: 10, name: 'Room A' }, { id: 11, name: 'Room B' },
    { id: 13, name: 'Room C' }, { id: 12, name: 'Room D' }
  ];
  await wrapper._refreshDiscoveredRooms();
  await drain();
  const cloudAreas = (await read(area)).supportedAreas;
  assert.deepEqual(cloudAreas.map(room => room.areaInfo.locationInfo.locationName), ['Room A', 'Room B', 'Room C', 'Room D']);
  assert.equal(cloudAreas[0].areaId, newAreas[0].areaId, 'renaming a room retains its Matter area ID');
  success(await select([cloudAreas[1].areaId]));
  success(await run(1));
  await drain();
  const cloudCalls = calls.splice(0);
  assert.equal(cloudCalls.some(([method, params]) => method === 'action' && params.siid === 10), false);
  assert.deepEqual(cloudCalls.at(-1), ['action', { did: FAKE_DID, siid: 7, aiid: 3, in: ['11', 0, 1] }]);
  miot.localConnected = false;
  miot.isReachableThroughMiCloud = async () => false;
  await poll();
  const unreachable = await read(state);
  assert.equal(unreachable.operationalState, 3);
  assert.match(unreachable.operationalError.errorStateDetails, /Robot unavailable/);
  assert.ok(cloudRequests.some(([route]) => route === '/v2/home/get_interim_file_url_pro'));
  assert.ok(cloudRequests.some(([route]) => route === '/miotspec/action'));
  const callsBeforeRestore = calls.length;
  const restored = await restoreFromPreferences();
  assert.equal(calls.length, callsBeforeRestore, 'restoring preferences does not contact the device');
  assert.equal(restored.clusters.rvcCleanMode.currentMode, wrapper.currentCleanMode);
  assert.deepEqual(restored.clusters.serviceArea.supportedAreas, (await read(area)).supportedAreas);
  assert.deepEqual(restored.clusters.serviceArea.selectedAreas, [cloudAreas[1].areaId]);
  assert.equal(restored.context.selectionInvalid, false);
}

async function main() {
  assert.ok(homebridgeArgument && path.isAbsolute(homebridgeArgument), 'Pass the absolute path to an existing Homebridge 2.4.0 package.');
  const attempts = blockNetwork();
  const workingDirectory = process.cwd();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-matter-runtime-'));
  let node;
  try {
    process.chdir(directory);
    node = await openOfflineNode();
    const device = await makeVacuum(pluginArgument);
    const runtime = await registerOffline(node, path.join(directory, 'preferences.json'), pluginArgument, device.adapter);
    await verifyRuntime(runtime, device);
  } finally {
    try {
      await node?.close();
    } finally {
      process.chdir(workingDirectory);
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  assert.deepEqual(attempts, [], 'the isolated runtime made no attempt to use network sockets');
  console.log('PASS Homebridge 2.4.0 + Matter 0.17.9: offline registration, persisted rooms and selections, map invalidation, nine modes, battery and faults, LAN/cloud command responses; no network attempts.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
