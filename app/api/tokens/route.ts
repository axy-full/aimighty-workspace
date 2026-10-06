import { tokenCreditUsage } from "@/lib/tokenUsage";
import { securityAuditStatement } from "@/lib/securityAudit";
import { requireTenant } from "@/lib/tenant";
import { tokenCeiling } from "@/lib/tokenCeiling";
import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { creditsApply } from "@/lib/credits";
import { tokenMonthStart } from "@/lib/cycle";
import {
  requireSession, mintTokenSecret, tokenHash, type TokenScope, withTenant } from "@/lib/auth";

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
 * The unit. A credit workspace (the platform's keys) reads each token's month
 * in the credits its takes were billed, never the vendor's dollars behind them
 * (see /api/analytics), and sets its ceiling in credits: the reply carries no
 * dollar figure at all. `legacyCeiling` says a dollar ceiling set before
 * credits still applies (the spend gate enforces it without naming the
 * figure). The house workspace (lib/houseWorkspace.ts), never billed in
 * credits, reads and caps in the engines' dollars, as its spend gate counts
 * them (tokenSpendThisMonth); no other workspace is sent a dollar figure.
 */
export const GET = withTenant(async function GET() {
  const got = await requireSession();
  if (got.response) return got.response;
  const user = got.user;
  await ready();
  if (!creditsApply(requireTenant())) {
    const rs = await db().execute({
      sql: `SELECT t.id, t.name, t.scope, t.cap_usd, t.last_used, t.created_at,
                   COALESCE((SELECT SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0))
                             FROM generations g WHERE g.token_id = t.id AND g.created_at >= ?), 0) AS spend
            FROM api_tokens t WHERE t.user_id = ? AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
      args: [tokenMonthStart(), user.id],
    });
    return NextResponse.json({
      unit: "usd",
      tokens: rs.rows.map((r: any) => ({
        id: r.id, name: r.name, scope: r.scope,
        /** In dollars, like `capUsd`. */
        spendThisMonth: Number(r.spend),
        capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
        lastUsed: r.last_used == null ? null : Number(r.last_used),
        createdAt: Number(r.created_at),
      })),
    });
  }
  /* The token's month runs on the same boundary its ceiling is enforced on (lib/cycle.ts), and counts
     every token-funded operation, reservations included (lib/tokenUsage.ts), in credits. */
  const totals = await tokenCreditUsage(tokenMonthStart());
  const rs = await db().execute({
    sql: "SELECT id,name,scope,cap_usd,cap_credits,last_used,created_at FROM api_tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC",
    args: [user.id],
  });

  return NextResponse.json({
    unit: "cr",
    tokens: rs.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      capCredits: r.cap_credits == null ? null : Number(r.cap_credits),
      legacyCeiling: r.cap_usd != null,
      /** Actual recorded credits, including reservations. */
      spendThisMonth: totals.get(String(r.id)) ?? 0,
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

  /* A token made here is read-only or prepares jobs (Gaps B); "render" is accepted from the older pages and the
     CLI, as before. Only the word itself grants spending. */
  const scope: TokenScope = body.scope === "read" ? "read" : body.scope === "prepare" ? "prepare" : "render";
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
