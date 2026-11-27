// The "<unit> Fixed Fan Speed" accessory: a Fanv2 on an accessory of its own,
// where Off is fan auto and On holds the slider's speed.
//
// WHY IT IS A SEPARATE ACCESSORY. Apple Home stores every writable value of a
// fan that shares an accessory with the HeaterCooler in each scene containing
// the AC, and its scene editor shows only temperature and mode. Every scene
// replayed a fan speed nobody chose. On its own accessory the fan is a tile a
// scene includes or leaves out, and a request that leaves it out carries no fan
// write. So nothing here is inferred from the climate writes of a request: the
// rules are resolveFanBurst in src/accessory.ts, tested directly at the bottom.
//
// Every multi-write request below is checked in every dispatch order, because
// hap-nodejs dispatches a request's handlers in one loop, in no promised order.
// Writes go through hapWrite, so HAP stores what Home wrote AFTER the handler,
// and each test checks what the characteristics read afterwards, not only what
// was sent.

import test from 'node:test';
import assert from 'node:assert';

import { resolveFanBurst } from '../dist/accessory.js';
import { FAN_SPEEDS } from '../dist/settings.js';
import type { Commands, DeviceProfile, FanSpeed, KumoConfig, Zone } from '../dist/settings.js';
import {
  Characteristic, Service, hapWrite, makeAccessory, makeAccessoryHarness,
  type FakeAccessory, type FakeLog, type FakeService,
} from './helpers';

const SERIAL = 'TESTSERIAL001';
const C = Characteristic;
const ON = C.Active.ACTIVE;
const OFF = C.Active.INACTIVE;

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

// The flush runs on the next tick; settle also covers revertSoon's 100 ms, and
// turnOn the 1500 ms an ON for an off unit is held (ACTIVE_ON_HOLD_MS).
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = () => new Promise((r) => setTimeout(r, 150));
const turnOn = () => new Promise((r) => setTimeout(r, 1800));

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
  opts: {
    accessory?: FakeAccessory; fanAccessory?: FakeAccessory | null;
    log?: Partial<FakeLog>; profile?: Partial<DeviceProfile> | false;
    /** Keep the real FAN_HOLD_MS; the harness zeroes it otherwise. */
    realFanHold?: boolean;
  } = {},
) {
  const h = makeAccessoryHarness({
    kumoConfig, accessory: opts.accessory ?? makeAccessory('Bedroom'),
    fanAccessory: opts.fanAccessory, log: opts.log, realFanHold: opts.realFanHold,
  });
  if (opts.profile !== false) {
    h.applyProfile(opts.profile ?? PROFILE);
  }
  const fanValue = (id: unknown) => h.fan.chars.get(id)?.value;
  const write = (svc: FakeService, id: unknown, value: unknown) =>
    () => hapWrite(svc.getCharacteristic(id), value);
  // One write per characteristic a request can carry, by name.
  const writes: Record<string, () => Promise<void>> = {
    climate: write(h.heaterCooler, C.Active, ON),
    off: write(h.heaterCooler, C.Active, OFF),
    fanOn: write(h.fan, C.Active, ON),
    fanOff: write(h.fan, C.Active, OFF),
    speed0: write(h.fan, C.RotationSpeed, 0),
    speed40: write(h.fan, C.RotationSpeed, 40),
    speed60: write(h.fan, C.RotationSpeed, 60),
    speed80: write(h.fan, C.RotationSpeed, 80),
    swingOff: write(h.heaterCooler, C.SwingMode, C.SwingMode.SWING_DISABLED),
    swingOn: write(h.heaterCooler, C.SwingMode, C.SwingMode.SWING_ENABLED),
  };
  /** Dispatch one request's writes the way hap-nodejs does: one loop, no awaits. */
  const request = (names: string[]) => Promise.all(names.map((n) => writes[n]()));
  const reads = () => ({ fan: fanValue(C.Active), slider: fanValue(C.RotationSpeed) });
  return { ...h, request, reads, writes };
}

/** A request in every order, each on a fresh unit, all at once. */
async function everyOrder(
  names: string[],
  check: (h: ReturnType<typeof makeHarness>, label: string) => void,
  setup: (h: ReturnType<typeof makeHarness>) => void,
  wait: () => Promise<unknown> = tick,
) {
  // allSettled: on a failure every order still finishes inside this test,
  // rather than failing later against an unrelated one.
  const results = await Promise.allSettled(permutations(names).map(async (order) => {
    const h = makeHarness();
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

test('the fan is a Fanv2 on its own accessory, and the AC accessory carries no fan', () => {
  const h = makeHarness();

  assert.ok(h.fanAccessory, 'the unit has a Fixed Fan Speed accessory');
  assert.strictEqual(h.fanAccessory.displayName, 'Bedroom Fixed Fan Speed');
  assert.strictEqual(h.fan.name, 'Bedroom Fixed Fan Speed');
  assert.ok(h.fan.chars.has(C.Active));
  assert.ok(h.fan.chars.has(C.RotationSpeed));
  // Home stores a hidden value for every writable characteristic of a scene's
  // tile, so the fan carries the two the editor shows and nothing else.
  assert.ok(!h.fan.chars.has(C.TargetFanState), 'no Fan Mode: Home hides it and scenes would store it');
  assert.ok(!h.fan.chars.has(C.SwingMode));
  assert.strictEqual(
    h.fanAccessory.getService(Service.AccessoryInformation)!.chars.get(C.SerialNumber)?.value,
    `${SERIAL}-fan`);

  assert.strictEqual(h.accessory.getService(Service.Fanv2), null);
  assert.strictEqual(h.accessory.getServiceById(Service.Fanv2, 'airflow'), null);
  assert.ok(!h.heaterCooler.chars.has(C.RotationSpeed),
    'a fan value on the AC accessory is replayed by every scene that contains the AC');
  // Swing does stay: Home shows Oscillate on the AC page and nowhere on a fan
  // inside a grouped tile.
  assert.ok(h.heaterCooler.chars.has(C.SwingMode));
});

test('with fixedFanSpeed: false there is no fan control, and status updates still apply', async () => {
  const h = makeAccessoryHarness({ kumoConfig: { fixedFanSpeed: false }, accessory: makeAccessory('Bedroom') });
  h.applyProfile(PROFILE);

  assert.strictEqual(h.fanAccessory, null);
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  h.handler.setCloudConnected(false);
  h.handler.setCloudConnected(true);
  assert.strictEqual(h.accessory.getService(Service.Fanv2), null);
  assert.strictEqual(await h.handler.getActive(), ON);
});

// 2.3.1 linked a Fanv2 ("airflow") to the HeaterCooler; builds of this branch
// added three switches that were never released. All leave the AC accessory, and
// Home drops the scene actions that wrote them.
test('the fan services of earlier versions are removed from the AC accessory, with one log line', () => {
  const accessory = makeAccessory('Bedroom');
  accessory.addService(Service.Fanv2, 'Bedroom Fan', 'airflow');
  accessory.addService(Service.Switch, 'Bedroom Fixed Fan Speed', 'fan-fixed');
  accessory.addService(Service.Switch, 'Bedroom Fan Auto', 'fan-auto');
  accessory.addService(Service.Switch, 'Bedroom Vane Auto', 'vane-auto');
  const lines: string[] = [];

  const h = makeHarness({}, { accessory, log: { info: (m: string) => lines.push(m) }, profile: false });

  assert.strictEqual(accessory.getServiceById(Service.Fanv2, 'airflow'), null);
  for (const subtype of ['fan-fixed', 'fan-auto', 'vane-auto']) {
    assert.strictEqual(accessory.getServiceById(Service.Switch, subtype), null, subtype);
  }
  const moved = lines.filter((l) => l.includes('removed the fan controls'));
  assert.strictEqual(moved.length, 1);
  assert.ok(moved[0].includes('"Bedroom Fixed Fan Speed"'), moved[0]);
  assert.ok(h.fan, 'and the fan is on its own accessory');
});

test('leftover showFanAutoSwitch / showVaneAutoSwitch keys create nothing', () => {
  const h = makeHarness({ showFanAutoSwitch: true, showVaneAutoSwitch: true } as Partial<KumoConfig>);
  assert.strictEqual(h.accessory.getServiceById(Service.Switch, 'fan-auto'), null);
  assert.strictEqual(h.accessory.getServiceById(Service.Switch, 'vane-auto'), null);
});

// After a restart the accessory comes back from the cache before any profile
// has arrived, and it must not sit in HomeKit with no handlers until one does.
test('a cached Fixed Fan Speed accessory is live from construction, before any profile', async () => {
  const first = makeHarness();

  const second = makeHarness({}, {
    accessory: first.accessory, fanAccessory: first.fanAccessory, profile: false,
  });
  assert.strictEqual(second.fan, first.fan, 'the cached service is adopted, not duplicated');
  assert.deepStrictEqual(second.published, [], 'adopting it publishes nothing');
  second.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  assert.deepStrictEqual(second.reads(), { fan: ON, slider: 60 }, 'tracks state with no profile delivered');

  await second.writes.fanOff();
  await tick();
  assert.deepStrictEqual(second.sent, [{ fanSpeed: 'auto' }], 'and its handler is bound');
});

// hap-nodejs puts setPrimaryService on every Service and FakeService does not,
// so this grafts it on: the same optional shape src probes for before calling it.
test('the HeaterCooler is declared the primary service', () => {
  let primary = false;
  const accessory = makeAccessory('Bedroom');
  const origAdd = accessory.addService;
  accessory.addService = (type, name, subtype) => {
    const svc: FakeService & { setPrimaryService?(value?: boolean): void } = origAdd(type, name, subtype);
    svc.setPrimaryService = (v) => {
      if (svc.type === Service.HeaterCooler) {
        primary = v !== false;
      }
    };
    return svc;
  };

  makeAccessoryHarness({ accessory });

  assert.strictEqual(primary, true, 'the climate tile is the accessory; the sensors hang off it');
});

// ---- the slider --------------------------------------------------------------

test('the five speeds sit at 20 to 100, and 0 stays writable', () => {
  // minValue must stay 0: hap-nodejs rejects a client write below minValue with
  // -70410 instead of clamping, and Home sends 0 when a fan slider is dragged to
  // the bottom.
  const props = makeHarness().fan.chars.get(C.RotationSpeed)!.props;

  assert.deepStrictEqual(props, { minValue: 0, maxValue: 100, minStep: 20 });
  assert.strictEqual(100 / 20, FAN_SPEEDS.length - 1, 'one position above 0 per real speed, auto excluded');
});

test('each position sends its own speed, and every speed reads back at its position', async () => {
  const cases: Array<[number, FanSpeed]> = [
    [20, 'superQuiet'], [40, 'quiet'], [60, 'low'], [80, 'powerful'], [100, 'superPowerful'],
  ];
  assert.deepStrictEqual(cases.map(([, speed]) => speed), FAN_SPEEDS.slice(1));
  for (const [pct, speed] of cases) {
    const h = makeHarness();
    h.handler.updateFromZone(zone({ fanSpeed: 'auto' }));
    await hapWrite(h.fan.getCharacteristic(C.RotationSpeed), pct);
    await tick();
    assert.deepStrictEqual(h.sent, [{ fanSpeed: speed }], `${pct}% must send ${speed}`);

    h.handler.updateFromZone(zone({ fanSpeed: speed }));
    assert.strictEqual(await h.handler.getRotationSpeed(), pct, `${speed} must read back as ${pct}%`);
  }
});

test('in auto the slider shows the last fixed speed, never 0', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'auto' }));
  assert.strictEqual(await h.handler.getRotationSpeed(), 40, 'quiet until a fixed speed has been seen');

  h.handler.updateFromZone(zone({ fanSpeed: 'Powerful' }));    // some units capitalise
  h.handler.updateFromZone(zone({ fanSpeed: 'auto' }));
  assert.deepStrictEqual(h.reads(), { fan: OFF, slider: 80 });
});

// ---- what it reads -----------------------------------------------------------

test('it reads On only while the unit is on at a fixed speed', async () => {
  const h = makeHarness();

  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  assert.strictEqual(h.reads().fan, ON);
  assert.strictEqual(await h.handler.getFanActive(), ON);

  h.handler.updateFromZone(zone({ fanSpeed: 'Auto' }));      // some units capitalise
  assert.strictEqual(h.reads().fan, OFF, 'auto is not fixed');

  h.handler.updateFromZone(zone({ fanSpeed: 'notAFanSpeed' }));
  assert.strictEqual(h.reads().fan, OFF, 'nor is a speed it does not know');

  h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'low' }));
  assert.strictEqual(h.reads().fan, OFF, 'off while the unit is off, whatever it stores');
  assert.strictEqual(await h.handler.getFanActive(), OFF);
});

test('it follows the unit off and on when HomeKit switches the AC, and neither sends a fan value', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  await h.writes.off();
  await settle();
  assert.strictEqual(h.reads().fan, OFF);
  await h.writes.climate();
  await settle();
  assert.strictEqual(h.reads().fan, ON);
  assert.ok(h.sent.every((c) => Object.keys(c).join() === 'operationMode'),
    `on and off touch no fan value; sent ${JSON.stringify(h.sent)}`);
});

// A scene that contains only the AC, or a bare power, mode or setpoint write,
// carries no fan write, so the fan stays as it was.
test('a request without the fan tile sends no fan or vane value', async () => {
  for (const unit of [OFF_UNIT, {}]) {
    const h = makeHarness();
    h.handler.updateFromZone(zone({ ...unit, fanSpeed: 'low', airDirection: 'vertical' }));
    await h.writes.climate();
    await turnOn();
    assert.deepStrictEqual(h.sent.filter((c) => 'fanSpeed' in c || 'vaneDir' in c), [],
      `unit ${JSON.stringify(unit)}: sent ${JSON.stringify(h.sent)}`);
  }
});

// ---- taps and drags ----------------------------------------------------------

test('On holds the speed the slider shows; Off sends fan auto', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'powerful' }));
  h.handler.updateFromZone(zone({ fanSpeed: 'auto' }));

  await h.writes.fanOn();
  await tick();
  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'powerful' }]);
  assert.deepStrictEqual(h.reads(), { fan: ON, slider: 80 });

  await h.writes.fanOff();
  await tick();
  assert.deepStrictEqual(h.sent.slice(1), [{ fanSpeed: 'auto' }]);
  assert.deepStrictEqual(h.reads(), { fan: OFF, slider: 80 });
});

test('dragging the slider up from Off sends that speed once, in every order', async () => {
  await everyOrder(['speed60'], (h) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'low' }]);
    assert.deepStrictEqual(h.reads(), { fan: ON, slider: 60 });
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'auto' })));
  await everyOrder(['fanOn', 'speed60'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'low' }], label);
    assert.deepStrictEqual(h.reads(), { fan: ON, slider: 60 }, label);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'auto' })));
});

// Home turns a fan off at the bottom of its slider, and sends the 0.
test('dragging the slider to the bottom sets fan auto, in every order', async () => {
  for (const names of [['speed0'], ['speed0', 'fanOff']]) {
    await everyOrder(names, (h, label) => {
      assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }], label);
      assert.deepStrictEqual(h.reads(), { fan: OFF, slider: 60 }, `${label}: the slider is back on the last speed`);
    }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'low' })));
  }
});

test('Off, or a speed of 0, wins over whatever else the request carries, in every order', async () => {
  for (const names of [['fanOff', 'speed80'], ['fanOn', 'speed0']]) {
    await everyOrder(names, (h, label) => {
      assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }], label);
      assert.strictEqual(h.reads().fan, OFF, label);
    }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'low' })));
  }
});

// The tile reads On only once the unit confirms a speed, so during a drag's
// round trip the slider shows the new speed and the tile still reads Off: just
// when a user taps it.
test('On while a slider drag is still on its way holds the dragged speed', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  h.handler.updateFromZone(zone({ fanSpeed: 'auto' }));
  const pending: Array<(v: boolean) => void> = [];
  h.handler['kumoAPI'].sendCommand = (_s: string, c: Commands) => {
    h.sent.push(c);
    return new Promise<boolean>((r) => pending.push(r));
  };

  await h.writes.speed80();
  await tick();
  assert.deepStrictEqual(h.reads(), { fan: OFF, slider: 80 }, 'HAP shows the drag, the unit has not confirmed it');
  await h.writes.fanOn();
  await tick();
  pending.forEach((r) => r(true));
  await tick();

  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'powerful' }, { fanSpeed: 'powerful' }]);
  assert.strictEqual(h.reads().slider, 80);
});

// The fan never powers the unit. The off unit refuses a command without a mode,
// so the write is stashed and the tile goes back to what is true. The stash is
// sent by a turn-on within OFF_STASH_MS, even a separate one.
test('On while the unit is off sends nothing until a turn-on, and the tile goes back to Off', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'auto' }));

  await h.request(['fanOn', 'speed60']);
  assert.strictEqual(h.reads().fan, ON, 'HAP stored the tap');
  await settle();

  assert.deepStrictEqual(h.sent, [], 'a fan tile cannot turn the heat pump on');
  assert.strictEqual(h.reads().fan, OFF);

  await h.writes.climate();
  await turnOn();
  assert.strictEqual(Object.keys(h.sent[0]).join(), 'operationMode');
  assert.deepStrictEqual(fanSent(h), [{ fanSpeed: 'low' }], 'a turn-on soon after sends the held speed');
});

test('a refused write puts the tile back', async () => {
  const h = makeHarness();
  h.handler['kumoAPI'].sendCommand = async () => false;
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  await h.writes.fanOff();
  await tick();

  assert.deepStrictEqual(h.reads(), { fan: ON, slider: 60 }, 'the unit is still at a fixed speed');
});

// Resolved fan writes run from a bare setTimeout, where nothing above them catches.
// A transport that throws instead of returning false must not become an unhandled
// rejection, which would take the whole Homebridge process down.
test('a queued fan write that throws is caught and the slider is put back', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  h.handler['kumoAPI'].sendCommand = async () => {
    throw new Error('socket hang up');
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  await hapWrite(h.fan.getCharacteristic(C.RotationSpeed), 100);
  await settle();
  process.off('unhandledRejection', onUnhandled);

  assert.deepStrictEqual(unhandled, []);
  assert.strictEqual(h.reads().slider, 60, 'back on the speed the unit is really at');
});

// Off has nothing to mean on a unit that cannot run its fan in auto.
test('on a unit with no auto fan, Off is refused and the speeds still work', async () => {
  const h = makeHarness({}, { profile: { ...PROFILE, hasFanSpeedAuto: false } });
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  await h.writes.fanOff();
  await settle();
  assert.deepStrictEqual(h.sent, []);
  assert.deepStrictEqual(h.reads(), { fan: ON, slider: 60 }, 'put back');

  await h.writes.speed80();
  await tick();
  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'powerful' }]);
});

// ---- the hold ----------------------------------------------------------------
//
// Apple Home writes each step of a slider drag as its own request. Seen live
// 2026-11-27: one drag from the bottom to 80% sent auto, quiet, low, low and
// powerful within a second. These run on the real FAN_HOLD_MS, which the
// harness zeroes everywhere else.

const afterHold = () => new Promise((r) => setTimeout(r, 650));

test('a slider drag sends only its last step', async () => {
  const info: string[] = [];
  const h = makeHarness({}, { realFanHold: true, log: { info: (m: string) => info.push(m) } });
  h.handler.updateFromZone(zone({ fanSpeed: 'auto' }));

  // The requests of the drag in the log, each its own tick.
  for (const names of [['speed0'], ['speed40', 'fanOn'], ['speed60'], ['speed60'], ['speed80']]) {
    await h.request(names);
    await tick();
  }
  assert.deepStrictEqual(h.sent, [], 'nothing goes out while the drag is still moving');
  await afterHold();

  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'powerful' }]);
  assert.deepStrictEqual(h.reads(), { fan: ON, slider: 80 });
  assert.deepStrictEqual(info.filter((l) => l.includes('->') && !l.includes('HomeKit sent')),
    ['[FAN] Bedroom: Fixed Fan Speed on -> "powerful"'], 'and only what was sent is logged as resolved');
});

test('a drag that ends at the bottom sends fan auto once', async () => {
  const h = makeHarness({}, { realFanHold: true });
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  for (const names of [['speed80'], ['speed40'], ['speed0', 'fanOff'], ['speed0']]) {
    await h.request(names);
    await tick();
  }
  await afterHold();

  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }]);
  assert.strictEqual(h.reads().fan, OFF);
});

test('a single tap is sent once the hold has passed, and not before', async () => {
  const h = makeHarness({}, { realFanHold: true });
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  await h.writes.fanOff();
  await settle();
  assert.deepStrictEqual(h.sent, []);
  await afterHold();
  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }]);
});

// The held value meets the off unit either before the turn-on has landed (it is
// stashed and follows the turn-on) or after (it is sent as it is).
test('the hold does not lose a scene\'s fan speed on a unit it turns on, ON first or mode first', async () => {
  const viaOn = makeHarness({}, { realFanHold: true });
  viaOn.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'auto' }));
  await viaOn.request(['climate', 'fanOn', 'speed60']);
  await new Promise((r) => setTimeout(r, 2300));
  assert.strictEqual(Object.keys(viaOn.sent[0]).join(), 'operationMode');
  assert.deepStrictEqual(viaOn.sent.slice(1), [{ fanSpeed: 'low' }]);

  const viaMode = makeHarness({}, { realFanHold: true });
  viaMode.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'auto' }));
  await Promise.all([
    hapWrite(viaMode.heaterCooler.getCharacteristic(C.TargetHeaterCoolerState), C.TargetHeaterCoolerState.HEAT),
    viaMode.request(['fanOn', 'speed60']),
  ]);
  await afterHold();
  assert.deepStrictEqual(viaMode.sent, [{ operationMode: 'heat' }, { fanSpeed: 'low' }]);
});

test('the hold does not let a fan speed out behind an AC off', async () => {
  const h = makeHarness({}, { realFanHold: true });
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  await h.request(['fanOn', 'speed80', 'off']);
  await afterHold();

  assert.deepStrictEqual(h.sent, [{ operationMode: 'off' }]);
  assert.strictEqual(h.reads().fan, OFF);
});

// ---- scenes ------------------------------------------------------------------

// The turn-on goes first; the fan and vane the request resolved to were stashed
// and follow it in one command (see offStash).
test('a scene that turns an off unit on and holds a speed sends the speed after the turn-on, in every order', async () => {
  await everyOrder(['climate', 'fanOn', 'speed60', 'swingOn'], (h, label) => {
    assert.strictEqual(Object.keys(h.sent[0]).join(), 'operationMode', `${label}: the turn-on goes first`);
    assert.deepStrictEqual(h.sent.slice(1), [{ fanSpeed: 'low', vaneDir: 'swing' }], label);
    assert.deepStrictEqual(h.reads(), { fan: ON, slider: 60 }, label);
  }, (h) => h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'auto' })), turnOn);
});

// A scene saved with the tile Off stores only that Off.
test('a scene that turns an off unit on with the tile Off sets fan auto after the turn-on, in every order', async () => {
  await everyOrder(['climate', 'fanOff'], (h, label) => {
    assert.strictEqual(Object.keys(h.sent[0]).join(), 'operationMode', `${label}: the turn-on goes first`);
    assert.deepStrictEqual(h.sent.slice(1), [{ fanSpeed: 'auto' }], label);
    assert.deepStrictEqual(h.reads(), { fan: OFF, slider: 60 }, label);
  }, (h) => h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'low' })), turnOn);
});

test('an "AC off" scene that also carries the fan tile sends only the off, in every order', async () => {
  await everyOrder(['off', 'fanOn', 'speed80', 'swingOff'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ operationMode: 'off' }], label);
    assert.strictEqual(h.reads().fan, OFF, label);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'low', airDirection: 'vertical' })), settle);
});

// One burst for the whole request: one fan command and one vane command.
test('a scene on a running unit sends one fan and one vane command, in every order', async () => {
  await everyOrder(['climate', 'fanOn', 'speed40', 'swingOff'], (h, label) => {
    assert.deepStrictEqual(h.sent, [{ fanSpeed: 'quiet' }, { vaneDir: 'auto' }], label);
    assert.strictEqual(h.heaterCooler.chars.get(C.SwingMode)?.value, C.SwingMode.SWING_DISABLED);
  }, (h) => h.handler.updateFromZone(zone({ fanSpeed: 'low', airDirection: 'vertical' })));
});

// The rules read no prior state but the last fixed speed, so a scene run twice
// ends where it ended the first time, and two units in one request do not mix.
test('a scene run twice sends the same thing twice, and units resolve independently', async () => {
  const a = makeHarness();
  const b = makeHarness({}, { accessory: makeAccessory('Den', 'TESTSERIAL002') });
  a.handler.updateFromZone(zone({ fanSpeed: 'low' }));
  b.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  for (let run = 0; run < 2; run++) {
    void a.request(['climate', 'fanOff']);
    void b.request(['fanOn', 'speed40']);
    await tick();
  }

  assert.deepStrictEqual(a.sent, [{ fanSpeed: 'auto' }, { fanSpeed: 'auto' }]);
  assert.deepStrictEqual(b.sent, [{ fanSpeed: 'quiet' }, { fanSpeed: 'quiet' }]);
});

// ---- No Response -------------------------------------------------------------

test('No Response reaches both fan characteristics, and a write still sends', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  h.handler.setCloudConnected(false);
  assert.ok(h.reads().fan instanceof Error, 'the error is pushed to Active');
  assert.ok(h.reads().slider instanceof Error, 'and to the slider');
  await assert.rejects(() => h.handler.getFanActive());
  await assert.rejects(() => h.handler.getRotationSpeed());

  await h.writes.fanOff();
  await tick();
  assert.deepStrictEqual(h.sent, [{ fanSpeed: 'auto' }]);

  h.handler.setCloudConnected(true);
  assert.deepStrictEqual(h.reads(), { fan: OFF, slider: 60 }, 'recovery repaints it from what was sent');
});

// ---- the log -----------------------------------------------------------------

test('the flush logs what the request resolved to, and at debug what it held', async () => {
  const info: string[] = [];
  const debug: string[] = [];
  const h = makeHarness({}, { log: { info: (m: string) => info.push(m), debug: (m: string) => debug.push(m) } });
  h.handler.updateFromZone(zone({ fanSpeed: 'low' }));

  await h.request(['fanOn', 'speed40']);
  await tick();
  await h.request(['fanOff']);
  await tick();

  assert.deepStrictEqual(info.filter((l) => l.includes('->') && !l.includes('HomeKit sent')), [
    '[FAN] Bedroom: Fixed Fan Speed on -> "quiet"',
    '[FAN] Bedroom: Fixed Fan Speed off -> "auto"',
  ]);
  assert.deepStrictEqual(debug.filter((l) => l.startsWith('[BURST]')), [
    '[BURST] Bedroom: held fan, speed',
    '[BURST] Bedroom: held fan',
  ]);
});

// Seen live 2026-11-27: the rule line alone read as if an off unit had been sent
// a speed.
test('a write held for an off unit says so at info', async () => {
  const info: string[] = [];
  const h = makeHarness({}, { log: { info: (m: string) => info.push(m) } });
  h.handler.updateFromZone(zone({ ...OFF_UNIT, fanSpeed: 'auto' }));

  await h.writes.speed60();
  await settle();

  assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(info.filter((l) => l.includes('"low" is held for a turn-on')).length, 1,
    info.join('\n'));
});

// ---- resolveFanBurst, directly -----------------------------------------------

test('resolveFanBurst: Off or 0 is auto, then the speed, then a bare On', () => {
  const last: FanSpeed = 'quiet';
  const speedOf = (fan: Parameters<typeof resolveFanBurst>[0]) => resolveFanBurst(fan, last)?.speed;

  assert.strictEqual(resolveFanBurst({}, last), null, 'no fan write, no fan command');
  assert.strictEqual(speedOf({ on: false }), 'auto');
  assert.strictEqual(speedOf({ on: false, speed: 'powerful' }), 'auto', 'Off wins over a speed');
  assert.strictEqual(speedOf({ speed: 'auto' }), 'auto', 'the bottom of the slider');
  assert.strictEqual(speedOf({ on: true, speed: 'auto' }), 'auto', '0 wins over On');
  assert.strictEqual(speedOf({ speed: 'low' }), 'low', 'a lone speed is that speed');
  assert.strictEqual(speedOf({ on: true, speed: 'low' }), 'low');
  assert.strictEqual(speedOf({ on: true }), 'quiet', 'a bare On is the last fixed speed');
  assert.strictEqual(resolveFanBurst({ on: true }, last)?.rule, 'Fixed Fan Speed on');
  assert.strictEqual(resolveFanBurst({ on: false }, last)?.rule, 'Fixed Fan Speed off');
});
