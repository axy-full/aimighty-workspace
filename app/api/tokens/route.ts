import { securityAuditStatement } from "@/lib/securityAudit";
import { requireTenant } from "@/lib/tenant";
import { parseCeiling } from "@/lib/tokenCeiling";
import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { creditsApply } from "@/lib/credits";
import { billedCreditsExpr } from "@/lib/creditSql";
import {
  currentUser, requireSession, mintTokenSecret, tokenHash, type TokenScope, withTenant } from "@/lib/auth";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * API tokens — how the CLI and the MCP server get in.
 *
 * Deliberately session-only: a token may never mint another token, so a
 * leaked one can't quietly breed replacements or widen its own scope. You
 * make these while signed in, in Settings.
 *
 * THAT PARAGRAPH WAS TRUE AND UNENFORCED. The guard was `currentUser()`,
 * which answers for a BEARER caller as well — `callerFromBearer` puts a user
 * in the store — so "is there a user?" was being asked while "is this a
 * session?" was meant. Any token of either scope passed it, and nothing
 * looked at `currentTenant()?.token`. A read-only token could therefore mint
 * a render-scoped one and start spending: the read-only guarantee undone in
 * one request, by the credential /connect hands to third parties precisely
 * because it "cannot bill". `requireSession()` asks the question the
 * paragraph meant.
 */

export const GET = withTenant(async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to manage tokens" }, { status: 401 });
  await ready();
  /* A credit workspace reads each token's month in credits billed, never the vendor's dollars (see /api/analytics). */
  const inCredits = creditsApply(requireTenant());

  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);

  const rs = await db().execute({
    sql: `SELECT t.id, t.name, t.scope, t.cap_usd, t.last_used, t.created_at,
                 COALESCE((SELECT SUM(${inCredits ? billedCreditsExpr("g") : "COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0)"})
                           FROM generations g
                           WHERE g.token_id = t.id AND g.created_at >= ?), 0) AS spend
          FROM api_tokens t
          WHERE t.user_id = ? AND t.revoked_at IS NULL
          ORDER BY t.created_at DESC`,
    args: [start.getTime(), user.id],
  });

  return NextResponse.json({
    unit: inCredits ? "cr" : "usd",
    tokens: rs.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
      /** In `unit`. The ceiling is still set and enforced in dollars. */
      spendThisMonth: Number(r.spend),
      lastUsed: r.last_used == null ? null : Number(r.last_used),
      createdAt: Number(r.created_at),
    })),
  });
});

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireSession();
  if (got.response) return got.response;
  const user = got.user;
  await ready();

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().slice(0, 60);
  if (!name) return NextResponse.json({ error: "Give the token a name" }, { status: 400 });

  const scope: TokenScope = body.scope === "read" ? "read" : "render";
  /* Absent or blank is "no limit"; any other value must be dollars above zero.
     A value that is not one used to be stored as no limit — an uncapped
     spending token from a typo. */
  const ceiling = body.capUsd == null || body.capUsd === "" ? { capUsd: null } : parseCeiling(String(body.capUsd));
  if ("error" in ceiling) return NextResponse.json({ error: ceiling.error }, { status: 400 });
  const capUsd = ceiling.capUsd;

  const secret = mintTokenSecret();
  const tid = id("tok");
  await db().batch([{
    sql: `INSERT INTO api_tokens (id, token_hash, name, user_id, scope, cap_usd, created_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [tid, tokenHash(secret), name, user.id, scope, capUsd, now()],
  }, securityAuditStatement({workspaceId:requireTenant().id,actorId:user.id,action:"api_token.created",targetType:"api_token",targetId:tid,details:{scope}})], "write");

  // The only time the secret exists outside a hash. Shown once, never again.
  return NextResponse.json({ id: tid, name, scope, capUsd, token: secret });
}, { requireRequestScope: true });
