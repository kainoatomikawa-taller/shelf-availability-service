import {
  DETECTION_SOURCES,
  instantFromISO,
  standardEncryption,
  standardRetention,
  tenantSlug,
  timeWindow,
  type DetectionSource,
  type RetailerId,
  type RetailerTenant,
  type TenantSlug,
  type TimeWindow,
} from '../../src/index.js';
import { ACME, RIVAL } from './fixtures.js';

/**
 * Tenant fixtures for the platform tests.
 *
 * Two retailers, because one cannot demonstrate isolation — there is nothing for
 * it to leak into — and because two is also the floor a pilot is allowed to run.
 */

export const ACME_SLUG: TenantSlug = tenantSlug('acme-grocery');
export const RIVAL_SLUG: TenantSlug = tenantSlug('rival-mart');

export const PILOT_START = instantFromISO('2026-01-05T00:00:00.000Z');

/** Twelve months: comfortably inside the contracted 9–15. */
export const PILOT_WINDOW: TimeWindow = timeWindow(
  PILOT_START,
  instantFromISO('2027-01-05T00:00:00.000Z'),
);

export interface TenantOverrides {
  readonly sources?: readonly DetectionSource[];
  readonly stores?: number;
  readonly facings?: number;
  readonly residency?: RetailerTenant['residency'];
  readonly onboardedAt?: RetailerTenant['onboardedAt'];
}

export const tenant = (
  retailerId: RetailerId,
  slug: TenantSlug,
  overrides: TenantOverrides = {},
): RetailerTenant => ({
  retailerId,
  slug,
  displayName: slug,
  residency: overrides.residency ?? 'us',
  sources: overrides.sources ?? DETECTION_SOURCES,
  eslVendors: ['vusion'],
  scale: { stores: overrides.stores ?? 40, facings: overrides.facings ?? 20_000 },
  retention: standardRetention(retailerId),
  encryption: standardEncryption(slug),
  onboardedAt: overrides.onboardedAt ?? instantFromISO('2026-01-12T00:00:00.000Z'),
});

export const ACME_TENANT = tenant(ACME, ACME_SLUG);
export const RIVAL_TENANT = tenant(RIVAL, RIVAL_SLUG, {
  onboardedAt: instantFromISO('2026-02-02T00:00:00.000Z'),
});

export const TWO_TENANTS: readonly RetailerTenant[] = [ACME_TENANT, RIVAL_TENANT];
