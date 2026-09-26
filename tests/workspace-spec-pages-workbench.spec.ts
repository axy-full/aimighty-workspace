import { mkdirSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { parseConnectedCatalogue } from "../lib/higgsfield-consumer/catalogue";
import { SPEC_PAGES } from "../lib/workspace/spec-cards";
import { pageDef, suiteOfPage } from "../lib/workspace/pages";
import type { PageId } from "../lib/workspace/types";

/**
 * Spec-card pages (workspace redesign, wave 2). Each page renders its card
 * groups, its working tool is reachable from the page, the page title never
 * truncates, and nothing clips at 1200, 1440 or 1920. Desktop assertions
 * skip on phones, which render the phone shell instead.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.WS_SPEC_SHOTS || "";

/* Test fixtures only — the app reads these from the real projects route. */
const primary = {
  ...newProject("Coastal light study"),
  id: "ws-spec-a",
  productionProjectId: "ws-spec-production",
  description: "Product film · Spot 02",
  aspect: "16:9",
  fps: 24,
  brief: "A short film about a lighthouse keeper's last night on duty.",
  script: "INT. LIGHTHOUSE - NIGHT\n\nThe lamp turns.\n\nEXT. CLIFF - DAWN\n\nThe keeper walks down.",
};
const list = [{ id: primary.id, name: primary.name, revision: 3, updatedAt: "2026-09-18T10:00:00Z" }];

/** A saved plan waiting on approval (fixture); names are neutral. */
const run = {
  id: "run-waiting",
  owner: "fixture",
  pipelineId: "saved-plan",
  pipelineVersion: 1,
  revision: 2,
  state: "awaiting_approval",
  name: "Harbour stills",
  context: { projectId: "ws-spec-production", bibleVersion: 1 },
  maximumUnits: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  stages: [],
  attempts: [],
  quotes: [],
  selections: [],
  assemblies: {},
};

/** Where each page's working tool lands: the element that proves it mounted. `body: null` — cards only. */
const TOOLS: Partial<Record<PageId, { body: string | null; card?: string; then?: string }>> = {
  brief: { body: '[data-tool-body="brief"]', card: "Script", then: '[data-tool-body="script"]' },
  boards: { body: '[data-tool-body="boards"]', card: "Frames" },
  astra: { body: '[data-tool-body="astra"]', card: "Camera" },
  deliver: { body: '[data-tool-body="package"]', card: "Master", then: '[data-tool-body="movie"]' },
  agent: { body: '[data-tool-body="agent"]', card: "Conversation" },
  runs: { body: '[data-tool-body="runs"]', card: "Queue" },
  recipes: { body: '[data-tool-body="recipes"]', card: "Exact cloning" },
  builds: { body: null },
  skills: { body: null },
  models: { body: '[data-tool-body="models"]', card: "Seedance 2.5" },
  approvals: { body: '[data-tool-body="approvals"]', card: "Priced gate" },
  budget: { body: '[data-tool-body="budget"]', card: "Caps" },
  /* Marketing Studio itself is mounted; its tool control opens a section inside the one body. */
  marketing: { body: '[data-tool-body="marketing"]', card: "Hooks" },
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
  /* The Atomik suite's reads for this production; nothing here may write. */
  await page.route("**/api/pipelines**", (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 403, json: { error: "Read-only fixture." } });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/pipelines") return route.fulfill({ json: { runs: [run], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } } });
    return route.fulfill({ json: { run } });
  });
  await page.route("**/api/projects", (route) =>
    route.fulfill({ json: { projects: [{ id: "ws-spec-production", name: primary.name, spend: 0.9, credits: 1234, capCredits: 2500, capUsd: 250, capUnlocked: false }] } }),
  );
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

test("phones render the phone shell on spec pages", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signedInWithProject(page);
  await page.goto(url("marketing"));
  /* The phone shell renders here now (wave M-A): /workspace is the phone's
     surface below 768px, and the desktop studio row is not mounted. */
  await expect(page.getByTestId("phone-shell")).toBeVisible();
  await expect(page.getByTestId("studio-row")).toHaveCount(0);
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
    if (tool.body) await expect(page.getByTestId("spec-work").locator(tool.body)).toBeVisible({ timeout: 30_000 });
    else await expect(page.getByTestId("spec-work")).toHaveCount(0);
    /* …and a card opens its tool. */
    if (tool.card && tool.body) {
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

    if (SHOTS && info.project.name === "workbench-1440x900" && (id === "brief" || id === "marketing" || id === "runs")) {
      await page.getByTestId("content").evaluate((el) => el.scrollTo(0, 0));
      await page.screenshot({ path: `${SHOTS}/${id}-1440x900.png` });
    }

    if (SHOTS && info.project.name === "workbench-1440x900" && tool.body) {
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

  /* States come from real data: the saved run waits on approval, the budget has a cap. */
  await page.setViewportSize(configured);
  await page.goto(url("approvals"));
  await expect(page.locator('.pxw-spec-card[data-card="Priced gate"] .pxw-spec-card-state')).toHaveText("You · waiting on you");
  await expect(page.locator('.pxw-spec-card[data-card="Priced gate"] .pxw-spec-chip').first()).toHaveText("1 waiting");
  await page.goto(url("budget"));
  await expect(page.locator('.pxw-spec-card[data-card="Caps"] .pxw-spec-card-state')).toHaveText("Admin · active");
  await expect(page.getByTestId("spec-facts")).toContainText("1,234 cr");

  /* Generate keeps its existing body, inside the shell. */
  await page.goto(url("generate"));
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await expect(page.locator('[data-page-body="generate"] [data-tool-body="generate"]')).toBeVisible({ timeout: 30_000 });
  await assertNoClipping(page);

  /* Home feature cards read the first sentence of each intro. */
  await page.setViewportSize(configured);
  await page.goto(`/workspace?project=${primary.id}&suite=moleculr`);
  await expect(page.locator('.pxw-feature[data-feature="marketing"] .pxw-feature-desc')).toHaveText(
    "One studio: a product, who presents it, what it says and where it runs.",
  );
  expect(errors).toEqual([]);
});

test("Generate's own form is the request its Atomik plan prices; nothing is quoted before Run", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8")), 1_758_000_000_000);
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const project = { ...primary, id: "ws-spec-generate" };
  const posts: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* A published request that re-publishes itself on every render never settles (audit, 25 September). */
  page.on("console", (message) => { if (message.type() === "error" && /Maximum update depth/.test(message.text())) errors.push(message.text()); });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/me") return json(me);
    if (path === "/api/workbench/projects")
      return json({ project, projects: [{ id: project.id, name: project.name, revision: 1 }], revision: 1, productions: [], shared: null });
    if (path === "/api/higgsfield/consumer/connection") return json({ connected: true, requiresReconnect: false });
    if (path === "/api/higgsfield/consumer/generation") {
      if (request.method() === "GET")
        return json({ connection: { connected: true, requiresReconnect: false }, capabilities: { types: ["image", "video", "audio", "3d"], promptLimit: 5000, maxMedias: 30, maxMediaBytes: 52428800, maxOriginalBytes: 104857600, importsMediaForQuote: true, cancel: false }, jobs: [] });
      const body = request.postDataJSON();
      posts.push(body);
      if (body.action === "catalogue")
        return json({ catalogue: { models: catalogue.models, unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: catalogue.fetchedAt } });
      return json({ error: "No quote may be requested in this test." }, 409);
    }
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (request.method() !== "GET") return json({ error: "No other mutation permitted." }, 409);
    return route.continue();
  });
  await page.goto(`/workspace?project=${project.id}&suite=atomik&page=generate`);
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  await expect(panel.getByRole("combobox", { name: "Generate model", exact: true })).toBeVisible({ timeout: 30_000 });

  const nav = page.getByRole("navigation", { name: "Pages" });
  await nav.getByRole("button", { name: /Atomik/ }).click();
  await expect(page.getByTestId("atomik-plan-title")).toHaveText("Generate on the connected account");
  await expect(page.getByTestId("atomik-reason")).toHaveText("Needs Generate data");
  await page.keyboard.press("Escape");

  await panel.getByRole("combobox", { name: "Generate model", exact: true }).selectOption("nano_banana_2");
  const settings = panel.getByRole("group", { name: "Model settings", exact: true });
  await settings.getByRole("combobox", { name: "resolution", exact: true }).selectOption("2k");
  await settings.getByRole("combobox", { name: "aspect ratio", exact: true }).selectOption("1:1");
  await panel.getByRole("textbox", { name: "Generate prompt", exact: true }).fill("A plain bottle on a clean studio background.");

  await nav.getByRole("button", { name: /Atomik/ }).click();
  await expect(page.getByTestId("atomik-reason")).toHaveCount(0);
  await expect(page.getByTestId("atomik-panel").getByRole("button", { name: /Run this page/ })).toBeEnabled();
  /* A complete form holds still: typing keeps up, and nothing re-renders on its own. */
  await page.keyboard.press("Escape");
  await panel.getByRole("textbox", { name: "Generate prompt", exact: true }).pressSequentially(" Soft light.");
  await expect(panel.getByRole("textbox", { name: "Generate prompt", exact: true })).toHaveValue("A plain bottle on a clean studio background. Soft light.");
  await page.waitForTimeout(1000);
  /* Publishing the request sends nothing: only the catalogue read left the page. */
  expect(posts).toEqual([{ action: "catalogue" }]);
  expect(errors).toEqual([]);
});
