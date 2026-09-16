import type {
  AvailabilityIndexReport,
  AvailabilityRecord,
  AvailabilityRecordQuery,
} from '../models/availability';
import type { Page } from '../models/paging';
import type { ReportScope } from '../models/scope';
import { availabilityRecordQuery, paths, scopeQuery } from './endpoints';
import type { ReportingHttpClient, ServiceResult } from './http-client';
import {
  decodeAvailabilityIndexPoint,
  decodeAvailabilityRecord,
  decodePage,
  decodeReportEnvelope,
} from './report-decoders';

/**
 * Availability figures and the records behind them.
 *
 * Mirrors the service's `AvailabilityQueryPort` one method for one method: the
 * read side is split by cohesion rather than exposed as one fat surface, and a
 * dashboard client that recombined them would put the seam back in the wrong
 * place.
 */
export interface AvailabilityQueryClient {
  /** Availability index (facing-time in stock) for the scope. */
  availabilityIndex(
    scope: ReportScope,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<AvailabilityIndexReport>>;

  /** Per-facing availability records, paged. */
  availabilityRecords(
    query: AvailabilityRecordQuery,
    signal?: AbortSignal | null,
  ): Promise<ServiceResult<Page<AvailabilityRecord>>>;
}

const decodeIndexReport = decodeReportEnvelope(decodeAvailabilityIndexPoint);
const decodeRecordPage = decodePage(decodeAvailabilityRecord);

export const createAvailabilityClient = (http: ReportingHttpClient): AvailabilityQueryClient => ({
  availabilityIndex: (scope, signal = null) =>
    http.get({
      path: paths.availabilityIndex(scope.retailerId),
      query: scopeQuery(scope),
      decode: decodeIndexReport,
      signal,
    }),

  availabilityRecords: (query, signal = null) =>
    http.get({
      path: paths.availabilityRecords(query.scope.retailerId),
      query: availabilityRecordQuery(query),
      decode: decodeRecordPage,
      signal,
    }),
});
