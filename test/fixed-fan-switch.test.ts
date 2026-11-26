// The "<unit> Fixed Fan Speed" switch, and how one HAP request's fan writes
// resolve to one fan value.
//
// Apple Home draws no Fan Mode (TargetFanState) for this fan, yet every Home
// scene replays the TargetFanState and RotationSpeed it captured. A deliberate
// speed and an incidental one arrive as the same bytes. So a request that
// carries TargetFanState together with a HeaterCooler write is read as a scene
// replay, and it sets fan auto unless the scene turns this switch on. Everything
// else (a slider drag, Siri, a lone Eve Fan Mode) does what it says. The rules
// are resolveFanBurst in src/accessory.ts; it is tested directly at the bottom.
//
// Every multi-write request below is checked in every dispatch order, because
// hap-nodejs dispatches a request's handlers in one loop, in no promised order.
// Writes go through hapWrite, so HAP stores what Home wrote AFTER the handler,
// and each test checks what the characteristics read afterwards, not only what
// was sent.

import test from 'node:test';
import assert from 'node:assert';

import { resolveFanBurst } from '../dist/accessory.js';
import type { Commands, DeviceProfile, KumoConfig, Zone } from '../dist/settings.js';
import {
  Characteristic, Service, hapWrite, makeAccessory, makeAccessoryHarness,
  type FakeAccessory, type FakeLog, type FakeService,
} from './helpers';

const SERIAL = 'TESTSERIAL001';
const C = Characteristic;

const PROFILE: Partial<DeviceProfile> = {
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  hasModeHeat: true, hasModeVent: false, hasModeDry: false,
  hasVaneDir: true, hasVaneSwing: true, hasFanSpeedAuto: true,
};

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

const OFF_UNIT = { power: 0, operationMode: 'off' };

// The flush runs on the next tick; settle also covers revertSoon's 100 ms.
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = () => new Promise((r) => setTimeout(r, 150));

/** Every ordering of a request's writes: hap-nodejs promises none. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) {
    return [items];
  }
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

function makeHarness(
  kumoConfig: Partial<KumoConfig> = {},
  opts: { accessory?: FakeAccessory; log?: Partial<FakeLog>; profile?: boolean } = {},
) {
  const h = makeAccessoryHarness({
    kumoConfig, accessory: opts.accessory ?? makeAccessory('Bedroom'), log: opts.log,
  });
  if (opts.profile !== false) {
    h.applyProfile(PROFILE);
  }
  const tile = () => h.accessory.getServiceById(Service.Switch, 'fan-fixed');
  const fanValue = (id: unknown) => h.fan.chars.get(id)?.value;
  const write = (svc: () => FakeService | null, id: unknown, value: unknown) =>
    () => hapWrite(svc()!.getCharacteristic(id), value);
  const hc = () => h.heaterCooler;
  const fan = () => h.fan;
  // One write per characteristic a request can carry, by name.
  const writes: Record<string, () => Promise<void>> = {
    climate: write(hc, C.Active, C.Active.ACTIVE),
    off: write(hc, C.Active, C.Active.INACTIVE),
    auto: write(fan, C.TargetFanState, C.TargetFanState.AUTO),
    manual: write(fan, C.TargetFanState, C.TargetFanState.MANUAL),
    speed0: write(fan, C.RotationSpeed, 0),
    speed25: write(fan, C.RotationSpeed, 25),
    speed50: write(fan, C.RotationSpeed, 50),
    speed75: write(fan, C.RotationSpeed, 75),
    fanOn: write(fan, C.Active, C.Active.ACTIVE),
    tileOn: write(tile, C.On, true),
    tileOff: write(tile, C.On, false),
    swingOff: write(hc, C.SwingMode, C.SwingMode.SWING_DISABLED),
    swingOn: write(hc, C.SwingMode, C.SwingMode.SWING_ENABLED),
  };
  /** Dispatch one request's writes the way hap-nodejs does: one loop, no awaits. */
  const request = (names: string[]) => Promise.all(names.map((n) => writes[n]()));
  const reads = () => ({
    tile: tile()?.chars.get(C.On)?.value,
    mode: fanValue(C.TargetFanState),
    slider: fanValue(C.RotationSpeed),
  });
  return { ...h, tile, request, reads, writes };
}

/** A request in every order, each on a fresh unit, all at once. */
async function everyOrder(
  names: string[],
  check: (h: ReturnType<typeof makeHarness>, label: string) => void,
  setup: (h: ReturnType<typeof makeHarness>) => void,
  kumoConfig: Partial<KumoConfig> = {},
  wait: () => Promise<unknown> = tick,
) {
  // allSettled: on a failure every order still finishes inside this test,
  // rather than failing later against an unrelated one.
  const results = await Promise.allSettled(permutations(names).map(async (order) => {
    const h = makeHarness(kumoConfig);
    setup(h);
    const done = h.request(order);
    await wait();
    check(h, `order ${order.join(' > ')}`);
    await done;
  }));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
}

const fanSent = (h: { sent: Commands[] }) => h.sent.filter((c) => 'fanSpeed' in c);

// ---- structure -------------------------------------------------------------

test('a unit with an auto fan gets the switch by default, named for the unit, and it is published', () => {
  const h = makeHarness({}, { profile: false });
  h.applyProfile(PROFILE);

  const tile = h.tile();
  assert.ok(tile, 'on by default');
  assert.strictEqual(tile.name, 'Bedroom Fixed Fan Speed');
  assert.strictEqual(tile.chars.get(C.ConfiguredName)?.value, 'Bedroom Fixed Fan Speed');

  const before = h.published.length;
  h.applyProfile(PROFILE);
  assert.strictEqual(h.published.length, before, 're-applying the same profile does not re-publish');
});

// The first profile also publishes for TargetFanState, so the switch's own
// publish is checked where it is the only thing added.
test('opting in later adds the switch and publishes the addition', () => {
  const h = makeHarness({ fixedFanSpeedSwitch: false });
  assert.strictEqual(h.tile(), null);
  const before = h.published.length;

  h.kumoConfig.fixedFanSpeedSwitch = true;
  h.applyProfile(PROFILE);
  assert.ok(h.tile());
  assert.strictEqual(h.published.length, before + 1, 'added after publish, so re-published once');

  h.applyProfile(PROFILE);
  assert.strictEqual(h.published.length, before + 1, 'and not again');
});

test('a switch created after a status has arrived shows that status at once', () => {
  const h = makeHarness({}, { profile: false });
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  h.applyProfile(PROFILE);
  assert.strictEqual(h.reads().tile, true);
});

test('no switch on a unit without an auto fan, or with fixedFanSpeedSwitch: false', () => {
  const noAuto = makeHarness({}, { profile: false });
  noAuto.applyProfile({ ...PROFILE, hasFanSpeedAuto: false });
  assert.strictEqual(noAuto.tile(), null);

  const optedOut = makeHarness({ fixedFanSpeedSwitch: false });
  assert.strictEqual(optedOut.tile(), null);
});

// Default on: only a literal false turns it off, so a hand-edited "no" keeps it.
test('only a literal false opts out', () => {
  const h = makeHarness({ fixedFanSpeedSwitch: 'no' } as unknown as Partial<KumoConfig>);
  assert.ok(h.tile());
});

test('opting out later removes the switch and publishes the removal', () => {
  const h = makeHarness();
  assert.ok(h.tile());
  const before = h.published.length;

  h.kumoConfig.fixedFanSpeedSwitch = false;
  h.applyProfile(PROFILE);

  assert.strictEqual(h.tile(), null);
  assert.ok(h.published.length > before);
});

// Opted out after a run with the default, the cached switch must not decide a
// scene in the window before the first profile: the opt-out is the 2.3.1 rule.
test('opted out, a cached switch is removed at construction and a replay sends what it captured', async () => {
  const accessory = makeAccessory('Bedroom');
  accessory.addService(Service.Switch, 'Bedroom Fixed Fan Speed', 'fan-fixed');
  const h = makeHarness({ fixedFanSpeedSwitch: false }, { accessory, profile: false });
  assert.strictEqual(h.tile(), null, 'gone before any profile arrives');

  h.applyProfile(PROFILE);
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  await h.request(['climate', 'manual', 'speed50']);
  await tick();
  assert.deepStrictEqual(fanSent(h), [{ fanSpeed: 'low' }]);
});

// The Fan Auto and Vane Auto switches were on this branch, never released. A
// cached copy is removed at construction rather than left as a dead tile.
test('cached Fan Auto and Vane Auto switches are removed at construction, with one log line', () => {
  const accessory = makeAccessory('Bedroom');
  accessory.addService(Service.Switch, 'Bedroom Fan Auto', 'fan-auto');
  accessory.addService(Service.Switch, 'Bedroom Vane Auto', 'vane-auto');
  const lines: string[] = [];

  makeHarness({}, { accessory, log: { info: (m: string) => lines.push(m) }, profile: false });

  assert.strictEqual(accessory.getServiceById(Service.Switch, 'fan-auto'), null);
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'vane-auto'), null);
  assert.strictEqual(lines.filter((l) => l.includes('retired')).length, 1);
});

test('leftover showFanAutoSwitch / showVaneAutoSwitch keys create nothing', () => {
  const h = makeHarness({ showFanAutoSwitch: true, showVaneAutoSwitch: true } as Partial<KumoConfig>);
  assert.strictEqual(h.accessory.getServiceById(Service.Switch, 'fan-auto'), null);
  assert.strictEqual(h.accessory.getServiceById(Service.Switch, 'vane-auto'), null);
  assert.ok(h.tile());
});

// After a restart the switch comes back from the cache before any profile has
// arrived. Without binding it at construction it would sit in HomeKit with no
// handlers until the first profile_update.
test('a cached switch is live from construction, before any profile', async () => {
  const first = makeHarness();
  first.tile()!.setCharacteristic(C.ConfiguredName, 'Bedroom pinned fan');

  const second = makeHarness({}, { accessory: first.accessory, profile: false });
  assert.deepStrictEqual(second.published, [], 'adopting a cached switch publishes nothing');
  second.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  assert.strictEqual(second.reads().tile, true, 'tracks state with no profile delivered');

  await second.writes.tileOff();
  await tick();
  assert.deepStrictEqual(second.sent, [{ fanSpeed: 'auto' }], 'and its handler is bound');

  second.applyProfile(PROFILE);
  assert.strictEqual(second.tile()!.chars.get(C.ConfiguredName)?.value, 'Bedroom pinned fan',
    'a name given in the Home app survives a restart');
});

// ---- what it reads -----------------------------------------------------------

test('the switch reads On only while the unit is on at a fixed speed', async () => {
  const h = makeHarness();

  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  assert.strictEqual(h.reads().tile, true);
  assert.strictEqual(await h.handler.getFixedFanOn(), true);

  h.handler.updateFromZone(zone({ fanSpeed: 'Auto' }));      // some units capitalise
  assert.strictEqual(h.reads().tile, false, 'auto is not fixed');

  h.handler.updateFromZone(zone({ fanSpeed: 'notAFanSpeed' }));
  assert.strictEqual(h.reads().tile, false, 'nor is a speed it does not know');

  // Home counts any switch that is on as the unit being on.
  h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'low' }));
  assert.strictEqual(h.reads().tile, false, 'off while the unit is off, whatever it stores');
  assert.strictEqual(await h.handler.getFixedFanOn(), false);
});

test('the switch follows the unit off and on when HomeKit does the switching', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  await h.writes.off();
  await settle();
  assert.strictEqual(h.reads().tile, false);
  await h.writes.climate();
  await settle();
  assert.strictEqual(h.reads().tile, true);
  assert.ok(h.sent.every((c) => Object.keys(c).join() === 'operationMode'),
    `on and off touch no fan value; sent ${JSON.stringify(h.sent)}`);
});

// No power-on default: a bare power, mode or setpoint write is a climate-only
// request, and it writes no fan or vane value.
test('a climate-only request sends no fan or vane value', async () => {
  for (const unit of [OFF_UNIT, {}]) {
    const h = makeHarness();
    h.handler.updateFromZone(zone({ ...unit, fanSpeed: 'low', airDirection: 'vertical' }));
    await h.writes.climate();
    await settle();
    assert.deepStrictEqual(h.sent.filter((c) => 'fanSpeed' in c || 'vaneDir' in c), [],
      `unit ${JSON.stringify(unit)}: sent ${JSON.stringify(h.sent)}`);
  }
});

// ---- taps --------------------------------------------------------------------

test('tapping it On holds the speed the slider shows; Off sends fan auto', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'powerful' }));
  h.handler.updateFromZone(zone({ fanSpeed: 'auto' }));

  await h.writes.tileOn();
  await tick();
  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'powerful' }]);
  assert.deepStrictEqual(h.reads(),
    { tile: true, mode: C.TargetFanState.MANUAL, slider: 75 });

  await h.writes.tileOff();
  await tick();
  assert.deepStrictEqual(h.sent.slice(1), [{ fanSpeed: 'auto' }]);
  assert.deepStrictEqual(h.reads(),
    { tile: false, mode: C.TargetFanState.AUTO, slider: 75 });
});

// The tile reads On only once the unit confirms a speed, so during a drag's
// round trip the slider shows the new speed and the tile still reads Off: just
// when a user taps it.
test('tapping it On while a slider drag is still on its way holds the dragged speed', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  h.handler.updateFromZone(zone({ fanSpeed: 'auto' }));
  const pending: Array<(v: boolean) => void> = [];
  h.handler['kumoAPI'].sendCommand = (_s: string, c: Commands) => {
    h.sent.push(c);
    return new Promise<boolean>((r) => pending.push(r));
  };

  await h.writes.speed75();
  await tick();
  assert.deepStrictEqual({ slider: h.reads().slider, tile: h.reads().tile }, { slider: 75, tile: false },
    'HAP shows the drag, the unit has not confirmed it');
  await h.writes.tileOn();
  await tick();
  pending.forEach((r) => r(true));
  await tick();

  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'powerful' }, { fanSpeed: 'powerful' }]);
  assert.strictEqual(h.reads().slider, 75);
});

// The off unit refuses a command without a mode, so the write is stashed, and
// the tile goes back to what is true. Like a slider drag on an off unit, the
// stash is sent by a turn-on within OFF_STASH_MS, even a separate one.
test('tapping it On while the unit is off sends nothing until a turn-on, and the switch goes back to Off', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'auto' }));

  await h.writes.tileOn();
  assert.strictEqual(h.reads().tile, true, 'HAP stored the tap');
  await settle();

  assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.reads().tile, false);

  await h.writes.climate();
  await new Promise((r) => setTimeout(r, 1700));
  assert.strictEqual(Object.keys(h.sent[0]).join(), 'operationMode');
  assert.deepStrictEqual(fanSent(h), [{ fanSpeed: 'quiet' }], 'a turn-on soon after sends the held speed');
});

test('a refused tap puts the switch back', async () => {
  const h = makeHarness();
  h.handler['kumoAPI'].sendCommand = async () => false;
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  await h.writes.tileOff();
  await tick();

  assert.strictEqual(h.reads().tile, true, 'the unit is still at a fixed speed');
});

// ---- scene replays -----------------------------------------------------------

// The common case: a scene saved while the fan sat at a manual speed. It carries
// MANUAL and the captured speed, and the user cannot see either in Home.
test('a replay of MANUAL and a speed without the switch sets fan auto, in every order', async () => {
  await everyOrder(['climate', 'manual', 'speed25'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }], label);
    assert.deepStrictEqual(h.reads(),
      { tile: false, mode: C.TargetFanState.AUTO, slider: 50 },
      `${label}: HAP stored MANUAL and 25, and the truth is pushed back`);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'low' })));
});

test('a replay of AUTO and a speed sets fan auto, in every order', async () => {
  await everyOrder(['climate', 'auto', 'speed25'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }], label);
    assert.deepStrictEqual(h.reads(),
      { tile: false, mode: C.TargetFanState.AUTO, slider: 50 }, `${label}: the slider keeps the old speed`);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'low' })));
});

// A scene that pins a speed on purpose: the slider at the bottom and the switch On.
test('a replay with the switch On sends the scene\'s speed, in every order', async () => {
  await everyOrder(['climate', 'manual', 'speed0', 'tileOn'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'superQuiet' }], label);
    assert.deepStrictEqual(h.reads(),
      { tile: true, mode: C.TargetFanState.MANUAL, slider: 0 }, label);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'auto' })));
});

test('a replay with the switch Off sets fan auto, in every order', async () => {
  await everyOrder(['climate', 'manual', 'speed0', 'tileOff'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }], label);
    assert.deepStrictEqual(h.reads(),
      { tile: false, mode: C.TargetFanState.AUTO, slider: 50 }, label);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'low' })));
});

// fixedFanSpeedSwitch: false restores 2.3.1: a captured AUTO wins, otherwise
// the captured speed.
test('with fixedFanSpeedSwitch: false a replay sends what it captured, in every order', async () => {
  const setup = (h: ReturnType<typeof makeHarness>) =>
    h.handler.updateFromZone(zone({ fanSpeed: 'auto' }));
  await everyOrder(['climate', 'manual', 'speed25'], (h, label) => {
    assert.strictEqual(h.tile(), null);
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'quiet' }], label);
  }, setup, { fixedFanSpeedSwitch: false });
  await everyOrder(['climate', 'auto', 'speed25'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }], label);
  }, setup, { fixedFanSpeedSwitch: false });
});

// Each HeaterCooler binding marks the request, not only Active. The thresholds
// hold their own send for 1.5 s, which is why only fan commands are compared.
for (const [label, id, value] of [
  ['TargetHeaterCoolerState', C.TargetHeaterCoolerState, C.TargetHeaterCoolerState.COOL],
  ['HeatingThresholdTemperature', C.HeatingThresholdTemperature, 20],
  ['CoolingThresholdTemperature', C.CoolingThresholdTemperature, 24],
  ['SwingMode', C.SwingMode, C.SwingMode.SWING_ENABLED],
] as const) {
  test(`a ${label} write marks the request as a replay, in every order`, async () => {
    await Promise.all(permutations(['hc', 'manual', 'speed25']).map(async (order) => {
      const h = makeHarness();
      h.handler.updateFromZone(zone({ fanSpeed: 'low' }));
      const done = Promise.all(order.map((n) =>
        n === 'hc' ? hapWrite(h.heaterCooler.getCharacteristic(id), value) : h.writes[n]()));
      await tick();
      assert.deepStrictEqual(fanSent(h), [{ fanSpeed: 'auto' }], `order ${order.join(' > ')}`);
      await done;
    }));
  });
}

// One burst for the whole request: one fan command and one vane command.
test('a replay that also carries Oscillate off sends one fan and one vane command, in every order', async () => {
  await everyOrder(['climate', 'manual', 'speed25', 'swingOff'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }, { vaneDir: 'auto' }], label);
    assert.strictEqual(h.heaterCooler.chars.get(C.SwingMode)?.value, C.SwingMode.SWING_DISABLED);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'low', airDirection: 'vertical' })));
});

// The rules read no prior state but the last manual speed, so a scene run twice
// ends where it ended the first time, and two units in one request do not mix.
test('a replay run twice sends the same thing twice, and units resolve independently', async () => {
  const a = makeHarness();
  const b = makeHarness({}, { accessory: makeAccessory('Den', 'TESTSERIAL002') });
  a.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  b.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  for (let run = 0; run < 2; run++) {
    void a.request(['climate', 'manual', 'speed25']);
    void b.request(['manual', 'speed25']);          // B's request carries no climate write
    await tick();
  }

  assert.deepStrictEqual(a.sent, [{ fanSpeed: 'auto' }, { fanSpeed: 'auto' }]);
  assert.deepStrictEqual(b.sent, [{ fanSpeed: 'quiet' }, { fanSpeed: 'quiet' }]);
});

// ---- not replays ---------------------------------------------------------------

test('a slider drag sends its speed, with or without a MANUAL beside it, in every order', async () => {
  await everyOrder(['speed25'], (h) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'quiet' }]);
    assert.deepStrictEqual(h.reads(), { tile: true, mode: C.TargetFanState.MANUAL, slider: 25 });
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'auto' })));
  await everyOrder(['manual', 'speed25'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'quiet' }], label);
    assert.deepStrictEqual(h.reads(), { tile: true, mode: C.TargetFanState.MANUAL, slider: 25 }, label);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'auto' })));
});

test('a lone Fan Mode write (Eve) is honoured', async () => {
  const toAuto = makeHarness();
  toAuto.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  await toAuto.writes.auto();
  await tick();
  assert.deepStrictEqual(toAuto.sent, [{ fanSpeed: 'auto' }]);
  assert.strictEqual(toAuto.reads().tile, false);

  const toManual = makeHarness();
  toManual.handler.updateFromZone(zone({ fanSpeed: 'powerful' }));
  toManual.handler.updateFromZone(zone({ fanSpeed: 'auto' }));
  await toManual.writes.manual();
  await tick();
  assert.deepStrictEqual(toManual.sent, [{ fanSpeed: 'powerful' }]);
  assert.strictEqual(toManual.reads().tile, true);
});

// Siri "set the fan to 50%" can carry the fan's Active=1. That goes to setActive,
// but not through the climate binding, so it does not make the request a replay.
test('a fan Active ON does not mark the request: a Siri-style speed still applies, in every order', async () => {
  await everyOrder(['fanOn', 'manual', 'speed50'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'low' }], label);
    assert.strictEqual(h.reads().tile, true, label);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'auto' })));
});

// ---- the unit is off or going off ------------------------------------------------

// The turn-on goes first; the fan and vane the request resolved to were stashed
// and follow it in one command (see offStash). A scene saved while the unit was
// off captured the switch Off, so the result is auto.
test('a replay that turns an off unit on sends fan auto after the turn-on, in every order', async () => {
  await everyOrder(['climate', 'manual', 'speed25', 'swingOff'], (h, label) => {
    assert.strictEqual(Object.keys(h.sent[0]).join(), 'operationMode', `${label}: the turn-on goes first`);
    assert.deepStrictEqual(h.sent.slice(1), [{ fanSpeed: 'auto', vaneDir: 'auto' }], label);
    assert.deepStrictEqual(h.reads(), { tile: false, mode: C.TargetFanState.AUTO, slider: 50 }, label);
  }, (h) => h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'low', airDirection: 'vertical' })),
  {}, () => new Promise((r) => setTimeout(r, 1700)));
});

// A scene saved while the unit ran at a pinned speed captured the switch On.
test('a replay with the switch On that turns an off unit on sends its speed and swing, in every order', async () => {
  await everyOrder(['climate', 'manual', 'speed0', 'tileOn', 'swingOn'], (h, label) => {
    assert.strictEqual(Object.keys(h.sent[0]).join(), 'operationMode', `${label}: the turn-on goes first`);
    assert.deepStrictEqual(h.sent.slice(1), [{ fanSpeed: 'superQuiet', vaneDir: 'swing' }], label);
    assert.deepStrictEqual(h.reads(), { tile: true, mode: C.TargetFanState.MANUAL, slider: 0 }, label);
    assert.strictEqual(h.heaterCooler.chars.get(C.SwingMode)?.value, C.SwingMode.SWING_ENABLED, label);
  }, (h) => h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'low' })),
  {}, () => new Promise((r) => setTimeout(r, 1800)));
});

test('a Siri speed that also turns an off unit on applies after the turn-on, in every order', async () => {
  await everyOrder(['fanOn', 'speed50'], (h, label) => {
    assert.strictEqual(Object.keys(h.sent[0]).join(), 'operationMode', label);
    assert.deepStrictEqual(h.sent.slice(1), [{ fanSpeed: 'low' }], label);
    assert.strictEqual(h.reads().tile, true, label);
  }, (h) => h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'auto' })),
  {}, () => new Promise((r) => setTimeout(r, 1700)));
});

test('an "AC off" scene sends only the off, and the switch reads Off, in every order', async () => {
  await everyOrder(['off', 'manual', 'speed25', 'swingOff'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ operationMode: 'off' }], label);
    assert.strictEqual(h.reads().tile, false, label);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'low', airDirection: 'vertical' })),
  {}, settle);
});

// ---- No Response -----------------------------------------------------------------

test('No Response reaches the switch, and a tap still sends', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  h.handler.setCloudConnected(false);
  assert.ok(h.reads().tile instanceof Error, 'the error is pushed to the switch');
  await assert.rejects(() => h.handler.getFixedFanOn());

  await h.writes.tileOff();
  await tick();
  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }]);

  h.handler.setCloudConnected(true);
  assert.strictEqual(h.reads().tile, false, 'recovery repaints it from what was sent');
});

test('No Response: a scene replay still resolves by the same rules and sends', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'low', airDirection: 'vertical' }));
  h.handler.setCloudConnected(false);

  await h.request(['climate', 'manual', 'speed25', 'swingOff']);
  await settle();
  assert.deepStrictEqual(h.sent.filter((c) => 'fanSpeed' in c || 'vaneDir' in c),
    [{ fanSpeed: 'auto' }, { vaneDir: 'auto' }]);

  h.handler.setCloudConnected(true);
  assert.deepStrictEqual(h.reads(), { tile: false, mode: C.TargetFanState.AUTO, slider: 50 });
  assert.strictEqual(h.heaterCooler.chars.get(C.SwingMode)?.value, C.SwingMode.SWING_DISABLED);
});

// ---- the log -------------------------------------------------------------------------

// So the owner can check at home that a slider drag is not taken for a replay.
test('the flush logs the rule it applied, and at debug what the request held', async () => {
  const info: string[] = [];
  const debug: string[] = [];
  const h = makeHarness({}, { log: { info: (m: string) => info.push(m), debug: (m: string) => debug.push(m) } });
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  await h.request(['manual', 'speed25']);
  await tick();
  await h.request(['climate', 'manual', 'speed25']);
  await tick();

  assert.deepStrictEqual(info.filter((l) => l.includes('->') && !l.includes('HomeKit sent')), [
    '[FAN] Bedroom: Fan Mode manual -> "quiet"',
    '[FAN] Bedroom: scene replay without Fixed Fan Speed -> "auto"',
  ]);
  assert.deepStrictEqual(debug.filter((l) => l.startsWith('[BURST]')), [
    '[BURST] Bedroom: held speed, mode',
    '[BURST] Bedroom: held climate, speed, mode',
  ]);
});

// ---- resolveFanBurst, directly -------------------------------------------------------

test('resolveFanBurst applies its rules in order', () => {
  const last = 'powerful' as const;
  const cases: Array<[string, Parameters<typeof resolveFanBurst>, string | null]> = [
    ['nothing', [{}, true, true, last], null],
    ['switch On, no speed', [{ manual: true }, false, true, last], 'powerful'],
    ['switch On beats a replay', [{ manual: true, mode: 'manual', speed: 'quiet' }, true, true, last], 'quiet'],
    ['switch Off beats a lone MANUAL', [{ manual: false, mode: 'manual', speed: 'quiet' }, false, true, last], 'auto'],
    ['replay with the switch', [{ mode: 'manual', speed: 'quiet' }, true, true, last], 'auto'],
    ['replay without the switch: MANUAL', [{ mode: 'manual', speed: 'quiet' }, true, false, last], 'quiet'],
    ['replay without the switch: AUTO', [{ mode: 'auto', speed: 'quiet' }, true, false, last], 'auto'],
    ['lone AUTO', [{ mode: 'auto', speed: 'quiet' }, false, true, last], 'auto'],
    ['lone MANUAL, no speed', [{ mode: 'manual' }, false, true, last], 'powerful'],
    ['lone speed', [{ speed: 'quiet' }, false, true, last], 'quiet'],
    ['a speed with only a climate write', [{ speed: 'quiet' }, true, true, last], 'quiet'],
  ];
  for (const [label, args, expected] of cases) {
    assert.strictEqual(resolveFanBurst(...args)?.speed ?? null, expected, label);
  }
});
