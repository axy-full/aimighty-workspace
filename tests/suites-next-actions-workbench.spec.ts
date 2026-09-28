import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * Idea 12, first slice: a Next row on every take — in the Inspector and on
 * the selected take in Takes — that opens the existing tool on it: Re-edit
 * for a still, Seedance Edit for a clip, Edit & Sound for a sound. Navigation
 * only: no price on the row, and nothing that could spend is sent until the
 * tool's own priced button is pressed (the desk's own automatic quotes are
 * read-only, and charge nothing). Every reply is route-mocked.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const fixture = (saved = true): Project => ({ ...newProject("Next steps"), id: "ws-next", ...(saved ? { productionProjectId: "prod-next" } : {}), shotMappings: {} });
const store = () => ({
  generations: [
    generation({ id: "gen_still", title: "Pier at dusk", prompt: "a pier at dusk" }),
    generation({ id: "gen_clip", title: "Ferry turning", prompt: "the ferry turns", kind: "video" }),
    generation({ id: "gen_voice", title: "Keeper's line", prompt: "the storm is coming", kind: "audio", model: "eleven_v3" }),
    generation({ id: "gen_failed", title: "Night swim", status: "failed", storedUrl: null, error: "Refused by the content filter." }),
  ],
  uploads: [upload({ id: "up_script", filename: "the-crossing.pdf", mime: "application/pdf", kind: "file", width: 0, height: 0 })],
});

async function open(page: Page, url: string, saved = true) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture(saved) });
  await mockLibrary(page, store());
  /* Anything that could spend is counted: navigating to a tool must send none of it. A read-only quote (the quote route, or a
     `quoteOnly` body — the desk prices its own tools on sight) charges nothing, and is kept apart to prove it is only that. */
  const sent: string[] = [], quotes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" || !/^\/api\/(generate|audio|jobs\/[^/]+\/retry|higgsfield)/.test(path)) return;
    let body: { quoteOnly?: unknown } | null = null;
    try { body = request.postDataJSON() as { quoteOnly?: unknown } | null; } catch { body = null; }
    if (path === "/api/generate/quote" || body?.quoteOnly === true) quotes.push(path); else sent.push(`${request.method()} ${path}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId("project-name")).toHaveText("Next steps");
  return { sent, quotes, errors };
}
const assets = async (page: Page, info: TestInfo) => {
  if (!WIDE.includes(info.project.name)) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
};
const tile = (page: Page, id: string) => page.getByTestId("library").locator(`.gx-asset-thumb[data-ctx='asset:${id}']`);
const deskTile = (page: Page, name: string) => page.getByTestId("takes-grid").getByTestId("take-tile").filter({ has: page.getByText(name, { exact: true }) });

/** Thumb-sized, labelled at the floor, inside the screen, and clear of the phone's tab bar. */
async function rowFloors(page: Page, info: TestInfo, row: ReturnType<Page["getByTestId"]>, where: string) {
  const box = (await row.boundingBox())!;
  expect(box.x + box.width, `${where}: the row inside the screen`).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, `${where} [data-testid="next-actions"]`), `${where}: Next under 44×44`).toEqual([]);
    expect(await dimLabels(page, `${where} [data-testid="next-actions"]`), `${where}: labels under #7C7C84`).toEqual([]);
    const bar = page.getByTestId("tabbar");
    if (await bar.isVisible()) {
      await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const [after, barBox] = [(await row.boundingBox())!, (await bar.boundingBox())!];
      expect(after.y + after.height, `${where}: the row clears the tab bar`).toBeLessThanOrEqual(barBox.y + 0.5);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  /* With NEXT_SHOTS_DIR set, a picture of the row where it is. */
  if (process.env.NEXT_SHOTS_DIR) await page.screenshot({ path: `${process.env.NEXT_SHOTS_DIR}/next-${where.includes("inspector") ? "inspector" : "desk"}-${info.project.name.replace("workbench-", "")}.png` });
}

test("the Inspector's Next opens each take's own tool on it — Re-edit for a still, Edit for a clip, Edit & Sound for a sound — and nothing that could spend is sent", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { sent, quotes, errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards");
  await assets(page, info);
  await tile(page, "generation:gen_still").click();
  const inspector = page.getByTestId("inspector");
  const next = inspector.getByTestId("next-actions");
  await expect(next.getByRole("button")).toHaveText(["Re-edit ›"]);
  await expect(next).not.toContainText(/\d|credit/i);
  await rowFloors(page, info, next, '[data-testid="inspector"]');
  await next.getByTestId("next-re-edit").click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect(page.getByTestId("takes-selected")).toContainText("Selected · Pier at dusk");
  await expect(page.getByTestId("edit-image")).toBeInViewport();
  await expect(page.getByTestId("edit-instruction")).toBeFocused();
  /* The form's own priced button is the next step: nothing is priced until the change is written, and nothing was sent. */
  await expect(page.getByTestId("edit-render")).toBeDisabled();
  await expect(page.getByTestId("edit-blocked")).toHaveText("Write what should change.");
  await expect.poll(() => new URL(page.url()).searchParams.get("asset")).toBe("generation:gen_still");
  if (!WIDE.includes(info.project.name)) await expect(page.getByTestId("inspector")).toHaveCount(0);

  /* A clip, from the Library again: already on Takes, its Seedance Edit opens on it. */
  await assets(page, info);
  await tile(page, "generation:gen_clip").click();
  await expect(page.getByTestId("inspector").getByTestId("next-actions").getByRole("button")).toHaveText(["Edit ›"]);
  await page.getByTestId("inspector").getByTestId("next-edit").click();
  await expect(page.getByTestId("takes-selected")).toContainText("Selected · Ferry turning");
  await expect(page.getByTestId("gen-edit")).toBeInViewport();
  await expect(page.getByTestId("gen-edit-panel")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("asset")).toBe("generation:gen_clip");

  /* A sound: Edit & Sound opens — the row says what opens, nothing more. */
  await assets(page, info);
  await tile(page, "generation:gen_voice").click();
  await expect(page.getByTestId("inspector").getByTestId("next-actions").getByRole("button")).toHaveText(["Edit & Sound ›"]);
  await page.getByTestId("inspector").getByTestId("next-edit-sound").click();
  await expect(page.getByTestId("page-title")).toHaveText("Edit & Sound");
  expect(sent, "nothing that could spend on the way to a tool").toEqual([]);
  expect(quotes.every((path) => path === "/api/generate/quote" || path === "/api/audio/transcribe"), "only read-only quotes").toBe(true);
  expect(errors).toEqual([]);
});

test("the selected take in Takes carries the same row; a sound's opens Edit & Sound in place of the old link", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { sent, quotes, errors } = await open(page, "/suites?suite=studio&page=takes");
  await deskTile(page, "Pier at dusk").getByTestId("edit-take").click();
  const selected = page.getByTestId("takes-selected");
  const next = selected.getByTestId("next-actions");
  await expect(next.getByRole("button")).toHaveText(["Re-edit ›"]);
  await rowFloors(page, info, next, '[data-testid="takes-selected"]');
  await next.getByTestId("next-re-edit").click();
  await expect(page.getByTestId("edit-instruction")).toBeFocused();
  await expect(page.getByTestId("edit-image")).toBeInViewport();

  await page.getByTestId("takes-kind").filter({ hasText: "Audio" }).click();
  await deskTile(page, "Keeper's line").getByTestId("edit-take").click();
  await expect(selected).toContainText("Selected · Keeper's line");
  await expect(selected.getByRole("button", { name: "Open Edit & Sound ›" })).toHaveCount(0);
  await selected.getByTestId("next-edit-sound").click();
  await expect(page.getByTestId("page-title")).toHaveText("Edit & Sound");
  expect(sent, "nothing that could spend").toEqual([]);
  expect(quotes.every((path) => path === "/api/generate/quote" || path === "/api/audio/transcribe"), "only read-only quotes").toBe(true);
  expect(errors).toEqual([]);
});

test("a take that did not render, a file with nothing to edit, and an unsaved project: Next says why, or is not there", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone and one desktop");
  const { sent, errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards", false);
  await assets(page, info);
  await tile(page, "generation:gen_failed").click();
  const next = page.getByTestId("inspector").getByTestId("next-actions");
  await expect(next.getByTestId("next-re-edit")).toBeDisabled();
  await expect(next.getByTestId("next-why")).toHaveText("It did not render, so there is nothing to edit.");
  if (!WIDE.includes(info.project.name)) await page.getByTestId("close-inspector").click();
  await assets(page, info);
  await tile(page, "generation:gen_still").click();
  await expect(page.getByTestId("inspector").getByTestId("next-re-edit")).toBeDisabled();
  await expect(page.getByTestId("inspector").getByTestId("next-why")).toHaveText("Save the project first.");
  if (!WIDE.includes(info.project.name)) await page.getByTestId("close-inspector").click();
  await assets(page, info);
  await tile(page, "upload:up_script").click();
  await expect(page.getByTestId("inspector").getByTestId("asset-inspector")).toBeVisible();
  await expect(page.getByTestId("inspector").getByTestId("next-actions")).toHaveCount(0);
  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
});
