/**
 * Workspace settings — the ones the whole team shares.
 *
 * localStorage prefs (lib/prefs.ts) seed one person's composer. These outlive
 * the browser: the filename protocol, the retention policy, how many times a
 * failed render is retried. Read on nearly every download, so they're memoed
 * for a few seconds rather than fetched per request.
 */
import { db, ready, now } from "@/lib/db";
import { memoGet, memoPut, memoDrop } from "@/lib/memo";

export const DEFAULTS = {
  /** R9 — the platform names the file, never the API. */
  namingTemplate: "{project}_{scene}_{shot}_{model}_v{version}_{user}",
  /** Days a soft-deleted render's media is kept before the janitor may remove it. */
  retentionDays: "0",
  /** How many times a transient provider failure is retried before the row fails. */
  maxRetries: "2",
  /** Whether oversized masters may be sent to an API as a derived copy. */
  deriveForApi: "1",
  /** Cost approval rule: anyone renders, a cap per shot, or a producer approves. */
  /** The workspace's own mark, shown on a client review page (brief 2.6). */
  brandLogoUploadId: "",
  approvalRule: "anyone",
  /** With "cap": a shot may take this many credits before a member needs an admin to press (brief 2.2). */
  shotCapCredits: "50",
  /** Warn the producer when a production's spend reaches this share of its cap. */
  capWarnPct: "80",
  /** What happens at the cap: the producer unlocks, rendering stops, or a warning only. */
  atCap: "producer",
  /** The engine a new composer opens on, per kind; blank inherits the platform's default. */
  defaultVideoModel: "",
  defaultImageModel: "",
  /** Platform rule ids this workspace has switched off, comma-separated. */
  rulesOff: "",
  /**
   * Container for edits and extensions: "mp4" or "mov".
   *
   * ByteDance recommend mov — it preserves colour and audio-visual continuity
   * that an mp4 re-encode degrades. It is NOT the default because a QuickTime
   * container does not play reliably in Chrome, and every render here is
   * watched in a browser. Turning it on trades a playable library for that
   * continuity.
   */
  editOutputFormat: "mp4",
  /**
   * Who finishes a prompt too thin to film:
   *   "none"     — Pro: nothing is rewritten; the words go as written
   *   "byteplus" — Seedream: ByteDance's own text model on the ModelArk key
   *   "claude"   — Claude Opus 5, through Vercel AI Gateway (or a direct key)
   * The library's camera modules apply in every mode; this is only the model.
   */
  promptWriter: "claude",
} as const;

export type SettingKey = keyof typeof DEFAULTS;

const TTL = 10_000;

export function invalidateSettings(): void {
  memoDrop("settings");
}

export async function allSettings(): Promise<Record<string, string>> {
  const hit = memoGet<Record<string, string>>("settings", TTL);
  if (hit) return hit;
  await ready();
  const rs = await db().execute(`SELECT key, value FROM settings`);
  const out: Record<string, string> = { ...DEFAULTS };
  for (const r of rs.rows) {
    const row = r as unknown as { key: string; value: string };
    out[row.key] = row.value;
  }
  memoPut("settings", out);
  return out;
}

export async function getSetting(key: SettingKey): Promise<string> {
  return (await allSettings())[key] ?? DEFAULTS[key];
}

export async function setSetting(key: string, value: string, userId: string): Promise<void> {
  await ready();
  await db().execute({
    sql: `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,
            updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    args: [key, value, userId, now()],
  });
  invalidateSettings();
}
