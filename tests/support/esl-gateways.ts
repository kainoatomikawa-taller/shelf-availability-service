import {
  STANDARD_DEGRADATION_LADDER,
  carrotTagId,
  facingId,
  millis,
  taskId,
  type ClearExpressionCommand,
  type ExpressTaskCommand,
  type CarrotTagId,
  type EslFleetGateway,
  type EslVendor,
  type FacingId,
  type RetailerId,
  type StoreDeployment,
  type StoreId,
  type TagBinding,
  type VendorAck,
  type VendorDispatch,
} from '../../src/index.js';
import { ACME, FACING, STORE, hour } from './fixtures.js';

/**
 * A scriptable stand-in for one vendor's gateway.
 *
 * Deliberately dumb: it records what it was sent verbatim and answers from a
 * script. That is what makes these adapter tests worth running — every assertion
 * is against the *vendor's own payload*, exactly as that vendor's API would
 * receive it, so a test cannot accidentally pass against a body the real gateway
 * would reject. The adapter's own judgement (which rung, which colour, what
 * lease) is nowhere in here.
 */
export class FakeFleetGateway implements EslFleetGateway {
  readonly dispatched: VendorDispatch[] = [];
  readonly released: VendorDispatch[] = [];
  /** Scripted refusal codes, keyed by tag id. */
  readonly refusals = new Map<CarrotTagId, string>();
  /** Tags the gateway holds rather than applies, keyed by tag id. */
  readonly queued = new Set<CarrotTagId>();
  dispatchCalls = 0;

  private deployment: StoreDeployment | null;
  private readonly bindings = new Map<FacingId, TagBinding>();

  constructor(
    readonly vendor: EslVendor,
    deployment: StoreDeployment | null,
    bindings: readonly TagBinding[] = [],
  ) {
    this.deployment = deployment;
    for (const binding of bindings) this.bindings.set(binding.facingId, binding);
  }

  withDeployment(deployment: StoreDeployment | null): this {
    this.deployment = deployment;
    return this;
  }

  bind(binding: TagBinding): this {
    this.bindings.set(binding.facingId, binding);
    return this;
  }

  unbind(facing: FacingId): this {
    this.bindings.delete(facing);
    return this;
  }

  async describeStore(retailerId: RetailerId, storeId: StoreId): Promise<StoreDeployment | null> {
    if (this.deployment === null) return null;
    return this.deployment.retailerId === retailerId && this.deployment.storeId === storeId
      ? this.deployment
      : null;
  }

  async resolveBindings(
    _retailerId: RetailerId,
    _storeId: StoreId,
    facingIds: readonly FacingId[],
  ): Promise<readonly TagBinding[]> {
    return facingIds
      .map((id) => this.bindings.get(id))
      .filter((binding): binding is TagBinding => binding !== undefined);
  }

  async dispatch(request: VendorDispatch): Promise<readonly VendorAck[]> {
    this.dispatchCalls += 1;
    this.dispatched.push(request);
    return request.commands.map((command) => this.ackFor(command.tagId));
  }

  async release(request: VendorDispatch): Promise<readonly VendorAck[]> {
    this.released.push(request);
    return request.commands.map((command) => this.ackFor(command.tagId));
  }

  private ackFor(tagId: CarrotTagId): VendorAck {
    const refusal = this.refusals.get(tagId);
    if (refusal !== undefined) {
      return {
        tagId,
        outcome: 'refused',
        code: refusal,
        estimatedAt: null,
        retryAfterMillis: millis(5_000),
      };
    }
    if (this.queued.has(tagId)) {
      return { tagId, outcome: 'queued', code: null, estimatedAt: hour(1), retryAfterMillis: null };
    }
    return { tagId, outcome: 'applied', code: null, estimatedAt: null, retryAfterMillis: null };
  }

  /** The last payload sent for a tag, for asserting on the vendor's wire shape. */
  lastPayloadFor(tagId: CarrotTagId): Readonly<Record<string, unknown>> | null {
    for (let index = this.dispatched.length - 1; index >= 0; index -= 1) {
      const request = this.dispatched[index];
      const command = request?.commands.find((entry) => entry.tagId === tagId);
      if (command !== undefined) return command.payload;
    }
    return null;
  }
}

export const deployment = (
  modelCodes: readonly string[],
  overrides: Partial<StoreDeployment> = {},
): StoreDeployment => ({
  retailerId: ACME,
  storeId: STORE,
  modelCodes,
  gatewayReachable: true,
  batchLimit: null,
  expressionLeaseMillis: null,
  observedAt: hour(0),
  ...overrides,
});

export const binding = (
  facing: string,
  tag: string,
  modelCode: string,
  overrides: Partial<TagBinding> = {},
): TagBinding => ({
  facingId: facingId(facing),
  tagId: carrotTagId(tag),
  modelCode,
  bound: true,
  online: true,
  batteryPercent: 90,
  ...overrides,
});

/** A gateway with one facing bound to one tag of the given model — the common case. */
export const fleetOn = (
  vendor: EslVendor,
  modelCode: string,
  facing: string,
  tag: string,
  bindingOverrides: Partial<TagBinding> = {},
): FakeFleetGateway =>
  new FakeFleetGateway(vendor, deployment([modelCode]), [
    binding(facing, tag, modelCode, bindingOverrides),
  ]);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * An express command as `buildExpressCommand` would produce one.
 *
 * The ladder is the platform's standard one, unfiltered, because that is what
 * dispatch actually sends: pre-trimming it to what a fleet supports would make
 * every result report `degraded: false` and hide the very thing these tests
 * exist to check.
 */
export const expressCommand = (
  overrides: Partial<ExpressTaskCommand> = {},
): ExpressTaskCommand => ({
  retailerId: ACME,
  storeId: STORE,
  taskId: taskId('task-1'),
  facingId: FACING,
  tagId: null,
  taskType: 'restock_out_of_stock',
  lane: 'red',
  priority: 'critical',
  flashPattern: 'fast',
  badge: { headline: 'RESTOCK', detail: 'sku-oat-milk-64oz' },
  modePreference: [...STANDARD_DEGRADATION_LADDER],
  expiresAt: hour(12),
  requestedAt: hour(1),
  ...overrides,
});

export const clearCommand = (
  overrides: Partial<ClearExpressionCommand> = {},
): ClearExpressionCommand => ({
  retailerId: ACME,
  storeId: STORE,
  taskId: taskId('task-1'),
  facingId: FACING,
  reason: 'verified',
  requestedAt: hour(2),
  ...overrides,
});
