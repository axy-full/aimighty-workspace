"use client";
import { useCallback, useEffect, useState } from "react";
import { cleanRule } from "@/lib/approvalRule";
import { MODELS, displayModelName } from "@/lib/models";
import { RULE_SCOPES, RULE_SCOPE_LABELS, type RuleApply, type RuleScope } from "@/lib/platformLayer";
import { APPROVAL_OPTIONS, AT_CAP_OPTIONS, CAP_WARN_OPTIONS, EDIT_FORMAT_OPTIONS } from "@/lib/settingValues";
import { WORKSPACE_TABS } from "@/lib/shell/ia";
import { ENHANCER_LABEL, ENHANCER_NOTE, ENHANCER_PROVIDERS, isEnhancerProvider, type EnhancerProvider } from "@/lib/shell/enhancer";
import { useShell } from "@/lib/shell/state";
import {
  auditEntries, checkoutUrl, keyStatus, packLine, planLine, sessionRows, statementCsvHref, statementHref, statementMonthsOf, twoStepLine, usageRows,
  type BillingPlan, type BillingSubscription, type KeyMode, type SecurityBody, type Topups, type UsageBody,
} from "@/lib/shell/workspace-view";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { creditsLabel } from "@/lib/workspace/format";
import { requestAccountRefresh, type WorkspaceAccount } from "@/lib/workspace/data";
import { labels as AUDIT_LABELS } from "@/components/management/WorkspaceAudit";
import { XaiEngineRow } from "./crew/XaiEngineRow";
import { ConnectedAccountRow } from "./ConnectedAccountRow";
import { DeveloperApiRow } from "./DeveloperApiRow";
import { ConnectRow } from "./ConnectRow";
import { ManagementDashboard } from "./ManagementDashboard";

/**
 * Workspace (FINAL_SPEC §5): General · People · Plans & credits · Usage · Dashboard ·
 * Engines · Security, each in Graphite on the route that already serves it.
 * The one page it opens is a month's printable statement; what a route does
 * not offer is said on the tab, never faked.
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

/** One write to a route; the refusal comes back as the sentence to show. */
function useWrite() {
  const scoped = useScopedFetch();
  return useCallback(async <T,>(url: string, method: string, body?: unknown): Promise<{ json: T | null; error: string | null }> => {
    try {
      const response = await scoped(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await response.json().catch(() => null) as (T & { error?: string }) | null;
      return response.ok ? { json, error: null } : { json: null, error: json?.error ?? "That change could not be made." };
    } catch (caught) { return { json: null, error: caught instanceof Error ? caught.message : "That change could not be made." }; }
  }, [scoped]);
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
  /* A rename shows at once, here and on General's field, while /api/me catches up; the account's own name wins once it differs from what was renamed. */
  const known = account?.workspace?.name ?? session.workspace?.name ?? "Workspace";
  const [renamed, setRenamed] = useState<{ id: string | null; from: string; to: string } | null>(null);
  const name = renamed && renamed.id === current && renamed.from === known ? renamed.to : known;
  const onRenamed = (to: string) => { setRenamed({ id: current, from: known, to }); requestAccountRefresh(); };
  return (
    <div className="gx-workspace gx-scroll" data-testid="workspace-view">
      <div className="wsx">
        <h1 className="gx-h1">Workspace</h1>
        <div className="gx-seg" role="tablist" aria-label="Workspace sections" style={{ alignSelf: "flex-start", maxWidth: "100%", overflowX: "auto" }}>
          {WORKSPACE_TABS.map((t) => (
            <button key={t.id} type="button" role="tab" className="gx-seg-btn" aria-selected={shell.wsTab === t.id} onClick={() => shell.goWorkspace(t.id)}><span>{t.label}</span></button>
          ))}
        </div>
        {shell.wsTab === "general" ? <><General name={name} onRenamed={onRenamed} /><Rules /></> : null}
        {shell.wsTab === "people" ? <People /> : null}
        {shell.wsTab === "credits" ? <Plans credits={credits} /> : null}
        {shell.wsTab === "usage" ? <Usage /> : null}
        {shell.wsTab === "dashboard" ? <ManagementDashboard /> : null}
        {shell.wsTab === "engines" ? <Engines /> : null}
        {shell.wsTab === "security" ? <Security /> : null}
        {shell.wsTab === "engines" ? <ConnectRow /> : null}
        {shell.wsTab === "general" ? (
          <div className="wsx-card">
            <span className="gx-eyebrow">{name}{session.role ? ` · ${session.role}` : ""}</span>
            {error ? <p role="alert" style={{ margin: 0, color: "var(--gx-failed)" }}>{error}</p> : null}
            {others.map((w) => (
              <button key={w.id} type="button" className="gx-rowlink" disabled={busy} onClick={() => change("switch", w.id)}><span>Switch to {w.name}</span><span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>›</span></button>
            ))}
            {session.superAdmin ? <a className="gx-rowlink" href="/admin" data-testid="platform-desk"><span>Platform desk</span><span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>›</span></a> : null}
            <button type="button" className="gx-rowlink" disabled={busy} onClick={() => change("logout")} data-testid="sign-out"><span>Sign out</span><span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>›</span></button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── General ─────────────────────────────────────────────────────────── */
type Settings = { settings: Record<string, string>; defaults: Record<string, string> };
/** What the server enforces for a stored value, so the select shows the rule in force — not the first option. */
function inForce(key: string, raw: string): string {
  if (key === "approvalRule") return cleanRule(raw);
  if (key === "editOutputFormat") return raw === "mov" ? "mov" : "mp4";
  if (key === "atCap") return raw === "stop" || raw === "warn" ? raw : "producer";
  return raw;
}
const ENGINES = (kind: "video" | "image") => MODELS.filter((m) => m.kind === kind && !m.hidden);
function General({ name, onRenamed }: { name: string; onRenamed: (name: string) => void }) {
  const session = useSession();
  const write = useWrite();
  const { data, error, read } = useRead<Settings>("/api/settings");
  const [draft, setDraft] = useState<Record<string, string>>({});
  /* null until the owner types: the field shows the workspace's name as it stands. */
  const [title, setTitle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const admin = session.role === "admin" || session.role === "owner";
  const owner = session.role === "owner";
  const stored = (key: string) => inForce(key, data?.settings[key] ?? data?.defaults[key] ?? "");
  const value = (key: string) => draft[key] ?? stored(key);
  const set = (key: string, next: string) => setDraft({ ...draft, [key]: next });
  const changed = Object.keys(draft).filter((k) => draft[k] !== stored(k));
  const typed = (title ?? name).trim();
  const renamed = owner && typed !== name && typed.length > 0;
  const save = async () => {
    setSaving(true); setNote(null);
    try {
      if (renamed) {
        const { error: refused } = await write("/api/workspaces", "PATCH", { name: typed });
        if (refused) throw new Error(refused);
        onRenamed(typed); setTitle(null);
      }
      if (changed.length) {
        const { error: refused } = await write("/api/settings", "PATCH", Object.fromEntries(changed.map((k) => [k, draft[k]])));
        if (refused) throw new Error(refused);
        setDraft({}); void read();
      }
      setNote("Saved.");
    } catch (caught) { setNote(caught instanceof Error ? caught.message : "The settings could not be saved."); }
    finally { setSaving(false); }
  };
  const enhancer: EnhancerProvider = isEnhancerProvider(value("promptEnhancer")) ? (value("promptEnhancer") as EnhancerProvider) : "higgsfield";
  const select = (key: string, label: string, options: readonly (readonly [string, string])[], testId?: string, off = false) => (
    <label className="wsx-label"><span className="gx-eyebrow">{label}</span>
      <select className="cw-select" value={value(key)} disabled={!admin || off} onChange={(e) => set(key, e.target.value)} data-testid={testId}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );
  return (
    <div className="wsx-card" data-testid="ws-general">
      <span className="gx-eyebrow">General</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      <div className="wsx-grid">
        <label className="wsx-label"><span className="gx-eyebrow">Workspace name</span>
          <input className="gx-field" value={title ?? name} maxLength={80} readOnly={!owner} title={owner ? undefined : "The owner names the workspace."} onChange={(e) => setTitle(e.target.value)} data-testid="ws-name" />
        </label>
        {select("approvalRule", "Cost approval", APPROVAL_OPTIONS, "ws-approval")}
        <label className="wsx-label"><span className="gx-eyebrow">Per-shot cap (cr)</span><input className="gx-field" inputMode="numeric" value={value("shotCapCredits")} disabled={!admin || value("approvalRule") !== "cap"} onChange={(e) => set("shotCapCredits", e.target.value.replace(/[^0-9]/g, ""))} data-testid="ws-shot-cap" /></label>
        {select("capWarnPct", "Warn at", CAP_WARN_OPTIONS.some(([v]) => v === value("capWarnPct")) ? CAP_WARN_OPTIONS : [...CAP_WARN_OPTIONS, [value("capWarnPct"), `${value("capWarnPct")}% of the cap`] as const], "ws-cap-warn")}
        {select("atCap", "At a project's cap", AT_CAP_OPTIONS, "ws-at-cap")}
        {select("defaultVideoModel", "Default video engine", [["", "Platform default"], ...ENGINES("video").map((m) => [m.id, displayModelName(m.id)] as const)], "ws-default-video")}
        {select("defaultImageModel", "Default image engine", [["", "Platform default"], ...ENGINES("image").map((m) => [m.id, displayModelName(m.id)] as const)], "ws-default-image")}
        {select("editOutputFormat", "Edit & extend container", EDIT_FORMAT_OPTIONS, "ws-format")}
      </div>
      <div className="wsx-label">
        <span className="gx-eyebrow">Prompt enhancer</span>
        <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Prompt enhancer" style={{ alignSelf: "flex-start" }}>
          {ENHANCER_PROVIDERS.map((p) => <button key={p} type="button" role="radio" aria-checked={enhancer === p} className="gx-seg-btn" disabled={!admin} onClick={() => set("promptEnhancer", p)} data-testid={`ws-enhancer-${p}`}><span>{ENHANCER_LABEL[p]}</span></button>)}
        </div>
        <span className="cw-dim">{ENHANCER_NOTE[enhancer]} A local enhancement costs 1 cr; a connected model that enhances on the account does it inside the render.</span>
      </div>
      <div className="wsx-actions">
        <button type="button" className="gx-primary" disabled={!admin || (!changed.length && !renamed) || saving} onClick={() => void save()} data-testid="ws-save">{saving ? "Saving…" : "Save"}</button>
        {!admin ? <span className="gx-reason">Workspace settings are an admin’s to change.</span> : null}
        {note ? <span className="cw-dim" role="status" data-testid="ws-note">{note}</span> : null}
      </div>
      {owner ? (
        <div className="wsx-actions" data-testid="ws-export">
          <span className="gx-eyebrow">Export</span>
          <a className="gx-hbtn" href="/api/export" download>Workspace · JSON</a>
          <a className="gx-hbtn" href="/api/export?format=csv" download>Takes · CSV</a>
        </div>
      ) : null}
    </div>
  );
}

/* ── Prompt rules ────────────────────────────────────────────────────── */
/* GET /api/rules: lib/platformLayer.ts EffectiveRule. The team's rules edit in full; the platform's switch off or on. */
type Rule = { id: string; text: string; scope: RuleScope; apply: RuleApply; on: boolean; source: "platform" | "workspace" };
function Rules() {
  const write = useWrite();
  const { data, error, read } = useRead<{ rules: Rule[] }>("/api/rules");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showInherited, setShowInherited] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const rules = data?.rules ?? [];
  const mine = rules.filter((r) => r.source === "workspace");
  const inherited = rules.filter((r) => r.source !== "workspace");
  const off = inherited.filter((r) => !r.on).length;
  const act = async (key: string, url: string, method: string, body?: unknown) => {
    setBusy(key); setNote(null); setRemoving(null);
    const { error: refused } = await write(url, method, body);
    setBusy(null);
    if (refused) { setNote(refused); return false; }
    await read();
    return true;
  };
  const at = (r: Rule) => `/api/rules/${encodeURIComponent(r.id)}`;
  const row = (r: Rule) => {
    const own = r.source === "workspace";
    return (
      <div className="wsx-actions" key={r.id} data-testid="ws-rule" data-source={r.source} style={{ opacity: r.on ? 1 : 0.6 }}>
        <button type="button" role="switch" className="gx-toggle" aria-checked={r.on} aria-label={r.on ? "Switch this rule off" : "Switch this rule on"} disabled={busy != null} onClick={() => void act(r.id, at(r), "PATCH", { on: !r.on })}>
          <span className="gx-toggle-dot" aria-hidden="true" />{r.on ? "On" : "Off"}
        </button>
        {own ? (
          <>
            <input className="gx-field" defaultValue={r.text} maxLength={400} aria-label="Rule" disabled={busy != null} style={{ flex: "1 1 220px", width: "auto" }}
              onBlur={(e) => { const next = e.target.value.trim(); if (next && next !== r.text) void act(r.id, at(r), "PATCH", { text: next }); }} />
            <select className="cw-select" value={r.scope} aria-label="Scope" disabled={busy != null} style={{ width: "auto" }} onChange={(e) => void act(r.id, at(r), "PATCH", { scope: e.target.value })}>
              {RULE_SCOPES.map((s) => <option key={s} value={s}>{RULE_SCOPE_LABELS[s]}</option>)}
            </select>
            <select className="cw-select" value={r.apply} aria-label="Applies to" disabled={busy != null} style={{ width: "auto" }} onChange={(e) => void act(r.id, at(r), "PATCH", { apply: e.target.value })}>
              <option value="writer">for the writer</option><option value="prompt">in the prompt</option>
            </select>
            {/* Removed rules are archived (lib/rules.ts deleteRule), never erased; the second press confirms. */}
            <button type="button" className="gx-hbtn gx-hbtn--danger" disabled={busy != null} onClick={() => (removing === r.id ? void act(r.id, at(r), "DELETE") : setRemoving(r.id))} data-testid="ws-rule-remove">
              {removing === r.id ? "Remove it" : "Remove"}
            </button>
          </>
        ) : (
          <span style={{ flex: "1 1 220px", minWidth: 0 }}>{r.text} <span className="cw-dim">· {RULE_SCOPE_LABELS[r.scope]} · {r.apply === "writer" ? "for the writer" : "in the prompt"}</span></span>
        )}
      </div>
    );
  };
  const add = async () => {
    const next = text.trim();
    if (next && await act("add", "/api/rules", "POST", { text: next, scope: "all", apply: "prompt" })) setText("");
  };
  return (
    <div className="wsx-card" data-testid="ws-rules">
      <span className="gx-eyebrow">Prompt rules</span>
      <span className="cw-dim">Added to every prompt in scope.</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      {data ? mine.map(row) : !error ? <span className="cw-dim">Reading…</span> : null}
      <div className="wsx-actions">
        <input className="gx-field" value={text} maxLength={400} placeholder="A rule, as one sentence" aria-label="New rule" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} style={{ flex: "1 1 220px", width: "auto" }} data-testid="ws-rule-text" />
        <button type="button" className="gx-hbtn" disabled={!text.trim() || busy != null} onClick={() => void add()} data-testid="ws-rule-add">Add rule</button>
        {inherited.length ? (
          <button type="button" className="gx-hbtn" aria-expanded={showInherited} onClick={() => setShowInherited((v) => !v)} data-testid="ws-rules-inherited">
            {showInherited ? "Hide" : "Show"} {inherited.length} inherited{off ? ` · ${off} off` : ""}
          </button>
        ) : null}
      </div>
      {showInherited ? inherited.map(row) : null}
      {note ? <p className="gx-gen-error" role="alert">{note}</p> : null}
    </div>
  );
}

/* ── People ──────────────────────────────────────────────────────────── */
type Member = { id: string; email: string; name: string; role?: string; standing?: string; permanent?: boolean; disabled: boolean; locked: boolean; lastSeen: number | null; clips: number };
type Invite = { code: string; email: string; name: string; role?: string; expiresAt: number; sendCount?: number };
type Team = { canSeeRoles: boolean; mail?: { configured: boolean }; users: Member[]; invites: Invite[] };
function People() {
  const session = useSession();
  const write = useWrite();
  const admin = session.role === "admin" || session.role === "owner";
  /* The roster is the owner's and admins' (GET /api/team is admin-only); a member is told so, not shown a refusal. */
  const { data, error, read } = useRead<Team>(admin ? "/api/team" : null);
  const [invite, setInvite] = useState({ name: "", email: "", role: "member" });
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, url: string, method: string, body?: unknown, done?: string) => {
    setBusy(key); setNote(null);
    const { error: refused } = await write(url, method, body);
    setBusy(null);
    if (refused) { setNote({ ok: false, text: refused }); return; }
    if (done) setNote({ ok: true, text: done });
    void read();
  };
  const send = async () => {
    setNote(null); setLink(null);
    const { json, error: refused } = await write<{ code?: string }>("/api/team", "POST", invite);
    if (refused || !json?.code) { setNote({ ok: false, text: refused ?? "The invitation could not be made." }); return; }
    setLink(`${window.location.origin}/invite/${json.code}`); setInvite({ name: "", email: "", role: "member" }); void read();
  };
  if (!admin) return <div className="wsx-card" data-testid="ws-people"><span className="gx-eyebrow">People</span><span className="gx-reason">The team is the owner’s and admins’ to manage.</span></div>;
  const roles = Boolean(data?.canSeeRoles);
  return (
    <div className="wsx-card" data-testid="ws-people">
      <span className="gx-eyebrow">People</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      {(data?.users ?? []).map((u) => {
        const self = Boolean(session.email) && u.email === session.email;
        const fixed = Boolean(u.permanent) || u.standing === "owner";
        return (
          <div className="wsx-row" key={u.id} data-testid="ws-member">
            <span className="wsx-initials" aria-hidden="true">{initials(u.name)}</span>
            <span style={{ minWidth: 0 }}><span className="wsx-name">{u.name}</span><span className="cw-dim">{u.email} · last seen {when(u.lastSeen)} · {u.clips} {u.clips === 1 ? "clip" : "clips"}{u.disabled ? " · disabled" : ""}{u.locked ? " · locked" : ""}</span></span>
            <span className="wsx-actions">
              {u.role ? <span className="gx-pill">{u.standing === "owner" ? "owner" : u.role}</span> : null}
              {roles && !fixed && u.role === "member" ? <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void act(u.id, `/api/team/${encodeURIComponent(u.id)}`, "PATCH", { role: "admin" })}>Promote</button> : null}
              {roles && !fixed && u.role === "admin" ? <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void act(u.id, `/api/team/${encodeURIComponent(u.id)}`, "PATCH", { role: "member" })}>Make member</button> : null}
              {u.locked ? <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void act(u.id, `/api/team/${encodeURIComponent(u.id)}`, "PATCH", { unlock: true })}>Unlock</button> : null}
              {/* Disabling ends access and keeps everything they made; it is undone the same way. Offered where the
                  roster says who owns the workspace (the owner's view), so the owner's own row never carries a refusal. */}
              {roles && !fixed && !self ? <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void act(u.id, `/api/team/${encodeURIComponent(u.id)}`, "PATCH", { disabled: !u.disabled }, u.disabled ? `${u.name} can sign in again.` : `${u.name} is disabled; their work stays.`)} data-testid="ws-member-disable">{u.disabled ? "Enable" : "Disable"}</button> : null}
            </span>
          </div>
        );
      })}
      {(data?.invites ?? []).map((i) => (
        <div className="wsx-row" key={i.code} data-testid="ws-invite-row">
          <span className="wsx-initials" aria-hidden="true">…</span>
          <span style={{ minWidth: 0 }}><span className="wsx-name">{i.name}</span><span className="cw-dim">{i.email} · invited · expires {when(i.expiresAt)}</span></span>
          <span className="wsx-actions">
            <span className="gx-pill">{i.role ?? "invited"}</span>
            {data?.mail?.configured ? <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void act(i.code, `/api/team/invites/${encodeURIComponent(i.code)}/send`, "POST", undefined, `Sent to ${i.email} again.`)}>Resend</button> : null}
            <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void act(i.code, `/api/team/invites/${encodeURIComponent(i.code)}`, "DELETE", undefined, `The link for ${i.email} no longer works.`)} data-testid="ws-invite-revoke">Revoke</button>
          </span>
        </div>
      ))}
      <div className="wsx-grid" style={{ alignItems: "end" }}>
        <label className="wsx-label"><span className="gx-eyebrow">Name</span><input className="gx-field" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} data-testid="ws-invite-name" /></label>
        <label className="wsx-label"><span className="gx-eyebrow">Email</span><input className="gx-field" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} data-testid="ws-invite-email" /></label>
        <button type="button" className="gx-hbtn" disabled={!invite.name.trim() || !invite.email.trim()} onClick={() => void send()} data-testid="ws-invite">Invite · one-time link</button>
      </div>
      {link ? <p className="gx-gen-note" role="status" data-testid="ws-invite-link">One-time link: <code className="cw-mono">{link}</code></p> : null}
      {note ? <p className={note.ok ? "gx-gen-note" : "gx-gen-error"} role={note.ok ? "status" : "alert"} data-testid="ws-people-note">{note.text}</p> : null}
    </div>
  );
}

/* ── Plans & credits ─────────────────────────────────────────────────── */
type Billing = { canManage: boolean; plans?: BillingPlan[]; subscription?: BillingSubscription | null };
function Plans({ credits }: { credits: { text: string; title: string } }) {
  const session = useSession();
  const write = useWrite();
  const admin = session.role === "admin" || session.role === "owner";
  const { data, error } = useRead<Billing>("/api/billing");
  /* Statements are the owner's and admins' (the route answers 403 to anyone else). */
  const statements = useRead<unknown>(admin ? "/api/statements" : null);
  const topups = useRead<Topups>("/api/workspaces/topups");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const months = statementMonthsOf(statements.data);
  const packs = topups.data?.applies ? topups.data.packs : [];
  const open = (topups.data?.requests ?? []).filter((r) => r.status === "requested");
  const request = async (packId: string) => {
    setBusy(packId); setNote(null);
    const { json, error: refused } = await write<{ checkout?: { kind: string; url?: string } }>("/api/workspaces/topups", "POST", { packId });
    setBusy(null);
    if (refused) { setNote({ ok: false, text: refused }); return; }
    const url = json?.checkout?.kind === "redirect" ? checkoutUrl(json.checkout.url, window.location.origin) : null;
    if (json?.checkout?.kind === "redirect") {
      if (url) { window.location.assign(url); return; }
      setNote({ ok: false, text: "Checkout returned an address this page will not open." }); return;
    }
    setNote({ ok: true, text: "Requested. The balance updates once the platform confirms payment." });
    void topups.read();
  };
  const withdraw = async (id: string) => {
    setBusy(id); setNote(null);
    const { error: refused } = await write(`/api/workspaces/topups?id=${encodeURIComponent(id)}`, "DELETE");
    setBusy(null);
    setNote(refused ? { ok: false, text: refused } : { ok: true, text: "Request withdrawn." });
    void topups.read();
  };
  return (
    <div className="wsx-card" data-testid="ws-plans">
      <span className="gx-eyebrow">Balance</span>
      <span className="wsx-balance" title={credits.title} data-testid="workspace-balance">{credits.text}</span>
      <span className="cw-dim" data-testid="ws-plan-line">{planLine(data?.plans, data?.subscription)}</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      {packs.length ? (
        <>
          <span className="gx-eyebrow">Add credits</span>
          <div className="wsx-packs">
            {packs.map((p) => (
              <div className="wsx-pack" key={p.id} data-testid="ws-pack">
                <span className="wsx-name">{p.label}</span>
                <span className="cw-mono">{packLine(p)}</span>
                <button type="button" className="gx-hbtn" disabled={!topups.data?.canRequest || busy != null} onClick={() => void request(p.id)} data-testid="ws-pack-request">
                  {busy === p.id ? "Requesting…" : topups.data?.provider === "manual" ? "Request pack" : "Buy credits"}
                </button>
              </div>
            ))}
          </div>
          {!topups.data?.canRequest ? <span className="gx-reason">The owner or an admin asks for credits.</span> : null}
          {open.map((r) => (
            <div className="wsx-actions" key={r.id} data-testid="ws-topup-request">
              <span className="cw-dim">{r.label} · {cr(r.credits + r.bonus)} · waiting on the platform</span>
              {topups.data?.canRequest ? <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void withdraw(r.id)}>Withdraw</button> : null}
            </div>
          ))}
        </>
      ) : null}
      {note ? <p className={note.ok ? "gx-gen-note" : "gx-gen-error"} role={note.ok ? "status" : "alert"} data-testid="ws-plans-note">{note.text}</p> : null}
      {admin ? (
        <>
          <span className="gx-eyebrow">Statements</span>
          <div className="wsx-actions">
            {months.slice(0, 12).map((m) => (
              <span className="wsx-actions" key={m.month}>
                <a className="gx-hbtn" href={statementHref(m.month)} data-testid="ws-statement">{m.month}</a>
                <a className="gx-hbtn" href={statementCsvHref(m.month)} download aria-label={`${m.month} as CSV`}>CSV</a>
              </span>
            ))}
            {statements.data && !months.length ? <span className="cw-dim">Nothing billed yet.</span> : null}
            {statements.error ? <span className="gx-gen-error" role="alert">{statements.error}</span> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ── Usage ───────────────────────────────────────────────────────────── */
function Usage() {
  const { data, error } = useRead<UsageBody>("/api/usage");
  const { unit, rows, total } = usageRows(data);
  const money = (n: number) => (unit === "cr" ? cr(Math.round(n)) : `$${n.toFixed(2)}`);
  const shown = rows.filter((r) => r.amount > 0 || r.n > 0).sort((a, b) => b.amount - a.amount);
  const max = Math.max(1, ...shown.map((r) => r.amount));
  return (
    <div className="wsx-card" data-testid="ws-usage">
      <span className="gx-eyebrow">Usage</span>
      <span className="cw-dim">Settled spend · {money(total)} · failed renders not billed</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      {shown.map((r) => (
        <div className="wsx-bar" key={r.id} data-testid="ws-usage-bar">
          <span title={r.label}>{r.label}</span>
          <span className="wsx-bar-track"><span className="wsx-bar-fill" style={{ width: `${Math.max(2, (r.amount / max) * 100)}%` }} /></span>
          <span className="cw-mono">{money(r.amount)} · {r.n}</span>
        </div>
      ))}
      {data && !shown.length ? <span className="cw-dim">Nothing settled yet.</span> : null}
    </div>
  );
}

/* ── Engines ─────────────────────────────────────────────────────────── */
type Keys = { mode?: KeyMode; keyring?: boolean; keys: { name: string; label: string; does: string; set: boolean; masked: string | null }[] };
function Engines() {
  const session = useSession();
  const write = useWrite();
  const owner = session.role === "owner";
  /* The keys and the account connection are the owner's (both routes answer 403 to anyone else). */
  const { data, error, read } = useRead<Keys>(owner ? "/api/workspaces/keys" : null);
  const [entering, setEntering] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [note, setNote] = useState<string | null>(null);
  /* The account row reads the connection; the developer-API row follows it. */
  const [linked, setLinked] = useState<boolean | null>(null);
  const save = async (name: string) => {
    setNote(null);
    const { error: refused } = await write("/api/workspaces/keys", "PUT", { name, value: key.trim() });
    if (refused) { setNote(refused); return; }
    setKey(""); setEntering(null); setNote("Key saved."); void read();
  };
  return (
    <>
      <div className="wsx-card" data-testid="ws-engines">
        <span className="gx-eyebrow">Engines</span>
        {!owner ? <span className="gx-reason">Engine keys and the connected account are the owner’s to change.</span> : null}
        {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
        {(data?.keys ?? []).filter((k) => k.name !== "xai").map((k) => {
          const status = keyStatus(data?.mode, k.set);
          return (
            <div className="wsx-row" key={k.name} data-testid="ws-engine">
              <span className="cw-engine" data-ok={k.set || status.label !== "not connected"}><span className="cw-engine-dot" aria-hidden="true" /></span>
              <span style={{ minWidth: 0 }}><span className="wsx-name">{k.label} · {status.label}</span><span className="cw-dim">{k.does}{k.masked ? ` · ${k.masked}` : ""}</span></span>
              <span className="wsx-actions">
                {status.canConnect ? <button type="button" className="gx-hbtn" onClick={() => { setEntering(entering === k.name ? null : k.name); setKey(""); }}>{k.set ? "Replace key" : "Connect"}</button> : null}
              </span>
              {entering === k.name ? (
                <div className="wsx-actions" style={{ gridColumn: "1 / -1" }}>
                  <input className="gx-field" type="password" autoComplete="off" aria-label={`${k.label} key`} placeholder={k.name === "higgsfield" ? "KEY_ID:KEY_SECRET" : "API key"} value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: "1 1 220px", width: "auto" }} />
                  <button type="button" className="gx-hbtn" disabled={key.trim().length < 8} onClick={() => void save(k.name)}>Save key</button>
                </div>
              ) : null}
            </div>
          );
        })}
        {owner ? <span className="cw-dim">{data?.mode === "legacy" ? "This workspace runs on the deployment’s keys." : "Keys are encrypted and never returned."}</span> : null}
        {note ? <p className="gx-gen-note" role="status">{note}</p> : null}
      </div>
      <ConnectedAccountRow owner={owner} onLinked={setLinked} />
      <XaiEngineRow />
      {owner ? <DeveloperApiRow connected={linked} /> : null}
    </>
  );
}

/* ── Security ────────────────────────────────────────────────────────── */
function Security() {
  const session = useSession();
  const admin = session.role === "admin" || session.role === "owner";
  const { data, error } = useRead<SecurityBody>("/api/account/security");
  const audit = useRead<unknown>(admin ? "/api/workspaces/audit?limit=5" : null);
  const shell = useShell();
  const sessions = sessionRows(data);
  const twoStep = twoStepLine(data);
  const events = auditEntries(audit.data, AUDIT_LABELS);
  return (
    <div className="wsx-card" data-testid="ws-security">
      <span className="gx-eyebrow">Security</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      <div className="wsx-grid">
        <div className="wsx-label"><span className="gx-eyebrow">Sessions</span><span className="cw-dim">{data ? `${sessions.length || 1} signed in` : "Reading…"}</span>
          {sessions.slice(0, 8).map((s) => <span key={s.id} className="cw-dim" data-testid="ws-session">{s.label} · since {when(s.since)}</span>)}
        </div>
        <div className="wsx-label"><span className="gx-eyebrow">Two-step sign-in</span><span className="cw-dim" data-testid="ws-two-step">{twoStep ?? (data ? "Not reported" : "Reading…")}</span></div>
        <div className="wsx-label"><span className="gx-eyebrow">Media access</span><span className="cw-dim">Originals are served signed, per workspace, never public.</span></div>
        {admin ? (
          <div className="wsx-label" data-testid="ws-audit"><span className="gx-eyebrow">Recent activity</span>
            {events.map((e) => <span key={e.id} className="cw-dim">{e.label} · {when(e.at)}</span>)}
            {audit.data && !events.length ? <span className="cw-dim">Nothing recorded yet.</span> : null}
            {audit.error ? <span className="gx-gen-error" role="alert">{audit.error}</span> : null}
          </div>
        ) : null}
      </div>
      <span className="cw-dim">Password, two-step enrolment and session sign-out change with your account, on the account’s own security page — the one place a password is ever typed. <a className="cw-link" href="/account/security">Open account security</a></span>
      <button type="button" className="gx-hbtn" style={{ alignSelf: "flex-start" }} onClick={() => shell.goWorkspace("general")}>Back to General</button>
    </div>
  );
}
