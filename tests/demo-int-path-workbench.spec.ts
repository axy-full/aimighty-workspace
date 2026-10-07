import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { seedBoard } from "./helpers/s03-board";

/**
 * Integration · the whole demo path with the new interface on, in one session: Home, the board (each region), Make, Atomik,
 * the control room, Settings, and the phone. It asserts that each address mounts the screen the registry says, that nothing
 * throws, and that nothing scrolls sideways; with INT_SHOTS set it also files a screenshot of every step. Local ENGINE_MOCK
 * server; nothing is pressed that spends.
 */
const SHOTS = process.env.INT_SHOTS;
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const COMPACT = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { width, height } = page.viewportSize()!;
  await page.screenshot({ path: `${SHOTS}/${String(shotNo++).padStart(2, "0")}-${name}-${width}x${height}.png` });
}
let shotNo = 1;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("the demo path: Home, board regions, Make, Atomik, the control room, Settings, the phone", async ({ page }, info) => {
  test.skip(![...DESKTOP, ...COMPACT].includes(info.project.name), "every configured viewport");
  test.setTimeout(420_000);
  shotNo = 1;
  const compact = COMPACT.includes(info.project.name);
  const { project } = await seedBoard(page);
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  const at = (search: string) => `/suites?project=${project.id}${search}`;
  const body = page.locator(".gx");

  /* Home. */
  await page.goto("/suites?view=home");
  await expect(body).toBeVisible({ timeout: 60_000 });
  if (compact) await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
  else await expect(body).toHaveAttribute("data-screen", "home", { timeout: 60_000 });
  await page.waitForTimeout(800);
  await shot(page, "home");
  expect(await noSideways(page), "home: no sideways scroll").toBe(true);

  /* The board: the whole board, then each region. On a phone, a project opens its Record, not a canvas. */
  if (!compact) {
    await page.goto(at("&view=board"));
    await expect(body).toHaveAttribute("data-screen", "board", { timeout: 60_000 });
    await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(800);
    await shot(page, "board");
    for (const region of ["brief", "looks", "storyboard", "shots", "cast", "cut", "deliver"]) {
      await page.goto(at(`&view=board&region=${region}`));
      await expect(body).toHaveAttribute("data-screen", "board", { timeout: 60_000 });
      await expect(page.getByTestId("board-rail")).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(1200);
      await shot(page, `board-${region}`);
    }
    await page.goto(at("&view=board&list=1"));
    await expect(body).toHaveAttribute("data-screen", "board", { timeout: 60_000 });
    await page.waitForTimeout(600);
    await shot(page, "board-list");
  } else {
    await page.goto(at("&view=board"));
    await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1000);
    await shot(page, "project-record");
  }

  /* Make: a panel over the board on a laptop; the phone's own on a phone. */
  await page.goto(at(compact ? "&screen=make" : "&view=board&make=video"));
  if (compact) await expect(page.getByTestId("phone-make-prompt")).toBeVisible({ timeout: 60_000 });
  else await expect(page.getByTestId("make-panel")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await shot(page, "make");

  /* Atomik: the docked panel over the board; the sheet on a phone. */
  await page.goto(at(compact ? "&atomik=1" : "&view=board&atomik=1"));
  if (!compact) await expect(page.getByTestId("atomik-panel-global")).toBeVisible({ timeout: 60_000 });
  else await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await shot(page, "atomik");

  /* The control room. */
  for (const [slug, search] of [["approvals", "&suite=atomik&page=approvals"], ["activity", "&suite=atomik&page=runs"]] as const) {
    await page.goto(at(search));
    if (!compact) await expect(body).toHaveAttribute("data-screen", "control-room", { timeout: 60_000 });
    else await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1000);
    await shot(page, `control-room-${slug}`);
    expect(await noSideways(page), `${slug}: no sideways scroll`).toBe(true);
  }

  /* Settings, in its sections. */
  for (const section of ["team", "credits", "rules"]) {
    await page.goto(at(`&view=workspace&ws=${section}`));
    if (!compact) await expect(body).toHaveAttribute("data-screen", "settings", { timeout: 60_000 });
    else await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1000);
    await shot(page, `settings-${section}`);
    expect(await noSideways(page), `settings ${section}: no sideways scroll`).toBe(true);
  }

  /* The phone, framed on a laptop (device=phone), plain at compact widths. */
  if (!compact) {
    await page.goto("/suites?device=phone");
    await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1000);
    await shot(page, "phone-framed-home");
    await page.goto(at("&device=phone"));
    await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1000);
    await shot(page, "phone-framed-record");
  }
  expect(problems, "no page error anywhere on the path").toEqual([]);
});
