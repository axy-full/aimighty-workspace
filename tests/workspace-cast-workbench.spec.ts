import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { SoulIdentity } from "../lib/workbench/soul-identity";
import { CLIP_WIDTHS, DESKTOP, PHONE, assertNoClipping, forbidPaidWork, mockMedia, mockProjects, type ProjectRoute } from "./helpers/workspaceFixtures";

/**
 * Cast & Elements (workspace redesign): cards from the draft's Character /
 * Element assets and the project's identities, tags derived from identity
 * state and shot links, an Inspector with only the facts the records hold,
 * Use in Rig, and + Add cast opening the existing paid identity flow whose
 * button carries the live price — a stale price blocks the request.
 */

const image = (id: string, name: string, category: string, extra: Partial<Asset> = {}): Asset => ({
  id, name, kind: "image", category, url: `/api/uploads/${id}`, uploadId: id, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra,
});
const ref = (id: string, title: string, type: CanvasNode["type"], assetId: string): CanvasNode => ({ id, title, type, assetId, x: 0, y: 0, width: 260, linked: [] });
const shot = (id: string, title: string, linked: string[]): CanvasNode => ({ id, title, type: "scene", text: "Hold on the water.", x: 0, y: 0, width: 300, linked });

function fixture(): Project {
  return {
    ...newProject("Coastal light study"),
    id: "ws-cast",
    productionProjectId: "prod-ws",
    shotMappings: {},
    assets: [
      image("up_lead", "Lead", "Character", { soulIdentityId: "id_lead", version: 2 }),
      image("up_second", "Second figure", "Character"),
      image("up_second_b", "Second figure / profile", "Reference", { parentId: "up_second" }),
      image("up_sphere", "Chrome sphere", "Element", { description: "chrome" }),
      image("up_plate", "Harbour plate", "Environment", { description: "warm daylight" }),
      image("up_extra", "Location scout", "Reference"),
    ],
    nodes: [
      ref("n-lead", "Lead", "character", "up_lead"),
      ref("n-sphere", "Chrome sphere", "element", "up_sphere"),
      ref("n-plate", "Harbour plate", "element", "up_plate"),
      shot("s1", "The approach", ["n-plate"]),
      shot("s2", "The encounter", ["n-lead", "n-sphere", "n-plate"]),
      shot("s3", "Mirror fold", ["n-sphere"]),
    ],
  };
}

const identity = (fields: Partial<SoulIdentity> & { id: string; name: string }): SoulIdentity => ({
  projectId: "ws-cast", description: "", subjectType: "character", status: "ready", previewUrl: null,
  references: [], createdAt: 1, updatedAt: 1, creditsBilled: null, error: null, ...fields,
});

type IdentityRoute = { identities: SoulIdentity[]; price: number; posts: Record<string, unknown>[] };

async function open(page: Page, store: ProjectRoute, ids: IdentityRoute) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, store);
  await page.route("**/api/soul/identities**", async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ json: { identities: ids.identities, configured: true, generationAvailable: true, terms: { minPhotos: 3, maxPhotos: 20, trainingCredits: ids.price } } });
    const body = request.postDataJSON() as Record<string, unknown>;
    ids.posts.push(body);
    /* As lib/soulIdentities.ts: a ceiling below the current price is refused before anything trains (409, settled). */
    if (typeof body.maxCredits !== "number" || body.maxCredits < ids.price)
      return route.fulfill({ status: 409, headers: { "Idempotency-Status": "complete" }, json: { error: "The identity quote changed. Review its current credit price before training." } });
    return route.fulfill({ status: 500, json: { error: "Unexpected training in a test." } });
  });
  await page.goto(`/workspace?project=${store.current.id}&suite=particl&page=cast`);
  await expect(page.getByTestId("page-title")).toHaveText("Cast & Elements");
}

const card = (page: Page, id: string) => page.locator(`[data-cast-id="${id}"]`);
const selected = (page: Page) => page.locator('.pxw-cast-card[aria-pressed="true"]');

test("phones render the phone shell for Cast", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signInLocally(page.request);
  await mockProjects(page, { current: fixture() });
  await page.goto(`/workspace?project=ws-cast&suite=particl&page=cast`);
  /* The phone shell renders here now (wave M-A): /workspace is the phone's
     surface below 768px, and the desktop studio row is not mounted. */
  await expect(page.getByTestId("phone-shell")).toBeVisible();
  await expect(page.getByTestId("studio-row")).toHaveCount(0);
});

test("Cast renders cards from the draft and identities, inspects, walks with arrows and opens Rig", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ids: IdentityRoute = {
    price: 54, posts: [],
    identities: [
      identity({ id: "id_lead", name: "Lead", creditsBilled: 54, references: [1, 2, 3, 4, 5, 6].map((n) => ({ uploadId: `up_lead_${n}` })) }),
      identity({ id: "id_spare", name: "Stand-in", status: "training", references: [{ uploadId: "up_spare_1" }] }),
    ],
  };
  await open(page, { current: fixture() }, ids);

  const castGroup = page.getByRole("region", { name: "Cast" });
  const elementGroup = page.getByRole("region", { name: "Elements" });
  await expect(castGroup.locator(".pxw-cast-card")).toHaveCount(3);
  await expect(elementGroup.locator(".pxw-cast-card")).toHaveCount(2);
  await expect(page.getByTestId("page-sub")).toHaveText("3 cast · 2 elements");
  await expect(card(page, "up_lead")).toContainText("Identity locked");
  await expect(card(page, "up_lead")).toContainText("6 references");
  await expect(card(page, "up_lead").locator(".pxw-cast-badge")).toHaveText("IDENTITY");
  await expect(card(page, "up_second")).toContainText("Draft · needs 1 more");
  await expect(card(page, "up_second")).toContainText("2 references · draft identity");
  await expect(card(page, "identity:id_spare")).toContainText("Identity training");
  await expect(card(page, "up_sphere")).toContainText("Cited by 2 shots");
  await expect(card(page, "up_plate")).toContainText("Cited by 2 shots");
  await expect(card(page, "up_plate").locator(".pxw-cast-badge")).toHaveText("ENVIRONMENT");
  await expect(page.getByTestId("add-cast")).toContainText("Identity training · 54 cr");

  /* The first card is selected; its Inspector carries the identity line and only backed facts. */
  await expect(selected(page)).toHaveAttribute("data-cast-id", "up_lead");
  await expect(page.getByTestId("identity-card")).toContainText("Locked identity");
  await expect(page.getByTestId("identity-card")).toContainText("Every shot citing this identity reuses the same reference set, byte-identical. Face, wardrobe and build hold across shots, engines and suites.");
  const consistency = page.getByTestId("consistency");
  await expect(consistency).toContainText("Cited by1 shot");
  await expect(consistency).toContainText("References6");
  await expect(consistency).toContainText("Training billed54 cr");
  await expect(consistency).not.toContainText("Face");
  await expect(page.getByTestId("reference-grid").locator("img")).toHaveCount(6);

  /* ← → walk the cast list in order. */
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toHaveAttribute("data-cast-id", "up_second");
  await expect(page.getByTestId("inspector-title")).toHaveText("Second figure");
  await expect(consistency).toContainText("Needed to lock1 more");
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toHaveAttribute("data-cast-id", "identity:id_spare");
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toHaveAttribute("data-cast-id", "up_sphere");
  await page.keyboard.press("ArrowLeft");
  await expect(selected(page)).toHaveAttribute("data-cast-id", "identity:id_spare");

  for (const size of CLIP_WIDTHS) {
    await page.setViewportSize(size);
    await assertNoClipping(page);
  }
  if (info.project.name === "workbench-1440x900") {
    await page.setViewportSize({ width: 1440, height: 900 });
    await card(page, "up_lead").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath("cast-1440x900.png") });
  }

  /* Use in Rig: Rig opens on the shot that cites this identity. */
  await card(page, "up_lead").click();
  await page.getByTestId("use-in-rig").click();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(page).toHaveURL(/[?&]sel=shot%3As2(&|$)/);
  expect(errors).toEqual([]);
});

test("+ Add cast opens the identity flow with the live price; a stale price blocks training", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const ids: IdentityRoute = { price: 54, posts: [], identities: [] };
  await open(page, { current: fixture() }, ids);
  await card(page, "up_second").click();
  await page.getByRole("button", { name: "Lock identity · 54 cr" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Identity", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Identity name")).toHaveValue("Second figure");
  await dialog.getByLabel("Use portrait Second figure / profile").check();
  await dialog.getByLabel("Use portrait Location scout").check();
  await dialog.getByRole("checkbox", { name: /I have the rights and consent/ }).check();
  const train = dialog.getByRole("button", { name: "Train identity · 54 credits" });
  await expect(train).toBeEnabled();

  /* The price moves after the quote was shown: the request carries the old ceiling and is refused. */
  ids.price = 60;
  await train.click();
  /* The refusal is settled: nothing is left to recover, and the panel re-reads the live price.
     (The panel's own post-submit refresh clears its error line — existing SoulIdentityPanel behaviour.) */
  await expect(dialog.getByText("Recover saved training request")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Train identity · 60 credits" })).toBeVisible();
  expect(ids.posts).toHaveLength(1);
  expect(ids.posts[0]).toMatchObject({ projectId: "ws-cast", name: "Second figure", maxCredits: 54, consent: true, subjectType: "character" });
  expect((ids.posts[0].references as unknown[]).length).toBe(3);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  /* Nothing trained: the card is still a draft. */
  await expect(card(page, "up_second")).toContainText("Draft · needs 1 more");
});

test("attaching a ready identity saves the draft through the revision-checked route", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const store: ProjectRoute = { current: fixture() };
  const ids: IdentityRoute = { price: 54, posts: [], identities: [identity({ id: "id_spare", name: "Stand-in", references: [{ uploadId: "up_extra" }] })] };
  await open(page, store, ids);
  await expect(card(page, "identity:id_spare")).toContainText("Identity locked");
  await page.getByTestId("primary-action").click();
  const dialog = page.getByRole("dialog");
  const saved = page.waitForRequest((r) => r.url().includes("/api/workbench/projects") && r.method() === "PUT");
  await dialog.getByRole("button", { name: "Use in Characters" }).click();
  await saved;
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => store.current.assets.some((a) => a.soulIdentityId === "id_spare" && a.category === "Character")).toBe(true);
  const attached = store.current.assets.find((a) => a.soulIdentityId === "id_spare")!;
  await expect(card(page, attached.id)).toContainText("Identity locked");
  await expect(card(page, "identity:id_spare")).toHaveCount(0);
});
