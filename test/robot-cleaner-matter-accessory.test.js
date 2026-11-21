const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const MatterAccessory = require('../lib/modules/robotcleaner/RobotCleanerMatterAccessory.js');

const logger = new Proxy({}, { get: () => () => {} });

async function setup({ config = {}, restored = null, deviceOverrides = {}, apiOverrides = {}, options = {}, mapId = '100' } = {}) {
  const state = { battery: 80, batteryKnown: true, flags: {}, mapId, commands: [] };
  const updates = [];
  const device = {
    getModel: () => 'ijai.vacuum.v18', getType: () => 'RobotCleaner',
    getMiotDevice: () => ({ getDeviceId: () => 'test-robot' }),
    supportsRoomCleaning: () => true, supportsRoomDiscovery: () => true,
    supportsRoomResume: () => true, supportsIdentify: () => false,
    supportsMopCleaning: () => true, supportsCombinedCleaning: () => true,
    isConnected: () => true, isLocallyConnected: () => true, isReachable: async () => true,
    isVacuumWorking: () => Boolean(state.flags.isWorking),
    getOperationalStateFlags: () => state.flags,
    hasKnownBatteryLevel: () => state.batteryKnown,
    getBatteryLevel: () => state.battery,
    getMatterOperationalError: () => ({ errorStateId: 0 }),
    _getCurrentMapId: () => state.mapId,
    discoverRooms: async () => [{ id: '10', name: 'Kitchen', mapId: state.mapId }],
    startCleaning: async options => state.commands.push(['start', options]),
    startRoomCleaning: async (rooms, options) => state.commands.push(['rooms', rooms, options]),
    resumeCleaning: async options => state.commands.push(['resume', options]),
    pauseCleaning: async () => state.commands.push(['pause']),
    goHome: async () => state.commands.push(['dock']),
    ...deviceOverrides
  };
  const api = { matter: {
    deviceTypes: { RoboticVacuumCleaner: {} },
    updateAccessoryState: async (_uuid, cluster, attributes) => updates.push({ cluster, attributes }),
    ...apiOverrides
  } };
  const wrapper = new MatterAccessory('Robot', device, 'robot-uuid', config, api, logger, {}, restored, options);
  await wrapper.init();
  return { wrapper, device, state, updates, api };
}

async function newPrefsFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'miot-matter-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'robot-uuid.json');
}

function areaId(wrapper, vendorId = '10') {
  return wrapper.normalizedRooms.find(room => room.vendorId === vendorId)?.areaId;
}

test('discovered rooms are sent through the Matter API immediately', async () => {
  const { wrapper, updates } = await setup();
  await wrapper._refreshDiscoveredRooms();
  const update = updates.find(entry => entry.cluster === 'serviceArea');
  assert.ok(update, 'room discovery must notify Matter');
  assert.equal(update.attributes.supportedAreas[0].areaInfo.locationInfo.locationName, 'Kitchen');
});

test('v18 does not enable the Matter feature that synthesizes progress from selected areas', async () => {
  const restored = { clusters: { serviceArea: { progress: [{ areaId: 10, status: 0 }] } } };
  const { wrapper } = await setup({ restored });
  assert.equal(wrapper.accessory.clusters.serviceArea.currentArea, null);
  assert.equal('progress' in wrapper.accessory.clusters.serviceArea, false);
});

test('a failed Matter state update remains retryable instead of poisoning the comparison cache', async () => {
  const { wrapper, api, updates } = await setup();
  const initial = wrapper.accessory.clusters.rvcOperationalState.operationalState;
  api.matter.updateAccessoryState = async () => { throw Error('temporary API failure'); };
  await assert.rejects(wrapper._updateClusterState('rvcOperationalState', { operationalState: 1 }), /temporary/);
  assert.equal(wrapper.accessory.clusters.rvcOperationalState.operationalState, initial);
  api.matter.updateAccessoryState = async (_id, cluster, attributes) => updates.push({ cluster, attributes });
  await wrapper._updateClusterState('rvcOperationalState', { operationalState: 1 });
  assert.equal(updates.length, 1);
  assert.equal(wrapper.accessory.clusters.rvcOperationalState.operationalState, 1);
});

test('selected clean mode is published and persisted, then restored after restart', async () => {
  const { wrapper, updates } = await setup();
  await wrapper.handleCleanModeChange(2);
  assert.equal(wrapper.accessory.clusters.rvcCleanMode.currentMode, 2);
  assert.ok(updates.some(entry => entry.cluster === 'rvcCleanMode' && entry.attributes.currentMode === 2));
  assert.equal(wrapper.accessory.context.currentCleanMode, 2);
  const restored = JSON.parse(JSON.stringify(wrapper.accessory));
  const next = await setup({ restored });
  assert.equal(next.wrapper.currentCleanMode, 2);
});

test('battery state distinguishes charging, full, not charging and unknown without inventing 100%', async () => {
  const { wrapper, state } = await setup();
  state.flags = { isCharging: true };
  assert.equal(wrapper._getBatteryState().batChargeState, 1);
  state.flags = { isCharging: true, isFullyCharged: true };
  assert.equal(wrapper._getBatteryState().batChargeState, 2);
  state.flags = {};
  assert.equal(wrapper._getBatteryState().batChargeState, 3);
  state.batteryKnown = false;
  assert.equal(wrapper._getBatteryState().batChargeState, 0);
  assert.equal(wrapper._getBatteryState().batPercentRemaining, null);
});

test('Matter reports device error details and clears them when the fault clears', async () => {
  let error = { errorStateId: 2, errorStateLabel: 'IJAI error', errorStateDetails: 'Code 999' };
  const { wrapper, updates } = await setup({ deviceOverrides: { getMatterOperationalError: () => error } });
  assert.deepEqual(wrapper.accessory.clusters.rvcOperationalState.operationalError, { errorStateId: 2, errorStateDetails: 'Code 999' });
  assert.equal(wrapper._getOperationalError(true).errorStateLabel, undefined);
  error = { ...error, errorStateId: 128 };
  assert.deepEqual(wrapper._getOperationalError(), error);
  error = { errorStateId: 0 };
  await wrapper._syncMatterState();
  assert.deepEqual(wrapper.accessory.clusters.rvcOperationalState.operationalError, error);
  const clear = updates.find(entry => entry.attributes.operationalError?.errorStateId === 0);
  assert.equal(Object.hasOwn(clear.attributes.operationalError, 'errorStateDetails'), true);
  assert.equal(clear.attributes.operationalError.errorStateDetails, undefined);
});

test('a removed selected room cannot silently fall back to a whole-home clean', async () => {
  const { wrapper, device, state } = await setup();
  await wrapper._refreshDiscoveredRooms();
  await wrapper.handleSelectAreas({ newAreas: [areaId(wrapper)] });
  device.discoverRooms = async () => [{ id: '20', name: 'Other room', mapId: '100' }];
  await wrapper._refreshDiscoveredRooms();
  await wrapper._syncMatterState();
  await assert.rejects(wrapper.handleRunModeChange(1), /select.*rooms.*again|selected.*room/i);
  assert.deepEqual(state.commands, []);
  await wrapper.handleSelectAreas({ newAreas: [areaId(wrapper, '20')] });
  await wrapper.handleRunModeChange(1);
  assert.equal(state.commands[0][0], 'rooms');
  assert.deepEqual(state.commands[0][1], ['20']);
});

test('reusing a room number on a different map invalidates the old selection', async () => {
  const { wrapper, state } = await setup();
  await wrapper._refreshDiscoveredRooms();
  await wrapper.handleSelectAreas({ newAreas: [areaId(wrapper)] });
  state.mapId = '200';
  await wrapper._refreshDiscoveredRooms();
  await assert.rejects(wrapper.handleRunModeChange(1), /select.*rooms.*again|selected.*room/i);
  assert.deepEqual(state.commands, []);
});

test('a changed active map is rejected before start even before the next discovery', async () => {
  const { wrapper, state } = await setup();
  await wrapper._refreshDiscoveredRooms();
  await wrapper.handleSelectAreas({ newAreas: [areaId(wrapper)] });
  state.mapId = '200';
  await assert.rejects(wrapper.handleRunModeChange(1), /map|selected.*room/i);
  assert.deepEqual(state.commands, []);
});

test('malformed selection cannot reset a previous room selection to whole-home', async () => {
  const { wrapper } = await setup();
  await wrapper._refreshDiscoveredRooms();
  const selectedId = areaId(wrapper);
  await wrapper.handleSelectAreas({ newAreas: [selectedId] });
  for (const bad of [undefined, '10', null, [null], [undefined], Array(1)]) {
    await assert.rejects(wrapper.handleSelectAreas({ newAreas: bad }), /array|selection|area/i);
    assert.deepEqual(wrapper.selectedAreaIds, [selectedId]);
  }
});

test('changing cleaning mode or areas during a paused job is rejected', async () => {
  const { wrapper, state } = await setup();
  await wrapper._refreshDiscoveredRooms();
  state.flags = { isPaused: true };
  await assert.rejects(wrapper.handleCleanModeChange(1), /paused|progress/i);
  await assert.rejects(wrapper.handleSelectAreas({ newAreas: [areaId(wrapper)] }), /paused|progress/i);
});

test('resume preserves the room job and refuses models without a safe room-resume path', async () => {
  const { wrapper, state, device } = await setup();
  await wrapper._refreshDiscoveredRooms();
  await wrapper.handleSelectAreas({ newAreas: [areaId(wrapper)] });
  state.flags = { isPaused: true };
  await wrapper.handleResume();
  assert.deepEqual(state.commands, [['resume', { vacuum: true, mop: false, roomIds: ['10'], mapId: '100' }]]);
  device.supportsRoomResume = () => false;
  await assert.rejects(wrapper.handleResume(), /room.*resume|resume.*room/i);
  assert.equal(state.commands.length, 1);
});

test('room choice and invalidation survive restart without relying on a token-named cache file', async () => {
  const { wrapper, state } = await setup();
  await wrapper._refreshDiscoveredRooms();
  const selectedId = areaId(wrapper);
  await wrapper.handleSelectAreas({ newAreas: [selectedId] });
  const restored = JSON.parse(JSON.stringify(wrapper.accessory));
  const next = await setup({ restored });
  assert.deepEqual(next.wrapper.selectedAreaIds, [selectedId]);
  await next.wrapper.handleRunModeChange(1);
  assert.equal(next.state.commands[0][0], 'rooms');
  state.mapId = '200';
  await wrapper._refreshDiscoveredRooms();
  const invalid = await setup({ restored: JSON.parse(JSON.stringify(wrapper.accessory)) });
  await assert.rejects(invalid.wrapper.handleRunModeChange(1), /selected.*room|select.*rooms.*again/i);
  assert.deepEqual(invalid.state.commands, []);
});

test('standalone restart restores local mode, selection, room IDs and invalidation without Homebridge context', async t => {
  const options = { roomCacheFile: await newPrefsFile(t) };
  const first = await setup({ options });
  await first.wrapper._refreshDiscoveredRooms();
  const selectedId = areaId(first.wrapper);
  await first.wrapper.handleCleanModeChange(2);
  await first.wrapper.handleSelectAreas({ newAreas: [selectedId] });

  const restartOptions = { ...options, existingMatterStorage: true };
  const next = await setup({ options: restartOptions });
  assert.equal(next.wrapper.currentCleanMode, 2);
  assert.deepEqual(next.wrapper.selectedAreaIds, [selectedId]);
  assert.equal(areaId(next.wrapper), selectedId);
  await next.wrapper.handleRunModeChange(1);
  assert.deepEqual(next.state.commands, [['rooms', ['10'], { vacuum: true, mop: true, mapId: '100' }]]);
  assert.equal((await fs.stat(options.roomCacheFile)).mode & 0o777, 0o600);

  next.device.discoverRooms = async () => [];
  await next.wrapper._refreshDiscoveredRooms();
  const invalid = await setup({ options: restartOptions });
  await assert.rejects(invalid.wrapper.handleRunModeChange(1), /selected rooms|select rooms/i);
  assert.deepEqual(invalid.state.commands, []);
});

test('missing, corrupted and legacy preferences on existing Matter storage require an explicit selection', async t => {
  const roomCacheFile = await newPrefsFile(t);
  for (const raw of [null, '{invalid', '{"version":1}', '{"rooms":[{"id":"10","mapId":"100"}]}']) {
    await fs.rm(roomCacheFile, { force: true });
    if (raw !== null) await fs.writeFile(roomCacheFile, raw);
    const { wrapper, state } = await setup({ options: { roomCacheFile, existingMatterStorage: true } });
    await assert.rejects(wrapper.handleRunModeChange(1), /selected rooms|select rooms/i);
    assert.deepEqual(state.commands, []);
    await wrapper.handleSelectAreas({ newAreas: [] });
    await wrapper.handleRunModeChange(1);
    assert.equal(state.commands[0][0], 'start');
  }
});

test('instance never reassigns an old controller area ID to a same-number room on another map', async t => {
  const options = { roomCacheFile: await newPrefsFile(t) };
  const first = await setup({ options });
  await first.wrapper._refreshDiscoveredRooms();
  const staleId = areaId(first.wrapper);
  await first.wrapper.handleSelectAreas({ newAreas: [staleId] });
  assert.ok(staleId > 65534 && staleId <= 0xffffffff);

  const next = await setup({ mapId: '200', options });
  await next.wrapper._refreshDiscoveredRooms();
  assert.notEqual(areaId(next.wrapper), staleId);
  await assert.rejects(next.wrapper.handleSelectAreas({ newAreas: [staleId] }), /area/i);
  await assert.rejects(next.wrapper.handleRunModeChange(1), /selected rooms|select rooms/i);
  assert.deepEqual(next.state.commands, []);

  next.state.mapId = '100';
  await next.wrapper._refreshDiscoveredRooms();
  assert.equal(areaId(next.wrapper), staleId);
});

test('v18 advertises only active-map discovered IDs, with config limited to verified name overrides', async () => {
  const { wrapper, device, state } = await setup({
    mapId: null,
    config: { matterRooms: [
      { id: '10', name: 'My Kitchen' },
      { id: '10', name: 'Bedroom on a different floor', map_id: '200' },
      { id: '20', name: 'Unverified room', mapId: '100' }
    ] }
  });
  assert.deepEqual(wrapper.normalizedRooms, []);
  state.mapId = '100';
  device.discoverRooms = async () => [{ id: '10', name: 'Kitchen', mapId: '100' }, { id: '11', name: 'Wrong floor', mapId: '200' }];
  await wrapper._refreshDiscoveredRooms();
  assert.deepEqual(wrapper.normalizedRooms.map(({ vendorId, name }) => [vendorId, name]), [['10', 'My Kitchen']]);
  state.mapId = null;
  await wrapper._syncMatterState();
  assert.deepEqual(wrapper.accessory.clusters.serviceArea.supportedAreas, []);
});

test('failed discovery keeps valid room intent and retries before the normal discovery interval', async t => {
  const { wrapper, device, state } = await setup();
  const timer = t.mock.method(Date, 'now', () => 600_000);
  await wrapper._refreshDiscoveredRoomsIfNeeded();
  const firstSuccess = wrapper.lastRoomDiscoveryAt;
  const selectedId = areaId(wrapper);
  await wrapper.handleSelectAreas({ newAreas: [selectedId] });
  state.mapId = '200';
  let attempts = 0;
  device.discoverRooms = async () => { attempts++; throw new Error('discovery failed'); };
  await assert.rejects(wrapper._refreshDiscoveredRoomsIfNeeded(), /failed/);
  assert.equal(wrapper.lastRoomDiscoveryAt, firstSuccess);
  assert.deepEqual(wrapper.cachedRooms, [{ id: '10', name: 'Kitchen', mapId: '100' }]);
  await wrapper._refreshDiscoveredRoomsIfNeeded();
  assert.equal(attempts, 1);
  timer.mock.mockImplementation(() => firstSuccess + 5 * 60_000);
  await assert.rejects(wrapper._refreshDiscoveredRoomsIfNeeded(), /failed/);
  assert.equal(attempts, 2);
  assert.equal(wrapper.lastRoomDiscoveryAt, firstSuccess);
});

test('Matter polling retries an asynchronously dropped endpoint write after dispatch resolved', async () => {
  class AreaState {
    constructor(value) { Object.assign(this, value); }
  }
  const endpoint = { serviceArea: { supportedAreas: [], supportedMaps: [], selectedAreas: [] } };
  const deliveries = [];
  let drop = true;
  const { wrapper } = await setup({ apiOverrides: {
    getAccessoryState: async (_uuid, cluster) => endpoint[cluster],
    updateAccessoryState: async (_uuid, cluster, attributes) => {
      if (cluster === 'serviceArea') {
        deliveries.push(attributes);
        setImmediate(() => {
          if (!drop) {
            Object.assign(endpoint[cluster], attributes);
            endpoint.serviceArea.supportedAreas = endpoint.serviceArea.supportedAreas.map(value => new AreaState(value));
          }
        });
      }
    }
  } });
  await wrapper._refreshDiscoveredRooms();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(endpoint.serviceArea.supportedAreas.length, 0);
  assert.equal(deliveries.length, 1);
  drop = false;
  await wrapper._syncMatterState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(endpoint.serviceArea.supportedAreas.length, 1);
  assert.equal(deliveries.length, 2);
  await wrapper._syncMatterState();
  assert.equal(deliveries.length, 2);
});

test('other models retain native room resume and their existing mixed-map room start behavior', async () => {
  const { wrapper, state } = await setup({
    deviceOverrides: {
      getModel: () => 'generic.vacuum.test', supportsRoomResume: undefined,
      resumeSweepAction: () => ({}),
      discoverRooms: async () => [{ id: '10', mapId: '100' }, { id: '20', mapId: '200' }]
    }
  });
  await wrapper._refreshDiscoveredRooms();
  await wrapper.handleSelectAreas({ newAreas: [10, 20] });
  await wrapper.handleRunModeChange(1);
  state.flags = { isPaused: true };
  await wrapper.handleResume();
  assert.deepEqual(state.commands, [
    ['rooms', ['10', '20'], { vacuum: true, mop: false }],
    ['resume', { vacuum: true, mop: false }]
  ]);
});

test('device cleaning presets publish their Matter descriptors and preserve exact cleaning options', async t => {
  const options = { roomCacheFile: await newPrefsFile(t) };
  const vacuum = { mode: 0, label: 'Vacuum', modeTags: [{ value: 16385 }], options: { vacuum: true, mop: false } };
  const quietCombined = {
    mode: 7,
    label: 'Quiet Vacuum and Mop',
    modeTags: [{ value: 16385 }, { value: 16386 }],
    options: { vacuum: true, mop: true, suction: 0 }
  };
  const deviceOverrides = { getMatterCleaningPresets: () => [vacuum, quietCombined] };
  const first = await setup({ options, deviceOverrides });
  const { mode, label, modeTags } = quietCombined;
  assert.deepEqual(first.wrapper.accessory.clusters.rvcCleanMode.supportedModes[1], { mode, label, modeTags });
  await assert.rejects(first.wrapper.handleCleanModeChange(99), /not supported/i);
  await first.wrapper.handleCleanModeChange(7);
  await first.wrapper._refreshDiscoveredRooms();
  await first.wrapper.handleSelectAreas({ newAreas: [areaId(first.wrapper)] });

  const restarted = await setup({ options, deviceOverrides });
  assert.equal(restarted.wrapper.currentCleanMode, 7);
  await restarted.wrapper.handleRunModeChange(1);
  assert.deepEqual(restarted.state.commands, [['rooms', ['10'], { vacuum: true, mop: true, suction: 0, mapId: '100' }]]);
  assert.deepEqual(quietCombined.options, { vacuum: true, mop: true, suction: 0 });

  const withoutPreset = await setup({ options });
  assert.equal(withoutPreset.wrapper.currentCleanMode, 0);
});


test('room discovery accepts a five-minute interval and rejects shorter intervals', async () => {
  const { wrapper } = await setup({ config: { matterRoomDiscoveryInterval: 1 / 12 } });
  assert.equal(wrapper._getRoomDiscoveryIntervalMs(), 300000);
  wrapper.config.matterRoomDiscoveryInterval = 0.001;
  assert.equal(wrapper._getRoomDiscoveryIntervalMs(), 6 * 60 * 60 * 1000);
});

test('Matter pause retains the selected vendor rooms and current map', async () => {
  const calls = [];
  const { wrapper } = await setup({ deviceOverrides: { pauseCleaning: async options => calls.push(options) } });
  await wrapper._refreshDiscoveredRooms();
  await wrapper.handleSelectAreas({ newAreas: [areaId(wrapper)] });
  await wrapper.handlePause();
  assert.deepEqual(calls, [{ roomIds: ['10'], mapId: '100' }]);
});

test('newer persisted clean mode wins over stale Homebridge cluster state on restart', async t => {
  const options = { roomCacheFile: await newPrefsFile(t) };
  const { wrapper } = await setup({ options });
  const staleAccessory = JSON.parse(JSON.stringify(wrapper.accessory));
  await wrapper.handleCleanModeChange(2);
  const next = await setup({ options, restored: staleAccessory });
  assert.equal(next.wrapper.currentCleanMode, 2);
  assert.equal(next.wrapper.accessory.clusters.rvcCleanMode.currentMode, 2);
  assert.equal(JSON.parse(await fs.readFile(options.roomCacheFile, 'utf8')).currentCleanMode, 2);
});

test('existing storage without room preferences does not block unrelated cloud-only robots', async () => {
  const { wrapper, state } = await setup({
    options: { existingMatterStorage: true },
    deviceOverrides: {
      getModel: () => 'dreame.vacuum.p2009',
      isLocallyConnected: () => false,
      supportsRoomCleaning: () => false,
      supportsRoomDiscovery: () => false
    }
  });
  await wrapper.handleRunModeChange(1);
  assert.deepEqual(state.commands, [['start', { vacuum: true, mop: false }]]);
});
