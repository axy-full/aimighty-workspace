"use client";
import { useState } from "react";
import type { SiteSettings } from "@/lib/site/settings";
import { useToast } from "../ui";
import { adminSend, useAdminRead } from "./api";
import { Head, Picker, Switch } from "./parts";
import type { AdminDesk } from "./types";

type Flag = "openSignup" | "guestHome" | "visitorPages";

/**
 * Public site: who may sign up and what a signed-out visitor sees (lib/site/settings.ts). Each switch saves as it is
 * touched, through the route it always used (app/api/admin/site); turning one ON says so with an Undo, since it opens a
 * door. The server checks every field again and writes the change with its audit line (lib/platformAudit.ts).
 */
export function Site({ desk }: { desk: AdminDesk | null }) {
  const toast = useToast();
  const { data, refresh } = useAdminRead<SiteSettings>("/api/admin/site", 0);
  const [busy, setBusy] = useState(false);

  async function save(patch: Partial<SiteSettings>): Promise<boolean> {
    setBusy(true);
    const sent = await adminSend("/api/admin/site", "PATCH", patch);
    setBusy(false);
    if (!sent.ok) toast({ text: sent.error });
    refresh();
    return sent.ok;
  }
  async function flip(flag: Flag, on: boolean, said: string) {
    if (!(await save({ [flag]: on }))) return;
    toast(on ? { text: said, action: { label: "Undo", run: () => void save({ [flag]: false }) } } : { text: said.replace(/ is on$/, " is off") });
  }

  const workspaces = (desk?.workspaces ?? []).filter((w) => !w.deletedAt && !w.legacy);
  return (
    <>
      <Head title="Public site" line="What signed-out visitors and client workspaces see." />
      {!data ? null : (
        <div className="v12-pc-rows" data-testid="pc-site">
          <div className="v12-pc-row">
            <Switch on={data.openSignup} label="Open sign-up" disabled={busy} onChange={(on) => void flip("openSignup", on, "Open sign-up is on")} testId="pc-site-open-signup" />
            <div className="v12-pc-rowtext"><span className="v12-pc-rowname">Open sign-up <span className="v12-pc-state">{data.openSignup ? "on" : "off"}</span></span>
              <span className="v12-pc-rowline">{data.openSignup ? "Anyone can make an account without an invitation." : "Sign-up needs an invitation. Requests land in Who can join."}</span></div>
          </div>
          <div className="v12-pc-row">
            <Switch on={data.guestHome} label="Visitor pages" disabled={busy} onChange={(on) => void flip("guestHome", on, "Visitor pages is on")} testId="pc-site-guest-home" />
            <div className="v12-pc-rowtext"><span className="v12-pc-rowname">Visitor pages <span className="v12-pc-state">{data.guestHome ? "on" : "off"}</span></span>
              <span className="v12-pc-rowline">{data.guestHome ? "A signed-out visitor sees Home with the sample board, read only." : "A signed-out visitor sees the old site."}</span></div>
          </div>
          <div className="v12-pc-row">
            <Switch on={data.visitorPages} label="New visitor design" disabled={busy || !data.guestHome} title={data.guestHome ? undefined : "Turn visitor pages on first"} onChange={(on) => void flip("visitorPages", on, "New visitor design is on")} testId="pc-site-visitor-pages" />
            <div className="v12-pc-rowtext"><span className="v12-pc-rowname">New visitor design <span className="v12-pc-state">{data.visitorPages ? "on" : "off"}</span></span>
              <span className="v12-pc-rowline">With visitor pages on, visitors see the new design and its join sheet.</span></div>
          </div>
          <div className="v12-pc-row v12-pc-rowfield">
            <div className="v12-pc-rowtext">
              <span className="v12-pc-rowname">Sample workspace</span>
              <Picker label="Sample workspace" value={data.guestWorkspace ?? ""} testId="pc-site-guest-workspace"
                options={[{ id: "", label: "None" }, ...workspaces.map((w) => ({ id: w.id, label: w.name }))]}
                onChange={(id) => { void save({ guestWorkspace: id || null }).then((ok) => { if (ok) toast({ text: id ? "Sample workspace set" : "Sample workspace cleared" }); }); }} />
              <span className="v12-pc-rowline">The public sample board visitors can explore. Never the house workspace.</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
