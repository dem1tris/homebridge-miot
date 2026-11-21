const MiCloud = require('../../../protocol/MiCloud.js');

const ACTION_ROUTE = '/miotspec/action';
const COUNTRIES = new Set(['ru', 'us', 'tw', 'sg', 'cn', 'de', 'in', 'i2']);
const quietLogger = Object.freeze({ debug() {}, deepDebug() {}, info() {}, warn() {}, error() {}, table() {} });

function failure(message, code = 'XIAOMI_ROOM_ACTION_FAILED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isDecimalId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function hasOnlyFields(value, fields) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every(field =>
    Object.prototype.hasOwnProperty.call(value, field) && 'value' in Object.getOwnPropertyDescriptor(value, field));
}

function isRoomAction(value, deviceId) {
  if (!hasOnlyFields(value, ['did', 'siid', 'aiid', 'in']) || value.did !== deviceId || value.siid !== 7 || value.aiid !== 3) return false;
  const input = value.in;
  if (!Array.isArray(input) || input.length !== 3 || Reflect.ownKeys(input).length !== 4 ||
      typeof input[0] !== 'string' || input[1] !== 0 || ![1, 2].includes(input[2])) return false;
  // An empty CSV is deliberately global. Only the verified pause operation may use it.
  if (input[0] === '') return input[2] === 2;
  if (!/^[1-9]\d{0,2}(?:,[1-9]\d{0,2})*$/.test(input[0])) return false;
  const ids = input[0].split(',');
  return ids.every(id => Number(id) <= 255) && new Set(ids).size === ids.length;
}

function isAuthenticationFailure(value) {
  if (value?.code === 'XIAOMI_MAP_AUTH_REQUIRED' || [value?.code, value?.status].some(code => [401, 403].includes(Number(code)))) return true;
  return /status (?:401|403)\b|unauthori[sz]ed|not logged in|access denied|login required|(?:session|token).*(?:expired|invalid)|invalid.*(?:session|token)/i.test(String(value?.message || ''));
}

function authenticationRequired() {
  return failure('Xiaomi room control requires a refreshed login. Refresh the configured MiCloud login before retrying.', 'XIAOMI_MAP_AUTH_REQUIRED');
}

class IjaiCloudRoomControl {
  constructor({ deviceId, readCredentials, dependencies = {} } = {}) {
    this.deviceId = String(deviceId ?? '');
    if (!isDecimalId(this.deviceId) || typeof readCredentials !== 'function') {
      throw failure('Cloud room control needs a device ID and a credentials provider.');
    }
    this.readCredentials = readCredentials;
    this.dependencies = dependencies;
  }

  async sendRoomCleanAction(params) {
    if (!isRoomAction(params, this.deviceId)) throw failure('This cloud room action is not allowed.', 'XIAOMI_ROOM_ACTION_DENIED');
    // Snapshot before awaiting credentials so the guarded command cannot change in flight.
    const action = Object.freeze({ did: params.did, siid: 7, aiid: 3, in: Object.freeze([...params.in]) });
    let credentials;
    try { credentials = await this.readCredentials(); } catch (error) {
      if (isAuthenticationFailure(error)) throw authenticationRequired();
      throw failure('The configured Xiaomi room control credentials could not be obtained.', 'XIAOMI_MAP_CREDENTIALS');
    }
    if (!credentials || String(credentials.deviceId) !== this.deviceId || !COUNTRIES.has(credentials.country) ||
        !isDecimalId(String(credentials.session?.userId ?? '')) ||
        typeof credentials.session?.ssecurity !== 'string' || !credentials.session.ssecurity ||
        typeof credentials.session?.serviceToken !== 'string' || !credentials.session.serviceToken) {
      throw failure('The configured Xiaomi room control credentials are incomplete or belong to another device.', 'XIAOMI_MAP_CREDENTIALS');
    }
    const guard = (route, data) => {
      if (route !== ACTION_ROUTE || !hasOnlyFields(data, ['params']) || !isRoomAction(data.params, this.deviceId) ||
          data.params.in.some((value, index) => value !== action.in[index])) {
        throw failure('This cloud room action request is not allowed.', 'XIAOMI_ROOM_ACTION_DENIED');
      }
    };
    let requestAgent;
    try {
      const createRequestAgent = this.dependencies.createRequestAgent || require('../../../protocol/XiaomiApiAgent.js').createXiaomiApiAgent;
      requestAgent = await createRequestAgent(credentials.country);
      // A 307 or 308 would repeat the physical command as another POST.
      const options = { requestAgent, requestRedirect: 'error' };
      const cloud = this.dependencies.createCloud
        ? this.dependencies.createCloud(quietLogger, guard, options)
        : new MiCloud(quietLogger, guard, options);
      cloud.setServiceToken(credentials.session);
      cloud.setCountry(credentials.country);
      cloud.setRequestTimeout(10000);
      const response = await cloud.request(ACTION_ROUTE, Object.freeze({ params: action }));
      if (isAuthenticationFailure(response) || isAuthenticationFailure(response?.result)) throw authenticationRequired();
      if (response?.code !== 0 || response.result?.code !== 0) throw failure('The Xiaomi cloud room action was not accepted.');
      return response.result;
    } catch (error) {
      if (isAuthenticationFailure(error)) throw authenticationRequired();
      // A timeout can still mean that the robot received the command. Never retry here.
      throw failure('The Xiaomi cloud room action could not be confirmed.');
    } finally { requestAgent?.destroy(); }
  }
}

module.exports = IjaiCloudRoomControl;
