"use client";
import { useCallback, useEffect, useState } from "react";
import { WORKSPACE_TABS } from "@/lib/shell/ia";
import { ENHANCER_LABEL, ENHANCER_NOTE, ENHANCER_PROVIDERS, isEnhancerProvider, type EnhancerProvider } from "@/lib/shell/enhancer";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { creditsLabel } from "@/lib/workspace/format";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { XaiEngineRow } from "./crew/XaiEngineRow";
import { DeveloperApiRow } from "./DeveloperApiRow";
import { ConnectedAccountRow } from "./ConnectedAccountRow";
import { ManagementDashboard } from "./ManagementDashboard";

/**
 * Workspace (FINAL_SPEC §5): General · People · Plans & credits · Usage · Dashboard ·
 * Engines · Security, each in Graphite on the route that already serves it.
 * Nothing links out to a legacy page any more; what a route does not offer
 * is said on the tab, never faked.
 */
const cr = (n: number) => `${n.toLocaleString("en-US")} cr`;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "never");

function useRead<T>(url: string | null) {
  const scoped = useScopedFetch();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    if (!url) return;
    try {
      const response = await scoped(url, { cache: "no-store" });
      const json = await response.json().catch(() => null) as (T & { error?: string }) | null;
      if (!response.ok) throw new Error(json?.error ?? "This could not be read.");
      setData(json); setError(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "This could not be read."); }
  }, [scoped, url]);
  useEffect(() => { const t = setTimeout(() => void read(), 0); return () => clearTimeout(t); }, [read]);
  return { data, error, read };
}

export function WorkspaceView({ account }: { account: WorkspaceAccount | null }) {
  const shell = useShell();
  const session = useSession();
  const scopedFetch = useScopedFetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const credits = creditsLabel(account?.credits?.balance ?? null, session.rates.unit, session.rates.creditUsd);
  const change = async (action: "switch" | "logout", id?: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await scopedFetch(action === "switch" ? "/api/workspaces/switch" : "/api/auth/logout", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "switch" ? { id } : {}),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Your account could not be changed. Please try again.");
      window.location.assign(action === "switch" ? "/suites" : "/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your account could not be changed. Please try again.");
      setBusy(false);
    }
  };
  const current = account?.workspace?.id ?? session.workspace?.id ?? null;
  const others = (session.workspaces ?? []).filter((w) => w.id !== current);
  const name = account?.workspace?.name ?? session.workspace?.name ?? "Workspace";
  return (
    <div className="gx-workspace gx-scroll" data-testid="workspace-view">
      <div className="wsx">
        <h1 className="gx-h1">Workspace</h1>
        <div className="gx-seg" role="tablist" aria-label="Workspace sections" style={{ alignSelf: "flex-start", maxWidth: "100%", overflowX: "auto" }}>
          {WORKSPACE_TABS.map((t) => (
            <button key={t.id} type="button" role="tab" className="gx-seg-btn" aria-selected={shell.wsTab === t.id} onClick={() => shell.goWorkspace(t.id)}><span>{t.label}</span></button>
          ))}
        </div>
        {shell.wsTab === "general" ? <General name={name} /> : null}
        {shell.wsTab === "people" ? <People /> : null}
        {shell.wsTab === "credits" ? <Plans credits={credits} /> : null}
        {shell.wsTab === "usage" ? <Usage /> : null}
        {shell.wsTab === "dashboard" ? <ManagementDashboard /> : null}
        {shell.wsTab === "engines" ? <Engines /> : null}
        {shell.wsTab === "security" ? <Security /> : null}
        {shell.wsTab === "general" ? (
          <div className="wsx-card">
            <span className="gx-eyebrow">{name}{session.role ? ` · ${session.role}` : ""}</span>
            {error ? <p role="alert" style={{ margin: 0, color: "var(--gx-failed)" }}>{error}</p> : null}
            {others.map((w) => (
              <button key={w.id} type="button" className="gx-rowlink" disabled={busy} onClick={() => change("switch", w.id)}><span>Switch to {w.name}</span><span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>›</span></button>
            ))}
            <button type="button" className="gx-rowlink" disabled={busy} onClick={() => change("logout")} data-testid="sign-out"><span>Sign out</span><span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>›</span></button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── General ─────────────────────────────────────────────────────────── */
type Settings = { settings: Record<string, string>; defaults: Record<string, string> };
function General({ name }: { name: string }) {
  const scoped = useScopedFetch();
  const session = useSession();
  const { data, error, read } = useRead<Settings>("/api/settings");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const admin = session.role === "admin" || session.role === "owner";
  const value = (key: string) => draft[key] ?? data?.settings[key] ?? data?.defaults[key] ?? "";
  const dirty = Object.keys(draft).some((k) => draft[k] !== (data?.settings[k] ?? data?.defaults[k] ?? ""));
  const save = async () => {
    setSaving(true); setNote(null);
    try {
      const response = await scoped("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The settings could not be saved.");
      setDraft({}); setNote("Saved."); void read();
    } catch (caught) { setNote(caught instanceof Error ? caught.message : "The settings could not be saved."); }
    finally { setSaving(false); }
  };
  const enhancer: EnhancerProvider = isEnhancerProvider(value("promptEnhancer")) ? (value("promptEnhancer") as EnhancerProvider) : "higgsfield";
  return (
    <div className="wsx-card" data-testid="ws-general">
      <span className="gx-eyebrow">General</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      <div className="wsx-grid">
        <label className="wsx-label"><span className="gx-eyebrow">Workspace name</span><input className="gx-field" value={name} readOnly title="Renaming lives with the platform; the name here is the workspace’s own." /></label>
        <label className="wsx-label"><span className="gx-eyebrow">Default delivery format</span>
          <select className="cw-select" value={value("editOutputFormat")} disabled={!admin} onChange={(e) => setDraft({ ...draft, editOutputFormat: e.target.value })} data-testid="ws-format"><option value="mp4">MP4 · H.264</option><option value="mov">MOV · ProRes</option><option value="webm">WebM · VP9</option></select>
        </label>
        <label className="wsx-label"><span className="gx-eyebrow">Cost approval</span>
          <select className="cw-select" value={value("approvalRule")} disabled={!admin} onChange={(e) => setDraft({ ...draft, approvalRule: e.target.value })} data-testid="ws-approval"><option value="always">Every paid job asks first</option><option value="cap">Ask above a per-shot cap</option><option value="never">Members render freely</option></select>
        </label>
        <label className="wsx-label"><span className="gx-eyebrow">Per-shot cap (cr)</span><input className="gx-field" inputMode="numeric" value={value("shotCapCredits")} disabled={!admin || value("approvalRule") !== "cap"} onChange={(e) => setDraft({ ...draft, shotCapCredits: e.target.value.replace(/[^0-9]/g, "") })} /></label>
      </div>
      <div className="wsx-label">
        <span className="gx-eyebrow">Prompt enhancer</span>
        <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Prompt enhancer" style={{ alignSelf: "flex-start" }}>
          {ENHANCER_PROVIDERS.map((p) => <button key={p} type="button" role="radio" aria-checked={enhancer === p} className="gx-seg-btn" disabled={!admin} onClick={() => setDraft({ ...draft, promptEnhancer: p })} data-testid={`ws-enhancer-${p}`}><span>{ENHANCER_LABEL[p]}</span></button>)}
        </div>
        <span className="cw-dim">{ENHANCER_NOTE[enhancer]} A local enhancement costs 1 cr; a connected model that enhances on the account does it inside the render.</span>
      </div>
      <div className="wsx-actions">
        <button type="button" className="gx-primary" disabled={!admin || !dirty || saving} onClick={() => void save()} data-testid="ws-save">{saving ? "Saving…" : "Save"}</button>
        {!admin ? <span className="gx-reason">Workspace settings are an admin’s to change.</span> : null}
        {note ? <span className="cw-dim" role="status" data-testid="ws-note">{note}</span> : null}
      </div>
    </div>
  );
}

/* ── People ──────────────────────────────────────────────────────────── */
type Team = { canSeeRoles: boolean; users: { id: string; email: string; name: string; role?: string; standing?: string; permanent?: boolean; disabled: boolean; locked: boolean; lastSeen: number | null; clips: number }[]; invites: { code: string; email: string; name: string; role?: string; expiresAt: number }[] };
function People() {
  const scoped = useScopedFetch();
  const session = useSession();
  const { data, error, read } = useRead<Team>("/api/team");
  const [invite, setInvite] = useState({ name: "", email: "", role: "member" });
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const admin = session.role === "admin" || session.role === "owner";
  const patch = async (id: string, body: Record<string, unknown>) => {
    setNote(null);
    try {
      const response = await scoped(`/api/team/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "That change could not be made.");
      void read();
    } catch (caught) { setNote(caught instanceof Error ? caught.message : "That change could not be made."); }
  };
  const send = async () => {
    setNote(null); setLink(null);
    try {
      const response = await scoped("/api/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(invite) });
      const json = await response.json().catch(() => null) as { code?: string; error?: string } | null;
      if (!response.ok || !json?.code) throw new Error(json?.error ?? "The invitation could not be made.");
      setLink(`${window.location.origin}/invite/${json.code}`); setInvite({ name: "", email: "", role: "member" }); void read();
    } catch (caught) { setNote(caught instanceof Error ? caught.message : "The invitation could not be made."); }
  };
  return (
    <div className="wsx-card" data-testid="ws-people">
      <span className="gx-eyebrow">People</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      {(data?.users ?? []).map((u) => (
        <div className="wsx-row" key={u.id} data-testid="ws-member">
          <span className="wsx-initials" aria-hidden="true">{initials(u.name)}</span>
          <span style={{ minWidth: 0 }}><span className="wsx-name">{u.name}</span><span className="cw-dim">{u.email} · last seen {when(u.lastSeen)} · {u.clips} {u.clips === 1 ? "clip" : "clips"}{u.disabled ? " · disabled" : ""}{u.locked ? " · locked" : ""}</span></span>
          <span className="wsx-actions">
            {u.role ? <span className="gx-pill">{u.standing === "owner" ? "owner" : u.role}</span> : null}
            {admin && data?.canSeeRoles && !u.permanent && u.role === "member" ? <button type="button" className="gx-hbtn" onClick={() => void patch(u.id, { role: "admin" })}>Promote</button> : null}
            {admin && u.locked ? <button type="button" className="gx-hbtn" onClick={() => void patch(u.id, { unlock: true })}>Unlock</button> : null}
          </span>
        </div>
      ))}
      {(data?.invites ?? []).map((i) => (
        <div className="wsx-row" key={i.code}><span className="wsx-initials" aria-hidden="true">…</span><span style={{ minWidth: 0 }}><span className="wsx-name">{i.name}</span><span className="cw-dim">{i.email} · invited · expires {when(i.expiresAt)}</span></span><span className="gx-pill">{i.role ?? "invited"}</span></div>
      ))}
      {admin ? (
        <div className="wsx-grid" style={{ alignItems: "end" }}>
          <label className="wsx-label"><span className="gx-eyebrow">Name</span><input className="gx-field" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} data-testid="ws-invite-name" /></label>
          <label className="wsx-label"><span className="gx-eyebrow">Email</span><input className="gx-field" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} data-testid="ws-invite-email" /></label>
          <button type="button" className="gx-hbtn" disabled={!invite.name.trim() || !invite.email.trim()} onClick={() => void send()} data-testid="ws-invite">Invite · one-time link</button>
        </div>
      ) : <span className="gx-reason">Inviting is an admin’s to do.</span>}
      {link ? <p className="gx-gen-note" role="status" data-testid="ws-invite-link">One-time link: <code className="cw-mono">{link}</code></p> : null}
      {note ? <p className="gx-gen-error" role="alert">{note}</p> : null}
    </div>
  );
}

/* ── Plans & credits ─────────────────────────────────────────────────── */
type Billing = { canManage: boolean; plans?: { id: string; label?: string; name?: string }[]; packs: { id: string; label: string; credits: number; bonus: number; total: number; usd: number }[]; subscription?: { plan?: string; status?: string; renewsAt?: number } | null; credits?: { balance?: number; granted?: number; used?: number } };
function Plans({ credits }: { credits: { text: string; title: string } }) {
  const { data, error } = useRead<Billing>("/api/billing");
  const { data: statements } = useRead<{ months?: string[] }>("/api/statements");
  const plan = data?.plans?.find((p) => p.id === data.subscription?.plan);
  return (
    <div className="wsx-card" data-testid="ws-plans">
      <span className="gx-eyebrow">Balance</span>
      <span className="wsx-balance" title={credits.title} data-testid="workspace-balance">{credits.text}</span>
      <span className="cw-dim">{plan ? `${plan.label ?? plan.name ?? plan.id} plan` : data?.subscription?.plan ? `${data.subscription.plan} plan` : "No plan on record"}{data?.subscription?.status ? ` · ${data.subscription.status}` : ""}</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      {/* Packs are not listed: the app has no purchase route, and a feature with no API workflow behind it is not shown (owner's rule, 22 September). */}
      <span className="gx-eyebrow">Statements</span>
      <div className="wsx-actions">
        {(statements?.months ?? []).slice(0, 12).map((m) => <a key={m} className="gx-hbtn" href={`/api/statements?month=${m}`}>{m}</a>)}
        {!statements?.months?.length ? <span className="cw-dim">Statements are the owner’s and admins’ to read; none yet.</span> : null}
      </div>
    </div>
  );
}

/* ── Usage ───────────────────────────────────────────────────────────── */
type UsageData = { unit?: string; spentCredits?: number; credits?: { balance?: number; used?: number; granted?: number }; models?: { model: string; engine?: string; kind?: string; n?: number; credits?: number }[]; vendors?: { id: string; label: string; spent?: number; models?: { model: string; label?: string; n?: number; spend?: number }[] }[] };
function Usage() {
  const { data, error } = useRead<UsageData>("/api/usage");
  const rows = data?.models?.length
    ? data.models.map((m) => ({ id: `${m.engine ?? ""}/${m.model}`, label: m.model, n: m.n ?? 0, amount: m.credits ?? 0, unit: "cr" }))
    : (data?.vendors ?? []).flatMap((v) => (v.models ?? []).map((m) => ({ id: `${v.id}/${m.model}`, label: `${m.label ?? m.model} · ${v.label}`, n: m.n ?? 0, amount: m.spend ?? 0, unit: "$" })));
  const max = Math.max(1, ...rows.map((r) => r.amount));
  const total = rows.reduce((n, r) => n + r.amount, 0);
  const unit = rows[0]?.unit ?? "cr";
  return (
    <div className="wsx-card" data-testid="ws-usage">
      <span className="gx-eyebrow">Usage</span>
      <span className="cw-dim">Settled spend · {unit === "cr" ? cr(Math.round(total)) : `$${total.toFixed(2)}`} · failed renders not billed</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      {rows.filter((r) => r.amount > 0 || r.n > 0).sort((a, b) => b.amount - a.amount).map((r) => (
        <div className="wsx-bar" key={r.id} data-testid="ws-usage-bar">
          <span title={r.label}>{r.label}</span>
          <span className="wsx-bar-track"><span className="wsx-bar-fill" style={{ width: `${Math.max(2, (r.amount / max) * 100)}%` }} /></span>
          <span className="cw-mono">{unit === "cr" ? cr(Math.round(r.amount)) : `$${r.amount.toFixed(2)}`} · {r.n}</span>
        </div>
      ))}
      {data && !rows.length ? <span className="cw-dim">Nothing settled yet.</span> : null}
    </div>
  );
}

/* ── Engines ─────────────────────────────────────────────────────────── */
type Keys = { keys: { name: string; label: string; does: string; set: boolean; masked: string | null }[]; allowance?: { usd: number; spentUsd: number } | null };
function Engines() {
  const scoped = useScopedFetch();
  const session = useSession();
  const { data, error, read } = useRead<Keys>("/api/workspaces/keys");
  const [entering, setEntering] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const owner = session.role === "owner";
  const save = async (name: string) => {
    setNote(null);
    try {
      const response = await scoped("/api/workspaces/keys", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, value: key.trim() }) });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The key could not be saved.");
      setKey(""); setEntering(null); setNote("Key saved."); void read();
    } catch (caught) { setNote(caught instanceof Error ? caught.message : "The key could not be saved."); }
  };
  return (
    <>
      <div className="wsx-card" data-testid="ws-engines">
        <span className="gx-eyebrow">Engines</span>
        {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
        {(data?.keys ?? []).filter((k) => k.name !== "xai").map((k) => (
          <div className="wsx-row" key={k.name} data-testid="ws-engine">
            <span className="cw-engine" data-ok={k.set}><span className="cw-engine-dot" aria-hidden="true" /></span>
            <span style={{ minWidth: 0 }}><span className="wsx-name">{k.label} · {k.set ? "connected" : "platform key"}</span><span className="cw-dim">{k.does}{k.masked ? ` · ${k.masked}` : ""}</span></span>
            <span className="wsx-actions">
              {owner ? <button type="button" className="gx-hbtn" onClick={() => { setEntering(entering === k.name ? null : k.name); setKey(""); }}>{k.set ? "Replace key" : "Connect"}</button> : null}
            </span>
            {entering === k.name ? (
              <div className="wsx-actions" style={{ gridColumn: "1 / -1" }}>
                <input className="gx-field" type="password" autoComplete="off" aria-label={`${k.label} key`} placeholder={k.name === "higgsfield" ? "KEY_ID:KEY_SECRET" : "API key"} value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: "1 1 220px", width: "auto" }} />
                <button type="button" className="gx-hbtn" disabled={key.trim().length < 8} onClick={() => void save(k.name)}>Save key</button>
              </div>
            ) : null}
          </div>
        ))}
        <span className="cw-dim">Keys are encrypted and never returned. Verify checks access categories and quotes only — it never trains, generates or spends.{owner ? "" : " Keys are the owner’s to change."}</span>
        {note ? <p className="gx-gen-note" role="status">{note}</p> : null}
      </div>
      <ConnectedAccountRow owner={owner} />
      <XaiEngineRow />
      <DeveloperApiRow />
    </>
  );
}

/* ── Security ────────────────────────────────────────────────────────── */
type SecurityData = { sessions?: { id: string; current?: boolean; createdAt?: number; lastSeen?: number; agent?: string }[]; mfa?: { enabled?: boolean; required?: boolean } | boolean; passwordPolicy?: Record<string, unknown>; audit?: { at: number; event: string }[]; [key: string]: unknown };
function Security() {
  const { data, error } = useRead<SecurityData>("/api/account/security");
  const shell = useShell();
  const sessions = Array.isArray(data?.sessions) ? data!.sessions! : [];
  const mfa = typeof data?.mfa === "object" && data?.mfa ? data.mfa : null;
  return (
    <div className="wsx-card" data-testid="ws-security">
      <span className="gx-eyebrow">Security</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      <div className="wsx-grid">
        <div className="wsx-label"><span className="gx-eyebrow">Sessions</span><span className="cw-dim">{data ? `${sessions.length || 1} signed in` : "Reading…"}</span>
          {sessions.slice(0, 8).map((s) => <span key={s.id} className="cw-dim">{s.current ? "This browser" : s.agent ?? "Session"} · {when(s.lastSeen ?? s.createdAt)}</span>)}
        </div>
        <div className="wsx-label"><span className="gx-eyebrow">Two-step sign-in</span><span className="cw-dim">{mfa ? (mfa.enabled ? "On" : "Off") + (mfa.required ? " · required by the workspace" : "") : data ? "See the account’s security page" : "Reading…"}</span></div>
        <div className="wsx-label"><span className="gx-eyebrow">Media access</span><span className="cw-dim">Originals are served signed, per workspace, never public.</span></div>
        <div className="wsx-label"><span className="gx-eyebrow">Audit</span><span className="cw-dim">{Array.isArray(data?.audit) && data!.audit!.length ? data!.audit!.slice(0, 5).map((a) => `${a.event} · ${when(a.at)}`).join(" · ") : "Sign-ins, key changes and role changes are kept with the account."}</span></div>
      </div>
      <span className="cw-dim">Password, two-step enrolment and session sign-out change with your account, on the account’s own security page — the one place a password is ever typed. <a className="cw-link" href="/account/security">Open account security</a></span>
      <button type="button" className="gx-hbtn" style={{ alignSelf: "flex-start" }} onClick={() => shell.goWorkspace("general")}>Back to General</button>
    </div>
  );
}
