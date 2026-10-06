import { requireUser, withTenant } from "@/lib/auth";
import { budgetPause, cleanWarnPct, projectCapSpent } from "@/lib/caps";
import { planBudgetLine } from "@/lib/budgetPause";
import { planGateQuote } from "@/lib/workbench/rig-agent";
import { getSetting } from "@/lib/settings";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * A production's budget as the reservation gate enforces it (lib/caps.ts projectCapSpent): its cap (its own, or the
 * workspace's budget per production), what it has used against it, and where paid work stops to ask (the workspace's
 * `capWarnPct` share). Credits workspaces only; read-only; this workspace only. The board's plan card reads it to show
 * "Paused at 80 % of the budget"; the gate decides on its own. With `runId` (a plan at its gate), also where the plan's
 * "at most" (the server's own quote) would take the production: one line for the card before Approve, or null.
 */
export const GET = withTenant(async (req: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  const scope = workbenchScopeProblem(req, requireTenant().id, got.user.id, false);
  if (scope) return Response.json({ error: scope }, { status: 409, headers: NO_STORE });
  const productionId = new URL(req.url).searchParams.get("productionId") ?? "";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(productionId)) return Response.json({ error: "Which production?" }, { status: 400, headers: NO_STORE });
  const row = await projectCapSpent(productionId);
  if (!row) return Response.json({ error: "No such production." }, { status: 404, headers: NO_STORE });
  /* A workspace that pays its vendors itself has no credit budget, and its dollars are not sent here. */
  if (row.unit !== "cr") return Response.json({ budget: null }, { headers: NO_STORE });
  const warnPct = cleanWarnPct(await getSetting("capWarnPct"));
  const pause = budgetPause({ cap: row.cap, spent: row.spent, needs: 0, warnPct });
  const runId = new URL(req.url).searchParams.get("runId");
  let plan: { atMost: number; line: string | null } | null = null;
  if (runId && /^[a-zA-Z0-9_-]{1,100}$/.test(runId) && row.cap != null) {
    const quote = await planGateQuote(productionId, runId).catch(() => null);
    const atCapRaw = await getSetting("atCap");
    const atCap = atCapRaw === "stop" || atCapRaw === "warn" ? atCapRaw : "producer";
    if (quote) plan = { atMost: quote.ceiling, line: planBudgetLine({ name: row.name, atMost: quote.ceiling, cap: row.cap, used: row.spent, warnPct, unlocked: row.unlocked, atCap }) };
  }
  return Response.json({
    plan,
    budget: row.cap == null ? null : {
      cap: row.cap, used: Math.round(row.spent * 10) / 10, warnPct, pauseAt: pause?.pauseAt ?? null, unlocked: row.unlocked, from: row.from ?? null,
    },
  }, { headers: NO_STORE });
});
