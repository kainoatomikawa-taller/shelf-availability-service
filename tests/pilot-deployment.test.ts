import { describe, expect, it } from 'vitest';
import {
  DAY,
  deploymentManifest,
  describeDeployment,
  detectionTopic,
  instant,
  instantFromISO,
  millis,
  retailerId,
  MONTH,
  PILOT_MAX_RETAILERS,
  PILOT_MIN_RETAILERS,
  planPilotDeployment,
  standardRetention,
  startDeployment,
  subscriptionsForRetailer,
  timeWindow,
  type PilotDeploymentInput,
  type RetailerTenant,
} from '../src/index.js';
import { ACME, RIVAL } from './support/fixtures.js';
import {
  ACME_SLUG,
  ACME_TENANT,
  PILOT_START,
  PILOT_WINDOW,
  RIVAL_TENANT,
  TWO_TENANTS,
  tenant,
} from './support/tenancy.js';
import { infrastructureFor } from './support/infrastructure.js';

/**
 * The pilot deployment: two to four retailers, nine to fifteen months.
 *
 * The bounds are enforced rather than documented, so the tests here are mostly
 * about what the planner refuses. That is deliberate — a plan that is applied
 * halfway leaves one retailer provisioned and another half-provisioned, which is
 * worse than not having started, so everything that can be refused is refused
 * while it is still a plan.
 */

const pilot = (overrides: Partial<PilotDeploymentInput> = {}): PilotDeploymentInput => ({
  environment: 'pilot',
  tenants: TWO_TENANTS,
  window: PILOT_WINDOW,
  ...overrides,
});

const extraTenant = (n: number): RetailerTenant =>
  tenant(retailerId(`retailer-${n}`), `retailer-${n}` as RetailerTenant['slug'], {
    onboardedAt: instantFromISO('2026-03-02T00:00:00.000Z'),
  });

describe('how many retailers a pilot runs', () => {
  it('plans two', () => {
    const deployment = planPilotDeployment(pilot());

    expect(deployment.registry.size).toBe(PILOT_MIN_RETAILERS);
    expect(deployment.dataStores).toHaveLength(2);
    expect(deployment.bus).toHaveLength(2);
    expect(deployment.sizing).toHaveLength(2);
  });

  it('plans four', () => {
    const deployment = planPilotDeployment(
      pilot({ tenants: [...TWO_TENANTS, extraTenant(3), extraTenant(4)] }),
    );

    expect(deployment.registry.size).toBe(PILOT_MAX_RETAILERS);
    expect(deployment.subscriptions).toHaveLength(4 * 5);
  });

  it('refuses one, which cannot demonstrate isolation', () => {
    expect(() => planPilotDeployment(pilot({ tenants: [ACME_TENANT] }))).toThrow(
      /nothing to leak into/,
    );
  });

  it('refuses five', () => {
    expect(() =>
      planPilotDeployment(
        pilot({ tenants: [...TWO_TENANTS, extraTenant(3), extraTenant(4), extraTenant(5)] }),
      ),
    ).toThrow(/2–4 retailers; 5 was configured/);
  });
});

describe('how long a pilot runs', () => {
  it.each([9, 12, 15])('accepts a %d-month window', (months) => {
    const window = timeWindow(PILOT_START, instant(PILOT_START + months * MONTH));

    expect(() => planPilotDeployment(pilot({ window }))).not.toThrow();
  });

  it('refuses a window shorter than nine months', () => {
    const window = timeWindow(PILOT_START, instant(PILOT_START + 6 * MONTH));

    expect(() => planPilotDeployment(pilot({ window }))).toThrow(/9–15 months; 6 months/);
  });

  it('refuses a window longer than fifteen months', () => {
    const window = timeWindow(PILOT_START, instant(PILOT_START + 18 * MONTH));

    expect(() => planPilotDeployment(pilot({ window }))).toThrow(/9–15 months; 18 months/);
  });

  it('refuses a retailer onboarded outside the window', () => {
    const early: RetailerTenant = {
      ...RIVAL_TENANT,
      onboardedAt: instantFromISO('2025-06-01T00:00:00.000Z'),
    };

    expect(() => planPilotDeployment(pilot({ tenants: [ACME_TENANT, early] }))).toThrow(
      /outside the pilot window/,
    );
  });

  it('refuses retention that would expire the pilot\'s own first months', () => {
    const policy = standardRetention(RIVAL);
    const forgetful: RetailerTenant = {
      ...RIVAL_TENANT,
      retention: {
        ...policy,
        horizons: {
          ...policy.horizons,
          detection_event: millis(30 * DAY),
          read_model_rollup: millis(60 * DAY),
          facing_history: millis(120 * DAY),
        },
      },
    };

    expect(() => planPilotDeployment(pilot({ tenants: [ACME_TENANT, forgetful] }))).toThrow(
      /keeps "facing_history" for 4 months against a 12-month pilot/,
    );
  });
});

describe('what a plan contains', () => {
  const deployment = planPilotDeployment(pilot());

  it('gives every retailer their own stores, topics, keys and group', () => {
    const manifest = deploymentManifest(deployment);

    expect(manifest.retailers).toHaveLength(2);
    const everything = manifest.retailers.flatMap((retailer) => [
      ...retailer.schemas,
      retailer.role,
      ...retailer.keys,
      retailer.consumerGroup,
      ...retailer.topics.map((topic) => topic.name),
    ]);
    expect(new Set(everything).size).toBe(everything.length);
  });

  it('renders each retailer\'s DDL naming only that retailer', () => {
    const manifest = deploymentManifest(deployment);
    const [acme, rival] = manifest.retailers;
    if (acme === undefined || rival === undefined) throw new Error('expected two retailers');

    expect(acme.ddl).toContain('osa_acme_grocery');
    expect(acme.ddl).not.toContain('rival');
    expect(rival.ddl).toContain('osa_rival_mart');
    expect(rival.ddl).not.toContain('acme');
  });

  it('carries a retention job for every table of every retailer', () => {
    const manifest = deploymentManifest(deployment);

    for (const retailer of manifest.retailers) {
      expect(retailer.retentionJobs.length).toBeGreaterThan(0);
      for (const job of retailer.retentionJobs) {
        expect(retailer.schemas).toContain(job.schema);
        expect(job.horizonMillis).toBeGreaterThan(0);
      }
    }
  });

  it('groups stores and brokers by residency, which is the retailer\'s to decide', () => {
    const crossRegion = planPilotDeployment(
      pilot({ tenants: [ACME_TENANT, { ...RIVAL_TENANT, residency: 'eu' }] }),
    );

    expect(crossRegion.regions).toEqual([
      { residency: 'us', retailerIds: [ACME] },
      { residency: 'eu', retailerIds: [RIVAL] },
    ]);
  });

  it('sizes each retailer from their own facing count and horizons', () => {
    const [acme] = deployment.sizing;
    if (acme === undefined) throw new Error('expected sizing');

    expect(acme.facings).toBe(ACME_TENANT.scale.facings);
    // History outlives detections by six times, but only a twentieth of signals
    // are transitions — so the history store is the smaller of the two.
    expect(acme.historyStoreBytes).toBeLessThan(acme.detectionStoreBytes);
    // The broker holds a week; the store holds ninety days.
    expect(acme.brokerBytes).toBeLessThan(acme.detectionStoreBytes);
    expect(acme.ingestReplicas).toBe(2);
    expect(acme.connectionPoolSize).toBeGreaterThanOrEqual(4);
  });

  it('summarises the numbers a review actually argues about', () => {
    expect(describeDeployment(deployment)).toContain('pilot: 2 retailers, 12 months');
  });
});

describe('starting a planned deployment', () => {
  const deployment = planPilotDeployment(pilot());

  it('gives every retailer their own container and their own consumer', () => {
    const runtimes = startDeployment(deployment, infrastructureFor);

    expect(runtimes.all).toHaveLength(2);
    const acme = runtimes.require(ACME);
    const rival = runtimes.require(RIVAL);

    expect(acme.container).not.toBe(rival.container);
    expect(acme.consumer).not.toBe(rival.consumer);
    expect(acme.container.resolve('facingRepository')).not.toBe(
      rival.container.resolve('facingRepository'),
    );
  });

  it('subscribes each consumer to its own retailer\'s topics only', () => {
    const runtimes = startDeployment(deployment, infrastructureFor);
    const acme = runtimes.require(ACME);

    expect([...acme.consumer.topics].sort()).toEqual(
      [...subscriptionsForRetailer(deployment, ACME).map((s) => s.topic)].sort(),
    );
    expect(acme.consumer.topics).toContain(detectionTopic(ACME_SLUG, 'caper_frame'));
    for (const topic of acme.consumer.topics) {
      expect(topic).not.toContain('rival');
    }
  });

  it('names a retailer it is not running rather than falling through to another', () => {
    const runtimes = startDeployment(deployment, infrastructureFor);

    expect(runtimes.find(retailerId('third-party'))).toBeNull();
    expect(() => runtimes.require(retailerId('third-party'))).toThrow(
      /"third-party" is not running/,
    );
  });
});
