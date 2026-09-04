import { NextResponse } from "next/server";
import { PROVIDERS, providerConfigured } from "@/lib/providers";
import { allSettings } from "@/lib/settings";
import { db, ready } from "@/lib/db";
import { presignedReadUrl } from "@/lib/storage";

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
export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";
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

  /* Deep probe (?deep=1): the playback path itself. Media is served by
     redirecting to a presigned private-blob URL, so what actually matters is
     whether THAT url answers a Range request the way iOS Safari demands —
     a 206 with a Content-Range. Presign, ask for two bytes, report, clean up. */
  let presignRange: string | null = null;
  if (deep && process.env.BLOB_READ_WRITE_TOKEN) {
    const probePath = "health/range-probe.bin";
    try {
      const { put, del } = await import("@vercel/blob");
      const probe = await put(probePath, Buffer.from("0123456789"), {
        access: "private", contentType: "application/octet-stream",
        addRandomSuffix: false, allowOverwrite: true,
      });
      const signed = await presignedReadUrl(probePath, 1);
      const r = await fetch(signed, { headers: { Range: "bytes=0-1" }, cache: "no-store" });
      presignRange = `${r.status} ${r.headers.get("content-range") ?? "no-content-range"} ` +
                     `accept-ranges=${r.headers.get("accept-ranges") ?? "-"}`;
      await del(probe.url);
    } catch (e) {
      presignRange = `ERROR ${(e as Error).message.slice(0, 160)}`;
    }
  }

  return NextResponse.json({
    ok: database !== "unreachable" && storage !== "blob-BROKEN",
    database,
    storage,
    ...(storageError ? { storageError } : {}),
    ...(presignRange ? { presignRange } : {}),
    videosSaved,
    videosAtRisk,
    providers: PROVIDERS.map((p) => ({ id: p.id, configured: providerConfigured(p) })),
    // Reads the settings table, so during a database outage it throws — and
    // the one endpoint whose job is to SAY "database unreachable" would 500
    // instead of answering. Its absence is itself the signal.
    cron: await cronStatus().catch(() => null),
    arkKeyConfigured: Boolean(process.env.ARK_API_KEY),
    pushConfigured: Boolean(
      process.env.VAPID_PRIVATE_KEY && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    ),
    region: process.env.VERCEL_REGION ?? "local",
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
  });
}


/**
 * When the cron last ran, who ran it, and whether that is recent enough.
 * The schedule is every 10 minutes; anything past 15 means a tick was missed.
 */
async function cronStatus() {
  const st = await allSettings();
  const at = Number(st.lastCronAt ?? 0);
  if (!at) return { lastRunAt: null, by: null, agoMinutes: null, healthy: null,
                    note: "no run recorded yet — instrumentation is new" };
  const ago = Math.round((Date.now() - at) / 60000);
  let result: unknown = null;
  try { result = JSON.parse(st.lastCronResult ?? "null"); } catch { /* ignore */ }
  return { lastRunAt: new Date(at).toISOString(), by: st.lastCronBy ?? null,
           agent: st.lastCronAgent ?? null,
           agoMinutes: ago, healthy: ago <= 15, result };
}
