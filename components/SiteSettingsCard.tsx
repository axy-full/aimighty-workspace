"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { appAlert, appConfirm } from "@/components/dialog";
import type { SitePatch, SiteSettings } from "@/lib/site/settings";

/**
 * /admin's "Site" block (lib/site/settings.ts): who may sign up, and what a signed-out visitor sees at "/".
 * Off by default. Turning either on asks first; the server checks every field again.
 */
export function SiteSettingsCard({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const { data, refresh } = useApi<SiteSettings & { newInterfaceOff: string[] }>("/api/admin/site", 0);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState("");

  async function save(patch: SitePatch, ask?: [string, string, string]) {
    if (ask && !(await appConfirm(ask[0], ask[1], { confirmLabel: ask[2] }))) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/site", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      refresh();
    } catch (e) { await appAlert("Not changed", (e as Error).message); }
    finally { setBusy(false); }
  }

  if (!data) return null;
  return (
    <section className="scard" data-testid="site-settings">
      <div className="scard-h"><span>Site</span><span>What a signed-out visitor sees, who may sign up, and which screens people get.</span></div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5"><span className="font-medium">Open sign-up</span><span className="text-[12px] text-lead">{data.openSignup ? "Anyone may create an account without an invitation link." : "Sign-up needs an invitation link. Requests for access land in “Asked to be let in”."}</span></span>
          <button type="button" className={`chip !py-0.5 !text-[12px] ${data.openSignup ? "is-on" : ""}`} disabled={busy} aria-pressed={data.openSignup} data-testid="site-open-signup"
            onClick={() => void save({ openSignup: !data.openSignup }, data.openSignup ? undefined : ["Open sign-up to anyone?", "Anyone can then create an account and a workspace without an invitation link.", "Open sign-up"])}>
            {data.openSignup ? "Open sign-up · on" : "Open sign-up · off"}
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5"><span className="font-medium">Guest Home</span><span className="text-[12px] text-lead">{data.guestHome ? "A signed-out visitor at / sees Home and the sample production, read-only." : "A signed-out visitor at / sees today’s site."}</span></span>
          <button type="button" className={`chip !py-0.5 !text-[12px] ${data.guestHome ? "is-on" : ""}`} disabled={busy} aria-pressed={data.guestHome} data-testid="site-guest-home"
            onClick={() => void save({ guestHome: !data.guestHome }, data.guestHome ? undefined : ["Show Guest Home at /?", "Signed-out visitors then see Home with the sample production instead of today’s site. Nothing they do there thinks or spends.", "Show Guest Home"])}>
            {data.guestHome ? "Guest Home · on" : "Guest Home · off"}
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5"><span className="font-medium">New visitor pages</span><span className="text-[12px] text-lead">{data.visitorPages ? "With Guest Home on, /?guest=1 shows the new interface’s visitor pages and join sheet." : "/?guest=1 shows today’s Guest Home."}</span></span>
          <button type="button" className={`chip !py-0.5 !text-[12px] ${data.visitorPages ? "is-on" : ""}`} disabled={busy} aria-pressed={data.visitorPages} data-testid="site-visitor-pages"
            onClick={() => void save({ visitorPages: !data.visitorPages }, data.visitorPages ? undefined : ["Show the new visitor pages?", "With Guest Home on, signed-out visitors at /?guest=1 then see the new interface’s Home, Make, sample board and join sheet. Nothing they do there thinks or spends.", "Show them"])}>
            {data.visitorPages ? "New visitor pages · on" : "New visitor pages · off"}
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5"><span className="font-medium">New interface for everyone</span><span className="text-[12px] text-lead">{data.newInterfaceEveryone ? "Every workspace uses the new interface." : "Every workspace is back on today’s screens."}</span></span>
          <button type="button" className={`chip !py-0.5 !text-[12px] ${data.newInterfaceEveryone ? "is-on" : ""}`} disabled={busy} aria-pressed={data.newInterfaceEveryone} data-testid="site-new-interface"
            onClick={() => void save({ newInterfaceEveryone: !data.newInterfaceEveryone }, data.newInterfaceEveryone ? ["Put everyone back on today’s screens?", "Every workspace, signed in now or later, returns to today’s screens at once. Nothing is lost; turn this on again to bring the new interface back.", "Put everyone back"] : undefined)}>
            {data.newInterfaceEveryone ? "New interface · on" : "New interface · off"}
          </button>
        </div>
        <div className="flex flex-col gap-2" data-testid="site-new-interface-off">
          <span className="flex flex-col gap-0.5"><span className="font-medium">Keep a workspace on today’s screens</span><span className="text-[12px] text-lead">Only that workspace goes back; the rest keep the new interface.</span></span>
          <div className="flex flex-wrap items-center gap-2">
            <select className="ctl !h-9 w-[260px]" value={pick} disabled={busy} aria-label="Workspace to keep on today’s screens" data-testid="site-new-interface-pick" onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a workspace</option>
              {workspaces.filter((w) => !data.newInterfaceOff.includes(w.id)).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <button type="button" className="chip !py-0.5 !text-[12px]" disabled={busy || !pick} data-testid="site-new-interface-add"
              onClick={() => void save({ newInterfaceOffAdd: pick }, ["Keep this workspace on today’s screens?", `${workspaces.find((w) => w.id === pick)?.name ?? "This workspace"} goes back to today’s screens at once. Everyone else keeps the new interface.`, "Keep it there"]).then(() => setPick(""))}>Keep on today’s screens</button>
          </div>
          {data.newInterfaceOff.length > 0 && (
            <ul className="flex flex-col gap-1">
              {data.newInterfaceOff.map((id) => (
                <li key={id} className="flex items-center justify-between gap-3" data-testid="site-new-interface-listed">
                  <span>{workspaces.find((w) => w.id === id)?.name ?? id}</span>
                  <button type="button" className="chip !py-0.5 !text-[12px]" disabled={busy} onClick={() => void save({ newInterfaceOffRemove: id })}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5"><span className="font-medium">The sample’s workspace</span><span className="text-[12px] text-lead">The separate public workspace that holds the sample production (“Particl sample”). Guests read only its sample; never the house workspace or a demo workspace.</span></span>
          <select className="ctl !h-9 w-[260px]" value={data.guestWorkspace ?? ""} disabled={busy} data-testid="site-guest-workspace"
            onChange={(e) => void save({ guestWorkspace: e.target.value || null })}>
            <option value="">None</option>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
