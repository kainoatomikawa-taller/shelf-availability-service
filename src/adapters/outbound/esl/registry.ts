import type { EslActuationPort } from '../../../ports/outbound/esl-actuation.port.js';
import { createEslFleetAdapter, type EslVendorProfile } from './fleet-adapter.js';
import type { EslFleetGateway } from './gateway.js';
import type { EslVendor } from './tag-model.js';
import { aperionProfile } from './vendors/aperion.js';
import { hashowProfile } from './vendors/hashow.js';
import { pricerProfile } from './vendors/pricer.js';
import { solumProfile } from './vendors/solum.js';
import { vusionProfile } from './vendors/vusion.js';

/**
 * Every ESL fleet, and the profile that speaks its dialect.
 *
 * A mapped type over `EslVendor` rather than an array, for the same reason the
 * detection-source registry is: "we have an adapter for every fleet we claim to
 * support" is then checked by the compiler. A sixth vendor is a type error here
 * until someone writes its profile, rather than a retailer discovering at
 * go-live that their shelves are the one estate nothing lights.
 */
export const ESL_VENDOR_PROFILES: { readonly [V in EslVendor]: EslVendorProfile } = {
  vusion: vusionProfile,
  aperion: aperionProfile,
  solum: solumProfile,
  pricer: pricerProfile,
  hashow: hashowProfile,
};

export const ALL_ESL_VENDOR_PROFILES: readonly EslVendorProfile[] =
  Object.values(ESL_VENDOR_PROFILES);

/**
 * Builds the driven adapter for whichever fleet a retailer runs in a store.
 *
 * The gateway declares its own vendor, so this is the one place a mismatched
 * pairing — a Pricer transceiver handed to the Solum profile — is caught, rather
 * than at the first refused command.
 */
export const createEslAdapter = (gateway: EslFleetGateway): EslActuationPort =>
  createEslFleetAdapter(ESL_VENDOR_PROFILES[gateway.vendor], gateway);
