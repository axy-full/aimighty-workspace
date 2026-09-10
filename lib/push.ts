import { db, ready, now } from "./db";
import { wants, type NotifyKind } from "./notifyPrefs";

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

/**
 * The push services a browser can actually hand out an endpoint for.
 *
 * A stored endpoint is a URL this server POSTs to on its own initiative,
 * for as long as the row exists — an outbound request primitive with a
 * scheduler attached. The route checked only that it began `https://`, so
 * any host would do, including one inside a private network.
 *
 * An allowlist rather than a private-range blocklist: DNS can be pointed
 * anywhere after the check, and rebinding beats every blocklist eventually.
 * These four are who issues push endpoints; a fifth browser is a one-line
 * change, made deliberately.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com",          // Chrome, Edge, and everything Chromium
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",   // Firefox
  "notify.windows.com",          // legacy Edge / WNS
  "web.push.apple.com",          // Safari
];

export function knownPushService(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
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
    process.env.VAPID_SUBJECT ?? "mailto:support@particlstudio.com",
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

/** A banner to particular people — the owner and admins when renders are held. */
export async function sendPushTo(userIds: string[], payload: { title: string; body: string; url?: string }): Promise<void> {
  if (!configured() || !userIds.length) return;
  await ready();
  const rs = await db().execute({
    sql: `SELECT s.endpoint, s.p256dh, s.auth FROM push_subs s JOIN users u ON u.id = s.user_id
          WHERE u.disabled = 0 AND s.user_id IN (${userIds.map(() => "?").join(",")})`,
    args: userIds,
  });
  if (!rs.rows.length) return;
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:support@particlstudio.com",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
  const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url ?? "/" });
  await Promise.allSettled(
    rs.rows.map(async (r: any) => {
      try {
        await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, body, { TTL: 3600 });
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await removeSubscription(String(r.endpoint));
        else console.error("push failed:", e?.statusCode ?? e?.message);
      }
    })
  );
}

/**
 * Tell the people who asked to be told (brief 2.7): the same push as ever,
 * filtered by each person's own choice in this workspace. A kind marked
 * admin-only never reaches a member even if their row says otherwise.
 */
export async function notify(kind: NotifyKind, userIds: string[], payload: { title: string; body: string; url?: string }): Promise<void> {
  if (!userIds.length) return;
  await ready();
  const rs = await db().execute({
    sql: `SELECT id, role, notify FROM users WHERE id IN (${userIds.map(() => "?").join(",")}) AND disabled = 0 AND deleted_at IS NULL`,
    args: userIds,
  });
  const people = (rs.rows as unknown as { id: string; role: string; notify: string | null }[]).map((r) => ({
    id: String(r.id), role: String(r.role ?? "member"),
    prefs: ((): unknown => { try { return r.notify ? JSON.parse(r.notify) : null; } catch { return null; } })(),
  }));
  await sendPushTo(wants(kind, people), payload);
}
