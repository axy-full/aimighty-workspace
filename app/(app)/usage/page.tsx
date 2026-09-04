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
import SectionNav from "@/components/SectionNav";
import { Waiting, Trouble } from "@/components/ParticlMark";
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

  /* Daily spend for the current month, from the finished renders we have. */
  const days = useMemo(() => {
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const buckets = new Map<number, number>();
    for (const r of data?.recent ?? []) {
      const d = new Date(r.createdAt);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (k !== key) continue;
      buckets.set(d.getDate(), (buckets.get(d.getDate()) ?? 0) + r.costUsd);
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  }, [data]);

  const monthLabel = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });

  usePageTitle("Usage");
  if (!data) return error ? <Trouble label="The ledger didn't load" detail={error} onRetry={refresh} /> : <Waiting label="Reading the ledgers" />;

  const maxDay = Math.max(...days.map(([, v]) => v), 0.0001);
  const monthSpend = days.reduce((a, [, v]) => a + v, 0);
  const vendorName = (id: string) => data.vendors.find((v) => v.id === id)?.label ?? id;
  const recent = vendorFilter === "all" ? data.recent : data.recent.filter((r) => r.provider === vendorFilter);

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[1120px]">
        <div className="flex flex-wrap items-center gap-4 pt-6">
          <h1 className="h1">Usage</h1>
          <SectionNav />
          <span className="ml-auto text-[15px] text-dim">{monthLabel}</span>
        </div>

        {/* The number, and the month it belongs to */}
        <div className="mt-8">
          <p className="text-[clamp(52px,7vw,88px)] font-bold leading-none tracking-[-0.04em] text-ink tabular-nums">
            {usd(data.spentUsd, 2)}
          </p>
          <p className="mt-3 text-[16px] text-dim">
            spent all time, across every vendor
            {data.promptSpendUsd > 0 && <> · of which prompts {usd(data.promptSpendUsd, 3)}</>}
            {" "}· each vendor&rsquo;s credit counts down on its own below
          </p>

          {days.length > 0 ? (
            <div className="max-w-[720px]">
              <div className="mt-8 flex h-[150px] items-end gap-[6px]">
                {days.map(([day, v]) => (
                  <span key={day} className="flex min-w-0 flex-1 flex-col items-center gap-2"
                    title={`${day} — ${usd(v, 2)}`}>
                    <span className="w-full rounded-full bg-blue transition-all"
                      style={{ height: `${Math.max(4, (v / maxDay) * 120)}px`, maxWidth: 10 }} />
                  </span>
                ))}
              </div>
              <div className="mt-3 flex gap-[6px] border-t border-hair pt-2">
                {days.map(([day]) => (
                  <span key={day} className="min-w-0 flex-1 text-center text-[12px] tabular-nums text-mute">{day}</span>
                ))}
              </div>
              <p className="mt-3 text-[13px] text-mute">
                {monthLabel} · {usd(monthSpend, 2)} across {days.length} day{days.length === 1 ? "" : "s"}
                <span className="ml-1">(from the most recent renders)</span>
              </p>
            </div>
          ) : (
            <p className="mt-8 max-w-[720px] rounded-[var(--r)] bg-panel2 px-4 py-6 text-center text-[14px] text-mute">
              No finished renders this month yet.
            </p>
          )}
        </div>

        {/* ── The ledgers ── */}
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
                className={`chip !py-1 !text-[12.5px] ${vendorFilter === k ? "bg-blue text-white" : ""}`}>{l}</button>
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
