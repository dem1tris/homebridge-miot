const MiCloud = require('../../../protocol/MiCloud.js');
const nodeFetch = require('node-fetch');
const { decodeIjaiV18Map } = require('./IjaiMapDecoder.js');

const MAP_URL_PATHS = ['/v2/home/get_interim_file_url_pro', '/v2/home/get_interim_file_url'];
const MAX_MAP_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const COUNTRIES = new Set(['ru', 'us', 'tw', 'sg', 'cn', 'de', 'in', 'i2']);
const quietLogger = Object.freeze({ debug() {}, deepDebug() {}, info() {}, warn() {}, error() {}, table() {} });

function failure(message, code = 'XIAOMI_MAP_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isDecimalId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function isWifiSerial(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 24 && /^(?:\d+\/)?[A-Z0-9]+$/.test(value);
}

function isAuthenticationFailure(value) {
  if (value?.code === 'XIAOMI_MAP_AUTH_REQUIRED' || [401, 403].includes(Number(value?.code ?? value?.status))) return true;
  return /status (?:401|403)\b|unauthori[sz]ed|not logged in|access denied|login required|(?:session|token).*(?:expired|invalid)|invalid.*(?:session|token)/i.test(String(value?.message || ''));
}

function authenticationRequired() {
  return failure('Xiaomi map access requires a refreshed login. Refresh the configured MiCloud login before retrying.', 'XIAOMI_MAP_AUTH_REQUIRED');
}

function allowedDownloadUrl(value, base) {
  let url;
  try { url = base ? new URL(value, base) : new URL(value); } catch { throw failure('Xiaomi map download URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.fds\.api\.xiaomi\.com$/i.test(url.hostname)) {
    throw failure('Xiaomi map download must use an allowed HTTPS storage host.');
  }
  return url;
}

function roomSignature(rooms) {
  return JSON.stringify(rooms.map(room => [String(room.id), room.name, String(room.mapId)])
    .sort((left, right) => left[0].localeCompare(right[0])));
}

class IjaiCloudRooms {
  constructor({ deviceId, readCredentials, readLocal, dependencies = {} } = {}) {
    this.deviceId = String(deviceId ?? '');
    if (!isDecimalId(this.deviceId) || typeof readCredentials !== 'function' || typeof readLocal !== 'function') {
      throw failure('Cloud room discovery needs a device ID, a credentials provider and local read transport.');
    }
    this.readCredentials = readCredentials;
    this.readLocal = readLocal;
    this.dependencies = dependencies;
  }

  async getRooms(mapId) {
    const requestedMap = String(mapId ?? '');
    if (!isDecimalId(requestedMap) || Number(requestedMap) > 0xffffffff) throw failure('A valid active map ID is required.');
    const credentials = await this._readCredentials();
    const identity = await this._readIdentity(requestedMap, credentials.session.userId);
    const { cloud, requestAgent } = await this._createCloud(credentials);
    try {
      const slots = await Promise.allSettled([0, 1].map(slot => this._readSlot(cloud, credentials.session.userId, slot, identity)));
      for (const slot of slots) {
        if (slot.status === 'rejected' && isAuthenticationFailure(slot.reason)) throw authenticationRequired();
      }
      // A damaged rotating slot has no trustworthy timestamp. It can be skipped,
      // but an intact, explicitly newer empty map must never be replaced by an old roster.
      const activeMaps = slots.filter(slot => slot.status === 'fulfilled').map(slot => slot.value)
        .filter(map => map && String(map.mapId) === requestedMap && Array.isArray(map.rooms));
      const hasTimestamp = map => Number.isInteger(map.uploadedAt) && map.uploadedAt >= 0 && map.uploadedAt <= 0xffffffff;
      const maps = activeMaps.filter(hasTimestamp);
      if (!maps.length) throw failure('No valid dated Xiaomi cloud map source is available for the active map.');
      maps.sort((left, right) => right.uploadedAt - left.uploadedAt);
      const newest = maps[0];
      if (activeMaps.some(map => (!hasTimestamp(map) || map.uploadedAt === newest.uploadedAt) &&
          roomSignature(map.rooms) !== roomSignature(newest.rooms))) {
        throw failure('Conflicting Xiaomi room inventories have equal or missing upload timestamps.');
      }
      await this._assertActiveMap(requestedMap);
      return newest.rooms.map(room => ({ id: String(room.id), name: room.name, mapId: requestedMap }));
    } finally { requestAgent.destroy(); }
  }

  async _readCredentials() {
    let value;
    try {
      value = await this.readCredentials();
    } catch (error) {
      if (isAuthenticationFailure(error)) throw authenticationRequired();
      throw failure('The configured Xiaomi map credentials could not be obtained.', 'XIAOMI_MAP_CREDENTIALS');
    }
    if (String(value?.deviceId ?? '') !== this.deviceId) {
      throw failure('Xiaomi map credentials do not match the configured device.', 'XIAOMI_MAP_CREDENTIALS');
    }
    if (!COUNTRIES.has(value.country) || !isDecimalId(String(value.session?.userId ?? '')) ||
        typeof value.session?.ssecurity !== 'string' || !value.session.ssecurity ||
        typeof value.session?.serviceToken !== 'string' || !value.session.serviceToken) {
      throw failure('The configured Xiaomi map credentials are incomplete.', 'XIAOMI_MAP_CREDENTIALS');
    }
    return { ...value, session: { ...value.session, userId: String(value.session.userId) } };
  }

  async _createCloud(credentials) {
    const names = new Set([0, 1].map(slot => `${credentials.session.userId}/${this.deviceId}/${slot}`));
    const guard = (route, data) => {
      if (!MAP_URL_PATHS.includes(route) || !data || Object.keys(data).length !== 1 || !names.has(data.obj_name)) {
        throw failure('This cloud map request is not allowed.', 'XIAOMI_MAP_REQUEST_DENIED');
      }
    };
    const createRequestAgent = this.dependencies.createRequestAgent || require('../../../protocol/XiaomiApiAgent.js').createXiaomiApiAgent;
    const requestAgent = await createRequestAgent(credentials.country);
    try {
      const cloud = this.dependencies.createCloud
        ? this.dependencies.createCloud(quietLogger, guard, { requestAgent })
        : new MiCloud(quietLogger, guard, { requestAgent });
      cloud.setServiceToken(credentials.session);
      cloud.setCountry(credentials.country);
      cloud.setRequestTimeout(10000);
      return { cloud, requestAgent };
    } catch {
      requestAgent.destroy();
      throw failure('The Xiaomi cloud transport could not be prepared.');
    }
  }

  async _properties(ids) {
    const result = await this.readLocal('get_properties', ids.map(([siid, piid]) => ({ did: this.deviceId, siid, piid })));
    if (!Array.isArray(result)) throw failure('The robot did not return its local map properties.');
    return (siid, piid) => result.find(value => value.siid === siid && value.piid === piid && value.code === 0)?.value;
  }

  async _assertActiveMap(expected) {
    let property;
    try { property = await this._properties([[10, 2]]); } catch {
      throw failure('Could not confirm the active map after reading cloud rooms.');
    }
    if (String(property(10, 2)) !== expected) throw failure('The active map changed or does not match the requested map.');
  }

  async _readIdentity(expectedMap, loginUid) {
    let info;
    let property;
    try {
      info = await this.readLocal('miIO.info', []);
      property = await this._properties([[10, 2], [1, 5], [1, 3], [7, 45]]);
    } catch {
      throw failure('Could not read the local robot identity and active map.');
    }
    if (String(property(10, 2)) !== expectedMap) throw failure('The active map changed or does not match the requested map.');
    if (Array.isArray(info)) info = info[0];
    if (!info || (info.model && info.model !== 'ijai.vacuum.v18') ||
        typeof info.mac !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$|^[0-9a-f]{12}$/i.test(info.mac)) {
      throw failure('The robot did not return a valid IJAI map identity.');
    }
    const reported = String(property(7, 45) ?? '');
    const serials = [property(1, 5), property(1, 3),
      ...reported.replace(/^\[|\]$/g, '').split(',').map(part => part.replace(/"/g, '').split(';')[0].trim())];
    const wifiSn = serials.find(isWifiSerial);
    if (!wifiSn) throw failure('The robot did not return its map serial number.');
    const ownerId = reported.match(/;([1-9]\d*)"/)?.[1] || loginUid;
    return { wifiSn, ownerId, deviceId: this.deviceId, mac: info.mac };
  }

  async _mapUrl(cloud, loginUid, slot) {
    for (const route of MAP_URL_PATHS) {
      try {
        const response = await cloud.request(route, { obj_name: `${loginUid}/${this.deviceId}/${slot}` });
        if (isAuthenticationFailure(response)) throw authenticationRequired();
        if (response?.code === 0 && typeof response.result?.url === 'string' && response.result.url) return response.result.url;
      } catch (error) {
        if (isAuthenticationFailure(error)) throw authenticationRequired();
      }
    }
    throw failure('The Xiaomi cloud map URL is unavailable.');
  }

  async _readSlot(cloud, loginUid, slot, identity) {
    const url = await this._mapUrl(cloud, loginUid, slot);
    const raw = await this._download(url);
    try { return (this.dependencies.decode || decodeIjaiV18Map)(raw, identity); } catch {
      throw failure('The Xiaomi cloud map source could not be decoded.');
    }
  }

  async _download(value) {
    let url = allowedDownloadUrl(value);
    for (let redirects = 0; ; redirects++) {
      let response;
      try {
        response = await (this.dependencies.fetch || nodeFetch)(url.href, {
          redirect: 'manual', timeout: 15000, size: MAX_MAP_BYTES
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || redirects >= MAX_REDIRECTS) throw failure('Xiaomi map download redirect limit exceeded.');
          url = allowedDownloadUrl(location, url);
          continue;
        }
        if (!response.ok) throw failure('The Xiaomi map download failed.');
        const length = response.headers.get('content-length');
        if (length !== null && Number(length) > MAX_MAP_BYTES) throw failure('The Xiaomi map download is too large.');
        const data = await response.buffer();
        if (data.length > MAX_MAP_BYTES) throw failure('The Xiaomi map download is too large.');
        return data;
      } catch {
        // Fetch errors commonly embed the presigned URL. Never forward them to logs.
        throw failure('The Xiaomi cloud map download failed.');
      } finally {
        response?.body?.destroy?.();
      }
    }
  }
}

module.exports = IjaiCloudRooms;
