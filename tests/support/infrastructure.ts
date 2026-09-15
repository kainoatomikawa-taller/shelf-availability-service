import {
  eventId,
  instantFromISO,
  streamSignalId,
  type Facing,
  type Instant,
  type RetailerInfrastructure,
  type RetailerTenant,
} from '../../src/index.js';
import { InMemoryFacingRepository, InMemoryIngestionLedger } from './in-memory-ports.js';
import { InMemoryEventStream, RecordingDeadLetterSink } from './in-memory-stream.js';
import { InMemoryReadModel } from './in-memory-read-model.js';
import { FakeFleetGateway, deployment } from './esl-gateways.js';

/**
 * In-process infrastructure for one tenant.
 *
 * One of these per retailer, exactly as a deployment would open one pool and one
 * broker client per retailer: a shared instance would be a test that cannot
 * observe the isolation the real wiring has.
 */
export interface TenantInfrastructure extends RetailerInfrastructure {
  readonly facings: InMemoryFacingRepository;
  readonly ledger: InMemoryIngestionLedger;
  readonly stream: InMemoryEventStream;
  readonly deadLetters: RecordingDeadLetterSink;
  readonly readModel: InMemoryReadModel;
  readonly gateways: FakeFleetGateway[];
}

export const NOW: Instant = instantFromISO('2026-09-15T12:00:00.000Z');

export const infrastructureFor = (tenant: RetailerTenant): TenantInfrastructure => {
  const gateways: FakeFleetGateway[] = [];

  return {
    clock: () => NOW,
    facings: new InMemoryFacingRepository(),
    ledger: new InMemoryIngestionLedger(),
    stream: new InMemoryEventStream(),
    deadLetters: new RecordingDeadLetterSink(),
    readModel: new InMemoryReadModel(tenant.onboardedAt),
    eslGateway: () => {
      const gateway = new FakeFleetGateway('vusion', deployment(['VUSION_SES_IMAGINE_29']));
      gateways.push(gateway);
      return gateway;
    },
    nextSignalId: streamSignalId,
    nextEventId: (facing: Facing) =>
      eventId(`${facing.facingId}:${facing.history.events.length + 1}`),
    gateways,
  };
};
