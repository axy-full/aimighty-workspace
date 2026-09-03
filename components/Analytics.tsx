"use client";

/**
 * The numbers, shared by the project overview (R1) and the management
 * dashboard (R2). One shape of data, two framings: a project asks "what did
 * this cost us", the dashboard asks "where is production getting stuck".
 */
import { usd, compactTokens, hours, dur, pct } from "@/lib/format";

export type Analytics = {
  scope: { projectId: string; days: number };
  totals: {
    generations: number; succeeded: number; failed: number; pending: number;
    binned: number; spend: number; promptSpend: number; prompts: number;
    tokens: number; renderMs: number;
    people: number; shots: number; successRate: number;
  };
  credit: { toppedUp: number; spentAllTime: number };
  byProject: { id: string | null; name: string; n: number; spend: number;
               failed: number; people: number; renderMs: number }[];
  byPerson: { id: string; name: string; n: number; spend: number;
              failed: number; projects: number }[];
  byModel: { model: string; label: string; n: number; spend: number;
             failed: number; avgMs: number | null }[];
  byShot: { id: string; code: string; scene: string; title: string; status: string;
            takes: number; spend: number; ok: number; failed: number; latest: number }[];
  byStatus: { status: string; n: number }[];
  byDay: { day: number; n: number; spend: number }[];
  stuck: { model: string; resolution: string; n: number; avgMs: number | null;
           maxMs: number; failed: number; retried: number }[];
  byCategory: { category: string; n: number; spend: number; failed: number;
                avgMs: number | null; projects: number; shots: number }[];
  patterns: {
    avgPromptLength: number; refined: number; withCast: number;
    withReferences: number; filedToShots: number; unfiled: number;
    takesPerShot: number;
  };
};

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card px-4 py-4 sm:px-5">
      <p className="grouplabel">{label}</p>
      <p className="mt-1 text-[clamp(22px,6vw,28px)] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink">
        {value}
      </p>
      {sub && <p className="mt-1.5 text-[12.5px] leading-snug text-mute sm:text-[13px]">{sub}</p>}
    </div>
  );
}

/** A labelled bar list — the same shape for projects, people and models. */
export function BarList({ rows, empty }: {
  rows: { key: string; label: string; value: number; note?: string }[];
  empty: string;
}) {
  if (!rows.length) return <p className="px-4 py-6 text-center text-[14px] text-mute">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 0.000001);
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => (
        <div key={r.key}>
          <div className="flex items-baseline gap-3 text-[14px]">
            <span className="min-w-0 flex-1 truncate text-ink">{r.label}</span>
            {r.note && <span className="text-[12px] tabular-nums text-mute">{r.note}</span>}
            <span className="tabular-nums text-dim">{usd(r.value, 2)}</span>
          </div>
          <div className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-chip">
            <span className="block h-full rounded-full bg-blue"
                  style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Headline({ a, title }: { a: Analytics; title: string }) {
  const t = a.totals;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pt-6">
        <h1 className="h1">{title}</h1>
        {t.pending > 0 && (
          <span className="chip">{t.pending} rendering</span>
        )}
      </div>
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cost" value={usd(t.spend, 2)}
              sub={`${compactTokens(t.tokens)} tokens · all-in, refinement included`} />
        <Stat label="Generations" value={String(t.generations)}
              sub={`${t.succeeded} delivered · ${t.failed} failed${t.binned ? ` · ${t.binned} binned` : ""}`} />
        <Stat label="Shots" value={String(t.shots)}
              sub={t.shots ? `${a.patterns.takesPerShot.toFixed(1)} takes per shot` : "none filed yet"} />
        <Stat label="Render time" value={hours(t.renderMs)}
              sub={`${t.people} ${t.people === 1 ? "person" : "people"} · ${pct(t.successRate)} first-pass success`} />
      </div>
    </>
  );
}

/** R2's headline question: which setups are eating the schedule? */
export function StuckTable({ rows }: { rows: Analytics["stuck"] }) {
  if (!rows.length) {
    return <p className="px-4 py-6 text-center text-[14px] text-mute">Nothing has run yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-[14px]">
        <thead>
          <tr className="text-left text-[12px] uppercase tracking-wide text-mute">
            <th className="pb-2 font-medium">Model · size</th>
            <th className="pb-2 text-right font-medium">Runs</th>
            <th className="pb-2 text-right font-medium">Average</th>
            <th className="pb-2 text-right font-medium">Slowest</th>
            <th className="pb-2 text-right font-medium">Failed</th>
            <th className="pb-2 text-right font-medium">Retried</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.model}-${r.resolution}-${i}`} className="border-t border-hair">
              <td className="py-2.5 pr-3">
                {r.model} <span className="text-mute">{r.resolution}</span>
              </td>
              <td className="py-2.5 text-right tabular-nums text-dim">{r.n}</td>
              <td className="py-2.5 text-right tabular-nums text-ink">{dur(r.avgMs)}</td>
              <td className="py-2.5 text-right tabular-nums text-dim">{dur(r.maxMs)}</td>
              <td className={`py-2.5 text-right tabular-nums ${r.failed ? "text-lift" : "text-mute"}`}>
                {r.failed || "—"}
              </td>
              <td className={`py-2.5 text-right tabular-nums ${r.retried ? "text-lift" : "text-mute"}`}>
                {r.retried || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Revisions per shot — which setup is fighting us. */
export function ShotTable({ rows }: { rows: Analytics["byShot"] }) {
  if (!rows.length) {
    return (
      <p className="px-4 py-6 text-center text-[14px] text-mute">
        No renders filed against a shot yet. File one from the composer and the
        revision count starts here.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[400px] text-[14px]">
        <thead>
          <tr className="text-left text-[12px] uppercase tracking-wide text-mute">
            <th className="pb-2 font-medium">Shot</th>
            <th className="pb-2 text-right font-medium">Takes</th>
            <th className="pb-2 text-right font-medium">Delivered</th>
            <th className="pb-2 text-right font-medium">Failed</th>
            <th className="pb-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-hair">
              <td className="py-2.5 pr-3">
                <span className="font-medium text-ink">{r.scene ? `${r.scene} · ` : ""}{r.code}</span>
                {r.title && <span className="ml-2 text-mute">{r.title}</span>}
              </td>
              <td className="py-2.5 text-right tabular-nums text-ink">{r.takes}</td>
              <td className="py-2.5 text-right tabular-nums text-dim">{r.ok}</td>
              <td className={`py-2.5 text-right tabular-nums ${r.failed ? "text-lift" : "text-mute"}`}>
                {r.failed || "—"}
              </td>
              <td className="py-2.5 text-right tabular-nums text-dim">{usd(r.spend, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Patterns({ a }: { a: Analytics }) {
  const p = a.patterns;
  const n = a.totals.generations || 1;
  const rows: [string, string][] = [
    ["Average prompt", `${p.avgPromptLength} characters`],
    ["Auto-refined", `${p.refined} of ${a.totals.generations} (${pct(p.refined / n)})`],
    ["Used the cast", `${p.withCast} (${pct(p.withCast / n)})`],
    ["Carried references", `${p.withReferences} (${pct(p.withReferences / n)})`],
    ["Filed to a shot", `${p.filedToShots} · ${p.unfiled} unfiled`],
    ["Takes per shot", p.takesPerShot ? p.takesPerShot.toFixed(1) : "—"],
  ];
  return (
    <div className="rows">
      {rows.map(([k, v]) => (
        <div key={k} className="row">
          <span>{k}</span>
          <span className="row-value tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  );
}
