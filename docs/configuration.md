# Configuration

Every option, and the mirroring guide. For the HomeKit side see the
[README](../README.md); for the wire protocol see [protocol.md](protocol.md).

## Minimal

```json
{
  "platforms": [
    {
      "platform": "KumoV3",
      "name": "Kumo",
      "username": "your-email@example.com",
      "password": "your-password"
    }
  ]
}
```

## Recommended

Add `disablePolling`. Streaming carries every update, and polling only starts if
streaming drops.

```json
{
  "platform": "KumoV3",
  "name": "Kumo",
  "username": "your-email@example.com",
  "password": "your-password",
  "disablePolling": true
}
```

With streaming healthy, the only recurring cloud request is the token refresh —
access tokens live 20 minutes and are refreshed 5 minutes early, so **4 requests per
hour** and nothing else. If streaming disconnects, 10-second polling starts by itself
and stops again on reconnect.

## Options

| Option | Type | Required | Description |
|---|---|---|---|
| `platform` | string | Yes | Must be `KumoV3` |
| `name` | string | Yes | Platform name. Defaults to `Kumo`, and the Homebridge UI pre-fills it |
| `username` | string | Yes | Your Mitsubishi Comfort / Kumo Cloud email address |
| `password` | string | Yes | Your Mitsubishi Comfort / Kumo Cloud password |
| `pollInterval` | number | No | Cloud poll interval in seconds while streaming is healthy (default 30). Below 5 the platform stays idle — see [Validation](#validation) |
| `disablePolling` | boolean | No | Recommended. Skip polling entirely while streaming is healthy; polling re-enables itself if streaming fails (default false) |
| `degradedPollInterval` | number | No | Poll interval in seconds while streaming is unhealthy (default 10) |
| `streamingHealthCheckInterval` | number | No | How often to check the Socket.IO connection state, in seconds (default 30) |
| `streamingStaleThreshold` | number | No | **Deprecated and inert.** Nothing reads it. Streaming health is decided by the Socket.IO connection state. Accepted so an existing config stays valid |
| `excludeDevices` | string[] | No | Device serials to hide from HomeKit. Serials appear in the log during discovery |
| `debug` | boolean | No | Verbose logging (default false). See [Debug](#debug) |
| `showHumiditySensor` | boolean | No | Expose indoor humidity as a `HumiditySensor` (default **true**). Turn off if humidity dominates the tile in the Home app |
| `showDrySwitch` | boolean | No | Add a per-unit Dry switch (default false). Added only on units whose profile reports dry |
| `showFanOnlySwitch` | boolean | No | Add a per-unit Fan-only switch (default false). This is fan-*only* mode; fan speed while heating or cooling is already on the main tile |
| `fixedFanSpeedSwitch` | boolean | No | Add a per-unit "&lt;unit&gt; Fixed Fan Speed" switch (default **true**; only `false` turns it off). It is on while the unit runs at a fixed speed and off otherwise, including while the unit is off. Turning it off sets fan auto; turning it on holds the slider's speed. A Home scene sets fan auto unless it turns this switch on. With `false` there is no switch, and scenes replay the fan speed and mode they captured, as in 2.3.1. See [Fan auto and scenes](../README.md#fan-auto-and-scenes). Added only on units whose profile reports an auto fan |
| `exposeVaneSlat` | boolean | No | Expose vane angles as a `Slats` service (default false). It is the only way to set a fixed angle from Home, since swing off means vane auto. Apple Home files `Slats` under window coverings — see the warning in the [README](../README.md#vane-and-swing) |
| `localControl` | boolean | No | Control units over the LAN (default false). **Currently non-functional through no fault of the plugin** — see [README → Local LAN control](../README.md#local-lan-control) |
| `localPollInterval` | number | No | Seconds between LAN status polls when `localControl` is on (default 15) |
| `localControlIps` | object | No | `{ "<deviceSerial>": "<ip>" }` to skip LAN discovery for specific units. **JSON editor only** — see [UI coverage](#ui-coverage) |
| `mirror` | array | No | `{ source, target }` device-serial pairs. See [Device mirroring](#device-mirroring) |

### Validation

Credentials and `pollInterval` are checked at startup, in `validatePlatformConfig`
(`src/platform.ts`). A bad value is **rejected, not clamped**: `pollInterval` must be a
number and at least 5, the username must contain `@`, and the password must be a non-empty
string.

When one of those fails, the platform logs a single error naming the problem and then
**stays idle** — it registers no accessories and starts no timers. Homebridge itself keeps
running and your other plugins are untouched. Fix the value in the Homebridge UI and
restart; nothing else needs cleaning up.

The minimum and maximum values on `degradedPollInterval`, `streamingHealthCheckInterval`
and `localPollInterval` live in `config.schema.json` only. The Homebridge UI form enforces
them; nothing clamps at runtime, so a value written straight into `config.json` is used
as-is.

### UI coverage

Every option renders in the Homebridge UI form except two:

- `localControlIps`, a free-form serial-to-IP map the form cannot express. Set it in the
  JSON config editor; the Local Control section carries a help block saying so, and any
  value already there is preserved when you save the form.
- `streamingStaleThreshold`, which is inert (see the table above). It stays in the schema
  so a `config.json` that sets it remains valid, but the form no longer shows a control
  that does nothing. It is JSON-only.

### Restart scope

`localControl` and `mirror` are read from the **parent** Homebridge config rather than the
child bridge's, so changing either needs a full Homebridge restart. Restarting just the
child bridge will not pick them up.

### Debug

`debug: true` logs API requests and responses with timings, raw zone and device payloads,
streaming updates, and token refreshes. It can log sensitive values, so keep it off except
while troubleshooting. The plugin warns on startup when it is on.

## Device mirroring

Make one unit **follow** another. Useful when a unit has no wall control and you want it
to shadow one you actually operate.

Serials appear in the log during device discovery.

```json
{
  "platform": "KumoV3",
  "username": "user@example.com",
  "password": "password123",
  "mirror": [
    { "source": "KITCHENSERIAL", "target": "LIVINGROOMSERIAL" }
  ]
}
```

How it behaves:

- **One-way.** The target follows the source; the source is never affected by the target.
- **Full state on every source change** — mode (heat / cool / auto / dry / vent / off),
  the setpoint(s), on/off, and fan speed.
- **Any control path triggers it.** It follows the source's *actual* state, so changing
  the source from its wall thermostat, the Comfort app, or HomeKit all mirror across.
  HomeKit changes mirror in about a second; wall and app changes mirror when the plugin
  next reads the source.
- **Manual target changes stick** until the source changes again, at which point the
  target re-syncs. Because any source change re-applies the *full* state, nudging only the
  source's temperature will also turn a manually-off target back on.
- **Safe across different units.** Setpoints are clamped to the target's own supported
  range, and a mode the target cannot do is skipped.

One source can drive several targets — add one entry per target. Vane direction, room
temperature and humidity are **not** mirrored; those are readings, not settings.

Why this lives in the plugin rather than in a HomeKit automation or a generic mirror
plugin: see the header comment in `src/mirror.ts`.
