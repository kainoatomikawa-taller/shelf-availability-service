import {
  DETECTION_SOURCES,
  instantFromISO,
  standardEncryption,
  retailerId,
  standardRetention,
  tenantSlug,
  timeWindow,
  type DetectionSource,
  type EslVendor,
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
  readonly eslVendors?: readonly EslVendor[];
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
  eslVendors: overrides.eslVendors ?? ['vusion'],
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

/**
 * The other two pilots, for the tests that run at the top of the contracted range.
 *
 * Four is the ceiling `planPilotDeployment` enforces, and it is worth exercising
 * as well as the floor: two retailers can demonstrate that a partition holds,
 * while four is the number at which a pooling bug has somewhere non-obvious to
 * hide — a leak into the *third* tenant is invisible to any test that only ever
 * has a neighbour.
 */
export const NORTH: RetailerId = retailerId('north-foods');
export const SUD: RetailerId = retailerId('sud-markt');

export const NORTH_SLUG: TenantSlug = tenantSlug('north-foods');
export const SUD_SLUG: TenantSlug = tenantSlug('sud-markt');

export const NORTH_TENANT = tenant(NORTH, NORTH_SLUG, {
  onboardedAt: instantFromISO('2026-01-19T00:00:00.000Z'),
  eslVendors: ['solum'],
});

export const SUD_TENANT = tenant(SUD, SUD_SLUG, {
  onboardedAt: instantFromISO('2026-02-16T00:00:00.000Z'),
  residency: 'eu',
  eslVendors: ['pricer'],
});

export const FOUR_TENANTS: readonly RetailerTenant[] = [
  ACME_TENANT,
  RIVAL_TENANT,
  NORTH_TENANT,
  SUD_TENANT,
];
