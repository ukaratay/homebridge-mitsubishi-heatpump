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
import type { Commands, DeviceProfile, KumoConfig, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory, type FakeService } from './helpers';

const SERIAL = 'TESTSERIAL001';

// Mirrors homebridge's hap namespace closely enough to exercise the real path.
class HapStatusError extends Error {
  constructor(public hapStatus: number) {
    super(`HAP status ${hapStatus}`);
  }
}
const hap = { HapStatusError, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } };

function makeHarness({
  localSerials = [] as string[], withHap = true, kumoConfig = {} as Partial<KumoConfig>,
  accessory = makeAccessory('Rear bedroom'),
} = {}) {
  const sent: Commands[] = [];
  let profileCb: ((serial: string, profile: Partial<DeviceProfile>) => void) | null = null;
  let streamCb: ((serial: string, data: Record<string, unknown>) => void) | null = null;
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: withHap ? { updatePlatformAccessories() {}, hap } : { updatePlatformAccessories() {} },
    kumoConfig,
    localClient: {
      hasLocal: (serial: string) => localSerials.includes(serial),
      sendCommand: async () => true,
    },
  };
  let sensorCb: ((reading: Record<string, unknown>) => void) | null = null;
  const kumoAPI = {
    subscribeToDevice(_serial: string, cb: (serial: string, data: Record<string, unknown>) => void) {
      streamCb = cb;
    },
    onDeviceProfileUpdate(cb: (serial: string, profile: Partial<DeviceProfile>) => void) {
      profileCb = cb;
    },
    onSensorUpdate(cb: (reading: Record<string, unknown>) => void) {
      sensorCb = cb;
    },
    sendCommand: async (_serial: string, commands: Commands) => {
      sent.push(commands);
      return true;
    },
    getDeviceStatus: async () => null,
  };
  const handler = new KumoThermostatAccessory(platform as never, accessory as never, kumoAPI as never, 30);
  const heaterCooler = accessory.getService(Service.HeaterCooler)!;
  const value = (id: unknown) => heaterCooler.getCharacteristic(id).value;
  const sensor = (reading: Record<string, unknown>) => sensorCb!({ deviceSerial: SERIAL, ...reading });
  // A profile for a fully equipped unit, so every optional service is created.
  const applyProfile = () => profileCb!(SERIAL, {
    minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
    maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
    hasModeHeat: true, hasModeDry: true, hasModeVent: true,
    hasVaneDir: true, hasVaneSwing: true, hasFanSpeedAuto: true,
  });
  // A device_update as the cloud's stream delivers it.
  const stream = (data: Record<string, unknown>) => streamCb!(SERIAL, {
    deviceSerial: SERIAL, roomTemp: 26.5, spHeat: 23.5, spCool: 24.5, power: 1, operationMode: 'cool',
    fanSpeed: 'low', airDirection: 'vertical', humidity: null, ...data,
  });
  return { handler, value, sent, sensor, accessory, heaterCooler, applyProfile, stream };
}

const ALL_SERVICES: Partial<KumoConfig> = {
  showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true,
};

/**
 * Every characteristic the accessory shows a value on, across all its services.
 * `chars` is the fake's record of what the plugin actually reached for.
 */
function shownValues(h: ReturnType<typeof makeHarness>): Array<[string, unknown]> {
  const fan = h.accessory.getServiceById(Service.Fanv2, 'airflow')!;
  const pick = (label: string, svc: FakeService | null, ids: unknown[]): Array<[string, unknown]> =>
    svc ? ids.map((id) => [`${label}.${(id as { _name: string })._name}`, svc.chars.get(id)?.value]) : [];
  const C = Characteristic;
  return [
    ...pick('climate', h.heaterCooler, [
      C.Active, C.CurrentHeaterCoolerState, C.TargetHeaterCoolerState, C.CurrentTemperature,
      C.HeatingThresholdTemperature, C.CoolingThresholdTemperature, C.SwingMode,
    ]),
    ...pick('fan', fan, [C.Active, C.CurrentFanState, C.RotationSpeed, C.TargetFanState]),
    ...['fan-only', 'dry'].flatMap((subtype) =>
      pick(subtype, h.accessory.getServiceById(Service.Switch, subtype), [C.On])),
    ...pick('slats', h.accessory.getService(Service.Slats),
      [C.CurrentSlatState, C.CurrentTiltAngle, C.TargetTiltAngle]),
    ...pick('filter', h.accessory.getService(Service.FilterMaintenance), [C.FilterChangeIndication]),
  ];
}

// Queued fan and vane writes land on the next tick.
const tick = () => new Promise((r) => setTimeout(r, 5));

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

// ---- every tile, not only the climate one -----------------------------------
//
// Found live by upstream during its 2.0 rollout (rear bedroom, 2026-09-27,
// homebridge-mitsubishi-comfort 8b65144): an offline unit's fan tile read "on and
// blowing" from the cloud's frozen record, beside a climate tile showing No
// Response. Our climate tile was gated; the fan, the vane, the switches and the
// filter were not.

test('going offline puts No Response on every service the unit has', async () => {
  const h = makeHarness({ kumoConfig: ALL_SERVICES });
  h.applyProfile();
  h.stream({ displayConfig: { filter: true } });     // creates the filter indicator too
  const before = shownValues(h);
  assert.strictEqual(before.length, 17, 'every optional service is present');
  assert.deepStrictEqual(before.filter(([, v]) => v === undefined || v instanceof Error), [],
    'and every one of them is showing a real value');

  h.handler.setCloudConnected(false);

  const stillLive = shownValues(h).filter(([, v]) => !(v instanceof Error)).map(([name]) => name);
  assert.deepStrictEqual(stillLive, [], 'no tile keeps its last value');
  await assert.rejects(() => h.handler.getFilterChangeIndication(), 'the filter indicator reads No Response too');
});

test('recovery puts a real value back on every one of them', async () => {
  // In fan auto and vane auto on purpose: neither has a slider position or a
  // tilt angle of its own, which is where a value is easiest to leave unrestored.
  const h = makeHarness({ kumoConfig: ALL_SERVICES });
  h.applyProfile();
  h.stream({ fanSpeed: 'auto', airDirection: 'auto', displayConfig: { filter: true } });
  h.handler.setCloudConnected(false);

  h.handler.setCloudConnected(true);

  const stuck = shownValues(h).filter(([, v]) => v instanceof Error).map(([name]) => name);
  assert.deepStrictEqual(stuck, [], 'nothing is left in No Response');
  assert.strictEqual(
    h.accessory.getService(Service.FilterMaintenance)!.chars.get(Characteristic.FilterChangeIndication)?.value,
    Characteristic.FilterChangeIndication.CHANGE_FILTER,
  );
});

// The profile is delivered by its own stream event and builds the optional
// services. Arriving for a unit that is already offline, each of those setups
// pushed a value from the frozen record: this is the path upstream hit.
test('a profile that arrives while the unit is offline paints nothing over No Response', async () => {
  const h = makeHarness({ kumoConfig: ALL_SERVICES });
  h.stream({ fanSpeed: 'auto', airDirection: 'auto' });
  h.handler.setCloudConnected(false);

  h.applyProfile();
  // And the cloud replaying its frozen record, which creates the filter indicator.
  h.stream({ fanSpeed: 'auto', airDirection: 'auto', displayConfig: { filter: true } });

  assert.ok(h.accessory.getService(Service.FilterMaintenance), 'the filter indicator was created');
  const live = shownValues(h).filter(([, v]) => !(v instanceof Error)).map(([name]) => name);
  assert.deepStrictEqual(live, [], 'the services created while offline read No Response as well');
});

// Setters still send while a unit is offline, on purpose (see the test above). A
// successful one used to echo the fan or vane back onto its tile.
test('a fan or vane write to an offline unit is sent but does not repaint its tile', async () => {
  const h = makeHarness({ kumoConfig: ALL_SERVICES });
  h.applyProfile();
  h.stream({});
  h.handler.setCloudConnected(false);

  await h.handler.setRotationSpeed(100);
  await h.handler.setSwingMode(Characteristic.SwingMode.SWING_ENABLED);
  await tick();

  // The vane write goes out at once; the fan write is queued to the next tick.
  assert.deepStrictEqual(h.sent, [{ vaneDir: 'swing' }, { fanSpeed: 'superPowerful' }]);
  const live = shownValues(h).filter(([, v]) => !(v instanceof Error)).map(([name]) => name);
  assert.deepStrictEqual(live, []);
});

// Gating the push must not gate the memory: what the unit was last told is what
// "swing off" and "fan manual" go back to once it is reachable again.
test('what was set while offline is still remembered afterwards', async () => {
  const h = makeHarness({ kumoConfig: ALL_SERVICES });
  h.applyProfile();
  h.stream({ fanSpeed: 'auto', airDirection: 'auto' });
  h.handler.setCloudConnected(false);
  await h.handler.setTargetTiltAngle(90);          // vertical
  await h.handler.setRotationSpeed(100);           // superPowerful
  await tick();
  h.handler.setCloudConnected(true);
  h.sent.length = 0;

  await h.handler.setSwingMode(Characteristic.SwingMode.SWING_ENABLED);
  await tick();
  await h.handler.setSwingMode(Characteristic.SwingMode.SWING_DISABLED);
  await h.handler.setTargetFanState(Characteristic.TargetFanState.AUTO);
  await tick();
  await h.handler.setTargetFanState(Characteristic.TargetFanState.MANUAL);
  await tick();

  assert.deepStrictEqual(h.sent, [
    { vaneDir: 'swing' }, { vaneDir: 'vertical' }, { fanSpeed: 'auto' }, { fanSpeed: 'superPowerful' },
  ]);
});

// The same, without waiting for recovery: writes keep going out while the unit
// is offline, and each has to build on the one before it.
test('a write made while offline is remembered by the next one made while offline', async () => {
  const h = makeHarness({ kumoConfig: ALL_SERVICES });
  h.applyProfile();
  h.stream({ fanSpeed: 'auto', airDirection: 'auto' });
  h.handler.setCloudConnected(false);

  await h.handler.setRotationSpeed(100);           // superPowerful
  await tick();
  await h.handler.setTargetFanState(Characteristic.TargetFanState.AUTO);
  await tick();
  await h.handler.setTargetFanState(Characteristic.TargetFanState.MANUAL);   // back to superPowerful
  await tick();

  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'superPowerful' }, { fanSpeed: 'auto' }, { fanSpeed: 'superPowerful' }]);
});

// The filter indicator is created by the first stream update. After a restart it
// is already in the accessory cache, and a unit that is offline sends no stream
// update: without a read handler bound at construction it kept answering its
// cached value beside tiles that read No Response.
test('a filter indicator restored from the cache reads No Response before any stream update', async () => {
  const first = makeHarness();
  first.stream({ displayConfig: { filter: true } });
  assert.ok(first.accessory.getService(Service.FilterMaintenance), 'cached by the first run');

  const second = makeHarness({ accessory: first.accessory });
  second.handler.updateFromZone(zone());
  second.handler.setCloudConnected(false);

  const filter = second.accessory.getService(Service.FilterMaintenance)!;
  assert.ok(filter.chars.get(Characteristic.FilterChangeIndication)?.value instanceof Error);
  await assert.rejects(() => second.handler.getFilterChangeIndication());
});

test('a mirror push to an offline unit is sent but does not repaint its setpoints', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone());
  h.handler.setCloudConnected(false);

  await h.handler.applyMirror({ operationMode: 'cool', power: 1, spHeat: 20, spCool: 22, fanSpeed: 'auto' });

  assert.strictEqual(h.sent.length, 1, 'the command still goes out');
  assert.ok(h.value(Characteristic.CoolingThresholdTemperature) instanceof Error);
});
