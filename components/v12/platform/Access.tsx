"use client";
import { useRef, useState } from "react";
import { timeAgo } from "@/lib/format";
import { ContextMenu, IconButton, Menu, useToast, type MenuItem } from "../ui";
import { adminSend } from "./api";
import { Head, day } from "./parts";
import type { AdminDesk, AdminInvite } from "./types";

/** Who can join: invite someone, the open invitations (Resend, Revoke), and the people who asked to be let in. */
export function Access({ desk, refresh }: { desk: AdminDesk | null; refresh: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ email: "", name: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ invite: AdminInvite; at: { x: number; y: number; pointer?: boolean } } | null>(null);

  async function invite(seed?: { email: string; name: string; requestId: string }) {
    const body = seed ? { ...seed, note: "", send: true } : { ...form, send: true };
    if (!body.email.trim()) return;
    setBusy(true);
    const sent = await adminSend<{ link: string; sent: boolean; mailError: string | null }>("/api/admin/invites", "POST", body);
    setBusy(false);
    if (!sent.ok) { toast({ text: sent.error }); return; }
    if (!seed) setForm({ email: "", name: "", note: "" });
    if (sent.json.sent) { setLink(null); toast({ text: "Invitation sent" }); }
    else { setLink(sent.json.link); toast({ text: sent.json.mailError ? `Not emailed · ${sent.json.mailError}` : "Not emailed · copy the link" }); }
    refresh();
  }
  async function resend(i: AdminInvite) {
    const sent = await adminSend(`/api/admin/invites/${encodeURIComponent(i.code)}`, "POST");
    toast({ text: sent.ok ? "Invitation sent again" : sent.error });
    if (sent.ok) refresh();
  }
  async function revoke(i: AdminInvite) {
    const sent = await adminSend(`/api/admin/invites/${encodeURIComponent(i.code)}`, "DELETE");
    toast({ text: sent.ok ? "Invitation revoked" : sent.error });
    refresh();
  }
  async function handled(id: string) {
    const sent = await adminSend(`/api/admin/requests/${encodeURIComponent(id)}`, "PATCH");
    if (!sent.ok) toast({ text: sent.error });
    refresh();
  }

  const items = (i: AdminInvite): MenuItem[] => [
    { id: "resend", label: "Resend", onSelect: () => void resend(i), disabled: !desk?.mail, title: desk?.mail ? undefined : "Email isn't set up", testId: "pc-invite-resend" },
    { id: "revoke", label: "Revoke", tone: "danger", onSelect: () => void revoke(i), testId: "pc-invite-revoke" },
  ];

  return (
    <>
      <Head title="Who can join" line="Sign-up is by invitation. Invite someone, or answer a request." />
      {desk && !desk.ready ? <p className="v12-pc-note" data-testid="pc-not-ready">Sign-up can’t start yet: the hosting environment is missing what gives a new workspace its database.</p> : null}
      <h2 className="v12-pc-h2">Invite someone</h2>
      <form className="v12-pc-form" onSubmit={(e) => { e.preventDefault(); void invite(); }}>
        <input className="v12-pc-input" type="email" required aria-label="Email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="pc-invite-email" />
        <input className="v12-pc-input" aria-label="Name" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="pc-invite-name" />
        <input className="v12-pc-input v12-pc-grow" aria-label="Note" placeholder="Note · who they are, for your own reference" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} data-testid="pc-invite-note" />
        <button type="submit" className="v12-pc-primary" disabled={busy || !desk?.ready} title={desk && !desk.ready ? "The hosting environment is not set up for new workspaces" : undefined} data-testid="pc-invite-send">Invite</button>
      </form>
      {link ? (
        <p className="v12-pc-note" data-testid="pc-invite-link">Not emailed. Send them this link: <code className="v12-pc-mono">{link}</code>{" "}
          <button type="button" className="v12-pc-quiet" onClick={() => { void navigator.clipboard?.writeText(link).then(() => toast({ text: "Link copied" })).catch(() => toast({ text: "Could not copy" })); }}>Copy</button></p>
      ) : null}

      <h2 className="v12-pc-h2">Invites</h2>
      <div className="v12-pc-table" role="table" aria-label="Invites" data-testid="pc-invites">
        <div className="v12-pc-tr v12-pc-th v12-pc-invcols" role="row">
          <span role="columnheader">Email</span><span role="columnheader">Name</span><span role="columnheader">State</span><span role="columnheader">Note</span><span role="columnheader">Expires</span><span role="columnheader" aria-label="Actions" />
        </div>
        {(desk?.invites ?? []).map((i) => (
          <InviteRow key={i.code} invite={i} items={items(i)} onContext={(at) => setMenu({ invite: i, at })} />
        ))}
        {desk && !desk.invites.length ? <div className="v12-pc-empty" data-testid="pc-invites-empty">No open invitations.</div> : null}
      </div>
      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)} label="Invitation" items={menu ? items(menu.invite) : []} width={180} />

      <h2 className="v12-pc-h2">Asked to be let in{desk?.requests.length ? <span className="v12-pc-count">{desk.requests.length}</span> : null}</h2>
      {desk && !desk.requests.length ? <p className="v12-pc-empty" data-testid="pc-requests-empty">Nobody waiting.</p> : null}
      <div className="v12-pc-cards">
        {(desk?.requests ?? []).map((r) => (
          <article key={r.id} className="v12-pc-card" data-testid="pc-request">
            <div className="v12-pc-card-head"><strong>{r.name || r.email}</strong><span className="v12-pc-meta">asked {timeAgo(r.createdAt)}</span></div>
            <div className="v12-pc-mono v12-pc-meta">{r.email}</div>
            {r.note ? <p className="v12-pc-quote">{r.note}</p> : null}
            <div className="v12-pc-actions">
              <button type="button" className="v12-pc-outline" disabled={busy || !desk?.ready} onClick={() => void invite({ email: r.email, name: r.name, requestId: r.id })} data-testid="pc-request-invite">Invite</button>
              <button type="button" className="v12-pc-btn" onClick={() => void handled(r.id)} data-testid="pc-request-handled">Mark handled</button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function InviteRow({ invite, items, onContext }: { invite: AdminInvite; items: MenuItem[]; onContext: (at: { x: number; y: number }) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="v12-pc-tr v12-pc-invcols" role="row" data-testid="pc-invite" onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext({ x: e.clientX, y: e.clientY }); }}>
      <span role="cell" className="v12-pc-mono v12-pc-clip">{invite.email}</span>
      <span role="cell" className="v12-pc-clip">{invite.name || "—"}</span>
      <span role="cell"><span className="v12-pc-dot" data-tone={invite.sentAt ? "info" : "idle"} aria-hidden /> {invite.sentAt ? "Sent" : "Not sent"}</span>
      <span role="cell" className="v12-pc-clip v12-pc-meta">{invite.note || "—"}</span>
      <span role="cell" className="v12-pc-mono v12-pc-meta">{day(invite.expiresAt)}</span>
      <span role="cell" className="v12-pc-end">
        <IconButton ref={anchor} tooltip={{ name: "More", line: "Resend or revoke this invitation." }} size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="pc-invite-more">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><circle cx="3" cy="7" r="1.2" fill="currentColor" /><circle cx="7" cy="7" r="1.2" fill="currentColor" /><circle cx="11" cy="7" r="1.2" fill="currentColor" /></svg>
        </IconButton>
        <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="Invitation" items={items} width={180} align="end" />
      </span>
    </div>
  );
}
