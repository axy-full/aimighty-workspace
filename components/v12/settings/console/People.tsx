"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { lastActive, nameFromEmail, seatsLine } from "@/lib/v12/settingsConsole";
import { useRead, useWrite } from "@/components/graphite/settings/use-settings";
import { Tooltip } from "../../ui";
import { Problem, Sec, initialsOf, Note } from "./parts";

/**
 * Settings › People: invite by email, the roster with a role per person, ⋯ Remove (also on right-click), and pending invitations
 * with Resend and Revoke. GET /api/team and its writes, which only an owner or admin may use (the routes answer anyone else 403,
 * and each change leaves a line in the workspace's history). Any admin sets roles; the owner's standing is protected and the last
 * admin can never be demoted or removed (the server refuses it, whatever this screen shows).
 */
export type TeamBody = {
  mail?: { configured: boolean };
  canSeeRoles: boolean;
  users: { id: string; email: string; name: string; role?: string; standing?: string; permanent?: boolean; disabled: boolean; lastSeen: number | null; support?: boolean }[];
  invites: { code: string; email: string; name: string; role?: string; expiresAt: number; sentAt: number | null; sendCount?: number }[];
};
type Team = { data: TeamBody | null; error: string | null; read: () => Promise<void> };

const day = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");

export function People({ team }: { team: Team }) {
  const session = useSession();
  const write = useWrite();
  const { toast } = useWorkspace();
  const { data, error, read } = team;
  const seats = useRead<{ used: number; ceiling: number | null }>("/api/team/seats");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const act = async (key: string, url: string, method: string, body?: unknown, done?: string) => {
    setBusy(key); setNote(null);
    const { error: refused } = await write(url, method, body);
    setBusy(null);
    if (refused) { setNote({ ok: false, text: refused }); return false; }
    if (done) toast(done);
    await read(); void seats.read();
    return true;
  };
  const invite = async () => {
    const address = email.trim().toLowerCase();
    if (!address) return;
    setBusy("invite"); setNote(null); setLink(null);
    const { json, error: refused } = await write<{ code?: string; sent?: boolean; mailError?: string | null }>("/api/team", "POST", { email: address, name: nameFromEmail(address), role });
    setBusy(null);
    if (refused || !json?.code) { setNote({ ok: false, text: refused ?? "The invitation could not be made." }); return; }
    setEmail("");
    /* Mail not set up (or it failed): the one-time link is the invitation, shown to copy. */
    if (json.sent) toast(`Invitation sent to ${address}.`); else setLink(`${window.location.origin}/invite/${json.code}`);
    await read();
  };
  const copy = async () => { if (!link) return; try { await navigator.clipboard.writeText(link); toast("Link copied."); } catch { toast("Copy didn’t work here. Select the link and copy it."); } };

  const users = (data?.users ?? []).filter((u) => !u.disabled);
  const canRole = Boolean(data?.canSeeRoles);
  const open = (id: string, name: string, x: number, y: number) => setMenu({ id, name, x: Math.min(x, window.innerWidth - 220), y: y + 6 });
  const remove = async (id: string, name: string) => {
    setMenu(null); setRemoving(null);
    await act(`rm:${id}`, `/api/team/${encodeURIComponent(id)}`, "DELETE", undefined, `${name} was removed from the workspace.`);
  };

  return (
    <>
      <Sec label="Invite a teammate" meta={data ? seatsLine(seats.data, users.length) : undefined} testId="v12-settings-invite">
        <form className="v12-ws-form" onSubmit={(e) => { e.preventDefault(); void invite(); }}>
          <input className="v12-ws-field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" aria-label="Email" data-testid="v12-settings-invite-email" />
          {canRole ? (
            <select className="v12-ws-select" value={role} onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")} aria-label="Role" data-testid="v12-settings-invite-role">
              <option value="member">Member</option><option value="admin">Admin</option>
            </select>
          ) : null}
          <button type="submit" className="v12-ws-btn v12-ws-btn-primary" disabled={!email.trim() || busy === "invite"} data-testid="v12-settings-invite-send">Invite</button>
        </form>
        {link ? (
          <div className="v12-ws-form" data-testid="v12-settings-invite-link">
            <span className="v12-ws-link">{link}</span>
            <button type="button" className="v12-ws-btn" onClick={() => void copy()}>Copy link</button>
          </div>
        ) : null}
        {note ? <Note ok={note.ok} text={note.text} testId="v12-settings-people-note" /> : null}
      </Sec>

      <Sec label={`People · ${users.length} ${users.length === 1 ? "person" : "people"}`} testId="v12-settings-people">
        {error ? <Problem text={error} onRetry={() => void read()} /> : !data ? <div className="v12-ws-empty">Reading the team…</div> : null}
        {data ? (
          <>
            <div className="v12-ws-table-head" aria-hidden="true"><span>Name</span><span>Email</span><span>Role</span><span>Last active</span><span /></div>
            {users.map((u) => {
              const you = u.id === session.userId;
              const owner = u.standing === "owner" || u.permanent;
              return (
                <div key={u.id} className="v12-ws-person" data-testid="v12-settings-person" data-id={u.id}
                  onContextMenu={(e) => { if (you || owner) return; e.preventDefault(); e.stopPropagation(); open(u.id, u.name, e.clientX, e.clientY); }}>
                  <span className="v12-ws-who"><span className="v12-ws-av" aria-hidden="true">{initialsOf(u.name)}</span>{u.name}{you ? <span className="v12-ws-you">you</span> : null}</span>
                  <span title={u.email}>{u.email || "Particl support"}</span>
                  {owner ? <span className="v12-ws-quiet" data-testid="v12-settings-owner">Owner</span> : (
                    <select className="v12-ws-select" value={u.role === "admin" ? "admin" : "member"} aria-label={`Role of ${u.name}`} disabled={!canRole || busy != null || Boolean(u.support)}
                      title={you ? "Your own role: another admin changes it." : u.support ? "Particl support’s access belongs to the platform." : "Admin: everything here. Member: boards and takes only."}
                      onChange={(e) => void act(`role:${u.id}`, `/api/team/${encodeURIComponent(u.id)}`, "PATCH", { role: e.target.value }, `${u.name} is now ${e.target.value === "admin" ? "an admin" : "a member"}.`)} data-testid="v12-settings-role">
                      <option value="admin">Admin</option><option value="member">Member</option>
                    </select>
                  )}
                  <span className="v12-ws-quiet">{lastActive(u.lastSeen, now)}</span>
                  {!you && !owner ? (
                    <Tooltip name="Remove from workspace" line="Or right-click the row." named>
                      <button type="button" className="v12-ws-btn v12-ws-btn-quiet" aria-label={`Actions for ${u.name}`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); open(u.id, u.name, r.right - 200, r.bottom); }} data-testid="v12-settings-person-more">⋯</button>
                    </Tooltip>
                  ) : <span />}
                </div>
              );
            })}
          </>
        ) : null}
      </Sec>

      <Sec label="Pending invites" testId="v12-settings-pending">
        {data && !data.invites.length ? <div className="v12-ws-empty">None pending.</div> : null}
        {(data?.invites ?? []).map((i) => (
          <div key={i.code} className="v12-ws-pending" data-testid="v12-settings-pending-row">
            <span title={i.email}>{i.email}</span>
            <span className="v12-ws-quiet">{i.role === "admin" ? "Admin" : "Member"}</span>
            <span className="v12-ws-quiet">{i.sentAt ? `Sent ${day(i.sentAt)} · ` : "Not emailed · "}expires {day(i.expiresAt)}</span>
            <span style={{ display: "inline-flex", gap: 6 }}>
              {data?.mail?.configured ? <button type="button" className="v12-ws-btn" disabled={busy != null} onClick={() => void act(`send:${i.code}`, `/api/team/invites/${encodeURIComponent(i.code)}/send`, "POST", undefined, `Invitation sent again to ${i.email}.`)}>Resend</button> : (
                <button type="button" className="v12-ws-btn" onClick={() => { setLink(`${window.location.origin}/invite/${i.code}`); }} data-testid="v12-settings-invite-show-link">Show link</button>
              )}
              <button type="button" className="v12-ws-btn" disabled={busy != null} onClick={() => void act(`revoke:${i.code}`, `/api/team/invites/${encodeURIComponent(i.code)}`, "DELETE", undefined, `Invitation to ${i.email} withdrawn.`)} data-testid="v12-settings-revoke">Revoke</button>
            </span>
          </div>
        ))}
      </Sec>

      {menu ? (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={() => { setMenu(null); setRemoving(null); }} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="v12-ws-menu" role="menu" style={{ left: menu.x, top: menu.y }} data-testid="v12-settings-menu">
            {removing === menu.id ? (
              <button type="button" role="menuitem" className="v12-ws-btn-danger" onClick={() => void remove(menu.id, menu.name)} data-testid="v12-settings-remove-confirm">Remove {menu.name} now</button>
            ) : (
              <button type="button" role="menuitem" onClick={() => setRemoving(menu.id)} data-testid="v12-settings-remove">Remove from workspace</button>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}
