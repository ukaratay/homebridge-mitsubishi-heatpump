// Regression test: Active=ON must not race a scene's mode write.
//
// A HomeKit scene that switches a running unit from COOL to HEAT pushes the whole
// captured tile: TargetHeaterCoolerState=HEAT *and* Active=ON (seen twice per unit
// in the live log), dispatched concurrently in arbitrary order. setActive re-sent
// the remembered mode on every ON, and the cache still said 'cool' because the
// HEAT write had not landed yet. The device got [{heat}, {cool}, {cool}] with
// nothing ordering them, so whichever reached the cloud last won. Seen live
// 2026-10-09: a 6:30 AM HEAT scene left units in the COOL set the night before.
//
// Fix: ON for a unit that is already running is a no-op. The control below pins
// the one case where the cache says "running" but the ON is real: an off in flight.

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
    kumoConfig: {},
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(serial: string, commands: Commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory('Bedroom');
  const handler = new KumoThermostatAccessory(
    platform as never,
    accessory as never,
    kumoAPI as never,
    30,
  );
  return { handler, sendCommandCalls };
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

test('HEAT scene on a unit running COOL: only the heat command reaches the device', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  // The order the live log showed: mode first, then two ONs, none awaited.
  const pMode = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
  const pOn1 = handler.setActive(Characteristic.Active.ACTIVE);
  const pOn2 = handler.setActive(Characteristic.Active.ACTIVE);
  await Promise.all([pMode, pOn1, pOn2]);

  assert.deepStrictEqual(
    sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'heat' }],
    'no stale cool may be sent alongside the scene\'s heat',
  );
});

test('HEAT scene with the ON dispatched before the mode: still only heat', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  const pOn = handler.setActive(Characteristic.Active.ACTIVE);
  const pMode = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
  await Promise.all([pOn, pMode]);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'heat' }]);
});

test('control: an ON right behind an in-flight off still turns the unit back on', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  // The cache still says power=1 while the off is in flight, so a cache-only
  // check would swallow this ON and leave the unit off.
  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  const pOn = handler.setActive(Characteristic.Active.ACTIVE);
  await Promise.all([pOff, pOn]);

  assert.deepStrictEqual(
    sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'off' }, { operationMode: 'cool' }],
  );
});
