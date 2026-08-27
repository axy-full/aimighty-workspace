"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { usd, compactTokens, timeAgo } from "@/lib/format";
import Bar from "@/components/Bar";
import { ACCOUNT_DISCOUNT } from "@/lib/models";
import { Panel } from "@/components/Panel";

type Usage = {
  purchasedUsd: number; spentUsd: number; remainingUsd: number;
  totalGenerations: number; succeeded: number; failed: number; pending: number;
  totalTokens: number; avgCostUsd: number;
  byModel: { model: string; label: string; n: number; spend: number; tokens: number }[];
  byProject: { name: string; n: number; spend: number }[];
  byPerson: { name: string; n: number; spend: number }[];
  refines: { model: string; n: number; tokens: number; spend: number; freeLeft: number }[];
  byMonth: { month: string; n: number; spend: number }[];
  recent: { id: string; label: string; prompt: string; costUsd: number;
            totalTokens: number; params: Record<string, unknown>; createdAt: number }[];
};

export default function UsagePage() {
  const { data, refresh } = useApi<Usage>("/api/usage", 20000);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [topupBusy, setTopupBusy] = useState(false);
  const [topupErr, setTopupErr] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);

  async function addTopup() {
    const v = Number(amount);
    if (!Number.isFinite(v) || v === 0 || topupBusy) return;
    setTopupBusy(true); setTopupErr(null);
    try {
      const res = await fetch("/api/topups", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountUsd: v, note }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not record the top-up");
      setAmount(""); setNote("");
      refresh();
    } catch (e) {
      setTopupErr((e as Error).message);
    } finally {
      setTopupBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="grid h-full place-items-center">
        <p className="font-mono text-[10.5px] tracking-[.14em] text-mute">READING LEDGER…</p>
      </div>
    );
  }

  const usedPct = data.purchasedUsd > 0
    ? Math.min((data.spentUsd / data.purchasedUsd) * 100, 100) : 0;
  const maxModel   = Math.max(...data.byModel.map((m) => m.spend), 0.0001);
  const maxProject = Math.max(...data.byProject.map((p) => p.spend), 0.0001);
  const maxPerson  = Math.max(...data.byPerson.map((p) => p.spend), 0.0001);
  const maxMonth   = Math.max(...data.byMonth.map((m) => m.spend), 0.0001);

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5 max-[860px]:px-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="ptitle text-[20px] leading-tight">Usage</span>
          <span className="text-[12px] text-dim">
            Dollars per generation, tracked from returned tokens
            {ACCOUNT_DISCOUNT > 0 && (
              <span className="text-ok"> · account −{Math.round(ACCOUNT_DISCOUNT * 100)}%</span>
            )}
          </span>
        </span>
        <span className="ml-auto" />
        <div className="flex flex-wrap items-center gap-2 max-[860px]:w-full">
          <span className="lbl shrink-0">Record top-up</span>
          <input
            className="ctl w-[92px] font-mono text-[11.5px]" value={amount} inputMode="decimal" placeholder="USD"
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTopup()}
          />
          <input
            className="ctl w-[180px] max-[860px]:order-last max-[860px]:w-full" value={note} placeholder="Note / invoice ref"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTopup()}
          />
          <button onClick={addTopup} disabled={topupBusy} className="chip !py-[7px] font-medium">
            {topupBusy ? "…" : "Add"}
          </button>
        </div>
        {topupErr && (
          <span className="w-full font-mono text-[9.5px] text-lift">{topupErr}</span>
        )}
      </div>

      {data.purchasedUsd === 0 && (
        <div className="mt-4 rounded-[var(--r)] border border-line bg-panel px-4 py-3">
          <p className="text-[12.5px] leading-relaxed text-bone/90">
            <span className="font-semibold text-lift">No credit recorded yet.</span>{" "}
            BytePlus doesn&apos;t publish your account balance over the API, so this page can&apos;t read it
            automatically. Enter what you&apos;ve loaded — e.g. <span className="font-mono text-lift">50</span> —
            above and it will count down from there using the real cost of every render.
          </p>
        </div>
      )}

      {/* Hero readouts — the design's stat cards */}
      <div className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <Stat
          label="Credit remaining"
          value={data.purchasedUsd > 0 ? usd(data.remainingUsd, 2) : "—"}
          sub={data.purchasedUsd > 0
            ? `${usd(data.spentUsd, 2)} of ${usd(data.purchasedUsd, 2)} used`
            : "record your top-up above ↑"}
          accent
        >
          {data.purchasedUsd > 0 && (
            <div className="mt-2.5 h-1 overflow-hidden rounded-[2px] bg-chip">
              <div className="h-full rounded-[2px] bg-red transition-[width] duration-700" style={{ width: `${usedPct}%` }} />
            </div>
          )}
        </Stat>
        <Stat label="Spent all time" value={usd(data.spentUsd, 2)}
              sub={`${data.succeeded} finished renders`} />
        <Stat label="Average per clip" value={usd(data.avgCostUsd)}
              sub={`${compactTokens(data.totalTokens)} tokens billed`} />
        <Stat label="Renders" value={String(data.totalGenerations).padStart(2, "0")}
              sub={`${data.pending} queued · ${data.failed} failed`} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        <Panel title="By project" right={
          <span className="font-mono text-[9px] tracking-wider text-mute">
            DELETED CLIPS STAY COUNTED
          </span>
        }>
          <Rows rows={data.byProject.map((p) => ({
            key: p.name, name: p.name,
            meta: `${p.n} clip${p.n === 1 ? "" : "s"}`,
            value: p.spend, max: maxProject,
          }))} />
        </Panel>
        <Panel title="By model">
          <Rows rows={data.byModel.map((m) => ({
            key: m.model, name: m.label,
            meta: `${m.n} clips · ${compactTokens(m.tokens)} tokens`,
            value: m.spend, max: maxModel,
          }))} />
        </Panel>
        <Panel title="By member">
          <Rows rows={data.byPerson.map((p) => ({
            key: p.name, name: p.name,
            meta: `${p.n} clip${p.n === 1 ? "" : "s"}`,
            value: p.spend, max: maxPerson,
          }))} />
        </Panel>
        {data.refines.length > 0 && (
          <Panel title="Prompt refinement" right={
            <span className="font-mono text-[9px] tracking-wider text-mute">
              FIRST 500K TOKENS PER MODEL FREE
            </span>
          }>
            <ul className="flex flex-col gap-3 p-4">
              {data.refines.map((r) => (
                <li key={r.model} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[12.5px] text-dim">{r.model}</span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-bone">
                      {r.spend > 0 ? usd(r.spend, 3) : "free"}
                    </span>
                  </div>
                  <div className="h-[3px] w-full overflow-hidden rounded-[2px] bg-chip" title={`${compactTokens(r.tokens)} of 500k free tokens used`}>
                    <div className={`h-full rounded-[2px] ${r.freeLeft === 0 ? "bg-warn" : "bg-red"}`}
                      style={{ width: `${Math.min(100, (r.tokens / 500000) * 100)}%` }} />
                  </div>
                  <span className="font-mono text-[9.5px] text-mute">
                    {r.n} refine{r.n === 1 ? "" : "s"} · {compactTokens(r.tokens)} tokens ·{" "}
                    {r.freeLeft > 0 ? `${compactTokens(r.freeLeft)} free left` : "free allowance used — billing at list"}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        <Panel title="By month">
          <Rows rows={data.byMonth.map((m) => ({
            key: m.month, name: m.month,
            meta: `${m.n} clip${m.n === 1 ? "" : "s"}`,
            value: m.spend, max: maxMonth,
          }))} />
        </Panel>
      </div>

      <Panel title="Cost per render" className="mt-3">
        {data.recent.length === 0 ? (
          <p className="py-8 text-center font-mono text-[10.5px] tracking-wider text-mute">
            NO FINISHED RENDERS
          </p>
        ) : (
          <>
          {/* Phones: two-line cards instead of a sideways-scrolling ledger.
              Tapping a row unfurls the full prompt. */}
          <ul className="hidden divide-y divide-hair max-[860px]:block">
            {data.recent.map((r) => {
              const p = r.params as { resolution?: string; ratio?: string; duration?: number };
              const open = openRow === r.id;
              return (
                <li key={r.id}>
                  <button
                    onClick={() => setOpenRow(open ? null : r.id)}
                    className="block w-full px-4 py-2.5 text-left"
                  >
                    <span className="flex items-baseline gap-3">
                      <span className={`min-w-0 flex-1 text-[12px] leading-snug text-bone/90 ${open ? "" : "truncate"}`}>
                        {r.prompt}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-bone">{usd(r.costUsd)}</span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-mute">
                      <span className="rounded-[5px] bg-chip px-1.5 py-px text-dim">{r.label}</span>
                      <span>{[p.resolution, p.ratio, p.duration && `${p.duration}s`].filter(Boolean).join(" · ")}</span>
                      <span>{compactTokens(r.totalTokens)}t</span>
                      <span className="ml-auto">{timeAgo(r.createdAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="overflow-x-auto max-[860px]:hidden">
            <table className="w-full min-w-[640px] border-collapse text-[11.5px]">
              <thead>
                <tr className="text-left">
                  {["Generation", "Model", "Spec", "Tokens", "Cost", "When"].map((h, i) => (
                    <th key={h} className={`lbl px-4 py-2.5 font-normal ${i > 2 ? "text-right" : ""}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => {
                  const p = r.params as { resolution?: string; ratio?: string; duration?: number };
                  return (
                    <tr key={r.id} className="border-t border-hair hover:bg-chip/60">
                      <td className="max-w-[300px] truncate px-4 py-2 font-medium text-bone/90" title={r.prompt}>
                        {r.prompt}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <span className="rounded-[5px] bg-chip px-1.5 py-px font-mono text-[10px] text-dim">{r.label}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-[10.5px] text-dim">
                        {[p.resolution, p.ratio, p.duration && `${p.duration}s`].filter(Boolean).join(" · ")}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[10.5px] tabular-nums text-mute">
                        {compactTokens(r.totalTokens)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-bone">
                        {usd(r.costUsd)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right font-mono text-[10.5px] text-mute">
                        {timeAgo(r.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Panel>
    </div>
  );
}

function Stat({ label, value, sub, accent, children }: {
  label: string; value: string; sub?: string; accent?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--r)] border border-line bg-panel px-4 py-3.5">
      <p className="lbl">{label}</p>
      <p className={`ptitle mt-1.5 text-[24px] leading-none tabular-nums tracking-[-0.02em] ${accent ? "text-lift" : "text-bone"}`}>
        {value}
      </p>
      {children}
      {sub && <p className="mt-1.5 font-mono text-[9.5px] text-mute">{sub}</p>}
    </div>
  );
}

function Rows({ rows }: {
  rows: { key: string; name: string; meta: string; value: number; max: number }[];
}) {
  if (!rows.length) {
    return (
      <p className="py-8 text-center font-mono text-[10.5px] tracking-wider text-mute">
        NOTHING RECORDED
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3 p-4">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[12.5px] text-dim">{r.name}</span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-bone">{usd(r.value, 2)}</span>
          </div>
          <Bar value={r.value} max={r.max} title={`${r.name} — ${usd(r.value, 2)}`} />
          <span className="font-mono text-[9.5px] text-mute">{r.meta}</span>
        </li>
      ))}
    </ul>
  );
}
