import type { RetailerId } from './ids.js';

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown whenever an operation would combine data belonging to two retailers.
 *
 * Tenant isolation is a modelling invariant here, not a query-time filter: there
 * is no legitimate path in the domain that pools facings, events, tasks or index
 * inputs across retailers, so violations fail loudly instead of degrading to a
 * silently wrong aggregate.
 */
export class CrossRetailerAccessError extends DomainError {
  readonly code = 'CROSS_RETAILER_ACCESS' as const;

  constructor(
    readonly expected: RetailerId,
    readonly actual: RetailerId,
    readonly context: string,
  ) {
    super(
      `Cross-retailer access rejected in ${context}: expected partition "${expected}", got "${actual}"`,
    );
  }
}

export class OutOfOrderEventError extends DomainError {
  readonly code = 'OUT_OF_ORDER_EVENT' as const;

  constructor(message: string) {
    super(message);
  }
}

export class InvalidTaskTransitionError extends DomainError {
  readonly code = 'INVALID_TASK_TRANSITION' as const;

  constructor(
    readonly from: string,
    readonly attempted: string,
  ) {
    super(`Task cannot move from "${from}" via "${attempted}"`);
  }
}

export class LaneMappingError extends DomainError {
  readonly code = 'INVALID_LANE_MAPPING' as const;

  constructor(message: string) {
    super(message);
  }
}
