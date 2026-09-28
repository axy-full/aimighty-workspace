import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { newProject } from "../lib/workbench/studio";
import type { TakeFailure } from "../lib/providerOutcome";

/**
 * A failed take on the shared card (TakeTile) says what happened and — only
 * when Particl's own receipt confirms it — what it came to: "Not billed",
 * "12 cr charged", "12 cr held". A take nobody confirmed carries no charge
 * line and never reads as free. The charge line wraps whole on every grid
 * (Gen › Results, Library › Assets, Studio › Takes) at every size, and the
 * last one clears the phone's tab bar. Every reply is route-mocked; nothing
 * is paid.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const BASE = 1_790_000_000_000;

const moderated: TakeFailure = { provider: "xai", stage: "run", code: "content_moderated", kind: "content_filter", message: null, billing: null, payer: "platform" };
const receipt = (credits: number, settled: boolean): TakeFailure => ({ ...moderated, charge: { credits, settled } });
/* Newest first on every grid, so "Released take" is the last card. */
const CASES: { title: string; failure: TakeFailure; charge: string | null; cancelled?: true }[] = [
  { title: "Unconfirmed take", failure: moderated, charge: null },
  { title: "Charged take", failure: receipt(12, true), charge: "12 cr charged" },
  { title: "Reserved take", failure: receipt(12, false), charge: "12 cr held" },
  { title: "Discarded take", failure: { provider: null, stage: null, code: "unknown", kind: "unknown", message: null, billing: null, payer: null, charge: { credits: 0, settled: true } }, charge: "Not billed", cancelled: true },
  { title: "Released take", failure: receipt(0, true), charge: "Not billed" },
];

async function open(page: Page, url: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject("Outcome review"), id: "billing-outcome", productionProjectId: "prod-ws", shotMappings: {}, aspect: "16:9" } });
  await mockLibrary(page, {
    uploads: [],
    generations: CASES.map((item, i) => generation({
      id: `gen_outcome_${i}`, title: item.title, kind: "video", status: item.cancelled ? "cancelled" : "failed", storedUrl: null, creditsBilled: null,
      /* What the route sends a credit workspace: the typed words, never the provider's own. */
      error: item.cancelled ? "Discarded before it started. Nothing was charged." : "Refused by the content filter",
      params: item.cancelled ? { held: { why: "credits", needs: 9 }, discardedAt: 1 } : {},
      failure: item.failure, createdAt: BASE - i * 60_000, updatedAt: BASE - i * 60_000,
    })),
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId("project-name")).toHaveText("Outcome review");
  return errors;
}

const tile = (scope: Locator, name: string) => scope.getByTestId("take-tile").filter({ hasText: name });

/** Every card says its status and why; a charge only where a receipt confirms it, whole, never "free" otherwise. */
async function expectCards(scope: Locator) {
  for (const item of CASES) {
    const card = tile(scope, item.title);
    await expect(card.getByTestId("take-chip")).toHaveText(item.cancelled ? "Cancelled" : "Failed");
    await expect(card.getByTestId("take-reason")).toHaveText(item.cancelled ? "Discarded before it started." : "Refused by the content filter");
    if (item.charge) await expect(card.getByTestId("take-charge")).toHaveText(item.charge);
    else await expect(card.getByTestId("take-charge")).toHaveCount(0);
  }
  await expect(tile(scope, "Unconfirmed take")).not.toContainText(/not billed|not charged|refunded|free/i);
  /* A charge is never cut: no ellipsis, nothing past its box. */
  const cut = await scope.getByTestId("take-charge").evaluateAll((els) => els.filter((el) => {
    const style = getComputedStyle(el);
    return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 || (style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap");
  }).map((el) => el.textContent));
  expect(cut, "charge lines cut").toEqual([]);
}

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

test("Gen › Results: a failed take's charge is said only from a receipt, whole, and clears the tab bar", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?view=gen");
  const results = page.getByRole("region", { name: "Results" });
  await expect(results.getByTestId("take-tile")).toHaveCount(CASES.length);
  await expectCards(results);
  /* The screen reader hears the take and its status, not a claim about its charge. */
  await expect(results.getByRole("button", { name: "Unconfirmed take · Failed", exact: true })).toBeVisible();

  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, ".gx-gen-results"), "targets under 44×44").toEqual([]);
    /* At the bottom of the page the last card's charge sits above the tab bar. */
    const last = tile(results, "Released take").getByTestId("take-charge");
    const bar = page.getByTestId("tabbar");
    await expect.poll(async () => {
      await page.getByTestId("gen-view").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const end = await last.boundingBox();
      const top = (await bar.isVisible()) ? (await bar.boundingBox())?.y ?? null : null;
      return Boolean(end && end.height > 0 && (top == null || end.y + end.height <= top + 1));
    }, { message: "the last charge line clears the tab bar" }).toBe(true);
  }
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("gen-failed-takes.png") });

  /* The Inspector: the card's status and reason, then the next step; the charge stays the receipt's, never a vendor's dollars. */
  await tile(results, "Charged take").locator(".gx-asset-thumb").click();
  const facts = page.getByTestId("asset-facts");
  await expect(facts).toContainText("Failed");
  await expect(facts).toContainText("Refused by the content filter");
  await expect(facts).toContainText("Change the prompt or reference");
  await expect(facts).not.toContainText("$");
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("Library › Assets and Studio › Takes carry the same charge line, whole", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=studio&page=takes");
  const takes = page.getByTestId("edit-takes");
  await expect(takes.getByTestId("take-tile")).toHaveCount(CASES.length);
  await expectCards(takes);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("studio-failed-takes.png") });

  if (!WIDE.includes(info.project.name)) await page.getByTestId("toggle-library").click();
  const library = page.getByTestId("library");
  await library.getByRole("tab", { name: /Assets/ }).click();
  const assets = page.getByTestId("library-assets");
  await expect(assets.getByTestId("take-tile")).toHaveCount(CASES.length);
  await expectCards(assets);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("library-failed-takes.png") });
  expect(errors).toEqual([]);
});
