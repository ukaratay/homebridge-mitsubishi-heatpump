// Regression test: the MODE writer must not trail an "AC off" scene either.
//
// Companion to off-scene-setpoint-race.test.ts, which covers the setpoint and
// fan-speed writers. Same physical failure — a unit left running after a scene
// told it to stop — through the one writer that was missing the guard.
//
// A HomeKit "turn off AC" scene captures each accessory's whole tile and re-pushes
// it, so an off arrives alongside the captured mode: Active=INACTIVE *and*
// TargetHeaterCoolerState=COOL, dispatched concurrently in arbitrary order. Every
// mode this setter can send is an active one (HeaterCooler expresses off through
// Active), so a mode landing behind the off powers the unit straight back on.
//
// It was worse than a trailing setpoint, because setTargetHeaterCoolerState calls
// noteModeIntent(), which ZEROES offRequestedAt. The mode write did not merely
// evade the guard, it disarmed it for everything dispatched behind it: an
// off + mode + threshold burst sent [{off}, {cool}, {spCool:25}] — the off
// undone, then the setpoint the suppression window exists to stop.
//
// Fix: setTargetHeaterCoolerState checks offInFlight() BEFORE noteModeIntent and
// reverts the characteristic. offInFlight(), not shouldSuppressSetpoint(): a mode
// chosen on a unit that is merely off is how a user turns it back on, so only an
// off IN FLIGHT blocks. The two controls below pin that distinction down.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Commands, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

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
  const accessory = makeAccessory('Living room');
  const handler = new KumoThermostatAccessory(
    platform as never,
    accessory as never,
    kumoAPI as never,
    30,
  );
  return { handler, accessory, sendCommandCalls };
}

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

const isOff = (c: SentCommand) => c.commands.operationMode === 'off';
// Any mode this setter can send is an active mode, so any operationMode other
// than 'off' on the wire is a command that powers the unit back on.
const isActiveMode = (c: SentCommand) =>
  c.commands.operationMode !== undefined && c.commands.operationMode !== 'off';
const isSetpoint = (c: SentCommand) =>
  c.commands.spHeat !== undefined || c.commands.spCool !== undefined;

test('AC-off scene: a mode dispatched right after the off does not reach the device', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  // The captured tile: off, then the mode the scene recorded. Fired concurrently
  // (not awaited between) to mirror HomeKit's dispatch — the off's optimistic
  // state update has not landed when the mode handler runs its guard.
  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  const pMode = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.COOL);
  await Promise.all([pOff, pMode]);

  const offIdx = sendCommandCalls.findIndex(isOff);
  assert.ok(offIdx >= 0, 'the off command is still sent (the off itself must not be broken)');

  const tail = sendCommandCalls.slice(offIdx + 1);
  assert.ok(
    !tail.some(isActiveMode),
    'no active mode may follow the off — it powers the unit back on. ' +
      'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)),
  );
});

test('a mode write in an off burst does not re-open the window for the setpoint behind it', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  // The full captured tile: off, mode, setpoint. This is the burst that used to
  // send [{off}, {cool}, {spCool:25}] — the mode's noteModeIntent cleared
  // offRequestedAt, and its success path put power back to 1 in the cache, so the
  // threshold's post-hold suppression check saw a running unit and sent.
  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  const pMode = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.COOL);
  const pSp = handler.setCoolingThresholdTemperature(25);
  await Promise.all([pOff, pMode, pSp]);

  assert.deepStrictEqual(
    sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'off' }],
    'the off must be the only thing the device sees in this burst',
  );
  // Stated separately so a failure names the hazard rather than a diff.
  assert.ok(!sendCommandCalls.some(isSetpoint), 'no setpoint reaches the device');
  assert.ok(!sendCommandCalls.some(isActiveMode), 'no active mode reaches the device');
});

test('AC-off scene: a Dry or Fan-only switch dispatched right after the off does not reach the device', async () => {
  for (const setSwitch of ['setDryOn', 'setFanOnlyOn'] as const) {
    const { handler, sendCommandCalls } = makeHarness();
    handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

    const pOff = handler.setActive(Characteristic.Active.INACTIVE);
    const pSwitch = handler[setSwitch](true);
    await Promise.all([pOff, pSwitch]);

    assert.deepStrictEqual(
      sendCommandCalls.map((c) => c.commands),
      [{ operationMode: 'off' }],
      `${setSwitch}: the switch's mode would power the unit back on`,
    );
  }
});

test('control: turning the unit on and picking a mode in the same breath still works', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  // Tapping a powered-off tile and choosing HEAT: Active=ACTIVE and the mode
  // arrive together. The unit is off, so a shouldSuppressSetpoint()-style guard
  // would swallow the mode and leave the unit running whatever it remembered.
  // Only an off IN FLIGHT may block, and setActive(ACTIVE) clears the window.
  const pOn = handler.setActive(Characteristic.Active.ACTIVE);
  const pMode = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
  await Promise.all([pOn, pMode]);

  // The mode write powers the unit on by itself, so the held ON is dropped rather
  // than racing it with 'auto' (see on-scene-mode-race.test.ts).
  assert.deepStrictEqual(
    sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'heat' }],
    'the requested mode reaches the device and turns it on',
  );
});

test('control: a mode change with no off in the burst still sends', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  await handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);

  assert.deepStrictEqual(
    sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'heat' }],
    'an ordinary mode change is untouched by the guard',
  );
});
