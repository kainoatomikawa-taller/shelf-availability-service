import { describe, expect, it } from 'vitest';
import {
  ESL_VENDOR_PROFILES,
  STANDARD_TASK_DISPATCH_POLICY,
  buildExpressCommand,
  carrotTagId,
  createEslAdapter,
  createEslFleetAdapter,
  createTask,
  dispatchTasks,
  facingId,
  instant,
  millis,
  rankGaps,
  resolveColorLaneMap,
  storeId,
  taskId,
  type EslActuationResult,
  type EslExpressionId,
  type RankedGap,
} from '../src/index.js';
import {
  ACME,
  CEREAL_GROCERY,
  FACING,
  PRODUCT,
  STORE,
  gap,
  hour,
} from './support/fixtures.js';
import {
  FakeFleetGateway,
  binding,
  clearCommand,
  deployment,
  expressCommand,
  fleetOn,
} from './support/esl-gateways.js';

/**
 * The half of every fleet adapter that is the same in all five: the lease, the
 * idempotency rule, the batch limit, the command interval and the hardware
 * refusals. Exercised through one vendor, because the policy is shared code and
 * testing it five times would test the registry, not the policy.
 */

const TAG = carrotTagId('tag-551');

const expressed = (result: EslActuationResult) => {
  if (result.status !== 'expressed') {
    throw new Error(`expected an expressed result, got "${result.status}"`);
  }
  return result;
};

const unavailable = (result: EslActuationResult) => {
  if (result.status !== 'unavailable') {
    throw new Error(`expected an unavailable result, got "${result.status}"`);
  }
  return result;
};

describe('fleet adapter — hardware the task cannot reach', () => {
  it('reports a facing with no tag rather than pretending it lit one', async () => {
    const gateway = new FakeFleetGateway('vusion', deployment(['VUSION_EDGE_3']));
    const result = unavailable(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.reason).toBe('facing_has_no_tag');
    expect(result.retryAfter).toBeNull();
    // Nothing reached the gateway: a facing with no tag needs no round trip.
    expect(gateway.dispatchCalls).toBe(0);
  });

  it('leaves a dark tag alone and says when to try again', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG, { online: false });
    const result = unavailable(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.reason).toBe('tag_offline');
    expect(result.retryAfter).toBe(millis(60_000));
    expect(gateway.dispatchCalls).toBe(0);
  });

  it('refuses to half-drive a tag whose battery is below the vendor floor', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG, { batteryPercent: 4 });
    const result = unavailable(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.reason).toBe('battery_too_low');
    expect(result.retryAfter).toBeNull();
  });

  it('rejects a caller’s stale tag id rather than guessing which tag to light', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const result = unavailable(
      await createEslAdapter(gateway).express(
        expressCommand({ tagId: carrotTagId('tag-from-last-week') }),
      ),
    );

    expect(result.reason).toBe('tag_unbound');
  });

  it('reports a store this vendor was never onboarded in', async () => {
    const gateway = new FakeFleetGateway('vusion', null);
    const result = unavailable(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.reason).toBe('store_not_onboarded');
  });

  it('declares nothing expressible when the gateway cannot reach its own tags', async () => {
    const gateway = new FakeFleetGateway(
      'vusion',
      deployment(['VUSION_EDGE_3'], { gatewayReachable: false }),
      [binding(FACING, TAG, 'VUSION_EDGE_3')],
    );
    const adapter = createEslAdapter(gateway);

    expect((await adapter.describeCapabilities(ACME, STORE)).supportedModes).toEqual(['none']);
    expect(unavailable(await adapter.express(expressCommand())).reason).toBe('fleet_unreachable');
  });

  it('treats commands the gateway did not answer for as failed, never as lit', async () => {
    class ShortAnswerGateway extends FakeFleetGateway {
      override async dispatch(): Promise<readonly never[]> {
        return [];
      }
    }
    const gateway = new ShortAnswerGateway('vusion', deployment(['VUSION_EDGE_3']), [
      binding(FACING, TAG, 'VUSION_EDGE_3'),
    ]);

    const result = unavailable(await createEslAdapter(gateway).express(expressCommand()));
    expect(result.reason).toBe('fleet_unreachable');
  });
});

describe('fleet adapter — leases and idempotency', () => {
  it('caps the lease at what the fleet holds, however long the caller asked for', async () => {
    const gateway = new FakeFleetGateway(
      'vusion',
      deployment(['VUSION_EDGE_3'], { expressionLeaseMillis: millis(60 * 60 * 1000) }),
      [binding(FACING, TAG, 'VUSION_EDGE_3')],
    );

    const result = expressed(
      await createEslAdapter(gateway).express(
        expressCommand({ requestedAt: hour(1), expiresAt: hour(12) }),
      ),
    );

    expect(result.leaseExpiresAt).toBe(hour(2));
  });

  it('honours a caller asking for less than the lease allows', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const result = expressed(
      await createEslAdapter(gateway).express(
        expressCommand({ requestedAt: hour(1), expiresAt: hour(2) }),
      ),
    );

    expect(result.leaseExpiresAt).toBe(hour(2));
  });

  it('renews rather than stacks when the same task is expressed the same way twice', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    const first = expressed(await adapter.express(expressCommand({ requestedAt: hour(1) })));
    const second = expressed(await adapter.express(expressCommand({ requestedAt: hour(3) })));

    expect(second.expressionId).toBe(first.expressionId);
    // One command on the wire, not two: the shelf already says this.
    expect(gateway.dispatchCalls).toBe(1);
    expect(second.expressedAt).toBe(hour(1));
    expect(second.leaseExpiresAt).toBeGreaterThan(first.leaseExpiresAt);
  });

  it('sends a fresh command when the same task changes what it wants to say', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    await adapter.express(expressCommand({ requestedAt: hour(1), flashPattern: 'slow' }));
    const escalated = expressed(
      await adapter.express(expressCommand({ requestedAt: hour(3), flashPattern: 'fast' })),
    );

    expect(gateway.dispatchCalls).toBe(2);
    expect(escalated.mode).toBe('pick_to_light');
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      flash: { pattern: 'FLASH_FAST' },
    });
  });

  it('rate-limits a genuinely new command inside the tag’s command interval', async () => {
    const gateway = fleetOn('vusion', 'VUSION_SIGMA_2', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    const at = hour(1);
    await adapter.express(expressCommand({ requestedAt: at, badge: { headline: 'A', detail: null } }));
    const tooSoon = unavailable(
      await adapter.express(
        expressCommand({
          requestedAt: instant(at + 1_000),
          badge: { headline: 'B', detail: null },
        }),
      ),
    );

    expect(tooSoon.reason).toBe('rate_limited');
    // Sigma holds a five second interval, one of which has passed.
    expect(tooSoon.retryAfter).toBe(millis(4_000));
  });

  it('renews a live expression through the gateway, without the rate limiter', async () => {
    const gateway = fleetOn('vusion', 'VUSION_SIGMA_2', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    const first = expressed(await adapter.express(expressCommand({ requestedAt: hour(1) })));
    const renewed = expressed(await adapter.refresh(ACME, first.expressionId, instant(hour(1) + 500)));

    expect(renewed.expressionId).toBe(first.expressionId);
    expect(renewed.degraded).toBe(false);
    expect(gateway.dispatchCalls).toBe(2);
  });

  it('tells a caller to re-express rather than pretending an unknown lease was renewed', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const result = unavailable(
      await createEslAdapter(gateway).refresh(ACME, 'vusion:ghost:ghost' as EslExpressionId, hour(1)),
    );

    expect(result.reason).toBe('expression_expired');
    expect(result.retryAfter).toBeNull();
  });

  it('refuses to renew a lease that already lapsed', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    const first = expressed(
      await adapter.express(expressCommand({ requestedAt: hour(1), expiresAt: hour(2) })),
    );
    const result = unavailable(await adapter.refresh(ACME, first.expressionId, hour(3)));

    expect(result.reason).toBe('expression_expired');
  });

  it('does not record a queued command as a live expression', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    gateway.queued.add(TAG);
    const adapter = createEslAdapter(gateway);

    const result = await adapter.express(expressCommand());
    expect(result.status).toBe('queued');

    // Nothing is lit yet, so there is nothing to clear.
    expect(await adapter.clear(clearCommand())).toEqual({ status: 'not_expressed' });
  });
});

describe('fleet adapter — clearing', () => {
  it('darkens the tag and reports the instant it was cleared', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    await adapter.express(expressCommand());
    const cleared = await adapter.clear(clearCommand({ requestedAt: hour(4) }));

    expect(cleared).toEqual({ status: 'cleared', clearedAt: hour(4) });
    expect(gateway.released[0]?.commands[0]?.payload).toMatchObject({
      labelId: TAG,
      flash: null,
      page: null,
      reason: 'verified',
    });
  });

  it('is idempotent: clearing twice is a no-op, not an error', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    await adapter.express(expressCommand());
    await adapter.clear(clearCommand());

    expect(await adapter.clear(clearCommand())).toEqual({ status: 'not_expressed' });
    expect(gateway.released).toHaveLength(1);
  });

  it('re-expresses cleanly after a clear', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    await adapter.express(expressCommand({ requestedAt: hour(1) }));
    await adapter.clear(clearCommand({ requestedAt: hour(2) }));
    const again = expressed(await adapter.express(expressCommand({ requestedAt: hour(3) })));

    expect(again.expressedAt).toBe(hour(3));
    expect(gateway.dispatchCalls).toBe(2);
  });
});

describe('fleet adapter — batching and partitions', () => {
  it('splits an oversized batch to the gateway’s own limit', async () => {
    const gateway = new FakeFleetGateway(
      'vusion',
      deployment(['VUSION_EDGE_3'], { batchLimit: 2 }),
      Array.from({ length: 5 }, (_, index) =>
        binding(`facing-${index}`, `tag-${index}`, 'VUSION_EDGE_3'),
      ),
    );

    const results = await createEslAdapter(gateway).expressBatch({
      retailerId: ACME,
      storeId: STORE,
      commands: Array.from({ length: 5 }, (_, index) =>
        expressCommand({ taskId: taskId(`task-${index}`), facingId: facingId(`facing-${index}`) }),
      ),
    });

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.status === 'expressed')).toBe(true);
    expect(gateway.dispatchCalls).toBe(3);
  });

  it('returns results in the caller’s order even when some never reached the gateway', async () => {
    const gateway = new FakeFleetGateway('vusion', deployment(['VUSION_EDGE_3']), [
      binding('facing-0', 'tag-0', 'VUSION_EDGE_3'),
      binding('facing-2', 'tag-2', 'VUSION_EDGE_3'),
    ]);

    const results = await createEslAdapter(gateway).expressBatch({
      retailerId: ACME,
      storeId: STORE,
      commands: [0, 1, 2].map((index) =>
        expressCommand({ taskId: taskId(`task-${index}`), facingId: facingId(`facing-${index}`) }),
      ),
    });

    expect(results.map((result) => result.status)).toEqual([
      'expressed',
      'unavailable',
      'expressed',
    ]);
  });

  it('re-lights a facing that was rebound to a different tag', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    await adapter.express(expressCommand({ requestedAt: hour(1) }));

    // Battery swap: same facing, same task, same rendering, new tag.
    const replacement = carrotTagId('tag-552');
    gateway.bind(binding(FACING, replacement, 'VUSION_EDGE_3'));

    const result = expressed(await adapter.express(expressCommand({ requestedAt: hour(3) })));

    expect(gateway.dispatchCalls).toBe(2);
    expect(gateway.lastPayloadFor(replacement)).toMatchObject({ labelId: replacement });
    expect(result.mode).toBe('pick_to_light');
  });

  it('rejects a batch mixing two stores rather than lighting the wrong building', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);

    await expect(
      createEslAdapter(gateway).expressBatch({
        retailerId: ACME,
        storeId: STORE,
        commands: [expressCommand({ storeId: storeId('acme-0099') })],
      }),
    ).rejects.toThrow(/one batch is one fleet/);
  });

  it('rejects a batch carrying another retailer’s command', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);

    await expect(
      createEslAdapter(gateway).expressBatch({
        retailerId: ACME,
        storeId: STORE,
        commands: [expressCommand({ retailerId: 'rival-mart' as typeof ACME })],
      }),
    ).rejects.toThrow(/Cross-retailer access rejected/);
  });

  it('refuses to pair a gateway with another vendor’s profile', () => {
    const gateway = fleetOn('pricer', 'SMARTFLASH', FACING, TAG);
    // `createEslAdapter` picks the profile off the gateway and so cannot mismatch;
    // the guard is for callers that wire a profile and a gateway up by hand.
    expect(() => createEslFleetAdapter(ESL_VENDOR_PROFILES.solum, gateway)).toThrow(
      /speaks only its own dialect/,
    );
  });
});

describe('fleet adapter — driven by the dispatch use case', () => {
  const lanes = (() => {
    const resolved = resolveColorLaneMap(ACME);
    if (!resolved.ok) throw resolved.error;
    return resolved.value;
  })();

  /** Ranks gaps the way the worklist does, so the dispatch order is the real one. */
  const ranked = (facings: readonly string[]): readonly RankedGap[] =>
    rankGaps({
      retailerId: ACME,
      gaps: facings.map((facing, index) => ({
        gap: gap(`gap-${index}`, facing, CEREAL_GROCERY, hour(1)),
        salesVelocity: null,
      })),
      coverage: [],
    }).excluded;

  it('lights the whole worklist through a real vendor adapter', async () => {
    const gateway = new FakeFleetGateway(
      'pricer',
      deployment(['SMARTFLASH']),
      [0, 1, 2].map((index) => binding(`facing-${index}`, `tag-${index}`, 'SMARTFLASH')),
    );

    const result = await dispatchTasks(
      { esl: createEslAdapter(gateway) },
      {
        retailerId: ACME,
        lanes,
        gaps: ranked(['facing-0', 'facing-1', 'facing-2']),
        nextTaskId: (detected) => taskId(`task-${detected.facingId}`),
        at: hour(2),
      },
    );

    expect(result.routedElsewhere).toHaveLength(0);
    expect(
      result.dispatches.map((dispatch) =>
        dispatch.result.status === 'expressed' ? dispatch.result.mode : dispatch.result.status,
      ),
    ).toEqual(['pick_to_light', 'pick_to_light', 'pick_to_light']);
  });

  it('routes work to the handheld list when the fleet can express nothing', async () => {
    const gateway = new FakeFleetGateway(
      'hashow',
      deployment(['HS-LITE'], { gatewayReachable: false }),
      [binding('facing-0', 'tag-0', 'HS-LITE')],
    );

    const result = await dispatchTasks(
      { esl: createEslAdapter(gateway) },
      {
        retailerId: ACME,
        lanes,
        gaps: ranked(['facing-0']),
        nextTaskId: () => taskId('task-1'),
        at: hour(2),
      },
    );

    expect(result.routedElsewhere).toHaveLength(1);
  });

  it('builds a command the adapter degrades exactly as the capability set predicts', async () => {
    const gateway = fleetOn('solum', 'NEWTON_TOUCH', FACING, TAG);
    const adapter = createEslAdapter(gateway);
    const capabilities = await adapter.describeCapabilities(ACME, STORE);

    const task = createTask({
      retailerId: ACME,
      storeId: STORE,
      taskId: taskId('task-1'),
      facingId: FACING,
      productId: PRODUCT,
      type: 'restock_out_of_stock',
      priority: 'critical',
      lanes,
      createdAt: hour(1),
    });

    const command = buildExpressCommand(task, capabilities, hour(1), STANDARD_TASK_DISPATCH_POLICY);
    // The capability set already says no colour is renderable, so the caller can
    // see the degradation coming before it happens.
    expect(capabilities.renderableColours).toEqual([]);

    const result = expressed(await adapter.express(command));
    expect(result.mode).toBe('label_badge');
    expect(result.degraded).toBe(true);
  });
});
