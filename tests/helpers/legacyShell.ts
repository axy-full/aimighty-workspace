import type { Page } from "@playwright/test";
import { LEGACY_SHELL, SHELL_COOKIE } from "../../lib/workspace/switchover";

/**
 * The redesigned workspace is the default surface on desktop now
 * (docs/workspace-switchover.md), so a spec that asserts the OLD shell asks
 * for it. This sets the `particl_shell=legacy` cookie the switch-over reads
 * and returns the URL unchanged, so these specs keep navigating to exactly
 * the URLs they always did and every assertion — including exact `toHaveURL`
 * ones, and links clicked inside the old shell — stays as written.
 *
 * Idempotent: calling it again overwrites the same cookie.
 *
 * When the old shell is retired, this helper and its call sites go with it.
 */
export async function legacyShell(page: Page, href: string): Promise<string> {
  await askForLegacyShell(page);
  return href;
}

/** The cookie on its own, for a spec that reaches an old surface by clicking. */
export async function askForLegacyShell(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: SHELL_COOKIE,
      value: LEGACY_SHELL,
      url: process.env.PW_BASE_URL || "http://localhost:4551",
    },
  ]);
}
