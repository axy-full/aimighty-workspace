"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { usd, compactTokens, timeAgo, dur } from "@/lib/format";

/** Bytes, the way a producer would say them. */
function gb(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}
import { Waiting, Trouble, Empty } from "@/components/ParticlMark";
import Link from "next/link";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { getModel } from "@/lib/models";
import { stateOf } from "@/components/Feed";
import type { Analytics } from "@/components/Analytics";
import type { Gen } from "@/components/GenCard";
import { IconClose } from "@/components/Icons";
import { appConfirm } from "@/components/dialog";
import { usePageTitle } from "@/lib/usePageTitle";

/**
 * Usage — four ledgers, one per vendor.
 *
 * Money is loaded with each vendor separately, so it is counted separately:
 * what was added, what the renders (and prompts) have cost, and what is
 * left. Where a vendor states its own position over the API, that sits
 * beside our count; where it doesn't, our count is the only one there is.
 */

type Vendor = {
  id: string; label: string; serves: string; via: string | null; configured: boolean; envKey: string;
  added: number; spent: number; renderSpend: number; promptSpend: number; remaining: number;
  unit: "usd" | "credits"; addedCredits: number; spentCredits: number; remainingCredits: number; usdPerCredit: number | null;
  renders: number; attempts: number; prompts: number; tokens: number;
  live: { kind: "gateway"; balanceUsd: number; usedUsd: number }
      | { kind: "credits"; used: number; limit: number; tier: string; resetAt: number | null }
      | null;
  note: string;
  /** What we would have said with no reading to anchor to. */
  computedSpent: number;
  computedCredits: number;
  /** The most recent reading from this vendor's own console. */
  anchor: {
    checkedAt: number;
    balanceUsd: number | null; spendUsd: number | null;
    balanceCredits: number | null; spendCredits: number | null;
    note: string; authorName: string | null;
    sinceUsd: number; sinceCredits: number; sinceRenders: number;
    driftUsd: number | null; driftCredits: number | null;
  } | null;
  models: { model: string; label: string; n: number; spend: number; tokens: number }[];
  topups: { id: string; amountUsd: number; credits: number | null; note: string; createdAt: number }[];
};

type Usage = {
  purchasedUsd: number; spentUsd: number; remainingUsd: number;
  totalGenerations: number; succeeded: number; failed: number; pending: number;
  totalTokens: number; avgCostUsd: number;
  promptSpendUsd: number; promptCount: number;
  vendors: Vendor[];
  /** Rent rather than a purchase: what it costs to KEEP what has been made. */
  storage: {
    bytes: number; counted: number; unmeasured: number;
    monthlyUsd: number; yearlyUsd: number;
    byKind: { kind: string; n: number; bytes: number; monthlyUsd: number }[];
    largest: { id: string; title: string | null; kind: string; bytes: number }[];
    perGbMonthUsd: number; perGbTransferUsd: number;
  } | null;
  byProject: { name: string; n: number; spend: number }[];
  byPerson: { name: string; n: number; spend: number }[];
  timing: { kind: string; n: number; totalMs: number | null; queueMs: number | null;
            refineMs: number | null; submitMs: number | null; engineMs: number | null;
            noticeMs: number | null; storeMs: number | null }[];
  refines: { model: string; label: string; n: number; inTokens: number; outTokens: number;
             tokens: number; spend: number; free: boolean; freeLeft: number }[];
  byMonth: { month: string; n: number; spend: number }[];
  recent: { id: string; label: string; provider: string; kind: string; title: string | null;
            prompt: string; costUsd: number; renderCostUsd: number;
            refineCostUsd: number | null; refineModel: string | null; refineLabel: string | null;
            refineInTokens: number | null; refineOutTokens: number | null;
            totalTokens: number; params: Record<string, unknown>; createdAt: number }[];
};

export default function UsagePage() {
  const { data, error, refresh } = useApi<Usage>("/api/usage", 20000);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState<string>("all");



  usePageTitle("Usage");
  if (!data) return error ? <Trouble label="The ledger didn't load" detail={error} onRetry={refresh} /> : <Waiting label="Reading the ledgers" />;

  const vendorName = (id: string) => data.vendors.find((v) => v.id === id)?.label ?? id;
  const recent = vendorFilter === "all" ? data.recent : data.recent.filter((r) => r.provider === vendorFilter);

  return (
    <div className="page">
      <div className="page-inner">
        <ProductionTop />

        {/* ── The ledgers ── */}
        <p className="mt-16 text-[13px] text-dim">
          Below: the ledgers behind the numbers — each vendor&rsquo;s own count, prompt writing, storage rent, where the time goes, and every render&rsquo;s price.
        </p>
        <p className="grouplabel mt-12">Ledgers</p>
        <div className="grid gap-5 md:grid-cols-2">
          {data.vendors.map((v) => <VendorCard key={v.id} v={v} onChanged={refresh} />)}
        </div>

        {/* Breakdowns */}
        <div className="mt-12 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          <Breakdown title="By project" rows={data.byProject.map((p) => ({
            key: p.name, name: p.name, meta: `${p.n} render${p.n === 1 ? "" : "s"}`, value: p.spend,
          }))} />
          <Breakdown title="By member" rows={data.byPerson.map((p) => ({
            key: p.name, name: p.name, meta: `${p.n} render${p.n === 1 ? "" : "s"}`, value: p.spend,
          }))} />
          <Breakdown title="By month" rows={data.byMonth.map((m) => ({
            key: m.month, name: m.month, meta: `${m.n} render${m.n === 1 ? "" : "s"}`, value: m.spend,
          }))} />
        </div>

        {data.refines.length > 0 && (
          <>
            <p className="grouplabel mt-12">Prompt writing</p>
            <div className="rows">
              {data.refines.map((r) => (
                <div key={r.model} className="row">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{r.label}</span>
                    <span className="text-[13px] text-mute">
                      {r.n} prompt{r.n === 1 ? "" : "s"} · {compactTokens(r.inTokens)} in / {compactTokens(r.outTokens)} out
                      {r.free && <> · {r.freeLeft > 0 ? `${compactTokens(r.freeLeft)} of the free 500k left` : "free allowance used"}</>}
                    </span>
                  </span>
                  <span className="row-value tabular-nums">{r.spend > 0 ? usd(r.spend, 3) : "Free"}</span>
                </div>
              ))}
              <div className="row">
                <span className="font-medium">All prompt writing</span>
                <span className="row-value font-semibold tabular-nums !text-bone">{usd(data.promptSpendUsd, 3)}</span>
              </div>
            </div>
            <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
              Every prompt&rsquo;s cost is part of its render&rsquo;s total wherever a total is shown, and
              is counted against the ledger of whoever wrote it: Claude on the Google Gemini credit,
              ByteDance&rsquo;s writer on ModelArk.
            </p>
          </>
        )}

        {/* ── Storage ─────────────────────────────────────────────── */}
        {data.storage && data.storage.counted > 0 && (
          <>
            <p className="grouplabel mt-12">Storage</p>
            <div className="rows">
              <div className="row">
                <span className="flex min-w-0 flex-col">
                  <span>Everything kept</span>
                  <span className="mt-0.5 text-[13px] text-mute">
                    {gb(data.storage.bytes)} across {data.storage.counted} render
                    {data.storage.counted === 1 ? "" : "s"}
                    {data.storage.unmeasured > 0 && ` · ${data.storage.unmeasured} not yet measured`}
                  </span>
                </span>
                <span className="row-value tabular-nums">
                  {usd(data.storage.monthlyUsd, 2)}<span className="text-mute"> / month</span>
                </span>
              </div>
              {data.storage.byKind.map((k) => (
                <div key={k.kind} className="row">
                  <span className="flex min-w-0 flex-col">
                    <span className="capitalize">{k.kind}</span>
                    <span className="text-[13px] text-mute">{k.n} · {gb(k.bytes)}</span>
                  </span>
                  <span className="row-value tabular-nums">{usd(k.monthlyUsd, 3)}</span>
                </div>
              ))}
              <div className="row">
                <span className="font-medium">A year at this size</span>
                <span className="row-value font-semibold tabular-nums !text-bone">
                  {usd(data.storage.yearlyUsd, 2)}
                </span>
              </div>
            </div>
            <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
              The only cost here that is rent rather than a purchase: it is charged every
              month for as long as a render is kept, and it grows while nobody is doing
              anything. Keeping is cheap — {usd(data.storage.perGbMonthUsd, 3)} a gigabyte
              a month in Mumbai. <span className="text-dim">Watching is what costs</span>:{" "}
              {usd(data.storage.perGbTransferUsd, 3)} a gigabyte every time a render travels,
              so one view of a clip costs about what a month of storing it does. That side
              is not counted here, because nothing yet counts views.
            </p>
          </>
        )}

        {(data.timing ?? []).length > 0 && (
          <>
            <p className="grouplabel mt-12">Where the time goes</p>
            <div className="rows">
              {(data.timing ?? []).map((t) => (
                <div key={t.kind} className="row !items-start">
                  <span className="flex min-w-0 flex-col">
                    <span className="capitalize">{t.kind}</span>
                    <span className="mt-0.5 text-[13px] text-mute">
                      {t.n} render{t.n === 1 ? "" : "s"} measured · median
                    </span>
                    <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] tabular-nums text-mute">
                      {t.refineMs != null && <span>prompt {dur(t.refineMs)}</span>}
                      {t.queueMs != null && <span>queued {dur(t.queueMs)}</span>}
                      {t.submitMs != null && <span>submit {dur(t.submitMs)}</span>}
                      {t.engineMs != null && <span className="text-dim">engine {dur(t.engineMs)}</span>}
                      {t.noticeMs != null && <span>noticed after {dur(t.noticeMs)}</span>}
                      {t.storeMs != null && <span>stored {dur(t.storeMs)}</span>}
                    </span>
                  </span>
                  <span className="row-value shrink-0 font-medium !text-bone tabular-nums">{dur(t.totalMs)}</span>
                </div>
              ))}
            </div>
            <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
              The figure on the right is the whole wait, from pressing the button to the
              tile appearing. Engine is the vendor&rsquo;s own working time; everything else
              is ours. Each stage is its own median, so they will not add up to the total
              exactly. A video reports engine time only when ModelArk stamps the task, and
              &ldquo;noticed after&rdquo; is how long it sat finished before a poll found it.
            </p>
          </>
        )}

        <div className="mt-12 flex flex-wrap items-center gap-2">
          <p className="grouplabel !pb-0">Cost per render</p>
          <span className="ml-auto flex flex-wrap gap-1.5">
            {[["all", "All"], ...data.vendors.map((v) => [v.id, v.label] as const)].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setVendorFilter(k)}
                className={`chip !py-1 !text-[12.5px] ${vendorFilter === k ? "bg-blue text-on-ink" : ""}`}>{l}</button>
            ))}
          </span>
        </div>
        <div className="rows mt-3">
          {recent.length === 0 && <div className="row text-dim">No finished renders here yet</div>}
          {recent.map((r) => {
            const p = r.params as { resolution?: string; ratio?: string; duration?: number; credits?: number; steps?: number };
            const open = openRow === r.id;
            return (
              <button key={r.id} className="row !items-start" onClick={() => setOpenRow(open ? null : r.id)}>
                <span className="flex min-w-0 flex-col">
                  <span className={`text-[15px] ${open ? "" : "truncate"}`}>{r.title || r.prompt}</span>
                  <span className="mt-0.5 text-[13px] text-mute">
                    {r.label} · {vendorName(r.provider)} ·{" "}
                    {[p.resolution, p.ratio, p.duration && `${p.duration}s`].filter(Boolean).join(" · ")}
                    {r.kind === "audio" && p.credits ? ` · ${p.credits.toLocaleString()} credits` : r.totalTokens ? ` · ${compactTokens(r.totalTokens)}t` : ""}
                    {" "}· {timeAgo(r.createdAt)}
                  </span>
                  <span className="mt-0.5 text-[12.5px] tabular-nums text-mute">
                    render {usd(r.renderCostUsd)}
                    {r.refineLabel
                      ? <> + prompt {r.refineCostUsd ? usd(r.refineCostUsd) : "free"} <span className="text-mute/80">({r.refineLabel})</span></>
                      : <> · prompt as written</>}
                  </span>
                </span>
                <span className="row-value shrink-0 font-medium !text-bone tabular-nums">{usd(r.costUsd)}</span>
              </button>
            );
          })}
        </div>

        <p className="mt-8 text-center text-[12px] text-mute">
          ModelArk and gateway figures are what those vendors billed; fal and ElevenLabs figures
          follow their published rates. Deleted renders stay counted.
        </p>
      </div>
    </div>
  );
}

/** One vendor's ledger: added, spent, left — and its own word where it gives one. */
function VendorCard({ v, onChanged }: { v: Vendor; onChanged: () => void }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [balance, setBalance] = useState("");
  const [portalSpend, setPortalSpend] = useState("");

  /** Write down what the vendor's own console says, and anchor to it. */
  async function saveCheck() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/ledger-checks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: v.id,
          // Recorded in whatever unit the console showed, never converted:
          // converting at read time would bake in whatever rate we happened
          // to believe on the day.
          ...(v.unit === "credits"
            ? {
                balanceCredits: balance.trim() === "" ? null : Number(balance),
                spendCredits: portalSpend.trim() === "" ? null : Number(portalSpend),
              }
            : {
                balanceUsd: balance.trim() === "" ? null : Number(balance),
                spendUsd: portalSpend.trim() === "" ? null : Number(portalSpend),
              }),
          note: note.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not record it");
      setBalance(""); setPortalSpend(""); setNote(""); setChecking(false);
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function add() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0 || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/topups", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v.unit === "credits"
          ? { credits: n, amountUsd: 0, note, provider: v.id }
          : { amountUsd: n, note, provider: v.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not record it");
      setAmount(""); setNote(""); setAdding(false);
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  /**
   * Removing a top-up rewrites what this vendor's ledger says is left, so
   * it asks — the number people read to decide whether they can afford a
   * render moves the moment this runs.
   */
  async function remove(t: Vendor["topups"][number]) {
    const amount = t.credits != null
      ? `${cr(t.credits)} credits${t.amountUsd ? ` · ${usd(t.amountUsd, 2)}` : ""}`
      : usd(t.amountUsd, 2);
    const ok = await appConfirm(
      `Remove this top-up of ${amount}?`,
      "The balance on this ledger drops by that much. Spending already recorded stays as it is.",
      { confirmLabel: "Remove", danger: true },
    );
    if (!ok) return;
    const res = await fetch(`/api/topups?id=${encodeURIComponent(t.id)}`, { method: "DELETE" });
    if (res.ok) onChanged();
  }

  const credits = v.unit === "credits";
  const over = credits ? v.remainingCredits < 0 : v.remaining < 0;
  const rate = v.usdPerCredit ?? 0;
  const cr = (n: number) => n.toLocaleString();
  return (
    <section className="card flex flex-col gap-4 px-5 py-5">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[19px] font-semibold tracking-[-0.015em]">{v.label}</h2>
          <span className="grouplabel !pb-0 !text-[10px]">{v.serves}</span>
          <span className={`text-[12.5px] ${v.configured ? "text-ok" : "text-mute"}`}>
            {v.configured ? (v.via === "gateway" ? "connected · gateway" : "connected") : `not connected · ${v.envKey}`}
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-mute">{v.note}</p>
      </div>

      {credits ? (
        <div className="grid grid-cols-3 gap-3">
          <Figure label="Added" value={`${cr(v.addedCredits)} cr`} sub={rate ? `≈ ${usd(v.addedCredits * rate, 2)}` : undefined} />
          <Figure label="Spent" value={`${cr(v.spentCredits)} cr`} sub={rate ? `≈ ${usd(v.spentCredits * rate, 2)}` : undefined} />
          <Figure label="Left" value={v.addedCredits > 0 || over ? `${cr(v.remainingCredits)} cr` : "—"} tone={over ? "bad" : v.addedCredits > 0 ? "good" : undefined}
            sub={rate && v.addedCredits > 0 ? `≈ ${usd(v.remainingCredits * rate, 2)}` : undefined} />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <Figure label="Added" value={usd(v.added, 2)} />
          <Figure label="Spent" value={usd(v.spent, 2)} sub={v.promptSpend > 0 ? `prompts ${usd(v.promptSpend, 2)}` : undefined} />
          <Figure label="Left" value={v.added > 0 || over ? usd(v.remaining, 2) : "—"} tone={over ? "bad" : v.added > 0 ? "good" : undefined} />
        </div>
      )}

      {/* ── Anchored to the vendor's own console ─────────────────────── */}
      {(
        <div className="rounded-[var(--r)] bg-panel2 px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[12px] font-medium uppercase tracking-wide text-mute">
              {v.label} console
            </span>
            {!checking && (
              <button type="button" onClick={() => setChecking(true)} className="ml-auto text-[13px] text-blue">
                {v.anchor ? "Record a new reading" : "Match it to the console"}
              </button>
            )}
          </div>

          {v.anchor ? (
            <>
              {(() => {
                const bal = credits ? v.anchor!.balanceCredits : v.anchor!.balanceUsd;
                const sp = credits ? v.anchor!.spendCredits : v.anchor!.spendUsd;
                const since = credits ? v.anchor!.sinceCredits : v.anchor!.sinceUsd;
                const drift = credits ? v.anchor!.driftCredits : v.anchor!.driftUsd;
                const fmt = (n: number) => (credits ? `${cr(Math.round(n))} cr` : usd(n, 2));
                const floor = credits ? 1 : 0.01;
                return (
                  <>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-dim">
                      Read {timeAgo(v.anchor!.checkedAt)}
                      {v.anchor!.authorName ? ` by ${v.anchor!.authorName}` : ""}:{" "}
                      {bal != null && <><span className="font-medium text-ink">{fmt(bal)}</span> left</>}
                      {bal != null && sp != null && ", "}
                      {sp != null && <><span className="font-medium text-ink">{fmt(sp)}</span> spent</>}
                      . The figures above count on from that
                      {v.anchor!.sinceRenders > 0
                        ? `, plus ${fmt(since)} across ${v.anchor!.sinceRenders} render${v.anchor!.sinceRenders === 1 ? "" : "s"} since.`
                        : "; nothing has been made since."}
                    </p>
                    {drift != null && Math.abs(drift) >= floor && (
                      <p className="mt-1.5 text-[12.5px] leading-relaxed text-mute">
                        Our own arithmetic had it{" "}
                        <span className={drift > 0 ? "text-lift" : "text-ok"}>
                          {fmt(Math.abs(drift))} {drift > 0 ? "high" : "low"}
                        </span>{" "}
                        at that point. A gap that keeps growing means a rate in the catalogue is
                        wrong, or a discount applies that we don&rsquo;t know about.
                      </p>
                    )}
                  </>
                );
              })()}
              {v.anchor.note && <p className="mt-1 text-[12.5px] text-mute">{v.anchor.note}</p>}
            </>
          ) : (
            <p className="mt-1.5 text-[13px] leading-relaxed text-mute">
              Every figure above is computed from what each render reported and our own rate
              table, so it is an estimate. Open the {v.label} console, type in what it says,
              and these count on from that instead.
            </p>
          )}

          {checking && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] text-mute">
                    Balance it shows{credits ? " (credits)" : ""}
                  </span>
                  <input className="ctl !h-[34px] !text-[14px]" value={balance} inputMode="decimal"
                    placeholder={credits ? "e.g. 128500" : "e.g. 62.04"}
                    onChange={(e) => setBalance(e.target.value)} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] text-mute">Spend to date, if shown</span>
                  <input className="ctl !h-[34px] !text-[14px]" value={portalSpend} inputMode="decimal"
                    placeholder="optional" onChange={(e) => setPortalSpend(e.target.value)} />
                </label>
              </div>
              <input className="ctl !h-[34px] !text-[14px]" value={note}
                placeholder="Note — which page, which period" onChange={(e) => setNote(e.target.value)} />
              <div className="flex gap-2">
                <button type="button" onClick={saveCheck} disabled={busy}
                  className="btn-render h-[32px] px-4 text-[13px] disabled:opacity-50">
                  {busy ? "Saving…" : "Anchor to this"}
                </button>
                <button type="button" onClick={() => { setChecking(false); setErr(null); }} className="chip !py-1.5 !text-[13px]">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {v.live?.kind === "gateway" && (
        <p className="text-[13px] text-dim">
          The gateway itself says <span className="font-medium text-ink">{usd(v.live.balanceUsd, 2)}</span> left
          ({usd(v.live.usedUsd, 2)} used). {Math.abs(v.live.balanceUsd - v.remaining) > 0.5
            ? "Where that differs from our count, the gateway is right — top-ups or spend outside this app."
            : "Our count agrees."}
        </p>
      )}
      {v.live?.kind === "credits" && (
        <p className="text-[13px] text-dim">
          The account says <span className="font-medium text-ink">{Math.max(0, v.live.limit - v.live.used).toLocaleString()}</span> of{" "}
          {v.live.limit.toLocaleString()} credits left this cycle on the {v.live.tier} plan
          {v.live.resetAt ? `, resetting ${timeAgo(v.live.resetAt)}` : ""}.
        </p>
      )}

      {v.models.length > 0 && (
        <div className="rows">
          {v.models.map((m) => (
            <div key={m.model} className="row !min-h-[40px] !py-2">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[14px]">{m.label}</span>
                <span className="text-[12px] text-mute">{m.n} render{m.n === 1 ? "" : "s"}{m.tokens ? ` · ${compactTokens(m.tokens)}t` : ""}</span>
              </span>
              <span className="row-value tabular-nums">{usd(m.spend, 2)}</span>
            </div>
          ))}
        </div>
      )}
      {v.models.length === 0 && <p className="text-[13px] text-mute">Nothing rendered here yet.</p>}

      <div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium uppercase tracking-wide text-mute">Top-ups</span>
          {!adding && <button type="button" onClick={() => setAdding(true)} className="ml-auto text-[13px] text-blue">Record a top-up</button>}
        </div>
        {v.topups.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {v.topups.map((t) => (
              <li key={t.id} className="group flex items-center gap-2 text-[13px]">
                <span className="tabular-nums font-medium">{t.credits != null ? `${cr(t.credits)} credits${t.amountUsd ? ` · ${usd(t.amountUsd, 2)}` : ""}` : usd(t.amountUsd, 2)}</span>
                <span className="truncate text-mute">{t.note || "—"} · {timeAgo(t.createdAt)}</span>
                <button type="button" onClick={() => void remove(t)} title="Remove this entry"
                  className="reveal ml-auto grid h-6 w-6 place-items-center rounded-full text-mute hover:text-lift"><IconClose className="!h-3 !w-3" /></button>
              </li>
            ))}
          </ul>
        )}
        {v.topups.length === 0 && !adding && <p className="mt-1 text-[13px] text-mute">Nothing added yet — {credits ? "0 credits" : usd(0, 2)} on this ledger.</p>}
        {adding && (
          <div className="mt-2 flex flex-wrap gap-2">
            <input className="ctl !h-[34px] w-[120px] !text-[14px]" value={amount} inputMode="decimal" placeholder={credits ? "Credits" : "USD"}
              onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} autoFocus />
            <input className="ctl !h-[34px] min-w-[160px] flex-1 !text-[14px]" value={note} placeholder="Note or invoice reference"
              onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            <button type="button" onClick={add} disabled={busy} className="chip !text-blue disabled:opacity-50">{busy ? "Recording…" : "Add"}</button>
            <button type="button" onClick={() => { setAdding(false); setErr(null); }} className="chip">Cancel</button>
          </div>
        )}
        {err && <p className="mt-1 text-[13px] text-lift">{err}</p>}
      </div>
    </section>
  );
}

function Figure({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-[12px] bg-panel2 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-mute">{label}</p>
      <p className={`mt-0.5 text-[20px] font-semibold tabular-nums tracking-[-0.02em] ${tone === "bad" ? "text-lift" : tone === "good" ? "text-blue" : ""}`}>{value}</p>
      {sub && <p className="text-[11.5px] text-mute">{sub}</p>}
    </div>
  );
}

function Breakdown({ title, rows }: {
  title: string;
  rows: { key: string; name: string; meta: string; value: number }[];
}) {
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  return (
    <section>
      <p className="grouplabel">{title}</p>
      <div className="card p-5">
        {rows.length === 0 && <p className="text-[14px] text-mute">Nothing recorded</p>}
        <ul className="flex flex-col gap-4">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex items-baseline gap-3">
                <span className="truncate text-[15px]">{r.name}</span>
                <span className="ml-auto shrink-0 text-[14px] font-medium tabular-nums">{usd(r.value, 2)}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel2">
                <div className="h-full rounded-full bg-blue transition-[width] duration-500"
                  style={{ width: `${Math.max((r.value / max) * 100, r.value > 0 ? 3 : 0)}%` }} />
              </div>
              <p className="mt-1 text-[12.5px] text-mute">{r.meta}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}


/* ── Production: the top of the page, from the pipeline handoff ───────
   What the job cost, who spent it, and which shot is taking the most
   takes. Four tiles, then production × people, then shots × engines. The
   studio's numbers come from the analytics route over a period; the
   production's from the same route narrowed to it, its cap from the
   projects route, and the per-take blocks from its own renders. */
type Period = "month" | "30" | "quarter";
type ProjRow = {
  id: string; name: string; code: string; spend: number; capUsd: number | null;
  shots: number; approvedShots: number; pickedShots: number; genCount: number;
};
const PROVIDER_NAMES: Record<string, string> = {
  byteplus: "BytePlus ModelArk", gateway: "Vercel AI Gateway", google: "Vercel AI Gateway",
  fal: "fal.ai", elevenlabs: "ElevenLabs",
};
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

function ProductionTop() {
  const { signedIn } = useSession();
  const { selection, current } = useProject();
  const scoped = selection !== "all" && selection !== "unfiled";
  const [period, setPeriod] = useState<Period>("month");
  const days = period === "month" ? new Date().getDate() : period === "30" ? 30 : 90;
  const periodLabel = period === "month" ? new Date().toLocaleDateString(undefined, { month: "long" }).toUpperCase() : period === "30" ? "30 DAYS" : "QUARTER";

  const { data: all } = useApi<Analytics>(signedIn ? `/api/analytics?days=${days}` : null, 30_000);
  const { data: proj } = useApi<Analytics>(signedIn && scoped ? `/api/analytics?days=${days}&projectId=${encodeURIComponent(selection)}` : null, 30_000);
  const { data: projects } = useApi<{ projects: ProjRow[] }>(signedIn ? "/api/projects" : null, 30_000);
  const { data: jobs } = useApi<{ generations: Gen[] }>(signedIn && scoped ? `/api/jobs?projectId=${encodeURIComponent(selection)}&limit=500&sync=0` : null, 15_000);

  const p = scoped ? projects?.projects.find((x) => x.id === selection) ?? null : null;
  const focus = (scoped ? proj : all) ?? null;
  const focusLabel = scoped ? (current?.name ?? "This production").toUpperCase() : "STUDIO";

  /* Takes per shot, as blocks: approved · picked · draft · rendering · sent back. */
  const shotRows = useMemo(() => {
    const map = new Map<string, Gen[]>();
    for (const g of jobs?.generations ?? []) {
      if (g.kind === "image" || g.kind === "audio" || !g.shotCode) continue;
      (map.get(g.shotCode) ?? map.set(g.shotCode, []).get(g.shotCode)!).push(g);
    }
    return [...map.entries()].map(([code, list]) => {
      const takes = list.slice().sort((a, b) => (a.version ?? 0) - (b.version ?? 0));
      const st = takes.map((g) => (g.reviewState === "changes" ? "back" : stateOf(g)));
      const state = st.includes("approved") ? "Approved" : st.includes("picked") ? "Picked" : st.includes("rendering") ? "Rendering" : "Draft";
      return {
        code, n: takes.length, blocks: st, state,
        back: st.filter((x) => x === "back").length,
        cost: takes.reduce((a, g) => a + (g.costUsd ?? 0) + (g.refineCostUsd ?? 0), 0),
      };
    }).sort((a, b) => b.n - a.n || b.cost - a.cost);
  }, [jobs]);

  const approved = p?.approvedShots ?? 0;
  const shots = p?.shots ?? 0;
  const videoTakes = shotRows.reduce((a, r) => a + r.n, 0);
  const perApproved = p && approved ? p.spend / approved : null;
  const takesPerApproval = approved ? videoTakes / approved : null;
  const projected = perApproved != null ? perApproved * shots : null;
  const capPct = p?.capUsd ? Math.min(100, Math.round((p.spend / p.capUsd) * 100)) : 0;

  /* The shot that has cost more than any approved one and isn't approved. */
  const maxApproved = Math.max(0, ...shotRows.filter((r) => r.state === "Approved").map((r) => r.cost));
  const worry = shotRows.filter((r) => r.state !== "Approved" && r.cost > maxApproved).sort((a, b) => b.cost - a.cost)[0] ?? null;

  const maxProd = Math.max(0.0001, ...(all?.byProject ?? []).map((r) => r.spend));
  const people = focus?.byPerson ?? [];
  const maxPerson = Math.max(0.0001, ...people.map((r) => r.spend));
  const engines = (focus?.byModel ?? []).filter((m) => m.spend > 0).sort((a, b) => b.spend - a.spend);
  const engineTotal = engines.reduce((a, m) => a + m.spend, 0) || 1;
  const shade = (i: number) => (i === 0 ? "var(--color-ink)" : i === 1 ? "rgba(245,246,248,.45)" : "rgba(245,246,248,.2)");

  function exportCsv() {
    const rows: (string | number)[][] = [["section", "name", "renders", "spend_usd"]];
    for (const r of all?.byProject ?? []) rows.push(["production", r.name, r.n, r.spend.toFixed(2)]);
    for (const r of people) rows.push(["person", r.name, r.n, r.spend.toFixed(2)]);
    for (const r of shotRows) rows.push(["shot", r.code, r.n, r.cost.toFixed(2)]);
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `particl-production-${period}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="flex flex-col gap-[30px]">
      <div className="page-head">
        <div>
          <h1 className="page-h1">Production</h1>
          <p className="page-sub">What the job cost, who spent it, and which shot is taking the most takes.</p>
        </div>
        <div className="page-acts items-center">
          <div className="seg" role="tablist">
            {([["month", new Date().toLocaleDateString(undefined, { month: "long" })], ["30", "30 days"], ["quarter", "Quarter"]] as [Period, string][]).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={period === k} className={`seg-opt ${period === k ? "is-on" : ""}`} onClick={() => setPeriod(k)}>{l}</button>
            ))}
          </div>
          <button type="button" className="btn-secondary" onClick={exportCsv} disabled={!all}>Export CSV ↓</button>
        </div>
      </div>

      {!signedIn ? (
        <Empty title="The numbers are for the team" line="Sign in to see what the studio's productions have cost, who spent it, and which shot is taking the most takes." />
      ) : !all ? (
        <Waiting label="Adding it up" />
      ) : (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="tile-l">STUDIO · {periodLabel}</span>
              <span className="tile-v">{usd(all.totals.spend, 2)}</span>
              <span className="tile-s">{all.byProject.length} production{all.byProject.length === 1 ? "" : "s"} · {all.totals.generations} render{all.totals.generations === 1 ? "" : "s"} · {all.totals.people} {all.totals.people === 1 ? "person" : "people"}</span>
            </div>
            <div className="tile">
              <span className="tile-l">{p ? `${p.name.toUpperCase()} · ${p.capUsd ? `OF $${Math.round(p.capUsd)} CAP` : "NO CAP"}` : "PRODUCTION · OF CAP"}</span>
              <span className="tile-v">{p ? usd(p.spend, 2) : "—"}</span>
              {p?.capUsd ? <span className="tile-bar"><span style={{ width: `${capPct}%` }} /></span> : null}
              <span className="tile-s">{p ? `${p.capUsd ? `${capPct}% spent · ` : ""}${approved} of ${shots} shots approved` : "Pick a production in the header to see it against its cap."}</span>
            </div>
            <div className="tile">
              <span className="tile-l">COST PER APPROVED SHOT</span>
              <span className="tile-v">{perApproved != null ? usd(perApproved, 2) : "—"}</span>
              <span className="tile-s">{p ? (approved ? `${p.name} · all takes counted, ${takesPerApproval!.toFixed(1)} takes per approval` : `${p.name} · nothing approved yet`) : "Per production, once one is picked."}</span>
            </div>
            <div className="tile">
              <span className="tile-l">PROJECTED AT THIS RATE</span>
              <span className="tile-v">{projected != null ? usd(projected, 0) : "—"}</span>
              <span className="tile-s">{p && projected != null
                ? `to approve all ${shots} · ${p.capUsd ? (projected <= p.capUsd ? `under cap by ${usd(p.capUsd - projected, 0)}` : `over cap by ${usd(projected - p.capUsd, 0)}`) : "no cap set"}`
                : "Needs one approved shot to project from."}</span>
            </div>
          </div>

          <div className="ugrid">
            <div className="ucard">
              <div className="ucard-h"><span>By production</span><span className="mono-s">{periodLabel} · {usd(all.totals.spend, 2)}</span></div>
              <div className="flex flex-col gap-[9px]">
                {all.byProject.length === 0 && <span className="rail-help">Nothing rendered in this period.</span>}
                {all.byProject.slice().sort((a, b) => b.spend - a.spend).map((r) => (
                  <Link key={r.id ?? "unfiled"} href={r.id ? `/projects/${r.id}/canvas` : "/all"} className="urow">
                    <span className="truncate">{r.id ? r.name : "Unfiled"}</span>
                    <span className="ubar"><span style={{ width: `${Math.max(1, (r.spend / maxProd) * 100)}%`, opacity: r.id ? 1 : .35 }} /></span>
                    <span className="mono-v text-right">{usd(r.spend, 2)}</span>
                  </Link>
                ))}
              </div>
              <span className="rail-help">Unfiled covers test renders made in All projects. File them against a shot and they move to the production.</span>
            </div>
            <div className="ucard">
              <div className="ucard-h"><span>Who spent it</span><span className="mono-s">{focusLabel} · {focus ? usd(focus.totals.spend, 2) : "—"}</span></div>
              <div className="flex flex-col gap-[9px]">
                {people.length === 0 && <span className="rail-help">Nobody has rendered here in this period.</span>}
                {people.slice().sort((a, b) => b.spend - a.spend).map((r) => (
                  <div key={r.id || r.name} className="urow is-person">
                    <span className="flex items-center gap-2 truncate"><span className="ptable-av !ml-0 !h-[22px] !w-[22px] !text-[8.5px]">{initials(r.name)}</span>{r.name} <span className="text-dim">{r.n} render{r.n === 1 ? "" : "s"}</span></span>
                    <span className="ubar"><span style={{ width: `${Math.max(1, (r.spend / maxPerson) * 100)}%` }} /></span>
                    <span className="mono-v text-right">{usd(r.spend, 2)}</span>
                  </div>
                ))}
              </div>
              <span className="rail-help">Anyone on the team renders; the cost is on the button before it is pressed. Change the rule in <Link href="/settings#defaults" className="text-ink">Settings</Link>.</span>
            </div>
          </div>

          <div className="ugrid">
            <div className="ucard">
              <div className="ucard-h"><span>Which shot is taking the most takes</span>{p && <Link href={`/projects/${p.id}/canvas`} className="hdr-mono-link">CANVAS →</Link>}</div>
              <div className="ushot-h"><span>SHOT</span><span>TAKES</span><span className="text-right">STATE</span><span className="text-right">SENT BACK</span><span className="text-right">COST</span></div>
              {!p && <span className="rail-help">Pick a production in the header to see its shots.</span>}
              {p && shotRows.length === 0 && <span className="rail-help">No takes filed against a shot yet.</span>}
              {shotRows.slice(0, 8).map((r) => (
                <Link key={r.code} href="/" className="ushot">
                  <span className="mono-v">{r.code}</span>
                  <span className="flex items-center gap-[3px]">
                    {r.blocks.slice(0, 12).map((b, i) => <span key={i} className={`ublk is-${b}`} />)}
                    <span className="mono-s ml-1.5">{r.n}</span>
                  </span>
                  <span className={`text-right ${r.state === "Approved" ? "text-approved" : r.state === "Draft" ? "text-dim" : ""}`}>{r.state}</span>
                  <span className="text-right text-dim">{r.back || "—"}</span>
                  <span className="mono-v text-right">{usd(r.cost, 2)}</span>
                </Link>
              ))}
              {worry && <span className="rail-help">{worry.code} has cost more than any approved shot and isn&rsquo;t approved yet{worry.back ? ` — ${worry.back} take${worry.back === 1 ? " was" : "s were"} sent back with a note` : ""}.</span>}
            </div>
            <div className="flex flex-col gap-3">
              <div className="ucard">
                <div className="ucard-h"><span>By engine</span><span className="mono-s">{focusLabel}</span></div>
                {engines.length === 0 ? <span className="rail-help">Nothing rendered in this period.</span> : (
                  <>
                    <div className="ueng">{engines.map((m, i) => <span key={m.model} style={{ flex: m.spend / engineTotal, background: shade(i) }} />)}</div>
                    <div className="flex flex-col gap-1.5">
                      {engines.map((m, i) => (
                        <div key={m.model} className="flex justify-between text-[12.5px]">
                          <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-[2px]" style={{ background: shade(i) }} />{m.label} · {PROVIDER_NAMES[getModel(m.model).provider ?? ""] ?? getModel(m.model).provider ?? "—"} <span className="text-dim">{m.n} render{m.n === 1 ? "" : "s"}</span></span>
                          <span className="mono-v">{usd(m.spend, 2)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <div className="ucard !gap-2.5">
                <div className="ucard-h"><span>Written back to Atomik</span><Link href="/atomik/shots" className="hdr-mono-link">SHOT LIST →</Link></div>
                <span className="text-[12.5px] leading-[1.45] text-lead [text-wrap:pretty]">Per shot: state, take count, cost to date and the master&rsquo;s link. The producer sees the same numbers on the shot list as here — one database, nothing to sync.</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
