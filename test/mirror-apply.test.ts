// applyMirror (target side): reconstructs one atomic command from a source's
// desired state, normalized, clamped to this unit's range, and capability-guarded.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Adapter, Commands, DeviceProfile, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

const SERIAL = 'TESTTARGET01';

const profile = (over: Partial<DeviceProfile> = {}): DeviceProfile => ({
  numberOfFanSpeeds: 5, hasFanSpeedAuto: true,
  hasModeDry: true, usesSetPointInDryMode: true,
  hasModeHeat: true, hasModeVent: true, hasVaneDir: true, hasVaneSwing: true,
  hasDefrost: true, hasStandby: true,
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  ...over,
});

function makeHarness() {
  const sendCommandCalls: Array<{ serial: string; commands: Commands }> = [];
  let profileCb: ((serial: string, deviceProfile: DeviceProfile) => void) | null = null;
  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
    localClient: null,
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb: (serial: string, deviceProfile: DeviceProfile) => void) {
      profileCb = cb;
    },
    sendCommand(serial: string, commands: Commands) {
      sendCommandCalls.push({ serial, commands }); return Promise.resolve(true);
    },
  };
  const handler = new KumoThermostatAccessory(
    platform as never,
    makeAccessory('Target', SERIAL) as never,
    kumoAPI as never,
    30,
  );
  const setProfile = (p: DeviceProfile) => profileCb!(SERIAL, p);
  return { handler, sendCommandCalls, setProfile };
}

const zone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
}) as unknown as Zone;

// NOTE: mirrored setpoints are snapped to the Fahrenheit grid by clampSetpoint,
// so the expected values below are the grid points, not the source's raw value:
// 21.5°C is 70.7°F -> 71°F -> 21.7°C; 23°C is 73.4°F -> 73°F -> 22.8°C. A mirror
// target must land on the same displayed degree as its source, which means it has
// to be on the same grid.
test('heat mirror sends one combined operationMode + spHeat + raw fan', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'heat', power: 1, spHeat: 21.5, spCool: 24, fanSpeed: 'powerful' });
  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'heat', spHeat: 21.7, fanSpeedRaw: 'powerful' });
});

test('off mirror sends operationMode:off only (no setpoint, no fan)', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await handler.applyMirror({ operationMode: 'off', power: 0, spHeat: 21, spCool: 24, fanSpeed: 'auto' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'off' });
});

test('an off mirror does not cache the source fan speed it never sent', async () => {
  const { handler, setProfile } = makeHarness();
  setProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'heat', fanSpeed: 'quiet' }));
  await handler.applyMirror({ operationMode: 'off', power: 0, spHeat: 21, spCool: 24, fanSpeed: 'powerful' });
  assert.strictEqual(handler['currentStatus']!.fanSpeed, 'quiet');
});

test('autoHeat normalizes to auto with both setpoints', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'autoHeat', power: 1, spHeat: 20, spCool: 25, fanSpeed: 'auto' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'auto', spHeat: 20, spCool: 25, fanSpeedRaw: 'auto' });
});

test('a setpoint above the target range is clamped to the target limit', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile({ maximumSetPoints: { cool: 30, heat: 28, auto: 30 } }));
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await handler.applyMirror({ operationMode: 'heat', power: 1, spHeat: 35, spCool: 24, fanSpeed: 'auto' });
  // 28°C is 82.4°F, not a whole °F. clampSetpoint steps along the °F grid into
  // the range rather than handing back the raw bound, so the result is the
  // largest whole °F that fits: 82°F = 27.8°C. Returning 28 would store an
  // off-grid value on the mirror target and drift its displayed degree away
  // from the source's.
  assert.strictEqual(sendCommandCalls[0].commands.spHeat, 27.8);
});

test('dry mirror sends spCool + power when the target uses a dry setpoint', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile({ usesSetPointInDryMode: true }));
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'dry', power: 1, spHeat: 20, spCool: 23, fanSpeed: 'quiet' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'dry', power: 1, spCool: 22.8, fanSpeedRaw: 'quiet' });
});

test('a target without dry capability skips a dry mirror', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile({ hasModeDry: false }));
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'dry', power: 1, spHeat: 20, spCool: 23, fanSpeed: 'auto' });
  assert.strictEqual(sendCommandCalls.length, 0);
});

test('vent mirror sends operationMode:vent + power + fan, no setpoint', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile({ hasModeVent: true }));
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'vent', power: 1, spHeat: 20, spCool: 23, fanSpeed: 'low' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'vent', power: 1, fanSpeedRaw: 'low' });
});

test('cool mirror sends operationMode:cool + spCool + fan', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await handler.applyMirror({ operationMode: 'cool', power: 1, spHeat: 20, spCool: 22.3, fanSpeed: 'auto' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'cool', spCool: 22.3, fanSpeedRaw: 'auto' });
});
