import { DAY, millis, type Millis } from '../domain/common/time.js';
import type { RetailerId } from '../domain/common/ids.js';
import type { EncryptionAtRest } from './encryption.js';
import { assertEncryptionIsDeployable } from './encryption.js';
import {
  assertRetentionIsCoherent,
  horizonOf,
  type DataClass,
  type RetentionPolicy,
} from './retention.js';
import {
  namespacesOf,
  TenancyConfigError,
  type RetailerTenant,
  type TenantNamespaces,
} from './tenancy.js';

/**
 * Per-retailer data stores: what exists, where it lives, and what keeps it apart.
 *
 * The isolation story is four controls deep, deliberately, because each one alone
 * has a plausible way of being undone by a future change:
 *
 *  1. **A schema per retailer.** Nothing is named without naming a tenant.
 *  2. **A role per retailer, granted only that schema.** A connection cannot
 *     reach another tenant's tables even with a hand-written query, so a bug in
 *     application-level filtering is a failed query rather than a leak.
 *  3. **A partition `CHECK` per table.** The retailer column is pinned to a
 *     literal, so a row carrying the wrong tenant cannot be written at all — the
 *     failure lands on the `INSERT` that caused it instead of on a report weeks
 *     later.
 *  4. **Row-level security, forced.** Reads are additionally filtered by the
 *     session's retailer, and `FORCE` means the table's own owner is not exempt,
 *     which is what closes the migration-script path.
 *
 * Above all four sits a per-retailer encryption key (`encryption.ts`): if every
 * one of these controls were somehow bypassed at once, what the wrong tenant
 * reaches is ciphertext their key does not open.
 *
 * Nothing here talks to a database. This package has no driver and deliberately
 * takes none; what it owns is the specification and the DDL a deployment applies,
 * which is testable without a socket and reviewable as one artifact.
 */

export type StoreKind =
  /** Current-state tables, queried by key. */
  | 'relational'
  /** Append-only, time-ordered, partitioned by time and expired by dropping partitions. */
  | 'timeseries';

export interface TableSpec {
  readonly name: string;
  readonly kind: StoreKind;
  readonly dataClass: DataClass;
  /**
   * The column a time-series table is range-partitioned on, and that its retention
   * sweep drops partitions by. `null` for relational tables, which are expired by
   * a delete against `retentionColumn` instead.
   */
  readonly timeColumn: string | null;
  /** The column the retention sweep measures age from. */
  readonly retentionColumn: string;
  /**
   * Columns holding verbatim third-party data, encrypted a second time at the
   * column level under the retailer's key.
   *
   * Volume-level encryption already covers everything on disk; it does not cover
   * a backup restored into a debugging environment or a row copied into a support
   * ticket. These are the columns where that difference matters, because their
   * contents are whatever a vendor happened to publish.
   */
  readonly encryptedColumns: readonly string[];
}

/**
 * Every table this service owns, in one list.
 *
 * Shared across tenants as a *shape*, never as storage: each retailer gets its
 * own copy of every table inside its own schema. Declaring it once is what makes
 * "this retailer is missing a table" impossible to arrive at by drift.
 */
export const TABLE_SPECS: readonly TableSpec[] = [
  {
    name: 'facing',
    kind: 'relational',
    dataClass: 'facing_history',
    timeColumn: null,
    retentionColumn: 'updated_at',
    encryptedColumns: [],
  },
  {
    name: 'ingestion_ledger',
    kind: 'relational',
    dataClass: 'ingestion_ledger',
    timeColumn: null,
    retentionColumn: 'accepted_at',
    encryptedColumns: [],
  },
  {
    name: 'task',
    kind: 'relational',
    dataClass: 'task_record',
    timeColumn: null,
    retentionColumn: 'updated_at',
    encryptedColumns: [],
  },
  {
    name: 'audit_artifact',
    kind: 'relational',
    dataClass: 'audit_artifact',
    timeColumn: null,
    retentionColumn: 'generated_at',
    encryptedColumns: ['body'],
  },
  {
    name: 'facing_event',
    kind: 'timeseries',
    dataClass: 'facing_history',
    timeColumn: 'occurred_at',
    retentionColumn: 'occurred_at',
    encryptedColumns: [],
  },
  {
    name: 'detection_event',
    kind: 'timeseries',
    dataClass: 'detection_event',
    timeColumn: 'occurred_at',
    retentionColumn: 'occurred_at',
    encryptedColumns: ['observations'],
  },
  {
    name: 'outcome_record',
    kind: 'timeseries',
    dataClass: 'outcome_record',
    timeColumn: 'detected_at',
    retentionColumn: 'detected_at',
    encryptedColumns: [],
  },
  {
    name: 'audit_trail',
    kind: 'timeseries',
    dataClass: 'audit_trail',
    timeColumn: 'at',
    retentionColumn: 'at',
    encryptedColumns: [],
  },
  {
    name: 'availability_rollup',
    kind: 'timeseries',
    dataClass: 'read_model_rollup',
    timeColumn: 'window_from',
    retentionColumn: 'window_from',
    encryptedColumns: [],
  },
  {
    name: 'dead_letter',
    kind: 'timeseries',
    dataClass: 'dead_letter',
    timeColumn: 'failed_at',
    retentionColumn: 'failed_at',
    // The payload is whatever the producer sent, kept byte-for-byte so its owner
    // can reproduce the failure. It is the least sanitised column in the estate.
    encryptedColumns: ['payload'],
  },
];

/** Time-series partitions are cut weekly: small enough to drop usefully, few enough to plan. */
export const PARTITION_INTERVAL: Millis = millis(7 * DAY);

/** One scheduled expiry, as the sweeper needs it. */
export interface RetentionJob {
  readonly schema: string;
  readonly table: string;
  readonly dataClass: DataClass;
  readonly horizon: Millis;
  readonly retentionColumn: string;
  /**
   * Dropping a whole partition beats deleting rows: it is O(1), it reclaims the
   * space immediately, and it cannot half-finish and leave a window partly
   * expired — which would read as a real dip in coverage.
   */
  readonly strategy: 'drop_partition' | 'delete_rows';
}

export interface RetailerDataStore {
  readonly retailerId: RetailerId;
  readonly namespaces: TenantNamespaces;
  readonly encryption: EncryptionAtRest;
  readonly retention: RetentionPolicy;
  readonly tables: readonly TableSpec[];
  readonly retentionJobs: readonly RetentionJob[];
}

const schemaFor = (namespaces: TenantNamespaces, table: TableSpec): string =>
  table.kind === 'timeseries' ? namespaces.timeseriesSchema : namespaces.relationalSchema;

/**
 * Plans one retailer's stores.
 *
 * Validates on the way through rather than at deploy time: a tenant whose
 * encryption or retention could not be provisioned safely never becomes a plan,
 * so there is no partly-valid plan for a pipeline to apply half of.
 */
export const planRetailerDataStore = (tenant: RetailerTenant): RetailerDataStore => {
  const namespaces = namespacesOf(tenant);
  assertEncryptionIsDeployable(tenant.encryption, `Retailer "${tenant.retailerId}"`);
  assertRetentionIsCoherent(tenant.retention);

  const retentionJobs = TABLE_SPECS.map((table): RetentionJob => ({
    schema: schemaFor(namespaces, table),
    table: table.name,
    dataClass: table.dataClass,
    horizon: horizonOf(tenant.retention, table.dataClass),
    retentionColumn: table.retentionColumn,
    strategy: table.kind === 'timeseries' ? 'drop_partition' : 'delete_rows',
  }));

  return {
    retailerId: tenant.retailerId,
    namespaces,
    encryption: tenant.encryption,
    retention: tenant.retention,
    tables: TABLE_SPECS,
    retentionJobs,
  };
};

export const planDataStores = (tenants: readonly RetailerTenant[]): readonly RetailerDataStore[] =>
  tenants.map(planRetailerDataStore);

/**
 * Refuses a plan in which two retailers would touch the same physical thing.
 *
 * The check the whole module exists to make passable. It is stated over the
 * finished plans rather than over the tenants, so it covers every name actually
 * generated — including any a future change adds to `TenantNamespaces` — instead
 * of the subset someone remembered to compare.
 */
export function assertNoCrossRetailerPooling(stores: readonly RetailerDataStore[]): void {
  const owners = new Map<string, RetailerId>();

  for (const store of stores) {
    const { relationalSchema, timeseriesSchema, role } = store.namespaces;
    if (relationalSchema === timeseriesSchema) {
      throw new TenancyConfigError(
        `Retailer "${store.retailerId}" would put relational and time-series tables in one schema "${relationalSchema}"; the two expire by different mechanisms and must not share a namespace`,
      );
    }
    for (const name of [relationalSchema, timeseriesSchema, role]) {
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new TenancyConfigError(
          `"${name}" is claimed by both retailer "${owner}" and retailer "${store.retailerId}"; retailers may not pool a schema or a role`,
        );
      }
      owners.set(name, store.retailerId);
    }
  }
}

/** Doubles embedded quotes, so a retailer id can be interpolated into a literal safely. */
export const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const header = (store: RetailerDataStore): string =>
  [
    `-- ${'='.repeat(74)}`,
    `-- Retailer : ${store.retailerId}`,
    `-- Schemas  : ${store.namespaces.relationalSchema}, ${store.namespaces.timeseriesSchema}`,
    `-- Role     : ${store.namespaces.role}`,
    `-- At rest  : ${store.encryption.algorithm}, ${store.encryption.keyManagement}, key ${store.encryption.dataKeyRef}`,
    `-- Backups  : key ${store.encryption.backupKeyRef}`,
    `-- In flight: TLS ${store.encryption.minimumTlsVersion} minimum`,
    `-- ${'='.repeat(74)}`,
  ].join('\n');

/**
 * The tenant's boundary, before any table exists.
 *
 * Applied first, and idempotent, so re-running the provisioner over an onboarded
 * retailer is a no-op rather than an error a pipeline learns to ignore. The
 * `DEFAULT PRIVILEGES` statements matter more than they look: without them, a
 * table added by a later migration arrives with no grant and the application
 * discovers it at the first query.
 */
export const renderTenantBootstrapDDL = (store: RetailerDataStore): string => {
  const { relationalSchema, timeseriesSchema, role } = store.namespaces;
  const lines: string[] = [header(store), ''];

  lines.push(
    `DO $$ BEGIN`,
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlLiteral(role)}) THEN`,
    `    CREATE ROLE ${role} NOLOGIN;`,
    `  END IF;`,
    `END $$;`,
    '',
  );

  for (const schema of [relationalSchema, timeseriesSchema]) {
    lines.push(
      `CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${role};`,
      // PUBLIC has USAGE on nothing here by default, but a schema restored from a
      // dump can arrive with it; revoking unconditionally costs nothing.
      `REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;`,
      `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};`,
      '',
    );
  }

  lines.push(
    // Pinned so an unqualified table name can only ever resolve inside this
    // tenant's schemas — a query that forgets to qualify fails rather than
    // finding a same-named table somewhere shared.
    `ALTER ROLE ${role} SET search_path = ${relationalSchema}, ${timeseriesSchema};`,
    `ALTER ROLE ${role} SET osa.retailer_id = ${sqlLiteral(store.retailerId)};`,
    '',
  );

  return lines.join('\n');
};

/**
 * The per-table isolation and retention DDL.
 *
 * Applied *after* the migrations that create the tables: this package declares
 * what must be true of every tenant table, and the statements below are how that
 * is enforced in the database rather than in the code that happens to query it.
 */
export const renderTenantIsolationDDL = (store: RetailerDataStore): string => {
  const lines: string[] = [];
  const literal = sqlLiteral(store.retailerId);

  for (const table of store.tables) {
    const schema = schemaFor(store.namespaces, table);
    const qualified = `${schema}.${table.name}`;
    const horizon = horizonOf(store.retention, table.dataClass);
    const horizonDays = Math.round(horizon / DAY);

    lines.push(`-- ${qualified} — ${table.dataClass}, retained ${horizonDays} days`);
    lines.push(
      `ALTER TABLE ${qualified}`,
      `  ADD CONSTRAINT ${table.name}_partition CHECK (retailer_id = ${literal}) NOT VALID;`,
      `ALTER TABLE ${qualified} VALIDATE CONSTRAINT ${table.name}_partition;`,
      `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
      // FORCE is the important half: without it the table's owner — which is the
      // role every migration runs as — bypasses the policy entirely.
      `ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY;`,
      `CREATE POLICY tenant_isolation ON ${qualified}`,
      `  USING (retailer_id = current_setting('osa.retailer_id', false))`,
      `  WITH CHECK (retailer_id = current_setting('osa.retailer_id', false));`,
    );

    for (const column of table.encryptedColumns) {
      lines.push(
        `COMMENT ON COLUMN ${qualified}.${column} IS 'envelope-encrypted under ${store.encryption.dataKeyRef}';`,
      );
    }

    if (table.timeColumn !== null) {
      lines.push(
        `COMMENT ON TABLE ${qualified} IS 'time-partitioned by ${table.timeColumn}, ${Math.round(PARTITION_INTERVAL / DAY)}-day partitions, expired by dropping partitions older than ${horizonDays} days';`,
      );
    } else {
      lines.push(
        `COMMENT ON TABLE ${qualified} IS 'expired by deleting rows whose ${table.retentionColumn} is older than ${horizonDays} days';`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
};

/** Bootstrap and isolation as one script, in the order a pipeline applies them. */
export const renderDataStoreDDL = (store: RetailerDataStore): string =>
  `${renderTenantBootstrapDDL(store)}\n-- Apply after the table migrations for this tenant.\n\n${renderTenantIsolationDDL(store)}`;
