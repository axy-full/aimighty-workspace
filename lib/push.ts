import { db, ready, now } from "./db";

/**
 * Web Push for chat. VAPID-signed sends straight to the browsers' push
 * services — no third-party notification vendor, nothing extra to pay for.
 *
 * Every active member except the author gets a banner; mentions get their
 * own wording. Subscriptions that the push service reports dead (404/410)
 * are pruned as we go.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function configured(): boolean {
  return Boolean(process.env.VAPID_PRIVATE_KEY && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
}

export async function saveSubscription(
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } }
): Promise<void> {
  await ready();
  await db().execute({
    sql: `INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at)
          VALUES (?,?,?,?,?)
          ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,
            p256dh=excluded.p256dh, auth=excluded.auth`,
    args: [sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, now()],
  });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await ready();
  await db().execute({ sql: `DELETE FROM push_subs WHERE endpoint=?`, args: [endpoint] });
}

export async function sendChatPush(opts: {
  authorId: string;
  authorName: string;
  text: string;
  attachmentName?: string | null;
  mentionIds: string[];
}): Promise<void> {
  if (!configured()) return;
  await ready();

  const rs = await db().execute({
    sql: `SELECT s.endpoint, s.p256dh, s.auth, s.user_id
          FROM push_subs s JOIN users u ON u.id = s.user_id
          WHERE u.disabled = 0 AND s.user_id != ?`,
    args: [opts.authorId],
  });
  if (!rs.rows.length) return;

  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:team@aimighty.studio",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );

  const mentioned = new Set(opts.mentionIds);
  const preview =
    (opts.text || "").slice(0, 140) ||
    (opts.attachmentName ? `📎 ${opts.attachmentName}` : "sent a file");

  await Promise.allSettled(
    rs.rows.map(async (r: any) => {
      const payload = JSON.stringify({
        title: mentioned.has(String(r.user_id))
          ? `${opts.authorName} mentioned you`
          : opts.authorName,
        body: preview,
        url: "/",
      });
      try {
        await webpush.sendNotification(
          { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
          payload,
          { TTL: 3600 }
        );
      } catch (e: any) {
        // Gone subscriptions are normal churn — clean them up quietly.
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await removeSubscription(String(r.endpoint));
        } else {
          console.error("push failed:", e?.statusCode ?? e?.message);
        }
      }
    })
  );
}
