"use client";

import { use, useMemo } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import { usePageTitle } from "@/lib/usePageTitle";
import { Waiting, Trouble, Empty } from "@/components/ParticlMark";
import type { Statement, StatementLine } from "@/lib/statements";

/**
 * A statement on paper: one month, itemised by production, shot and take,
 * in the workspace's unit, with the packs bought that month as the one
 * dollar line. Print it, or take the CSV.
 */
const monthLabel = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
};
const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export default function StatementPage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = use(params);
  const search = useSearchParams();
  const router = useRouter();
  const project = search.get("project") || "";
  const { signedIn, role } = useSession();
  const { projects } = useProject();
  const admin = role === "owner" || role === "admin";
  usePageTitle(`Statement · ${monthLabel(month)}`);
  const url = signedIn && admin ? `/api/statements?month=${encodeURIComponent(month)}${project ? `&project=${encodeURIComponent(project)}` : ""}` : null;
  const { data, error, refresh } = useApi<Statement>(url, 60_000);
  const amount = useMemo(() => (data?.unit === "cr"
    ? (n: number) => `${Math.round(n).toLocaleString("en-US")} cr`
    : (n: number) => `$${n.toFixed(2)}`), [data?.unit]);

  if (!signedIn) return <div className="page"><div className="page-inner"><Empty title="Statements are private" line="Sign in as an owner or admin to read them." /></div></div>;
  if (!admin) return <div className="page"><div className="page-inner"><Empty title="The owner's and admins' to read" line="Ask an admin for this month's statement." /></div></div>;
  if (!data) return error ? <Trouble label="The statement didn't load" detail={error} onRetry={refresh} /> : <Waiting label="Adding it up" />;

  const csv = `/api/statements?month=${encodeURIComponent(month)}${project ? `&project=${encodeURIComponent(project)}` : ""}&format=csv`;
  const Line = ({ l, shot }: { l: StatementLine; shot: string }) => (
    <tr>
      <td className="st-td st-mono">{day(l.at)}</td>
      <td className="st-td">{shot ? <><span className="st-mono">{shot}</span> {l.take}</> : <>{l.take}<span className="text-mute"> · {l.note}</span></>}</td>
      <td className="st-td text-dim">{l.what}{l.status !== "succeeded" ? <span className="text-mute"> · {l.status}</span> : null}</td>
      <td className="st-td st-mono text-right">{amount(data.unit === "cr" ? l.credits : l.usd)}</td>
    </tr>
  );
  return (
    <div className="theme-light statement">
      <div className="statement-actions">
        <Link href="/settings#statements" className="text-[14px] text-blue">← Statements</Link>
        <span className="ml-auto flex gap-2">
          <label className="chip-dd !py-1.5">
            <select value={project} aria-label="Production" onChange={(e) => router.push(`/statements/${month}${e.target.value ? `?project=${encodeURIComponent(e.target.value)}` : ""}`)}>
              <option value="">Every production</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <a href={csv} className="btn-secondary !h-8 !px-3 !text-[12.5px]">Download CSV</a>
          <button type="button" className="btn-primary !h-8 !px-3 !text-[12.5px]" onClick={() => window.print()}>Print</button>
        </span>
      </div>
      <header className="statement-head">
        <p className="mono !tracking-[.14em] !text-[10px]">STATEMENT</p>
        <h1 className="h1">{data.workspace.name}</h1>
        <p className="text-[15px] text-dim">{monthLabel(month)}{data.projectFilter ? ` · ${data.projects[0]?.name ?? "one production"}` : ""} · {data.totals.takes} take{data.totals.takes === 1 ? "" : "s"}</p>
      </header>
      {data.projects.length === 0 && <p className="rail-help">Nothing billed this month.</p>}
      {data.projects.map((p) => (
        <section key={p.id ?? "unfiled"} className="statement-project">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[19px] font-semibold tracking-[-0.015em]">{p.name}</h2>
            <span className="ml-auto st-mono text-[14px]">{amount(data.unit === "cr" ? p.credits : p.usd)}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="st-table">
              <thead><tr><th className="st-th">Date</th><th className="st-th">Shot · take</th><th className="st-th">What</th><th className="st-th text-right">{data.unit === "cr" ? "Credits" : "Cost"}</th></tr></thead>
              <tbody>
                {p.shots.map((s) => s.lines.map((l) => <Line key={l.id} l={l} shot={`${s.code}${s.title ? ` ${s.title}` : ""}`} />))}
                {p.loose.map((l) => <Line key={l.id} l={l} shot="" />)}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <footer className="statement-foot">
        <div className="flex items-baseline gap-3"><span className="font-medium">Total</span><span className="ml-auto st-mono text-[17px] font-semibold">{amount(data.unit === "cr" ? data.totals.credits : data.totals.usd)}</span></div>
        {data.unit === "cr" && (
          <div className="mt-1.5 flex items-baseline gap-3 text-[14px] text-dim">
            <span>Packs bought this month{data.packs.count ? ` · ${data.packs.count}` : ""}</span>
            <span className="ml-auto st-mono">{data.packs.count ? `${data.packs.credits.toLocaleString("en-US")} credits · $${data.packs.usd.toFixed(2)}` : "none"}</span>
          </div>
        )}
        <p className="mt-4 text-[12px] text-mute">Months are counted in UTC. {data.unit === "cr" ? "Credits are what this workspace was billed; a pack's price is the only dollar figure." : "Costs are what the vendors charged."}</p>
      </footer>
    </div>
  );
}
