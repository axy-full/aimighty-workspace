import type { Client } from "@libsql/client";
import { db, now } from "./db";
import { platformDb, platformReady, SUPER_ADMIN_EMAIL } from "./platform";
import { requireTenant } from "./tenant";
import { KEY_CHANGED } from "./higgsfield";
import { mailConfigured, sendMail } from "./mail";

/**
 * A take whose provider key is gone.
 *
 * Every Higgsfield job is pinned, when it is sent, to the one-way fingerprint
 * of the key it was sent on, and it is collected and settled with exactly
 * that key (lib/higgsfield.ts higgsfieldCollectionCredentials): the current
 * key, a previous platform key kept for collection, or the current key where
 * the operator has said the old one was the same provider organization. When
 * none of those holds, nothing is asked of the provider. The take is not
 * failed, refunded or sent again: it waits, saying "The provider key
 * changed; checking with the provider.", and the platform's admin is alerted
 * once, with what to do. When the key comes back the take is collected as if
 * nothing happened; a still still waiting after KEY_GONE_MS is ended with its
 * charge kept (lib/jobs.ts), because by then the provider's copy is gone too.
 */

/** Past this, the provider no longer keeps what it made (outputs stay at least seven days). */
export const KEY_GONE_MS = 7 * 24 * 60 * 60_000;
/** The end of a still that waited out KEY_GONE_MS. The request was accepted, so its charge is kept. */
export const KEY_GONE_END =
  "The provider key this request was sent on never came back, so its result could not be collected. Its cost stays charged; it will not be sent again.";

const boot = new WeakMap<Client, Promise<void>>();
async function keyAlertsReady(): Promise<void> {
  await platformReady();
  const client = platformDb();
  if (!boot.has(client))
    boot.set(client, client.execute(`CREATE TABLE IF NOT EXISTS provider_key_alerts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key_prefix TEXT NOT NULL,
      first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, resolved_at INTEGER
    )`).then(() => undefined).catch((error) => { boot.delete(client); throw error; }));
  await boot.get(client);
}

/** How the desk names a key: the first 12 characters of its one-way fingerprint. Never the key itself. */
export const keyPrefix = (fingerprint: string | undefined | null) =>
  typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint.slice(0, 12) : "unknown";

/**
 * Collection found the take's key gone. The take keeps waiting: its words say
 * so, a failing-collection count it may have had is ended (the provider was
 * never asked, so nothing failed), and the platform's admin hears of it once.
 */
export async function markKeyChanged(id: string, fingerprint: string | undefined): Promise<void> {
  const at = now();
  await db().execute({
    sql: `UPDATE generations SET error=?, updated_at=?,
            params=json_remove(json_set(params,'$.providerKeyChanged',COALESCE(json_extract(params,'$.providerKeyChanged'),?)),'$.higgsfieldStillCollection')
          WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
    args: [KEY_CHANGED, at, at, id],
  });
  await keyAlertsReady();
  const workspaceId = requireTenant().id;
  const prior = (await platformDb().execute({
    sql: "SELECT resolved_at FROM provider_key_alerts WHERE id=? AND workspace_id=?", args: [id, workspaceId],
  })).rows[0];
  /* An alert already open only notes the latest check; one opened (or opened again) starts from now. */
  await platformDb().execute({
    sql: `INSERT INTO provider_key_alerts(id, workspace_id, key_prefix, first_at, last_at) VALUES(?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at, resolved_at=NULL,
            first_at=CASE WHEN provider_key_alerts.resolved_at IS NULL THEN provider_key_alerts.first_at ELSE excluded.first_at END
          WHERE provider_key_alerts.workspace_id=excluded.workspace_id`,
    args: [id, workspaceId, keyPrefix(fingerprint), at, at],
  });
  if (prior && prior.resolved_at == null) return;
  /* The first take of an episode: tell the platform's owner once, not for every take that follows. */
  const open = Number((await platformDb().execute("SELECT COUNT(*) AS n FROM provider_key_alerts WHERE resolved_at IS NULL")).rows[0]?.n ?? 0);
  if (open !== 1 || !mailConfigured() || !SUPER_ADMIN_EMAIL) return;
  const body = `A take was sent on a provider key that is no longer configured (key ${keyPrefix(fingerprint)}…), so its result cannot be collected yet. Nothing was failed, refunded or sent again. Keep the old key under HF_CREDENTIALS_PREVIOUS, or, if it belonged to the same provider organization, add that key's fingerprint to HF_CREDENTIAL_ALIASES. The platform desk lists every take waiting.`;
  await sendMail({ to: SUPER_ADMIN_EMAIL, subject: "Particl: takes are waiting on a provider key that changed", text: body, html: `<p>${body}</p>` }).catch(() => {});
}

/** The take's key answered again (or the take ended): its wait, and its alert, are over. */
export async function clearKeyChanged(id: string): Promise<void> {
  await db().execute({
    sql: "UPDATE generations SET params=json_remove(params,'$.providerKeyChanged') WHERE id=? AND json_extract(params,'$.providerKeyChanged') IS NOT NULL",
    args: [id],
  });
  await keyAlertsReady();
  await platformDb().execute({
    sql: "UPDATE provider_key_alerts SET resolved_at=? WHERE id=? AND workspace_id=? AND resolved_at IS NULL",
    args: [now(), id, requireTenant().id],
  });
}

export type KeyAlert = { id: string; workspaceId: string; keyPrefix: string; firstAt: number; lastAt: number };

/** Takes waiting on a key that is gone, for the platform desk: newest first. */
export async function openKeyAlerts(limit = 50): Promise<KeyAlert[]> {
  await keyAlertsReady();
  const rs = await platformDb().execute({
    sql: "SELECT id, workspace_id, key_prefix, first_at, last_at FROM provider_key_alerts WHERE resolved_at IS NULL ORDER BY last_at DESC, id LIMIT ?",
    args: [Math.max(1, Math.min(200, limit))],
  });
  return rs.rows.map((r) => ({ id: String(r.id), workspaceId: String(r.workspace_id), keyPrefix: String(r.key_prefix), firstAt: Number(r.first_at), lastAt: Number(r.last_at) }));
}
