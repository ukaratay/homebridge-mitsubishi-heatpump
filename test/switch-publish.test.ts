// Regression test for the runtime-structure-publish fix.
//
// Every service this accessory grows *after* discovery — the fan-only switch
// (1.4.0), the dry switch (1.5.0), the Slats/vane service and the HumiditySensor
// service (both new with the HeaterCooler migration) — is created from an async
// callback: applyDeviceProfile (profile_update) or the first zone update that
// carries a humidity reading. By then the accessory has already been published to
// the bridge. A service or characteristic added to an already-published accessory
// is invisible to HomeKit — and never persisted to cachedAccessories — unless the
// plugin calls api.updatePlatformAccessories([accessory]). It never did, so both
// switches silently failed to appear in the Home app.
//
// These tests drive the compiled accessory with a minimal HAP mock and assert
// that a structural change both mutates the service set AND re-publishes the
// accessory. Before the fix, the publish count was 0.
//
// Since the HeaterCooler migration the switches are ALSO config-gated
// (showDrySwitch / showFanOnlySwitch, both opt-in; exposeVaneSlat, opt-out), so
// each add/remove branch is now driven by capability AND config. Both gates route
// through the same setup*/remove* pair, so both must publish.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Adapter, DeviceProfile, KumoConfig, Zone } from '../dist/settings.js';
import {
  Characteristic, Service, makeLog, makeAccessory,
  type FakeAccessory, type FakeService,
} from './helpers';

const SERIAL = 'TESTSERIAL001';

type ProfilePayload = Partial<DeviceProfile>;

// The switches are opt-in and the vane slats opt-out, so every harness states its
// config explicitly — the gate under test is as much the config as the capability.
const ALL_ON: Partial<KumoConfig> =
  { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true };

function makeHarness(kumoConfig: Partial<KumoConfig> = ALL_ON, existingAccessory?: FakeAccessory) {
  // Each element is the array handed to updatePlatformAccessories, so the length
  // of `updates` is the publish count — which is what every assertion below reads.
  const updates: FakeAccessory[][] = [];
  let profileCb: ((serial: string, profile: ProfilePayload) => void) | null = null;
  let streamCb: ((serial: string, data: Record<string, unknown>) => void) | null = null;
  const config: Partial<KumoConfig> = { ...kumoConfig };
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories: (a: FakeAccessory[]) => updates.push(a) },
    kumoConfig: config,
  };
  const kumoAPI = {
    subscribeToDevice(_serial: string, cb: (serial: string, data: Record<string, unknown>) => void) {
      streamCb = cb;
    },
    onDeviceProfileUpdate(cb: (serial: string, profile: ProfilePayload) => void) { profileCb = cb; },
  };
  const accessory = existingAccessory ?? makeAccessory('Living room');
  const handler = new KumoThermostatAccessory(
    platform as never,
    accessory as never,
    kumoAPI as never,
    30,
  );
  // Both are created by the constructor, before any profile arrives. Asserted
  // rather than optional-chained: if either stops being built the tests below
  // should fail on the missing tile, not silently pass an `undefined` comparison.
  const heaterCooler = accessory.getService(Service.HeaterCooler);
  assert.ok(heaterCooler, 'the constructor publishes the HeaterCooler service');
  const fan = accessory.getServiceById(Service.Fanv2, 'airflow');
  assert.ok(fan, 'the constructor publishes the linked Fanv2 service');
  return {
    handler, accessory, updates, config, heaterCooler, fan,
    // A profile listener is registered in the constructor; if it ever stops being
    // registered this blows up loudly instead of quietly testing nothing.
    applyProfile: (p: ProfilePayload) => profileCb!(SERIAL, p),
    // A device_update as the cloud's stream delivers it.
    stream: (data: Record<string, unknown>) => streamCb!(SERIAL, {
      deviceSerial: SERIAL, roomTemp: 22, spHeat: 20, spCool: 24, power: 1, operationMode: 'cool',
      fanSpeed: 'auto', airDirection: 'auto', humidity: null, ...data,
    }),
  };
}

const zone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

const profile = (over: ProfilePayload = {}): ProfilePayload => ({
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  hasModeVent: true,
  hasModeDry: true,
  ...over,
});

/** Names of every characteristic a service was actually asked for. */
const registeredOn = (svc: FakeService): string[] =>
  [...svc.chars.keys()].map((c) => (c as { _name: string })._name);

// ---- switches: capability gate -------------------------------------------

test('applying a vent+dry profile adds both switches and publishes them to HomeKit', () => {
  const { accessory, updates, applyProfile } = makeHarness();
  assert.strictEqual(updates.length, 0, 'nothing published before a profile arrives');

  applyProfile(profile());

  assert.ok(accessory.getServiceById(Service.Switch, 'fan-only'), 'fan-only switch added');
  assert.ok(accessory.getServiceById(Service.Switch, 'dry'), 'dry switch added');
  // The regression: before the fix this stayed 0 — services existed in memory
  // but were never pushed to the bridge.
  assert.ok(updates.length >= 1, 'accessory re-published after adding switches');
});

test('re-applying the same profile does not re-publish (guarded on real change)', () => {
  const { updates, applyProfile } = makeHarness();
  applyProfile(profile());
  const afterFirst = updates.length;
  applyProfile(profile());
  assert.strictEqual(updates.length, afterFirst, 'no redundant HomeKit config bump');
});

test('dropping dry support removes the switch and publishes the removal', () => {
  const { accessory, updates, applyProfile } = makeHarness();
  applyProfile(profile());
  const before = updates.length;
  applyProfile(profile({ hasModeDry: false }));
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null, 'dry switch removed');
  assert.ok(updates.length > before, 'removal re-published to HomeKit');
});

// ---- the setpoint-range log line -------------------------------------------

// profile_update is a heartbeat: the cloud re-sends each unit's unchanged profile
// every few minutes. Logging the range every time put dozens of identical info
// lines an hour between the ones that matter (upstream counted about 20 an hour
// on five units, homebridge-mitsubishi-comfort ac1b646).
test('the setpoint range is logged when it changes, not on every profile heartbeat', () => {
  const { handler, applyProfile } = makeHarness({});
  const lines: string[] = [];
  handler['platform'].log.info = (message: string) => {
    lines.push(message);
  };
  const ranges = () => lines.filter((l) => l.includes('setpoint range'));

  applyProfile(profile());
  applyProfile(profile());
  applyProfile(profile());
  assert.strictEqual(ranges().length, 1, 'three identical profiles, one line');

  applyProfile(profile({ maximumSetPoints: { cool: 30, heat: 28, auto: 30 } }));
  assert.strictEqual(ranges().length, 2, 'a changed range is logged again');
  assert.match(ranges()[1], /heat 10-30/);
});

// ---- switches: config gate ------------------------------------------------

// Fan speed and dehumidify used to have nowhere to live on a Thermostat tile, so
// both switches were published for every capable unit. On HeaterCooler fan speed
// is RotationSpeed on the main tile, so the fan-only switch is a niche control and
// both switches became opt-in. A capable device with no opt-in must publish
// NOTHING: an unwanted switch is as much a bug as a missing one, and a stray
// publish alone bumps the HomeKit config number for no structural change.
test('a capable device publishes no switches when the config has not opted in', () => {
  const { accessory, updates, applyProfile } = makeHarness({});

  applyProfile(profile());

  assert.strictEqual(accessory.getServiceById(Service.Switch, 'fan-only'), null, 'no fan-only switch');
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null, 'no dry switch');
  assert.strictEqual(updates.length, 0, 'nothing added, so nothing published');
});

// The opt-in is checked with === true, so only a literal true opts in. This pins
// that: a truthy-but-not-true config value (a string from a hand-edited config.json)
// must not silently publish a switch.
//
// KumoConfig types both flags as `boolean | undefined`, so no type-checked caller
// can produce these values — which is the point. Homebridge parses config.json at
// runtime and hands whatever is in the file straight through, so the `=== true`
// check in src is the only thing standing between a stray `"showDrySwitch": "yes"`
// and a switch the user never asked for. The cast records that this input arrives
// from outside the type system, not that the assertion is being loosened.
test('the config gate is strict — only true opts a switch in', () => {
  const handEdited = { showDrySwitch: 'yes', showFanOnlySwitch: 1 } as unknown as Partial<KumoConfig>;
  const { accessory, applyProfile } = makeHarness(handEdited);

  applyProfile(profile());

  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null, 'non-boolean does not opt in');
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'fan-only'), null, 'non-boolean does not opt in');
});

// ---- Slats (vane) ---------------------------------------------------------

// The Slats service is the discrete-vane control, added from the same async
// profile callback as the switches — so it carries the identical publish
// requirement. Isolated here with both switches off, so the publish count is
// attributable to the Slats service alone and cannot be satisfied by a switch
// publish that happens to fire in the same applyDeviceProfile pass.
test('a vane-capable profile adds the Slats service and publishes it', () => {
  const { accessory, updates, applyProfile } = makeHarness({ exposeVaneSlat: true });

  applyProfile(profile({ hasVaneDir: true }));

  assert.ok(accessory.getService(Service.Slats), 'Slats service added');
  assert.strictEqual(updates.length, 1, 'exactly one publish, for the Slats service');
});

test('exposeVaneSlat: false keeps Slats off a vane-capable device', () => {
  const { accessory, updates, applyProfile } = makeHarness({ exposeVaneSlat: false });

  applyProfile(profile({ hasVaneDir: true }));

  assert.strictEqual(accessory.getService(Service.Slats), null, 'opted out, no Slats service');
  assert.strictEqual(updates.length, 0, 'nothing added, so nothing published');
});

// Opting out after the service already exists must remove AND publish, or the
// Home app keeps showing a vane tile that no longer has handlers behind it.
// A live config edit needs a Homebridge restart, so the real-world path is a
// cached Slats service meeting a now-false exposeVaneSlat on the next profile —
// the same removeSlatsService branch this drives.
test('opting out of the vane slats removes the service and publishes the removal', () => {
  const { accessory, updates, config, applyProfile } = makeHarness({ exposeVaneSlat: true });
  applyProfile(profile({ hasVaneDir: true }));
  const before = updates.length;

  config.exposeVaneSlat = false;
  applyProfile(profile({ hasVaneDir: true }));

  assert.strictEqual(accessory.getService(Service.Slats), null, 'Slats service removed');
  assert.ok(updates.length > before, 'removal re-published to HomeKit');
});

// ---- humidity -------------------------------------------------------------

// Same bug class as the switches, but the target moved: CurrentRelativeHumidity
// was an optional characteristic on Thermostat and is NOT valid on HeaterCooler
// (hap-nodejs would add it anyway and emit a "not in required or optional
// characteristic section" warning), so humidity now needs its own HumiditySensor
// service. It is still created lazily on the first non-null reading — long after
// the accessory was published — so it must still re-publish.
test('first humidity reading adds a HumiditySensor service and publishes it', () => {
  const { handler, accessory, updates, heaterCooler } = makeHarness();
  const before = updates.length;

  handler.updateFromZone(zone({ humidity: 51 }));

  const hum = accessory.getService(Service.HumiditySensor);
  assert.ok(hum, 'HumiditySensor service added');
  // `chars.get` rather than `getCharacteristic`: the latter CREATES on lookup, the
  // way real HAP does, and would manufacture the very characteristic under test.
  assert.strictEqual(
    hum.chars.get(Characteristic.CurrentRelativeHumidity)?.value, 51,
    'reading landed on the sensor service',
  );
  // The characteristic must not be hung off the main tile: HeaterCooler does not
  // list it, which is the whole reason the service exists.
  assert.ok(
    !heaterCooler.chars.has(Characteristic.CurrentRelativeHumidity),
    'humidity must not be attached to the HeaterCooler service',
  );
  assert.ok(updates.length > before, 'adding the humidity service re-published the accessory');
});

test('the humidity service is published only once, not on every reading', () => {
  const { handler, accessory, updates } = makeHarness();
  handler.updateFromZone(zone({ humidity: 51 }));
  const after = updates.length;

  handler.updateFromZone(zone({ humidity: 52 }));

  assert.strictEqual(updates.length, after, 'no redundant publish once humidity is registered');
  const hum = accessory.getService(Service.HumiditySensor);
  assert.ok(hum, 'the humidity service is still there');
  assert.strictEqual(
    hum.chars.get(Characteristic.CurrentRelativeHumidity)?.value,
    52,
    'later readings still update the existing service',
  );
});

// ---- a humidity tile that outlived its sensor --------------------------------
//
// The tile is created on the first reading and cached with the accessory, and
// the getter serves 0 when there is no reading. A unit whose wireless sensor was
// moved to another unit, or unpaired, therefore kept a tile reading "0%" for
// good: seen on the owner's Family Room AC (2026-11-25), and by upstream after
// moving a sensor between rooms (homebridge-mitsubishi-comfort fc73d52). The only
// way out was showHumiditySensor false, which removes it from every unit.
//
// The cloud's zone record says outright whether a unit has a source. That, and
// only that, removes the tile.

const NO_SENSOR = { hasSensor: false, hasMhk2: false, humidity: null };

test('the zone record saying there is no sensor removes a cached humidity tile and publishes it', () => {
  const { handler, accessory, updates } = makeHarness();
  handler.updateFromZone(zone({ humidity: 51 }));
  assert.ok(accessory.getService(Service.HumiditySensor), 'the tile exists');
  const before = updates.length;

  handler.updateFromZone(zone(NO_SENSOR));

  assert.strictEqual(accessory.getService(Service.HumiditySensor), null, 'the stale tile is gone');
  assert.strictEqual(updates.length, before + 1, 'removed with exactly one publish');

  handler.updateFromZone(zone(NO_SENSOR));
  assert.strictEqual(updates.length, before + 1, 'and not re-published on every poll');
});

// The cached-accessory case: the tile is already there when the process starts,
// and the platform hands the first zone record to applyZoneSensors at discovery.
test('a humidity tile restored from the cache is removed as soon as the zone record is seen', () => {
  const first = makeHarness();
  first.handler.updateFromZone(zone({ humidity: 51 }));

  const second = makeHarness(ALL_ON, first.accessory);
  assert.ok(second.accessory.getService(Service.HumiditySensor), 'adopted from the cache');
  second.handler.applyZoneSensors(zone(NO_SENSOR).adapter);

  assert.strictEqual(second.accessory.getService(Service.HumiditySensor), null);
  assert.strictEqual(second.updates.length, 1);
});

test('a zone record reporting 0% with no sensor removes the tile too', () => {
  // 0 is what the cloud sends for "none"; a real room is never at 0% RH.
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ humidity: 51 }));

  handler.updateFromZone(zone({ hasSensor: false, hasMhk2: false, humidity: 0 }));

  assert.strictEqual(accessory.getService(Service.HumiditySensor), null);
});

// Everything short of that explicit statement leaves the tile alone. A missing
// reading is not "no sensor": streaming updates omit humidity all the time, and
// removing and re-adding a service is a structural change HomeKit has to re-read.
test('nothing short of an explicit "no sensor" removes the humidity tile', () => {
  const keeps: Array<[string, Record<string, unknown>]> = [
    ['a reading that is merely missing', { humidity: null }],
    ['a record that says nothing about sensors', { humidity: null, hasSensor: undefined }],
    ['a paired wireless sensor', { hasSensor: true, hasMhk2: false, humidity: null }],
    ['an MHK2 wall controller', { hasSensor: false, hasMhk2: true, humidity: null }],
    ['a record that still carries a reading', { hasSensor: false, hasMhk2: false, humidity: 48 }],
  ];
  for (const [why, adapter] of keeps) {
    const { handler, accessory, updates, stream } = makeHarness();
    // The first stream update publishes once for its own reasons (the filter
    // service), so it is taken before the baseline.
    stream({ humidity: 51 });
    const before = updates.length;

    handler.updateFromZone(zone(adapter));
    stream({ humidity: null });

    assert.ok(accessory.getService(Service.HumiditySensor), `kept for ${why}`);
    assert.strictEqual(updates.length, before, `no structural publish for ${why}`);
  }
});

test('a humidity of 0 does not create the tile', () => {
  const { handler, accessory, updates, stream } = makeHarness();
  stream({ humidity: null });            // the stream's own first-update publish
  const before = updates.length;

  handler.updateFromZone(zone({ humidity: 0 }));
  stream({ humidity: 0 });

  assert.strictEqual(accessory.getService(Service.HumiditySensor), null);
  assert.strictEqual(updates.length, before);
});

// Without this the tile would flap: a stream that still carried a humidity for
// the unit re-created the service, and the next poll removed it again.
test('while the cloud says there is no sensor, a reading from the stream does not bring the tile back', () => {
  const { handler, accessory, updates, stream } = makeHarness();
  stream({ humidity: 51 });
  handler.updateFromZone(zone(NO_SENSOR));
  const after = updates.length;

  stream({ humidity: 47 });
  assert.strictEqual(accessory.getService(Service.HumiditySensor), null, 'the zone record is the authority');
  assert.strictEqual(updates.length, after);

  // A sensor is paired again: the record changes, and the next reading creates it.
  handler.updateFromZone(zone({ hasSensor: true, hasMhk2: false, humidity: null }));
  stream({ humidity: 47 });
  assert.ok(accessory.getService(Service.HumiditySensor), 'back once the cloud reports a sensor');
  assert.strictEqual(
    accessory.getService(Service.HumiditySensor)!.chars.get(Characteristic.CurrentRelativeHumidity)?.value, 47);
});

// ---- swing ----------------------------------------------------------------

// This was a real bug in src/accessory.ts and this test was checked in FAILING to
// pin it. It is fixed — applyDeviceProfile now calls publishStructureChange()
// inside the `if (profile.hasVaneSwing && !this.swingModeRegistered)` block — and
// the test is kept as the regression guard for it. The mechanism, so nobody
// "simplifies" the publish back out:
//
// applyDeviceProfile registers SwingMode with
// `this.service.getCharacteristic(C.SwingMode)`. In hap-nodejs, getCharacteristic()
// on a characteristic the service does not yet carry ADDS it (Service.js:186-230;
// SwingMode is in HeaterCooler's optionalCharacteristics list,
// ServiceDefinitions.js:701) — so this is a structural change to an
// already-published accessory, exactly like the humidity characteristic was.
// Without the publish, the swing toggle never reaches the Home app and is never
// persisted to cachedAccessories.
//
// The bug was masked whenever the same applyDeviceProfile pass also added or
// removed a service, because those publishes flush the pending SwingMode too.
// This profile is the unmasked case, and it is the DEFAULT configuration:
// swing-capable, no discrete vane positions, both switches at their opt-out
// default. Keep it that way — widening this profile re-masks the regression.
test('registering SwingMode publishes it to HomeKit', () => {
  const { updates, applyProfile, fan, heaterCooler } = makeHarness({});

  applyProfile(profile({
    hasVaneSwing: true, hasVaneDir: false, hasModeVent: false, hasModeDry: false,
  }));

  // Swing stays on the HeaterCooler: Apple Home's default collapsed tile renders
  // a fan's speed but hides its Oscillate toggle, so swing on the Fanv2 would be
  // invisible on a default install (and Slats is off by default). It still
  // arrives from the async profile event, so it still has to re-publish.
  assert.ok(
    heaterCooler.chars.has(Characteristic.SwingMode),
    'SwingMode added to the already-published HeaterCooler service',
  );
  assert.ok(
    !fan.chars.has(Characteristic.SwingMode),
    'and NOT on the fan service, where Home would hide it',
  );
  assert.ok(
    updates.length >= 1,
    'adding SwingMode after publish must re-publish the accessory',
  );
});

// ---- Slats must be opt-IN ------------------------------------------------
//
// Apple Home categorises Slats as a WINDOW COVERING. Shipped on by default, the
// vane services joined the blinds/shades grouping of a house with real Matter
// blinds — four heat-pump louvres showed up among the window coverings, where a
// room-level blinds control can reach them. Observed live 2026-07-27.
//
// Swing on/off stays on the HeaterCooler tile via SwingMode either way; the
// Slats service only adds discrete tilt angles. Defaulting it off is the whole
// point, so these tests guard the default specifically, not just the plumbing.

test('no Slats service unless exposeVaneSlat is explicitly true', () => {
  const { accessory, applyProfile } = makeHarness({});   // no display options at all
  applyProfile(profile({ hasVaneDir: true, hasVaneSwing: true }));

  assert.strictEqual(accessory.getService(Service.Slats), null,
    'a vane-capable unit must NOT get a Slats service by default — it would land ' +
    'in the Home app window-covering group alongside real blinds');
});

test('exposeVaneSlat: false is honoured explicitly too', () => {
  const { accessory, applyProfile } = makeHarness(
    { showDrySwitch: false, showFanOnlySwitch: false, exposeVaneSlat: false });
  applyProfile(profile({ hasVaneDir: true, hasVaneSwing: true }));

  assert.strictEqual(accessory.getService(Service.Slats), null);
});

test('opting in still works for anyone who wants fixed vane angles', () => {
  const { accessory, applyProfile } = makeHarness(
    { showDrySwitch: false, showFanOnlySwitch: false, exposeVaneSlat: true });
  applyProfile(profile({ hasVaneDir: true, hasVaneSwing: true }));

  assert.notStrictEqual(accessory.getService(Service.Slats), null,
    'the capability is not removed, only made opt-in');
});

test('swing stays available with Slats off', () => {
  // The important half of the Slats fix: dropping the Slats service must not cost
  // vane control entirely. SwingMode is registered on the Fanv2 service and is
  // unaffected by exposeVaneSlat.
  const { heaterCooler, applyProfile } = makeHarness({});
  applyProfile(profile({ hasVaneDir: true, hasVaneSwing: true }));

  // `chars` is the mock's record of every characteristic the code actually
  // reached for — inspecting it does not create one, unlike getCharacteristic.
  const registered = registeredOn(heaterCooler);
  assert.ok(registered.includes('SwingMode'),
    `SwingMode must be on the climate tile when Slats is off; got ${registered}`);
});
