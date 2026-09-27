import { tokenCreditUsage } from "@/lib/tokenUsage";
import { securityAuditStatement } from "@/lib/securityAudit";
import { requireTenant } from "@/lib/tenant";
import { parseCeiling } from "@/lib/tokenCeiling";
import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
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
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);

  const totals = await tokenCreditUsage(start.getTime());
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

  const scope: TokenScope = body.scope === "read" ? "read" : "render";
  if (body.capUsd != null) return NextResponse.json({ error: "Set a monthly ceiling in Particl credits." }, { status: 400 });
  const ceiling = body.capCredits == null ? { capCredits: null } : parseCeiling(String(body.capCredits));
  if ("error" in ceiling) return NextResponse.json({ error: ceiling.error }, { status: 400 });
  const capCredits = ceiling.capCredits;

  const secret = mintTokenSecret();
  const tid = id("tok");
  await db().batch([{
    sql: `INSERT INTO api_tokens (id, token_hash, name, user_id, scope, cap_credits, created_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [tid, tokenHash(secret), name, user.id, scope, capCredits, now()],
  }, securityAuditStatement({workspaceId:requireTenant().id,actorId:user.id,action:"api_token.created",targetType:"api_token",targetId:tid,details:{scope}})], "write");

  // The only time the secret exists outside a hash. Shown once, never again.
  return NextResponse.json({ id: tid, name, scope, capCredits, token: secret });
}, { requireRequestScope: true });
