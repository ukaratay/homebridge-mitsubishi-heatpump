// Regression test for the dry-mode setpoint field bug.
//
// On the Kumo v3 cloud, Dry mode holds its temperature setpoint in `spCool`
// (there is no spDry field). The old code routed dry through the catch-all
// `else` branch that writes/reads `spHeat`, so dry-mode temperature changes
// silently did nothing — the cloud accepted the spHeat write but the unit
// ignored it (and some writes 400'd with `invalidSpHeatRange`). Live-confirmed
// against the real account: a unit in dry reports e.g. spCool=25, spHeat=23, and
// the plugin surfaced 23 (the wrong field). Writing spCool while in dry is
// adopted and the unit stays in dry.
//
// Under HeaterCooler there is no single TargetTemperature left to mis-route:
// spHeat and spCool each own a characteristic (HeatingThresholdTemperature /
// CoolingThresholdTemperature) and they are the setpoint controls in EVERY mode,
// not just AUTO. The field now follows the characteristic, not the mode, so the
// `else`-branch class of bug cannot recur. What still has to hold — and is what
// these tests pin — is that the setpoint the Home app actually *surfaces* while
// dehumidifying is the spCool one: dry reports TargetHeaterCoolerState COOL, and
// in COOL the Home app shows the cooling threshold. Break either half of that
// pair (map dry to HEAT, or back the cooling threshold with spHeat) and the
// original bug is back: the user drags the dry setpoint and the unit ignores it.
//
// `usesSetPointInDryMode` survives in one place only — the mirror push, which
// reconstructs a dry command by hand and must not attach a spCool to a unit that
// dehumidifies at a fixed setpoint. It still defaults to "has a setpoint" until
// the async profile arrives, so the common case works immediately.
//
// NOTE ON EXPECTED VALUES: every setpoint write is snapped to the exact Celsius
// of the nearest whole °F on the way out (src/temperature.ts,
// quantizeSetpointInRange), because HAP's minStep only constrains the outbound
// path and a controller can write any float inbound. So the value asserted below
// is the quantized one, not the one HomeKit sent. The first write test spells the
// arithmetic out; the rest call `quantizeSetpointC` for the expectation, because
// hand-copied arithmetic rots — comments here have drifted behind the quantizer
// before. The mirror path is
// deliberately exempt — it copies a value the source already quantized.

import test from 'node:test';
import assert from 'node:assert';

import { quantizeSetpointC } from '../dist/temperature.js';
import type { Adapter, DeviceProfile, Zone } from '../dist/settings.js';
import { Characteristic, SWITCHES_ON, makeAccessoryHarness } from './helpers';

const SERIAL = 'TESTSERIAL001';

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

const profile = (over: Partial<DeviceProfile> = {}): Partial<DeviceProfile> => ({
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  hasModeVent: true,
  hasModeDry: true,
  usesSetPointInDryMode: true,
  ...over,
});

// ---- Write path ----------------------------------------------------------

test('setting the dry-mode setpoint sends spCool, not spHeat', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone()); // dry, no profile yet

  // In dry the tile reads COOL, so this is the handle the Home app puts under
  // the user's finger while the unit is dehumidifying.
  await handler.setCoolingThresholdTemperature(24);

  assert.strictEqual(sendCommandCalls.length, 1, 'a command is sent in dry mode');
  // Before the fix this was { spHeat: ... }, which the unit ignored / 400'd.
  // The one worked example: 24°C = 75.2°F -> nearest whole 75°F -> 23.888…°C ->
  // nearest 0.5°C, the grid the cloud accepts = 24.0.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 24 },
    'dry-mode setpoint is written to spCool (no spHeat, no operationMode)');
});

test('the dry setpoint routes to spCool even before the device profile arrives', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  // No applyProfile() call — deviceProfile is null, the common startup window.
  // The quantizer then falls back to a 10–35°C range, which changes nothing here.
  handler.updateFromZone(zone());

  await handler.setCoolingThresholdTemperature(26);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: quantizeSetpointC(26) },
    'the dry setpoint works from the first tap, not only once the profile lands');
});

test('the cooling threshold writes spCool in dry, cool and heat alike', async () => {
  // The structural reason the original bug cannot come back: the destination
  // field is chosen by the characteristic, never by operationMode, so there is
  // no mode-dispatch `else` for dry to fall through any more.
  for (const operationMode of ['dry', 'cool', 'heat']) {
    const { handler, sendCommandCalls } = makeHarness();
    handler.updateFromZone(zone({ operationMode }));

    await handler.setCoolingThresholdTemperature(25); // 25°C = 77°F exactly, unchanged

    assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 25 },
      `cooling threshold -> spCool in ${operationMode}`);
  }
});

test('the heating threshold still writes spHeat (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));

  await handler.setHeatingThresholdTemperature(22);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: quantizeSetpointC(22) });
});

// ---- Read path -----------------------------------------------------------

test('a unit in DRY surfaces spCool, not spHeat', async () => {
  const { handler } = makeHarness();
  // Live capture: Kitchen in dry reported spCool=25, spHeat=23 (stale).
  handler.updateFromZone(zone({ spCool: 25, spHeat: 23 }));

  // Two halves of one claim: dry presents as COOL, and COOL is the mode in which
  // the Home app shows the cooling threshold. Together they are what makes the
  // *displayed* dry setpoint spCool-backed.
  assert.strictEqual(await handler.getTargetHeaterCoolerState(),
    Characteristic.TargetHeaterCoolerState.COOL,
    'dry must present as COOL or the cooling threshold is never shown');

  const surfaced = await handler.getCoolingThresholdTemperature();

  // Before the fix the dry setpoint read back as the stale spHeat, 23.
  assert.strictEqual(surfaced, 25, 'dry surfaces the spCool setpoint');
  assert.notStrictEqual(surfaced, 23, 'never the spHeat the old else-branch returned');
});

// ---- usesSetPointInDryMode: the mirror push -------------------------------
// The profile flag no longer gates the HomeKit surface (CoolingThresholdTemperature
// IS spCool in every mode — writing it is correct even on a unit that ignores the
// value while dehumidifying). It still gates the one place the plugin composes a
// dry command itself, where an unwanted spCool would be an invention rather than
// the user's own drag: the mirror.

test('mirroring a dry source carries its spCool to the target', async () => {
  const { handler, sendCommandCalls, applyProfile } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  applyProfile(profile()); // usesSetPointInDryMode: true

  await handler.applyMirror({
    operationMode: 'dry', power: 1, spHeat: 23, spCool: 25, fanSpeed: 'quiet',
  });

  // One atomic command; spCool (25 is inside the target's 16–31 clamp) and no
  // spHeat, same field choice as the HomeKit path. Not re-quantized: the source
  // already snapped this value to the °F grid when it was set.
  assert.deepStrictEqual(sendCommandCalls[sendCommandCalls.length - 1].commands, {
    operationMode: 'dry', power: 1, spCool: 25, fanSpeedRaw: 'quiet',
  });
});

test('mirroring a dry source omits spCool when the profile reports usesSetPointInDryMode=false', async () => {
  const { handler, sendCommandCalls, applyProfile } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  applyProfile(profile({ usesSetPointInDryMode: false }));

  await handler.applyMirror({
    operationMode: 'dry', power: 1, spHeat: 23, spCool: 25, fanSpeed: 'quiet',
  });

  // Such a unit dehumidifies at a fixed setpoint and ignores the value; sending
  // one anyway would silently rewrite the setpoint it uses back in COOL.
  assert.deepStrictEqual(sendCommandCalls[sendCommandCalls.length - 1].commands, {
    operationMode: 'dry', power: 1, fanSpeedRaw: 'quiet',
  }, 'fixed-setpoint dry units do not get a spCool write');
});
