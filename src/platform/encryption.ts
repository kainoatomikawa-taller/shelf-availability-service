import type { Brand } from '../domain/common/brand.js';
import { DAY, millis, type Millis } from '../domain/common/time.js';

/**
 * Encryption at rest, described once and applied to every store a retailer owns.
 *
 * The shape of this module follows from one decision: **the key is per retailer.**
 * Schemas, roles and topic ACLs all keep tenants apart, but each of them is a
 * control that a future migration, a support script or a well-meant `GRANT` can
 * undo without anyone noticing. A per-retailer key is the control that fails
 * closed — if two retailers' rows ever do end up in one place, the second
 * retailer's bytes are ciphertext that the first retailer's key cannot open, and
 * the incident is a decrypt error in a log rather than a quiet cross-tenant read.
 *
 * Nothing here performs encryption. The service never holds a data key: storage
 * and broker do the encrypting with keys they fetch from the KMS, and what this
 * package owns is the specification those components are provisioned from, plus
 * the checks that say a specification is safe to deploy.
 */

/**
 * A key in the deployment's KMS, by reference.
 *
 * A reference and never material — branded so that "we handle key references,
 * not keys" is visible in the types, and so a literal that looks like a secret
 * cannot be passed where a key alias belongs.
 */
export type KeyRef = Brand<string, 'KeyRef'>;

const KEY_REF_PATTERN = /^alias\/osa\/[a-z][a-z0-9-]*\/(data|backup)$/;

export class EncryptionConfigError extends Error {
  readonly code = 'ENCRYPTION_CONFIG' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EncryptionConfigError';
  }
}

export const keyRef = (raw: string): KeyRef => {
  if (!KEY_REF_PATTERN.test(raw)) {
    throw new EncryptionConfigError(
      `Key reference must match ${KEY_REF_PATTERN.source}, got "${raw}"`,
    );
  }
  return raw as KeyRef;
};

/**
 * AES-256-GCM only.
 *
 * A single algorithm rather than a choice: an authenticated cipher is what makes
 * a tampered ciphertext a failure instead of plausible plaintext, and offering a
 * second option here would only ever be used to weaken a deployment.
 */
export type EncryptionAlgorithm = 'aes-256-gcm';

export type KeyManagement =
  /** Key material the retailer owns and can revoke. Required for pilots. */
  | 'customer-managed'
  /** The cloud provider's default key, shared across the account. */
  | 'provider-managed';

export interface EncryptionAtRest {
  readonly algorithm: EncryptionAlgorithm;
  readonly keyManagement: KeyManagement;
  /**
   * The retailer's own key, wrapping every data key used for their stores and
   * topics. Never shared — see `assertDistinctTenants`.
   */
  readonly dataKeyRef: KeyRef;
  /** Backups and snapshots, keyed separately so a restore is its own decision. */
  readonly backupKeyRef: KeyRef;
  /**
   * Envelope encryption: per-object data keys wrapped by the retailer key.
   *
   * Always true, and typed as the literal so a deployment cannot turn it off.
   * Without it, revoking a retailer's key would mean re-encrypting their whole
   * estate; with it, revocation is immediate because every object's data key is
   * unwrappable only through the retailer key.
   */
  readonly envelopeEncryption: true;
  readonly keyRotationPeriod: Millis;
  /** Minimum TLS version on every connection to the stores and the broker. */
  readonly minimumTlsVersion: '1.2' | '1.3';
}

/** Ninety days: short enough to bound one key's exposure, long enough to be automatable. */
export const STANDARD_KEY_ROTATION: Millis = millis(90 * DAY);

/**
 * The standard specification for one retailer, derived from their slug.
 *
 * Derived rather than configured so that adding a pilot cannot accidentally reuse
 * the previous pilot's key: the alias contains the slug, and two tenants cannot
 * share a slug.
 */
export const standardEncryption = (slug: string): EncryptionAtRest => ({
  algorithm: 'aes-256-gcm',
  keyManagement: 'customer-managed',
  dataKeyRef: keyRef(`alias/osa/${slug}/data`),
  backupKeyRef: keyRef(`alias/osa/${slug}/backup`),
  envelopeEncryption: true,
  keyRotationPeriod: STANDARD_KEY_ROTATION,
  minimumTlsVersion: '1.3',
});

/**
 * What a deployment refuses to provision.
 *
 * Three rules, each of which has a way of being argued into a pilot and should
 * not be: a provider-managed key is one the retailer cannot revoke, a shared
 * data/backup key means a stolen snapshot is a live read, and an unbounded
 * rotation period is a key that outlives the contract it was created for.
 */
export function assertEncryptionIsDeployable(
  encryption: EncryptionAtRest,
  what: string,
): EncryptionAtRest {
  if (encryption.keyManagement !== 'customer-managed') {
    throw new EncryptionConfigError(
      `${what} must use a customer-managed key; a provider-managed key cannot be revoked by the retailer it protects`,
    );
  }
  if (encryption.dataKeyRef === encryption.backupKeyRef) {
    throw new EncryptionConfigError(
      `${what} uses one key for live data and backups; a leaked snapshot then reads as freely as the live store`,
    );
  }
  if (encryption.keyRotationPeriod <= 0) {
    throw new EncryptionConfigError(`${what} must define a positive key rotation period`);
  }
  return encryption;
}
