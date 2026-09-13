import { VENDOR_RATES } from "./vendorRates";
import { TEXT_RATES } from "./refineGate";
import { creditUsd, marginFor, tableFor } from "./creditTerms";
import { currentTenant } from "./tenant";
import type { RateTable, ModelRates, Unit } from "./rateTable";

/**
 * Turn the vendors' dollars into the unit a workspace is allowed to see.
 *
 * Every figure is multiplied through once, here, on the server. The margin
 * never crosses the wire and neither does the dollar it was applied to — and
 * because the estimator downstream is linear in the rate, a table converted
 * this way produces exactly the credit figure the old two-step
 * (estimate in dollars, then convert) produced. `tests/unit/rateTable.spec.ts`
 * asserts that across the whole catalogue rather than trusting the algebra.
 *
 * Unrounded on purpose: rounding belongs at the end, once, on the total a
 * person is about to be charged. Rounding each rate first would overcharge a
 * three-second clip and undercharge a thirty-second one.
 */
export function buildRateTable(unit: Unit, internal = currentTenant()?.workspace?.internal === true): RateTable {
  const per = creditUsd();
  /* The workspace's own table: at cost when it is flagged internal (§7A
     guardrail 6), so the price on its buttons is the price its ledger
     charges. Defaults to the tenant in scope; a caller building a table for
     another workspace says so. */
  const table = tableFor(internal);
  const models: Record<string, ModelRates> = {};

  for (const [id, r] of Object.entries(VENDOR_RATES)) {
    /* The margin is the ENGINE's, keyed by model id, so a table built for one
       workspace is right for every engine in it — not one blended rate. */
    const k = unit === "usd" ? 1 : marginFor(id, table) / per;
    const out: ModelRates = {};
    if (r.tiers?.length) {
      out.tiers = r.tiers.map((t) => ({
        resolutions: t.resolutions,
        withoutVideo: t.withoutVideo * k,
        withVideo: t.withVideo * k,
      }));
    }
    if (r.secondRates?.length) {
      out.secondRates = r.secondRates.map((t) => ({
        resolutions: t.resolutions,
        withoutAudio: t.withoutAudio * k,
        withAudio: t.withAudio * k,
      }));
    }
    if (r.taskRates) {
      out.taskRates = Object.fromEntries(
        Object.entries(r.taskRates).map(([task, v]) => [task, (v as number) * k]),
      ) as ModelRates["taskRates"];
    }
    if (r.imagePricing) {
      out.imagePricing = Object.fromEntries(
        Object.entries(r.imagePricing).map(([size, v]) => [size, v * k]),
      );
    }
    if (r.imageRefInUsd != null) out.imageRefIn = r.imageRefInUsd * k;
    models[id] = out;
  }

  /* The writer, on the same terms. Its margin is its own — `text` in the
     table — and is applied here so the three Atomik screens that quote a
     draft never need the margin themselves. */
  const textK = unit === "usd" ? 1 : marginFor("text", table) / per;
  const text = Object.fromEntries(
    Object.entries(TEXT_RATES).map(([id, r]) => [id, { input: r.input * textK, output: r.output * textK }]),
  );

  return { unit, models, text, creditUsd: per };
}
