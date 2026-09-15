import type { Brand } from '../../domain/common/brand.js';
import type {
  CarrotTagId,
  FacingId,
  RetailerId,
  StoreId,
  TaskId,
} from '../../domain/common/ids.js';
import type { RetailerPartitioned } from '../../domain/common/partition.js';
import type { Instant, Millis } from '../../domain/common/time.js';
import type { LedColor } from '../../domain/task/color-lane.js';
import type { TaskPriority, TaskType } from '../../domain/task/task-type.js';

/**
 * Electronic shelf label actuation — the outbound (driven) boundary for
 * expressing a task at the shelf edge.
 *
 * Types only: no behaviour lives here. The Carrot Tags adapter, and any other
 * ESL fleet a retailer runs, implement this port.
 *
 * The port is written around **graceful degradation** because shelf-edge hardware
 * is heterogeneous and unreliable by nature: fleets differ by generation, tags go
 * offline, batteries fade, and gateways rate-limit. A task still has to reach the
 * employee. So the fleet declares what it can express, the caller declares an
 * ordered fallback ladder, and the result says which rung was actually used.
 */

/** Identifier for one live expression, returned so it can be cleared or traced. */
export type EslExpressionId = Brand<string, 'EslExpressionId'>;

/**
 * Ways a task can be expressed at the shelf edge, most to least expressive.
 *
 * `none` is a real option, not a failure: it declares that the fleet cannot
 * express this task at all and the caller must route it to another channel (the
 * handheld task list) rather than assume the shelf is lit.
 */
export type EslExpressionMode =
  /** Full pick-to-light: lane colour plus flash pattern drawing the eye to the facing. */
  | 'pick_to_light'
  /** Lane colour, steady. Fleets without flash control. */
  | 'lane_colour_steady'
  /** Mono LED with no colour control: presence signals a task, the lane does not. */
  | 'mono_indicator'
  /** Text or icon rendered on the label's e-paper area. */
  | 'label_badge'
  /** Nothing expressible at the shelf edge. */
  | 'none';

export const ESL_EXPRESSION_MODES = [
  'pick_to_light',
  'lane_colour_steady',
  'mono_indicator',
  'label_badge',
  'none',
] as const satisfies readonly EslExpressionMode[];

/**
 * The platform's default degradation ladder, most to least expressive.
 *
 * A retailer may supply its own ordering — a fleet whose e-paper is more legible
 * than its mono LED would put `label_badge` first — but the ladder always ends at
 * `none`, so there is always a defined answer.
 */
export const STANDARD_DEGRADATION_LADDER = [
  'pick_to_light',
  'lane_colour_steady',
  'label_badge',
  'mono_indicator',
  'none',
] as const satisfies readonly EslExpressionMode[];

export type EslFlashPattern = 'slow' | 'fast' | 'double_pulse';

/**
 * What a retailer's fleet in a given store can actually do.
 *
 * Declared by the adapter rather than assumed by the caller: a store mid-way
 * through a hardware refresh runs two generations of tag at once, and the
 * capability set is the only honest description of that.
 */
export interface EslFleetCapabilities extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly fleetVendor: string;
  /** Modes the fleet can express, in no particular order. */
  readonly supportedModes: readonly EslExpressionMode[];
  /** Subset of the lane palette the hardware can render. May be empty for mono fleets. */
  readonly renderableColours: readonly LedColor[];
  readonly supportedFlashPatterns: readonly EslFlashPattern[];
  /** `null` when the fleet has no text-capable area. */
  readonly maxBadgeCharacters: number | null;
  /** Ordered fallback ladder in force for this fleet, most to least expressive. */
  readonly degradationLadder: readonly EslExpressionMode[];
  /** Minimum interval between commands to a single tag. */
  readonly minCommandIntervalMillis: Millis;
  /** Maximum commands accepted in one `expressBatch` call. */
  readonly batchLimit: number;
  /**
   * How long an expression survives without a refresh. Expressions are leased,
   * not set-and-forget, so a crashed service leaves dark shelves rather than
   * tags lit for a task nobody is working.
   */
  readonly expressionLeaseMillis: Millis;
  readonly observedAt: Instant;
}

/** Text shown when the fleet can render a badge. */
export interface EslBadgeContent {
  /** Truncated by the adapter to `maxBadgeCharacters`; callers need not pre-trim. */
  readonly headline: string;
  readonly detail: string | null;
}

/** Ask the shelf edge to express one task. */
export interface ExpressTaskCommand extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly taskId: TaskId;
  readonly facingId: FacingId;
  /** `null` asks the adapter to resolve the tag bound to the facing. */
  readonly tagId: CarrotTagId | null;
  readonly taskType: TaskType;
  /** The retailer's resolved lane for `taskType`. Ignored by mono fleets. */
  readonly lane: LedColor;
  readonly priority: TaskPriority;
  readonly flashPattern: EslFlashPattern | null;
  readonly badge: EslBadgeContent | null;
  /**
   * Ordered fallback ladder for this command, most to least expressive. The first
   * entry is what the caller wants; the adapter walks down until it finds a mode
   * the fleet supports.
   */
  readonly modePreference: readonly EslExpressionMode[];
  /** Expression is dropped at this instant even if never explicitly cleared. */
  readonly expiresAt: Instant;
  readonly requestedAt: Instant;
}

export interface ClearExpressionCommand extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly taskId: TaskId;
  readonly facingId: FacingId;
  readonly reason: 'verified' | 'cancelled' | 'expired' | 'reassigned' | 'superseded';
  readonly requestedAt: Instant;
}

export type EslUnavailableReason =
  | 'tag_offline'
  | 'tag_unbound'
  | 'facing_has_no_tag'
  | 'battery_too_low'
  | 'fleet_unreachable'
  | 'rate_limited'
  /** Nothing on the ladder is supported by this fleet — route the task elsewhere. */
  | 'no_supported_mode'
  | 'store_not_onboarded';

export type EslActuationResult =
  | {
      readonly status: 'expressed';
      readonly expressionId: EslExpressionId;
      /** The rung of the ladder actually used. */
      readonly mode: EslExpressionMode;
      /** True when `mode` is not the caller's first preference. */
      readonly degraded: boolean;
      /** Set when the lane colour could not be rendered and was substituted or dropped. */
      readonly renderedColour: LedColor | null;
      readonly expressedAt: Instant;
      /** Expression lapses at this instant unless refreshed. */
      readonly leaseExpiresAt: Instant;
    }
  | {
      /** Accepted by the gateway but not yet confirmed at the tag. */
      readonly status: 'queued';
      readonly expressionId: EslExpressionId;
      readonly mode: EslExpressionMode;
      readonly degraded: boolean;
      readonly queuedAt: Instant;
      readonly estimatedExpressionAt: Instant | null;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: EslUnavailableReason;
      /** `null` when retrying will not help and the caller must use another channel. */
      readonly retryAfter: Millis | null;
    };

export type EslClearResult =
  | { readonly status: 'cleared'; readonly clearedAt: Instant }
  /** Nothing was lit for this task — clearing is idempotent, not an error. */
  | { readonly status: 'not_expressed' }
  | {
      readonly status: 'unavailable';
      readonly reason: EslUnavailableReason;
      readonly retryAfter: Millis | null;
    };

/** A batch confined to one retailer partition, matching the domain's isolation rule. */
export interface ExpressTaskBatch extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly commands: readonly ExpressTaskCommand[];
}

/**
 * Outbound port implemented by each ESL fleet adapter.
 *
 * Implementations must be idempotent per `(taskId, facingId)`: re-expressing an
 * already-lit task refreshes its lease rather than stacking a second expression.
 */
export interface EslActuationPort {
  /**
   * What this fleet can express in this store. Callers read capabilities before
   * building a command so degradation is a decision, not a surprise.
   */
  describeCapabilities(retailerId: RetailerId, storeId: StoreId): Promise<EslFleetCapabilities>;

  express(command: ExpressTaskCommand): Promise<EslActuationResult>;

  /** Positional results: one per submitted command, in order. */
  expressBatch(batch: ExpressTaskBatch): Promise<readonly EslActuationResult[]>;

  /** Renews the lease on a live expression so a long-running task stays lit. */
  refresh(
    retailerId: RetailerId,
    expressionId: EslExpressionId,
    requestedAt: Instant,
  ): Promise<EslActuationResult>;

  clear(command: ClearExpressionCommand): Promise<EslClearResult>;
}
