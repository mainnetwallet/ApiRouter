import { PROVIDER_IDS } from "../config.js";

/**
 * The public provider catalog.
 *
 * Re-exported from `config.js` rather than repeated, so the catalog the server
 * advertises cannot drift from the providers the configuration actually reads:
 * a provider added in one place is registered in both, or in neither.
 */
export const PROVIDERS = [...PROVIDER_IDS];
