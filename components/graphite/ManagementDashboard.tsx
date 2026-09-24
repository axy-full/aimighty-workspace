"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useSession } from "@/lib/session";

/**
 * Workspace › Dashboard (owner, 24 September: "the management dashboard in
 * the Suites"). Production oversight from the analytics route that already
 * computes it — spend in dollars and credits by project, person and model;
 * revisions per shot; where generations stall; category and prompting
 * patterns — plus the credit ledger's view of all paid work (agents and
 * connected jobs included). Filter by project and period; export as CSV.
 */
type Row = Record<string, unknown>;
type Analytics = {
  totals: { generations: number; succeeded: number; failed: number; pending: number; spend: number; credits: number; promptSpend: number; renderMs: number; people: number; shots: number; successRate: number };
  byProject: { id: string | null; name: string; n: number; spend: number; credits: number; failed: number; people: number; renderMs: number }[];
  byPerson: { id: string; name: string; email?: string; n: number; spend: number; credits: number; failed: number; projects: number }[];
  byModel: { model: string; label: string; n: number; spend: number; credits: number; failed: number; avgMs: number | null }[];
  byShot: { id: string; code: string | null; scene: string | null; title: string | null; takes: number; spend: number; credits: number; ok: number; failed: number }[];
  stuck?: { model: string; resolution: string | null; n: number; avgMs: number | null; maxMs: number | null; failed: number; retried: number }[];
  byCategory?: { category: string; n: number; spend: number; credits: number; failed: number; avgMs: number | null; projects: number; shots: number }[];
  patterns?: { avgPromptLength: number; refined: number; withCast: number; withReferences: number; filedToShots: number; unfiled: number; takesPerShot: number };
  personalOnly?: boolean;
};
type Ledger = { byProject?: { name: string; n?: number; credits?: number }[]; byPerson?: { name: string; n?: number; credits?: number }[] };

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const PERIODS = [{ days: 0, label: "All time" }, { days: 90, label: "90 days" }, { days: 30, label: "30 days" }, { days: 7, label: "7 days" }];

function csv(rows: Row[], columns: [string, string][]): string {
  const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(([, label]) => cell(label)).join(","), ...rows.map((r) => columns.map(([key]) => cell(r[key])).join(","))].join("\n");
}

function Table<T extends Row>({ caption, rows, columns, testid, onPick }: { caption: string; rows: T[]; columns: { label: string; value: (r: T) => string; numeric?: boolean }[]; testid: string; onPick?: (r: T) => void }) {
  return (
    <div className="mdx-table-wrap">
      <table className="mdx-table" data-testid={testid}>
        <caption className="gx-eyebrow">{caption}</caption>
        <thead><tr>{columns.map((c) => <th key={c.label} scope="col" data-numeric={c.numeric || undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.length ? rows.map((r, i) => (
            <tr key={i} data-clickable={onPick ? true : undefined} onClick={onPick ? () => onPick(r) : undefined}>
              {columns.map((c) => <td key={c.label} data-numeric={c.numeric || undefined}>{c.value(r)}</td>)}
            </tr>
          )) : <tr><td colSpan={columns.length} className="cw-dim">Nothing yet in this range.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function ManagementDashboard() {
  const scoped = useScopedFetch();
  const session = useSession();
  const [days, setDays] = useState(0);
  const [projectId, setProjectId] = useState("all");
  const [data, setData] = useState<Analytics | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const read = useCallback(async () => {
    try {
      const q = new URLSearchParams({ days: String(days), ...(projectId !== "all" ? { projectId } : {}) });
      const response = await scoped(`/api/analytics?${q}`, { cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.error ?? "The dashboard could not be read.");
      setData(json); setError("");
      if (projectId === "all") setProjects((json as Analytics).byProject.filter((p) => p.id).map((p) => ({ id: p.id!, name: p.name })));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The dashboard could not be read."); }
  }, [scoped, days, projectId]);
  useEffect(() => { const t = setTimeout(() => void read(), 0); return () => clearTimeout(t); }, [read]);
  useEffect(() => {
    let alive = true;
    void scoped("/api/usage", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((json) => { if (alive && json) setLedger(json as Ledger); }).catch(() => undefined);
    return () => { alive = false; };
  }, [scoped]);

  const credits = session.rates.unit !== "usd";
  const t = data?.totals;
  const it = data?.patterns;
  const scopeName = projectId === "all" ? "All projects" : projects.find((p) => p.id === projectId)?.name ?? "This project";
  const exportCsv = useMemo(() => () => {
    if (!data) return;
    const parts = [
      `# ${scopeName} · ${PERIODS.find((p) => p.days === days)?.label}`,
      "# By project", csv(data.byProject as unknown as Row[], [["name", "Project"], ["n", "Generations"], ["spend", "Cost (USD)"], ["credits", "Credits"], ["failed", "Failed"], ["people", "People"], ["renderMs", "Render ms"]]),
      "", "# By person", csv(data.byPerson as unknown as Row[], [["name", "Person"], ["email", "Email (masked)"], ["n", "Generations"], ["spend", "Cost (USD)"], ["credits", "Credits"], ["failed", "Failed"], ["projects", "Projects"]]),
      "", "# By model", csv(data.byModel as unknown as Row[], [["label", "Model"], ["n", "Generations"], ["spend", "Cost (USD)"], ["credits", "Credits"], ["failed", "Failed"], ["avgMs", "Average ms"]]),
      "", "# Revisions per shot", csv(data.byShot as unknown as Row[], [["code", "Shot"], ["title", "Title"], ["takes", "Takes"], ["ok", "Succeeded"], ["failed", "Failed"], ["spend", "Cost (USD)"], ["credits", "Credits"]]),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([parts], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `particl-dashboard-${scopeName.replace(/[^\w-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [data, days, scopeName]);

  return (
    <div className="wsx-card mdx" data-testid="ws-dashboard">
      <div className="mdx-head">
        <span className="gx-eyebrow">Dashboard · {scopeName}</span>
        <span className="gx-spacer" />
        <select className="cw-select" aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="dash-project">
          <option value="all">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Period">
          {PERIODS.map((p) => <button key={p.days} type="button" role="radio" className="gx-seg-btn" aria-checked={days === p.days} onClick={() => setDays(p.days)}><span>{p.label}</span></button>)}
        </div>
        <button type="button" className="gx-hbtn" disabled={!data} onClick={exportCsv} data-testid="dash-export">Export CSV</button>
      </div>
      {error ? <p className="gx-reason" role="alert">{error}</p> : null}
      {data?.personalOnly ? <p className="cw-dim" data-testid="dash-personal">Spend by person shows only your own work. Owners and admins see the whole team.</p> : null}
      {t ? (
        <>
          <div className="mdx-tiles" data-testid="dash-totals">
            <div className="mdx-tile"><span className="gx-eyebrow">Cost</span><strong data-testid="dash-cost">{usd(t.spend)}</strong><span className="cw-dim">vendor cost{t.promptSpend ? ` · ${usd(t.promptSpend)} prompt writing` : ""}</span></div>
            {credits ? <div className="mdx-tile"><span className="gx-eyebrow">Credits</span><strong>{int(t.credits)} cr</strong><span className="cw-dim">billed to the workspace</span></div> : null}
            <div className="mdx-tile"><span className="gx-eyebrow">Generations</span><strong data-testid="dash-generations">{int(t.generations)}</strong><span className="cw-dim">{int(t.succeeded)} made · {int(t.failed)} failed{t.pending ? ` · ${int(t.pending)} running` : ""}</span></div>
            <div className="mdx-tile"><span className="gx-eyebrow">Success</span><strong>{pct(t.succeeded, t.generations)}</strong><span className="cw-dim">of generations</span></div>
            <div className="mdx-tile"><span className="gx-eyebrow">Render time</span><strong>{hours(t.renderMs)}</strong><span className="cw-dim">machine time, not people time</span></div>
            <div className="mdx-tile"><span className="gx-eyebrow">Team</span><strong>{int(t.people)}</strong><span className="cw-dim">{int(t.shots)} shots worked on</span></div>
          </div>

          {projectId === "all" ? (
            <Table caption="By project · click one to focus the dashboard on it" testid="dash-projects" rows={data!.byProject} onPick={(r) => r.id && setProjectId(r.id)}
              columns={[{ label: "Project", value: (r) => r.name }, { label: "Generations", value: (r) => int(r.n), numeric: true }, { label: "Cost", value: (r) => usd(r.spend), numeric: true },
                ...(credits ? [{ label: "Credits", value: (r: Analytics["byProject"][number]) => int(r.credits), numeric: true }] : []),
                { label: "Failed", value: (r) => int(r.failed), numeric: true }, { label: "People", value: (r) => int(r.people), numeric: true }, { label: "Render", value: (r) => hours(r.renderMs), numeric: true }]} />
          ) : null}
          <Table caption="By person" testid="dash-people" rows={data!.byPerson}
            columns={[{ label: "Person", value: (r) => (r.email ? `${r.name} · ${r.email}` : r.name) }, { label: "Generations", value: (r) => int(r.n), numeric: true }, { label: "Cost", value: (r) => usd(r.spend), numeric: true },
              ...(credits ? [{ label: "Credits", value: (r: Analytics["byPerson"][number]) => int(r.credits), numeric: true }] : []),
              { label: "Failed", value: (r) => int(r.failed), numeric: true }, { label: "Projects", value: (r) => int(r.projects), numeric: true }]} />
          <Table caption="By model" testid="dash-models" rows={data!.byModel}
            columns={[{ label: "Model", value: (r) => r.label }, { label: "Generations", value: (r) => int(r.n), numeric: true }, { label: "Cost", value: (r) => usd(r.spend), numeric: true },
              { label: "Failed", value: (r) => `${int(r.failed)} · ${pct(r.failed, r.n)}`, numeric: true }, { label: "Average time", value: (r) => secs(r.avgMs), numeric: true }]} />
          <Table caption="Revisions per shot · the shots that took the most takes" testid="dash-shots" rows={data!.byShot.slice(0, 25)}
            columns={[{ label: "Shot", value: (r) => [r.code, r.title].filter(Boolean).join(" · ") || "—" }, { label: "Takes", value: (r) => int(r.takes), numeric: true },
              { label: "Made", value: (r) => int(r.ok), numeric: true }, { label: "Failed", value: (r) => int(r.failed), numeric: true }, { label: "Cost", value: (r) => usd(r.spend), numeric: true }]} />
          {data!.stuck ? (
            <Table caption="Where generations stall · slowest first" testid="dash-stuck" rows={data!.stuck.slice(0, 15)}
              columns={[{ label: "Model", value: (r) => r.model }, { label: "Resolution", value: (r) => r.resolution ?? "—" }, { label: "Runs", value: (r) => int(r.n), numeric: true },
                { label: "Average", value: (r) => secs(r.avgMs), numeric: true }, { label: "Longest", value: (r) => secs(r.maxMs), numeric: true },
                { label: "Failed", value: (r) => int(r.failed), numeric: true }, { label: "Retried", value: (r) => int(r.retried), numeric: true }]} />
          ) : null}
          {data!.byCategory?.length ? (
            <Table caption="By category" testid="dash-categories" rows={data!.byCategory}
              columns={[{ label: "Category", value: (r) => r.category }, { label: "Projects", value: (r) => int(r.projects), numeric: true }, { label: "Generations", value: (r) => int(r.n), numeric: true },
                { label: "Cost", value: (r) => usd(r.spend), numeric: true }, { label: "Failed", value: (r) => pct(r.failed, r.n), numeric: true }, { label: "Average time", value: (r) => secs(r.avgMs), numeric: true }]} />
          ) : null}
          {it ? (
            <div className="mdx-tiles" data-testid="dash-iteration">
              <div className="mdx-tile"><span className="gx-eyebrow">Takes per shot</span><strong>{it.takesPerShot ? it.takesPerShot.toFixed(1) : "—"}</strong><span className="cw-dim">1.0 means nobody revises</span></div>
              <div className="mdx-tile"><span className="gx-eyebrow">Prompt length</span><strong>{it.avgPromptLength ? int(it.avgPromptLength) : "—"}</strong><span className="cw-dim">characters on average</span></div>
              <div className="mdx-tile"><span className="gx-eyebrow">Prompt writer</span><strong>{pct(it.refined, t.generations)}</strong><span className="cw-dim">of generations used it</span></div>
              <div className="mdx-tile"><span className="gx-eyebrow">With references</span><strong>{pct(it.withReferences, t.generations)}</strong><span className="cw-dim">of generations</span></div>
            </div>
          ) : null}
          {credits && (ledger?.byProject?.length || ledger?.byPerson?.length) ? (
            <div className="mdx-ledger" data-testid="dash-ledger">
              <span className="gx-eyebrow">All paid work · the credit ledger (renders, agents, connected jobs)</span>
              <Table caption="By project" testid="dash-ledger-projects" rows={(ledger?.byProject ?? []) as Row[]}
                columns={[{ label: "Project", value: (r) => String(r.name) }, { label: "Jobs", value: (r) => int(Number(r.n ?? 0)), numeric: true }, { label: "Credits", value: (r) => int(Number(r.credits ?? 0)), numeric: true }]} />
              <Table caption="By person" testid="dash-ledger-people" rows={(ledger?.byPerson ?? []) as Row[]}
                columns={[{ label: "Person", value: (r) => String(r.name) }, { label: "Jobs", value: (r) => int(Number(r.n ?? 0)), numeric: true }, { label: "Credits", value: (r) => int(Number(r.credits ?? 0)), numeric: true }]} />
            </div>
          ) : null}
        </>
      ) : !error ? <p className="cw-dim">Reading the dashboard…</p> : null}
    </div>
  );
}
