import {
  facingId,
  productId,
  storeId,
  type EslVendor,
  type FacingId,
  type Instant,
  type MerchandisingClassification,
  type ProductId,
  type StoreId,
} from '../../src/index.js';
import { CEREAL_GROCERY, DAIRY_FRESH, hour } from './fixtures.js';
import {
  ACME_TENANT,
  NORTH_TENANT,
  RIVAL_TENANT,
  SUD_TENANT,
} from './tenancy.js';
import {
  startPilot,
  type Pilot,
  type PilotFacingSpec,
  type PilotRetailerSpec,
  type PilotStoreSpec,
} from './pilot-harness.js';

/**
 * The pilots the integration suite runs against.
 *
 * Two shapes, both real: the floor the engagement allows (two retailers) and the
 * ceiling (four). Between them the four retailers run all five shelf-edge fleets,
 * because "integration tests pass for each ESL vendor" has to mean each vendor
 * driven through a container and a deployment, not five adapters instantiated
 * side by side in a unit test.
 *
 * Every store is small — a handful of facings — and that is deliberate. The scale
 * that matters for these tests is the number of *tenants*, since that is what the
 * isolation claims are about and what the deployment planner bounds; a pilot's
 * facing count is declared on the tenant and sized against the bus there, where a
 * test can assert on it without simulating twenty thousand shelves.
 */

export const OAT_MILK: ProductId = productId('sku-oat-milk-64oz');
export const CEREAL: ProductId = productId('sku-bran-flakes-500g');

export const ACME_STORE: StoreId = storeId('acme-0042');
export const ACME_STORE_TWO: StoreId = storeId('acme-0077');
export const RIVAL_STORE: StoreId = storeId('rival-0100');
export const NORTH_STORE: StoreId = storeId('north-0001');
export const SUD_STORE: StoreId = storeId('sud-0001');

/** A facing reference in the shape every producer spells it. */
export const facingRef = (store: StoreId, position: number): string =>
  `${store}:a12:b3:s2:p${position}`;

export const facingIn = (store: StoreId, position: number): FacingId =>
  facingId(facingRef(store, position));

export interface FacingOptions {
  readonly product?: ProductId;
  readonly classification?: MerchandisingClassification;
  readonly initialState?: PilotFacingSpec['initialState'];
}

export const pilotFacing = (
  store: StoreId,
  position: number,
  options: FacingOptions = {},
): PilotFacingSpec => ({
  facingId: facingIn(store, position),
  productId: options.product ?? OAT_MILK,
  classification: options.classification ?? DAIRY_FRESH,
  location: { aisle: 'A12', bay: 'B3', shelf: 2, position },
  capacityUnits: 12,
  // Facings start stocked so that a detected gap is a transition the test caused
  // rather than the state the fixture happened to open in.
  initialState: options.initialState ?? 'in_stock',
});

export interface StoreOptions {
  readonly facings?: number;
  readonly classification?: MerchandisingClassification;
  readonly gatewayReachable?: boolean;
}

export const pilotStore = (
  store: StoreId,
  vendor: EslVendor,
  modelCodes: readonly string[],
  options: StoreOptions = {},
): PilotStoreSpec => ({
  storeId: store,
  vendor,
  modelCodes,
  facings: Array.from({ length: options.facings ?? 2 }, (_, index) =>
    pilotFacing(store, index + 1, {
      ...(options.classification === undefined
        ? {}
        : { classification: options.classification }),
      ...(index === 1 ? { product: CEREAL, classification: CEREAL_GROCERY } : {}),
    }),
  ),
  ...(options.gatewayReachable === undefined
    ? {}
    : { gatewayReachable: options.gatewayReachable }),
});

/**
 * The five fleets, with the model code that can express the whole ladder and the
 * one that cannot.
 *
 * Both are named because a store mid-hardware-refresh runs two generations at
 * once, and the degradation each vendor falls back to is the thing worth
 * integrating: a task that reaches the shelf as a text badge is still a closed
 * loop, and a task that reaches it as nothing is not.
 */
export const VENDOR_MODELS: {
  readonly [V in EslVendor]: { readonly capable: string; readonly floor: string };
} = {
  vusion: { capable: 'VUSION_EDGE_3', floor: 'VUSION_SIGMA_2' },
  aperion: { capable: 'lumina-2', floor: 'classic-1' },
  solum: { capable: 'NEWTON_TOUCH', floor: 'NEWTON_PAPER' },
  pricer: { capable: 'SMARTFLASH', floor: 'CONTINUUM' },
  hashow: { capable: 'HS-PLUS', floor: 'HS-LITE' },
};

const capable = (vendor: EslVendor): readonly string[] => [
  VENDOR_MODELS[vendor].capable,
  VENDOR_MODELS[vendor].floor,
];

export const ACME_SPEC: PilotRetailerSpec = {
  tenant: ACME_TENANT,
  stores: [
    pilotStore(ACME_STORE, 'vusion', capable('vusion')),
    pilotStore(ACME_STORE_TWO, 'aperion', capable('aperion')),
  ],
};

export const RIVAL_SPEC: PilotRetailerSpec = {
  tenant: RIVAL_TENANT,
  stores: [pilotStore(RIVAL_STORE, 'hashow', capable('hashow'))],
};

export const NORTH_SPEC: PilotRetailerSpec = {
  tenant: NORTH_TENANT,
  stores: [pilotStore(NORTH_STORE, 'solum', capable('solum'))],
};

export const SUD_SPEC: PilotRetailerSpec = {
  tenant: SUD_TENANT,
  stores: [pilotStore(SUD_STORE, 'pricer', capable('pricer'))],
};

/** Where the clock starts for every integration test: the measurement day's open. */
export const PILOT_NOW: Instant = hour(0);

/** The floor a pilot is allowed to run: two retailers, four stores between them. */
export const twoRetailerPilot = (now: Instant = PILOT_NOW): Pilot =>
  startPilot([ACME_SPEC, RIVAL_SPEC], { now });

/** The ceiling: four retailers, five stores, all five shelf-edge fleets. */
export const fourRetailerPilot = (now: Instant = PILOT_NOW): Pilot =>
  startPilot([ACME_SPEC, RIVAL_SPEC, NORTH_SPEC, SUD_SPEC], { now });

/** Which store in the four-retailer pilot runs which vendor's fleet. */
export const STORE_BY_VENDOR: {
  readonly [V in EslVendor]: { readonly retailer: PilotRetailerSpec; readonly store: StoreId };
} = {
  vusion: { retailer: ACME_SPEC, store: ACME_STORE },
  aperion: { retailer: ACME_SPEC, store: ACME_STORE_TWO },
  hashow: { retailer: RIVAL_SPEC, store: RIVAL_STORE },
  solum: { retailer: NORTH_SPEC, store: NORTH_STORE },
  pricer: { retailer: SUD_SPEC, store: SUD_STORE },
};
