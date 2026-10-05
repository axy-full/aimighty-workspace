import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { screenplayPdf } from "./helpers/screenplayPdf";

/**
 * Owner, 25 September: "wherever there is an asset shown, there should be a
 * preview available for it." One previewer for the whole site: the ⤢ on
 * hover, a double-click, Space on a focused tile, a long-press on a phone, or
 * the Inspector's Preview — full size, stepping through the neighbours,
 * pictures, video, sound and documents (a PDF drawn page by page).
 */
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-390x844"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-preview", productionProjectId: "prod-ws", shotMappings: {} });

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [
      upload({ id: "up_plate", filename: "harbour-plate.webp" }),
      upload({ id: "up_tone", filename: "room-tone.mp3", mime: "audio/mpeg", kind: "audio", width: 0, height: 0 }),
      upload({ id: "up_script", filename: "the-crossing.pdf", mime: "application/pdf", kind: "file", width: 0, height: 0 }),
    ],
    generations: [generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" })],
  });
  /* After mockMedia, so it answers first: the script is a real PDF, the room tone is sound. */
  await page.route(/\/api\/uploads\/up_script(\?.*)?$/, (route) => route.fulfill({ body: screenplayPdf([["THE CROSSING", "", "EXT. FROZEN HARBOUR - DUSK", "A red fox crosses the ice."], ["INT. HUT - NIGHT", "Mara watches."]]), contentType: "application/octet-stream" }));
  await page.route(/\/api\/uploads\/up_tone(\?.*)?$/, (route) => route.fulfill({ body: Buffer.alloc(64), contentType: "audio/mpeg" }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=atomik&page=agent&sp=agent");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors };
}
const openAssets = async (page: Page, wide: boolean) => {
  if (!wide) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
};
const tile = (page: Page, id: string) => page.getByTestId("library").locator(`.gx-asset-thumb[data-ctx='asset:${id}']`);

test("every Library asset previews: ⤢ on hover, double-click, Space; ← / → step; Esc closes and gives focus back", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name), "desktops");
  const { errors } = await open(page);
  await openAssets(page, true);
  const dialog = page.getByTestId("preview-dialog");

  /* Hover: the ⤢ appears over the tile and opens the full-size picture. */
  await tile(page, "upload:up_plate").hover();
  await page.getByTestId("preview-open").click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("preview-name")).toHaveText("harbour-plate.webp");
  await expect(page.getByTestId("preview-image")).toHaveAttribute("src", "/api/uploads/up_plate");
  await expect(page.getByTestId("preview-download")).toHaveAttribute("href", "/api/uploads/up_plate?download=1");
  await expect(page.getByTestId("preview-count")).toHaveText(/^\d+ \/ 4$/);

  /* → and ← walk the neighbours, wrapping. */
  const first = await page.getByTestId("preview-name").textContent();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("preview-name")).not.toHaveText(first!);
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("preview-name")).toHaveText(first!);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  /* Double-click: sound gets a player. */
  await tile(page, "upload:up_tone").dblclick();
  await expect(dialog).toHaveAttribute("data-kind", "audio");
  await expect(page.getByTestId("preview-audio").locator("audio")).toHaveAttribute("src", "/api/uploads/up_tone");
  await page.getByTestId("preview-close").click();

  /* A PDF script is drawn page by page (the server only sends PDFs as downloads). */
  await tile(page, "upload:up_script").dblclick();
  await expect(dialog).toHaveAttribute("data-kind", "document");
  await expect(page.getByTestId("preview-document").locator("img.pv-page")).toHaveCount(2, { timeout: 20_000 });
  await page.keyboard.press("Escape");
  /* Esc hands focus back to the script's tile on the next tick; wait for it, or it lands after the next focus. */
  await expect(tile(page, "upload:up_script")).toBeFocused();

  /* Space on a focused tile, like Quick Look; Esc gives focus back to it. */
  await tile(page, "generation:gen_wide").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("preview-name")).toHaveText("Wide on the water");
  await expect(page.getByTestId("preview-image")).toHaveAttribute("src", "/api/media/gen_wide");
  await page.keyboard.press("Escape");
  await expect(tile(page, "generation:gen_wide")).toBeFocused();

  /* The Inspector names it too. */
  await tile(page, "upload:up_script").click();
  await page.getByTestId("inspector-open-preview").click();
  await expect(page.getByTestId("preview-name")).toHaveText("the-crossing.pdf");
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("closing a preview does not pull focus back from a tile focused in the meantime", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name), "desktops");
  const { errors } = await open(page);
  await openAssets(page, true);
  await tile(page, "upload:up_plate").dblclick();
  await expect(page.getByTestId("preview-dialog")).toBeVisible();
  /* Esc and a focus on the next tile in the same task, as a slow machine lets
     happen: the deferred hand-back to the plate must not win. */
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    document.querySelector<HTMLElement>(".gx-asset-thumb[data-ctx='asset:generation:gen_wide']")!.focus();
  });
  await expect(page.getByTestId("preview-dialog")).toHaveCount(0);
  await page.waitForTimeout(100);
  await expect(tile(page, "generation:gen_wide")).toBeFocused();
  expect(errors).toEqual([]);
});

test("phone: a long-press on an asset previews it full screen, and the tap does not also open the Inspector", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "a phone");
  const { errors } = await open(page);
  await openAssets(page, false);
  const plate = tile(page, "upload:up_plate");
  const box = (await plate.boundingBox())!;
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: "touch", isPrimary: true, bubbles: true, pointerId: 7 };
  await plate.dispatchEvent("pointerdown", at);
  await page.waitForTimeout(700);
  await plate.dispatchEvent("pointerup", at);
  await plate.dispatchEvent("click", at);
  await expect(page.getByTestId("preview-dialog")).toBeVisible();
  await expect(page.getByTestId("preview-name")).toHaveText("harbour-plate.webp");
  const frame = (await page.getByTestId("preview-dialog").boundingBox())!;
  expect(frame.width).toBeGreaterThanOrEqual(389);
  await page.getByTestId("preview-close").click();
  await expect(page.getByTestId("preview-dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});


/* ── Idea 26: the viewer walks the whole filtered list, from the shell's selection, and hands off through the shell ── */

const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const TOUCH = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const BIG = 150;
const frameName = (i: number) => `Frame ${String(i).padStart(3, "0")}`;
/** 150 takes, newest first: every tenth a clip, every fifteenth a failed render (nothing to preview), then a sound and a plate. */
function bigLibrary() {
  const base = 1_790_000_000_000;
  const generations = Array.from({ length: BIG }, (_, i) => generation({
    id: `gen_${String(i).padStart(3, "0")}`, title: frameName(i), prompt: frameName(i), createdAt: base - i * 60_000, updatedAt: base - i * 60_000,
    ...(i % 10 === 5 ? { kind: "video" as const } : {}),
    ...(i % 15 === 7 ? { status: "failed" as const, storedUrl: null, error: "The engine refused it." } : {}),
  }));
  const uploads = [
    upload({ id: "up_tone", filename: "room-tone.mp3", mime: "audio/mpeg", kind: "audio", width: 0, height: 0, createdAt: base - BIG * 60_000 }),
    upload({ id: "up_plate", filename: "harbour-plate.webp", createdAt: base - (BIG + 1) * 60_000 }),
  ];
  return { generations, uploads };
}
/** With PREVIEW_SHOTS_DIR set, a picture of the state under test at this size. */
async function shot(page: Page, info: { project: { name: string } }, name: string) {
  const dir = process.env.PREVIEW_SHOTS_DIR;
  if (!dir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/${name}-${info.project.name.replace("workbench-", "")}.png` });
}
const failedCount = Array.from({ length: BIG }, (_, i) => i).filter((i) => i % 15 === 7).length;
const PREVIEWABLE = BIG - failedCount + 2;
const VIDEOS = Array.from({ length: BIG }, (_, i) => i).filter((i) => i % 10 === 5 && i % 15 !== 7).length;

async function openBig(page: Page, info: { project: { name: string } }) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  const store = { ...bigLibrary(), pageSize: 200 };
  await mockLibrary(page, store);
  await page.route(/\/api\/uploads\/up_tone(\?.*)?$/, (route) => route.fulfill({ body: Buffer.alloc(64), contentType: "audio/mpeg" }));
  /* Nothing paid may leave the page: every generate-shaped request is counted, and the paid routes throw (forbidPaidWork). */
  const sent: string[] = [];
  page.on("request", (request) => { if (/\/api\/(generate|generations|jobs\/[^/]+\/retry)(\/|$|\?)/.test(new URL(request.url()).pathname) && request.method() !== "GET") sent.push(request.url()); });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=atomik&page=agent&sp=agent");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await openAssets(page, WIDE.includes(info.project.name));
  await expect(page.getByTestId("library").getByRole("tab", { name: /Assets/ })).toContainText(String(BIG + 2));
  return { errors, sent };
}

/** Open the viewer on a Library tile the way this device does: a double-click, or a long-press on touch. */
async function previewTile(page: Page, id: string, touch: boolean) {
  const el = tile(page, id);
  await el.scrollIntoViewIfNeeded();
  if (!touch) { await el.dblclick(); return; }
  const box = (await el.boundingBox())!;
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: "touch", isPrimary: true, bubbles: true, pointerId: 9 };
  await el.dispatchEvent("pointerdown", at);
  await page.waitForTimeout(700);
  await el.dispatchEvent("pointerup", at);
  await el.dispatchEvent("click", at);
}

test("the viewer walks the Library's whole filtered list, far past what the window has mounted; its arrows move the selection, the Inspector, the download and the address bar", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name), touch = TOUCH.includes(info.project.name);
  const { errors, sent } = await openBig(page, info);
  const list = page.getByTestId("library-assets");
  await expect(list).toHaveAttribute("data-virtual", "on");
  const mounted = await list.locator(".gx-asset-thumb").count();
  expect(mounted, "a windowed list mounts a slice").toBeLessThan(PREVIEWABLE);

  await previewTile(page, "generation:gen_002", touch);
  const dialog = page.getByTestId("preview-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-bound", "");
  /* Its place among every take that has something to show — failed renders are left out, as their tiles have no preview. */
  await expect(page.getByTestId("preview-count")).toHaveText(`3 / ${PREVIEWABLE}`);
  await expect(page.getByTestId("preview-name")).toHaveText(frameName(2));
  /* A long-press selects nothing — the phone's Inspector stays shut and the address bar names no take; a double-click's
     first click selects its tile, as any click on it does. */
  if (touch) expect(new URL(page.url()).searchParams.get("asset")).toBeNull();
  else await expect.poll(() => new URL(page.url()).searchParams.get("asset")).toBe("generation:gen_002");
  if (!wide) await expect(page.getByTestId("inspector")).toHaveCount(0);

  const entries = await page.evaluate(() => history.length);
  const next = async () => { if (touch) await page.getByTestId("preview-next").click(); else await page.keyboard.press("ArrowRight"); };
  await next();
  await expect(page.getByTestId("preview-name")).toHaveText(frameName(3));
  await expect(page.getByTestId("preview-count")).toHaveText(`4 / ${PREVIEWABLE}`);
  await expect(page.getByTestId("preview-download")).toHaveAttribute("href", "/api/media/gen_003?download=1");
  await expect.poll(() => new URL(page.url()).searchParams.get("asset")).toBe("generation:gen_003");
  expect(new URL(page.url()).searchParams.get("sel")).toBe("take:generation:gen_003");
  if (wide) await expect(page.getByTestId("inspector-title")).toHaveText(frameName(3));
  else await expect(page.getByTestId("inspector")).toHaveCount(0);
  /* Past the failed render at 7: 6 → 8. Wrapping backwards from the first reaches the last, the plate, far outside the window. */
  for (let i = 0; i < 3; i++) await next();
  await expect(page.getByTestId("preview-name")).toHaveText(frameName(6));
  await next();
  await expect(page.getByTestId("preview-name")).toHaveText(frameName(8));
  if (touch) { for (let i = 0; i < 8; i++) await page.getByTestId("preview-prev").click(); }
  else for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("preview-name")).toHaveText("harbour-plate.webp");
  await expect(page.getByTestId("preview-count")).toHaveText(`${PREVIEWABLE} / ${PREVIEWABLE}`);
  await expect.poll(() => new URL(page.url()).searchParams.get("asset")).toBe("upload:up_plate");
  /* Stepping rewrote the one entry: Back still leaves the page, not each step. */
  expect(await page.evaluate(() => history.length)).toBe(entries);

  await shot(page, info, "viewer-bound");
  /* The bar's controls: thumb-sized on touch, inside the screen everywhere. */
  if (touch) expect(await smallTargets(page, '[data-testid="preview-dialog"]'), "viewer targets under 44×44").toEqual([]);
  const frame = (await dialog.boundingBox())!, bar = (await page.getByTestId("preview-actions").boundingBox())!;
  expect(bar.y + bar.height, "the bar is on the screen").toBeLessThanOrEqual(page.viewportSize()!.height + 0.5);
  expect(frame.x + frame.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  /* Focus goes back to the tile it was opened from. */
  if (!touch) await expect(tile(page, "generation:gen_002")).toBeFocused();

  /* The Video filter: the viewer walks only what it keeps. */
  await page.getByTestId("library").locator(".gx-chip[data-kind='Video']").click();
  await previewTile(page, "generation:gen_015", touch);
  await expect(page.getByTestId("preview-count")).toHaveText(`2 / ${VIDEOS}`);
  await expect(page.getByTestId("preview-dialog")).toHaveAttribute("data-kind", "video");
  await page.getByTestId("preview-close").click();
  expect(sent, "nothing paid was sent").toEqual([]);
  expect(errors).toEqual([]);
});

test("the Inspector's Preview starts at its take in the page's list; Recreate and Use as reference hand off to Gen without sending anything; Copy link names the workspace, the production and the take", async ({ page, baseURL }, info) => {
  test.skip(!WIDE.includes(info.project.name), "desktops: the Inspector is a column");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  const { errors, sent } = await openBig(page, info);
  await tile(page, "generation:gen_004").click();
  await expect(page.getByTestId("inspector-title")).toHaveText(frameName(4));
  await expect.poll(() => new URL(page.url()).searchParams.get("asset")).toBe("generation:gen_004");
  await page.getByTestId("inspector-open-preview").click();
  await expect(page.getByTestId("preview-count")).toHaveText(`5 / ${PREVIEWABLE}`);
  await expect(page.getByTestId("preview-actions").getByRole("button")).toHaveText(["Recreate", "Use as reference", "Copy link"]);

  /* Copy link: the workspace, the production and the take — no draft, no media address. */
  await page.getByTestId("preview-link").click();
  await expect(page.getByTestId("preview-said")).toHaveText(/^Link copied/);
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.pathname).toBe("/suites");
  expect(Object.fromEntries(copied.searchParams)).toMatchObject({ view: "board", region: "shots", production: "prod-ws", asset: "generation:gen_004" });
  expect(copied.searchParams.get("ws")).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(copied.searchParams.has("project")).toBe(false);

  /* A sound is no reference and was not generated: Use as reference says why, Recreate is not offered. */
  /* Back past the first take wraps to the end: the plate, then the sound. */
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("preview-name")).toHaveText("room-tone.mp3");
  await expect(page.getByTestId("preview-recreate")).toHaveCount(0);
  await expect(page.getByTestId("preview-reference")).toBeDisabled();
  await expect(page.getByTestId("preview-why")).toHaveText("References are images and videos.");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");

  /* Recreate: the recipe goes to Gen, which prices it on its own button. Nothing is sent. */
  await expect(page.getByTestId("preview-name")).toHaveText(frameName(4));
  await page.getByTestId("preview-recreate").click();
  await expect(page.getByTestId("preview-dialog")).toHaveCount(0);
  /* Make opens over the page the take was previewed from; the page stays put underneath. */
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText(frameName(4));
  await expect(page.getByTestId("toast")).toContainText(`${frameName(4)}’s recipe is in Gen.`);

  /* Use as reference, from the Inspector's own list again. */
  await tile(page, "generation:gen_005").click();
  await page.getByTestId("inspector-open-preview").click();
  await expect(page.getByTestId("preview-name")).toHaveText(frameName(5));
  await page.getByTestId("preview-reference").click();
  await expect(page.getByTestId("preview-dialog")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText(`${frameName(5)} added as Video`);
  expect(sent, "no generation request before approval").toEqual([]);
  expect(errors).toEqual([]);
});

test("a second preview opened while one is up starts at its own take, and a bound preview closes when the project changes", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name), "desktops");
  const { errors } = await openBig(page, info);
  await tile(page, "generation:gen_001").dblclick();
  await expect(page.getByTestId("preview-count")).toHaveText(`2 / ${PREVIEWABLE}`);
  /* A menu's Preview while the viewer is up: the new open is its own session, not the old index. */
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("particl:preview", { detail: { items: [{ url: "/api/media/gen_010", kind: "image", name: "Frame 010" }], index: 0, bind: { surface: "library", asset: "generation:gen_010" } } })));
  await expect(page.getByTestId("preview-name")).toHaveText(frameName(10));
  /* Frame 007 failed and is not in the gallery: Frame 010 is the tenth. */
  await expect(page.getByTestId("preview-count")).toHaveText(`10 / ${PREVIEWABLE}`);
  /* Another project arrives (Back to an entry in another project): the bound viewer and its buttons go. */
  await page.route("**/api/workbench/projects**", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { projects: [{ id: "ws-preview", name: "Coastal light study", revision: 1 }, { id: "ws-other", name: "Other study", revision: 1 }], productions: [], project: { ...newProject("Other study"), id: "ws-other", productionProjectId: "prod-other", shotMappings: {} }, revision: 1, shared: null } })
    : route.fallback());
  await page.evaluate(() => { const q = new URLSearchParams(location.search); q.set("project", "ws-other"); history.pushState(null, "", location.pathname + "?" + q); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByTestId("project-name")).toHaveText("Other study");
  await expect(page.getByTestId("preview-dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
