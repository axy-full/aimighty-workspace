import type { PageId } from "./types";

/**
 * What the shell needs to know about a page's Atomik plan. The plan registry
 * (lib/workspace/plans.ts) supplies this; until then every page answers null
 * and the shell falls back to plain copy rather than inventing a plan.
 */
export type PlanSummary = {
  title: string;
  /** e.g. "Free · text model" or a live credit quote. */
  price?: string | null;
  /** Shown on the gate, the waiting toolbar chip and the NEXT line. */
  gatePrice?: string | null;
  steps?: string[];
  /** False when no step calls a real backend: shown as "Not runnable yet". */
  runnable?: boolean;
};

export type PlanSource = (page: PageId) => PlanSummary | null;

export const NO_PLANS: PlanSource = () => null;

/** The seam the Library footer and the Atomik surfaces read a plan title from. */
export function planTitle(source: PlanSource, page: PageId): string | null {
  return source(page)?.title ?? null;
}
