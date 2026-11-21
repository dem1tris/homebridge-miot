const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const MatterAccessory = require('../lib/modules/robotcleaner/RobotCleanerMatterAccessory.js');
const logger = { info() {}, debug() {}, warn() {} };

async function setup(options = {}, restored = null, config = {}) {
  const state = { mapId: '42', flags: {}, rooms: [{ id: '10', name: 'Kitchen', mapId: '42' }], calls: [] };
  const device = {
    getModel: () => 'ijai.vacuum.v18', getType: () => 'RobotCleaner',
    getMiotDevice: () => ({ getDeviceId: () => '42' }),
    supportsMopCleaning: () => true, supportsCombinedCleaning: () => true,
    supportsRoomCleaning: () => true, supportsRoomDiscovery: () => true, supportsIdentify: () => false,
    isConnected: () => true, isLocallyConnected: () => true, isReachable: async () => true,
    isVacuumWorking: () => !!state.flags.isWorking, getOperationalStateFlags: () => state.flags,
    hasKnownBatteryLevel: () => true, getBatteryLevel: () => 80,
    _getCurrentMapId: () => state.mapId, discoverRooms: async () => state.rooms,
    startCleaning: async args => state.calls.push(['start', args]),
    startRoomCleaning: async (...args) => state.calls.push(['rooms', ...args]),
    pauseCleaning: async args => state.calls.push(['pause', args]),
    resumeCleaning: async args => state.calls.push(['resume', args]), goHome: async () => state.calls.push(['dock']),
    getMatterCleaningPresets: () => [
      { mode: 0, label: 'Vacuum', modeTags: [{ value: 16385 }], options: { vacuum: true, mop: false } },
      { mode: 4, label: 'Max Vacuum', modeTags: [{ value: 16385 }, { value: 7 }], options: { vacuum: true, mop: false, suction: 3 } }
    ]
  };
  const updates = [];
  const api = { matter: { deviceTypes: { RoboticVacuumCleaner: {} },
    updateAccessoryState: async (_id, cluster, values) => updates.push([cluster, values]) } };
  const wrapper = new MatterAccessory('Robot', device, 'test-vacuum', config, api, logger, {}, restored, options);
  await wrapper.init();
  return { wrapper, state, device, updates, api };
}

test('v18 publishes its modes and passes selected room context to start, pause and resume', async () => {
  const { wrapper, state } = await setup();
  assert.deepEqual(wrapper.accessory.clusters.rvcCleanMode.supportedModes.map(m => m.mode), [0, 4]);
  await wrapper._refreshDiscoveredRooms();
  await wrapper.handleCleanModeChange(4);
  await wrapper.handleSelectAreas({ newAreas: [10] });
  await wrapper.handleRunModeChange(1);
  await wrapper.handlePause();
  await wrapper.handleResume();
  assert.deepEqual(state.calls[0], ['rooms', ['10'], { vacuum: true, mop: false, suction: 3, mapId: '42' }]);
  assert.deepEqual(state.calls[1], ['pause', { roomIds: ['10'], mapId: '42' }]);
  assert.deepEqual(state.calls[2], ['resume', { vacuum: true, mop: false, suction: 3, roomIds: ['10'], mapId: '42' }]);
  assert.equal(wrapper.accessory.clusters.serviceArea.progress, undefined);
});

test('existing room cache restores mode and room selection after restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ijai-matter-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { roomCacheFile: path.join(dir, 'rooms.json') };
  const first = await setup(options);
  const stale = JSON.parse(JSON.stringify(first.wrapper.accessory));
  await first.wrapper._refreshDiscoveredRooms();
  await first.wrapper.handleCleanModeChange(4);
  await first.wrapper.handleSelectAreas({ newAreas: [10] });
  const next = await setup(options, stale);
  assert.equal(next.wrapper.currentCleanMode, 4);
  assert.deepEqual(next.wrapper.selectedAreaIds, [10]);
  await next.wrapper.handleRunModeChange(1);
  assert.equal(next.state.calls[0][0], 'rooms');
});

test('manual rooms work without discovery and reject unknown Matter areas', async () => {
  const { wrapper, state, device } = await setup({}, null, {
    matterRoomDiscovery: 'disabled',
    matterRooms: [{ id: '11', name: 'Study', mapId: '42' }]
  });
  device.discoverRooms = async () => { throw Error('Cloud unavailable'); };
  assert.equal(wrapper._shouldDiscoverRooms(), false);
  await assert.rejects(wrapper.handleSelectAreas({ newAreas: [99] }), /not known/i);
  assert.deepEqual(state.calls, []);
  await wrapper.handleSelectAreas({ newAreas: [11] });
  await wrapper.handleRunModeChange(1);
  await wrapper.handlePause();
  await wrapper.handleResume();
  assert.deepEqual(state.calls.map(call => call[0]), ['rooms', 'pause', 'resume']);
  assert.deepEqual(state.calls[0], ['rooms', ['11'], { vacuum: true, mop: false, mapId: '42' }]);
});

test('changed or removed rooms require selection again instead of starting the whole home', async () => {
  for (const rooms of [[], [{ id: '10', name: 'Other floor', mapId: '43' }]]) {
    const { wrapper, state } = await setup();
    await wrapper._refreshDiscoveredRooms();
    await wrapper.handleSelectAreas({ newAreas: [10] });
    state.rooms = rooms;
    await wrapper._refreshDiscoveredRooms();
    await assert.rejects(wrapper.handleRunModeChange(1), /select.*room/i);
    assert.deepEqual(state.calls, []);
    await wrapper.handleRunModeChange(0);
    assert.deepEqual(state.calls, [['dock']]);
    await wrapper.handleSelectAreas({ newAreas: [] });
    await wrapper.handleRunModeChange(1);
    assert.equal(state.calls[1][0], 'start');
  }
});

test('paused jobs retain their mode and room selection', async () => {
  const { wrapper, state } = await setup();
  await wrapper._refreshDiscoveredRooms();
  await wrapper.handleSelectAreas({ newAreas: [10] });
  state.flags.isPaused = true;
  await assert.rejects(wrapper.handleCleanModeChange(4), /paused|progress/i);
  await assert.rejects(wrapper.handleSelectAreas({ newAreas: [] }), /paused|progress/i);
  assert.deepEqual(wrapper.selectedAreaIds, [10]);
});

test('failed Matter updates remain retryable and battery includes charge state', async () => {
  const { wrapper, state, api } = await setup();
  const update = api.matter.updateAccessoryState;
  api.matter.updateAccessoryState = async () => { throw Error('temporary failure'); };
  await assert.rejects(wrapper._updateClusterState('rvcOperationalState', { operationalState: 1 }));
  assert.equal(wrapper.accessory.clusters.rvcOperationalState.operationalState, 0);
  api.matter.updateAccessoryState = update;
  await wrapper._updateClusterState('rvcOperationalState', { operationalState: 1 });
  state.flags = { isCharging: true };
  assert.equal(wrapper._getBatteryState().batChargeState, 1);
  state.flags.isFullyCharged = true;
  assert.equal(wrapper._getBatteryState().batChargeState, 2);
});
