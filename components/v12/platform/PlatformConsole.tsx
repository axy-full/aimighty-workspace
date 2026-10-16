"use client";
import { useEffect } from "react";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { PLATFORM_SECTIONS, PLATFORM_SECTION_PARAM, PLATFORM_SHEET_PARAM, readPlatformSection, type PlatformSectionId } from "@/lib/platformConsole";
import type { ConsoleOverview } from "@/lib/platformConsole.server";
import { riskAlarm, riskWords } from "@/lib/atRiskWindow";
import { useAdminRead } from "./api";
import { Overview } from "./Overview";
import { Access } from "./Access";
import { Site } from "./Site";
import { Workspaces } from "./Workspaces";
import { Models } from "./Models";
import { Rules } from "./Rules";
import { Limits } from "./Limits";
import { Plans } from "./Plans";
import { FailedSaves } from "./FailedSaves";
import type { AdminDesk } from "./types";
import "./platform.css";

/**
 * The platform console (`?view=admin`; prototype 14 › Platform console): the platform owner's desk in the new interface's
 * frame, a left column of nine places and the place beside it. Owner only: the page refuses anyone else on the server
 * (app/suites/page.tsx), every route behind it does too (app/api/admin/*, requireSuperAdmin), and a client that reaches it
 * anyway is sent Home. Desktop only; a phone or a workspace without the new interface is told so (SuitesShell).
 *
 * Nothing here moves money or opens a door by itself: Grant credits, Pause and Resume, Invite, Revoke, Resend, the switches
 * and Retry save each call the route they always called, and each of those writes its audit line with the change
 * (lib/platformAudit.ts).
 */
export function PlatformConsole() {
  const shell = useShell();
  const { superAdmin } = useSession();
  useEffect(() => { if (!superAdmin) shell.goHome(); }, [superAdmin, shell]);
  const section = readPlatformSection(new URLSearchParams({ [PLATFORM_SECTION_PARAM]: shell.params[PLATFORM_SECTION_PARAM] ?? "" }));
  const sheet = shell.params[PLATFORM_SHEET_PARAM] ?? null;
  const { data: counts, refresh: refreshCounts } = useAdminRead<ConsoleOverview>(superAdmin ? "/api/admin/console" : null, 30_000);
  const needsDesk = section === "access" || section === "site" || section === "workspaces";
  const { data: desk, refresh: refreshDesk } = useAdminRead<AdminDesk>(superAdmin && needsDesk ? "/api/admin/invites" : null, 30_000);
  if (!superAdmin) return null;

  const badge = (id: PlatformSectionId): { n: number | string; tone?: "bad" } | null => {
    if (id === "access") { const n = (counts?.requestsWaiting ?? 0) + (counts?.invitesPending ?? 0); return n ? { n } : null; }
    if (id === "risk") { const c = counts?.failedSaves; return c && riskAlarm(c) ? { n: riskWords(c), tone: "bad" } : null; }
    return null;
  };
  const refresh = () => { refreshDesk(); refreshCounts(); };

  return (
    <div className="v12-pc" data-testid="platform-console" data-section={section}>
      <nav className="v12-pc-nav" aria-label="Platform console">
        <div className="v12-pc-navhead">Platform console</div>
        {PLATFORM_SECTIONS.map((s) => {
          const b = badge(s.id);
          return (
            <button key={s.id} type="button" className="v12-pc-navitem" aria-current={s.id === section ? "page" : undefined} data-testid={`pc-nav-${s.id}`} onClick={() => shell.goPlatform(s.id)}>
              <span className="v12-pc-navtext"><span className="v12-pc-navlabel">{s.label}</span><span className="v12-pc-navline">{s.line}</span></span>
              {b ? <span className="v12-pc-badge" data-tone={b.tone} data-testid={`pc-badge-${s.id}`}>{b.n}</span> : null}
            </button>
          );
        })}
        <p className="v12-pc-navfoot">Owner only. Never shown in a client workspace.</p>
      </nav>
      <main className="v12-pc-main" data-testid="pc-main">
        <div className="v12-pc-col">
          {section === "overview" ? <Overview /> : null}
          {section === "access" ? <Access desk={desk} refresh={refresh} /> : null}
          {section === "site" ? <Site desk={desk} /> : null}
          {section === "workspaces" ? <Workspaces desk={desk} refresh={refresh} open={sheet} onOpen={(id) => shell.goPlatform("workspaces", id)} /> : null}
          {section === "engines" ? <Models /> : null}
          {section === "rules" ? <Rules /> : null}
          {section === "caps" ? <Limits /> : null}
          {section === "plans" ? <Plans /> : null}
          {section === "risk" ? <FailedSaves onChanged={refreshCounts} /> : null}
        </div>
      </main>
    </div>
  );
}
