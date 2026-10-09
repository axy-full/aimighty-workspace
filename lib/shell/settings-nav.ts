import { SETTINGS_SECTIONS, type SettingsSectionId } from "./ia";
import type { Shell } from "./state";

/** Opens one of the five Settings sections on the page that holds it today: the avatar menu and ⌘K share this. */
export function goSettings(shell: Pick<Shell, "goWorkspace" | "goSuite">, id: SettingsSectionId): void {
  const section = SETTINGS_SECTIONS.find((s) => s.id === id)!;
  if ("workspace" in section.opens) shell.goWorkspace(section.opens.workspace);
  else shell.goSuite(section.opens.suite, section.opens.page);
}
