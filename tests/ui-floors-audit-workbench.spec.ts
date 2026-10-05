import { test, expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";
import { DEFAULT_BOARDS } from "../lib/production/boards";
import { DEFAULT_ENVIRONMENT, newEnvironmentEntry } from "../lib/production/environment";
import { forbidPaidWork, generation, mockLibrary, mockMedia, upload } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { closeSuitesMenu, openSuitesMenu } from "./helpers/suitesMenu";
import { legacyShell } from "./helpers/legacyShell";

/**
 * The owner's UI floors, held where the floors audit of the Suites pages
 * (28 September 2026) found them broken: every label named here reads at
 * #7C7C84 or brighter once its colour is composited with its alpha over the
 * ground behind it; Edit & Sound fits a phone instead of scrolling sideways;
 * Deliver's and Edit & Sound's buttons, Environment's library pickers, the ⌘K
 * field and Edit & Sound's "Add takes" are 44px targets on a touch screen; a
 * long file name in a picker never widens the page; and a draft that could
 * not be read says "Try again" ("Retry" is a take's paid re-render). The
 * follow-up floors: the Library overlay ends above a phone's tab bar, its
 * closing note included; the agent's model and effort pickers, the Atomik
 * agent panel and the Atomik suite's controls are 44px targets on a touch
 * screen; Atomik's projects and budget reads say "Try again" when they fail;
 * and the Atomik pages' group notes read at the label floor. A real project
 * on the local routes, a mocked Library, the mock engine: nothing is paid for.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844"];
/* A phone on its side is a touch screen too: its targets keep the floor. */
const TOUCH = [...PHONES, "workbench-844x390"];

const SCRIPT = seedProject().script!;
function fixture(): Project {
  const sha = createHash("sha256").update(SCRIPT).digest("hex");
  const scene = (n: number, heading: string) => ({
    id: `scene-${n}`, heading, summary: `What scene ${n} is for.`, characters: ["MIRA"], locations: [heading], props: [],
    beats: [1, 2].map((b) => ({ id: `beat-${n}-${b}`, text: `Scene ${n}, beat ${b}.` })),
    shots: [1, 2].map((t) => ({ id: `shot-${n}-${t}`, description: `Scene ${n}, shot ${t}.`, framing: "Wide", movement: "Slow push-in", lighting: "Low sun", sound: "Wind" })),
  });
  return {
    ...seedProject(), id: `floors-${randomUUID().slice(0, 8)}`, name: "Mirrored Dunes",
    production: {
      scriptApproval: { at: new Date().toISOString(), source: "hand", sha256: sha },
      beats: { scriptSha256: sha, updatedAt: new Date().toISOString(), scenes: [scene(1, "EXT. MIRRORED DUNES - LATE AFTERNOON"), scene(2, "EXT. MIRROR SPHERE - LATE AFTERNOON")] },
      boards: { ...DEFAULT_BOARDS, frames: { "shot-1-1": { prompt: "Ivory suit, chrome sphere, low sun.", style: "bw-sketch", takes: [] } } },
      environment: { ...DEFAULT_ENVIRONMENT, entries: [newEnvironmentEntry("Mirrored dunes", "Wide plates", "Sculptural caramel dunes", "dunes")] },
    },
  };
}

/** A real project through the local routes; the Library mocked, with a file name long enough to widen a picker. */
async function open(page: Page, path: string, ready: string) {
  await signInLocally(page.request);
  const account = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string } };
  const project = fixture();
  const saved = await page.request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${account.id}` }, data: { project, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate-wide-establishing-shot-at-first-light-final-graded-v12.webp" })],
    generations: [generation({ id: "gen_still", title: "Chrome sphere, low sun", prompt: "Chrome sphere" })],
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${path}&project=${project.id}`);
  await expect(page.getByTestId(ready).first()).toBeVisible();
  /* Workspace has no project head of its own. */
  if (!path.includes("view=workspace")) await expect(page.getByTestId("project-name").first()).toHaveText("Mirrored Dunes");
  return { errors, project };
}

/**
 * Every visible element matching `selector` whose text reads under #7C7C84 as it lands on the screen: its colour and
 * any opacity above it composited over the backgrounds behind it, down to black (the darkest ground a screen shows) —
 * the measure tests/phoneFloors.ts's dimLabels takes with the alpha.
 */
async function dimLabels(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(async (selector) => {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)));
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (color: string): Rgba | null => {
      const srgb = color.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+))?\)$/);
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] == null ? 1 : Number(srgb[4]) };
      const rgb = color.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
      if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] == null ? 1 : Number(rgb[4]) };
      return color === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
    };
    const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const luminance = (c: Rgba) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const floor = 0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5;
    const out: string[] = [];
    const found = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => el.getClientRects().length && (el.textContent ?? "").trim());
    if (!found.length) return [`nothing on screen matches ${selector}`];
    for (const el of found) {
      const layers: Rgba[] = [];
      for (let up = el.parentElement; up; up = up.parentElement) {
        const bg = parse(getComputedStyle(up).backgroundColor);
        if (!bg || bg.a <= 0) continue;
        layers.push(bg);
        if (bg.a >= 1) break;
      }
      const ground = layers.reverse().reduce((under, layer) => over(layer, under), { r: 0, g: 0, b: 0, a: 1 });
      let opacity = 1;
      for (let up: HTMLElement | null = el; up; up = up.parentElement) opacity *= Number(getComputedStyle(up).opacity);
      const ink = parse(getComputedStyle(el).color);
      if (!ink) { out.push(`${el.className}: unreadable colour`); continue; }
      const seen = over({ ...ink, a: ink.a * opacity }, ground);
      if (luminance(seen) < floor) out.push(`${el.className || el.tagName}: ${getComputedStyle(el).color} reads ${[seen.r, seen.g, seen.b].map(Math.round).join(", ")} — “${(el.textContent ?? "").trim().slice(0, 24)}”`);
    }
    return out;
  }, selector);
}

/** The document and each named scroller never scroll sideways. */
async function sideways(page: Page, scrollers: string[] = []) {
  return page.evaluate((scrollers) => {
    const out: string[] = [];
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (doc > 0) out.push(`document ${doc}px wider than the screen`);
    for (const selector of scrollers)
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector)))
        if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) out.push(`${selector} scrolls ${el.scrollWidth - el.clientWidth}px sideways`);
    return out;
  }, scrollers);
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });





test("⌘K: the field is a 44px target on touch; its groups, hints and keys read at the floor", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=atomik&page=agent&sp=agent", "spec-page");
  /* On a phone, Search waits behind the header's context badge. */
  await openSuitesMenu(page);
  await page.getByTestId("header-search").click();
  await expect(page.locator(".gx-palette")).toBeVisible();
  for (const selector of [".gx-palette-group", ".gx-palette-hint", ".gx-palette .gx-key"]) expect(await dimLabels(page, selector), `${selector}: under #7C7C84`).toEqual([]);
  if (TOUCH.includes(info.project.name)) {
    const field = (await page.locator(".gx-palette-input").boundingBox())!;
    expect(Math.round(field.height), "the search field's height").toBeGreaterThanOrEqual(44);
  }
  expect(errors).toEqual([]);
});

test("Workspace › Dashboard: the tables' column headers read at the floor", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?view=workspace&tab=dashboard", "workspace-view");
  await expect(page.locator(".mdx-table th").first()).toBeVisible();
  expect(await dimLabels(page, ".mdx-table th"), "column headers under #7C7C84").toEqual([]);
  expect(errors).toEqual([]);
});

test("a draft that could not be read says Try again, never Retry (Deliver's tool, Edit & Sound)", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  /* Workspace reads no stage's draft, so the stages below read theirs for the first time once the connection is down
     (the shell already holds the project, so its own head stays). */
  const { errors } = await open(page, "/suites?view=workspace&tab=general", "workspace-view");
  let down = true;
  await page.route(/\/api\/workbench\/projects\?id=/, (route) => (down && route.request().method() === "GET" ? route.fulfill({ status: 503, json: { error: "Studio could not load this project (503)." } }) : route.fallback()));
  await openSuitesMenu(page);
  /* The project's segment opens its Studio pages (header option B). */
  await page.getByRole("tablist", { name: "Suites" }).locator('[data-suite-tab="project"]').click();
  await closeSuitesMenu(page);
  const strip = page.getByRole("navigation", { name: "Pages" });
  for (const [tab, alert] of [[/Deliver/, "[data-testid='stage-work'] [role='alert']"], [/Edit & Sound/, ".pxw-edit [role='alert']"]] as const) {
    await strip.getByRole("button", { name: tab }).click();
    const failed = page.locator(alert).filter({ hasText: "could not load this project" });
    await expect(failed).toBeVisible();
    await expect(failed.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(failed.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  }
  down = false;
  await page.locator(".pxw-edit [role='alert']").getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByTestId("assembly")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the old shell's home: a projects read that failed says Try again, never Retry, and reads again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  let down = true;
  await page.route(/\/api\/workbench\/projects(\?.*)?$/, (route) =>
    down && route.request().method() === "GET" ? route.fulfill({ status: 503, json: { error: "Projects could not be loaded (503)." } }) : route.fallback());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(await legacyShell(page, "/"));
  const failed = page.locator(".suite-home-projects [role='alert']");
  await expect(failed).toContainText("Projects could not be loaded");
  await expect(failed.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(failed.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  if (TOUCH.includes(info.project.name)) expect(await smallTargets(page, ".suite-home-projects [role='alert']"), "Try again under 44×44").toEqual([]);
  down = false;
  await failed.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(failed).toHaveCount(0);
  await expect(page.locator(".suite-home-projects").getByText(/Loading projects|Start a project|Open production/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

/**
 * Every control a thumb can hit inside `scope` that is under 44×44: buttons, links, fields, a disclosure's summary and
 * a list's option; a checkbox by its label, which takes the tap for the whole row. A segmented option may be 40px tall
 * inside its 44px track, the one exemption tests/phoneFloors.ts allows.
 */
async function touchTargets(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scope) => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(scope)).filter((el) => el.getClientRects().length);
    if (!roots.length) return [`nothing on screen matches ${scope}`];
    const out: string[] = [];
    for (const root of roots)
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("button, a[href], select, input, textarea, summary, [role='option']"))) {
        if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
        const target = el.matches("input[type='checkbox'], input[type='radio']") ? (el.closest("label") ?? el) : el;
        const box = target.getBoundingClientRect();
        const track = el.classList.contains("gx-seg-btn") ? el.closest(".gx-seg") : null;
        const floor = track && track.getBoundingClientRect().height >= 43.5 ? 40 : 44;
        if (box.width < 43.5 || box.height < floor - 0.5)
          out.push(`${(el.getAttribute("aria-label") || el.textContent || String(el.className) || el.tagName).trim().slice(0, 32)}: ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
    return out;
  }, scope);
}

test("Library: the overlay's list and its closing note end above the tab bar, where a tap lands on them", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=atomik&page=agent&sp=agent", "spec-page");
  const library = page.getByTestId("library");
  if (!(await library.isVisible())) await page.getByTestId("toggle-library").click();
  const assets = library.getByRole("tab", { name: /Assets/ });
  if (await assets.count()) await assets.click();
  await expect(library.locator(".gx-asset").first()).toBeVisible();
  await expect(library.locator(".gx-lib-foot")).toHaveText("Everything this project has made or uploaded, on every page.");
  /* The overlay has finished sliding in: an entrance still under way is not where it rests. */
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
  const under = await page.evaluate(() => {
    const out: string[] = [];
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    const floats = Boolean(bar && bar.getClientRects().length && getComputedStyle(bar).position === "fixed");
    const limit = floats ? bar!.getBoundingClientRect().top : innerHeight;
    /* The list's own window, not only its last row: a tile half under the bar took a tap meant for it (the floors
       audit, when the note was hidden and the list ran on under the bar). */
    const list = document.querySelector<HTMLElement>("[data-testid='library-assets']")!;
    list.scrollTop = list.scrollHeight;
    const listBottom = list.getBoundingClientRect().bottom;
    if (listBottom > limit + 0.5) out.push(`the asset list runs to ${Math.round(listBottom)}px, past ${Math.round(limit)}px`);
    const tiles = Array.from(list.querySelectorAll<HTMLElement>(".gx-asset")).filter((el) => el.getClientRects().length);
    const last = tiles.at(-1)!.getBoundingClientRect();
    if (last.bottom > limit + 0.5) out.push(`the last tile ends at ${Math.round(last.bottom)}px, past ${Math.round(limit)}px`);
    /* Landscape phones fold the note away with the rest of their compact controls (components/graphite/phone.css); where it
       shows, it is read above the bar, and a tap on it lands on it. */
    const note = document.querySelector<HTMLElement>(".gx-library > .gx-lib-foot")!;
    if (note.getClientRects().length) {
      const box = note.getBoundingClientRect();
      if (box.bottom > limit + 0.5) out.push(`the closing note ends at ${Math.round(box.bottom)}px, past ${Math.round(limit)}px`);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!hit || !note.contains(hit)) out.push(`the closing note is covered by ${hit ? String(hit.className || hit.tagName).slice(0, 40) : "nothing"}`);
    }
    return out;
  });
  expect(under, "the Library's contents above the tab bar").toEqual([]);
  expect(errors).toEqual([]);
});

/* The agent's reads, answered here: a planning model the workspace reaches and one finished proposal. Nothing is
   quoted, planned or rendered: any other request to the agent's route is refused and recorded. */
const AGENT_MODELS = [
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", vision: true, released: 2, efforts: [{ value: "auto", label: "Auto" }, { value: "high", label: "High" }] },
];
const AGENT_JOB = {
  id: "wb_atomik_floors", requestId: "request-floors-1", projectId: "floors", productionProjectId: null, suite: "atomik", status: "succeeded",
  request: "[atomik] Plan the dunes teaser", model: "anthropic/claude-sonnet-4.6", depth: "Deep", refs: [], estimateCredits: 7, credits: 3, error: null, createdAt: 1, updatedAt: 1,
  plan: {
    id: "wb_atomik_floors", request: "[atomik] Plan the dunes teaser", model: "anthropic/claude-sonnet-4.6", depth: "Deep", refs: [], applied: false, intent: "shots",
    summary: "A three-shot teaser that opens on the dunes and ends on the sphere.", steps: ["Board the dunes at first light."],
    suiteAgent: { suite: "atomik", projectId: "floors", actions: [{ kind: "image", title: "Dunes at first light", prompt: "Caramel dunes at first light, the chrome sphere on the right.", referenceIds: [] }], hooks: ["First light"], assumptions: ["The audience is festival programmers."] },
  },
};
async function agentReads(page: Page) {
  const refused: string[] = [];
  await page.route("**/api/workbench/atomik**", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: true, models: AGENT_MODELS, jobs: [AGENT_JOB] } });
    refused.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 409, json: { error: "No agent request is sent in this test." } });
  });
  return refused;
}


test("Atomik › Agent: the agent panel's controls are 44px targets on touch; the page's group notes read at the floor", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const refused = await agentReads(page);
  const { errors } = await open(page, "/suites?suite=atomik&page=agent&sp=agent", "spec-page");
  const panel = page.getByRole("region", { name: "Production orchestrator" });
  await expect(panel.getByLabel("Creative request")).toBeEnabled();
  await expect(panel.getByText("Production proposal", { exact: true })).toBeVisible();
  expect.soft(await dimLabels(page, ".pxw-spec-note"), ".pxw-spec-note: under #7C7C84").toEqual([]);
  if (TOUCH.includes(info.project.name)) {
    /* Every disclosure open, so the rows inside it are measured too. */
    await panel.locator("summary").filter({ hasText: "Project references" }).click();
    await expect(panel.getByRole("checkbox").first()).toBeVisible();
    await panel.locator("summary").filter({ hasText: "Assumptions to review" }).click();
    await panel.locator("summary").filter({ hasText: "Dunes at first light" }).click();
    await expect(panel.getByRole("button", { name: "Remember: The audience is festival programmers." })).toBeVisible();
    expect.soft(await touchTargets(page, "[aria-label='Production orchestrator']"), "the agent panel").toEqual([]);
  }
  expect(refused).toEqual([]);
  expect(errors).toEqual([]);
});

test("Atomik › Runs, Budget and Models: the suite's buttons, links and fields are 44px targets on touch", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const refused = await agentReads(page);
  const { errors } = await open(page, "/suites?suite=atomik&page=runs&sp=runs", "spec-page");
  const strip = page.getByRole("navigation", { name: "Pages" });
  const suite = page.locator(".pxw-tool--atomik");
  for (const [tab, ready] of [["Runs", "Build your first plan"], ["Budget", "Project generation spend"], ["Models", "Effective routing"]] as const) {
    await strip.getByRole("button", { name: new RegExp(tab) }).click();
    await expect(suite.getByText(ready, { exact: true })).toBeVisible();
    if (tab === "Budget") await expect(suite.getByRole("button", { name: "Save cap" })).toBeVisible();
    if (tab === "Models") await expect(suite.getByRole("link", { name: "Manage engines and routing" })).toBeVisible();
    if (TOUCH.includes(info.project.name)) expect.soft(await touchTargets(page, ".pxw-tool--atomik"), `Atomik › ${tab}`).toEqual([]);
  }
  expect(await sideways(page)).toEqual([]);
  expect(refused).toEqual([]);
  expect(errors).toEqual([]);
});

test("Atomik: a projects or budget read that failed says Try again, never Retry", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const refused = await agentReads(page);
  /* Workspace reads neither, so Atomik reads both for the first time once the connection is down (the shell already
     holds the project, so its own head stays). */
  const { errors } = await open(page, "/suites?view=workspace&tab=general", "workspace-view");
  let projectsDown = true, budgetDown = false;
  await page.route(/\/api\/workbench\/projects\?id=/, (route) => (projectsDown && route.request().method() === "GET" ? route.fulfill({ status: 503, json: { error: "Studio could not load this project (503)." } }) : route.fallback()));
  await page.route(/\/api\/projects(\?.*)?$/, (route) => (budgetDown && route.request().method() === "GET" ? route.fulfill({ status: 503, json: { error: "The project budget could not be loaded (503)." } }) : route.fallback()));
  await openSuitesMenu(page);
  await page.getByRole("tablist", { name: "Suites" }).getByRole("tab", { name: "Atomik" }).click();
  await closeSuitesMenu(page);
  const strip = page.getByRole("navigation", { name: "Pages" });
  await strip.getByRole("button", { name: /Runs/ }).click();
  const projects = page.locator(".pxw-tool--atomik [role='alert']").filter({ hasText: "could not load this project" });
  await expect(projects).toBeVisible();
  await expect(projects.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(projects.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  projectsDown = false;
  await projects.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".pxw-tool--atomik").getByText("Build your first plan", { exact: true })).toBeVisible();

  budgetDown = true;
  await strip.getByRole("button", { name: /Budget/ }).click();
  const budget = page.locator(".pxw-tool--atomik [role='alert']").filter({ hasText: "could not be loaded" });
  await expect(budget).toBeVisible();
  await expect(budget.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(budget.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  budgetDown = false;
  await budget.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".pxw-tool--atomik").getByText("Project generation spend", { exact: true })).toBeVisible();
  expect(refused).toEqual([]);
  expect(errors).toEqual([]);
});
