import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { DESKTOP, PHONE, forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";
import { projectName } from "./helpers/projectName";
import { isCompact } from "./helpers/shellMode";

/**
 * Studio's first run (idea 10). With no project open, a Studio stage used to
 * show one sentence and no button; New project hid in the switcher's ▾, the
 * starter production was never offered, and a desktop's mark opened Brief.
 *
 * Now an empty stage shows a card: New project (the switcher's own create),
 * Explore the starter production (seeded on first use as sample takes on the
 * platform's previews: nothing is generated or charged, and a second press
 * opens the same one), the four stages in order, and the recent projects. On
 * a desktop the mark opens the Studio home: the next step, what is running,
 * the other projects. Phones hold the floors: nothing wider than the screen,
 * 44px targets, labels no dimmer than #7C7C84, and the last row above the tab
 * bar.
 *
 * The workspace is a fresh local one per test (no projects). Paid routes fail
 * the test; the only engine is the mocked one, and nothing here reaches it.
 */
const SIZES = [...PHONE, ...DESKTOP];
/* Release 1: Studio's overview and its stage pages are gone. With no project, the board's address shows this same first-run card (screens.tsx ›
   `board-no-project`: New project, Explore the starter production); Home carries its own (demo-s02-home-workbench) and the phone's Home starts a
   project too (r1-phone-start-workbench). So these tests open the board of an empty workspace, on a desktop; the phone app draws Home and the
   Record, not this card. Studio's overview, its "Up next" and its recent-projects list were deleted with the page, and with them the tests that
   only read them. What stays is what the card owes: one project from one press, a starter that costs nothing, and a failure said in words. */
test.beforeEach(async ({ page: _page }, info) => { test.skip(isCompact(info), "the phone app has no first-run card: its Home starts a project (r1-phone-start-workbench) and its Record is the board's address (demo-s10-phone-record)"); });

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return errors;
}

/* Entrance animations scale and fade a card in; measure once they have finished. */
async function settled(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => undefined))));
}

/**
 * Every visible text in `scope` is no dimmer than #7C7C84: its WCAG relative luminance, composited over black,
 * is at least #7C7C84's (a saturated red can read brighter than a grey of the same sRGB weight, so the
 * channels are linearised first). Gradient-clipped titles paint their own light and are left out.
 */
async function dimText(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const linear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const luminance = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const floor = luminance(0x7c, 0x7c, 0x84) - 0.001;
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!text || !el || !el.getClientRects().length) continue;
      const style = getComputedStyle(el);
      if (style.backgroundClip === "text" || style.webkitBackgroundClip === "text") continue;
      const [r, g, b, a = 1] = (style.color.match(/[\d.]+/g) ?? []).map(Number);
      if (luminance(r * a, g * a, b * a) < floor) out.push(`“${text.slice(0, 32)}” ${style.color}`);
    }
    return out;
  });
}

/** On a phone the tab bar floats over the stage: at the stage's furthest scroll, `last` ends above it. */
async function clearsTabBar(page: Page, last: Locator) {
  const bar = page.getByTestId("tabbar");
  if (!(await bar.isVisible())) return;
  await page.getByTestId("content").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(async () => {
    const [box, barBox] = [await last.boundingBox(), await bar.boundingBox()];
    return Math.round((barBox!.y - (box!.y + box!.height)) * 100) / 100;
  }, { message: "the last row ends above the tab bar" }).toBeGreaterThanOrEqual(0);
}

/** The floors, measured on `scope`: no page scroll sideways; on phones 44px targets and 12px text; labels no dimmer than #7C7C84. */
async function floors(page: Page, scope: Locator, info: TestInfo) {
  await settled(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal page scroll").toBe(true);
  const box = (await scope.boundingBox())!;
  expect(box.x, "the card starts on screen").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "the card ends on screen").toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 0.5);
  expect(await dimText(scope), "labels no dimmer than #7C7C84").toEqual([]);
  if (PHONE.includes(info.project.name)) {
    const selector = await scope.evaluate((el) => `[data-testid="${(el as HTMLElement).dataset.testid}"]`);
    expect(await smallTargets(page, selector), "targets under 44×44").toEqual([]);
    expect(await smallText(page), "text under 12px").toEqual([]);
  }
}


test("New project on the card is the switcher's own create: a double press makes one project, and it opens", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?view=board");
  const creates: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/api/workbench/projects") && (request.postDataJSON() as { revision?: number } | null)?.revision === 0) creates.push(request.url());
  });
  await page.getByTestId("first-run-new").click({ timeout: 60_000 });
  const form = page.getByTestId("first-run-new-form");
  await expect(form).toBeVisible();
  await expect(page.getByTestId("first-run-new-name")).toBeFocused();
  /* Cancel puts the button back; nothing was made. */
  await page.getByTestId("first-run-new-cancel").click();
  await expect(page.getByTestId("first-run-new")).toHaveText("New project");
  await page.getByTestId("first-run-new").click();
  /* The field stops at the longest name a project saves with (100; it allowed 120 and a longer name was refused after Create). */
  await page.getByTestId("first-run-new-name").fill("x".repeat(130));
  await expect(page.getByTestId("first-run-new-name")).toHaveValue("x".repeat(100));
  const name = `Harbour ${Date.now().toString(36)} — the long lens series, shot at dusk on the frozen water with the crew`.slice(0, 100);
  await page.getByTestId("first-run-new-name").fill(name);
  await page.getByTestId("first-run-new-create").dblclick();
  /* The toast shows for 2.6 s from the create; the project loads after it, seconds later on a busy server. */
  await expect(page.getByTestId("toast")).toContainText(`${name} is open`, { timeout: 30_000 });
  await expect(projectName(page)).toHaveText(name, { timeout: 30_000 });
  await expect(page.getByTestId("first-run")).toHaveCount(0);
  /* The project opens on its board. */
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  expect(creates, "one press of Create, one project").toHaveLength(1);
  /* The header's project segment keeps the long name inside itself. */
  const segment = (await page.locator('[data-suite-tab="project"]').boundingBox())!;
  const label = (await page.locator('[data-suite-tab="project"] .gx-seg-label').boundingBox())!;
  expect(label.x + label.width, "the name stays inside the segment").toBeLessThanOrEqual(segment.x + segment.width + 0.5);
  expect(errors).toEqual([]);
});

test("Explore the starter production opens it with its sample takes, charges nothing, and a second press opens the same one", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?view=board");
  const starter = page.getByTestId("first-run-starter");
  await expect(starter).toBeVisible({ timeout: 60_000 });
  const credits = (await page.getByTestId("workspace-credits").textContent())!;
  const presses: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/workbench/projects") && (request.postDataJSON() as { action?: string } | null)?.action === "starter") presses.push(request.url());
  });
  /* A double press sends one request: the button holds until the starter replaces the card. */
  await starter.dblclick();
  /* As above: read the 2.6 s toast before waiting for the production to load. */
  await expect(page.getByTestId("toast")).toContainText("Its takes are samples: nothing was generated or charged.", { timeout: 60_000 });
  await expect(projectName(page)).toHaveText("Starter production", { timeout: 60_000 });
  expect(presses).toHaveLength(1);
  await expect(page.getByTestId("first-run")).toHaveCount(0);
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });

  /* The server's side: a lost reply retried opens the same draft and seeds nothing; one starter in the workspace; no take cost anything. */
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string } };
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const retried = await page.request.post("/api/workbench/projects", { headers, data: { action: "starter" } });
  expect(retried.ok(), await retried.text()).toBe(true);
  const again = await retried.json() as { project: { id: string; name: string; productionProjectId: string }; created: boolean; seeded: boolean };
  expect(again).toMatchObject({ created: false, seeded: false, project: { name: "Starter production" } });
  const list = await page.request.get("/api/workbench/projects", { headers }).then((r) => r.json()) as { projects: { id: string }[] };
  expect(list.projects.map((p) => p.id)).toEqual([again.project.id]);
  const productions = await page.request.get("/api/projects").then((r) => r.json()) as { projects: { starter: boolean }[] };
  expect(productions.projects.filter((p) => p.starter)).toHaveLength(1);
  const takes = await page.request.get(`/api/workbench/library?projectId=${encodeURIComponent(again.project.id)}&source=generations&limit=60`, { headers }).then((r) => r.json()) as { generations: { id: string; status: string; costUsd: number | null; creditsBilled: number | null; params: { demo?: boolean } }[] };
  expect(takes.generations).toHaveLength(7);
  for (const take of takes.generations) {
    expect(take).toMatchObject({ status: "succeeded", params: { demo: true } });
    /* In whichever unit the workspace pays: nothing. */
    expect((take.creditsBilled ?? 0) + (take.costUsd ?? 0), "a sample take billed nothing").toBe(0);
  }
  /* A sample take's picture is the platform's own, on this origin — never a missing original. */
  const media = await page.request.get(`/api/media/${takes.generations[0].id}?stream=1`, { maxRedirects: 0 });
  expect(media.status()).toBe(302);
  expect(media.headers().location).toMatch(/^\/(fixtures\/clip\.mp4|api\/platform\/previews\/[^?]+\?stream=1)$/);
  const played = await page.request.get(`/api/media/${takes.generations[0].id}`);
  expect(played.status()).toBe(200);
  expect(played.headers()["content-type"]).toContain("video/mp4");
  await expect(page.getByTestId("workspace-credits"), "no credit moved").toHaveText(credits);

  expect(errors).toEqual([]);
});

test("a starter that could not be opened says so under the button, in view above the tab bar, and the button comes back", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?view=board");
  await expect(page.getByTestId("first-run-starter")).toBeVisible({ timeout: 60_000 });
  let presses = 0;
  await page.route("**/api/workbench/projects", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    presses++;
    return route.fulfill({ status: 500, json: { error: "The starter production could not be opened. Try again." } });
  });
  await page.getByTestId("first-run-starter").click();
  const problem = page.getByTestId("first-run-problem");
  await expect(problem).toHaveText("The starter production could not be opened. Try again.");
  await expect(page.getByTestId("first-run-starter")).toHaveText("Explore the starter production");
  await expect(page.getByTestId("first-run-starter")).not.toHaveAttribute("aria-disabled", "true");
  /* In view. */
  await expect.poll(async () => {
    const box = (await problem.boundingBox())!;
    return box.y >= 0 && box.y + box.height <= page.viewportSize()!.height + 0.5;
  }, { message: "the reason is on screen" }).toBe(true);
  expect(await dimText(page.getByTestId("first-run")), "labels no dimmer than #7C7C84").toEqual([]);
  /* Try again is the same button: one more press, one more request. */
  await page.getByTestId("first-run-starter").click();
  await expect.poll(() => presses).toBe(2);
  await expect(problem).toBeVisible();
  expect(errors).toEqual([]);
});

