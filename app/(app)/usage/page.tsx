"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { usd, compactTokens, timeAgo } from "@/lib/format";
import { shortLabel } from "@/lib/models";
import SectionNav from "@/components/SectionNav";
import { Waiting } from "@/components/ParticlMark";
import { usePageTitle } from "@/lib/usePageTitle";

type Usage = {
  purchasedUsd: number; spentUsd: number; remainingUsd: number;
  totalGenerations: number; succeeded: number; failed: number; pending: number;
  totalTokens: number; avgCostUsd: number;
  /** The prompt writer's share of spentUsd, and how many prompts it wrote. */
  promptSpendUsd: number; promptCount: number;
  byModel: { model: string; label: string; n: number; spend: number; promptSpend: number; tokens: number }[];
  byProject: { name: string; n: number; spend: number }[];
  byPerson: { name: string; n: number; spend: number }[];
  refines: { model: string; label: string; n: number; inTokens: number; outTokens: number;
             tokens: number; spend: number; free: boolean; freeLeft: number }[];
  byMonth: { month: string; n: number; spend: number }[];
  recent: { id: string; label: string; prompt: string; costUsd: number; renderCostUsd: number;
            refineCostUsd: number | null; refineModel: string | null; refineLabel: string | null;
            refineInTokens: number | null; refineOutTokens: number | null;
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
  if (!data) return <Waiting label="Reading the ledger" />;

  const maxDay = Math.max(...days.map(([, v]) => v), 0.0001);
  const monthSpend = days.reduce((a, [, v]) => a + v, 0);

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[1120px]">
        <div className="flex flex-wrap items-center gap-4 pt-6">
          <h1 className="h1">Usage</h1>
          <SectionNav />
          <span className="ml-auto text-[15px] text-dim">{monthLabel}</span>
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
          {/* The number, and the month it belongs to */}
          <div>
            <p className="text-[clamp(52px,7vw,88px)] font-bold leading-none tracking-[-0.04em] text-ink tabular-nums">
              {usd(data.spentUsd, 2)}
            </p>
            <p className="mt-3 text-[16px] text-dim">
              spent all time
              {data.purchasedUsd > 0 && <> · credit {usd(data.purchasedUsd, 2)}</>}
              {data.promptSpendUsd > 0 && <> · prompts {usd(data.promptSpendUsd, 3)}</>}
            </p>

            {days.length > 0 ? (
              <>
                <div className="mt-10 flex h-[180px] items-end gap-[6px]">
                  {days.map(([day, v]) => (
                    <span key={day} className="flex min-w-0 flex-1 flex-col items-center gap-2"
                      title={`${day} — ${usd(v, 2)}`}>
                      <span className="w-full rounded-full bg-blue transition-all"
                        style={{ height: `${Math.max(4, (v / maxDay) * 150)}px`, maxWidth: 10 }} />
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex gap-[6px] border-t border-hair pt-2">
                  {days.map(([day]) => (
                    <span key={day} className="min-w-0 flex-1 text-center text-[12px] tabular-nums text-mute">
                      {day}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-[13px] text-mute">
                  {monthLabel} · {usd(monthSpend, 2)} across {days.length} day{days.length === 1 ? "" : "s"}
                  <span className="ml-1">(from the most recent renders)</span>
                </p>
              </>
            ) : (
              <p className="mt-10 rounded-[var(--r)] bg-panel2 px-4 py-6 text-center text-[14px] text-mute">
                No finished renders this month yet.
              </p>
            )}
          </div>

          {/* Where it went */}
          <div className="flex flex-col gap-4">
            <div className="rows">
              {data.byModel.map((m) => (
                <div key={m.model} className="row">
                  <span className="truncate">{m.label}</span>
                  <span className="row-value tabular-nums">{usd(m.spend, 2)}</span>
                </div>
              ))}
              {data.byModel.length === 0 && (
                <div className="row text-dim">No spend recorded yet</div>
              )}
              <div className="row">
                <span className="font-medium text-blue">Remaining</span>
                <span className={`row-value font-semibold tabular-nums ${
                  data.remainingUsd < 0 ? "!text-lift" : "!text-blue"}`}>
                  {data.purchasedUsd > 0 ? usd(data.remainingUsd, 2) : "—"}
                </span>
              </div>
            </div>

            <p className="grouplabel">Record a top-up</p>
            <div className="rows">
              <div className="row">
                <input
                  className="ctl !bg-transparent !px-0" value={amount} inputMode="decimal"
                  placeholder="Amount in USD"
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addTopup()}
                />
              </div>
              <div className="row">
                <input
                  className="ctl !bg-transparent !px-0" value={note} placeholder="Note or invoice reference"
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addTopup()}
                />
              </div>
              <button className="row justify-center !text-blue" onClick={addTopup} disabled={topupBusy}>
                {topupBusy ? "Recording…" : "Add to credit"}
              </button>
            </div>
            {topupErr && <p className="px-[18px] text-[13px] text-lift">{topupErr}</p>}
            {data.purchasedUsd === 0 && (
              <p className="px-[18px] text-[13px] leading-relaxed text-mute">
                BytePlus doesn&apos;t publish a balance over the API. Enter what you&apos;ve
                loaded and it counts down using the real cost of every render.
              </p>
            )}
          </div>
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
              Every prompt&rsquo;s cost is part of its render&rsquo;s total wherever a total is shown.
              A prompt written for a render that then failed still counts.
            </p>
          </>
        )}

        <p className="grouplabel mt-12">Cost per render</p>
        <div className="rows">
          {data.recent.length === 0 && <div className="row text-dim">No finished renders yet</div>}
          {data.recent.map((r) => {
            const p = r.params as { resolution?: string; ratio?: string; duration?: number };
            const open = openRow === r.id;
            return (
              <button key={r.id} className="row !items-start" onClick={() => setOpenRow(open ? null : r.id)}>
                <span className="flex min-w-0 flex-col">
                  <span className={`text-[15px] ${open ? "" : "truncate"}`}>{r.prompt}</span>
                  <span className="mt-0.5 text-[13px] text-mute">
                    {shortLabel(r.label) === r.label ? r.label : r.label} ·{" "}
                    {[p.resolution, p.ratio, p.duration && `${p.duration}s`].filter(Boolean).join(" · ")} ·{" "}
                    {compactTokens(r.totalTokens)}t · {timeAgo(r.createdAt)}
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
          Every figure comes from the tokens ByteDance actually billed. Deleted renders stay counted.
        </p>
      </div>
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
