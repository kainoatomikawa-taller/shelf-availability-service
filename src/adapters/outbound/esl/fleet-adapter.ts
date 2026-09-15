import type { CarrotTagId, FacingId, RetailerId, StoreId, TaskId } from '../../../domain/common/ids.js';
import { assertSameRetailer } from '../../../domain/common/partition.js';
import { elapsed, instant, millis, plus, type Instant, type Millis } from '../../../domain/common/time.js';
import {
  type ClearExpressionCommand,
  type EslActuationPort,
  type EslActuationResult,
  type EslClearResult,
  type EslExpressionId,
  type EslExpressionMode,
  type EslFleetCapabilities,
  type EslUnavailableReason,
  type ExpressTaskBatch,
  type ExpressTaskCommand,
} from '../../../ports/outbound/esl-actuation.port.js';
import { planExpression, renderingFingerprint, type ExpressionPlan } from './degradation.js';
import type {
  EslFleetGateway,
  StoreDeployment,
  TagBinding,
  VendorAck,
  VendorCommand,
} from './gateway.js';
import { unionOfModels, type EslTagModel, type EslVendor } from './tag-model.js';

/**
 * The half of a vendor adapter that is the same in all five fleets.
 *
 * Splitting the package this way is the whole design. What genuinely differs
 * between VusionGroup, Aperion, Solum, Pricer and Hashow is a *table* — which tag
 * models they sell, what each one can light, what their request body is called
 * and how they spell a refusal. What does not differ is the policy: walk the
 * ladder, honour the lease, be idempotent per task and facing, respect the
 * gateway's batch limit and command interval, and never light a reserved lane.
 * Writing that policy once means a sixth vendor is a table, and means a bug in
 * the lease is fixed in one place rather than in five.
 */

/** Everything a vendor's `encodeExpression` is handed. */
export interface VendorExpressionInput {
  readonly command: ExpressTaskCommand;
  readonly binding: TagBinding;
  readonly model: EslTagModel;
  readonly plan: ExpressionPlan;
  readonly leaseMillis: Millis;
  /** The earlier of the caller's expiry and the lease — what the tag is told. */
  readonly expiresAt: Instant;
}

export interface VendorReleaseInput {
  readonly command: ClearExpressionCommand;
  readonly binding: TagBinding;
  readonly model: EslTagModel;
}

/**
 * One vendor's dialect and hardware catalogue.
 *
 * A pure data-and-translation object: no I/O, no state, nothing conditional on
 * the retailer. That keeps a vendor's peculiarities — Pricer's numeric colour
 * ids, Vusion's seconds, Hashow's e-paper-only catalogue — inside one file that
 * can be read against the vendor's API documentation side by side.
 */
export interface EslVendorProfile {
  readonly vendor: EslVendor;
  /** Reported as `EslFleetCapabilities.fleetVendor`. */
  readonly fleetVendor: string;
  readonly models: Readonly<Record<string, EslTagModel>>;
  /**
   * What an unrecognised model code is assumed to be.
   *
   * Points at the vendor's *least* capable tag on purpose. A gateway reporting a
   * model this build has never heard of is either newer than us or a typo, and
   * assuming the floor means the task still reaches the shelf in the least
   * presumptuous way the fleet has, rather than being planned against
   * capabilities the tag may not have and arriving as nothing at all.
   */
  readonly floorModelCode: string;
  /** The ladder this fleet declares. Callers may still send their own. */
  readonly degradationLadder: readonly EslExpressionMode[];
  readonly defaultBatchLimit: number;
  readonly defaultLeaseMillis: Millis;
  /** Below this the tag is left dark rather than half-driven into a brownout. */
  readonly minBatteryPercent: number;
  /** The vendor's own refusal codes, translated into the port's reasons. */
  readonly refusalCodes: Readonly<Record<string, EslUnavailableReason>>;
  encodeExpression(input: VendorExpressionInput): Readonly<Record<string, unknown>>;
  encodeRelease(input: VendorReleaseInput): Readonly<Record<string, unknown>>;
}

/** How long to wait before retrying something the fleet said was transient. */
const OFFLINE_RETRY = millis(60_000);
const UNREACHABLE_RETRY = millis(30_000);

const unavailable = (
  reason: EslUnavailableReason,
  retryAfter: Millis | null,
): EslActuationResult => ({ status: 'unavailable', reason, retryAfter });

interface LiveExpression {
  readonly expressionId: EslExpressionId;
  readonly tagId: CarrotTagId;
  readonly storeId: StoreId;
  readonly mode: EslExpressionMode;
  readonly renderedColour: ExpressionPlan['colour'];
  readonly fingerprint: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly leaseMillis: Millis;
  readonly expressedAt: Instant;
  readonly leaseExpiresAt: Instant;
}

/** A command that survived every pre-flight check and is ready for the gateway. */
interface PreparedCommand {
  readonly index: number;
  readonly command: ExpressTaskCommand;
  readonly binding: TagBinding;
  readonly plan: ExpressionPlan;
  readonly vendorCommand: VendorCommand;
  readonly leaseMillis: Millis;
  readonly expiresAt: Instant;
}

/**
 * A driven adapter for one vendor's fleet.
 *
 * State is held per retailer partition and never pooled: the expression registry,
 * the per-tag command clock and the expression ids are all keyed by retailer
 * first, so there is no lookup in this class that can return another tenant's lit
 * shelf.
 */
class EslFleetAdapter implements EslActuationPort {
  /** Live expressions, keyed `retailer|task|facing`. */
  private readonly expressions = new Map<string, LiveExpression>();
  /** Reverse index for `refresh`, keyed `retailer|expressionId`. */
  private readonly byExpressionId = new Map<string, string>();
  /** When each tag was last sent a *different* command, keyed `retailer|tag`. */
  private readonly lastCommandAt = new Map<string, Instant>();

  constructor(
    private readonly profile: EslVendorProfile,
    private readonly gateway: EslFleetGateway,
  ) {}

  private expressionKey(retailerId: RetailerId, taskId: TaskId, facingId: FacingId): string {
    return `${retailerId}|${taskId}|${facingId}`;
  }

  private tagKey(retailerId: RetailerId, tagId: CarrotTagId): string {
    return `${retailerId}|${tagId}`;
  }

  private modelFor(binding: TagBinding): EslTagModel {
    return this.modelByCode(binding.modelCode);
  }

  private modelByCode(modelCode: string): EslTagModel {
    const known = this.profile.models[modelCode];
    if (known !== undefined) return known;
    const floor = this.profile.models[this.profile.floorModelCode];
    if (floor === undefined) {
      throw new Error(
        `Vendor profile "${this.profile.vendor}" declares floor model "${this.profile.floorModelCode}", which is not in its catalogue`,
      );
    }
    return floor;
  }

  private leaseFor(deployment: StoreDeployment): Millis {
    return deployment.expressionLeaseMillis ?? this.profile.defaultLeaseMillis;
  }

  async describeCapabilities(
    retailerId: RetailerId,
    storeId: StoreId,
  ): Promise<EslFleetCapabilities> {
    const deployment = await this.gateway.describeStore(retailerId, storeId);

    // A store this vendor has never been onboarded in still gets an honest,
    // well-formed answer rather than a throw: "we can express nothing here" is
    // exactly what the caller needs to route the work to the handheld list, and
    // an exception would make every dispatch loop carry a try/catch for it.
    if (deployment === null) {
      return {
        retailerId,
        storeId,
        fleetVendor: this.profile.fleetVendor,
        supportedModes: ['none'],
        renderableColours: [],
        supportedFlashPatterns: [],
        maxBadgeCharacters: null,
        degradationLadder: this.profile.degradationLadder,
        minCommandIntervalMillis: millis(0),
        batchLimit: this.profile.defaultBatchLimit,
        expressionLeaseMillis: this.profile.defaultLeaseMillis,
        observedAt: instant(0),
      };
    }

    assertSameRetailer(retailerId, deployment, 'describeCapabilities');

    const models = deployment.modelCodes.map((modelCode) => this.modelByCode(modelCode));
    const union = unionOfModels(models);

    return {
      retailerId,
      storeId,
      fleetVendor: this.profile.fleetVendor,
      // A gateway that cannot reach its tags can express nothing right now, and
      // saying otherwise would have the caller dispatch into a building where
      // nothing will light.
      supportedModes: deployment.gatewayReachable ? [...union.supportedModes, 'none'] : ['none'],
      renderableColours: union.renderableColours,
      supportedFlashPatterns: union.supportedFlashPatterns,
      maxBadgeCharacters: union.maxBadgeCharacters,
      degradationLadder: this.profile.degradationLadder,
      minCommandIntervalMillis: union.minCommandIntervalMillis,
      batchLimit: deployment.batchLimit ?? this.profile.defaultBatchLimit,
      expressionLeaseMillis: this.leaseFor(deployment),
      observedAt: deployment.observedAt,
    };
  }

  async express(command: ExpressTaskCommand): Promise<EslActuationResult> {
    const [result] = await this.expressAll(command.retailerId, command.storeId, [command]);
    return result ?? unavailable('fleet_unreachable', null);
  }

  async expressBatch(batch: ExpressTaskBatch): Promise<readonly EslActuationResult[]> {
    for (const command of batch.commands) {
      assertSameRetailer(batch.retailerId, command, 'expressBatch');
      // Capabilities, bindings and batch limits are all properties of the fleet
      // in one building. A command for another store would be planned against
      // this store's hardware and addressed to a tag id resolved here, so it is
      // rejected loudly rather than lighting a shelf somewhere else.
      if (command.storeId !== batch.storeId) {
        throw new Error(
          `Batch for store "${batch.storeId}" carries a command for "${command.storeId}"; one batch is one fleet`,
        );
      }
    }
    return this.expressAll(batch.retailerId, batch.storeId, batch.commands);
  }

  /**
   * The one path every expression takes, batched or not.
   *
   * Pre-flight is per command and local; the gateway is called once per chunk.
   * Commands that fail pre-flight never reach the gateway at all — a tag we
   * already know is dark does not need a round trip to tell us so — and their
   * results are slotted back into the caller's positions at the end, because the
   * port contracts positional results and a caller zipping a short list against
   * its own commands is how a task silently goes missing.
   */
  private async expressAll(
    retailerId: RetailerId,
    storeId: StoreId,
    commands: readonly ExpressTaskCommand[],
  ): Promise<readonly EslActuationResult[]> {
    if (commands.length === 0) return [];
    // Filled rather than sized: `map` skips holes in a sparse array, so a slot
    // that somehow went unassigned would come back as a hole the caller reads as
    // `undefined` — a task silently neither expressed nor reported.
    const results: (EslActuationResult | undefined)[] = new Array<EslActuationResult | undefined>(
      commands.length,
    ).fill(undefined);

    const deployment = await this.gateway.describeStore(retailerId, storeId);
    if (deployment === null) return commands.map(() => unavailable('store_not_onboarded', null));
    assertSameRetailer(retailerId, deployment, 'express');
    if (!deployment.gatewayReachable) {
      return commands.map(() => unavailable('fleet_unreachable', UNREACHABLE_RETRY));
    }

    const bindings = await this.gateway.resolveBindings(
      retailerId,
      storeId,
      commands.map((command) => command.facingId),
    );
    const byFacing = new Map(bindings.map((binding) => [binding.facingId, binding]));
    const leaseMillis = this.leaseFor(deployment);

    const prepared: PreparedCommand[] = [];

    commands.forEach((command, index) => {
      const outcome = this.prepare(command, byFacing.get(command.facingId), leaseMillis, index);
      if ('result' in outcome) results[index] = outcome.result;
      else prepared.push(outcome.prepared);
    });

    const batchLimit = Math.max(1, deployment.batchLimit ?? this.profile.defaultBatchLimit);

    for (let offset = 0; offset < prepared.length; offset += batchLimit) {
      const chunk = prepared.slice(offset, offset + batchLimit);
      const acks = await this.gateway.dispatch({
        retailerId,
        storeId,
        commands: chunk.map((entry) => entry.vendorCommand),
      });

      chunk.forEach((entry, position) => {
        results[entry.index] = this.applyAck(entry, acks[position], storeId);
      });
    }

    return results.map((result) => result ?? unavailable('fleet_unreachable', null));
  }

  /**
   * Everything that can be decided without talking to the fleet.
   *
   * Ordered from cheapest and most certain to least: a facing with no tag cannot
   * be lit by any argument, a dark tag will not light whatever we send it, and
   * only once the hardware is known good is it worth asking what the tag can
   * express.
   */
  private prepare(
    command: ExpressTaskCommand,
    binding: TagBinding | undefined,
    leaseMillis: Millis,
    index: number,
  ): { readonly result: EslActuationResult } | { readonly prepared: PreparedCommand } {
    if (binding === undefined) return { result: unavailable('facing_has_no_tag', null) };
    if (!binding.bound) return { result: unavailable('tag_unbound', null) };
    // A caller that named a tag is asserting a binding it read somewhere earlier.
    // If the fleet now says the facing is on a different tag, the caller's is
    // stale, and lighting either one would be a guess.
    if (command.tagId !== null && command.tagId !== binding.tagId) {
      return { result: unavailable('tag_unbound', null) };
    }
    if (!binding.online) return { result: unavailable('tag_offline', OFFLINE_RETRY) };
    if (binding.batteryPercent < this.profile.minBatteryPercent) {
      return { result: unavailable('battery_too_low', null) };
    }

    const model = this.modelFor(binding);
    const plan = planExpression(command, model);
    if (plan.mode === 'none') return { result: unavailable('no_supported_mode', null) };

    const key = this.expressionKey(command.retailerId, command.taskId, command.facingId);
    const fingerprint = renderingFingerprint(plan);
    const live = this.expressions.get(key);

    // Idempotent per (taskId, facingId): the same task, on the same tag, lit the
    // same way, renews its lease locally. Re-sending would stack a second command
    // on a tag the gateway would then rate-limit us for, and would change nothing
    // on the shelf.
    //
    // The tag id is part of the comparison, not just the rendering. A facing
    // rebound after a battery swap is the same task lit the same way on a
    // different tag, and treating that as already-expressed would renew a lease
    // on a tag in a drawer while the shelf itself stayed dark.
    if (live !== undefined && live.fingerprint === fingerprint && live.tagId === binding.tagId) {
      const renewed = this.renew(key, live, command.requestedAt, command.expiresAt);
      return {
        result: {
          status: 'expressed',
          expressionId: renewed.expressionId,
          mode: renewed.mode,
          degraded: plan.degraded,
          renderedColour: renewed.renderedColour,
          expressedAt: renewed.expressedAt,
          leaseExpiresAt: renewed.leaseExpiresAt,
        },
      };
    }

    const tagKey = this.tagKey(command.retailerId, binding.tagId);
    const lastAt = this.lastCommandAt.get(tagKey);
    if (lastAt !== undefined) {
      const since = elapsed(lastAt, command.requestedAt);
      if (since < model.minCommandIntervalMillis) {
        return {
          result: unavailable('rate_limited', millis(model.minCommandIntervalMillis - since)),
        };
      }
    }

    // The tag is told the earlier of what the caller asked for and what the lease
    // allows. A caller asking for a twelve-hour expression on a fleet that leases
    // four does not get eight hours of a tag lit for work nobody is tracking.
    const leaseExpiry = plus(command.requestedAt, leaseMillis);
    const expiresAt = command.expiresAt < leaseExpiry ? command.expiresAt : leaseExpiry;

    return {
      prepared: {
        index,
        command,
        binding,
        plan,
        leaseMillis,
        expiresAt,
        vendorCommand: {
          tagId: binding.tagId,
          payload: this.profile.encodeExpression({
            command,
            binding,
            model,
            plan,
            leaseMillis,
            expiresAt,
          }),
        },
      },
    };
  }

  private renew(
    key: string,
    live: LiveExpression,
    at: Instant,
    requestedExpiry: Instant,
  ): LiveExpression {
    const leaseExpiry = plus(at, live.leaseMillis);
    const renewed: LiveExpression = {
      ...live,
      leaseExpiresAt: requestedExpiry < leaseExpiry ? requestedExpiry : leaseExpiry,
    };
    this.expressions.set(key, renewed);
    return renewed;
  }

  private applyAck(
    entry: PreparedCommand,
    ack: VendorAck | undefined,
    storeId: StoreId,
  ): EslActuationResult {
    const { command, plan } = entry;

    // A gateway that answered for fewer commands than it was sent has not told us
    // anything about the rest. They are treated as failed rather than as lit:
    // the cost of a task routed to the handheld list unnecessarily is one extra
    // walk, and the cost of the other mistake is a gap nobody ever goes to.
    if (ack === undefined) return unavailable('fleet_unreachable', null);

    if (ack.outcome === 'refused') {
      const reason =
        (ack.code === null ? undefined : this.profile.refusalCodes[ack.code]) ?? 'fleet_unreachable';
      return { status: 'unavailable', reason, retryAfter: ack.retryAfterMillis };
    }

    this.lastCommandAt.set(this.tagKey(command.retailerId, entry.binding.tagId), command.requestedAt);

    const expressionId = `${this.profile.vendor}:${command.taskId}:${command.facingId}` as EslExpressionId;

    if (ack.outcome === 'queued') {
      // Not recorded as a live expression: nothing is lit yet, and a `clear`
      // arriving now must reach the gateway rather than be answered from a
      // registry that believes the shelf is already dark.
      return {
        status: 'queued',
        expressionId,
        mode: plan.mode,
        degraded: plan.degraded,
        queuedAt: command.requestedAt,
        estimatedExpressionAt: ack.estimatedAt,
      };
    }

    const key = this.expressionKey(command.retailerId, command.taskId, command.facingId);
    const live: LiveExpression = {
      expressionId,
      tagId: entry.binding.tagId,
      storeId,
      mode: plan.mode,
      renderedColour: plan.colour,
      fingerprint: renderingFingerprint(plan),
      payload: entry.vendorCommand.payload,
      leaseMillis: entry.leaseMillis,
      expressedAt: command.requestedAt,
      leaseExpiresAt: entry.expiresAt,
    };
    this.expressions.set(key, live);
    this.byExpressionId.set(`${command.retailerId}|${expressionId}`, key);

    return {
      status: 'expressed',
      expressionId,
      mode: plan.mode,
      degraded: plan.degraded,
      renderedColour: plan.colour,
      expressedAt: command.requestedAt,
      leaseExpiresAt: entry.expiresAt,
    };
  }

  /**
   * Renews the lease on a live expression.
   *
   * The same payload goes back to the tag rather than a bare keepalive, because
   * these gateways hold a command, not a timer, and a tag that missed the
   * original radio window gets its second chance here. The rate limiter is not
   * applied: a refresh is by definition the rendering already on the tag, so it
   * is the one command that cannot make the shelf say something new.
   */
  async refresh(
    retailerId: RetailerId,
    expressionId: EslExpressionId,
    requestedAt: Instant,
  ): Promise<EslActuationResult> {
    const key = this.byExpressionId.get(`${retailerId}|${expressionId}`);
    const live = key === undefined ? undefined : this.expressions.get(key);
    if (key === undefined || live === undefined) {
      return unavailable('expression_expired', null);
    }
    if (live.leaseExpiresAt <= requestedAt) {
      this.expressions.delete(key);
      this.byExpressionId.delete(`${retailerId}|${expressionId}`);
      return unavailable('expression_expired', null);
    }

    const [ack] = await this.gateway.dispatch({
      retailerId,
      storeId: live.storeId,
      commands: [{ tagId: live.tagId, payload: live.payload }],
    });

    if (ack === undefined) return unavailable('fleet_unreachable', UNREACHABLE_RETRY);
    if (ack.outcome === 'refused') {
      const reason =
        (ack.code === null ? undefined : this.profile.refusalCodes[ack.code]) ?? 'fleet_unreachable';
      return { status: 'unavailable', reason, retryAfter: ack.retryAfterMillis };
    }

    const renewed = this.renew(key, live, requestedAt, plus(requestedAt, live.leaseMillis));

    if (ack.outcome === 'queued') {
      return {
        status: 'queued',
        expressionId,
        mode: renewed.mode,
        degraded: false,
        queuedAt: requestedAt,
        estimatedExpressionAt: ack.estimatedAt,
      };
    }

    return {
      status: 'expressed',
      expressionId,
      mode: renewed.mode,
      degraded: false,
      renderedColour: renewed.renderedColour,
      expressedAt: renewed.expressedAt,
      leaseExpiresAt: renewed.leaseExpiresAt,
    };
  }

  /**
   * Darkens the tag for a task.
   *
   * A task this adapter has no record of returns `not_expressed` without a round
   * trip. That is safe precisely because expressions are leased: an expression
   * this process did not make — one stranded by a restart — goes dark on its own
   * when its lease lapses, which is the failure direction the port was designed
   * around. Clearing is idempotent, so a second call is a no-op, not an error.
   */
  async clear(command: ClearExpressionCommand): Promise<EslClearResult> {
    const key = this.expressionKey(command.retailerId, command.taskId, command.facingId);
    const live = this.expressions.get(key);
    if (live === undefined) return { status: 'not_expressed' };

    const bindings = await this.gateway.resolveBindings(command.retailerId, command.storeId, [
      command.facingId,
    ]);
    const binding = bindings.find((candidate) => candidate.facingId === command.facingId);
    if (binding === undefined) {
      // The tag is gone from the fleet's own records, so there is nothing left to
      // address. The registry entry is dropped with it rather than kept as a
      // permanent claim on a shelf we can no longer reach.
      this.forget(command.retailerId, key, live.expressionId);
      return { status: 'not_expressed' };
    }
    if (!binding.online) return { status: 'unavailable', reason: 'tag_offline', retryAfter: OFFLINE_RETRY };

    const [ack] = await this.gateway.release({
      retailerId: command.retailerId,
      storeId: command.storeId,
      commands: [
        {
          tagId: binding.tagId,
          payload: this.profile.encodeRelease({
            command,
            binding,
            model: this.modelFor(binding),
          }),
        },
      ],
    });

    if (ack === undefined) {
      return { status: 'unavailable', reason: 'fleet_unreachable', retryAfter: UNREACHABLE_RETRY };
    }
    if (ack.outcome === 'refused') {
      const reason =
        (ack.code === null ? undefined : this.profile.refusalCodes[ack.code]) ?? 'fleet_unreachable';
      return { status: 'unavailable', reason, retryAfter: ack.retryAfterMillis };
    }

    this.forget(command.retailerId, key, live.expressionId);
    return { status: 'cleared', clearedAt: command.requestedAt };
  }

  private forget(retailerId: RetailerId, key: string, expressionId: EslExpressionId): void {
    this.expressions.delete(key);
    this.byExpressionId.delete(`${retailerId}|${expressionId}`);
  }
}

/** Builds the driven adapter for one vendor over one gateway. */
export function createEslFleetAdapter(
  profile: EslVendorProfile,
  gateway: EslFleetGateway,
): EslActuationPort {
  if (gateway.vendor !== profile.vendor) {
    throw new Error(
      `Gateway for "${gateway.vendor}" cannot drive the "${profile.vendor}" adapter; each fleet speaks only its own dialect`,
    );
  }
  return new EslFleetAdapter(profile, gateway);
}
