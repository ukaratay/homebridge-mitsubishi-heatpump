// The paired wireless sensor, delivered by the cloud `sensor_update` event.
//
// WHY THIS PATH EXISTS. Mitsubishi's v3 cloud stopped distributing the two
// secrets local LAN control needs (`password` vanished from `adapter_update`,
// `cryptoSerial` from GET /devices/{serial}/status), so the LAN read that used
// to supply the sensor's fine-grained temperature and humidity is dead. In the
// same window a `sensor_update` Socket.IO event appeared carrying exactly that
// data per device, keyed by `deviceSerial`.
//
// WHY IT MATTERS. The unit quantizes its own roomTemp to 0.5°C before reporting
// it; the sensor reports ~6 decimals (22.30543 against the unit's 22.5). Three
// of the four units here regulate FROM that sensor (tempSource 'sensor0'), so
// the sensor is the real thermostat, and the finer value also settles a display
// ambiguity: 22.5°C is exactly 72.5°F, the one 0.5°C step where a rounding
// renderer shows 73°F and a truncating one shows 72°F.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type {
  Commands, DeviceProfile, DeviceStatus, KumoConfig, SensorReading, Zone,
} from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory, type FakeService } from './helpers';

const SERIAL = 'TESTSERIAL001';
const OTHER_SERIAL = 'TESTSERIAL002';

// The fake hooks are typed by what these tests actually push at them. Profile
// fixtures carry only the fields the accessory reads; two tests below emit a
// sensor reading with NO deviceSerial, which the live event always has but an
// unkeyed one must survive; and the streaming payload carries displayConfig,
// which DeviceUpdateCallback does not declare but handleStreamingUpdate reads
// off the same object.
type ProfilePayload = Partial<DeviceProfile>;
type SensorPayload = Partial<SensorReading>;
type StreamingPayload = Partial<DeviceStatus> & {
  displayConfig?: { filter?: boolean; defrost?: boolean; standby?: boolean };
};

// hap-nodejs puts setPrimaryService/addLinkedService on every Service and
// FakeService does not, so the link-aware accessory grafts them on — the same
// optional shape src probes for before calling them.
type LinkableService = FakeService & {
  setPrimaryService?(value?: boolean): void;
  addLinkedService?(service: FakeService): void;
};

// The harness now has to supply onSensorUpdate as well as the streaming and
// profile hooks — the accessory subscribes to all three in its constructor.
function makeHarness(
  kumoConfig: Partial<KumoConfig> = {},
  { linkAware = false, displayName = 'Bedroom' } = {},
) {
  const sendCommandCalls: Array<{ serial: string; commands: Commands }> = [];
  const linked: FakeService[] = [];
  let primary = false;
  let publishes = 0;
  let profileCb: ((serial: string, profile: ProfilePayload) => void) | null = null;
  let sensorCb: ((reading: SensorPayload) => void) | null = null;
  let streamCb: ((serial: string, data: StreamingPayload) => void) | null = null;

  const accessory = makeAccessory(displayName);
  if (linkAware) {
    const origAdd = accessory.addService;
    accessory.addService = (type, name, subtype) => {
      const svc: LinkableService = origAdd(type, name, subtype);
      svc.setPrimaryService = (v) => { if (svc.type === Service.HeaterCooler) primary = v !== false; };
      svc.addLinkedService = (s) => linked.push(s);
      return svc;
    };
  }

  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() { publishes += 1; } },
    kumoConfig,
  };
  const kumoAPI = {
    subscribeToDevice(serial: string, cb: (serial: string, data: StreamingPayload) => void) {
      streamCb = cb;
    },
    onDeviceProfileUpdate(cb: (serial: string, profile: ProfilePayload) => void) { profileCb = cb; },
    onSensorUpdate(cb: (reading: SensorPayload) => void) { sensorCb = cb; },
    sendCommand(serial: string, commands: Commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(true);
    },
  };

  const handler = new KumoThermostatAccessory(
    platform as never,
    accessory as never,
    kumoAPI as never,
    30,
  );
  profileCb!(SERIAL, {
    minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
    maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
    hasModeVent: true, hasModeDry: true, hasModeHeat: true,
    hasVaneDir: false, hasVaneSwing: true, hasFanSpeedAuto: true,
    usesSetPointInDryMode: true,
  });

  return {
    handler, accessory, sendCommandCalls, linked,
    isPrimary: () => primary,
    heaterCooler: accessory.getService(Service.HeaterCooler)!,
    battery: () => accessory.getService(Service.Battery),
    humidity: () => accessory.getService(Service.HumiditySensor),
    publishes: () => publishes,
    emitSensor: (reading: SensorPayload) => sensorCb!({ deviceSerial: SERIAL, ...reading }),
    emitRaw: (reading: SensorPayload) => sensorCb!(reading),
    emitStreaming: (data: StreamingPayload) => streamCb!(SERIAL, data),
    hasSensorHook: () => typeof sensorCb === 'function',
  };
}

type Harness = ReturnType<typeof makeHarness>;

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'quiet', airDirection: 'auto',
    roomTemp: 22.5, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

const currentTemp = (h: Harness) =>
  h.heaterCooler.chars.get(Characteristic.CurrentTemperature)!.value;

// ---- Subscription ---------------------------------------------------------

test('the accessory subscribes to sensor_update in its constructor', () => {
  const h = makeHarness();
  assert.strictEqual(h.hasSensorHook(), true,
    'without a subscription the sensor data never reaches HomeKit at all');
});

test('a reading for another unit is ignored', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));

  h.emitRaw({ deviceSerial: OTHER_SERIAL, temperature: 30, battery: 10 });

  assert.strictEqual(currentTemp(h), 22.5, 'sensor_update is broadcast per account, not per device');
  assert.strictEqual(h.battery(), null, 'and must not grow another unit a battery service');
});

test('a reading with no deviceSerial is ignored rather than crashing', () => {
  // deviceSerial is present on the live payload (verified: the capturing handler
  // filtered on it and fired). Code defensively anyway — an unkeyed event cannot
  // be attributed to a unit, so it must be dropped, not guessed at.
  const h = makeHarness();
  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));

  assert.doesNotThrow(() => h.emitRaw({ temperature: 30, battery: 5 }));
  assert.doesNotThrow(() => h.emitRaw({}));

  assert.strictEqual(currentTemp(h), 22.5);
  assert.strictEqual(h.battery(), null);
});

// ---- Temperature: the fine value wins -------------------------------------

test('a sensor reading publishes the fine temperature, not the quantized roomTemp', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));
  assert.strictEqual(currentTemp(h), 22.5, 'the unit reports its 0.5°C-quantized value');

  h.emitSensor({ temperature: 22.30543 });

  assert.strictEqual(currentTemp(h), 22.30543,
    'the sensor is the real thermostat on these units; 22.5 is the same reading rounded off');
  assert.strictEqual(await h.handler.getCurrentTemperature(), 22.30543,
    'and the cached read agrees with what was published');
});

test('a later cloud poll carrying the coarse roomTemp does not clobber the sensor value', async () => {
  // The whole point of the precedence rule. The cloud poll arrives every ~30s
  // with roomTemp quantized to 0.5°C; last-writer-wins would throw the fine
  // reading away seconds after it landed.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543 });

  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));

  assert.strictEqual(currentTemp(h), 22.30543);
  assert.strictEqual(await h.handler.getCurrentTemperature(), 22.30543);
});

test('the same poll still applies everything that is not sensor data', async () => {
  // The substitution is scoped to temperature and humidity. A sensor knows
  // nothing about mode, power or setpoints, so those must ride through untouched.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543 });

  h.handler.updateFromZone(zone({ roomTemp: 22.5, operationMode: 'heat', spHeat: 21, power: 1 }));

  assert.strictEqual(currentTemp(h), 22.30543);
  assert.strictEqual(await h.handler.getTargetHeaterCoolerState(), Characteristic.TargetHeaterCoolerState.HEAT);
  assert.strictEqual(await h.handler.getHeatingThresholdTemperature(), 21);
  assert.strictEqual(await h.handler.getActive(), Characteristic.Active.ACTIVE);
});

test('a local poll cannot clobber the sensor value either', async () => {
  // Polling, streaming and the local poll all funnel through processZoneUpdate,
  // so the guard has to sit there rather than on one transport.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543 });

  h.handler.updateFromLocal({
    roomTemp: 22.5, spHeat: 20, spCool: 24, power: 1, operationMode: 'cool', fanSpeed: 'quiet',
  });

  assert.strictEqual(currentTemp(h), 22.30543);
});

test('nor can a streaming update, which applies extra fields after the rebuild', async () => {
  // The third transport, and the only one that writes to currentStatus AFTER
  // processZoneUpdate returns (modelNumber, connected, displayConfig). That
  // post-pass must not reach back over the substituted temperature.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543 });

  h.emitStreaming({
    id: 'zone-1', deviceSerial: SERIAL, roomTemp: 22.5, spHeat: 20, spCool: 24,
    spAuto: null, power: 1, operationMode: 'cool', fanSpeed: 'quiet',
    airDirection: 'auto', humidity: null, rssi: -50,
    displayConfig: { filter: false, defrost: false, standby: false },
  });

  assert.strictEqual(currentTemp(h), 22.30543);
  assert.strictEqual(await h.handler.getCurrentTemperature(), 22.30543);
});

test('a sensor reading before the first device update still answers reads', async () => {
  const h = makeHarness();

  h.emitSensor({ temperature: 21.875 });

  assert.strictEqual(await h.handler.getCurrentTemperature(), 21.875,
    'a real reading beats the 20°C placeholder');
});

test('a sensor reading is telemetry: it sends nothing and moves nothing', async () => {
  // It must not revive a unit, re-push a setpoint, or fire the mirror — the mirror
  // follows *commanded* state, and a room warming by a tenth of a degree is not a
  // command.
  const h = makeHarness();
  h.handler.updateFromZone(zone({ power: 0, operationMode: 'off', roomTemp: 22.5 }));
  const mirrored: string[] = [];
  h.handler.onStatusUpdate((s: DeviceStatus) => mirrored.push(s.operationMode));

  h.emitSensor({ temperature: 22.30543, humidity: 55.5, battery: 100 });

  assert.strictEqual(h.sendCommandCalls.length, 0);
  assert.strictEqual(mirrored.length, 0, 'sensor telemetry must not drive the mirror');
  assert.strictEqual(await h.handler.getActive(), Characteristic.Active.INACTIVE,
    'a unit that is off stays off');
  assert.strictEqual(await h.handler.getCoolingThresholdTemperature(), 24);
});

// ---- Battery --------------------------------------------------------------

test('a battery reading lazily creates the Battery service and publishes it', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone());
  assert.strictEqual(h.battery(), null, 'nothing exists until a battery value actually arrives');
  const before = h.publishes();

  h.emitSensor({ temperature: 22.3, battery: 100 });

  const battery = h.battery();
  assert.notStrictEqual(battery, null);
  assert.strictEqual(battery!.chars.get(Characteristic.BatteryLevel)!.value, 100);
  assert.strictEqual(h.publishes(), before + 1,
    'a service added after discovery is invisible to HomeKit without a re-publish');
});

test('the Garage — a unit with no paired sensor — never grows a Battery service', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone());
  h.handler.updateFromZone(zone({ roomTemp: 23 }));

  assert.strictEqual(h.battery(), null,
    'a battery tile on a mains-powered unit with nothing to report is pure noise');
});

test('a sensor that reports temperature but no battery gets no Battery service', () => {
  // Same shape as the Garage case from the other direction: the event fires, but
  // carries no battery field, so there is nothing to expose.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543, humidity: 55.5 });

  assert.strictEqual(h.battery(), null);
  assert.strictEqual(currentTemp(h), 22.30543, 'the temperature still lands');
});

test('the Battery service carries only characteristics HAP allows on it', () => {
  // Verified against hap-nodejs ServiceDefinitions: Battery REQUIRES
  // StatusLowBattery and optionally allows BatteryLevel, ChargingState and Name.
  // Anything else makes Homebridge log a characteristic warning on every start —
  // exactly what ConfiguredName on Fanv2 did.
  const h = makeHarness();
  h.emitSensor({ battery: 100 });
  const battery = h.battery()!;

  const allowed = new Set<unknown>([
    Characteristic.StatusLowBattery,
    Characteristic.BatteryLevel,
    Characteristic.ChargingState,
    Characteristic.Name,
  ]);
  for (const key of battery.chars.keys()) {
    assert.ok(allowed.has(key),
      `${(key as { _name: string })._name} is not in Battery's required or optional set`);
  }
  assert.ok(battery.chars.has(Characteristic.StatusLowBattery), 'the one required characteristic');
  assert.strictEqual(battery.chars.get(Characteristic.ChargingState)!.value,
    Characteristic.ChargingState.NOT_CHARGEABLE,
    'a wireless sensor runs on a cell you replace, not one you charge');
});

test('StatusLowBattery flips at 20%, with a case either side', () => {
  const cases: Array<[number, number]> = [
    [100, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL],
    [21, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL],
    [20, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL],
    [19, Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW],
    [0, Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW],
  ];
  for (const [percent, expected] of cases) {
    const h = makeHarness();
    h.emitSensor({ battery: percent });
    assert.strictEqual(h.battery()!.chars.get(Characteristic.StatusLowBattery)!.value, expected,
      `${percent}% must report ${expected === 1 ? 'LOW' : 'NORMAL'}`);
  }
});

test('the battery level is clamped and rounded to the uint8 HAP expects', () => {
  // The value comes off the cloud, so it is a trust boundary: hand HAP something
  // it will reject and the characteristic silently keeps its old value.
  const cases: Array<[number, number]> = [[100, 100], [55.6, 56], [-5, 0], [140, 100]];
  for (const [raw, expected] of cases) {
    const h = makeHarness();
    h.emitSensor({ battery: raw });
    assert.strictEqual(h.battery()!.chars.get(Characteristic.BatteryLevel)!.value, expected);
  }
});

test('a later battery reading updates the existing service without re-publishing', () => {
  const h = makeHarness();
  h.emitSensor({ battery: 100 });
  const after = h.publishes();

  h.emitSensor({ battery: 12 });

  assert.strictEqual(h.battery()!.chars.get(Characteristic.BatteryLevel)!.value, 12);
  assert.strictEqual(h.battery()!.chars.get(Characteristic.StatusLowBattery)!.value,
    Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
  assert.strictEqual(h.publishes(), after, 'the service is only structurally new once');
});

test('the battery survives a cloud poll rebuilding the cached status', () => {
  // processZoneUpdate rebuilds DeviceStatus from the zone payload, which carries
  // no battery — it only ever arrives on sensor_update.
  const h = makeHarness();
  h.emitSensor({ battery: 42 });

  h.handler.updateFromZone(zone({ roomTemp: 23 }));

  assert.strictEqual(h.battery()!.chars.get(Characteristic.BatteryLevel)!.value, 42,
    'the published value stands');
});

test('the Battery service is linked to the climate tile', () => {
  const h = makeHarness({}, { linkAware: true });
  h.emitSensor({ battery: 100 });

  assert.ok(h.linked.includes(h.battery()!),
    'an unlinked Battery reads as a standalone accessory rather than part of the unit');
});

// ---- Humidity -------------------------------------------------------------

test('humidity from a sensor reading reaches the HumiditySensor service', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ humidity: null }));
  assert.strictEqual(h.humidity(), null, 'no humidity has been seen yet');

  h.emitSensor({ humidity: 55.523438 });

  assert.notStrictEqual(h.humidity(), null, 'the first reading creates the service');
  assert.strictEqual(
    h.humidity()!.chars.get(Characteristic.CurrentRelativeHumidity)!.value, 55.523438);
});

test('a poll reporting no humidity does not wipe the sensor value', () => {
  const h = makeHarness();
  h.emitSensor({ humidity: 55.523438 });

  h.handler.updateFromZone(zone({ humidity: null }));

  assert.strictEqual(
    h.humidity()!.chars.get(Characteristic.CurrentRelativeHumidity)!.value, 55.523438);
});

test('showHumiditySensor: false keeps the sensor humidity out of HomeKit', () => {
  // Home collapses an accessory's services into one tile and favours a sensor
  // reading for what that tile shows, so this opt-out exists to stop humidity
  // dominating the unit. A new delivery path must not route around it.
  const h = makeHarness({ showHumiditySensor: false });

  h.emitSensor({ humidity: 55.523438, temperature: 22.30543 });

  assert.strictEqual(h.humidity(), null, 'no service, whatever the sensor reports');
  assert.strictEqual(currentTemp(h), 22.30543, 'the temperature is unaffected by the gate');
});

test('a humidity-only reading leaves the temperature alone', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));

  h.emitSensor({ humidity: 55.5 });

  assert.strictEqual(currentTemp(h), 22.5,
    'a partial reading updates only the fields it actually carries');
});

// ---- the zone record and a paired sensor disagree ----------------------------
//
// applyZoneSensors removes the humidity tile when the cloud's zone record says
// the unit has no sensor, and holds off stream readings that would re-create it.
// A reading from the unit's own paired sensor is different: it is the most direct
// evidence there is that a sensor exists. The zone record lags, and with
// disablePolling it is not read again until a restart, so a sensor moved to a
// unit that had none would otherwise get no humidity tile.

const NO_SENSOR_RECORD = { hasSensor: false, hasMhk2: false, humidity: null } as never;

test('a reading from a newly paired sensor creates the humidity tile despite the zone record', () => {
  const h = makeHarness();
  h.handler.applyZoneSensors(NO_SENSOR_RECORD);

  h.emitStreaming({ roomTemp: 22, power: 1, operationMode: 'cool', humidity: 44 });
  assert.strictEqual(h.humidity(), null, 'a stream value alone does not, while the record says no sensor');

  h.emitSensor({ humidity: 45 });
  assert.ok(h.humidity(), 'the sensor itself does');
  assert.strictEqual(
    h.humidity()!.chars.get(Characteristic.CurrentRelativeHumidity)?.value, 45);
});

test('the zone record does not remove the tile while the sensor is still reporting', () => {
  const h = makeHarness();
  h.emitSensor({ humidity: 45 });
  assert.ok(h.humidity());
  const before = h.publishes();

  h.handler.applyZoneSensors(NO_SENSOR_RECORD);

  assert.ok(h.humidity(), 'a fresh reading outranks a stale record');
  assert.strictEqual(h.publishes(), before);
});

test('once the sensor has gone quiet, the zone record removes the tile', () => {
  const h = makeHarness();
  h.emitSensor({ humidity: 45 });
  // Moved to another unit: its readings stop. Age the last one past the window
  // in which the sensor is taken as authoritative.
  h.handler['sensorReadingTs'] = Date.now() - 10 * 60 * 1000;

  h.handler.applyZoneSensors(NO_SENSOR_RECORD);

  assert.strictEqual(h.humidity(), null);
});
