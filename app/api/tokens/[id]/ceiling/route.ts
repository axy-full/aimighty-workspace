import { securityAuditStatement } from "@/lib/securityAudit";
import { requireTenant } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireAdmin, withTenant } from "@/lib/auth";
import { creditsApply } from "@/lib/credits";
import { tokenCeiling } from "@/lib/tokenCeiling";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
/**
 * An admin sets a token's monthly ceiling (owner, 20 Oct 2026, Q1 "B": "An admin sets a ceiling per token in credits per month").
 * `{ capCredits }` in a workspace billed in credits (whole credits a month), `{ capUsd }` in one that pays its engines itself, read
 * strictly by lib/tokenCeiling.ts; blank or null clears it, and the token then only prepares and prices (lib/tokenSpend.ts).
 *
 * People only, and admins only: requireAdmin is a signed-in session (a token, an MCP client or Atomik is refused, whatever its
 * scope, so no caller can raise its own ceiling) with the admin role. Any token of this workspace that can generate, whoever made
 * it; a read-only or prepare token spends nothing and takes no ceiling. The figure is the token's one ceiling: in a credits workspace
 * it replaces a dollar ceiling left from before credits (cleared, both are none), and the other way round in one that pays in dollars.
 * Recorded in the security history with the figure before and after (whole credits, or whole cents), never a secret.
 */
export const PATCH = withTenant(async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) return NextResponse.json({ error: "Invalid token." }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || !("capCredits" in body || "capUsd" in body))
    return NextResponse.json({ error: "Give the monthly ceiling, or leave it blank and the token only prepares and prices." }, { status: 400 });
  const row = (await db().execute({ sql: `SELECT id, scope, cap_credits, cap_usd FROM api_tokens WHERE id = ? AND revoked_at IS NULL LIMIT 1`, args: [id] })).rows[0];
  if (!row) return NextResponse.json({ error: "That token is not in this workspace." }, { status: 404 });
  if (row.scope !== "render") return NextResponse.json({ error: "Only a token that can generate takes a ceiling. This one spends nothing." }, { status: 400 });
  /* The workspace's unit, decided as POST /api/tokens decides it (lib/credits creditsApply). */
  const inCredits = creditsApply(requireTenant());
  const ceiling = tokenCeiling(body, { scope: "render", inCredits });
  if ("error" in ceiling) return NextResponse.json({ error: ceiling.error }, { status: 400 });
  /* The admin's figure is the token's one ceiling: it replaces the other unit's, so a dollar ceiling left from before credits neither
     keeps a cleared token spending nor stays behind as a second wall. Cleared, both are none and the token only prepares and prices. */
  const before = inCredits ? row.cap_credits : row.cap_usd;
  const whole = (v: unknown) => (v == null ? null : inCredits ? Math.round(Number(v)) : Math.round(Number(v) * 100));
  const [updated] = await db().batch([
    inCredits
      ? { sql: `UPDATE api_tokens SET cap_credits = ?, cap_usd = NULL WHERE id = ? AND revoked_at IS NULL`, args: [ceiling.capCredits, id] }
      : { sql: `UPDATE api_tokens SET cap_usd = ?, cap_credits = NULL WHERE id = ? AND revoked_at IS NULL`, args: [ceiling.capUsd, id] },
    securityAuditStatement({ workspaceId: requireTenant().id, actorId: got.user.id, action: "api_token.ceiling_set", targetType: "api_token", targetId: id,
      details: { ceilingUnit: inCredits ? "cr" : "usd_cents", ceilingBefore: whole(before), ceilingAfter: whole(inCredits ? ceiling.capCredits : ceiling.capUsd),
        ...(inCredits && row.cap_usd != null ? { legacyCleared: true } : {}) } }, true),
  ], "write");
  /* Revoked between the read and the write: nothing changed, and nothing was recorded. */
  if (!updated?.rowsAffected) return NextResponse.json({ error: "That token is not in this workspace." }, { status: 404 });
  return NextResponse.json(inCredits ? { id, capCredits: ceiling.capCredits } : { id, capUsd: ceiling.capUsd });
}, { requireRequestScope: true });
