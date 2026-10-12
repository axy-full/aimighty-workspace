"use client";
import { useSession } from "@/lib/session";
import { useShell } from "@/lib/shell/state";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { useLowCredit } from "@/lib/v12/useLowCredit";
import { isAccountSection, navFor, sectionFor, TITLES, type ConsoleSection } from "@/lib/v12/settingsConsole";
import { useRead } from "@/components/graphite/settings/use-settings";
import { Overview } from "./Overview";
import { People, type TeamBody } from "./People";
import { ConsoleBilling } from "./ConsoleBilling";
import { Usage } from "./Usage";
import { Defaults } from "./Defaults";
import { StyleRules } from "./StyleRules";
import { Limits } from "./Limits";
import { WorkspacePanel } from "./WorkspacePanel";
import { Profile } from "./Profile";
import { Notifications } from "./Notifications";
import "./console.css";

/**
 * Workspace settings (prototype v14, README § V14.2; `?view=settings&section=…`): a left column of sections and one content
 * column. An admin has Overview, People, Credits & billing, Usage, Defaults, Style rules, Limits and Workspace; a member has
 * Your usage and Plan (read only). Everyone has Profile and Notifications. The column hides what a person may not use, and the
 * server refuses it anyway: every admin read and write is an admin's in its own route (tests/workspace-settings-v12-workbench.spec.ts).
 * Everything here is this workspace's, from the signed-in session; no id of another workspace is ever sent or read.
 */
export function WorkspaceConsole({ account, onOpenProject }: { account: WorkspaceAccount | null; onOpenProject: (id: string) => void }) {
  const session = useSession();
  const shell = useShell();
  const admin = session.role === "admin" || session.role === "owner";
  const section = sectionFor(shell.params.section, admin);
  const wsName = session.workspace?.name ?? account?.workspace?.name ?? "this workspace";
  const team = useRead<TeamBody>(admin ? "/api/team" : null);
  const low = useLowCredit(account?.credits?.balance ?? null).low;
  const pending = team.data?.invites.length ?? 0;
  const badge = (id: ConsoleSection): string => (id === "people" && pending ? String(pending) : id === "overview" && low ? "Low" : "");
  const title = TITLES[section];
  const heading = !admin && title.memberTitle ? title.memberTitle : title.title;
  const sub = !admin && title.memberSub ? title.memberSub : title.sub(wsName);

  return (
    <div className="v12-ws" data-testid="v12-settings" data-section={section} data-screen-label={`Workspace settings · ${heading}`}>
      <nav className="v12-ws-nav" aria-label="Workspace settings">
        <span className="v12-ws-nav-title">Workspace settings</span>
        <span className="v12-ws-nav-ws" title={wsName}>{wsName}</span>
        {navFor(admin).map((group) => (
          <div key={group.label} style={{ display: "contents" }}>
            <span className="v12-ws-group">{group.label}</span>
            {group.items.map((item) => (
              <button key={item.id} type="button" className="v12-ws-item" aria-current={item.id === section ? "page" : undefined} onClick={() => shell.goConsole(item.id)} data-testid={`v12-settings-nav-${item.id}`}>
                <span className="v12-ws-item-k">
                  <span className="v12-ws-item-name">{item.label}</span>
                  <span className="v12-ws-item-line">{item.line}</span>
                </span>
                {badge(item.id) ? <span className="v12-ws-badge" data-testid={`v12-settings-badge-${item.id}`}>{badge(item.id)}</span> : null}
              </button>
            ))}
          </div>
        ))}
        <div className="v12-ws-nav-foot">
          <button type="button" className="v12-ws-more" onClick={() => shell.goWorkspace("team")} data-testid="v12-settings-more">Sign-in security, keys and connections</button>
          <span>Only people in this workspace can see this.</span>
        </div>
      </nav>
      <main className="v12-ws-main" id="v12-ws-main">
        <div className="v12-ws-col">
          <div className="v12-ws-head">
            <span className="v12-ws-eyebrow">{isAccountSection(section) ? "Your account" : "Your workspace"}</span>
            <h1 className="v12-ws-h1" data-testid="v12-settings-title">{heading}</h1>
            <span className="v12-ws-sub">{sub}</span>
          </div>
          {section === "overview" && admin ? <Overview account={account} team={team} /> : null}
          {section === "people" && admin ? <People team={team} /> : null}
          {section === "billing" ? <ConsoleBilling account={account} admin={admin} onOpenProject={onOpenProject} /> : null}
          {section === "usage" ? <Usage admin={admin} onOpenProject={onOpenProject} /> : null}
          {section === "defaults" && admin ? <Defaults /> : null}
          {section === "rules" && admin ? <StyleRules /> : null}
          {section === "limits" && admin ? <Limits /> : null}
          {section === "workspace" && admin ? <WorkspacePanel /> : null}
          {section === "profile" ? <Profile /> : null}
          {section === "notifications" ? <Notifications admin={admin} /> : null}
        </div>
      </main>
    </div>
  );
}
