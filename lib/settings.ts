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
   * The workspace's Setup (brief 2.3), as a JSON ShotSpec.
   *
   * It lived in `localStorage["aw_setup_all"]` — not in any database, and
   * NOT KEYED BY WORKSPACE, so it followed you across a workspace switch and
   * one workspace's defaults quietly applied in another. Being a setting
   * makes it what it always claimed to be: the workspace's, shared by the
   * team, and scoped by the database it lives in.
   */
  setup: "{}",
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
  /**
   * Who rewrites a prompt when someone presses Enhance in Gen (Workspace ›
   * General): "higgsfield" | "claude" | "openai" — lib/shell/enhancer.ts.
   * Higgsfield is the owner's default (21 September 2026). Separate from
   * promptWriter, which is the legacy inline refine inside a render.
   */
  promptEnhancer: "higgsfield",
  /**
   * When this workspace's cast was mirrored into Rig's elements (brief 3).
   *
   * Blank means it has not happened, and the first read of the element
   * library is what does it. It is a marker rather than a schema version
   * because the work is a one-off read of rows that already existed, not a
   * migration anything is waiting on.
   */
  rigBackfilledAt: "",
  /* design/particl-v2 §13 · Engines & rates: the model ids Atomik may NOT propose, as a JSON array. Empty means every engine. */
  atomikEngines: "[]",
  /* §13 · Rig & locks: a new asset starts locked ("1") or open ("0"). */
  lockNewAssets: "0",
  /* §13 · Rig & locks · Train on create: "ask" (the switch, off), "always" (the switch, on), "never" (no switch). */
  trainOnCreate: "ask",
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
