// Regression tests for adapter reachability -> HomeKit "No Response".
//
// Ported from upstream homebridge-mitsubishi-comfort (test/reachability.test.js,
// 7941fe1) and rewritten for the HeaterCooler service. Observed upstream on
// 2026-09-10: a unit's Wi-Fi adapter dropped off the network for ~22h while the
// cloud kept serving its last known state (`cool, power=1`) from a frozen shadow
// record, so HomeKit showed a confident, wrong tile and every `off` an automation
// sent returned HTTP 200 while reaching nothing. The cloud reported the outage the
// whole time through `device_status_v2`; nothing was listening.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Commands, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

const SERIAL = 'TESTSERIAL001';

// Mirrors homebridge's hap namespace closely enough to exercise the real path.
class HapStatusError extends Error {
  constructor(public hapStatus: number) {
    super(`HAP status ${hapStatus}`);
  }
}
const hap = { HapStatusError, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } };

function makeHarness({ localSerials = [] as string[], withHap = true } = {}) {
  const sent: Commands[] = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: withHap ? { updatePlatformAccessories() {}, hap } : { updatePlatformAccessories() {} },
    kumoConfig: {},
    localClient: {
      hasLocal: (serial: string) => localSerials.includes(serial),
      sendCommand: async () => true,
    },
  };
  let sensorCb: ((reading: Record<string, unknown>) => void) | null = null;
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    onSensorUpdate(cb: (reading: Record<string, unknown>) => void) {
      sensorCb = cb;
    },
    sendCommand: async (_serial: string, commands: Commands) => {
      sent.push(commands);
      return true;
    },
    getDeviceStatus: async () => null,
  };
  const accessory = makeAccessory('Rear bedroom');
  const handler = new KumoThermostatAccessory(platform as never, accessory as never, kumoAPI as never, 30);
  const heaterCooler = accessory.getService(Service.HeaterCooler)!;
  const value = (id: unknown) => heaterCooler.getCharacteristic(id).value;
  const sensor = (reading: Record<string, unknown>) => sensorCb!({ deviceSerial: SERIAL, ...reading });
  return { handler, value, sent, sensor };
}

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 26.5, spCool: 24.5, spHeat: 23.5, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

test('an adapter the cloud reports offline goes No Response instead of serving stale state', async () => {
  const { handler, value } = makeHarness();
  handler.updateFromZone(zone());

  // Baseline: reachable, real values published.
  assert.strictEqual(value(Characteristic.CurrentTemperature), 26.5);
  assert.strictEqual(await handler.getCurrentTemperature(), 26.5);

  handler.setCloudConnected(false);

  assert.strictEqual(handler.isReachable(), false);
  await assert.rejects(() => handler.getCurrentTemperature(), 'getter throws while unreachable');
  await assert.rejects(() => handler.getActive(), 'Active getter throws too');
  await assert.rejects(() => handler.getRotationSpeed(), 'so does the linked fan');

  // The error is pushed immediately rather than waiting for HomeKit to read.
  const pushed = value(Characteristic.CurrentHeaterCoolerState) as HapStatusError;
  assert.ok(pushed instanceof Error, 'No Response pushed to the characteristic');
  assert.strictEqual(pushed.hapStatus, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
});

test('a stale shadow replay does NOT repaint the tile while the adapter is offline', async () => {
  // The upstream failure: the unit was physically OFF but the cloud kept replaying
  // `cool, power=1`. That must not reach HomeKit as if it were live.
  const { handler, value } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  handler.setCloudConnected(false);

  handler.updateFromZone(zone({ operationMode: 'cool', power: 1 }));

  assert.ok(value(Characteristic.Active) instanceof Error, 'stale replay left the tile in No Response');
});

test('a wireless-sensor reading does not paint over No Response, and recovery publishes it', async () => {
  const { handler, value, sensor } = makeHarness();
  handler.updateFromZone(zone());
  handler.setCloudConnected(false);

  sensor({ temperature: 21.7 });
  assert.ok(value(Characteristic.CurrentTemperature) instanceof Error, 'still No Response');

  handler.setCloudConnected(true);
  assert.strictEqual(value(Characteristic.CurrentTemperature), 21.7, 'the cached reading is published');
});

test('recovery republishes real state and clears No Response', async () => {
  const { handler, value } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  handler.setCloudConnected(false);
  assert.ok(value(Characteristic.Active) instanceof Error);

  handler.setCloudConnected(true);

  assert.strictEqual(handler.isReachable(), true);
  assert.strictEqual(value(Characteristic.Active), Characteristic.Active.INACTIVE);
  assert.strictEqual(value(Characteristic.CurrentTemperature), 26.5);
  assert.strictEqual(await handler.getCurrentTemperature(), 26.5, 'getters serve values again');
});

test('local LAN control keeps a unit reachable even when the cloud calls it offline', async () => {
  const { handler } = makeHarness({ localSerials: [SERIAL] });
  handler.updateFromZone(zone());

  handler.setCloudConnected(false);

  assert.strictEqual(handler.isReachable(), true);
  assert.strictEqual(await handler.getCurrentTemperature(), 26.5);
});

test('writes still go out while the cloud calls the adapter offline, and the tile stays No Response', async () => {
  // Upstream removed this signal once (8b54033) because device_status_v2 reported
  // units offline that were not. Rejecting writes on it would turn that false
  // positive into "the AC will not turn off", so setters are never guarded.
  const { handler, value, sent } = makeHarness();
  handler.updateFromZone(zone());
  handler.setCloudConnected(false);

  await handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
  await handler.setActive(Characteristic.Active.INACTIVE);

  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }, { operationMode: 'off' }]);
  assert.ok(value(Characteristic.Active) instanceof Error, 'the optimistic echo does not clear No Response');
  await assert.rejects(() => handler.getActive(), 'reads still report No Response');
});

test('a device that has never reported status is treated as reachable', async () => {
  // null (nothing reported yet) must not flash No Response at startup.
  const { handler } = makeHarness();
  assert.strictEqual(handler.isReachable(), true);
  handler.updateFromZone(zone());
  assert.strictEqual(await handler.getCurrentTemperature(), 26.5);
});

test('reachability still degrades correctly without hap on the platform api', async () => {
  const { handler } = makeHarness({ withHap: false });
  handler.updateFromZone(zone());
  handler.setCloudConnected(false);
  await assert.rejects(() => handler.getCurrentTemperature(), 'still throws without hap');
});
