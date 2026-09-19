import { withRecoveryActivity } from "@/lib/recovery";
import {recoveryRoute} from '@/lib/recovery';
import { NextResponse } from "next/server";
import { PROVIDERS, providerConfigured, providerVia } from "@/lib/providers";
import { currentContext, requireSuperAdmin } from "@/lib/auth";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@/lib/tenant";
import { platformDb, platformReady } from "@/lib/platform";
import { vendorKey } from "@/lib/vendorKeys";
import { allSettings } from "@/lib/settings";
import { db, ready } from "@/lib/db";
import { presignedReadUrl } from "@/lib/storage";
import { mailConfigured, mailFrom } from "@/lib/mail";
import { engineMock } from "@/lib/mock";
import { dispatchMode } from "@/lib/dispatch";
import { recentDispatches } from "@/lib/dispatch-log";

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
export const GET = recoveryRoute(async function GET(req: Request) {
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
  const ctx = await currentContext().catch(() => null);
  const full = Boolean(ctx?.workspace);
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  if (deep) {
    const auth = await requireSuperAdmin().catch(() => ({ response: NextResponse.json({ error: "Diagnostics unavailable" }, { status: 503 }) }));
    if (auth.response) return auth.response;
  }
  let database = "unreachable";
  let videosSaved = 0;
  let videosAtRisk = 0; // succeeded renders whose file never landed in our storage
  try {
    await platformReady();
    await platformDb().execute("SELECT 1");
    database = /^(libsql|https):/.test(process.env.PLATFORM_DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? "") ? "turso" : "local-file";
    if (ctx?.workspace) {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const r: any = await runInTenant(ctx.workspace, async () => {
        await ready();
        const rs = await db().execute(`
          SELECT SUM(CASE WHEN stored_url IS NOT NULL THEN 1 ELSE 0 END) AS saved,
                 SUM(CASE WHEN stored_url IS NULL THEN 1 ELSE 0 END) AS atrisk
          FROM generations WHERE status='succeeded' AND deleted=0`);
        return rs.rows[0];
      });
      videosSaved = Number(r?.saved ?? 0);
      videosAtRisk = Number(r?.atrisk ?? 0);
    }
  } catch {
    database = "unreachable";
  }

  // Public checks are read-only. Writing a storage probe requires a platform
  // administrator; ordinary workspace accounts cannot trigger Blob probes.
  let storage = process.env.BLOB_READ_WRITE_TOKEN
    ? "blob-configured"
    : process.env.NODE_ENV === "production"
      ? "missing"
      : "local-disk";
  let storageError: string | null = null;
  /* Deep probe (?deep=1): the playback path itself. Media is served by
     redirecting to a presigned private-blob URL, so what actually matters is
     whether THAT url answers a Range request the way iOS Safari demands —
     a 206 with a Content-Range. Presign, ask for two bytes, report, clean up. */
  let presignRange: string | null = null;
  if (deep && process.env.BLOB_READ_WRITE_TOKEN) {
    const probePath = `health/${randomUUID()}/range-probe.bin`;
    let probeUrl: string | null = null;
    try {
      const { put: rawPut } = await import("@vercel/blob");
    const put = (...args: Parameters<typeof rawPut>) => withRecoveryActivity("blob-put", () => rawPut(...args), { uncertainOnError: true });
      const probe = await put(probePath, Buffer.from("0123456789"), {
        access: "private",
        contentType: "application/octet-stream",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      probeUrl = probe.url;
      const signed = await presignedReadUrl(probePath, 1);
      const r = await fetch(signed, {
        headers: { Range: "bytes=0-1" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      presignRange =
        `${r.status} ${r.headers.get("content-range") ?? "no-content-range"} ` +
        `accept-ranges=${r.headers.get("accept-ranges") ?? "-"}`;
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (r.status !== 206 || r.headers.get("content-range") !== "bytes 0-1/10" || bytes.length !== 2 || bytes[0] !== 48 || bytes[1] !== 49) {
        storage = "blob-BROKEN";
      } else { storage = "blob-private"; }
    } catch {
      presignRange = "ERROR: Private media range probe failed";
      storage = "blob-BROKEN";
    } finally {
      if (probeUrl) {
        try { const { del: rawDel } = await import("@vercel/blob");
    const del = (...args: Parameters<typeof rawDel>) => withRecoveryActivity("blob-delete", () => rawDel(...args), { uncertainOnError: true }); await del(probeUrl); }
        catch { storage = "blob-BROKEN"; storageError = "Storage probe cleanup failed"; }
      }
    }
  }

  /* What anyone may know: is it up, and can it reach its two dependencies.
     A monitor needs exactly this and nothing more. */
  const ok =
    database !== "unreachable" &&
    storage !== "blob-BROKEN" &&
    storage !== "missing";
  if (!full) {
    return NextResponse.json(
      {
        /* "blob-BROKEN" is only reachable when signed in now, so for a monitor
         this is the database answer — which is the one that goes down. */
        ok,
        mock: engineMock(),
        dispatch: { mode: dispatchMode() },
        database: database === "unreachable" ? "unreachable" : "ok",
        storage:
          storage === "blob-BROKEN"
            ? "broken"
            : storage === "missing"
              ? "missing"
              : "ok",
        storageVerified: false,
      },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  /* The rest is one workspace's briefing, answered inside that workspace. */
  return runInTenant(ctx!.workspace!, async () =>
    NextResponse.json(
      {
        ok,
        mock: engineMock(),
        /* Which dispatcher this deployment hands background work to
           (lib/dispatch.ts): "native" is /api/worker on Vercel, "inngest"
           only when DISPATCH_MODE asks for it, "inline" is the request's own
           after() — and the last ten hand-offs and worker runs from the
           platform's dispatch_log, newest first, so a render's "send: sent
           202" then "run: finished-ok" can be read here instead of in the
           Vercel log viewer. Identifiers and outcomes only; signed-in only,
           because it is a timeline of the studio's activity. Null means
           the platform database could not answer. */
        dispatch: { mode: dispatchMode(), recent: await recentDispatches(10).catch(() => null) },
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
          id: p.id,
          configured: providerConfigured(p),
          via: providerVia(p),
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
          process.env.VAPID_PRIVATE_KEY &&
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        ),
        region: process.env.VERCEL_REGION ?? "local",
        commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
      },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    ),
  );
});

/**
 * When the cron last ran, who ran it, and whether that is recent enough.
 * The schedule is every 10 minutes; anything past 15 means a tick was missed.
 */
async function cronStatus() {
  const st = await allSettings();
  const at = Number(st.lastCronAt ?? 0);
  if (!at)
    return {
      lastRunAt: null,
      by: null,
      agoMinutes: null,
      healthy: null,
      note: "no run recorded yet — instrumentation is new",
    };
  const ago = Math.round((Date.now() - at) / 60000);
  let result: unknown = null;
  try {
    result = JSON.parse(st.lastCronResult ?? "null");
  } catch {
    /* ignore */
  }
  return {
    lastRunAt: new Date(at).toISOString(),
    by: st.lastCronBy ?? null,
    agent: st.lastCronAgent ?? null,
    agoMinutes: ago,
    healthy: ago <= 15 && st.lastCronStatus !== "failed" && st.lastCronStatus !== "partial",
    status: st.lastCronStatus ?? "unknown",
    lastAttemptAt: Number(st.lastCronAttemptAt ?? 0) || null,
    result,
  };
}
