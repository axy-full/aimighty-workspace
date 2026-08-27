import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Deployment sanity check. Reports only whether things are configured and
 * WORKING — never a key, a URL or a token value.
 *
 * storage went from "is the env var set" to a live write+delete probe after
 * a hand-pasted token turned out to be the likeliest cause of upload
 * failures: presence of a credential proves nothing about its validity.
 */
export async function GET() {
  let database = "unreachable";
  let videosSaved = 0;
  let videosAtRisk = 0; // succeeded renders whose file never landed in our storage
  try {
    await ready();
    await db().execute("SELECT 1");
    database = process.env.TURSO_DATABASE_URL ? "turso" : "local-file";
    const rs = await db().execute(`
      SELECT SUM(CASE WHEN stored_url IS NOT NULL THEN 1 ELSE 0 END) AS saved,
             SUM(CASE WHEN stored_url IS NULL THEN 1 ELSE 0 END) AS atrisk
      FROM generations WHERE status='succeeded'`);
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r: any = rs.rows[0];
    videosSaved = Number(r?.saved ?? 0);
    videosAtRisk = Number(r?.atrisk ?? 0);
  } catch { /* leave as unreachable */ }

  // Live storage probe: write one tiny private object, then remove it.
  let storage = "local-disk";
  let storageError: string | null = null;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put, del } = await import("@vercel/blob");
      const probe = await put("health/probe.txt", `ok ${Date.now()}`, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      await del(probe.url);
      storage = "blob-private";
    } catch (e) {
      storage = "blob-BROKEN";
      // Error text only — a Blob error never contains the token itself.
      storageError = (e as Error).message.slice(0, 140);
    }
  }

  return NextResponse.json({
    ok: database !== "unreachable" && storage !== "blob-BROKEN",
    database,
    storage,
    ...(storageError ? { storageError } : {}),
    videosSaved,
    videosAtRisk,
    arkKeyConfigured: Boolean(process.env.ARK_API_KEY),
    geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
    pushConfigured: Boolean(
      process.env.VAPID_PRIVATE_KEY && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    ),
    region: process.env.VERCEL_REGION ?? "local",
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
  });
}
