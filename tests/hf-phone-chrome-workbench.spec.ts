import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { dimLabels, lastRowClearsPinned, smallTargets, smallText } from "./phoneFloors";
import { COMPACT, DESKTOP, isCompact, shellIsPhone } from "./helpers/shellMode";

/**
 * The phone's chrome, measured (Release 1). At compact widths the shell mounts the phone's own app (components/graphite/phone/PhoneApp.tsx):
 * a header with the credits, the tab bar, and one screen between them. The old layers this file used to measure (the header island, the
 * suite and page strips, the project and page heads, Gen's sticky Generate band, the Library overlay's head, the tab bar of the old shell)
 * are not mounted there; the measures that still mean something are kept and read from the phone's own layers:
 *
 *  - every layer between the screen's edge and the screen's page is measured, and the page gets most of the screen on Home, Make and the Record;
 *  - the floors hold on each of them (44px targets, 12px text, no label dimmer than the floor, nothing sideways);
 *  - the last row of each screen ends above the tab bar;
 *  - rotation keeps the screen visible without moving it sideways;
 *  - a desktop mounts none of this and keeps its own header.
 *
 * The phone's own behaviour (approving from Home, review, Make's price on its button, the Atomik sheet) is tests/demo-s10-*; this file holds
 * only what the chrome around them takes from the screen. Nothing is sent: forbidPaidWork.
 */
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];

const fixture = (): Project => ({
  ...newProject("Harbour at dusk"), id: "ws-chrome", productionProjectId: "prod-ws", shotMappings: {},
  brief: "A fox crosses a frozen harbour at dusk and meets the keeper of the light",
} as Project);
const TAKES = Array.from({ length: 10 }, (_, i) => generation({ id: `gen_take_${i}`, title: `Take ${i + 1} on the water`, prompt: `Take ${i + 1} on the water`, shotId: `shot_${i % 3}`, shotCode: `SH0${(i % 3) + 1}`, version: 1 + Math.floor(i / 3) }));

async function open(page: Page, path: string, ready: string) {
  const sent: string[] = [];
  const errors: string[] = [];
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: TAKES });
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: { items: [], decided: [], inCredits: true } }));
  await page.route(/\/api\/control-room\/activity/, (route) => route.fulfill({ json: { inCredits: true, productionId: "prod-ws", projects: [], runs: [] } }));
  await page.route(/\/api\/jobs\?view=tray/, (route) => route.fulfill({ json: { jobs: [], pollAfterSeconds: 60 } }));
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  page.on("request", (request) => { if (request.method() !== "GET" && /\/api\/(generate|workbench\/team-canvas|pipelines|atomik)/.test(request.url())) sent.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId(ready)).toBeVisible();
  /* Entrance animations settle before anything is measured. */
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
  return { sent, errors };
}

/** The screens the phone draws that carry the page, with the test id that says each is up. */
const SCREENS = [
  { id: "home", path: "/suites?view=home", ready: "phone-home" },
  { id: "make", path: "/suites?screen=make", ready: "phone-make" },
  { id: "record", path: "/suites?screen=record", ready: "phone-record" },
] as const;

/** What the header and the tab bar take, and what is left between them for the screen. */
function layers(page: Page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const rect = (selector: string) => {
      const el = Array.from(document.querySelectorAll(selector)).find((e) => e.getClientRects().length > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height), width: Math.round(r.width) };
    };
    const header = rect('[data-testid="phone-header"]');
    const tabs = rect('[data-testid="mobile-dock"]');
    const scroller = rect('[data-testid="mobile-scroll"]');
    const top = header ? header.bottom : 0;
    /* The tab bar sits under the screen on a portrait phone; on a landscape one it may sit at the side, and then it takes width, not height. */
    const bottom = tabs && tabs.width >= window.innerWidth - 2 ? tabs.top : vh;
    return { vh, header, tabs, scroller, page: Math.max(0, bottom - top), overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) };
  });
}

test("phone chrome: every layer measured, and the screen gets most of the page", async ({ page }, info) => {
  test.skip(!isCompact(info), "the phone's own chrome; a desktop's is the last test");
  const portrait = PORTRAIT.includes(info.project.name);
  for (const screen of SCREENS) {
    const { sent, errors } = await open(page, screen.path, screen.ready);
    const m = await layers(page);
    expect(m.header, `${screen.id}: the phone's header is up`).not.toBeNull();
    expect(m.tabs, `${screen.id}: the tab bar is up`).not.toBeNull();
    expect(m.overflowX, `${screen.id}: no sideways page scroll`).toBe(0);
    /* Header and tab bar together leave the screen at least 60% of a portrait phone and half of a landscape one. */
    expect.soft(m.page, `${screen.id}: the screen between the header and the tab bar`).toBeGreaterThanOrEqual(Math.ceil(m.vh * (portrait ? 0.6 : 0.5)));
    /* Nothing the chrome draws is wider than the screen, and the header ends where the screen begins. */
    expect(m.header!.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(sent, `${screen.id}: nothing is sent just by looking`).toEqual([]);
    expect(errors).toEqual([]);
  }
});

test("phone: the floors hold on every screen the phone draws, and the last row ends above the tab bar", async ({ page }, info) => {
  test.skip(!isCompact(info), "the phone's own screens");
  for (const screen of SCREENS) {
    await open(page, screen.path, screen.ready);
    expect(await smallText(page), `${screen.id}: text under 12px`).toEqual([]);
    expect(await smallTargets(page, ".ph-app"), `${screen.id}: targets under 44×44`).toEqual([]);
    expect(await dimLabels(page, ".ph-app"), `${screen.id}: labels under the floor`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${screen.id}: nothing sideways`).toBe(true);
    expect(await lastRowClearsPinned(page), `${screen.id}: the last row clears the tab bar`).toEqual([]);
  }
});

test("phone: rotation keeps the current screen visible without moving it sideways", async ({ page }, info) => {
  test.skip(!isCompact(info), "the phone sizes");
  await open(page, "/suites?view=home", "phone-home");
  const original = page.viewportSize()!;
  const rotated = original.width < 768 ? { width: 844, height: 390 } : { width: 390, height: 844 };
  for (const viewport of [original, rotated, original]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("phone-home")).toBeVisible();
    await expect(page.getByTestId("phone-header")).toBeVisible();
    await expect(page.getByTestId("mobile-dock")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }
});

test("a desktop mounts none of the phone's chrome and keeps its header, with the credits and the avatar", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop widths");
  expect(COMPACT).not.toContain(info.project.name);
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: TAKES });
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("workspace-credits")).toBeVisible();
  await expect(page.getByTestId("workspace-avatar")).toBeVisible();
  await expect(page.getByTestId("phone-app")).toHaveCount(0);
  expect(await shellIsPhone(page)).toBe(false);
});
