import type { TaskType } from '../models/enums';
import { TASK_TYPES } from '../models/enums';
import type { ReportScope } from '../models/scope';
import type {
  DetectionToResolutionReport,
  ResolvedGapRateReport,
  TaskWorkRateReport,
} from '../models/task-performance';
import { at, decodeArray, decodeEnum, field } from './decode';
import { paths, scopeQuery } from './endpoints';
import type { ReportingHttpClient, ServiceResult } from './http-client';
import {
  decodeDetectionToResolutionPoint,
  decodeReportEnvelope,
  decodeResolvedGapRatePoint,
  decodeTaskWorkRatePoint,
} from './report-decoders';

/**
 * How well the loop is closing, as opposed to how stocked the shelf is.
 *
 * The three reports are separate calls rather than one combined response on
 * purpose: they are read on different cadences and at different grains, and a
 * store manager watching a task queue should not pay for a percentile
 * computation they are not looking at.
 */
export interface TaskPerformanceQueryClient {
  /** Task throughput, completion and rework, with per-labour-hour rate when available. */
  taskWorkRate(
    scope: ReportScope,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<TaskWorkRateReport>>;

  /** Share of detected gaps that reached a verified resolution. */
  resolvedGapRate(
    scope: ReportScope,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<ResolvedGapRateReport>>;

  /** Stage-by-stage latency from detection through verification. */
  detectionToResolution(
    scope: ReportScope,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<DetectionToResolutionReport>>;

  /** Task types in scope for the retailer, for building breakdown filters. */
  reportableTaskTypes(
    retailerId: string,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<readonly TaskType[]>>;
}

const decodeWorkRate = decodeReportEnvelope(decodeTaskWorkRatePoint);
const decodeGapRate = decodeReportEnvelope(decodeResolvedGapRatePoint);
const decodeLatency = decodeReportEnvelope(decodeDetectionToResolutionPoint);
const decodeTaskTypes = (raw: unknown, path: string): readonly TaskType[] =>
  decodeArray(decodeEnum(TASK_TYPES, 'TaskType'))(
    field(raw, 'taskTypes', path),
    at(path, 'taskTypes'),
  );

export const createTaskPerformanceClient = (
  http: ReportingHttpClient,
): TaskPerformanceQueryClient => ({
  taskWorkRate: (scope, signal = null) =>
    http.get({
      path: paths.taskWorkRate(scope.retailerId),
      query: scopeQuery(scope),
      decode: decodeWorkRate,
      signal,
    }),

  resolvedGapRate: (scope, signal = null) =>
    http.get({
      path: paths.resolvedGapRate(scope.retailerId),
      query: scopeQuery(scope),
      decode: decodeGapRate,
      signal,
    }),

  detectionToResolution: (scope, signal = null) =>
    http.get({
      path: paths.detectionToResolution(scope.retailerId),
      query: scopeQuery(scope),
      decode: decodeLatency,
      signal,
    }),

  reportableTaskTypes: (retailerId, signal = null) =>
    http.get({
      path: paths.reportableTaskTypes(retailerId),
      query: {},
      decode: decodeTaskTypes,
      signal,
    }),
});
