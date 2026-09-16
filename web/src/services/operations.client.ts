import type { AdoptionReport, StoreAdoption } from '../models/adoption';
import type { DepartmentalOutcome } from '../models/departmental';
import type { QueueId } from '../models/ids';
import type { Page, PageRequest } from '../models/paging';
import type { ReportScope } from '../models/scope';
import type { TaskQueueFilter, TaskQueueItem, TaskQueueSort, TaskQueueSummary } from '../models/task-queue';
import { paths, scopeQuery, taskQueueItemQuery, taskQueueQuery } from './endpoints';
import type { ReportingHttpClient, ServiceResult } from './http-client';
import {
  decodeAdoptionPoint,
  decodeDepartmentalOutcomes,
  decodeStoreAdoptions,
  decodeTaskQueueItem,
  decodeTaskQueueSummaries,
} from './operations-decoders';
import { decodePage, decodeReportEnvelope } from './report-decoders';

/** Live work queues, as a store manager sees them right now. */
export interface TaskQueueClient {
  taskQueues(
    filter: TaskQueueFilter,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<readonly TaskQueueSummary[]>>;

  taskQueueItems(
    queue: QueueId,
    filter: TaskQueueFilter,
    sort: TaskQueueSort,
    page: PageRequest,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<Page<TaskQueueItem>>>;
}

/** Pilot instrumentation: whether the service is being used, not whether it works. */
export interface AdoptionClient {
  adoption(scope: ReportScope, signal?: AbortSignal | null): Promise<ServiceResult<AdoptionReport>>;

  storeAdoption(
    scope: ReportScope,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<readonly StoreAdoption[]>>;
}

/** The department cut of the outcome metrics — whose staff to move. */
export interface DepartmentalOutcomeClient {
  departmentalOutcomes(
    scope: ReportScope,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<readonly DepartmentalOutcome[]>>;
}

const decodeAdoptionReport = decodeReportEnvelope(decodeAdoptionPoint);
const decodeQueueItemPage = decodePage(decodeTaskQueueItem);

export const createTaskQueueClient = (http: ReportingHttpClient): TaskQueueClient => ({
  taskQueues: (filter, signal = null) =>
    http.get({
      path: paths.taskQueues(filter.retailerId),
      query: taskQueueQuery(filter),
      decode: decodeTaskQueueSummaries,
      signal,
    }),

  taskQueueItems: (queue, filter, sort, page, signal = null) =>
    http.get({
      path: paths.taskQueueItems(filter.retailerId, queue),
      query: taskQueueItemQuery(filter, sort, page),
      decode: decodeQueueItemPage,
      signal,
    }),
});

export const createAdoptionClient = (http: ReportingHttpClient): AdoptionClient => ({
  adoption: (scope, signal = null) =>
    http.get({
      path: paths.adoption(scope.retailerId),
      query: scopeQuery(scope),
      decode: decodeAdoptionReport,
      signal,
    }),

  storeAdoption: (scope, signal = null) =>
    http.get({
      path: paths.storeAdoption(scope.retailerId),
      query: scopeQuery(scope),
      decode: decodeStoreAdoptions,
      signal,
    }),
});

export const createDepartmentalOutcomeClient = (
  http: ReportingHttpClient,
): DepartmentalOutcomeClient => ({
  departmentalOutcomes: (scope, signal = null) =>
    http.get({
      path: paths.departmentalOutcomes(scope.retailerId),
      // The department breakdown is the report, so the dimension is not the
      // caller's to forget — it is forced on, whatever the scope carries.
      query: { ...scopeQuery(scope), breakdownBy: ['department'] },
      decode: decodeDepartmentalOutcomes,
      signal,
    }),
});
