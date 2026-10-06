import type { Page, TestInfo } from "@playwright/test";
import { COMPACT_QUERY } from "../../lib/shell/use-compact";

/**
 * Which screens a viewport gets. Below the compact line the shell (components/graphite/SuitesShell.tsx) mounts the phone's own
 * app (components/graphite/phone/PhoneApp.tsx) instead of the header, strip and body; the phone draws only Home, the project's
 * Record, plan approval, review, Make and Atomik's sheet. A spec written for a screen the phone does not draw skips at COMPACT
 * widths and says which spec covers the phone; a spec for a screen the phone does draw retargets to the phone's test ids.
 *
 * The shell's own rule is COMPACT_QUERY (lib/shell/use-compact.ts): narrower than 768 px, OR a coarse-pointer screen at most 500 px
 * tall. So 844x390 is a PHONE even though it is wider than 768. The workbench projects give every viewport narrower than 900 px
 * touch and a mobile device (playwright.workbench.config.ts), so the three small projects are exactly the compact ones.
 */
export const COMPACT = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
export const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];

/** True when the project's viewport gets the phone app. Use it for `test.skip(isCompact(info), "<what the phone does instead, and the spec that covers it>")`. */
export function isCompact(info: Pick<TestInfo, "project">): boolean {
  return COMPACT.includes(info.project.name);
}

/** The rule itself, for a viewport and pointer: the same two clauses as COMPACT_QUERY. */
export function viewportIsPhone(width: number, height: number, coarsePointer: boolean): boolean {
  return width < 768 || (width >= 768 && height <= 500 && coarsePointer);
}

/** Asks the page: does the shell's own media query match here, so is it the phone app that is mounted? */
export async function shellIsPhone(page: Page): Promise<boolean> {
  return page.evaluate((query) => window.matchMedia(query).matches, COMPACT_QUERY);
}
