"use client";

/**
 * The platform page — the written answers to the questions the requirements
 * doc says need answering (R4 asset handling, R6 reliability, R7 API
 * architecture, R11 security and client data, R12 IP).
 *
 * Everything factual on this page is read off the running system, not typed
 * into a document, because a page that answers "are files compressed?" must
 * not be allowed to go stale. Where an answer is a policy rather than a
 * measurement it says so plainly, including where the honest answer is "not
 * yet".
 */
import { useApi } from "@/lib/useApi";
import Link from "next/link";
import { Waiting, Trouble } from "@/components/ParticlMark";
import { usePageTitle } from "@/lib/usePageTitle";

type Platform = {
  storage: {
    mode: string; region: string; database: string;
    maxImageBytes: number; maxRequestBytes: number;
    chunkedUploads: boolean; chunkedMaxBytes: number;
    derivesForApi: boolean; namingTemplate: string;
  };
  providers: {
    id: string; label: string; configured: boolean; baseUrl: string; docs: string;
    limits: Record<string, number | string[]>; rateLimit: string; billsFailures: boolean;
    models: { id: string; label: string; kind: string }[];
  }[];
  reliability: { maxRetries: number; cron: string; health: string };
};

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

function QA({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-hair py-3 first:border-0">
      <p className="text-[14px] font-medium text-ink">{q}</p>
      <div className="mt-1 text-[14px] leading-relaxed text-dim">{children}</div>
    </div>
  );
}

export default function PlatformPage() {
  const { data, error, refresh } = useApi<Platform>("/api/platform");
  usePageTitle("Platform");
  if (!data) return error ? <Trouble label="The system page didn't load" detail={error} onRetry={refresh} /> : <Waiting label="Reading the system" />;
  const s = data.storage;

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[760px] pb-10">
        <Link href="/settings" className="mt-6 inline-block text-[14px] text-blue">← Settings</Link>
        <h1 className="h1 mt-2">Platform</h1>
        <p className="mt-3 max-w-[62ch] text-[15px] text-dim">
          What happens to a file, what happens when a vendor fails, and who can
          reach any of it. The numbers below are read off this deployment as
          the page loads.
        </p>

        {/* ── R4 ─────────────────────────────────────────── */}
        <section className="card mt-8 px-5 py-4">
          <p className="grouplabel">Assets</p>
          <div className="mt-2">
            <QA q="Are files compressed?">
              No. An upload is written byte-for-byte, then re-read from storage
              and hashed; the browser hashes the file before sending and
              compares. A match is shown as <b>BYTE-IDENTICAL</b>. Nothing in
              the upload path decodes an image, so nothing can re-encode one.
            </QA>
            <QA q="What is the maximum upload size?">
              A single reference image up to {mb(s.maxImageBytes)}; the whole
              request to a vendor up to {mb(s.maxRequestBytes)}. Chunked
              uploads carry files up to {(s.chunkedMaxBytes / 1073741824).toFixed(0)} GB —
              which is how anything past a few megabytes actually arrives.
            </QA>
            <QA q="What if an asset is bigger than the API accepts?">
              {s.derivesForApi ? (
                <>The master is kept exactly as it arrived and a separate
                <b> delivery copy</b> is derived to fit the vendor: pixels
                brought inside the ceiling, aspect padded rather than cropped,
                quality reduced only as far as the byte limit demands. The copy
                is never shown in All takes, downloaded or exported. An asset
                below the vendor&rsquo;s minimum size is refused rather than
                upscaled, because upscaling invents detail.</>
              ) : (
                <>Delivery copies are currently switched OFF, so an oversized
                asset is refused rather than stored. Turn them on in Settings
                to keep the master and send a derived copy instead.</>
              )}
            </QA>
            <QA q="Where are originals stored?">
              {s.mode === "vercel-blob-private"
                ? <>A private Vercel Blob store in <b>{s.region}</b>, alongside a
                   Turso database in the same region. Nothing in the store is
                   public: media is served through an authenticated route that
                   hands out a short-lived signed link.</>
                : <>On local disk under <code>.data/</code> — this is a
                   development deployment. Production uses a private blob store
                   and a managed database.</>}
            </QA>
            <QA q="Are downloaded assets identical to the original?">
              Yes for masters — the download streams the stored bytes. The
              delivery copy is the only derived file that exists and it is
              never what a download serves.
            </QA>
            <QA q="Are chunked uploads supported?">
              {s.chunkedUploads ? "Yes — sliced client-side and uploaded three at a time, assembled server-side as a stream that is never fully buffered." : "No."}
            </QA>
            <QA q="What are downloads named?">
              By this workspace&rsquo;s protocol, never the vendor&rsquo;s:
              <code className="ml-1 break-all">{s.namingTemplate}</code>.
              Editable in Settings.
            </QA>
          </div>
        </section>

        {/* ── R7 ─────────────────────────────────────────── */}
        <section className="card mt-6 px-5 py-4">
          <p className="grouplabel">Generation APIs</p>
          <p className="mt-1 text-[13px] text-mute">
            The GPUs are somebody else&rsquo;s. What this platform owns is the
            orchestration around them, so a vendor is data — its key, limits
            and failure behaviour declared in one place. Adding one is an entry
            plus an adapter, not a rebuild.
          </p>
          <div className="mt-3">
            {data.providers.map((p) => (
              <div key={p.id} className="border-t border-hair py-3">
                <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium text-ink">
                  {p.label}
                  <span className={`chip ${p.configured ? "" : "!text-lift"}`}>
                    {p.configured ? "key configured" : "no key"}
                  </span>
                  <span className="chip">{p.models.length} model{p.models.length === 1 ? "" : "s"}</span>
                </p>
                <p className="mt-1.5 text-[13px] text-dim">
                  Images {mb(Number(p.limits.maxImageBytes))} · videos{" "}
                  {mb(Number(p.limits.maxVideoBytes))} · request{" "}
                  {mb(Number(p.limits.maxRequestBytes))} ·{" "}
                  {String(p.limits.minImagePx)}–{String(p.limits.maxImagePx)}px ·
                  aspect {String(p.limits.minAspect)}–{String(p.limits.maxAspect)}
                </p>
                <p className="mt-1 text-[13px] text-mute">{p.rateLimit}</p>
                <p className="mt-1 text-[13px] text-mute">
                  {p.billsFailures
                    ? "Failed generations ARE billed by this vendor."
                    : "Failed generations are not billed, and a failed row records no cost."}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── R6 ─────────────────────────────────────────── */}
        <section className="card mt-6 px-5 py-4">
          <p className="grouplabel">Reliability</p>
          <div className="mt-2">
            <QA q="What happens when a vendor call fails?">
              Failures are classified before anything is retried. A timeout, a
              502 or a rate limit is weather: retried up to{" "}
              {data.reliability.maxRetries} time{data.reliability.maxRetries === 1 ? "" : "s"} with
              backoff, and the attempt count is recorded on the render. A
              rejected prompt is a decision and fails immediately with the
              vendor&rsquo;s own words. Nothing fails silently — the row is
              written before the submit, so a failed render is visible rather
              than absent.
            </QA>
            <QA q="Can a failed job destabilise a project?">
              No. Each render is an independent row; there is no shared queue
              to poison and no worker to wedge. A project that has never
              rendered and a project with a thousand renders load the same way.
            </QA>
            <QA q="What happens to a render nobody is watching?">
              {data.reliability.cron} copies finished renders off the
              vendor&rsquo;s expiring URLs into our own storage, so a render
              that lands at 2am is still there on Monday.
            </QA>
            <QA q="How is the platform monitored?">
              <code>{data.reliability.health}</code> reports the database and
              storage mode, the commit deployed, renders saved, and any render
              whose media never landed.
            </QA>
          </div>
        </section>

        {/* ── R11 ────────────────────────────────────────── */}
        <section className="card mt-6 px-5 py-4">
          <p className="grouplabel">Security &amp; client data</p>
          <div className="mt-2">
            <QA q="Is traffic encrypted?">
              Yes — HTTPS end to end, including the signed links handed out for
              playback. Media links are short-lived and never cached.
            </QA>
            <QA q="Who can reach the files?">
              Every API route requires a session or a scoped API token, media
              and reference routes included — nothing is publicly fetchable.
              Tokens are stored as hashes, can be read-only, can carry a
              monthly spend ceiling, and can never mint another token.
              Disabling a person deletes their sessions immediately.
            </QA>
            <QA q="Where is the data physically hosted?">
              {s.database === "turso" ? "Turso" : "SQLite"} and{" "}
              {s.mode === "vercel-blob-private" ? "a private Vercel Blob store" : "local disk"},
              region <b>{s.region}</b>. Compute runs in the same region so
              media never crosses one unnecessarily.
            </QA>
            <QA q="Is anything exposed to third parties?">
              Only what a render needs: the prompt and its reference assets go
              to the generation vendor you chose, and nowhere else. There is no
              analytics vendor, no ad SDK, and no third-party session recorder
              in this application.
            </QA>
            <QA q="Retention, deletion and backups">
              Deleting a render is a soft delete — the media goes, the cost
              stays in the ledger, because a ledger that forgets binned takes
              flatters the project. <b>Honest gap:</b> there is no automated
              backup schedule or hard-delete job in this build. The managed
              database provider keeps its own backups; a documented restore
              drill has not been run.
            </QA>
          </div>
        </section>

        {/* ── R12 ────────────────────────────────────────── */}
        <section className="card mt-6 px-5 py-4">
          <p className="grouplabel">IP &amp; ownership</p>
          <div className="mt-2">
            <QA q="Who owns what is made here?">
              Two layers, and they answer differently.
              <b> The platform:</b> this workspace is built and run by the
              studio. It claims no ownership or usage rights over uploaded
              client material, prompts, generations or project data, and there
              is no clause anywhere granting any.
              <b> The generation API:</b> IP in an output is governed by the
              commercial terms of the model that produced it. That is the layer
              to read before a client contract, and it changes per vendor.
            </QA>
            <QA q="Can we take everything out?">
              Yes — <Link href="/api/export" className="text-blue">Export data</Link> dumps
              every project, prompt, cost and account record as JSON, and media
              downloads under the workspace&rsquo;s own naming protocol.
            </QA>
          </div>
        </section>
      </div>
    </div>
  );
}
