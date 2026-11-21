const assert = require('node:assert/strict');
const test = require('node:test');

const MiotDevice = require('../lib/protocol/MiotDevice.js');
const IjaiVacuumV18 = require('../lib/modules/robotcleaner/devices/ijai.vacuum.v18.js');

const logger = { info() {}, warn() {}, error() {}, debug() {}, deepDebug() {}, table() {} };
const action = (siid, aiid, input = []) => ['action', { did: '12345', siid, aiid, in: input }];
const write = (siid, piid, value) => ['set_properties', [{ did: '12345', siid, piid, value }]];
const get = (...ids) => ['get_properties', ids.map(([siid, piid]) => ({ did: '12345', siid, piid }))];
const mapRead = get([10, 2]);
const roomRead = ['rooms', '42'];
const ok = (params) => params.map(param => ({ ...param, code: 0 }));

async function makeVacuum(respond = (method, params) => {
  if (method === 'get_properties') return ok(params).map(row => ({ ...row, value: row.siid === 10 ? 42 : 2 }));
  if (method === 'set_properties') return ok(params);
  return { code: 0 };
}) {
  const miot = new MiotDevice('192.0.2.18', 'token', '12345', 'ijai.vacuum.v18', 'Vacuum', logger);
  // Accessory polling after an action acknowledgement is independent of the command payload.
  miot.pollProperties = async () => {};
  const calls = [];
  const sendOptions = [];
  miot.miioProtocol.send = async (_ip, method, params, options) => {
    calls.push([method, params]);
    sendOptions.push(options);
    return respond(method, params);
  };
  miot.localConnected = true;
  const vacuum = new IjaiVacuumV18(miot, 'Vacuum', logger);
  await vacuum.initDevice();
  miot.forceLocalConnection();
  return { vacuum, calls, sendOptions };
}

function mockRooms(vacuum, calls, ...ids) {
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  vacuum.setMatterRoomSource({ getRooms: async mapId => {
    calls.push(['rooms', mapId]);
    return ids.map(id => ({ id: String(id), mapId }));
  } });
  vacuum.matterRoomControl = { sendRoomCleanAction: async params => {
    calls.push(['cloud', params]);
    return { code: 0 };
  } };
}

test('v18 construction and metadata initialization send no commands', async () => {
  const { calls } = await makeVacuum();
  assert.deepEqual(calls, []);
});

test('v18 polls the active map and cleaning settings alongside existing status', async () => {
  const { vacuum } = await makeVacuum();
  const monitored = vacuum.getMiotDevice().getPropertiesToMonitor();
  for (const property of ['vacuum:status', 'map:cur-map-id', 'sweep:suction-state', 'sweep:water-state']) {
    assert.ok(monitored.includes(property), `Missing monitored property ${property}`);
  }
});

test('v18 global pause uses only cloud operation 2 after fresh global working-state checks', async () => {
  for (const [status, sweepType] of [[5, 0], [6, 0], [7, 1]]) {
    const { vacuum, calls } = await makeVacuum((method, params) => method === 'get_properties'
      ? ok(params).map(row => ({ ...row, value: row.piid === 1 ? status : sweepType })) : { code: 0 });
    vacuum.matterRoomControl = { sendRoomCleanAction: async params => { calls.push(['cloud', params]); return { code: 0 }; } };
    await vacuum.pauseCleaning();
    assert.deepEqual(calls, [get([2, 1], [2, 8]), ['cloud', action(7, 3, ['', 0, 2])[1]]]);
  }
});

test('v18 global pause rejects inactive or non-global jobs before sending a physical action', async () => {
  for (const [status, sweepType] of [[1, 0], [2, 0], [3, 0], [4, 0], [8, 0], [5, 2], [5, 3], [5, 4], [5, 5], [5, 6], [5, 7], [5, 8], [5, null]]) {
    const { vacuum, calls } = await makeVacuum((method, params) => method === 'get_properties'
      ? ok(params).map(row => ({ ...row, value: row.piid === 1 ? status : sweepType })) : { code: 0 });
    vacuum.matterRoomControl = { sendRoomCleanAction: async () => assert.fail('Unexpected global pause') };
    await assert.rejects(vacuum.pauseCleaning(), /global working job/i);
    assert.deepEqual(calls, [get([2, 1], [2, 8])]);
  }
});

test('v18 global pause never falls back after cloud timeout', async () => {
  const { vacuum, calls } = await makeVacuum((method, params) => method === 'get_properties'
    ? ok(params).map(row => ({ ...row, value: row.piid === 1 ? 5 : 0 })) : { code: 0 });
  vacuum.matterRoomControl = { sendRoomCleanAction: async params => { calls.push(['cloud', params]); throw new Error('Cloud timeout'); } };
  await assert.rejects(vacuum.pauseCleaning(), /Cloud timeout/);
  assert.deepEqual(calls, [get([2, 1], [2, 8]), ['cloud', action(7, 3, ['', 0, 2])[1]]]);
});

test('v18 legacy resume without room context uses 2/1 without writing settings', async () => {
  const { vacuum, calls } = await makeVacuum();
  vacuum.statusProp().updateInternalValue(2);
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  assert.equal(vacuum.supportsRoomResume?.(), false);
  await vacuum.resumeCleaning({ vacuum: false, mop: true });
  assert.deepEqual(calls, [get([2, 1]), action(2, 1)]);
});

test('v18 refuses to resume when there is no reported paused job', async () => {
  const { vacuum, calls } = await makeVacuum();
  vacuum.statusProp().updateInternalValue(1);
  await assert.rejects(vacuum.resumeCleaning({ roomIds: ['10'] }), /paused job/);
  assert.deepEqual(calls, []);
});

test('v18 does not resume when a fresh status read reports that the job is no longer paused', async () => {
  const { vacuum, calls } = await makeVacuum((method, params) => method === 'get_properties'
    ? ok(params).map(row => ({ ...row, value: 1 }))
    : { code: 0 });
  vacuum.statusProp().updateInternalValue(2);
  await assert.rejects(vacuum.resumeCleaning(), /paused job/);
  assert.deepEqual(calls, [get([2, 1])]);
});

test('v18 does not resume a selected room after the active map changed', async () => {
  const { vacuum, calls } = await makeVacuum((method, params) => method === 'get_properties'
    ? ok(params).map(row => ({ ...row, value: row.siid === 10 ? 43 : 2 }))
    : { code: 0 });
  vacuum.statusProp().updateInternalValue(2);
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  vacuum.matterRoomControl = { sendRoomCleanAction: async () => assert.fail('Map changed') };
  vacuum.setMatterRoomSource({ getRooms: async () => [{ id: '10', mapId: '42' }] });
  await assert.rejects(vacuum.resumeCleaning({ roomIds: ['10'], mapId: '42' }), /active map/i);
  assert.deepEqual(calls, [get([2, 1], [10, 2])]);
});

test('v18 selected room pause uses the cloud room operation after fresh working status and map checks', async () => {
  for (const status of [5, 6, 7]) {
    const { vacuum, calls } = await makeVacuum((method, params) => method === 'get_properties'
      ? ok(params).map(row => ({ ...row, value: row.siid === 10 ? 42 : status })) : { code: 0 });
    vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
    vacuum.matterRoomControl = { sendRoomCleanAction: async params => { calls.push(['cloud', params]); return { code: 0 }; } };
    await vacuum.pauseCleaning({ roomIds: [10, '12'], mapId: '42' });
    assert.deepEqual(calls, [get([2, 1], [10, 2]), ['cloud', action(7, 3, ['10,12', 0, 2])[1]]]);
  }
});

test('v18 selected room pause rejects invalid rooms, map or inactive job before physical dispatch', async () => {
  const { vacuum, calls } = await makeVacuum();
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  vacuum.matterRoomControl = { sendRoomCleanAction: async () => assert.fail('Invalid pause') };
  for (const roomIds of ['10,12', [0], ['10,12'], Array(1)]) {
    await assert.rejects(vacuum.pauseCleaning({ roomIds, mapId: '42' }), /room ID/i);
  }
  await assert.rejects(vacuum.pauseCleaning({ roomIds: ['10'], mapId: '43' }), /active map/i);
  assert.deepEqual(calls, []);
  await assert.rejects(vacuum.pauseCleaning({ roomIds: ['10'], mapId: '42' }), /working job/i);
  assert.deepEqual(calls, [get([2, 1], [10, 2])]);
});

test('v18 selected room resume revalidates room membership and sends cloud start with no settings writes', async () => {
  const { vacuum, calls } = await makeVacuum();
  vacuum.statusProp().updateInternalValue(2);
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  vacuum.setMatterRoomSource({ getRooms: async mapId => { calls.push(['rooms', mapId]); return [{ id: '10', mapId }]; } });
  vacuum.matterRoomControl = { sendRoomCleanAction: async params => { calls.push(['cloud', params]); return { code: 0 }; } };
  assert.equal(vacuum.supportsRoomResume(), true);
  await vacuum.resumeCleaning({ roomIds: ['10'], mapId: '42', vacuum: true, suction: 3 });
  assert.deepEqual(calls, [['rooms', '42'], get([2, 1], [10, 2]), ['cloud', action(7, 3, ['10', 0, 1])[1]]]);
});

test('v18 selected room resume rejects removed room membership', async () => {
  const { vacuum, calls } = await makeVacuum();
  vacuum.statusProp().updateInternalValue(2);
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  vacuum.setMatterRoomSource({ getRooms: async mapId => { calls.push(['rooms', mapId]); return []; } });
  vacuum.matterRoomControl = { sendRoomCleanAction: async () => assert.fail('Removed room') };
  await assert.rejects(vacuum.resumeCleaning({ roomIds: ['10'], mapId: '42' }), /selected room.*active map/i);
  assert.deepEqual(calls, [['rooms', '42']]);
});

test('v18 selected pause and resume never fall back after an ambiguous cloud failure', async () => {
  for (const [command, status, operation] of [['pauseCleaning', 5, 2], ['resumeCleaning', 2, 1]]) {
    const { vacuum, calls } = await makeVacuum((method, params) => method === 'get_properties'
      ? ok(params).map(row => ({ ...row, value: row.siid === 10 ? 42 : status })) : { code: 0 });
    vacuum.statusProp().updateInternalValue(status);
    vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
    vacuum.setMatterRoomSource({ getRooms: async () => [{ id: '10', mapId: '42' }] });
    vacuum.matterRoomControl = { sendRoomCleanAction: async params => { calls.push(['cloud', params]); throw new Error('Cloud timeout'); } };
    await assert.rejects(vacuum[command]({ roomIds: ['10'], mapId: '42' }), /Cloud timeout/);
    assert.deepEqual(calls, [get([2, 1], [10, 2]), ['cloud', action(7, 3, ['10', 0, operation])[1]]]);
  }
});

test('v18 selected pause and resume require a configured cloud control', async () => {
  const { vacuum, calls } = await makeVacuum();
  vacuum.statusProp().updateInternalValue(2);
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  for (const command of ['pauseCleaning', 'resumeCleaning']) {
    await assert.rejects(vacuum[command]({ roomIds: ['10'], mapId: '42' }), /cloud room control/i);
  }
  assert.deepEqual(calls, []);
});

test('v18 room discovery never makes an unbound room request without an active map', async () => {
  const { vacuum, calls } = await makeVacuum();
  vacuum.setMatterRoomSource({ getRooms: async () => assert.fail('Room discovery must reject before querying its source') });
  await assert.rejects(vacuum.discoverRooms(), /active map/i);
  assert.deepEqual(calls, []);
});

test('v18 room discovery refuses to report an empty map when offline', async () => {
  const { vacuum, calls } = await makeVacuum();
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  vacuum.getMiotDevice().localConnected = false;
  vacuum.setMatterRoomSource({ getRooms: async () => assert.fail('Room discovery must reject before querying its source') });
  await assert.rejects(vacuum.discoverRooms(), /not connected locally/i);
  assert.deepEqual(calls, []);
});

test('v18 room start sets the mode before using map room IDs as one CSV string', async () => {
  const { vacuum, calls } = await makeVacuum();
  mockRooms(vacuum, calls, 10, 12);
  await vacuum.startRoomCleaning([10, '12'], { vacuum: false, mop: true, mapId: '42' });
  assert.deepEqual(calls, [roomRead, write(2, 4, 2), mapRead, ['cloud', action(7, 3, ['10,12', 0, 1])[1]]]);
});

test('v18 room start rejects a missing, stale or unknown map before writing settings', async () => {
  const { vacuum, calls } = await makeVacuum();
  await assert.rejects(vacuum.startRoomCleaning([10], { mapId: '42' }), /active map/i);
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  await assert.rejects(vacuum.startRoomCleaning([10]), /active map/i);
  await assert.rejects(vacuum.startRoomCleaning([10], { mapId: '43' }), /active map/i);
  assert.deepEqual(calls, []);
});

test('v18 room start stops if polling detects a map change while settings are being written', async () => {
  const { vacuum, calls } = await makeVacuum((method, params) => {
    if (method === 'set_properties') {
      vacuum.getProperty('map:cur-map-id').updateInternalValue(43);
      return ok(params);
    }
    return { code: 0 };
  });
  mockRooms(vacuum, calls, 10);
  await assert.rejects(vacuum.startRoomCleaning([10], { mapId: '42' }), /active map/i);
  assert.deepEqual(calls, [roomRead, write(2, 4, 0)]);
});

test('v18 room start stops if a fresh read detects the cached active map is stale', async () => {
  const { vacuum, calls } = await makeVacuum((method, params) => {
    if (method === 'set_properties') return ok(params);
    if (method === 'get_properties') return ok(params).map(row => ({ ...row, value: 43 }));
    return { code: 0 };
  });
  mockRooms(vacuum, calls, 10);
  await assert.rejects(vacuum.startRoomCleaning([10], { mapId: '42' }), /active map/i);
  assert.deepEqual(calls, [roomRead, write(2, 4, 0), mapRead]);
});

test('v18 room start rejects a selected room that disappeared from the same map', async () => {
  const { vacuum, calls } = await makeVacuum((method, params) => {
    if (method === 'set_properties') return ok(params);
    if (method === 'get_properties') return ok(params).map(row => ({ ...row, value: 42 }));
    return { code: 0 };
  });
  mockRooms(vacuum, calls, 10);
  await assert.rejects(vacuum.startRoomCleaning([10, '12'], { mapId: '42' }), /selected room.*active map/i);
  assert.deepEqual(calls, [roomRead]);
});

test('v18 room start rejects empty or malformed input without sending commands', async () => {
  const { vacuum, calls } = await makeVacuum();
  for (const ids of [[], '10,12', ['10,12'], [10, ''], [false], [0], [256], [-1], ['01'], [1.5], Array(1)]) {
    await assert.rejects(vacuum.startRoomCleaning(ids), /room ID/i);
  }
  assert.deepEqual(calls, []);
});

test('v18 propagates a failed room start without falling back to a different action', async () => {
  const { vacuum, calls } = await makeVacuum((method, params) => {
    if (method === 'set_properties') return ok(params);
    if (method === 'get_properties') return ok(params).map(row => ({ ...row, value: 42 }));
    return { did: '12345', siid: 7, aiid: 3, code: -4006 };
  });
  mockRooms(vacuum, calls, 10);
  vacuum.matterRoomControl.sendRoomCleanAction = async params => {
    calls.push(['cloud', params]);
    return { code: -4006 };
  };
  await assert.rejects(vacuum.startRoomCleaning(['10'], { mapId: '42' }), /sweep:set-room-clean/);
  assert.deepEqual(calls, [roomRead, write(2, 4, 0), mapRead, ['cloud', action(7, 3, ['10', 0, 1])[1]]]);
});

test('v18 does not start room cleaning after a settings write is rejected', async () => {
  const { vacuum, calls } = await makeVacuum((method, params) => method === 'set_properties'
    ? [{ did: '12345', siid: params[0].siid, piid: params[0].piid, code: params[0].piid === 4 ? 0 : -4005 }]
    : { code: 0 });
  mockRooms(vacuum, calls, 10);
  await assert.rejects(vacuum.startRoomCleaning([10], { vacuum: true, mop: true, suction: 3, water: 2, mapId: '42' }), /sweep:suction-state/);
  assert.deepEqual(calls, [roomRead, write(2, 4, 1), write(7, 5, 3)]);
  assert.equal(vacuum.getProperty('sweep:suction-state').isValueInitial, true);
});

test('v18 cleaning settings send acknowledged mode, suction and water writes in order', async () => {
  const { vacuum, calls, sendOptions } = await makeVacuum();
  await vacuum.applyCleaningSettings({ vacuum: true, mop: false, suction: 0, water: 0 });
  await vacuum.applyCleaningSettings({ vacuum: true, mop: true, suction: 3, water: 2 });
  assert.deepEqual(calls, [
    write(2, 4, 0), write(7, 5, 0), write(7, 6, 0),
    write(2, 4, 1), write(7, 5, 3), write(7, 6, 2)
  ]);
  assert.ok(sendOptions.every(options => options?.retries === 0));
});

test('v18 validates all settings before it sends any write', async () => {
  const { vacuum, calls } = await makeVacuum();
  const base = { vacuum: true, mop: false };
  for (const malformed of [null, 'mop', true, []]) {
    await assert.rejects(vacuum.applyCleaningSettings(malformed), /settings object/);
  }
  for (const invalid of [
    { vacuum: false }, { vacuum: 1 }, { mop: null }, { suction: 4 }, { suction: -1 },
    { suction: '3' }, { water: 3 }, { water: -1 }, { water: 1.5 }, { water: null }
  ]) {
    await assert.rejects(vacuum.applyCleaningSettings({ ...base, ...invalid }), /mode|suction|water/i);
  }
  assert.deepEqual(calls, []);
});

test('v18 Matter presets retain their IDs and distinguish cleaning types and intensity', async () => {
  const { vacuum } = await makeVacuum();
  const presets = vacuum.getMatterCleaningPresets?.() ?? [];
  assert.deepEqual(presets.map(({ mode, label, modeTags }) => [mode, label, modeTags.map(tag => tag.value)]), [
    [0, 'Vacuum', [16385]],
    [1, 'Mop', [16386]],
    [2, 'Vacuum and Mop', [16385, 16386]],
    [3, 'Quiet Vacuum', [16385, 2]],
    [4, 'Max Suction Vacuum', [16385, 7]],
    [5, 'Low Water Mop', [16386, 6]],
    [6, 'High Water Mop', [16386, 7]],
    [7, 'Quiet Vacuum and Mop', [16385, 16386, 2]],
    [8, 'Max Suction Vacuum and Mop', [16385, 16386, 7]]
  ]);
});

test('v18 Matter presets apply only their selected settings before their cleaning action', async () => {
  const { vacuum, calls } = await makeVacuum();
  const presets = vacuum.getMatterCleaningPresets?.() ?? [];
  assert.equal(presets.length, 9);

  const expectedCalls = [
    [write(2, 4, 0), action(2, 3)],
    [write(2, 4, 2), action(2, 6)],
    [write(2, 4, 1), action(2, 5)],
    [write(2, 4, 0), write(7, 5, 0), action(2, 3)],
    [write(2, 4, 0), write(7, 5, 3), action(2, 3)],
    [write(2, 4, 2), write(7, 6, 0), action(2, 6)],
    [write(2, 4, 2), write(7, 6, 2), action(2, 6)],
    [write(2, 4, 1), write(7, 5, 0), action(2, 5)],
    [write(2, 4, 1), write(7, 5, 3), action(2, 5)]
  ];
  for (const preset of presets) {
    await vacuum.startCleaning(preset.options);
    assert.deepEqual(calls.splice(0), expectedCalls[preset.mode], preset.label);
  }
});

test('v18 whole house start applies settings then uses the requested action without fallback', async () => {
  const { vacuum, calls } = await makeVacuum((method, params) => {
    if (method === 'set_properties') return [{ did: '12345', siid: params[0].siid, piid: params[0].piid, code: 0 }];
    throw new Error('transport timeout');
  });
  await assert.rejects(vacuum.startCleaning({ vacuum: true, mop: false, suction: 3 }), /transport timeout/);
  assert.deepEqual(calls, [write(2, 4, 0), write(7, 5, 3), action(2, 3)]);
});

test('v18 docking propagates an ambiguous timeout without switching to a legacy command', async () => {
  const { vacuum, calls } = await makeVacuum(() => { throw new Error('transport timeout'); });
  await assert.rejects(vacuum.goHome(), /transport timeout/);
  assert.deepEqual(calls, [action(3, 1)]);
});

test('v18 locate propagates an ambiguous timeout without repeating the sound command', async () => {
  const { vacuum, calls, sendOptions } = await makeVacuum(() => { throw new Error('transport timeout'); });
  await assert.rejects(vacuum.identify(), /transport timeout/);
  assert.deepEqual(calls, [write(4, 1, 1)]);
  assert.deepEqual(sendOptions, [{ retries: 0 }]);
});

test('v18 knows its battery level only inside the 0 to 100 percent range', async () => {
  const { vacuum } = await makeVacuum();
  assert.equal(vacuum.hasKnownBatteryLevel(), false);
  for (const [value, known] of [[-1, false], [101, false], [null, false], [0, true], [100, true]]) {
    vacuum.batteryLevelProp().updateInternalValue(value);
    assert.equal(vacuum.hasKnownBatteryLevel(), known, `Battery reading ${value}`);
  }
});

test('v18 interprets 2105 as full charge and preserves an unknown fault code', async () => {
  const { vacuum } = await makeVacuum();
  vacuum.statusProp().updateInternalValue(4);
  vacuum.batteryLevelProp().updateInternalValue(100);
  vacuum.faultProp().updateInternalValue(2105);
  assert.equal(vacuum.getOperationalStateFlags().hasFault, false);
  assert.equal(vacuum.getOperationalStateFlags().isFullyCharged, true);
  assert.equal(vacuum.getMatterOperationalError().errorStateId, 0);

  vacuum.faultProp().updateInternalValue(2345);
  assert.equal(vacuum.getOperationalStateFlags().hasFault, true);
  assert.equal(vacuum.getMatterOperationalError().errorStateId, 2);
  assert.match(vacuum.getMatterOperationalError().errorStateDetails, /2345/);

  vacuum.faultProp().updateInternalValue(0);
  assert.equal(vacuum.getOperationalStateFlags().hasFault, false);
  assert.equal(vacuum.getMatterOperationalError().errorStateId, 0);
});


test('v18 uses its configured room source without the incomplete local room action', async () => {
  const { vacuum, calls } = await makeVacuum();
  mockRooms(vacuum, calls, 10);
  const rooms = [10, 11, 12, 13].map(id => ({ id: String(id), name: `Room ${id}`, mapId: '42' }));
  const maps = [];
  vacuum.setMatterRoomSource({ getRooms: async mapId => { maps.push(mapId); return rooms; } });
  assert.deepEqual(await vacuum.discoverRooms(), rooms);
  await vacuum.startRoomCleaning(['11'], { mapId: '42' });
  assert.deepEqual(maps, ['42', '42']);
  assert.deepEqual(calls, [write(2, 4, 0), mapRead, ['cloud', action(7, 3, ['11', 0, 1])[1]]]);
});

test('v18 cloud room errors and changes stop selected starts before any settings', async () => {
  for (const outcome of ['unavailable', 'missing', 'map-changed']) {
    const { vacuum, calls } = await makeVacuum();
    mockRooms(vacuum, calls, 10);
    vacuum.setMatterRoomSource({ getRooms: async () => {
      if (outcome === 'unavailable') throw new Error('Map access unavailable');
      if (outcome === 'map-changed') vacuum.getProperty('map:cur-map-id').updateInternalValue(43);
      return [{ id: '12', name: 'Bedroom', mapId: '42' }];
    } });
    await assert.rejects(vacuum.startRoomCleaning(['10'], { mapId: '42' }), /unavailable|active map/i);
    assert.deepEqual(calls, []);
  }
});

test('configured cloud room control sends only the selected room action, without local fallback', async () => {
  for (const reject of [false, true]) {
    const { vacuum, calls } = await makeVacuum();
    mockRooms(vacuum, calls, 10);
    const cloudCalls = [];
    vacuum.matterRoomControl = { sendRoomCleanAction: async params => {
      cloudCalls.push(params);
      if (reject) throw new Error('Cloud acknowledgement unavailable');
      return { code: 0 };
    } };
    const start = vacuum.startRoomCleaning(['10'], { mapId: '42' });
    if (reject) await assert.rejects(start, /Cloud acknowledgement unavailable/);
    else await start;
    assert.deepEqual(cloudCalls, [action(7, 3, ['10', 0, 1])[1]]);
    assert.deepEqual(calls, [roomRead, write(2, 4, 0), mapRead]);
  }
});

test('observed v18 code 2108 is informational only during vacuum or combined cleaning', async () => {
  const { vacuum } = await makeVacuum();
  vacuum.faultProp().updateInternalValue(2108);
  for (const status of [5, 6, 1, 2, 4, 7]) {
    vacuum.statusProp().updateInternalValue(status);
    const benign = [5, 6].includes(status);
    assert.equal(vacuum.getOperationalStateFlags().hasFault, !benign);
    assert.equal(vacuum.getMatterOperationalError().errorStateId, benign ? 0 : 2);
  }
});

test('observed IJAI charging notices are benign only in their corresponding dock states', async () => {
  const { vacuum } = await makeVacuum();
  for (const [fault, expectedState] of [[2103, 4], [2104, 3]]) {
    vacuum.faultProp().updateInternalValue(fault);
    for (const status of [1, 2, 3, 4, 5]) {
      vacuum.statusProp().updateInternalValue(status);
      assert.equal(vacuum.getOperationalStateFlags().hasFault, status !== expectedState);
      assert.equal(vacuum.getMatterOperationalError().errorStateId, status === expectedState ? 0 : 2);
    }
  }
});

test('observed startup notice 2110 is benign only while sweeping', async () => {
  const { vacuum } = await makeVacuum();
  vacuum.faultProp().updateInternalValue(2110);
  for (const status of [1, 2, 3, 4, 5, 6, 7]) {
    vacuum.statusProp().updateInternalValue(status);
    assert.equal(vacuum.getOperationalStateFlags().hasFault, status !== 5);
    assert.equal(vacuum.getMatterOperationalError().errorStateId, status === 5 ? 0 : 2);
  }
});

test('v18 global pause requires configured cloud control and sends no legacy stop', async () => {
  const { vacuum, calls } = await makeVacuum();
  await assert.rejects(vacuum.pauseCleaning(), /cloud room control/i);
  assert.deepEqual(calls, []);
});

test('v18 room discovery is opt-in and never publishes the incomplete local room list', async () => {
  const { vacuum, calls } = await makeVacuum(() => ({
    code: 0, out: [{ piid: 17, value: '[{"name":"room1","id":10}]' }]
  }));
  vacuum.getProperty('map:cur-map-id').updateInternalValue(42);
  vacuum.configureMatterRoomSource({ matterRoomDiscoveryMiCloud: false });
  assert.equal(vacuum.supportsRoomDiscovery({ useMiCloud: true }), false);
  await assert.rejects(vacuum.discoverRooms(), /matterRoomDiscoveryMiCloud/);
  await assert.rejects(vacuum.startRoomCleaning([10], { mapId: '42' }), /matterRoomDiscoveryMiCloud/);
  assert.deepEqual(calls, []);
});

test('v18 cloud control and opted-in discovery share a lazy standard session provider', async t => {
  const { vacuum, calls } = await makeVacuum();
  const miot = vacuum.getMiotDevice();
  const session = { userId: '56789', serviceToken: 'test-token', ssecurity: 'test-security' };
  miot.getMiCloudSession = t.mock.fn(async () => ({ country: 'ru', session }));
  vacuum.configureMatterRoomSource({});
  assert.equal(vacuum.matterRoomSource, undefined);
  assert.equal(vacuum.supportsRoomDiscovery(), false);
  assert.equal(vacuum.matterRoomControl.deviceId, '12345');
  assert.equal(miot.getMiCloudSession.mock.callCount(), 0);

  vacuum.configureMatterRoomSource({ matterRoomDiscoveryMiCloud: true });
  assert.equal(vacuum.supportsRoomDiscovery(), false);
  assert.equal(vacuum.supportsRoomDiscovery({ useMiCloud: true }), true);
  assert.equal(vacuum.matterRoomSource.deviceId, '12345');
  assert.equal(vacuum.matterRoomSource.readCredentials, vacuum.matterRoomControl.readCredentials);
  assert.equal(miot.getMiCloudSession.mock.callCount(), 0);
  assert.deepEqual(await vacuum.matterRoomControl.readCredentials(), { deviceId: '12345', country: 'ru', session });
  assert.equal(miot.getMiCloudSession.mock.callCount(), 1);
  assert.deepEqual(calls, []);
});

test('v18 can initialize local Matter controls before a usable device ID is known', async () => {
  const { vacuum, calls } = await makeVacuum();
  vacuum.getMiotDevice().deviceId = undefined;
  vacuum.configureMatterRoomSource({ matterRoomDiscoveryMiCloud: true });
  assert.equal(vacuum.supportsRoomDiscovery({ useMiCloud: true }), false);
  await assert.rejects(vacuum.discoverRooms(), /device ID/);
  await assert.rejects(vacuum.pauseCleaning(), /device ID/);
  vacuum.getMiotDevice().deviceId = '12345';
  assert.equal(vacuum.supportsRoomDiscovery({ useMiCloud: true }), true);
  assert.equal(vacuum.matterRoomControl.deviceId, '12345');
  assert.deepEqual(calls, []);
});

test('v18 cloud-only state cannot fall back to generic MiCloud for physical actions', async () => {
  const { vacuum, calls } = await makeVacuum();
  const miot = vacuum.getMiotDevice();
  miot.localConnected = false;
  miot.setRequiresMiCloud(true);
  miot.isConnectedToCloud = () => true;
  miot.miCloud = {
    miotAction: () => assert.fail('Generic cloud action must not run'),
    miotSetProps: () => assert.fail('Generic cloud settings must not run')
  };
  await assert.rejects(vacuum.goHome(), /not connected locally/);
  await assert.rejects(vacuum.startCleaning(), /not connected locally/);
  assert.deepEqual(calls, []);
});

test('v18 label metadata preserves suction and water numeric values', async () => {
  const { vacuum } = await makeVacuum();
  for (const [property, labels] of [
    ['sweep:suction-state', ['Quiet', 'Standard', 'Strong', 'Turbo']],
    ['sweep:water-state', ['Low', 'Medium', 'High']],
    ['order:suction', ['Quiet', 'Normal', 'Strong', 'Turbo']],
    ['order:water', ['Low', 'Medium', 'High']]
  ]) {
    assert.deepEqual(vacuum.getProperty(property).getValueList(), labels.map((description, value) => ({ value, description })));
  }
});
