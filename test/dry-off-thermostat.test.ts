// Regression test: a scene/automation "turn off" must actually turn off a unit
// that is running in DRY (or fan-only VENT).
//
// Bug: dry and fan-only have no HomeKit *mode* of their own, so the plugin
// reported the climate tile as OFF while the unit was running (dry/vent were
// surfaced only through their separate Dry/Fan switches). A HomeKit
// off-automation writes the tile's off characteristic. When the unit was in dry,
// that characteristic already read OFF, so iOS suppressed the redundant write —
// the setter never fired, no `operationMode:'off'` reached the unit, and the
// still-ON Dry switch kept it dehumidifying. Live-confirmed the trigger is a
// scene/automation.
//
// Upstream's 1.7.1 fix (B) was to lie: report the Thermostat as COOL while in
// dry/vent so the off write stopped being redundant. That workaround is GONE and
// must not be reinstated. It only existed because Thermostat's OFF meant two
// things at once — "not heating or cooling" AND "powered down" — so honesty about
// the first cost you the second. HeaterCooler splits them:
//
//   Active                    on/off. THIS is what an off-automation writes.
//   CurrentHeaterCoolerState  what the unit is doing: INACTIVE/IDLE/HEATING/COOLING.
//   TargetHeaterCoolerState   the requested mode: AUTO/HEAT/COOL. No OFF member.
//
// The regression is therefore structurally impossible *provided* a running
// dry/vent unit reports Active=ACTIVE. If Active ever read INACTIVE while the
// unit was running, iOS would suppress the redundant Active=0 exactly as before
// and the original bug would be back through the new characteristic — so that is
// what these tests pin down. Current state can now be honest: dry runs the
// compressor and the coil cold (COOLING), vent moves air without heating or
// cooling (IDLE) — and IDLE, unlike the old OFF, still means "on".

import test from 'node:test';
import assert from 'node:assert';

import type { Adapter, Zone } from '../dist/settings.js';
import { Characteristic, SWITCHES_ON, makeAccessoryHarness } from './helpers';

const SERIAL = 'TESTSERIAL001';

const Active = Characteristic.Active;
const CurrentState = Characteristic.CurrentHeaterCoolerState;
const TargetState = Characteristic.TargetHeaterCoolerState;

const makeHarness = () => makeAccessoryHarness({ kumoConfig: SWITCHES_ON });

const zone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'dry',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 25, spHeat: 23, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

// ---- Active: dry/vent must NOT read "off" while running ---------------------
// This is the direct successor of "dry must not read a non-OFF target". Active is
// now the characteristic an off-automation writes, so it is the one that must not
// already agree with the write.

test('a unit running in DRY reports Active ACTIVE (an off write is never redundant)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));

  const active = await handler.getActive();

  assert.notStrictEqual(active, Active.INACTIVE, 'dry must not read INACTIVE (would make off a no-op)');
  assert.strictEqual(active, Active.ACTIVE);
});

test('a unit running in fan-only VENT reports Active ACTIVE', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'vent', power: 1 }));

  const active = await handler.getActive();

  assert.notStrictEqual(active, Active.INACTIVE, 'vent must not read INACTIVE (would make off a no-op)');
  assert.strictEqual(active, Active.ACTIVE);
});

test('a genuinely off unit still reports Active INACTIVE (control)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));

  assert.strictEqual(await handler.getActive(), Active.INACTIVE);
});

test('HEAT and COOL still map correctly (control — no regression)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat', power: 1 }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), TargetState.HEAT);
  handler.updateFromZone(zone({ operationMode: 'cool', power: 1 }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), TargetState.COOL);
});

// ---- Current state is honest now, and still never reads "off" while running --
// The 1.7.1 hack made both dry and vent claim COOLING. HeaterCooler has a real
// IDLE, so each can be reported as what it is — the constraint that survives is
// only that a running unit must not report INACTIVE.

test('DRY reports CurrentHeaterCoolerState COOLING (compressor and coil are running)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));

  const current = await handler.getCurrentHeaterCoolerState();

  // The tile's status label follows Current. Dehumidify genuinely runs the
  // compressor, so COOLING is accurate rather than the old cover story — and it
  // shows a running dry unit as on even when the Dry switch is hidden.
  assert.strictEqual(current, CurrentState.COOLING);
  assert.notStrictEqual(current, CurrentState.INACTIVE, 'a running unit must never read INACTIVE');
});

test('VENT reports CurrentHeaterCoolerState IDLE — on, but neither heating nor cooling', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'vent', power: 1 }));

  const current = await handler.getCurrentHeaterCoolerState();

  // Fan-only had to be dressed up as COOLING under Thermostat because its only
  // honest option, OFF, doubled as "powered down". IDLE says "on, moving air"
  // without claiming a compressor that isn't running.
  assert.strictEqual(current, CurrentState.IDLE);
  assert.notStrictEqual(current, CurrentState.INACTIVE, 'a running unit must never read INACTIVE');
});

test('a powered-off unit still reports CurrentHeaterCoolerState INACTIVE (control)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));

  assert.strictEqual(await handler.getCurrentHeaterCoolerState(), CurrentState.INACTIVE);
});

test('dry and vent both report TargetHeaterCoolerState COOL (there is no OFF to fall into)', async () => {
  const { handler } = makeHarness();

  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));
  // Dry genuinely belongs on COOL: its setpoint lives in spCool, so the Home app
  // showing the cooling threshold is showing the dry setpoint (see
  // dry-setpoint.test.ts). Vent has no setpoint of its own and rides along.
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), TargetState.COOL);

  handler.updateFromZone(zone({ operationMode: 'vent', power: 1 }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), TargetState.COOL);
});

test('turning a dry unit off via Active sends operationMode off', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));

  await handler.setActive(Active.INACTIVE);

  assert.deepStrictEqual(sendCommandCalls[sendCommandCalls.length - 1].commands,
    { operationMode: 'off' },
    'off from a dry unit turns it off');
});

// ---- Optimistic window: turning Dry ON must not leave the tile reading off ---

test('turning the Dry switch ON leaves Active ACTIVE immediately', async () => {
  const { handler, heaterCooler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));

  await handler.setDryOn(true);

  // If the optimistic update left Active at INACTIVE, an off-automation firing
  // before the next poll would be suppressed again — reintroducing the bug in
  // that window. (Under Thermostat the same gap existed on the target state.)
  assert.strictEqual(
    heaterCooler.getCharacteristic(Characteristic.Active).value,
    Active.ACTIVE,
    'optimistic Active reflects the now-running unit',
  );
  assert.strictEqual(
    heaterCooler.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
    CurrentState.COOLING,
    'and the tile shows it running, not "Off"',
  );
});
