import { createHash } from 'crypto';
import { Agent, request as httpRequest } from 'http';
import { Logger } from 'homebridge';
import { Commands, DeviceStatus, isFanSpeed, isVaneDirection } from './settings';

/**
 * Local LAN control of Mitsubishi Kumo adapters.
 *
 * The indoor-unit WiFi adapter exposes a local HTTP API at
 * `PUT http://<ip>/api?m=<token>` with a JSON body `{"c":{"indoorUnit":{"status":{...}}}}`.
 * Both reads and writes are PUTs — a status read sends empty leaf objects and the
 * unit echoes the populated values back under `"r"`.
 *
 * The request is authenticated with a token derived from two per-device secrets:
 *  - `password`     — base64, from the cloud `adapter_update` Socket.IO event
 *  - `cryptoSerial` — hex, from the cloud `GET /devices/{serial}/status`
 *
 * The token algorithm is a port of dlarrick/pykumo's `_token()` (verified
 * byte-for-byte against nikolairahimi/mitsubishi-comfort, the library behind
 * Home Assistant's official `mitsubishi_comfort` integration) and live-confirmed
 * against real hardware: a signed status read returned `200` + `r.indoorUnit.status`.
 *
 * Local-vs-cloud differences worth remembering:
 *  - Local fields are `mode` (not `operationMode`) and `vaneDir` (not `airDirection`).
 *  - There is NO `power` field locally — `mode:"off"` powers down, any active mode powers on.
 *  - `filterDirty` / `defrost` / `standby` come straight from the local status.
 *  - Humidity is NOT in the status read (it lives in a separate sensors/MHK2 query and
 *    only exists on sensor-equipped units) — handled by the cloud path for now.
 */

/** Fixed 32-byte constant baked into the adapter's token scheme (pykumo `W_PARAM`). */
const W_PARAM = Buffer.from(
  '44c73283b498d432ff25f5c8e06a016aef931e68f0a00ea710e36e6338fb22db',
  'hex',
);

/** The query body for a full status read (empty leaves = "report everything"). */
export const STATUS_READ_BODY = Buffer.from('{"c":{"indoorUnit":{"status":{}}}}', 'utf8');

/**
 * A dedicated agent with keep-alive OFF.
 *
 * Node's global agent defaults to `keepAlive: true` with a 5s timeout, so every
 * request would park a live TCP connection on the adapter for 5s after the reply.
 * These WiFi adapters have a very small connection table and treat a parked socket
 * as an occupied slot — both reference implementations tear the connection down
 * after every exchange for exactly this reason (pykumo `_drop_session()` with
 * pool_maxsize=1; mitsubishi-comfort `disconnect()` in a finally). Reusing a
 * pooled socket also produces the failure mode in `request` below: the adapter
 * closes an idle connection and the next write on it fails.
 */
const LOCAL_AGENT = new Agent({ keepAlive: false, maxSockets: 1 });

/**
 * One signed PUT to an adapter, resolving its parsed JSON reply.
 *
 * Plain `node:http` rather than the global `fetch`, and the agent above is the
 * whole reason: undici's fetch — which is what global fetch is — has no way to
 * take an `http.Agent`. It does not reject the option, it ignores it, so a swap
 * to `fetch()` would have silently put every LAN request back on a keep-alive
 * pool with no per-adapter socket cap. `http.request` takes the agent directly.
 *
 * Two timers, because one is not enough. `timeout` is the socket timeout: it
 * covers a dead IP and an adapter that accepts the connection then says nothing,
 * and it destroys the socket rather than parking it. But Node arms it when the
 * agent ASSIGNS a socket, not when the request is created, so a request queued
 * behind `maxSockets: 1` waits with no timer running at all. `signal` is the
 * missing half: armed here, at call time, it bounds total duration the way the
 * caller's wall-clock `Promise.race` used to (node-fetch v3 had dropped its own
 * `timeout` option, which is why that race existed).
 *
 * Dropping the race and keeping only the socket timeout was measurably wrong.
 * `maxSockets` is per origin, so a /24 sweep does not queue — 253 candidates are
 * 253 origins — but a rediscovery sweep probing an IP the poller is already
 * talking to does. Measured 2026-08-02 against a silent server, 8 requests to one
 * origin at a 500ms cap: 503ms with the race, 4022ms with the socket timeout
 * alone, i.e. the cap became per-socket rather than per-call. Distinct origins
 * were 505ms and 508ms, unchanged.
 *
 * Rejects on any transport failure and resolves `null` when the reply is not a
 * JSON object: the callers' 'transport' and 'malformed'. The HTTP status is
 * deliberately not read, exactly as the node-fetch version never read `res.ok`.
 * The adapter answers 200 to everything it parses, its own `_api_error` replies
 * included, so the body is the only signal there is.
 */
function putSigned(
  ip: string,
  token: string,
  accept: string,
  body: Buffer,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `http://${ip}/api?m=${token}`,
      {
        method: 'PUT',
        agent: LOCAL_AGENT,
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'Accept': accept,
          // Explicit because `http.request` sends no Accept-Encoding at all, while
          // node-fetch advertised gzip and transparently inflated the reply. Nothing
          // here can inflate one, so a server that took the silence as licence to
          // compress would surface as a bogus 'malformed'. Content-Length needs no
          // such help: handing the whole body to `req.end()` below makes Node compute
          // and send it (verified against a capture — chunked is only what a body
          // written in pieces would get, and it never was).
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(text);
            resolve(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    // `timeout` only fires the event; the socket lives on until something tears it
    // down, so an unreachable unit would still stall the poll forever without this.
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Why a local request produced no data.
 *
 * The distinction that matters is `auth` versus `busy`. Discovery sweeps the
 * subnet and asks every host to authenticate a token; only `auth` means "this is
 * some other Kumo unit, stop considering this IP". `busy` covers the adapter's
 * transient self-reported failures — it is out of memory or mid-serialization —
 * which say nothing about identity. Collapsing the two (as before) let a unit
 * that happened to be busy during the sweep get written off as a stranger and
 * stranded on cloud control.
 */
export type LocalErrorKind = 'none' | 'transport' | 'auth' | 'busy' | 'malformed' | 'no-creds';

/** Map an adapter `_api_error` string onto a kind. Vocabulary from pykumo. */
export function classifyApiError(code: string): LocalErrorKind {
  if (code === 'device_authentication_error') {
    return 'auth';
  }
  // `serializer_error` and `__no_memory` are the adapter saying "not right now".
  if (code === 'serializer_error' || code === '__no_memory') {
    return 'busy';
  }
  return 'malformed';
}

export interface LocalDeviceCreds {
  ip: string;
  password: string; // base64
  cryptoSerial: string; // hex, >= 9 bytes
}

/**
 * Round to 0.1°C — strips float noise; the units honor 0.1 granularity (verified).
 *
 * Belt and braces only. Setpoint quantization is now owned by `src/temperature.ts`
 * and applied in accessory.ts BEFORE sendDeviceCommand, so every transport gets the
 * same value. This stays as a defensive last resort against a caller that reaches
 * the local transport without going through that path; it must never be the only
 * quantizer, or local and cloud writes would disagree again.
 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compute the URL security token for a given request body.
 * Port of pykumo `_token()`: two SHA-256s over an 88-byte buffer assembled from
 * W_PARAM, sha256(password ‖ body), the constant `0x0840`, S_PARAM (0), and a
 * shuffled slice of the cryptoSerial (bytes [8], [4:8), [0:4)).
 */
export function computeLocalToken(passwordB64: string, cryptoSerialHex: string, body: Buffer): string {
  const password = Buffer.from(passwordB64, 'base64');
  const cryptoSerial = Buffer.from(cryptoSerialHex, 'hex');
  if (cryptoSerial.length < 9) {
    throw new Error(`cryptoSerial too short (${cryptoSerial.length} bytes, need >= 9)`);
  }

  const dataHash = createHash('sha256').update(Buffer.concat([password, body])).digest();

  const buf = Buffer.alloc(88);
  W_PARAM.copy(buf, 0); // [0:32)
  dataHash.copy(buf, 32); // [32:64)
  buf[64] = 0x08;
  buf[65] = 0x40; // [64:66)
  buf[66] = 0x00; // S_PARAM; [67:79) stay zero
  buf[79] = cryptoSerial[8];
  cryptoSerial.copy(buf, 80, 4, 8); // [80:84) = cryptoSerial[4:8)
  cryptoSerial.copy(buf, 84, 0, 4); // [84:88) = cryptoSerial[0:4)

  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build the local command body for a set of our cloud-shaped Commands.
 * Maps `operationMode` → `mode` and `vaneDir` → `vaneDir`, rounds setpoints to
 * 0.1°C, and DROPS `power` (local control expresses on/off purely through `mode`).
 *
 * Throws on an out-of-vocabulary vane direction or fan speed. This is the only
 * validation that will ever happen: the adapter answers HTTP 200 to a write of
 * `vaneDir:"notARealVane"` and silently ignores it, so dropping a bad value here
 * would produce an invisible no-op — the unit would simply never move, with no
 * error anywhere. Throwing also aborts before any I/O, so nothing is half-written.
 */
export function buildLocalCommandBody(commands: Commands): Buffer {
  const status: Record<string, unknown> = {};

  if (commands.operationMode !== undefined) {
    status.mode = commands.operationMode; // off/heat/cool/auto/vent/dry — same strings locally
  }
  if (commands.spHeat !== undefined) {
    status.spHeat = round1(commands.spHeat);
  }
  if (commands.spCool !== undefined) {
    status.spCool = round1(commands.spCool);
  }
  if (commands.fanSpeedRaw !== undefined) {
    // Mirror path: a verbatim fan-speed string observed on the source unit. Written
    // as-is and NOT validated — the source reported it, so the hardware produces it,
    // even if it is a value this fork has not enumerated. Takes precedence over
    // `fanSpeed` (a mirror push must copy the source faithfully).
    status.fanSpeed = commands.fanSpeedRaw;
  } else if (commands.fanSpeed !== undefined) {
    // Same vocabulary locally and in the cloud since the coarse auto/low/medium/high
    // enum was removed, so there is nothing left to translate — just validate.
    if (!isFanSpeed(commands.fanSpeed)) {
      throw new Error(`Invalid fan speed "${commands.fanSpeed}" — the adapter would accept and ignore it`);
    }
    status.fanSpeed = commands.fanSpeed;
  }
  if (commands.vaneDir !== undefined) {
    if (!isVaneDirection(commands.vaneDir)) {
      throw new Error(`Invalid vane direction "${commands.vaneDir}" — the adapter would accept and ignore it`);
    }
    status.vaneDir = commands.vaneDir; // local `vaneDir` == cloud `airDirection`
  }
  // Note: commands.power is intentionally ignored — `mode` carries on/off locally.

  return Buffer.from(JSON.stringify({ c: { indoorUnit: { status } } }), 'utf8');
}

/**
 * Map a local `r.indoorUnit.status` object onto our DeviceStatus shape.
 * Returns the fields the local API provides; humidity is omitted (cloud-only).
 */
export function mapLocalStatus(local: Record<string, unknown>): Partial<DeviceStatus> {
  const mode = typeof local.mode === 'string' ? local.mode : 'off';
  return {
    operationMode: mode,
    power: mode === 'off' ? 0 : 1,
    roomTemp: local.roomTemp as number,
    spHeat: local.spHeat as number,
    spCool: local.spCool as number,
    spAuto: null, // these units have no spAuto; auto uses the spHeat/spCool band
    // Both are kept as plain strings rather than narrowed to FanSpeed/VaneDirection.
    // This is inbound device data behind an unchecked cast, so a closed union here
    // would be a claim the compiler cannot enforce, and collapsing an unrecognized
    // value to 'auto' would misreport the unit's real position. The write path
    // (buildLocalCommandBody) is where the vocabularies are enforced. Verified live:
    // vaneDir reports one of VANE_DIRECTIONS on all four units.
    fanSpeed: typeof local.fanSpeed === 'string' ? local.fanSpeed : 'auto',
    airDirection: typeof local.vaneDir === 'string' ? local.vaneDir : 'auto', // local `vaneDir` == cloud `airDirection`
    filterDirty: local.filterDirty === true,
    defrost: local.defrost === true,
    standby: local.standby === true,
    connected: true, // a successful local read means the unit is reachable
  };
}

/**
 * Per-device local HTTP client. Serializes requests per unit (the adapter
 * tolerates only ~one concurrent local connection — pykumo locks for this reason;
 * the HA library dropped the lock, which we don't repeat) and uses a forgiving
 * timeout (the reference's 1.2s connect timeout flaps on busy WiFi).
 */
export class LocalKumoClient {
  private readonly creds = new Map<string, LocalDeviceCreds>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly log: Logger,
    private readonly timeoutMs: number = 6000,
  ) {}

  setCreds(serial: string, creds: LocalDeviceCreds): void {
    this.creds.set(serial, creds);
  }

  hasLocal(serial: string): boolean {
    return this.creds.has(serial);
  }

  /** Run `fn` after any in-flight request for this serial completes (per-device mutex). */
  private withLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(serial) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    // Swallow errors on the stored chain so one failure doesn't reject the next caller.
    this.chains.set(serial, next.catch(() => undefined));
    return next;
  }

  /**
   * Send a signed PUT and return the parsed `r` object, or null on any failure
   * (timeout, network error, auth error, malformed reply). Null means "no data" —
   * never interpret it as a device state.
   */
  /** Units that reported no sensor and no MHK2; stop paying for the lookup. */
  private readonly noSensor: Set<string> = new Set();
  /** Last seen tempSource|activeThermistor per unit, to detect a source change. */
  private readonly lastTempSource: Map<string, string> = new Map();

  async request(serial: string, body: Buffer): Promise<Record<string, unknown> | null> {
    return (await this.requestDetailed(serial, body)).result;
  }

  /**
   * Send a signed PUT, retrying once on a transport error.
   *
   * The retry is safe because every command this plugin sends is an idempotent
   * absolute-value write (a setpoint, a mode, a fan speed — never a delta), so
   * re-sending can only re-assert the same state. Both reference implementations
   * retry once for the same reason. The failure it targets is a connection the
   * adapter closed while it sat idle; a fresh one almost always succeeds.
   *
   * Returns the `r` payload plus a classification of *why* it failed, which
   * discovery needs in order to tell "not this device" from "busy right now".
   */
  async requestDetailed(
    serial: string,
    body: Buffer,
  ): Promise<{ result: Record<string, unknown> | null; error: LocalErrorKind }> {
    const creds = this.creds.get(serial);
    if (!creds) {
      return { result: null, error: 'no-creds' };
    }

    return this.withLock(serial, async () => {
      let last: LocalErrorKind = 'transport';
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await this.attempt(serial, creds, body);
        if (outcome.result) {
          return outcome;
        }
        last = outcome.error;
        // Only a transport failure is worth a second try. An auth rejection or a
        // well-formed error reply will say the same thing again.
        if (outcome.error !== 'transport') {
          return outcome;
        }
        this.log.debug(`[LOCAL] ${serial} @ ${creds.ip}: transport failure, retrying once`);
      }
      return { result: null, error: last };
    });
  }

  private async attempt(
    serial: string,
    creds: LocalDeviceCreds,
    body: Buffer,
  ): Promise<{ result: Record<string, unknown> | null; error: LocalErrorKind }> {
    const token = computeLocalToken(creds.password, creds.cryptoSerial, body);
    try {
      const json = await putSigned(
        creds.ip,
        token,
        'application/json, text/plain, */*',
        body,
        this.timeoutMs,
      );
      if (json && json.r && typeof json.r === 'object') {
        return { result: json.r as Record<string, unknown>, error: 'none' };
      }
      if (json && json._api_error) {
        const kind = classifyApiError(String(json._api_error));
        this.log.debug(`[LOCAL] ${serial} @ ${creds.ip}: api error ${json._api_error} (${kind})`);
        return { result: null, error: kind };
      }
      return { result: null, error: 'malformed' };
    } catch (err) {
      this.log.debug(`[LOCAL] ${serial} @ ${creds.ip}: request failed (${(err as Error).message})`);
      return { result: null, error: 'transport' };
    }
  }

  /** Read and map the unit's current status locally, or null if unreachable. */
  async getStatus(serial: string): Promise<Partial<DeviceStatus> | null> {
    const r = await this.request(serial, STATUS_READ_BODY);
    const indoorUnit = r?.indoorUnit as Record<string, unknown> | undefined;
    const status = indoorUnit?.status as Record<string, unknown> | undefined;
    if (!status || status.roomTemp === undefined) {
      return null;
    }
    const mapped = mapLocalStatus(status);

    // Only ask for the remote sensor when the unit says one is driving the
    // reading. `tempSource`/`activeThermistor` are 'sensorN' on a unit with a
    // paired wireless sensor and 'unset' on one running off its own thermistor —
    // no point spending a request on a unit that has nothing to report.
    if (this.deviceHasSensor(serial, status)) {
      const extra = await this.getSensorReadings(serial);
      if (extra) {
        if (extra.humidity !== undefined) {
          mapped.humidity = extra.humidity;
        }
        // Prefer the sensor's own temperature over the unit's `roomTemp`.
        // The unit quantizes to 0.5°C before reporting; the sensor gives ~6
        // decimals. Measured 2026-07-27: sensor 22.648632°C against roomTemp
        // 22.5. In °F that is the difference between an unambiguous 72.77 (both
        // apps show 73) and exactly 72.50, which one app rounds to 73 while the
        // other truncates to 72. The finer value removes the ambiguity.
        if (extra.temperature !== undefined) {
          mapped.roomTemp = extra.temperature;
        }
      }
    }
    return mapped;
  }

  /**
   * Whether this unit's reading is coming from a paired wireless sensor.
   *
   * Also resets the `noSensor` latch when the unit's temperature source CHANGES,
   * which is the only event that can make a previously fruitless lookup worth
   * retrying (a sensor being paired, or one dropping off). Clearing the latch
   * merely because the unit currently claims a sensor would defeat it entirely:
   * a unit reporting `tempSource: sensor0` whose sensors leaf returns nothing
   * usable would be re-probed on every single poll, forever.
   */
  private deviceHasSensor(serial: string, status: Record<string, unknown>): boolean {
    const src = typeof status.tempSource === 'string' ? status.tempSource : '';
    const active = typeof status.activeThermistor === 'string' ? status.activeThermistor : '';
    const signature = `${src}|${active}`;

    const previous = this.lastTempSource.get(serial);
    if (previous !== undefined && previous !== signature) {
      this.noSensor.delete(serial);
    }
    this.lastTempSource.set(serial, signature);

    return src.startsWith('sensor') || active.startsWith('sensor');
  }

  /**
   * Read the paired sensor (and, failing that, an MHK2 wall thermostat).
   *
   * Humidity is not in `indoorUnit.status` at all — upstream therefore left it
   * cloud-only, which is wrong under local control: cloud updates are dropped for
   * 45s after every local read, so a local-authoritative unit's humidity would go
   * stale or never arrive. Both reference implementations read it from these
   * leaves in the same poll.
   *
   * Sensor slots are consecutive; the first slot with no `uuid` ends the list.
   * A unit that reports neither sensors nor MHK2 is remembered in `noSensor` so
   * the poll stops paying for the lookup, mirroring mitsubishi-comfort's latch.
   */
  private async getSensorReadings(
    serial: string,
  ): Promise<{ humidity?: number | null; temperature?: number } | null> {
    if (this.noSensor.has(serial)) {
      return null;
    }

    for (let i = 0; i < 4; i++) {
      const r = await this.request(serial, Buffer.from(`{"c":{"sensors":{"${i}":{}}}}`, 'utf8'));
      const sensors = r?.sensors as Record<string, unknown> | undefined;
      const sensor = sensors?.[String(i)] as Record<string, unknown> | undefined;
      if (!sensor || !sensor.uuid) {
        break; // slots are consecutive: no uuid here means no more sensors
      }
      const temperature = typeof sensor.temperature === 'number' ? sensor.temperature : undefined;
      const humidity = typeof sensor.humidity === 'number' ? sensor.humidity : undefined;
      if (temperature !== undefined || humidity !== undefined) {
        return { temperature, humidity };
      }
    }

    // No usable sensor — try an MHK2 wall thermostat, which reports humidity only.
    const r = await this.request(serial, Buffer.from('{"c":{"mhk2":{"status":{}}}}', 'utf8'));
    const mhk2 = r?.mhk2 as Record<string, unknown> | undefined;
    const st = mhk2?.status as Record<string, unknown> | undefined;
    const indoorHumid = st?.indoorHumid;
    if (typeof indoorHumid === 'number') {
      return { humidity: indoorHumid };
    }

    this.noSensor.add(serial);
    this.log.debug(`[LOCAL] ${serial}: no sensor or MHK2 humidity source — not asking again`);
    return null;
  }

  /** Send a control command locally. Returns true iff the unit acknowledged with `r`. */
  async sendCommand(serial: string, commands: Commands): Promise<boolean> {
    const body = buildLocalCommandBody(commands);
    const r = await this.request(serial, body);
    return r !== null;
  }
}

// ---- LAN discovery --------------------------------------------------------
// The cloud provides neither the unit's IP nor its MAC, so we find each unit by
// sweeping the subnet and seeing which adapter authenticates which device's token.

export interface SerialCreds {
  password: string; // base64
  cryptoSerial: string; // hex
}

/** Enumerate the /24 a host IPv4 sits on (x.y.z.1 .. .254), excluding the host itself. */
export function enumerateSubnet(hostIpv4: string): string[] {
  const m = hostIpv4.match(/^(\d+\.\d+\.\d+)\.(\d+)$/);
  if (!m) {
    return [];
  }
  const prefix = m[1];
  const self = Number(m[2]);
  const ips: string[] = [];
  for (let i = 1; i <= 254; i++) {
    if (i !== self) {
      ips.push(`${prefix}.${i}`);
    }
  }
  return ips;
}

type ProbeResult = 'match' | 'kumo' | null;

/**
 * Probe one IP with one device's token via a status read:
 *  - 'match' → the adapter authenticated this device (returns r.indoorUnit): IP found
 *  - 'kumo'  → a Kumo adapter that rejected THIS device's token: a different unit
 *  - null    → unreachable, not a Kumo adapter, or a Kumo adapter that was busy
 *
 * Only `device_authentication_error` proves the IP belongs to a different unit.
 * The adapter's other self-reported errors (`serializer_error`, `__no_memory`)
 * mean "ask me again" and say nothing about identity — previously they were all
 * read as 'kumo', so a unit that happened to be out of memory during the sweep
 * was written off and left on cloud control until a later retry re-swept it.
 * Returning null instead leaves the IP eligible to be probed again.
 */
async function probeIpForSerial(ip: string, creds: SerialCreds, timeoutMs: number): Promise<ProbeResult> {
  try {
    const token = computeLocalToken(creds.password, creds.cryptoSerial, STATUS_READ_BODY);
    const json = await putSigned(ip, token, '*/*', STATUS_READ_BODY, timeoutMs);
    if (json && json.r && typeof json.r === 'object' && (json.r as Record<string, unknown>).indoorUnit) {
      return 'match';
    }
    if (json && json._api_error) {
      return classifyApiError(String(json._api_error)) === 'auth' ? 'kumo' : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const run = async (): Promise<void> => {
    while (idx < items.length) {
      await fn(items[idx++]);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(run());
  }
  await Promise.all(workers);
}

/**
 * Sweep candidate IPs and return a serial→IP map by matching each device's token
 * to the adapter that authenticates it. ~5s for a /24 in practice (verified).
 */
export async function discoverDeviceIps(
  log: Logger,
  candidateIps: string[],
  creds: Map<string, SerialCreds>,
  opts: { concurrency?: number; timeoutMs?: number } = {},
): Promise<Map<string, string>> {
  const concurrency = opts.concurrency ?? 24;
  const timeoutMs = opts.timeoutMs ?? 3500;
  const found = new Map<string, string>();
  const remaining = new Set(creds.keys());

  await mapLimit(candidateIps, concurrency, async (ip) => {
    if (remaining.size === 0) {
      return;
    }
    for (const serial of [...remaining]) {
      const result = await probeIpForSerial(ip, creds.get(serial)!, timeoutMs);
      if (result === 'match') {
        found.set(serial, ip);
        remaining.delete(serial);
        log.info(`[LOCAL] Discovered ${serial} at ${ip}`);
        break;
      }
      if (result === null) {
        break; // not a reachable Kumo host — don't bother trying the other serials
      }
      // 'kumo': a Kumo adapter that isn't this serial — try the next serial here
    }
  });

  if (remaining.size > 0) {
    log.warn(`[LOCAL] ${remaining.size} device(s) not found on the LAN (will use cloud): ${[...remaining].join(', ')}`);
  }
  return found;
}
