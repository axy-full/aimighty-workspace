"use client";

/**
 * The team, in the app's own idiom: a title, an invite card, and one
 * grouped list of members — the same list on a desk and a phone.
 */
import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { usd, timeAgo } from "@/lib/format";
import { avatarHue, initialsOf } from "@/lib/avatar";
import { usePageTitle } from "@/lib/usePageTitle";
import { Empty } from "@/components/ParticlMark";
import { appConfirm, appAlert } from "@/components/dialog";

type Member = {
  id: string; email: string; name: string;
  /** Present only for the owner; nobody else is told who outranks whom. */
  role?: string;
  disabled: boolean; locked: boolean;
  lastSeen: number | null; createdAt: number; clips: number; spend: number;
  /** The workspace's permanent admin: cannot be demoted, disabled or removed. */
  permanent?: boolean;
};
type AccessRequest = {
  id: string; name: string; email: string; note: string;
  mailed: boolean; createdAt: number;
};

type Invite = {
  code: string; email: string; name: string; role?: string;
  createdAt: number; expiresAt: number;
  sentAt?: number | null; sendCount?: number;
};
type Mail = { configured: boolean; from: string | null };

export default function TeamPage() {
  usePageTitle("Team");
  const { data, refresh } = useApi<{
    users: Member[]; invites: Invite[]; mail?: Mail; canSeeRoles?: boolean;
    requests?: AccessRequest[];
  }>("/api/team", 30000);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const { data: me } = useApi<{ id?: string; email: string }>("/api/me");
  const [form, setForm] = useState({ name: "", email: "", role: "member" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function invite() {
    if (!form.name.trim() || !form.email.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/team", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't create the invite");
      setForm({ name: "", email: "", role: "member" });
      setNotice(json.sent
        ? `Invitation emailed to ${json.email}.`
        : json.mailError
          ? `Invitation created, but the email didn't go: ${json.mailError} Copy the link below instead.`
          : null);
      refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/team/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) setErr(json.error ?? "That didn't work"); else setErr(null);
    refresh();
  }

  async function remove(u: Member) {
    const ok = await appConfirm(
      `Delete ${u.name}?`,
      "They lose access immediately: sessions and API tokens are revoked and they leave the team. " +
      "Their renders and spend stay on the ledger under their name. This can't be undone.",
      { confirmLabel: "Delete", danger: true },
    );
    if (!ok) return;
    const res = await fetch(`/api/team/${u.id}`, { method: "DELETE" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) setErr(json.error ?? "That didn't work"); else setErr(null);
    refresh();
  }

  async function resend(iv: Invite) {
    setSending(iv.code); setErr(null); setNotice(null);
    try {
      const res = await fetch(`/api/team/invites/${iv.code}/send`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't send it");
      setNotice(`Invitation emailed again to ${iv.email}.`);
      refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setSending(null); }
  }

  async function revoke(iv: Invite) {
    const ok = await appConfirm(
      `Revoke the invitation to ${iv.email}?`,
      "Their link stops working straight away. If they still need access you'd have to invite them again.",
      { confirmLabel: "Revoke", danger: true },
    );
    if (!ok) return;
    await fetch(`/api/team/invites/${iv.code}`, { method: "DELETE" });
    refresh();
  }

  async function copyLink(code: string) {
    const link = `${window.location.origin}/invite/${code}`;
    try {
      // Safari refuses the write outside a user gesture, and http origins
      // have no clipboard at all — both used to still say "Copied ✓".
      await navigator.clipboard.writeText(link);
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      await appAlert("The link wasn't copied", link);
    }
  }

  const users = data?.users ?? [];
  /** True only for the workspace owner. Everyone else is shown no standing. */
  const canSeeRoles = Boolean(data?.canSeeRoles);
  const invites = data?.invites ?? [];
  const requests = data?.requests ?? [];
  const active = users.filter((u) => !u.disabled).length;
  const mail = data?.mail?.configured ?? false;

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[760px] pb-10">
        <div className="flex flex-wrap items-end gap-3 pt-6">
          <span className="flex flex-col">
            <h1 className="h1">Team</h1>
            <span className="mt-1 text-[15px] text-dim">
              {active} active member{active === 1 ? "" : "s"} · invitation only
            </span>
          </span>
          <a href="/api/export" download
            title="Every prompt, cost and account record, as JSON"
            className="chip mb-2 ml-auto !text-dim">
            Export data
          </a>
        </div>

        {/* Strangers who have asked to be let in. The interface is public
            now, so this is the queue that public-ness produces — and it is
            read from the database rather than from an inbox, so a request
            survives the email failing. */}
        {requests.length > 0 && (
          <>
            <p className="grouplabel mt-10">
              Asked for an invitation
              <span className="ml-2 text-mute">{requests.length}</span>
            </p>
            <div className="rows">
              {requests.map((r) => (
                <div key={r.id} className="row !items-start">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{r.name || r.email}</span>
                    {r.name && <span className="truncate text-[12.5px] text-mute">{r.email}</span>}
                    {r.note && (
                      <span className="mt-0.5 max-w-[52ch] text-[12.5px] leading-relaxed text-dim">
                        {r.note}
                      </span>
                    )}
                    {!r.mailed && (
                      <span className="mt-0.5 text-[11.5px] text-mute">
                        Not emailed — mail isn&rsquo;t set up, so this page is the only copy.
                      </span>
                    )}
                  </span>
                  <span className="row-value flex shrink-0 items-center gap-2">
                    <span className="text-[12px] text-mute">{timeAgo(r.createdAt)}</span>
                    <button type="button" className="chip !py-1.5 !text-[13px]"
                      onClick={() => setForm({ name: r.name, email: r.email, role: "member" })}
                      title="Fill the invite form with these details">
                      Invite
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="grouplabel mt-10">Invite someone</p>
        <div className="card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <input className="ctl min-w-[160px] flex-1" placeholder="Name"
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && invite()} />
            <input className="ctl min-w-[200px] flex-1" placeholder="Email" type="email"
              value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && invite()} />
            {/* Only the owner chooses standing. For anyone else the invite
                is a member invite, decided on the server rather than here. */}
            {canSeeRoles && (
              <select className="ctl w-auto shrink-0" value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            )}
            <button onClick={invite} disabled={busy || !form.name.trim() || !form.email.trim()}
              className="btn-render h-[38px] shrink-0 px-4 text-[14px]">
              {busy ? "Sending…" : mail ? "Send invite" : "Create invite"}
            </button>
          </div>
          <p className="mt-2.5 text-[12.5px] text-mute">
            {mail
              ? <>The invitation is emailed from {data?.mail?.from} with a link that expires on its own; you can also copy the link.</>
              : <>No email is set up, so copy the link and share it yourself; it expires on its own. To email invitations, add RESEND_API_KEY and MAIL_FROM in Vercel.</>}
          </p>
          {notice && (
            <p className="mt-3 rounded-[10px] bg-blue/8 px-3 py-2 text-[13.5px] text-blue">{notice}</p>
          )}
          {err && (
            <p className="mt-3 rounded-[10px] bg-lift/8 px-3 py-2 text-[13.5px] text-lift">{err}</p>
          )}
        </div>

        {invites.length > 0 && (
          <>
            <p className="grouplabel mt-10">Pending invites</p>
            <div className="rows">
              {invites.map((iv) => (
                <div key={iv.code} className="row">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border-[1.5px] border-dashed border-mute/60 text-[12px] text-mute">
                    {initialsOf(iv.name)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px]">{iv.name}</span>
                    <span className="truncate text-[12.5px] text-mute">
                      {iv.email}{iv.role ? ` · ${iv.role}` : ""} · expires {new Date(iv.expiresAt).toLocaleDateString()}
                      {iv.sentAt ? ` · emailed ${timeAgo(iv.sentAt)}${(iv.sendCount ?? 0) > 1 ? ` (${iv.sendCount}×)` : ""}` : mail ? " · not emailed yet" : ""}
                    </span>
                  </span>
                  <span className="row-value !gap-1.5">
                    {mail && (
                      <button onClick={() => resend(iv)} disabled={sending === iv.code} className="chip !py-1.5 !text-[13px] !text-blue disabled:opacity-50">
                        {sending === iv.code ? "Sending…" : iv.sentAt ? "Resend" : "Email it"}
                      </button>
                    )}
                    <button onClick={() => copyLink(iv.code)} className="chip !py-1.5 !text-[13px]">
                      {copied === iv.code ? "Copied ✓" : "Copy link"}
                    </button>
                    <button onClick={() => void revoke(iv)} className="chip !py-1.5 !text-[13px] !text-lift">
                      Revoke
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="grouplabel mt-10">Members</p>
        <div className="rows">
          {users.length === 0 && <div className="row"><Empty compact title="Nobody yet" /></div>}
          {users.map((u) => (
            <div key={u.id} className={`row !items-start !py-3 ${u.disabled ? "opacity-45" : ""}`}>
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-[12px] font-semibold text-white"
                style={{ background: avatarHue(u.name) }}>
                {initialsOf(u.name)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[15px] font-medium">{u.name}</span>
                  {canSeeRoles && (u.permanent ? (
                    <span className="rounded-full bg-blue/10 px-2 py-px text-[11px] font-medium text-blue"
                      title="The workspace's permanent admin — can't be demoted, disabled or removed">
                      Owner
                    </span>
                  ) : u.role === "admin" && (
                    <span className="rounded-full bg-blue/10 px-2 py-px text-[11px] font-medium text-blue">Admin</span>
                  ))}
                  {u.locked && (
                    <span className="rounded-full bg-warn/15 px-2 py-px text-[11px] font-medium text-warn">Locked</span>
                  )}
                  {u.disabled && (
                    <span className="rounded-full bg-chip px-2 py-px text-[11px] font-medium text-dim">Disabled</span>
                  )}
                </span>
                <span className="truncate text-[12.5px] text-mute">{u.email}</span>
                <span className="text-[12.5px] tabular-nums text-mute">
                  {u.clips} render{u.clips === 1 ? "" : "s"} · {usd(u.spend, 2)} ·{" "}
                  {u.lastSeen ? `seen ${timeAgo(u.lastSeen)}` : "never signed in"}
                </span>
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {/* A control that will always be refused is worse than no
                      control: it invites the click and then explains itself.
                      Unlock stays, because it only ever helps this account. */}
                  {!canSeeRoles ? null : u.permanent ? (
                    <>
                      <span className="text-[12.5px] text-mute">
                        Permanent admin — can&rsquo;t be demoted, disabled or removed.
                      </span>
                      {u.locked && (
                        <button onClick={() => patch(u.id, { unlock: true })} className="chip !py-1 !text-[12.5px] !text-warn">
                          Unlock
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}
                        className="h-[28px] rounded-full bg-chip px-2.5 text-[12.5px] font-medium text-dim">
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                      {u.locked && (
                        <button onClick={() => patch(u.id, { unlock: true })} className="chip !py-1 !text-[12.5px] !text-warn">
                          Unlock
                        </button>
                      )}
                      <button onClick={() => patch(u.id, { disabled: !u.disabled })}
                        className="chip !py-1 !text-[12.5px]">
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                      {(me?.id ? me.id !== u.id : me?.email !== u.email) && (
                        <button onClick={() => remove(u)} className="chip !py-1 !text-[12.5px] !text-lift"
                          title="Revoke access and remove from the team; their work stays on the ledger">
                          Delete
                        </button>
                      )}
                    </>
                  )}
                </span>
              </span>
            </div>
          ))}
        </div>
        <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
          Admins manage the team, invites and the ledger. Members generate and edit.
          Disable is reversible; Delete revokes access for good and keeps their renders and spend on the ledger under their name.
        </p>
      </div>
    </div>
  );
}
