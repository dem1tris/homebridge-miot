const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

const COUNTRIES = new Set(['ru', 'us', 'tw', 'sg', 'cn', 'de', 'in', 'i2']);
const DEADLINE_MS = 2000;
const MAX_ADDRESSES = 8;
const MAX_TLS_ROUNDS = 3;

function unavailable(message) {
  const error = new Error(message);
  error.code = 'XIAOMI_API_UNAVAILABLE';
  return error;
}

function resolveAddresses(hostname, resolve4, setTimer, clearTimer) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, addresses) => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      if (error) reject(unavailable('Xiaomi API DNS lookup failed or timed out.'));
      else resolve(addresses);
    };
    const timer = setTimer(() => finish(true), DEADLINE_MS);
    Promise.resolve().then(() => resolve4(hostname)).then(addresses => finish(false, addresses), () => finish(true));
  });
}

function createSocketPool(hostname, addresses, connect, setTimer, clearTimer) {
  let destroyed = false;
  const activeRounds = new Set();
  const ownedSockets = new Set();
  const runRound = () => new Promise((resolve, reject) => {
    let finished = false;
    let remaining = addresses.length;
    let winner;
    const probes = [];
    const cleanup = (probe, keepSocket = false) => {
      if (probe.timer !== undefined) clearTimer(probe.timer);
      if (probe.socket) {
        probe.socket.removeListener('secureConnect', probe.onSecure);
        probe.socket.removeListener('close', probe.onClose);
        // Keep the error listener: destroying a socket can deliver late errors.
        if (!keepSocket) probe.socket.destroy();
      }
    };
    const cancel = () => {
      if (finished) return;
      finished = true;
      activeRounds.delete(cancel);
      for (const probe of probes) cleanup(probe);
      reject(unavailable('The Xiaomi API agent was closed.'));
    };
    activeRounds.add(cancel);
    const fail = probe => {
      if (finished || probe.done) return;
      probe.done = true;
      cleanup(probe);
      if (--remaining === 0) {
        finished = true;
        activeRounds.delete(cancel);
        reject(unavailable('No Xiaomi API address completed a verified TLS connection.'));
      }
    };
    for (const address of addresses) {
      const probe = { done: false };
      probes.push(probe);
      probe.onClose = () => fail(probe);
      probe.onSecure = () => {
        if (finished || probe.done) return;
        if (probe.socket.authorized !== true) { fail(probe); return; }
        finished = true;
        winner = probe;
        activeRounds.delete(cancel);
        ownedSockets.add(probe.socket);
        probe.socket.once('close', () => ownedSockets.delete(probe.socket));
        for (const active of probes) cleanup(active, active === probe);
        resolve({ socket: probe.socket, address });
      };
      try {
        probe.socket = connect({ host: address, port: 443, family: 4,
          servername: hostname, rejectUnauthorized: true });
        probe.socket.on('error', () => {
          if (winner === probe) probe.socket.destroy();
          else fail(probe);
        });
        probe.socket.once('close', probe.onClose);
        probe.socket.once('secureConnect', probe.onSecure);
        probe.timer = setTimer(() => fail(probe), DEADLINE_MS);
      } catch {
        fail(probe);
      }
    }
  });
  return {
    get destroyed() { return destroyed; },
    async acquire() {
      for (let round = 0; round < MAX_TLS_ROUNDS; round++) {
        if (destroyed) throw unavailable('The Xiaomi API agent was closed.');
        try { return await runRound(); } catch (error) {
          if (destroyed || round === MAX_TLS_ROUNDS - 1) throw error;
        }
      }
    },
    release(socket) { ownedSockets.delete(socket); },
    discard(socket) { ownedSockets.delete(socket); socket.destroy(); },
    destroy() {
      destroyed = true;
      for (const cancel of [...activeRounds]) cancel();
      for (const socket of ownedSockets) socket.destroy();
      ownedSockets.clear();
    }
  };
}

function socketIsReady(socket) {
  return socket && socket.authorized === true && !socket.destroyed && !socket.closed &&
    !socket.readableEnded && !socket.writableEnded && socket.writable !== false;
}

class XiaomiApiAgent extends https.Agent {
  constructor(hostname, warm, pool, normalLookup) {
    super({
      keepAlive: false,
      rejectUnauthorized: true,
      lookup(requestedHostname, options, callback) {
        if (requestedHostname !== hostname) {
          if (typeof options === 'function') return normalLookup(requestedHostname, options);
          return normalLookup(requestedHostname, options, callback);
        }
        if (typeof options === 'function') { callback = options; options = {}; }
        queueMicrotask(() => {
          if (options?.all) callback(null, [{ address: warm.address, family: 4 }]);
          else callback(null, warm.address, 4);
        });
      }
    });
    this.apiHostname = hostname;
    this.warmConnection = warm;
    this.socketPool = pool;
  }

  createConnection(options, callback) {
    if (this.socketPool.destroyed) {
      queueMicrotask(() => callback(unavailable('The Xiaomi API agent was closed.')));
      return;
    }
    if ((options.host || options.hostname) !== this.apiHostname || Number(options.port || 443) !== 443 || options.socketPath) {
      return super.createConnection(options, callback);
    }
    if (options.servername !== undefined && options.servername !== this.apiHostname) {
      queueMicrotask(() => callback(unavailable('The Xiaomi API TLS server name does not match.')));
      return;
    }
    const warm = this.warmConnection;
    this.warmConnection = null;
    // Node's HTTP Agent does not hand the socket to ClientRequest until this callback.
    // Reuse the exact verified TLS connection; reconnecting to its IP can stall again.
    Promise.resolve().then(async () => {
      if (this.socketPool.destroyed) throw unavailable('The Xiaomi API agent was closed.');
      if (socketIsReady(warm?.socket)) return warm;
      if (warm?.socket) this.socketPool.discard(warm.socket);
      return this.socketPool.acquire();
    }).then(connection => {
      if (this.socketPool.destroyed || !socketIsReady(connection.socket)) {
        this.socketPool.discard(connection.socket);
        callback(unavailable('The Xiaomi API TLS connection closed before the request.'));
        return;
      }
      this.socketPool.release(connection.socket);
      callback(null, connection.socket);
    }, error => callback(error));
  }

  destroy() {
    this.socketPool.destroy();
    this.warmConnection = null;
    super.destroy();
  }
}

async function createXiaomiApiAgent(country, dependencies = {}) {
  if (!COUNTRIES.has(country)) throw unavailable('A supported Xiaomi API country is required.');
  const hostname = country === 'cn' ? 'api.io.mi.com' : `${country}.api.io.mi.com`;
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  const resolved = await resolveAddresses(hostname, dependencies.resolve4 || dns.promises.resolve4.bind(dns.promises), setTimer, clearTimer);
  const addresses = [...new Set(Array.isArray(resolved) ? resolved.filter(address => typeof address === 'string' && net.isIPv4(address)) : [])].slice(0, MAX_ADDRESSES);
  if (!addresses.length) throw unavailable('Xiaomi API DNS returned no usable IPv4 addresses.');
  // Only TLS is retried. No application bytes are sent until HTTP receives a winner.
  const pool = createSocketPool(hostname, addresses, dependencies.tlsConnect || tls.connect, setTimer, clearTimer);
  try {
    const warm = await pool.acquire();
    return new XiaomiApiAgent(hostname, warm, pool, dependencies.lookup || dns.lookup);
  } catch (error) {
    pool.destroy();
    throw error;
  }
}

module.exports = { createXiaomiApiAgent };
