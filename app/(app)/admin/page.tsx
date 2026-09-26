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
import { DEFAULT_PLANS, type PlanDef, type PlanId } from "@/lib/plans";
import { CATEGORIES } from "@/lib/studio";
import { REASON_LABELS } from "@/lib/reports";
import { getModel, MODELS } from "@/lib/models";
import { TEXT_JOBS, TEXT_JOB_LABELS, TEXT_MODEL_IDS, textModelFor, RULE_SCOPES, RULE_SCOPE_LABELS } from "@/lib/platformLayer";
import { PREVIEW_MODELS, PREVIEW_RESOLUTIONS, PREVIEW_DURATIONS } from "@/lib/previews";

type Admin = {
  ready: boolean; mail: boolean;
  invites: { code: string; email: string; name: string; note: string; createdAt: number; expiresAt: number; sentAt: number | null; sendCount: number }[];
  requests: { id: string; name: string; email: string; note: string; mailed: boolean; createdAt: number }[];
  platformKeysByDefault: boolean; defaultAllowanceUsd: number | null;
  creditUsd: number; welcomeCredits: number | null;
  plans: PlanDef[];
  concurrency: { byEngine: { engine: string; peak: number; at: number; jobs: number }[]; overall: { peak: number; at: number }; days: number } | null;
  workspaces: Ws[];
};
type Ws = {
  id: string; slug: string; name: string; legacy: boolean; platformKeys: boolean; allowanceUsd: number | null; gatewayKey: boolean;
  credits: { granted: number; used: number; balance: number } | null; createdAt: number; deletedAt: number | null; owner: { email: string; name: string } | null; members: number;
  spend30: { jobs: number; failed: number; running: number; engineCostUsd: number; billedCredits: number; marginUsd: number } | null;
  grants: { paid: number; free: number };
  suspended: boolean; suspendedReason: string | null; flagged: boolean; flagNote: string | null;
  limits: { concurrency: number | null; rendersPerHour: number | null; storageGb: number | null };
  internalTest?: boolean;
  planId: PlanId | null;
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

  // A deleted workspace is kept, not live: it is counted apart from the rest.
  const deleted = data ? data.workspaces.filter((w) => w.deletedAt).length : 0,
    live = data ? data.workspaces.length - deleted : 0;

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
            {!data.ready && <p className="rail-help text-lift">Sign-up isn&rsquo;t open yet: set TURSO_API_TOKEN, TURSO_ORG and KEYRING_SECRET in the hosting environment so new workspaces can be given a database and hold keys.</p>}

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

            <ReportsCard />

            <TopupsCard onChanged={refresh} />

            <EnginesCard />
            <ConcurrencyCard c={data.concurrency} />

            <PlatformLayerCard />

            <PreviewsCard />

            <section className="scard">
              <div className="scard-h"><span>Workspaces</span><span>{live} on this deployment{deleted ? `, ${deleted} deleted` : ""}. The studio&rsquo;s own is the platform. {data.platformKeysByDefault ? `Every other one starts on the platform's keys: ${data.welcomeCredits ?? "—"} credits from an approved invitation, 0 from self-serve sign-up (one credit is ${usd(data.creditUsd, 2)} of vendor cost). Click a balance to add credits.` : "Every other one brings its own keys (PLATFORM_KEYS_FOR_NEW_WORKSPACES=0)."}</span></div>
              <div className="flex flex-col">
                <div className="steam is-head !grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_170px_150px_190px]"><span>WORKSPACE</span><span>OWNER</span><span>30 DAYS</span><span>KEYS</span><span className="text-right">STATE</span></div>
                {data.workspaces.map((w) => (
                  <div key={w.id} className={`steam !grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_170px_150px_190px] ${w.deletedAt ? "opacity-60" : w.suspended ? "opacity-70" : ""}`}>
                    <span className="flex flex-col gap-0.5"><span className="font-medium">{w.name}{w.deletedAt ? <span className="ml-2 text-[11px] text-lift">DELETED</span> : w.flagged ? <span className="ml-2 text-[11px] text-lift" title={w.flagNote ?? ""}>FLAGGED</span> : null}</span><span className="text-[11.5px] text-dim">{w.slug}{w.legacy ? " · the studio's own" : ""} · {w.members} member{w.members === 1 ? "" : "s"} · {timeAgo(w.createdAt)}</span></span>
                    <span className="flex flex-col gap-0.5"><span>{w.owner?.name ?? "—"}</span><span className="text-[11.5px] text-dim">{w.owner?.email ?? ""}</span></span>
                    <SpendCell s={w.spend30} grants={w.grants} />
                    <CreditsCell w={w} onChanged={refresh} />
                    <StateCell w={w} plans={data.plans ?? DEFAULT_PLANS} onChanged={refresh} />
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
  w: { id: string; legacy: boolean; platformKeys: boolean; credits: { granted: number; used: number; balance: number } | null; gatewayKey: boolean; deletedAt: number | null };
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  if (w.legacy) return <span className="mono-s">THE PLATFORM</span>;
  if (!w.platformKeys) return <span className="mono-s">ITS OWN</span>;
  // Nobody can open a deleted workspace, so its balance is read, not topped up.
  if (w.deletedAt) return <span className="mono-s">PLATFORM · {w.credits ? `${creditsNumber(w.credits.balance)} CR` : "—"}</span>;
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
  credits: number; bonus: number; usd: number; status: "requested" | "approved" | "declined" | "cancelled"; note: string;
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
      if (action === "approve") {
        // What landed, not what was charged for: the bonus is credits too.
        const arrived = (json.request.credits + (json.request.bonus ?? 0)).toLocaleString();
        await appAlert("Credits added", json.released ? `${arrived} credits are in and ${json.released} held take${json.released === 1 ? "" : "s"} released.` : `${arrived} credits are in.`);
      }
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
            <span className="flex flex-col gap-0.5"><span className="mono-v">{(r.credits + r.bonus).toLocaleString()} cr</span><span className="text-[11.5px] text-dim">{r.label} · ${r.usd.toLocaleString()}{r.bonus > 0 ? ` · ${r.bonus.toLocaleString()} free` : ""}</span></span>
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
            <span className="mono-v">{(r.credits + r.bonus).toLocaleString()} cr</span>
            <span className="mono-s text-right">{r.decidedAt ? when(r.decidedAt) : ""}</span>
            <span className="mono-s text-right">{r.status.toUpperCase()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Thirty days of a workspace on the platform's money: what the engines
 * charged, what was billed, the margin between.
 *
 * The margin counts only the share of those credits somebody bought, so a
 * workspace living on its welcome grant no longer reads as revenue. When any
 * of the balance was given rather than sold the cell says so — otherwise a
 * margin quietly reduced by apportioning looks like a workspace that renders
 * expensively, which is a different problem with a different answer.
 */
function SpendCell({ s, grants }: { s: Ws["spend30"]; grants: Ws["grants"] }) {
  if (!s || !s.jobs) return <span className="mono-s">—</span>;
  const m = s.marginUsd;
  const free = grants?.free ?? 0;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="mono-v">{usd(s.engineCostUsd, 2)} · {Math.round(s.billedCredits).toLocaleString()} CR</span>
      <span className={`text-[11.5px] ${m < 0 ? "text-lift" : "text-dim"}`}>margin {m < 0 ? "−" : "+"}{usd(Math.abs(m), 2)} · {s.jobs} job{s.jobs === 1 ? "" : "s"}{s.failed ? ` · ${s.failed} failed` : ""}{s.running ? ` · ${s.running} running` : ""}</span>
      {free > 0 && <span className="text-[11.5px] text-mute">{Math.round(free).toLocaleString()} of {Math.round(free + (grants?.paid ?? 0)).toLocaleString()} CR given, not sold</span>}
    </span>
  );
}

/** Active, flagged for review, or suspended — and the two levers. */
function StateCell({ w, plans, onChanged }: { w: Ws; plans: PlanDef[]; onChanged: () => void }) {
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
  async function setLimits() {
    const cur = `${w.limits.concurrency ?? ""} / ${w.limits.rendersPerHour ?? ""} / ${w.limits.storageGb ?? ""}`;
    const raw = await appPrompt("This workspace's own limits: renders at once / renders an hour / GB kept. Leave a number blank for the platform's default.", cur.trim() === "/ /" ? "" : cur, "4 / 60 / 50");
    if (raw === null) return;
    const parts = raw.split("/").map((s) => s.trim());
    const num = (s: string | undefined) => (s == null || s === "" ? null : Number(s));
    await patch({ limits: { concurrency: num(parts[0]), rendersPerHour: num(parts[1]), storageGb: num(parts[2]) } });
  }
  async function flag() {
    const note = await appPrompt("Flag this workspace for review. A note for the desk; they do not see it.", w.flagNote ?? "", "Prompts refused twice today");
    if (note === null) return;
    await patch({ flagged: true, note });
  }
  async function restore() {
    if (!(await appConfirm("Restore this workspace?", "Its owner gets access back and turns the rest of the team on from People.", { confirmLabel: "Restore" }))) return;
    await patch({ restore: true });
  }
  if (w.legacy) return <span className="mono-s text-right">THE PLATFORM</span>;
  if (w.deletedAt) return (
    <span className="flex flex-col items-end gap-1">
      <span className="mono-s text-lift">DELETED {timeAgo(w.deletedAt).toUpperCase()}</span>
      <button type="button" className="chip !py-0.5 !text-[11.5px]" disabled={busy} onClick={restore}>Restore</button>
    </span>
  );
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
        <button type="button" className="chip !py-0.5 !text-[11.5px]" disabled={busy} onClick={setLimits} title={`Own limits: ${w.limits.concurrency ?? "—"} at once · ${w.limits.rendersPerHour ?? "—"} an hour · ${w.limits.storageGb ?? "—"} GB`}>Limits</button>
        <button type="button" className={`chip !py-0.5 !text-[11.5px] ${w.internalTest ? "is-on" : ""}`} disabled={busy} onClick={() => patch({ internalTest: !w.internalTest })} title="The platform's own internal test workspace: the one place a real engine call may be made for the platform's sake">{w.internalTest ? "Test workspace" : "Make test"}</button>
        <PlanChip w={w} plans={plans} busy={busy} patch={patch} />
      </span>
    </span>
  );
}

/**
 * Which plan a workspace is on, and the one control that changes it.
 *
 * NOTHING ABOUT CREDITS MOVES HERE. A plan's included credits are granted per
 * cycle and that grant does not exist yet — it waits on a draw order that is
 * still undecided (§14). This records which plan, which is the part that can
 * be true today and the part the console has had no way to say at all.
 *
 * "None" is a real answer, not a missing one: it is every workspace until
 * somebody is put on a plan, and it is deliberately not the same as Invite,
 * which carries a 1-production and 3-member ceiling.
 */
function PlanChip({ w, plans, busy, patch }: {
  w: Ws; plans: PlanDef[]; busy: boolean; patch: (body: Record<string, unknown>) => void;
}) {
  const on = plans.find((p) => p.id === w.planId) ?? null;
  const label = on ? `${on.label}${on.priceUsd ? ` · $${on.priceUsd}/mo` : ""}` : "No plan";
  return (
    <label className={`chip !py-0.5 !text-[11.5px] ${on ? "is-on" : ""}`} title={on
      ? `${on.label}: ${on.includedCredits.toLocaleString()} credits a cycle${on.maxProductions ? `, ${on.maxProductions} project${on.maxProductions === 1 ? "" : "s"}` : ""}${on.maxMembers ? `, ${on.maxMembers} members` : ""}. Included credits are not granted yet.`
      : "On no plan. Not the same as Invite, which carries its own ceilings."}>
      <select
        value={w.planId ?? ""}
        disabled={busy}
        aria-label={`Plan for ${w.name}`}
        onChange={(e) => patch({ planId: e.target.value || null })}
      >
        <option value="">No plan</option>
        {plans.map((p) => <option key={p.id} value={p.id}>{p.label}{p.priceUsd ? ` · $${p.priceUsd}/mo` : ""}</option>)}
      </select>
      {label}
    </label>
  );
}

/**
 * The most an engine ever ran at once (SOW §7).
 *
 * This is the number to take to a provider when asking for a higher limit,
 * and it is DERIVED rather than sampled: every meter row records when its
 * job began and when it stopped, so the peak is a property of the intervals
 * and can be read for any window, including ones that ended before anybody
 * thought to measure them.
 *
 * The platform's own peak is shown apart from the engines' and is NOT their
 * sum — those happen at different moments, and adding them would quote a
 * number the platform never reached.
 */
function ConcurrencyCard({ c }: { c: Admin["concurrency"] }) {
  if (!c || !c.byEngine.length) return null;
  const when = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
  return (
    <section className="scard">
      <div className="scard-h">
        <span>Peak concurrency</span>
        <span>The most that ever ran at once on each engine, over {c.days} days, on the platform&rsquo;s keys. Read from the meter&rsquo;s own intervals, so it is exact rather than sampled — this is the figure to quote when asking a provider for a higher limit.</span>
      </div>
      <div className="flex flex-col">
        <div className="steam is-head !grid-cols-[minmax(0,1fr)_90px_90px_190px]">
          <span>ENGINE</span><span className="text-right">PEAK</span><span className="text-right">JOBS</span><span className="text-right">WHEN</span>
        </div>
        {c.byEngine.map((e: { engine: string; peak: number; at: number; jobs: number }) => (
          <div key={e.engine} className="steam !grid-cols-[minmax(0,1fr)_90px_90px_190px]">
            <span className="font-medium">{e.engine}</span>
            <span className="mono-v text-right">{e.peak}</span>
            <span className="mono-s text-right text-dim">{e.jobs}</span>
            <span className="mono-s text-right text-dim">{when(e.at)}</span>
          </div>
        ))}
        <div className="steam !grid-cols-[minmax(0,1fr)_90px_90px_190px] opacity-70">
          <span>Everything at once</span>
          <span className="mono-v text-right">{c.overall.peak}</span>
          <span className="mono-s text-right text-dim">—</span>
          <span className="mono-s text-right text-dim">{when(c.overall.at)}</span>
        </div>
      </div>
      <span className="rail-help">The platform figure is not the engines&rsquo; added together: those peaks happen at different moments.</span>
    </section>
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

type Layer = {
  setup: Record<string, string>;
  starter: { name: string; code: string; description: string; shots: { code: string; title: string; description: string; planned: number; setup: Record<string, string>; cast: string[] }[]; cast: { name: string; kind: "character" | "location" | "prop" | "style"; description: string }[] };
  rules: { id: string; text: string; scope: string; apply: "writer" | "prompt"; on: boolean }[];
  caps: { defaultCapCredits: number | null; signupCredits: number | null; warnPct: number; concurrency: number; rendersPerHour: number; storageGb: number };
  models: { video: string; image: string; text?: Record<string, string> };
};
type LayerView = { layer: Layer; stored: string[]; defaults: Layer; cameraBank: { kind: string; value: string; label: string; module: string }[] };

/**
 * The platform layer: what every new workspace inherits. Four parts, each
 * with a default in code that the desk may override here, and put back.
 */
function PlatformLayerCard() {
  const { data, refresh } = useApi<LayerView>("/api/admin/platform-layer", 60_000);
  const [draft, setDraft] = useState<Layer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showBank, setShowBank] = useState(false);
  const layer = draft ?? data?.layer ?? null;
  if (!data || !layer) return null;
  const stored = new Set(data.stored);
  const set = (patch: Partial<Layer>) => setDraft({ ...(draft ?? data.layer), ...patch });
  async function save(key: keyof Layer, reset = false) {
    setBusy(key);
    try {
      const res = await fetch("/api/admin/platform-layer", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reset ? { key, reset: true } : { key, value: layer![key] }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      setDraft(null); refresh();
    } catch (e) { await appAlert("Not saved", (e as Error).message); }
    finally { setBusy(null); }
  }
  const actions = (k: keyof Layer) => (
    <span className="flex items-center gap-2">
      {stored.has(k) && <span className="mono-s">OVERRIDDEN</span>}
      <button type="button" className="chip !py-0.5 !text-[11.5px]" disabled={busy != null} onClick={() => save(k, true)}>Default</button>
      <button type="button" className="btn-primary !h-7 !px-2.5 !text-[12px]" disabled={busy != null} onClick={() => save(k)}>{busy === k ? "…" : "Save"}</button>
    </span>
  );
  const shots = layer.starter.shots;
  return (
    <section className="scard">
      <div className="scard-h"><span>Platform layer</span><span>What every new workspace inherits: the default Setup, the starter project, the rules the compiler applies, and the numbers a workspace starts with. Each part has a default; Save keeps your version, Default puts it back.</span></div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3"><p className="grouplabel !pb-0">Default Setup</p>{actions("setup")}</div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-3 lg:grid-cols-4">
          {CATEGORIES.map((c) => (
            <label key={c.key} className="flex flex-col gap-1 text-[12px] text-dim">
              {c.label}
              <select className="ctl !h-8 !text-[13px]" value={layer.setup[c.key] ?? ""} onChange={(e) => { const next = { ...layer.setup }; if (e.target.value) next[c.key] = e.target.value; else delete next[c.key]; set({ setup: next }); }}>
                <option value="">—</option>
                {c.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3"><p className="grouplabel !pb-0">Starter project</p>{actions("starter")}</div>
        <div className="grid gap-2 md:grid-cols-[1fr_120px]">
          <input className="ctl !h-8 !text-[13px]" value={layer.starter.name} aria-label="Project name" onChange={(e) => set({ starter: { ...layer.starter, name: e.target.value } })} />
          <input className="ctl !h-8 !text-[13px]" value={layer.starter.code} aria-label="Code" onChange={(e) => set({ starter: { ...layer.starter, code: e.target.value } })} />
        </div>
        <input className="ctl !h-8 !text-[13px]" value={layer.starter.description} aria-label="Description" onChange={(e) => set({ starter: { ...layer.starter, description: e.target.value } })} />
        {shots.map((s, i) => (
          <div key={i} className="grid gap-2 rounded-[10px] bg-panel2 p-2 md:grid-cols-[90px_1fr_70px_auto]">
            <input className="ctl !h-8 !text-[13px]" value={s.code} aria-label="Shot code" onChange={(e) => set({ starter: { ...layer.starter, shots: shots.map((x, j) => j === i ? { ...x, code: e.target.value } : x) } })} />
            <input className="ctl !h-8 !text-[13px]" value={s.title} aria-label="Shot title" onChange={(e) => set({ starter: { ...layer.starter, shots: shots.map((x, j) => j === i ? { ...x, title: e.target.value } : x) } })} />
            <input className="ctl !h-8 !text-[13px]" type="number" min={1} max={60} value={s.planned} aria-label="Planned seconds" onChange={(e) => set({ starter: { ...layer.starter, shots: shots.map((x, j) => j === i ? { ...x, planned: Number(e.target.value) } : x) } })} />
            <button type="button" className="chip !py-0.5 !text-[11.5px]" onClick={() => set({ starter: { ...layer.starter, shots: shots.filter((_, j) => j !== i) } })}>Remove</button>
            <textarea className="ctl !h-16 !text-[13px] md:col-span-4" value={s.description} aria-label="Shot description" onChange={(e) => set({ starter: { ...layer.starter, shots: shots.map((x, j) => j === i ? { ...x, description: e.target.value } : x) } })} />
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="chip !py-0.5 !text-[11.5px]" onClick={() => set({ starter: { ...layer.starter, shots: [...shots, { code: `SH0${(shots.length + 1) * 10}`, title: "", description: "", planned: 5, setup: {}, cast: [] }] } })}>+ Shot</button>
        </div>
        {layer.starter.cast.map((c, i) => (
          <div key={i} className="grid gap-2 md:grid-cols-[140px_120px_1fr_auto]">
            <input className="ctl !h-8 !text-[13px]" value={c.name} aria-label="Cast name" onChange={(e) => set({ starter: { ...layer.starter, cast: layer.starter.cast.map((x, j) => j === i ? { ...x, name: e.target.value } : x) } })} />
            <select className="ctl !h-8 !text-[13px]" value={c.kind} aria-label="Cast kind" onChange={(e) => set({ starter: { ...layer.starter, cast: layer.starter.cast.map((x, j) => j === i ? { ...x, kind: e.target.value as Layer["starter"]["cast"][number]["kind"] } : x) } })}>
              {["character", "location", "prop", "style"].map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input className="ctl !h-8 !text-[13px]" value={c.description} aria-label="Cast description" onChange={(e) => set({ starter: { ...layer.starter, cast: layer.starter.cast.map((x, j) => j === i ? { ...x, description: e.target.value } : x) } })} />
            <button type="button" className="chip !py-0.5 !text-[11.5px]" onClick={() => set({ starter: { ...layer.starter, cast: layer.starter.cast.filter((_, j) => j !== i) } })}>Remove</button>
          </div>
        ))}
        <div><button type="button" className="chip !py-0.5 !text-[11.5px]" onClick={() => set({ starter: { ...layer.starter, cast: [...layer.starter.cast, { name: "", kind: "character", description: "" }] } })}>+ Cast</button></div>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3"><p className="grouplabel !pb-0">Rules</p>{actions("rules")}</div>
        <p className="text-[12.5px] text-dim">A rule for the writer steers the prompt writer; a rule for the prompt is appended to the prompt itself, in scope. An engine-only rule is that engine&rsquo;s dialect. Every workspace inherits these; switching one off here switches it off everywhere.</p>
        {layer.rules.map((r, i) => (
          <div key={r.id} className="grid items-center gap-2 md:grid-cols-[auto_110px_120px_1fr_auto]">
            <input type="checkbox" checked={r.on} aria-label="On" onChange={(e) => set({ rules: layer.rules.map((x, j) => j === i ? { ...x, on: e.target.checked } : x) })} />
            <select className="ctl !h-8 !text-[13px]" value={r.scope} aria-label="Scope" onChange={(e) => set({ rules: layer.rules.map((x, j) => j === i ? { ...x, scope: e.target.value } : x) })}>
              {RULE_SCOPES.map((s) => <option key={s} value={s}>{RULE_SCOPE_LABELS[s]}</option>)}
            </select>
            <select className="ctl !h-8 !text-[13px]" value={r.apply} aria-label="Applies to" onChange={(e) => set({ rules: layer.rules.map((x, j) => j === i ? { ...x, apply: e.target.value as Layer["rules"][number]["apply"] } : x) })}>
              <option value="writer">for the writer</option><option value="prompt">in the prompt</option>
            </select>
            <input className="ctl !h-8 !text-[13px]" value={r.text} aria-label="Rule" onChange={(e) => set({ rules: layer.rules.map((x, j) => j === i ? { ...x, text: e.target.value } : x) })} />
            <button type="button" className="chip !py-0.5 !text-[11.5px]" onClick={() => set({ rules: layer.rules.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <div><button type="button" className="chip !py-0.5 !text-[11.5px]" onClick={() => set({ rules: [...layer.rules, { id: `rule-${Date.now().toString(36)}`, text: "", scope: "all", apply: "writer", on: true }] })}>+ Rule</button></div>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3"><p className="grouplabel !pb-0">Default engines</p>{actions("models")}</div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-[12px] text-dim">Default video engine
            <select className="ctl !h-8 !text-[13px]" value={layer.models.video} onChange={(e) => set({ models: { ...layer.models, video: e.target.value } })}>
              {MODELS.filter((m) => m.kind === "video" && !m.hidden).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select></label>
          <label className="flex flex-col gap-1 text-[12px] text-dim">Default still engine
            <select className="ctl !h-8 !text-[13px]" value={layer.models.image} onChange={(e) => set({ models: { ...layer.models, image: e.target.value } })}>
              {MODELS.filter((m) => m.kind === "image" && !m.hidden).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select></label>
          {TEXT_JOBS.map((job) => (
            <label key={job} className="flex flex-col gap-1 text-[12px] text-dim">{TEXT_JOB_LABELS[job]} — model
              <select className="ctl !h-8 !text-[13px]" value={textModelFor(layer.models, job)} onChange={(e) => set({ models: { ...layer.models, text: { ...(layer.models.text ?? {}), [job]: e.target.value } } })}>
                {TEXT_MODEL_IDS.map((id) => <option key={id} value={id}>{id.split("/").pop()}</option>)}
              </select></label>
          ))}
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3"><p className="grouplabel !pb-0">Default caps</p>{actions("caps")}</div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-[12px] text-dim">Welcome credits (blank = the deployment&rsquo;s)
            <input className="ctl !h-8 !text-[13px]" type="number" min={0} value={layer.caps.signupCredits ?? ""} onChange={(e) => set({ caps: { ...layer.caps, signupCredits: e.target.value === "" ? null : Number(e.target.value) } })} /></label>
          <label className="flex flex-col gap-1 text-[12px] text-dim">A new project&rsquo;s cap, in credits (blank = none)
            <input className="ctl !h-8 !text-[13px]" type="number" min={0} value={layer.caps.defaultCapCredits ?? ""} onChange={(e) => set({ caps: { ...layer.caps, defaultCapCredits: e.target.value === "" ? null : Number(e.target.value) } })} /></label>
          <label className="flex flex-col gap-1 text-[12px] text-dim">Warn the producer at, % of cap
            <input className="ctl !h-8 !text-[13px]" type="number" min={1} max={100} value={layer.caps.warnPct} onChange={(e) => set({ caps: { ...layer.caps, warnPct: Number(e.target.value) } })} /></label>
          <label className="flex flex-col gap-1 text-[12px] text-dim">Renders at once (past it a take waits)
            <input className="ctl !h-8 !text-[13px]" type="number" min={1} max={100} value={layer.caps.concurrency} onChange={(e) => set({ caps: { ...layer.caps, concurrency: Number(e.target.value) } })} /></label>
          <label className="flex flex-col gap-1 text-[12px] text-dim">Renders an hour
            <input className="ctl !h-8 !text-[13px]" type="number" min={1} max={10000} value={layer.caps.rendersPerHour} onChange={(e) => set({ caps: { ...layer.caps, rendersPerHour: Number(e.target.value) } })} /></label>
          <label className="flex flex-col gap-1 text-[12px] text-dim">Storage kept, GB
            <input className="ctl !h-8 !text-[13px]" type="number" min={1} max={100000} value={layer.caps.storageGb} onChange={(e) => set({ caps: { ...layer.caps, storageGb: Number(e.target.value) } })} /></label>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3"><p className="grouplabel !pb-0">Camera bank</p><button type="button" className="chip !py-0.5 !text-[11.5px]" onClick={() => setShowBank((v) => !v)}>{showBank ? "Hide" : `Show ${data.cameraBank.length} modules`}</button></div>
        <p className="text-[12.5px] text-dim">The moves and techniques every workspace renders with, as the compiler writes them today. Their wording is edited with the rule library (2.5); this is the bank as it reads.</p>
        {showBank && (
          <div className="flex flex-col gap-1.5">
            {data.cameraBank.map((m) => (
              <div key={`${m.kind}/${m.value}`} className="rounded-[10px] bg-panel2 px-3 py-2 text-[12.5px]"><span className="font-medium">{m.label}</span> <span className="mono-s">{m.kind.toUpperCase()}</span><p className="mt-1 text-dim">{m.module || "—"}</p></div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

type Report = { id: string; url: string; reason: string; details: string; email: string | null; workspace: { id: string; name: string; slug: string } | null; accountEmail: string | null; createdAt: number; handledAt: number | null };

/** What was reported, open first. Handling it is the desk's; suspending is on the workspace's row below. */
function ReportsCard() {
  const { data, refresh } = useApi<{ open: Report[]; handled: Report[] }>("/api/admin/reports", 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  async function handled(id: string) {
    setBusy(id);
    try { await fetch("/api/admin/reports", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }); refresh(); }
    finally { setBusy(null); }
  }
  if (!data) return null;
  const label = (r: string) => (REASON_LABELS as Record<string, string>)[r] ?? r;
  return (
    <section className="scard">
      <div className="scard-h"><span>Reports</span><span>What people reported, open first. Read it, act on the workspace&rsquo;s row below if it needs it, then mark it handled.</span></div>
      <div className="flex flex-col">
        {data.open.map((r) => (
          <div key={r.id} className="steam !grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_90px_110px]">
            <span className="flex flex-col gap-0.5"><span className="font-medium">{label(r.reason)}</span><span className="break-all text-[11.5px] text-dim">{r.url}</span>{r.details && <span className="text-[12px] text-dim">{r.details}</span>}</span>
            <span className="flex flex-col gap-0.5"><span>{r.workspace?.name ?? "—"}</span><span className="text-[11.5px] text-dim">{r.email ?? r.accountEmail ?? "no reply address"}</span></span>
            <span className="mono-s text-right">{timeAgo(r.createdAt).toUpperCase()}</span>
            <span className="flex justify-end"><button type="button" className="chip !py-0.5 !text-[11.5px]" disabled={busy != null} onClick={() => handled(r.id)}>{busy === r.id ? "…" : "Handled"}</button></span>
          </div>
        ))}
        {data.open.length === 0 && <span className="rail-help pt-2">Nothing reported.</span>}
        {data.handled.slice(0, 5).map((r) => (
          <div key={r.id} className="steam !grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_90px_110px] opacity-60">
            <span className="flex flex-col gap-0.5"><span>{label(r.reason)}</span><span className="break-all text-[11.5px] text-dim">{r.url}</span></span>
            <span>{r.workspace?.name ?? "—"}</span>
            <span className="mono-s text-right">{r.handledAt ? timeAgo(r.handledAt).toUpperCase() : ""}</span>
            <span className="mono-s text-right">HANDLED</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── The bank's neutral previews: one costed batch, from the test workspace (brief 1.4) ── */
type PreviewsView = {
  plan: { modelId: string; resolution: string; duration: number; count: number; perClipUsd: number; totalUsd: number; perClipCredits: number; totalCredits: number; items: { key: string; label: string; kind: string }[] };
  scene: string;
  workspace: { id: string; name: string; internalTest: boolean } | null;
  candidates: { genId: string; key: string; model: string; costUsd: number | null; status: string; createdAt: number }[];
  assets: { key: string; bytes: number; model: string | null; costUsd: number | null; createdAt: number }[];
};

function PreviewsCard() {
  const [model, setModel] = useState<string>(PREVIEW_MODELS[0]);
  const [resolution, setResolution] = useState<string>(PREVIEW_RESOLUTIONS[0]);
  const [duration, setDuration] = useState<number>(PREVIEW_DURATIONS[0]);
  const q = `model=${encodeURIComponent(model)}&resolution=${resolution}&duration=${duration}`;
  const { data, refresh } = useApi<PreviewsView>(`/api/admin/previews?${q}`, 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; failed: number } | null>(null);
  if (!data) return null;
  const { plan, workspace, candidates, assets } = data;
  const ready = candidates.filter((c) => c.status === "succeeded").length;
  const running = candidates.filter((c) => c.status === "running" || c.status === "held").length;
  const testOk = Boolean(workspace?.internalTest);
  const credits = plan.totalCredits;

  async function generate() {
    if (!workspace || !testOk) return;
    const ok = await appConfirm(
      `Render ${plan.count} previews in ${workspace.name} for $${plan.totalUsd.toFixed(2)}?`,
      `${plan.count} clips × $${plan.perClipUsd.toFixed(3)} at ${getModel(plan.modelId).label}, ${plan.resolution}, ${plan.duration}s, silent. ${assets.length ? `${assets.length} previews are already published; publishing again replaces them.` : "This runs once for the whole platform."}`,
      { confirmLabel: `Spend $${plan.totalUsd.toFixed(2)}`, danger: true },
    );
    if (!ok) return;
    setBusy("generate"); setProgress({ done: 0, failed: 0 });
    let done = 0, failed = 0;
    for (const item of plan.items) {
      try {
        const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          prompt: data!.scene, model: plan.modelId, resolution: plan.resolution, ratio: "16:9", duration: plan.duration, generateAudio: false,
          shotSpec: { [item.kind]: item.key.split(":")[1] }, previewFor: item.key, projectId: null,
        }) });
        if (!res.ok) failed++; else done++;
      } catch { failed++; }
      setProgress({ done, failed });
    }
    setBusy(null); refresh();
  }

  async function publish() {
    setBusy("publish");
    try {
      const res = await fetch("/api/admin/previews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "publish" }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      await appAlert("Published", `${(j.published ?? []).length} previews are now the platform's.${(j.failed ?? []).length ? ` ${(j.failed ?? []).length} did not copy.` : ""}`);
      refresh();
    } catch (e) { await appAlert("Not published", (e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <section className="scard">
      <div className="scard-h"><span>Camera previews</span><span>One neutral clip per move and technique, rendered once from the test workspace and served to every workspace.</span></div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-[12px] text-dim">Engine
          <select className="ctl !h-8 !text-[13px]" value={model} onChange={(e) => setModel(e.target.value)}>
            {PREVIEW_MODELS.map((m) => <option key={m} value={m}>{getModel(m).label}</option>)}
          </select></label>
        <label className="flex flex-col gap-1 text-[12px] text-dim">Resolution
          <select className="ctl !h-8 !text-[13px]" value={resolution} onChange={(e) => setResolution(e.target.value)}>
            {PREVIEW_RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select></label>
        <label className="flex flex-col gap-1 text-[12px] text-dim">Seconds
          <select className="ctl !h-8 !text-[13px]" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {PREVIEW_DURATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <span className="font-semibold text-ink">{plan.count} clips × ${plan.perClipUsd.toFixed(3)} = ${plan.totalUsd.toFixed(2)}</span>
        <span className="text-mute">≈ {credits.toLocaleString("en-US")} cr at the engine&rsquo;s margin</span>
        <span className="text-mute">{workspace ? (testOk ? `From ${workspace.name} (test workspace)` : `${workspace.name} is not a test workspace — switch to one, or mark one above`) : "No workspace"}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary !h-8 !px-3 !text-[12.5px]" disabled={!testOk || busy != null} onClick={generate}>
          {busy === "generate" && progress ? `Rendering… ${progress.done + progress.failed} of ${plan.count}` : `Render ${plan.count} previews`}
        </button>
        <button type="button" className="chip" disabled={!testOk || busy != null || !ready} onClick={publish}>{busy === "publish" ? "Publishing…" : `Publish ${ready} ready`}</button>
        {running > 0 && <span className="text-[12.5px] text-mute">{running} still rendering</span>}
        <span className="ml-auto text-[12.5px] text-mute">{assets.length} of {plan.count} published</span>
      </div>
      {assets.length > 0 && (
        <p className="mt-2 text-[12px] text-mute">Published: {assets.map((a) => a.key).join(" · ")}</p>
      )}
    </section>
  );
}
