const assert = require('node:assert/strict');
const test = require('node:test');
const MiotDevice = require('../lib/protocol/MiotDevice.js');
const Vacuum = require('../lib/modules/robotcleaner/devices/ijai.vacuum.v18.js');

const logger = { info() {}, warn() {}, error() {}, debug() {}, deepDebug() {}, table() {} };
const action = (siid, aiid, input = []) => ({ did: '12345', siid, aiid, in: input });
const write = (siid, piid, value) => ['set_properties', [{ did: '12345', siid, piid, value }]];

async function setup() {
  const miot = new MiotDevice('192.0.2.18', 'token', '12345', 'ijai.vacuum.v18', 'Robot', logger);
  const calls = [];
  const state = { status: 1, mapId: 42, sweepType: 0, roomIds: ['10', '11'] };
  miot.localConnected = true;
  miot.pollProperties = async () => {};
  miot.miioProtocol.send = async (_ip, method, params) => {
    calls.push([method, params]);
    if (method === 'get_properties') return params.map(p => ({ ...p, code: 0,
      value: p.siid === 10 ? state.mapId : p.piid === 1 ? state.status : state.sweepType }));
    return method === 'set_properties' ? params.map(p => ({ ...p, code: 0 })) : { code: 0 };
  };
  miot.withMiCloudSession = async operation => operation({ miotAction: async params => {
    calls.push(['cloud', params]);
    return { code: 0 };
  } });
  const vacuum = new Vacuum(miot, 'Robot', logger);
  await vacuum.initDevice();
  miot.forceLocalConnection();
  vacuum.getProperty('map:cur-map-id').updateInternalValue(state.mapId);
  vacuum.discoverRooms = async () => state.roomIds.map(id => ({ id, mapId: String(state.mapId) }));
  return { vacuum, miot, calls, state };
}

test('nine Matter presets apply their settings and the corresponding v18 start action', async () => {
  const { vacuum, calls } = await setup();
  const presets = vacuum.getMatterCleaningPresets();
  assert.deepEqual(presets.map(p => p.mode), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const expected = [[0, 3], [2, 6], [1, 5], [0, 3, 5, 0], [0, 3, 5, 3], [2, 6, 6, 0],
    [2, 6, 6, 2], [1, 5, 5, 0], [1, 5, 5, 3]];
  for (const [i, preset] of presets.entries()) {
    await vacuum.startCleaning(preset.options);
    const [mode, start, property, value] = expected[i];
    assert.deepEqual(calls.splice(0), [write(2, 4, mode), ...(property ? [write(7, property, value)] : []), ['action', action(2, start)]]);
  }
  assert.deepEqual(vacuum.getProperty('sweep:suction-state').valueList.map(v => v.description), ['Quiet', 'Standard', 'Strong', 'Turbo']);
  assert.deepEqual(vacuum.getProperty('sweep:water-state').valueList.map(v => v.description), ['Low', 'Medium', 'High']);
});

test('invalid settings fail before changing the robot', async () => {
  const { vacuum, calls } = await setup();
  for (const options of [{ vacuum: false, mop: false }, { suction: 4 }, { water: -1 }]) {
    await assert.rejects(vacuum.startCleaning(options));
  }
  assert.deepEqual(calls, []);
});

test('selected rooms use the cloud action after applying cleaning settings', async () => {
  const { vacuum, calls } = await setup();
  await vacuum.startRoomCleaning(['10', '11'], { mapId: '42', suction: 3 });
  assert.deepEqual(calls, [write(2, 4, 0), write(7, 5, 3), ['cloud', action(7, 3, ['10,11', 0, 1])]]);
});

test('unknown rooms and a changed map cannot start another area', async () => {
  const { vacuum, calls, state } = await setup();
  await assert.rejects(vacuum.startRoomCleaning(['99'], { mapId: '42' }), /room/i);
  state.mapId = 43;
  await assert.rejects(vacuum.startRoomCleaning(['10'], { mapId: '42' }), /map/i);
  await assert.rejects(vacuum.startRoomCleaning([], { mapId: '43' }), /room/i);
  assert.deepEqual(calls, []);
});

test('global and selected pause use cloud operation 2 instead of local Stop', async () => {
  const { vacuum, calls, state } = await setup();
  state.status = 5;
  await vacuum.pauseCleaning();
  assert.deepEqual(calls.at(-1), ['cloud', action(7, 3, ['', 0, 2])]);
  state.sweepType = 7;
  await vacuum.pauseCleaning({ roomIds: ['10'], mapId: '42' });
  assert.deepEqual(calls.at(-1), ['cloud', action(7, 3, ['10', 0, 2])]);
  await assert.rejects(vacuum.pauseCleaning(), /global/i);
  state.status = 4;
  await assert.rejects(vacuum.pauseCleaning({ roomIds: ['10'], mapId: '42' }), /working|cleaning/i);
  assert.equal(calls.filter(([method]) => method === 'cloud').length, 2);
});

test('resume continues a paused job without applying new settings', async () => {
  const { vacuum, calls, state } = await setup();
  state.status = 2;
  await vacuum.resumeCleaning({ mop: true, water: 2 });
  assert.deepEqual(calls.at(-1), ['action', action(2, 1)]);
  await vacuum.resumeCleaning({ roomIds: ['10'], mapId: '42' });
  assert.deepEqual(calls.at(-1), ['cloud', action(7, 3, ['10', 0, 1])]);
  state.status = 4;
  await assert.rejects(vacuum.resumeCleaning(), /paused/i);
  assert.equal(calls.some(([method]) => method === 'set_properties'), false);
});

test('dock and identify use their native commands and cloud failures propagate', async () => {
  const { vacuum, miot, calls } = await setup();
  await vacuum.goHome();
  await vacuum.identify();
  assert.deepEqual(calls.splice(0), [['action', action(3, 1)], write(4, 1, 1)]);
  miot.withMiCloudSession = async operation => operation({ miotAction: async () => { throw new Error('Cloud unavailable'); } });
  await assert.rejects(vacuum.startRoomCleaning(['10'], { mapId: '42' }), /Cloud unavailable/);
  assert.deepEqual(calls, [write(2, 4, 0)]);
});

test('known v18 notices do not become faults, but unknown codes remain visible', async () => {
  const { vacuum } = await setup();
  for (const [status, code] of [[4, 2103], [3, 2104], [5, 2110], [5, 2108], [6, 2108], [4, 2105]]) {
    vacuum.statusProp().updateInternalValue(status);
    vacuum.faultProp().updateInternalValue(code);
    assert.equal(vacuum.getOperationalStateFlags().hasFault, false);
  }
  assert.equal(vacuum.getOperationalStateFlags().isFullyCharged, true);
  vacuum.faultProp().updateInternalValue(999);
  assert.equal(vacuum.getOperationalStateFlags().hasFault, true);
  vacuum.batteryLevelProp().updateInternalValue(-1);
  assert.equal(vacuum.hasKnownBatteryLevel(), false);
});
