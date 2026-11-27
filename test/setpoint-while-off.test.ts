// Regression test for the off-unit setpoint bug.
//
// HomeKit sends a setpoint independently of the unit's on/off state. When an
// automation (e.g. "turn off the AC when the skylight opens") captures a unit's
// full state, opening the skylight re-pushes each unit's last setpoint alongside
// `off`. The old code's off branch sent a bare `{ spHeat: temp }` with no
// operationMode, which the Kumo v3 API rejects with `modeRequiredWhenDeviceOff`
// (HTTP 400) — producing a cluster of red errors on every skylight-open event
// even though the unit shut off fine.
//
// The unit is off, so there is nothing to set: no command should be sent. The
// requested value is cached + echoed to HomeKit so the slider doesn't snap back.
//
// ---- What the HeaterCooler migration changed about this test ----------------
//   * The setpoint no longer arrives on TargetTemperature (that characteristic
//     does not exist on HeaterCooler). It arrives on HeatingThresholdTemperature
//     or CoolingThresholdTemperature, which are the setpoint controls in every
//     mode now. Both route into the same guard, so both are exercised below —
//     under Thermostat one characteristic covered both device fields, here it
//     takes two writers to cover the same ground.
//   * The independence that makes the bug possible is, if anything, sharper: the
//     off is `Active`, a physically separate characteristic, so a controller can
//     and does write a threshold to a unit it just powered down.
//   * The echoed value is the *quantized* setpoint, not the raw request — writes
//     are snapped onto the whole-°F grid (src/temperature.ts) before anything
//     else happens. That is still "the slider holds": 21.3°C and 21.0°C are the
//     same 70°F, which is what the user actually asked for and what the Home app
//     displays. Arithmetic is spelled out at each assertion; its last step is the
//     nearest 0.5°C, the only grid the Mitsubishi cloud accepts. See storedC in
//     src/temperature.ts.

import test from 'node:test';
import assert from 'node:assert';

import type { Adapter, Zone } from '../dist/settings.js';
import {
  Characteristic, Service, makeAccessory, type FakeAccessory, SWITCHES_ON, makeAccessoryHarness,
} from './helpers';

const SERIAL = 'TESTSERIAL001';

const makeHarness = () =>
  makeAccessoryHarness({ kumoConfig: SWITCHES_ON, accessory: makeAccessory('Living room') });

/**
 * The characteristic the Home app's slider is bound to, off the primary climate
 * service. Asserting the service exists rather than optional-chaining: a missing
 * HeaterCooler is itself the regression, and `undefined === 21` would report it
 * as a wrong value instead of a missing tile.
 */
function climateChar(accessory: FakeAccessory, id: unknown) {
  const svc = accessory.getService(Service.HeaterCooler);
  assert.ok(svc, 'the HeaterCooler service was published');
  return svc.getCharacteristic(id);
}

const zone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

test('setting a target temperature while the unit is OFF sends no command', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  // Seed an OFF status the way a streaming/poll update would.
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(21);

  // Before the fix this was 1: a bare { spHeat: 21 } that the API rejected with
  // modeRequiredWhenDeviceOff. The unit is off, so nothing should be sent.
  assert.strictEqual(sendCommandCalls.length, 0,
    'no API command should be sent when the unit is off');
});

// The cooling threshold is a second, independent writer into the same guard.
// Under Thermostat, TargetTemperature covered spHeat and spCool from one setter,
// so one test covered both device fields; here it takes two. The Home app shows
// this handle whenever the (off) unit's captured mode was COOL or AUTO, which is
// precisely the skylight scene's shape.
test('the cooling threshold is guarded the same way while the unit is OFF', async () => {
  const { handler, accessory, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spCool: 24 }));

  await handler.setCoolingThresholdTemperature(25);

  assert.strictEqual(sendCommandCalls.length, 0,
    'a bare { spCool } to an off unit is the same doomed 400');
  // 25°C is exactly 77°F, so the echo is the request unchanged.
  const cool = climateChar(accessory, Characteristic.CoolingThresholdTemperature);
  assert.strictEqual(cool.value, 25, 'the cooling handle holds the requested value');
});

test('setting a target temperature while OFF still echoes the value to HomeKit', async () => {
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(21);

  // 21°C = 69.8°F -> nearest whole °F is 70 -> (70-32)*5/9 = 21.111… -> nearest
  // 0.5°C = 21.0, which is 69.8°F and displays as the 70°F the user asked for, so
  // the handle holds where they put it rather than snapping back to the device's 20.
  const target = climateChar(accessory, Characteristic.HeatingThresholdTemperature);
  assert.strictEqual(target.value, 21,
    'HomeKit still reflects the requested value, on the °F grid (slider holds)');
});

test('setting a target temperature while HEATING still sends the setpoint (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22);

  assert.strictEqual(sendCommandCalls.length, 1, 'heat-mode setpoint is sent to the API');
  // 22°C = 71.6°F -> 72°F -> (72-32)*5/9 = 22.222… -> nearest 0.5°C 22.0.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 22 },
    'sends the quantized heat setpoint with no spurious fields');
});

// ---- Fan and vane on an OFF unit -----------------------------------------
//
// Over the LAN, fan speed and vane were stored preferences an idle unit accepted
// (verified 2026-07-27 on the powered-off Garage). The cloud does not take them:
// any command without a mode to an off unit returns 400
// `modeRequiredWhenDeviceOff` (seen live 2026-11-01 and 2026-11-04). So they are
// held for a turn-on in the same scene burst instead of being sent to fail; see
// off-unit-scene-burst.test.ts for the turn-on that sends them.

test('a fan-speed change is not sent to a unit that is OFF', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setRotationSpeed(0); // superQuiet — the bottom of the slider
  await new Promise((r) => setTimeout(r, 5)); // fan writes coalesce onto the next tick

  assert.strictEqual(sendCommandCalls.length, 0,
    'the cloud refuses a mode-less command to an off unit');
});

test('a vane change is not sent to a unit that is OFF', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setSwingMode(Characteristic.SwingMode.SWING_ENABLED);
  await new Promise((r) => setTimeout(r, 5)); // vane writes coalesce onto the next tick too

  assert.strictEqual(sendCommandCalls.length, 0);
});

test('nor is a setpoint (the original guard)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setHeatingThresholdTemperature(21);

  assert.strictEqual(sendCommandCalls.length, 0,
    'a bare setpoint on an off unit is still suppressed — it would revive it');
});
