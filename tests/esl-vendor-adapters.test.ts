import { describe, expect, it } from 'vitest';
import {
  ESL_VENDOR_PROFILES,
  ESL_VENDORS,
  carrotTagId,
  createEslAdapter,
  facingId,
  millis,
  taskId,
  type EslActuationResult,
  type EslVendor,
} from '../src/index.js';
import { ACME, FACING, STORE, hour } from './support/fixtures.js';
import {
  FakeFleetGateway,
  binding,
  deployment,
  expressCommand,
  fleetOn,
} from './support/esl-gateways.js';

/**
 * Per-vendor integration tests for the five ESL fleets.
 *
 * Each vendor gets the same two questions asked of it: what happens on the best
 * hardware it sells, and what happens on the worst. The answers differ — that is
 * the point of the fleet being heterogeneous — but the *shape* of the answer
 * never does: something is expressed, the result names the rung, and `degraded`
 * tells the caller whether the shelf says what they asked it to.
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

// ---------------------------------------------------------------------------
// VusionGroup — full capability, and the previous generation beside it
// ---------------------------------------------------------------------------

describe('VusionGroup adapter', () => {
  it('expresses a critical task as pick-to-light in its own lane colour', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    const result = expressed(await adapter.express(expressCommand()));

    expect(result.mode).toBe('pick_to_light');
    expect(result.degraded).toBe(false);
    expect(result.renderedColour).toBe('red');
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      labelId: TAG,
      flash: { colour: 'RED', pattern: 'FLASH_FAST' },
    });
  });

  it('states the lifetime in seconds, as Vusion expects, rounded up', async () => {
    const gateway = fleetOn('vusion', 'VUSION_EDGE_3', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    await adapter.express(expressCommand({ requestedAt: hour(1), expiresAt: hour(2) }));

    expect(gateway.lastPayloadFor(TAG)).toMatchObject({ lifetimeSeconds: 3_600 });
  });

  it('falls back to a text badge on the previous generation, and says it degraded', async () => {
    const gateway = fleetOn('vusion', 'VUSION_SIGMA_2', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    const result = expressed(await adapter.express(expressCommand()));

    expect(result.mode).toBe('label_badge');
    expect(result.degraded).toBe(true);
    // The lane could not be rendered, so it is dropped rather than substituted.
    expect(result.renderedColour).toBeNull();
    // Sigma's strip is sixteen characters, so the product id loses its last one.
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      page: { layout: 'TASK_BADGE', fields: { line1: 'RESTOCK', line2: 'sku-oat-milk-64o' } },
    });
  });

  it('degrades per tag, not per store, when both generations share an aisle', async () => {
    const gateway = new FakeFleetGateway(
      'vusion',
      deployment(['VUSION_EDGE_3', 'VUSION_SIGMA_2']),
      [
        binding('facing-new', 'tag-new', 'VUSION_EDGE_3'),
        binding('facing-old', 'tag-old', 'VUSION_SIGMA_2'),
      ],
    );
    const adapter = createEslAdapter(gateway);

    const results = await adapter.expressBatch({
      retailerId: ACME,
      storeId: STORE,
      commands: [
        expressCommand({ taskId: taskId('task-new'), facingId: facingId('facing-new') }),
        expressCommand({ taskId: taskId('task-old'), facingId: facingId('facing-old') }),
      ],
    });

    expect(results.map((result) => (result.status === 'expressed' ? result.mode : result.status))).toEqual([
      'pick_to_light',
      'label_badge',
    ]);
  });

  it('reports the store-wide union of both generations as its capability set', async () => {
    const gateway = new FakeFleetGateway('vusion', deployment(['VUSION_EDGE_3', 'VUSION_SIGMA_2']));
    const capabilities = await createEslAdapter(gateway).describeCapabilities(ACME, STORE);

    expect(capabilities.fleetVendor).toBe('vusiongroup');
    expect(capabilities.supportedModes).toContain('pick_to_light');
    // Narrowest badge and slowest command interval of the two — anything the
    // caller sends has to be safe for whichever tag it lands on.
    expect(capabilities.maxBadgeCharacters).toBe(16);
    expect(capabilities.minCommandIntervalMillis).toBe(millis(5_000));
  });
});

// ---------------------------------------------------------------------------
// Pricer — pick-to-light on a restricted palette
// ---------------------------------------------------------------------------

describe('Pricer adapter', () => {
  it('expresses pick-to-light with Pricer’s numeric colour id', async () => {
    const gateway = fleetOn('pricer', 'SMARTFLASH', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    const result = expressed(await adapter.express(expressCommand()));

    expect(result.mode).toBe('pick_to_light');
    expect(result.degraded).toBe(false);
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      signMode: 'FLASH',
      ledColour: 1,
      flashRate: 'HIGH',
    });
  });

  it('drops to text when the retailer’s lane is a colour the tag has no id for', async () => {
    const gateway = fleetOn('pricer', 'CONTINUUM', FACING, TAG);
    const adapter = createEslAdapter(gateway);

    // Amber is the replenishment lane; a Continuum tag renders three primaries.
    const result = expressed(
      await adapter.express(
        expressCommand({
          lane: 'amber',
          taskType: 'replenish_low_stock',
          flashPattern: 'slow',
          badge: { headline: 'TOP UP', detail: null },
        }),
      ),
    );

    expect(result.mode).toBe('label_badge');
    expect(result.degraded).toBe(true);
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      ledColour: null,
      signMode: 'STEADY',
      textLine: 'TOP UP',
    });
  });

  it('lights the lane steady, without a flash, when the lane itself is renderable', async () => {
    const gateway = fleetOn('pricer', 'CONTINUUM', FACING, TAG);
    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.mode).toBe('lane_colour_steady');
    expect(result.degraded).toBe(true);
    expect(result.renderedColour).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// Aperion — colour, but no flash primitive anywhere in the catalogue
// ---------------------------------------------------------------------------

describe('Aperion adapter', () => {
  it('lights the lane steady and reports the lost urgency as a degradation', async () => {
    const gateway = fleetOn('aperion', 'lumina-2', FACING, TAG);
    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.mode).toBe('lane_colour_steady');
    expect(result.degraded).toBe(true);
    expect(result.renderedColour).toBe('red');
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      tag_uid: TAG,
      led: { colour: 'red', mode: 'solid' },
    });
  });

  it('takes an absolute ISO expiry rather than a duration', async () => {
    const gateway = fleetOn('aperion', 'lumina-2', FACING, TAG);
    await createEslAdapter(gateway).express(
      expressCommand({ requestedAt: hour(1), expiresAt: hour(2) }),
    );

    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      expires_at: '2026-03-02T02:00:00.000Z',
    });
  });

  it('falls back to the e-paper banner on its LED-less Classic tags', async () => {
    const gateway = fleetOn('aperion', 'classic-1', FACING, TAG);
    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.mode).toBe('label_badge');
    expect(result.degraded).toBe(true);
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      led: null,
      epaper: { banner: 'RESTOCK', sub_banner: 'sku-oat-milk-64oz' },
    });
  });
});

// ---------------------------------------------------------------------------
// Solum — no lane colour anywhere; text carries the task
// ---------------------------------------------------------------------------

describe('Solum adapter', () => {
  it('shows the task as text and blinks the mono indicator alongside it', async () => {
    const gateway = fleetOn('solum', 'NEWTON_TOUCH', FACING, TAG);
    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.mode).toBe('label_badge');
    expect(result.degraded).toBe(true);
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      templateData: { TASK_LINE: 'RESTOCK', TASK_SUB: 'sku-oat-milk-64oz' },
      // `fast` maps to Solum's pattern 2; the text alone would not be seen from
      // down the aisle.
      ledCommand: { pattern: 2, repeat: 0 },
    });
  });

  it('truncates the badge to the tag’s width rather than letting the gateway reject it', async () => {
    const gateway = fleetOn('solum', 'NEWTON_TOUCH', FACING, TAG);
    await createEslAdapter(gateway).express(
      expressCommand({ badge: { headline: 'RESTOCK THE WHOLE BAY IMMEDIATELY', detail: null } }),
    );

    const payload = gateway.lastPayloadFor(TAG);
    const template = (payload as { readonly templateData: { readonly TASK_LINE: string } })
      .templateData;
    expect(template.TASK_LINE).toBe('RESTOCK THE WHOLE BA');
    expect(template.TASK_LINE.length).toBeLessThanOrEqual(20);
  });

  it('sends text with no blink on its LED-less paper tags', async () => {
    const gateway = fleetOn('solum', 'NEWTON_PAPER', FACING, TAG);
    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.mode).toBe('label_badge');
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({ ledCommand: null });
  });

  it('takes an absolute expiry in epoch millis', async () => {
    const gateway = fleetOn('solum', 'NEWTON_TOUCH', FACING, TAG);
    await createEslAdapter(gateway).express(
      expressCommand({ requestedAt: hour(1), expiresAt: hour(3) }),
    );

    expect(gateway.lastPayloadFor(TAG)).toMatchObject({ expireAt: hour(3) });
  });
});

// ---------------------------------------------------------------------------
// Hashow — the bottom of the ladder
// ---------------------------------------------------------------------------

describe('Hashow adapter', () => {
  it('lights the lane and writes the badge on its HS-Plus tags', async () => {
    const gateway = fleetOn('hashow', 'HS-PLUS', FACING, TAG);
    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));

    // HS-Plus renders red and has a text area, but its only flash pattern is
    // `slow`, so the caller's `fast` cannot be honoured and pick-to-light drops.
    expect(result.mode).toBe('lane_colour_steady');
    expect(result.degraded).toBe(true);
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      cmd: 'LED_ONLY',
      lamp: { colour: 'R', mode: 'ON' },
    });
  });

  it('blinks a bare indicator on HS-Lite, which has neither colour nor text', async () => {
    const gateway = fleetOn('hashow', 'HS-LITE', FACING, TAG);
    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));

    expect(result.mode).toBe('mono_indicator');
    expect(result.degraded).toBe(true);
    expect(result.renderedColour).toBeNull();
    expect(gateway.lastPayloadFor(TAG)).toMatchObject({
      cmd: 'LED_ONLY',
      overlay: null,
      lamp: { colour: null, mode: 'BLINK_4HZ' },
    });
  });

  it('assumes the least capable tag in the catalogue for a model it has never heard of', async () => {
    const gateway = fleetOn('hashow', 'HS-2027-PREVIEW', FACING, TAG);
    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));

    // Planned as an HS-Lite: the task still reaches the shelf, in the least
    // presumptuous way this fleet has.
    expect(result.mode).toBe('mono_indicator');
  });
});

// ---------------------------------------------------------------------------
// Rules every fleet keeps
// ---------------------------------------------------------------------------

describe('every ESL fleet', () => {
  it('has an adapter, and its profile matches the vendor it is registered under', () => {
    for (const vendor of ESL_VENDORS) {
      expect(ESL_VENDOR_PROFILES[vendor].vendor).toBe(vendor);
    }
    expect(Object.keys(ESL_VENDOR_PROFILES).sort()).toEqual([...ESL_VENDORS].sort());
  });

  it('declares a floor model that is actually in its own catalogue', () => {
    for (const vendor of ESL_VENDORS) {
      const profile = ESL_VENDOR_PROFILES[vendor];
      expect(Object.keys(profile.models)).toContain(profile.floorModelCode);
    }
  });

  it('only ever claims a lane colour its catalogue can actually render', () => {
    for (const vendor of ESL_VENDORS) {
      const profile = ESL_VENDOR_PROFILES[vendor];
      for (const model of Object.values(profile.models)) {
        // A tag declaring a colour but no colour-capable mode would have the
        // ladder plan a lit lane onto hardware that cannot light one.
        if (model.colours.length > 0) {
          expect(
            model.modes.includes('lane_colour_steady') || model.modes.includes('pick_to_light'),
          ).toBe(true);
        }
      }
    }
  });

  const vendors: readonly EslVendor[] = ESL_VENDORS;

  it.each(vendors)('%s expresses something rather than nothing on its best tag', async (vendor) => {
    const profile = ESL_VENDOR_PROFILES[vendor];
    const best = Object.keys(profile.models)[0];
    const gateway = fleetOn(vendor, best ?? profile.floorModelCode, FACING, TAG);

    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));
    expect(result.mode).not.toBe('none');
  });

  it.each(vendors)('%s reaches the shelf even on its floor model', async (vendor) => {
    const profile = ESL_VENDOR_PROFILES[vendor];
    const gateway = fleetOn(vendor, profile.floorModelCode, FACING, TAG);

    const result = expressed(await createEslAdapter(gateway).express(expressCommand()));
    // Degraded on every floor model in the estate — that is what a floor model is
    // — but never dark, and never routed elsewhere.
    expect(result.mode).not.toBe('none');
    expect(result.degraded).toBe(true);
  });

  it.each(vendors)('%s never drives the reserved shopper-pick lane', async (vendor) => {
    const profile = ESL_VENDOR_PROFILES[vendor];
    const best = Object.keys(profile.models)[0] ?? profile.floorModelCode;
    const gateway = fleetOn(vendor, best, FACING, TAG);

    const result = await createEslAdapter(gateway).express(
      expressCommand({ lane: 'green', flashPattern: null }),
    );

    if (result.status === 'expressed') {
      expect(result.renderedColour).toBeNull();
      expect(result.mode === 'label_badge' || result.mode === 'mono_indicator').toBe(true);
    } else {
      expect(result.status).toBe('unavailable');
    }
  });

  it.each(vendors)('%s translates its own refusal codes into the port’s reasons', async (vendor) => {
    const profile = ESL_VENDOR_PROFILES[vendor];
    const offlineCode = Object.entries(profile.refusalCodes).find(
      ([, reason]) => reason === 'tag_offline',
    )?.[0];
    expect(offlineCode).toBeDefined();

    const gateway = fleetOn(vendor, profile.floorModelCode, FACING, TAG);
    gateway.refusals.set(TAG, offlineCode ?? '');

    const result = unavailable(await createEslAdapter(gateway).express(expressCommand()));
    expect(result.reason).toBe('tag_offline');
    expect(result.retryAfter).toBe(millis(5_000));
  });
});
