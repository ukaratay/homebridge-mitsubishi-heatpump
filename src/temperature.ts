/**
 * Fahrenheit-anchored setpoint quantization.
 *
 * HomeKit is Celsius-native: the Home app converts to °F only for display, and a
 * controller writing "72°F" sends whatever Celsius float its own conversion produced.
 * The Mitsubishi cloud accepts setpoints only on a 0.5°C grid. It took 0.1°C values
 * until 2026-10-29; from 2026-10-30 every other value is refused with HTTP 400
 * `invalidSpHeatIncrement` / `invalidSpCoolIncrement` (live-verified 2026-11-04:
 * 21.0 and 21.5 accepted, 21.3 and 22.7 refused). Units still hold and report older
 * 0.1°C values; only writes are checked. This module snaps every write to the 0.5°C
 * point nearest a whole °F.
 *
 * Why this is not handled by HAP props. Upstream set `minStep: 0.1` on the setpoint
 * characteristics believing that would make °F round-trip. It does not:
 * hap-nodejs applies minStep only on the OUTBOUND path (`validateUserInput`); the
 * inbound controller-write path (`validateClientSuppliedValue`) hands the float
 * through verbatim. The minStep grid also introduces IEEE-754 dirt of its own,
 * because it is anchored at `minValue` — with minValue 10 and minStep 0.1 a 72°F
 * write lands on `10 + 122 * 0.1 = 22.200000000000003`, which then leaks into
 * commands, logs and mirror signatures.
 *
 * Rounding also used to live in the LAN transport only (`round1` in local-api.ts) and
 * never on the cloud path, so the same HomeKit tap stored a different value depending
 * on which transport won. Quantizing here — above both transports — makes the write
 * deterministic regardless of which one carries it.
 */

/** Half of the 0.5°C setpoint grid: the widest gap that is still "the same setpoint". */
const SETPOINT_TOLERANCE_C = 0.25;

/** Guard for arithmetic on range bounds that may themselves carry float dirt. */
const EPS = 1e-9;

export function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

export function fToC(f: number): number {
  return (f - 32) * 5 / 9;
}

/**
 * The 0.5°C value a whole °F degree is stored as: the nearest one.
 *
 * Nearest keeps the stored value within 0.25°C (0.45°F) of the degree, so the Home
 * app, which rounds, always shows it back as that same degree. A whole °F never
 * converts to a .25/.75 tie, and adjacent degrees (0.556°C apart) never share a
 * grid point.
 *
 * Cost of the 0.5°C grid: the Mitsubishi Comfort app TRUNCATES when it renders
 * Celsius as Fahrenheit (confirmed live 2026-07-27: 22.200001°C, which is 71.96°F,
 * showed as 72 in Home and 71 in Comfort). About half the degrees land just below
 * their °F and show one degree low there (72°F → 22.0°C = 71.6°F). The 0.1°C grid
 * avoided that by taking the ceiling; the 0.5°C grid has no point that is right in
 * both apps for those degrees, and of the two the Home app is the one kept exact.
 */
function storedC(f: number): number {
  return Math.round(fToC(f) * 2) / 2;
}

/**
 * Snap a Celsius setpoint to the 0.5°C the units store for the nearest whole
 * Fahrenheit degree.
 *
 * The result always displays back as the whole °F it came from in a renderer that
 * rounds; see storedC for the truncating one.
 */
export function quantizeSetpointC(c: number): number {
  return storedC(Math.round(cToF(c)));
}

/**
 * Clamp to [min,max] AFTER quantizing, staying on the °F grid.
 *
 * A plain `Math.min/Math.max` clamp would hand back the raw bound, which is usually
 * not a whole °F and need not sit on the 0.5°C grid the cloud accepts. Instead, when
 * the quantized value falls outside the range we step along the °F grid toward the
 * interior and take the first whole °F that lies inside. The real device range
 * 10–31°C is 50–87.8°F, and 88°F stores as 31.0°C, so both ends are reachable.
 *
 * "Inside" is judged to within half the 0.5°C grid, not exactly. A bound that is
 * itself a whole °F — 60°F is 15.5555…°C — is stored as 15.5, which an exact test
 * would read as 0.056°C out of range and reject, making the range's own endpoint
 * unreachable. The allowance cannot loosen a bound that already sits on the 0.5°C grid
 * (every real device profile bound does): both bound and candidate are then multiples
 * of 0.5, so an out-of-range candidate misses by a full 0.5, well past the tolerance.
 */
export function quantizeSetpointInRange(c: number, min: number, max: number): number {
  const lo = min - SETPOINT_TOLERANCE_C;
  const hi = max + SETPOINT_TOLERANCE_C;

  const quantized = quantizeSetpointC(c);
  if (quantized >= lo && quantized <= hi) {
    return quantized;
  }

  const step = quantized < min ? 1 : -1;
  let f = Math.round(cToF(quantized));
  // Bounded: the widest plausible range is ~50°F, and the walk bails the moment it
  // steps past the far edge. The isFinite clause makes a NaN input terminate at once.
  for (let i = 0; i < 128 && Number.isFinite(f); i++) {
    f += step;
    const candidate = storedC(f);
    if (candidate >= lo && candidate <= hi) {
      return candidate;
    }
    if (step === 1 ? candidate > hi : candidate < lo) {
      break;
    }
  }

  // No whole °F fits inside the range (it is narrower than 1°F, or degenerate).
  // Fall back to the range edge itself, on the 0.5°C grid, rounded inward so the
  // result cannot land outside the range.
  return step === 1
    ? Math.ceil(min * 2 - EPS) / 2
    : Math.floor(max * 2 + EPS) / 2;
}

/**
 * True if two Celsius setpoints are the same to within half a 0.5°C step.
 *
 * Used to compare a reconciled device setpoint with the one we sent. Values that
 * came out of quantizeSetpointC are at least 0.5°C apart when they differ, so the
 * exact-0.25 boundary is unreachable in practice — do not rely on which side it falls.
 */
export function sameSetpoint(a: number, b: number): boolean {
  return Math.abs(a - b) < SETPOINT_TOLERANCE_C;
}
