"use client";

/**
 * The platform owner's desk: who may sign up, who has asked, and every
 * workspace on the deployment. Nobody else can open this — the route
 * behind it answers 403 to everyone but the platform owner.
 */
import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/usePageTitle";
import { timeAgo } from "@/lib/format";
import { appAlert, appConfirm } from "@/components/dialog";
import { Empty, Waiting } from "@/components/ParticlMark";

type Admin = {
  ready: boolean; mail: boolean;
  invites: { code: string; email: string; name: string; note: string; createdAt: number; expiresAt: number; sentAt: number | null; sendCount: number }[];
  requests: { id: string; name: string; email: string; note: string; mailed: boolean; createdAt: number }[];
  workspaces: { id: string; slug: string; name: string; legacy: boolean; platformKeys: boolean; createdAt: number; owner: { email: string; name: string } | null; members: number }[];
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
              <div className="scard-h"><span>Asked to be let in</span><span>People who pressed Contact management. Invite them, or mark the request handled.</span></div>
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

            <section className="scard">
              <div className="scard-h"><span>Workspaces</span><span>{data.workspaces.length} on this deployment. The studio&rsquo;s own runs on the deployment&rsquo;s keys; every other one brings its own.</span></div>
              <div className="flex flex-col">
                <div className="steam is-head !grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_100px_120px_120px]"><span>WORKSPACE</span><span>OWNER</span><span>MEMBERS</span><span>KEYS</span><span className="text-right">CREATED</span></div>
                {data.workspaces.map((w) => (
                  <div key={w.id} className="steam !grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_100px_120px_120px]">
                    <span className="flex flex-col gap-0.5"><span className="font-medium">{w.name}</span><span className="text-[11.5px] text-dim">{w.slug}{w.legacy ? " · the studio's own" : ""}</span></span>
                    <span className="flex flex-col gap-0.5"><span>{w.owner?.name ?? "—"}</span><span className="text-[11.5px] text-dim">{w.owner?.email ?? ""}</span></span>
                    <span className="mono-v">{w.members}</span>
                    <span className="mono-s">{w.platformKeys ? "DEPLOYMENT" : "ITS OWN"}</span>
                    <span className="mono-s text-right">{timeAgo(w.createdAt).toUpperCase()}</span>
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
