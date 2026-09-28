import { test, expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";
import { DEFAULT_BOARDS } from "../lib/production/boards";
import { DEFAULT_ENVIRONMENT, newEnvironmentEntry } from "../lib/production/environment";
import { forbidPaidWork, generation, mockLibrary, mockMedia, upload } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";

/**
 * The owner's UI floors, held where the floors audit of the Suites pages
 * (28 September 2026) found them broken: every label named here reads at
 * #7C7C84 or brighter once its colour is composited with its alpha over the
 * ground behind it; Edit & Sound fits a phone instead of scrolling sideways;
 * Deliver's and Edit & Sound's buttons, Environment's library pickers, the ⌘K
 * field and Edit & Sound's "Add takes" are 44px targets on a touch screen; a
 * long file name in a picker never widens the page; the Library's last line
 * sits above the phone's tab bar; and a draft that could not be read says
 * "Try again" ("Retry" is a take's paid re-render). A real project on the
 * local routes, a mocked Library, the mock engine: nothing is paid for.
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

test("Deliver: the strip's numbers, the stage facts, the card feet and the package's labels read at the floor; its buttons are 44px on touch", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=studio&page=deliver&sp=deliver", "stage-view");
  await expect(page.locator(".pxw-package-actions")).toBeVisible();
  for (const selector of [".gx-strip .gx-tab:not([aria-current]) .gx-tab-n", ".gx-stage-facts dt", ".gx-stage-card-foot:not([data-state='COMPLETE']):not([data-state='ACTIVE']):not([data-state='WAITING'])", ".pxw-package-facts span"])
    expect(await dimLabels(page, selector), `${selector}: under #7C7C84`).toEqual([]);
  expect(await sideways(page, ["[data-testid='content']"])).toEqual([]);
  if (TOUCH.includes(info.project.name)) expect(await smallTargets(page, ".pxw-package"), "Deliver's package: targets under 44×44").toEqual([]);
  expect(errors).toEqual([]);
});

test("Beats and Storyboards: scene, shot and card-foot numbers read at the floor", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=studio&page=brief&sp=beats", "beats-stage");
  await expect(page.getByTestId("beat-scene").first()).toBeVisible();
  for (const selector of [".pd-scene-n", ".pd-beat-card-foot"]) expect(await dimLabels(page, selector), `${selector}: under #7C7C84`).toEqual([]);
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Storyboards/ }).click();
  await expect(page.getByTestId("boards-stage")).toBeVisible();
  await expect(page.locator(".pd-shot-n").first()).toBeVisible();
  expect(await dimLabels(page, ".pd-shot-n"), ".pd-shot-n: under #7C7C84").toEqual([]);
  expect(errors).toEqual([]);
});

test("Edit & Sound fits the screen: nothing sideways, its labels at the floor, 44px targets on touch", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=studio&page=edit&sp=edit", "content");
  await expect(page.getByTestId("assembly")).toBeVisible();
  await expect(page.locator(".pxw-stem").first()).toBeVisible();
  /* It was held at 680px wide and scrolled sideways inside a phone's page. */
  expect(await sideways(page, ["[data-testid='content']", ".gx-legacy > .pxw-content"])).toEqual([]);
  for (const selector of [".pxw-assembly-sub", ".pxw-stem-name > span", ".pxw-stem-note", ".pxw-stem-state"])
    expect(await dimLabels(page, selector), `${selector}: under #7C7C84`).toEqual([]);
  if (TOUCH.includes(info.project.name)) {
    expect(await smallTargets(page, ".pxw-edit"), "Edit & Sound: targets under 44×44").toEqual([]);
    expect(await smallTargets(page, "[data-testid='timeline-cut'] .pd-more"), "Add takes: targets under 44×44").toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("Environment: a long file name never widens the page, and the library pickers are 44px on touch", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=studio&page=boards&sp=environment", "environment-stage");
  const picker = page.getByTestId("environment-add-reference").first();
  await expect(picker).toBeEnabled();
  await expect(picker.locator("option", { hasText: "harbour-plate-wide-establishing-shot-at-first-light-final-graded-v12.webp" })).toHaveCount(1);
  expect(await sideways(page, ["[data-testid='content']"])).toEqual([]);
  for (const id of ["environment-add-reference", "environment-use-plate"]) {
    const box = (await page.getByTestId(id).first().boundingBox())!;
    expect(box.x + box.width, `${id} inside the screen`).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (TOUCH.includes(info.project.name)) expect(Math.round(box.height), `${id} height`).toBeGreaterThanOrEqual(44);
  }
  /* The place name keeps the field's height in the card's column (it had collapsed to 20px away from a phone's width). */
  const name = (await page.getByTestId("environment-name").first().boundingBox())!;
  expect(Math.round(name.height), "the place name's height").toBeGreaterThanOrEqual(TOUCH.includes(info.project.name) ? 44 : 36);
  expect(errors).toEqual([]);
});

test("⌘K: the field is a 44px target on touch; its groups, hints and keys read at the floor", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=studio&page=takes&sp=takes", "edit-stage");
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

test("phone: the Library's closing line never sits under the tab bar", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "the portrait phones, where the tab bar floats over the page");
  const { errors } = await open(page, "/suites?suite=studio&page=boards&sp=boards", "boards-stage");
  await page.getByTestId("tabbar-assets").click();
  const library = page.getByTestId("library");
  await expect(library.getByTestId("library-assets")).toBeVisible();
  const barTop = await page.getByTestId("tabbar").evaluate((el) => el.getBoundingClientRect().top);
  /* The overlay runs to the screen's foot: its closing line (below the list, which keeps its own clearance) was under the bar. */
  const foot = library.locator(".gx-lib-foot");
  if (await foot.isVisible()) expect(await foot.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(barTop);
  expect(errors).toEqual([]);
});

test("a draft that could not be read says Try again, never Retry (Deliver's tool, Edit & Sound)", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  /* Workspace reads no stage's draft, so the stages below read theirs for the first time once the connection is down
     (the shell already holds the project, so its own head stays). */
  const { errors } = await open(page, "/suites?view=workspace&tab=general", "workspace-view");
  let down = true;
  await page.route(/\/api\/workbench\/projects\?id=/, (route) => (down && route.request().method() === "GET" ? route.fulfill({ status: 503, json: { error: "Studio could not load this project (503)." } }) : route.fallback()));
  await page.getByRole("tablist", { name: "Suites" }).getByRole("tab", { name: "Studio" }).click();
  const strip = page.getByRole("navigation", { name: "Pages" });
  for (const [tab, alert] of [[/Deliver/, "[data-testid='stage-work'] [role='alert']"], [/Edit & Sound/, ".pxw-edit [role='alert']"]] as const) {
    await strip.getByRole("button", { name: tab }).click();
    const failed = page.locator(alert).filter({ hasText: "could not load this project" });
    await expect(failed).toBeVisible();
    await expect(failed.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(failed.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  }
  down = false;
  /* Pressed from the keyboard: on a portrait phone a legacy page body's last row can still end under the tab bar (the
     stage's clearance for it is the phone chrome's work); this test is about the word, and that the read comes back. */
  await page.locator(".pxw-edit [role='alert']").getByRole("button", { name: "Try again", exact: true }).press("Enter");
  await expect(page.getByTestId("assembly")).toBeVisible();
  expect(errors).toEqual([]);
});
