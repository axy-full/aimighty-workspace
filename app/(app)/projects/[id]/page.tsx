"use client";

/**
 * R1 — the project overview.
 *
 * A project is the unit the business thinks in, so this is the page that
 * answers "what did this job cost us": total generations, credit and dollars,
 * who worked on it, how many takes each shot needed, and how much machine
 * time it burned. The shot list doubles as the place shots are created, so
 * the numbers on the dashboard have something to count.
 */
import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/projectContext";
import { confirmDeleteProject } from "@/lib/deleteProject";
import { useApi } from "@/lib/useApi";
import { usd, hours, pct, timeAgo } from "@/lib/format";
import { type Analytics, Headline, BarList, ShotTable, Patterns } from "@/components/Analytics";
import { appPrompt, appAlert, appConfirm } from "@/components/dialog";
import { Waiting, Trouble } from "@/components/ParticlMark";
import { usePageTitle } from "@/lib/usePageTitle";
import { useMoney } from "@/lib/price";
import { useSession } from "@/lib/session";
import { burnDown, biggestBurners, projectionLine } from "@/lib/burndown";

type Project = {
  id: string; name: string; description: string; code?: string; category?: string;
  spend?: number; credits?: number; capUsd?: number | null; capCredits?: number | null; capUnlocked?: boolean;
};
type ShotRow = {
  id: string; code: string; scene: string; title: string; status: string;
  takes: number; ok: number; failed: number; spend: number; credits?: number;
};

export default function ProjectOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { selection, setSelection, refreshProjects: refreshCtx } = useProject();
  const { role } = useSession();
  const isAdmin = role === "owner" || role === "admin";
  const money = useMoney();
  const { data, error, refresh } = useApi<Analytics>(`/api/analytics?projectId=${encodeURIComponent(id)}`, 30000);
  const { data: projects, refresh: refreshProjects } =
    useApi<{ projects: Project[] }>("/api/projects", 60000);
  const { data: shotData, refresh: refreshShots } =
    useApi<{ shots: ShotRow[] }>(`/api/shots?projectId=${encodeURIComponent(id)}`, 30000);
  const [busy, setBusy] = useState(false);

  const project = projects?.projects.find((p) => p.id === id);

  async function addShot() {
    if (busy) return;
    const code = await appPrompt("Shot code", "", "SH010 — blank numbers it for you");
    if (code === null) return;
    const scene = await appPrompt("Scene", "", "SC04 (optional)");
    if (scene === null) return;
    const title = await appPrompt("What is the shot?", "", "Rooftop wide (optional)");
    if (title === null) return;
    setBusy(true);
    try {
      const res = await fetch("/api/shots", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id, code, scene, title }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not add the shot");
      refreshShots();
    } catch (e) {
      await appAlert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await confirmDeleteProject(id, project?.name ?? "this production", data?.totals?.generations ?? null))) return;
    if (selection === id) setSelection("all");
    refreshCtx();
    router.push("/projects");
  }

  async function setCode() {
    const code = await appPrompt("Production code", project?.code ?? "", "NKA26");
    if (code === null) return;
    const res = await fetch(`/api/projects/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) await appAlert("Could not save the code");
    else refreshProjects();
  }

  async function setCategory() {
    const category = await appPrompt("Category", project?.category ?? "",
      "TVC · music video · social · title sequence");
    if (category === null) return;
    const res = await fetch(`/api/projects/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    });
    if (!res.ok) await appAlert("Could not save the category");
    else refreshProjects();
  }

  usePageTitle(project?.name ?? "Project");
  if (!data) return error ? <Trouble label="The production didn't load" detail={error} onRetry={refresh} /> : <Waiting label="Reading the production" />;

  const t = data.totals;
  const shots = shotData?.shots ?? [];

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[1120px] pb-10">
        <Link href="/projects" className="mt-6 inline-block text-[14px] text-blue">← Productions</Link>
        <Headline a={data} title={project?.name ?? "Project"} />

        {project?.description && (
          <p className="mt-4 max-w-[70ch] text-[15px] text-dim">{project.description}</p>
        )}

        <p className="mt-3 text-[14px] text-mute">
          Code{" "}
          <button onClick={setCode} className="font-mono text-blue">
            {project?.code || "set one"}
          </button>{" "}
          — the short form that appears in filenames. Category{" "}
          <button onClick={setCategory} className="text-blue">
            {project?.category || "set one"}
          </button>{" "}
          — how this job is grouped on the production dashboard.
        </p>
        {project && <CapLine project={project} spentCredits={t.credits} spentUsd={t.spend} isAdmin={isAdmin} onChanged={() => { refreshProjects(); refresh(); }} />}
        <ReviewLinks projectId={id} isAdmin={isAdmin} />
        {/* The selects, on the way out (brief 2.6). */}
        <section className="rvl">
          <div className="rvl-head">
            <span className="grouplabel !pb-0">Export the selects</span>
            <a className="hdr-mono-link" href={`/api/export/selects?projectId=${encodeURIComponent(id)}&format=zip`}>ZIP ↓</a>
            <a className="hdr-mono-link" href={`/api/export/selects?projectId=${encodeURIComponent(id)}&format=csv`}>SHOT LIST ↓</a>
            <a className="hdr-mono-link" href={`/api/export/selects?projectId=${encodeURIComponent(id)}&format=edl`}>EDL ↓</a>
          </div>
          <p className="rvl-note">Every Approved take, in shot order: the masters named by your own convention, a shot list to bill from, and an edit list an editor can conform against. The zip carries all three.</p>
        </section>
        {project && <BurnDown project={project} totals={t} byShot={data.byShot} shotCount={shots.length} />}

        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/" className="chip bg-blue text-on-ink">Open in Generate</Link>
          <Link href={`/projects/${id}/canvas`} className="chip">Canvas</Link>
          <Link href="/all" className="chip">All takes</Link>
          <Link href="/dashboard" className="chip">Production dashboard</Link>
          <button type="button" onClick={remove} className="chip !text-lift">Delete production</button>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="card px-5 py-5">
            <div className="flex items-center gap-3">
              <p className="grouplabel">Shots</p>
              <button onClick={addShot} disabled={busy}
                className="ml-auto text-[14px] text-blue disabled:opacity-50">+ Add shot</button>
            </div>
            <p className="mt-1 text-[13px] text-mute">
              Every render filed against a shot becomes a numbered version of it.
            </p>
            <div className="mt-4">
              <ShotTable rows={shots.map((s) => ({
                id: s.id, code: s.code, scene: s.scene, title: s.title, status: s.status,
                takes: s.takes, spend: s.spend, credits: s.credits, ok: s.ok, failed: s.failed, latest: 0,
              }))} />
            </div>
          </section>

          <div className="flex flex-col gap-6">
            <section className="card px-5 py-5">
              <p className="grouplabel">Who worked on it</p>
              <div className="mt-4">
                <BarList empty="No takes yet."
                  rows={data.byPerson.map((p) => ({
                    key: p.id || p.name, label: p.name, value: p.spend, credits: p.credits,
                    note: `${p.n} render${p.n === 1 ? "" : "s"}`,
                  }))} />
              </div>
            </section>

            <section className="card px-5 py-5">
              <p className="grouplabel">By model</p>
              <div className="mt-4">
                <BarList empty="No takes yet."
                  rows={data.byModel.map((m) => ({
                    key: m.model, label: m.label, value: m.spend, credits: m.credits, note: `${m.n}`,
                  }))} />
              </div>
            </section>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="card px-5 py-5">
            <p className="grouplabel">How this production was made</p>
            <div className="mt-4"><Patterns a={data} /></div>
          </section>

          <section className="card px-5 py-5">
            <p className="grouplabel">Cost of this production</p>
            <div className="rows mt-4">
              <div className="row"><span>Generations</span>
                <span className="row-value tabular-nums">{t.generations}</span></div>
              <div className="row"><span>Delivered</span>
                <span className="row-value tabular-nums">{t.succeeded} ({pct(t.successRate)})</span></div>
              <div className="row"><span>Failed</span>
                <span className="row-value tabular-nums">{t.failed}</span></div>
              <div className="row"><span>Render time</span>
                <span className="row-value tabular-nums">{hours(t.renderMs)}</span></div>
              <div className="row"><span>Renders</span>
                <span className="row-value tabular-nums">{money.inCredits ? money.of(t) : usd(t.spend - t.promptSpend, 2)}</span></div>
              <div className="row">
                <span className="flex flex-col">
                  Prompt writing
                  <span className="text-[12px] text-mute">
                    {t.prompts} prompt{t.prompts === 1 ? "" : "s"} finished by the writer
                  </span>
                </span>
                <span className="row-value tabular-nums">{money.inCredits ? "included" : usd(t.promptSpend, 3)}</span></div>
              <div className="row"><span className="font-medium">Total cost</span>
                <span className="row-value font-semibold tabular-nums !text-bone">{money.of(t)}</span></div>
            </div>
            <p className="mt-4 text-[13px] text-mute">
              All-in: the render plus what the prompt writer charged. Binned takes still
              count — money spent is money spent.
              {data.byDay.length > 0 && (
                <> Last activity {timeAgo(data.byDay[data.byDay.length - 1].day)}.</>
              )}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * The production's cap, in the workspace's unit: what it is, how much of
 * it is spent, and — for an admin — the two ways past it: raise it, or
 * unlock it and let the take through.
 */
function CapLine({ project, spentCredits, spentUsd, isAdmin, onChanged }: { project: Project; spentCredits: number; spentUsd: number; isAdmin: boolean; onChanged: () => void }) {
  const money = useMoney();
  const cap = money.inCredits ? project.capCredits ?? null : project.capUsd ?? null;
  // The page's own totals, which are fresh; the production list behind `project` is a cache.
  const spent = money.inCredits ? spentCredits : spentUsd;
  const unit = money.inCredits ? "cr" : "$";
  const show = (n: number) => (money.inCredits ? `${Math.round(n).toLocaleString("en-US")} cr` : `$${Math.round(n)}`);
  const pct = cap ? Math.round((spent / cap) * 100) : null;
  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/projects/${project.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { await appAlert("Not changed", json.error ?? "Could not change the cap"); return; }
    onChanged();
  }
  async function setCap() {
    const raw = await appPrompt(money.inCredits ? "Cap for this production, in credits" : "Cap for this production, in dollars", cap ? String(Math.round(cap)) : "", money.inCredits ? "2000" : "250");
    if (raw === null) return;
    const v = raw.trim() === "" ? null : Number(raw.replace(/[^0-9.]/g, ""));
    if (v != null && !(v >= 0)) { await appAlert("Not a cap", "A cap is a number, or blank for none."); return; }
    await patch(money.inCredits ? { capCredits: v } : { capUsd: v });
  }
  return (
    <p className="mt-2 text-[14px] text-mute">
      Cap{" "}
      {isAdmin
        ? <button onClick={setCap} className="text-blue">{cap ? show(cap) : "set one"}</button>
        : <span className="text-ink">{cap ? show(cap) : "none"}</span>}
      {cap ? <> — {show(spent)} spent{pct != null ? ` · ${pct}%` : ""}{project.capUnlocked ? " · unlocked past the cap" : ""}</> : <> — {unit === "cr" ? "credits" : "dollars"} this production may spend before the rule at the cap applies.</>}
      {isAdmin && cap ? (
        <>{" "}<button onClick={() => patch({ capUnlocked: !project.capUnlocked })} className="text-blue">{project.capUnlocked ? "Lock again" : "Unlock"}</button></>
      ) : null}
    </p>
  );
}

/**
 * Client review links (brief 2.6): a read-only page of this production's
 * Approved takes, for someone with no account here. The link is shown once,
 * when it is made — after that only its label, its expiry and the power to
 * withdraw it, because the token itself is never stored in the clear.
 */
function ReviewLinks({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { data, refresh } = useApi<{ shares: { id: string; label: string; createdBy: string; createdAt: number; expiresAt: number; revokedAt: number | null; live: boolean }[]; days: number }>(
    `/api/shares?projectId=${encodeURIComponent(projectId)}`, 0);
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shares = data?.shares ?? [];
  const live = shares.filter((s) => s.live);
  if (!isAdmin && !live.length) return null;

  async function mint() {
    const label = await appPrompt("A review link for this production", "", "Who is it for? (optional)");
    if (label === null) return;
    setBusy(true);
    try {
      const res = await fetch("/api/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, label }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      setMinted(j.url as string);
      try { await navigator.clipboard.writeText(j.url as string); } catch { /* the link is on screen either way */ }
      refresh();
    } catch (e) { await appAlert("No link made", (e as Error).message); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    if (!(await appConfirm("Withdraw this link?", "Anyone holding it loses the page at once. The takes are untouched.", { confirmLabel: "Withdraw", danger: true }))) return;
    await fetch(`/api/shares?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setMinted(null); refresh();
  }
  const when = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  return (
    <section className="rvl">
      <div className="rvl-head">
        <span className="grouplabel !pb-0">Client review</span>
        {isAdmin && <button type="button" className="hdr-mono-link" disabled={busy} onClick={mint}>{busy ? "MAKING…" : "MAKE A LINK →"}</button>}
      </div>
      <p className="rvl-note">A read-only page of this production&rsquo;s Approved takes, in shot order, under your own name. No login. Comments come back onto the take.</p>
      {minted && <p className="rvl-new"><code>{minted}</code> <span className="mono-s">COPIED · SHOWN ONCE</span></p>}
      {live.length > 0 && (
        <ul className="rvl-list">
          {live.map((s) => (
            <li key={s.id}>
              <span>{s.label || "Review link"}</span>
              <span className="mono-s">BY {s.createdBy.toUpperCase()} · UNTIL {when(s.expiresAt).toUpperCase()}</span>
              {isAdmin && <button type="button" className="hdr-mono-link" onClick={() => revoke(s.id)}>WITHDRAW</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The burn-down (brief 2.2): what this production has spent against its
 * cap, what finishing it looks like at the rate it has actually run, and
 * which shots are eating it. The arithmetic is plain on purpose — a
 * producer who cannot check a projection will not act on it.
 */
function BurnDown({ project, totals, byShot, shotCount }: {
  project: Project;
  totals: Analytics["totals"];
  byShot: Analytics["byShot"];
  shotCount: number;
}) {
  const money = useMoney();
  const inCredits = money.inCredits;
  const show = (n: number) => (inCredits ? `${Math.round(n).toLocaleString("en-US")} cr` : `$${Math.round(n)}`);
  const spend = (s: { credits?: number; spend: number }) => (inCredits ? s.credits ?? 0 : s.spend);
  const rows = byShot.map((s) => ({ id: s.id, code: s.code, title: s.title, takes: s.takes, credits: spend(s) }));
  const b = burnDown({
    spentCredits: inCredits ? totals.credits : totals.spend,
    capCredits: (inCredits ? project.capCredits : project.capUsd) ?? null,
    shotCount, byShot: rows,
  });
  const burners = biggestBurners(rows, b.spent);
  const line = projectionLine(b, show);
  if (!b.known && !b.cap) return null;

  return (
    <section className="burn">
      <div className="burn-head">
        <span className="grouplabel !pb-0">Burn-down</span>
        <span className="mono-s">
          {show(b.spent)} SPENT{b.cap != null ? ` OF ${show(b.cap)}` : ""}
          {b.pct != null ? ` · ${b.pct}%` : ""}
          {b.started ? ` · ${b.started} OF ${b.shots} SHOTS STARTED` : ""}
        </span>
      </div>
      {b.cap != null && (
        <div className="burn-bar" role="img" aria-label={`${b.pct ?? 0}% of the cap spent`}>
          <span className="burn-spent" style={{ width: `${Math.min(100, b.pct ?? 0)}%` }} />
          {b.projected != null && b.cap > 0 && (
            <span className="burn-mark" style={{ left: `${Math.min(100, Math.round((b.projected / b.cap) * 100))}%` }} title={`Projected finish: ${show(b.projected)}`} />
          )}
        </div>
      )}
      {line && <p className={`burn-line ${b.over != null && b.over > 0 ? "is-over" : ""}`}>{line}</p>}
      {burners.length > 0 && (
        <ul className="burn-list">
          {burners.map((s) => (
            <li key={s.id}>
              <span className="mono-s">{s.code}</span>
              <span className="burn-name">{s.title || "Untitled shot"}</span>
              <span className="burn-take">{s.takes} take{s.takes === 1 ? "" : "s"}</span>
              <span className="burn-share"><span style={{ width: `${Math.max(2, s.share)}%` }} /></span>
              <span className="mono-s">{show(s.credits)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
