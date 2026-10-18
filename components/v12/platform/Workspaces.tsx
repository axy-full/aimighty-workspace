"use client";
import { useMemo, useRef, useState } from "react";
import type { WorkspaceSheet } from "@/lib/platformConsole.server";
import { HOUSE_NOT_BILLED } from "@/lib/houseWorkspace";
import { creditsText } from "@/lib/shell/price-words";
import { houseCapUsdText, houseCapWarning } from "@/lib/houseCapText";
import { timeAgo } from "@/lib/format";
import { ContextMenu, IconButton, useOverlay, useToast, type MenuItem } from "../ui";
import { adminSend, useAdminRead } from "./api";
import { Cr, Head, day } from "./parts";
import type { AdminDesk, AdminWorkspace } from "./types";

const dollars = (usd: number): string => `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** All workspaces: every workspace on the deployment, including the house, and a side sheet for one (credits, pause, resume). */
export function Workspaces({ desk, refresh, open, onOpen }: { desk: AdminDesk | null; refresh: () => void; open: string | null; onOpen: (id: string | null) => void }) {
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ ws: AdminWorkspace; at: { x: number; y: number; pointer?: boolean } } | null>(null);
  const plans = desk?.plans ?? [];
  const rows = useMemo(() => {
    const all = desk?.workspaces ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((w) => `${w.name} ${w.owner?.name ?? ""} ${w.owner?.email ?? ""}`.toLowerCase().includes(needle)) : all;
  }, [desk, q]);
  const planOf = (w: AdminWorkspace) => (w.house ? "House · pays at cost" : plans.find((p) => p.id === w.planId)?.label ?? "No plan");
  const status = (w: AdminWorkspace) => (w.deletedAt ? { tone: "idle", word: "Deleted" } : w.suspended ? { tone: "warn", word: "Paused" } : { tone: "ok", word: "Active" });
  const items = (w: AdminWorkspace): MenuItem[] => [{ id: "open", label: "Open", onSelect: () => onOpen(w.id), testId: "pc-ws-open" }];

  return (
    <>
      <Head title="All workspaces" line="Every workspace on the platform, including the house." />
      <div className="v12-pc-toolbar">
        <input className="v12-pc-input v12-pc-search" type="search" aria-label="Search by name or owner" placeholder="Search by name or owner" value={q} onChange={(e) => setQ(e.target.value)} data-testid="pc-ws-search" />
        <span className="v12-pc-meta v12-pc-mono" data-testid="pc-ws-count">{rows.length} of {desk?.workspaces.length ?? 0}</span>
      </div>
      <div className="v12-pc-table" role="table" aria-label="Workspaces" data-testid="pc-workspaces">
        <div className="v12-pc-tr v12-pc-th v12-pc-wscols" role="row">
          <span role="columnheader">Name</span><span role="columnheader">Owner</span><span role="columnheader">Plan</span><span role="columnheader">Seats</span>
          <span role="columnheader">Credits left</span><span role="columnheader">Spent · 30 days</span><span role="columnheader">Created</span><span role="columnheader">Status</span>
        </div>
        {rows.map((w) => {
          const s = status(w);
          return (
            <div key={w.id} role="row" tabIndex={0} className="v12-pc-tr v12-pc-wscols v12-pc-rowbtn" data-active={open === w.id || undefined} data-testid="pc-ws-row" data-ws={w.id}
              onClick={() => onOpen(w.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(w.id); } }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ ws: w, at: { x: e.clientX, y: e.clientY } }); }}>
              <span role="cell" className="v12-pc-strong v12-pc-clip">{w.name}</span>
              <span role="cell" className="v12-pc-clip v12-pc-meta">{w.owner?.name || w.owner?.email || "—"}</span>
              <span role="cell" className={w.house ? "v12-pc-accent" : undefined}>{planOf(w)}</span>
              <span role="cell" className="v12-pc-mono">{w.members}</span>
              <span role="cell">{w.credits ? <Cr credits={w.credits.balance} /> : <span className="v12-pc-meta">—</span>}</span>
              <span role="cell">{w.house ? (w.spend30 ? <span className="v12-pc-mono" title="Pays at cost">{dollars(w.spend30.engineCostUsd)}</span> : <span className="v12-pc-meta">—</span>) : w.spend30 ? <Cr credits={w.spend30.billedCredits} /> : <span className="v12-pc-meta">—</span>}</span>
              <span role="cell" className="v12-pc-meta">{day(w.createdAt)}</span>
              <span role="cell"><span className="v12-pc-dot" data-tone={s.tone} aria-hidden /> {s.word}</span>
            </div>
          );
        })}
        {desk && !rows.length ? <div className="v12-pc-empty">No workspace matches.</div> : null}
      </div>
      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)} label="Workspace" items={menu ? items(menu.ws) : []} width={160} />
      {open ? <Sheet key={open} id={open} summary={desk?.workspaces.find((w) => w.id === open) ?? null} onClose={() => onOpen(null)} changed={refresh} /> : null}
    </>
  );
}

/** One workspace in a side sheet: its plan and balance, who is in it, its credit history, Grant credits and Pause or Resume. */
function Sheet({ id, summary, onClose, changed }: { id: string; summary: AdminWorkspace | null; onClose: () => void; changed: () => void }) {
  const toast = useToast();
  const panel = useRef<HTMLElement>(null);
  const { data, error, refresh } = useAdminRead<WorkspaceSheet>(`/api/admin/console/workspaces/${encodeURIComponent(id)}`, 0);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pausing, setPausing] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  useOverlay("menu", true, onClose, { refs: [panel], outside: false });

  const deleted = Boolean(summary?.deletedAt);
  const credits = Number(amount);
  const grantOk = Number.isInteger(credits) && credits > 0;

  async function patch(body: Record<string, unknown>, said: string) {
    setBusy(true);
    const sent = await adminSend(`/api/admin/workspaces/${encodeURIComponent(id)}`, "PATCH", body);
    setBusy(false);
    toast({ text: sent.ok ? said : sent.error });
    if (sent.ok) { refresh(); changed(); }
    return sent.ok;
  }
  const grant = async () => { if (await patch({ grantCredits: credits, note: reason.trim() || "Granted by the platform" }, `Added ${creditsText(credits)} to ${data?.name ?? "the workspace"}`)) { setAmount(""); setReason(""); } };
  const pause = async () => { if (await patch({ suspended: true, reason: why.trim() || "Paused by the platform" }, "Workspace paused")) { setPausing(false); setWhy(""); } };

  return (
    <aside ref={panel} className="v12-pc-sheet" role="dialog" aria-label={data?.name ?? summary?.name ?? "Workspace"} data-testid="pc-sheet">
      <header className="v12-pc-sheet-head">
        <div>
          <h2 className="v12-pc-sheet-title">{data?.name ?? summary?.name ?? "…"}</h2>
          <p className="v12-pc-meta">{summary?.owner ? `Owner ${summary.owner.name || summary.owner.email}` : "No owner"}{summary ? ` · created ${day(summary.createdAt)}` : ""}</p>
        </div>
        <IconButton tooltip={{ name: "Close", shortcut: "Esc" }} size="sm" onClick={onClose} data-testid="pc-sheet-close">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </IconButton>
      </header>
      {error && !data ? <p className="v12-pc-note">{error}</p> : null}
      {data ? (
        <div className="v12-pc-sheet-body">
          <div className="v12-pc-minitiles">
            <div className="v12-pc-minitile"><span className="v12-pc-tile-name">Plan</span><strong data-testid="pc-sheet-plan">{data.house ? "House · pays at cost" : data.plan?.label ?? "No plan"}</strong></div>
            {data.houseCap ? <div className="v12-pc-minitile" data-testid="pc-sheet-house-cap"><span className="v12-pc-tile-name">Monthly cap</span><strong>{data.houseCap.warn ? houseCapWarning(data.houseCap) : `${houseCapUsdText(data.houseCap.capUsd)} · ${data.houseCap.pct}% used`}</strong></div> : null}
            <div className="v12-pc-minitile"><span className="v12-pc-tile-name">Credits left</span><strong data-testid="pc-sheet-balance">{data.balance == null ? "—" : <Cr credits={data.balance} />}</strong></div>
          </div>
          <h3 className="v12-pc-h3">Members · {data.members.length}</h3>
          <ul className="v12-pc-list" data-testid="pc-sheet-members">
            {data.members.slice(0, 5).map((m) => (
              <li key={m.email} className="v12-pc-li"><span className="v12-pc-clip">{m.name || m.email}</span><span className="v12-pc-meta">{m.disabled ? "Switched off" : m.role === "owner" ? "Owner" : m.role === "admin" ? "Admin" : "Member"}</span></li>
            ))}
            {data.members.length > 5 ? <li className="v12-pc-li v12-pc-meta">+ {data.members.length - 5} more</li> : null}
          </ul>
          <h3 className="v12-pc-h3">Credit history</h3>
          {data.house ? <p className="v12-pc-meta">{HOUSE_NOT_BILLED}</p> : (
            <ul className="v12-pc-list" data-testid="pc-sheet-history">
              {data.history.map((g, i) => (
                <li key={i} className="v12-pc-li v12-pc-hist"><span className="v12-pc-meta">{day(g.at)}</span><span className="v12-pc-clip">{g.note || g.kind}</span><span className="v12-pc-mono" data-tone={g.credits < 0 ? "out" : "in"}>{g.credits > 0 ? "+" : "−"}{creditsText(Math.abs(g.credits))}</span></li>
              ))}
              {!data.history.length ? <li className="v12-pc-li v12-pc-meta">Nothing yet.</li> : null}
            </ul>
          )}
          {data.changes.length ? (
            <>
              <h3 className="v12-pc-h3">Changes from here</h3>
              <ul className="v12-pc-list" data-testid="pc-sheet-changes">
                {data.changes.map((c) => <li key={c.id} className="v12-pc-li"><span className="v12-pc-clip">{auditWords(c.action, c.details.credits, c.details.capUsd, c.details.atPct)}</span><span className="v12-pc-meta">{timeAgo(c.createdAt)}</span></li>)}
              </ul>
            </>
          ) : null}
          {!deleted ? (
            <>
              <form className="v12-pc-grant" onSubmit={(e) => { e.preventDefault(); if (grantOk && !data.house) void grant(); }}>
                <h3 className="v12-pc-h3">Grant credits</h3>
                <div className="v12-pc-grantrow">
                  <label className="v12-pc-unit"><input className="v12-pc-input v12-pc-num" inputMode="numeric" aria-label="Credits to add" placeholder="Credits" value={amount} disabled={data.house} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} data-testid="pc-grant-amount" /><span>cr</span></label>
                  <input className="v12-pc-input v12-pc-grow" aria-label="Reason" placeholder="Reason · they see it" value={reason} disabled={data.house} onChange={(e) => setReason(e.target.value)} data-testid="pc-grant-reason" />
                </div>
                <span title={data.house ? HOUSE_NOT_BILLED : !grantOk ? "Type how many credits to add" : undefined} className="v12-pc-inline">
                  <button type="submit" className="v12-pc-primary" disabled={busy || data.house || !grantOk} data-testid="pc-grant-send">Grant credits</button>
                </span>
              </form>
              <div className="v12-pc-pause">
                {data.paused ? (
                  <>
                    <p className="v12-pc-meta">Paused{data.pausedReason ? ` · ${data.pausedReason}` : ""}. Renders are stopped; nothing is deleted.</p>
                    <button type="button" className="v12-pc-btn" disabled={busy} onClick={() => void patch({ suspended: false }, "Workspace resumed")} data-testid="pc-resume">Resume workspace</button>
                  </>
                ) : pausing ? (
                  <div className="v12-pc-grantrow">
                    <input className="v12-pc-input v12-pc-grow" aria-label="Reason" placeholder="Reason · shown to the workspace" value={why} onChange={(e) => setWhy(e.target.value)} data-testid="pc-pause-reason" />
                    <button type="button" className="v12-pc-btn" disabled={busy} onClick={() => void pause()} data-testid="pc-pause-confirm">Pause</button>
                    <button type="button" className="v12-pc-quiet" onClick={() => setPausing(false)}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <p className="v12-pc-meta">Pausing stops renders; nothing is deleted.</p>
                    <span title={data.house ? "The house workspace can’t be paused from here" : undefined} className="v12-pc-inline">
                      <button type="button" className="v12-pc-btn" disabled={busy || data.house} onClick={() => setPausing(true)} data-testid="pc-pause">Pause workspace</button>
                    </span>
                  </>
                )}
              </div>
            </>
          ) : <p className="v12-pc-meta">Deleted workspaces can’t be changed here.</p>}
        </div>
      ) : null}
    </aside>
  );
}

/** A platform-audit line as a sentence: what, and for credits how many (lib/platformAudit.ts). */
function auditWords(action: string, credits?: number, capUsd?: number | null, atPct?: number): string {
  switch (action) {
    case "credits.granted": return credits != null ? `${credits < 0 ? "Took" : "Added"} ${creditsText(Math.abs(credits))}` : "Credits changed";
    case "workspace.paused": return "Paused";
    case "workspace.resumed": return "Resumed";
    case "housecap.set": return capUsd == null ? "Cap back to the default" : `Cap set to ${houseCapUsdText(capUsd)} a month`;
    case "housecap.warned": return atPct != null ? `${atPct}% of the monthly cap used` : "Monthly cap warning";
    default: return action;
  }
}
