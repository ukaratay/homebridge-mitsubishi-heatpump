// Vane writes: one device field behind several HomeKit characteristics.
//
// The unit stores a single vane value (`auto`, `swing`, or one of five fixed
// angles). HomeKit reaches it through SwingMode on the HeaterCooler ("Oscillate"
// in Apple Home) and the tilt angle of the opt-in Slats service. Two rules:
//
//  1. Oscillate OFF means vane auto, from any state, tapped or replayed by a
//     scene. HAP has nowhere else to put vane auto, and a remembered fixed angle
//     (what 2.3.1 sent) reset on every restart.
//  2. hap-nodejs dispatches the handlers of one request without awaiting them,
//     so a scene carrying SwingMode and the tilt it also captured is resolved as
//     one value: swing ON, then a tilt, then OFF (auto).

import test from 'node:test';
import assert from 'node:assert';

import type { KumoConfig, Zone } from '../dist/settings.js';
import { Characteristic, makeAccessory, makeAccessoryHarness } from './helpers';

const SERIAL = 'TESTSERIAL001';

function makeHarness(kumoConfig: Partial<KumoConfig> = { exposeVaneSlat: true }) {
  const h = makeAccessoryHarness({ kumoConfig, accessory: makeAccessory('Bedroom') });
  // SwingMode and the Slats service are capability-gated, so a profile comes first.
  h.applyProfile({
    minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
    maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
    hasModeHeat: true, hasVaneDir: true, hasVaneSwing: true, hasFanSpeedAuto: true,
  });
  return h;
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

// Vane writes are resolved per request on the next tick (see noteBurst).
const tick = () => new Promise((r) => setTimeout(r, 5));

const SWING = Characteristic.SwingMode;

// ---- OFF means auto ---------------------------------------------------------

for (const before of ['auto', 'midpoint', 'swing']) {
  test(`swing OFF sends vane auto from ${before}`, async () => {
    const { handler, sent, heaterCooler } = makeHarness();
    handler.updateFromZone(zone({ airDirection: 'vertical' }));   // a fixed angle remembered
    handler.updateFromZone(zone({ airDirection: before }));

    await handler.setSwingMode(SWING.SWING_DISABLED);
    await tick();

    // One redundant command when the vane is already in auto: the plugin does
    // not dedupe against a state it only knows second-hand.
    assert.deepStrictEqual(sent, [{ vaneDir: 'auto' }]);
    assert.strictEqual(heaterCooler.chars.get(SWING)?.value, SWING.SWING_DISABLED);
  });
}

test('swing ON sends swing', async () => {
  const { handler, sent, heaterCooler } = makeHarness();
  handler.updateFromZone(zone({ airDirection: 'auto' }));

  await handler.setSwingMode(SWING.SWING_ENABLED);
  await tick();

  assert.deepStrictEqual(sent, [{ vaneDir: 'swing' }]);
  assert.strictEqual(heaterCooler.chars.get(SWING)?.value, SWING.SWING_ENABLED);
});

test('a tilt angle alone still sets that angle', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ airDirection: 'auto' }));

  await handler.setTargetTiltAngle(45);
  await tick();

  assert.deepStrictEqual(sent, [{ vaneDir: 'midvertical' }]);
});

// ---- one request, one write ------------------------------------------------

// A scene captured while the vane was swinging holds SwingMode ON and, with the
// Slats service on, the tilt angle the service was last showing.
test('swing ON beats the tilt the same scene captured, in either order', async () => {
  for (const swingFirst of [true, false]) {
    const { handler, sent } = makeHarness();
    handler.updateFromZone(zone({ airDirection: 'horizontal' }));

    if (swingFirst) {
      void handler.setSwingMode(SWING.SWING_ENABLED);
      void handler.setTargetTiltAngle(90);
    } else {
      void handler.setTargetTiltAngle(90);
      void handler.setSwingMode(SWING.SWING_ENABLED);
    }
    await tick();

    assert.deepStrictEqual(sent, [{ vaneDir: 'swing' }], `swingFirst=${swingFirst}`);
  }
});

// A scene captured at a fixed angle, replayed while the unit is swinging: the
// tilt names where to go, the OFF only says "not swinging".
test('a tilt beats the swing OFF the same scene captured, in either order', async () => {
  for (const offFirst of [true, false]) {
    const { handler, sent } = makeHarness();
    handler.updateFromZone(zone({ airDirection: 'horizontal' }));
    handler.updateFromZone(zone({ airDirection: 'swing' }));

    if (offFirst) {
      void handler.setSwingMode(SWING.SWING_DISABLED);
      void handler.setTargetTiltAngle(90);
    } else {
      void handler.setTargetTiltAngle(90);
      void handler.setSwingMode(SWING.SWING_DISABLED);
    }
    await tick();

    assert.deepStrictEqual(sent, [{ vaneDir: 'vertical' }], `offFirst=${offFirst}`);
  }
});

// The off-unit rule is unchanged by the coalescing: one resolved value is held
// for a turn-on in the same burst and sent after it (see offStash).
test('the vane writes of a scene that turns an OFF unit on reach it as one value', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', airDirection: 'horizontal' }));

  await Promise.all([
    handler.setTargetTiltAngle(90),
    handler.setSwingMode(SWING.SWING_ENABLED),
    handler.setActive(Characteristic.Active.ACTIVE),
  ]);
  await tick();

  assert.strictEqual(Object.keys(sent[0]).join(), 'operationMode', 'the turn-on goes first');
  assert.deepStrictEqual(sent.slice(1), [{ vaneDir: 'swing' }]);
});

// Queued writes run from a bare setTimeout, where nothing above them catches. A
// transport that throws instead of returning false must not become an unhandled
// rejection, which would take the whole Homebridge process down.
test('a queued vane write that throws is caught and the tile is put back', async () => {
  const { handler, heaterCooler } = makeHarness();
  handler.updateFromZone(zone({ airDirection: 'auto' }));
  handler['kumoAPI'].sendCommand = async () => {
    throw new Error('socket hang up');
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  await handler.setSwingMode(SWING.SWING_ENABLED);
  heaterCooler.getCharacteristic(SWING).value = SWING.SWING_ENABLED;   // HAP stores the write
  await new Promise((r) => setTimeout(r, 150));
  process.off('unhandledRejection', onUnhandled);

  assert.deepStrictEqual(unhandled, []);
  assert.strictEqual(heaterCooler.getCharacteristic(SWING).value, SWING.SWING_DISABLED);
});

// ---- Vane revert -----------------------------------------------------------
//
// hap-nodejs assigns the written value AFTER the onSet handler resolves
// (Characteristic.handleSetRequest: `await this.setHandler(...)`, then
// `this.value = value`). A revert made inside the handler is overwritten, so these
// tests replay that assignment before checking the tile came back.

const settle = () => new Promise((r) => setTimeout(r, 150));

test('a failed vane write puts SwingMode back after HAP stores the written value', async () => {
  const { handler, heaterCooler } = makeHarness();
  handler.updateFromZone(zone({ airDirection: 'auto' }));
  handler['kumoAPI'].sendCommand = async () => false;

  await handler.setSwingMode(SWING.SWING_ENABLED);
  heaterCooler.getCharacteristic(SWING).value = SWING.SWING_ENABLED;
  await settle();

  assert.strictEqual(heaterCooler.getCharacteristic(SWING).value, SWING.SWING_DISABLED);
});

test('a vane write refused behind an off puts SwingMode back too', async () => {
  const { handler, heaterCooler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ airDirection: 'auto' }));

  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  const pSwing = handler.setSwingMode(SWING.SWING_ENABLED);
  await Promise.all([pOff, pSwing]);
  heaterCooler.getCharacteristic(SWING).value = SWING.SWING_ENABLED;
  await settle();

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'off' }]);
  assert.strictEqual(heaterCooler.getCharacteristic(SWING).value, SWING.SWING_DISABLED);
});
