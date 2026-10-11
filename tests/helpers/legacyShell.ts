import { test, type Page } from "@playwright/test";

/**
 * The old shell is not reachable in Release 1: /, /workbench, /atomik and
 * /subatomik always go to /suites, and ?shell=legacy and its cookie are gone
 * (docs/old-shells.md). A spec that still asks for the old shell has nothing to
 * drive, so it is skipped here, with the reason, instead of failing in a place
 * that no longer exists. Rewrite it against /suites, or delete it with the old
 * screen it covers.
 *
 * The helper keeps its name and signature so the specs that call it still
 * compile; it returns the URL unchanged.
 */
export const OLD_SHELL_RETIRED = "The old shell is retired in Release 1 (no ?shell=legacy): rewrite against /suites or delete with the old screen.";

export async function legacyShell(page: Page, href: string): Promise<string> {
  void page;
  test.skip(true, OLD_SHELL_RETIRED);
  return href;
}

/** For a spec that reached an old surface by clicking: skipped for the same reason. */
export async function askForLegacyShell(page: Page): Promise<void> {
  void page;
  test.skip(true, OLD_SHELL_RETIRED);
}
