// Integration tests for local control wiring in the accessory:
//  - updateFromLocal() feeds a locally-read status into the characteristics
//  - local is authoritative: a cloud (polling/streaming) update is dropped while a
//    recent local poll exists (the cloud lags ~7-10s and would clobber it)
//  - sendDeviceCommand() prefers local and falls back to cloud on local failure
//
// The characteristics these assert against moved with the Thermostat ->
// HeaterCooler switch: there is no TargetTemperature any more, so the setpoint a
// local read lands on is read back through Cooling/HeatingThresholdTemperature
// (which are the setpoint controls in EVERY mode here, not just AUTO), and on/off
// is the separate `Active` characteristic. The wiring being tested — which
// transport a read/write travels over — is unchanged.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { DeviceUpdateCallback } from '../dist/kumo-api.js';
import type { Adapter, Commands, DeviceStatus, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';
import type { FakeService } from './helpers';

const SERIAL = 'TESTSERIAL001';

interface CommandCall {
  serial: string;
  commands: Commands;
}

/** The slice of LocalKumoClient the accessory actually reaches for. */
interface FakeLocalClient {
  calls: CommandCall[];
  hasLocalResult: boolean;
  sendCommandResult: boolean;
  hasLocal(): boolean;
  sendCommand(serial: string, commands: Commands): Promise<boolean>;
  getStatus(): Promise<Partial<DeviceStatus> | null>;
}

function makeLocalClient(over: Partial<FakeLocalClient> = {}): FakeLocalClient {
  const calls: CommandCall[] = [];
  return {
    calls,
    hasLocalResult: true,
    sendCommandResult: true,
    hasLocal() {
      return this.hasLocalResult;
    },
    sendCommand(serial: string, commands: Commands) {
      calls.push({ serial, commands }); return Promise.resolve(this.sendCommandResult);
    },
    getStatus() {
      return Promise.resolve(null);
    },
    ...over,
  };
}

/**
 * `displayConfig` is not part of DeviceStatus: standby / defrost / filter arrive
 * only on the streaming transport, alongside the fields that are.
 */
interface StreamingDisplayConfig {
  filter: boolean;
  defrost: boolean;
  standby: boolean;
  hotAdjust?: boolean;
}
type StreamingUpdate = Partial<DeviceStatus> & { displayConfig?: StreamingDisplayConfig };

function makeHarness({ localClient = null }: { localClient?: FakeLocalClient | null } = {}) {
  const sendCommandCalls: CommandCall[] = [];
  let streamCb: DeviceUpdateCallback | null = null;
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
    localClient,
  };
  const kumoAPI = {
    // Capture the streaming callback rather than dropping it: displayConfig
    // (standby / defrost / filter) only ever arrives on this transport, so the
    // carry-across tests below have no other way to put it in the cache.
    subscribeToDevice(serial: string, cb: DeviceUpdateCallback) {
      streamCb = cb;
    },
    onDeviceProfileUpdate() {},
    sendCommand(serial: string, commands: Commands) {
      sendCommandCalls.push({ serial, commands }); return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(
    platform as never,
    accessory as never,
    kumoAPI as never,
    30,
  );
  return {
    handler, sendCommandCalls, accessory,
    emitStreaming: (data: StreamingUpdate) => {
      assert.ok(streamCb, 'the accessory subscribed to the streaming transport');
      streamCb(SERIAL, data);
    },
    heaterCooler: (): FakeService => {
      const svc = accessory.getService(Service.HeaterCooler);
      assert.ok(svc, 'the HeaterCooler service was published');
      return svc;
    },
  };
}

const localStatus = (over: Partial<DeviceStatus> = {}): Partial<DeviceStatus> => ({
  roomTemp: 24, operationMode: 'cool', power: 1, spCool: 23, spHeat: 20,
  spAuto: null, fanSpeed: 'auto', airDirection: 'auto', filterDirty: false,
  defrost: false, standby: false, ...over,
});

const cloudZone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 30, spCool: 28, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
}) as unknown as Zone;

test('updateFromLocal feeds a locally-read status into the characteristics', async () => {
  const { handler } = makeHarness();
  handler.updateFromLocal(localStatus({ roomTemp: 24, operationMode: 'cool', spCool: 23, spHeat: 20 }));

  assert.strictEqual(await handler.getCurrentTemperature(), 24);
  // The local read's setpoints reach HomeKit through the two thresholds now.
  // spCool is the one the Home app shows in COOL; spHeat rides along so the band
  // is intact the moment the user switches to AUTO.
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 23, 'cool mode surfaces spCool');
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20, 'the heat edge comes across too');
  // Local status carries no `power` field of its own — mapLocalStatus derives it
  // from mode !== 'off' — so Active is the end of that chain.
  assert.strictEqual(await handler.getActive(), Characteristic.Active.ACTIVE);
  assert.strictEqual(
    await handler.getCurrentHeaterCoolerState(),
    Characteristic.CurrentHeaterCoolerState.COOLING,
  );
  assert.strictEqual(
    await handler.getTargetHeaterCoolerState(),
    Characteristic.TargetHeaterCoolerState.COOL,
  );
});

test('a cloud update is dropped while a recent local poll exists', async () => {
  const { handler } = makeHarness();
  handler.updateFromLocal(localStatus({ roomTemp: 24, spCool: 23 }));
  // Cloud streaming/polling lags and reports a stale 30°C — must NOT clobber local.
  handler.updateFromZone(cloudZone({ roomTemp: 30, spCool: 28 }));

  assert.strictEqual(await handler.getCurrentTemperature(), 24, 'local stays authoritative');
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 23,
    'the stale cloud setpoint is dropped too, not just the temperature');
});

test('cloud updates still apply when no local data exists', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(cloudZone({ roomTemp: 30 }));
  assert.strictEqual(await handler.getCurrentTemperature(), 30, 'pure-cloud path unaffected');
});

// ---- standby / defrost / filter survive a status rebuild ------------------
//
// processZoneUpdate rebuilds DeviceStatus from the zone payload on every update.
// standby, defrost and filterDirty are NOT in /sites/{id}/zones — they arrive in
// the streaming `displayConfig` and in the local status, both of which apply them
// AFTER processZoneUpdate returns. Without carrying them across the rebuild the
// poll (every 30s by default, alongside streaming) dropped them back to undefined,
// and the characteristics that read them reported a working compressor for a unit
// that was idling.

const streamingUpdate = (over: Partial<StreamingUpdate> = {}): StreamingUpdate => ({
  id: 'zone-1', deviceSerial: SERIAL, roomTemp: 24, spHeat: 20, spCool: 23,
  spAuto: null, power: 1, operationMode: 'cool', fanSpeed: 'auto',
  airDirection: 'auto', humidity: null, rssi: -50,
  displayConfig: { filter: false, defrost: false, standby: true, hotAdjust: false },
  ...over,
});

test('a cloud poll keeps the fan speed and vane the stream reported', async () => {
  // The real zones payload has no fanSpeed or airDirection at all. Defaulting them
  // on every poll flipped a manual fan to AUTO and a swinging vane to fixed.
  const { handler } = makeHarness();
  handler.updateFromZone(cloudZone({ fanSpeed: 'quiet', airDirection: 'swing' }));

  handler.updateFromZone(cloudZone({ fanSpeed: undefined, airDirection: undefined }));

  const status = handler['currentStatus']!;
  assert.strictEqual(status.fanSpeed, 'quiet');
  assert.strictEqual(status.airDirection, 'swing');
  assert.strictEqual(await handler.getTargetFanState(), Characteristic.TargetFanState.MANUAL);
});

test('before anything reports a fan speed, a poll still defaults it to auto', () => {
  const { handler } = makeHarness();
  handler.updateFromZone(cloudZone({ fanSpeed: undefined, airDirection: undefined }));
  assert.strictEqual(handler['currentStatus']!.fanSpeed, 'auto');
  assert.strictEqual(handler['currentStatus']!.airDirection, 'auto');
});

test('a cloud poll does not wipe the standby flag the streaming event delivered', async () => {
  const { handler, emitStreaming } = makeHarness();
  emitStreaming(streamingUpdate({ displayConfig: { standby: true, filter: false, defrost: false } }));
  assert.strictEqual(
    await handler.getCurrentHeaterCoolerState(),
    Characteristic.CurrentHeaterCoolerState.IDLE,
    'streaming reported the compressor idle',
  );

  handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));

  assert.strictEqual(
    await handler.getCurrentHeaterCoolerState(),
    Characteristic.CurrentHeaterCoolerState.IDLE,
    'the zones payload carries no standby — losing it reports a running compressor',
  );
});

test('the state PUSHED to HomeKit by the poll is idle too, not just the cached read', async () => {
  // The Home app shows the pushed value; a getter that disagrees with it is no
  // help. mapToCurrentHeaterCoolerState runs inside processZoneUpdate, so it sees
  // the rebuilt status, which is where the flag used to go missing.
  const h = makeHarness();
  h.emitStreaming(streamingUpdate({ displayConfig: { standby: true, filter: false, defrost: false } }));

  h.handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));

  const pushed = h.heaterCooler().chars.get(Characteristic.CurrentHeaterCoolerState)?.value;
  assert.strictEqual(pushed, Characteristic.CurrentHeaterCoolerState.IDLE);
});

test('the fan reports idle rather than blowing air while the compressor is in standby', async () => {
  const { handler, emitStreaming } = makeHarness();
  emitStreaming(streamingUpdate({ displayConfig: { standby: true, filter: false, defrost: false } }));

  handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));

  assert.strictEqual(
    await handler.getCurrentFanState(),
    Characteristic.CurrentFanState.IDLE,
    'the second consumer of the same flag',
  );
});

test('a unit that is genuinely running still reports cooling after a poll', async () => {
  // The carry-across must not pin a stale idle either: a streaming event saying
  // standby is over has to survive the next poll the same way.
  const { handler, emitStreaming } = makeHarness();
  emitStreaming(streamingUpdate({ displayConfig: { standby: true, filter: false, defrost: false } }));
  emitStreaming(streamingUpdate({ displayConfig: { standby: false, filter: false, defrost: false } }));

  handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));

  assert.strictEqual(
    await handler.getCurrentHeaterCoolerState(),
    Characteristic.CurrentHeaterCoolerState.COOLING,
  );
});

test('the filter indication survives a poll as well', async () => {
  // updateFilterMaintenance re-reads the cached flag (`filterDirty ?? false`) on
  // every streaming event. A poll in between that dropped the flag therefore
  // cleared a genuine "change the filter" warning on the very next event.
  const { handler, accessory, emitStreaming } = makeHarness();
  emitStreaming(streamingUpdate({ displayConfig: { standby: false, filter: true, defrost: false } }));
  const filterSvc = accessory.getService(Service.FilterMaintenance);
  assert.ok(filterSvc, 'the FilterMaintenance service was published');
  const dirty = filterSvc.chars.get(Characteristic.FilterChangeIndication)?.value;
  assert.strictEqual(dirty, Characteristic.FilterChangeIndication.CHANGE_FILTER);

  handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));
  // A later streaming event that carries no displayConfig at all — the adapter
  // does not send one on every update.
  emitStreaming(streamingUpdate({ displayConfig: undefined, roomTemp: 24.5 }));

  assert.strictEqual(
    filterSvc.chars.get(Characteristic.FilterChangeIndication)?.value,
    Characteristic.FilterChangeIndication.CHANGE_FILTER,
    'the warning must not clear itself just because a poll rebuilt the status',
  );
});

// ---- sendDeviceCommand routing --------------------------------------------
//
// A setpoint write is the vehicle for these because it is the one command whose
// payload the two transports shape differently (the LAN body drops `power`), so
// it is where a routing mistake actually costs something.
//
// 22°C arrives on the wire as 22.2: setpoints are snapped to the Fahrenheit grid
// before sending (quantizeSetpointInRange). 22°C = 71.6°F -> nearest whole °F is
// 72 -> back to Celsius at the 0.1°C device resolution = 22.3. Whichever
// transport carries the write, it carries the same quantized value — the point of
// quantizing above the transport layer rather than inside it.
const QUANTIZED_22 = 22.3;

test('commands prefer the local path when a unit is locally reachable', async () => {
  const local = makeLocalClient();
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22);

  assert.deepStrictEqual(local.calls.map((c) => c.commands), [{ spHeat: QUANTIZED_22 }], 'sent locally');
  assert.strictEqual(sendCommandCalls.length, 0, 'cloud not used');
});

test('a failed local command falls back to the cloud', async () => {
  const local = makeLocalClient({ sendCommandResult: false });
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22);

  assert.strictEqual(local.calls.length, 1, 'local attempted first');
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: QUANTIZED_22 }], 'then cloud');
});

test('commands skip local when the unit is not locally reachable', async () => {
  const local = makeLocalClient({ hasLocalResult: false });
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22);

  assert.strictEqual(local.calls.length, 0, 'local not attempted');
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: QUANTIZED_22 }], 'cloud used');
});

test('turning the unit off routes locally as a bare mode write', async () => {
  // On/off used to ride on TargetHeatingCoolingState.OFF; it is `Active` now. It
  // still has to reach the LAN adapter as `mode: "off"` and nothing else — the
  // local protocol has no `power` field, so an off that arrived as a bare
  // `power: 0` would be dropped on the floor and the unit would keep running.
  const local = makeLocalClient();
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'cool' }));

  await handler.setActive(Characteristic.Active.INACTIVE);

  assert.deepStrictEqual(local.calls.map((c) => c.commands), [{ operationMode: 'off' }], 'sent locally');
  assert.strictEqual(sendCommandCalls.length, 0, 'cloud not used');
  assert.strictEqual(await handler.getActive(), Characteristic.Active.INACTIVE, 'optimistically off');
});
