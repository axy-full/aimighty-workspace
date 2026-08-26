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
  byMonth: { month: string; n: number; spend: number }[];
  recent: { id: string; label: string; prompt: string; costUsd: number;
            totalTokens: number; params: Record<string, unknown>; createdAt: number }[];
};

export default function UsagePage() {
  const { data, refresh } = useApi<Usage>("/api/usage", 20000);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  async function addTopup() {
    const v = Number(amount);
    if (!Number.isFinite(v) || v === 0) return;
    await fetch("/api/topups", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd: v, note }),
    });
    setAmount(""); setNote(""); refresh();
  }

  if (!data) {
    return (
      <div className="desk-grid grid h-full place-items-center">
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
    <div className="flex h-full min-h-0 flex-col">
      {/* Ledger toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-chrome px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="lbl shrink-0">Record top-up</span>
        <input
          className="ctl w-[110px] shrink-0" value={amount} inputMode="decimal" placeholder="USD"
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addTopup()}
        />
        <input
          className="ctl w-[240px] shrink-0" value={note} placeholder="Note / invoice ref"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addTopup()}
        />
        <button
          onClick={addTopup}
          className="ptitle h-[30px] shrink-0 rounded-[3px] border border-line bg-panel2 px-3 text-[10.5px] tracking-[.1em] text-dim hover:border-lift hover:text-lift"
        >
          Add
        </button>
        <span className="ml-auto shrink-0 pl-3 font-mono text-[9.5px] tracking-wider text-mute">
          ACTUALS FROM RETURNED TOKENS
          {ACCOUNT_DISCOUNT > 0 && (
            <>
              <span className="mx-2 text-line">│</span>
              <span className="text-ok">ACCOUNT −{Math.round(ACCOUNT_DISCOUNT * 100)}%</span>
            </>
          )}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.purchasedUsd === 0 && (
          <div className="border-b border-line bg-panel2 px-3 py-2.5">
            <p className="text-[12.5px] leading-relaxed text-bone/90">
              <span className="ptitle text-[11px] tracking-[.08em] text-lift">No credit recorded yet.</span>{" "}
              BytePlus doesn&apos;t publish your account balance over the API, so this page can&apos;t read it
              automatically. Enter what you&apos;ve loaded — e.g. <span className="font-mono text-lift">50</span> —
              in the bar above and it will count down from there using the real cost of every render.
            </p>
          </div>
        )}

        {/* Hero readouts — magnitude with no comparison, so tiles not charts */}
        <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Credit remaining"
            value={data.purchasedUsd > 0 ? usd(data.remainingUsd, 2) : "—"}
            sub={data.purchasedUsd > 0
              ? `of ${usd(data.purchasedUsd, 2)} recorded`
              : "record your top-up above ↑"}
            accent />
          <Stat label="Spent all time" value={usd(data.spentUsd, 2)}
                sub={`${data.succeeded} finished renders`} />
          <Stat label="Average per clip" value={usd(data.avgCostUsd)}
                sub={`${compactTokens(data.totalTokens)} tokens billed`} />
          <Stat label="Renders" value={String(data.totalGenerations).padStart(2, "0")}
                sub={`${data.pending} queued · ${data.failed} failed`} />
        </div>

        <div className="grid gap-2.5 p-2.5">
          <Panel title="Credit drawdown" right={
            <span className="font-mono text-[9.5px] tracking-wider text-dim">
              {data.purchasedUsd > 0 ? `${usedPct.toFixed(1)}% USED` : "NO TOP-UP RECORDED"}
            </span>
          }>
            <div className="p-3">
              <div className="h-2 w-full bg-panel3">
                <div className="h-full bg-lift transition-[width] duration-700" style={{ width: `${usedPct}%` }} />
              </div>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-mute">
                BytePlus&apos;s billing API reports spend, never remaining balance — so the
                starting figure is entered here once and drawn down against the actual
                token cost of every finished render.
              </p>
            </div>
          </Panel>

          <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
            <Panel title="Spend by model">
              <Rows rows={data.byModel.map((m) => ({
                key: m.model, name: m.label,
                meta: `${m.n} clips · ${compactTokens(m.tokens)} tokens`,
                value: m.spend, max: maxModel,
              }))} />
            </Panel>
            <Panel title="Spend by bin">
              <Rows rows={data.byProject.map((p) => ({
                key: p.name, name: p.name,
                meta: `${p.n} clip${p.n === 1 ? "" : "s"}`,
                value: p.spend, max: maxProject,
              }))} />
            </Panel>
            <Panel title="Spend by person">
              <Rows rows={data.byPerson.map((p) => ({
                key: p.name, name: p.name,
                meta: `${p.n} clip${p.n === 1 ? "" : "s"}`,
                value: p.spend, max: maxPerson,
              }))} />
            </Panel>
            <Panel title="Spend by month">
              <Rows rows={data.byMonth.map((m) => ({
                key: m.month, name: m.month,
                meta: `${m.n} clip${m.n === 1 ? "" : "s"}`,
                value: m.spend, max: maxMonth,
              }))} />
            </Panel>
          </div>


          <Panel title="Cost per render">
            {data.recent.length === 0 ? (
              <p className="py-8 text-center font-mono text-[10.5px] tracking-wider text-mute">
                NO FINISHED RENDERS
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-[11.5px]">
                  <thead>
                    <tr className="border-b border-line text-left">
                      {["Prompt", "Model", "Format", "Tokens", "Cost", "When"].map((h, i) => (
                        <th key={h} className={`lbl px-2.5 py-2 font-normal ${i > 2 ? "text-right" : ""}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r) => {
                      const p = r.params as { resolution?: string; ratio?: string; duration?: number };
                      return (
                        <tr key={r.id} className="border-b border-hair last:border-0 hover:bg-panel2">
                          <td className="max-w-[300px] truncate px-2.5 py-1.5 text-bone/85" title={r.prompt}>
                            {r.prompt}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-dim">{r.label}</td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[10.5px] text-mute">
                            {[p.resolution, p.ratio, p.duration && `${p.duration}s`].filter(Boolean).join(" · ")}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono text-[10.5px] tabular-nums text-mute">
                            {compactTokens(r.totalTokens)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono text-[10.5px] tabular-nums text-bone">
                            {usd(r.costUsd)}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-right font-mono text-[10.5px] text-mute">
                            {timeAgo(r.createdAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: boolean;
}) {
  return (
    <div className="relative bg-panel px-3.5 py-3">
      {accent && <span className="absolute left-0 top-0 h-full w-[2px] bg-lift" />}
      <p className="lbl">{label}</p>
      <p className={`ptitle mt-1.5 text-[26px] leading-none tabular-nums ${accent ? "text-lift" : "text-bone"}`}>
        {value}
      </p>
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
    <ul className="flex flex-col gap-2.5 p-3">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[12.5px] text-bone/90">{r.name}</span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-bone">{usd(r.value, 2)}</span>
          </div>
          <Bar value={r.value} max={r.max} title={`${r.name} — ${usd(r.value, 2)}`} />
          <span className="font-mono text-[9.5px] text-mute">{r.meta}</span>
        </li>
      ))}
    </ul>
  );
}
