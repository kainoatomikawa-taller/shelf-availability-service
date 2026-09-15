import type { CarrotTagId, FacingId, RetailerId, StoreId } from '../../../domain/common/ids.js';
import type { RetailerPartitioned } from '../../../domain/common/partition.js';
import type { Instant, Millis } from '../../../domain/common/time.js';
import type { EslVendor } from './tag-model.js';

/**
 * The transport seam every vendor adapter sits on.
 *
 * Deliberately thin, and deliberately *not* expressed in the vendor's vocabulary
 * except where it has to be. Three things genuinely differ between the five
 * fleets — the request body, the refusal codes and which tag models are deployed
 * — so those are the three things that cross this seam as vendor-shaped data:
 * `payload` is the vendor's own request object, built by that vendor's adapter,
 * and `code` is the vendor's own refusal spelling, translated by it. Everything
 * else is the same call in every fleet and is typed once, here.
 *
 * This keeps HTTP, MQTT, SDKs and retries out of the adapters entirely: what a
 * fleet adapter *is* is the translation between a task and a vendor's idea of a
 * lit tag, and that is testable without a socket.
 */

/**
 * What the vendor's gateway says is installed in one store.
 *
 * `modelCodes` is a list, not a single value, because the honest answer for a
 * store mid-refresh is "both of these", and collapsing it to one would either
 * over-promise on the old tags or under-use the new ones.
 */
export interface StoreDeployment extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  /** Every tag model deployed in this store, in the vendor's own spelling. */
  readonly modelCodes: readonly string[];
  /** False when the gateway itself is answering but cannot reach its tags. */
  readonly gatewayReachable: boolean;
  /** Commands the gateway accepts in one call; `null` takes the vendor default. */
  readonly batchLimit: number | null;
  /** How long this gateway holds an expression without a refresh; `null` takes the default. */
  readonly expressionLeaseMillis: Millis | null;
  readonly observedAt: Instant;
}

/**
 * The facing-to-tag binding, which only the fleet knows.
 *
 * Held here rather than in the domain because the same physical facing is bound
 * to a different tag after a battery swap, and a mapping the service cached would
 * go on lighting a tag that is in a drawer.
 */
export interface TagBinding {
  readonly facingId: FacingId;
  readonly tagId: CarrotTagId;
  /** The vendor's model code for this specific tag. */
  readonly modelCode: string;
  /** False when the tag exists but is not associated with the facing's product. */
  readonly bound: boolean;
  readonly online: boolean;
  /** 0–100. Below the vendor's floor the tag is left dark rather than half-driven. */
  readonly batteryPercent: number;
}

/** One tag's worth of work, with the vendor's own request body. */
export interface VendorCommand {
  readonly tagId: CarrotTagId;
  /** The vendor's request object, exactly as that vendor's API expects it. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface VendorDispatch extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly commands: readonly VendorCommand[];
}

/**
 * What the gateway said about one command.
 *
 * `queued` is a first-class outcome rather than an optimistic `applied`: most of
 * these fleets hold commands until the tag's next radio wake-up, and reporting
 * that as "expressed" would have the loop believe a shelf is lit for as long as a
 * quarter of an hour before it is.
 */
export interface VendorAck {
  readonly tagId: CarrotTagId;
  readonly outcome: 'applied' | 'queued' | 'refused';
  /** The vendor's own refusal code; `null` unless `outcome` is `refused`. */
  readonly code: string | null;
  /** When a queued command is expected to reach the tag, when the gateway says. */
  readonly estimatedAt: Instant | null;
  readonly retryAfterMillis: Millis | null;
}

export interface EslFleetGateway {
  readonly vendor: EslVendor;

  /** `null` when this vendor has no deployment for the store at all. */
  describeStore(retailerId: RetailerId, storeId: StoreId): Promise<StoreDeployment | null>;

  /** Bindings for the facings asked about. Facings with no tag are simply absent. */
  resolveBindings(
    retailerId: RetailerId,
    storeId: StoreId,
    facingIds: readonly FacingId[],
  ): Promise<readonly TagBinding[]>;

  /** Positional acks: one per command, in order. */
  dispatch(request: VendorDispatch): Promise<readonly VendorAck[]>;

  /** Positional acks for clearing tags, same contract as `dispatch`. */
  release(request: VendorDispatch): Promise<readonly VendorAck[]>;
}
