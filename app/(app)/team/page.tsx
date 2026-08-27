"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { usd, timeAgo } from "@/lib/format";
import { Panel } from "@/components/Panel";
import { avatarHue, initialsOf } from "@/components/NavRail";

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
  const active = users.filter((u) => !u.disabled).length;

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5 max-[860px]:px-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="ptitle text-[20px] leading-tight">Team</span>
          <span className="text-[12px] text-dim">{active} active member{active === 1 ? "" : "s"} · invite-only</span>
        </span>
        <span className="ml-auto" />
        <a href="/api/export" download
          title="Download every prompt, cost and account record as JSON"
          className="chip !py-[7px] !text-dim">
          Export data
        </a>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[var(--r)] border border-line bg-panel p-3">
        <input className="ctl w-[170px] flex-1 sm:flex-none" placeholder="Name"
          value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && invite()} />
        <input className="ctl w-[220px] flex-1 sm:flex-none" placeholder="Email" type="email"
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && invite()} />
        <select className="ctl w-auto shrink-0" value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button onClick={invite} disabled={busy || !form.name.trim() || !form.email.trim()}
          className="btn-render h-[32px] shrink-0 px-3.5 text-[12.5px]">
          Invite member
        </button>
        <span className="w-full font-mono text-[9px] tracking-wider text-mute sm:ml-auto sm:w-auto">
          SHARE THE LINK YOURSELF — NO EMAIL IS SENT
        </span>
      </div>

      {err && (
        <p className="mt-3 rounded-[8px] bg-lift/8 px-3 py-2 font-mono text-[10.5px] text-lift">{err}</p>
      )}

      {invites.length > 0 && (
        <Panel title="Pending invites" className="mt-3">
          <ul className="divide-y divide-hair">
            {invites.map((iv) => (
              <li key={iv.code} className="flex flex-wrap items-center gap-2.5 px-4 py-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-[1.4px] border-dashed border-mute/60" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[12.5px] font-semibold text-dim">{iv.name}</span>
                  <span className="truncate font-mono text-[10px] text-mute">{iv.email}</span>
                </span>
                <span className="rounded-full border border-dashed border-line px-2.5 py-[3px] text-[11px] text-mute">
                  {iv.role} · pending
                </span>
                <span className="font-mono text-[9.5px] text-mute">
                  expires {new Date(iv.expiresAt).toLocaleDateString()}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  <button onClick={() => copyLink(iv.code)}
                    className="rounded-[7px] border border-line px-2 py-1 font-mono text-[9.5px] tracking-wider text-dim hover:border-lift hover:text-lift">
                    {copied === iv.code ? "COPIED ✓" : "COPY LINK"}
                  </button>
                  <button onClick={() => revoke(iv.code)}
                    className="rounded-[7px] border border-line px-2 py-1 font-mono text-[9.5px] tracking-wider text-mute hover:border-lift hover:text-lift">
                    REVOKE
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Members" className="mt-3">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-[12px]">
            <thead>
              <tr className="text-left">
                {["Member", "Role", "Clips", "Spend", "Last seen", ""].map((h, i) => (
                  <th key={h || i} className={`lbl px-4 py-2.5 font-normal ${i > 1 && i < 5 ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={`border-t border-hair hover:bg-chip/60 ${u.disabled ? "opacity-45" : ""}`}>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                        style={{ background: avatarHue(u.name) }}>
                        {initialsOf(u.name)}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[12.5px] font-semibold text-bone">
                          {u.name}
                          {u.locked && (
                            <span className="ml-2 font-mono text-[9px] tracking-wider text-warn">LOCKED</span>
                          )}
                        </span>
                        <span className="truncate font-mono text-[10px] text-mute">{u.email}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}
                      className={`h-[24px] rounded-full border px-2 text-[11px] font-medium ${
                        u.role === "admin"
                          ? "border-red/35 bg-red/15 text-lift"
                          : "border-line bg-chip text-dim"
                      }`}>
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-dim">{u.clips}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-bone">{usd(u.spend, 2)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right text-[11.5px] text-mute">
                    {u.lastSeen ? timeAgo(u.lastSeen) : "never"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    {u.locked && (
                      <button onClick={() => patch(u.id, { unlock: true })}
                        className="mr-1.5 rounded-[7px] border border-line px-2 py-1 font-mono text-[9.5px] tracking-wider text-warn hover:border-warn">
                        UNLOCK
                      </button>
                    )}
                    <button onClick={() => patch(u.id, { disabled: !u.disabled })}
                      className="rounded-[7px] border border-line px-2 py-1 font-mono text-[9.5px] tracking-wider text-mute hover:border-lift hover:text-lift">
                      {u.disabled ? "ENABLE" : "DISABLE"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-mute">
        <span><span className="font-semibold text-dim">Admin</span> — team, invites &amp; ledger</span>
        <span><span className="font-semibold text-dim">Member</span> — generate &amp; edit</span>
      </div>
    </div>
  );
}
