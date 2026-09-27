import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, generation, mockLibrary, mockProjects } from "./helpers/workspaceFixtures";
import { newProject } from "../lib/workbench/studio";
import type { TakeFailure } from "../lib/providerOutcome";

const base: TakeFailure = { provider: "xai", stage: "run", code: "content_moderated", kind: "content_filter", message: null, billing: null, payer: "platform" };

test("failed takes report recorded credit outcomes without claiming unknown attempts were free", async ({ page }, info) => {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockProjects(page, { current: { ...newProject("Outcome review"), id: "billing-outcome", productionProjectId: "prod-ws", shotMappings: {} } });
  const cases = [
    { title: "Released take", failure: { ...base, charge: { credits: 0, settled: true } }, expected: "Not billed" },
    { title: "Charged take", failure: { ...base, charge: { credits: 12, settled: true } }, expected: "12 cr charged" },
    { title: "Reserved take", failure: { ...base, charge: { credits: 12, settled: false } }, expected: "12 cr held" },
    { title: "Unconfirmed take", failure: { ...base }, expected: "Blocked by the content filter · Change the prompt or reference" },
  ];
  await mockLibrary(page, { uploads: [], generations: cases.map((item, i) => generation({ id: `gen_outcome_${i}`, title: item.title, status: "failed", storedUrl: null, failure: item.failure, creditsBilled: null })) });
  await page.goto("/suites?view=gen");
  const view = page.getByTestId("gen-view");
  await expect(view).toBeVisible();
  await view.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  for (const item of cases) {
    const card = view.locator(".gx-asset").filter({ hasText: item.title });
    await expect(card.getByTestId("take-failure")).toContainText(item.expected);
  }
  await expect(view.locator(".gx-asset").filter({ hasText: "Unconfirmed take" })).not.toContainText(/not billed|not charged|refunded/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const failures = view.getByTestId("take-failure");
  expect(await failures.evaluateAll((elements) => elements.every((el) => el.scrollWidth <= el.clientWidth + 1))).toBe(true);
  if (info.project.name.includes("360x640") || info.project.name.includes("390x844")) {
    const last = failures.last();
    await view.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => {
      const end = await last.boundingBox();
      const bar = await page.locator(".gx-tabbar").boundingBox();
      return Boolean(end && (!bar || end.y + end.height <= bar.y + 1));
    }).toBe(true);
    expect(await view.locator(".gx-asset-thumb").evaluateAll((els) => els.every((el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) >= 44 && Math.round(r.height) >= 44; }))).toBe(true);
  }
  await page.screenshot({ path: info.outputPath("failed-takes.png") });
});
