import type { Brand } from '../common/brand.js';
import { DAY } from '../common/time.js';
import type { PosMovementSignal } from '../facing/signals.js';

/**
 * How fast the product sells at this facing, in units per day.
 *
 * Per day rather than per POS window, so a fifteen-minute register roll-up and a
 * nightly batch are directly comparable when they land in the same ranking.
 */
export type SalesVelocity = Brand<number, 'SalesVelocity'>;

export const salesVelocity = (unitsPerDay: number): SalesVelocity => {
  if (!Number.isFinite(unitsPerDay) || unitsPerDay < 0) {
    throw new RangeError(`Sales velocity must be a finite, non-negative number, got ${unitsPerDay}`);
  }
  return unitsPerDay as SalesVelocity;
};

export const ZERO_VELOCITY: SalesVelocity = salesVelocity(0);

/**
 * Velocity measured from a POS movement signal.
 *
 * `null` for a zero-length window: there is no rate to read off an instant, and
 * dividing by it would manufacture a number nobody measured. Callers decide what
 * an unknown velocity means for them — the domain does not guess one.
 */
export function salesVelocityFromPos(signal: PosMovementSignal): SalesVelocity | null {
  const days = signal.windowMillis / DAY;
  if (days === 0) return null;
  return salesVelocity(signal.unitsSold / days);
}
