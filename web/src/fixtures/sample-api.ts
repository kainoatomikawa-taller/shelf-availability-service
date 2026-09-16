import { err, ok } from '../models/result';
import type { ServiceError } from '../services/errors';
import type { ServiceResult } from '../services/http-client';
import type { DashboardApi } from '../services/reporting.client';
import { sampleDataset } from './sample-data';
import type { SampleDataset } from './sample-data';

export interface SampleApiOptions {
  /** Milliseconds before each call settles. `0` resolves on the microtask queue. */
  readonly latency?: number;
  /** Fail every call with this instead of answering — for exercising error states. */
  readonly failWith?: ServiceError | null;
  readonly dataset?: SampleDataset;
}

/**
 * A `DashboardApi` backed by the fixtures.
 *
 * This is what lets the components be rendered and asserted on in isolation:
 * the state layer, the effects and the panels all run exactly as they do against
 * the real service, with the HTTP client swapped for a resolved promise. Nothing
 * about the components has to know which one they are talking to.
 */
export const createSampleApi = ({
  latency = 0,
  failWith = null,
  dataset = sampleDataset(),
}: SampleApiOptions = {}): DashboardApi => {
  const answer = <T>(value: T): Promise<ServiceResult<T>> => {
    const result: ServiceResult<T> = failWith === null ? ok(value) : err(failWith);
    return latency <= 0
      ? Promise.resolve(result)
      : new Promise((resolve) => setTimeout(() => resolve(result), latency));
  };

  return {
    availabilityIndex: () => answer(dataset.availabilityIndex),
    availabilityRecords: () => answer(dataset.availabilityRecords),
    taskWorkRate: () => answer(dataset.taskWorkRate),
    resolvedGapRate: () => answer(dataset.resolvedGapRate),
    detectionToResolution: () => answer(dataset.detectionToResolution),
    reportableTaskTypes: () => answer(['restock_out_of_stock', 'replenish_low_stock'] as const),
    adoption: () => answer(dataset.adoption),
    storeAdoption: () => answer(dataset.storeAdoption),
    departmentalOutcomes: () => answer(dataset.departmentalOutcomes),
    taskQueues: () => answer(dataset.taskQueues),
    taskQueueItems: () => answer(dataset.taskQueueItems),
  };
};
