import type { StoreId } from './ids';
import type { ReportEnvelope } from './scope';
import type { Instant, Millis, Ratio, TimeWindow } from './time';

/**
 * Whether the pilot is actually being used, as opposed to whether it works.
 *
 * This is the metric family the pilot is instrumented for and the one the rest
 * of the dashboard is read against: a resolved-gap rate computed over three
 * engaged stores out of forty says something very different from the same number
 * across the estate. Every rate here therefore carries its own denominator —
 * `activeStores` beside `enrolledStores`, `activeEmployees` beside
 * `enrolledEmployees` — so a headline percentage can never be read without the
 * population it was taken over.
 */
export interface AdoptionPoint {
  readonly window: TimeWindow;
  /** Stores provisioned for the pilot at the end of the bucket. */
  readonly enrolledStores: number;
  /** Enrolled stores that acknowledged at least one task in the bucket. */
  readonly activeStores: number;
  /** Employees with an account in an enrolled store. */
  readonly enrolledEmployees: number;
  /** Enrolled employees who acknowledged at least one task in the bucket. */
  readonly activeEmployees: number;
  /** `activeStores / enrolledStores`. `null` when nothing is enrolled yet. */
  readonly storeActivationRate: Ratio | null;
  /** `activeEmployees / enrolledEmployees`. `null` when nothing is enrolled yet. */
  readonly employeeActivationRate: Ratio | null;
  /** Task assignments that reached an acknowledgement, however late. */
  readonly tasksAcknowledged: number;
  readonly tasksDispatched: number;
  /**
   * `tasksAcknowledged / tasksDispatched` — the sharpest adoption signal there
   * is. A store that never acknowledges is a store working off paper.
   */
  readonly acknowledgementRate: Ratio | null;
  /** How long a dispatched task waits to be picked up. The felt cost of adoption. */
  readonly medianAcknowledgementLag: Millis | null;
  /** Tasks closed from the handheld rather than back-office bulk edits. */
  readonly tasksClosedInApp: number;
  readonly appSessions: number;
}

export type AdoptionReport = ReportEnvelope<AdoptionPoint>;

/**
 * One store's standing in the rollout, for the table that shows which sites need
 * a visit from the pilot team.
 */
export interface StoreAdoption {
  readonly storeId: StoreId;
  readonly storeName: string;
  readonly stage: AdoptionStage;
  readonly enrolledEmployees: number;
  readonly activeEmployees: number;
  readonly acknowledgementRate: Ratio | null;
  readonly tasksAcknowledged: number;
  readonly medianAcknowledgementLag: Millis | null;
  /** Last task acknowledgement from this store. `null` if it has never had one. */
  readonly lastActivityAt: Instant | null;
}

/**
 * How far a store has got, as a stage rather than a percentage.
 *
 * `provisioned` and `dormant` are kept apart on purpose: a store that has never
 * been switched on and a store that was working tasks and stopped need opposite
 * interventions, and both read as "0% active" if the stage is collapsed to a
 * number.
 */
export type AdoptionStage = 'provisioned' | 'onboarding' | 'active' | 'dormant';

export const ADOPTION_STAGES = [
  'provisioned',
  'onboarding',
  'active',
  'dormant',
] as const satisfies readonly AdoptionStage[];

export const ADOPTION_STAGE_LABELS: Readonly<Record<AdoptionStage, string>> = {
  provisioned: 'Provisioned',
  onboarding: 'Onboarding',
  active: 'Active',
  dormant: 'Dormant',
};

export const storeAdoptionKey = (store: StoreAdoption): string => store.storeId;
