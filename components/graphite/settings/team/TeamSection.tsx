"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { auditEntries, sessionRows, twoStepLine, type SecurityBody } from "@/lib/shell/workspace-view";
import { labels as AUDIT_LABELS } from "@/components/management/WorkspaceAudit";
import type { SettingsFold } from "@/lib/shell/settings";
import { Btn, Fold, LinkBtn, Note, Problem, Row, Section } from "../parts";
import { ROLES, inviteLine, memberLine, peopleMeta, roleChangeable, roleCounts, roleOf, workspaceTwoStep, type Team, type WorkspacePolicy } from "../model";
import { lostConnection, useRead, useWrite } from "../use-settings";

/**
 * Settings › Team (README § 3.5; Workspace's People and Security tabs, § 1.2). People, their roles and
 * the one-time invite links, on the routes Workspace › People uses (GET /api/team and its writes, the
 * owner's and admins' only). A person's own two-step sign-in and password change on the account's own
 * security page (DECISIONS 4). The one write here is the owner's workspace rule, on the route the old People
 * page used (POST /api/workspaces/security): the server asks for the owner's password and a fresh code to
 * confirm it, so those two are typed here, never kept, and cleared after every answer.
 */
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "never");

export function TeamSection({ open }: { open: SettingsFold | null }) {
  const session = useSession();
  const admin = session.role === "admin" || session.role === "owner";
  return (
    <>
      {admin ? <People /> : (
        <Section label="People" testId="settings-people">
          <Row name="The team is the owner’s and admins’ to manage." />
        </Section>
      )}
      <Security initiallyOpen={open === "security"} />
      <Roles />
    </>
  );
}

function People() {
  const session = useSession();
  const write = useWrite();
  const { toast } = useWorkspace();
  const { data, error, read } = useRead<Team>("/api/team");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [roleOpen, setRoleOpen] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({ name: "", email: "" });
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const act = async (key: string, url: string, method: string, body?: unknown, done?: string) => {
    setBusy(key); setNote(null);
    const { error: refused } = await write(url, method, body);
    setBusy(null);
    if (refused) { setNote({ ok: false, text: refused }); return; }
    if (done) toast(done);
    void read();
  };
  const send = async () => {
    setNote(null); setLink(null); setCopied(false);
    setBusy("invite");
    /* The same body Workspace › People sends: a member, by name and email. */
    const { json, error: refused } = await write<{ code?: string }>("/api/team", "POST", { ...invite, role: "member" });
    setBusy(null);
    if (refused || !json?.code) { setNote({ ok: false, text: refused ?? "The invitation could not be made." }); return; }
    setLink(`${window.location.origin}/invite/${json.code}`);
    setInvite({ name: "", email: "" });
    void read();
  };
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { toast("Copy didn’t work here. Select the link and copy it."); }
  };

  const roles = Boolean(data?.canSeeRoles);
  return (
    <Section label="People" meta={peopleMeta(data)} testId="settings-people"
      action={<button type="button" className="gs-primary" aria-expanded={inviting} onClick={() => { setInviting((v) => !v); setLink(null); }} data-testid="settings-invite">Invite · one-time link</button>}>
      {error ? <Problem text={error} onRetry={() => void read()} /> : !data ? <Row name="Reading the team…" /> : null}
      {(data?.users ?? []).map((u) => {
        const self = Boolean(session.email) && u.email === session.email;
        const changeable = roleChangeable(u, roles);
        return (
          <Row key={u.id} name={u.name} line={memberLine(u)} value={roles ? roleOf(u) : undefined} testId="settings-member">
            {changeable && roleOpen === u.id ? (
              <span className="gs-choice" role="group" aria-label={`Role for ${u.name}`}>
                {(["admin", "member"] as const).map((r) => (
                  <Btn key={r} pressed={u.role === r} disabled={busy != null} testId={`settings-role-${r}`}
                    onClick={() => { setRoleOpen(null); if (u.role !== r) void act(u.id, `/api/team/${encodeURIComponent(u.id)}`, "PATCH", { role: r }, `${u.name} is ${r === "admin" ? "an admin" : "a member"} now.`); }}>
                    {r === "admin" ? "Admin" : "Member"}
                  </Btn>
                ))}
              </span>
            ) : changeable ? <Btn disabled={busy != null} onClick={() => setRoleOpen(u.id)} testId="settings-change-role">Change role</Btn> : null}
            {u.locked ? <Btn disabled={busy != null} onClick={() => void act(u.id, `/api/team/${encodeURIComponent(u.id)}`, "PATCH", { unlock: true }, `${u.name} can sign in again.`)}>Unlock</Btn> : null}
            {/* Disabling ends access and keeps everything they made; it is undone the same way. */}
            {roles && !u.permanent && u.standing !== "owner" && !self ? (
              <Btn disabled={busy != null} danger={!u.disabled} testId="settings-member-disable"
                onClick={() => void act(u.id, `/api/team/${encodeURIComponent(u.id)}`, "PATCH", { disabled: !u.disabled }, u.disabled ? `${u.name} can sign in again.` : `${u.name} is disabled; their work stays.`)}>
                {u.disabled ? "Enable" : "Disable"}
              </Btn>
            ) : null}
          </Row>
        );
      })}
      {(data?.invites ?? []).map((i) => (
        <Row key={i.code} name={i.name} line={inviteLine(i)} value="invited" testId="settings-invite-row">
          {data?.mail?.configured ? <Btn disabled={busy != null} onClick={() => void act(i.code, `/api/team/invites/${encodeURIComponent(i.code)}/send`, "POST", undefined, `Sent to ${i.email} again.`)}>Resend</Btn> : null}
          <Btn disabled={busy != null} testId="settings-invite-revoke" onClick={() => void act(i.code, `/api/team/invites/${encodeURIComponent(i.code)}`, "DELETE", undefined, `The link for ${i.email} no longer works.`)}>Revoke</Btn>
        </Row>
      ))}
      {inviting ? (
        <form className="gs-form" onSubmit={(e) => { e.preventDefault(); if (invite.name.trim() && invite.email.trim()) void send(); }} data-testid="settings-invite-form">
          <label className="gs-label"><span className="gs-eyebrow">Name</span>
            <input className="gs-field" value={invite.name} autoComplete="off" onChange={(e) => setInvite({ ...invite, name: e.target.value })} data-testid="settings-invite-name" />
          </label>
          <label className="gs-label"><span className="gs-eyebrow">Email</span>
            <input className="gs-field" type="email" value={invite.email} autoComplete="off" onChange={(e) => setInvite({ ...invite, email: e.target.value })} data-testid="settings-invite-email" />
          </label>
          <button type="submit" className="gs-btn" data-hot disabled={busy != null || !invite.name.trim() || !invite.email.trim()} data-testid="settings-invite-make">
            {busy === "invite" ? "Making the link…" : "Make the link"}
          </button>
        </form>
      ) : null}
      {link ? (
        <div className="gs-fresh" role="status" data-testid="settings-invite-link">
          <span className="gs-row-line">One-time link · it works once</span>
          <code className="gs-code">{link}</code>
          <Btn onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</Btn>
        </div>
      ) : null}
      {note ? <Note ok={note.ok} text={note.text} testId="settings-people-note" /> : null}
    </Section>
  );
}

function Security({ initiallyOpen }: { initiallyOpen: boolean }) {
  const session = useSession();
  const admin = session.role === "admin" || session.role === "owner";
  const [open, setOpen] = useState(initiallyOpen);
  const account = useRead<SecurityBody>(open ? "/api/account/security" : null);
  const audit = useRead<unknown>(open && admin ? "/api/workspaces/audit?limit=5" : null);
  /* The workspace's own two-step rule is the owner's (the route reads it for them). */
  const policy = useRead<WorkspacePolicy>(open && session.owner ? "/api/workspaces/security" : null);
  const sessions = sessionRows(account.data);
  const twoStep = twoStepLine(account.data);
  const events = auditEntries(audit.data, AUDIT_LABELS);
  const rule = workspaceTwoStep({ owner: session.owner, workspaceId: session.workspace?.id ?? null, policy: policy.data, policyFailed: Boolean(policy.error), required: account.data?.requiredWorkspaces ?? (account.data ? [] : null) });
  return (
    <Fold label="Security" meta="sign-in, sessions and access" open={open} onToggle={() => setOpen((v) => !v)} testId="settings-security">
      {account.error ? <Problem text={account.error} onRetry={() => void account.read()} /> : null}
      <Row name="Your two-factor sign-in" line="An authenticator app, for every workspace you are on" value={twoStep ?? (account.data ? "Not reported" : "Reading…")} testId="settings-two-step">
        <LinkBtn href="/account/security" testId="settings-two-step-change">Change</LinkBtn>
      </Row>
      {session.owner ? <WorkspaceRule rule={rule} error={policy.error} reread={policy.read} /> : (
        <Row name="Two-factor on this workspace" line={rule.line} value={rule.value} testId="settings-workspace-two-step" />
      )}
      <Row name="Signed in" line={sessions.slice(0, 4).map((s) => `${s.label} · since ${when(s.since)}`).join(" · ") || undefined}
        value={account.data ? `${sessions.length || 1} ${sessions.length === 1 || !sessions.length ? "session" : "sessions"}` : "Reading…"} testId="settings-sessions" />
      <Row name="Media access" line="Originals are served signed, per workspace, never public" />
      {admin ? (
        <Row name="Recent activity" line={events.length ? events.map((e) => `${e.label} · ${when(e.at)}`).join(" · ") : audit.data ? "Nothing recorded yet" : audit.error ?? "Reading…"} testId="settings-audit" />
      ) : null}
    </Fold>
  );
}

/**
 * Roles (Team security, Gaps B): the code's owner, admin and member, what each may do, and how many hold each on the
 * owner's view. There is no other role and no limit per role (owner correction 7); a role changes on the person's
 * row above, by the owner.
 */
function Roles() {
  const session = useSession();
  const admin = session.role === "admin" || session.role === "owner";
  const { data } = useRead<Team>(admin ? "/api/team" : null);
  const counts = roleCounts(data);
  return (
    <Section label="Roles" meta="what each role may do" testId="settings-roles">
      {ROLES.map((r) => <Row key={r.id} name={r.name} line={r.line} value={counts ? String(counts[r.id]) : undefined} testId="settings-role" />)}
    </Section>
  );
}

/**
 * The owner's on/off for the workspace's two-step rule, with the body the old People page sent
 * (components/management/WorkspaceSecurity.tsx): { requiresMfa, password, code }, under the captured scope. The server
 * decides everything (owner only, their own two-step on, a fresh code, never the last recovery code); its refusal is
 * shown as it says it, and the rule is read again after every answer, so a lost answer never leaves a guess on screen.
 */
function WorkspaceRule({ rule, error, reread }: { rule: ReturnType<typeof workspaceTwoStep>; error: string | null; reread: () => Promise<void> }) {
  const write = useWrite();
  const { toast } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const on = rule.action === "turn-on";
  const save = async () => {
    if (busy || !password || !code || (rule.action !== "turn-on" && rule.action !== "turn-off")) return;
    setBusy(true); setNote(null);
    const { json, error: refused } = await write<{ requiresMfa?: boolean }>("/api/workspaces/security", "POST", { requiresMfa: on, password, code });
    setPassword(""); setCode("");
    await reread();
    setBusy(false);
    if (refused) {
      /* A dropped answer may have been saved: the form closes on the rule as read back, never on a guess. */
      if (lostConnection(refused)) { setConfirming(false); setNote("The connection dropped before the answer came back. The rule shown is the one saved."); }
      else setNote(refused);
      return;
    }
    setConfirming(false);
    toast(json?.requiresMfa ? "Two-step sign-in is now required on this workspace." : "Two-step sign-in is now each person’s choice.");
  };
  return (
    <>
      <Row name="Two-factor on this workspace" line={rule.line} value={rule.value} testId="settings-workspace-two-step">
        {rule.action === "enrol-first" ? <LinkBtn href="/account/security" testId="settings-workspace-two-step-enrol">Set up yours first</LinkBtn> : null}
        {rule.action === "turn-on" || rule.action === "turn-off" ? (
          <button type="button" className="gs-btn" aria-expanded={confirming} disabled={busy} data-testid="settings-workspace-two-step-toggle"
            onClick={() => { setConfirming((v) => !v); setNote(null); setPassword(""); setCode(""); }}>
            {confirming ? "Cancel" : on ? "Turn on" : "Turn off"}
          </button>
        ) : null}
      </Row>
      {error ? <Problem text={error} onRetry={() => void reread()} testId="settings-workspace-two-step-problem" /> : null}
      {confirming && rule.action !== "enrol-first" && rule.action !== null ? (
        <form className="gs-form" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="settings-workspace-two-step-form">
          <label className="gs-label"><span className="gs-eyebrow">Your password</span>
            <input className="gs-field" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="gs-label"><span className="gs-eyebrow">Authenticator or recovery code</span>
            <input className="gs-field" autoComplete="one-time-code" maxLength={24} value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button type="submit" className="gs-btn" data-hot disabled={busy || !password || !code} data-testid="settings-workspace-two-step-confirm">
            {busy ? "Saving…" : on ? "Require it" : "Make it optional"}
          </button>
        </form>
      ) : null}
      {note ? <Note ok={false} text={note} testId="settings-workspace-two-step-note" /> : null}
    </>
  );
}
