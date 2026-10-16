"use client";
import type { ConsoleOverview } from "@/lib/platformConsole.server";
import { riskAlarm, riskWords } from "@/lib/atRiskWindow";
import { useAdminRead } from "./api";
import { Head } from "./parts";

/** The shape /api/health answers a signed-in person with (app/api/health/route.ts); only what the strip reads. */
type Health = {
  ok?: boolean;
  database?: string;
  storage?: string;
  mail?: { configured: boolean; from?: string };
  cron?: { healthy: boolean | null; agoMinutes: number | null; status?: string } | null;
  providers?: { id: string; configured: boolean; via: string | null }[];
  commit?: string;
};
type Tone = "ok" | "warn" | "bad" | "idle";
type Cell = { name: string; tone: Tone; line: string };

/** The five health cells, each from what /api/health says: nothing is guessed, and a missing answer is "unknown", never green. */
export function healthCells(h: Health | null): Cell[] {
  if (!h) return ["Database", "Storage", "Background jobs", "Mail", "Engines"].map((name) => ({ name, tone: "idle" as const, line: "Reading…" }));
  const storage = h.storage ?? "";
  const providers = h.providers ?? [];
  const connected = providers.filter((p) => p.configured).length;
  return [
    { name: "Database", tone: h.database === "unreachable" ? "bad" : h.database ? "ok" : "idle", line: h.database === "unreachable" ? "Not reachable" : h.database ? "Reachable" : "Unknown" },
    { name: "Storage", tone: storage.endsWith("-BROKEN") || storage === "missing" ? "bad" : storage ? "ok" : "idle", line: storage.endsWith("-BROKEN") ? "Not working" : storage === "missing" ? "Not set up" : storage ? "Reachable" : "Unknown" },
    h.cron == null
      ? { name: "Background jobs", tone: "idle", line: "No run recorded" }
      : h.cron.healthy === false ? { name: "Background jobs", tone: "bad", line: h.cron.agoMinutes != null ? `Last run ${h.cron.agoMinutes} min ago` : "Last run failed" }
      : h.cron.healthy === true ? { name: "Background jobs", tone: "ok", line: `Last run ${h.cron.agoMinutes ?? 0} min ago` }
      : { name: "Background jobs", tone: "idle", line: "No run recorded" },
    h.mail?.configured ? { name: "Mail", tone: "ok", line: "Set up" } : { name: "Mail", tone: "warn", line: "Not set up" },
    { name: "Engines", tone: !providers.length ? "idle" : connected === providers.length ? "ok" : connected ? "warn" : "bad", line: providers.length ? `${connected} of ${providers.length} connected` : "Unknown" },
  ];
}

export function Overview() {
  const { data } = useAdminRead<ConsoleOverview>("/api/admin/console", 30_000);
  const { data: health } = useAdminRead<Health>("/api/health", 60_000);
  const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-US"));
  const risk = data?.failedSaves ?? null;
  return (
    <>
      <Head title="Overview" line="The platform at a glance." />
      <div className="v12-pc-tiles" data-testid="pc-tiles">
        <div className="v12-pc-tile"><span className="v12-pc-tile-name">Workspaces</span><span className="v12-pc-tile-n" data-testid="pc-tile-workspaces">{n(data?.workspaces)}</span></div>
        <div className="v12-pc-tile"><span className="v12-pc-tile-name">People</span><span className="v12-pc-tile-n" data-testid="pc-tile-people">{n(data?.people)}</span><span className="v12-pc-tile-sub">across all workspaces</span></div>
        <div className="v12-pc-tile"><span className="v12-pc-tile-name">Credits granted this month</span><span className="v12-pc-tile-n" data-testid="pc-tile-granted">{n(data?.grantedThisMonth)}</span><span className="v12-pc-tile-sub">given, not bought</span></div>
        <div className="v12-pc-tile"><span className="v12-pc-tile-name">Failed saves</span><span className="v12-pc-tile-n" data-tone={risk && riskAlarm(risk) ? "bad" : undefined} data-testid="pc-tile-risk">{data && !risk ? "—" : risk ? riskWords(risk) || "0" : n(null)}</span><span className="v12-pc-tile-sub">renders with no stored copy</span></div>
      </div>
      <h2 className="v12-pc-h2">Health</h2>
      <div className="v12-pc-health" data-testid="pc-health">
        {healthCells(health).map((c) => (
          <div key={c.name} className="v12-pc-hcell" data-testid={`pc-health-${c.name.toLowerCase().replace(/\s+/g, "-")}`} data-tone={c.tone}>
            <span className="v12-pc-hname"><span className="v12-pc-dot" data-tone={c.tone} aria-hidden />{c.name}</span>
            <span className="v12-pc-hline">{c.line}</span>
          </div>
        ))}
      </div>
      <p className="v12-pc-running" data-testid="pc-running">Running {health?.commit ?? data?.commit ?? "—"}</p>
    </>
  );
}
