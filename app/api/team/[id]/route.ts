import { NextResponse } from "next/server";
import { requireAdmin, withTenant, isPlatformOwner, clearFailures } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformDb, platformReady, mirrorUser, now } from "@/lib/platform";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
/* eslint-disable @typescript-eslint/no-explicit-any */

const PROTECTED = { error: "That account owns the workspace. It can't be demoted, disabled or removed." };

async function member(wsId: string, accountId: string) {
  const rs = await platformDb().execute({
    sql: `SELECT a.id, a.email, a.name, m.role, m.disabled FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.workspace_id = ? AND m.account_id = ? AND a.deleted_at IS NULL LIMIT 1`,
    args: [wsId, accountId],
  });
  return (rs.rows[0] as any) ?? null;
}

/** Change standing, disable or re-enable, or clear a lockout — within this workspace. */
export const PATCH = withTenant(async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const target = await member(ws.id, id);
  if (!target) return NextResponse.json({ error: "No such member" }, { status: 404 });
  const owner = got.user.owner || (await isPlatformOwner(got.user));

  if (body.role !== undefined && !owner) {
    return NextResponse.json({ error: "Only the workspace owner can change what someone is." }, { status: 403 });
  }
  if (target.role === "owner") {
    const harmful = (body.role !== undefined && body.role !== "admin") || (body.disabled !== undefined && Boolean(body.disabled));
    if (harmful) return NextResponse.json(PROTECTED, { status: 400 });
  }
  if (id === got.user.id && body.disabled === true) {
    return NextResponse.json({ error: "You can't disable your own account." }, { status: 400 });
  }

  const p = platformDb();
  if ((body.role === "admin" || body.role === "member") && target.role !== "owner") {
    await p.execute({ sql: `UPDATE memberships SET role = ? WHERE workspace_id = ? AND account_id = ?`, args: [body.role, ws.id, id] });
    await mirrorUser(ws, { id: target.id, email: target.email, name: target.name }, body.role, Number(target.disabled) === 1);
  }
  if (body.unlock === true || body.disabled === false) await clearFailures(String(target.id));
  if (body.disabled === true) {
    await p.execute({ sql: `UPDATE memberships SET disabled = 1 WHERE workspace_id = ? AND account_id = ?`, args: [ws.id, id] });
    await mirrorUser(ws, { id: target.id, email: target.email, name: target.name }, target.role, true);
  } else if (body.disabled === false) {
    await p.execute({ sql: `UPDATE memberships SET disabled = 0 WHERE workspace_id = ? AND account_id = ?`, args: [ws.id, id] });
    await mirrorUser(ws, { id: target.id, email: target.email, name: target.name }, target.role, false);
  }
  return NextResponse.json({ ok: true });
});

/**
 * Remove someone from this workspace. Their account lives on — they may
 * belong to other workspaces — and their renders here keep their name.
 */
export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const { id } = await params;
  if (id === got.user.id) return NextResponse.json({ error: "You can't remove yourself." }, { status: 400 });
  const target = await member(ws.id, id);
  if (!target) return NextResponse.json({ error: "No such member" }, { status: 404 });
  if (target.role === "owner") return NextResponse.json(PROTECTED, { status: 400 });
  const p = platformDb();
  await p.execute({ sql: `DELETE FROM memberships WHERE workspace_id = ? AND account_id = ?`, args: [ws.id, id] });
  await p.execute({ sql: `DELETE FROM p_sessions WHERE account_id = ? AND workspace_id = ?`, args: [id, ws.id] });
  await mirrorUser(ws, { id: target.id, email: target.email, name: target.name }, "member", true);
  const { db } = await import("@/lib/db");
  await db().execute({ sql: `UPDATE users SET deleted_at = ? WHERE id = ?`, args: [now(), id] });
  await db().execute({ sql: `UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, args: [now(), id] });
  return NextResponse.json({ ok: true, name: target.name });
});
