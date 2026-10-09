import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { KumoV3Platform } from './platform';
import { KumoAPI } from './kumo-api';
import {
  DeviceStatus, DeviceProfile, Zone, Commands, MirrorState, SensorReading,
  FanSpeed, FAN_SPEEDS, VaneDirection, isVaneDirection, normalizeFanSpeed,
} from './settings';
import { cToF, quantizeSetpointInRange, sameSetpoint } from './temperature';

/**
 * Fan speed <-> HomeKit RotationSpeed, on the Fanv2 service.
 *
 * The slider carries ONLY the five real airflow levels, evenly spaced across the
 * whole range at 25% intervals: 0/25/50/75/100 map to FAN_SPEEDS[1..5]
 * (superQuiet..superPowerful). Every position is a distinct speed — no value is
 * duplicated and none is dead. `auto` is deliberately NOT on the slider.
 *
 * An earlier version put `auto` at 0 on the HeaterCooler's own RotationSpeed and
 * it was wrong twice over: RotationSpeed is a percentage, and 0 reads as "off"
 * everywhere else in HomeKit; and `auto` is not a point on the airflow ladder at
 * all — in auto the unit may be blowing at full power while a 0 slider claims it
 * is at its slowest. Auto is an orthogonal mode, so it belongs on the
 * characteristic HAP provides for exactly that, TargetFanState — which exists on
 * Fanv2 and not on HeaterCooler. That is the reason the fan moved services.
 *
 * 0 is the quietest speed, not "off". Power lives on the climate tile's Active,
 * and routing an off through the fan would put the heat pump back within reach of
 * a scene or voice command aimed at "the fan" (see setFanActive). Note the
 * trade-off this accepts: a fan reporting 0% can lead some controllers to send
 * 100% on activation, so watch for a unit coming on at full blast.
 *
 * All five speeds are offered on every unit regardless of `numberOfFanSpeeds`,
 * which is advisory — a unit reporting 3 accepted all five on live hardware.
 */
const FAN_PCT_STEP = 25;

/**
 * Vane position <-> HomeKit tilt angle, for the optional Slats service.
 * `horizontal` (blade flattest, air thrown furthest) is -90 and `vertical`
 * (blade pointing down) is +90, matching HAP's tilt convention. `auto` and
 * `swing` are not fixed angles and are therefore absent — they are expressed
 * through SwingMode and CurrentSlatState instead.
 */
const VANE_TILT: ReadonlyArray<{ vane: VaneDirection; angle: number }> = [
  { vane: 'horizontal', angle: -90 },
  { vane: 'midhorizontal', angle: -45 },
  { vane: 'midpoint', angle: 0 },
  { vane: 'midvertical', angle: 45 },
  { vane: 'vertical', angle: 90 },
];
const TILT_STEP = 45;

export class KumoThermostatAccessory {
  private service: Service;

  private deviceSerial: string;
  private siteId: string;
  private currentStatus: DeviceStatus | null = null;
  private hasHumiditySensor: boolean = false;
  private lastUpdateTimestamp: number = 0;
  private lastUpdateSource: 'streaming' | 'polling' | 'local' | 'none' = 'none';
  private lastLocalUpdateTs: number = 0;
  // While a local poll has arrived within this window, local is the authoritative
  // status source and cloud updates are dropped (the cloud lags ~7-10s and would
  // otherwise clobber fresher local data). Should exceed the local poll interval.
  private readonly LOCAL_AUTHORITATIVE_MS = 45000;
  // Cloud-reported adapter reachability from `device_status_v2`. null = nothing
  // reported yet (treated as reachable). See setCloudConnected.
  private cloudConnected: boolean | null = null;

  // ---- Paired wireless sensor (cloud `sensor_update`) ---------------------
  // The unit quantizes its own roomTemp to 0.5°C before reporting it; the paired
  // wireless sensor reports ~6 decimals (22.30543 against the unit's 22.5), and
  // on three of the four units here the unit REGULATES from that sensor
  // (tempSource 'sensor0'), so the sensor is the real thermostat. The finer value
  // also removes a display ambiguity: 22.5°C is exactly 72.5°F, the one 0.5°C step
  // where a rounding renderer shows 73°F and a truncating one shows 72°F.
  //
  // PRECEDENCE. A cloud poll or streaming event carries the coarse roomTemp and
  // would otherwise clobber the fine value seconds after it arrives. This is
  // resolved the same way as LOCAL_AUTHORITATIVE_MS above, and deliberately not by
  // last-writer-wins: while a sensor reading is fresher than SENSOR_AUTHORITATIVE_MS,
  // the sensor is the authoritative temperature/humidity source and every update
  // path (streaming, cloud poll, local poll) has its coarse value SUBSTITUTED in
  // processZoneUpdate before it reaches either the cache or HomeKit. The rest of
  // the update applies untouched. That makes the outcome independent of arrival
  // order rather than racing it, and it fails safe: once the sensor stops
  // reporting the window lapses and the unit's own roomTemp takes over again.
  private sensorTemp: number | null = null;
  private sensorHumidity: number | null = null;
  private sensorReadingTs: number = 0;
  // Bounds how long a stale sensor value can hold the display. The cadence of
  // `sensor_update` has not been measured, so this is chosen rather than derived:
  // long enough to sit well clear of the 30s cloud poll it is protecting against,
  // short enough that a sensor that has gone quiet cannot pin CurrentTemperature
  // for long. If the sensor reports less often than this, the reading simply
  // decays to the unit's coarse roomTemp between reports — coarser, never wrong.
  private readonly SENSOR_AUTHORITATIVE_MS = 300000;
  private batteryService: Service | null = null;
  // Below this percent the sensor is reported as low. HAP has no threshold of its
  // own; 20% is the convention Homebridge accessories use.
  private readonly LOW_BATTERY_PCT = 20;

  private deviceProfile: DeviceProfile | null = null;
  private filterMaintenanceService: Service | null = null;
  private fanOnlyService: Service | null = null;
  private dryService: Service | null = null;
  private slatsService: Service | null = null;
  private humidityService: Service | null = null;
  private modelNumberSet: boolean = false;
  // SwingMode is a toggle, but the device stores one vane field. Turning swing
  // off has to restore *something*, so remember the last fixed position the unit
  // was actually seen in and go back to that ('auto' until we've seen one).
  private lastFixedVane: VaneDirection = 'auto';
  // SwingMode is only registered on units whose profile reports vane swing, so
  // track that rather than probing the service for the characteristic.
  private swingModeRegistered = false;
  private fanService: Service | null = null;
  // TargetFanState is a toggle, but the device stores one fan field whose values
  // include 'auto'. Switching back to MANUAL has to pick a speed, so remember the
  // last real one the unit was seen at. Mirrors lastFixedVane.
  private lastManualFan: FanSpeed = 'quiet';
  // Fan writes arriving in one HAP request are coalesced; see queueFanIntent.
  private pendingFan: { auto?: boolean; speed?: FanSpeed } | null = null;
  private fanFlushTimer: NodeJS.Timeout | null = null;
  private targetFanStateRegistered = false;
  // Timestamp (ms) of the most recent HomeKit "off" request. Within
  // OFF_SUPPRESS_WINDOW_MS of it, setpoint writes are suppressed (cached + echoed
  // but not sent). An "AC off" scene captures each thermostat's full state and
  // re-pushes its setpoints (TargetTemperature, and for an AUTO unit the two
  // threshold handles) alongside OFF; HomeKit dispatches them concurrently in an
  // arbitrary order. A setpoint landing after the off reaches the LAN adapter as
  // a bare, mode-less write (local commands carry no power field — see
  // local-api.ts) and powers the unit back on. The unit is being turned off —
  // there is nothing to set. Set synchronously before the off command's await so
  // sibling handlers in the same burst observe it; any active mode clears it.
  private offRequestedAt = 0;
  private readonly OFF_SUPPRESS_WINDOW_MS = 4000;

  // The off-suppression window above only catches setpoints dispatched *after*
  // the off. A scene's captured setpoint that lands just *before* it arrives
  // while the unit is still on, so it sends — and permanently rewrites the
  // stored setpoint. Observed live 2026-07-26: an "AC off" scene rewrote the
  // Living room's spCool to its stale captured 25°C, leaving a mirror target
  // 2.5°C off its source (mirroring is edge-triggered, so nothing corrected it
  // until the source next changed). Holding each setpoint write briefly closes
  // the gap in the other direction: an off landing during the hold cancels the
  // pending send. Keyed per setpoint so the two AUTO handles don't cancel each
  // other, with a generation counter so a drag only sends its final value.
  private readonly setpointWriteGen: Map<string, number> = new Map();
  private readonly SETPOINT_HOLD_MS = 1500;

  // A scene that turns on a unit that is OFF and picks its mode pushes Active=ON
  // and the mode (TargetHeaterCoolerState, or a Dry / Fan-only switch) together,
  // in either order. The mode write powers the unit on by itself; an ON sent
  // beside it carries the default or remembered mode and races it through the
  // cloud, so whichever lands last wins. setActive therefore holds an ON for an
  // off unit for ACTIVE_ON_HOLD_MS and drops it if a mode write was dispatched
  // within that span on either side of it. activeWriteGen lets a newer Active
  // write (an off right behind the on) cancel a held ON. The hold matches
  // SETPOINT_HOLD_MS, which covers the same scene-burst spread; cloud commands
  // take seconds to land anyway, so it is not felt.
  private modeWriteAt = 0;
  private activeWriteGen = 0;
  private readonly ACTIVE_ON_HOLD_MS = 1500;

  // How long after an accepted setpoint write to re-read the unit and publish what
  // it actually stored. Long enough for the adapter to apply the write and answer
  // a fresh read; short enough that the tile settles while the user is still there.
  private readonly SETPOINT_RECONCILE_MS = 2000;

  // Listeners notified whenever this accessory's state actually changes. The
  // MirrorController subscribes to a *source* accessory here so it can push the
  // change to its target(s). Fired from processZoneUpdate (catches wall
  // thermostat / Kumo app / any observed change) and from the setters (catches a
  // HomeKit change to this unit without waiting for the streaming/local echo).
  private statusListeners: Array<(status: DeviceStatus) => void> = [];

  constructor(
    private readonly platform: KumoV3Platform,
    private readonly accessory: PlatformAccessory,
    private readonly kumoAPI: KumoAPI,
    // Unused: polling is site-level on the platform (platform.ts:startSitePoller),
    // and nothing per-accessory has a timer of its own. Kept because platform.ts
    // still passes it at both construction sites; removing it is a signature
    // change across that file and every test harness.
    _pollIntervalSeconds?: number,
  ) {
    this.deviceSerial = this.accessory.context.device.deviceSerial;
    this.siteId = this.accessory.context.device.siteId;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Mitsubishi')
      .setCharacteristic(this.platform.Characteristic.Model, 'Kumo Cloud Heat Pump')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceSerial);

    // A ductless mini-split is a HeaterCooler, not a Thermostat. HeaterCooler
    // models what this hardware actually is: an on/off `Active` state separate
    // from the heat/cool/auto mode, a fan speed, and a swing control — none of
    // which the Thermostat service can express. Accessories cached by earlier
    // versions carry a Thermostat service; remove it, or the unit shows two
    // competing climate tiles and the Home app cannot decide which is primary.
    const staleThermostat = this.accessory.getService(this.platform.Service.Thermostat);
    if (staleThermostat) {
      this.accessory.removeService(staleThermostat);
      this.platform.log.info(
        `${accessory.context.device.displayName}: migrated Thermostat -> HeaterCooler. ` +
        'Automations that referenced the old thermostat controls must be recreated.',
      );
    }

    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.displayName,
    );

    // --- required ---
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentHeaterCoolerState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onGet(this.getTargetHeaterCoolerState.bind(this))
      .onSet(this.setTargetHeaterCoolerState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    // --- setpoints ---
    // On HeaterCooler these two ARE the setpoint controls in every mode, not just
    // AUTO: the Home app shows the heating threshold in HEAT, the cooling
    // threshold in COOL, and both as a range in AUTO. There is no single
    // TargetTemperature characteristic to also write the same device field, which
    // structurally removes the band-collapse bug that upstream PR #23 patched
    // around — the second writer simply does not exist any more.
    //
    // minStep stays 0.1 because the grid is Fahrenheit-anchored, not Celsius:
    // every write is snapped to the exact Celsius of a whole °F by
    // quantizeSetpointInRange (see src/temperature.ts). A 0.5°C step would force
    // 72°F to 22.5°C, which reads back as 72.5°F and shows as 73°F in the
    // Mitsubishi app. Note HAP applies minStep only on the outbound path, so the
    // quantizer — not this prop — is what actually holds the grid.
    const wideThresholdProps = { minValue: 10, maxValue: 35, minStep: 0.1 };
    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps(wideThresholdProps)
      .onGet(this.getHeatingThresholdTemperature.bind(this))
      .onSet(this.setHeatingThresholdTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps(wideThresholdProps)
      .onGet(this.getCoolingThresholdTemperature.bind(this))
      .onSet(this.setCoolingThresholdTemperature.bind(this));

    // --- fan ---
    // Fan speed and swing live on a Fanv2 service, not here. See setupFanService.
    // An accessory cached by an earlier version carries RotationSpeed (and maybe
    // SwingMode) on the HeaterCooler; strip them so the unit does not end up with
    // two competing fan controls.
    this.removeStaleCharacteristic(this.service, this.platform.Characteristic.RotationSpeed);
    this.setupFanService();

    // --- display units ---
    // Upstream never handled this and left it hardwired to Celsius, which is
    // wrong for every non-Apple HomeKit controller (the Home app ignores it and
    // follows the phone's locale, but Eve and others honour it). It is a display
    // preference only — it changes no stored value — so it lives in accessory
    // context and survives restarts.
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    // Note: Polling is now handled at the platform level (centralized site polling)
    // This accessory will receive updates via updateFromZone()

    // If this accessory was cached with a fan-only switch from a previous run,
    // wire up its handlers immediately. applyDeviceProfile() will remove it if
    // the device profile later reports hasModeVent === false.
    const cachedFanSwitch = this.accessory.getServiceById(
      this.platform.Service.Switch,
      'fan-only',
    );
    if (cachedFanSwitch) {
      this.fanOnlyService = cachedFanSwitch;
      this.fanOnlyService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getFanOnlyOn.bind(this))
        .onSet(this.setFanOnlyOn.bind(this));
    }

    // Same for a cached dry switch (see setupDrySwitch / hasModeDry).
    const cachedDrySwitch = this.accessory.getServiceById(
      this.platform.Service.Switch,
      'dry',
    );
    if (cachedDrySwitch) {
      this.dryService = cachedDrySwitch;
      this.dryService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getDryOn.bind(this))
        .onSet(this.setDryOn.bind(this));
    }

    // Cached Slats and Humidity services need their handlers re-bound now too.
    // Both are normally created from an async event (the device profile / the
    // first humidity reading); without this, a restart leaves the cached service
    // present in HomeKit but answering reads with HAP defaults until that event
    // arrives. setupSlatsService/setupHumidityService both adopt an existing
    // service, so this is just wiring them earlier.
    if (this.accessory.getService(this.platform.Service.Slats)) {
      this.setupSlatsService();
    }
    const cachedHumidity = this.accessory.getService(this.platform.Service.HumiditySensor);
    if (cachedHumidity) {
      if (this.platform.kumoConfig.showHumiditySensor === false) {
        // Opted out since the last run — drop the cached service so the tile stops
        // being dominated by the humidity reading.
        this.accessory.removeService(cachedHumidity);
      } else {
        this.hasHumiditySensor = true;
        this.setupHumidityService();
      }
    }

    // Register for streaming updates
    this.kumoAPI.subscribeToDevice(this.deviceSerial, this.handleStreamingUpdate.bind(this));
    this.platform.log.debug(`Registered streaming callback for ${this.deviceSerial}`);

    // Register for profile updates (setpoint limits)
    this.kumoAPI.onDeviceProfileUpdate((serial, profile) => {
      if (serial === this.deviceSerial) {
        this.applyDeviceProfile(profile);
      }
    });

    // Register for paired-wireless-sensor readings. `sensor_update` is broadcast
    // for every sensor on the account, so filter on deviceSerial exactly as the
    // profile subscription above does. An event without a deviceSerial matches
    // nothing and is therefore ignored rather than crashing the handler.
    //
    // Guarded on the method existing for the same reason linkSecondaryService is:
    // this runs during construction, where a throw takes out the whole accessory,
    // and a KumoAPI built before sensor_update existed does not carry it.
    if (typeof this.kumoAPI.onSensorUpdate === 'function') {
      this.kumoAPI.onSensorUpdate((reading: SensorReading) => {
        if (reading && reading.deviceSerial === this.deviceSerial) {
          this.handleSensorUpdate(reading);
        }
      });
    }

  }

  /**
   * Apply one paired-wireless-sensor reading.
   *
   * Telemetry ONLY. It never touches power, operationMode or the setpoints, and it
   * deliberately does not fire the status listeners: the mirror is driven by
   * *commanded* state (see mirror.ts's signature), and a room warming up by a
   * tenth of a degree is not a command. Feeding it there would push the source
   * unit's full state onto every mirror target every time the sensor breathed.
   */
  private handleSensorUpdate(reading: SensorReading): void {
    const temperature = reading.temperature;
    const humidity = reading.humidity;
    const battery = reading.battery;

    if (typeof temperature === 'number' && !isNaN(temperature)) {
      this.sensorTemp = temperature;
      this.sensorReadingTs = Date.now();
      if (this.currentStatus) {
        this.currentStatus.roomTemp = temperature;
      }
      // Cached either way; published only while reachable, so a sensor reading
      // does not paint over No Response (recovery republishes it).
      if (this.isReachable()) {
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentTemperature,
          temperature,
        );
      }
      this.platform.log.debug(
        `[SENSOR] ${this.accessory.displayName}: ${temperature}°C ` +
        `(${cToF(temperature).toFixed(2)}°F) from the paired wireless sensor`,
      );
    }

    if (typeof humidity === 'number' && !isNaN(humidity)) {
      this.sensorHumidity = humidity;
      this.sensorReadingTs = Date.now();
      if (this.currentStatus) {
        this.currentStatus.humidity = humidity;
      }
      // Same latch and config gate the poll path uses: opting out of the humidity
      // service must not be undone by the sensor arriving from a different event.
      if (this.platform.kumoConfig.showHumiditySensor !== false) {
        if (!this.hasHumiditySensor) {
          this.hasHumiditySensor = true;
          this.setupHumidityService();
        }
        if (this.isReachable()) {
          this.humidityService?.updateCharacteristic(
            this.platform.Characteristic.CurrentRelativeHumidity,
            humidity,
          );
        }
      }
    }

    if (typeof battery === 'number' && !isNaN(battery)) {
      if (this.currentStatus) {
        this.currentStatus.sensorBattery = battery;
      }
      this.updateSensorBattery(battery);
    }
  }

  /** True while the paired sensor is the authoritative temperature/humidity source. */
  private sensorReadingFresh(): boolean {
    return this.sensorReadingTs > 0 &&
      (Date.now() - this.sensorReadingTs) < this.SENSOR_AUTHORITATIVE_MS;
  }

  /**
   * The paired sensor's battery, as its own Battery service.
   *
   * Created lazily on the first reading that actually carries a battery value, so
   * a unit with no paired sensor (the Garage) never grows the service. Follows the
   * lazy-create pattern of setupHumidityService: adopt a cached service if there
   * is one, publish the structure change only when the service is genuinely new.
   *
   * WHY THIS IS WORTH A SERVICE: three of the four units regulate FROM the
   * wireless sensor, so a dead sensor battery silently moves the control point
   * from the wall back to the unit at the ceiling — the unit keeps working, just
   * against a temperature several degrees off the one the room is at. Nothing else
   * surfaces that.
   *
   * Note the accessory itself is mains powered; this battery belongs to the
   * sensor, not the heat pump. HomeKit has no way to say that, so Apple Home will
   * label the low-battery warning with the ACCESSORY's name ("Bedroom has a low
   * battery"), which is why the service is named for the sensor.
   */
  private updateSensorBattery(percent: number): void {
    const C = this.platform.Characteristic;
    // BatteryLevel is a uint8 percentage. The value comes off the cloud, so clamp
    // and round it here rather than handing HAP something it will reject.
    const level = Math.max(0, Math.min(100, Math.round(percent)));

    if (!this.batteryService) {
      const existing = this.accessory.getService(this.platform.Service.Battery);
      const name = `${this.accessory.context.device.displayName} Sensor Battery`;
      this.batteryService =
        existing || this.accessory.addService(this.platform.Service.Battery, name);
      this.batteryService.setCharacteristic(C.Name, name);
      // Verified against hap-nodejs ServiceDefinitions: Battery requires
      // StatusLowBattery and optionally allows BatteryLevel, ChargingState and
      // Name. Nothing else goes on it — an out-of-set characteristic makes
      // Homebridge log a warning on every start, which is exactly what
      // ConfiguredName on Fanv2 did.
      this.batteryService.setCharacteristic(C.ChargingState, C.ChargingState.NOT_CHARGEABLE);
      this.linkSecondaryService(this.batteryService);
      if (!existing) {
        this.publishStructureChange();
      }
      this.platform.log.debug(`Added sensor Battery service for ${this.accessory.displayName}`);
    }

    this.batteryService.updateCharacteristic(C.BatteryLevel, level);
    this.batteryService.updateCharacteristic(
      C.StatusLowBattery,
      level < this.LOW_BATTERY_PCT
        ? C.StatusLowBattery.BATTERY_LEVEL_LOW
        : C.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  }

  private applyDeviceProfile(profile: DeviceProfile): void {
    this.deviceProfile = profile;

    // Each threshold gets the range of the mode it actually drives, rather than
    // the union across all three modes. Upstream applied one min/max collapsed
    // with Math.min/Math.max to every setpoint characteristic, so in COOL the
    // Home app would happily offer a value from the HEAT range and the unit
    // answered with an invalidSpCoolRange 400. On HeaterCooler each threshold IS
    // the setpoint for its own mode, so the correct bound is per-characteristic.
    // In AUTO both handles are live, so widen each to cover the auto range too.
    //
    // These bounds are NOT ours to widen, and the recurring "why can't I set 55°F"
    // question has no answer in this code. They are installer settings stored in the
    // unit (MHK2 Function Code 181, or an installer's service tool), reported to us
    // read-only via profile_update. The cloud enforces them independently: a write
    // outside the range comes back 400 with `{"commands":["invalidSpHeatRange"]}`.
    // There is no cloud endpoint that changes them — /devices/{serial}/profile is
    // read-only and rejects PUT/PATCH/POST, and no installer-level auth exists on the
    // v3 API (verified 2025-12-25 against /installer/login, /admin/login,
    // /technician/login, /devices/{serial}/settings and a role/userType/installerPin
    // login variant sweep; all 404 or ignored). Clamping to the profile is the whole
    // of what a client can do.
    const heatMin = Math.min(profile.minimumSetPoints.heat, profile.minimumSetPoints.auto);
    const heatMax = Math.max(profile.maximumSetPoints.heat, profile.maximumSetPoints.auto);
    const coolMin = Math.min(profile.minimumSetPoints.cool, profile.minimumSetPoints.auto);
    const coolMax = Math.max(profile.maximumSetPoints.cool, profile.maximumSetPoints.auto);

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: heatMin, maxValue: heatMax, minStep: 0.1 });
    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: coolMin, maxValue: coolMax, minStep: 0.1 });

    this.platform.log.info(
      `${this.accessory.displayName}: setpoint range heat ${heatMin}-${heatMax}°C ` +
      `(${cToF(heatMin).toFixed(0)}-${cToF(heatMax).toFixed(0)}°F), ` +
      `cool ${coolMin}-${coolMax}°C (${cToF(coolMin).toFixed(0)}-${cToF(coolMax).toFixed(0)}°F)`,
    );

    // Restrict the mode picker to what the unit can actually do. A cooling-only
    // unit offering HEAT in the Home app just produces a command it rejects.
    const T = this.platform.Characteristic.TargetHeaterCoolerState;
    const modes: number[] = [T.COOL];
    if (profile.hasModeHeat) {
      modes.unshift(T.HEAT);
      // AUTO needs both directions to mean anything.
      modes.unshift(T.AUTO);
    }
    this.service.getCharacteristic(T).setProps({ validValues: modes });

    // Swing lives on the main tile when the unit supports it.
    if (profile.hasFanSpeedAuto && !this.targetFanStateRegistered && this.fanService) {
      this.fanService.getCharacteristic(this.platform.Characteristic.TargetFanState)
        .onGet(this.getTargetFanState.bind(this))
        .onSet(this.setTargetFanState.bind(this));
      this.targetFanStateRegistered = true;
      // Arrives from the async profile event, so it needs a re-publish to reach
      // HomeKit — same as the switches and Slats.
      this.publishStructureChange();
    }

    if (profile.hasVaneSwing && !this.swingModeRegistered) {
      const C = this.platform.Characteristic;
      // SwingMode stays on the HeaterCooler, NOT the fan service, and this is not
      // a stylistic choice. Apple Home collapses an accessory's services into one
      // tile by default, and in that collapsed state it renders the fan's speed
      // but NOT its Oscillate toggle (first-hand:
      // cbrandlehner/homebridge-daikin-local#346, corroborated by
      // mp-consulting/homebridge-daikin-cloud). Swing on the fan service is
      // therefore invisible unless the user has opted into "Show as Separate
      // Tiles" — and with the Slats service off by default, that would leave vane
      // control unreachable in the Home app on a default install.
      // Home Assistant's own HeaterCooler migration (core#148231) moves only
      // RotationSpeed and keeps swing on the climate service for the same reason.
      this.service.getCharacteristic(C.SwingMode)
        .onGet(this.getSwingMode.bind(this))
        .onSet(this.setSwingMode.bind(this));
      this.swingModeRegistered = true;
      // Strip a SwingMode left on the fan service by the version that moved it.
      if (this.fanService) {
        this.removeStaleCharacteristic(this.fanService, C.SwingMode);
      }
      // The profile arrives via an async streaming event, after this accessory has
      // already been published. Adding a characteristic now is invisible to HomeKit
      // (and never persisted to the cache) unless the accessory is re-published —
      // same reason setupFanOnlySwitch/setupDrySwitch call this.
      this.publishStructureChange();
    }

    // Discrete vane positions, opt-IN via config (default off). Apple Home files
    // Slats under window coverings, so on by default it pollutes the blinds
    // grouping of any home that has real shades. See KumoConfig.exposeVaneSlat.
    const wantSlats = this.platform.kumoConfig.exposeVaneSlat === true;
    if (profile.hasVaneDir && wantSlats) {
      this.setupSlatsService();
    } else {
      this.removeSlatsService();
    }

    // Add / remove the fan-only switch based on device capability AND config.
    // Fan speed now lives on the HeaterCooler tile, so this switch is only for
    // fan-ONLY mode (no heating or cooling) and is off by default.
    if (profile.hasModeVent && this.platform.kumoConfig.showFanOnlySwitch === true) {
      this.setupFanOnlySwitch();
    } else {
      this.removeFanOnlySwitch();
    }

    // Add / remove the dry switch based on device capability AND config.
    // HeaterCooler has no dehumidify mode either, so dry stays a Switch — but
    // it is opt-in now rather than automatic.
    if (profile.hasModeDry && this.platform.kumoConfig.showDrySwitch === true) {
      this.setupDrySwitch();
    } else {
      this.removeDrySwitch();
    }
  }

  /**
   * Re-publish this accessory to the bridge. REQUIRED after adding or removing a
   * service or characteristic at runtime: the accessory was already published to
   * HomeKit during discovery, so structural changes that happen later (a
   * capability switch, the humidity characteristic, the filter service) never
   * reach the Home app — or get persisted to the cache — without this call.
   */
  private publishStructureChange(): void {
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  private setupFanOnlySwitch(): void {
    if (this.fanOnlyService) {
      return;
    }

    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'fan-only');
    const displayName = this.accessory.context.device.displayName;
    const switchName = `${displayName} Fan`;

    this.fanOnlyService =
      existing ||
      this.accessory.addService(this.platform.Service.Switch, switchName, 'fan-only');

    this.fanOnlyService.setCharacteristic(this.platform.Characteristic.Name, switchName);
    this.fanOnlyService.setCharacteristic(this.platform.Characteristic.ConfiguredName, switchName);

    this.fanOnlyService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getFanOnlyOn.bind(this))
      .onSet(this.setFanOnlyOn.bind(this));

    // Reflect current state immediately if we already have a status
    this.fanOnlyService.updateCharacteristic(
      this.platform.Characteristic.On,
      this.isFanOnlyActive(this.currentStatus),
    );

    // The profile arrives via an async streaming event, after the accessory
    // has already been published to the bridge. A service added now is invisible
    // to HomeKit (and not persisted) unless we re-publish the accessory.
    if (!existing) {
      this.publishStructureChange();
    }

    this.platform.log.debug(`Added Fan-Only switch for ${this.accessory.displayName}`);
  }

  private removeFanOnlySwitch(): void {
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'fan-only');
    if (existing) {
      this.accessory.removeService(existing);
      this.publishStructureChange();
      this.platform.log.debug(
        `Removed Fan-Only switch for ${this.accessory.displayName} (device reports no vent mode support)`,
      );
    }
    this.fanOnlyService = null;
  }

  private isFanOnlyActive(status: DeviceStatus | null): boolean {
    if (!status) {
      return false;
    }
    return status.power === 1 && status.operationMode === 'vent';
  }

  async getFanOnlyOn(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.isFanOnlyActive(this.currentStatus);
  }

  async setFanOnlyOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    const operationMode: 'vent' | 'off' = on ? 'vent' : 'off';
    const power: 0 | 1 = on ? 1 : 0;

    this.platform.log.info(
      `[FAN ONLY] ${this.accessory.displayName}: HomeKit sent ${on ? 'ON' : 'OFF'}`,
    );

    // Same guard as setTargetHeaterCoolerState, and checked before noteModeIntent
    // for the same reason: an ON trailing an off in one scene burst revives the
    // unit, and noteModeIntent would clear the window for everything behind it.
    if (on && this.offInFlight()) {
      this.platform.log.debug(`[FAN ONLY] ${this.accessory.displayName}: an off is in flight — not sending vent`);
      this.revertSoon();
      return;
    }

    this.noteModeIntent(operationMode);
    if (on) {
      this.modeWriteAt = Date.now();
    }

    const success = await this.sendDeviceCommand({ operationMode, power });

    if (!success) {
      this.platform.log.error(
        `[FAN ONLY] ${this.accessory.displayName}: Failed to set fan-only ${on ? 'ON' : 'OFF'}`,
      );
      this.revertSoon();
      return;
    }

    this.platform.log.info(`[FAN ONLY] ${this.accessory.displayName}: Command accepted by API`);

    // Optimistic local-state update so the thermostat tile reflects the change
    // immediately, and so the Target state matches what the next poll will report —
    // vent now maps to COOL, not OFF (same rationale as dry above).
    if (this.currentStatus) {
      this.currentStatus.operationMode = operationMode;
      this.currentStatus.power = on ? 1 : 0;
      this.refreshClimateCharacteristics();
    }

    // Mirror a HomeKit-driven fan-only toggle to any followers immediately.
    this.notifyStatusListeners();
  }

  private setupDrySwitch(): void {
    if (this.dryService) {
      return;
    }

    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'dry');
    const displayName = this.accessory.context.device.displayName;
    const switchName = `${displayName} Dry`;

    this.dryService =
      existing ||
      this.accessory.addService(this.platform.Service.Switch, switchName, 'dry');

    this.dryService.setCharacteristic(this.platform.Characteristic.Name, switchName);
    this.dryService.setCharacteristic(this.platform.Characteristic.ConfiguredName, switchName);

    this.dryService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getDryOn.bind(this))
      .onSet(this.setDryOn.bind(this));

    // Reflect current state immediately if we already have a status
    this.dryService.updateCharacteristic(
      this.platform.Characteristic.On,
      this.isDryActive(this.currentStatus),
    );

    // The profile arrives via an async streaming event, after the accessory
    // has already been published to the bridge. A service added now is invisible
    // to HomeKit (and not persisted) unless we re-publish the accessory.
    if (!existing) {
      this.publishStructureChange();
    }

    this.platform.log.debug(`Added Dry switch for ${this.accessory.displayName}`);
  }

  private removeDrySwitch(): void {
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'dry');
    if (existing) {
      this.accessory.removeService(existing);
      this.publishStructureChange();
      this.platform.log.debug(
        `Removed Dry switch for ${this.accessory.displayName} (device reports no dry mode support)`,
      );
    }
    this.dryService = null;
  }

  private isDryActive(status: DeviceStatus | null): boolean {
    if (!status) {
      return false;
    }
    return status.power === 1 && status.operationMode === 'dry';
  }

  async getDryOn(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.isDryActive(this.currentStatus);
  }

  async setDryOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    const operationMode: 'dry' | 'off' = on ? 'dry' : 'off';
    const power: 0 | 1 = on ? 1 : 0;

    this.platform.log.info(
      `[DRY] ${this.accessory.displayName}: HomeKit sent ${on ? 'ON' : 'OFF'}`,
    );

    // Same guard as setTargetHeaterCoolerState, and checked before noteModeIntent
    // for the same reason: an ON trailing an off in one scene burst revives the
    // unit, and noteModeIntent would clear the window for everything behind it.
    if (on && this.offInFlight()) {
      this.platform.log.debug(`[DRY] ${this.accessory.displayName}: an off is in flight — not sending dry`);
      this.revertSoon();
      return;
    }

    this.noteModeIntent(operationMode);
    if (on) {
      this.modeWriteAt = Date.now();
    }

    const success = await this.sendDeviceCommand({ operationMode, power });

    if (!success) {
      this.platform.log.error(
        `[DRY] ${this.accessory.displayName}: Failed to set dry ${on ? 'ON' : 'OFF'}`,
      );
      this.revertSoon();
      return;
    }

    this.platform.log.info(`[DRY] ${this.accessory.displayName}: Command accepted by API`);

    // Optimistic local-state update so the thermostat tile reflects the change
    // immediately, and (critically) so the Target state matches what the next poll
    // will report — dry now maps to COOL, not OFF. Leaving Target at OFF here would
    // let an off-automation firing before the next poll be suppressed again.
    if (this.currentStatus) {
      this.currentStatus.operationMode = operationMode;
      this.currentStatus.power = on ? 1 : 0;
      this.refreshClimateCharacteristics();
    }

    // Mirror a HomeKit-driven dry toggle to any followers immediately.
    this.notifyStatusListeners();
  }

  private updateFilterMaintenance(filterDirty: boolean): void {
    if (!this.filterMaintenanceService) {
      const existing = this.accessory.getService(this.platform.Service.FilterMaintenance);
      this.filterMaintenanceService =
        existing || this.accessory.addService(this.platform.Service.FilterMaintenance);
      this.linkSecondaryService(this.filterMaintenanceService);
      if (!existing) {
        this.publishStructureChange();
        this.platform.log.debug(`Added FilterMaintenance service for ${this.accessory.displayName}`);
      }
    }

    this.filterMaintenanceService.updateCharacteristic(
      this.platform.Characteristic.FilterChangeIndication,
      filterDirty
        ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
        : this.platform.Characteristic.FilterChangeIndication.FILTER_OK,
    );
  }

  // Handle streaming updates
  private handleStreamingUpdate(deviceSerial: string, data: Partial<DeviceStatus>) {
    // Validate that we have essential data before processing
    if (data.roomTemp === undefined || data.roomTemp === null) {
      this.platform.log.debug(`Streaming update for ${deviceSerial} missing essential data, skipping`);
      return;
    }

    const updateTimestamp = Date.now();

    this.platform.log.debug(`Streaming update received for ${deviceSerial}: temp=${data.roomTemp}, mode=${data.operationMode}, power=${data.power}`);

    // Convert streaming data format to zone format for processing
    const zoneUpdate: Partial<Zone> = {
      adapter: {
        id: data.id || '',
        deviceSerial: deviceSerial,
        roomTemp: data.roomTemp!,
        spHeat: data.spHeat!,
        spCool: data.spCool!,
        spAuto: data.spAuto || null,
        humidity: data.humidity ?? null,
        power: data.power!,
        operationMode: data.operationMode!,
        previousOperationMode: data.operationMode!,
        fanSpeed: data.fanSpeed || 'auto',
        airDirection: data.airDirection || 'auto',
        connected: true,
        isSimulator: false,
        hasSensor: data.humidity !== null && data.humidity !== undefined,
        hasMhk2: false,
        scheduleOwner: 'adapter',
        scheduleHoldEndTime: 0,
        rssi: data.rssi,
      },
    } as Zone;

    // Use existing update processing logic
    this.processZoneUpdate(zoneUpdate as Zone, 'streaming', updateTimestamp);

    // Extract extended fields only available from streaming (not in Zone format)
    if (this.currentStatus) {
      this.currentStatus.modelNumber = (data as any).modelNumber;
      this.currentStatus.connected = (data as any).connected;
      const displayConfig = (data as any).displayConfig;
      if (displayConfig) {
        this.currentStatus.filterDirty = displayConfig.filter === true;
        this.currentStatus.defrost = displayConfig.defrost === true;
        this.currentStatus.standby = displayConfig.standby === true;
      }

      // Set model number once on AccessoryInformation
      if (!this.modelNumberSet && this.currentStatus.modelNumber) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
          .setCharacteristic(this.platform.Characteristic.Model, this.currentStatus.modelNumber);
        this.modelNumberSet = true;
        this.platform.log.info(`${this.accessory.displayName}: Model ${this.currentStatus.modelNumber}`);
      }

      // Update filter maintenance service
      this.updateFilterMaintenance(this.currentStatus.filterDirty ?? false);
    }
  }

  /**
   * Register a listener fired whenever this accessory's state changes. Used by the
   * MirrorController to follow a source unit. The listener receives the live
   * currentStatus; treat it as read-only.
   */
  public onStatusUpdate(listener: (status: DeviceStatus) => void): void {
    this.statusListeners.push(listener);
  }

  private notifyStatusListeners(): void {
    if (!this.currentStatus || this.statusListeners.length === 0) {
      return;
    }
    const snapshot = this.currentStatus;
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.platform.log.error('Status listener error:', err);
      }
    }
  }

  // Getter methods for platform to access private properties
  public getSiteId(): string {
    return this.siteId;
  }

  public getDeviceSerial(): string {
    return this.deviceSerial;
  }

  // Called by platform when new zone data is available
  /**
   * Cloud reachability, driven by the `device_status_v2` streaming event.
   *
   * Ported from upstream homebridge-mitsubishi-comfort 7941fe1. Observed there on
   * 2026-09-10: a unit's Wi-Fi adapter was off the network for ~22h while the cloud
   * kept serving its last known state (`cool, power=1`, `connected=true`, a fresh
   * `updatedAt`) from a frozen shadow record. HomeKit showed a tile that was wrong
   * and unactionable: every `off` returned HTTP 200 and reached nothing. The cloud
   * reported "offline (reason: IoT Disconnected)" the whole time through
   * `device_status_v2`. Surfacing that as No Response stops the tile from passing
   * a frozen record off as live. Writes still go out; see assertReachable.
   */
  public setCloudConnected(connected: boolean): void {
    const wasReachable = this.isReachable();
    this.cloudConnected = connected;
    const nowReachable = this.isReachable();

    if (wasReachable === nowReachable) {
      return;
    }

    if (nowReachable) {
      this.platform.log.info(`[REACHABILITY] ${this.accessory.displayName}: back online`);
      if (this.currentStatus) {
        this.publishStatus(this.currentStatus);
      }
    } else {
      this.platform.log.warn(
        `[REACHABILITY] ${this.accessory.displayName}: unreachable — the adapter is offline and ` +
        'there is no local LAN path. Showing No Response in HomeKit; its last reported state is stale. ' +
        'Commands are still sent.',
      );
      this.pushUnreachable();
    }
  }

  /**
   * Unreachable ONLY when the cloud has explicitly reported the adapter disconnected
   * and no local path exists. A unit still answering over the LAN is reachable
   * whatever the cloud thinks, and `null` (nothing reported yet) counts as reachable
   * so a fresh start never flashes No Response before the first status arrives.
   */
  public isReachable(): boolean {
    const local = this.platform.localClient;
    if (local && local.hasLocal(this.deviceSerial)) {
      return true;
    }
    return this.cloudConnected !== false;
  }

  /**
   * HAP's "no response" signal. Falls back to a bare Error, which HomeKit also reads
   * as unreachable, for test harnesses that stub `platform.api` without `hap`.
   */
  private unreachableError(): Error {
    const hap = this.platform.api?.hap as
      | { HapStatusError?: new (s: number) => Error; HAPStatus?: { SERVICE_COMMUNICATION_FAILURE: number } }
      | undefined;
    if (hap?.HapStatusError && hap.HAPStatus) {
      return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return new Error('Device unreachable');
  }

  /**
   * Guard for every characteristic getter: throwing is what puts the accessory into
   * No Response, rather than handing HomeKit a stale cached value as if it were live.
   *
   * Setters are deliberately NOT guarded. Upstream removed this signal once
   * (8b54033, 2026-03-08) because `device_status_v2` falsely reported units offline
   * and every tile went No Response. If that recurs, a guarded setter would also
   * refuse the user's "off". So writes always go out; against a really offline
   * adapter the cloud accepts them and they reach nothing, which is no worse than
   * before this existed.
   */
  private assertReachable(): void {
    if (!this.isReachable()) {
      throw this.unreachableError();
    }
  }

  /** Push the error to HomeKit immediately instead of waiting for the next read. */
  private pushUnreachable(): void {
    const err = this.unreachableError() as never;
    const C = this.platform.Characteristic;
    for (const characteristic of [
      C.Active,
      C.CurrentHeaterCoolerState,
      C.TargetHeaterCoolerState,
      C.CurrentTemperature,
    ]) {
      this.service.updateCharacteristic(characteristic, err);
    }
    this.fanService?.updateCharacteristic(C.Active, err);
    this.fanOnlyService?.updateCharacteristic(C.On, err);
    this.dryService?.updateCharacteristic(C.On, err);
    this.humidityService?.updateCharacteristic(C.CurrentRelativeHumidity, err);
  }

  public updateFromZone(zone: Zone) {
    const updateTimestamp = Date.now();
    this.processZoneUpdate(zone, 'polling', updateTimestamp);
  }

  /**
   * Called by the platform's local poller with a locally-read status.
   * Humidity is not in the local `indoorUnit.status`, but LocalKumoClient now
   * fetches it from the unit's paired sensor (or an MHK2) in the same poll, so a
   * local read usually carries one. Fall back to the last streaming value when it
   * does not, rather than wiping it — a unit with no sensor has no local source.
   *
   * This matters under local control specifically: cloud updates are dropped for
   * LOCAL_AUTHORITATIVE_MS after every local read, so a cloud-only humidity would
   * go stale or never arrive at all on a locally-polled unit.
   */
  public updateFromLocal(status: Partial<DeviceStatus>) {
    if (status.roomTemp === undefined || status.roomTemp === null) {
      return;
    }
    const updateTimestamp = Date.now();
    const zoneUpdate: Partial<Zone> = {
      id: this.currentStatus?.id || '',
      adapter: {
        id: this.currentStatus?.id || '',
        deviceSerial: this.deviceSerial,
        roomTemp: status.roomTemp!,
        spHeat: status.spHeat!,
        spCool: status.spCool!,
        spAuto: status.spAuto ?? null,
        humidity: status.humidity ?? this.currentStatus?.humidity ?? null,
        power: status.power!,
        operationMode: status.operationMode!,
        previousOperationMode: status.operationMode!,
        fanSpeed: status.fanSpeed || 'auto',
        airDirection: status.airDirection || 'auto',
        connected: true,
        isSimulator: false,
        hasSensor: (status.humidity ?? this.currentStatus?.humidity) !== null &&
          (status.humidity ?? this.currentStatus?.humidity) !== undefined,
        hasMhk2: false,
        scheduleOwner: 'adapter',
        scheduleHoldEndTime: 0,
      },
    } as Zone;

    this.processZoneUpdate(zoneUpdate as Zone, 'local', updateTimestamp);

    // Filter / defrost / standby come straight from the local status.
    if (this.currentStatus) {
      if (status.filterDirty !== undefined) {
        this.currentStatus.filterDirty = status.filterDirty;
      }
      if (status.defrost !== undefined) {
        this.currentStatus.defrost = status.defrost;
      }
      if (status.standby !== undefined) {
        this.currentStatus.standby = status.standby;
      }
      this.updateFilterMaintenance(this.currentStatus.filterDirty ?? false);
    }
  }

  /**
   * Send a control command, preferring the local LAN path when available and
   * falling back to the cloud. A failed local send (timeout/unreachable) also
   * falls back, so a flaky adapter never blocks control.
   */
  private async sendDeviceCommand(commands: Commands): Promise<boolean> {
    const local = this.platform.localClient;
    if (local && local.hasLocal(this.deviceSerial)) {
      const ok = await local.sendCommand(this.deviceSerial, commands);
      if (ok) {
        // A successful local command makes us authoritative for the unit's state:
        // we just set it. Mark it local-authoritative (same window a local poll
        // uses) so the Kumo cloud's ~7-10s lag can't replay the pre-command state
        // and clobber it. Without this, only a local *poll* refreshed the window —
        // so when polling was starved during a command burst, a stale cloud/streaming
        // update could be applied after an `off`, briefly flip the cached state back
        // on, and fire the mirror hook, reviving a mirror target (2026-07-23 skylight
        // regression). Local polls (every localPollInterval) confirm the real state
        // within the window.
        this.lastLocalUpdateTs = Date.now();
        this.platform.log.debug(`[LOCAL] ${this.accessory.displayName}: command sent locally`);
        return true;
      }
      this.platform.log.debug(
        `[LOCAL] ${this.accessory.displayName}: local command failed — falling back to cloud`,
      );
    }
    return this.kumoAPI.sendCommand(this.deviceSerial, commands);
  }

  private processZoneUpdate(zone: Zone, source: 'streaming' | 'polling' | 'local', timestamp: number) {
    try {
      // When local control is healthy, it is the authoritative status source: drop
      // cloud (streaming/polling) updates that would clobber fresher local data,
      // since the cloud lags ~7-10s. Once local goes stale (unreachable), cloud
      // updates flow again.
      if (
        source !== 'local' &&
        this.lastLocalUpdateTs > 0 &&
        (Date.now() - this.lastLocalUpdateTs) < this.LOCAL_AUTHORITATIVE_MS
      ) {
        this.platform.log.debug(`[${this.deviceSerial}] Ignoring ${source} update — local is authoritative`);
        return;
      }

      // Prevent old updates from overwriting newer ones
      if (timestamp < this.lastUpdateTimestamp) {
        this.platform.log.debug(
          `[${this.deviceSerial}] Ignoring ${source} update: ` +
          `${this.lastUpdateTimestamp - timestamp}ms older than last ${this.lastUpdateSource} update`
        );
        return;
      }

      this.lastUpdateTimestamp = timestamp;
      const previousSource = this.lastUpdateSource;
      this.lastUpdateSource = source;
      if (source === 'local') {
        this.lastLocalUpdateTs = timestamp;
      }

      if (previousSource !== source && previousSource !== 'none') {
        this.platform.log.debug(`[${this.deviceSerial}] Update source changed: ${previousSource} → ${source}`);
      }

      this.platform.log.debug(`Processing ${source} update for ${this.deviceSerial}`);

      // Validate required fields
      if (zone.adapter.roomTemp === undefined || zone.adapter.roomTemp === null) {
        this.platform.log.error(`Device ${this.deviceSerial} has invalid roomTemp: ${zone.adapter.roomTemp}`);
        this.platform.log.debug('Zone adapter data:', JSON.stringify(zone.adapter));
        return;
      }

      // A fresh paired-sensor reading outranks this update's temperature and
      // humidity, whichever transport it arrived on. Substituted HERE, before the
      // cache and every characteristic below are written, so the coarse value
      // never lands anywhere: the sensor wins by precedence rather than by
      // winning a race. See SENSOR_AUTHORITATIVE_MS. Everything else in the
      // update — mode, power, setpoints, fan, vane — applies untouched, because a
      // sensor knows nothing about any of it.
      const sensorFresh = this.sensorReadingFresh();
      const effectiveRoomTemp = sensorFresh && this.sensorTemp !== null
        ? this.sensorTemp
        : zone.adapter.roomTemp;
      const effectiveHumidity = sensorFresh && this.sensorHumidity !== null
        ? this.sensorHumidity
        : zone.adapter.humidity;

      // Check if device has a humidity reading and add the sensor service if so.
      // CurrentRelativeHumidity is NOT a valid characteristic on HeaterCooler
      // (it was optional on Thermostat), so humidity needs its own service.
      const hasHumidity = effectiveHumidity !== null && effectiveHumidity !== undefined;
      const wantHumidity = this.platform.kumoConfig.showHumiditySensor !== false;
      if (hasHumidity && wantHumidity && !this.hasHumiditySensor) {
        this.hasHumiditySensor = true;
        this.setupHumidityService();
        this.platform.log.debug(`Added humidity sensor for device ${this.deviceSerial}`);
      }
      // Note: Once humidity is detected, we never remove the characteristic.
      // Streaming updates may intermittently omit humidity data, but that doesn't
      // mean the hardware sensor is gone. Toggling the characteristic destabilizes
      // HomeKit and causes "No Response" errors.

      // Convert adapter data to DeviceStatus format
      const status: DeviceStatus = {
        id: zone.id,
        deviceSerial: zone.adapter.deviceSerial,
        rssi: zone.adapter.rssi || 0,
        power: zone.adapter.power,
        operationMode: zone.adapter.operationMode,
        humidity: effectiveHumidity,
        // The zones payload carries neither fan speed nor vane (they live in the
        // streaming `device_update` and in GET /devices/{serial}); both are optional
        // on Adapter for that reason. Carry the last known value across a poll, and
        // default to 'auto' only before anything has reported one. Defaulting on
        // every poll reset a unit on a manual speed or a swinging vane to auto in
        // HomeKit each time, and changed mirror.ts's signature, so every
        // alternation between the two update sources pushed fan 'auto' to mirror
        // targets. The streaming and local paths always fill both fields.
        fanSpeed: zone.adapter.fanSpeed || this.currentStatus?.fanSpeed || 'auto',
        airDirection: zone.adapter.airDirection || this.currentStatus?.airDirection || 'auto',
        roomTemp: effectiveRoomTemp,
        spCool: zone.adapter.spCool,
        spHeat: zone.adapter.spHeat,
        spAuto: zone.adapter.spAuto,
        // The sensor battery is in no zone/streaming payload — it arrives only on
        // sensor_update — so carry it across this rebuild of the status object.
        sensorBattery: this.currentStatus?.sensorBattery ?? null,
        // Same shape, three more fields. standby/defrost/filterDirty are in the
        // streaming `displayConfig` and in the local status, but NOT in the
        // /sites/{id}/zones payload, and both of those sources apply them *after*
        // this call returns. Without carrying them the rebuild left them undefined,
        // so mapToCurrentHeaterCoolerState below (which reads `standby === true`)
        // and getCurrentFanState never once reported IDLE for a unit whose
        // compressor was idling — the characteristic was pushed as COOLING/HEATING
        // before the source had a chance to set the flag. Carrying the last known
        // value makes the push at worst one update stale instead of always wrong.
        standby: this.currentStatus?.standby,
        defrost: this.currentStatus?.defrost,
        filterDirty: this.currentStatus?.filterDirty,
      };

      this.currentStatus = status;
      // Both setpoints, not one "target": on HeaterCooler each threshold is the
      // setpoint for its own mode and the band is live in AUTO, so there is no
      // single target temperature to name.
      this.platform.log.debug(`${this.accessory.displayName}: ${status.roomTemp}°C (heat ${status.spHeat}°C / cool ${status.spCool}°C, mode: ${status.operationMode})`);

      // A unit whose adapter is offline has no live state to publish: anything
      // arriving now is the cloud replaying its frozen shadow record. Keep the
      // cached status (recovery republishes it) but leave HomeKit in No Response,
      // and don't mirror a stale reading onto a live target.
      if (!this.isReachable()) {
        this.platform.log.debug(
          `[${this.deviceSerial}] Unreachable — cached ${source} update without publishing to HomeKit`,
        );
        return;
      }

      this.publishStatus(status);

      // Notify mirror listeners — this only runs on an applied update (early
      // returns above skip it), so a dropped/stale update never mirrors.
      this.notifyStatusListeners();
    } catch (error) {
      this.platform.log.error('Error updating device status:', error);
    }
  }

  /** Push every characteristic derived from `status` to HomeKit (not while unreachable). */
  private publishStatus(status: DeviceStatus): void {
    if (!this.isReachable()) {
      return;
    }
    // Active, mode state and the Dry / Fan-only switches
    this.refreshClimateCharacteristics();

    // Fan and vane ride along with every status update. Both live on the
    // Fanv2 service now, so they go through their own sync helpers.
    this.syncFanCharacteristics(status.fanSpeed);
    this.syncVaneCharacteristics(status.airDirection);

    // Only update temperature if valid
    if (status.roomTemp !== undefined && status.roomTemp !== null && !isNaN(status.roomTemp)) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        status.roomTemp,
      );
    }

    // HeaterCooler has no single TargetTemperature; the two thresholds below
    // carry the setpoints in every mode.

    // Keep the AUTO-mode threshold characteristics in sync with the live band.
    // The Home app only surfaces these in AUTO; refreshing them in any mode is
    // harmless (each is independent within its own min/max props, so a unit
    // sitting in heat/cool with an inverted spHeat>spCool pair never trips a
    // HomeKit constraint — the values just aren't shown until AUTO is selected).
    if (status.spHeat !== undefined && status.spHeat !== null && !isNaN(status.spHeat)) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.HeatingThresholdTemperature,
        status.spHeat,
      );
    }
    if (status.spCool !== undefined && status.spCool !== null && !isNaN(status.spCool)) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature,
        status.spCool,
      );
    }

    // Only update humidity if the device has a humidity sensor
    if (this.hasHumiditySensor && status.humidity !== null) {
      this.humidityService?.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        status.humidity,
      );
    }
  }

  /** On/off. HeaterCooler splits this out from the mode, unlike Thermostat. */
  private mapToActive(status: DeviceStatus): number {
    const C = this.platform.Characteristic;
    return status.power === 1 && status.operationMode !== 'off' ? C.Active.ACTIVE : C.Active.INACTIVE;
  }

  /**
   * What the unit is doing right now.
   *
   * HeaterCooler has a real IDLE state, which Thermostat lacked — so `vent`
   * (fan running, no heating or cooling) and a compressor in standby can both be
   * reported honestly instead of being dressed up as COOL. That removes the whole
   * dry/vent -> COOL workaround upstream needed in 1.7.1: that hack existed only
   * because Thermostat's OFF was both "not running" and "powered down", so an
   * off-scene write got suppressed as redundant. Here on/off is `Active`, a
   * separate characteristic, so a scene turning the unit off always registers.
   */
  private mapToCurrentHeaterCoolerState(status: DeviceStatus): number {
    const C = this.platform.Characteristic.CurrentHeaterCoolerState;

    if (status.power === 0 || status.operationMode === 'off') {
      return C.INACTIVE;
    }
    // Compressor idle but the unit is on and holding its setpoint.
    if (status.standby === true) {
      return C.IDLE;
    }

    switch (status.operationMode) {
      case 'heat':
      case 'autoHeat':
        return C.HEATING;
      case 'cool':
      case 'autoCool':
        return C.COOLING;
      case 'dry':
        // Dehumidify runs the compressor and the coil cold; COOLING is accurate.
        return C.COOLING;
      case 'vent':
        // Fan only: on, moving air, neither heating nor cooling.
        return C.IDLE;
      case 'auto': {
        // Plain 'auto' without the unit telling us which way it went. Infer from
        // the band: above the cool edge -> cooling, below the heat edge ->
        // heating, in between -> genuinely idle.
        const heat = this.getThresholdTemperature('spHeat', 20);
        const cool = this.getThresholdTemperature('spCool', 24);
        if (status.roomTemp > cool) {
          return C.COOLING;
        }
        if (status.roomTemp < heat) {
          return C.HEATING;
        }
        return C.IDLE;
      }
      default:
        return C.INACTIVE;
    }
  }

  /**
   * The requested mode. HeaterCooler's target has only AUTO/HEAT/COOL — no OFF
   * (that is `Active`) and nothing for dry or fan-only. Dry and vent report COOL
   * so the tile stays coherent while their dedicated switches drive them; dry
   * genuinely belongs there, since its setpoint lives in spCool.
   */
  private mapToTargetHeaterCoolerState(status: DeviceStatus): number {
    const C = this.platform.Characteristic.TargetHeaterCoolerState;

    if (this.isAutoMode(status.operationMode)) {
      return C.AUTO;
    }
    if (status.operationMode === 'heat') {
      return C.HEAT;
    }
    // cool, dry, vent, and anything unrecognised.
    return C.COOL;
  }

  private isAutoMode(operationMode: string): boolean {
    return operationMode.startsWith('auto');
  }

  /**
   * Whether dry mode exposes a settable temperature target on this unit.
   *
   * On the Kumo v3 cloud the dry setpoint lives in `spCool` (there is no spDry
   * field), and the device profile reports `usesSetPointInDryMode`. We treat dry
   * as having a setpoint unless the profile is loaded and explicitly says it
   * doesn't — so the common case still works during the brief window before the
   * async profile_update arrives. Verified live: writing `spCool` while in dry is
   * adopted and the unit stays in dry.
   */
  private dryUsesSetpoint(): boolean {
    return this.deviceProfile === null || this.deviceProfile.usesSetPointInDryMode;
  }

  /**
   * Record HomeKit's mode intent so a concurrent scene setpoint can't revive a
   * unit that's being turned off. Called synchronously (before the command's
   * await) from every mode-changing setter: open the suppression window on
   * `off`, clear it on any active mode.
   */
  private noteModeIntent(operationMode: string): void {
    this.offRequestedAt = operationMode === 'off' ? Date.now() : 0;
  }

  /**
   * Hold a setpoint write for SETPOINT_HOLD_MS before sending it, so a
   * concurrent "AC off" can cancel it whichever order HomeKit dispatched them in.
   *
   *  - 'send'       — go ahead
   *  - 'superseded' — a newer write to the same setpoint arrived; drop this one
   *                   silently (don't cache a stale value over the newer one)
   *  - 'suppressed' — the unit is off / turning off; cache + echo, don't send
   */
  private async holdSetpointWrite(key: string): Promise<'send' | 'superseded' | 'suppressed'> {
    const gen = (this.setpointWriteGen.get(key) || 0) + 1;
    this.setpointWriteGen.set(key, gen);
    await new Promise(resolve => setTimeout(resolve, this.SETPOINT_HOLD_MS));
    if (this.setpointWriteGen.get(key) !== gen) {
      return 'superseded';
    }
    return this.shouldSuppressSetpoint() ? 'suppressed' : 'send';
  }

  /**
   * True only while a HomeKit "off" is in flight — the concurrent scene burst.
   *
   * Distinct from shouldSuppressSetpoint(), which is ALSO true for a unit that
   * has simply been off for a while. That distinction matters for fan speed and
   * vane: both are stored preferences it is perfectly reasonable to set on an
   * idle unit ("set every fan to quiet"), and neither revives it — verified live
   * 2026-07-27 by writing all six speeds and all seven vane positions to the
   * powered-off Garage, which reported mode=off throughout. What must still be
   * blocked is a command trailing an off inside the same scene burst.
   */
  private offInFlight(): boolean {
    return Date.now() - this.offRequestedAt < this.OFF_SUPPRESS_WINDOW_MS;
  }

  /**
   * Whether a setpoint write should be suppressed (cached + echoed, not sent).
   * True when the unit is already off, or when a HomeKit off was requested within
   * OFF_SUPPRESS_WINDOW_MS — the window covers the concurrent "AC off" scene
   * burst, where the off command's optimistic state update hasn't landed yet.
   */
  private shouldSuppressSetpoint(): boolean {
    if (!this.currentStatus) {
      return false;
    }
    return (
      this.currentStatus.power === 0 ||
      this.currentStatus.operationMode === 'off' ||
      this.offInFlight()
    );
  }

  // ---- HeaterCooler: Active (on/off) --------------------------------------

  async getActive(): Promise<CharacteristicValue> {
    this.assertReachable();
    if (!this.currentStatus) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    return this.mapToActive(this.currentStatus);
  }

  /**
   * Turn the unit on or off, independently of its mode.
   *
   * Turning ON restores the mode the unit was last in rather than picking one:
   * `previousOperationMode` is what the hardware itself remembers, and HomeKit
   * sends Active=1 with no mode of its own.
   */
  async setActive(value: CharacteristicValue): Promise<void> {
    const on = value === this.platform.Characteristic.Active.ACTIVE;

    // ON for a unit that is already running changes nothing, so nothing is sent.
    // A scene that switches mode pushes Active=ON alongside TargetHeaterCoolerState,
    // concurrently and in either order. Re-sending the remembered mode here raced
    // the scene's own mode write and whichever reached the cloud last won: a morning
    // HEAT scene left units in the COOL the evening scene had set. An off IN FLIGHT
    // still lets the ON through, because the cache has not caught up with it yet.
    if (on && !this.offInFlight() &&
        this.currentStatus?.power === 1 && this.currentStatus.operationMode !== 'off') {
      this.platform.log.info(`[ACTIVE] ${this.accessory.displayName}: HomeKit sent ON, already on — nothing to send`);
      return;
    }

    const gen = ++this.activeWriteGen;

    let operationMode: 'off' | 'heat' | 'cool' | 'auto' | 'dry' | 'vent';
    if (!on) {
      operationMode = 'off';
    } else {
      const remembered = this.currentStatus?.operationMode;
      operationMode = remembered && remembered !== 'off'
        ? this.normalizeSendMode(remembered)
        : this.defaultOnMode();
    }

    this.platform.log.info(
      `[ACTIVE] ${this.accessory.displayName}: HomeKit sent ${on ? 'ON' : 'OFF'} -> mode ${operationMode}`,
    );

    // Synchronously (before the await) note the off/active intent so a setpoint
    // write dispatched later in the same scene burst is suppressed rather than
    // reviving the unit. See offRequestedAt.
    this.noteModeIntent(operationMode);

    // An ON for an off unit waits out the scene burst. See modeWriteAt.
    if (on) {
      const heldAt = Date.now();
      if (heldAt - this.modeWriteAt >= this.ACTIVE_ON_HOLD_MS) {
        await new Promise(resolve => setTimeout(resolve, this.ACTIVE_ON_HOLD_MS));
      }
      if (this.modeWriteAt > heldAt - this.ACTIVE_ON_HOLD_MS) {
        this.platform.log.info(
          `[ACTIVE] ${this.accessory.displayName}: a mode write in the same burst turns it on — nothing to send`,
        );
        return;
      }
      if (this.activeWriteGen !== gen) {
        return;
      }
    }

    const success = await this.sendDeviceCommand({ operationMode });

    if (!success) {
      this.platform.log.error(`[ACTIVE] ${this.accessory.displayName}: failed to turn ${on ? 'ON' : 'OFF'}`);
      this.revertSoon();
      return;
    }

    if (this.currentStatus) {
      this.currentStatus.operationMode = operationMode;
      this.currentStatus.power = on ? 1 : 0;
      this.refreshClimateCharacteristics();
    }
    this.notifyStatusListeners();
  }

  /** Collapse a reported mode (autoHeat/autoCool) to one the API accepts on send. */
  private normalizeSendMode(mode: string): 'heat' | 'cool' | 'auto' | 'dry' | 'vent' {
    if (this.isAutoMode(mode)) {
      return 'auto';
    }
    if (mode === 'heat' || mode === 'cool' || mode === 'dry' || mode === 'vent') {
      return mode;
    }
    return 'cool';
  }

  /** Mode to use when HomeKit says "on" and we have nothing remembered. */
  private defaultOnMode(): 'heat' | 'cool' | 'auto' {
    if (this.deviceProfile && !this.deviceProfile.hasModeHeat) {
      return 'cool';
    }
    return 'auto';
  }

  // ---- HeaterCooler: mode --------------------------------------------------

  async getCurrentHeaterCoolerState(): Promise<CharacteristicValue> {
    this.assertReachable();
    if (!this.currentStatus) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
    return this.mapToCurrentHeaterCoolerState(this.currentStatus);
  }

  async getTargetHeaterCoolerState(): Promise<CharacteristicValue> {
    this.assertReachable();
    if (!this.currentStatus) {
      return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
    }
    return this.mapToTargetHeaterCoolerState(this.currentStatus);
  }

  async setTargetHeaterCoolerState(value: CharacteristicValue): Promise<void> {
    const C = this.platform.Characteristic.TargetHeaterCoolerState;

    let operationMode: 'heat' | 'cool' | 'auto';
    switch (value) {
      case C.HEAT: operationMode = 'heat'; break;
      case C.COOL: operationMode = 'cool'; break;
      case C.AUTO: operationMode = 'auto'; break;
      default:
        this.platform.log.error('Unknown target heater-cooler state:', value);
        return;
    }

    this.platform.log.info(`[MODE CHANGE] ${this.accessory.displayName}: HomeKit sent ${operationMode.toUpperCase()}`);

    // Guarded on offInFlight(), NOT shouldSuppressSetpoint(): picking a mode on a
    // unit that is merely off is how a user turns it back on, and that must keep
    // working. What must not go through is a mode trailing an off inside the same
    // scene burst — every mode here is an active one, so it revives the unit the
    // way a trailing setpoint does, and it does worse than the other writers: the
    // noteModeIntent below would clear the window for everything dispatched behind
    // it. Checked BEFORE that call for exactly that reason. Turning the unit on
    // clears the window through setActive, so an on+mode pair is unaffected.
    if (this.offInFlight()) {
      this.platform.log.debug(
        `[MODE CHANGE] ${this.accessory.displayName}: an off is in flight — not sending ${operationMode}`,
      );
      this.revertSoon();
      return;
    }

    // A mode is always an active mode here — HeaterCooler expresses off through
    // Active — so this clears any pending off-suppression window.
    this.noteModeIntent(operationMode);
    this.modeWriteAt = Date.now();

    const success = await this.sendDeviceCommand({ operationMode });

    if (success) {
      this.platform.log.info(`[MODE CHANGE] ${this.accessory.displayName}: Command accepted by API`);
      if (this.currentStatus) {
        this.currentStatus.operationMode = operationMode;
        this.currentStatus.power = 1;
        this.refreshClimateCharacteristics();
      }
      this.notifyStatusListeners();
    } else {
      this.platform.log.error(`[MODE CHANGE] ${this.accessory.displayName}: Failed to set mode to ${operationMode}`);
    }
  }

  /**
   * Push Active, both state characteristics and the Dry / Fan-only switches from
   * the current cached status. The switches are derived here rather than flipped
   * by each setter: fan-only and dry are mutually exclusive, and both are off in
   * heat/cool/auto or when the unit is off.
   */
  private refreshClimateCharacteristics(): void {
    // Unreachable: the cache is updated, but HomeKit stays in No Response.
    if (!this.currentStatus || !this.isReachable()) {
      return;
    }
    const C = this.platform.Characteristic;
    this.service.updateCharacteristic(C.Active, this.mapToActive(this.currentStatus));
    this.service.updateCharacteristic(
      C.CurrentHeaterCoolerState, this.mapToCurrentHeaterCoolerState(this.currentStatus));
    this.service.updateCharacteristic(
      C.TargetHeaterCoolerState, this.mapToTargetHeaterCoolerState(this.currentStatus));
    this.fanOnlyService?.updateCharacteristic(C.On, this.isFanOnlyActive(this.currentStatus));
    this.dryService?.updateCharacteristic(C.On, this.isDryActive(this.currentStatus));
  }

  /**
   * Put HomeKit back on the cached device state after a write that did not go
   * through. Deferred because HAP applies the written value after the handler
   * returns, which would overwrite an immediate revert.
   */
  private revertSoon(): void {
    setTimeout(() => {
      if (this.currentStatus) {
        this.publishStatus(this.currentStatus);
      }
    }, 100);
  }

  // ---- Fanv2: speed, auto/manual, swing -----------------------------------

  /**
   * The Fanv2 service: everything about air movement in one place.
   *
   * HeaterCooler cannot express "fan auto" — TargetFanState is a Fanv2
   * characteristic — which is the whole reason this service exists. Speed lives
   * on RotationSpeed (five real detents, no zero), auto/manual on TargetFanState,
   * and swing on SwingMode once the profile confirms the unit has one.
   */
  private setupFanService(): void {
    if (this.fanService) {
      return;
    }
    const C = this.platform.Characteristic;
    const name = `${this.accessory.context.device.displayName} Fan`;
    const existing = this.accessory.getServiceById(this.platform.Service.Fanv2, 'airflow');

    this.fanService = existing ||
      this.accessory.addService(this.platform.Service.Fanv2, name, 'airflow');
    // Name only. ConfiguredName is NOT in Fanv2's required or optional set, and
    // adding it makes Homebridge log a characteristic warning on every start
    // ("Adding anyway"). The same is true of Switch, so the Dry/Fan-only switches
    // inherited from upstream will warn too if they are enabled.
    this.fanService.setCharacteristic(C.Name, name);
    // Simply not setting it does not remove one a previous version already
    // persisted into the accessory cache, so strip it explicitly.
    this.removeStaleCharacteristic(this.fanService, C.ConfiguredName);

    this.fanService.getCharacteristic(C.Active)
      .onGet(this.getFanActive.bind(this))
      .onSet(this.setFanActive.bind(this));

    this.fanService.getCharacteristic(C.CurrentFanState)
      .onGet(this.getCurrentFanState.bind(this));

    // TargetFanState is registered from applyDeviceProfile, gated on the unit
    // actually having an auto fan mode — offering an Auto segment on a unit that
    // cannot do it would just produce a command it ignores.

    this.fanService.getCharacteristic(C.RotationSpeed)
      // Five evenly spaced positions across the full range: 0/25/50/75/100, one
      // per real speed, no duplicates and nothing dead. minValue must stay 0
      // regardless — hap-nodejs REJECTS a client write below minValue with -70410
      // rather than clamping it, and the Home app sends 0 when a fan slider is
      // dragged to the bottom.
      .setProps({ minValue: 0, maxValue: 100, minStep: FAN_PCT_STEP })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    this.linkSecondaryService(this.fanService);

    // Deliberately NO publishStructureChange() here. This runs from the
    // constructor, where the HeaterCooler itself is also added without one:
    // Homebridge's own registration (and its cache save) picks up everything the
    // constructor builds. Publishing here would fire before the accessory is
    // registered on a fresh install, and it would break the invariant that
    // nothing is published until a device profile actually changes something.
    // The lazy services (Slats, HumiditySensor, the switches) DO publish, because
    // they are created later from async profile/status events.
  }

  /**
   * Declare the HeaterCooler as this accessory's primary service and hang the
   * secondary ones off it.
   *
   * `primary` and `linked` are both part of a service's HAP representation, so
   * controllers are told which tile is the accessory and which services belong
   * *to* it rather than standing alone. This is the documented way to say "the
   * fan is part of this heat pump", as opposed to being an independent fan that
   * a room-level or category-wide command should sweep up.
   *
   * Guarded because a bare Service stub has neither method, and this runs from
   * the constructor where a throw would take out the whole accessory.
   */
  private linkSecondaryService(secondary: Service | null): void {
    if (!secondary) {
      return;
    }
    const primary = this.service as unknown as {
      setPrimaryService?: (v?: boolean) => void;
      addLinkedService?: (s: Service) => void;
    };
    if (typeof primary.setPrimaryService === 'function') {
      primary.setPrimaryService(true);
    }
    if (typeof primary.addLinkedService === 'function') {
      primary.addLinkedService(secondary);
    }
  }

  /**
   * Remove a characteristic an earlier version of this plugin left on a service.
   *
   * Guarded on the methods existing: hap-nodejs Services have testCharacteristic
   * and removeCharacteristic, but a stub may not, and this runs during
   * construction where a throw would take out the whole accessory.
   */
  private removeStaleCharacteristic(service: Service, char: unknown): void {
    const svc = service as unknown as {
      testCharacteristic?: (c: unknown) => boolean;
      getCharacteristic?: (c: unknown) => unknown;
      removeCharacteristic?: (c: unknown) => void;
    };
    if (typeof svc.testCharacteristic !== 'function' ||
        typeof svc.removeCharacteristic !== 'function' ||
        typeof svc.getCharacteristic !== 'function') {
      return;
    }
    if (svc.testCharacteristic(char)) {
      svc.removeCharacteristic(svc.getCharacteristic(char));
      this.platform.log.debug(
        `${this.accessory.displayName}: removed a stale characteristic left by an earlier version`,
      );
    }
  }

  /** Fan speed -> RotationSpeed percent. `auto` has no slider position. */
  private fanSpeedToRotation(speed: string): number {
    // Case-insensitive: pykumo reports `Low` (capitalised) on 4-speed units, and
    // an exact match would score that -1 and render it as the slowest speed.
    const known = normalizeFanSpeed(speed);
    if (!known) {
      this.platform.log.debug(
        `${this.accessory.displayName}: unrecognised fan speed "${speed}" from the unit`,
      );
      return (FAN_SPEEDS.indexOf(this.lastManualFan) - 1) * FAN_PCT_STEP;
    }
    if (known === 'auto') {
      // In auto the slider shows the last real speed observed. TargetFanState is
      // what actually tells the user the unit is choosing for itself.
      return (FAN_SPEEDS.indexOf(this.lastManualFan) - 1) * FAN_PCT_STEP;
    }
    return (FAN_SPEEDS.indexOf(known) - 1) * FAN_PCT_STEP;
  }

  /** RotationSpeed percent -> a real fan speed. Never returns 'auto'. */
  private rotationToFanSpeed(pct: number): FanSpeed {
    // 0/25/50/75/100 -> FAN_SPEEDS[1..5]; index 0 is the auto sentinel and is not
    // reachable from this slider.
    const i = Math.round(pct / FAN_PCT_STEP) + 1;
    return FAN_SPEEDS[Math.min(Math.max(i, 1), FAN_SPEEDS.length - 1)];
  }

  async getFanActive(): Promise<CharacteristicValue> {
    this.assertReachable();
    if (!this.currentStatus) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    return this.mapToActive(this.currentStatus);
  }

  /**
   * Turning the fan tile OFF is refused; turning it ON turns the unit on.
   *
   * Apple documents room-scoped Siri fan commands ("Turn off the fan.", "Turn on
   * the fan in the office."), and a HomePod answers a bare "turn off the fan" for
   * its own room. If this delegated an INACTIVE write through to the unit's
   * power, any of those would shut down the heat pump — the same shape as the
   * Slats service being swept up by a blinds command.
   *
   * So an off is bounced: the characteristic is put back a moment later, which is
   * what Home Assistant's HomeKit bridge does for exactly this case
   * (climate_base.py `_set_fan_active` -> `_reject_char_write`). Off belongs on
   * the climate tile, where the user is unambiguously talking about the unit.
   */
  async setFanActive(value: CharacteristicValue): Promise<void> {
    const C = this.platform.Characteristic.Active;
    if (value === C.INACTIVE) {
      this.platform.log.info(
        `[FAN] ${this.accessory.displayName}: ignoring a fan-tile OFF — a mini-split's ` +
        'fan cannot run independently, and honouring this would let a room-wide ' +
        '"turn off the fan" shut down the heat pump. Use the climate tile to turn it off.',
      );
      this.revertSoon();
      return;
    }
    await this.setActive(value);
  }

  async getCurrentFanState(): Promise<CharacteristicValue> {
    this.assertReachable();
    const C = this.platform.Characteristic.CurrentFanState;
    if (!this.currentStatus ||
        this.mapToActive(this.currentStatus) === this.platform.Characteristic.Active.INACTIVE) {
      return C.INACTIVE;
    }
    // Standby means the compressor is idle: the unit is on but not working.
    return this.currentStatus.standby === true ? C.IDLE : C.BLOWING_AIR;
  }

  async getTargetFanState(): Promise<CharacteristicValue> {
    this.assertReachable();
    const C = this.platform.Characteristic.TargetFanState;
    return this.currentStatus?.fanSpeed === 'auto' ? C.AUTO : C.MANUAL;
  }

  async setTargetFanState(value: CharacteristicValue): Promise<void> {
    const C = this.platform.Characteristic.TargetFanState;
    this.platform.log.info(
      `[FAN] ${this.accessory.displayName}: HomeKit sent ` +
      `${value === C.AUTO ? 'AUTO' : 'MANUAL'}`,
    );
    this.queueFanIntent({ auto: value === C.AUTO });
  }

  /**
   * Collect the fan writes of a single HAP request before sending anything.
   *
   * HomeKit sends a scene as ONE write request carrying several characteristics,
   * and hap-nodejs dispatches every handler in that request concurrently without
   * awaiting (Accessory.js runs `handleCharacteristicWrite(...).then(...)` in a
   * plain loop). A scene that sets "fan auto" also re-sends the captured
   * RotationSpeed, so whichever handler ran last used to win: setting auto landed
   * in manual roughly at random. Buffering to the next tick makes the pair one
   * intent, and an explicit AUTO beats the mode merely implied by a slider value.
   */
  private queueFanIntent(patch: { auto?: boolean; speed?: FanSpeed }): void {
    this.pendingFan = { ...(this.pendingFan ?? {}), ...patch };
    if (this.fanFlushTimer) {
      return;
    }
    this.fanFlushTimer = setTimeout(() => {
      this.fanFlushTimer = null;
      const intent = this.pendingFan;
      this.pendingFan = null;
      if (!intent) {
        return;
      }
      // Explicit AUTO wins over any speed in the same burst; otherwise the speed
      // (or, for a bare MANUAL, the last real speed the unit was seen at).
      const speed: FanSpeed = intent.auto === true
        ? 'auto'
        : (intent.speed ?? this.lastManualFan);
      void this.writeFanSpeed(speed);
    }, 0);
  }

  async getRotationSpeed(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.fanSpeedToRotation(this.currentStatus?.fanSpeed ?? 'auto');
  }

  async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const pct = value as number;
    // 0 is the quietest speed, not "off" — see the note on FAN_PCT_STEP. Off
    // stays on the climate tile so a command aimed at "the fan" cannot stop the
    // heat pump (see setFanActive).
    const fanSpeed = this.rotationToFanSpeed(pct);
    this.platform.log.info(
      `[FAN SPEED] ${this.accessory.displayName}: HomeKit sent ${pct} -> "${fanSpeed}"`,
    );
    // Deliberately NOT force-pushing MANUAL here: that is what let a scene's
    // trailing speed override an explicit AUTO in the same burst. queueFanIntent
    // resolves the two together.
    this.queueFanIntent({ speed: fanSpeed });
  }

  /** Send a fan speed and reconcile the fan characteristics. */
  private async writeFanSpeed(fanSpeed: FanSpeed): Promise<void> {
    // Guarded on offInFlight(), NOT shouldSuppressSetpoint(): a fan write is fine
    // on a unit that is merely off (it is a stored preference and does not revive
    // it), but must not trail an off inside a scene burst.
    if (this.offInFlight()) {
      this.platform.log.debug(
        `[FAN SPEED] ${this.accessory.displayName}: an off is in flight — not sending`,
      );
      return;
    }

    const success = await this.sendDeviceCommand({ fanSpeed });

    if (success) {
      if (fanSpeed !== 'auto') {
        this.lastManualFan = fanSpeed;
      }
      if (this.currentStatus) {
        this.currentStatus.fanSpeed = fanSpeed;
      }
      this.syncFanCharacteristics(fanSpeed);
      this.notifyStatusListeners();
    } else {
      this.platform.log.error(
        `[FAN SPEED] ${this.accessory.displayName}: failed to set "${fanSpeed}"`,
      );
      this.syncFanCharacteristics(this.currentStatus?.fanSpeed ?? 'auto');
    }
  }

  /** Push every fan-derived characteristic from one device value. */
  private syncFanCharacteristics(speed: string): void {
    if (!this.fanService) {
      return;
    }
    const C = this.platform.Characteristic;
    const known = normalizeFanSpeed(speed);
    if (known && known !== 'auto') {
      this.lastManualFan = known;
    }
    if (this.targetFanStateRegistered) {
      this.fanService.updateCharacteristic(
        C.TargetFanState,
        known === 'auto' ? C.TargetFanState.AUTO : C.TargetFanState.MANUAL,
      );
    }
    this.fanService.updateCharacteristic(C.RotationSpeed, this.fanSpeedToRotation(speed));
    if (this.currentStatus) {
      this.fanService.updateCharacteristic(C.Active, this.mapToActive(this.currentStatus));
    }
  }


  // ---- Display units -------------------------------------------------------

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    const C = this.platform.Characteristic.TemperatureDisplayUnits;
    return this.accessory.context.displayUnits === 'C' ? C.CELSIUS : C.FAHRENHEIT;
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue): Promise<void> {
    const C = this.platform.Characteristic.TemperatureDisplayUnits;
    const units = value === C.CELSIUS ? 'C' : 'F';
    if (this.accessory.context.displayUnits === units) {
      return; // persisting rewrites the whole accessory cache to disk
    }
    this.accessory.context.displayUnits = units;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  // ---- Vane (swing + discrete positions) ----------------------------------
  // The device holds ONE vane field, which carries both the fixed blade angles
  // and the two non-angle states ('auto', 'swing'). HomeKit splits that across
  // SwingMode (a toggle) and, optionally, a Slats service with a tilt angle.
  // Both drive the same field, so they are kept in sync from one place.
  //
  // The write path for any of this did not exist upstream: `Commands` had no
  // vane member at all. Every value below is live-verified as accepted by the
  // adapter; note it returns HTTP 200 for garbage and silently ignores it, so
  // isVaneDirection is the only thing standing between a typo and a no-op.

  private vaneToTilt(vane: string): number | null {
    return VANE_TILT.find((v) => v.vane === vane)?.angle ?? null;
  }

  private tiltToVane(angle: number): VaneDirection {
    let best = VANE_TILT[0];
    for (const v of VANE_TILT) {
      if (Math.abs(v.angle - angle) < Math.abs(best.angle - angle)) {
        best = v;
      }
    }
    return best.vane;
  }

  /** Push every vane-derived characteristic from one device value. */
  private syncVaneCharacteristics(vane: string): void {
    const C = this.platform.Characteristic;
    const swinging = vane === 'swing';

    if (!swinging && isVaneDirection(vane) && vane !== 'auto') {
      this.lastFixedVane = vane;
    }

    if (this.swingModeRegistered) {
      this.service.updateCharacteristic(
        C.SwingMode,
        swinging ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED,
      );
    }

    if (this.slatsService) {
      this.slatsService.updateCharacteristic(
        C.CurrentSlatState,
        swinging ? C.CurrentSlatState.SWINGING : C.CurrentSlatState.FIXED,
      );
      const tilt = this.vaneToTilt(vane);
      if (tilt !== null) {
        this.slatsService.updateCharacteristic(C.CurrentTiltAngle, tilt);
        this.slatsService.updateCharacteristic(C.TargetTiltAngle, tilt);
      }
    }
  }

  /** Send a vane value, validate it, and reconcile the characteristics. */
  private async writeVane(vane: VaneDirection, label: string): Promise<boolean> {
    // Every refusal below reverts through revertSoon, never synchronously: HAP
    // assigns the written value after this handler returns, which would overwrite
    // an immediate revert and leave the tile showing a vane the unit is not in.
    if (!isVaneDirection(vane)) {
      this.platform.log.error(`[${label}] ${this.accessory.displayName}: refusing invalid vane "${vane}"`);
      this.revertSoon();
      return false;
    }

    // Same rule as fan speed: allowed on an idle unit, blocked while an off is
    // in flight so it cannot trail an off in a scene burst.
    if (this.offInFlight()) {
      this.platform.log.debug(
        `[${label}] ${this.accessory.displayName}: an off is in flight — not sending vane`,
      );
      this.revertSoon();
      return false;
    }

    const success = await this.sendDeviceCommand({ vaneDir: vane });
    if (success) {
      if (this.currentStatus) {
        this.currentStatus.airDirection = vane;
      }
      this.syncVaneCharacteristics(vane);
      this.notifyStatusListeners();
    } else {
      this.platform.log.error(`[${label}] ${this.accessory.displayName}: failed to set vane "${vane}"`);
      this.revertSoon();
    }
    return success;
  }

  async getSwingMode(): Promise<CharacteristicValue> {
    this.assertReachable();
    const C = this.platform.Characteristic.SwingMode;
    return this.currentStatus?.airDirection === 'swing' ? C.SWING_ENABLED : C.SWING_DISABLED;
  }

  async setSwingMode(value: CharacteristicValue): Promise<void> {
    const C = this.platform.Characteristic.SwingMode;
    // Turning swing off restores the last fixed position the unit was actually
    // observed in, falling back to 'auto' — the device has one field, so "not
    // swinging" has to mean some concrete position.
    const vane: VaneDirection = value === C.SWING_ENABLED ? 'swing' : this.lastFixedVane;
    this.platform.log.info(
      `[VANE] ${this.accessory.displayName}: swing ${value === C.SWING_ENABLED ? 'ON' : 'OFF'} -> "${vane}"`,
    );
    await this.writeVane(vane, 'VANE');
  }

  async getCurrentSlatState(): Promise<CharacteristicValue> {
    this.assertReachable();
    const C = this.platform.Characteristic.CurrentSlatState;
    return this.currentStatus?.airDirection === 'swing' ? C.SWINGING : C.FIXED;
  }

  async getTargetTiltAngle(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.vaneToTilt(this.currentStatus?.airDirection ?? '') ?? 0;
  }

  async setTargetTiltAngle(value: CharacteristicValue): Promise<void> {
    const vane = this.tiltToVane(value as number);
    this.platform.log.info(
      `[VANE] ${this.accessory.displayName}: tilt ${value}° -> "${vane}"`,
    );
    await this.writeVane(vane, 'VANE');
  }

  private setupSlatsService(): void {
    if (this.slatsService) {
      return;
    }
    const C = this.platform.Characteristic;
    const existing = this.accessory.getService(this.platform.Service.Slats);
    const name = `${this.accessory.context.device.displayName} Vane`;

    this.slatsService = existing || this.accessory.addService(this.platform.Service.Slats, name);
    this.slatsService.setCharacteristic(C.Name, name);
    // These are ceiling cassettes and wall units: the blade that moves is the
    // horizontal one, tilting the airflow up and down.
    this.slatsService.setCharacteristic(C.SlatType, C.SlatType.HORIZONTAL);

    this.slatsService.getCharacteristic(C.CurrentSlatState).onGet(this.getCurrentSlatState.bind(this));
    this.slatsService.getCharacteristic(C.CurrentTiltAngle)
      .setProps({ minValue: -90, maxValue: 90, minStep: TILT_STEP });
    this.slatsService.getCharacteristic(C.TargetTiltAngle)
      .setProps({ minValue: -90, maxValue: 90, minStep: TILT_STEP })
      .onGet(this.getTargetTiltAngle.bind(this))
      .onSet(this.setTargetTiltAngle.bind(this));

    this.syncVaneCharacteristics(this.currentStatus?.airDirection ?? 'auto');
    this.linkSecondaryService(this.slatsService);

    if (!existing) {
      this.publishStructureChange();
    }
    this.platform.log.debug(`Added Slats (vane) service for ${this.accessory.displayName}`);
  }

  private removeSlatsService(): void {
    const existing = this.accessory.getService(this.platform.Service.Slats);
    if (existing) {
      this.accessory.removeService(existing);
      this.publishStructureChange();
    }
    this.slatsService = null;
  }

  /**
   * Indoor humidity, as its own service.
   *
   * Thermostat carried CurrentRelativeHumidity as an optional characteristic;
   * HeaterCooler does not, so the reading needs a HumiditySensor service. Added
   * lazily on the first non-null reading, exactly as before — only sensor-equipped
   * units report it, and the value is cloud-sourced (the local status has no
   * humidity field).
   */
  private setupHumidityService(): void {
    if (this.humidityService) {
      return;
    }
    const existing = this.accessory.getService(this.platform.Service.HumiditySensor);
    const name = `${this.accessory.context.device.displayName} Humidity`;

    this.humidityService =
      existing || this.accessory.addService(this.platform.Service.HumiditySensor, name);
    this.humidityService.setCharacteristic(this.platform.Characteristic.Name, name);
    this.humidityService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));
    this.linkSecondaryService(this.humidityService);

    if (!existing) {
      this.publishStructureChange();
    }
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    this.assertReachable();
    // Never block on API calls - return cached or default value immediately
    if (!this.currentStatus) {
      // A sensor_update can land before the first device_update, and a real
      // reading beats the placeholder.
      if (this.sensorReadingFresh() && this.sensorTemp !== null) {
        return this.sensorTemp;
      }
      this.platform.log.debug('No status available yet for getCurrentTemperature, returning default');
      return 20; // Default fallback temperature
    }

    const temp = this.currentStatus.roomTemp;
    if (temp === undefined || temp === null || isNaN(temp)) {
      this.platform.log.warn(`Invalid roomTemp value for ${this.accessory.displayName}:`, temp);
      return 20; // Default fallback temperature
    }

    this.platform.log.debug(`HomeKit get current temp for ${this.accessory.displayName}: ${temp}°C`);
    return temp;
  }

  // NOTE: getTargetTemperature / setTargetTemperature are deliberately gone.
  // HeaterCooler has no TargetTemperature characteristic; the heating and
  // cooling thresholds below are the setpoint controls in every mode. Removing
  // the second writer is what structurally fixes upstream's AUTO band collapse
  // (PR #23): there is no longer a characteristic that writes both spHeat and
  // spCool from one value, so a scene re-sending a captured target cannot
  // flatten the band no matter what order HomeKit dispatches the burst in.

  // ---- Setpoints ----------------------------------------------------------
  // On HeaterCooler these two are the setpoint controls in EVERY mode, not just
  // AUTO: the Home app shows the heating threshold in HEAT, the cooling
  // threshold in COOL, and both handles as a range in AUTO. spHeat is the
  // low/heat bound, spCool the high/cool bound (these units have no spAuto).

  async getHeatingThresholdTemperature(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.getThresholdTemperature('spHeat', 20);
  }

  async getCoolingThresholdTemperature(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.getThresholdTemperature('spCool', 24);
  }

  private getThresholdTemperature(field: 'spHeat' | 'spCool', fallback: number): number {
    if (!this.currentStatus) {
      return fallback;
    }
    const v = this.currentStatus[field];
    if (v === undefined || v === null || isNaN(v)) {
      return fallback;
    }
    return v;
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue) {
    await this.setThresholdTemperature('spHeat', this.quantize('spHeat', value as number));
  }

  async setCoolingThresholdTemperature(value: CharacteristicValue) {
    await this.setThresholdTemperature('spCool', this.quantize('spCool', value as number));
  }

  /**
   * After a setpoint write lands, read the unit back and publish what it ACTUALLY
   * stored rather than what we asked for.
   *
   * Every success path in this class used to echo the requested value straight to
   * HomeKit, so the tile showed our intent, not the device's state. That is fine
   * while the two agree and quietly wrong when they don't — a value clamped to the
   * unit's own limit, or a write the adapter accepted with HTTP 200 and ignored,
   * both leave the Home app confidently displaying a number the hardware never
   * took. Cheap to close: one extra local read, and only when local control is on.
   *
   * Deliberately fire-and-forget — the setter has already returned to HomeKit and
   * the periodic poll remains the real backstop, so a failed reconcile is a no-op.
   */
  private scheduleSetpointReconcile(field: 'spHeat' | 'spCool'): void {
    const local = this.platform.localClient;
    if (!local || !local.hasLocal(this.deviceSerial)) {
      return; // cloud-only: the next poll reconciles, ~7-10s behind.
    }

    setTimeout(() => {
      void (async () => {
        try {
          const status = await local.getStatus(this.deviceSerial);
          const actual = status?.[field];
          if (typeof actual !== 'number' || isNaN(actual)) {
            return;
          }
          const requested = this.currentStatus?.[field];
          // Compare at the device's 0.1 resolution, so IEEE dirt (22.200001 vs
          // 22.2) is not reported as a disagreement.
          const differs = typeof requested !== 'number' || !sameSetpoint(actual, requested);

          if (differs) {
            this.platform.log.info(
              `[SETPOINT] ${this.accessory.displayName}: device holds ${field}=${actual}°C ` +
              `(${cToF(actual).toFixed(1)}°F), we asked for ${requested}°C — publishing the device's value`,
            );
          }
          if (this.currentStatus) {
            this.currentStatus[field] = actual;
          }
          this.service.updateCharacteristic(
            field === 'spHeat'
              ? this.platform.Characteristic.HeatingThresholdTemperature
              : this.platform.Characteristic.CoolingThresholdTemperature,
            actual,
          );
        } catch {
          // Unreachable adapter mid-reconcile; the poll will catch up.
        }
      })();
    }, this.SETPOINT_RECONCILE_MS);
  }

  /**
   * Snap an inbound setpoint onto the Fahrenheit grid, inside this unit's range.
   *
   * This is the single place quantization happens, and it has to be here rather
   * than in the transport: HAP applies a characteristic's `minStep` only on the
   * OUTBOUND path (validateUserInput). The inbound controller write goes through
   * validateClientSuppliedValue, which range-checks and hands back the float
   * verbatim — so the 0.1 step upstream relied on never constrained what HomeKit
   * actually sent. Upstream then rounded on the LAN transport only, never on the
   * cloud path, so the very same tap stored a different value depending on which
   * transport won the race.
   */
  private quantize(field: 'spHeat' | 'spCool', temp: number): number {
    const p = this.deviceProfile;
    const min = p ? Math.min(p.minimumSetPoints[field === 'spHeat' ? 'heat' : 'cool'], p.minimumSetPoints.auto) : 10;
    const max = p ? Math.max(p.maximumSetPoints[field === 'spHeat' ? 'heat' : 'cool'], p.maximumSetPoints.auto) : 35;
    const q = quantizeSetpointInRange(temp, min, max);
    if (q !== temp) {
      this.platform.log.debug(
        `[SETPOINT] ${this.accessory.displayName}: ${temp}°C -> ${q}°C ` +
        `(${cToF(q).toFixed(0)}°F, snapped to the whole-°F grid)`,
      );
    }
    return q;
  }

  /**
   * Write one edge of the AUTO setpoint band. HomeKit pushes these when the user
   * drags the range handles in AUTO: spHeat is the low/heat bound, spCool the
   * high/cool bound. Mirrors setTargetTemperature — same powered-off guard (the
   * v3 API 400s a bare setpoint on an off unit, see 1.5.2), optimistic echo, and
   * revert-on-failure. spHeat/spCool are always the per-mode setpoints, so this
   * is safe even on the rare out-of-AUTO write.
   */
  private async setThresholdTemperature(field: 'spHeat' | 'spCool', temp: number): Promise<void> {
    const characteristic = field === 'spHeat'
      ? this.platform.Characteristic.HeatingThresholdTemperature
      : this.platform.Characteristic.CoolingThresholdTemperature;
    const label = field === 'spHeat' ? 'AUTO HEAT SP' : 'AUTO COOL SP';

    const tempF = cToF(temp);
    this.platform.log.info(
      `[${label}] ${this.accessory.displayName}: HomeKit sent ${temp.toFixed(1)}°C (${tempF.toFixed(1)}°F)`,
    );

    if (!this.currentStatus) {
      this.platform.log.error(`[${label}] ${this.accessory.displayName}: no current status`);
      return;
    }

    // Don't send a setpoint to a powered-off (or being-turned-off) unit: cache +
    // echo only so the handle holds, without a doomed `modeRequiredWhenDeviceOff`
    // 400 (1.5.2) and without a trailing setpoint reviving a unit an "AC off"
    // scene is turning off (see offRequestedAt / shouldSuppressSetpoint).
    if (this.shouldSuppressSetpoint()) {
      this.platform.log.debug(
        `[${label}] ${this.accessory.displayName}: unit is off / turning off — caching ${temp}°C without sending`,
      );
      this.currentStatus[field] = temp;
      this.service.updateCharacteristic(characteristic, temp);
      return;
    }

    const commands: { spHeat?: number; spCool?: number } = {};
    commands[field] = temp;

    // Hold briefly so an "AC off" dispatched alongside this handle wins
    // regardless of order (see setpointWriteGen). Keyed per field so the two
    // AUTO handles don't supersede each other.
    const hold = await this.holdSetpointWrite(field);
    if (hold === 'superseded') {
      return;
    }
    if (hold === 'suppressed') {
      this.platform.log.debug(
        `[${label}] ${this.accessory.displayName}: unit turned off while held — caching ${temp}°C without sending`,
      );
      if (this.currentStatus) {
        this.currentStatus[field] = temp;
      }
      this.service.updateCharacteristic(characteristic, temp);
      return;
    }

    const success = await this.sendDeviceCommand(commands);

    if (success) {
      this.platform.log.info(`[${label}] ${this.accessory.displayName}: Command accepted by API`);
      this.currentStatus[field] = temp;
      this.service.updateCharacteristic(characteristic, temp);
      // Then confirm against the device rather than trusting our own echo.
      this.scheduleSetpointReconcile(field);
      // Mirror a HomeKit-driven AUTO-handle change to any followers immediately.
      this.notifyStatusListeners();
    } else {
      this.platform.log.error(`[${label}] ${this.accessory.displayName}: Failed to set ${field} to ${temp}`);
      this.revertSoon();
    }
  }


  // ---- Device mirroring (target side) -------------------------------------
  // Driven by the MirrorController when a source unit changes. Reconstructs a
  // single atomic command from the source's desired state, clamped to this unit's
  // own limits — one combined command, so the 1.7.2 trailing-setpoint race cannot
  // recur.

  /** Clamp a setpoint to this unit's supported range for a mode (no-op until profile loads). */
  private clampSetpoint(value: number, mode: 'heat' | 'cool' | 'auto'): number {
    if (typeof value !== 'number' || isNaN(value) || !this.deviceProfile) {
      return value;
    }
    const min = this.deviceProfile.minimumSetPoints[mode];
    const max = this.deviceProfile.maximumSetPoints[mode];
    // Go through the quantizer rather than clamping to the raw bound. The bounds
    // are not generally whole °F (the real profile range 16-31°C is 60.8-87.8°F),
    // so returning one directly would store an off-grid value and put the mirror
    // target a whole displayed degree away from its source. quantizeSetpointInRange
    // clamps by stepping along the °F grid into the range instead. A value already
    // inside the range still gets snapped, which is right: a source running an
    // off-grid setpoint should not propagate that off the grid.
    return quantizeSetpointInRange(
      value,
      typeof min === 'number' ? min : 10,
      typeof max === 'number' ? max : 35,
    );
  }

  /** Collapse a raw source mode to a command mode (autoHeat/autoCool → auto, off if powered off). */
  private normalizeMirrorMode(desired: MirrorState): 'off' | 'heat' | 'cool' | 'auto' | 'dry' | 'vent' {
    if (desired.power === 0 || desired.operationMode === 'off') {
      return 'off';
    }
    const m = desired.operationMode;
    if (this.isAutoMode(m)) {
      return 'auto';
    }
    if (m === 'heat' || m === 'cool' || m === 'dry' || m === 'vent') {
      return m;
    }
    return 'off';
  }

  /**
   * Apply a source unit's state to this (target) unit. One combined command
   * (mode + mode-appropriate setpoint(s) + fan), clamped to this unit's range and
   * guarded against modes it can't do. Sends via the normal local-first path.
   */
  public async applyMirror(desired: MirrorState): Promise<void> {
    const mode = this.normalizeMirrorMode(desired);

    if (mode === 'dry' && this.deviceProfile && !this.deviceProfile.hasModeDry) {
      this.platform.log.warn(`[MIRROR] ${this.accessory.displayName}: target has no dry mode — skipping`);
      return;
    }
    if (mode === 'vent' && this.deviceProfile && !this.deviceProfile.hasModeVent) {
      this.platform.log.warn(`[MIRROR] ${this.accessory.displayName}: target has no vent mode — skipping`);
      return;
    }

    const commands: Commands = { operationMode: mode };
    const fan = desired.fanSpeed;
    if (mode !== 'off' && fan) {
      commands.fanSpeedRaw = fan;
    }
    switch (mode) {
      case 'heat':
        commands.spHeat = this.clampSetpoint(desired.spHeat, 'heat');
        break;
      case 'cool':
        commands.spCool = this.clampSetpoint(desired.spCool, 'cool');
        break;
      case 'auto':
        commands.spHeat = this.clampSetpoint(desired.spHeat, 'auto');
        commands.spCool = this.clampSetpoint(desired.spCool, 'auto');
        break;
      case 'dry':
        commands.power = 1;
        if (this.dryUsesSetpoint()) {
          commands.spCool = this.clampSetpoint(desired.spCool, 'cool');
        }
        break;
      case 'vent':
        commands.power = 1;
        break;
    }

    this.platform.log.info(`[MIRROR] ${this.accessory.displayName}: applying ${JSON.stringify(commands)}`);
    this.noteModeIntent(mode);

    const success = await this.sendDeviceCommand(commands);
    if (!success) {
      this.platform.log.error(`[MIRROR] ${this.accessory.displayName}: mirror command failed`);
      return;
    }

    // Optimistic echo so the tile reflects the mirror immediately; the next poll
    // reconciles authoritatively.
    if (this.currentStatus) {
      this.currentStatus.operationMode = mode;
      this.currentStatus.power = mode === 'off' ? 0 : 1;
      if (commands.spHeat !== undefined) {
        this.currentStatus.spHeat = commands.spHeat;
      }
      if (commands.spCool !== undefined) {
        this.currentStatus.spCool = commands.spCool;
      }
      // Only what was sent: an off mirror carries no fan, and caching the source's
      // speed here would show a speed the target was never given.
      if (commands.fanSpeedRaw) {
        this.currentStatus.fanSpeed = commands.fanSpeedRaw;
      }

      this.refreshClimateCharacteristics();
      // Echo the setpoints through the thresholds — the mirrored value lands on
      // whichever edge(s) the source actually changed.
      if (commands.spHeat !== undefined) {
        this.service.updateCharacteristic(
          this.platform.Characteristic.HeatingThresholdTemperature, commands.spHeat);
      }
      if (commands.spCool !== undefined) {
        this.service.updateCharacteristic(
          this.platform.Characteristic.CoolingThresholdTemperature, commands.spCool);
      }
      if (commands.fanSpeedRaw) {
        this.syncFanCharacteristics(commands.fanSpeedRaw);
      }
    }
  }

  /**
   * Cached only, like every other getter here.
   *
   * This used to fetch GET /devices/{serial}/status on a cold cache and assign the
   * result into this.currentStatus. That payload is the CONNECTION status — the
   * same one getDeviceCryptoSerial reads — and it carries no `operationMode`, so
   * the assignment left a half-populated cache behind. mapToTargetHeaterCoolerState
   * calls isAutoMode(status.operationMode), which is `operationMode.startsWith`, so
   * the very next getTargetHeaterCoolerState threw a TypeError and HomeKit showed
   * the accessory as No Response. Verified by assigning that payload shape and
   * calling the three getters: Active and CurrentHeaterCoolerState survive,
   * TargetHeaterCoolerState throws.
   *
   * Streaming, the cloud poll and the local poll all populate humidity, and the
   * HumiditySensor service is normally created by the first reading that carries
   * one. The cold-cache read is reachable only for a service restored from the
   * accessory cache before the first update lands, where 0 is what the old code
   * returned anyway whenever the fetch came back empty.
   */
  async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    this.assertReachable();
    const humidity = this.currentStatus?.humidity || 0;
    this.platform.log.debug('Get CurrentRelativeHumidity:', humidity);
    return humidity;
  }

  destroy() {
    // Unsubscribe from streaming updates
    this.kumoAPI.unsubscribeFromDevice(this.deviceSerial);
    this.platform.log.debug(`Unsubscribed from streaming updates for ${this.deviceSerial}`);

    // Note: No per-device polling timer to clean up
    // Polling is handled at the platform level
  }
}
