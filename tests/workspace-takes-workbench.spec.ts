import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import {
  CLIP_WIDTHS, DESKTOP, PHONE, assertNoClipping, forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload,
  type LibraryRoute,
} from "./helpers/workspaceFixtures";

/**
 * Takes (workspace redesign): the whole project library — uploads and
 * generations together — as cards over the real library route's shape,
 * filtered, walked with ← →, inspected, and added to with + Upload through
 * the existing upload client.
 */

const project = { ...newProject("Coastal light study"), id: "ws-takes", productionProjectId: "prod-ws", shotMappings: {} };

function library(): LibraryRoute {
  return {
    generations: [
      generation({ id: "gen_approved", title: "Harbour at dusk", reviewState: "approved", creditsBilled: 18, version: 2 }),
      generation({ id: "gen_review", title: "Harbour at dusk", creditsBilled: 18, version: 1 }),
      generation({ id: "gen_failed", title: "Pier wide", status: "failed", storedUrl: null, creditsBilled: 0, error: "Engine timed out" }),
      generation({ id: "gen_running", title: "Lighthouse turn", kind: "video", model: "dreamina-seedance-2-5-260628", status: "running", storedUrl: null, params: { duration: 5 } }),
    ],
    uploads: [
      upload({ id: "up_plate", filename: "Harbour plate.webp", width: 4032, height: 3024 }),
      upload({ id: "up_scout", filename: "Location scout 01.webp", width: 3024, height: 4032 }),
      upload({ id: "up_notes", filename: "Director notes.pdf", mime: "application/pdf", kind: "file", width: null, height: null, sha256: "not-a-digest" }),
    ],
  };
}

async function open(page: Page, store: LibraryRoute, onFile?: (id: string) => void) {
  const account = await signInLocally(page.request);
  const db = createClient({ url: localPlatformDbUrl() });
  try { await db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [account.workspace.id] }); } finally { db.close(); }
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: project });
  await mockLibrary(page, store, onFile);
  await page.goto(`/workspace?project=${project.id}&suite=particl&page=takes`);
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
}

const card = (page: Page, id: string) => page.locator(`[data-take-id="${id}"]`);

test("phones keep the existing phone surface for Takes", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signInLocally(page.request);
  await mockProjects(page, { current: project });
  await page.goto(`/workspace?project=${project.id}&suite=particl&page=takes`);
  await expect(page).toHaveURL(/\/workbench\?project=ws-takes$/);
});

test("Takes renders the project library, filters, walks the visible list and inspects", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const store = library();
  await open(page, store);

  /* Every asset, one grid, derived subtitle: 36 cr settled; the failed render adds nothing. */
  await expect(page.locator(".pxw-take-card")).toHaveCount(7);
  await expect(page.getByTestId("page-sub")).toHaveText("7 assets · 36 cr settled");
  await expect(card(page, "generation:gen_failed")).toContainText("Failed · not billed");
  await expect(card(page, "generation:gen_approved")).toContainText("Approved");
  await expect(card(page, "generation:gen_approved").getByTestId("take-cost")).toHaveText("18 cr");
  await expect(card(page, "upload:up_plate").locator(".pxw-take-kind")).toHaveText("UPLOAD");
  await expect(card(page, "generation:gen_review").locator(".pxw-take-kind")).toHaveText("GEN");
  await expect(card(page, "upload:up_plate")).toContainText("4032×3024");
  await expect(card(page, "upload:up_plate").locator("img")).toBeVisible();
  /* No browser preview for a PDF: the flat block stands in. */
  await expect(card(page, "upload:up_notes").locator(".pxw-flat")).toBeVisible();

  /* Selection repair: the first card is selected and the URL carries it. */
  await expect(page).toHaveURL(/[?&]sel=take%3Ageneration%3Agen_approved/);
  await expect(page.getByTestId("inspector-title")).toHaveText("Harbour at dusk");
  await expect(page.getByTestId("take-facts")).toContainText("Settled cost");
  await expect(page.getByTestId("take-facts")).toContainText("18 cr");

  /* Uploads only: → never lands on a generation, and wraps at the end (#233's keymap). */
  await page.getByRole("group", { name: "Takes view" }).getByRole("button", { name: "Uploads" }).click();
  await expect(page.locator(".pxw-take-card")).toHaveCount(3);
  await expect(page.locator('.pxw-take-card[aria-pressed="true"]')).toHaveAttribute("data-take-id", "upload:up_plate");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('.pxw-take-card[aria-pressed="true"]')).toHaveAttribute("data-take-id", "upload:up_scout");
  await expect(page.getByTestId("take-facts")).toContainText("Integrity");
  await expect(page.getByTestId("take-facts")).toContainText("sha256 ✓");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('.pxw-take-card[aria-pressed="true"]')).toHaveAttribute("data-take-id", "upload:up_notes");
  /* No stored digest, no integrity claim. */
  await expect(page.getByTestId("take-facts")).not.toContainText("Integrity");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('.pxw-take-card[aria-pressed="true"]')).toHaveAttribute("data-take-id", "upload:up_plate");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator('.pxw-take-card[aria-pressed="true"]')).toHaveAttribute("data-take-id", "upload:up_notes");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator('.pxw-take-card[aria-pressed="true"]')).toHaveAttribute("data-take-id", "upload:up_scout");

  /* Generations: the selection moves into the visible list. */
  await page.getByRole("group", { name: "Takes view" }).getByRole("button", { name: "Generations" }).click();
  await expect(page.locator(".pxw-take-card")).toHaveCount(4);
  await card(page, "generation:gen_failed").click();
  await expect(page.getByTestId("take-facts")).toContainText("Not billed");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('.pxw-take-card[aria-pressed="true"]')).toHaveAttribute("data-take-id", "generation:gen_running");
  await expect(page.getByTestId("take-facts")).toContainText("Not settled");

  /* Library sidebar: Media counts and shows the project's uploads. */
  await page.getByRole("group", { name: "Library view" }).getByRole("button", { name: /Media/ }).click();
  await expect(page.locator(".pxw-library-media-count")).toHaveText("3");
  await expect(page.locator("[data-media-item]")).toHaveCount(3);
  await page.locator('[data-media-item="upload:up_scout"]').click();
  await expect(page.locator('.pxw-take-card[aria-pressed="true"]')).toHaveAttribute("data-take-id", "upload:up_scout");

  for (const size of CLIP_WIDTHS) {
    await page.setViewportSize(size);
    await assertNoClipping(page);
  }
  if (info.project.name === "workbench-1440x900") {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("group", { name: "Takes view" }).getByRole("button", { name: "All" }).click();
    await page.getByRole("group", { name: "Library view" }).getByRole("button", { name: "Tools" }).click();
    await card(page, "generation:gen_approved").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath("takes-1440x900.png") });
  }
  expect(errors).toEqual([]);
});

test("Takes pages through the library cursor and + Upload files an original into the project", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const store = library();
  store.pageSize = 2;
  const filed: string[] = [];
  await open(page, store, (id) => {
    filed.push(id);
    store.uploads.unshift(upload({ id, filename: "New angle.png", createdAt: Date.now() }));
  });

  /* Two per page from each source until Load more. */
  await expect(page.locator(".pxw-take-card")).toHaveCount(4);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".pxw-take-card")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  /* + Upload: the existing chunked client stores the original, then files it to this project. */
  const finished = page.waitForResponse((r) => r.url().endsWith("/api/uploads/finish") && r.request().method() === "POST");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("primary-action").click();
  await (await chooser).setFiles({ name: "New angle.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64") });
  const response = await finished;
  expect(response.ok(), await response.text()).toBe(true);
  const receipt = await response.json();
  await expect.poll(() => filed).toEqual([receipt.id]);
  await expect(card(page, `upload:${receipt.id}`)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "stored byte-identical" })).toBeVisible();
  await expect(page.getByTestId("page-sub")).toHaveText("8 assets · 36 cr settled");
});
