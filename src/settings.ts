// NOTE: PLATFORM_NAME is deliberately left as 'KumoV3' across the fork. It is the
// `platform` key in every existing user's config.json; changing it would orphan
// their configured platform block and re-create every accessory. The npm package
// rename does not require it (Homebridge resolves plugin renames separately).
export const PLATFORM_NAME = 'KumoV3';
export const PLUGIN_NAME = 'homebridge-mitsubishi-heatpump';
export const API_BASE_URL = 'https://app-prod.kumocloud.com/v3';
export const SOCKET_BASE_URL = 'https://socket-prod.kumocloud.com';
export const TOKEN_REFRESH_INTERVAL = 20 * 60 * 1000; // 20 minutes (actual token lifetime)
export const APP_VERSION = '3.2.4';

export interface KumoConfig {
  platform: string;
  name?: string;
  username: string;
  password: string;
  pollInterval?: number;
  disablePolling?: boolean;
  debug?: boolean;
  excludeDevices?: string[];
  streamingHealthCheckInterval?: number;
  streamingStaleThreshold?: number;
  degradedPollInterval?: number;
  // Local LAN control (opt-in). When true, the plugin discovers each unit's IP on
  // the LAN and controls/reads it directly, falling back to cloud per-unit when a
  // unit is unreachable. Cloud streaming stays connected as the fallback.
  localControl?: boolean;
  // Optional manual serial -> IP overrides (skip discovery for these units).
  localControlIps?: Record<string, string>;
  // Seconds between local status polls (default 15).
  localPollInterval?: number;
  // --- Display options -----------------------------------------------------
  // Fan speed has its own Fixed Fan Speed tile and swing is on the HeaterCooler, so the
  // Dry and Fan-only Switch tiles are opt-in rather than automatic. Every tile
  // only appears on units whose profile reports the capability.
  /** Add a per-unit "Dry" switch (dehumidify). Default false. */
  showDrySwitch?: boolean;
  /** Add a per-unit "Fan" switch (fan-only mode, no heating/cooling). Default false. */
  showFanOnlySwitch?: boolean;
  /**
   * Publish a "<unit> Fixed Fan Speed" fan accessory beside each unit. Default
   * TRUE; only a literal false turns it off. On holds the slider's speed, Off
   * is fan auto. It is a separate accessory so that a scene sets the fan only
   * when it includes this tile. With false HomeKit has no fan control. See
   * setupFanAccessory in accessory.ts.
   */
  fixedFanSpeed?: boolean;
  /**
   * Expose indoor humidity as a HumiditySensor service. Default TRUE.
   *
   * Turn this off if humidity is dominating the accessory's tile in the Apple
   * Home app. Home collapses an accessory's services into a single tile and
   * favours a sensor reading for what that tile displays, so a unit with a
   * paired humidity sensor can show humidity where you wanted temperature and
   * fan. Home's per-accessory "Show as Separate Tiles" setting is the
   * alternative that keeps both.
   */
  showHumiditySensor?: boolean;
  /**
   * Expose vane direction as a HomeKit Slats service in addition to SwingMode.
   * Default FALSE, deliberately.
   *
   * Apple Home categorises Slats as a WINDOW COVERING. On a home with real
   * blinds or shades, a vane Slats service joins their room grouping and their
   * category summary tile, so the heat pump's louvre starts appearing among the
   * blinds — and a room-level "close the blinds" control can reach it. Observed
   * 2026-07-27 on a house with Matter blinds paired directly to HomeKit.
   *
   * Swing on/off is always available on the HeaterCooler tile itself via
   * SwingMode; this option only adds the discrete tilt positions.
   */
  exposeVaneSlat?: boolean;
  // Device mirroring (opt-in). Each pair makes `target` follow `source`: whenever
  // the source's commanded state changes (via any control path — wall thermostat,
  // Kumo app, or HomeKit), the source's full state is pushed to the target. One-way;
  // a manual change to the target persists until the next source change re-syncs it.
  mirror?: MirrorPair[];
}

/** A one-way mirror: `target` follows `source` (both device serials). */
export interface MirrorPair {
  source: string;
  target: string;
}

/**
 * The subset of a device's state the mirror copies from source to target.
 * `operationMode` is the raw status value (may be autoHeat/autoCool); `fanSpeed`
 * is the raw adapter/cloud fan-speed string (mirrored verbatim).
 */
export interface MirrorState {
  operationMode: string;
  power: number;
  spHeat: number;
  spCool: number;
  fanSpeed: string;
}

export interface LoginResponse {
  id: string;
  username: string;
  email: string;
  token: {
    access: string;
    refresh: string;
  };
  preferences?: Record<string, unknown>;
}

export interface Site {
  id: string;
  name: string;
}

export interface Zone {
  id: string;
  name: string;
  isActive: boolean;
  adapter: Adapter;
}

export interface Adapter {
  id: string;
  deviceSerial: string;
  roomTemp: number;
  spHeat: number;
  spCool: number;
  spAuto: number | null;
  humidity: number | null;
  power: number;
  operationMode: string;
  previousOperationMode: string;
  // NOT PRESENT in the `GET /sites/{siteId}/zones` payload — optional on purpose.
  // The zones adapter object carries roomTemp/setpoints/power/operationMode but
  // neither fan speed nor vane; those live in the streaming `device_update` event
  // and in `GET /devices/{serial}`. They were typed as required `string` here,
  // which is how the debug poll log ended up printing "Fan: undefined" for every
  // unit and why vane data looked unavailable from the cloud. Any read must
  // default (see accessory.ts, which does `|| 'auto'` on the streaming paths).
  fanSpeed?: string;
  airDirection?: string;
  connected: boolean;
  hasSensor: boolean;
  hasMhk2: boolean;
  rssi?: number;
}

export interface DeviceStatus {
  id: string;
  deviceSerial: string;
  rssi: number;
  power: number;
  operationMode: string;
  humidity: number | null;
  fanSpeed: string;
  airDirection: string;
  roomTemp: number;
  spCool: number;
  spHeat: number;
  spAuto: number | null;
  // Extended fields from device_update streaming
  modelNumber?: string;
  connected?: boolean;
  standby?: boolean;
  defrost?: boolean;
  filterDirty?: boolean;
  /** Wireless-sensor battery percent, when the unit has a paired sensor. */
  sensorBattery?: number | null;
}

/**
 * A reading from a unit's paired wireless sensor, via the cloud `sensor_update` event.
 *
 * This exists because the v3 cloud stopped distributing the two secrets local LAN
 * control needs: the per-device `password` vanished from the `adapter_update` payload
 * and `cryptoSerial` vanished from `GET /devices/{serial}/status` (confirmed cloud-side
 * and account-independent — pykumo issue #78, 2026-07-31, reproduced by its maintainer).
 * Local control is dead until that reverses, and with it went the `{"c":{"sensors":...}}`
 * leaf that `local-api.ts:getSensorReadings` used for the sensor's fine-grained
 * temperature, humidity and battery.
 *
 * A `sensor_update` Socket.IO event appeared in the same window carrying exactly that
 * data per device, so it is now the only source for it. It matters for more than
 * humidity: the unit quantizes `roomTemp` to 0.5°C before reporting while the sensor
 * reports ~6 decimals (22.30543 against 22.5), and three of the four units tested
 * regulate FROM the sensor (`tempSource: 'sensor0'`), so the sensor is the real
 * thermostat. The finer value also removes a display ambiguity: 22.5°C is exactly
 * 72.5°F, the one 0.5°C step where a rounding renderer shows 73 and a truncating one
 * shows 72.
 *
 * Every field but `deviceSerial` is optional and nullable: the event is coerced
 * defensively, and anything that did not arrive as a number becomes null.
 */
export interface SensorReading {
  deviceSerial: string;
  uuid?: string;
  battery?: number | null;
  rssi?: number | null;
  txPower?: number | null;
  temperature?: number | null;
  humidity?: number | null;
}

export interface DeviceProfile {
  numberOfFanSpeeds: number;
  hasFanSpeedAuto: boolean;
  hasModeDry: boolean;
  // Dry mode holds its setpoint in spCool on the Kumo v3 cloud (there is no
  // spDry field). When true, dry has a settable target; when false the unit
  // dehumidifies at a fixed setpoint and ignores writes. See accessory.ts.
  usesSetPointInDryMode: boolean;
  hasModeHeat: boolean;
  hasModeVent: boolean;
  hasVaneDir: boolean;
  hasVaneSwing: boolean;
  hasDefrost: boolean;
  hasStandby: boolean;
  minimumSetPoints: { cool: number; heat: number; auto: number };
  maximumSetPoints: { cool: number; heat: number; auto: number };
}

// ---- Vane and fan-speed vocabularies --------------------------------------
// Both lists are live-verified by write test on the author's four units
// (MLZ-KX06NL-U1 x2, MLZ-KX12NL-U1, MSZ-GX06NL-U1): every value below was
// accepted by the local adapter API. Accepted, not shown distinct: the adapter
// accepts anything (next paragraph), and Mitsubishi's service manuals list four
// fan speeds on the MLZ-KX cassettes (OBH943, OBH957) against five on the MSZ-GX
// (OBH950), so on a cassette the five fan names cannot all be different speeds.
//
// These lists are the ONLY validation layer. The adapter does not validate: a
// write of `vaneDir:"notARealVane"` returns HTTP 200 and is silently ignored, so
// a typo produces an invisible no-op rather than an error. Validate before every
// write (isVaneDirection / isFanSpeed) — never pass an unchecked string through.

/**
 * Vane (louver) positions, listed in physical order: 'horizontal' is the most
 * horizontal blade angle, 'vertical' the most downward, with the three mid steps
 * between them. 'auto' (unit decides) leads and 'swing' (continuous sweep) trails,
 * since neither is a fixed angle.
 */
export type VaneDirection =
  | 'auto'
  | 'horizontal'
  | 'midhorizontal'
  | 'midpoint'
  | 'midvertical'
  | 'vertical'
  | 'swing';

export const VANE_DIRECTIONS: readonly VaneDirection[] = [
  'auto',
  'horizontal',
  'midhorizontal',
  'midpoint',
  'midvertical',
  'vertical',
  'swing',
];

export function isVaneDirection(v: unknown): v is VaneDirection {
  return typeof v === 'string' && (VANE_DIRECTIONS as readonly string[]).includes(v);
}

/** Named fan speeds the adapter accepts. */
export type FanSpeed = 'auto' | 'superQuiet' | 'quiet' | 'low' | 'powerful' | 'superPowerful';

/**
 * Ordering decision: indices 1..5 are the airflow ladder in ASCENDING order
 * (superQuiet < quiet < low < powerful < superPowerful). 'auto' is index 0 and is
 * deliberately outside that ladder — it is not an airflow level but "let the unit
 * decide", so it has no rank relative to the others. Anything mapping a speed onto
 * a linear control (a HomeKit RotationSpeed slider, say) must treat index 0 as the
 * auto sentinel and rank only `FAN_SPEEDS.slice(1)`.
 *
 * The device profile's `numberOfFanSpeeds` does not gate this list: a unit reporting
 * 3 accepted all five named speeds, and pykumo sends all five too. That is acceptance
 * only (the adapter does not validate), so it does not show which speeds are distinct,
 * nor that Home Assistant's `_FAN_SPEEDS_BY_COUNT[3] = [quiet, low, powerful]` is
 * wrong about that. A write-then-read-back test per head would settle it; none has
 * been run here.
 */
export const FAN_SPEEDS: readonly FanSpeed[] = [
  'auto',
  'superQuiet',
  'quiet',
  'low',
  'powerful',
  'superPowerful',
];

export function isFanSpeed(v: unknown): v is FanSpeed {
  return typeof v === 'string' && (FAN_SPEEDS as readonly string[]).includes(v);
}

/**
 * Match a fan speed REPORTED by a unit against our vocabulary, ignoring case.
 *
 * Read path only. pykumo lists both `low` and `Low` in its vocabulary and returns
 * the capitalised form for units reporting `numberOfFanSpeeds: 4`, so an exact
 * match would miss it: the speed would fall through to index -1 and render as
 * "auto" on the tile, and the real speed could never be selected again. Writes
 * still go out in our canonical lower-case form, which is what the adapter
 * accepted on every unit tested.
 *
 * Returns undefined for a genuinely unknown speed — callers must not silently
 * treat that as 'auto', since it would misreport the unit's actual state.
 */
export function normalizeFanSpeed(v: unknown): FanSpeed | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }
  const lower = v.toLowerCase();
  return FAN_SPEEDS.find((f) => f.toLowerCase() === lower);
}

export interface Commands {
  spHeat?: number;
  spCool?: number;
  operationMode?: 'off' | 'heat' | 'cool' | 'auto' | 'vent' | 'dry';
  // Was the coarse `'auto'|'low'|'medium'|'high'` enum through 1.8.2, translated to
  // the adapter's vocabulary by a lossy `mapFanSpeedToLocal` in local-api.ts. That
  // enum had no producer anywhere in the plugin (every call site set `fanSpeedRaw`
  // instead, precisely because the coarse strings collided with the real ones —
  // coarse 'low' meant 'quiet'), so it is replaced by the real vocabulary and the
  // lossy mapping is gone with it. Validate with isFanSpeed before writing.
  fanSpeed?: FanSpeed;
  // A verbatim adapter/cloud fan-speed string. Retained alongside the now-typed
  // `fanSpeed` for the mirror path only: mirroring copies whatever the source unit
  // reported, which may be a value this fork has not enumerated, and that must be
  // passed through unvalidated rather than rejected. Takes precedence over
  // `fanSpeed` on the local path; folded into `fanSpeed` on the cloud path
  // (see toCloudCommands). Prefer `fanSpeed` for anything the plugin originates.
  fanSpeedRaw?: string;
  // Vane/louver position. The local field is `vaneDir`; the cloud calls the same
  // thing `airDirection` (translated in toCloudCommands).
  vaneDir?: VaneDirection;
  power?: 0 | 1;
}

/**
 * The cloud wire shape for `POST /devices/send-command`. Deliberately not `Commands`:
 * the cloud names the vane field `airDirection` and has no notion of `fanSpeedRaw`.
 * `toCloudCommands` performs the translation.
 */
export interface CloudCommands {
  spHeat?: number;
  spCool?: number;
  operationMode?: Commands['operationMode'];
  // Verbatim, not narrowed to FanSpeed: the mirror passthrough may carry a string
  // this fork has not enumerated, and the cloud accepts whatever the unit reported.
  fanSpeed?: string;
  airDirection?: VaneDirection;
  power?: 0 | 1;
}

export interface SendCommandRequest {
  deviceSerial: string;
  commands: CloudCommands;
}

export interface SendCommandResponse {
  devices: string[]; // Array of device serial numbers that received the command
}
