import {
  LED_COLORS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
} from '../models/enums';
import { ADOPTION_STAGES } from '../models/adoption';
import type { AdoptionPoint, StoreAdoption } from '../models/adoption';
import type {
  CategoryOutcome,
  DepartmentalOutcome,
  ServiceLevelScope,
} from '../models/departmental';
import type {
  CategoryId,
  DepartmentId,
  EmployeeId,
  QueueId,
  RetailerId,
  StoreId,
  TaskId,
} from '../models/ids';
import type { TaskQueueItem, TaskQueueSummary } from '../models/task-queue';
import type { Decoder } from './decode';
import {
  at,
  decodeArray,
  decodeBoolean,
  decodeCount,
  decodeCountsOf,
  decodeEnum,
  decodeId,
  decodeInstant,
  decodeMillis,
  decodeNullable,
  decodeNumber,
  decodeRatio,
  decodeString,
  decodeTimeWindow,
  fail,
  field,
} from './decode';

const decodeRetailerId = decodeId<RetailerId>('RetailerId');
const decodeStoreId = decodeId<StoreId>('StoreId');
const decodeTaskType = decodeEnum(TASK_TYPES, 'TaskType');
const decodeTaskStatus = decodeEnum(TASK_STATUSES, 'TaskStatus');
const decodeTaskPriority = decodeEnum(TASK_PRIORITIES, 'TaskPriority');
const decodeLedColor = decodeEnum(LED_COLORS, 'LedColor');

const nullableInstant = decodeNullable(decodeInstant);
const nullableMillis = decodeNullable(decodeMillis);
const nullableRatio = decodeNullable(decodeRatio);
const nullableNumber = decodeNullable(decodeNumber);
const nullableString = decodeNullable(decodeString);

// ---------------------------------------------------------------------------
// Task queues
// ---------------------------------------------------------------------------

export const decodeTaskQueueSummary: Decoder<TaskQueueSummary> = (raw, path) => ({
  retailerId: decodeRetailerId(field(raw, 'retailerId', path), at(path, 'retailerId')),
  queueId: decodeId<QueueId>('QueueId')(field(raw, 'queueId', path), at(path, 'queueId')),
  storeId: decodeStoreId(field(raw, 'storeId', path), at(path, 'storeId')),
  label: decodeString(field(raw, 'label', path), at(path, 'label')),
  taskType: decodeNullable(decodeTaskType)(field(raw, 'taskType', path), at(path, 'taskType')),
  openCount: decodeCount(field(raw, 'openCount', path), at(path, 'openCount')),
  unassignedCount: decodeCount(field(raw, 'unassignedCount', path), at(path, 'unassignedCount')),
  breachingCount: decodeCount(field(raw, 'breachingCount', path), at(path, 'breachingCount')),
  awaitingVerificationCount: decodeCount(
    field(raw, 'awaitingVerificationCount', path),
    at(path, 'awaitingVerificationCount'),
  ),
  // Count maps default absent members to zero: a rollup legitimately omits an
  // empty bucket, and "no cancelled tasks" is a fact, not a gap in the data.
  countsByPriority: decodeCountsOf(TASK_PRIORITIES)(
    field(raw, 'countsByPriority', path),
    at(path, 'countsByPriority'),
  ),
  countsByStatus: decodeCountsOf(TASK_STATUSES)(
    field(raw, 'countsByStatus', path),
    at(path, 'countsByStatus'),
  ),
  oldestOpenAt: nullableInstant(field(raw, 'oldestOpenAt', path), at(path, 'oldestOpenAt')),
  updatedAt: decodeInstant(field(raw, 'updatedAt', path), at(path, 'updatedAt')),
});

/**
 * A task row, flattening the service's `TaskState` union into status plus
 * nullable timestamps.
 *
 * The flattening is checked rather than assumed: a task reported as
 * `acknowledged` with no `acknowledgedAt` is a contract break, not a row to
 * render with a blank cell, because every downstream age and lag calculation
 * would silently skip it.
 */
export const decodeTaskQueueItem: Decoder<TaskQueueItem> = (raw, path) => {
  const status = decodeTaskStatus(field(raw, 'status', path), at(path, 'status'));
  const acknowledgedAt = nullableInstant(
    field(raw, 'acknowledgedAt', path),
    at(path, 'acknowledgedAt'),
  );
  const resolvedAt = nullableInstant(field(raw, 'resolvedAt', path), at(path, 'resolvedAt'));

  if (REQUIRES_ACKNOWLEDGED_AT.has(status) && acknowledgedAt === null) {
    fail(at(path, 'acknowledgedAt'), `timestamp for a task in status "${status}"`, null);
  }
  if (status === 'awaiting_verification' && resolvedAt === null) {
    fail(at(path, 'resolvedAt'), 'timestamp for a task awaiting verification', null);
  }

  return {
    retailerId: decodeRetailerId(field(raw, 'retailerId', path), at(path, 'retailerId')),
    storeId: decodeStoreId(field(raw, 'storeId', path), at(path, 'storeId')),
    taskId: decodeId<TaskId>('TaskId')(field(raw, 'taskId', path), at(path, 'taskId')),
    facingId: decodeId<TaskQueueItem['facingId']>('FacingId')(
      field(raw, 'facingId', path),
      at(path, 'facingId'),
    ),
    productId: decodeId<TaskQueueItem['productId']>('ProductId')(
      field(raw, 'productId', path),
      at(path, 'productId'),
    ),
    productName: decodeString(field(raw, 'productName', path), at(path, 'productName')),
    location: decodeQueueLocation(field(raw, 'location', path), at(path, 'location')),
    type: decodeTaskType(field(raw, 'type', path), at(path, 'type')),
    priority: decodeTaskPriority(field(raw, 'priority', path), at(path, 'priority')),
    lane: decodeLedColor(field(raw, 'lane', path), at(path, 'lane')),
    status,
    assigneeId: decodeNullable(decodeId<EmployeeId>('EmployeeId'))(
      field(raw, 'assigneeId', path),
      at(path, 'assigneeId'),
    ),
    assigneeName: nullableString(field(raw, 'assigneeName', path), at(path, 'assigneeName')),
    createdAt: decodeInstant(field(raw, 'createdAt', path), at(path, 'createdAt')),
    updatedAt: decodeInstant(field(raw, 'updatedAt', path), at(path, 'updatedAt')),
    acknowledgedAt,
    resolvedAt,
    failedVerifications: decodeCount(
      field(raw, 'failedVerifications', path),
      at(path, 'failedVerifications'),
    ),
    requiresVerification: decodeBoolean(
      field(raw, 'requiresVerification', path),
      at(path, 'requiresVerification'),
    ),
    dueAt: nullableInstant(field(raw, 'dueAt', path), at(path, 'dueAt')),
  };
};

/** States a task cannot be in without having been acknowledged first. */
const REQUIRES_ACKNOWLEDGED_AT = new Set(['acknowledged', 'in_progress', 'awaiting_verification']);

const decodeQueueLocation: Decoder<TaskQueueItem['location']> = (raw, path) => ({
  aisle: decodeString(field(raw, 'aisle', path), at(path, 'aisle')),
  bay: decodeString(field(raw, 'bay', path), at(path, 'bay')),
  shelf: decodeCount(field(raw, 'shelf', path), at(path, 'shelf')),
  position: decodeCount(field(raw, 'position', path), at(path, 'position')),
});

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

export const decodeAdoptionPoint: Decoder<AdoptionPoint> = (raw, path) => ({
  window: decodeTimeWindow(field(raw, 'window', path), at(path, 'window')),
  enrolledStores: decodeCount(field(raw, 'enrolledStores', path), at(path, 'enrolledStores')),
  activeStores: decodeCount(field(raw, 'activeStores', path), at(path, 'activeStores')),
  enrolledEmployees: decodeCount(
    field(raw, 'enrolledEmployees', path),
    at(path, 'enrolledEmployees'),
  ),
  activeEmployees: decodeCount(field(raw, 'activeEmployees', path), at(path, 'activeEmployees')),
  storeActivationRate: nullableRatio(
    field(raw, 'storeActivationRate', path),
    at(path, 'storeActivationRate'),
  ),
  employeeActivationRate: nullableRatio(
    field(raw, 'employeeActivationRate', path),
    at(path, 'employeeActivationRate'),
  ),
  tasksAcknowledged: decodeCount(
    field(raw, 'tasksAcknowledged', path),
    at(path, 'tasksAcknowledged'),
  ),
  tasksDispatched: decodeCount(field(raw, 'tasksDispatched', path), at(path, 'tasksDispatched')),
  acknowledgementRate: nullableRatio(
    field(raw, 'acknowledgementRate', path),
    at(path, 'acknowledgementRate'),
  ),
  medianAcknowledgementLag: nullableMillis(
    field(raw, 'medianAcknowledgementLag', path),
    at(path, 'medianAcknowledgementLag'),
  ),
  tasksClosedInApp: decodeCount(field(raw, 'tasksClosedInApp', path), at(path, 'tasksClosedInApp')),
  appSessions: decodeCount(field(raw, 'appSessions', path), at(path, 'appSessions')),
});

export const decodeStoreAdoption: Decoder<StoreAdoption> = (raw, path) => ({
  storeId: decodeStoreId(field(raw, 'storeId', path), at(path, 'storeId')),
  storeName: decodeString(field(raw, 'storeName', path), at(path, 'storeName')),
  stage: decodeEnum(ADOPTION_STAGES, 'AdoptionStage')(field(raw, 'stage', path), at(path, 'stage')),
  enrolledEmployees: decodeCount(
    field(raw, 'enrolledEmployees', path),
    at(path, 'enrolledEmployees'),
  ),
  activeEmployees: decodeCount(field(raw, 'activeEmployees', path), at(path, 'activeEmployees')),
  acknowledgementRate: nullableRatio(
    field(raw, 'acknowledgementRate', path),
    at(path, 'acknowledgementRate'),
  ),
  tasksAcknowledged: decodeCount(
    field(raw, 'tasksAcknowledged', path),
    at(path, 'tasksAcknowledged'),
  ),
  medianAcknowledgementLag: nullableMillis(
    field(raw, 'medianAcknowledgementLag', path),
    at(path, 'medianAcknowledgementLag'),
  ),
  lastActivityAt: nullableInstant(field(raw, 'lastActivityAt', path), at(path, 'lastActivityAt')),
});

// ---------------------------------------------------------------------------
// Departmental outcomes
// ---------------------------------------------------------------------------

/**
 * Service-level scope, decoded as the union it is.
 *
 * `below_revisit_threshold` and `unmeasured` are not interchangeable and the
 * decoder will not let them become so: the first carries a measured density that
 * missed the bar, the second carries `null` because nothing was weighed at all.
 */
export const decodeServiceLevelScope: Decoder<ServiceLevelScope> = (raw, path) => {
  const inScope = decodeBoolean(field(raw, 'inScope', path), at(path, 'inScope'));
  if (inScope) {
    return {
      inScope: true,
      density: decodeNumber(field(raw, 'density', path), at(path, 'density')),
    };
  }
  const reason = decodeEnum(
    ['below_revisit_threshold', 'unmeasured'] as const,
    'ServiceLevelExclusion',
  )(field(raw, 'reason', path), at(path, 'reason'));
  const required = decodeNumber(field(raw, 'required', path), at(path, 'required'));
  return reason === 'unmeasured'
    ? { inScope: false, reason, density: null, required }
    : {
        inScope: false,
        reason,
        density: decodeNumber(field(raw, 'density', path), at(path, 'density')),
        required,
      };
};

export const decodeDepartmentalOutcome: Decoder<DepartmentalOutcome> = (raw, path) => ({
  departmentId: decodeId<DepartmentId>('DepartmentId')(
    field(raw, 'departmentId', path),
    at(path, 'departmentId'),
  ),
  departmentName: decodeString(field(raw, 'departmentName', path), at(path, 'departmentName')),
  storeId: decodeNullable(decodeStoreId)(field(raw, 'storeId', path), at(path, 'storeId')),
  window: decodeTimeWindow(field(raw, 'window', path), at(path, 'window')),
  availabilityIndex: nullableRatio(
    field(raw, 'availabilityIndex', path),
    at(path, 'availabilityIndex'),
  ),
  coverage: decodeRatio(field(raw, 'coverage', path), at(path, 'coverage')),
  facingCount: decodeCount(field(raw, 'facingCount', path), at(path, 'facingCount')),
  availabilityIndexDelta: nullableNumber(
    field(raw, 'availabilityIndexDelta', path),
    at(path, 'availabilityIndexDelta'),
  ),
  detectedGaps: decodeCount(field(raw, 'detectedGaps', path), at(path, 'detectedGaps')),
  resolvedGapRate: nullableRatio(field(raw, 'resolvedGapRate', path), at(path, 'resolvedGapRate')),
  awaitingVerification: decodeCount(
    field(raw, 'awaitingVerification', path),
    at(path, 'awaitingVerification'),
  ),
  tasksCreated: decodeCount(field(raw, 'tasksCreated', path), at(path, 'tasksCreated')),
  tasksVerified: decodeCount(field(raw, 'tasksVerified', path), at(path, 'tasksVerified')),
  tasksOutstanding: decodeCount(field(raw, 'tasksOutstanding', path), at(path, 'tasksOutstanding')),
  tasksPerLabourHour: nullableNumber(
    field(raw, 'tasksPerLabourHour', path),
    at(path, 'tasksPerLabourHour'),
  ),
  reworkRate: nullableRatio(field(raw, 'reworkRate', path), at(path, 'reworkRate')),
  medianDetectionToVerification: nullableMillis(
    field(raw, 'medianDetectionToVerification', path),
    at(path, 'medianDetectionToVerification'),
  ),
  serviceLevel: decodeServiceLevelScope(field(raw, 'serviceLevel', path), at(path, 'serviceLevel')),
  computedAt: decodeInstant(field(raw, 'computedAt', path), at(path, 'computedAt')),
});

export const decodeCategoryOutcome: Decoder<CategoryOutcome> = (raw, path) => ({
  categoryId: decodeId<CategoryId>('CategoryId')(
    field(raw, 'categoryId', path),
    at(path, 'categoryId'),
  ),
  categoryName: decodeString(field(raw, 'categoryName', path), at(path, 'categoryName')),
  departmentId: decodeId<DepartmentId>('DepartmentId')(
    field(raw, 'departmentId', path),
    at(path, 'departmentId'),
  ),
  availabilityIndex: nullableRatio(
    field(raw, 'availabilityIndex', path),
    at(path, 'availabilityIndex'),
  ),
  coverage: decodeRatio(field(raw, 'coverage', path), at(path, 'coverage')),
  detectedGaps: decodeCount(field(raw, 'detectedGaps', path), at(path, 'detectedGaps')),
  resolvedGapRate: nullableRatio(field(raw, 'resolvedGapRate', path), at(path, 'resolvedGapRate')),
  serviceLevel: decodeServiceLevelScope(field(raw, 'serviceLevel', path), at(path, 'serviceLevel')),
});

export const decodeDepartmentalOutcomes: Decoder<readonly DepartmentalOutcome[]> = (raw, path) =>
  decodeArray(decodeDepartmentalOutcome)(field(raw, 'departments', path), at(path, 'departments'));

export const decodeStoreAdoptions: Decoder<readonly StoreAdoption[]> = (raw, path) =>
  decodeArray(decodeStoreAdoption)(field(raw, 'stores', path), at(path, 'stores'));

export const decodeTaskQueueSummaries: Decoder<readonly TaskQueueSummary[]> = (raw, path) =>
  decodeArray(decodeTaskQueueSummary)(field(raw, 'queues', path), at(path, 'queues'));
