import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * The phone's chrome, measured (owner-approved compaction, 27 September 2026).
 * Every layer between the screen's edge and the page — safe areas, the header
 * island, the suite and page strips, the project and page heads, Gen's sticky
 * Generate band, the Library overlay's own head, search and chips, the tab bar,
 * a toast — and what is left for the page itself. On a portrait phone the page
 * gets at least 60% of the screen on Takes, Gen, Rig and Brief; nothing is
 * smaller than main left it; the floors hold; the last row of every page ends
 * above the tab bar; what moved behind the context badge is one tap away; and a
 * desktop's chrome is where it was.
 *
 * Screenshots and numbers are opt-in: PHONE_CHROME_SHOTS names a folder for a
 * screenshot of every page at every size, PHONE_CHROME_REPORT a folder for the
 * numbers as JSON. CI writes neither.
 */
const SHOTS = process.env.PHONE_CHROME_SHOTS;
const REPORT = process.env.PHONE_CHROME_REPORT;
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
const PHONES = [...PORTRAIT, "workbench-844x390"];
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];

const node = (id: string, title: string, x: number, y: number, linked: string[] = []): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked, role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});
const fixture = (): Project => ({
  ...newProject("Harbour at dusk"), id: "ws-chrome", productionProjectId: "prod-ws", shotMappings: {},
  brief: "A fox crosses a frozen harbour at dusk and meets the keeper of the light",
  shots: [{ id: "s1", name: "The crossing", assetId: "", duration: 5, sourceIn: 0, note: "" }],
  nodes: [node("a", "The long approach across the frozen harbour", 100, 100), node("b", "The encounter", 460, 100, ["a"]), node("c", "Departure", 820, 100)],
} as Project);
const TAKES = Array.from({ length: 10 }, (_, i) => generation({ id: `gen_take_${i}`, title: `Take ${i + 1} on the water`, prompt: `Take ${i + 1} on the water` }));

async function open(page: Page, path: string, named = true, atomik = false) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  /* Atomik's run engine, answered here: a quote of 12 cr and nothing dispatched (these specs never approve). */
  if (atomik) await page.route("**/api/workbench/atomik**", (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { configured: false, models: [], jobs: [] } });
    if ((request.postDataJSON() as { quoteOnly?: unknown } | null)?.quoteOnly === true) return route.fulfill({ json: { estimateCredits: 12, estimateUsd: 1.2, quoteOnly: true } });
    throw new Error("The phone chrome spec never approves an Atomik run.");
  });
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })], generations: TAKES });
  await page.route("**/api/workbench/engines**", (route) => route.fulfill({ json: { credits: 18, models: [] } }));
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  await page.route("**/api/crew/members?*", (route) => route.fulfill({ json: { members: [] } }));
  await page.goto(path);
  /* The Workspace view has no project head. */
  if (named) await expect(page.getByTestId("project-name")).toHaveText("Harbour at dusk");
}

/** Every entrance animation on the page has settled (the shell's `gx-in` rise moves what is measured). */
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));

/**
 * Atomik's approval row up: a paid plan stopped at its gate and the sheet closed, so the run waits under the island
 * on every page. Then Atomik's Tools page (its page id stays `skills`), where #394 found the stage left ~30px.
 */
async function gateRowUp(page: Page) {
  await page.getByTestId("primary-action").click();
  await expect(page.getByTestId("atomik-gate")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("suites-atomik-gate")).toBeVisible();
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Skills|Tools/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText(/^(Skills|Tools & connections)$/);
  await expect(page.getByTestId("suites-atomik-gate")).toBeVisible();
}

/** The Library's Assets: the tab bar's Assets on a portrait phone; elsewhere the page head's Library, then its Assets tab. */
async function openAssets(page: Page) {
  if (await page.getByTestId("tabbar-assets").isVisible()) { await page.getByTestId("tabbar-assets").click(); return; }
  await page.getByTestId("toggle-library").click();
  const tab = page.getByTestId("library").getByRole("tab", { name: /Assets/ });
  if (await tab.count()) await tab.click();
}

type Box = { top: number; bottom: number; height: number; outer: number };
type Measure = { layers: Record<string, Box | null>; safe: Record<string, number>; content: { top: number; bottom: number; height: number; share: number }; overflowX: number };

/**
 * The chrome's layers as they stand, and the part of `target` a person sees:
 * inside every scroller it sits in, above the tab bar and Gen's Generate band, on screen.
 */
function measure(page: Page, target: string): Promise<Measure> {
  return page.evaluate((target) => {
    const vh = window.innerHeight;
    const shown = (el: Element | null): el is HTMLElement => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const box = (selector: string): Box | null => {
      const el = Array.from(document.querySelectorAll(selector)).find(shown);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const outer = r.height + (Number.parseFloat(s.marginTop) || 0) + (Number.parseFloat(s.marginBottom) || 0);
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), outer: Math.round(outer) };
    };
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.appendChild(probe);
    const ps = getComputedStyle(probe);
    const safe = { top: Number.parseFloat(ps.paddingTop), right: Number.parseFloat(ps.paddingRight), bottom: Number.parseFloat(ps.paddingBottom), left: Number.parseFloat(ps.paddingLeft) };
    probe.remove();
    const layers: Record<string, Box | null> = {
      header: box(".gx-header"),
      suiteStrip: box(".gx-header .gx-seg"),
      pageStrip: box(".gx-strip"),
      gateRow: box(".gx-gate"),
      projectHead: box(".gx-project"),
      pageHead: box(".gx-main .gx-pagehead"),
      generateBand: box(".gx-gen-cta"),
      libraryHead: box(".gx-library .gx-panel-head"),
      libraryTabs: box(".gx-library > .gx-seg"),
      librarySearch: box(".gx-library > .gx-field"),
      libraryChips: box(".gx-library > .gx-chips"),
      libraryFoot: box(".gx-library > .gx-lib-foot"),
      workspaceHead: box(".gx-workspace .wsx > .gx-h1"),
      workspaceTabs: box(".gx-workspace .wsx > .gx-seg"),
      tabBar: box(".gx-tabbar"),
      toast: box("[data-testid='toast']"),
    };
    const el = Array.from(document.querySelectorAll(target)).find(shown);
    let top = 0, bottom = 0;
    if (el) {
      const r = el.getBoundingClientRect();
      top = Math.max(0, r.top); bottom = Math.min(vh, r.bottom);
      for (let up = el.parentElement; up; up = up.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(up).overflowY)) { const u = up.getBoundingClientRect(); top = Math.max(top, u.top); bottom = Math.min(bottom, u.bottom); }
      }
      const bar = document.querySelector(".gx-tabbar");
      if (shown(bar) && getComputedStyle(bar).position === "fixed") bottom = Math.min(bottom, bar.getBoundingClientRect().top);
      const band = document.querySelector(".gx-gen-cta");
      if (shown(band) && getComputedStyle(band).position === "sticky") bottom = Math.min(bottom, band.getBoundingClientRect().top);
    }
    const height = Math.max(0, Math.round(bottom - top));
    return { layers, safe, content: { top: Math.round(top), bottom: Math.round(bottom), height, share: Math.round((height / vh) * 1000) / 10 }, overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) };
  }, target);
}

type Screen = { id: string; path?: string; named?: false; atomik?: true; target: string; pane: string; ready: (page: Page) => Promise<void> };
const SCREENS: Screen[] = [
  { id: "home", path: "/suites?suite=studio&page=brief&sp=home", target: "[data-testid='content']", pane: "[data-testid='content']", ready: async (page) => { await expect(page.getByTestId("suite-home")).toBeVisible(); } },
  { id: "takes", path: "/suites?suite=particl&page=takes&sp=takes", target: "[data-testid='content']", pane: "[data-testid='content']", ready: async (page) => { await expect(page.getByTestId("edit-takes")).toBeVisible(); } },
  { id: "gen", path: "/suites?view=gen", target: "[data-testid='content']", pane: "[data-testid='content']", ready: async (page) => { await expect(page.getByTestId("gen-view")).toBeVisible(); await expect(page.locator(".gx-gen-go")).toBeVisible(); } },
  { id: "rig-list", path: "/suites?suite=studio&page=rig", target: "[data-testid='content']", pane: "[data-testid='content']", ready: async (page) => { await expect(page.getByTestId("rig-list").locator(".pxw-rig-row")).toHaveCount(3); } },
  { id: "rig-canvas", target: "[data-testid='rig-graph-surface']", pane: "[data-testid='content']", ready: async (page) => {
    await page.locator(".gx-pagehead").getByRole("tab", { name: "Canvas" }).click();
    await expect(page.getByTestId("rig-graph-surface")).toBeVisible();
  } },
  { id: "brief", path: "/suites?suite=studio&page=brief&sp=brief", target: "[data-testid='content']", pane: "[data-testid='content']", ready: async (page) => { await expect(page.getByTestId("brief-stage")).toBeVisible(); } },
  { id: "library", target: "[data-testid='library-assets']", pane: "[data-testid='library-assets']", ready: async (page) => {
    await openAssets(page);
    await expect(page.getByTestId("library-assets").locator(".gx-asset").first()).toBeVisible();
  } },
  { id: "plans", path: "/suites?view=workspace&tab=credits", named: false, target: "[data-testid='workspace-view']", pane: "[data-testid='workspace-view']", ready: async (page) => { await expect(page.getByTestId("workspace-view")).toBeVisible(); } },
  { id: "atomik-gate", path: "/suites?suite=atomik&page=agent&sp=agent", atomik: true, target: "[data-testid='content']", pane: "[data-testid='content']", ready: gateRowUp },
];

/** What main left for the page (px), measured with this spec on 27 September 2026: the floor nothing may fall under. */
const BEFORE: Record<string, Record<string, number>> = {
  "360x640": { home: 365, takes: 127, gen: 150, "rig-list": 180, "rig-canvas": 0, brief: 187, library: 8, plans: 370, "atomik-gate": 0 },
  "390x844": { home: 569, takes: 331, gen: 351, "rig-list": 384, "rig-canvas": 0, brief: 388, library: 212, plans: 626, "atomik-gate": 193 },
  "844x390": { home: 255, takes: 124, gen: 182, "rig-list": 124, "rig-canvas": 0, brief: 130, library: 0, plans: 330, "atomik-gate": 69 },
};
/** On a portrait phone these pages get at least 60% of the screen; with Atomik's approval row up (itself something to press), at least half. */
const TARGETS = ["takes", "gen", "rig-list", "rig-canvas", "brief"];
const WITH_GATE = ["atomik-gate"];

test("phone chrome: every layer measured, and the page gets most of the screen", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone sizes");
  const size = info.project.name.replace("workbench-", "");
  const vh = page.viewportSize()!.height;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const report: Record<string, Measure> = {};
  for (const screen of SCREENS) {
    if (screen.path) await open(page, screen.path, screen.named ?? true, screen.atomik ?? false);
    await screen.ready(page);
    await settle(page);
    report[screen.id] = await measure(page, screen.target);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${size}-${screen.id}.png`), animations: "disabled" }); }
  }
  /* A toast, where it sits: the Library's + sends a still to Gen and says so. */
  await open(page, "/suites?suite=particl&page=takes&sp=takes");
  await openAssets(page);
  await page.getByTestId("library-assets").locator(".gx-asset-add:not(:disabled)").first().click();
  await expect(page.getByTestId("toast")).toBeVisible();
  await settle(page);
  report.toast = await measure(page, "[data-testid='content']");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${size}-toast.png`), animations: "disabled" });
  if (REPORT) { mkdirSync(REPORT, { recursive: true }); writeFileSync(join(REPORT, `${size}.json`), JSON.stringify(report, null, 2)); }
  await info.attach(`chrome-${size}.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });

  for (const screen of SCREENS) {
    const { content, overflowX } = report[screen.id];
    expect.soft(overflowX, `${screen.id}: no sideways page scroll`).toBe(0);
    expect.soft(content.height, `${screen.id}: never less than main left it (${BEFORE[size][screen.id]}px)`).toBeGreaterThanOrEqual(BEFORE[size][screen.id]);
    if (PORTRAIT.includes(info.project.name) && TARGETS.includes(screen.id))
      expect.soft(content.height, `${screen.id}: at least 60% of ${vh}px for the page`).toBeGreaterThanOrEqual(Math.ceil(vh * 0.6));
    if (PORTRAIT.includes(info.project.name) && WITH_GATE.includes(screen.id))
      expect.soft(content.height, `${screen.id}: at least half of ${vh}px for the page`).toBeGreaterThanOrEqual(Math.ceil(vh * 0.5));
    if (!PORTRAIT.includes(info.project.name) && (TARGETS.includes(screen.id) || WITH_GATE.includes(screen.id) || screen.id === "library"))
      expect.soft(content.height, `${screen.id}: at least half of landscape height remains usable`).toBeGreaterThanOrEqual(Math.ceil(vh * 0.5));
    if (PORTRAIT.includes(info.project.name) && screen.id === "library")
      expect.soft(content.height, "files stay visible below the Library controls").toBeGreaterThanOrEqual(Math.ceil(vh * 0.25));
  }
  /* The owner's measure: Takes at 360×640 showed 127px of its page. */
  if (size === "360x640") expect(report.takes.content.height).toBeGreaterThanOrEqual(380);
  /* The toast rests above the tab bar, never on it. */
  const { toast, tabBar } = report.toast.layers;
  expect(toast, "the toast is up").not.toBeNull();
  if (tabBar && PORTRAIT.includes(info.project.name)) expect(toast!.bottom).toBeLessThanOrEqual(tabBar.top);
  expect(errors).toEqual([]);
});

/**
 * The lowest thing in a scroll pane, where it lands at the pane's end (`scroll`) and when it is revealed on its
 * own (`reveal`: scrollIntoView, as a Retry or a new take is brought into view). Anything inside a nested
 * scroller or a sticky or fixed block is that block's; the pane's own bottom padding does not count.
 */
function lastRow(page: Page, pane: string, how: "scroll" | "reveal") {
  return page.evaluate(({ pane, how }) => {
    const root = document.querySelector<HTMLElement>(pane);
    if (!root) return null;
    root.scrollTop = 0;
    const own = (el: HTMLElement) => {
      for (let up: HTMLElement | null = el; up && up !== root; up = up.parentElement) {
        const s = getComputedStyle(up);
        if (s.position === "fixed" || s.position === "sticky") return false;
        if (up !== el && (s.overflowY !== "visible" || s.overflowX !== "visible")) return false;
      }
      return true;
    };
    const rows = Array.from(root.querySelectorAll<HTMLElement>("*")).filter((el) => {
      const r = el.getBoundingClientRect();
      /* checkVisibility: a closed <details>' content is laid out but never shown. */
      return r.width > 1 && r.height > 1 && el.checkVisibility({ visibilityProperty: true }) && own(el);
    });
    if (!rows.length) return null;
    const lowest = rows.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a));
    if (how === "scroll") root.scrollTop = root.scrollHeight;
    else lowest.scrollIntoView({ block: "end" });
    const bar = document.querySelector(".gx-tabbar");
    const barTop = bar && bar.getClientRects().length ? bar.getBoundingClientRect().top : innerHeight;
    return { bottom: Math.round(lowest.getBoundingClientRect().bottom * 10) / 10, barTop, name: String(lowest.className || lowest.tagName).slice(0, 40) };
  }, { pane, how });
}

test("phone: the last row of every page ends above the tab bar, scrolled to or revealed", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "the portrait phones, where the tab bar floats over the page");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const screen of SCREENS) {
    if (screen.path) await open(page, screen.path, screen.named ?? true, screen.atomik ?? false);
    await screen.ready(page);
    await settle(page);
    for (const how of ["scroll", "reveal"] as const) {
      const last = await lastRow(page, screen.pane, how);
      expect(last, `${screen.id}: a pane with rows`).not.toBeNull();
      expect.soft(last!.bottom, `${screen.id} (${how}): ${last!.name} ends above the tab bar`).toBeLessThanOrEqual(last!.barTop + 0.5);
    }
  }
  expect(errors).toEqual([]);
});

test("phone: with Atomik's approval row up, a page that failed offers Try again above the tab bar, uncovered", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "the portrait phones, where the tab bar floats over the page");
  /* #392's development-only probe: the Tools page's stage throws as it renders, so its fault card stands in for it. */
  await page.addInitScript(() => { (window as unknown as { __particlCrash?: string[] }).__particlCrash = ["stage:skills"]; });
  await open(page, "/suites?suite=atomik&page=agent&sp=agent", true, true);
  await gateRowUp(page);
  const fault = page.locator('[data-testid="panel-fault"][data-fault="stage:skills"]');
  await expect(fault).toBeVisible();
  await settle(page);
  const retry = fault.getByTestId("fault-retry");
  const vh = page.viewportSize()!.height;
  expect((await measure(page, "[data-testid='content']")).content.height, "the page keeps at least half the screen").toBeGreaterThanOrEqual(Math.ceil(vh * 0.5));
  /* Revealed the way the shell reveals it, and the way Playwright's own tap would: above the bar, and the tap is the button's. */
  for (const reveal of [() => retry.evaluate((el) => el.scrollIntoView({ block: "end" })), () => retry.scrollIntoViewIfNeeded()]) {
    await reveal();
    const hit = await retry.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { bottom: box.bottom, bar: document.querySelector(".gx-tabbar")!.getBoundingClientRect().top, onTop: Boolean(top && (top === el || el.contains(top))) };
    });
    expect(hit.bottom, "Try again ends above the tab bar").toBeLessThanOrEqual(hit.bar + 0.5);
    expect(hit.onTop, "nothing covers Try again").toBe(true);
  }
  /* Fixed underneath, the tap brings the page back, with the approval still waiting above it. */
  await page.evaluate(() => { (window as unknown as { __particlCrash?: string[] }).__particlCrash = []; });
  await retry.click();
  await expect(fault).toHaveCount(0);
  await expect(page.getByTestId("suites-atomik-gate")).toBeVisible();
});

test("phone: the chrome keeps the floors on every page — 44px targets, no label under #7C7C84, nothing sideways", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone sizes");
  for (const screen of SCREENS) {
    if (screen.path) await open(page, screen.path, screen.named ?? true, screen.atomik ?? false);
    await screen.ready(page);
    await settle(page);
    expect.soft(await smallTargets(page, ".gx-header, .gx-strip, .gx-project, .gx-main > .gx-pagehead, .gx-tabbar"), `${screen.id}: chrome targets under 44×44`).toEqual([]);
    expect.soft(await dimLabels(page, ".gx"), `${screen.id}: labels under #7C7C84`).toEqual([]);
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${screen.id}: sideways`).toBeLessThanOrEqual(0);
  }
});

test("phone: the Suites and Search wait behind the context badge, one tap away; the page head's glyphs and the bar's switcher work", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "the phone sizes");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "/suites?suite=studio&page=rig");
  await expect(page.getByTestId("rig-list")).toBeVisible();
  const badge = page.getByTestId("suites-menu");
  const suites = page.getByRole("tablist", { name: "Suites" });
  /* Closed: the badge names where you are; the Suites and Search take no room. */
  await expect(badge).toBeVisible();
  await expect(page.getByTestId("suite-mark")).toHaveText("STUDIO");
  await expect(badge).toHaveAttribute("aria-expanded", "false");
  await expect(suites).toBeHidden();
  await expect(page.getByTestId("header-search")).toBeHidden();

  /* One tap: all six suites and Search, each a 44px target on screen; the one you are in is lit. */
  await badge.click();
  await expect(badge).toHaveAttribute("aria-expanded", "true");
  await expect(suites.getByRole("tab")).toHaveText(["Studio", "Gen", "Business", "Viral", "Atomik", "Crew"]);
  await expect(suites.getByRole("tab", { name: "Studio" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("header-search")).toBeVisible();
  await settle(page);
  for (const target of [...await suites.getByRole("tab").all(), page.getByTestId("header-search")]) await expect(target).toBeInViewport();
  expect(await smallTargets(page, ".gx-header"), "menu targets under 44×44").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${info.project.name.replace("workbench-", "")}-menu.png`), animations: "disabled" }); }

  /* A pick goes there and closes the menu. */
  await suites.getByRole("tab", { name: "Business" }).click();
  await expect(page.getByTestId("suite-mark")).toHaveText("BUSINESS");
  await expect(badge).toHaveAttribute("aria-expanded", "false");
  await expect(suites).toBeHidden();

  /* Search is the menu's first row: it opens ⌘K's sheet and the menu closes behind it. */
  await badge.click();
  await page.getByTestId("header-search").click();
  await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
  await expect(badge).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Search" })).toHaveCount(0);

  /* A tap anywhere else, or Escape, closes it without going anywhere. */
  await badge.click();
  await expect(suites).toBeVisible();
  if (PORTRAIT.includes(info.project.name)) await page.getByTestId("tabbar").click({ position: { x: 4, y: 29 } });
  else await page.getByTestId("content").click({ position: { x: 700, y: 20 } });
  await expect(suites).toBeHidden();
  await badge.click();
  await page.keyboard.press("Escape");
  await expect(suites).toBeHidden();
  await expect(page.getByTestId("suite-mark")).toHaveText("BUSINESS");
  /* Going anywhere from the header itself (the credits) leaves it closed where you land. */
  await badge.click();
  await page.getByTestId("workspace-credits").click();
  await expect(page.getByTestId("workspace-view")).toBeVisible();
  await expect(badge).toHaveAttribute("aria-expanded", "false");
  await expect(suites).toBeHidden();

  /* The page head's Library and Inspector are their glyphs, named in words, and open their panels. */
  await open(page, "/suites?suite=studio&page=rig");
  await expect(page.getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByTestId("library")).toBeVisible();
  await page.getByTestId("close-library").click();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(page.getByTestId("inspector")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector")).toHaveCount(0);

  /* The primary keeps its price whole, under its action. */
  const primary = page.getByTestId("primary-action");
  await expect(primary).toHaveText("Generate · 18 cr");
  const [act, price] = await Promise.all([primary.locator(".gx-go-act").boundingBox(), primary.locator(".gx-go-price").boundingBox()]);
  expect(price!.y).toBeGreaterThan(act!.y + act!.height - 1);

  /* The bar's project switcher opens the project list; the strip shows the page you are on. */
  await page.getByTestId("project-switcher").click();
  await expect(page.getByRole("listbox", { name: "Projects" }).getByRole("option", { name: /Harbour at dusk/ })).toBeInViewport();
  await page.keyboard.press("Escape");
  const strip = page.getByRole("navigation", { name: "Pages" });
  await expect(strip.getByRole("button", { name: /Rig/ })).toHaveAttribute("aria-current", "page");
  const [bar, tab] = await Promise.all([strip.boundingBox(), strip.getByRole("button", { name: /Rig/ }).boundingBox()]);
  expect(tab!.x).toBeGreaterThanOrEqual(bar!.x - 0.5);
  expect(tab!.x + tab!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 0.5);
  expect(errors).toEqual([]);
});

/** Where the desktop chrome sits: the parts that do not depend on a font's widths. */
function desktopChrome(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, number[] | null> = {};
    const r1 = (n: number) => Math.round(n * 10) / 10;
    for (const [name, selector, whole] of [
      ["header", ".gx-header", true], ["strip", ".gx-strip", true], ["project", ".gx-project", true], ["pagehead", ".gx-main > .gx-pagehead", true],
      ["content", "[data-testid='content']", true], ["library", "[data-testid='library']", true], ["avatar", "[data-testid='workspace-avatar']", true],
      ["brand", ".gx-brand", false], ["badge", "[data-testid='suite-mark']", false], ["suites", ".gx-header .gx-seg", false], ["search", "[data-testid='header-search']", false],
      ["credits", "[data-testid='workspace-credits']", false], ["title", "[data-testid='page-title']", false], ["views", ".gx-pagehead .gx-seg", false],
      ["inspector", "[data-testid='toggle-inspector']", false], ["primary", "[data-testid='primary-action']", false],
    ] as const) {
      const el = document.querySelector<HTMLElement>(selector);
      const r = el && el.getClientRects().length ? el.getBoundingClientRect() : null;
      /* A box whose width is its words' is pinned by its top and height only. */
      out[name] = r ? (whole ? [r1(r.left), r1(r.top), r1(r.width), r1(r.height)] : [r1(r.top), r1(r.height)]) : null;
    }
    return out;
  });
}

/* main's desktop chrome (27 September 2026), for the two desktops; W and H are the viewport. */
const desktopBefore = (W: number, H: number): Record<string, Record<string, number[] | null>> => {
  const suite = {
    header: [10, 10, W - 20, 64], strip: [10, 84, W - 20, 48], project: [301, 143, W - 642, 75], pagehead: [301, 218, W - 642, 66.7],
    content: [301, 284.7, W - 642, H - 295.7], library: [10, 142, 280, H - 152], avatar: [W - 61, 27, 30, 30],
    brand: [31.1, 21.8], badge: [32, 20], suites: [23, 38], search: [26, 32], credits: [26, 32], title: [232, 37.7],
  };
  return {
    rig: { ...suite, views: [232.8, 36], inspector: [234.8, 32], primary: [233.8, 34] },
    takes: { ...suite, views: [232.8, 36], inspector: [234.8, 32], primary: null },
    gen: {
      ...suite, strip: null, project: [301, 85, W - 642, 75], pagehead: [301, 160, W - 642, 66.7], content: [301, 226.7, W - 642, H - 237.7], library: [10, 84, 280, H - 94],
      title: [174, 37.7], views: null, inspector: null, primary: null,
    },
  };
};

test("desktop: the chrome is where it was — the islands, the heads, words on the toggles, the price on one line", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "the two desktops");
  const { width, height } = page.viewportSize()!;
  const size = info.project.name.replace("workbench-", "");
  const expected = desktopBefore(width, height);
  const seen: Record<string, Record<string, number[] | null>> = {};
  for (const [id, path] of [["rig", "/suites?suite=studio&page=rig"], ["takes", "/suites?suite=particl&page=takes&sp=takes"], ["gen", "/suites?view=gen"]] as const) {
    await open(page, path);
    if (id === "rig") await expect(page.getByTestId("primary-action")).toHaveText("Generate · 18 cr");
    if (id === "gen") await expect(page.getByTestId("gen-view")).toBeVisible();
    await settle(page);
    seen[id] = await desktopChrome(page);
    for (const [name, box] of Object.entries(expected[id])) {
      if (box === null) { expect.soft(seen[id][name], `${id} › ${name}: absent`).toBeNull(); continue; }
      const got = seen[id][name];
      expect.soft(got, `${id} › ${name}`).not.toBeNull();
      if (got) box.forEach((n, i) => expect.soft(Math.abs(got[i] - n), `${id} › ${name}[${i}]: ${got[i]} vs ${n}`).toBeLessThanOrEqual(0.5));
    }
    /* The phone's parts stay out of a desktop: no badge button, the Suites inline, Search in the header, words on the toggles. */
    await expect(page.getByTestId("suites-menu")).toHaveCount(0);
    await expect(page.locator(".gx-brand [data-testid='suite-mark']")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Suites" }).getByRole("tab")).toHaveCount(6);
    await expect(page.getByTestId("header-search")).toContainText("Search");
    await expect(page.locator(".gx-bar")).toHaveCount(0);
    for (const toggle of await page.locator(".gx-hbtn--glyph").all()) {
      await expect(toggle.locator(".gx-hbtn-glyph")).toBeHidden();
      expect((await toggle.locator(".gx-hbtn-label").boundingBox())!.width).toBeGreaterThan(20);
    }
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${size}-${id}.png`), animations: "disabled" }); }
  }
  if (REPORT) { mkdirSync(REPORT, { recursive: true }); writeFileSync(join(REPORT, `${size}-desktop.json`), JSON.stringify(seen, null, 2)); }
});
