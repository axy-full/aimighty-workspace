import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
/* eslint-disable @typescript-eslint/no-explicit-any */

async function adminCount(): Promise<number> {
  const rs = await db().execute(`SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0`);
  return Number((rs.rows[0] as any).n);
}

/** Enable/disable, or change role. Guards against removing the last admin. */
export async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const rs = await db().execute({ sql: `SELECT * FROM users WHERE id=? LIMIT 1`, args: [id] });
  const target = rs.rows[0] as any;
  if (!target) return NextResponse.json({ error: "No such user" }, { status: 404 });

  const losingAnAdmin =
    target.role === "admin" && !Number(target.disabled) &&
    (body.role === "member" || body.disabled === true);
  if (losingAnAdmin && (await adminCount()) <= 1) {
    return NextResponse.json({ error: "That's the last admin — promote someone else first." }, { status: 400 });
  }
  if (id === got.user.id && body.disabled === true) {
    return NextResponse.json({ error: "You can't disable your own account." }, { status: 400 });
  }

  if (body.role === "admin" || body.role === "member") {
    await db().execute({ sql: `UPDATE users SET role=? WHERE id=?`, args: [body.role, id] });
  }
  // Someone locked out by failed logins shouldn't have to wait it out.
  if (body.unlock === true || body.disabled === false) {
    await db().execute({
      sql: `UPDATE users SET failed_count=0, locked_until=NULL WHERE id=?`, args: [id],
    });
  }
  if (typeof body.disabled === "boolean") {
    await db().execute({
      sql: `UPDATE users SET disabled=? WHERE id=?`, args: [body.disabled ? 1 : 0, id],
    });
    // Disabling someone kicks them out immediately.
    if (body.disabled) {
      await db().execute({ sql: `DELETE FROM sessions WHERE user_id=?`, args: [id] });
    }
  }
  return NextResponse.json({ ok: true });
}
