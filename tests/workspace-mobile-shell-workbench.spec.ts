import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * /workspace on a phone (wave M-A): the phone shell, its two screens, the
 * sheet chrome and the drill-down. The rules under test are the ones 05-mobile
 * calls non-negotiable — nothing below 12px, no target under 44×44, the last
 * row of every scroller clears the pinned block — plus the drill-down itself
 * and the promise that the desktop shell above 768px is untouched.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = "/private/tmp/mobile-shell-shots";

/* Test fixtures only — the app reads these from the real projects route. */
const primary = { ...newProject("Coastal light study"), id: "ws-phone-a", description: "Product film · Spot 02", aspect: "16:9", fps: 24 };
const list = [
  { id: primary.id, name: primary.name, revision: 3, updatedAt: "2026-09-18T10:00:00Z" },
  { id: "ws-phone-b", name: "Harbour", revision: 1, updatedAt: "2026-09-12T10:00:00Z" },
  { id: "ws-phone-c", name: "Night market", revision: 5, updatedAt: "2026-09-02T10:00:00Z" },
];

async function signedInWithProjects(page: Page) {
  await signInLocally(page.request);
  await page.route("**/api/workbench/projects**", (route) => {
    const id = new URL(route.request().url()).searchParams.get("id");
    const project = id === primary.id || !id ? primary : { ...newProject(list.find((p) => p.id === id)?.name ?? "Project"), id: id ?? "x" };
    return route.fulfill({ json: { projects: list, productions: [], project, revision: 1, shared: null } });
  });
}

/** Every text node on screen, with its computed size — the 12px floor. */
async function smallText(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || !el.getClientRects().length) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size}px: “${text.slice(0, 40)}” (${el.className || el.tagName})`);
    }
    return out;
  });
}

/** Header controls, and any other button the phone shell pins. */
async function smallTargets(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      if (rect.width < 44 || rect.height < 44) out.push(`${el.dataset.testid ?? el.className}: ${Math.round(rect.width)}×${Math.round(rect.height)}`);
    }
    return out;
  }, selector);
}

/** At max scroll, the last row is fully visible above whatever is pinned below. */
async function lastRowClearsPinned(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="mobile-scroll"]')!;
    scroller.scrollTop = scroller.scrollHeight;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>("button, p, a")).filter((el) => el.getClientRects().length);
    const last = rows[rows.length - 1];
    const problems: string[] = [];
    const box = scroller.getBoundingClientRect();
    const pinned = ['[data-testid="mobile-actions"]', '[data-testid="mobile-dock"]']
      .map((sel) => document.querySelector<HTMLElement>(sel))
      .filter((el): el is HTMLElement => Boolean(el));
    if (last && last.getBoundingClientRect().bottom > box.bottom + 1)
      problems.push(`last row ends at ${last.getBoundingClientRect().bottom}, scroller ends at ${box.bottom}`);
    for (const block of pinned) {
      const rect = block.getBoundingClientRect();
      if (box.bottom > rect.top + 1) problems.push(`scroller (${box.bottom}) runs under ${block.dataset.testid} (${rect.top})`);
    }
    return problems;
  });
}

test("the phone shell: screens, dock, sheet, drill-down and the floors", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signedInWithProjects(page);
  const shot = info.project.name === "workbench-390x844";

  /* 1 — /workspace renders the phone shell, not the desktop one, and stays. */
  await page.goto("/workspace?project=" + primary.id + "&suite=particl");
  await expect(page.getByTestId("phone-shell")).toBeVisible();
  await expect(page.getByTestId("studio-row")).toHaveCount(0);
  await expect(page).toHaveURL(/\/workspace\?/);
  await expect(page.locator('[data-screen="projects"]')).toBeVisible();
  await expect(page.getByTestId("mobile-dock")).toBeVisible();
  /* The shell caps at 440px and centres. */
  const shellWidth = (await page.getByTestId("phone-shell").boundingBox())!.width;
  expect(shellWidth).toBeLessThanOrEqual(440);

  /* 2 — the floors: 44×44 targets and no text under 12px. */
  expect(await smallTargets(page, '[data-testid="mobile-header"] button')).toEqual([]);
  expect(await smallText(page)).toEqual([]);
  if (shot) await page.screenshot({ path: `${SHOTS}/projects-390x844.png`, animations: "disabled" });

  /* 3 — the derived project line, from the same states the Stages screen reads. */
  await expect(page.getByTestId("mobile-project-progress")).toHaveText(/^0 of 8 stages$/);

  /* 4 — drill down: a project card opens the Suite screen. */
  await page.locator(`[data-project="${primary.id}"]`).click();
  await expect(page.locator('[data-screen="suite"]')).toBeVisible();
  await expect(page.getByTestId("mobile-stage-count")).toHaveText(/of 8 stages complete/);
  await expect(page.getByTestId("mobile-atomik-card")).toBeVisible();
  await expect(page.locator('[data-screen="suite"] .pxm-stage-row')).toHaveCount(8);
  expect(await smallText(page)).toEqual([]);
  if (shot) await page.screenshot({ path: `${SHOTS}/suite-390x844.png`, animations: "disabled" });
  expect(await lastRowClearsPinned(page)).toEqual([]);

  /* 5 — drill down again: a stage row opens its page, through go(). */
  await page.locator('[data-screen="suite"] [data-page="rig"]').click();
  await expect(page.getByTestId("mobile-page-title")).toHaveText("Rig");
  await expect(page).toHaveURL(/page=rig/);
  await expect(page.getByTestId("mobile-actions")).toBeVisible();
  expect(await lastRowClearsPinned(page)).toEqual([]);

  /* 6 — back steps up one level, twice. */
  await page.getByTestId("mobile-back").click();
  await expect(page.locator('[data-screen="suite"]')).toBeVisible();
  await page.getByTestId("mobile-back").click();
  await expect(page.locator('[data-screen="projects"]')).toBeVisible();

  /* 7 — the dock switches screens, and reads active. */
  await page.locator('[data-tab="stages"]').click();
  await expect(page.locator('[data-screen="suite"]')).toBeVisible();
  await page.locator('[data-tab="make"]').click();
  await expect(page.locator('[data-screen="make"]')).toBeVisible();
  await expect(page.locator('[data-tab="make"]')).toHaveAttribute("aria-current", "true");
  await page.locator('[data-tab="projects"]').click();
  await expect(page.locator('[data-screen="projects"]')).toBeVisible();

  /* 8 — the Search sheet: opens from the header, closes on a scrim tap. */
  await page.getByTestId("mobile-search").click();
  await expect(page.getByTestId("mobile-sheet")).toBeVisible();
  expect(await page.getByTestId("mobile-search-row").count()).toBeGreaterThan(0);
  const sheet = await page.locator(".pxm-sheet").boundingBox();
  const viewport = page.viewportSize()!;
  expect(sheet!.height).toBeLessThanOrEqual(viewport.height * 0.88 + 1);
  expect(await smallText(page)).toEqual([]);
  if (shot) await page.screenshot({ path: `${SHOTS}/search-sheet-390x844.png`, animations: "disabled" });
  /* Tap the part of the scrim the sheet does not cover — what a thumb reaches. */
  await page.getByTestId("mobile-sheet-scrim").click({ position: { x: 24, y: 12 } });
  await expect(page.getByTestId("mobile-sheet")).toHaveCount(0);

  /* 9 — a sheet tab reads active while its sheet is up; the dock sits behind
     the scrim, so the sheet closes by its 34px close (or the scrim), not by a
     second tap on a tab nobody can reach. */
  await page.locator('[data-tab="library"]').click();
  await expect(page.getByTestId("mobile-sheet")).toBeVisible();
  await expect(page.locator('[data-tab="library"]')).toHaveAttribute("aria-current", "true");
  const dockCovered = await page.evaluate(() => {
    const tab = document.querySelector<HTMLElement>('[data-tab="library"]')!.getBoundingClientRect();
    const hit = document.elementFromPoint(tab.left + tab.width / 2, tab.top + tab.height / 2);
    return hit?.closest('[data-testid="mobile-sheet"]') !== null;
  });
  expect(dockCovered).toBe(true);
  await page.locator(".pxm-sheet-close").click();
  await expect(page.getByTestId("mobile-sheet")).toHaveCount(0);

  /* 10 — a search row navigates through go(), landing on the Page level. */
  await page.getByTestId("mobile-search").click();
  await page.locator('.pxm-field').fill("Boards");
  await page.getByTestId("mobile-search-row").first().click();
  await expect(page.getByTestId("mobile-page-title")).toHaveText("Boards");
  await expect(page.getByTestId("mobile-sheet")).toHaveCount(0);

  /* 11 — the avatar opens Settings, a sibling of the drill-down. */
  await page.getByTestId("mobile-avatar").click();
  await expect(page.locator('[data-screen="settings"]')).toBeVisible();

  /* 12 — deep links: a page URL lands on that page, `level=suite` on the list. */
  await page.goto("/workspace?project=" + primary.id + "&suite=subatomik&page=motion");
  await expect(page.getByTestId("mobile-page-title")).toHaveText("Motion Transfer");
  await page.goto("/workspace?project=" + primary.id + "&suite=particl&level=suite");
  await expect(page.locator('[data-screen="suite"]')).toBeVisible();
  await expect(page.getByTestId("mobile-stage-count")).toBeVisible();
  /* An alias still resolves, and still lands on the page it became. */
  await page.goto("/workspace?project=" + primary.id + "&page=canvas");
  await expect(page.getByTestId("mobile-page-title")).toHaveText("Rig");

  /* 13 — no horizontal overflow at any phone width. */
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("the desktop shell above the breakpoint is unchanged", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signedInWithProjects(page);
  await page.goto("/workspace?project=" + primary.id + "&suite=particl&page=brief");
  await expect(page.getByTestId("studio-row")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  await expect(page.getByTestId("project-title")).toHaveText(primary.name);
  /* Nothing of the phone shell exists here. */
  await expect(page.getByTestId("phone-shell")).toHaveCount(0);
  await expect(page.getByTestId("mobile-dock")).toHaveCount(0);
  /* The desktop rows and the stage tabs are still the desktop's. */
  await expect(page.locator('[data-row="stages"]')).toBeVisible();
  await expect(page.locator('[data-row="project"]')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
