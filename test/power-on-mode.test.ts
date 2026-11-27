// A bare "on" returns the unit to the mode it was last on in.
//
// HomeKit's Active=1 carries no mode, and an off unit reports
// `operationMode: 'off'`, so the cached status cannot say what to come back as.
// Until this was fixed every tile tap, "turn on" to Siri and fan-tile ON brought
// an off unit up in AUTO (heat/cool), whatever it had been doing: a unit that had
// been heating could come back able to cool. The README had promised otherwise
// since 2.0 ("turning a unit off does not change which mode it returns to").
//
// It also broke the mode picker. Home shows Off / Heat / Cool / Auto, and
// choosing the mode the tile already displays sends Active=1 alone. An off unit's
// target used to read a default COOL, so picking "Cool" turned it on in AUTO. The
// target now shows the remembered mode while the unit is off, so what the picker
// displays is what a bare ON delivers.
//
// Found by reading upstream (homebridge-mitsubishi-comfort 36dae3e: "the fork
// turned every off unit on in AUTO"), which keeps the same memory.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Commands, DeviceProfile, Zone } from '../dist/settings.js';
import {
  Characteristic, Service, makeLog, makeAccessory, type FakeAccessory,
} from './helpers';

const SERIAL = 'TESTSERIAL001';

type ProfilePayload = Partial<DeviceProfile>;
type StreamCallback = (serial: string, data: Record<string, unknown>) => void;

function makeHarness(accessory: FakeAccessory = makeAccessory('Family Room')) {
  const sent: Commands[] = [];
  let streamCb: StreamCallback | null = null;
  let profileCb: ((serial: string, profile: ProfilePayload) => void) | null = null;
  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: {},
  };
  const kumoAPI = {
    subscribeToDevice(_serial: string, cb: StreamCallback) { streamCb = cb; },
    onDeviceProfileUpdate(cb: (serial: string, profile: ProfilePayload) => void) { profileCb = cb; },
    sendCommand(_serial: string, commands: Commands) {
      sent.push(commands);
      return Promise.resolve(true);
    },
  };
  const handler = new KumoThermostatAccessory(
    platform as never, accessory as never, kumoAPI as never, 30,
  );
  return {
    handler, accessory, sent,
    heaterCooler: accessory.getService(Service.HeaterCooler)!,
    // A device_update as the cloud's stream delivers it.
    stream: (data: Record<string, unknown>) => streamCb!(SERIAL, {
      deviceSerial: SERIAL, roomTemp: 21, spHeat: 20, spCool: 24, power: 1, operationMode: 'heat',
      fanSpeed: 'auto', airDirection: 'auto', humidity: null, ...data,
    }),
    applyProfile: (p: ProfilePayload) => profileCb!(SERIAL, {
      minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
      maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
      ...p,
    }),
  };
}

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'heat',
    fanSpeed: null, airDirection: null,
    roomTemp: 21, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

const OFF = { power: 0, operationMode: 'off' };
const Active = Characteristic.Active;
const Target = Characteristic.TargetHeaterCoolerState;

// ---- the mode a bare ON uses ------------------------------------------------

test('a unit last seen heating comes back in heat', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  handler.updateFromZone(zone(OFF));          // turned off at the wall or in the vendor app

  await handler.setActive(Active.ACTIVE);

  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

test('a unit HomeKit itself turned off comes back in the mode it was in', async () => {
  for (const mode of ['heat', 'cool', 'autoHeat']) {
    const { handler, sent } = makeHarness();
    handler.updateFromZone(zone({ operationMode: mode }));

    await handler.setActive(Active.INACTIVE);
    await handler.setActive(Active.ACTIVE);

    // The cloud reports auto as autoHeat / autoCool but only accepts 'auto'.
    const expected = mode === 'autoHeat' ? 'auto' : mode;
    assert.deepStrictEqual(sent, [{ operationMode: 'off' }, { operationMode: expected }], mode);
  }
});

test('a mode chosen in HomeKit is remembered without waiting for the unit to report it', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool' }));

  await handler.setTargetHeaterCoolerState(Target.HEAT);
  handler.updateFromZone(zone(OFF));
  // Past the scene-burst window: an ON this close to a mode write is taken as
  // part of the same scene and dropped (see on-scene-mode-race.test.ts).
  await new Promise((resolve) => setTimeout(resolve, 1600));

  sent.length = 0;
  await handler.setActive(Active.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

test('the fan tile turning an off unit on uses the same remembered mode', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  handler.updateFromZone(zone(OFF));

  await handler.setFanActive(Active.ACTIVE);

  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

// ---- Dry and Fan-only are not remembered --------------------------------------

// The picker cannot show them: both read as COOL while they run. A unit last on
// in Dry that came back in Dry would show "Cool" on its off tile and deliver
// dehumidifying, which is the very mismatch this memory exists to remove. So they
// are excursions made with their own switches, and the tile returns to the heat,
// cool or auto from before them.
test('after Dry or Fan-only, a bare ON returns to the mode from before it', async () => {
  for (const excursion of ['dry', 'vent']) {
    const { handler, sent, heaterCooler } = makeHarness();
    handler.updateFromZone(zone({ operationMode: 'heat' }));
    handler.updateFromZone(zone({ operationMode: excursion }));
    handler.updateFromZone(zone(OFF));

    assert.strictEqual(heaterCooler.chars.get(Target)?.value, Target.HEAT, `${excursion}: the off tile shows Heat`);
    await handler.setActive(Active.ACTIVE);
    assert.deepStrictEqual(sent, [{ operationMode: 'heat' }], `${excursion}: and that is what it gets`);
  }
});

test('a unit only ever seen in Dry comes on in the default, which is what its tile shows', async () => {
  const { handler, sent, stream } = makeHarness();
  stream({ power: 1, operationMode: 'dry', previousOperationMode: 'dry' });
  stream({ ...OFF, previousOperationMode: 'dry' });

  assert.strictEqual(await handler.getTargetHeaterCoolerState(), Target.AUTO);
  await handler.setActive(Active.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'auto' }]);
});

// The memory is read as defensively as it is written: a value that is not heat,
// cool or auto (an earlier build of this branch stored Dry and Fan-only) is
// treated as nothing remembered.
test('a remembered Dry found in the accessory cache is not used', async () => {
  const accessory = makeAccessory('Family Room');
  (accessory.context as Record<string, unknown>).lastActiveMode = 'dry';
  const { handler, sent } = makeHarness(accessory);
  handler.updateFromZone(zone(OFF));

  assert.strictEqual(await handler.getTargetHeaterCoolerState(), Target.AUTO);
  await handler.setActive(Active.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'auto' }]);
});

// ---- a unit that cannot heat --------------------------------------------------

// The adapter answers HTTP 200 to a mode the unit cannot do and ignores it, so a
// remembered heat or auto would leave a cooling-only unit that a bare ON can no
// longer turn on, showing a mode outside the picker's valid values. The profile
// is applied when the memory is read, so it does not matter how the value got
// there: the unit's own memory, a mirror push, or a cache older than the profile.
test('a cooling-only unit never comes back in heat or auto', async () => {
  const seeded = makeHarness();
  seeded.stream({ ...OFF, previousOperationMode: 'autoCool' });
  seeded.applyProfile({ hasModeHeat: false });
  assert.strictEqual(await seeded.handler.getTargetHeaterCoolerState(), Target.COOL);
  await seeded.handler.setActive(Active.ACTIVE);
  assert.deepStrictEqual(seeded.sent, [{ operationMode: 'cool' }], 'seeded from the unit');

  const accessory = makeAccessory('Family Room');
  // Cached before the profile was known. The fake types only the fields it seeds.
  (accessory.context as Record<string, unknown>).lastActiveMode = 'heat';
  const cached = makeHarness(accessory);
  cached.applyProfile({ hasModeHeat: false });
  cached.handler.updateFromZone(zone(OFF));
  assert.strictEqual(await cached.handler.getTargetHeaterCoolerState(), Target.COOL);
  await cached.handler.setActive(Active.ACTIVE);
  assert.deepStrictEqual(cached.sent, [{ operationMode: 'cool' }], 'restored from the cache');
});

// ---- where the memory comes from -------------------------------------------

// The plugin may never have seen the unit on: a fresh install, or a cache that
// was cleared. The unit itself remembers, and device_update carries it.
test('with nothing remembered, the unit\'s own previousOperationMode is used', async () => {
  const { handler, sent, stream } = makeHarness();
  stream({ ...OFF, previousOperationMode: 'heat' });

  await handler.setActive(Active.ACTIVE);

  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

test('what the plugin saw the unit doing outranks the unit\'s older memory', async () => {
  const { handler, sent, stream } = makeHarness();
  stream({ power: 1, operationMode: 'cool' });
  stream({ ...OFF, previousOperationMode: 'heat' });

  await handler.setActive(Active.ACTIVE);

  assert.deepStrictEqual(sent, [{ operationMode: 'cool' }]);
});

// accessory.context is written with Homebridge's accessory cache, so the memory
// outlives the process without a write of our own.
test('the remembered mode survives a restart', async () => {
  const first = makeHarness();
  first.handler.updateFromZone(zone({ operationMode: 'heat' }));
  first.handler.updateFromZone(zone(OFF));

  const second = makeHarness(first.accessory);
  second.handler.updateFromZone(zone(OFF));
  await second.handler.setActive(Active.ACTIVE);

  assert.deepStrictEqual(second.sent, [{ operationMode: 'heat' }]);
});

test('with no history at all it is still AUTO, or COOL on a cooling-only unit', async () => {
  const both = makeHarness();
  both.handler.updateFromZone(zone(OFF));
  await both.handler.setActive(Active.ACTIVE);
  assert.deepStrictEqual(both.sent, [{ operationMode: 'auto' }]);

  const coolOnly = makeHarness();
  coolOnly.applyProfile({ hasModeHeat: false });
  coolOnly.handler.updateFromZone(zone(OFF));
  await coolOnly.handler.setActive(Active.ACTIVE);
  assert.deepStrictEqual(coolOnly.sent, [{ operationMode: 'cool' }]);
});

test('an off report never becomes the remembered mode', async () => {
  const { handler, sent, stream } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  stream({ ...OFF, previousOperationMode: 'off' });
  handler.updateFromZone(zone(OFF));

  await handler.setActive(Active.ACTIVE);

  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

// ---- what the mode picker shows --------------------------------------------

// Home's picker offers Off / Heat / Cool / Auto and sends Active=1 ALONE when the
// user picks the mode the tile already shows. So an off unit has to show the mode
// a bare ON will really use, or picking that entry delivers something else.
test('an off unit shows the mode a bare ON will turn it on in', async () => {
  for (const [mode, shown] of [['heat', Target.HEAT], ['cool', Target.COOL], ['autoCool', Target.AUTO]] as const) {
    const { handler, sent, heaterCooler } = makeHarness();
    handler.updateFromZone(zone({ operationMode: mode }));
    handler.updateFromZone(zone(OFF));

    assert.strictEqual(await handler.getTargetHeaterCoolerState(), shown, `${mode}: read`);
    assert.strictEqual(heaterCooler.chars.get(Target)?.value, shown, `${mode}: pushed`);

    await handler.setActive(Active.ACTIVE);     // "picking" the entry already shown
    assert.strictEqual(await handler.getTargetHeaterCoolerState(), shown, `${mode}: and it holds`);
    assert.strictEqual(sent.length, 1);
  }
});

// The scene case is unchanged and pinned in on-scene-mode-race.test.ts; this is
// the control that the memory does not override an explicit choice.
test('a mode picked in the same request still wins over the remembered one', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  handler.updateFromZone(zone(OFF));

  await Promise.all([
    handler.setActive(Active.ACTIVE),
    handler.setTargetHeaterCoolerState(Target.COOL),
  ]);

  assert.deepStrictEqual(sent, [{ operationMode: 'cool' }]);
});

// A unit the cloud reports offline publishes nothing, but its cached state still
// moves, and a HomeKit ON is still sent (see assertReachable). The mode has to be
// remembered from the update itself, not only on the publish path that an
// unreachable unit skips: otherwise the unit's older previousOperationMode wins.
test('the mode is remembered from updates that arrive while the unit shows No Response', async () => {
  const { handler, sent, stream } = makeHarness();
  handler.setCloudConnected(false);
  stream({ power: 1, operationMode: 'cool', previousOperationMode: 'heat' });
  stream({ ...OFF, previousOperationMode: 'heat' });

  await handler.setActive(Active.ACTIVE);

  assert.deepStrictEqual(sent, [{ operationMode: 'cool' }]);
});
