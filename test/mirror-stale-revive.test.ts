// Regression: a stale cloud/streaming reading must not revive a mirror target
// after the source was turned off locally.
//
// Real-world failure (skylight "AC off" scene, 2026-07-23 06:40): the kitchen
// (mirror source) was turned OFF over the LAN, but the Kumo cloud lags ~7-10s and
// a stale `device_update` still reporting the kitchen as `cool` arrived a few
// seconds later. A local command does not refresh the "local authoritative"
// window (only a local poll did), so when the kitchen's local poll was starved
// during the all-units command burst that stale `cool` got APPLIED — briefly
// flipping the kitchen's cached state back to `cool`. That fired the source hook,
// and the mirror sent a REAL `cool` command to the living room, reviving it while
// the kitchen itself was (and stayed) off.
//
// Fix: a successful LOCAL command marks the unit locally-authoritative, so stale
// cloud/streaming updates are dropped for the authoritative window and never reach
// the mirror.
//
// The off itself now travels through HeaterCooler's `Active` characteristic rather
// than a Thermostat mode of OFF, which makes this regression *easier* to hit, not
// harder: an off is no longer a mode transition iOS might collapse, so scenes send
// it every time. The command on the wire is unchanged (`operationMode: 'off'`), and
// so is the window it has to arm.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Adapter, Commands, DeviceStatus, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

const SERIAL = 'TESTSOURCE01';

interface FakeLocalClient {
  calls: Array<{ serial: string; commands: Commands }>;
  hasLocalResult: boolean;
  sendCommandResult: boolean;
  hasLocal(): boolean;
  sendCommand(serial: string, commands: Commands): Promise<boolean>;
  getStatus(): Promise<Partial<DeviceStatus> | null>;
}

function makeLocalClient(over: Partial<FakeLocalClient> = {}): FakeLocalClient {
  const calls: Array<{ serial: string; commands: Commands }> = [];
  return {
    calls,
    hasLocalResult: true,
    sendCommandResult: true,
    hasLocal() { return this.hasLocalResult; },
    sendCommand(serial: string, commands: Commands) { calls.push({ serial, commands }); return Promise.resolve(this.sendCommandResult); },
    getStatus() { return Promise.resolve(null); },
    ...over,
  };
}
function makeHarness({ localClient = null }: { localClient?: FakeLocalClient | null } = {}) {
  const platform = {
    Service, Characteristic, log: makeLog(), api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
    localClient,
  };
  const kumoAPI = { subscribeToDevice() {}, onDeviceProfileUpdate() {}, sendCommand() { return Promise.resolve(true); } };
  const handler = new KumoThermostatAccessory(
    platform as never,
    makeAccessory('Kitchen', SERIAL) as never,
    kumoAPI as never,
  );
  return { handler };
}

// A cloud (streaming/polling) zone reading for the source.
const cloudZone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 24, spCool: 24, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
}) as unknown as Zone;
const localStatus = (over: Partial<DeviceStatus> = {}): Partial<DeviceStatus> => ({
  roomTemp: 24, operationMode: 'cool', power: 1, spCool: 24, spHeat: 20,
  spAuto: null, fanSpeed: 'auto', airDirection: 'auto', filterDirty: false,
  defrost: false, standby: false, ...over,
});

test('a stale cloud "cool" after a local OFF does not re-fire the mirror hook', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });

  // Source is cooling; the local-authoritative window is not currently active
  // (the local poll was starved during the command burst — modeled by priming
  // via a cloud reading, leaving lastLocalUpdateTs unset).
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1, spCool: 24 }));

  const seen: Array<{ operationMode: string; power: number }> = [];
  handler.onStatusUpdate((s) => seen.push({ operationMode: s.operationMode, power: s.power }));

  // Skylight scene turns the source OFF over the LAN. Under HeaterCooler the off
  // arrives on Active, not as a mode — TargetHeaterCoolerState has no OFF member —
  // but it is the same LAN command (`operationMode: 'off'`) and must arm the same
  // local-authoritative window.
  await handler.setActive(Characteristic.Active.INACTIVE);

  // The Kumo cloud lags and replays the pre-off "cool" state.
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1, spCool: 24 }));

  // The mirror must never observe an on-state after the off — otherwise it would
  // send a real "cool" command to the target and revive it.
  assert.ok(
    seen.length > 0 && seen.every((s) => s.operationMode === 'off' && s.power === 0),
    `mirror hook saw a phantom revive after off: ${JSON.stringify(seen)}`,
  );
});

test('a REAL local change after an OFF still fires the mirror hook (following preserved)', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });

  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1, spCool: 24 }));
  const seen: Array<{ operationMode: string; power: number }> = [];
  handler.onStatusUpdate((s) => seen.push({ operationMode: s.operationMode, power: s.power }));

  await handler.setActive(Characteristic.Active.INACTIVE);

  // A genuine local poll (e.g. someone used the wall thermostat) reads cool — the
  // mirror MUST still follow this (the fix only blocks stale *cloud* data, never
  // authoritative local reads).
  handler.updateFromLocal(localStatus({ operationMode: 'cool', power: 1, spCool: 23 }));

  assert.ok(
    seen.some((s) => s.operationMode === 'cool' && s.power === 1),
    `mirror hook should follow a real local change: ${JSON.stringify(seen)}`,
  );
});
