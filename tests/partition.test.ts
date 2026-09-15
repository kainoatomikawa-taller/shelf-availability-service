import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  appendAudit,
  assertSameRetailer,
  assertSinglePartition,
  auditEntryId,
  belongsToRetailer,
  computeAvailabilityIndex,
  createTask,
  emptyAuditLog,
  partitionKeyOf,
  recordSignal,
  resolveColorLaneMap,
  timelineFor,
  timeWindow,
  unwrap,
  type AuditLogEntry,
  type RetailerPartitioned,
} from '../src/index.js';
import {
  ACME,
  FACING,
  PRODUCT,
  RIVAL,
  STORE,
  TASK,
  facingAt,
  hour,
  nextEventId,
  pass,
  shopperScan,
} from './support/fixtures.js';

const LANES = unwrap(resolveColorLaneMap(ACME));

const auditEntry = (): AuditLogEntry => ({
  entryId: auditEntryId('audit-1'),
  retailerId: ACME,
  storeId: STORE,
  at: hour(9),
  actor: { kind: 'system', component: 'osa-task-engine' },
  action: 'task.created',
  subject: { kind: 'task', taskId: TASK },
  before: null,
  after: 'created',
  correlationId: 'corr-1',
});

describe('retailer partition key — present on every entity', () => {
  const applied = recordSignal(
    facingAt(hour(0), 'in_stock'),
    shopperScan({ observedAt: hour(9), outcome: 'not_found' }),
    { nextEventId },
  );
  const facing = applied.facing;
  const event = applied.outcome === 'transitioned' ? applied.event : null;
  const task = createTask({
    retailerId: ACME,
    storeId: STORE,
    taskId: TASK,
    facingId: FACING,
    productId: PRODUCT,
    type: 'restock_out_of_stock',
    priority: 'high',
    lanes: LANES,
    createdAt: hour(9),
  });
  const window = timeWindow(hour(0), hour(24));
  const index = computeAvailabilityIndex(ACME, [timelineFor(facing, window)], window);

  // Every entity below is assignable to RetailerPartitioned, so this array is
  // itself the compile-time half of the assertion.
  const entities: ReadonlyArray<readonly [string, RetailerPartitioned]> = [
    ['facing', facing],
    ['facing event history', facing.history],
    ['facing state event', event as RetailerPartitioned],
    ['signal', shopperScan({ observedAt: hour(9) })],
    ['task', task],
    ['color lane map', LANES],
    ['verification pass', pass('p1', hour(11))],
    ['availability index', index],
    ['per-facing availability', index.perFacing[0] as RetailerPartitioned],
    ['audit log', emptyAuditLog(ACME)],
    ['audit entry', auditEntry()],
  ];

  it.each(entities)('%s carries the partition key', (_name, entity) => {
    expect(partitionKeyOf(entity)).toBe(ACME);
    expect(belongsToRetailer(entity, ACME)).toBe(true);
    expect(belongsToRetailer(entity, RIVAL)).toBe(false);
  });
});

describe('retailer partition key — no cross-retailer pooling', () => {
  it('rejects a foreign entity at an aggregate boundary', () => {
    expect(() => assertSameRetailer(ACME, { retailerId: RIVAL }, 'test')).toThrow(
      CrossRetailerAccessError,
    );
  });

  it('names the context, the expected partition and the offending one', () => {
    try {
      assertSameRetailer(ACME, { retailerId: RIVAL }, 'ingestSignal');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CrossRetailerAccessError);
      const failure = error as CrossRetailerAccessError;
      expect(failure.code).toBe('CROSS_RETAILER_ACCESS');
      expect(failure.expected).toBe(ACME);
      expect(failure.actual).toBe(RIVAL);
      expect(failure.message).toContain('ingestSignal');
    }
  });

  it('screens a whole batch before any of it is used', () => {
    const batch = [pass('p1', hour(11)), pass('p2', hour(12), 'clean', { retailerId: RIVAL })];

    expect(() => assertSinglePartition(ACME, batch, 'verify')).toThrow(CrossRetailerAccessError);
    expect(assertSinglePartition(ACME, [pass('p1', hour(11))], 'verify')).toHaveLength(1);
  });

  it('rejects a foreign audit entry rather than interleaving trails', () => {
    const log = emptyAuditLog(ACME);

    expect(() => appendAudit(log, { ...auditEntry(), retailerId: RIVAL })).toThrow(
      CrossRetailerAccessError,
    );
  });
});
