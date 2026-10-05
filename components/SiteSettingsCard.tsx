"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { appAlert, appConfirm } from "@/components/dialog";
import type { SiteSettings } from "@/lib/site/settings";

/**
 * /admin's "Site" block (lib/site/settings.ts): who may sign up, and what a signed-out visitor sees at "/".
 * Off by default. Turning either on asks first; the server checks every field again.
 */
export function SiteSettingsCard({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const { data, refresh } = useApi<SiteSettings>("/api/admin/site", 0);
  const [busy, setBusy] = useState(false);

  async function save(patch: Partial<SiteSettings>, ask?: [string, string, string]) {
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
      <div className="scard-h"><span>Site</span><span>What a signed-out visitor sees, and who may sign up. Both are off by default.</span></div>
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
        <label className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5"><span className="font-medium">The sample’s workspace</span><span className="text-[12px] text-lead">The one workspace whose sample production guests may read. Nothing else is read for a guest.</span></span>
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
