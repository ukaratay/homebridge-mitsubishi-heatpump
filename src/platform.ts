import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import * as os from 'os';

import { PLATFORM_NAME, PLUGIN_NAME, KumoConfig } from './settings';
import { KumoAPI } from './kumo-api';
import { KumoThermostatAccessory } from './accessory';
import { LocalKumoClient, discoverDeviceIps, enumerateSubnet, SerialCreds } from './local-api';
import { MirrorController } from './mirror';

/** How long the initial credential gather waits before falling back to retries. */
const LOCAL_CRED_INITIAL_WAIT_MS = 25000;
/** First retry delay for devices that still owe us local credentials. */
const LOCAL_CRED_RETRY_BASE_MS = 60000;
/** Ceiling for the credential retry backoff. */
const LOCAL_CRED_RETRY_MAX_MS = 1800000; // 30 minutes
/**
 * Consecutive fruitless retry passes before we stop asking. With the doubling
 * backoff the passes land at 1, 3, 7, 15, 31 and 61 minutes after startup, so six
 * passes is roughly an hour of wall time.
 */
const LOCAL_CRED_MAX_FAILED_PASSES = 6;
/** How long each retry pass waits for a nudged device to answer. */
const LOCAL_CRED_RETRY_WAIT_MS = 10000;

/**
 * Check the platform block. Returns the reason it is unusable, or null if it is fine.
 *
 * Separate from the constructor because of what the constructor may NOT do: throw.
 * Homebridge constructs platforms unguarded — `new constructor(...)` in `loadPlatforms()`
 * has no try/catch around it, unlike the plugin lookup either side of it — and an error
 * escaping there rejects `Server.start()`, which the CLI's handler answers by SIGTERMing
 * the process. Every other plugin in the install goes down with it, before the bridge is
 * even published, and hb-service restarts straight back into the same throw. Under a child
 * bridge it is `process.exit(1)` and a restart loop that gives up after five attempts.
 *
 * So there is no such thing as "refuse to start" for one platform here. The choice is
 * between staying idle and taking the whole install down, and a missing password is not
 * grounds for the second. Verified against homebridge 2.2.1 on 2026-08-01, including that
 * a second, unrelated platform plugin never had its constructor called.
 */
export function validatePlatformConfig(config: KumoConfig): string | null {
  if (!config.username || !config.password) {
    return 'Username and password are required in config.';
  }
  if (typeof config.username !== 'string' || !config.username.includes('@')) {
    return 'Username must be a valid email address.';
  }
  if (typeof config.password !== 'string' || config.password.trim().length === 0) {
    return 'Password must be a non-empty string.';
  }
  if (config.pollInterval !== undefined
    && (typeof config.pollInterval !== 'number' || config.pollInterval < 5)) {
    return 'Poll interval must be a number >= 5 seconds.';
  }
  return null;
}

export class KumoV3Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly accessoryHandlers: KumoThermostatAccessory[] = [];
  // One function for the platform's lifetime, so a discovery retry that reaches
  // streaming again does not subscribe twice (the API holds callbacks in a Set).
  private readonly applyDeviceConnection = (serial: string, connected: boolean): void => {
    this.accessoryHandlers.find(h => h.getDeviceSerial() === serial)?.setCloudConnected(connected);
  };
  private readonly kumoAPI: KumoAPI;
  // Read by KumoThermostatAccessory for the per-accessory display options
  // (showDrySwitch / showFanOnlySwitch / exposeVaneSlat).
  public readonly kumoConfig: KumoConfig;
  private readonly sitePollers: Map<string, NodeJS.Timeout> = new Map();
  private readonly siteAccessories: Map<string, KumoThermostatAccessory[]> = new Map();
  private readonly degradedPollInterval: number;
  private readonly normalPollInterval: number;
  private isStreamingHealthy: boolean = false;
  private isDegradedMode: boolean = false;

  // Local LAN control (opt-in). The client is shared with accessories for
  // local-first command routing; the platform drives discovery + status polling.
  public localClient: LocalKumoClient | null = null;
  private localPollTimer: NodeJS.Timeout | null = null;
  private localSerials: string[] = [];
  private localCredRetryTimer: NodeJS.Timeout | null = null;
  private localCredRetryRunning: boolean = false;
  private localCredRetryDelayMs: number = LOCAL_CRED_RETRY_BASE_MS; // doubles per failed pass
  private localCredFailedPasses: number = 0;
  // Set once we stop chasing credentials. In-memory only: config.json is never
  // rewritten, so a restart retries from scratch and local control comes back by
  // itself if the cloud starts serving the credentials again.
  private localCredGaveUp: boolean = false;

  // Device mirroring (opt-in). Constructed once after discovery when `mirror`
  // config is present; makes one unit follow another.
  private mirror: MirrorController | null = null;

  // Hysteresis for mode switching - prevents rapid oscillation on flaky connections
  private readonly modeChangeHysteresisMs: number = 10000; // 10 second stability required
  private pendingModeChange: NodeJS.Timeout | null = null;

  // Discovery retry — self-heals from transient startup failures (e.g. DNS/login blips)
  private discoveryRetryTimer: NodeJS.Timeout | null = null;
  private discoveryRetryDelayMs: number = 30000; // grows via backoff, reset on success
  private readonly discoveryRetryBaseMs: number = 30000; // first retry after 30s
  private readonly discoveryRetryMaxMs: number = 300000; // cap backoff at 5 minutes

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.kumoConfig = config as unknown as KumoConfig;
    this.log.debug('Initializing platform:', this.config.name);

    const kumoConfig = this.kumoConfig;
    const configError = validatePlatformConfig(kumoConfig);

    // Configure degraded mode polling interval
    this.degradedPollInterval = (kumoConfig.degradedPollInterval || 10) * 1000;
    this.normalPollInterval = (kumoConfig.pollInterval || 30) * 1000;
    this.log.debug(`Degraded polling interval: ${this.degradedPollInterval / 1000}s`);

    // Assigned before the bail-out below because `strict` requires every readonly field to
    // be set on every path out of the constructor. Constructing KumoAPI is inert — it sets
    // two flags and logs — so building one that will never be used costs nothing. Streaming
    // is passed as disabled on the error path purely so it does not announce itself.
    this.kumoAPI = new KumoAPI(
      kumoConfig.username,
      kumoConfig.password,
      this.log,
      kumoConfig.debug || false,
      !configError,
    );

    if (configError) {
      this.log.error(
        `${configError} This platform will stay idle until that is fixed in the Homebridge UI. `
        + 'Homebridge and your other plugins are unaffected.',
      );
      return;
    }

    // Configure streaming health monitoring
    const healthCheckInterval = kumoConfig.streamingHealthCheckInterval || 30;
    this.kumoAPI.setStreamingHealthCheckInterval(healthCheckInterval);

    // Register for streaming health changes
    this.kumoAPI.onStreamingHealthChange((isHealthy: boolean) => {
      this.handleStreamingHealthChange(isHealthy);
    });

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      log.debug('Shutting down platform');
      this.cleanup();
    });
  }

  private cleanup() {
    // Cancel any pending discovery retry
    if (this.discoveryRetryTimer) {
      clearTimeout(this.discoveryRetryTimer);
      this.discoveryRetryTimer = null;
    }

    // Stop local polling
    if (this.localPollTimer) {
      clearInterval(this.localPollTimer);
      this.localPollTimer = null;
    }

    // Stop the background local-credential retry
    this.stopLocalCredRetry();

    // Tear down mirroring timers
    if (this.mirror) {
      this.mirror.destroy();
      this.mirror = null;
    }

    // Clean up all site pollers
    this.stopAllPollers();

    // Clean up all accessory handlers
    for (const handler of this.accessoryHandlers) {
      handler.destroy();
    }
    this.accessoryHandlers.length = 0;

    // Clean up API
    this.kumoAPI.destroy();
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices(): Promise<void> {
    const success = await this.attemptDiscovery();

    if (success) {
      // Discovery succeeded: cancel any pending retry and reset the backoff.
      if (this.discoveryRetryTimer) {
        clearTimeout(this.discoveryRetryTimer);
        this.discoveryRetryTimer = null;
      }
      this.discoveryRetryDelayMs = this.discoveryRetryBaseMs;
      return;
    }

    this.scheduleDiscoveryRetry();
  }

  /**
   * Re-run discovery after a transient failure (e.g. a DNS/login blip at startup).
   * Without this, a single failed login left the plugin idle until a manual restart.
   * Backoff grows 30s -> 5min and then retries indefinitely, so the plugin recovers
   * on its own whenever connectivity returns.
   */
  private scheduleDiscoveryRetry(): void {
    if (this.discoveryRetryTimer) {
      return; // a retry is already queued
    }

    const delaySec = Math.round(this.discoveryRetryDelayMs / 1000);
    this.log.warn(`Device discovery did not complete - retrying in ${delaySec}s`);

    this.discoveryRetryTimer = setTimeout(() => {
      this.discoveryRetryTimer = null;
      this.discoverDevices();
    }, this.discoveryRetryDelayMs);

    this.discoveryRetryDelayMs = Math.min(this.discoveryRetryDelayMs * 2, this.discoveryRetryMaxMs);
  }

  private async attemptDiscovery(): Promise<boolean> {
    try {
      this.log.info('Starting device discovery');

      // Login to API
      const loginSuccess = await this.kumoAPI.login();
      if (!loginSuccess) {
        this.log.error('Failed to login to Kumo Cloud API');
        return false;
      }

      // Get all sites
      const sites = await this.kumoAPI.getSites();
      if (sites.length === 0) {
        this.log.warn('No sites found');
        return false;
      }

      this.log.info(`Found ${sites.length} site(s)`);

      const discoveredDevices: Array<{ uuid: string; displayName: string; deviceSerial: string }> = [];

      // For each site, get zones
      for (const site of sites) {
        this.log.debug(`Fetching zones for site: ${site.name}`);
        const zones = await this.kumoAPI.getZones(site.id);

        for (const zone of zones) {
          if (!zone.isActive) {
            this.log.debug(`Skipping inactive zone: ${zone.name}`);
            continue;
          }

          const deviceSerial = zone.adapter.deviceSerial;
          const displayName = zone.name;

          // Skip hidden devices
          if (this.kumoConfig.excludeDevices?.includes(deviceSerial)) {
            this.log.info(`Hiding device from HomeKit: ${displayName} (${deviceSerial})`);
            continue;
          }

          // Generate unique ID for this device
          const uuid = this.api.hap.uuid.generate(deviceSerial);

          discoveredDevices.push({
            uuid,
            displayName,
            deviceSerial,
          });

          this.log.info(`Discovered device: ${displayName} (${deviceSerial})`);

          // Idempotency: a previous (partial) discovery attempt may have already
          // created a handler for this device. Skip it so retries never double-register.
          if (this.accessoryHandlers.some(handler => handler.getDeviceSerial() === deviceSerial)) {
            this.log.debug(`Handler already initialized for ${deviceSerial}, skipping`);
            continue;
          }

          // Check if accessory already exists
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

          if (existingAccessory) {
            // Update existing accessory
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
            existingAccessory.context.device = {
              deviceSerial,
              displayName,
              siteId: site.id,
            };

            // Create accessory handler
            const handler = new KumoThermostatAccessory(this, existingAccessory, this.kumoAPI, this.kumoConfig.pollInterval);
            this.accessoryHandlers.push(handler);

            // Update accessory if needed
            this.api.updatePlatformAccessories([existingAccessory]);
          } else {
            // Create new accessory
            this.log.info('Adding new accessory:', displayName);

            const accessory = new this.api.platformAccessory(displayName, uuid);

            accessory.context.device = {
              deviceSerial,
              displayName,
              siteId: site.id,
            };

            // Create accessory handler
            const handler = new KumoThermostatAccessory(this, accessory, this.kumoAPI, this.kumoConfig.pollInterval);
            this.accessoryHandlers.push(handler);

            // Register accessory
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.accessories.push(accessory);
          }
        }
      }

      // A transient zones-fetch failure returns no zones, leaving this empty.
      // Treat that as a failure and retry rather than unregistering every cached
      // accessory as "stale".
      if (discoveredDevices.length === 0) {
        this.log.warn('No devices discovered - likely a transient API failure; will retry');
        return false;
      }

      // Remove accessories that were not discovered
      const staleAccessories = this.accessories.filter(
        accessory => !discoveredDevices.find(device => device.uuid === accessory.UUID),
      );

      if (staleAccessories.length > 0) {
        this.log.info(`Removing ${staleAccessories.length} stale accessory(ies)`);
        this.api.unregisterPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          staleAccessories,
        );
      }

      this.log.info('Device discovery completed');

      // Start streaming for all devices
      const allDeviceSerials = discoveredDevices.map(d => d.deviceSerial);
      if (allDeviceSerials.length > 0) {
        // Subscribe BEFORE streaming starts so the initial `device_status_v2` burst
        // isn't missed: a unit already offline at boot should come up as No Response
        // rather than serving a stale shadow record as if it were live.
        this.kumoAPI.onDeviceConnectionStatusChange(this.applyDeviceConnection);
        this.log.info('Starting streaming for real-time updates...');
        const streamingStarted = await this.kumoAPI.startStreaming(allDeviceSerials);

        if (streamingStarted) {
          this.log.info('✓ Streaming enabled - devices will update in real-time');
        } else {
          // startStreaming resolves false when the socket did not connect (error or
          // timeout). Nothing will fire a health change in that case - the socket was
          // never healthy to begin with - so this branch has to start the fallback
          // itself. Under `disablePolling: true` it is the only thing that starts any
          // poller at all; the branch used to log this line and poll nothing.
          this.log.warn('Streaming failed to start - falling back to polling');
          this.enterDegradedMode();
        }

        // Log startup configuration summary
        const healthCheckInterval = this.kumoConfig.streamingHealthCheckInterval || 30;

        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log.info('Mitsubishi Comfort Plugin Configuration');
        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log.info(`Streaming: ${streamingStarted ? 'ENABLED' : 'DISABLED'}`);
        this.log.info(`Polling mode: ${this.kumoConfig.disablePolling ? 'On-demand only' : 'Enabled'}`);
        this.log.info(`Normal poll interval: ${this.normalPollInterval / 1000}s`);
        this.log.info(`Degraded poll interval: ${this.degradedPollInterval / 1000}s`);
        this.log.info(`Health check interval: ${healthCheckInterval}s`);
        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (streamingStarted) {
          if (this.kumoConfig.disablePolling) {
            this.log.info('Strategy: Streaming primary, polling fallback only');
          } else {
            this.log.info('Strategy: Streaming primary, polling supplemental');
          }
        }

        // Local LAN control (opt-in). Set up in the background: it waits for the
        // adapter passwords (which arrive via adapter_update after streaming
        // connects), then discovers each unit's IP. Never blocks startup, and
        // cloud streaming stays up as the per-unit fallback.
        if (this.kumoConfig.localControl) {
          this.initLocalControl(allDeviceSerials).catch(err =>
            this.log.error('Local control setup failed:', err));
        }
      }

      // Start site-level polling based on configuration and streaming health
      if (!this.kumoConfig.disablePolling) {
        const siteIds = this.siteIds();
        this.log.info(`Initializing pollers for ${siteIds.length} site(s)`);

        for (const siteId of siteIds) {
          this.startSitePoller(siteId);
        }
      } else {
        this.log.info('Polling disabled - will activate only if streaming fails');
      }

      // Device mirroring (opt-in). Construct once — discovery can retry, so guard
      // on an existing controller to avoid double-registering source listeners.
      if (!this.mirror && this.kumoConfig.mirror && this.kumoConfig.mirror.length > 0) {
        this.mirror = new MirrorController(this.log, this.kumoConfig.mirror, this.accessoryHandlers);
        this.log.info(`Device mirroring enabled for ${this.kumoConfig.mirror.length} pair(s)`);
      }

      return true;
    } catch (error) {
      this.log.error('Error during device discovery:', error);
      return false;
    }
  }

  /**
   * Set up local LAN control: wait for the per-device credentials, resolve each
   * unit's IP (manual override or LAN sweep), and start local status polling.
   * Best-effort and per-device — any unit we can't reach locally simply stays on
   * the cloud path. Runs in the background; never blocks discovery.
   */
  private async initLocalControl(serials: string[]): Promise<void> {
    this.log.info('Local control enabled — gathering credentials...');
    this.localClient = new LocalKumoClient(this.log);
    this.localSerials = serials;

    const creds = await this.gatherLocalCreds(serials, LOCAL_CRED_INITIAL_WAIT_MS);
    if (creds.size > 0) {
      this.log.info(`Local control: credentials for ${creds.size}/${serials.length} device(s)`);
      await this.admitLocalDevices(creds);
    } else {
      this.log.warn('Local control: no credentials obtained yet — staying on cloud for now');
    }

    const localCount = this.countLocalDevices();
    if (localCount > 0) {
      this.log.info(`✓ Local control active for ${localCount}/${serials.length} device(s)`);
      this.startLocalPolling();
    } else {
      this.log.warn('Local control: no devices reachable on the LAN — staying on cloud');
    }

    // Some adapters answer `adapterStatus` slowly (or not at all until they
    // recover from a wedged cloud session), so a fixed startup window silently
    // strands them on the cloud for the life of the process. Keep nudging the
    // stragglers in the background and admit each one the moment its
    // credentials show up. The nudging backs off and eventually gives up: since
    // 2026-07-31 the cloud serves no credentials at all, and an endless retry
    // against that is only noise (see abandonLocalCreds).
    this.scheduleLocalCredRetry();
  }

  /**
   * Nudge each device for its `adapter_update` and collect both halves of the
   * local key (password from the socket, cryptoSerial from REST), giving up
   * after `waitMs`. Only returns entries for devices that yielded both.
   */
  private async gatherLocalCreds(serials: string[], waitMs: number): Promise<Map<string, SerialCreds>> {
    for (const serial of serials) {
      this.kumoAPI.requestAdapterStatus(serial);
    }
    const creds = new Map<string, SerialCreds>();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && creds.size < serials.length) {
      for (const serial of serials) {
        if (creds.has(serial)) {
          continue;
        }
        const password = this.kumoAPI.getAdapterPassword(serial);
        if (!password) {
          continue;
        }
        const cryptoSerial = await this.kumoAPI.getDeviceCryptoSerial(serial);
        if (cryptoSerial) {
          creds.set(serial, { password, cryptoSerial });
        }
      }
      if (creds.size < serials.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        for (const serial of serials) {
          if (!creds.has(serial)) {
            this.kumoAPI.requestAdapterStatus(serial);
          }
        }
      }
    }
    return creds;
  }

  /**
   * Resolve each credentialed device's IP (configured override first, then a LAN
   * sweep for the rest) and hand it to the local client.
   */
  private async admitLocalDevices(creds: Map<string, SerialCreds>): Promise<void> {
    if (!this.localClient) {
      return;
    }
    const manual = this.kumoConfig.localControlIps || {};
    const toDiscover = new Map<string, SerialCreds>();
    for (const [serial, c] of creds) {
      if (manual[serial]) {
        this.localClient.setCreds(serial, { ...c, ip: manual[serial] });
        this.log.info(`Local control: ${serial} -> ${manual[serial]} (configured)`);
      } else {
        toDiscover.set(serial, c);
      }
    }
    if (toDiscover.size === 0) {
      return;
    }
    const hostIp = this.getHostIpv4();
    if (!hostIp) {
      this.log.warn('Local control: could not determine the host LAN subnet for discovery');
      return;
    }
    const candidates = enumerateSubnet(hostIp);
    this.log.info(`Local control: sweeping ${candidates.length} addresses on ${hostIp}'s subnet...`);
    const ips = await discoverDeviceIps(this.log, candidates, toDiscover);
    for (const [serial, ip] of ips) {
      this.localClient.setCreds(serial, { ...toDiscover.get(serial)!, ip });
    }
  }

  private countLocalDevices(): number {
    if (!this.localClient) {
      return 0;
    }
    return this.localSerials.filter(serial => this.localClient!.hasLocal(serial)).length;
  }

  private pendingLocalSerials(): string[] {
    if (!this.localClient) {
      return [];
    }
    return this.localSerials.filter(serial => !this.localClient!.hasLocal(serial));
  }

  /**
   * Background retry for devices that haven't yielded local credentials yet.
   * A nudge is a single socket emit and the expensive part (the LAN sweep) only
   * runs when a device actually hands over its credentials, but a pass re-nudges
   * every pending device every couple of seconds for the length of its window, so
   * a fixed 60s interval against devices that will never answer cost ~1440 emits
   * an hour and never stopped. Same self-scheduling backoff as
   * scheduleDiscoveryRetry: 60s doubling to a 30 minute cap, then give up.
   * Stops early once every device is local.
   */
  private scheduleLocalCredRetry(): void {
    if (this.localCredRetryTimer || this.localCredGaveUp || this.pendingLocalSerials().length === 0) {
      return;
    }
    this.localCredRetryTimer = setTimeout(() => {
      this.localCredRetryTimer = null;
      void this.retryLocalCreds().then(() => this.scheduleLocalCredRetry());
    }, this.localCredRetryDelayMs);

    this.localCredRetryDelayMs = Math.min(this.localCredRetryDelayMs * 2, LOCAL_CRED_RETRY_MAX_MS);
  }

  private async retryLocalCreds(): Promise<void> {
    // A sweep can outlast the delay; never let two passes overlap.
    if (this.localCredRetryRunning || !this.localClient || this.localCredGaveUp) {
      return;
    }
    const pending = this.pendingLocalSerials();
    if (pending.length === 0) {
      this.stopLocalCredRetry();
      return;
    }
    this.localCredRetryRunning = true;
    try {
      const creds = await this.gatherLocalCreds(pending, LOCAL_CRED_RETRY_WAIT_MS);
      if (creds.size === 0) {
        this.log.debug(
          `Local control: still waiting on ${pending.length} device(s) ` +
          `(pass ${this.localCredFailedPasses + 1}/${LOCAL_CRED_MAX_FAILED_PASSES})`,
        );
        this.noteFailedCredPass(pending);
        return;
      }
      // Credentials are flowing again, so restart the backoff at its base delay
      // for whatever is still pending.
      this.localCredFailedPasses = 0;
      this.localCredRetryDelayMs = LOCAL_CRED_RETRY_BASE_MS;
      this.log.info(`Local control: credentials arrived for ${creds.size} more device(s)`);
      await this.admitLocalDevices(creds);
      const localCount = this.countLocalDevices();
      if (localCount > 0) {
        this.log.info(`✓ Local control active for ${localCount}/${this.localSerials.length} device(s)`);
        // No-op if it's already running.
        this.startLocalPolling();
      }
      if (this.pendingLocalSerials().length === 0) {
        this.stopLocalCredRetry();
      }
    } catch (error) {
      this.log.debug(`Local control retry failed: ${(error as Error).message}`);
      this.noteFailedCredPass(pending);
    } finally {
      this.localCredRetryRunning = false;
    }
  }

  /** Count one fruitless pass and stop for good once we hit the ceiling. */
  private noteFailedCredPass(pending: string[]): void {
    this.localCredFailedPasses++;
    if (this.localCredFailedPasses >= LOCAL_CRED_MAX_FAILED_PASSES) {
      this.abandonLocalCreds(pending);
    }
  }

  /**
   * Stop chasing credentials that are not coming, and say so once.
   *
   * Verified 2026-07-31: Mitsubishi's v3 cloud stopped distributing both halves of
   * the local key. `password` is gone from the `adapter_update` socket event and
   * `cryptoSerial` is gone from GET /devices/{serial}/status. Reproduced on
   * unrelated accounts and on a second client stack (pykumo issue #78), so it is a
   * cloud-side change, not a per-account or per-network fault. Retrying forever is
   * noise, and a debug-only line is a silent failure.
   *
   * Nothing is persisted: the give-up flag lives in this process only and the
   * plugin never rewrites config.json, so `localControl` stays true and the next
   * Homebridge restart runs the whole credential gather again. If the cloud starts
   * serving the fields, local control returns with no user action.
   */
  private abandonLocalCreds(pending: string[]): void {
    this.localCredGaveUp = true;
    this.stopLocalCredRetry();

    // With no device on the local path, keeping a client around only makes the
    // plugin present as local-capable: accessory.sendDeviceCommand and
    // scheduleSetpointReconcile evaluate their local guards on every write for a
    // path that cannot work. Drop it so they go straight to the cloud. A partial
    // result (some units local) keeps the client, since those units still work.
    if (this.countLocalDevices() === 0) {
      this.localClient = null;
      if (this.localPollTimer) {
        clearInterval(this.localPollTimer);
        this.localPollTimer = null;
      }
    }

    this.log.warn(
      `Local control unavailable: Kumo Cloud stopped returning the per-device local credentials ` +
      `(the adapter password in adapter_update and cryptoSerial in GET /devices/{serial}/status are ` +
      `both absent), so after ${LOCAL_CRED_MAX_FAILED_PASSES} attempts over about an hour ` +
      `${pending.length} device(s) are using cloud control. This is a cloud-side change, not a ` +
      `problem with your network or your units, and every feature keeps working over the cloud. ` +
      `Set "localControl": false in the Homebridge config to silence this; leaving it true costs ` +
      `nothing and local control resumes on its own at the next restart if the credentials come back.`,
    );
  }

  private stopLocalCredRetry(): void {
    if (this.localCredRetryTimer) {
      clearTimeout(this.localCredRetryTimer);
      this.localCredRetryTimer = null;
    }
  }

  /** Find the host's primary private-LAN IPv4 (to derive the sweep subnet). */
  private getHostIpv4(): string | null {
    const ifaces = os.networkInterfaces();
    let fallback: string | null = null;
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family !== 'IPv4' || ni.internal || ni.address.startsWith('169.254.')) {
          continue;
        }
        // Prefer a private-LAN address (10/8, 192.168/16, 172.16/12) over e.g. a
        // CGNAT/VPN range like Tailscale's 100.64/10.
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) {
          return ni.address;
        }
        fallback = fallback || ni.address;
      }
    }
    return fallback;
  }

  /** Poll the locally-reachable units and feed their status into the accessories. */
  private startLocalPolling(): void {
    if (this.localPollTimer) {
      return;
    }
    const interval = (this.kumoConfig.localPollInterval || 15) * 1000;
    this.log.info(`Local status polling every ${interval / 1000}s`);

    const poll = async () => {
      if (!this.localClient) {
        return;
      }
      for (const handler of this.accessoryHandlers) {
        const serial = handler.getDeviceSerial();
        if (!this.localClient.hasLocal(serial)) {
          continue;
        }
        try {
          const status = await this.localClient.getStatus(serial);
          if (status) {
            handler.updateFromLocal(status);
          }
        } catch (error) {
          this.log.debug(`Local poll error for ${serial}: ${(error as Error).message}`);
        }
      }
    };

    poll();
    this.localPollTimer = setInterval(poll, interval);
  }

  private startSitePoller(siteId: string) {
    // Don't start if already polling
    if (this.sitePollers.has(siteId)) {
      return;
    }

    // If streaming is healthy and polling is disabled, don't start
    if (this.isStreamingHealthy && this.kumoConfig.disablePolling) {
      this.log.info(`Skipping poller for site ${siteId} (streaming healthy, polling disabled)`);
      return;
    }

    const interval = this.currentPollInterval();
    const intervalSec = interval / 1000;
    const mode = this.isDegradedMode ? 'DEGRADED' : 'NORMAL';

    this.log.info(`Starting ${mode} poller for site ${siteId}: ${intervalSec}s intervals`);

    // Group accessories by site for efficient distribution
    const accessories = this.accessoryHandlers.filter(
      handler => handler.getSiteId() === siteId
    );
    this.siteAccessories.set(siteId, accessories);

    // Do immediate poll
    this.pollSite(siteId);

    // Then poll at regular intervals
    const timer = setInterval(() => {
      this.pollSite(siteId);
    }, interval);

    this.sitePollers.set(siteId, timer);
  }

  private async pollSite(siteId: string) {
    try {
      const mode = this.isDegradedMode ? 'DEGRADED' : 'NORMAL';
      const health = this.isStreamingHealthy ? 'healthy' : 'unhealthy';
      this.log.debug(`[${mode}] Polling site ${siteId} (streaming: ${health})`);

      // Fetch all zones for this site
      const zones = await this.kumoAPI.getZones(siteId);

      // A failed fetch returns no zones at all, already logged by getZones. Saying
      // so once beats one "Zone not found" warning per device: degraded polling runs
      // every 10s, and the outage that put us in degraded mode is exactly when every
      // poll comes back empty.
      if (zones.length === 0) {
        this.log.debug(`No zones returned for site ${siteId}`);
        return;
      }

      // Distribute zone data to each accessory
      const accessories = this.siteAccessories.get(siteId) || [];
      for (const handler of accessories) {
        const zone = zones.find(z => z.adapter.deviceSerial === handler.getDeviceSerial());
        if (zone) {
          handler.updateFromZone(zone);
        } else {
          this.log.warn(`Zone not found for device: ${handler.getDeviceSerial()}`);
        }
      }
    } catch (error) {
      this.log.error(`Error polling site ${siteId}:`, error);
    }
  }

  /**
   * Handle streaming health state changes with hysteresis
   *
   * Hysteresis prevents rapid mode switching on flaky connections:
   * - Entering degraded mode: IMMEDIATE (we need polling fallback right away)
   * - Exiting degraded mode: DELAYED (wait for stable connection before stopping polling)
   */
  private handleStreamingHealthChange(isHealthy: boolean): void {
    const wasHealthy = this.isStreamingHealthy;
    this.isStreamingHealthy = isHealthy;

    // If streaming is unhealthy, switch to degraded mode IMMEDIATELY
    // (No hysteresis - we need polling fallback right away)
    //
    // Deliberately not gated on `wasHealthy`: a socket that never connected in the
    // first place has never been healthy, so requiring a healthy->unhealthy edge
    // meant the one case with no updates at all could not reach the fallback.
    // enterDegradedMode is idempotent.
    if (!isHealthy) {
      // Cancel any pending mode change (e.g., pending exit from degraded mode)
      if (this.pendingModeChange) {
        clearTimeout(this.pendingModeChange);
        this.pendingModeChange = null;
        this.log.debug('Cancelled pending mode change due to new disconnect');
      }

      this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.log.warn('⚠ STREAMING INTERRUPTED');
      this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.enterDegradedMode();
    }

    // If streaming became healthy, schedule exit from degraded mode WITH HYSTERESIS
    // (Wait for stable connection before stopping polling fallback)
    if (!wasHealthy && isHealthy) {
      // The only pending change is an exit to healthy, so one pending means this one.
      if (this.pendingModeChange) {
        this.log.debug('Mode change to healthy already pending, waiting for stability...');
        return;
      }

      const hysteresisSec = this.modeChangeHysteresisMs / 1000;
      this.log.info(`Streaming reconnected - waiting ${hysteresisSec}s for stable connection...`);

      this.pendingModeChange = setTimeout(() => {
        this.pendingModeChange = null;

        // Double-check health is still good before switching
        if (this.isStreamingHealthy) {
          this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          this.log.info('✓ STREAMING RESUMED (stable)');
          this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          this.exitDegradedMode();
        } else {
          this.log.warn('Streaming became unhealthy during stability check, staying in degraded mode');
        }
      }, this.modeChangeHysteresisMs);
    }
  }

  /**
   * Enter degraded mode - start/speed up polling
   */
  private enterDegradedMode(): void {
    if (this.isDegradedMode) {
      return; // Already in degraded mode
    }

    this.isDegradedMode = true;

    const intervalSec = this.degradedPollInterval / 1000;
    this.log.warn(`→ Switching to DEGRADED MODE`);
    this.log.warn(`→ Polling activated: ${intervalSec}s intervals`);
    this.log.warn(`→ Updates will continue via API polling`);

    // If polling is disabled, temporarily enable it
    if (this.kumoConfig.disablePolling) {
      this.log.warn('→ Overriding disablePolling setting for fallback');
    }

    // Start (or speed up) a poller for every site. Under `disablePolling: true` none
    // exist yet, so this is the only place they are ever created.
    this.restartAllPollers();
  }

  /**
   * Exit degraded mode - stop or slow down polling
   */
  private exitDegradedMode(): void {
    if (!this.isDegradedMode) {
      return; // Not in degraded mode
    }

    this.isDegradedMode = false;

    // If polling was disabled in config, stop all pollers
    if (this.kumoConfig.disablePolling) {
      this.log.info('→ Returning to NORMAL MODE');
      this.log.info('→ Polling halted (streaming active)');
      this.log.info('→ Updates resume via real-time streaming');
      this.stopAllPollers();
    } else {
      // Otherwise restart with normal interval
      this.log.info('→ Returning to NORMAL MODE');
      this.log.info(`→ Polling reduced to ${this.normalPollInterval / 1000}s intervals`);
      this.log.info('→ Primary updates via streaming');
      this.restartAllPollers();
    }
  }

  /** Every site that has at least one accessory. */
  private siteIds(): string[] {
    return [...new Set(this.accessoryHandlers.map(handler => handler.getSiteId()).filter(Boolean))];
  }

  /** The poll interval for the current mode, in ms. */
  private currentPollInterval(): number {
    return this.isDegradedMode ? this.degradedPollInterval : this.normalPollInterval;
  }

  /**
   * Bring every site's poller up at the current mode's interval, starting the ones
   * that do not exist yet.
   *
   * Starting the missing ones is what makes the degraded-mode fallback real. Under
   * the recommended `disablePolling: true`, discovery never calls startSitePoller,
   * so this map is empty when streaming fails: a "restart all" restarted nothing
   * while logging "0 site poller(s) active", and the fallback polled nothing at all.
   */
  private restartAllPollers(): void {
    for (const siteId of this.siteIds()) {
      const timer = this.sitePollers.get(siteId);
      if (timer) {
        clearInterval(timer);
        this.sitePollers.delete(siteId);
      }
      // startSitePoller derives its interval from isDegradedMode, which both callers
      // set before calling us. It also does its own immediate poll and groups the
      // site's accessories.
      this.startSitePoller(siteId);
    }

    this.log.info(`✓ ${this.sitePollers.size} site poller(s) active at ${this.currentPollInterval() / 1000}s intervals`);
  }

  /**
   * Stop all site pollers
   */
  private stopAllPollers(): void {
    for (const [siteId, timer] of this.sitePollers) {
      clearInterval(timer);
      this.log.debug(`Poller stopped for site ${siteId}`);
    }
    this.sitePollers.clear();
    this.log.info('✓ All polling halted');
  }
}
