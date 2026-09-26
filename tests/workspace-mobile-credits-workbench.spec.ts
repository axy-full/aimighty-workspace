import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * The phone header carries the credit balance — on Projects, on the Suite list
 * and on a Page, at every phone width (05-mobile, "Header": "Right: credits in
 * mono, search, then the ZF avatar").
 *
 * The balance was missing in production, and not because a test mock omitted
 * it: the slot was conditional on `account.credits`, so a workspace whose
 * credit state reads null — a billing read behind `.catch(() => null)`, or a
 * workspace billed in dollars — rendered no slot at all. It is now always
 * mounted, with the figure when there is one and a neutral placeholder when
 * there is not (lib/workspace/format.ts creditsLabel).
 */

const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
/* 375×812 is the width the missing balance was reported at, and it is not one
   of the config's five projects; it is checked here inside the phone runs. */
const WIDTHS: [number, number][] = [[360, 640], [375, 812], [390, 844], [844, 390]];
const FIGURE = /\d[\d,]*\s*cr/i;

const primary = { ...newProject("Coastal light study"), id: "ws-credits-a", aspect: "16:9", fps: 24 };
const list = [{ id: primary.id, name: primary.name, revision: 2, updatedAt: "2026-09-18T10:00:00Z" }];

async function signedInWithProjects(page: Page) {
  await signInLocally(page.request);
  await page.route("**/api/workbench/projects**", (route) =>
    route.fulfill({ json: { projects: list, productions: [], project: primary, revision: 1, shared: null } }),
  );
}

/** The header's credits node: its text, its box and its computed type size. */
async function credits(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="mobile-credits"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      text: (el.innerText ?? "").trim(),
      width: rect.width,
      right: rect.right,
      fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
      family: getComputedStyle(el).fontFamily,
      header: document.querySelector<HTMLElement>('[data-testid="mobile-header"]')!.getBoundingClientRect(),
    };
  });
}

test("the phone header shows a credit figure on Projects, Suite and Page, at every phone width", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signedInWithProjects(page);

  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    await page.goto("/workspace?project=" + primary.id + "&suite=particl");
    await expect(page.getByTestId("phone-shell")).toBeVisible();

    /* Projects. */
    await expect(page.getByTestId("mobile-credits")).toBeVisible();
    let seen = (await credits(page))!;
    expect(seen.text, `${width}×${height} Projects`).toMatch(FIGURE);

    /* Suite. */
    await page.locator(`[data-project="${primary.id}"]`).click();
    await expect(page.locator('[data-screen="suite"]')).toBeVisible();
    expect((await credits(page))!.text, `${width}×${height} Suite`).toMatch(FIGURE);

    /* Page. */
    await page.locator('[data-screen="suite"] [data-page="rig"]').click();
    await expect(page.getByTestId("mobile-page-title")).toHaveText("Rig");
    seen = (await credits(page))!;
    expect(seen.text, `${width}×${height} Page`).toMatch(FIGURE);

    /* Mono, at or above the 12px floor, inside the header, and no wider than
       the room the header has — the balance is never the reason a target or a
       label breaks a floor. */
    expect(seen.fontSize, `${width}×${height} type size`).toBeGreaterThanOrEqual(12);
    expect(seen.family.toLowerCase()).toMatch(/mono/);
    expect(seen.right).toBeLessThanOrEqual(seen.header.right + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    /* Nothing the header pins shrinks below 44×44 to make room for it. */
    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="mobile-header"] button'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => (r.width || r.height) && (Math.round(r.width * 100) / 100 < 44 || Math.round(r.height * 100) / 100 < 44)).length);
    expect(small, `${width}×${height} header targets`).toBe(0);
  }
});

test("a refresh that brings no balance does not wipe the one on screen", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signedInWithProjects(page);
  /* /api/me reads its credit state behind a catch; a failed billing read
     answers `credits: null`. The header used to go blank on the next poll. */
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ json: { ...body, credits: null } });
  });
  await page.goto("/workspace?project=" + primary.id + "&suite=particl");
  await expect(page.getByTestId("mobile-credits")).toBeVisible();
  /* The server-rendered balance survives every refresh that has none. */
  await expect(page.getByTestId("mobile-credits")).toHaveText(FIGURE);
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("mobile-credits")).toHaveText(FIGURE);
});

test("a large balance is written in full, and still clears the header's floors", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signedInWithProjects(page);
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ json: { ...body, credits: { ...(body.credits ?? {}), balance: 1234567 } } });
  });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/workspace?project=" + primary.id + "&suite=particl");
  /* Grouped en-US, in full: a truncated balance is a wrong balance. */
  await expect(page.getByTestId("mobile-credits")).toHaveText("1,234,567 cr");
  const title = (await page.getByTestId("mobile-title").boundingBox())!;
  expect(title.width).toBeGreaterThanOrEqual(44);
  expect(Math.round(title.height * 100) / 100).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
