import { NextResponse } from "next/server";
import { PROVIDERS, providerConfigured, providerVia } from "@/lib/providers";
import { currentContext } from "@/lib/auth";
import { runInTenant } from "@/lib/tenant";
import { platformDb, platformReady } from "@/lib/platform";
import { vendorKey } from "@/lib/vendorKeys";
import { allSettings } from "@/lib/settings";
import { db, ready } from "@/lib/db";
import { presignedReadUrl } from "@/lib/storage";
import { mailConfigured, mailFrom } from "@/lib/mail";

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
  /* Two answers from one route, because it has two audiences.
   *
   * An uptime monitor needs to know the app is alive and can reach its
   * database and its storage, and needs no credential to ask. Everything
   * else here is a fingerprint of the deployment — how many renders the
   * studio has, which vendor keys it holds, which door stills go through,
   * the address invitations are sent from, the commit it is running, and
   * the cron's last heartbeat. That was fine while nobody could find the
   * app; it is a briefing note now the front door is open.
   *
   * `deep` is stricter still: it WRITES to Vercel Blob, presigns, ranges
   * and deletes on every call, so anonymously it was an unauthenticated
   * lever on the studio's storage account. */
  const ctx = await currentContext();
  const full = Boolean(ctx?.workspace);
  const deep = full && new URL(req.url).searchParams.get("deep") === "1";
  let database = "unreachable";
  let videosSaved = 0;
  let videosAtRisk = 0; // succeeded renders whose file never landed in our storage
  try {
    await platformReady();
    await platformDb().execute("SELECT 1");
    database = process.env.TURSO_DATABASE_URL ? "turso" : "local-file";
    if (ctx?.workspace) {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const r: any = await runInTenant(ctx.workspace, async () => {
        await ready();
        const rs = await db().execute(`
          SELECT SUM(CASE WHEN stored_url IS NOT NULL THEN 1 ELSE 0 END) AS saved,
                 SUM(CASE WHEN stored_url IS NULL THEN 1 ELSE 0 END) AS atrisk
          FROM generations WHERE status='succeeded'`);
        return rs.rows[0];
      });
      videosSaved = Number(r?.saved ?? 0);
      videosAtRisk = Number(r?.atrisk ?? 0);
    }
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

  /* What anyone may know: is it up, and can it reach its two dependencies.
     A monitor needs exactly this and nothing more. */
  if (!full) {
    return NextResponse.json({
      ok: database !== "unreachable" && storage !== "blob-BROKEN",
      database: database === "unreachable" ? "unreachable" : "ok",
      storage: storage === "blob-BROKEN" ? "broken" : "ok",
    });
  }

  /* The rest is one workspace's briefing, answered inside that workspace. */
  return runInTenant(ctx!.workspace!, async () => NextResponse.json({
    ok: database !== "unreachable" && storage !== "blob-BROKEN",
    workspace: { id: ctx!.workspace!.id, name: ctx!.workspace!.name },
    database,
    storage,
    ...(storageError ? { storageError } : {}),
    ...(presignRange ? { presignRange } : {}),
    videosSaved,
    videosAtRisk,
    /* `via` is the door, not just whether a vendor is reachable: stills can
       be served by Google's own key or by the Vercel gateway, and which one
       it is decides whose balance pays. Without it the only way to find out
       was to make a render and read the ledger afterwards. */
    providers: PROVIDERS.map((p) => ({
      id: p.id, configured: providerConfigured(p), via: providerVia(p),
    })),
    // Reads the settings table, so during a database outage it throws — and
    // the one endpoint whose job is to SAY "database unreachable" would 500
    // instead of answering. Its absence is itself the signal.
    cron: await cronStatus().catch(() => null),
    arkKeyConfigured: Boolean(vendorKey("ark")),
    /* Whether invitations can be emailed, and from what address. Neither is
       a secret — the address appears in every invitation it sends — and
       without this the only way to tell was to send one and see. */
    mail: mailConfigured()
      ? { configured: true, from: mailFrom() }
      : { configured: false, needs: ["RESEND_API_KEY", "MAIL_FROM"] },
    pushConfigured: Boolean(
      process.env.VAPID_PRIVATE_KEY && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    ),
    region: process.env.VERCEL_REGION ?? "local",
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
  }));
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
