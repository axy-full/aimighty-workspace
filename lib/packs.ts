import { creditUsd } from "./creditTerms";

/**
 * Credit packs: what a workspace buys. Three sizes at the fixed rate,
 * agreed 6 September 2026; CREDIT_PACKS (JSON, [{id, credits, label}])
 * overrides the sizes without touching the rate. The dollar figure here
 * is the one place the product says dollars to a workspace.
 */
export type Pack = { id: string; label: string; credits: number; usd: number };

const DEFAULT_PACKS = [
  { id: "starter", label: "Starter", credits: 500 },
  { id: "studio", label: "Studio", credits: 2000 },
  { id: "house", label: "House", credits: 10000 },
];

let _packs: Pack[] | null = null;
export function packs(): Pack[] {
  if (_packs) return _packs;
  let sizes = DEFAULT_PACKS;
  try {
    const raw = process.env.CREDIT_PACKS ? (JSON.parse(process.env.CREDIT_PACKS) as unknown) : null;
    if (Array.isArray(raw) && raw.length) {
      const clean = raw
        .map((p) => (p && typeof p === "object" ? p as Record<string, unknown> : null))
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p!.id === "string" && Number(p!.credits) > 0)
        .map((p) => ({ id: String(p.id), label: String(p.label ?? p.id), credits: Math.round(Number(p.credits)) }));
      if (clean.length) sizes = clean;
    }
  } catch { /* an unreadable override keeps the defaults */ }
  const per = creditUsd();
  _packs = sizes.map((p) => ({ ...p, usd: Math.round(p.credits * per * 100) / 100 }));
  return _packs;
}

export function packById(id: string): Pack | null {
  return packs().find((p) => p.id === id) ?? null;
}
