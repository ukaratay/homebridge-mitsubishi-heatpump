// Regression test for Fahrenheit-anchored setpoint quantization.
//
// The Home app is Celsius-native and converts to °F only for display, so a "72°F"
// tap arrives as an arbitrary Celsius float. Upstream set HAP `minStep: 0.1` on the
// setpoint characteristics believing that would make °F round-trip; it does not.
// hap-nodejs applies minStep only on the OUTBOUND path (`validateUserInput`) — the
// inbound controller-write path (`validateClientSuppliedValue`) returns the float
// verbatim. The minStep grid is also anchored at `minValue`, so with minValue 10 a
// 72°F write lands on 10 + 122 * 0.1 = 22.200000000000003 (IEEE-754 dirt that then
// leaks into commands, logs and mirror signatures).
//
// Separately, rounding lived in the LAN transport only (`round1` in local-api.ts) and
// never on the cloud path, so the same tap stored a different value depending on
// which transport won. quantizeSetpointC sits above both transports and snaps every
// write to the 0.5°C point nearest a whole °F: since 2026-10-30 the Mitsubishi
// cloud refuses any other value (HTTP 400 `invalidSpHeatIncrement`).

import test from 'node:test';
import assert from 'node:assert';

import {
  cToF,
  fToC,
  quantizeSetpointC,
  quantizeSetpointInRange,
  sameSetpoint,
} from '../dist/temperature.js';

/** What the Home app would show for a stored Celsius value. */
function displayedF(c: number): number {
  return Math.round(cToF(c));
}

test('cToF / fToC are exact at the anchors', () => {
  assert.strictEqual(cToF(0), 32);
  assert.strictEqual(cToF(100), 212);
  assert.strictEqual(fToC(32), 0);
  assert.strictEqual(fToC(212), 100);
});

test('every whole °F from 50 to 90 round-trips through 0.5°C storage', () => {
  for (let f = 50; f <= 90; f++) {
    const stored = quantizeSetpointC(fToC(f));
    assert.strictEqual(displayedF(stored), f,
      `${f}°F stored as ${stored}°C displays back as ${displayedF(stored)}°F`);
  }
});

test('the whole-°F round-trip survives ±0.2°C of controller jitter', () => {
  for (let f = 50; f <= 90; f++) {
    for (const jitter of [-0.2, -0.05, 0, 0.05, 0.2]) {
      const stored = quantizeSetpointC(fToC(f) + jitter);
      assert.strictEqual(displayedF(stored), f,
        `${f}°F + ${jitter}°C should still land on ${f}°F, got ${displayedF(stored)}°F`);
    }
  }
});

test('every stored value is on the 0.5°C grid the cloud accepts', () => {
  for (let f = 50; f <= 90; f++) {
    const stored = quantizeSetpointC(fToC(f));
    assert.strictEqual(stored * 2, Math.round(stored * 2), `${f}°F stored as ${stored}°C is off the 0.5°C grid`);
  }
});

test('72°F lands on 22.0°C, the nearest 0.5°C point', () => {
  // 72°F is 22.2222°C. 22.0 is 71.6°F and 22.5 is 72.5°F; only 22.0 rounds back
  // to 72 in the Home app. The Comfort app, which truncates, shows it as 71.
  const stored = quantizeSetpointC(fToC(72));
  assert.strictEqual(stored, 22);
  assert.strictEqual(displayedF(stored), 72);
});

test('the 0.1°C values existing scenes still send land on the 0.5°C grid', () => {
  // HomeKit scenes saved under the old 0.1°C ceiling grid keep sending those
  // values; the cloud refused every one off the 0.5 grid from 2026-10-30. They
  // go through °F, so each lands on the 0.5°C point for its own degree.
  const cases: Array<[number, number, number]> = [
    [21.2, 21.0, 70],
    [22.3, 22.0, 72],
    [18.9, 19.0, 66],
    [18.4, 18.5, 65],
    [20.0, 20.0, 68],
    [24.5, 24.5, 76],
    [22.8, 23.0, 73],
  ];
  for (const [sent, stored, f] of cases) {
    assert.strictEqual(quantizeSetpointC(sent), stored, `${sent}°C should store as ${stored}°C`);
    assert.strictEqual(displayedF(stored), f, `${stored}°C should display as ${f}°F`);
  }
});

test('the stored value sits within 0.45°F of its target degree', () => {
  for (let f = 50; f <= 90; f++) {
    const back = cToF(quantizeSetpointC(fToC(f)));
    assert.ok(Math.abs(back - f) <= 0.45 + 1e-9, `${f}°F stored back as ${back}°F`);
  }
});

test('distinct whole °F map to distinct stored values (no two-°F collapse)', () => {
  const seen = new Set<number>();
  for (let f = 50; f <= 90; f++) {
    seen.add(quantizeSetpointC(fToC(f)));
  }
  assert.strictEqual(seen.size, 41, 'each of the 41 °F degrees gets its own 0.5°C slot');
});

test('results never carry IEEE-754 dirt', () => {
  for (let f = 50; f <= 90; f++) {
    const stored = quantizeSetpointC(fToC(f));
    assert.strictEqual(stored, Number(stored.toFixed(1)),
      `${stored} is not a clean one-decimal value`);
  }
});

test('the upstream minStep grid value is cleaned up, not passed through', () => {
  // What hap-nodejs' minValue-anchored 0.1 grid actually produces for 72°F.
  const dirty = 10 + Math.round((fToC(72) - 10) / 0.1) * 0.1;
  assert.notStrictEqual(dirty, 22.2, 'sanity: the upstream grid really is dirty');

  const stored = quantizeSetpointC(dirty);
  assert.strictEqual(stored, 22, 'the dirty 72°F value is re-snapped onto the 0.5°C grid');
});

test('quantizeSetpointC is idempotent across the usable range', () => {
  for (let c = 5; c <= 40; c += 0.05) {
    const once = quantizeSetpointC(c);
    assert.strictEqual(quantizeSetpointC(once), once, `not idempotent at ${c}`);
  }
});

test('quantizeSetpointInRange is idempotent, including outside the range', () => {
  for (let c = 5; c <= 40; c += 0.05) {
    const once = quantizeSetpointInRange(c, 10, 31);
    assert.strictEqual(quantizeSetpointInRange(once, 10, 31), once, `not idempotent at ${c}`);
  }
});

test('an in-range value is still snapped to the grid, not passed through raw', () => {
  // "In range" does not mean "leave alone": a source setpoint sitting off the
  // grid (e.g. mirrored from a unit set in Celsius) must still be snapped, or it
  // propagates the display drift this module exists to remove.
  assert.strictEqual(quantizeSetpointInRange(fToC(68), 10, 31), quantizeSetpointC(fToC(68)));
  assert.strictEqual(quantizeSetpointInRange(fToC(72), 10, 31), 22);
  assert.strictEqual(quantizeSetpointInRange(22.3, 10, 31), 22, 'an off-grid in-range value is snapped');
});

test('the real 10–31°C device range: below the floor snaps up to 50°F', () => {
  // 10°C is exactly 50°F, so the bottom bound is itself on the grid.
  assert.strictEqual(quantizeSetpointInRange(9.4, 10, 31), 10);
  assert.strictEqual(quantizeSetpointInRange(0, 10, 31), 10);
  assert.strictEqual(displayedF(quantizeSetpointInRange(0, 10, 31)), 50);
});

test('the real 10–31°C device range: a 88°F request lands on the 31°C max', () => {
  // 31°C is 87.8°F. 88°F is 31.11°C, whose nearest 0.5°C point is 31.0 itself.
  const out = quantizeSetpointInRange(fToC(88), 10, 31);
  assert.strictEqual(out, 31);
  assert.strictEqual(displayedF(out), 88);
  assert.strictEqual(quantizeSetpointInRange(fToC(95), 10, 31), 31, 'never above the device max');
});

test('clamped values stay inside the range and on the °F grid', () => {
  const min = 10;
  const max = 31;
  for (let f = 40; f <= 100; f++) {
    const out = quantizeSetpointInRange(fToC(f), min, max);
    assert.ok(out >= min && out <= max, `${f}°F produced ${out}°C, outside [${min},${max}]`);
    assert.strictEqual(out, Number(out.toFixed(1)), `${out} is not a clean one-decimal value`);
    // On the grid: the stored value is the storage form of its own displayed °F.
    assert.strictEqual(out, quantizeSetpointC(out), `${out}°C is off the °F grid`);
  }
});

test('a range whose bounds are whole °F keeps both endpoints reachable', () => {
  // 60°F is 15.5555…°C but is *stored* as 15.5 — 0.056°C below the bound. Judging
  // containment exactly would reject the range's own endpoint and hand back 61°F,
  // silently shaving a degree off the bottom of the slider. Containment is therefore
  // judged to within half the 0.5°C grid.
  const min = fToC(60); // 15.5555…
  const max = fToC(80); // 26.6666…
  assert.strictEqual(quantizeSetpointInRange(fToC(55), min, max), 15.5);
  assert.strictEqual(displayedF(quantizeSetpointInRange(fToC(55), min, max)), 60);
  assert.strictEqual(quantizeSetpointInRange(fToC(85), min, max), 26.5);
  assert.strictEqual(displayedF(quantizeSetpointInRange(fToC(85), min, max)), 80);
});

test('the resolution allowance never loosens a bound that is on the 0.5°C grid', () => {
  // Both bound and candidate are multiples of 0.5 there, so an out-of-range
  // candidate misses by a full 0.5 — well outside the 0.25 allowance.
  for (let halves = 20; halves <= 64; halves++) {
    const max = halves / 2;
    const out = quantizeSetpointInRange(40, 10, max);
    assert.ok(out <= max, `max ${max} was exceeded by ${out}`);
  }
});

test('a range narrower than 1°F falls back to the range edge, still inside', () => {
  // No whole °F lands in [12.3, 12.7]: 54°F stores as 12.0 and 55°F as 13.0, so
  // the 12.5 grid point between them belongs to no degree.
  const low = quantizeSetpointInRange(5, 12.3, 12.7);
  assert.strictEqual(low, 12.5);
  const high = quantizeSetpointInRange(40, 12.3, 12.7);
  assert.strictEqual(high, 12.5);
});

test('a float-dirty bound does not push the result out of range', () => {
  const max = 22.000000000000004; // a float-dirty form of the 72°F grid point
  const out = quantizeSetpointInRange(fToC(75), 10, max);
  assert.ok(out <= max + 0.25, `${out} exceeded the dirty max ${max}`);
  assert.strictEqual(out, 22, 'the bound itself is reachable despite the trailing dirt');
});

test('sameSetpoint is true within half a 0.5°C step', () => {
  assert.ok(sameSetpoint(22, 22));
  assert.ok(sameSetpoint(22, 22.2), 'a legacy 0.1°C reading near the grid point is not a change');
  assert.ok(sameSetpoint(22, 21.8));
  assert.ok(sameSetpoint(22, 22.000000000000004), 'float dirt is not a change');
});

test('sameSetpoint is false beyond half a 0.5°C step', () => {
  assert.ok(!sameSetpoint(22, 22.3));
  assert.ok(!sameSetpoint(22, 22.5), 'one 0.5°C step apart is a real change');
  assert.ok(!sameSetpoint(22, 23), 'one °F apart is a real change');
});

test('adjacent °F setpoints are never mistaken for the same setpoint', () => {
  for (let f = 50; f < 90; f++) {
    const a = quantizeSetpointC(fToC(f));
    const b = quantizeSetpointC(fToC(f + 1));
    assert.ok(!sameSetpoint(a, b), `${f}°F and ${f + 1}°F compared equal`);
  }
});
