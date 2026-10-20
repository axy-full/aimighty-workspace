import { tokenCreditUsage } from "@/lib/tokenUsage";
import { securityAuditStatement } from "@/lib/securityAudit";
import { requireTenant } from "@/lib/tenant";
import { tokenCeiling } from "@/lib/tokenCeiling";
import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { creditsApply } from "@/lib/credits";
import { grantPrepareStatement, preparing } from "@/lib/security/token-grants";
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
/** The scope as this build reads it: the stored word, with a prepare grant read beside a "read" row. */
const scopeOf = (r: any, prep: Set<string>) => (r.scope === "render" ? "render" : r.scope === "read" && prep.has(String(r.id)) ? "prepare" : "read");

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
    const prep = await preparing(rs.rows.map((r: any) => String(r.id)));
    const others = user.role === "admin" ? (await db().execute({
      sql: `SELECT t.id, t.name, t.cap_usd, t.last_used, t.created_at, u.name AS owner_name,
                   COALESCE((SELECT SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0))
                             FROM generations g WHERE g.token_id = t.id AND g.created_at >= ?), 0) AS spend
            FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
            WHERE t.user_id <> ? AND t.scope = 'render' AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
      args: [tokenMonthStart(), user.id],
    })).rows : null;
    return NextResponse.json({
      unit: "usd",
      tokens: rs.rows.map((r: any) => ({
        id: r.id, name: r.name, scope: scopeOf(r, prep),
        /** In dollars, like `capUsd`. */
        spendThisMonth: Number(r.spend),
        capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
        lastUsed: r.last_used == null ? null : Number(r.last_used),
        createdAt: Number(r.created_at),
      })),
      ...(others ? { others: others.map((r: any) => ({
        id: r.id, name: r.name, scope: "render", owner: r.owner_name == null ? null : String(r.owner_name),
        spendThisMonth: Number(r.spend), capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
        lastUsed: r.last_used == null ? null : Number(r.last_used), createdAt: Number(r.created_at),
      })) } : {}),
    });
  }
  /* The token's month runs on the same boundary its ceiling is enforced on (lib/cycle.ts), and counts
     every token-funded operation, reservations included (lib/tokenUsage.ts), in credits. */
  const totals = await tokenCreditUsage(tokenMonthStart());
  const rs = await db().execute({
    sql: "SELECT id,name,scope,cap_usd,cap_credits,last_used,created_at FROM api_tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC",
    args: [user.id],
  });

  const prep = await preparing(rs.rows.map((r: any) => String(r.id)));
  /* An admin also sees the other members' tokens that can generate, to set their ceilings (PATCH /api/tokens/[id]/ceiling): a token
     with none only prepares and prices (lib/tokenSpend.ts). Read-only and prepare tokens spend nothing and are not listed; revoking
     stays the maker's. No secret is stored, so none can be shown. */
  const others = user.role === "admin" ? (await db().execute({
    sql: `SELECT t.id, t.name, t.cap_usd, t.cap_credits, t.last_used, t.created_at, u.name AS owner_name
          FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
          WHERE t.user_id <> ? AND t.scope = 'render' AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
    args: [user.id],
  })).rows : null;
  return NextResponse.json({
    ...(others ? { others: others.map((r: any) => ({
      id: r.id, name: r.name, scope: "render", owner: r.owner_name == null ? null : String(r.owner_name),
      capCredits: r.cap_credits == null ? null : Number(r.cap_credits), legacyCeiling: r.cap_usd != null,
      spendThisMonth: totals.get(String(r.id)) ?? 0,
      lastUsed: r.last_used == null ? null : Number(r.last_used), createdAt: Number(r.created_at),
    })) } : {}),
    unit: "cr",
    tokens: rs.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      scope: scopeOf(r, prep),
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

  /* A token made here is read-only or prepares jobs (Gaps B); "render" is accepted, as the word itself, from the
     older pages and the CLI. No scope, or one the server doesn't know, makes a read-only token: only the word
     itself grants spending, when a token is made as when it is read. */
  const scope: TokenScope = body.scope === "render" ? "render" : body.scope === "prepare" ? "prepare" : "read";
  /* The ceiling, in the workspace's unit (lib/tokenCeiling.ts). Absent or
     blank is "no limit"; any other value must read as a figure or nothing is
     made. A value that did not read used to be stored as no limit: an
     uncapped spending token from a typo. */
  const ceiling = tokenCeiling(body, { scope, inCredits: creditsApply(requireTenant()) });
  if ("error" in ceiling) return NextResponse.json({ error: ceiling.error }, { status: 400 });
  const { capUsd, capCredits } = ceiling;
  /* An admin sets a token's ceiling (owner, 20 Oct 2026, Q1 "B"): the ceiling is the standing approval a token spends under. A member
     makes a token that can generate without one (it only prepares and prices, lib/tokenSpend.ts) and an admin sets it after
     (PATCH /api/tokens/[id]/ceiling). Nothing is made when a member names one. A token never reaches here (requireSession). */
  if ((capUsd != null || capCredits != null) && got.user.role !== "admin")
    return NextResponse.json({ error: "Only an admin sets a token's monthly ceiling. Make the token without one, and ask an admin to set it." }, { status: 403 });

  const secret = mintTokenSecret();
  const tid = id("tok");
  await db().batch([{
    sql: `INSERT INTO api_tokens (id, token_hash, name, user_id, scope, cap_usd, cap_credits, created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    /* A prepare token is stored "read", its grant beside it in the same transaction (lib/security/token-grants.ts):
       a build that doesn't know the grant reads a read-only token, never a spending one. */
    args: [tid, tokenHash(secret), name, user.id, scope === "prepare" ? "read" : scope, capUsd, capCredits, now()],
  }, ...(scope === "prepare" ? [grantPrepareStatement(tid)] : []), securityAuditStatement({workspaceId:requireTenant().id,actorId:user.id,action:"api_token.created",targetType:"api_token",targetId:tid,details:{scope}})], "write");

  // The only time the secret exists outside a hash. Shown once, never again.
  return NextResponse.json({ id: tid, name, scope, capUsd, capCredits, token: secret });
}, { requireRequestScope: true });
