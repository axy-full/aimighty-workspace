import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { sendChatPush } from "@/lib/push";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const PAGE = 80;

/**
 * One team-wide channel, Slack-shaped: newest-last messages, @mentions, and
 * attachments that ride the same byte-identical upload pipeline as
 * references. Polling, not sockets — six people, and the whole app already
 * heartbeats on short intervals.
 */
export async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  const url = new URL(req.url);
  const countOnly = url.searchParams.get("count") === "1";
  const after = Number(url.searchParams.get("after") ?? 0);
  const before = Number(url.searchParams.get("before") ?? 0);

  const where = after > 0 ? "WHERE m.created_at > ?" : before > 0 ? "WHERE m.created_at < ?" : "";
  const args: any[] = after > 0 ? [after] : before > 0 ? [before] : [];

  const rs = countOnly ? { rows: [] as any[] } : await db().execute({
    sql: `SELECT m.*, u.name AS author,
                 up.filename AS att_name, up.bytes AS att_bytes,
                 up.kind AS att_kind, up.mime AS att_mime, up.sha256 AS att_sha
          FROM messages m
          JOIN users u ON u.id = m.user_id
          LEFT JOIN uploads up ON up.id = m.upload_id
          ${where}
          ORDER BY m.created_at DESC LIMIT ${PAGE}`,
    args,
  });

  const meRead = await db().execute({
    sql: `SELECT last_read_at FROM chat_reads WHERE user_id = ?`,
    args: [got.user.id],
  });
  const lastRead = Number((meRead.rows[0] as any)?.last_read_at ?? 0);

  const unread = await db().execute({
    sql: `SELECT COUNT(*) AS n,
                 SUM(CASE WHEN instr(mentions, ?) > 0 THEN 1 ELSE 0 END) AS mentioned
          FROM messages WHERE created_at > ? AND user_id != ?`,
    args: [got.user.id, lastRead, got.user.id],
  });
  const u: any = unread.rows[0];

  return NextResponse.json({
    messages: rs.rows.reverse().map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      author: r.author,
      text: r.text,
      mentions: JSON.parse(r.mentions || "[]"),
      createdAt: Number(r.created_at),
      attachment: r.upload_id
        ? {
            id: r.upload_id, name: r.att_name, bytes: Number(r.att_bytes),
            kind: r.att_kind, mime: r.att_mime, sha256: r.att_sha,
            url: `/api/uploads/${r.upload_id}`,
          }
        : null,
    })),
    unread: Number(u?.n ?? 0),
    mentioned: Number(u?.mentioned ?? 0),
    me: got.user.id,
  });
}

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim().slice(0, 4000);
  const uploadId = body.uploadId ? String(body.uploadId) : null;

  if (!text && !uploadId) {
    return NextResponse.json({ error: "Say something or attach a file" }, { status: 400 });
  }

  if (uploadId) {
    const up = await db().execute({ sql: `SELECT id FROM uploads WHERE id=? LIMIT 1`, args: [uploadId] });
    if (!up.rows[0]) return NextResponse.json({ error: "That attachment is gone" }, { status: 400 });
  }

  // Mentions come as ids from the composer's autocomplete, but only ids that
  // belong to real, active users survive — the client's list is a suggestion.
  const claimed: string[] = Array.isArray(body.mentions)
    ? body.mentions.map(String).slice(0, 20)
    : [];
  let mentions: string[] = [];
  if (claimed.length) {
    const rs = await db().execute({
      sql: `SELECT id FROM users WHERE disabled=0 AND id IN (${claimed.map(() => "?").join(",")})`,
      args: claimed,
    });
    mentions = rs.rows.map((r: any) => String(r.id));
  }

  const mid = id("msg");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO messages (id, user_id, text, mentions, upload_id, created_at) VALUES (?,?,?,?,?,?)`,
    args: [mid, got.user.id, text, JSON.stringify(mentions), uploadId, ts],
  });

  // Banner on every teammate's device; never blocks the send.
  let attachmentName: string | null = null;
  if (uploadId) {
    const a = await db().execute({ sql: `SELECT filename FROM uploads WHERE id=?`, args: [uploadId] });
    attachmentName = (a.rows[0] as any)?.filename ?? null;
  }
  try {
    await sendChatPush({
      authorId: got.user.id, authorName: got.user.name,
      text, attachmentName, mentionIds: mentions,
    });
  } catch (e) {
    console.error("push dispatch failed:", (e as Error).message);
  }
  // Your own message never counts as unread for you.
  await db().execute({
    sql: `INSERT INTO chat_reads (user_id, last_read_at) VALUES (?,?)
          ON CONFLICT(user_id) DO UPDATE SET last_read_at=excluded.last_read_at`,
    args: [got.user.id, ts],
  });
  return NextResponse.json({ id: mid, createdAt: ts });
}
