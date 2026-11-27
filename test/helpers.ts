// Shared test scaffolding for the accessory tests: the HAP fakes (the
// Characteristic identity map, the Service name map, the service/accessory stubs)
// and one accessory harness, makeAccessoryHarness, that wires a
// KumoThermostatAccessory to a fake platform and a fake KumoAPI.
//
// The harness holds only the wiring that was identical across the test files. What
// a test is ABOUT stays in its own file: each file keeps a short local makeHarness
// that names its config, its accessory and its stream/profile payloads, and a file
// whose fakes behave differently (a link-aware accessory, a LAN client) builds them
// locally and passes them in. Grow the shared harness only with wiring every
// accessory test needs, not with one file's special case.
//
// Enum members are READ FROM hap-nodejs at runtime rather than copied here.
// Copies drift: 10 of the 13 hand-rolled versions of this file encoded
// TargetHeaterCoolerState.AUTO = 3, which is the old *Thermostat*
// characteristic's value, and HAP defines AUTO = 0 for HeaterCooler. Typing a
// hand-copied table would only assert that the wrong number is a number;
// deriving it makes that class of drift impossible. The harness's `api.hap` is the
// real HapStatusError and HAPStatus for the same reason.

import assert from 'node:assert';
import {
  Characteristic as HapCharacteristic,
  HapStatusError,
  HAPStatus,
} from '@homebridge/hap-nodejs';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Commands, DeviceProfile, KumoConfig } from '../dist/settings.js';

/** A stand-in for a HAP Characteristic. Structural, not a real HAP object. */
export interface FakeCharacteristic {
  value: unknown;
  props?: Record<string, unknown>;
  /** The handler the plugin bound with onSet, kept so a test can write through it: see hapWrite. */
  setHandler?: (value: unknown) => unknown;
  onGet(handler?: unknown): FakeCharacteristic;
  onSet(handler?: unknown): FakeCharacteristic;
  setProps(props: Record<string, unknown>): FakeCharacteristic;
}

/** A stand-in for a HAP Service. `type` is the name string from `Service` below. */
export interface FakeService {
  type: string;
  name?: string;
  subtype?: string;
  /**
   * Every characteristic this service has been asked for.
   *
   * Exposed so a test can ask whether a characteristic was ever *added* without
   * adding it by asking. That mirrors real HAP: hap-nodejs's
   * `Service.getCharacteristic()` ADDS an optional characteristic as a side
   * effect of the lookup, which is exactly how a post-publish characteristic
   * sneaks in unpublished.
   */
  chars: Map<unknown, FakeCharacteristic>;
  getCharacteristic(id: unknown): FakeCharacteristic;
  setCharacteristic(id: unknown, value: unknown): FakeService;
  updateCharacteristic(id: unknown, value: unknown): FakeService;
  /** Declares a characteristic; real HAP only uses it to skip a warning, so this does nothing. */
  addOptionalCharacteristic(id: unknown): void;
}

/** A stand-in for a Homebridge PlatformAccessory. */
export interface FakeAccessory {
  displayName: string;
  context: { device: { deviceSerial: string; siteId: string; displayName: string } };
  getService(type: string): FakeService | null;
  getServiceById(type: string, subtype: string): FakeService | null;
  addService(type: string, name?: string, subtype?: string): FakeService;
  removeService(service: FakeService): void;
}

export interface FakeLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/**
 * Copy a real characteristic class's numeric constants.
 *
 * HAP declares them as static members (`TargetHeaterCoolerState.AUTO = 0`), so
 * the uppercase numeric statics are exactly the enum. `UUID` is a string and is
 * skipped by the type test.
 */
function realMembers(name: string): Record<string, number> {
  const cls = (HapCharacteristic as unknown as Record<string, unknown>)[name];
  if (typeof cls !== 'function') {
    return {};
  }
  const members: Record<string, number> = {};
  for (const key of Object.getOwnPropertyNames(cls)) {
    const value = (cls as unknown as Record<string, unknown>)[key];
    if (typeof value === 'number' && /^[A-Z][A-Z0-9_]*$/.test(key)) {
      members[key] = value;
    }
  }
  return members;
}

/**
 * Stable characteristic identifiers: the same object comes back for a given
 * name, so it can be used as a Map key the way hap-nodejs uses the real class.
 * A name HAP does not define gets no members, which makes a mistyped constant
 * read as undefined instead of silently matching something else.
 */
const charCache: Record<string, { _name: string } & Record<string, unknown>> = {};
export const Characteristic: Record<string, { _name: string } & Record<string, number>> =
  new Proxy({}, {
    get(_target, prop: string) {
      if (!charCache[prop]) {
        charCache[prop] = { _name: String(prop), ...realMembers(prop) };
      }
      return charCache[prop];
    },
  }) as Record<string, { _name: string } & Record<string, number>>;

export const Service = {
  AccessoryInformation: 'AccessoryInformation',
  Thermostat: 'Thermostat',
  HeaterCooler: 'HeaterCooler',
  Fanv2: 'Fanv2',
  Slats: 'Slats',
  HumiditySensor: 'HumiditySensor',
  Switch: 'Switch',
  FilterMaintenance: 'FilterMaintenance',
  Battery: 'Battery',
};

export function makeLog(): FakeLog {
  const noop = () => { /* silent in tests */ };
  return { info: noop, warn: noop, error: noop, debug: noop };
}

export function makeCharacteristic(): FakeCharacteristic {
  const ch: FakeCharacteristic = {
    value: undefined,
    onGet() {
      return ch;
    },
    onSet(handler?: unknown) {
      ch.setHandler = handler as FakeCharacteristic['setHandler'];
      return ch;
    },
    setProps(props: Record<string, unknown>) {
      ch.props = props;
      return ch;
    },
  };
  return ch;
}

/**
 * Write a characteristic the way hap-nodejs does: run the handler the plugin
 * bound with onSet, then store the value once it resolves
 * (Characteristic.handleSetRequest awaits the handler, then assigns `value`).
 * The handler starts synchronously, so calling this for each write of a request
 * in a plain loop, without awaiting, is how hap-nodejs dispatches the request.
 */
export async function hapWrite(ch: FakeCharacteristic, value: unknown): Promise<void> {
  assert.ok(ch.setHandler, 'the plugin bound an onSet handler to this characteristic');
  await ch.setHandler(value);
  ch.value = value;
}

export function makeService(type: string, name?: string, subtype?: string): FakeService {
  const chars = new Map<unknown, FakeCharacteristic>();
  const svc: FakeService = {
    type,
    name,
    subtype,
    chars,
    getCharacteristic(id: unknown) {
      if (!chars.has(id)) {
        chars.set(id, makeCharacteristic());
      }
      return chars.get(id)!;
    },
    setCharacteristic(id: unknown, value: unknown) {
      svc.getCharacteristic(id).value = value;
      return svc;
    },
    updateCharacteristic(id: unknown, value: unknown) {
      svc.getCharacteristic(id).value = value;
      return svc;
    },
    addOptionalCharacteristic() { /* see the interface */ },
  };
  return svc;
}

/**
 * AccessoryInformation is pre-seeded because the accessory constructor calls
 * `getService(...)!` on it and would throw on null.
 */
export function makeAccessory(
  displayName = 'Kitchen',
  deviceSerial = 'TESTSERIAL001',
): FakeAccessory {
  const entries: Array<{ type: string; subtype?: string; svc: FakeService }> = [
    {
      type: Service.AccessoryInformation,
      subtype: undefined,
      svc: makeService(Service.AccessoryInformation),
    },
  ];
  return {
    displayName,
    context: { device: { deviceSerial, siteId: 'site-1', displayName } },
    getService(type: string) {
      const e = entries.find((x) => x.type === type && x.subtype === undefined);
      return e ? e.svc : null;
    },
    getServiceById(type: string, subtype: string) {
      const e = entries.find((x) => x.type === type && x.subtype === subtype);
      return e ? e.svc : null;
    },
    addService(type: string, name?: string, subtype?: string) {
      const svc = makeService(type, name, subtype);
      entries.push({ type, subtype, svc });
      return svc;
    },
    removeService(service: FakeService) {
      const i = entries.findIndex((x) => x.svc === service);
      if (i >= 0) {
        entries.splice(i, 1);
      }
    },
  };
}

/** The three opt-in display services on: what most behaviour tests want to see. */
export const SWITCHES_ON: Partial<KumoConfig> = {
  showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true,
};

export interface HarnessOptions {
  /** Copied, so a test can mutate the returned `kumoConfig` without touching a shared constant. */
  kumoConfig?: Partial<KumoConfig>;
  /** Defaults to a fresh makeAccessory(); pass one to model a cached accessory. */
  accessory?: FakeAccessory;
  /**
   * The unit's Fixed Fan Speed accessory. Defaults to a fresh one, or to none
   * with `fixedFanSpeed: false`, as the platform decides it; pass one to model a
   * cached accessory, or null for none.
   */
  fanAccessory?: FakeAccessory | null;
  /** The platform's LAN client. Defaults to null: cloud-only. */
  localClient?: unknown;
  /** Log methods to use instead of the silent ones, for lines the constructor writes. */
  log?: Partial<FakeLog>;
  /**
   * Keep the real FAN_HOLD_MS. By default the harness sets it to 0, which
   * turns the hold off: a fan write is then out one tick after its request, so
   * the many tests that are not about the hold neither wait for it nor race it.
   */
  realFanHold?: boolean;
}

/**
 * One KumoThermostatAccessory on a fake platform and a fake KumoAPI.
 *
 * Plain handles out: `sendCommandCalls` and `sent` both record every cloud command
 * (with and without its serial), `published` every updatePlatformAccessories call,
 * and `applyProfile` / `stream` / `sensor` deliver an event to the callback the
 * accessory registered, as the accessory's own serial. `sensor` delivers the
 * reading exactly as given, so a test can send one with no deviceSerial.
 */
export function makeAccessoryHarness(opts: HarnessOptions = {}) {
  const accessory = opts.accessory ?? makeAccessory();
  const serial = accessory.context.device.deviceSerial;
  const kumoConfig: Partial<KumoConfig> = { ...opts.kumoConfig };
  const fanAccessory = opts.fanAccessory !== undefined
    ? opts.fanAccessory
    : kumoConfig.fixedFanSpeed === false
      ? null
      : makeAccessory(`${accessory.displayName} Fixed Fan Speed`, `${serial}-fan`);
  const sendCommandCalls: Array<{ serial: string; commands: Commands }> = [];
  const sent: Commands[] = [];
  const published: FakeAccessory[][] = [];
  let onStream: ((serial: string, data: object) => void) | null = null;
  let onProfile: ((serial: string, profile: Partial<DeviceProfile>) => void) | null = null;
  let onSensor: ((reading: object) => void) | null = null;

  const platform = {
    Service,
    Characteristic,
    log: { ...makeLog(), ...opts.log },
    kumoConfig,
    localClient: opts.localClient ?? null,
    api: {
      updatePlatformAccessories: (a: FakeAccessory[]) => { published.push(a); },
      hap: {
        HapStatusError,
        // HAPStatus is a const enum, so it is read member by member.
        HAPStatus: { SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    },
  };
  const kumoAPI = {
    subscribeToDevice(_serial: string, cb: typeof onStream) { onStream = cb; },
    onDeviceProfileUpdate(cb: typeof onProfile) { onProfile = cb; },
    onSensorUpdate(cb: typeof onSensor) { onSensor = cb; },
    sendCommand(commandSerial: string, commands: Commands) {
      sendCommandCalls.push({ serial: commandSerial, commands });
      sent.push(commands);
      return Promise.resolve(true);
    },
  };
  const handler = new KumoThermostatAccessory(
    platform as never,
    accessory as never,
    kumoAPI as never,
    (fanAccessory ?? undefined) as never,
  );
  if (!opts.realFanHold) {
    (handler as unknown as { FAN_HOLD_MS: number }).FAN_HOLD_MS = 0;
  }

  return {
    handler, accessory, fanAccessory, kumoConfig, sendCommandCalls, sent, published,
    heaterCooler: accessory.getService(Service.HeaterCooler)!,
    /** The Fanv2 on the Fixed Fan Speed accessory. Null-asserted: absent with `fixedFanSpeed: false`. */
    fan: fanAccessory?.getService(Service.Fanv2) as FakeService,
    applyProfile: (p: Partial<DeviceProfile>) => {
      assert.ok(onProfile, 'the accessory subscribed to profile updates');
      onProfile(serial, p);
    },
    stream: (data: object) => {
      assert.ok(onStream, 'the accessory subscribed to the streaming transport');
      onStream(serial, data);
    },
    sensor: (reading: object) => {
      assert.ok(onSensor, 'the accessory subscribed to sensor readings');
      onSensor(reading);
    },
  };
}
