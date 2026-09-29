import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { DESKTOP, PHONE, forbidPaidWork, generation, mockLibrary, mockMedia } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";
import { closeSuitesMenu, openSuitesMenu } from "./helpers/suitesMenu";

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

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return errors;
}

/* Entrance animations scale and fade a card in; measure once they have finished (the infinite aurora never does). */
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

test("with no project open, every Studio stage offers New project, the starter and the four steps — and the card holds the floors", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=studio&page=brief&sp=brief");
  const card = page.getByTestId("first-run");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toHaveAttribute("data-stage", "brief");
  await expect(page.getByTestId("brief-no-project")).toHaveText("Open or create a project to write its script.");
  await expect(card.getByTestId("first-run-new")).toHaveText("New project");
  await expect(card.getByTestId("first-run-starter")).toHaveText("Explore the starter production");
  await expect(card.getByTestId("first-run-note")).toContainText("Nothing is generated or charged.");
  const steps = card.getByTestId("first-run-steps").getByRole("button");
  await expect(steps).toHaveCount(4);
  expect(await steps.locator(".gx-first-step-label").allTextContents()).toEqual(["Brief", "Beats", "Boards", "Takes"]);
  await expect(card.getByTestId("first-run-step-brief")).toHaveAttribute("aria-current", "step");
  await expect(card.getByTestId("recent-projects")).toHaveCount(0);
  await floors(page, card, info);
  await clearsTabBar(page, card.getByTestId("first-run-step-takes"));

  /* Each step opens its stage, which shows the same card with its own sentence and its step lit. */
  for (const [id, title, lead] of [
    ["beats", "Beats & Shots", "Open or create a project to break its script into beats."],
    ["boards", "Storyboards", "Open or create a project to storyboard it."],
    ["takes", "Takes", "Open or create a project to see its takes."],
  ] as const) {
    await page.getByTestId(`first-run-step-${id}`).click();
    await expect(page.getByTestId("page-title")).toHaveText(title);
    await expect(page.getByTestId("first-run")).toHaveAttribute("data-stage", id);
    await expect(page.getByTestId(`${id}-no-project`)).toHaveText(lead);
    await expect(page.getByTestId(`first-run-step-${id}`)).toHaveAttribute("aria-current", "step");
  }
  /* The stages off the four steps show it too; those whose bodies are tools keep them, under the card. */
  for (const [id, page_, lead] of [
    ["environment", "boards", "Open or create a project to build its world."],
    ["cast", "cast", "Open or create a project to cast it."],
    ["rig", "rig", "Open or create a project to use Rig."],
    ["astra", "astra", "Open or create a project to use Astra 3D."],
    ["edit", "edit", "Open or create a project to use Edit & Sound."],
    ["deliver", "deliver", "Open or create a project to use Deliver."],
  ] as const) {
    await page.goto(`/suites?suite=studio&page=${page_}&sp=${id}`);
    await expect(page.getByTestId(`${id}-no-project`)).toHaveText(lead, { timeout: 30_000 });
    await expect(page.getByTestId("first-run")).toHaveAttribute("data-stage", id);
    await expect(page.getByTestId("first-run").locator('[aria-current="step"]')).toHaveCount(0);
  }
  /* The Rig's own list is still there under the card, saying the same. */
  await page.goto("/suites?suite=studio&page=rig&sp=rig");
  await expect(page.getByTestId("rig-list")).toContainText("Open or create a project to see its shots.", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("New project on the card is the switcher's own create: a double press makes one project, and it opens", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=studio&page=brief&sp=brief");
  const creates: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/api/workbench/projects") && (request.postDataJSON() as { revision?: number } | null)?.revision === 0) creates.push(request.url());
  });
  await page.getByTestId("first-run-new").click({ timeout: 60_000 });
  const form = page.getByTestId("first-run-new-form");
  await expect(form).toBeVisible();
  await expect(page.getByTestId("first-run-new-name")).toBeFocused();
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="first-run-new-form"]'), "form targets under 44×44").toEqual([]);
  /* Cancel puts the button back; nothing was made. */
  await page.getByTestId("first-run-new-cancel").click();
  await expect(page.getByTestId("first-run-new")).toHaveText("New project");
  await page.getByTestId("first-run-new").click();
  /* The field stops at the longest name a project saves with (100; it allowed 120 and a longer name was refused after Create). */
  await page.getByTestId("first-run-new-name").fill("x".repeat(130));
  await expect(page.getByTestId("first-run-new-name")).toHaveValue("x".repeat(100));
  /* A name that long: the switcher's pill ends it in an ellipsis rather than spilling. */
  const name = `Harbour ${Date.now().toString(36)} — the long lens series, shot at dusk on the frozen water with the crew`.slice(0, 100);
  await page.getByTestId("first-run-new-name").fill(name);
  await page.getByTestId("first-run-new-create").dblclick();
  /* The toast shows for 2.6 s from the create; the project and Brief load after it, seconds later on a busy server. */
  await expect(page.getByTestId("toast")).toContainText(`${name} is open`, { timeout: 30_000 });
  await expect(page.getByTestId("project-name")).toHaveText(name, { timeout: 30_000 });
  await expect(page.getByTestId("first-run")).toHaveCount(0);
  await expect(page.getByTestId("brief-stage")).toBeVisible();
  expect(creates, "one press of Create, one project").toHaveLength(1);
  const pill = (await page.getByTestId("project-switcher").boundingBox())!;
  const label = (await page.getByTestId("project-name").boundingBox())!;
  expect(label.y + label.height, "the name stays inside the pill").toBeLessThanOrEqual(pill.y + pill.height + 0.5);
  expect(label.x + label.width, "the name stays inside the pill").toBeLessThanOrEqual(pill.x + pill.width + 0.5);
  await page.getByTestId("project-switcher").click();
  await expect(page.getByRole("listbox", { name: "Projects" }).getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("listbox", { name: "Projects" }).getByRole("option", { name: new RegExp(name) })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Explore the starter production opens it with its sample takes, charges nothing, and a second press opens the same one", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=studio&page=brief&sp=brief");
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
  await expect(page.getByTestId("project-name")).toHaveText("Starter production", { timeout: 60_000 });
  expect(presses).toHaveLength(1);
  await expect(page.getByTestId("first-run")).toHaveCount(0);
  await expect(page.getByTestId("brief-stage")).toBeVisible();

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

  /* Its Studio home: the stages it lit and its next step — the first shot still to render. */
  if (DESKTOP.includes(info.project.name)) await page.getByTestId("brand-home").click();
  else if (info.project.name === "workbench-844x390") await page.goto("/suites?suite=studio&sp=stages");
  else { await page.getByTestId("tabbar-home").click(); await page.getByTestId("home-suite-studio").click(); }
  const home = page.getByTestId("studio-home");
  await expect(home).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("page-title")).toHaveText("Starter production");
  await expect(page.getByTestId("home-up-next")).toContainText("Up next · Shot 01");
  await expect(page.getByTestId("home-stage-takes")).toContainText("7 takes");
  await expect(page.getByTestId("home-stage-rig")).toContainText("3 shots · 1 rendered");
  await expect(page.getByTestId("home-stage-cast")).toContainText("1 identity · 1 element");
  await expect(page.getByTestId("home-recent").locator(".gx-home-take")).toHaveCount(6);
  await floors(page, home, info);
  await clearsTabBar(page, home.locator(".gx-home-recent, .gx-home > .gx-empty").last());
  expect(errors).toEqual([]);
});

test("a starter that could not be opened says so under the button, in view above the tab bar, and the button comes back", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=studio&page=brief&sp=brief");
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
  /* In view, and never under the phone's tab bar. */
  await expect.poll(async () => {
    const box = (await problem.boundingBox())!;
    const bar = await page.getByTestId("tabbar").isVisible() ? (await page.getByTestId("tabbar").boundingBox())!.y : page.viewportSize()!.height;
    return box.y >= 0 && box.y + box.height <= bar + 0.5;
  }, { message: "the reason is on screen above the tab bar" }).toBe(true);
  expect(await dimText(page.getByTestId("first-run")), "labels no dimmer than #7C7C84").toEqual([]);
  /* Try again is the same button: one more press, one more request. */
  await page.getByTestId("first-run-starter").click();
  await expect.poll(() => presses).toBe(2);
  await expect(problem).toBeVisible();
  expect(errors).toEqual([]);
});

/* Three projects of this person's; the library has a take still generating. Nothing is written. */
const PROJECTS: Record<string, Project> = {
  "ws-home": { ...newProject("Coastal light study"), id: "ws-home", productionProjectId: "prod-home", shotMappings: {}, brief: "A fox crosses a frozen harbour at dusk", shots: [{ id: "s1", name: "The crossing", assetId: "", duration: 120, sourceIn: 0, note: "" }] },
  "ws-market": { ...newProject("Night market"), id: "ws-market", productionProjectId: "prod-market", shotMappings: {} },
  "ws-dunes": { ...newProject("Dune light tests"), id: "ws-dunes", productionProjectId: "prod-dunes", shotMappings: {} },
};
async function withProjects(page: Page) {
  const list = [
    { id: "ws-home", name: "Coastal light study", revision: 3, updatedAt: Date.now() - 60_000 },
    { id: "ws-market", name: "Night market", revision: 1, updatedAt: Date.now() - 3 * 3_600_000 },
    { id: "ws-dunes", name: "Dune light tests", revision: 1, updatedAt: Date.now() - 2 * 86_400_000 },
  ];
  await page.route("**/api/workbench/projects**", (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 400, json: { error: "Unexpected write in a read test." } });
    const id = new URL(route.request().url()).searchParams.get("id") ?? "ws-home";
    return route.fulfill({ json: { projects: list, productions: [], project: PROJECTS[id] ?? null, revision: 1, shared: null } });
  });
  await mockMedia(page);
  await mockLibrary(page, { uploads: [], generations: [
    generation({ id: "gen_run", title: "Wide on the water", prompt: "Wide on the water", status: "running", storedUrl: null }),
    generation({ id: "gen_done", title: "Close on the rope", prompt: "Close on the rope" }),
  ] });
}

test("desktop: the mark opens the Studio home — the next step, what is generating, the other projects — with the strip and no stage spec", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the desktop's home");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await withProjects(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=rig&sp=rig");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study", { timeout: 60_000 });
  await page.getByTestId("brand-home").click();
  const home = page.getByTestId("studio-home");
  await expect(home).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Coastal light study");
  await expect(page.getByTestId("home-up-next")).toContainText("Up next · Shot 01");
  const running = page.getByTestId("home-running");
  await expect(running.getByTestId("home-run")).toHaveCount(1);
  await expect(running.getByTestId("home-run")).toContainText("Wide on the water");
  await expect(running.getByTestId("home-run")).toContainText("Generating");
  const others = home.getByTestId("recent-projects");
  await expect(others.getByTestId("recent-project")).toHaveCount(2);
  expect(await others.locator(".gx-recent-name").allTextContents()).toEqual(["Night market", "Dune light tests"]);
  await expect(others.locator(".gx-recent-age").first()).toHaveText("3 hr");
  /* The strip stays, with no stage lit; the Inspector has no stage spec to show here. */
  const strip = page.getByRole("navigation", { name: "Pages" });
  await expect(strip.getByRole("button")).toHaveCount(10);
  await expect(strip.locator('[aria-current="page"]')).toHaveCount(0);
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  await floors(page, home, info);
  /* A take picked here opens in the Inspector. */
  await running.getByTestId("home-run").click();
  await expect(page.getByTestId("inspector")).toBeVisible();
  /* A recent project opens in one click. */
  await others.getByRole("button", { name: /Night market/ }).click();
  await expect(page.getByTestId("project-name")).toHaveText("Night market");
  await expect(page.getByTestId("page-title")).toHaveText("Night market");
  /* An empty project's next step is its brief. */
  await expect(page.getByTestId("home-up-next")).toContainText("Up next · the brief");
  await page.getByTestId("home-open-brief").click();
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  expect(errors).toEqual([]);
});

test("phone: with a project, the Studio home lists what is generating and the other projects, and its last row clears the tab bar", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "the phone's Studio grid");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await withProjects(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&sp=stages");
  const home = page.getByTestId("studio-home");
  await expect(home).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("page-title")).toHaveText("Coastal light study");
  await expect(page.getByTestId("home-running").getByTestId("home-run")).toContainText("Wide on the water");
  const others = home.getByTestId("recent-projects");
  await expect(others.getByTestId("recent-project")).toHaveCount(2);
  await floors(page, home, info);
  await clearsTabBar(page, others.getByTestId("recent-project").last());
  await others.getByTestId("recent-project").last().click();
  await expect(page.getByTestId("project-name")).toHaveText("Dune light tests");
  expect(errors).toEqual([]);
});

test("with no project, the Studio home is the first run: from the mark on a desktop, from Home › Studio on a phone", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=studio&page=brief&sp=brief");
  await expect(page.getByTestId("first-run")).toBeVisible({ timeout: 60_000 });
  if (DESKTOP.includes(info.project.name)) await page.getByTestId("brand-home").click();
  else if (info.project.name === "workbench-844x390") { await page.getByTestId("brand-home").click(); await page.getByTestId("home-suite-studio").click(); }
  else { await page.getByTestId("tabbar-home").click(); await page.getByTestId("home-suite-studio").click(); }
  const home = page.getByTestId("studio-home");
  await expect(home).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Start a production");
  const card = home.getByTestId("first-run");
  await expect(card).toHaveAttribute("data-stage", "home");
  await expect(card.locator('[aria-current="step"]')).toHaveCount(0);
  await expect(home.getByTestId("home-up-next")).toHaveCount(0);
  await floors(page, home, info);
  await clearsTabBar(page, card.getByTestId("first-run-step-takes"));
  await card.getByTestId("first-run-step-beats").click();
  await expect(page.getByTestId("page-title")).toHaveText("Beats & Shots");
  expect(errors).toEqual([]);
});

test("the card and the Studio home sit inside the stage's boundary: a throw in either is that stage's fault card, and the shell keeps working", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  await page.addInitScript(() => { (window as unknown as { __particlCrash?: unknown[] }).__particlCrash = ["first-run", "studio-home"]; });
  const errors = await open(page, "/suites?suite=studio&page=brief&sp=brief");
  const fault = page.locator('[data-testid="panel-fault"][data-fault="stage:brief"]');
  await expect(fault).toBeVisible({ timeout: 60_000 });
  await expect(fault).toContainText("Brief & Script stopped");
  await openSuitesMenu(page);
  await expect(page.getByRole("tablist", { name: "Suites" })).toBeVisible();
  await closeSuitesMenu(page);
  await expect(page.getByTestId("project-switcher")).toBeVisible();
  await page.goto("/suites?suite=studio&sp=stages");
  await expect(page.locator('[data-testid="panel-fault"][data-fault="stage:stages"]')).toBeVisible();
  /* Disarmed, Try again brings the home back. */
  await page.evaluate(() => { (window as unknown as { __particlCrash?: unknown[] }).__particlCrash = []; });
  await page.locator('[data-testid="panel-fault"][data-fault="stage:stages"]').getByTestId("fault-retry").click();
  await expect(page.getByTestId("studio-home").getByTestId("first-run")).toBeVisible();
  expect(errors, "a caught throw never reaches the window").toEqual([]);
});
