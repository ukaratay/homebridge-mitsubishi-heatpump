// A unit marked offline must come back when the cloud says it is connected again.
//
// Ported from upstream homebridge-mitsubishi-comfort (test/offline-recheck.test.js,
// db11496). Seen here 2026-11-02: a few seconds after the plugin's own stream
// reconnected, the cloud pushed every unit as offline (reason WEBSOCKET_CLOSED) and
// never pushed "connected" again, so all four showed No Response for 25 hours while
// commands kept landing. While a unit is marked offline the plugin now re-asks for
// its status every minute; asked directly, the cloud answers within a second.

import test from 'node:test';
import assert from 'node:assert';

import { KumoAPI } from '../dist/kumo-api.js';

const SERIAL = '5234P009H100443F';

type Internals = Record<string, unknown> & {
  handleDeviceStatus(data: { deviceSerial?: string; status?: string; lastDisconnectedReason?: string }): void;
  recheckOfflineDevices(): void;
};

function makeApi() {
  const logs: { warn: string[]; info: string[] } = { warn: [], info: [] };
  const log = {
    info: (m: string) => logs.info.push(m),
    warn: (m: string) => logs.warn.push(m),
    error() {},
    debug() {},
  };
  const api = new KumoAPI('user@example.com', 'pw', log as never, false, true);
  const internals = api as unknown as Internals;
  const emits: unknown[][] = [];
  internals.socket = { emit: (...args: unknown[]) => emits.push(args) };
  const changes: Array<[string, boolean]> = [];
  api.onDeviceConnectionStatusChange((serial, connected) => changes.push([serial, connected]));
  return { api: internals, emits, changes, logs };
}

test('an offline unit is re-asked about, and comes back when the cloud says connected', () => {
  const { api, emits, changes, logs } = makeApi();
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected', lastDisconnectedReason: 'WEBSOCKET_CLOSED' });
  assert.deepStrictEqual(changes, [[SERIAL, false]]);

  api.recheckOfflineDevices();
  assert.deepStrictEqual(emits, [['device_status_v2', SERIAL]], 'asks about the offline unit');

  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'connected' });
  assert.deepStrictEqual(changes, [[SERIAL, false], [SERIAL, true]], 'reachable again');
  assert.ok(logs.info.some((m) => m.includes('reported online again')));

  api.lastOfflineRecheck = 0;
  api.recheckOfflineDevices();
  assert.strictEqual(emits.length, 1, 'nothing to re-ask once every unit is connected');
});

test('re-asking is limited to once a minute', () => {
  const { api, emits } = makeApi();
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected' });
  api.recheckOfflineDevices();
  api.recheckOfflineDevices(); // the 30s health tick, too soon
  assert.strictEqual(emits.length, 1);
  api.lastOfflineRecheck = Date.now() - 61000; // a minute later
  api.recheckOfflineDevices();
  assert.strictEqual(emits.length, 2);
});

test('the offline warning is logged once, not on every answer while it stays offline', () => {
  const { api, logs, changes } = makeApi();
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected' });
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected' });
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected' });
  assert.strictEqual(logs.warn.filter((m) => m.includes('reported offline')).length, 1);
  assert.strictEqual(changes.length, 1, 'one change, one callback');
});
