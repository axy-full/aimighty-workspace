"use client";
import { useCallback } from "react";
import { useShell } from "@/lib/shell/state";
import { sectionTarget, type SettingsFold, type SettingsSectionId, type SettingsTarget } from "@/lib/shell/settings";

/** Opens a Settings section where this build has it: the section itself, or the page that holds it today. */
export function useGoSettings() {
  const shell = useShell();
  const go = useCallback((target: SettingsTarget) => {
    if (target.kind === "suite") shell.goSuite(target.suite, target.page);
    else if (target.kind === "workspace") shell.goWorkspace(target.tab);
    else shell.goWorkspace(target.section, target.open ? { open: target.open } : undefined);
  }, [shell]);
  return useCallback((id: SettingsSectionId, open?: SettingsFold) => go(sectionTarget(id, open)), [go]);
}
