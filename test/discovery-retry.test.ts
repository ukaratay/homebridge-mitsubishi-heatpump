// Regression tests for the discovery self-heal added in v1.4.1.
// Before the fix, a transient login/network failure at startup left the plugin
// idle until a manual restart, and a transient empty zones response could
// unregister every cached accessory. These tests exercise that logic against
// the compiled platform with the KumoAPI replaced by a stub (no network).

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';

import { KumoV3Platform } from '../dist/platform.js';
import type { KumoAPI } from '../dist/kumo-api.js';
import type { KumoThermostatAccessory } from '../dist/accessory.js';
import type { KumoConfig, Site, Zone } from '../dist/settings.js';
import { makeLog } from './helpers';

const SERIAL = 'TESTSERIAL001';
const SITE: Site = { id: 'site-1', name: 'Home' };
// Discovery reads isActive, name and adapter.deviceSerial and nothing else, so
// the payload stays at those three rather than inventing the fifteen adapter
// fields this path never looks at.
const ZONE = {
  isActive: true, name: 'Living room', adapter: { deviceSerial: SERIAL },
} as unknown as Zone;

type KumoStub =
  Pick<KumoAPI, 'destroy'>
  & Partial<Pick<KumoAPI, 'login' | 'getSites' | 'getZones' | 'startStreaming' | 'onDeviceConnectionStatusChange'>>;

/** A stand-in accessory handler: only what the idempotency guard calls. */
type HandlerStub = Pick<KumoThermostatAccessory, 'getDeviceSerial' | 'getSiteId' | 'destroy'>;

/** Pre-seed a handler so the idempotency guard skips real accessory construction. */
function seedHandler(platform: KumoV3Platform, serial: string, siteId: string): void {
  const handler: HandlerStub = {
    getDeviceSerial: () => serial, getSiteId: () => siteId, destroy: () => {},
  };
  platform['accessoryHandlers'].push(handler as never);
}

interface Spies {
  register: unknown[][];
  update: unknown[][];
  unregister: unknown[][];
}

/** Homebridge's `platformAccessory` constructor, as the platform `new`s it. */
class FakePlatformAccessory {
  context: Record<string, unknown> = {};
  constructor(public displayName: string, public UUID: string) {}
}

function makeApi(spies: Spies) {
  return {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: { generate: (s: string) => `uuid-${s}` },
    },
    platformAccessory: FakePlatformAccessory,
    on: () => {},
    registerPlatformAccessories: (...a: unknown[]) => spies.register.push(a),
    updatePlatformAccessories: (...a: unknown[]) => spies.update.push(a),
    unregisterPlatformAccessories: (...a: unknown[]) => spies.unregister.push(a),
  };
}

function makePlatform(kumoStub: KumoStub, configOverrides: Partial<KumoConfig> = {}) {
  const spies: Spies = { register: [], update: [], unregister: [] };
  const config: PlatformConfig = {
    name: 'test',
    platform: 'KumoV3',
    username: 'user@example.com',
    password: 'secret',
    disablePolling: true,
    ...configOverrides,
  };
  const platform = new KumoV3Platform(makeLog() as never, config, makeApi(spies) as never);
  // Swap the real API (constructed in the ctor, harmless) for our stub.
  (platform as unknown as { kumoAPI: KumoAPI }).kumoAPI = kumoStub as never;
  return { platform, spies };
}

function stopRetries(platform: KumoV3Platform): void {
  platform.discoverDevices = async () => {};
  const timer = platform['discoveryRetryTimer'];
  if (timer) {
    clearTimeout(timer);
    platform['discoveryRetryTimer'] = null;
  }
}

test('login failure schedules a retry instead of giving up', async () => {
  let loginCalls = 0;
  const stub: KumoStub = {
    login: async () => {
      loginCalls++; return false;
    },
    getSites: async () => {
      throw new Error('should not reach getSites');
    },
    destroy: () => {},
  };
  const { platform, spies } = makePlatform(stub);
  try {
    await platform.discoverDevices();
    assert.strictEqual(loginCalls, 1, 'login attempted once');
    assert.ok(platform['discoveryRetryTimer'] !== null, 'a retry timer is scheduled');
    assert.strictEqual(spies.register.length, 0, 'no accessories registered on failure');
  } finally {
    stopRetries(platform);
  }
});

test('retry actually re-invokes discovery after the backoff', async () => {
  let sitesCalls = 0;
  const stub: KumoStub = {
    login: async () => true,
    getSites: async () => {
      sitesCalls++; return [];
    }, // "no sites" -> retry
    destroy: () => {},
  };
  const { platform } = makePlatform(stub);
  platform['discoveryRetryDelayMs'] = 20; // shrink backoff for the test
  try {
    await platform.discoverDevices();
    await new Promise((r) => setTimeout(r, 130));
    assert.ok(sitesCalls >= 2, `discovery re-fired (getSites called ${sitesCalls}x)`);
  } finally {
    stopRetries(platform);
  }
});

test('successful discovery clears the retry timer and resets backoff', async () => {
  const stub: KumoStub = {
    login: async () => true,
    getSites: async () => [SITE],
    getZones: async () => [ZONE],
    startStreaming: async () => true,
    onDeviceConnectionStatusChange: () => {},
    destroy: () => {},
  };
  const { platform } = makePlatform(stub);
  seedHandler(platform, SERIAL, SITE.id);
  platform['discoveryRetryDelayMs'] = 99999; // pretend we had backed off
  try {
    await platform.discoverDevices();
    assert.strictEqual(platform['discoveryRetryTimer'], null, 'no retry scheduled on success');
    assert.strictEqual(platform['discoveryRetryDelayMs'], platform['discoveryRetryBaseMs'], 'backoff reset');
  } finally {
    stopRetries(platform);
  }
});

test('idempotent: an already-handled device is not re-registered', async () => {
  const stub: KumoStub = {
    login: async () => true,
    getSites: async () => [SITE],
    getZones: async () => [ZONE],
    startStreaming: async () => true,
    onDeviceConnectionStatusChange: () => {},
    destroy: () => {},
  };
  const { platform, spies } = makePlatform(stub);
  seedHandler(platform, SERIAL, SITE.id);
  try {
    await platform.discoverDevices();
    assert.strictEqual(spies.register.length, 0, 'existing handler -> no duplicate registration');
    assert.strictEqual(platform['discoveryRetryTimer'], null, 'discovery treated as success');
  } finally {
    stopRetries(platform);
  }
});

test('transient empty zones does NOT unregister cached accessories', async () => {
  const stub: KumoStub = {
    login: async () => true,
    getSites: async () => [SITE],
    getZones: async () => [], // transient failure returns no zones
    startStreaming: async () => true,
    onDeviceConnectionStatusChange: () => {},
    destroy: () => {},
  };
  const { platform, spies } = makePlatform(stub);
  // A cached accessory that would have been wiped by the old "stale" sweep.
  platform.accessories.push(new FakePlatformAccessory('Cached', 'uuid-OTHER') as never);
  try {
    await platform.discoverDevices();
    assert.strictEqual(spies.unregister.length, 0, 'cached accessories preserved on transient empty result');
    assert.ok(platform['discoveryRetryTimer'] !== null, 'empty result triggers a retry');
  } finally {
    stopRetries(platform);
  }
});
