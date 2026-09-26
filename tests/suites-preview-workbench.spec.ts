import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
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
  await page.goto("/suites?suite=particl&page=boards&sp=boards");
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

test("the Rig's shot thumbnails preview their take, and a video take shows its own frame (not a broken picture)", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name), "desktops");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const project: Project = {
    ...fixture(),
    assets: [{ id: "a-vid", generationId: "gen_take", name: "Take 1", kind: "video", category: "Take", url: "/api/media/gen_take", description: "", prompt: "", status: "Draft", version: 1, locked: false, refs: [] }],
    nodes: [{ id: "n1", title: "Opening", type: "scene", x: 0, y: 0, width: 238, linked: [], role: "Director", status: "draft", mode: "Video", assetId: "a-vid", durationS: 5, ratio: "16:9", resolution: "720p" }],
  } as Project;
  await mockProjects(page, { current: project });
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_take", title: "Take 1", prompt: "t", kind: "video" })] });
  await page.goto("/suites?suite=studio&page=rig");
  const thumb = page.locator(".pxw-rig-thumb[data-preview-url]").first();
  await expect(thumb).toHaveAttribute("data-preview-url", "/api/media/gen_take");
  await expect(thumb).toHaveAttribute("data-preview-kind", "video");
  await expect(thumb.locator("img[src*='/api/workbench/preview/']")).toHaveCount(0);
  await thumb.dblclick();
  await expect(page.getByTestId("preview-dialog")).toHaveAttribute("data-kind", "video");
  await expect(page.getByTestId("preview-video")).toHaveAttribute("src", "/api/media/gen_take");
});
