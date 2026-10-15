import { EXPORT_COMPOSITIONS, EXPORT_PRICE_LABEL } from "./contract";
import { EXPORT_PRICE, exportWorkerConfig } from "./limits";
import { exportsEnabled } from "./switch";

/**
 * The export tool, declared once (rule 11, the registry's shape: id, kind, inputs, provider, key, price, mock,
 * who may call). The button (screens come with Claude Design), Make, a board card, Atomik, a saved skill and an
 * outside agent over MCP all call this tool through the same route (POST /api/exports), at the same price, through the
 * same gate. Nothing about it is a person's alone: it spends nothing, so any caller with a render-scope token or a
 * signed-in person may run it. A paid step an export depends on is a different tool, priced and approved on its own
 * path before the export is asked for.
 */
export const EXPORT_TOOL = Object.freeze({
  id: "export_video",
  kind: "app-action" as const,
  /** Anyone who can render in the workspace; never an admin-only or people-only action. */
  callers: "render" as const,
  provider: "Remotion on our own export worker (our own templates only)",
  /** The settings it needs; a tool without them names them. */
  keys: ["REMOTION_WORKER_URLS", "REMOTION_WORKER_SECRETS"] as const,
  route: "/api/exports",
  compositions: EXPORT_COMPOSITIONS,
  /** The price of an export: always 0 cr, "Free". There is no quote to fetch and nothing to approve. */
  price: (): typeof EXPORT_PRICE => EXPORT_PRICE,
  priceLabel: EXPORT_PRICE_LABEL,
  /** The mock: the same tool against an in-memory worker (tests/unit/remotionWorkerFake.ts); no render, no network. */
  mock: "tests/unit/remotionWorkerFake.ts",
});

/** Whether the tool can run now, and when it cannot, why (naming the missing setting, never its value). */
export function exportToolAvailability(env: Readonly<Record<string, string | undefined>> = process.env): { available: boolean; reason: string | null } {
  if (!exportsEnabled(env)) return { available: false, reason: "Exports are not switched on for this deployment." };
  if (!exportWorkerConfig(env)) return { available: false, reason: `Exports need ${EXPORT_TOOL.keys.join(" and ")}: one to three worker addresses and a secret for each.` };
  return { available: true, reason: null };
}

/** The total of a plan that includes an export: the export adds nothing; paid steps are summed at their own prices. */
export function planTotalCredits(paidStepCredits: readonly number[]): number {
  return paidStepCredits.reduce((sum, credits) => sum + credits, EXPORT_TOOL.price().credits);
}

/** The same for one workspace: the settings above, and the workspace must be the house or listed (lib/engineGate.ts). */
export async function exportToolAvailabilityFor(
  workspace: { id: string } | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ available: boolean; reason: string | null }> {
  const base = exportToolAvailability(env);
  if (!base.available) return base;
  const { engineEnabledFor } = await import("../engineGate.server");
  if (!(await engineEnabledFor("remotion", workspace, env))) return { available: false, reason: "Exports are not switched on for this workspace." };
  return base;
}
