# Homebridge Mitsubishi Heat Pump

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

HomeKit control for Mitsubishi ductless heat pumps (MLZ / MSZ) through the Mitsubishi
Comfort v3 cloud API, with optional direct LAN control.

Each unit is a **HeaterCooler**: power, mode, setpoints and vane swing on one tile, with a
separate **Fixed Fan Speed** tile for the fan.

Not affiliated with, endorsed by, or associated with Mitsubishi Electric. **Use at your
own risk** — this drives real heating and cooling equipment, and the author assumes no
liability for damage or loss arising from it.

## Features

- **One tile per unit.** On/off, Heat / Cool / Auto, and the setpoint for the active
  mode. Auto shows a two-handle band.
- **Fan speed on its own tile.** Each unit has a **Fixed Fan Speed** fan tile: off is fan
  auto, on holds one of five speeds. A scene changes the fan only when it includes the tile.
- **Vane control** — swing on the main tile, where swing off means vane auto. Discrete
  tilt angles through an opt-in `Slats` service.
- **Fahrenheit-anchored setpoints.** Every setpoint is stored as the 0.5°C step nearest
  a whole °F, so the Home app shows back the degree you set.
- **Wireless sensor support.** Units with a paired sensor report its finer temperature
  and humidity, plus battery level with a low-battery warning.
- **Real-time streaming** over Socket.IO, with adaptive polling that starts only when
  streaming fails.
- **Device mirroring** (opt-in) — make one unit follow another.
- **Local LAN control** (opt-in) — currently blocked by a vendor change, see below.

## Installation

Requires **Node.js 20 or newer** and **Homebridge 1.6.0+, including 2.x**.

```bash
npm install -g homebridge-mitsubishi-heatpump
```

Pre-releases are published under the tag named in their version (`2.4.0-beta.1` is
`beta`) and are never the default install. `npm view homebridge-mitsubishi-heatpump
dist-tags` lists the tags that exist. To try a beta, and to go back:

```bash
npm install -g homebridge-mitsubishi-heatpump@beta
npm install -g homebridge-mitsubishi-heatpump@latest
```

From source:

```bash
git clone https://github.com/ukaratay/homebridge-mitsubishi-heatpump.git
cd homebridge-mitsubishi-heatpump
npm install && npm run build && npm link
```

Then add your credentials — see **[Configuration](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/docs/configuration.md)** for the
minimal config and every option.

## Upgrading from 2.x

Two changes affect scenes you already have, and each unit gets one new tile.

- **The fan moved to its own tile.** Each unit gets a fan accessory named
  `<unit> Fixed Fan Speed`, and the fan slider leaves the unit's own page. The new tiles
  appear in the bridge's room: move each one to its unit's room in the Home app.
  `fixedFanSpeed: false` removes them.
- **Scenes no longer set the fan.** Up to 2.3.1 every scene that contained a unit also
  stored its fan speed, which Home never showed. Those stored values are dropped on
  upgrade, so existing scenes and automations leave the fan as it is. To make a scene set
  the fan, add the unit's Fixed Fan Speed tile to it. See
  [Fan auto and scenes](#fan-auto-and-scenes).
- **The slider scale changed.** The five speeds sit at 20 / 40 / 60 / 80 / 100. 2.3.1 used
  0 / 25 / 50 / 75 / 100.
- **Oscillate off sets vane auto.** Turning swing off, by hand or from a scene, now sends
  vane auto. 2.3.1 sent the last fixed angle it had seen since Homebridge started, or auto
  if it had seen none. There is no option to keep that. If you never pin a vane angle, you
  will see no change. See [Vane and swing](#vane-and-swing).

## Migrating from homebridge-mitsubishi-comfort

This is a hard fork of
[homebridge-mitsubishi-comfort](https://github.com/burtherman/homebridge-mitsubishi-comfort)
at v1.8.2. It keeps the config `platform` key `KumoV3` and still derives accessory UUIDs
from the device serial, so **your existing `config.json` works unchanged and your
accessories keep their identity**.

| Thing | Survives? |
|---|---|
| `config.json` platform block | ✅ `platform` is still `KumoV3` |
| Child-bridge pairing | ✅ pairing lives at the bridge, `_bridge.username` untouched |
| Room assignment, names, Favorites | ✅ accessory UUID derives from `deviceSerial` |
| `mirror` config | ✅ keyed on device serial |
| **Automations, scenes, Shortcuts** | ❌ **these break** |

### What breaks

The primary service changed from `Thermostat` to `HeaterCooler`. HomeKit binds automations
to a *service and characteristic instance*, not to the accessory, so **every automation,
scene, trigger or Shortcut that referenced the old thermostat stops working and must be
rebuilt**. The accessory is still there under the same name in the same room; only the
controls beneath it are new. There is no way to migrate these automatically.

### Upgrade steps

1. **Stop Homebridge.** `sudo hb-service stop`
2. **Uninstall the old plugin from the command line**, not the Homebridge UI:
   ```bash
   sudo hb-service remove homebridge-mitsubishi-comfort
   ```
   > ⚠️ **Not via the Homebridge UI.** Its uninstall dialog defaults to "remove config",
   > which deletes the whole platform block *including* `_bridge.username`. Losing that
   > changes the child bridge's identity and forces you to re-pair every unit.
3. **Install this plugin.** `sudo hb-service add homebridge-mitsubishi-heatpump`
   > ⚠️ **Never have both installed at once.** Two plugins registering the `KumoV3`
   > platform makes Homebridge throw an ambiguous-platform error, which it swallows into a
   > misleading "Could not find the associated plugin" and drops your accessories.
4. **Start Homebridge.** `sudo hb-service start`
5. Rebuild your automations and scenes against the new tiles.

## Modes and switches

`HeaterCooler`'s target mode is only Heat / Cool / Auto — on/off is a separate `Active`
characteristic, and there is no state for dehumidify or fan-only. So:

- **On/off is independent of mode.** Turning a unit off does not change which mode it
  returns to: a plain "on" (the tile, Siri, the fan tile) brings it back in the heat, cool
  or auto it was last on in, and while it is off the mode control shows that mode. Dry and
  Fan-only are not remembered this way; they are turned on with their own switches.
- **Setpoints are the two thresholds.** The Home app shows the heating threshold in Heat,
  the cooling threshold in Cool, and both as a band in Auto. Modes the unit's profile says
  it cannot do are removed from the picker.
- **Auto on a multi-zone system.** Mitsubishi's operating manuals do not recommend Auto
  mode for an indoor unit on an MXZ multi-zone outdoor unit: with several units running,
  one may be unable to change between heating and cooling, and waits in standby instead.
- **What the unit is doing is reported honestly:** heating, cooling, or **idle** when the
  unit reports standby or is in fan-only.
- **Fan speed** is on the unit's **Fixed Fan Speed** tile, a separate fan accessory that is
  on by default. Off is fan auto. On holds the slider's speed, with five positions at
  20 / 40 / 60 / 80 / 100. A unit with fewer real speeds has fewer distinct airflows than
  positions: Mitsubishi lists four on the MLZ-KX ceiling cassettes and five on the MSZ-GX
  wall unit. See [Fan auto and scenes](#fan-auto-and-scenes).
- **Dry** and **Fan-only** are opt-in switches (`showDrySwitch`, `showFanOnlySwitch`),
  added only on units that support them, and mutually exclusive. Dry reports as Cool,
  because HomeKit has no Dry state. Mitsubishi's manuals for the units checked say the
  temperature cannot be set in Dry (the unit picks its own target from the room
  temperature at start), so the setpoint shown may have no effect there. Changing fan
  speed while heating or cooling needs no switch.
- **Indoor humidity** is a HumiditySensor, on by default. Turn it off if the Home app's
  collapsed tile shows humidity where you wanted temperature.
- **Filter indicator** appears when the unit reports its filter needs cleaning.

> **Note:** iOS caches an accessory's services. If a switch you just enabled, or the Auto
> range, doesn't appear in the Home app, restart your iPhone or iPad. Restarting the Home
> hub or force-quitting the Home app has not been enough.

### Fan auto and scenes

**A scene changes a unit's fan only if it includes that unit's Fixed Fan Speed tile.**

Each unit has a fan tile named `<unit> Fixed Fan Speed`:

- **Off is fan auto.** A heat pump's fan cannot be off while the unit runs, so off means
  the unit picks the speed.
- **On holds the speed on the slider.** Dragging the slider up turns it on at that speed.
  Dragging it to the bottom turns it off.
- **It reads off while the unit is off**, whatever the unit has stored. Off says nothing
  about the fan then.
- **It never turns the unit on.** Turning it on while the unit is off sends nothing and
  the tile goes back to off. The speed is applied only if the unit is turned on within a
  few seconds, which is what a scene that sets both does.
- **On a unit without an auto fan**, the tile is on whenever the unit runs, and turning it
  off is refused.

In a scene or automation:

| The scene contains | Result when it runs |
|---|---|
| Only the unit | The fan stays as it is |
| The fan tile, off | Fan auto |
| The fan tile, on at a speed | That speed |

The fan is a separate accessory because of how Apple Home builds scenes. Home stores every
value of a fan that shares an accessory with the unit in each scene containing that unit,
and its scene editor shows only temperature and mode. Up to 2.3.1, a scene saved while a
fan was at a fixed speed put it back at that speed every time it ran, and nothing in Home
showed it. On its own tile the fan is in a scene only when you add it, and the editor
shows its speed.

What this costs:

- **One more tile per unit.** Hide it from the Home view in its settings if you only want
  it in scenes.
- **Nothing in Home says Auto.** Read "Fixed Fan Speed: off" on a running unit as fan auto.
- **The slider does not show the real speed in auto.** The unit reports no speed in auto,
  so the slider keeps the last fixed speed, and turning the tile on goes back to it.
- **"Turn off the fans" sets fan auto** on every unit in range of the command, and "turn
  on the fans" holds each running unit at its last fixed speed. Neither changes a unit's
  power.

To opt out, set `fixedFanSpeed` to `false`. The tiles go, and HomeKit has no fan control:
the fan stays as the remote or the Mitsubishi app set it.

### Vane and swing

Swing on/off lives on the main tile via `SwingMode`. Apple Home does not render an
Oscillate toggle for a collapsed accessory's fan service, which is why swing is on the
climate service and not the fan.

**Oscillate off means vane auto.** On sends swing. Off sends the vane's **auto** position
(a fixed position the unit chooses by mode: horizontal in cool and dry, downward in heat,
per Mitsubishi's operating manuals), whatever the vane was doing, whether you tap it, ask
Siri, or a scene replays it. HomeKit has no other control that can carry vane auto.

What this costs:

- **Oscillate reads off for auto and for every fixed angle alike.**
- **An angle set with the remote or the Mitsubishi app does not survive a scene.** The next
  scene that includes the unit sets the vane to auto, or to the scene's own tilt angle
  when Slats is on.
- **A fixed angle from Home needs the opt-in Slats control** (`exposeVaneSlat`, below).
  When a request carries both, a tilt angle beats Oscillate off, and Oscillate on beats a
  tilt angle.
- **A unit with fixed angles but no swing has no Oscillate**, so Home cannot set its vane
  to auto.

Discrete tilt angles need `exposeVaneSlat`, which is **off by default**. Apple Home
categorises a HAP `Slats` service as a **window covering**: turned on, each unit's vane
joins the same Home app grouping as your real blinds and shades, and a room-level "close
the blinds" can reach your louvres. Observed on a house with Matter blinds paired directly
to HomeKit. Enable it only if you want fixed angles and have no window coverings in
HomeKit to collide with.

## Local LAN control

**`localControl` does not work at present, and not because of anything in this plugin.**

Authenticating to a unit's WiFi adapter needs two per-device secrets that only the vendor
cloud hands out: the adapter `password` (from the `adapter_update` socket event) and
`cryptoSerial` (from `GET /devices/{serial}/status`). Around **2026-07-31 the Comfort v3
API stopped serving both**, on unrelated accounts and on a second client stack
([pykumo #78](https://github.com/dlarrick/pykumo/issues/78), reproduced by its
maintainer). This plugin talks to v3, so it has no way to compute a local token.

There is reportedly one other source. The **legacy v2 login** — the older `geo-c` endpoint
that pykumo and Home Assistant use — still returned both fields over plain REST when
[upstream tested it on 2026-07-28](https://github.com/burtherman/homebridge-mitsubishi-comfort),
three days before the v3 change. Whether it still does is untested here, and upstream notes
its copy of the credentials can be stale enough that the adapter rejects them. This plugin
does not use it today.

You do not need to do anything. The plugin retries for about an hour, logs one warning,
and runs everything over the cloud. Nothing is written to your config, so if the fields
come back local control resumes on its own at the next restart. Leaving `localControl:
true` costs nothing; set it to `false` to silence the warning.

## Temperature display

HomeKit stores temperatures in Celsius and converts for display. The Home app **rounds**
that conversion while the Comfort app **truncates** it, so the same stored value can read
72°F in one and 71°F in the other.

**Setpoints: right in the Home app.** Since late October 2026 the Mitsubishi cloud accepts
setpoints only in 0.5°C steps and refuses anything else. Every setpoint you write is
snapped to the 0.5°C step nearest the whole °F you asked for, which the Home app always
shows as that degree. About half the degrees land just below their °F (72°F is stored as
22.0°C = 71.6°F), and the Comfort app, which truncates, shows those one degree low. No
0.5°C value reads correctly in both apps for those degrees.

**Current temperature: partly.** Indoor units report measured room temperature in 0.5°C
steps, a hardware limit, so the displayed value can still differ by ~1°F between apps. A
unit with a paired wireless sensor reports a much finer value and does not have this
problem.

Outdoor temperature is not available — the cloud API does not expose it, and the outdoor
unit's sensor is reachable only over a direct CN105 serial connection.

## Troubleshooting

### A unit shows "No Response"

The Mitsubishi cloud has reported that unit's Wi-Fi adapter as disconnected. The plugin
then shows No Response on all of the unit's tiles instead of its last known state, because
the cloud keeps serving that state from a frozen record and it may be hours old.

- **Commands are still sent.** A scene or tap that turns the unit off goes out anyway.
- **The report can be wrong.** While a unit is marked offline the plugin asks the cloud
  about it again about once a minute, and the tiles come back by themselves when the cloud
  reports it connected.
- **If it stays that way,** check the unit in the Comfort app. If it is offline there too,
  switch the indoor unit off and on at its breaker, and if that does not bring it back,
  redo the adapter's Wi-Fi setup in the Comfort app.

In the Homebridge log, look for `[REACHABILITY] <unit>: unreachable` and
`[REACHABILITY] <unit>: back online`, and for `reported offline (reason: ...)`.

### The fan changes when a scene runs

A scene changes a unit's fan only if it includes that unit's Fixed Fan Speed tile: on
holds the speed stored in the scene, off sets fan auto. Open the scene and check that
tile. See [Fan auto and scenes](#fan-auto-and-scenes).

In the log, `[FAN] <unit>: Fixed Fan Speed on -> "<speed>"` and
`[FAN] <unit>: Fixed Fan Speed off -> "auto"` are the fan setting each request resolved
to. A line saying the speed `is held for a turn-on` means the unit was off and nothing
was sent.

### A unit shows "0% Humidity"

That tile outlived the sensor it was reading: the unit's wireless sensor was moved or
unpaired. It is removed when the plugin next reads the unit's record from the cloud and
finds no sensor: at the next poll, or at the next Homebridge restart if you use
`disablePolling`. To hide humidity on every unit, set `showHumiditySensor` to `false`.

## Documentation

| | |
|---|---|
| [Configuration](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/docs/configuration.md) | Every option, validation rules, device mirroring |
| [Protocol](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/docs/protocol.md) | REST, Socket.IO, local LAN, HomeKit services |
| [Changelog](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/CHANGELOG.md) | |

**Matter:** not supported. Homebridge does not yet expose the FanControl features or
handlers a Matter build would need for vane and swing, and losing those is the whole
reason this plugin exists. HAP only until that changes.

## License

Apache License 2.0 — see [LICENSE](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/LICENSE).

Forked from
[burtherman/homebridge-mitsubishi-comfort](https://github.com/burtherman/homebridge-mitsubishi-comfort)
at v1.8.2. The upstream repository shipped no license file and declared MIT in
`package.json` while reproducing Apache-2.0 boilerplate in its README; Apache-2.0 is the
only choice valid under either reading. Attribution, the statement of changes required by
Apache-2.0 section 4(b), and third-party notices — including the pykumo port that upstream
did not attribute — are in [NOTICE](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/NOTICE).

Inspired by [homebridge-kumo](https://github.com/fjs21/homebridge-kumo).
