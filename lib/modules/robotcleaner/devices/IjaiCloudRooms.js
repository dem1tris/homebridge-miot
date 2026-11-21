const { decodeIjaiV18Map } = require('./IjaiMapDecoder.js');

async function getIjaiRooms(cloud, deviceId, readLocal, mapId) {
  const readProperties = async ids => {
    const response = await readLocal('get_properties', ids.map(([siid, piid]) => ({ did: deviceId, siid, piid })));
    if (!Array.isArray(response)) throw new Error('Could not read IJAI map properties.');
    return ids.map(([siid, piid]) => response.find(item => item.siid === siid && item.piid === piid && item.code === 0)?.value);
  };
  const assertMap = current => {
    if (!Number.isInteger(Number(mapId)) || Number(mapId) <= 0 || String(current) !== String(mapId)) {
      throw new Error('The active IJAI map changed or is unknown.');
    }
  };
  const [currentMap, serial, alternateSerial, wifiInfo] = await readProperties([[10, 2], [1, 5], [1, 3], [7, 45]]);
  assertMap(currentMap);
  let info = await readLocal('miIO.info', []);
  if (Array.isArray(info)) info = info[0];
  const reported = String(wifiInfo ?? '');
  const serials = [serial, alternateSerial, ...reported.replace(/^\[|\]$/g, '').split(',').map(part => part.replace(/"/g, '').split(';')[0].trim())];
  const wifiSn = serials.find(value => typeof value === 'string' && /^(?:\d+\/)?[A-Z0-9]{12,24}$/.test(value));
  if (!wifiSn || !info?.mac) throw new Error('Could not read the IJAI map identity.');
  const userId = cloud.getServiceToken().userId;
  const identity = { deviceId, wifiSn, mac: info.mac, ownerId: reported.match(/;([1-9]\d*)"/)?.[1] || userId };

  // IJAI alternates between two uploaded files. Their embedded map and timestamp
  // determine which one belongs to the currently selected floor.
  const slots = await Promise.allSettled([0, 1].map(async slot => {
    const objectName = `${userId}/${deviceId}/${slot}`;
    let data;
    try {
      data = await cloud.getInterimFile(objectName, true);
    } catch {
      data = await cloud.getInterimFile(objectName);
    }
    return decodeIjaiV18Map(data, identity);
  }));
  const activeMaps = slots.filter(slot => slot.status === 'fulfilled').map(slot => slot.value)
    .filter(map => map.mapId === String(mapId));
  const maps = activeMaps.filter(map => Number.isInteger(map.uploadedAt))
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
  if (!maps.length) throw new Error('No current IJAI cloud map is available. Check the MiCloud session and region.');
  const newest = maps[0];
  const signature = map => JSON.stringify([...map.rooms].sort((a, b) => Number(a.id) - Number(b.id)));
  if (activeMaps.some(map => (map.uploadedAt === null || map.uploadedAt === newest.uploadedAt) && signature(map) !== signature(newest))) {
    throw new Error('Conflicting IJAI cloud map uploads.');
  }
  const [confirmedMap] = await readProperties([[10, 2]]);
  assertMap(confirmedMap);
  return newest.rooms;
}

module.exports = { getIjaiRooms };
