import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * GLASS_SPEC §5, desktop: the wallpaper shows in 10px gutters; four islands
 * with the specular top edge; every control a capsule, every thumbnail 12px;
 * ⌘K and the model sheet are glass over a light scrim; context-menu rows are
 * capsules; Rig nodes are glass with glass-cored ports; below 1280 the
 * Library and Inspector float as overlays inset 10px.
 */
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];
const shot = (id: string, title: string, note: string, y: number): CanvasNode => ({
  id, title, type: "scene", x: 100, y, width: 344, linked: [], role: "Director", status: "draft", mode: "Video",
  operations: [{ id: `op-${id}`, kind: "direction", enabled: true, values: { note } }],
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});
const fixture = (): Project => ({
  ...newProject("Dune Studies"), id: "glass", productionProjectId: "prod-glass", shotMappings: {},
  nodes: [shot("glass-a", "The encounter", "She enters. The landscape becomes a reflection.", 100), shot("glass-b", "Departure", "Wide again.", 500)],
});

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("project-name")).toHaveText("Dune Studies");
  return errors;
}

const style = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

test("desktop: wallpaper, four glass islands with 10px gutters, capsule controls, 12px thumbnails, glass overlays and Rig nodes", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "desktop widths");
  const errors = await open(page, "/suites?suite=studio&page=rig");
  /* Two things a browser can do with the blur: not know the property (then the layer's own @supports
     fallback fires — blur off, panel alphas at .92) or know it and still compute `none` (CI's headless
     shell). Both are read from the page, not assumed; a browser that applies it asserts the blur. */
  const [applies, fallback] = await page.evaluate(() => {
    const probe = document.createElement("div"); probe.style.backdropFilter = "blur(1px)"; document.body.appendChild(probe);
    const applies = getComputedStyle(probe).backdropFilter !== "none" && getComputedStyle(probe).backdropFilter !== ""; probe.remove();
    const fallback = getComputedStyle(document.querySelector(".gx")!).getPropertyValue("--gl-blur").trim() === "none";
    return [applies, fallback];
  });
  const blur = (px: string) => (applies && !fallback ? `blur(${px})` : "none");
  const panel = (alpha: string) => (fallback ? "rgba(28, 28, 34, 0.92)" : `rgba(28, 28, 34, ${alpha})`);

  /* The ground is the wallpaper; the body grid keeps 10px gutters over it. */
  expect(await style(page, ".gx", "background-image")).toContain("radial-gradient");
  await expect(page.getByTestId("shell-body")).toHaveCSS("gap", "10px");
  await expect(page.getByTestId("shell-body")).toHaveCSS("padding", "10px");
  expect(await style(page, ".gx-body", "background-color")).toBe("rgba(0, 0, 0, 0)");

  /* Toolbar, stage capsule, Library, stage and Inspector are islands: blur, edge, specular top edge, radius. */
  for (const [selector, radius, edge] of [[".gx-header", "22px", "0.14"], [".gx-strip", "999px", "0.12"], [".gx-library", "22px", "0.14"], [".gx-main", "22px", "0.14"], [".gx-inspector", "22px", "0.14"]] as const) {
    expect(await style(page, selector, "backdrop-filter"), selector).toContain(blur("40px"));
    expect(await style(page, selector, "box-shadow"), selector).toContain("inset");
    expect(await style(page, selector, "border-top-color"), selector).toBe(`rgba(255, 255, 255, ${edge})`);
    await expect(page.locator(selector).first(), selector).toHaveCSS("border-radius", radius);
  }
  await expect(page.locator(".gx-header").first()).toHaveCSS("height", "64px");
  await expect(page.locator(".gx-strip").first()).toHaveCSS("height", "48px");

  /* Every control is a capsule; thumbnails and tag tiles are 12px boxes. */
  for (const selector of [".gx-hbtn", ".gx-search", ".gx-seg", ".gx-seg-btn", ".gx-tab", ".gx-primary", ".gx-chip", ".gx-pill"]) {
    const el = page.locator(selector).first();
    if (await el.count()) await expect(el, selector).toHaveCSS("border-radius", "999px");
  }
  await expect(page.locator(".gx-tool-tag").first()).toHaveCSS("border-radius", "12px");
  expect(await style(page, ".gx-tool-group", "background-image")).toContain("linear-gradient");
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  await expect(page.locator(".gx-chip").first()).toHaveCSS("border-radius", "999px");
  await expect(page.locator(".gx-field").first()).toHaveCSS("border-radius", "999px");

  /* Rig › Canvas: nodes are glass; the ports carry a glass core. */
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(page.getByTestId("rig-graph")).toBeVisible();
  const node = page.locator(".gx .pxw-graph-node").first();
  await expect(node).toBeVisible();
  await expect(node).toHaveCSS("border-radius", "16px");
  expect(await node.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain(blur("24px"));
  expect(await node.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
  const port = page.locator(".gx .pxw-graph-port").first();
  await expect(port).toBeAttached();
  expect(await port.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain(blur("8px"));
  expect(await port.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(panel("0.72"));

  /* The context menu is glass with capsule rows. */
  await page.locator(".gx-main").first().click({ button: "right", position: { x: 200, y: 200 } });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain(blur("40px"));
  await expect(menu).toHaveCSS("border-radius", "18px");
  await expect(menu.getByRole("menuitem").first()).toHaveCSS("border-radius", "999px");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  /* ⌘K: the palette is glass over the light scrim. */
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.locator(".gx-palette");
  await expect(palette).toBeVisible();
  expect(await palette.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain(blur("40px"));
  expect(await palette.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(panel("0.72"));
  expect(await style(page, ".gx-veil", "background-color")).toBe("rgba(6, 6, 12, 0.45)");
  expect(await style(page, ".gx-veil", "backdrop-filter")).toContain(blur("18px"));
  await expect(page.locator(".gx-palette-row").first()).toHaveCSS("border-radius", "999px");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  /* Gen: the model sheet is the same glass; Generate is the 44px capsule. */
  await page.getByRole("tablist", { name: "Suites" }).getByRole("tab", { name: "Gen" }).click();
  await expect(page.locator(".gx-gen-go")).toHaveCSS("border-radius", "999px");
  await expect(page.locator(".gx-gen-go")).toHaveCSS("height", "44px");
  await expect(page.locator(".gx-well").first()).toHaveCSS("border-top-style", "dashed");
  await page.getByTestId("gen-model").click();
  const sheet = page.locator(".gx-sheet");
  await expect(sheet).toBeVisible();
  /* The veil covers the window, not just the stage island (a filtered ancestor would contain it). */
  expect(await page.locator(".gx-veil").evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.width)]; })).toEqual([0, 0, page.viewportSize()!.width]);
  expect(await sheet.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain(blur("40px"));
  await expect(sheet).toHaveCSS("border-radius", "18px");
  await expect(page.locator(".gx-sheet-row").first()).toHaveCSS("border-radius", "999px");
  /* A tap on the scrim closes the sheet. */
  await page.getByTestId("model-sheet-veil").click({ position: { x: 8, y: 8 } });
  await expect(sheet).toBeHidden();

  /* Narrow: Library and Inspector float over the stage, inset 10px, on the overlay tone. */
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.getByTestId("toggle-library").click();
  const library = page.getByTestId("library");
  await expect(library).toHaveClass(/gx-panel--overlay/);
  await expect(library).toHaveCSS("top", "10px");
  await expect(library).toHaveCSS("left", "10px");
  await expect(library).toHaveCSS("border-radius", "22px");
  expect(await library.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(24, 24, 30, 0.86)");
  expect(await style(page, ".gx-scrim", "backdrop-filter")).toContain(blur("18px"));
  expect(errors).toEqual([]);
});
