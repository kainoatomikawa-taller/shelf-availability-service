import { describe, expect, it } from 'vitest';
import {
  OutOfOrderEventError,
  appendAudit,
  auditEntryId,
  emptyAuditLog,
  entriesForFacing,
  entriesForTask,
  entriesWithin,
  taskId,
  timeWindow,
  type AuditLog,
  type AuditLogEntry,
  type Instant,
} from '../src/index.js';
import { ACME, EMPLOYEE, FACING, STORE, TASK, hour } from './support/fixtures.js';

let counter = 0;
const entry = (at: Instant, overrides: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  entryId: auditEntryId(`audit-${++counter}`),
  retailerId: ACME,
  storeId: STORE,
  at,
  actor: { kind: 'system', component: 'osa-task-engine' },
  action: 'task.transitioned',
  subject: { kind: 'task', taskId: TASK },
  before: 'assigned',
  after: 'acknowledged',
  correlationId: 'corr-1',
  ...overrides,
});

const log = (...entries: readonly AuditLogEntry[]): AuditLog =>
  entries.reduce(appendAudit, emptyAuditLog(ACME));

describe('audit log', () => {
  it('starts empty for a retailer', () => {
    expect(emptyAuditLog(ACME).entries).toEqual([]);
  });

  it('appends without mutating the previous log', () => {
    const before = emptyAuditLog(ACME);
    const after = appendAudit(before, entry(hour(9)));

    expect(before.entries).toHaveLength(0);
    expect(after.entries).toHaveLength(1);
  });

  it('refuses an entry that predates the last one, keeping the trail ordered', () => {
    const existing = log(entry(hour(12)));

    expect(() => appendAudit(existing, entry(hour(8)))).toThrow(OutOfOrderEventError);
  });

  it('accepts entries sharing an instant', () => {
    expect(log(entry(hour(9)), entry(hour(9))).entries).toHaveLength(2);
  });

  it('records who acted, on what, and what changed', () => {
    const resolved = entry(hour(10), {
      actor: { kind: 'employee', employeeId: EMPLOYEE },
      action: 'task.transitioned',
      before: 'in_progress',
      after: 'awaiting_verification',
    });

    expect(resolved.actor).toEqual({ kind: 'employee', employeeId: EMPLOYEE });
    expect(resolved.before).toBe('in_progress');
    expect(resolved.after).toBe('awaiting_verification');
  });

  it('filters by window, task and facing', () => {
    const trail = log(
      entry(hour(8), { subject: { kind: 'facing', facingId: FACING }, action: 'facing.state_changed' }),
      entry(hour(9)),
      entry(hour(20), { subject: { kind: 'task', taskId: taskId('task-other') } }),
    );

    expect(entriesWithin(trail, timeWindow(hour(8), hour(10)))).toHaveLength(2);
    expect(entriesForTask(trail, TASK)).toHaveLength(1);
    expect(entriesForFacing(trail, FACING)).toHaveLength(1);
  });
});
