import { currentTenant } from "./tenant";

/**
 * Which gated models (lib/models.ts GATED_MODELS) are open for the request in scope, recorded by lib/modelGate.ts where it asks (admission, the composer's lists) and read here
 * by the price path (`ratesFor`, lib/vendorRates.ts), which is synchronous and has no workspace to ask. FAILS CLOSED: a scope nobody has asked for has none open, so a quote helper
 * that is called without the gate having been asked (a shot's planned budget, a preview batch, a customer naming the id) returns no price for a gated model. Settlement does not read this:
 * it prices from the take's own recorded parameters (`ratesFor(..., settle)`).
 * Imports only the tenant scope, so the rates module can use it without a cycle.
 */
const open = new WeakMap<object, ReadonlySet<string>>();

export function recordOpenGated(ids: Iterable<string>): void {
  const scope = currentTenant();
  if (scope) open.set(scope, new Set(ids));
}

export function gatedPriceOpen(modelId: string): boolean {
  const scope = currentTenant();
  return Boolean(scope && open.get(scope)?.has(modelId));
}
