// The source-side status hook: onStatusUpdate must fire both when an update is
// observed (streaming/poll/local, via processZoneUpdate) AND when a HomeKit
// setter changes this unit — so a HomeKit change to the source mirrors without
// waiting for the echo. It must NOT fire on a dropped/no-op path.
//
// Under HeaterCooler the setter surface is split three ways where Thermostat had
// two: the setpoint is a *threshold* characteristic (spHeat/spCool directly, no
// TargetTemperature), the mode is TargetHeaterCoolerState (heat/cool/auto only),
// and on/off is its own Active characteristic. All three are control paths a
// mirror source can be driven through, so all three must fire the hook — an
// unhooked setter means the target silently stops following until the next
// streaming/poll echo (up to a full poll interval late), which is exactly the
// latency this hook exists to remove.

import test from 'node:test';
import assert from 'node:assert';

import type { DeviceStatus, Zone } from '../dist/settings.js';
import { Characteristic, makeAccessory, SWITCHES_ON, makeAccessoryHarness } from './helpers';

const SERIAL = 'TESTSOURCE01';

const makeHarness = () =>
  makeAccessoryHarness({ kumoConfig: SWITCHES_ON, accessory: makeAccessory('Source', SERIAL) });
const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'heat',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 21, spCool: 24, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
}) as unknown as Zone;

test('onStatusUpdate fires on an observed (polled) update with the new state', () => {
  const { handler } = makeHarness();
  const seen: Array<Record<string, unknown>> = [];
  handler.onStatusUpdate((s: DeviceStatus) => seen.push({ mode: s.operationMode, spHeat: s.spHeat }));
  handler.updateFromZone(zone({ operationMode: 'heat', spHeat: 22 }));
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0], { mode: 'heat', spHeat: 22 });
});

// The setpoint hook used to be checked through TargetTemperature, which no longer
// exists — HeaterCooler's threshold characteristics are the setpoint controls in
// every mode. The hook must fire on the *quantized* value that was actually sent,
// not the raw °C HomeKit wrote: mirror.ts's signature is built from spHeat/spCool,
// so a hook that reported the pre-quantization float would put the source's
// signature permanently out of step with the value the hardware holds, and every
// later echo would look like a fresh change and re-push the target.
//
// 23°C is deliberately off the °F grid: 23 × 9/5 + 32 = 73.4°F → nearest whole
// 73°F → (73 − 32) × 5/9 = 22.777…°C → nearest 0.5°C, the grid the cloud accepts,
// = 23.0. (No device profile is loaded here, so the clamp range is the 10–35
// default and does not move the result.)
test('onStatusUpdate fires after a HomeKit setpoint change (setter hook)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat', spHeat: 20 })); // seed status
  const seen: number[] = [];
  handler.onStatusUpdate((s: DeviceStatus) => seen.push(s.spHeat));
  await handler.setHeatingThresholdTemperature(23);
  assert.ok(seen.includes(23), `expected a listener fire with spHeat 23, got ${JSON.stringify(seen)}`);
});

test('onStatusUpdate fires after a HomeKit mode change (setter hook)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' })); // seed status
  const seen: string[] = [];
  handler.onStatusUpdate((s: DeviceStatus) => seen.push(s.operationMode));
  await handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.COOL);
  assert.ok(seen.includes('cool'), `expected a listener fire with mode cool, got ${JSON.stringify(seen)}`);
});

// On/off is a separate characteristic now, so it is a separate setter — and the
// one whose miss is most expensive. Under Thermostat, an off was a mode change
// and rode the mode setter's hook for free; here setTargetHeaterCoolerState can
// never carry it (TargetHeaterCoolerState has no OFF member). If Active did not
// notify, turning the source off in HomeKit would leave a mirrored target running
// until an echo arrived — the "AC off scene left the living room on" failure this
// whole hook was added for.
test('onStatusUpdate fires after a HomeKit on/off change (Active setter hook)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool', power: 1 })); // seed status
  const seen: Array<Record<string, unknown>> = [];
  handler.onStatusUpdate((s: DeviceStatus) => seen.push({ mode: s.operationMode, power: s.power }));
  await handler.setActive(Characteristic.Active.INACTIVE);
  assert.deepStrictEqual(
    seen.filter((s) => s.mode === 'off' && s.power === 0).length, 1,
    `expected exactly one listener fire with the unit off, got ${JSON.stringify(seen)}`,
  );
});

test('multiple listeners are all invoked', () => {
  const { handler } = makeHarness();
  let a = 0; let b = 0;
  handler.onStatusUpdate(() => { a++; });
  handler.onStatusUpdate(() => { b++; });
  handler.updateFromZone(zone());
  assert.strictEqual(a, 1);
  assert.strictEqual(b, 1);
});
