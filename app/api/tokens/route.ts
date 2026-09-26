import { securityAuditStatement } from "@/lib/securityAudit";
import { requireTenant } from "@/lib/tenant";
import { tokenCeiling } from "@/lib/tokenCeiling";
import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import {
  currentUser, monthStart, requireSession, mintTokenSecret, tokenHash, type TokenScope, withTenant } from "@/lib/auth";
import { creditsApply } from "@/lib/credits";
import { billedCreditsSum } from "@/lib/creditSql";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * API tokens — how the CLI and the MCP server get in.
 *
 * Deliberately session-only: a token may never mint another token, so a
 * leaked one can't quietly breed replacements or widen its own scope. You
 * make these while signed in, in Atomik › Tools & connections (or /connect).
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

/*
 * The unit. A workspace on the platform's keys pays in credits, so its tokens
 * are read and capped in credits and the engine's dollars never leave the
 * server (§7A): the reply carries no dollar field at all. `legacyCeiling`
 * says a dollar ceiling set before credits still applies (admission enforces
 * it without naming the figure). A workspace on its own keys keeps dollars.
 */
export const GET = withTenant(async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to manage tokens" }, { status: 401 });
  await ready();
  const credits = creditsApply(requireTenant());
  const start = monthStart();

  const rs = await db().execute({
    sql: credits
      ? `SELECT t.id, t.name, t.scope, t.cap_usd, t.cap_credits, t.last_used, t.created_at,
                (SELECT ${billedCreditsSum("g")} FROM generations g
                  WHERE g.token_id = t.id AND g.created_at >= ?) AS spend
         FROM api_tokens t
         WHERE t.user_id = ? AND t.revoked_at IS NULL
         ORDER BY t.created_at DESC`
      : `SELECT t.id, t.name, t.scope, t.cap_usd, t.cap_credits, t.last_used, t.created_at,
                COALESCE((SELECT SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0))
                          FROM generations g
                          WHERE g.token_id = t.id AND g.created_at >= ?), 0) AS spend
         FROM api_tokens t
         WHERE t.user_id = ? AND t.revoked_at IS NULL
         ORDER BY t.created_at DESC`,
    args: [start, user.id],
  });

  return NextResponse.json({
    unit: credits ? "credits" : "usd",
    tokens: rs.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      ...(credits
        ? {
            capCredits: r.cap_credits == null ? null : Number(r.cap_credits),
            spendCredits: Number(r.spend ?? 0),
            legacyCeiling: r.cap_usd != null,
          }
        : {
            capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
            spendThisMonth: Number(r.spend ?? 0),
          }),
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
  /* The ceiling, in the workspace's unit (lib/tokenCeiling.ts). Absent or
     blank is "no limit"; any other value must read as a figure or nothing is
     made. A value that did not read used to be stored as no limit: an
     uncapped spending token from a typo. */
  const ceiling = tokenCeiling(body, { scope, inCredits: creditsApply(requireTenant()) });
  if ("error" in ceiling) return NextResponse.json({ error: ceiling.error }, { status: 400 });
  const { capUsd, capCredits } = ceiling;

  const secret = mintTokenSecret();
  const tid = id("tok");
  await db().batch([{
    sql: `INSERT INTO api_tokens (id, token_hash, name, user_id, scope, cap_usd, cap_credits, created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [tid, tokenHash(secret), name, user.id, scope, capUsd, capCredits, now()],
  }, securityAuditStatement({workspaceId:requireTenant().id,actorId:user.id,action:"api_token.created",targetType:"api_token",targetId:tid,details:{scope}})], "write");

  // The only time the secret exists outside a hash. Shown once, never again.
  return NextResponse.json({ id: tid, name, scope, capUsd, capCredits, token: secret });
}, { requireRequestScope: true });
