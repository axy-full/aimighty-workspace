import snapshot from "../../lib/modelCatalog.json";

/** Every rate-sized figure (0 < n < 1) in a value, at any depth, whether written as a number or a string. */
const figures = (value: unknown): number[] =>
  value && typeof value === "object" ? Object.values(value as Record<string, unknown>).flatMap(figures)
    : Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) < 1 ? [Number(value)] : [];

/* Every figure in every catalogue entry's pricing (lib/modelCatalog.json: the gateway entries and the provider-priced ones). */
let listed: Set<number> | null = null;
const catalogueFigures = () => listed ??= new Set([...snapshot.models, ...(snapshot.providerPriced ?? [])].flatMap((m) => figures(m.pricing)));

/** The figures in a fixture's pricing that some catalogue entry also has, at any depth (tiers, regions, service tiers included).
    No fixture may state a vendor's rate (owner, 23 Oct 2026): a spec checks each of its fixtures has none.

    What it does not check (a pass says nothing about these):
    - figures of 1 or more (per-thousand search prices, per-million spellings): only figures between 0 and 1 are compared;
    - the code price tables (lib/vendorRates.ts, the training and render rates, the prompt writer's per-million table): only
      lib/modelCatalog.json is read, so a fixture holding a per-second, per-image, per-megapixel or render rate passes whatever it is;
    - a figure derived from a vendor's rate (a scaled or rounded copy): only exact equality is caught. */
export function vendorRatesIn(pricing: unknown): number[] {
  const known = catalogueFigures();
  return figures(pricing).filter((n) => known.has(n));
}
