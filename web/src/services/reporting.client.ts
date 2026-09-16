import type { AvailabilityQueryClient } from './availability.client';
import { createAvailabilityClient } from './availability.client';
import type { HttpClientConfig } from './http-client';
import { createHttpClient } from './http-client';
import type { AdoptionClient, DepartmentalOutcomeClient, TaskQueueClient } from './operations.client';
import {
  createAdoptionClient,
  createDepartmentalOutcomeClient,
  createTaskQueueClient,
} from './operations.client';
import type { TaskPerformanceQueryClient } from './task-performance.client';
import { createTaskPerformanceClient } from './task-performance.client';

/**
 * The whole read side, as the dashboard consumes it.
 *
 * Composed from the four cohesive clients rather than declared as one flat
 * interface, so the composition is visible and a panel can still be typed
 * against the narrow surface it actually needs.
 */
export interface DashboardApi
  extends AvailabilityQueryClient,
    TaskPerformanceQueryClient,
    TaskQueueClient,
    AdoptionClient,
    DepartmentalOutcomeClient {}

export const createDashboardApi = (
  baseUrl: string,
  overrides: Partial<Omit<HttpClientConfig, 'baseUrl'>> = {},
): DashboardApi => {
  const http = createHttpClient(baseUrl, overrides);
  return {
    ...createAvailabilityClient(http),
    ...createTaskPerformanceClient(http),
    ...createTaskQueueClient(http),
    ...createAdoptionClient(http),
    ...createDepartmentalOutcomeClient(http),
  };
};
