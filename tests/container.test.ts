import { describe, expect, it } from 'vitest';
import {
  createContainer,
  createDetectionConsumer,
  detectionTopic,
  DetectionIngestionService,
  DetectionStreamConsumer,
  PORT_NAMES,
  planRetailerBus,
  ReportingAdapter,
  standardProviders,
  storeId,
  type PortName,
  type PortProviders,
  type ServicePorts,
} from '../src/index.js';
import { ACME, RIVAL, STORE } from './support/fixtures.js';
import { ACME_SLUG, ACME_TENANT } from './support/tenancy.js';
import { infrastructureFor } from './support/infrastructure.js';

/**
 * The composition root.
 *
 * What is worth testing here is not that a factory returns an object — the
 * compiler already refuses a `PortProviders` with a port missing — but the three
 * things the types cannot state: that resolving is memoized, so the ingestion
 * service and the reporting adapter see one store rather than two; that the read
 * ports and the audit export are the *same* adapter, which is what keeps a report
 * and the artifact substantiating it in agreement; and that a container scoped to
 * one retailer cannot be handed another retailer's subscriptions.
 */

const containerFor = (tenant = ACME_TENANT) =>
  createContainer(tenant, infrastructureFor(tenant));

describe('binding every port', () => {
  it('binds all ten ports to an implementation', () => {
    const ports = containerFor().ports();

    expect(PORT_NAMES).toHaveLength(10);
    for (const name of PORT_NAMES) {
      expect(ports[name]).toBeDefined();
    }
  });

  it('builds this service\'s own code and takes only drivers from infrastructure', () => {
    const infrastructure = infrastructureFor(ACME_TENANT);
    const container = createContainer(ACME_TENANT, infrastructure);

    // Built here.
    expect(container.resolve('detectionIngestion')).toBeInstanceOf(DetectionIngestionService);
    expect(container.resolve('reporting')).toBeInstanceOf(ReportingAdapter);
    // Handed in: these are the four that genuinely need a driver.
    expect(container.resolve('facingRepository')).toBe(infrastructure.facings);
    expect(container.resolve('ingestionLedger')).toBe(infrastructure.ledger);
    expect(container.resolve('eventStream')).toBe(infrastructure.stream);
    expect(container.resolve('deadLetterSink')).toBe(infrastructure.deadLetters);
  });

  it('memoizes, so two ports sharing a dependency share the instance', () => {
    const container = containerFor();

    expect(container.resolve('detectionIngestion')).toBe(container.resolve('detectionIngestion'));
    expect(container.resolve('facingRepository')).toBe(container.resolve('facingRepository'));
  });

  it('serves both read ports and the audit export from one adapter', () => {
    const container = containerFor();

    // Three bindings, one instance. Three that merely constructed the same class
    // would compute a report and its artifact from two read models.
    const reporting = container.resolve('reporting');
    expect(container.resolve('availabilityQuery')).toBe(reporting);
    expect(container.resolve('taskPerformanceQuery')).toBe(reporting);
    expect(container.resolve('auditExport')).toBe(reporting);
  });

  it('holds one fleet adapter per store, because the adapter holds that store\'s leases', () => {
    const container = containerFor();
    const actuation = container.resolve('eslActuation');

    // A fresh adapter per call would lose every live expression lease and reset
    // the per-tag command interval.
    expect(actuation(ACME, STORE)).toBe(actuation(ACME, STORE));
    expect(actuation(ACME, storeId('acme-0043'))).not.toBe(actuation(ACME, STORE));
  });

  it('refuses to build a fleet adapter for a retailer this container is not scoped to', () => {
    const actuation = containerFor().resolve('eslActuation');

    expect(() => actuation(RIVAL, STORE)).toThrow(
      /container was asked for retailer "rival-mart"/,
    );
  });

  it('names both ports in a dependency cycle rather than overflowing the stack', () => {
    const cyclic: PortProviders = {
      ...standardProviders,
      facingRepository: ({ resolve }) =>
        resolve('ingestionLedger') as unknown as ServicePorts['facingRepository'],
      ingestionLedger: ({ resolve }) =>
        resolve('facingRepository') as unknown as ServicePorts['ingestionLedger'],
    };
    const container = createContainer(ACME_TENANT, infrastructureFor(ACME_TENANT), cyclic);

    expect(() => container.resolve('facingRepository')).toThrow(
      /facingRepository -> ingestionLedger -> facingRepository/,
    );
  });

  it('resolves everything at startup, so a bad binding fails before the first request', () => {
    const broken: PortProviders = {
      ...standardProviders,
      deadLetterSink: () => {
        throw new Error('no dead-letter topic configured');
      },
    };
    const container = createContainer(ACME_TENANT, infrastructureFor(ACME_TENANT), broken);

    expect(() => container.ports()).toThrow(/no dead-letter topic configured/);
  });

  it('lets a test override one binding without restating the other nine', () => {
    const names: PortName[] = [...PORT_NAMES];

    // The mapped type is what guarantees this: an override object is still a
    // complete `PortProviders`, so a spread cannot quietly drop a port.
    const overridden: PortProviders = { ...standardProviders };
    expect(Object.keys(overridden).sort()).toEqual(names.sort());
  });
});

describe('scoping a container to one retailer', () => {
  it('wires the consumer with that retailer\'s topics and no others', () => {
    const container = containerFor();
    const topology = planRetailerBus(ACME_TENANT);

    const consumer = createDetectionConsumer(container, topology.subscriptions);

    expect(consumer).toBeInstanceOf(DetectionStreamConsumer);
    expect([...consumer.topics].sort()).toEqual([...topology.subscriptions.map((s) => s.topic)].sort());
    for (const topic of consumer.topics) {
      expect(topic.startsWith(`osa.${ACME_SLUG}.`)).toBe(true);
    }
  });

  it('refuses a subscription belonging to another retailer', () => {
    const container = containerFor();

    expect(() =>
      createDetectionConsumer(container, [
        {
          topic: detectionTopic(ACME_SLUG, 'pos_movement'),
          source: 'pos_movement',
          retailerId: RIVAL,
        },
      ]),
    ).toThrow(/was given a subscription for "rival-mart"/);
  });

  it('holds one tenant, so nothing downstream can reach two', () => {
    const acme = containerFor();

    expect(acme.tenant.retailerId).toBe(ACME);
    // Two retailers means two containers, two pools and two consumers — there is
    // no value in the wiring that holds both.
    expect(acme.resolve('facingRepository')).not.toBe(
      createContainer(ACME_TENANT, infrastructureFor(ACME_TENANT)).resolve('facingRepository'),
    );
  });
});
