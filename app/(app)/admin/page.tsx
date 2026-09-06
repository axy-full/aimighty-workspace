"use client";

/**
 * The platform owner's desk: who may sign up, who has asked, and every
 * workspace on the deployment. Nobody else can open this — the route
 * behind it answers 403 to everyone but the platform owner.
 */
import { useState } from "react";
import { creditsNumber } from "@/lib/price";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/usePageTitle";
import { timeAgo, usd } from "@/lib/format";
import { appAlert, appConfirm, appPrompt } from "@/components/dialog";
import { Empty, Waiting } from "@/components/ParticlMark";

type Admin = {
  ready: boolean; mail: boolean;
  invites: { code: string; email: string; name: string; note: string; createdAt: number; expiresAt: number; sentAt: number | null; sendCount: number }[];
  requests: { id: string; name: string; email: string; note: string; mailed: boolean; createdAt: number }[];
  platformKeysByDefault: boolean; defaultAllowanceUsd: number | null; gatewayMint: boolean;
  creditUsd: number; signupCredits: number;
  workspaces: Ws[];
};
type Ws = {
  id: string; slug: string; name: string; legacy: boolean; platformKeys: boolean; allowanceUsd: number | null; gatewayKey: boolean;
  credits: { granted: number; used: number; balance: number } | null; createdAt: number; owner: { email: string; name: string } | null; members: number;
  spend30: { jobs: number; failed: number; running: number; engineCostUsd: number; billedCredits: number; marginUsd: number } | null;
  suspended: boolean; suspendedReason: string | null; flagged: boolean; flagNote: string | null;
};

export default function AdminPage() {
  usePageTitle("Platform");
  const { superAdmin } = useSession();
  const { data, refresh } = useApi<Admin>(superAdmin ? "/api/admin/invites" : null, 30_000);
  const [form, setForm] = useState({ email: "", name: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ link: string; sent: boolean; mailError: string | null } | null>(null);

  async function invite(seed?: { email: string; name: string; requestId?: string }) {
    const body = seed ? { ...seed, note: "", send: true } : { ...form, send: true };
    if (!body.email) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't create the invitation");
      setLast({ link: json.link, sent: json.sent, mailError: json.mailError });
      setForm({ email: "", name: "", note: "" });
      refresh();
    } catch (e) { await appAlert("Not invited", (e as Error).message); }
    finally { setBusy(false); }
  }
  async function withdraw(code: string) {
    if (!(await appConfirm("Withdraw this invitation?", "The link stops working.", { confirmLabel: "Withdraw", danger: true }))) return;
    await fetch(`/api/admin/invites/${encodeURIComponent(code)}`, { method: "DELETE" });
    refresh();
  }
  async function handled(id: string) {
    await fetch(`/api/admin/requests/${encodeURIComponent(id)}`, { method: "PATCH" });
    refresh();
  }

  if (!superAdmin) return <div className="page"><div className="page-inner"><Empty title="The platform owner only" line="This desk administers sign-ups for the whole deployment." /></div></div>;

  return (
    <div className="page">
      <div className="page-inner flex flex-col gap-5">
        <div className="page-head">
          <div>
            <h1 className="page-h1">Platform</h1>
            <p className="page-sub">Who may sign up, who has asked, and every workspace on this deployment. Each workspace has its own database, its own keys and its own owner.</p>
          </div>
        </div>
        {!data ? <Waiting label="Reading the platform" /> : (
          <>
            {!data.ready && <p className="rail-help text-lift">Sign-up isn&rsquo;t open yet: set TURSO_API_TOKEN, TURSO_ORG and KEYRING_SECRET in Vercel so new workspaces can be given a database and hold keys.</p>}

            <section className="scard">
              <div className="scard-h"><span>Invite someone to sign up</span><span>An invitation lets one address create an account and a workspace of its own. {data.mail ? "It is emailed at once." : "Email isn't set up, so copy the link and send it yourself."}</span></div>
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); invite(); }}>
                <label className="wl-field !gap-1">EMAIL<input className="ctl !h-9 w-[240px]" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
                <label className="wl-field !gap-1">NAME<input className="ctl !h-9 w-[180px]" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                <label className="wl-field !gap-1">NOTE<input className="ctl !h-9 w-[260px]" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="who they are, for your own record" /></label>
                <button type="submit" className="btn-primary" disabled={busy || !data.ready}>Invite</button>
              </form>
              {last && <p className="rail-help">{last.sent ? "Sent." : last.mailError ? `Not emailed (${last.mailError}).` : "Not emailed."} Link: <code className="font-mono text-[11px] text-ink">{last.link}</code></p>}
              <div className="flex flex-col">
                <div className="steam is-head"><span>INVITED</span><span>STATE</span><span>NOTE</span><span className="text-right">EXPIRES</span></div>
                {data.invites.map((i) => (
                  <div key={i.code} className="steam">
                    <span className="flex flex-col gap-0.5"><span className="font-medium">{i.name || i.email}</span><span className="text-[11.5px] text-dim">{i.email}</span></span>
                    <span className="mono-s">{i.sentAt ? `SENT ${timeAgo(i.sentAt).toUpperCase()}` : "NOT SENT"}</span>
                    <span className="text-lead">{i.note || "—"}</span>
                    <span className="flex items-center justify-end gap-3"><span className="mono-s">{timeAgo(i.expiresAt).replace(" ago", "")}</span><button type="button" className="ak-act is-muted" onClick={() => withdraw(i.code)}>WITHDRAW</button></span>
                  </div>
                ))}
                {data.invites.length === 0 && <span className="rail-help pt-2">No open invitations.</span>}
              </div>
            </section>

            <section className="scard">
              <div className="scard-h"><span>Asked to be let in</span><span>People who asked for an invite. Invite them, or mark the request handled.</span></div>
              <div className="flex flex-col">
                {data.requests.map((r) => (
                  <div key={r.id} className="steam !grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_180px]">
                    <span className="flex flex-col gap-0.5"><span className="font-medium">{r.name || r.email}</span><span className="text-[11.5px] text-dim">{r.email} · {timeAgo(r.createdAt)}</span></span>
                    <span className="text-lead">{r.note || "—"}</span>
                    <span className="flex justify-end gap-2">
                      <button type="button" className="btn-secondary !h-8 !text-[12px]" onClick={() => invite({ email: r.email, name: r.name, requestId: r.id })} disabled={busy || !data.ready}>Invite</button>
                      <button type="button" className="ak-act is-muted" onClick={() => handled(r.id)}>HANDLED</button>
                    </span>
                  </div>
                ))}
                {data.requests.length === 0 && <span className="rail-help pt-2">Nobody waiting.</span>}
              </div>
            </section>

            <TopupsCard onChanged={refresh} />

            <EnginesCard />

            <section className="scard">
              <div className="scard-h"><span>Workspaces</span><span>{data.workspaces.length} on this deployment. The studio&rsquo;s own is the platform. {data.platformKeysByDefault ? `Every other one starts on the platform's keys with ${data.signupCredits} credits (one credit is ${usd(data.creditUsd, 2)} of vendor cost) — or on its own keys once its owner switches. Click a balance to add credits.` : "Every other one brings its own keys (PLATFORM_KEYS_FOR_NEW_WORKSPACES=0)."}{!data.gatewayMint && " Set VERCEL_TOKEN and VERCEL_TEAM_ID so each new workspace is minted a Vercel AI Gateway key of its own."}</span></div>
              <div className="flex flex-col">
                <div className="steam is-head !grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_170px_150px_190px]"><span>WORKSPACE</span><span>OWNER</span><span>30 DAYS</span><span>KEYS</span><span className="text-right">STATE</span></div>
                {data.workspaces.map((w) => (
                  <div key={w.id} className={`steam !grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_170px_150px_190px] ${w.suspended ? "opacity-70" : ""}`}>
                    <span className="flex flex-col gap-0.5"><span className="font-medium">{w.name}{w.flagged ? <span className="ml-2 text-[11px] text-lift" title={w.flagNote ?? ""}>FLAGGED</span> : null}</span><span className="text-[11.5px] text-dim">{w.slug}{w.legacy ? " · the studio's own" : ""} · {w.members} member{w.members === 1 ? "" : "s"} · {timeAgo(w.createdAt)}</span></span>
                    <span className="flex flex-col gap-0.5"><span>{w.owner?.name ?? "—"}</span><span className="text-[11.5px] text-dim">{w.owner?.email ?? ""}</span></span>
                    <SpendCell s={w.spend30} />
                    <CreditsCell w={w} onChanged={refresh} />
                    <StateCell w={w} onChanged={refresh} />
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** Whose keys a workspace runs on, and — on the platform's — its credit balance, with a way to add some. */
function CreditsCell({ w, onChanged }: {
  w: { id: string; legacy: boolean; platformKeys: boolean; credits: { granted: number; used: number; balance: number } | null; gatewayKey: boolean };
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  if (w.legacy) return <span className="mono-s">THE PLATFORM</span>;
  if (!w.platformKeys) return <span className="mono-s">ITS OWN</span>;
  async function grant() {
    const n = Number(val);
    if (!Number.isFinite(n) || n === 0) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/workspaces/${encodeURIComponent(w.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantCredits: n, note: "Added by management" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      setEditing(false); setVal(""); onChanged();
    } catch (e) { await appAlert("Not added", (e as Error).message); }
    finally { setBusy(false); }
  }
  const c = w.credits;
  if (editing) {
    return (
      <span className="flex items-center gap-1">
        <input className="ctl !h-7 !w-[84px] !px-2 !text-[12px]" value={val} onChange={(e) => setVal(e.target.value)} placeholder="+ credits" autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") grant(); if (e.key === "Escape") setEditing(false); }} aria-label="Credits to add" />
        <button type="button" className="btn-primary !h-7 !px-2 !text-[11px]" onClick={grant} disabled={busy || !val.trim()}>Add</button>
      </span>
    );
  }
  return (
    <button type="button" className="mono-s text-left hover:text-ink" title={c ? `${creditsNumber(c.used)} used of ${creditsNumber(c.granted)} granted — click to add credits` : "Click to add credits"} onClick={() => setEditing(true)}>
      PLATFORM · {c ? `${creditsNumber(c.balance)} CR` : "—"}{w.gatewayKey ? " · OWN GATEWAY KEY" : ""}
    </button>
  );
}

type Queue = {
  provider: "manual" | "stripe" | "razorpay";
  open: QueueRow[]; decided: QueueRow[];
};
type QueueRow = {
  id: string; workspaceId: string; workspaceName: string; workspaceSlug: string; packId: string; label: string;
  credits: number; usd: number; status: "requested" | "approved" | "declined" | "cancelled"; note: string;
  requesterEmail: string | null; requesterName: string | null; createdAt: number; decidedAt: number | null;
};

/** Packs asked for, waiting on an answer. Approving adds the credits and releases held takes. */
function TopupsCard({ onChanged }: { onChanged: () => void }) {
  const { data, refresh } = useApi<Queue>("/api/admin/topups", 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(id: string, action: "approve" | "decline") {
    if (action === "decline" && !(await appConfirm("Decline this request?", "The workspace keeps its balance as it is; they can ask again.", { confirmLabel: "Decline", danger: true }))) return;
    setBusy(id);
    try {
      const res = await fetch("/api/admin/topups", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not answer it");
      if (action === "approve") await appAlert("Credits added", json.released ? `${json.request.credits.toLocaleString()} credits are in and ${json.released} held take${json.released === 1 ? "" : "s"} released.` : `${json.request.credits.toLocaleString()} credits are in.`);
      refresh(); onChanged();
    } catch (e) { await appAlert("Not answered", (e as Error).message); }
    finally { setBusy(null); }
  }
  if (!data) return null;
  const when = (ms: number) => timeAgo(ms).toUpperCase();
  return (
    <section className="scard">
      <div className="scard-h"><span>Top-ups</span><span>{data.provider === "manual"
        ? "Packs workspaces have asked for. Take payment your own way, then approve: the credits go in at once and anything held releases itself."
        : `Card checkout through ${data.provider} approves these on its own; this is the record.`}</span></div>
      <div className="flex flex-col">
        <div className="steam is-head !grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_110px_90px_170px]"><span>WORKSPACE</span><span>ASKED BY</span><span>PACK</span><span className="text-right">WHEN</span><span className="text-right">ANSWER</span></div>
        {data.open.map((r) => (
          <div key={r.id} className="steam !grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_110px_90px_170px]">
            <span className="flex flex-col gap-0.5"><span className="font-medium">{r.workspaceName}</span><span className="text-[11.5px] text-dim">{r.note || r.workspaceSlug}</span></span>
            <span className="flex flex-col gap-0.5"><span>{r.requesterName ?? "—"}</span><span className="text-[11.5px] text-dim">{r.requesterEmail ?? ""}</span></span>
            <span className="flex flex-col gap-0.5"><span className="mono-v">{r.credits.toLocaleString()} cr</span><span className="text-[11.5px] text-dim">{r.label} · ${r.usd.toLocaleString()}</span></span>
            <span className="mono-s text-right">{when(r.createdAt)}</span>
            <span className="flex justify-end gap-1.5">
              <button type="button" className="btn-secondary !h-7 !px-2.5 !text-[12px]" disabled={busy != null} onClick={() => decide(r.id, "decline")}>Decline</button>
              <button type="button" className="btn-primary !h-7 !px-2.5 !text-[12px]" disabled={busy != null} onClick={() => decide(r.id, "approve")}>{busy === r.id ? "…" : "Approve"}</button>
            </span>
          </div>
        ))}
        {data.open.length === 0 && <span className="rail-help pt-2">Nothing waiting.</span>}
        {data.decided.slice(0, 8).map((r) => (
          <div key={r.id} className="steam !grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_110px_90px_170px] opacity-60">
            <span className="flex flex-col gap-0.5"><span>{r.workspaceName}</span><span className="text-[11.5px] text-dim">{r.workspaceSlug}</span></span>
            <span className="text-dim">{r.requesterName ?? "—"}</span>
            <span className="mono-v">{r.credits.toLocaleString()} cr</span>
            <span className="mono-s text-right">{r.decidedAt ? when(r.decidedAt) : ""}</span>
            <span className="mono-s text-right">{r.status.toUpperCase()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Thirty days of a workspace on the platform's money: what the engines charged, what was billed, the margin between. */
function SpendCell({ s }: { s: Ws["spend30"] }) {
  if (!s || !s.jobs) return <span className="mono-s">—</span>;
  const m = s.marginUsd;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="mono-v">{usd(s.engineCostUsd, 2)} · {Math.round(s.billedCredits).toLocaleString()} CR</span>
      <span className={`text-[11.5px] ${m < 0 ? "text-lift" : "text-dim"}`}>margin {m < 0 ? "−" : "+"}{usd(Math.abs(m), 2)} · {s.jobs} job{s.jobs === 1 ? "" : "s"}{s.failed ? ` · ${s.failed} failed` : ""}{s.running ? ` · ${s.running} running` : ""}</span>
    </span>
  );
}

/** Active, flagged for review, or suspended — and the two levers. */
function StateCell({ w, onChanged }: { w: Ws; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/workspaces/${encodeURIComponent(w.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      onChanged();
    } catch (e) { await appAlert("Not changed", (e as Error).message); }
    finally { setBusy(false); }
  }
  async function suspend() {
    const reason = await appPrompt("Suspend this workspace? Say why — they will read it.", w.suspendedReason ?? "", "Content policy: under review");
    if (reason === null) return;
    await patch({ suspended: true, reason });
  }
  async function flag() {
    const note = await appPrompt("Flag this workspace for review. A note for the desk; they do not see it.", w.flagNote ?? "", "Prompts refused twice today");
    if (note === null) return;
    await patch({ flagged: true, note });
  }
  if (w.legacy) return <span className="mono-s text-right">THE PLATFORM</span>;
  return (
    <span className="flex flex-col items-end gap-1">
      <span className={`mono-s ${w.suspended ? "text-lift" : ""}`} title={w.suspended ? w.suspendedReason ?? "" : w.flagNote ?? ""}>{w.suspended ? "SUSPENDED" : w.flagged ? "FLAGGED" : "ACTIVE"}</span>
      <span className="flex gap-1.5">
        {w.suspended
          ? <button type="button" className="chip !py-0.5 !text-[11.5px]" disabled={busy} onClick={() => patch({ suspended: false })}>Resume</button>
          : <button type="button" className="chip !py-0.5 !text-[11.5px] !text-lift" disabled={busy} onClick={suspend}>Suspend</button>}
        {w.flagged
          ? <button type="button" className="chip !py-0.5 !text-[11.5px]" disabled={busy} onClick={() => patch({ flagged: false })}>Clear flag</button>
          : <button type="button" className="chip !py-0.5 !text-[11.5px]" disabled={busy} onClick={flag}>Flag</button>}
      </span>
    </span>
  );
}

type Health = { engine: string; model: string; jobs: number; failed: number; running: number; failRate: number; avgMs: number | null; maxMs: number | null; engineCostUsd: number };

/** Every engine across every workspace: what ran, what failed, how long it took. */
function EnginesCard() {
  const { data } = useApi<{ day: Health[]; week: Health[] }>("/api/admin/engines", 60_000);
  if (!data) return null;
  const byKey = new Map(data.day.map((h) => [`${h.engine}/${h.model}`, h]));
  const rows = data.week.map((w) => ({ w, d: byKey.get(`${w.engine}/${w.model}`) ?? null }));
  const pct = (h: Health | null) => (h && h.jobs ? `${Math.round(h.failRate * 100)}%` : "—");
  const wait = (h: Health | null) => (h?.avgMs != null ? `${Math.round(h.avgMs / 1000)}s` : "—");
  return (
    <section className="scard">
      <div className="scard-h"><span>Engines</span><span>Across every workspace, from the meter: jobs, failure rate and the average wait for a finished job, over a day and a week.</span></div>
      {rows.length === 0 ? <span className="rail-help">Nothing has run in the last week.</span> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-mute"><th className="pb-2 font-medium">Engine</th><th className="pb-2 font-medium">Model</th><th className="pb-2 text-right font-medium">24h jobs</th><th className="pb-2 text-right font-medium">Failed</th><th className="pb-2 text-right font-medium">7d jobs</th><th className="pb-2 text-right font-medium">Failed</th><th className="pb-2 text-right font-medium">Avg wait</th><th className="pb-2 text-right font-medium">7d cost</th></tr></thead>
            <tbody>
              {rows.map(({ w, d }) => (
                <tr key={`${w.engine}/${w.model}`} className="border-t border-hair">
                  <td className="py-2 pr-3">{w.engine}</td>
                  <td className="py-2 pr-3 text-dim">{w.model}</td>
                  <td className="py-2 text-right tabular-nums">{d?.jobs ?? 0}</td>
                  <td className={`py-2 text-right tabular-nums ${d && d.failRate > 0.2 ? "text-lift" : "text-dim"}`}>{pct(d)}</td>
                  <td className="py-2 text-right tabular-nums">{w.jobs}</td>
                  <td className={`py-2 text-right tabular-nums ${w.failRate > 0.2 ? "text-lift" : "text-dim"}`}>{pct(w)}</td>
                  <td className="py-2 text-right tabular-nums text-dim">{wait(w)}</td>
                  <td className="py-2 text-right tabular-nums text-dim">{usd(w.engineCostUsd, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
