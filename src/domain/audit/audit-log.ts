import { OutOfOrderEventError } from '../common/errors.js';
import type {
  AuditEntryId,
  EmployeeId,
  FacingId,
  RetailerId,
  ShopperId,
  StoreId,
  TaskId,
} from '../common/ids.js';
import { assertSameRetailer, type RetailerPartitioned } from '../common/partition.js';
import { toISO, type Instant, type TimeWindow } from '../common/time.js';
import type { SignalSource } from '../facing/signals.js';

/** Who caused the audited change. */
export type AuditActor =
  | { readonly kind: 'system'; readonly component: string }
  | { readonly kind: 'employee'; readonly employeeId: EmployeeId }
  | { readonly kind: 'shopper'; readonly shopperId: ShopperId }
  | { readonly kind: 'integration'; readonly source: SignalSource };

export type AuditAction =
  | 'signal.ingested'
  | 'facing.state_changed'
  | 'task.created'
  | 'task.transitioned'
  | 'task.verified'
  | 'verification.pass_recorded'
  | 'lane_map.overridden'
  | 'availability_index.computed';

/** What the entry is about, as a partition-local reference. */
export type AuditSubject =
  | { readonly kind: 'facing'; readonly facingId: FacingId }
  | { readonly kind: 'task'; readonly taskId: TaskId }
  | { readonly kind: 'store'; readonly storeId: StoreId }
  | { readonly kind: 'retailer' };

/**
 * One immutable record of something the closed loop did.
 *
 * The audit log is a domain entity, not a logging concern: retailers are
 * contractually shown why a facing was called out of stock, why an employee was
 * dispatched, and on what evidence the task was declared verified.
 */
export interface AuditLogEntry extends RetailerPartitioned {
  readonly entryId: AuditEntryId;
  /** Partition key. Audit trails are retailer-scoped end to end. */
  readonly retailerId: RetailerId;
  readonly storeId: StoreId | null;
  readonly at: Instant;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly subject: AuditSubject;
  /** Prior and resulting values, already redacted for the retailer's own view. */
  readonly before: string | null;
  readonly after: string | null;
  /** Ties every entry produced while handling one upstream signal together. */
  readonly correlationId: string;
}

/** Append-only, time-ordered audit trail for one retailer partition. */
export interface AuditLog extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly entries: readonly AuditLogEntry[];
}

export const emptyAuditLog = (retailerId: RetailerId): AuditLog => ({ retailerId, entries: [] });

export function appendAudit(log: AuditLog, entry: AuditLogEntry): AuditLog {
  assertSameRetailer(log.retailerId, entry, 'appendAudit');

  const previous = log.entries.at(-1);
  if (previous !== undefined && entry.at < previous.at) {
    throw new OutOfOrderEventError(
      `Audit entry ${entry.entryId} at ${toISO(entry.at)} precedes the last entry at ${toISO(previous.at)}`,
    );
  }

  return { ...log, entries: [...log.entries, entry] };
}

export const entriesWithin = (log: AuditLog, window: TimeWindow): readonly AuditLogEntry[] =>
  log.entries.filter((entry) => entry.at >= window.from && entry.at < window.to);

export const entriesForTask = (log: AuditLog, id: TaskId): readonly AuditLogEntry[] =>
  log.entries.filter((entry) => entry.subject.kind === 'task' && entry.subject.taskId === id);

export const entriesForFacing = (log: AuditLog, id: FacingId): readonly AuditLogEntry[] =>
  log.entries.filter((entry) => entry.subject.kind === 'facing' && entry.subject.facingId === id);
