/**
 * The monthly engine cap as the platform desk (/admin) reads and writes it.
 *
 * The cap itself is unchanged: `workspaces.allowance_usd`, dollars a month of
 * what the ENGINES charge the platform for this workspace's jobs (their cost,
 * not the credits the workspace is billed for them), enforced by
 * lib/allowance.ts (`allowanceCheck`), lib/quote.ts and
 * `reserveGenerationSpend`. The desk shows it in those dollars and nothing
 * else: no figure in credits beside it.
 *
 * Why no credits: billing adds each engine's margin and rounds every job up
 * (lib/creditTerms.ts), so N dollars of engine cost is billed as more than
 * N / credit price credits, by an amount that depends on which engines ran.
 * A "$10 · 100 CR" label would read as a 100-credit cap and let the workspace
 * be billed well past it. To hold a workspace to a number of billed credits,
 * its credit balance is the wall; the cap stops the platform's engine spend.
 *
 * What the stored value means, and what the desk must keep apart:
 * - a number, 0 included, is this workspace's own cap. 0 is a wall: no job
 *   the platform pays an engine for starts.
 * - null is "no cap of its own": the deployment's default applies
 *   (PLATFORM_ALLOWANCE_USD), and when that is unset there is no cap at all.
 *
 * So an empty box must never be read as 0 (that would wall a workspace by
 * accident), and 0 must never be read as "none" (that would open one).
 *
 * No imports: the browser reads it.
 */

/** The most the admin route accepts, in dollars a month. */
export const CAP_MAX_USD = 100_000;

/**
 * What an admin typed, as the dollars to send: 0 or more, to the cent.
 * Blank is refused rather than read as 0: removing a cap is its own button.
 */
export function parseCapUsd(raw: string): { ok: true; usd: number } | { ok: false; error: string } {
  const text = raw.replace(/[,\s]/g, "").replace(/^\$/, "");
  if (text === "") return { ok: false, error: "Type dollars a month, 0 or more." };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: "Dollars a month, 0 or more, to the cent." };
  const usd = Number(text);
  if (!Number.isFinite(usd) || usd > CAP_MAX_USD)
    return { ok: false, error: `At most $${CAP_MAX_USD.toLocaleString("en-US")} a month.` };
  return { ok: true, usd };
}

export type CapView =
  /** The house workspace: never billed in credits, takes no cap. */
  | { kind: "house" }
  /** No cap of its own, and the deployment sets none. */
  | { kind: "none" }
  /** No cap of its own; the deployment's default applies. */
  | { kind: "default"; usd: number }
  /** Its own cap. usd 0 is a wall. */
  | { kind: "own"; usd: number };

export function capView(w: { allowanceUsd: number | null; house?: boolean }, defaultUsd: number | null): CapView {
  if (w.house) return { kind: "house" };
  if (w.allowanceUsd != null) return { kind: "own", usd: w.allowanceUsd };
  if (defaultUsd != null) return { kind: "default", usd: defaultUsd };
  return { kind: "none" };
}

const usdText = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What every cap's title says: what it caps, and what it does not. */
export const CAP_MEANS = "Caps what the engines charge the platform for this workspace each month (their cost, from the 1st). It is not a cap on the credits the workspace is billed, which carry each engine's margin: its credit balance is that wall.";

/** The cell's two lines: the cap in engine dollars, and what it means. */
export function capLabel(v: CapView): { main: string; sub: string; title: string } {
  switch (v.kind) {
    case "house": return { main: "—", sub: "Never billed", title: "The house workspace is never billed in credits and takes no cap." };
    case "none": return { main: "NO CAP", sub: "Deployment sets none", title: CAP_MEANS };
    case "default": return { main: usdText(v.usd), sub: v.usd === 0 ? "Default · nothing can spend" : "Deployment default · engine cost", title: CAP_MEANS };
    case "own": return { main: usdText(v.usd), sub: v.usd === 0 ? "Nothing can spend" : "Engine cost a month", title: CAP_MEANS };
  }
}
