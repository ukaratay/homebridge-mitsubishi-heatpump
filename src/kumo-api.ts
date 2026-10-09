import type { Logger } from 'homebridge';
import { io, Socket } from 'socket.io-client';
import {
  API_BASE_URL,
  APP_VERSION,
  TOKEN_REFRESH_INTERVAL,
  SOCKET_BASE_URL,
  LoginResponse,
  Site,
  Zone,
  DeviceStatus,
  DeviceProfile,
  SensorReading,
  Commands,
  CloudCommands,
  SendCommandRequest,
  SendCommandResponse,
  isVaneDirection,
} from './settings';

/**
 * Translate internal Commands to the cloud wire shape. Two renames:
 *  - `fanSpeedRaw` (the mirror path's verbatim adapter string) folds into `fanSpeed`,
 *    which is what the cloud expects. Best-effort — the cloud reports these same
 *    strings, so echoing one back is accepted.
 *  - `vaneDir` (the local field name) becomes `airDirection` (the cloud field name
 *    for the same thing).
 *
 * Throws on an out-of-vocabulary vane direction, matching buildLocalCommandBody.
 * Both write boundaries must validate: a bad value that merely fell through the
 * local transport would otherwise be retried against the cloud by the local-first
 * fallback in accessory.sendDeviceCommand, and reach the hardware anyway.
 *
 * Returns the input unchanged when there is nothing to translate.
 */
export function toCloudCommands(commands: Commands): CloudCommands {
  if (commands.fanSpeedRaw === undefined && commands.vaneDir === undefined) {
    return commands;
  }
  const { fanSpeedRaw, vaneDir, ...rest } = commands;
  const wire: CloudCommands = { ...rest };
  if (fanSpeedRaw !== undefined && wire.fanSpeed === undefined) {
    wire.fanSpeed = fanSpeedRaw;
  }
  if (vaneDir !== undefined) {
    if (!isVaneDirection(vaneDir)) {
      throw new Error(`Invalid vane direction "${vaneDir}" — the cloud would accept and ignore it`);
    }
    wire.airDirection = vaneDir;
  }
  return wire;
}

// Event callback types
export type DeviceUpdateCallback = (deviceSerial: string, status: Partial<DeviceStatus>) => void;
export type DeviceConnectionCallback = (deviceSerial: string, connected: boolean) => void;
export type DeviceProfileCallback = (deviceSerial: string, profile: DeviceProfile) => void;
export type SensorUpdateCallback = (reading: SensorReading) => void;

/**
 * Accept a value only if it really is a finite number; anything else becomes null.
 *
 * The `sensor_update` payload is not schema-checked by us and the cloud has already
 * demonstrated it will drop fields without notice (see the local-credential outage
 * documented on SensorReading). A string, null, or absent field must not reach a
 * consumer as if it were a reading — null is the honest answer, and NaN/Infinity are
 * rejected too since either would poison a temperature straight onto the tile.
 */
function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A device serial worth subscribing to: a non-blank string. */
function isValidSerial(serial: unknown): serial is string {
  return typeof serial === 'string' && serial.trim().length > 0;
}

/**
 * The message to log for a failed request, with the reason the transport buried.
 *
 * Undici — which is what the global `fetch` is — reports every network failure as the
 * literal string `fetch failed` and hangs the real reason off `error.cause`. node-fetch
 * used to inline it (`request to http://… failed, reason: connect ECONNREFUSED …`), so
 * moving to the built-in fetch silently reduced every one of these log lines to two
 * useless words. The cloud is the only transport with live users, so this is the line
 * someone gets sent when the plugin stops working.
 */
export function describeRequestError(error: Error): string {
  // Cast rather than raise the tsconfig target: `Error.cause` is only in the es2022 lib,
  // and the property is present at runtime on every Node this package supports.
  const cause = (error as Error & { cause?: unknown }).cause;
  const reason = cause instanceof Error ? cause.message : undefined;
  return reason && reason !== error.message ? `${error.message}: ${reason}` : error.message;
}

export class KumoAPI {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private debugMode: boolean = false;
  private refreshInProgress: Promise<boolean> | null = null;

  // Streaming properties
  private socket: Socket | null = null;
  private streamingEnabled: boolean = true;
  private deviceUpdateCallbacks: Map<string, DeviceUpdateCallback> = new Map();
  // Last `device_status_v2` verdict per serial, so listeners hear only changes.
  private deviceConnectionStatus: Map<string, boolean> = new Map();
  private deviceConnectionCallbacks: Set<DeviceConnectionCallback> = new Set();

  // Device profiles, delivered to the accessories via `profile_update`.
  private deviceProfileCallbacks: Set<DeviceProfileCallback> = new Set();

  // Local-control credentials: on v3 the per-device local password arrives only in the
  // `adapter_update` Socket.IO event, never via REST. We capture it here for the local
  // LAN transport (paired with the cryptoSerial from /devices/{serial}/status).
  //
  // "Never via REST" is true of v3 and only of v3. The legacy v2 login (`geo-c`, what
  // pykumo and Home Assistant read) reportedly still returns every adapter's password and
  // cryptoSerial over plain REST — upstream homebridge-mitsubishi-comfort v1.8.3 verified
  // that on 2026-07-28, before the v3 fields disappeared, and treats the result as a
  // candidate rather than truth because the v2 store can be stale enough that the adapter
  // answers device_authentication_error. This plugin does not read v2.
  private adapterPasswords: Map<string, string> = new Map();

  // Paired wireless sensor readings, via the `sensor_update` event.
  private sensorUpdateCallbacks: Set<SensorUpdateCallback> = new Set();

  // Local-credential outage detection. Since 2026-07-31 the cloud has been sending
  // `adapter_update` without `password` and `/devices/{serial}/status` without
  // `cryptoSerial`, which silently disables local control. Each cause warns exactly
  // once — these events arrive continuously, so an unlatched warning would flood the
  // log. The password counter is consecutive, so a single odd event (an adapter_update
  // that legitimately carries no credential) does not trip it.
  private adapterUpdatesWithoutPassword: number = 0;
  private warnedNoAdapterPassword: boolean = false;
  private warnedNoCryptoSerial: boolean = false;

  // Streaming health tracking
  private streamingHealthCallbacks: Set<(isHealthy: boolean) => void> = new Set();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private streamingHealthCheckInterval: number = 30000; // 30s default
  private isStreamingHealthy: boolean = false;
  private isReconnecting: boolean = false; // Suppresses health notifications during planned reconnects
  // Zombie-stream detection. checkStreamingHealth() only asks "is the socket
  // connected?" — it can't see a stream that stays connected while its device_update
  // subscription silently dies. The cloud only pushes device_update on real state
  // change, so a long device_update silence is ambiguous (idle vs zombie); an active
  // status nudge disambiguates. See checkStreamingLiveness().
  private lastDeviceUpdateTs: number = 0;
  private probePendingSince: number = 0; // when the current status nudge was sent (0 = none pending)
  private lastZombieReconnectTs: number = 0;
  private forceStatusOnNextConnect: boolean = false;
  private static readonly PROBE_AFTER_MS = 300000; // 5 min of device_update silence → nudge for status
  private static readonly PROBE_GRACE_MS = 150000; // 2.5 min for ANY device to answer the nudge (adapters: 6–65s)
  private static readonly ZOMBIE_RECONNECT_COOLDOWN_MS = 300000; // ≥5 min between zombie reconnects

  // Rate limiting and retry tracking
  private refreshRetryCount: number = 0;
  private lastRefreshAttempt: number = 0;
  private loginRetryCount: number = 0;
  private lastLoginAttempt: number = 0;
  private readonly maxRetryAttempts: number = 5;
  private readonly baseRetryDelay: number = 5000; // 5 seconds
  private readonly minLoginInterval: number = 10000; // Minimum 10 seconds between login attempts
  // Re-arm delay after a refresh that failed outright. Short on purpose: by then the
  // token is already inside its 5 minute expiry buffer.
  private readonly refreshRetryDelay: number = 60000; // 60 seconds
  // Ceiling on how long startStreaming waits for the socket to come up before
  // reporting failure. Matches the socket.io connection timeout below.
  private readonly socketConnectTimeout: number = 20000; // 20 seconds

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
    debug: boolean = false,
    enableStreaming: boolean = true,
  ) {
    this.debugMode = debug;
    this.streamingEnabled = enableStreaming;
    if (this.debugMode) {
      this.log.info('Debug mode enabled');
      this.log.warn('Debug mode may log sensitive information - use only for troubleshooting');
    }
    if (this.streamingEnabled) {
      this.log.info('Streaming mode enabled - real-time updates will be used');
    }
  }

  private maskToken(token: string | null): string {
    if (!token) {
      return 'null';
    }
    if (token.length <= 8) {
      return '***';
    }
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  }

  async login(): Promise<boolean> {
    // Enforce minimum interval between login attempts to avoid rate limiting
    const timeSinceLastLogin = Date.now() - this.lastLoginAttempt;
    if (this.lastLoginAttempt > 0 && timeSinceLastLogin < this.minLoginInterval) {
      const waitTime = this.minLoginInterval - timeSinceLastLogin;
      this.log.warn(`Rate limit protection: waiting ${Math.round(waitTime / 1000)}s before login attempt`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastLoginAttempt = Date.now();

    try {
      this.log.debug('Attempting to login to Kumo Cloud API');

      const response = await fetch(`${API_BASE_URL}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-App-Version': APP_VERSION,
        },
        body: JSON.stringify({
          username: this.username,
          password: this.password,
          appVersion: APP_VERSION,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();

        // A credential error here may be a lie. Under login rate limiting the v3 API
        // does not always answer 429 — it also returns `{"error":
        // "usernameOrPasswordIncorrect"}` for credentials that are perfectly valid,
        // and keeps doing so for 15-30 minutes. Anyone debugging "my password stopped
        // working" after a burst of restarts is most likely looking at this. It is why
        // login attempts are spaced by `minLoginInterval` and token refresh carries
        // jitter, rather than retrying as fast as the transport allows.
        // Handle rate limiting
        if (response.status === 429) {
          this.loginRetryCount++;
          this.log.error(`Login rate limited (429). Retry count: ${this.loginRetryCount}`);

          if (this.loginRetryCount >= this.maxRetryAttempts) {
            this.log.error(`Login retry limit reached (${this.maxRetryAttempts} attempts). Giving up.`);
            this.loginRetryCount = 0;
            return false;
          }

          // Wait with exponential backoff before retrying
          const backoffDelay = Math.min(
            this.baseRetryDelay * Math.pow(2, this.loginRetryCount),
            120000, // Cap at 2 minutes
          );
          this.log.warn(`Retrying login in ${Math.round(backoffDelay / 1000)}s...`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          return await this.login();
        }

        this.log.error(`Login failed with status: ${response.status}`);
        // Only log response body in debug mode, as it may contain sensitive info
        if (this.debugMode && errorText) {
          this.log.debug(`Login error response: ${errorText}`);
        }
        this.loginRetryCount = 0;
        return false;
      }

      const data = await response.json() as LoginResponse;

      this.accessToken = data.token.access;
      this.refreshToken = data.token.refresh;

      // Track if this was a recovery scenario (for streaming reconnect)
      const wasRecovery = this.loginRetryCount > 0 || this.refreshRetryCount > 0 || this.socket?.connected;

      // Log recovery from rate limiting at INFO level
      if (this.loginRetryCount > 0) {
        this.log.info(`Login recovered after ${this.loginRetryCount} retry attempt(s)`);
      } else {
        this.log.info('Successfully logged in to Kumo Cloud API');
      }

      // Reset retry counters on successful login
      this.loginRetryCount = 0;
      this.refreshRetryCount = 0;

      // JWT tokens expire in 20 minutes, we'll refresh at 15 minutes (20 min - 5 min buffer)
      this.tokenExpiresAt = Date.now() + TOKEN_REFRESH_INTERVAL;

      // Reconnect streaming if this was a recovery (re-login after failures)
      // The old token is now invalid, so we need fresh connection
      if (wasRecovery) {
        await this.reconnectStreaming();
      }

      // Set up automatic token refresh
      this.scheduleTokenRefresh();

      return true;
    } catch (error) {
      this.logRequestError('Login error', error);
      this.loginRetryCount = 0;
      return false;
    }
  }

  /**
   * Arm the next token refresh. `delayMs` overrides the normal 15 minute schedule
   * and is used to retry after a refresh that failed outright.
   */
  private scheduleTokenRefresh(delayMs?: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    // Schedule refresh 5 minutes before expiry (TOKEN_REFRESH_INTERVAL is 20 min, so this is at 15 min mark)
    // Add random jitter (0-60 seconds) to avoid predictable timing that triggers rate limits
    const baseRefreshIn = TOKEN_REFRESH_INTERVAL - (5 * 60 * 1000);
    const jitter = Math.floor(Math.random() * 60000); // 0-60 seconds random jitter
    const refreshIn = delayMs ?? baseRefreshIn + jitter;

    this.log.debug(`Token refresh scheduled in ${Math.round(refreshIn / 1000)}s`);

    this.refreshTimer = setTimeout(async () => {
      const refreshed = await this.refreshAccessToken();
      if (!refreshed) {
        // The other two scheduleTokenRefresh call sites are both on success paths
        // (login, and refreshAccessToken's own), so without this re-arm one failed
        // refresh ends the chain for the life of the process. With
        // `disablePolling: true` there is no REST traffic left to drive
        // ensureAuthenticated either, so a partition outlasting the 20 minute token
        // lifetime left the plugin unauthenticated until Homebridge was restarted.
        this.log.warn(`Token refresh failed - retrying in ${Math.round(this.refreshRetryDelay / 1000)}s`);
        this.scheduleTokenRefresh(this.refreshRetryDelay);
      }
    }, refreshIn);
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) {
      this.log.error('No refresh token available, need to login again');
      return await this.login();
    }

    // Check if we need to wait due to rate limiting
    const timeSinceLastAttempt = Date.now() - this.lastRefreshAttempt;
    if (this.refreshRetryCount > 0) {
      const backoffDelay = Math.min(
        this.baseRetryDelay * Math.pow(2, this.refreshRetryCount - 1),
        60000, // Cap at 60 seconds
      );

      if (timeSinceLastAttempt < backoffDelay) {
        const waitTime = backoffDelay - timeSinceLastAttempt;
        this.log.warn(`Rate limit backoff: waiting ${Math.round(waitTime / 1000)}s before retry attempt ${this.refreshRetryCount + 1}/${this.maxRetryAttempts}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    this.lastRefreshAttempt = Date.now();

    try {
      this.log.debug('Refreshing access token');
      if (this.debugMode) {
        this.log.debug(`Refresh token (masked): ${this.maskToken(this.refreshToken)}`);
        this.log.debug(`Token expires at: ${new Date(this.tokenExpiresAt).toISOString()}`);
      }

      const response = await fetch(`${API_BASE_URL}/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-App-Version': APP_VERSION,
        },
        body: JSON.stringify({
          refresh: this.refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log.warn(`Token refresh failed (${response.status}): ${errorText}`);

        // Handle rate limiting specifically
        if (response.status === 429) {
          this.refreshRetryCount++;

          if (this.refreshRetryCount >= this.maxRetryAttempts) {
            this.log.error(`Rate limit retry limit reached (${this.maxRetryAttempts} attempts). Falling back to full login.`);
            this.refreshRetryCount = 0; // Reset for next cycle
            return await this.login();
          }

          // Retry with exponential backoff
          this.log.warn(`Rate limited. Will retry with exponential backoff (attempt ${this.refreshRetryCount}/${this.maxRetryAttempts})`);
          return await this.refreshAccessToken();
        }

        // For other errors, attempt full login
        this.log.warn('Attempting full login');
        this.refreshRetryCount = 0;
        return await this.login();
      }

      const data = await response.json() as any;

      // The refresh endpoint returns tokens directly, not nested under 'token'
      this.accessToken = data.access;
      this.refreshToken = data.refresh;
      this.tokenExpiresAt = Date.now() + TOKEN_REFRESH_INTERVAL;

      // Log recovery from rate limiting at INFO level (not just debug)
      if (this.refreshRetryCount > 0) {
        this.log.info(`Token refresh recovered after ${this.refreshRetryCount} retry attempt(s)`);
      } else {
        this.log.debug('Access token refreshed successfully');
      }
      if (this.debugMode) {
        this.log.debug(`New access token (masked): ${this.maskToken(this.accessToken)}`);
        this.log.debug(`New token expires at: ${new Date(this.tokenExpiresAt).toISOString()}`);
      }

      // Reset retry count on success
      this.refreshRetryCount = 0;

      // Always reconnect streaming after token refresh to ensure socket uses fresh token
      // Socket.IO connection headers are set at connection time, so we need to reconnect
      // to use the new token (otherwise socket would keep using the old, expired token)
      await this.reconnectStreaming();

      // Schedule next refresh
      this.scheduleTokenRefresh();

      return true;
    } catch (error) {
      this.logRequestError('Token refresh error', error);
      this.refreshRetryCount = 0;
      this.log.warn('Falling back to full login after refresh error');
      return await this.login();
    }
  }

  private async ensureAuthenticated(): Promise<boolean> {
    // If no token or token is about to expire, refresh it
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt - (5 * 60 * 1000)) {
      // If a refresh is already in progress, wait for it instead of starting a new one
      if (this.refreshInProgress) {
        this.log.debug('Waiting for existing token refresh to complete');
        return await this.refreshInProgress;
      }

      // Start a new refresh and store the promise
      this.refreshInProgress = (async () => {
        try {
          if (!this.refreshToken) {
            return await this.login();
          }
          return await this.refreshAccessToken();
        } finally {
          // Clear the lock when done
          this.refreshInProgress = null;
        }
      })();

      return await this.refreshInProgress;
    }
    return true;
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-App-Version': APP_VERSION,
    };
  }

  private async makeAuthenticatedRequest<T>(
    endpoint: string,
    method: string = 'GET',
    body?: unknown,
  ): Promise<T | null> {
    // Ensure we have a valid token
    const authenticated = await this.ensureAuthenticated();
    if (!authenticated) {
      this.log.error('Failed to authenticate');
      return null;
    }

    try {
      const options: RequestInit = {
        method,
        headers: this.getAuthHeaders(),
      };

      if (body) {
        options.body = JSON.stringify(body);
      }

      const url = `${API_BASE_URL}${endpoint}`;

      // Debug logging: Show request details
      if (this.debugMode) {
        this.log.info(`→ API Request: ${method} ${endpoint}`);
        if (body) {
          this.log.info(`  Body: ${JSON.stringify(body)}`);
        }
      }

      const startTime = Date.now();
      const response = await fetch(url, options);
      const duration = Date.now() - startTime;

      // Handle 401 by refreshing token and retrying once
      if (response.status === 401) {
        this.log.debug('Received 401, refreshing token and retrying');
        const refreshed = await this.refreshAccessToken();
        if (!refreshed) {
          return null;
        }

        // Retry request with new token
        options.headers = this.getAuthHeaders();
        const retryResponse = await fetch(`${API_BASE_URL}${endpoint}`, options);
        if (!retryResponse.ok) {
          this.log.error(`Request failed after retry: ${retryResponse.status}`);
          return null;
        }

        return await retryResponse.json() as T;
      }

      if (!response.ok) {
        this.log.error(`Request failed with status: ${response.status}`);
        const errorText = await response.text();
        // Always log 400 errors to see API validation messages
        if (this.debugMode || response.status === 400) {
          this.log.error(`  Error response: ${errorText}`);
        }
        return null;
      }

      const data = await response.json() as T;

      // Debug logging: Show response summary
      if (this.debugMode) {
        this.log.info(`← API Response: ${response.status} (${duration}ms)`);
        // For array responses, show count; for objects, show keys
        if (Array.isArray(data)) {
          this.log.info(`  Returned ${data.length} item(s)`);
        } else if (data && typeof data === 'object') {
          this.log.info(`  Keys: ${Object.keys(data).join(', ')}`);
        }
      }

      return data;
    } catch (error) {
      this.logRequestError('Request error', error);
      return null;
    }
  }

  /** Log a failed request without exposing sensitive details; the stack only in debug. */
  private logRequestError(context: string, error: unknown): void {
    if (error instanceof Error) {
      this.log.error(`${context}:`, describeRequestError(error));
      if (this.debugMode) {
        this.log.debug(`${context} stack:`, error.stack);
      }
    } else {
      this.log.error(`${context}: Unknown error occurred`);
    }
  }

  async getSites(): Promise<Site[]> {
    this.log.debug('Fetching sites');
    const sites = await this.makeAuthenticatedRequest<Site[]>('/sites');
    return sites || [];
  }

  async getZones(siteId: string): Promise<Zone[]> {
    const zones = await this.makeAuthenticatedRequest<Zone[]>(`/sites/${siteId}/zones`);
    if (!zones) {
      return [];
    }

    if (this.debugMode) {
      this.log.info(`  Fetched ${zones.length} zone(s) for site ${siteId}`);

      // Log raw JSON for each zone to see all available fields
      zones.forEach(zone => {
        this.log.info(`  RAW Zone JSON for ${zone.name}:`);
        this.log.info(JSON.stringify(zone, null, 2));
      });

      zones.forEach(zone => {
        const a = zone.adapter;
        this.log.info(`    ${zone.name} [${a.deviceSerial}]`);
        this.log.info(`      Temperature: ${a.roomTemp}°C (current) → Heat: ${a.spHeat}°C, Cool: ${a.spCool}°C, Auto: ${a.spAuto}°C`);
        this.log.info(`      Status: ${a.operationMode} mode, power=${a.power}, connected=${a.connected}`);
        // Fan speed and vane direction are NOT in the zones payload — this line
        // used to print "Fan: undefined, Direction: undefined" for every unit on
        // every poll, which read as "the cloud does not expose vane data" and is
        // why upstream issue #6 stalled. They are real fields, just on other
        // endpoints: the streaming `device_update` event and `GET /devices/{serial}`.
        // Only claim them here when the payload actually carried them.
        const fan = a.fanSpeed ?? 'n/a (not in zones payload)';
        const vane = a.airDirection ?? 'n/a (not in zones payload)';
        this.log.info(`      Fan: ${fan}, Direction: ${vane}, Humidity: ${a.humidity !== null ? a.humidity + '%' : 'N/A'}`);
        this.log.info(`      Signal: ${a.rssi !== undefined ? a.rssi + ' dBm' : 'N/A'}`);
      });
    }

    return zones;
  }

  async sendCommand(deviceSerial: string, commands: Commands): Promise<boolean> {
    const wire = toCloudCommands(commands);
    this.log.debug(`Sending command to device ${deviceSerial}:`, JSON.stringify(wire));

    const request: SendCommandRequest = {
      deviceSerial,
      commands: wire,
    };

    const response = await this.makeAuthenticatedRequest<SendCommandResponse>(
      '/devices/send-command',
      'POST',
      request,
    );

    if (!response) {
      this.log.error(`Send command failed: no response from API for device ${deviceSerial}`);
      return false;
    }

    // The API returns { devices: ["serialNumber"] } on success
    if (!response.devices || !Array.isArray(response.devices)) {
      this.log.error(`Send command failed: unexpected response format for device ${deviceSerial}`);
      if (this.debugMode) {
        this.log.debug(`Response:`, JSON.stringify(response));
      }
      return false;
    }

    // Check if our device is in the response
    if (!response.devices.includes(deviceSerial)) {
      this.log.error(`Send command failed: device ${deviceSerial} not in response devices list`);
      return false;
    }

    this.log.debug(`Command sent successfully to device ${deviceSerial}`);
    return true;
  }

  // Streaming methods

  async startStreaming(deviceSerials: string[]): Promise<boolean> {
    if (!this.streamingEnabled) {
      this.log.debug('Streaming is disabled, skipping connection');
      return false;
    }

    if (this.socket?.connected) {
      this.log.debug('Streaming already connected');
      return true;
    }

    if (!this.accessToken) {
      this.log.error('Cannot start streaming: not authenticated');
      return false;
    }

    for (const bad of deviceSerials.filter(serial => !isValidSerial(serial))) {
      this.log.warn(`Skipping invalid device serial: ${bad}`);
    }
    deviceSerials = deviceSerials.filter(isValidSerial);

    try {
      // Use debug level for routine reconnects (token refresh), info for initial connection
      const logLevel = this.isReconnecting ? 'debug' : 'info';
      this.log[logLevel]('Starting streaming connection...');

      this.socket = io(SOCKET_BASE_URL, {
        transports: ['polling', 'websocket'],
        timeout: this.socketConnectTimeout,
        extraHeaders: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': '*/*',
          'User-Agent': 'kumocloud/1122',
        },
      });

      // Resolve on the first of connect / connect_error / timeout. Returning true as
      // soon as the socket object existed reported a socket that never connected as a
      // working stream: the platform logged "Streaming enabled" and, under
      // `disablePolling: true`, then started no poller at all. Socket.IO keeps
      // retrying underneath either way, so a false here means "not up yet", not
      // "gone": the connect handler below reports recovery.
      const connected = new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (isConnected: boolean): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(connectTimer);
          resolve(isConnected);
        };
        const connectTimer = setTimeout(() => {
          this.log.warn(`Streaming did not connect within ${this.socketConnectTimeout / 1000}s`);
          settle(false);
        }, this.socketConnectTimeout);
        this.socket?.once('connect', () => settle(true));
        this.socket?.once('connect_error', () => settle(false));
      });

      this.socket.on('connect', () => {
        // Use debug level for routine reconnects, info for initial connection
        const isRoutineReconnect = this.isReconnecting;

        if (isRoutineReconnect) {
          this.log.debug(`Streaming reconnected (ID: ${this.socket?.id})`);
        } else {
          this.log.info(`✓ Streaming connected (ID: ${this.socket?.id})`);
        }

        // Subscribe to all devices
        for (const deviceSerial of deviceSerials) {
          this.log.debug(`Subscribing to device: ${deviceSerial}`);
          this.socket?.emit('subscribe', deviceSerial);
        }

        // Mark as healthy and start health checks
        this.isStreamingHealthy = true;
        this.notifyHealthChange(false, true);
        this.startHealthChecks();

        // Seed the zombie-detection clock so a freshly (re)connected socket gets a
        // full grace period before checkStreamingLiveness() can nudge, and clear any
        // probe that was mid-flight against the old socket.
        this.lastDeviceUpdateTs = Date.now();
        this.probePendingSince = 0;

        // Account-level subscribe (required for adapter_update events)
        const userId = this.getUserIdFromToken();
        if (userId) {
          this.log.debug(`Account-level subscribe with user ID: ${userId}`);
          this.socket?.emit('subscribe', '', userId);
        }

        // On initial connection — or when recovering from a zombie stream — request
        // device profiles and status. The zombie path (forceStatusOnNextConnect) must
        // re-issue these nudges so device_update actually resumes; a plain routine
        // (token-refresh) reconnect skips them since the stream was already live.
        if (!isRoutineReconnect || this.forceStatusOnNextConnect) {
          for (const deviceSerial of deviceSerials) {
            this.socket?.emit('force_adapter_request', deviceSerial, 'iuStatus');
            this.socket?.emit('force_adapter_request', deviceSerial, 'profile');
            this.socket?.emit('force_adapter_request', deviceSerial, 'adapterStatus');
          }
          // Request connection status for all devices
          this.socket?.emit('device_status_v2', '');
          for (const deviceSerial of deviceSerials) {
            this.socket?.emit('device_status_v2', deviceSerial);
          }
        }
        this.forceStatusOnNextConnect = false;

        // LOG: Streaming started (only for initial connection)
        if (!isRoutineReconnect) {
          this.log.info('✓ Streaming connection established');
          this.log.info(`Monitoring ${deviceSerials.length} device(s) for real-time updates`);
        }
      });

      this.socket.on('device_update', (data: any) => {
        this.lastDeviceUpdateTs = Date.now();
        const deviceSerial = data.deviceSerial;
        if (!deviceSerial) {
          return;
        }

        if (this.debugMode) {
          this.log.debug(`Stream update for ${deviceSerial}: temp=${data.roomTemp}°C, mode=${data.operationMode}, power=${data.power}`);
          this.log.debug(`Stream update detail: ${JSON.stringify(data)}`);
        }

        // Trigger callbacks for this device. Guarded like sensor_update below: this
        // is the highest-traffic event and its consumer dereferences
        // `getService(...)!` on a payload nobody schema-checks, so an unguarded throw
        // would escape into socket.io's emit loop and could take down the listener
        // for every other event on this socket.
        const callback = this.deviceUpdateCallbacks.get(deviceSerial);
        if (callback) {
          this.safeCall(`Device update callback error for ${deviceSerial}`, () => callback(deviceSerial, data));
        }
      });

      // Additional event listeners for richer device data
      this.socket.on('adapter_update', (data: any) => {
        const serial = data.deviceSerial || 'unknown';
        // Strip password before logging
        const { password, ...safeData } = data;
        // Capture the local password for the LAN transport (it appears ONLY here,
        // never in a REST response). Keep stripping it from all log output.
        if (data.deviceSerial && password) {
          this.adapterUpdatesWithoutPassword = 0;
          this.adapterPasswords.set(data.deviceSerial, password);
        } else if (data.deviceSerial) {
          // An adapter_update for a real device that carried no password at all.
          // Three in a row is the cloud having stopped sending it, not a one-off.
          this.adapterUpdatesWithoutPassword++;
          if (this.adapterUpdatesWithoutPassword >= 3 && !this.warnedNoAdapterPassword) {
            this.warnedNoAdapterPassword = true;
            this.log.warn(
              'Kumo cloud has stopped sending the per-device local password in adapter_update, so '
              + 'local LAN control cannot authenticate and the plugin is using cloud control. This '
              + 'is a cloud-side change, not a problem with your network or config. Set '
              + 'localControl: false to silence this.',
            );
          }
        }
        this.log.debug(`Adapter update for ${serial}: fw=${safeData.firmwareVersion}, rssi=${safeData.routerRssi}`);
        if (this.debugMode) {
          this.log.debug(`Adapter update detail: ${JSON.stringify(safeData)}`);
        }
      });

      // Adapter reachability. The platform turns a disconnect into No Response in
      // HomeKit (accessory.ts:setCloudConnected).
      this.socket.on('device_status_v2', (data: any) => {
        const serial = data.deviceSerial;
        if (!serial) {
          return;
        }
        const isConnected = data.status !== 'disconnected';
        const wasConnected = this.deviceConnectionStatus.get(serial);
        this.deviceConnectionStatus.set(serial, isConnected);

        if (!isConnected) {
          this.log.warn(`Device ${serial} reported offline (reason: ${data.lastDisconnectedReason || 'unknown'})`);
        } else {
          this.log.debug(`Device status for ${serial}: ${data.status}`);
        }

        if (wasConnected !== isConnected) {
          for (const callback of this.deviceConnectionCallbacks) {
            this.safeCall(`Connection status callback error for ${serial}`, () => callback(serial, isConnected));
          }
        }
      });

      this.socket.on('profile_update', (data: any) => {
        const serial = data.deviceSerial;
        if (!serial) {
          return;
        }

        const profile: DeviceProfile = {
          numberOfFanSpeeds: data.numberOfFanSpeeds ?? 3,
          hasFanSpeedAuto: data.hasFanSpeedAuto ?? true,
          hasModeDry: data.hasModeDry ?? false,
          usesSetPointInDryMode: data.usesSetPointInDryMode ?? false,
          hasModeHeat: data.hasModeHeat ?? true,
          hasModeVent: data.hasModeVent ?? false,
          hasVaneDir: data.hasVaneDir ?? false,
          hasVaneSwing: data.hasVaneSwing ?? false,
          hasDefrost: data.hasDefrost ?? false,
          hasStandby: data.hasStandby ?? false,
          minimumSetPoints: data.minimumSetPoints ?? { cool: 16, heat: 16, auto: 16 },
          maximumSetPoints: data.maximumSetPoints ?? { cool: 31, heat: 31, auto: 31 },
        };

        this.log.debug(`Profile for ${serial}: temp range ${JSON.stringify(profile.minimumSetPoints)}-${JSON.stringify(profile.maximumSetPoints)}, fans=${profile.numberOfFanSpeeds}`);

        // Guarded per callback: one accessory throwing while applying a profile must
        // not skip the remaining accessories, and must not escape into socket.io's
        // emit loop.
        for (const callback of this.deviceProfileCallbacks) {
          this.safeCall(`Profile update callback error for ${serial}`, () => callback(serial, profile));
        }
      });

      this.socket.on('acoil_update', (data: any) => {
        const serial = data.deviceSerial || 'unknown';
        this.log.debug(`A-coil update for ${serial}`);
      });

      // A paired wireless sensor reported. This is the cloud's replacement for the
      // local `{"c":{"sensors":...}}` leaf, which became unreachable when the cloud
      // stopped serving local credentials (see SensorReading in settings.ts).
      this.socket.on('sensor_update', (data: any) => {
        try {
          // Key off deviceSerial: it is present and matches the unit (verified live
          // by a capture handler that filtered on it). We deliberately do NOT resolve
          // the sensor's own `uuid` back to a device — an event we cannot attribute is
          // dropped rather than guessed at, since attributing a temperature to the
          // wrong unit is worse than having none.
          const serial = data?.deviceSerial;
          if (typeof serial !== 'string' || serial.length === 0) {
            this.log.debug('Ignoring sensor_update with no deviceSerial');
            return;
          }

          const reading: SensorReading = {
            deviceSerial: serial,
            uuid: typeof data.uuid === 'string' ? data.uuid : undefined,
            battery: asNumberOrNull(data.battery),
            rssi: asNumberOrNull(data.rssi),
            txPower: asNumberOrNull(data.txPower),
            temperature: asNumberOrNull(data.temperature),
            humidity: asNumberOrNull(data.humidity),
          };

          this.log.debug(
            `Sensor update for ${serial}: temp=${reading.temperature}°C, `
            + `humidity=${reading.humidity}%, battery=${reading.battery}%, rssi=${reading.rssi}`,
          );

          for (const callback of this.sensorUpdateCallbacks) {
            this.safeCall(`Sensor update callback error for ${serial}`, () => callback(reading));
          }
        } catch (e) {
          // A throw here would escape into socket.io's emit loop and could take down
          // the listener for every other event on this socket.
          this.log.debug('Malformed sensor_update ignored');
        }
      });

      this.socket.on('disconnect', (reason) => {
        this.log.warn(`✗ Streaming disconnected: ${reason}`);

        // Mark as unhealthy immediately
        const wasHealthy = this.isStreamingHealthy;
        this.isStreamingHealthy = false;
        this.notifyHealthChange(wasHealthy, false);

        // Stop health checks while disconnected
        this.stopHealthChecks();

        // Socket.IO handles reconnection automatically with exponential backoff
        // Our health monitoring will detect when connection is restored
        // and polling fallback will cover updates in the meantime
      });

      this.socket.on('connect_error', (error) => {
        this.log.error(`Streaming connection error: ${error.message}`);
      });

      // Health checks used to start only inside the `connect` handler, so a socket
      // that never connected was never monitored either. startHealthChecks clears any
      // existing timer, so the call in `connect` (which restores checks after a
      // disconnect stopped them) stays correct.
      this.startHealthChecks();

      return await connected;
    } catch (error) {
      if (error instanceof Error) {
        this.log.error('Failed to start streaming:', error.message);
      }
      return false;
    }
  }

  subscribeToDevice(deviceSerial: string, callback: DeviceUpdateCallback): void {
    this.deviceUpdateCallbacks.set(deviceSerial, callback);

    // If already connected, subscribe immediately
    if (this.socket?.connected) {
      this.log.debug(`Subscribing to device: ${deviceSerial}`);
      this.socket.emit('subscribe', deviceSerial);
    }
  }

  unsubscribeFromDevice(deviceSerial: string): void {
    this.deviceUpdateCallbacks.delete(deviceSerial);
  }

  /** Subscribe to adapter connect/disconnect changes. The same function is held once. */
  onDeviceConnectionStatusChange(callback: DeviceConnectionCallback): void {
    this.deviceConnectionCallbacks.add(callback);
  }

  isStreamingConnected(): boolean {
    return this.socket?.connected || false;
  }

  // Profile and connection status callbacks
  onDeviceProfileUpdate(callback: DeviceProfileCallback): void {
    this.deviceProfileCallbacks.add(callback);
  }

  /** Notified whenever a paired wireless sensor reports, via `sensor_update`. */
  onSensorUpdate(callback: SensorUpdateCallback): void {
    this.sensorUpdateCallbacks.add(callback);
  }

  // ---- Local-control credential accessors ---------------------------------

  /** The captured local password (base64) for a device, if seen yet. */
  getAdapterPassword(serial: string): string | undefined {
    return this.adapterPasswords.get(serial);
  }

  /** Fetch a device's `cryptoSerial` (hex) — the second half of the local key. */
  async getDeviceCryptoSerial(serial: string): Promise<string | null> {
    const status = await this.makeAuthenticatedRequest<{ cryptoSerial?: string }>(
      `/devices/${serial}/status`,
    );
    // A null status is a failed request, already logged by makeAuthenticatedRequest.
    // A status object that simply OMITS cryptoSerial is the cloud-side change: the
    // endpoint still answers 200, just without the field. That used to return null
    // silently, so the only symptom a user got was local control never starting.
    if (status && (typeof status.cryptoSerial !== 'string' || status.cryptoSerial.length === 0)) {
      if (!this.warnedNoCryptoSerial) {
        this.warnedNoCryptoSerial = true;
        this.log.warn(
          'Kumo cloud has stopped returning cryptoSerial from /devices/<serial>/status, so local '
          + 'LAN control cannot authenticate and the plugin is using cloud control. This is a '
          + 'cloud-side change, not a problem with your network or config. Set localControl: false '
          + 'to silence this.',
        );
      }
      return null;
    }
    return status?.cryptoSerial ?? null;
  }

  /** Ask the cloud to re-push a device's `adapter_update` (carries the password). */
  requestAdapterStatus(serial: string): void {
    this.socket?.emit('force_adapter_request', serial, 'adapterStatus');
  }

  /**
   * Extract user ID from the JWT access token payload.
   */
  private getUserIdFromToken(): string | null {
    if (!this.accessToken) {
      return null;
    }
    try {
      const parts = this.accessToken.split('.');
      if (parts.length < 2) {
        return null;
      }
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      return payload.id ? String(payload.id) : null;
    } catch {
      this.log.debug('Failed to extract user ID from JWT');
      return null;
    }
  }

  /**
   * Set streaming health check interval
   */
  setStreamingHealthCheckInterval(checkIntervalSec: number): void {
    this.streamingHealthCheckInterval = checkIntervalSec * 1000;
    this.log.debug(`Streaming health check interval: ${checkIntervalSec}s`);
  }

  /**
   * Register callback for streaming health changes
   */
  onStreamingHealthChange(callback: (isHealthy: boolean) => void): void {
    this.streamingHealthCallbacks.add(callback);
  }

  /**
   * Check if streaming is healthy (socket connected).
   * Socket.io fires disconnect events if the transport drops, so this catches a
   * dead socket. It does NOT catch a "zombie" — a socket that stays connected while
   * its device_update subscription silently dies. checkStreamingLiveness() covers that.
   */
  private checkStreamingHealth(): void {
    const wasHealthy = this.isStreamingHealthy;

    // Check if socket is connected
    // Socket.io handles heartbeats automatically and will disconnect if connection is lost
    this.isStreamingHealthy = this.isStreamingConnected();
    this.notifyHealthChange(wasHealthy, this.isStreamingHealthy);
  }

  /**
   * Detect and recover a "zombie" stream: a socket that stays TCP-connected while its
   * device_update subscription silently dies. Ported from upstream
   * homebridge-mitsubishi-comfort 59879da, which observed it live on 2026-08-15:
   * after an all-units-off burst, device_update went silent for 13 min while
   * profile_update kept arriving on its ~2–4 min heartbeat and health stayed
   * "healthy", so the plugin went deaf to real state changes with no recovery.
   *
   * The cloud only pushes device_update on real STATE CHANGE, so a long silence is
   * just as much the signature of an idle stream, and profile_update flows in both
   * cases. The only reliable discriminator is an active nudge: force a status request
   * and see whether ANY device answers with a device_update.
   *
   * State machine, ticked from the health-check timer:
   *   quiet < PROBE_AFTER_MS ............... healthy, do nothing
   *   quiet ≥ PROBE_AFTER_MS, no probe yet . send one iuStatus nudge to all devices
   *   probe pending, a device_update landed  quiet < PROBE_AFTER_MS again → clear probe
   *   probe pending > PROBE_GRACE_MS, silent zombie confirmed → reconnect (forceStatus)
   *
   * Upstream first tried a probe that declared a zombie when a nudge went unanswered
   * for 20s, and removed it after it false-fired on adapters that answer in 6–65s.
   * Here the grace is 2.5 min and ANY one device answering clears it, so a slow or
   * partly unresponsive fleet never trips it. Reconnects are rate-limited by
   * ZOMBIE_RECONNECT_COOLDOWN_MS.
   */
  private checkStreamingLiveness(): void {
    if (this.isReconnecting || !this.isStreamingConnected()) {
      this.probePendingSince = 0; // can't judge; abandon any in-flight probe
      return;
    }
    if (this.lastDeviceUpdateTs === 0) {
      return; // fresh connection seeds this; nothing to judge yet
    }
    const now = Date.now();

    // device_update flowing, on its own or in answer to a nudge: the stream is alive.
    // An answer always lands here, since it arrives within PROBE_GRACE_MS of a
    // nudge and PROBE_GRACE_MS < PROBE_AFTER_MS, so it also clears any pending probe.
    const deviceStale = now - this.lastDeviceUpdateTs;
    if (deviceStale < KumoAPI.PROBE_AFTER_MS) {
      this.probePendingSince = 0;
      return;
    }

    // device_update quiet too long. Nudge once, then wait out the grace window.
    if (this.probePendingSince === 0) {
      if ((now - this.lastZombieReconnectTs) < KumoAPI.ZOMBIE_RECONNECT_COOLDOWN_MS) {
        return; // just reconnected; give it room before probing again
      }
      this.probePendingSince = now;
      this.nudgeDeviceStatus();
      this.log.debug(`Streaming quiet ${Math.round(deviceStale / 1000)}s — nudging device status`);
      return;
    }

    // Nudge still unanswered within grace → keep waiting.
    if ((now - this.probePendingSince) < KumoAPI.PROBE_GRACE_MS) {
      return;
    }

    // Grace elapsed and NO device answered the nudge → zombie. Reconnect.
    this.probePendingSince = 0;
    this.lastZombieReconnectTs = now;
    this.forceStatusOnNextConnect = true;
    this.log.warn(
      `⚠ Streaming zombie: no device_update for ${Math.round(deviceStale / 1000)}s ` +
      'and a status nudge went unanswered — forcing reconnect',
    );
    this.reconnectStreaming().catch(e =>
      this.log.warn(`Zombie reconnect failed: ${(e as Error).message}`));
  }

  /** Ask every subscribed device to re-report indoor-unit status (→ device_update). */
  private nudgeDeviceStatus(): void {
    for (const serial of this.deviceUpdateCallbacks.keys()) {
      if (isValidSerial(serial)) {
        this.socket?.emit('force_adapter_request', serial, 'iuStatus');
      }
    }
  }

  /**
   * Notify listeners if health status changed
   */
  private notifyHealthChange(wasHealthy: boolean, isHealthy: boolean): void {
    if (wasHealthy !== isHealthy) {
      // Suppress "unhealthy" notifications during planned reconnections (token refresh)
      if (this.isReconnecting && !isHealthy) {
        this.log.debug('Suppressing unhealthy notification during planned reconnect');
        return;
      }

      // Track if this is a routine reconnect before clearing the flag
      const isRoutineReconnect = this.isReconnecting;

      // Clear reconnecting flag when we become healthy
      if (isHealthy) {
        this.isReconnecting = false;
      }

      // Use debug level for routine reconnects, info for real state changes
      if (isRoutineReconnect) {
        this.log.debug(`Streaming health restored after token refresh`);
      } else {
        this.log.info(`Streaming health changed: ${wasHealthy ? 'healthy' : 'unhealthy'} → ${isHealthy ? 'healthy' : 'unhealthy'}`);
      }

      this.reportHealth(isHealthy);
    }
  }

  /**
   * Fan a health state out to the platform.
   *
   * Guarded like the other fan-outs: the connect and disconnect handlers both
   * reach here, so this runs inside socket.io's emit loop, and the consumer
   * (the platform's degraded-mode switch) starts and stops timers.
   */
  private reportHealth(isHealthy: boolean): void {
    for (const callback of this.streamingHealthCallbacks) {
      this.safeCall('Streaming health callback error', () => callback(isHealthy));
    }
  }

  /**
   * Run one consumer callback, logging instead of throwing. A throw from a Socket.IO
   * handler escapes into its emit loop, and one consumer must not skip the others.
   */
  private safeCall(context: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log.error(`${context}: ${(e as Error).message}`);
    }
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      this.checkStreamingHealth();
      this.checkStreamingLiveness();
    }, this.streamingHealthCheckInterval);

    this.log.debug('Started streaming health checks');
  }

  /**
   * Stop periodic health checks
   */
  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Clean up streaming health monitoring
    this.stopHealthChecks();
    this.streamingHealthCallbacks.clear();
    this.log.debug('Streaming health monitoring stopped');

    if (this.socket) {
      this.log.debug('Disconnecting streaming connection');
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * Reconnect streaming with the current (refreshed) access token.
   * This is called after every token refresh to ensure the socket uses the new token.
   * Socket.IO headers are set at connection time, so reconnection is required.
   */
  async reconnectStreaming(): Promise<void> {
    if (!this.streamingEnabled) {
      return;
    }

    // Get the device serials we're subscribed to
    const deviceSerials = Array.from(this.deviceUpdateCallbacks.keys());
    if (deviceSerials.length === 0) {
      this.log.debug('No devices subscribed, skipping streaming reconnect');
      return;
    }

    this.log.debug('Reconnecting streaming with refreshed token...');

    // Set flag to suppress health notifications during planned reconnect
    this.isReconnecting = true;

    // Disconnect current socket if connected
    if (this.socket) {
      // Stop health checks to prevent false "unhealthy" detection during reconnect
      this.stopHealthChecks();

      // Remove listeners before disconnect to avoid spurious warnings
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    // Start streaming with new token (it will use this.accessToken).
    // Deliberately not awaited: startStreaming now waits for the socket to actually
    // come up (up to socketConnectTimeout), and this runs inside the token refresh
    // that every REST call and every HomeKit write blocks on via ensureAuthenticated.
    // The connect handler reports success asynchronously.
    this.startStreaming(deviceSerials)
      .then(connected => {
        if (connected) {
          return;
        }
        // The planned reconnect never came up, so report the outage here rather
        // than leaving it to the health checks. isReconnecting is otherwise cleared
        // only by becoming healthy, and while it is set notifyHealthChange DROPS
        // every unhealthy report — including the edge, which it does not replay. A
        // socket that fails this reconnect therefore latched the flag for the life
        // of the process: the platform was never told streaming had died, and under
        // `disablePolling: true` it never started the fallback poller either.
        // reportHealth bypasses the edge gate; handleStreamingHealthChange is
        // idempotent for repeated unhealthy reports.
        this.isReconnecting = false;
        this.isStreamingHealthy = false;
        this.log.warn('Streaming did not come back up after the token refresh');
        this.reportHealth(false);
      })
      .catch(error => this.log.debug(`Streaming reconnect failed: ${(error as Error).message}`));
  }
}
