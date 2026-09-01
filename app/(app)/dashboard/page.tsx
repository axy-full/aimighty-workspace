"use client";

/**
 * R2 — the management dashboard.
 *
 * Separate from Usage on purpose. Usage answers "how much credit is left";
 * this answers "how is production going" — who is spending it, which shots
 * are being fought over, which model-and-size combinations eat the clock,
 * and how the team actually prompts. The deeper cuts are the ones worth
 * having in a post-mortem, so nothing here is per-render noise.
 */
import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { usd, hours, pct } from "@/lib/format";
import {
  type Analytics, Headline, BarList, StuckTable, ShotTable, Patterns,
} from "@/components/Analytics";
import SectionNav from "@/components/SectionNav";

const WINDOWS = [
  { days: 0, label: "All time" },
  { days: 90, label: "90 days" },
  { days: 30, label: "30 days" },
  { days: 7, label: "7 days" },
];

export default function DashboardPage() {
  const [days, setDays] = useState(0);
  const { data } = useApi<Analytics>(`/api/analytics?days=${days}`, 30000);

  if (!data) {
    return (
      <div className="screen grid place-items-center">
        <p className="text-[15px] text-mute">Reading production…</p>
      </div>
    );
  }

  const maxDay = Math.max(...data.byDay.map((d) => d.spend), 0.000001);

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[1120px] pb-10">
        <Headline a={data} title="Production" />

        <div className="mt-5"><SectionNav /></div>

        <div className="mt-5 flex flex-wrap gap-2">
          {WINDOWS.map((w) => (
            <button key={w.days} onClick={() => setDays(w.days)}
              className={`chip ${days === w.days ? "bg-blue text-white" : ""}`}>
              {w.label}
            </button>
          ))}
        </div>

        {/* Spend over time — the shape of a month, not a number */}
        {data.byDay.length > 1 && (
          <section className="card mt-6 px-5 py-5">
            <p className="grouplabel">Spend by day</p>
            <div className="mt-4 flex h-[120px] items-end gap-[3px]">
              {data.byDay.map((d) => (
                <span key={d.day} className="flex min-w-0 flex-1 flex-col justify-end"
                  title={`${new Date(d.day).toLocaleDateString()} — ${usd(d.spend, 2)} · ${d.n} renders`}>
                  <span className="w-full rounded-t-[3px] bg-blue"
                    style={{ height: `${Math.max(2, (d.spend / maxDay) * 110)}px` }} />
                </span>
              ))}
            </div>
            <p className="mt-3 text-[13px] text-mute">
              {new Date(data.byDay[0].day).toLocaleDateString()} — today
            </p>
          </section>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="card px-5 py-5">
            <p className="grouplabel">Spend by project</p>
            <div className="mt-4">
              <BarList empty="Nothing filed to a project yet."
                rows={data.byProject.map((p) => ({
                  key: p.id ?? "unfiled", label: p.name, value: p.spend,
                  note: `${p.n} · ${hours(p.renderMs)}`,
                }))} />
            </div>
          </section>

          <section className="card px-5 py-5">
            <p className="grouplabel">Spend by team member</p>
            <div className="mt-4">
              <BarList empty="No renders yet."
                rows={data.byPerson.map((p) => ({
                  key: p.id || p.name, label: p.name, value: p.spend,
                  note: `${p.n}${p.failed ? ` · ${p.failed} failed` : ""}`,
                }))} />
            </div>
          </section>
        </div>

        <section className="card mt-6 px-5 py-5">
          <p className="grouplabel">Revisions per shot</p>
          <p className="mt-1 text-[13px] text-mute">
            The shots taking the most takes are the ones costing the most schedule.
          </p>
          <div className="mt-4"><ShotTable rows={data.byShot} /></div>
        </section>

        <section className="card mt-6 px-5 py-5">
          <p className="grouplabel">By category</p>
          <p className="mt-1 text-[13px] text-mute">
            Whether a music video behaves like a TVC — the axis a producer
            quotes from. Set a project&rsquo;s category on its overview.
          </p>
          <div className="mt-4">
            <BarList empty="No categories set yet."
              rows={data.byCategory.map((c) => ({
                key: c.category, label: c.category, value: c.spend,
                note: `${c.n} · ${c.projects} project${c.projects === 1 ? "" : "s"}`,
              }))} />
          </div>
        </section>

        <section className="card mt-6 px-5 py-5">
          <p className="grouplabel">Where renders get stuck</p>
          <p className="mt-1 text-[13px] text-mute">
            Wall-clock from submit to delivery, by model and output size.
          </p>
          <div className="mt-4"><StuckTable rows={data.stuck} /></div>
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="card px-5 py-5">
            <p className="grouplabel">How we prompt</p>
            <div className="mt-4"><Patterns a={data} /></div>
          </section>

          <section className="card px-5 py-5">
            <p className="grouplabel">By model</p>
            <div className="mt-4">
              <BarList empty="No renders yet."
                rows={data.byModel.map((m) => ({
                  key: m.model, label: m.label, value: m.spend,
                  note: `${m.n}${m.failed ? ` · ${m.failed} failed` : ""}`,
                }))} />
            </div>
            <p className="mt-5 text-[13px] text-mute">
              Credit {usd(data.credit.toppedUp, 2)} recorded · {usd(data.credit.spentAllTime, 2)} spent
              all time · {pct(data.totals.successRate)} of renders delivered.
            </p>
          </section>
        </div>

        <p className="mt-8 text-center text-[13px] text-mute">
          Per-project detail lives on each project&rsquo;s overview.{" "}
          <Link href="/" className="text-blue">Projects</Link>
        </p>
      </div>
    </div>
  );
}
