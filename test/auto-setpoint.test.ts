// Regression test for the AUTO setpoint band.
//
// These units report spAuto: null and keep the auto band in spHeat (low/heat
// bound) and spCool (high/cool bound) — verified against live device data (every
// poll showed `Auto: null` with independent spHeat/spCool). HomeKit shows that as
// a temperature *range* (two handles) whenever the mode is AUTO.
//
// The original bug: AUTO collapsed to the single TargetTemperature characteristic
// which, with spAuto null, fell back to spHeat — so the cooling side of the band
// was invisible and unsettable, and any write of that one characteristic drove
// both edges to the same value.
//
// The primary service is now HeaterCooler, not Thermostat, which changes what
// this file protects in two ways:
//
//   1. TargetTemperature does not exist on HeaterCooler. The heating and cooling
//      thresholds are THE setpoint controls in every mode — heat threshold in
//      HEAT, cool threshold in COOL, both as a range in AUTO. So the collapse is
//      now structurally impossible rather than merely patched around: there is no
//      second characteristic that can write both edges from one value. The test
//      below asserts that absence directly, so a future re-introduction of a
//      single combined setpoint control fails here instead of in someone's house.
//
//   2. Every inbound setpoint is snapped to the exact Celsius of the nearest
//      whole °F before it is sent (src/temperature.ts, quantizeSetpointInRange).
//      That is why the expected command values below are not the values HomeKit
//      "sent" — see the per-test arithmetic. It is deliberate: HAP applies a
//      characteristic's minStep only on the OUTBOUND path, so a controller write
//      of "72°F" arrives as whatever Celsius float it produced, and without the
//      snap the unit stores 22.2000000000003 or 22.5 and the Mitsubishi app shows
//      73°F for a 72°F tap.
//
// The snap lands on the nearest 0.5°C, the only grid the Mitsubishi cloud has
// accepted since 2026-10-30 (see src/temperature.ts). So 71.6°F → 72°F →
// 22.222…°C stores as 22.0. Every worked arithmetic comment below ends at the
// nearest 0.5°C for that reason.
//
// Still asserted, unchanged in spirit:
//   - getHeatingThresholdTemperature -> spHeat,  getCoolingThresholdTemperature -> spCool
//   - setHeatingThresholdTemperature -> { spHeat }, setCoolingThresholdTemperature -> { spCool }
//     (one key per command — neither write clobbers the other edge)
//   - zone updates sync both threshold characteristics
//   - the 1.5.2 powered-off guard applies (no bare setpoint to an off unit)

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Adapter, Commands, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory, type FakeAccessory } from './helpers';

const SERIAL = 'TESTSERIAL001';

interface SentCommand {
  serial: string;
  commands: Commands;
}

function makeHarness() {
  const sendCommandCalls: SentCommand[] = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(serial: string, commands: Commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(
    platform as never,
    accessory as never,
    kumoAPI as never,
  );
  return { handler, accessory, sendCommandCalls };
}

// Read a characteristic value off the primary climate service. That service is
// HeaterCooler now — a ductless mini-split has an on/off state separate from its
// mode, which Thermostat cannot express. A cached Thermostat is removed in the
// constructor, so getService(Service.Thermostat) is null here.
function heaterCoolerChar(accessory: FakeAccessory, charKey: string): unknown {
  const svc = accessory.getService(Service.HeaterCooler);
  assert.ok(svc, 'the HeaterCooler service is the primary climate service');
  return svc.getCharacteristic(Characteristic[charKey]).value;
}

const zone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'autoCool',
    fanSpeed: null, airDirection: null,
    roomTemp: 23, spCool: 26, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

// ---- Read path -----------------------------------------------------------
// The read path is NOT quantized: whatever the device reports is what the handle
// shows. Snapping a device-reported value would misreport the unit's real state
// (someone may have set 22.5 from the Mitsubishi app or a wall thermostat).

test('heating threshold reads spHeat, cooling threshold reads spCool', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 26);
});

test('zone updates sync both AUTO threshold characteristics', async () => {
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 19, spCool: 27 }));

  assert.strictEqual(heaterCoolerChar(accessory, 'HeatingThresholdTemperature'), 19,
    'spHeat is pushed to the heating handle, verbatim');
  assert.strictEqual(heaterCoolerChar(accessory, 'CoolingThresholdTemperature'), 27,
    'spCool is pushed to the cooling handle, verbatim');
});

test('setting the heating threshold in AUTO sends spHeat only', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setHeatingThresholdTemperature(21);

  // 21°C -> 69.8°F -> nearest whole °F is 70 -> 70°F = 21.111…°C -> stored 21.0.
  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 21 },
    'heating handle writes spHeat, on the °F grid (no spCool, no operationMode)');
});

test('setting the cooling threshold in AUTO sends spCool only', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setCoolingThresholdTemperature(25);

  // 25°C is exactly 77°F, so the grid snap is a no-op here — a useful control
  // that quantization only ever moves values that were off-grid to begin with.
  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 25 },
    'cooling handle writes spCool (no spHeat, no operationMode)');
});

test('the AUTO band cannot collapse: no single control writes both edges', async () => {
  const { handler, accessory, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  // --- structural half ---
  // The collapse needed a characteristic that drove spHeat AND spCool from one
  // value. On HeaterCooler that characteristic does not exist, and the handler
  // methods that backed it are gone. Assert the absence, not just the behaviour:
  // this is the regression that reaches the user as "my AUTO range snapped shut".
  // Read `chars` directly rather than through getCharacteristic, which creates on
  // lookup (as real HAP does) and would add the very characteristic being denied.
  const svc = accessory.getService(Service.HeaterCooler);
  assert.ok(svc, 'the HeaterCooler service exists to be inspected');
  const ids = [...svc.chars.keys()].map((c) => (c as { _name: string })._name);
  assert.ok(!ids.includes('TargetTemperature'),
    'HeaterCooler must not carry a combined TargetTemperature — it is the collapse vector');
  // Denied twice, at compile time and at run time. The `?: never` members are the
  // compile-time half: this annotation is an ordinary assignment, not a cast, so
  // the day someone declares `setTargetTemperature` on KumoThermostatAccessory the
  // intersection reduces to `never` and this line stops type-checking. Reading the
  // value through it keeps the run-time half, which is what catches an accessor
  // bolted on outside the class declaration (a mixin, a prototype patch).
  const surface: KumoThermostatAccessory & {
    setTargetTemperature?: never;
    getTargetTemperature?: never;
  } = handler;
  assert.strictEqual(typeof surface.setTargetTemperature, 'undefined',
    'no combined setpoint writer may exist');
  assert.strictEqual(typeof surface.getTargetTemperature, 'undefined',
    'no combined setpoint reader may exist');

  // --- behavioural half ---
  // The live scenario that used to flatten the band: an automation/scene pushes
  // both captured handles at once and HomeKit dispatches them concurrently in an
  // arbitrary order. The 1.5s write hold is keyed per setpoint field, so the two
  // handles cannot supersede each other — both must land, with their own values.
  await Promise.all([
    handler.setHeatingThresholdTemperature(21),   // -> 70°F -> 21.0
    handler.setCoolingThresholdTemperature(25),   // -> 77°F -> 25
  ]);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands),
    [{ spHeat: 21 }, { spCool: 25 }],
    'a concurrent two-handle burst sends both edges, each with its own value');
  for (const call of sendCommandCalls) {
    assert.strictEqual(Object.keys(call.commands).length, 1,
      'every setpoint command touches exactly one edge');
  }
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 21);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 25,
    'the band is still 3.9°C wide, not collapsed to a point');
});

test('dragging the band sends two independent commands, not a collapsed pair', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  await handler.setHeatingThresholdTemperature(21);
  await handler.setCoolingThresholdTemperature(25);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands),
    [{ spHeat: 21 }, { spCool: 25 }],
    'the band stays two-sided; neither write clobbers the other edge');
});

test('an accepted threshold write optimistically updates cached state', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  await handler.setCoolingThresholdTemperature(24);

  // 24°C -> 75.2°F -> 75°F -> 23.888…°C -> stored 24.0. The echo must be the
  // QUANTIZED value, not the raw 24 HomeKit sent: the handle has to show what the
  // unit will actually hold, or the next poll visibly yanks it and the user
  // re-drags it.
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 24,
    'the new spCool is reflected immediately, before the next poll');
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20,
    'the heating edge is untouched');
});

// ---- Powered-off guard (inherits the 1.5.2 behavior) ---------------------

test('threshold writes to a powered-off unit are cached, not sent', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setHeatingThresholdTemperature(22);

  // 22°C -> 71.6°F -> 72°F -> 22.222…°C -> stored 22.0.
  assert.strictEqual(sendCommandCalls.length, 0,
    'no bare setpoint is sent to an off unit (would 400 modeRequiredWhenDeviceOff)');
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 22,
    'the value is cached + echoed so the handle holds — quantized, same as a sent write');
});

// ---- Controls: single-setpoint modes are unaffected ----------------------
// These were TargetTemperature tests. TargetTemperature is gone, but the risk it
// guarded is not: the thresholds are now load-bearing in HEAT and COOL too, so a
// change to the AUTO band logic must not disturb the single-setpoint modes. Same
// guarantee, asserted through the characteristic that carries it now.

test('HEAT-mode heating threshold still sends spHeat only (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));

  await handler.setHeatingThresholdTemperature(22);

  // 22°C -> 71.6°F -> 72°F -> 22.0.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 22 },
    'the heat path writes only its own edge, and carries no operationMode');
});

test('COOL-mode cooling threshold still sends spCool only (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool' }));

  await handler.setCoolingThresholdTemperature(23);

  // 23°C -> 73.4°F -> 73°F -> 22.777…°C -> stored 23.0.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 23 });
});
