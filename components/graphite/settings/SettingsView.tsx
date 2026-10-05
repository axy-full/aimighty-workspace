"use client";
import { useRef, type KeyboardEvent } from "react";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { SETTINGS_SECTIONS, isBuiltSection, isSettingsFold, sectionLabel, type SettingsSectionId } from "@/lib/shell/settings";
import { WorkspaceView } from "../WorkspaceView";
import { TeamSection } from "./team/TeamSection";
import { CreditsSection } from "./credits/CreditsSection";
import { RulesSection } from "./rules/RulesSection";
import { ConnectionsSection } from "./connections/ConnectionsSection";
import { AdvancedSection } from "./advanced/AdvancedSection";
import { useGoSettings } from "./navigate";
import "./settings.css";

/**
 * Settings behind the avatar, in five sections (design/particl-graphite/README.md § 3.5; the master's
 * `?view=workspace&ws=…` frames): Team · Plan & credits · Spending rules · Connections · Advanced.
 * The shell mounts it for `view=workspace` with the new interface on (lib/shell/screens.ts).
 *
 * Each section reads and writes through the routes Workspace's tabs already use, with their own role
 * checks; nothing here prices, charges or approves. A section this build does not draw yet opens the
 * page that holds it today (lib/shell/settings.ts › SETTINGS_INTERIM), and an old tab id that no row
 * has moved yet (General, Engines, Dashboard) still shows Workspace's own tab.
 */
const FOOT: Partial<Record<SettingsSectionId, string>> = {
  credits: "Hover a figure for dollars.",
  rules: "Spending rules belong to people: Atomik prepares and explains, you decide.",
};

export function SettingsView({ account, section, open }: { account: WorkspaceAccount | null; section: string; open: string | null }) {
  const go = useGoSettings();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!isBuiltSection(section)) return <WorkspaceView account={account} />;
  const fold = isSettingsFold(open) ? open : null;
  /* ←/→ walk the sections, Home/End jump; a section opens on press, as the master's segment does. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.current.findIndex((el) => el === document.activeElement);
    const n = SETTINGS_SECTIONS.length;
    const to = e.key === "ArrowRight" ? (at + 1) % n : e.key === "ArrowLeft" ? (at + n - 1) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0 || at < 0) return;
    e.preventDefault();
    tabs.current[to]?.focus();
  };
  return (
    <div className="gs gx-scroll" data-testid="settings-view" data-section={section}>
      <div className="gs-page">
        <div className="gs-head">
          <div className="gs-title">
            <span className="gs-eyebrow">Settings</span>
            <h1 className="gs-h1" data-testid="settings-title">{sectionLabel(section)}</h1>
          </div>
          <div className="gs-seg" role="group" aria-label="Settings sections" onKeyDown={onKey}>
            {SETTINGS_SECTIONS.map((s, i) => (
              <button key={s.id} ref={(el) => { tabs.current[i] = el; }} type="button" className="gs-seg-btn" aria-current={s.id === section ? "page" : undefined}
                onClick={() => { if (s.id !== section) go(s.id); }} data-testid={`settings-section-${s.id}`}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {section === "team" ? <TeamSection key="team" open={fold} /> : null}
        {section === "credits" ? <CreditsSection key="credits" account={account} open={fold} /> : null}
        {section === "rules" ? <RulesSection key="rules" /> : null}
        {section === "connections" ? <ConnectionsSection key="connections" open={fold} /> : null}
        {section === "advanced" ? <AdvancedSection key="advanced" open={fold} /> : null}
        {FOOT[section] ? <p className="gs-foot">{FOOT[section]}</p> : null}
      </div>
    </div>
  );
}
