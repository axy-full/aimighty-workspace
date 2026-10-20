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
 * it; a read-only or prepare token spends nothing and takes no ceiling. A dollar ceiling left from before credits is kept as it is
 * (it is still enforced); nothing is ever dropped. Recorded in the security history.
 */
export const PATCH = withTenant(async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) return NextResponse.json({ error: "Invalid token." }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || !("capCredits" in body || "capUsd" in body))
    return NextResponse.json({ error: "Give the monthly ceiling, or leave it blank for none." }, { status: 400 });
  const row = (await db().execute({ sql: `SELECT id, scope FROM api_tokens WHERE id = ? AND revoked_at IS NULL LIMIT 1`, args: [id] })).rows[0];
  if (!row) return NextResponse.json({ error: "That token is not in this workspace." }, { status: 404 });
  if (row.scope !== "render") return NextResponse.json({ error: "Only a token that can generate takes a ceiling. This one spends nothing." }, { status: 400 });
  const inCredits = creditsApply(requireTenant());
  const ceiling = tokenCeiling(body, { scope: "render", inCredits });
  if ("error" in ceiling) return NextResponse.json({ error: ceiling.error }, { status: 400 });
  await db().batch([
    inCredits
      ? { sql: `UPDATE api_tokens SET cap_credits = ? WHERE id = ? AND revoked_at IS NULL`, args: [ceiling.capCredits, id] }
      : { sql: `UPDATE api_tokens SET cap_usd = ? WHERE id = ? AND revoked_at IS NULL`, args: [ceiling.capUsd, id] },
    securityAuditStatement({ workspaceId: requireTenant().id, actorId: got.user.id, action: "api_token.ceiling_set", targetType: "api_token", targetId: id }, true),
  ], "write");
  return NextResponse.json(inCredits ? { id, capCredits: ceiling.capCredits } : { id, capUsd: ceiling.capUsd });
}, { requireRequestScope: true });
