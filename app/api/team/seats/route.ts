import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformDb, platformReady, planOf } from "@/lib/platform";
import { ceilingFor } from "@/lib/planLimits";
import { now } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/team/seats — the seats this workspace's plan allows (`ceiling`, null for no limit) and how many are taken (`used`): enabled
 * members, plus open invitations to someone who is not one yet (an invitation holds a seat, as lib/teamInvitations.ts counts it).
 * An owner's or admin's, for People's "3 of 5 seats used". Read-only, this workspace only.
 */
export const GET = withTenant(async function GET() {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const [members, invites, plan] = await Promise.all([
    platformDb().execute({ sql: "SELECT a.email FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.workspace_id = ? AND m.disabled = 0 AND a.deleted_at IS NULL", args: [ws.id] }),
    platformDb().execute({ sql: "SELECT DISTINCT email FROM workspace_invites WHERE workspace_id = ? AND used_at IS NULL AND expires_at > ?", args: [ws.id, now()] }),
    planOf(ws).catch(() => null),
  ]);
  const taken = new Set(members.rows.map((r) => String(r.email)));
  const used = taken.size + invites.rows.filter((r) => !taken.has(String(r.email))).length;
  return NextResponse.json({ used, ceiling: plan ? ceilingFor(plan, "members") : null }, { headers: { "Cache-Control": "private, no-store" } });
});
