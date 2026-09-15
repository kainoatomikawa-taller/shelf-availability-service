import type { Brand } from '../domain/common/brand.js';
import type { RetailerId } from '../domain/common/ids.js';
import type { Instant, Millis } from '../domain/common/time.js';
import type { DetectionSource } from '../ports/inbound/detection-ingestion.port.js';
import type { EslVendor } from '../adapters/outbound/esl/tag-model.js';
import type { EncryptionAtRest } from './encryption.js';
import type { RetentionPolicy } from './retention.js';

/**
 * Who the pilots are, and the one name every piece of their infrastructure is
 * derived from.
 *
 * The domain already treats `retailerId` as a partition key that no operation may
 * mix. This module is the other half of that invariant: the point where a
 * retailer stops being a value in a record and becomes a schema, a role, a key
 * alias, a topic prefix and a consumer group. Everything physical is derived from
 * one slug, in one place, so "no cross-retailer pooling" is a property of how the
 * names are generated rather than a rule each provisioning script is trusted to
 * have followed.
 */

/**
 * A retailer's name as it appears in infrastructure.
 *
 * Separate from `RetailerId` because the id is whatever a retailer's contract
 * says it is, and a slug has to survive being interpolated into a SQL identifier,
 * a topic name, a consumer group and a key alias. Branded so a raw string cannot
 * reach any of those places without passing `tenantSlug`.
 */
export type TenantSlug = Brand<string, 'TenantSlug'>;

/**
 * The intersection of every downstream naming rule, not the union.
 *
 * Lower-case alphanumerics and single hyphens: safe unquoted in a Postgres
 * identifier once hyphens become underscores, safe as one Kafka topic segment,
 * safe in a KMS alias path, and short enough that `osa_<slug>_ts` clears
 * Postgres's 63-byte identifier limit with room to spare. Deliberately strict —
 * a slug is chosen once at onboarding, so the cost of the rule is a conversation
 * and the cost of getting it wrong is an injection point in generated DDL.
 */
const SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 40;

/** Raised for any tenancy configuration that could not be provisioned safely. */
export class TenancyConfigError extends Error {
  readonly code = 'TENANCY_CONFIG' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TenancyConfigError';
  }
}

export const tenantSlug = (raw: string): TenantSlug => {
  if (!SLUG_PATTERN.test(raw)) {
    throw new TenancyConfigError(
      `Tenant slug must match ${SLUG_PATTERN.source}, got "${raw}" — slugs become SQL identifiers, topic segments and key aliases`,
    );
  }
  if (raw.length > SLUG_MAX_LENGTH) {
    throw new TenancyConfigError(
      `Tenant slug "${raw}" is ${raw.length} characters; the limit is ${SLUG_MAX_LENGTH} so derived identifiers stay inside Postgres's 63-byte limit`,
    );
  }
  return raw as TenantSlug;
};

/**
 * Where a retailer's data is allowed to live.
 *
 * Carried on the tenant rather than on the deployment because it is the retailer's
 * property, not the pilot's: two pilots in different regions cannot share a store,
 * a broker cluster or a key, and the planner refuses to put them in one.
 */
export type DataResidency = 'us' | 'eu' | 'uk' | 'ca' | 'au';

/**
 * How big this retailer's pilot is, in the two units that actually drive sizing.
 *
 * Stores and facings, not requests per second: the detection load is a function
 * of how much shelf is being watched and by how many producers, and those are
 * numbers a retailer can state at contract time.
 */
export interface TenantScale {
  readonly stores: number;
  /** Facings under measurement across those stores. */
  readonly facings: number;
}

export interface RetailerTenant {
  readonly retailerId: RetailerId;
  readonly slug: TenantSlug;
  readonly displayName: string;
  readonly residency: DataResidency;
  /**
   * The detection producers this retailer actually runs.
   *
   * Explicit rather than "all five", because provisioning a topic a retailer has
   * no producer for buys an unattended stream and an ACL nobody reviews, and
   * because a missing source should be visible in the deployment plan rather
   * than inferred from an empty topic six weeks in.
   */
  readonly sources: readonly DetectionSource[];
  /** The shelf-edge fleets installed in this retailer's stores. */
  readonly eslVendors: readonly EslVendor[];
  readonly scale: TenantScale;
  readonly retention: RetentionPolicy;
  readonly encryption: EncryptionAtRest;
  /** When this retailer's data starts; the floor under every retention horizon. */
  readonly onboardedAt: Instant;
}

/**
 * Every physical name one retailer owns.
 *
 * The single derivation. Nothing else in the codebase builds a schema name, a
 * role name, a topic prefix or a consumer group from a slug, so reviewing tenant
 * isolation means reviewing this function and the uniqueness check below it.
 */
export interface TenantNamespaces {
  readonly retailerId: RetailerId;
  readonly slug: TenantSlug;
  /** Postgres schema holding the retailer's relational tables. */
  readonly relationalSchema: string;
  /** Postgres schema holding the retailer's time-partitioned tables. */
  readonly timeseriesSchema: string;
  /** The only role granted anything inside those two schemas. */
  readonly role: string;
  /** Prefix covering every topic this retailer owns, and no other retailer's. */
  readonly topicPrefix: string;
  /** Consumer group reading this retailer's topics; lag is per retailer as a result. */
  readonly consumerGroup: string;
}

/** `acme-grocery` → `acme_grocery`; hyphens are legal in a slug, awkward in an identifier. */
export const sqlIdentifierOf = (slug: TenantSlug): string => slug.replaceAll('-', '_');

export const namespacesOf = (tenant: RetailerTenant): TenantNamespaces => {
  const identifier = sqlIdentifierOf(tenant.slug);
  return {
    retailerId: tenant.retailerId,
    slug: tenant.slug,
    relationalSchema: `osa_${identifier}`,
    timeseriesSchema: `osa_${identifier}_ts`,
    role: `osa_${identifier}_app`,
    topicPrefix: `osa.${tenant.slug}.`,
    consumerGroup: `osa-ingest-${tenant.slug}`,
  };
};

/**
 * The onboarded retailers, indexed.
 *
 * A class rather than a map so the failure mode of an unknown retailer is a named
 * error at the boundary instead of an `undefined` that flows onward as a missing
 * schema name.
 */
export class TenantRegistry {
  private readonly byRetailer: ReadonlyMap<RetailerId, RetailerTenant>;
  private readonly bySlug: ReadonlyMap<TenantSlug, RetailerTenant>;
  readonly tenants: readonly RetailerTenant[];

  constructor(tenants: readonly RetailerTenant[]) {
    assertDistinctTenants(tenants);
    this.tenants = [...tenants];
    this.byRetailer = new Map(tenants.map((tenant) => [tenant.retailerId, tenant]));
    this.bySlug = new Map(tenants.map((tenant) => [tenant.slug, tenant]));
  }

  get size(): number {
    return this.tenants.length;
  }

  find(retailerId: RetailerId): RetailerTenant | null {
    return this.byRetailer.get(retailerId) ?? null;
  }

  /** The retailer, or a named failure. Used wherever a missing tenant is a bug. */
  require(retailerId: RetailerId): RetailerTenant {
    const tenant = this.byRetailer.get(retailerId);
    if (tenant === undefined) {
      throw new TenancyConfigError(
        `Retailer "${retailerId}" is not onboarded in this deployment; onboarded: ${this.tenants.map((t) => t.retailerId).join(', ') || '(none)'}`,
      );
    }
    return tenant;
  }

  bySlugOrNull(slug: TenantSlug): RetailerTenant | null {
    return this.bySlug.get(slug) ?? null;
  }

  namespaces(): readonly TenantNamespaces[] {
    return this.tenants.map(namespacesOf);
  }
}

/**
 * Refuses any two tenants that would collide on something physical.
 *
 * Ids and slugs are the obvious ones. Key references are checked here too,
 * because a shared key is the failure that survives every other control: two
 * retailers in properly separate schemas whose data is wrapped by one key are one
 * `GRANT` away from being readable as a single corpus, and nothing downstream
 * would notice.
 */
export function assertDistinctTenants(tenants: readonly RetailerTenant[]): void {
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  const seenKeys = new Map<string, RetailerId>();

  for (const tenant of tenants) {
    if (seenIds.has(tenant.retailerId)) {
      throw new TenancyConfigError(`Retailer "${tenant.retailerId}" is configured twice`);
    }
    seenIds.add(tenant.retailerId);

    if (seenSlugs.has(tenant.slug)) {
      throw new TenancyConfigError(
        `Tenant slug "${tenant.slug}" is used by two retailers; every physical name is derived from it, so they would share a schema, a role and a topic prefix`,
      );
    }
    seenSlugs.add(tenant.slug);

    for (const keyRef of [tenant.encryption.dataKeyRef, tenant.encryption.backupKeyRef]) {
      const owner = seenKeys.get(keyRef);
      if (owner !== undefined && owner !== tenant.retailerId) {
        throw new TenancyConfigError(
          `Encryption key "${keyRef}" is shared by retailers "${owner}" and "${tenant.retailerId}"; a per-retailer key is what makes a storage-level mix-up unreadable rather than merely unlikely`,
        );
      }
      seenKeys.set(keyRef, tenant.retailerId);
    }
  }
}

/** How long a retailer has been onboarded, for reporting against the pilot window. */
export const tenantAge = (tenant: RetailerTenant, now: Instant): Millis =>
  Math.max(0, now - tenant.onboardedAt) as Millis;
