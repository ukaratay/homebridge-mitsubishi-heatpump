# Protocol

What this plugin puts on the wire, and what it exposes to HomeKit. Reverse-engineered
from the Mitsubishi Comfort app and cross-checked against
[pykumo](https://github.com/dlarrick/pykumo); none of it is documented by the vendor and
any of it can change without notice.

Negative results live here too — see [What does not exist](#what-does-not-exist) — so the
same dead ends do not get explored twice.

## REST

Base `https://app-prod.kumocloud.com/v3` (`API_BASE_URL`, `src/settings.ts:7`). Requests
carry `Authorization: Bearer <token>` and `X-App-Version` (`APP_VERSION`, currently
`3.2.4`). Access tokens live 20 minutes and are refreshed 5 minutes early.

| Endpoint | Use |
|---|---|
| `POST /login` | Authenticate |
| `POST /refresh` | Renew the access token |
| `GET /sites` | Discover sites |
| `GET /sites/{siteId}/zones` | Primary poll. Zone state plus the nested `adapter` object |
| `GET /devices/{serial}/status` | Read `cryptoSerial`, and only that. Connection state comes from the zones payload, not from here |
| `POST /devices/send-command` | `{ deviceSerial, commands }` |

That is the complete set. Two more exist but are not called: `GET /devices/{serial}`, and
`GET /config` (notification rate limits and archiving settings — nothing this plugin needs).

`GET /devices/{serial}/profile` returns the same capability and setpoint-limit data that
arrives over the socket as `profile_update`, and is read-only: PUT, PATCH and POST all
404.

### Login rate limiting

Login is rate limited, and **the rate-limit response is not always a 429**. A burst of
login attempts also gets `{"error": "usernameOrPasswordIncorrect"}` for credentials that
are entirely valid, and keeps doing so for 15–30 minutes. If a password appears to have
stopped working right after a run of restarts, this is the first thing to rule out.

The plugin spaces login attempts by 10 seconds and adds 0–60 s of jitter to token
refresh for this reason.

### What does not exist

Verified 2025-12-25, while looking for a way to lower a unit's minimum heating setpoint
below the installer-set 17 °C. All of these 404:

`/installer/login` · `/admin/login` · `/technician/login` ·
`/devices/{serial}/settings` · `/devices/{serial}/config` ·
`/devices/{serial}/installer` · `/devices/{serial}/functioncodes` ·
`/sites/{siteId}/settings` · `/functioncodes` · `/limits` · `/ranges`

Login also ignores `role`, `userType`, `accountType` and `installerPin`. There is no
installer-level authentication on the v3 API.

**Conclusion, recorded so nobody repeats the search:** setpoint limits are installer
settings held in the unit (MHK2 Function Code 181, or an installer's service tool). The
cloud reports them read-only and enforces them — a write outside the range returns 400
with `{"error":{"<serial>":{"commands":["invalidSpHeatRange"]}}}`. No API can change
them.

## Socket.IO

`https://socket-prod.kumocloud.com` (`SOCKET_BASE_URL`), upgraded to `wss://` by
socket.io. Streaming is the primary update path; cloud polling is the fallback.

**Emitted:**

| Emit | Purpose |
|---|---|
| `subscribe(serial)` | One per device |
| `subscribe('', userId)` | Account-level. Required for `adapter_update` to arrive at all |
| `force_adapter_request(serial, 'iuStatus' \| 'profile' \| 'adapterStatus')` | On first connect, pull current state rather than waiting for a push |
| `device_status_v2('')` and `device_status_v2(serial)` | Request connection status |

`force_adapter_request` and `device_status_v2` are sent on the initial connection and after
a zombie-stream reconnect, not on routine (token-refresh) reconnects. While the stream is
connected but `device_update` has been silent for 5 minutes, one
`force_adapter_request(serial, 'iuStatus')` per device asks for status; if no device
answers within 2.5 minutes, the stream is reconnected.

**Received:**

| Event | Carries |
|---|---|
| `device_update` | Full unit state, including `fanSpeed`, `airDirection`, `displayConfig` |
| `profile_update` | Capabilities, fan-speed count, setpoint limits |
| `sensor_update` | A paired wireless sensor's temperature, humidity and battery |
| `adapter_update` | Adapter firmware and RSSI. Formerly also the local-control password |
| `device_status_v2` | Connected / disconnected. A disconnect turns the unit's tiles into No Response |
| `acoil_update` | Outdoor unit. Minimal, debug-logged |

`operationMode` is **sent** as `'auto'` but **returned** as `'autoHeat'` or `'autoCool'`.

The adapter does not validate writes: `vaneDir: "notARealVane"` returns HTTP 200 and is
silently ignored, so every fan-speed and vane value is checked against a known vocabulary
before it is sent (`src/settings.ts`).

### Payloads

Field documentation cross-referenced against
[dlarrick/hass-kumo](https://github.com/dlarrick/hass-kumo),
[EnumC/ha_kumo_ws](https://github.com/EnumC/ha_kumo_ws) and pykumo's `Cloud_api_v3.md`.
The plugin reads a subset; the rest is recorded because the vendor documents none of it.

`device_update` — primary state event, sent on change and on subscription:

```json
{
  "deviceSerial": "string",
  "roomTemp": 21.5,
  "spHeat": 20, "spCool": 24, "spAuto": null,
  "power": 1,
  "operationMode": "heat",
  "previousOperationMode": "heat",
  "fanSpeed": "auto",
  "airDirection": "auto",
  "humidity": 45,
  "rssi": -55,
  "connected": true,
  "modelNumber": "SVZ-KP30NA",
  "displayConfig": { "filter": false, "defrost": false, "hotAdjust": false, "standby": false },
  "activeThermistor": "string",
  "tempSource": "string",
  "scheduleOwner": "adapter",
  "scheduleHoldEndTime": 0,
  "isSimulator": false, "ledDisabled": false, "isHeadless": false,
  "lastStatusChangeAt": "ISO 8601", "createdAt": "ISO 8601", "updatedAt": "ISO 8601"
}
```

`displayConfig` is the cloud's spelling of what the local API exposes under
`indoorUnit.status`:

| Cloud | Local (pykumo) | Meaning |
|---|---|---|
| `displayConfig.filter` | `filterDirty` | Filter needs cleaning |
| `displayConfig.defrost` | `defrost` | Defrost cycle active |
| `displayConfig.standby` | `standby` | Compressor idle |
| `displayConfig.hotAdjust` | — | Hot adjust active |

`tempSource` is worth knowing: it names which thermistor regulates the unit. `sensor0`
means a paired wireless sensor is the real thermostat, not the head unit.

`profile_update` — capabilities and limits. Beyond the fields the plugin consumes it also
carries `hasHotAdjust`, `hasInitialSettings`, `hasModeTest` and `extendedTemps`.
`minimumSetPoints` / `maximumSetPoints` are `{ cool, heat, auto }` in Celsius.

`adapter_update` — `{ deviceSerial, firmwareVersion, routerRssi, minSetpoint, maxSetpoint,
roomTempDisplayOffset }`, and formerly `password`. **Strip before logging.**

`device_status_v2` — `{ deviceSerial, status, lastTimeConnected, lastDisconnectedReason }`;
`status` is `"connected"` or `"disconnected"`.

`acoil_update` — `{ deviceSerial, date }`. That is all of it.

## Local LAN

`PUT http://<unit-ip>/api?m=<token>`. Reads and writes are both PUTs — a status read sends
empty leaf objects and the adapter fills them in.

The token is a port of pykumo's `_token()`: two SHA-256 passes over an 88-byte buffer
assembled from a fixed 32-byte constant, `sha256(password ‖ body)`, and the first 4 bytes
of `cryptoSerial` (`src/local-api.ts:101-124`).

Both halves of the key come from the cloud — `password` from `adapter_update`,
`cryptoSerial` from `GET /devices/{serial}/status` — and **the cloud stopped serving both
around 2026-07-31**. See [README → Local LAN control](../README.md#local-lan-control).

## HomeKit services

One accessory per indoor unit.

**HeaterCooler** (primary):

| Characteristic | Notes |
|---|---|
| `Active` | On/off. Independent of mode |
| `CurrentHeaterCoolerState` | Inactive / idle / heating / cooling. Idle is real — fan-only and compressor standby report it |
| `TargetHeaterCoolerState` | Heat / cool / auto, narrowed to what the unit's profile supports |
| `CurrentTemperature` | From the paired wireless sensor when there is one, otherwise the unit's own thermistor |
| `HeatingThresholdTemperature`, `CoolingThresholdTemperature` | These **are** the setpoint controls in every mode. There is deliberately no `TargetTemperature` |
| `SwingMode` | Vane swing, on units that have one |
| `TemperatureDisplayUnits` | Settable. The Home app ignores it; Eve and others honour it |

**Fanv2** (linked, subtype `airflow`): `Active`, `CurrentFanState`, `RotationSpeed`
(`minValue` 0, `maxValue` 100, `minStep` 25 — five detents, nothing dead), and
`TargetFanState` on units whose profile reports an auto fan.

**Optional, per unit:**

| Service | When |
|---|---|
| `HumiditySensor` | `showHumiditySensor`, on by default |
| `Battery` | Units with a paired wireless sensor. `BatteryLevel`, `StatusLowBattery` below 20%, `ChargingState = NOT_CHARGEABLE` |
| `FilterMaintenance` | Created lazily, the first time the unit reports a dirty filter |
| `Slats` | `exposeVaneSlat`, off by default. Five discrete angles, −90° to 90° in 45° steps |
| `Switch` ×2 | `showDrySwitch` / `showFanOnlySwitch`, both off by default and both capability-gated |

A `Thermostat` service left in the accessory cache by a pre-2.0 version is removed on
first start, with a log line saying so.
