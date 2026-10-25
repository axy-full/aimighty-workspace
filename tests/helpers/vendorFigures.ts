import snapshot from "../../lib/modelCatalog.json";

/* Keys that hold a tier's bounds or an image size, not a price. */
const NOT_A_PRICE = new Set(["min", "max", "threshold", "size"]);

/** Every price figure in a value, at any depth (tiers, regions, service tiers), whether written as a number or a string. */
export function priceFigures(value: unknown, key = ""): number[] {
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => priceFigures(v, k));
  if (NOT_A_PRICE.has(key)) return [];
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? [n] : [];
}

type Priced = { pricing?: unknown };
const catalogue = snapshot as unknown as { models: Priced[]; providerPriced?: Priced[] };
let listed: Set<number> | null = null;
/* Every figure in every catalogue entry's pricing in lib/modelCatalog.json: the gateway entries and the provider-priced ones. */
const catalogueFigures = () => listed ??= new Set([...catalogue.models, ...(catalogue.providerPriced ?? [])].flatMap((m) => priceFigures(m.pricing)));

/**
 * The figures in a fixture's pricing that some catalogue entry also has. No fixture or spec states a vendor's rate (owner, 23 Oct 2026):
 * a spec runs this on each priced fixture it makes up and expects nothing back.
 *
 * What a pass does not cover: the code's own price tables (lib/vendorRates.ts, the render and training rates) are not read, so a fixture
 * copying one of those passes; and only an exact figure is caught, not a scaled or rounded copy.
 */
export function vendorRatesIn(pricing: unknown): number[] {
  const known = catalogueFigures();
  return priceFigures(pricing).filter((n) => known.has(n));
}
