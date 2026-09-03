import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
/* eslint-disable @typescript-eslint/no-explicit-any */

/** A demotion/disable only lands when another active admin would remain. */
const KEEP_ADMIN = `(SELECT COUNT(*) FROM users u2
  WHERE u2.role='admin' AND u2.disabled=0 AND u2.id != ?) >= 1`;

const LAST_ADMIN = { error: "That's the last admin — promote someone else first." };

/**
 * Enable/disable, change role, or clear a lockout. The last-admin guard lives
 * IN the SQL — a separate count check would let two concurrent demotions both
 * pass and leave the workspace with no admin at all.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const rs = await db().execute({ sql: `SELECT * FROM users WHERE id=? LIMIT 1`, args: [id] });
  const target = rs.rows[0] as any;
  if (!target || target.deleted_at) return NextResponse.json({ error: "No such user" }, { status: 404 });

  if (id === got.user.id && body.disabled === true) {
    return NextResponse.json({ error: "You can't disable your own account." }, { status: 400 });
  }

  if (body.role === "admin") {
    await db().execute({ sql: `UPDATE users SET role='admin' WHERE id=?`, args: [id] });
  } else if (body.role === "member") {
    const upd = await db().execute({
      sql: `UPDATE users SET role='member' WHERE id=? AND (role='member' OR ${KEEP_ADMIN})`,
      args: [id, id],
    });
    if (Number(upd.rowsAffected) === 0) {
      return NextResponse.json(LAST_ADMIN, { status: 400 });
    }
  }

  // Someone locked out by failed logins shouldn't have to wait it out.
  if (body.unlock === true || body.disabled === false) {
    await db().execute({
      sql: `UPDATE users SET failed_count=0, locked_until=NULL WHERE id=?`, args: [id],
    });
  }

  if (body.disabled === true) {
    const upd = await db().execute({
      sql: `UPDATE users SET disabled=1 WHERE id=? AND (role='member' OR ${KEEP_ADMIN})`,
      args: [id, id],
    });
    if (Number(upd.rowsAffected) === 0) {
      return NextResponse.json(LAST_ADMIN, { status: 400 });
    }
    // Disabling someone kicks them out immediately.
    await db().execute({ sql: `DELETE FROM sessions WHERE user_id=?`, args: [id] });
  } else if (body.disabled === false) {
    await db().execute({ sql: `UPDATE users SET disabled=0 WHERE id=?`, args: [id] });
  }

  return NextResponse.json({ ok: true });
}

/**
 * Delete a member.
 *
 * What a studio needs from "delete" is that the person is gone: no sign-in,
 * no API tokens, no notifications, no unused invites they sent, and no
 * entry on any list. What it must NOT lose is the ledger — every render
 * and every dollar stays attributed to them by name. So the account is
 * retired rather than erased: disabled, stamped with the time, its email
 * rewritten so the address can be invited again. The last-admin guard is
 * the same one the demotion path uses, and lives in the SQL for the same
 * reason.
 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();

  const { id } = await params;
  if (id === got.user.id) {
    return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  }
  const rs = await db().execute({ sql: `SELECT * FROM users WHERE id=? LIMIT 1`, args: [id] });
  const target = rs.rows[0] as any;
  if (!target || target.deleted_at) return NextResponse.json({ error: "No such user" }, { status: 404 });

  const ts = now();
  const upd = await db().execute({
    sql: `UPDATE users
          SET disabled=1, deleted_at=?, email=?, failed_count=0, locked_until=NULL
          WHERE id=? AND deleted_at IS NULL AND (role='member' OR ${KEEP_ADMIN})`,
    args: [ts, `${target.email}#deleted-${ts}`, id, id],
  });
  if (Number(upd.rowsAffected) === 0) {
    return NextResponse.json(LAST_ADMIN, { status: 400 });
  }

  await Promise.all([
    db().execute({ sql: `DELETE FROM sessions WHERE user_id=?`, args: [id] }),
    db().execute({ sql: `UPDATE api_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, args: [ts, id] }),
    db().execute({ sql: `DELETE FROM push_subs WHERE user_id=?`, args: [id] }),
    db().execute({ sql: `DELETE FROM invites WHERE created_by=? AND used_at IS NULL`, args: [id] }),
  ]);

  return NextResponse.json({ ok: true, name: target.name });
}
