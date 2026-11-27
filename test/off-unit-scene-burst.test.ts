// Regression tests: scenes that touch a unit which is OFF.
//
// Seen live every evening from 2026-10-30 to 2026-11-04: the Evening Temps scene
// holds the Garage's climate tile OFF, its fan tile ON, HEAT, 68°F / 72.5°F, fan
// and vane. The fan tile's Active=ON went to setActive, which cleared the
// off-in-flight window, so the scene's HEAT went through and the Garage came on
// every night. Its setpoints, fan and vane had arrived while the unit was off and
// were never sent (the cloud refuses a mode-less command to an off unit with
// `modeRequiredWhenDeviceOff`), so it heated to its old 72.5°F.
//
// Fixed in two parts: a fan-tile ON does not reach the unit's power at all (the
// fan is the separate Fixed Fan Speed accessory now, and only holds a speed),
// and writes held while the unit was off are sent right after a write in the
// same burst turns it on.

import test from 'node:test';
import assert from 'node:assert';

import type { Zone } from '../dist/settings.js';
import { Characteristic, makeAccessory, makeAccessoryHarness } from './helpers';

const SERIAL = 'TESTSERIAL001';

const makeHarness = () => makeAccessoryHarness({ accessory: makeAccessory('Garage') });

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 0, operationMode: 'off',
    fanSpeed: null, airDirection: null,
    roomTemp: 20, spCool: 22.8, spHeat: 22.5, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

/** Fan writes coalesce onto the next tick; let them settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test('Evening Temps on the OFF Garage: climate OFF + fan ON + HEAT leaves it off', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  // The dispatch order from the 2026-11-04 20:15 log, none awaited.
  await Promise.all([
    handler.setSwingMode(Characteristic.SwingMode.SWING_DISABLED),
    handler.setHeatingThresholdTemperature(20),
    handler.setActive(Characteristic.Active.INACTIVE),
    handler.setFanActive(Characteristic.Active.ACTIVE),
    handler.setRotationSpeed(0),
    handler.setCoolingThresholdTemperature(22.5),
    handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT),
  ]);
  await settle();

  assert.deepStrictEqual(
    sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'off' }],
    'the climate tile\'s OFF wins; nothing turns the unit on',
  );
});

test('same scene with the fan ON dispatched before the climate OFF: still off', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await Promise.all([
    handler.setFanActive(Characteristic.Active.ACTIVE),
    handler.setActive(Characteristic.Active.INACTIVE),
    handler.setHeatingThresholdTemperature(20),
    handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT),
  ]);
  await settle();

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'off' }]);
});

test('a fan-tile ON with no off in flight does not turn the unit on either', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setFanActive(Characteristic.Active.ACTIVE);
  await settle();

  assert.deepStrictEqual(sendCommandCalls, [], '"turn on the fans" must not start a heat pump');
});

test('a scene turning on an OFF unit, mode first: its setpoints, fan and vane follow the turn-on', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await Promise.all([
    handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT),
    handler.setActive(Characteristic.Active.ACTIVE),
    handler.setHeatingThresholdTemperature(20), // 68°F -> 20.0
    handler.setCoolingThresholdTemperature(22), // 71.6°F -> 72°F -> 22.0
    handler.setRotationSpeed(20),
    handler.setSwingMode(Characteristic.SwingMode.SWING_ENABLED),
  ]);
  await settle();

  const sent = sendCommandCalls.map((c) => c.commands);
  assert.deepStrictEqual(sent[0], { operationMode: 'heat' }, 'the mode goes first');
  const after = Object.assign({}, ...sent.slice(1));
  assert.deepStrictEqual(after, { spHeat: 20, spCool: 22, fanSpeed: 'superQuiet', vaneDir: 'swing' },
    'every setting the scene carried reaches the unit once it is on');
  assert.ok(sent.slice(1).every((c) => c.operationMode === undefined));
});

test('a scene turning on an OFF unit, settings first: same result', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await Promise.all([
    handler.setHeatingThresholdTemperature(20),
    handler.setCoolingThresholdTemperature(22),
    handler.setRotationSpeed(20),
    handler.setSwingMode(Characteristic.SwingMode.SWING_ENABLED),
    handler.setActive(Characteristic.Active.ACTIVE),
    handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT),
  ]);
  await settle();

  const sent = sendCommandCalls.map((c) => c.commands);
  assert.deepStrictEqual(sent[0], { operationMode: 'heat' });
  assert.deepStrictEqual(Object.assign({}, ...sent.slice(1)),
    { spHeat: 20, spCool: 22, fanSpeed: 'superQuiet', vaneDir: 'swing' });
});

test('only values HomeKit wrote are sent after a turn-on, never ones the unit reported', async () => {
  // The unit still reports a legacy 0.1°C spCool (22.8). Sending it back would
  // get the command refused with invalidSpCoolIncrement.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ spCool: 22.8 }));

  await Promise.all([
    handler.setHeatingThresholdTemperature(21), // 69.8°F -> 70°F -> 21.0
    handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT),
  ]);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'heat' }, { spHeat: 21 }]);
});

test('a setpoint moved on an idle unit is not sent by a later, unrelated turn-on', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());
  (handler as unknown as { OFF_STASH_MS: number }).OFF_STASH_MS = 30;

  await handler.setHeatingThresholdTemperature(21);
  await new Promise((r) => setTimeout(r, 60));
  await handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'heat' }]);
});
