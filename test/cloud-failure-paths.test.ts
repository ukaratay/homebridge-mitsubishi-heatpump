// Regression tests for the cloud failure paths that composed into
// brick-until-restart.
//
// Three independent defects lined up: a token refresh that failed once was never
// re-armed, degraded mode "restarted" a poller map that `disablePolling: true`
// (what the README recommends) leaves permanently empty, and startStreaming
// reported success before the socket had connected, so a socket that never came up
// could never be reported unhealthy. A partition outlasting the 20 minute token
// lifetime therefore left the plugin unauthenticated, unstreamed and unpolled,
// while the log still said "Streaming enabled".
//
// Exercised against the compiled sources with the network stubbed out. Every test
// tears its timers down in a `finally`: a failed assertion that leaked the 15
// minute refresh timer would hang the runner instead of reporting.

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';

// `import ... = require` and not `import * as sioc`: the tests swap socket.io's
// `io` for a fake, and under esModuleInterop a namespace import of a CommonJS
// module without an `__esModule` marker (socket.io-client is one) is copied into
// a fresh object. Patching the copy would leave kumo-api.js calling the real
// `io` and dialling Mitsubishi's socket endpoint from the test suite.
import sioc = require('socket.io-client');

import { KumoAPI } from '../dist/kumo-api.js';
import { KumoV3Platform } from '../dist/platform.js';
import type { KumoThermostatAccessory } from '../dist/accessory.js';
import type { KumoConfig, SensorReading, Site, Zone } from '../dist/settings.js';
import { makeLog } from './helpers';

const SERIAL = 'TESTSERIAL001';
const SITE: Site = { id: 'site-1', name: 'Home' };
// Discovery and polling read isActive, name and adapter.deviceSerial and nothing
// else, so the payload stays at those three rather than inventing the fifteen
// adapter fields these paths never look at.
const ZONE = {
  isActive: true, name: 'Living room', adapter: { deviceSerial: SERIAL },
} as unknown as Zone;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type KumoStub =
  Pick<KumoAPI, 'destroy'>
  & Partial<Pick<KumoAPI, 'login' | 'getSites' | 'getZones' | 'startStreaming' | 'onDeviceConnectionStatusChange'>>;

/** Homebridge's `platformAccessory` constructor. Never `new`ed on these paths. */
class FakePlatformAccessory {}

function makeApi() {
  return {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s: string) => `uuid-${s}` } },
    platformAccessory: FakePlatformAccessory,
    on: () => {},
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };
}

function makePlatform(kumoStub: KumoStub, configOverrides: Partial<KumoConfig> = {}): KumoV3Platform {
  const config: PlatformConfig = {
    name: 'test',
    platform: 'KumoV3',
    username: 'user@example.com',
    password: 'secret',
    disablePolling: true,
    degradedPollInterval: 10,
    ...configOverrides,
  };
  const platform = new KumoV3Platform(makeLog() as never, config, makeApi() as never);
  (platform as unknown as { kumoAPI: KumoAPI }).kumoAPI = kumoStub as never;
  return platform;
}

/** A stand-in accessory handler that records the zone updates polling delivers. */
type HandlerStub = Pick<
  KumoThermostatAccessory, 'getDeviceSerial' | 'getSiteId' | 'updateFromZone' | 'destroy'
>;

function addHandler(platform: KumoV3Platform, serial: string, siteId: string, updates: string[]): void {
  const handler: HandlerStub = {
    getDeviceSerial: () => serial,
    getSiteId: () => siteId,
    updateFromZone: () => updates.push(serial),
    destroy: () => {},
  };
  platform['accessoryHandlers'].push(handler as never);
}

function sitePollers(platform: KumoV3Platform): Map<string, NodeJS.Timeout> {
  return platform['sitePollers'];
}

/**
 * The delay a timer was scheduled with. `_idleTimeout` is Node's internal field
 * and is absent from @types/node, but reading it is the only way to assert what
 * was scheduled without waiting the interval out.
 */
function scheduledDelay(timer: NodeJS.Timeout | null | undefined): number {
  if (!timer) {
    throw new Error('expected a scheduled timer, found none');
  }
  return (timer as unknown as { _idleTimeout: number })._idleTimeout;
}

type SocketHandler = (data?: unknown) => void;

/**
 * A stand-in for the socket.io client. `fire` does NOT catch listener errors,
 * because socket.io's own emit loop does not either: a throw escaping a handler is
 * precisely the hazard the guards under test exist for.
 */
interface FakeSocket {
  connected: boolean;
  id: string;
  on(event: string, fn: SocketHandler): FakeSocket;
  once(event: string, fn: SocketHandler): FakeSocket;
  emit(): FakeSocket;
  disconnect(): FakeSocket;
  removeAllListeners(): FakeSocket;
  fire(event: string, data?: unknown): void;
}

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, SocketHandler[]>();
  const socket: FakeSocket = {
    connected: false,
    id: 'fake-socket',
    on(event: string, fn: SocketHandler) {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event)!.push(fn);
      return socket;
    },
    once(event: string, fn: SocketHandler) {
      return socket.on(event, fn);
    },
    emit() {
      return socket;
    },
    disconnect() {
      socket.connected = false;
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
      return socket;
    },
    fire(event: string, data?: unknown) {
      for (const fn of handlers.get(event) || []) {
        fn(data);
      }
    },
  };
  return socket;
}

/** Run `fn` with socket.io's `io()` replaced by a fake socket. */
async function withFakeSocket<T>(fn: (socket: FakeSocket) => Promise<T>): Promise<T> {
  const socket = makeFakeSocket();
  const realIo = sioc.io;
  sioc.io = (() => socket) as never;
  try {
    return await fn(socket);
  } finally {
    sioc.io = realIo;
  }
}

/** A KumoAPI with its listeners wired to `socket`, which never connects. */
async function streamingApi(socket: FakeSocket): Promise<KumoAPI> {
  const api = new KumoAPI('user@example.com', 'secret', makeLog() as never);
  api['accessToken'] = 'test-token';
  const started = api.startStreaming([SERIAL]);
  socket.fire('connect_error', new Error('getaddrinfo ENOTFOUND'));
  await started;
  return api;
}

// ---- 1. token refresh must survive a single failure -----------------------

test('a failed token refresh schedules another attempt', async () => {
  const api = new KumoAPI('user@example.com', 'secret', makeLog() as never);
  let attempts = 0;
  api['refreshAccessToken'] = async () => {
    attempts++;
    return false;
  };

  api['scheduleTokenRefresh'](20);
  await delay(60);

  try {
    assert.strictEqual(attempts, 1);
    assert.ok(api['refreshTimer'], 'the refresh chain must not end on one failure');
    assert.strictEqual(scheduledDelay(api['refreshTimer']), 60000,
      'the other two call sites are on success paths, so nothing else would ever re-arm it');
  } finally {
    api.destroy();
  }
});

test('a successful token refresh does not arm the failure retry', async () => {
  // The success path schedules its own 15 minute refresh; re-arming here as well
  // would refresh the token every 60s for the life of the process.
  const api = new KumoAPI('user@example.com', 'secret', makeLog() as never);
  api['refreshAccessToken'] = async () => true;

  api['scheduleTokenRefresh'](20);
  await delay(60);

  try {
    assert.notStrictEqual(scheduledDelay(api['refreshTimer']), 60000);
  } finally {
    api.destroy();
  }
});

// ---- 2. degraded mode has to create the pollers, not just restart them ----

test('entering degraded mode starts a poller per site even with disablePolling: true', async () => {
  const updates: string[] = [];
  const kumo: KumoStub = {
    getZones: async (siteId: string) => (siteId === 'site-1'
      ? [ZONE]
      : [{ ...ZONE, adapter: { ...ZONE.adapter, deviceSerial: 'S2' } }]),
    destroy: () => {},
  };
  const platform = makePlatform(kumo, { disablePolling: true });
  addHandler(platform, SERIAL, 'site-1', updates);
  addHandler(platform, 'S2', 'site-2', updates);

  try {
    platform['enterDegradedMode']();

    assert.deepStrictEqual([...sitePollers(platform).keys()].sort(), ['site-1', 'site-2'],
      'startSitePoller had one caller, behind `if (!disablePolling)`, so this map was empty here');
    await delay(20);
    assert.deepStrictEqual(updates.sort(), ['S2', SERIAL].sort(),
      'the fallback has to actually reach the accessories, not just log "poller(s) active"');
  } finally {
    platform['cleanup']();
  }
});

test('degraded mode leaves an existing poller alone, at the degraded interval', async () => {
  const updates: string[] = [];
  const kumo: KumoStub = { getZones: async () => [ZONE], destroy: () => {} };
  const platform = makePlatform(kumo, { disablePolling: false, pollInterval: 30, degradedPollInterval: 10 });
  addHandler(platform, SERIAL, SITE.id, updates);

  try {
    platform['startSitePoller'](SITE.id);
    assert.strictEqual(scheduledDelay(sitePollers(platform).get(SITE.id)), 30000);

    platform['enterDegradedMode']();

    assert.strictEqual(sitePollers(platform).size, 1, 'no second poller for a site already polling');
    assert.strictEqual(scheduledDelay(sitePollers(platform).get(SITE.id)), 10000);
  } finally {
    platform['cleanup']();
  }
});

// ---- 3. a socket that never connects must reach the fallback --------------

test('startStreaming reports failure when the socket never connects', async () => {
  await withFakeSocket(async (socket) => {
    const api = new KumoAPI('user@example.com', 'secret', makeLog() as never);
    api['accessToken'] = 'test-token';

    const started = api.startStreaming([SERIAL]);
    socket.fire('connect_error', new Error('getaddrinfo ENOTFOUND'));

    try {
      assert.strictEqual(await started, false,
        'returning true before the socket connects is what logged "Streaming enabled" on a dead stream');
    } finally {
      api.destroy();
    }
  });
});

test('startStreaming reports success once the socket connects', async () => {
  await withFakeSocket(async (socket) => {
    const api = new KumoAPI('user@example.com', 'secret', makeLog() as never);
    api['accessToken'] = 'test-token';

    const started = api.startStreaming([SERIAL]);
    socket.connected = true;
    socket.fire('connect');

    try {
      assert.strictEqual(await started, true);
    } finally {
      api.destroy();
    }
  });
});

test('health checks run even for a socket that never connected', async () => {
  await withFakeSocket(async (socket) => {
    const api = await streamingApi(socket);

    try {
      assert.ok(api['healthCheckTimer'],
        'startHealthChecks used to be reachable only from inside the connect handler');
    } finally {
      api.destroy();
    }
    assert.strictEqual(api['healthCheckTimer'], null, 'and destroy still stops them');
  });
});

test('a socket that never connects still degrades to polling at startup', async () => {
  const updates: string[] = [];
  const kumo: KumoStub = {
    login: async () => true,
    getSites: async () => [SITE],
    getZones: async () => [ZONE],
    startStreaming: async () => false, // the socket never came up
    onDeviceConnectionStatusChange: () => {},
    destroy: () => {},
  };
  const platform = makePlatform(kumo, { disablePolling: true });
  // Pre-seed the handler so the idempotency guard skips real accessory construction.
  addHandler(platform, SERIAL, SITE.id, updates);

  try {
    const ok = await platform['attemptDiscovery']();

    assert.strictEqual(ok, true, 'a dead stream is not a discovery failure');
    assert.strictEqual(platform['isDegradedMode'], true,
      'nothing else fires a health change for a socket that was never healthy');
    assert.strictEqual(sitePollers(platform).size, 1);
    await delay(20);
    assert.deepStrictEqual(updates, [SERIAL], 'the accessory is actually being updated');
  } finally {
    platform['cleanup']();
  }
});

test('an unhealthy report degrades even without a preceding healthy report', async () => {
  const kumo: KumoStub = { getZones: async () => [ZONE], destroy: () => {} };
  const platform = makePlatform(kumo, { disablePolling: true });
  addHandler(platform, SERIAL, SITE.id, []);

  try {
    // isStreamingHealthy starts false, so the old `wasHealthy && !isHealthy` gate
    // made this transition unreachable for a socket that had never connected.
    platform['handleStreamingHealthChange'](false);

    assert.strictEqual(platform['isDegradedMode'], true);
    assert.strictEqual(sitePollers(platform).size, 1);
  } finally {
    platform['cleanup']();
  }
});

test('a routine reconnect that never comes up is still reported unhealthy', async () => {
  // The hole the other three fixes left open. reconnectStreaming sets
  // isReconnecting to suppress the "unhealthy" that its own planned disconnect
  // would otherwise produce, and that flag is cleared ONLY by becoming healthy
  // again. notifyHealthChange drops suppressed reports without replaying the edge,
  // so a socket that failed this reconnect latched the flag for the life of the
  // process: every later unhealthy report was swallowed, the platform never
  // learned streaming had died, and under `disablePolling: true` it never started
  // the fallback poller. Reachable on the ordinary 15 minute token-refresh path,
  // and 100% of the time when the socket endpoint is down while REST is up.
  const sockets: FakeSocket[] = [];
  const realIo = sioc.io;
  sioc.io = (() => {
    const socket = makeFakeSocket();
    sockets.push(socket);
    return socket;
  }) as never;

  const api = new KumoAPI('user@example.com', 'secret', makeLog() as never);
  api['accessToken'] = 'test-token';
  const health: boolean[] = [];
  api.onStreamingHealthChange((isHealthy) => health.push(isHealthy));
  api.subscribeToDevice(SERIAL, () => {});

  try {
    // A healthy socket first: without one, isReconnecting would never be set.
    const started = api.startStreaming([SERIAL]);
    sockets[0].connected = true;
    sockets[0].fire('connect');
    assert.strictEqual(await started, true);
    assert.deepStrictEqual(health, [true]);

    // The token refresh replaces the socket. The replacement never connects.
    await api.reconnectStreaming();
    assert.strictEqual(sockets.length, 2, 'the refresh built a new socket');
    sockets[1].fire('connect_error', new Error('getaddrinfo ENOTFOUND'));
    await delay(20);

    assert.deepStrictEqual(health, [true, false],
      'the platform must be told streaming died, or the fallback never starts');
    assert.strictEqual(api['isReconnecting'], false,
      'the suppression flag must not stay latched once the reconnect has failed');
  } finally {
    api.destroy();
    sioc.io = realIo;
  }
});

// ---- 4. one throwing consumer must not take down the socket --------------

test('a throwing device_update consumer does not escape into the socket emit loop', async () => {
  await withFakeSocket(async (socket) => {
    const api = await streamingApi(socket);
    const sensors: SensorReading[] = [];
    api.onSensorUpdate((reading) => sensors.push(reading));
    api.subscribeToDevice(SERIAL, () => {
      // What the consumer does on a payload it did not expect: it dereferences
      // getService(...)! on a shape nobody schema-checks.
      throw new TypeError('Cannot read properties of undefined (reading \'updateCharacteristic\')');
    });

    try {
      assert.doesNotThrow(() => socket.fire('device_update', { deviceSerial: SERIAL, roomTemp: 21 }),
        'a throw here reaches socket.io and can kill the listeners for every other event');

      socket.fire('sensor_update', { deviceSerial: SERIAL, temperature: 20.5 });
      assert.strictEqual(sensors.length, 1, 'the other listeners must still be live');
    } finally {
      api.destroy();
    }
  });
});

test('one throwing profile_update consumer does not skip the others', async () => {
  await withFakeSocket(async (socket) => {
    const api = await streamingApi(socket);
    const seen: string[] = [];
    api.onDeviceProfileUpdate(() => {
      throw new Error('accessory blew up applying the profile');
    });
    api.onDeviceProfileUpdate((serial) => seen.push(serial));

    try {
      assert.doesNotThrow(() => socket.fire('profile_update', { deviceSerial: SERIAL }));
      assert.deepStrictEqual(seen, [SERIAL], 'every remaining accessory still gets its profile');
    } finally {
      api.destroy();
    }
  });
});

// ---- 5. device_status_v2 drives reachability ------------------------------

test('device_status_v2 reports each connection change once, and a throwing consumer stays contained', async () => {
  await withFakeSocket(async (socket) => {
    const api = await streamingApi(socket);
    const seen: Array<[string, boolean]> = [];
    api.onDeviceConnectionStatusChange(() => {
      throw new Error('accessory blew up applying reachability');
    });
    api.onDeviceConnectionStatusChange((serial, connected) => seen.push([serial, connected]));

    try {
      const offline = { deviceSerial: SERIAL, status: 'disconnected', lastDisconnectedReason: 'IoT Disconnected' };
      assert.doesNotThrow(() => socket.fire('device_status_v2', offline));
      socket.fire('device_status_v2', offline); // repeated verdict: no new edge
      socket.fire('device_status_v2', { deviceSerial: SERIAL, status: 'connected' });
      assert.deepStrictEqual(seen, [[SERIAL, false], [SERIAL, true]]);
    } finally {
      api.destroy();
    }
  });
});
