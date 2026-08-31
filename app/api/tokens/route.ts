import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import {
  currentUser, mintTokenSecret, tokenHash, type TokenScope,
} from "@/lib/auth";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * API tokens — how the CLI and the MCP server get in.
 *
 * Deliberately session-only: a token may never mint another token, so a
 * leaked one can't quietly breed replacements or widen its own scope. You
 * make these while signed in, in Settings.
 */

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to manage tokens" }, { status: 401 });
  await ready();

  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);

  const rs = await db().execute({
    sql: `SELECT t.id, t.name, t.scope, t.cap_usd, t.last_used, t.created_at,
                 COALESCE((SELECT SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0))
                           FROM generations g
                           WHERE g.token_id = t.id AND g.created_at >= ?), 0) AS spend
          FROM api_tokens t
          WHERE t.user_id = ? AND t.revoked_at IS NULL
          ORDER BY t.created_at DESC`,
    args: [start.getTime(), user.id],
  });

  return NextResponse.json({
    tokens: rs.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
      spendThisMonth: Number(r.spend),
      lastUsed: r.last_used == null ? null : Number(r.last_used),
      createdAt: Number(r.created_at),
    })),
  });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to create a token" }, { status: 401 });
  await ready();

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().slice(0, 60);
  if (!name) return NextResponse.json({ error: "Give the token a name" }, { status: 400 });

  const scope: TokenScope = body.scope === "read" ? "read" : "render";
  const capRaw = Number(body.capUsd);
  const capUsd = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : null;

  const secret = mintTokenSecret();
  const tid = id("tok");
  await db().execute({
    sql: `INSERT INTO api_tokens (id, token_hash, name, user_id, scope, cap_usd, created_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [tid, tokenHash(secret), name, user.id, scope, capUsd, now()],
  });

  // The only time the secret exists outside a hash. Shown once, never again.
  return NextResponse.json({ id: tid, name, scope, capUsd, token: secret });
}
