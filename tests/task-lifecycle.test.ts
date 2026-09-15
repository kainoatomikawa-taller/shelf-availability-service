import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  CrossRetailerAccessError,
  InvalidTaskTransitionError,
  applyTaskCommand,
  assigneeOf,
  createTask,
  employeeId,
  eventId,
  isTerminal,
  passId,
  requiresShelfVerification,
  resolveColorLaneMap,
  unwrap,
  type Task,
  type TaskCommand,
  type TaskStatus,
  type TaskType,
} from '../src/index.js';
import { ACME, EMPLOYEE, FACING, PRODUCT, RIVAL, STORE, TASK, hour } from './support/fixtures.js';

const LANES = unwrap(resolveColorLaneMap(ACME));

const newTask = (type: TaskType = 'restock_out_of_stock'): Task =>
  createTask({
    retailerId: ACME,
    storeId: STORE,
    taskId: TASK,
    facingId: FACING,
    productId: PRODUCT,
    type,
    priority: 'high',
    lanes: LANES,
    triggeringEventId: eventId('evt-oos-1'),
    createdAt: hour(8),
  });

/** Applies commands in sequence, failing loudly on the first illegal one. */
const run = (task: Task, ...commands: readonly TaskCommand[]): Task =>
  commands.reduce((current, command) => unwrap(applyTaskCommand(current, command)).task, task);

const assign = (at = hour(8)): TaskCommand => ({ kind: 'assign', at, assigneeId: EMPLOYEE });
const acknowledge = (at = hour(9)): TaskCommand => ({ kind: 'acknowledge', at });
const start = (at = hour(9)): TaskCommand => ({ kind: 'start', at });
const resolve = (at = hour(10)): TaskCommand => ({ kind: 'resolve', at, note: 'pulled from backstock' });

describe('task creation', () => {
  it('is raised in the created state, on the retailer lane for its type', () => {
    const task = newTask();

    expect(task.state.status).toBe('created');
    expect(task.lane).toBe('red');
    expect(task.retailerId).toBe(ACME);
    expect(task.triggeringEventId).toBe(eventId('evt-oos-1'));
    expect(task.requiresVerification).toBe(true);
  });

  it('picks up an overridden lane from the retailer mapping', () => {
    const overridden = unwrap(
      resolveColorLaneMap(ACME, {
        retailerId: ACME,
        lanes: { restock_out_of_stock: 'teal', audit_count: 'red' },
      }),
    );
    const task = createTask({
      retailerId: ACME,
      storeId: STORE,
      taskId: TASK,
      facingId: FACING,
      productId: PRODUCT,
      type: 'restock_out_of_stock',
      priority: 'high',
      lanes: overridden,
      createdAt: hour(8),
    });

    expect(task.lane).toBe('teal');
  });

  it("refuses to be raised against another retailer's lane mapping", () => {
    const foreignLanes = unwrap(resolveColorLaneMap(RIVAL));

    expect(() =>
      createTask({
        retailerId: ACME,
        storeId: STORE,
        taskId: TASK,
        facingId: FACING,
        productId: PRODUCT,
        type: 'restock_out_of_stock',
        priority: 'high',
        lanes: foreignLanes,
        createdAt: hour(8),
      }),
    ).toThrow(CrossRetailerAccessError);
  });
});

describe('task lifecycle — the happy path', () => {
  it('walks created -> assigned -> acknowledged -> in progress -> awaiting verification', () => {
    const task = run(newTask(), assign(), acknowledge(), start(), resolve());

    expect(task.state.status).toBe('awaiting_verification');
    if (task.state.status !== 'awaiting_verification') return;
    expect(task.state.resolvedAt).toBe(hour(10));
    expect(task.state.resolutionNote).toBe('pulled from backstock');
    expect(assigneeOf(task.state)).toBe(EMPLOYEE);
  });

  it('closes on the two passes that satisfied the verification rule', () => {
    const resolved = run(newTask(), assign(), acknowledge(), start(), resolve());
    const verified = run(resolved, {
      kind: 'confirm_verification',
      at: hour(14),
      firstPassId: passId('p1'),
      secondPassId: passId('p2'),
    });

    expect(verified.state.status).toBe('verified');
    if (verified.state.status !== 'verified') return;
    expect(verified.state.verifiedBy).toEqual({
      firstPassId: passId('p1'),
      secondPassId: passId('p2'),
    });
    expect(isTerminal(verified.state.status)).toBe(true);
  });

  it('closes a self-evidencing task straight from in progress, with no passes', () => {
    const task = run(newTask('price_label_correction'), assign(), acknowledge(), start(), resolve());

    expect(requiresShelfVerification('price_label_correction')).toBe(false);
    expect(task.state.status).toBe('verified');
    expect(task.state.status === 'verified' && task.state.verifiedBy).toBeNull();
  });
});

describe('task lifecycle — rework and rejection', () => {
  it('reopens a task whose verification regressed, counting the failed attempt', () => {
    const resolved = run(newTask(), assign(), acknowledge(), start(), resolve());
    const reopened = run(resolved, {
      kind: 'reopen',
      at: hour(12),
      reason: 'verification_regressed',
    });

    expect(reopened.state.status).toBe('reopened');
    expect(reopened.state.status === 'reopened' && reopened.state.failedAttempts).toBe(1);
  });

  it('accumulates failed attempts across successive rework cycles', () => {
    let task = run(newTask(), assign(), acknowledge(), start(), resolve());
    task = run(task, { kind: 'reopen', at: hour(12), reason: 'verification_regressed' });
    task = run(task, assign(hour(13)), acknowledge(hour(13)), start(hour(13)), resolve(hour(14)));
    task = run(task, { kind: 'reopen', at: hour(16), reason: 'verification_window_lapsed' });

    expect(task.failedVerifications).toBe(2);
    expect(task.state.status === 'reopened' && task.state.failedAttempts).toBe(2);
  });

  it('allows reassignment while the task is still assigned or acknowledged', () => {
    const other = employeeId('emp-88');
    const reassigned = run(newTask(), assign(), {
      kind: 'assign',
      at: hour(9),
      assigneeId: other,
    });

    expect(assigneeOf(reassigned.state)).toBe(other);
  });

  it('cancels with a reason and stops there', () => {
    const cancelled = run(newTask(), { kind: 'cancel', at: hour(9), reason: 'product_delisted' });

    expect(cancelled.state.status).toBe('cancelled');
    expect(cancelled.state.status === 'cancelled' && cancelled.state.reason).toBe('product_delisted');
  });
});

describe('task lifecycle — illegal transitions', () => {
  it('will not start work nobody acknowledged', () => {
    const result = applyTaskCommand(newTask(), start());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(InvalidTaskTransitionError);
    expect(result.ok === false && result.error.from).toBe('created');
  });

  it('will not resolve a task that was never started', () => {
    const assigned = run(newTask(), assign());

    expect(applyTaskCommand(assigned, resolve()).ok).toBe(false);
  });

  it('will not confirm verification on a task that is not awaiting it', () => {
    const inProgress = run(newTask(), assign(), acknowledge(), start());
    const result = applyTaskCommand(inProgress, {
      kind: 'confirm_verification',
      at: hour(11),
      firstPassId: passId('p1'),
      secondPassId: passId('p2'),
    });

    expect(result.ok).toBe(false);
  });

  it('will not move a terminal task', () => {
    const verified = run(
      newTask('tag_maintenance'),
      assign(),
      acknowledge(),
      start(),
      resolve(),
    );
    const commands: readonly TaskCommand[] = [
      assign(hour(12)),
      { kind: 'reopen', at: hour(12), reason: 'supervisor_rejected' },
      { kind: 'cancel', at: hour(12), reason: 'duplicate' },
      { kind: 'expire', at: hour(12) },
    ];

    for (const command of commands) {
      expect(applyTaskCommand(verified, command).ok).toBe(false);
    }
  });

  it('leaves the task untouched when a command is rejected', () => {
    const task = newTask();
    const result = applyTaskCommand(task, start());

    expect(result.ok).toBe(false);
    expect(task.state.status).toBe('created');
  });

  it('declares every terminal status a dead end in the transition table', () => {
    for (const status of ['verified', 'cancelled', 'expired'] satisfies TaskStatus[]) {
      expect(ALLOWED_TRANSITIONS[status]).toEqual([]);
      expect(isTerminal(status)).toBe(true);
    }
  });
});
