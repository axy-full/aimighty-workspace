import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { SPEC_PAGES } from "../lib/workspace/spec-cards";
import { pageDef, suiteOfPage } from "../lib/workspace/pages";
import type { PageId } from "../lib/workspace/types";

/**
 * Spec-card pages (workspace redesign, wave 2). Each page renders its card
 * groups, its working tool is reachable from the page, the page title never
 * truncates, and nothing clips at 1200, 1440 or 1920. Desktop assertions
 * skip on phones, which keep the existing phone surface.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.WS_SPEC_SHOTS || "";

/* Test fixtures only — the app reads these from the real projects route. */
const primary = {
  ...newProject("Coastal light study"),
  id: "ws-spec-a",
  description: "Product film · Spot 02",
  aspect: "16:9",
  fps: 24,
  brief: "A short film about a lighthouse keeper's last night on duty.",
  script: "INT. LIGHTHOUSE - NIGHT\n\nThe lamp turns.\n\nEXT. CLIFF - DAWN\n\nThe keeper walks down.",
};
const list = [{ id: primary.id, name: primary.name, revision: 3, updatedAt: "2026-09-18T10:00:00Z" }];

/** Where each page's working tool lands: the element that proves it mounted. */
const TOOLS: Partial<Record<PageId, { body: string; card?: string; then?: string }>> = {
  brief: { body: '[data-tool-body="brief"]', card: "Script", then: '[data-tool-body="script"]' },
  boards: { body: '[data-tool-body="boards"]', card: "Frames" },
  astra: { body: '[data-tool-body="astra"]', card: "Camera" },
  deliver: { body: '[data-tool-body="package"]', card: "Master", then: '[data-tool-body="movie"]' },
  marketing: { body: '[data-tool-body="product"]', card: "Hooks", then: '[data-tool-body="format"]' },
  motion: { body: '[data-tool-body="subatomik"]', card: "Source video" },
  swap: { body: '[data-tool-body="subatomik"]', card: "Target element" },
  sources: { body: '[data-tool-body="subatomik"]', card: "Uploads" },
  compare: { body: '[data-tool-body="subatomik"]', card: "Split and wipe" },
  history: { body: '[data-tool-body="subatomik"]', card: "Result history" },
};
const PAGES = Object.keys(TOOLS) as PageId[];

async function signedInWithProject(page: Page) {
  await signInLocally(page.request);
  await page.route("**/api/workbench/projects**", (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 409, json: { error: "Fixture projects are read-only." } });
    return route.fulfill({ json: { projects: list, productions: [], project: primary, revision: 1, shared: null } });
  });
}

const url = (id: PageId) => `/workspace?project=${primary.id}&suite=${suiteOfPage(id)}&page=${id}`;

/** Header rows keep every child inside them, titles never truncate, spec cards never clip. */
async function assertNoClipping(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const inspector = document.querySelector('[data-testid="inspector"]')?.getBoundingClientRect() ?? null;
    for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-row]"))) {
      const name = row.dataset.row!;
      const rowRect = row.getBoundingClientRect();
      for (const child of Array.from(row.children) as HTMLElement[]) {
        const rect = child.getBoundingClientRect();
        if (!rect.width) continue;
        const right = rect.right - rowRect.left + row.scrollLeft;
        if (right > row.scrollWidth + 0.5) out.push(`${name}: ${child.className || child.tagName} ends past its row`);
        if (inspector && ["project", "page", "crumbs"].includes(name) && rect.right > inspector.left + 0.5)
          out.push(`${name}: ${child.className || child.tagName} overlaps the Inspector`);
      }
    }
    for (const id of ["project-title", "page-title"]) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      if (el.scrollWidth > el.clientWidth + 0.5) out.push(`${id} truncated: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    const content = document.querySelector('[data-testid="content"]')!.getBoundingClientRect();
    for (const card of Array.from(document.querySelectorAll<HTMLElement>(".pxw-spec-card"))) {
      const rect = card.getBoundingClientRect();
      if (rect.right > content.right + 0.5) out.push(`card "${card.dataset.card}" runs past the content pane`);
      if (inspector && rect.right > inspector.left + 0.5) out.push(`card "${card.dataset.card}" runs under the Inspector`);
      if (card.scrollWidth > card.clientWidth + 0.5) out.push(`card "${card.dataset.card}" clips its content`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`document scrolls horizontally`);
    return out;
  });
  expect(problems).toEqual([]);
}

test("phones keep the existing phone surface on spec pages", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signedInWithProject(page);
  await page.goto(url("marketing"));
  await expect(page).toHaveURL(/\/workbench\?project=ws-spec-a$/);
  await expect(page.locator(".pxw")).toHaveCount(0);
});

test("spec pages: cards, working tool, title and layout", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signedInWithProject(page);
  const configured = page.viewportSize()!;
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  for (const id of PAGES) {
    const spec = SPEC_PAGES[id]!;
    const tool = TOOLS[id]!;
    await page.setViewportSize(configured);
    await page.goto(url(id));
    await expect(page.getByTestId("page-title")).toHaveText(pageDef(id).title);
    const body = page.getByTestId("spec-page");
    await expect(body.locator(".pxw-spec-intro")).toHaveText(spec.intro);
    /* Every group and every card, in order. */
    await expect(body.locator(".pxw-spec-group")).toHaveCount(spec.groups.length);
    const names = spec.groups.flatMap((g) => g.cards.map((c) => c.name));
    await expect(body.locator(".pxw-spec-card")).toHaveCount(names.length);
    expect(await body.locator(".pxw-spec-card-title").allTextContents()).toEqual(names);
    /* Every footer reads "Owner · state"; no icon tiles on these cards. */
    for (const footer of await body.locator(".pxw-spec-card-state").allTextContents()) expect(footer).toMatch(/^.+ · (complete|active|waiting on you|ready)$/);
    await expect(body.locator(".pxw-spec-card .pxw-tile")).toHaveCount(0);

    /* The existing working tool is mounted below the cards… */
    await expect(page.getByTestId("spec-work").locator(tool.body)).toBeVisible({ timeout: 30_000 });
    /* …and a card opens its tool. */
    if (tool.card) {
      await body.locator(`.pxw-spec-card[data-card="${tool.card}"]`).click();
      await expect(body.locator(`.pxw-spec-card[data-card="${tool.card}"]`)).toHaveAttribute("aria-current", "true");
      await expect(page.getByTestId("spec-work").locator(tool.then ?? tool.body)).toBeVisible({ timeout: 30_000 });
    }

    /* Inspector: five facts and the page's plan, disabled with its reason when it cannot run. */
    const inspector = page.getByTestId("spec-inspector");
    await expect(inspector.locator(".pxw-fact")).toHaveCount(5);
    const run = inspector.locator(".pxw-insp-run");
    await expect(run).toBeVisible();
    if (await run.isDisabled()) await expect(inspector.getByTestId("spec-plan-reason")).not.toBeEmpty();

    if (SHOTS && info.project.name === "workbench-1440x900" && (id === "brief" || id === "marketing")) {
      await page.getByTestId("content").evaluate((el) => el.scrollTo(0, 0));
      await page.screenshot({ path: `${SHOTS}/${id}-1440x900.png` });
    }

    if (SHOTS && info.project.name === "workbench-1440x900") {
      await page.getByTestId("spec-work").scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${SHOTS}/${id}-work-1440x900.png` });
    }

    for (const width of [1200, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByTestId("content").evaluate((el) => el.scrollTo(0, 0));
      await assertNoClipping(page);
    }
  }

  /* Home feature cards read the first sentence of each intro. */
  await page.setViewportSize(configured);
  await page.goto(`/workspace?project=${primary.id}&suite=moleculr`);
  await expect(page.locator('.pxw-feature[data-feature="marketing"] .pxw-feature-desc')).toHaveText(
    "One studio: a product, who presents it, what it says and where it runs.",
  );
  expect(errors).toEqual([]);
});
