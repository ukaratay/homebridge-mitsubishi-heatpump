// Regression tests for the config gate in the platform constructor.
//
// Until 2.1.0 each of these four cases threw. Homebridge does not guard a platform
// constructor, so the throw rejected `Server.start()` and the CLI answered by SIGTERMing
// the process: a missing password took down every other plugin in the install, before the
// bridge published, and the supervisor restarted into the same throw. Verified against
// homebridge 2.2.1 — a second, unrelated platform plugin never had its constructor called.
//
// What these tests pin is therefore not the message but the shape: the constructor
// returns, and it does NOT subscribe to didFinishLaunching, which is what would start it.

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';

import { KumoV3Platform, validatePlatformConfig } from '../dist/platform.js';
import type { KumoConfig } from '../dist/settings.js';
import { makeLog } from './helpers';

const VALID: PlatformConfig = {
  name: 'test',
  platform: 'KumoV3',
  username: 'user@example.com',
  password: 'secret',
};

/** Records the lifecycle events the platform subscribes to. */
function makeApi() {
  const events: string[] = [];
  const api = {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s: string) => `uuid-${s}` } },
    on: (event: string) => events.push(event),
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };
  return { api, events };
}

const BAD_CONFIGS: Array<[string, Partial<KumoConfig>, string]> = [
  ['no credentials at all', { username: undefined, password: undefined }, 'Username and password'],
  ['username present, password missing', { password: undefined }, 'Username and password'],
  ['username is not an email', { username: 'notanemail' }, 'valid email'],
  ['password is whitespace', { password: '   ' }, 'non-empty'],
  ['pollInterval below the floor', { pollInterval: 1 }, 'Poll interval'],
  ['pollInterval hand-edited to a string', { pollInterval: '30' as never }, 'Poll interval'],
];

for (const [label, overrides, expected] of BAD_CONFIGS) {
  test(`validatePlatformConfig rejects: ${label}`, () => {
    const reason = validatePlatformConfig({ ...VALID, ...overrides } as unknown as KumoConfig);
    assert.ok(reason, 'a reason is returned');
    assert.match(reason, new RegExp(expected, 'i'));
  });

  test(`constructor stays inert instead of throwing: ${label}`, () => {
    const { api, events } = makeApi();
    const config = { ...VALID, ...overrides } as PlatformConfig;

    let platform: KumoV3Platform | undefined;
    assert.doesNotThrow(() => {
      platform = new KumoV3Platform(makeLog() as never, config, api as never);
    }, 'a throw here SIGTERMs the whole Homebridge process');

    assert.ok(platform, 'construction completed');
    assert.deepStrictEqual(events, [], 'no lifecycle hooks: the platform never starts');
  });
}

test('validatePlatformConfig accepts a minimal valid config', () => {
  assert.strictEqual(validatePlatformConfig(VALID as unknown as KumoConfig), null);
});

// The Fan Auto and Vane Auto switch options existed on a development build and
// were dropped. A config that still carries them must keep working.
test('leftover showFanAutoSwitch / showVaneAutoSwitch keys are ignored, not rejected', () => {
  const leftover = { ...VALID, showFanAutoSwitch: true, showVaneAutoSwitch: true };
  assert.strictEqual(validatePlatformConfig(leftover as unknown as KumoConfig), null);
  const { api, events } = makeApi();
  new KumoV3Platform(makeLog() as never, leftover, api as never);
  assert.deepStrictEqual(events, ['didFinishLaunching', 'shutdown'], 'the platform starts');
});

test('pollInterval is optional, and the floor of 5 is inclusive', () => {
  assert.strictEqual(validatePlatformConfig({ ...VALID, pollInterval: 5 } as unknown as KumoConfig), null);
  assert.ok(validatePlatformConfig({ ...VALID, pollInterval: 4.9 } as unknown as KumoConfig));
});

test('a valid config still subscribes to both lifecycle events', () => {
  const { api, events } = makeApi();
  const platform = new KumoV3Platform(makeLog() as never, VALID, api as never);
  assert.ok(platform);
  assert.deepStrictEqual(events, ['didFinishLaunching', 'shutdown']);
});

test('the reason is logged as an error, once, and names the remedy', () => {
  const logged: string[] = [];
  const log = { ...makeLog(), error: (...args: unknown[]) => logged.push(args.join(' ')) };
  const { api } = makeApi();

  new KumoV3Platform(log as never, { ...VALID, password: undefined } as PlatformConfig, api as never);

  assert.strictEqual(logged.length, 1, 'exactly one error line, not a wall of them');
  assert.match(logged[0], /Username and password are required/);
  assert.match(logged[0], /stay idle/);
  assert.match(logged[0], /other plugins are unaffected/);
});
