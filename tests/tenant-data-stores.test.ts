import { describe, expect, it } from 'vitest';
import {
  assertDistinctTenants,
  assertEncryptionIsDeployable,
  assertNoCrossRetailerPooling,
  assertRetentionIsCoherent,
  auditRetentionOf,
  DATA_CLASSES,
  DAY,
  horizonOf,
  ingestionHorizon,
  instantFromISO,
  keyRef,
  millis,
  namespacesOf,
  planDataStores,
  planRetailerDataStore,
  renderTenantBootstrapDDL,
  renderTenantIsolationDDL,
  retainedFrom,
  sqlIdentifierOf,
  sqlLiteral,
  standardEncryption,
  standardRetention,
  STANDARD_RETENTION_HORIZONS,
  TABLE_SPECS,
  tenantSlug,
  TenantRegistry,
  type RetailerTenant,
} from '../src/index.js';
import { ACME, RIVAL } from './support/fixtures.js';
import { ACME_SLUG, ACME_TENANT, PILOT_START, RIVAL_TENANT, TWO_TENANTS, tenant } from './support/tenancy.js';

/**
 * Provisioning: one partition, one key and one retention policy per retailer.
 *
 * These are the tests that stand behind "no cross-retailer pooling". The domain
 * already refuses to *compute* across two retailers; what is checked here is the
 * layer below that — that the two retailers were never given anywhere to pool in
 * the first place, and that a configuration which would give them one is refused
 * while it is still a plan.
 */

describe('tenant slugs', () => {
  it('accepts a lower-case, hyphenated name', () => {
    expect(tenantSlug('acme-grocery')).toBe('acme-grocery');
  });

  it.each([
    ['acme.eu', 'a dot would re-parse as a second topic segment'],
    ['Acme', 'upper case would need quoting as a SQL identifier'],
    ['acme--eu', 'a doubled hyphen is a typo more often than a name'],
    ['-acme', 'a leading hyphen is not a legal identifier start'],
    ["acme'; DROP SCHEMA osa_rival; --", 'the whole reason the pattern is strict'],
  ])('refuses "%s" — %s', (raw) => {
    expect(() => tenantSlug(raw)).toThrow(/Tenant slug must match/);
  });

  it('refuses a slug long enough to overflow a derived identifier', () => {
    expect(() => tenantSlug('a'.repeat(41))).toThrow(/63-byte limit/);
  });

  it('derives every physical name from the slug and nothing else', () => {
    const namespaces = namespacesOf(ACME_TENANT);

    expect(namespaces).toEqual({
      retailerId: ACME,
      slug: ACME_SLUG,
      relationalSchema: 'osa_acme_grocery',
      timeseriesSchema: 'osa_acme_grocery_ts',
      role: 'osa_acme_grocery_app',
      topicPrefix: 'osa.acme-grocery.',
      consumerGroup: 'osa-ingest-acme-grocery',
    });
    expect(sqlIdentifierOf(ACME_SLUG)).toBe('acme_grocery');
  });
});

describe('the tenant registry', () => {
  it('refuses two retailers sharing a slug', () => {
    const clash = tenant(RIVAL, ACME_SLUG);

    expect(() => new TenantRegistry([ACME_TENANT, clash])).toThrow(
      /Tenant slug "acme-grocery" is used by two retailers/,
    );
  });

  it('refuses two retailers sharing an encryption key', () => {
    const shared: RetailerTenant = { ...RIVAL_TENANT, encryption: ACME_TENANT.encryption };

    expect(() => assertDistinctTenants([ACME_TENANT, shared])).toThrow(
      /Encryption key .* is shared by retailers/,
    );
  });

  it('refuses the same retailer configured twice', () => {
    expect(() => new TenantRegistry([ACME_TENANT, ACME_TENANT])).toThrow(/configured twice/);
  });

  it('names the retailer rather than returning undefined for one it does not have', () => {
    const registry = new TenantRegistry([ACME_TENANT]);

    expect(registry.find(RIVAL)).toBeNull();
    expect(() => registry.require(RIVAL)).toThrow(/"rival-mart" is not onboarded/);
    expect(registry.require(ACME)).toBe(ACME_TENANT);
  });
});

describe('encryption at rest', () => {
  it('gives each retailer their own customer-managed key, derived from their slug', () => {
    const acme = standardEncryption('acme-grocery');
    const rival = standardEncryption('rival-mart');

    expect(acme).toMatchObject({
      algorithm: 'aes-256-gcm',
      keyManagement: 'customer-managed',
      envelopeEncryption: true,
      minimumTlsVersion: '1.3',
    });
    expect(acme.dataKeyRef).toBe('alias/osa/acme-grocery/data');
    expect(new Set([acme.dataKeyRef, acme.backupKeyRef, rival.dataKeyRef, rival.backupKeyRef]).size)
      .toBe(4);
  });

  it('refuses a provider-managed key, which the retailer cannot revoke', () => {
    expect(() =>
      assertEncryptionIsDeployable(
        { ...standardEncryption('acme-grocery'), keyManagement: 'provider-managed' },
        'Acme',
      ),
    ).toThrow(/cannot be revoked by the retailer/);
  });

  it('refuses one key for both live data and backups', () => {
    const encryption = standardEncryption('acme-grocery');

    expect(() =>
      assertEncryptionIsDeployable(
        { ...encryption, backupKeyRef: encryption.dataKeyRef },
        'Acme',
      ),
    ).toThrow(/leaked snapshot then reads as freely/);
  });

  it('refuses a key reference that is not one of ours', () => {
    expect(() => keyRef('arn:aws:kms:us-east-1:1234:key/abcd')).toThrow(/Key reference must match/);
  });
});

describe('retention', () => {
  it('gives every data class a horizon', () => {
    for (const dataClass of DATA_CLASSES) {
      expect(STANDARD_RETENTION_HORIZONS[dataClass]).toBeGreaterThan(0);
    }
    expect(DATA_CLASSES).toHaveLength(Object.keys(STANDARD_RETENTION_HORIZONS).length);
  });

  it('keeps the derived state longer than the raw events it came from', () => {
    const policy = standardRetention(ACME);

    expect(horizonOf(policy, 'facing_history')).toBeGreaterThan(
      horizonOf(policy, 'detection_event'),
    );
    expect(horizonOf(policy, 'audit_artifact')).toBeGreaterThan(
      horizonOf(policy, 'facing_history'),
    );
    // The verbatim vendor payload is the shortest-lived thing in the estate.
    expect(horizonOf(policy, 'dead_letter')).toBeLessThan(horizonOf(policy, 'detection_event'));
  });

  it('refuses a policy that would expire history before the events behind it', () => {
    const policy = standardRetention(ACME);

    expect(() =>
      assertRetentionIsCoherent({
        ...policy,
        horizons: { ...policy.horizons, facing_history: millis(1 * DAY) },
      }),
    ).toThrow(/keeps "detection_event" .* longer than "facing_history"/);
  });

  it('refuses a policy that would keep a dead letter past its detection events', () => {
    const policy = standardRetention(ACME);

    expect(() =>
      assertRetentionIsCoherent({
        ...policy,
        horizons: { ...policy.horizons, dead_letter: millis(9_999 * DAY) },
      }),
    ).toThrow(/verbatim vendor payload must not outlive/);
  });

  it('never reports a retained-from instant before the retailer was onboarded', () => {
    const policy = standardRetention(ACME);
    const justOnboarded = instantFromISO('2026-01-10T00:00:00.000Z');

    // Ninety days of detection retention against five days of relationship.
    expect(retainedFrom(policy, 'detection_event', justOnboarded, instantFromISO('2026-01-15T00:00:00.000Z')))
      .toBe(justOnboarded);
  });

  it('suspends every horizon under a legal hold', () => {
    const held = { ...standardRetention(ACME), legalHold: true };

    expect(retainedFrom(held, 'detection_event', PILOT_START, instantFromISO('2030-01-01T00:00:00.000Z')))
      .toBe(PILOT_START);
  });

  it('answers the audit port from the history horizon, not the detection horizon', () => {
    const policy = standardRetention(ACME);
    const now = instantFromISO('2026-09-15T00:00:00.000Z');

    const audit = auditRetentionOf(policy, PILOT_START, now);

    expect(audit.retailerId).toBe(ACME);
    expect(audit.eventRetention).toBe(horizonOf(policy, 'facing_history'));
    expect(audit.artifactRetention).toBe(horizonOf(policy, 'audit_artifact'));
    // The horizon ingestion enforces is the detection one, and it is the tighter
    // of the two — so an export can still cover months ingestion would now refuse.
    expect(ingestionHorizon(policy, PILOT_START, now)).toBeGreaterThan(audit.retainedFrom);
  });
});

describe('per-retailer data stores', () => {
  it('puts every table inside the retailer\'s own two schemas', () => {
    const store = planRetailerDataStore(ACME_TENANT);

    expect(store.tables).toBe(TABLE_SPECS);
    for (const job of store.retentionJobs) {
      expect(['osa_acme_grocery', 'osa_acme_grocery_ts']).toContain(job.schema);
    }
    // Relational and time-series are separate schemas because they expire by
    // different mechanisms.
    expect(store.retentionJobs.filter((job) => job.strategy === 'drop_partition').length)
      .toBeGreaterThan(0);
    expect(store.retentionJobs.filter((job) => job.strategy === 'delete_rows').length)
      .toBeGreaterThan(0);
  });

  it('gives every table the retention its data class was assigned', () => {
    const store = planRetailerDataStore(ACME_TENANT);

    for (const job of store.retentionJobs) {
      expect(job.horizon).toBe(horizonOf(ACME_TENANT.retention, job.dataClass));
    }
  });

  it('shares no schema, no role and no key between two retailers', () => {
    const stores = planDataStores(TWO_TENANTS);
    const names = stores.flatMap((store) => [
      store.namespaces.relationalSchema,
      store.namespaces.timeseriesSchema,
      store.namespaces.role,
      store.encryption.dataKeyRef,
      store.encryption.backupKeyRef,
    ]);

    expect(new Set(names).size).toBe(names.length);
    expect(() => assertNoCrossRetailerPooling(stores)).not.toThrow();
  });

  it('refuses a plan in which two retailers claim one schema', () => {
    const store = planRetailerDataStore(ACME_TENANT);
    const impostor = {
      ...planRetailerDataStore(RIVAL_TENANT),
      namespaces: { ...store.namespaces, retailerId: RIVAL },
    };

    expect(() => assertNoCrossRetailerPooling([store, impostor])).toThrow(
      /claimed by both retailer/,
    );
  });

  it('refuses to plan a store for a tenant whose encryption is not deployable', () => {
    const weakened: RetailerTenant = {
      ...ACME_TENANT,
      encryption: { ...ACME_TENANT.encryption, keyManagement: 'provider-managed' },
    };

    expect(() => planRetailerDataStore(weakened)).toThrow(/customer-managed/);
  });
});

describe('the DDL a deployment applies', () => {
  const bootstrap = renderTenantBootstrapDDL(planRetailerDataStore(ACME_TENANT));
  const isolation = renderTenantIsolationDDL(planRetailerDataStore(ACME_TENANT));

  it('creates the retailer\'s schemas owned by the retailer\'s role', () => {
    expect(bootstrap).toContain(
      'CREATE SCHEMA IF NOT EXISTS osa_acme_grocery AUTHORIZATION osa_acme_grocery_app;',
    );
    expect(bootstrap).toContain(
      'CREATE SCHEMA IF NOT EXISTS osa_acme_grocery_ts AUTHORIZATION osa_acme_grocery_app;',
    );
  });

  it('revokes PUBLIC and grants only the retailer\'s own role', () => {
    expect(bootstrap).toContain('REVOKE ALL ON SCHEMA osa_acme_grocery FROM PUBLIC;');
    expect(bootstrap).toContain('GRANT USAGE ON SCHEMA osa_acme_grocery TO osa_acme_grocery_app;');
    // Without default privileges, a table added by a later migration arrives
    // with no grant and is discovered at the first query.
    expect(bootstrap).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA osa_acme_grocery');
    expect(bootstrap).not.toContain('rival');
  });

  it('pins the search path and the session retailer to this tenant', () => {
    expect(bootstrap).toContain(
      'ALTER ROLE osa_acme_grocery_app SET search_path = osa_acme_grocery, osa_acme_grocery_ts;',
    );
    expect(bootstrap).toContain(
      "ALTER ROLE osa_acme_grocery_app SET osa.retailer_id = 'acme-grocery';",
    );
  });

  it('pins every table to the one retailer it belongs to', () => {
    for (const table of TABLE_SPECS) {
      expect(isolation).toContain(
        `ADD CONSTRAINT ${table.name}_partition CHECK (retailer_id = 'acme-grocery') NOT VALID;`,
      );
    }
  });

  it('forces row-level security, so the table owner is not exempt either', () => {
    for (const table of TABLE_SPECS) {
      const schema = table.kind === 'timeseries' ? 'osa_acme_grocery_ts' : 'osa_acme_grocery';
      expect(isolation).toContain(`ALTER TABLE ${schema}.${table.name} FORCE ROW LEVEL SECURITY;`);
    }
    expect(isolation).toContain("USING (retailer_id = current_setting('osa.retailer_id', false))");
  });

  it('records the retention horizon against every table', () => {
    // 90 days of detection events and 550 of history, straight from the policy.
    expect(isolation).toContain('detection_event, retained 90 days');
    expect(isolation).toContain('facing_history, retained 550 days');
    expect(isolation).toContain('dead_letter, retained 14 days');
  });

  it('marks the columns carrying verbatim vendor data as separately encrypted', () => {
    expect(isolation).toContain(
      "COMMENT ON COLUMN osa_acme_grocery_ts.dead_letter.payload IS 'envelope-encrypted under alias/osa/acme-grocery/data';",
    );
  });

  it('escapes a retailer id before it reaches a SQL literal', () => {
    expect(sqlLiteral("o'brien-foods")).toBe("'o''brien-foods'");
  });
});
