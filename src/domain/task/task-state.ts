import type { EmployeeId, PassId } from '../common/ids.js';
import type { Instant } from '../common/time.js';

export type TaskStatus =
  | 'created'
  | 'assigned'
  | 'acknowledged'
  | 'in_progress'
  | 'awaiting_verification'
  | 'verified'
  | 'reopened'
  | 'cancelled'
  | 'expired';

export const TERMINAL_STATUSES = ['verified', 'cancelled', 'expired'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const isTerminal = (status: TaskStatus): status is TerminalStatus =>
  (TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);

export type ReopenReason =
  | 'verification_regressed'
  | 'verification_window_lapsed'
  | 'supervisor_rejected';

export type CancelReason =
  | 'duplicate'
  | 'product_delisted'
  | 'store_closed'
  | 'superseded_by_planogram'
  | 'supervisor_cancelled';

/**
 * Task lifecycle as a discriminated union rather than a status string plus a bag
 * of nullable columns.
 *
 * Each state carries exactly the data that state can have: there is no way to
 * read `assigneeId` off a task nobody has been assigned, and no way to read the
 * verifying pass ids off a task that has not passed verification.
 */
export type TaskState =
  | { readonly status: 'created'; readonly createdAt: Instant }
  | { readonly status: 'assigned'; readonly assignedAt: Instant; readonly assigneeId: EmployeeId }
  | {
      readonly status: 'acknowledged';
      readonly acknowledgedAt: Instant;
      readonly assigneeId: EmployeeId;
    }
  | { readonly status: 'in_progress'; readonly startedAt: Instant; readonly assigneeId: EmployeeId }
  | {
      readonly status: 'awaiting_verification';
      readonly resolvedAt: Instant;
      readonly assigneeId: EmployeeId;
      readonly resolutionNote: string | null;
    }
  | {
      readonly status: 'verified';
      readonly verifiedAt: Instant;
      /**
       * The two clean passes that closed the loop, or `null` when the task type
       * does not require shelf verification.
       */
      readonly verifiedBy: {
        readonly firstPassId: PassId;
        readonly secondPassId: PassId;
      } | null;
    }
  | {
      readonly status: 'reopened';
      readonly reopenedAt: Instant;
      readonly reason: ReopenReason;
      /** Resolve attempts that have failed verification, including this one. */
      readonly failedAttempts: number;
    }
  | { readonly status: 'cancelled'; readonly cancelledAt: Instant; readonly reason: CancelReason }
  | { readonly status: 'expired'; readonly expiredAt: Instant };

export type TaskStateOf<S extends TaskStatus> = Extract<TaskState, { status: S }>;

/**
 * The legal state graph, kept as data so it can be asserted against in tests and
 * rendered for operations docs without re-reading the transition code.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  created: ['assigned', 'cancelled', 'expired'],
  assigned: ['assigned', 'acknowledged', 'cancelled', 'expired'],
  acknowledged: ['assigned', 'in_progress', 'cancelled', 'expired'],
  in_progress: ['awaiting_verification', 'verified', 'cancelled'],
  awaiting_verification: ['verified', 'reopened', 'expired'],
  reopened: ['assigned', 'cancelled', 'expired'],
  verified: [],
  cancelled: [],
  expired: [],
};

export const canTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);

/** The employee currently holding the task, if any state carries one. */
export const assigneeOf = (state: TaskState): EmployeeId | null => {
  switch (state.status) {
    case 'assigned':
    case 'acknowledged':
    case 'in_progress':
    case 'awaiting_verification':
      return state.assigneeId;
    case 'created':
    case 'verified':
    case 'reopened':
    case 'cancelled':
    case 'expired':
      return null;
  }
};
