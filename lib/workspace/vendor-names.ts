/**
 * The workspace redesign's banned-name check. There is one list, in
 * lib/vendorNames.ts, and this module is the workspace-side door to it:
 * before, two lists drifted apart and each missed names the other held.
 *
 * Internal ids, env vars, API paths and code identifiers keep their names;
 * this is for strings a user can read.
 */
export { VENDOR_NAMES, vendorNameIn, hasVendorName } from "../vendorNames";
