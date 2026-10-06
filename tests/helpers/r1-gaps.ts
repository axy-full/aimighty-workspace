import { expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { OLD_WORDS } from "./uiStrings";
import { localPlatformDbUrl, signInLocally } from "./workbenchLocal";
import { smallTargets, smallText } from "../phoneFloors";

/**
 * Release 1, the three screens that were not built (control room tabs, phone fix and states, Make's Upscale):
 * what every one of their browser specs checks the same way. A fresh local account, a warm-up visit, then the floors.
 */

export const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
/** The shell treats 844x390 as a phone (lib/shell/use-compact.ts). */
export const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
export const SHOTS = process.env.R1_GAP_SHOTS || "/private/tmp/claude-r1-gap-shots";

/** Sign in a fresh local workspace with credits to spend, and visit Home once so the shell is warm. */
export async function signedInWarm(page: Page, name = "Gap Tester") {
  const workspaceId = (await signInLocally(page.request, name)).workspace.id;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 2000, "Gap spec", "manual", "test", 0] }); } finally { db.close(); }
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("screen").or(page.getByTestId("phone-app")).first()).toBeVisible();
  return workspaceId;
}

/** Console and page errors a screen raised, collected from the first call on. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon|ERR_|net::/.test(m.text())) errors.push(m.text()); });
  return errors;
}

const WORDS = new RegExp(`\\b(${OLD_WORDS.filter((w) => w !== "Astra").join("|")})(?:s|'s|’s)?\\b`);

/** None of the retired names in what a person can read; "Astra" only as Topaz's model name ("Topaz Astra 2"). */
export async function noBannedNames(page: Page, scope = "body") {
  const text = await page.locator(scope).first().innerText();
  const found = WORDS.exec(text);
  expect(found?.[0] ?? null, "a retired name is on screen").toBeNull();
  for (const m of text.matchAll(/\bAstra\b/g)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 8), m.index);
    expect(before, "Astra stands alone").toMatch(/Topaz $/);
  }
}

/** Every control that spends shows a price or is disabled until it has one; nothing says "Retry" or "quoted" about a price. */
export async function everySpendButtonPriced(page: Page, scope = "body") {
  const bad = await page.evaluate((scope) => {
    const out: string[] = [];
    const figure = /(?:^|[\s·(,])(?:up to |about )?<?\d[\d,]*(?:\.\d+)?\s*cr\b|\bfree\b/i;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`${scope} [data-spend]`))) {
      if (!el.getClientRects().length) continue;
      const text = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`;
      const unpriced = el.getAttribute("data-spend") === "unpriced";
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true";
      if (unpriced && !disabled) out.push(`unpriced but enabled: ${text.trim().slice(0, 40)}`);
      else if (!unpriced && !figure.test(text) && !el.hasAttribute("aria-busy")) out.push(`no figure: ${text.trim().slice(0, 40)}`);
    }
    return out;
  }, scope);
  expect(bad, "spending controls without a price").toEqual([]);
}

/** No sideways scroll, nothing read under 12 px, and 44 px targets on a phone. */
export async function floors(page: Page, scope: string, phone: boolean) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow").toBeLessThanOrEqual(0);
  expect(await smallText(page), "text under 12 px").toEqual([]);
  if (phone) expect(await smallTargets(page, scope), "targets under 44×44").toEqual([]);
}

export async function shoot(page: Page, project: string, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/gap-${name}-${project.replace("workbench-", "")}.png`, animations: "disabled" });
}
