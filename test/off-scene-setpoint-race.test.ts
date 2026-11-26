// Regression test: an "AC off" scene must not leave a unit running.
//
// A HomeKit "turn off AC" scene captures each unit's full state and, when it
// fires, re-pushes the off *and* the captured setpoints. HomeKit dispatches these
// concurrently in an arbitrary order. A setpoint dispatched after the off reaches
// the LAN adapter as a bare, mode-less write (local setpoint commands carry no
// mode/power — see local-api.ts) and powers the unit back on. Observed live
// 2026-07-11: the Living room (an AUTO unit) "restarted" in dry after the off
// automation, because its two AUTO threshold writes were dispatched after the off
// — the mutex sent {mode:off} then two bare setpoints.
//
// Fix: a HomeKit off request opens a short suppression window; setpoint writes
// during it are cached/echoed but not sent, so the off is the last thing the
// adapter sees. The setpoints dispatched *before* the off are handled by the
// separate hold (off-scene-pre-setpoint.test.ts).
//
// ---- What the HeaterCooler migration changed about this test ----------------
// Nothing about the physical failure. Only the surfaces moved:
//   * The scene's off used to be TargetHeatingCoolingState=OFF. HeaterCooler has
//     no OFF mode — power is the separate `Active` characteristic — so the off is
//     now setActive(INACTIVE). It still calls noteModeIntent('off') synchronously
//     before its own await, which is what opens the suppression window in time
//     for the siblings dispatched behind it.
//   * The captured setpoints used to be TargetTemperature plus, on an AUTO unit,
//     the two threshold handles. TargetTemperature is gone; the two thresholds
//     are now the setpoint controls in every mode, so they carry the whole scene
//     payload.
//   * HeaterCooler puts fan speed on the same tile (RotationSpeed), so a scene
//     capturing this accessory captures that too — a new fourth writer that did
//     not exist under Thermostat. It is the same hazard: a bare fanSpeed write on
//     the LAN path carries no mode, and `mode` is the only thing that expresses
//     on/off locally, so a trailing one revives the unit exactly like a trailing
//     setpoint. It shares the setpoint guard (accessory.ts:setRotationSpeed) and
//     the burst below now covers it.

import test from 'node:test';
import assert from 'node:assert';

import type { Adapter, Commands, Zone } from '../dist/settings.js';
import { Characteristic, makeAccessory, SWITCHES_ON, makeAccessoryHarness } from './helpers';

const SERIAL = 'TESTSERIAL001';

interface SentCommand {
  serial: string;
  commands: Commands;
}

const makeHarness = () =>
  makeAccessoryHarness({ kumoConfig: SWITCHES_ON, accessory: makeAccessory('Living room') });

const zone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

const isOff = (c: SentCommand) => c.commands.operationMode === 'off';
const isSetpoint = (c: SentCommand) =>
  c.commands.spHeat !== undefined || c.commands.spCool !== undefined;
// A fan-speed write is mode-less on the LAN path too, so it revives an off unit
// the same way a bare setpoint does. New writer on the HeaterCooler tile.
const isFanSpeed = (c: SentCommand) => c.commands.fanSpeed !== undefined;

test('AC-off scene: no setpoint reaches the device after the off (unit stays off)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  // Living room was running in dry. Seed that on state the way a poll would.
  handler.updateFromZone(zone({ power: 1, operationMode: 'dry', spCool: 24, spHeat: 20 }));

  // Reproduce the 06:49:01 scene dispatch shape, re-expressed on HeaterCooler:
  // one captured setpoint ahead of the off, then the rest of the captured tile
  // behind it.
  //   HeatingThreshold(21) → Active(INACTIVE) → CoolingThreshold(25) → Rotation(80)
  // The original burst was TargetTemperature(21) → OFF → CoolingThreshold(25) →
  // HeatingThreshold(21); TargetTemperature is gone, and repeating a threshold
  // would just re-enter the same generation key, so the fourth slot is the fan
  // speed the tile now also carries. Fired concurrently (not awaited between) to
  // mirror HomeKit's concurrent dispatch — this is what lets a follower's guard
  // check run before the off's optimistic state update lands.
  const p1 = handler.setHeatingThresholdTemperature(21);
  const p2 = handler.setActive(Characteristic.Active.INACTIVE);
  const p3 = handler.setCoolingThresholdTemperature(25);
  const p4 = handler.setRotationSpeed(80);
  await Promise.all([p1, p2, p3, p4]);

  const offIdx = sendCommandCalls.findIndex(isOff);
  assert.ok(offIdx >= 0, 'the off command is still sent (the off-fix is preserved)');

  const tail = sendCommandCalls.slice(offIdx + 1);
  assert.ok(
    !tail.some(isSetpoint),
    'no setpoint command may follow the off — a trailing bare setpoint revives the unit. ' +
      'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)),
  );
  assert.ok(
    !tail.some(isFanSpeed),
    'no fan-speed command may follow the off either — it is mode-less on the LAN ' +
      'path and revives the unit the same way. ' +
      'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)),
  );
});

test('a threshold write dispatched right after an off is suppressed', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  const pSp = handler.setCoolingThresholdTemperature(25);
  await Promise.all([pOff, pSp]);

  const setpoints = sendCommandCalls.filter(isSetpoint);
  assert.strictEqual(
    setpoints.length, 0,
    'a setpoint issued in the same burst as an off must not be sent to the device',
  );
});

test('a threshold write with no recent off still sends (control — AUTO handle drag)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'auto', spAuto: null }));

  await handler.setCoolingThresholdTemperature(25);

  assert.strictEqual(sendCommandCalls.length, 1, 'the AUTO cooling handle write is sent');
  // 25°C is exactly 77°F, so quantization leaves it alone — the guard, not the
  // grid, is what this control is measuring.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 25 });
});
