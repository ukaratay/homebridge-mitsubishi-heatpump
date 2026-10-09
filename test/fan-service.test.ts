// The Fanv2 service: speed, auto/manual, and the on/off relationship.
//
// WHY THIS SERVICE EXISTS. Fan speed used to live on the HeaterCooler's own
// RotationSpeed, with `auto` encoded as 0. That was wrong twice over:
//
//   1. RotationSpeed is a percentage and 0 means "off" everywhere else in
//      HomeKit, so auto rendered as an empty slider.
//   2. `auto` is not a point on the airflow ladder at all. In auto the unit may
//      be blowing at full power while a 0 slider claims it is at its slowest.
//
// HAP models exactly this with TargetFanState (MANUAL/AUTO) — which exists on
// Fanv2 and NOT on HeaterCooler (verified against hap-nodejs). So the fan moved
// to its own service, the slider carries only the five real speeds, and auto
// became an orthogonal flag instead of a fake speed.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import { FAN_SPEEDS } from '../dist/settings.js';
import type { Commands, DeviceProfile, FanSpeed, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory, type FakeService } from './helpers';

const SERIAL = 'TESTSERIAL001';

type ProfilePayload = Partial<DeviceProfile>;

// hap-nodejs puts setPrimaryService/addLinkedService on every Service and
// FakeService does not, so the link-aware accessory below grafts them on — the
// same optional shape src probes for before calling them.
type LinkableService = FakeService & {
  setPrimaryService?(value?: boolean): void;
  addLinkedService?(service: FakeService): void;
};

function makeHarness() {
  const sendCommandCalls: Array<{ serial: string; commands: Commands }> = [];
  let profileCb: ((serial: string, profile: ProfilePayload) => void) | null = null;
  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: {},
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb: (serial: string, profile: ProfilePayload) => void) { profileCb = cb; },
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
  // TargetFanState and SwingMode are capability-gated, so a realistic harness has
  // to deliver a profile before either exists.
  profileCb!(SERIAL, {
    minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
    maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
    hasModeVent: true, hasModeDry: true, hasModeHeat: true,
    hasVaneDir: true, hasVaneSwing: true, hasFanSpeedAuto: true,
    usesSetPointInDryMode: true,
  });
  return {
    handler, accessory, sendCommandCalls,
    fan: accessory.getServiceById(Service.Fanv2, 'airflow')!,
    heaterCooler: accessory.getService(Service.HeaterCooler)!,
  };
}

// Fan writes are coalesced onto the next tick (see queueFanIntent), so a test has
// to let that tick run before asserting what was sent.
const tick = () => new Promise((r) => setTimeout(r, 5));

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

async function rotationOf(handler: KumoThermostatAccessory): Promise<number> {
  const pct = await handler.getRotationSpeed();
  if (typeof pct !== 'number') {
    assert.fail(`RotationSpeed must read back as a number, got ${String(pct)}`);
  }
  return pct;
}

// ---- Structure -----------------------------------------------------------

test('the fan lives on its own Fanv2 service, not on the HeaterCooler', () => {
  const { fan, heaterCooler } = makeHarness();

  assert.notStrictEqual(fan, null, 'a Fanv2 service is created for every unit');
  assert.ok(fan.chars.has(Characteristic.RotationSpeed), 'speed is on the fan service');
  assert.ok(fan.chars.has(Characteristic.TargetFanState), 'auto/manual is on the fan service');
  assert.ok(!heaterCooler.chars.has(Characteristic.RotationSpeed),
    'the HeaterCooler must NOT also carry a speed control — two controls, one field');
  // Swing deliberately does NOT move: Apple Home's default collapsed tile renders
  // the fan's speed but hides its Oscillate toggle, which would make vane control
  // unreachable on a default install.
  assert.ok(heaterCooler.chars.has(Characteristic.SwingMode),
    'swing stays on the climate tile where Home actually renders it');
  assert.ok(!fan.chars.has(Characteristic.SwingMode));
});

test('the five speeds fill the slider evenly, one position each', async () => {
  // 0/25/50/75/100 — every position is a distinct real speed. No duplicates (the
  // earlier 20%-step scale had 0 and 20 both meaning superQuiet) and nothing dead.
  const { fan } = makeHarness();
  const props = fan.chars.get(Characteristic.RotationSpeed)!.props;

  assert.strictEqual(props?.minValue, 0);
  assert.strictEqual(props?.maxValue, 100);
  assert.strictEqual(props?.minStep, 25);
  const num = (key: string): number => {
    const v = props?.[key];
    if (typeof v !== 'number') {
      assert.fail(`RotationSpeed props.${key} must be a number, got ${String(v)}`);
    }
    return v;
  };
  const positions = (num('maxValue') - num('minValue')) / num('minStep') + 1;
  assert.strictEqual(positions, FAN_SPEEDS.length - 1,
    'exactly one detent per real speed, auto excluded');
});

test('0 is the quietest speed, not off', async () => {
  // minValue must stay 0 regardless: hap-nodejs rejects a client write below
  // minValue with -70410 instead of clamping, and Home sends 0 when a fan slider
  // is dragged to the bottom. Power stays on the climate tile.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'powerful' }));

  await handler.setRotationSpeed(0);
  await tick();

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'superQuiet' });
});

// ---- Speed round-trip ----------------------------------------------------

test('each detent maps to its own real speed', async () => {
  const cases: Array<[number, FanSpeed]> = [
    [0, 'superQuiet'], [25, 'quiet'], [50, 'low'], [75, 'powerful'], [100, 'superPowerful'],
  ];
  for (const [pct, speed] of cases) {
    const { handler, sendCommandCalls } = makeHarness();
    handler.updateFromZone(zone());
    await handler.setRotationSpeed(pct);
    await tick();
    assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: speed },
      `${pct}% must send ${speed}`);
  }
});

test('the slider can never produce "auto"', async () => {
  // Every reachable detent is a real speed; index 0 (the auto sentinel) is not on
  // this slider at all.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setRotationSpeed(0);
  await tick();

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'superQuiet' });
  assert.ok(!sendCommandCalls.some((c) => c.commands.fanSpeed === 'auto'));
});

test('a reported speed reads back as its own detent', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'powerful' }));

  assert.strictEqual(await handler.getRotationSpeed(), 75);
  assert.strictEqual(await handler.getTargetFanState(), Characteristic.TargetFanState.MANUAL);
});

// ---- Auto ----------------------------------------------------------------

test('auto is reported on TargetFanState, not as a speed', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'auto' }));

  assert.strictEqual(await handler.getTargetFanState(), Characteristic.TargetFanState.AUTO,
    'auto is a mode flag');
  assert.notStrictEqual(await handler.getRotationSpeed(), 0,
    'and must NOT render as a zeroed slider, which reads as "off"');
});

test('switching to AUTO sends auto', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'quiet' }));

  await handler.setTargetFanState(Characteristic.TargetFanState.AUTO);
  await tick();

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'auto' });
});

test('leaving AUTO restores the last real speed the unit was seen at', async () => {
  // The device stores ONE fan field, so "manual" has to name a speed. Falling
  // back to a fixed default would silently change the user's airflow; the last
  // observed speed is the only answer that does not.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'powerful' }));   // observed
  handler.updateFromZone(zone({ fanSpeed: 'auto' }));       // then switched to auto

  await handler.setTargetFanState(Characteristic.TargetFanState.MANUAL);
  await tick();

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'powerful' },
    'not a hardcoded default');
});

test('in auto the slider shows the last real speed, not zero', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'low' }));
  handler.updateFromZone(zone({ fanSpeed: 'auto' }));

  assert.strictEqual(await handler.getRotationSpeed(), 50,
    'the slider keeps a meaningful position; TargetFanState carries the auto-ness');
});

test('moving the slider leaves auto', async () => {
  const { handler, fan, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'auto' }));

  await handler.setRotationSpeed(25);
  await tick();

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'quiet' });
  assert.strictEqual(fan.chars.get(Characteristic.TargetFanState)!.value,
    Characteristic.TargetFanState.MANUAL,
    'picking a speed is inherently manual — the toggle follows once the write lands');
});

test('an explicit AUTO beats a speed sent in the same burst', async () => {
  // HomeKit delivers a scene as ONE write request and hap-nodejs dispatches every
  // handler in it concurrently without awaiting. A scene that sets "fan auto"
  // also re-sends its captured RotationSpeed, so before the writes were coalesced
  // whichever handler finished last won and auto landed in manual at random.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'quiet' }));

  await Promise.all([
    handler.setTargetFanState(Characteristic.TargetFanState.AUTO),
    handler.setRotationSpeed(75),
  ]);
  await tick();

  assert.strictEqual(sendCommandCalls.length, 1, 'the burst collapses to one command');
  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'auto' },
    'the explicit auto wins over the speed the scene happened to carry');
});

test('the same burst in the other order still resolves to auto', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'quiet' }));

  await Promise.all([
    handler.setRotationSpeed(75),
    handler.setTargetFanState(Characteristic.TargetFanState.AUTO),
  ]);
  await tick();

  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'auto' },
    'order of dispatch must not decide the outcome');
});

// ---- On/off --------------------------------------------------------------

test('the fan tile follows the unit power', async () => {
  const { handler } = makeHarness();

  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));
  assert.strictEqual(await handler.getFanActive(), Characteristic.Active.ACTIVE);
  assert.strictEqual(await handler.getCurrentFanState(), Characteristic.CurrentFanState.BLOWING_AIR);

  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));
  assert.strictEqual(await handler.getFanActive(), Characteristic.Active.INACTIVE);
  assert.strictEqual(await handler.getCurrentFanState(), Characteristic.CurrentFanState.INACTIVE);
});

test('turning the fan tile OFF does NOT turn the unit off', async () => {
  // Apple documents room-scoped Siri fan commands ("Turn off the fan.", "Turn on
  // the fan in the office."), and a HomePod answers a bare "turn off the fan" for
  // its own room. If a fan-tile off reached the unit's power, any of those would
  // shut down the heat pump — the same shape as the Slats service being swept up
  // by a blinds command. The write is bounced instead.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  await handler.setFanActive(Characteristic.Active.INACTIVE);
  await tick();

  assert.strictEqual(sendCommandCalls.length, 0,
    'a room-wide "turn off the fan" must not be able to stop the heat pump');
});

test('turning the fan tile ON does turn the unit on', async () => {
  // Only the off direction is refused: an on is unambiguous and harmless.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setFanActive(Characteristic.Active.ACTIVE);
  await tick();

  assert.strictEqual(sendCommandCalls.length, 1);
  assert.ok(sendCommandCalls[0].commands.operationMode !== 'off');
});

// ---- Service linkage -----------------------------------------------------
//
// `primary` and `linked` are part of a service's HAP representation. Declaring
// them says "the HeaterCooler is this accessory, and the fan belongs to it"
// rather than leaving a Fanv2 looking like a standalone fan that a room-level or
// category-wide command should sweep up. That is the exact failure the Slats
// service hit when it was silently grouped with the user's real blinds.

function makeLinkAwareHarness() {
  const linked: FakeService[] = [];
  let primary = false;
  const accessory = makeAccessory('Bedroom');
  const origAdd = accessory.addService;
  accessory.addService = (type, name, subtype) => {
    const svc: LinkableService = origAdd(type, name, subtype);
    svc.setPrimaryService = (v) => { if (svc.type === Service.HeaterCooler) primary = v !== false; };
    svc.addLinkedService = (s) => linked.push(s);
    return svc;
  };
  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: {},
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand() { return Promise.resolve(true); },
  };
  const handler = new KumoThermostatAccessory(
    platform as never,
    accessory as never,
    kumoAPI as never,
    30,
  );
  return { handler, accessory, linked, isPrimary: () => primary };
}

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

  await handler.setSwingMode(Characteristic.SwingMode.SWING_ENABLED);
  heaterCooler.getCharacteristic(Characteristic.SwingMode).value = Characteristic.SwingMode.SWING_ENABLED;
  await settle();

  assert.strictEqual(heaterCooler.getCharacteristic(Characteristic.SwingMode).value,
    Characteristic.SwingMode.SWING_DISABLED);
});

test('a vane write refused behind an off puts SwingMode back too', async () => {
  const { handler, heaterCooler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ airDirection: 'auto' }));

  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  const pSwing = handler.setSwingMode(Characteristic.SwingMode.SWING_ENABLED);
  await Promise.all([pOff, pSwing]);
  heaterCooler.getCharacteristic(Characteristic.SwingMode).value = Characteristic.SwingMode.SWING_ENABLED;
  await settle();

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'off' }]);
  assert.strictEqual(heaterCooler.getCharacteristic(Characteristic.SwingMode).value,
    Characteristic.SwingMode.SWING_DISABLED);
});

test('the HeaterCooler is declared the primary service', () => {
  const { isPrimary } = makeLinkAwareHarness();
  assert.strictEqual(isPrimary(), true,
    'the climate tile is the accessory; the rest hang off it');
});

test('the fan service is linked to the HeaterCooler', () => {
  const { linked, accessory } = makeLinkAwareHarness();
  const fan = accessory.getServiceById(Service.Fanv2, 'airflow')!;

  assert.ok(linked.includes(fan),
    'an unlinked Fanv2 reads as a standalone fan, which is how a "turn off the ' +
    'fans" command reaches a heat pump');
});

test('every real speed round-trips to its own position and back', async () => {
  const { handler } = makeHarness();
  for (const speed of FAN_SPEEDS.slice(1)) {
    handler.updateFromZone(zone({ fanSpeed: speed }));
    const pct = await rotationOf(handler);
    assert.strictEqual(FAN_SPEEDS[Math.round(pct / 25) + 1], speed,
      `${speed} reported as ${pct}% must map back to itself`);
  }
});
