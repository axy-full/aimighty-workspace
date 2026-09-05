import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Marks the channel read up to now — clears the unread badge. */
export const POST = withTenant(async function POST() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  await db().execute({
    sql: `INSERT INTO chat_reads (user_id, last_read_at) VALUES (?,?)
          ON CONFLICT(user_id) DO UPDATE SET last_read_at=excluded.last_read_at`,
    args: [got.user.id, now()],
  });
  return NextResponse.json({ ok: true });
});
