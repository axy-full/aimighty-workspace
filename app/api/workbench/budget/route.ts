import { mayReachProject } from "@/lib/draftProject";
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
 * workspace's budget per production), what it has used against it, and the workspace's `capWarnPct` share, where the
 * producer is warned (nothing pauses there since Auto went on 20 Oct 2026). Credits workspaces only; read-only; this workspace
 * only. The board's plan card reads it for its budget lines; the gate decides on its own. With `runId` (a plan at its gate), also where the plan's
 * "at most" (the server's own quote) would take the production: one line for the card before Approve, or null. A token
 * caller (requireUser lets read-only API and MCP tokens through) gets the budget only, never the plan's figures.
 */
export const GET = withTenant(async (req: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  const scope = workbenchScopeProblem(req, requireTenant().id, got.user.id, false);
  if (scope) return Response.json({ error: scope }, { status: 409, headers: NO_STORE });
  const productionId = new URL(req.url).searchParams.get("productionId") ?? "";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(productionId)) return Response.json({ error: "Which production?" }, { status: 400, headers: NO_STORE });
  /* A private board is its owner's alone: asked about by anyone else it is as unknown as an unknown id (lib/draftProject.ts). */
  const row = (await mayReachProject(got.user, productionId, "read")) ? await projectCapSpent(productionId) : null;
  if (!row) return Response.json({ error: "No such production." }, { status: 404, headers: NO_STORE });
  /* A workspace that pays its vendors itself has no credit budget, and its dollars are not sent here. */
  if (row.unit !== "cr") return Response.json({ budget: null }, { headers: NO_STORE });
  const warnPct = cleanWarnPct(await getSetting("capWarnPct"));
  const pause = budgetPause({ cap: row.cap, spent: row.spent, needs: 0, warnPct });
  const runId = new URL(req.url).searchParams.get("runId");
  let plan: { atMost: number; line: string | null } | null = null;
  /* The plan's figures are the board's (its team-canvas read takes a browser session): a token caller gets none. */
  if (runId && !got.token && /^[a-zA-Z0-9_-]{1,100}$/.test(runId) && row.cap != null) {
    const quote = await planGateQuote(productionId, runId).catch(() => null);
    const atCapRaw = await getSetting("atCap");
    const atCap = atCapRaw === "stop" || atCapRaw === "warn" ? atCapRaw : "producer";
    if (quote) plan = { atMost: quote.ceiling, line: planBudgetLine({ name: row.name, total: quote.total, atMost: quote.ceiling, cap: row.cap, used: row.spent, warnPct, unlocked: row.unlocked, atCap }) };
  }
  return Response.json({
    plan,
    budget: row.cap == null ? null : {
      cap: row.cap, used: Math.round(row.spent * 10) / 10, warnPct, pauseAt: pause?.pauseAt ?? null, unlocked: row.unlocked, from: row.from ?? null,
    },
  }, { headers: NO_STORE });
});
