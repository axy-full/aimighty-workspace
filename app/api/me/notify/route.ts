import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { db, ready } from "@/lib/db";
import { cleanPrefs, NOTIFY_KINDS, type NotifyKind } from "@/lib/notifyPrefs";

export const dynamic = "force-dynamic";

/** What this person wants to be told about, here (brief 2.7). Theirs alone: no one sets another's. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const rs = await db().execute({ sql: `SELECT notify FROM users WHERE id = ? LIMIT 1`, args: [got.user.id] });
  const raw = rs.rows.length ? (rs.rows[0] as { notify?: string | null }).notify : null;
  const prefs = cleanPrefs(((): unknown => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })());
  return NextResponse.json({ prefs, role: got.user.role });
});

export const PATCH = withTenant(async function PATCH(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const kind = String(body.kind ?? "") as NotifyKind;
  if (!NOTIFY_KINDS.includes(kind)) return NextResponse.json({ error: "No such notification." }, { status: 400 });
  await ready();
  const rs = await db().execute({ sql: `SELECT notify FROM users WHERE id = ? LIMIT 1`, args: [got.user.id] });
  const raw = rs.rows.length ? (rs.rows[0] as { notify?: string | null }).notify : null;
  const prefs = cleanPrefs(((): unknown => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })());
  prefs[kind] = Boolean(body.on);
  await db().execute({ sql: `UPDATE users SET notify = ? WHERE id = ?`, args: [JSON.stringify(prefs), got.user.id] });
  return NextResponse.json({ prefs });
}, { requireRequestScope: true });
