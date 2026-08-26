"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { usd, timeAgo } from "@/lib/format";
import { Panel } from "@/components/Panel";
import { IconPlus } from "@/components/Icons";

type Member = {
  id: string; email: string; name: string; role: string;
  disabled: boolean; locked: boolean;
  lastSeen: number | null; createdAt: number; clips: number; spend: number;
};
type Invite = {
  code: string; email: string; name: string; role: string;
  createdAt: number; expiresAt: number;
};

export default function TeamPage() {
  const { data, refresh } = useApi<{ users: Member[]; invites: Invite[] }>("/api/team", 30000);
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
      if (!res.ok) throw new Error(json.error ?? "Could not create the invite");
      setForm({ name: "", email: "", role: "member" });
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

  async function revoke(code: string) {
    await fetch(`/api/team/invites/${code}`, { method: "DELETE" });
    refresh();
  }

  function copyLink(code: string) {
    const link = `${window.location.origin}/invite/${code}`;
    navigator.clipboard?.writeText(link);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  }

  const users = data?.users ?? [];
  const invites = data?.invites ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-chrome px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <input className="ctl w-[170px] shrink-0" placeholder="Name"
          value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && invite()} />
        <input className="ctl w-[220px] shrink-0" placeholder="Email" type="email"
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && invite()} />
        <select className="ctl w-auto shrink-0" value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button onClick={invite} disabled={busy || !form.name.trim() || !form.email.trim()}
          className="ptitle flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] bg-red px-3 text-[10.5px] tracking-[.1em] text-white hover:bg-lift disabled:bg-panel3 disabled:text-mute">
          <IconPlus /> Invite
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-3">
          <a href="/api/export" download
            title="Download every prompt, cost and account record as JSON"
            className="rounded-[6px] border border-line px-2 py-1 font-mono text-[9.5px] tracking-wider text-dim hover:border-lift hover:text-lift">
            EXPORT DATA
          </a>
          <span className="font-mono text-[10px] tracking-wider text-mute">
            {String(users.filter((u) => !u.disabled).length).padStart(2, "0")} ACTIVE
          </span>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {err && (
          <p className="border-b border-lift/30 bg-lift/8 px-3 py-2 font-mono text-[10.5px] text-lift">{err}</p>
        )}

        <div className="grid gap-2.5 p-2.5">
          {invites.length > 0 && (
            <Panel title="Pending invites" right={
              <span className="font-mono text-[9.5px] tracking-wider text-mute">
                SHARE THE LINK YOURSELF — NO EMAIL IS SENT
              </span>
            }>
              <ul className="divide-y divide-hair">
                {invites.map((iv) => (
                  <li key={iv.code} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="text-[12.5px] text-bone">{iv.name}</span>
                    <span className="font-mono text-[10px] text-mute">{iv.email}</span>
                    <span className="lbl border border-hair px-1.5 py-px">{iv.role}</span>
                    <span className="font-mono text-[9.5px] text-mute">
                      expires {new Date(iv.expiresAt).toLocaleDateString()}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      <button onClick={() => copyLink(iv.code)}
                        className="rounded-[6px] border border-line px-2 py-1 font-mono text-[9.5px] tracking-wider text-dim hover:border-lift hover:text-lift">
                        {copied === iv.code ? "COPIED ✓" : "COPY LINK"}
                      </button>
                      <button onClick={() => revoke(iv.code)}
                        className="rounded-[6px] border border-line px-2 py-1 font-mono text-[9.5px] tracking-wider text-mute hover:border-lift hover:text-lift">
                        REVOKE
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="Members">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[660px] border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    {["Name", "Email", "Role", "Clips", "Spend", "Last seen", ""].map((h, i) => (
                      <th key={h || i} className={`lbl px-2.5 py-2 font-normal ${i > 2 && i < 6 ? "text-right" : ""}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className={`border-b border-hair last:border-0 hover:bg-panel2 ${u.disabled ? "opacity-45" : ""}`}>
                      <td className="px-2.5 py-2 text-bone">
                        {u.name}
                        {u.locked && (
                          <span className="ml-2 font-mono text-[9px] tracking-wider text-warn">LOCKED</span>
                        )}
                      </td>
                      <td className="px-2.5 py-2 font-mono text-[10.5px] text-mute">{u.email}</td>
                      <td className="px-2.5 py-2">
                        <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}
                          className="h-[24px] rounded-[6px] border border-line bg-desk px-1 font-mono text-[10px] text-dim">
                          <option value="member">member</option>
                          <option value="admin">admin</option>
                        </select>
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono text-[10.5px] tabular-nums text-dim">{u.clips}</td>
                      <td className="px-2.5 py-2 text-right font-mono text-[10.5px] tabular-nums text-lift">{usd(u.spend, 2)}</td>
                      <td className="px-2.5 py-2 text-right font-mono text-[10px] text-mute whitespace-nowrap">
                        {u.lastSeen ? timeAgo(u.lastSeen) : "never"}
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-2 text-right">
                        {u.locked && (
                          <button onClick={() => patch(u.id, { unlock: true })}
                            className="mr-1.5 rounded-[6px] border border-line px-2 py-1 font-mono text-[9.5px] tracking-wider text-warn hover:border-warn">
                            UNLOCK
                          </button>
                        )}
                        <button onClick={() => patch(u.id, { disabled: !u.disabled })}
                          className="rounded-[6px] border border-line px-2 py-1 font-mono text-[9.5px] tracking-wider text-mute hover:border-lift hover:text-lift">
                          {u.disabled ? "ENABLE" : "DISABLE"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
