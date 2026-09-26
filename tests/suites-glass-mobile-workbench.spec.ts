import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";

/**
 * GLASS_SPEC §3 / §5, mobile: Home shows only "Where to?", six suite tiles
 * with a live fact each and the Assets row; the tab bar floats 22px above the
 * bottom with the active pill; the top bar is a glass island with the context
 * badge; the Studio tile opens the stage grid with a Home back; sheets are
 * glass; nothing hides under the tab bar; every target is 44px.
 */
const PHONES = ["workbench-360x640", "workbench-390x844"];
const fixture = (): Project => ({
  ...newProject("Dune Studies"), id: "glass-m", productionProjectId: "prod-glass-m", shotMappings: {},
  brief: "A fox crosses a frozen harbour at dusk",
  shots: [{ id: "s1", name: "The crossing", assetId: "", duration: 5, sourceIn: 0, note: "" }],
});

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "g1", title: "Wide on the water", prompt: "Wide on the water" })] });
  await page.route("**/api/crew/members?*", (route) => route.fulfill({ json: { members: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("project-name")).toHaveText("Dune Studies");
  return errors;
}

const css = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

test("phone: Home is the suite picker; the tab bar and top bar float as glass; Studio opens the grid with a Home back; sheets are glass; the floors hold", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  /* `sp` names the shell page where several share a legacy page: the Home sits on Brief's. */
  const errors = await open(page, "/suites?suite=studio&page=brief&sp=home");
  const home = page.getByTestId("suite-home");
  await expect(home).toBeVisible();
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

  await expect(page.getByTestId("home-project")).toHaveText("Dune Studies");
  await expect(page.getByTestId("page-title")).toHaveText("Where to?");
  await expect(page.getByTestId("suite-mark")).toHaveText("HOME");

  /* Six tiles, verbatim lines, live facts in the suite colour; the Assets row; nothing else. */
  const tiles = home.getByRole("listitem");
  await expect(tiles).toHaveCount(6);
  await expect(tiles).toContainText(["Brief to delivery, ten stages.", "Video, images, audio — one composer.", "Marketing Studio: product, presenter, ad.", "Genjutsu: motion transfer, object swap.", "Plans, prices, waits for your word.", "One Grok agent per department."]);
  /* The brief has words, one take exists and one shot is cut: Brief, Takes and Edit & Sound are done. */
  await expect(page.getByTestId("home-fact-studio")).toHaveText("3 of 10 done");
  await expect(page.getByTestId("home-fact-gen")).toHaveText("Seedance 2.5 · default");
  await expect(page.getByTestId("home-fact-business")).toHaveText("UGC · 15 s · quoted in Ads");
  await expect(page.getByTestId("home-fact-atomik")).toHaveText("0 awaiting approval");
  await expect(page.getByTestId("home-fact-crew")).toHaveText("3 seats");
  expect(await page.getByTestId("home-fact-studio").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(10, 132, 255)");
  await expect(page.getByTestId("home-assets")).toContainText("1 in Dune Studies");
  await expect(home.locator(".gx-home-grid, .gx-home-next, .gx-home-recent")).toHaveCount(0);
  await expect(page.getByTestId("studio-home")).toHaveCount(0);
  for (const selector of [".gx-where-tile", ".gx-where-assets"]) {
    const el = page.locator(selector).first();
    await expect(el).toHaveCSS("border-radius", selector === ".gx-where-tile" ? "22px" : "999px");
  }
  expect(await smallText(page, ".gx-where"), "text under 12px").toEqual([]);
  expect(await smallTargets(page, ".gx-where, .gx-tabbar"), "targets under 44×44").toEqual([]);

  /* The tab bar floats: fixed, 12px in, 22px up, 66px tall, glass, the active tab a pill. */
  const bar = page.getByTestId("tabbar");
  await expect(bar).toHaveCSS("position", "fixed");
  await expect(bar).toHaveCSS("bottom", "22px");
  await expect(bar).toHaveCSS("left", "12px");
  await expect(bar).toHaveCSS("height", "66px");
  await expect(bar).toHaveCSS("border-radius", "999px");
  expect(await css(page, ".gx-tabbar", "backdrop-filter")).toContain(blur("40px"));
  await expect(bar.getByRole("button")).toHaveText(["Home", "Gen", "Suites", "Assets", "More"]);
  const homeTab = page.getByTestId("tabbar-home");
  await expect(homeTab).toHaveAttribute("aria-current", "page");
  expect(await homeTab.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
  await expect(homeTab).toHaveCSS("border-radius", "999px");
  const barTop = await bar.evaluate((el) => el.getBoundingClientRect().top);
  const viewport = page.viewportSize()!;
  expect(barTop + 66 + 22).toBeCloseTo(viewport.height, 0);

  /* The top bar is a glass island with the mark and the context badge; mark, credits and avatar share one row. */
  const header = page.locator(".gx-header").first();
  await expect(page.getByTestId("header-search")).toBeVisible();
  await expect(page.getByTestId("header-search")).toHaveCSS("width", "44px");
  const rowTops = await page.evaluate(() => [".gx-brand", '[data-testid="header-search"]', '[data-testid="workspace-credits"]', '[data-testid="workspace-avatar"]'].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().top)));
  expect(new Set(rowTops).size, `one row: ${rowTops.join(", ")}`).toBe(1);
  await expect(header).toHaveCSS("border-radius", "24px");
  expect(await css(page, ".gx-header", "backdrop-filter")).toContain(blur("40px"));
  expect(await css(page, ".gx-header", "margin-left")).toBe("10px");
  expect(await css(page, ".gx", "background-image")).toContain("radial-gradient");

  /* Nothing hides under the bar: every scroll region ends 110px above its own bottom. */
  await expect(page.getByTestId("content")).toHaveCSS("padding-bottom", "110px");
  await page.getByTestId("tabbar-more").click();
  await expect(page.getByTestId("workspace-view")).toHaveCSS("padding-bottom", "110px");
  await page.getByTestId("tabbar-home").click();
  await expect(home).toBeVisible();
  await page.getByTestId("content").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const assetsBottom = await page.getByTestId("home-assets").evaluate((el) => el.getBoundingClientRect().bottom);
  expect(assetsBottom).toBeLessThanOrEqual(barTop + 0.5);

  /* The Studio tile opens the stage grid; ‹ Home comes back; the badge reads STUDIO there. */
  await page.getByTestId("home-suite-studio").click();
  await expect(page.getByTestId("studio-home")).toBeVisible();
  await expect(page.getByTestId("suite-mark")).toHaveText("STUDIO");
  await expect(page.getByTestId("phone-back")).toHaveText(/Home/);
  await expect(homeTab).toHaveAttribute("aria-current", "page");
  await page.getByTestId("phone-back").click();
  await expect(home).toBeVisible();

  /* The Assets row opens the Library's Assets tab; the badge reads ASSETS. */
  await page.getByTestId("home-assets").click();
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("tabbar-assets")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("suite-mark")).toHaveText("ASSETS");
  await page.getByTestId("tabbar-home").click();
  await expect(home).toBeVisible();

  /* Gen's model sheet rises as glass: the sheet tone, the blur, the 30px top radius, over the scrim. */
  await page.getByTestId("home-suite-gen").click();
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await expect(page.getByTestId("suite-mark")).toHaveText("GEN");
  /* The sticky Generate sits just above the bar, never over the composer (measured once Gen's entrance,
     a 6px rise, has settled: the band's resting place is 4px over the bar). */
  const cta = page.locator(".gx-gen-cta");
  await page.getByTestId("gen-view").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const ctaBottom = await cta.evaluate((el) => el.getBoundingClientRect().bottom);
  expect(ctaBottom).toBeGreaterThanOrEqual(barTop - 8);
  expect(ctaBottom).toBeLessThanOrEqual(barTop + 0.5);
  await page.getByTestId("gen-model").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.getByTestId("gen-model").click();
  const sheet = page.locator(".gx-sheet");
  await expect(sheet).toBeVisible();
  /* The veil covers the whole screen (it leaves the filtered island) and the sheet rises into view. */
  expect(await page.locator(".gx-veil").evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })).toEqual([0, viewport.height]);
  await expect(sheet).toBeInViewport({ ratio: 0.9 });
  await expect(sheet).toHaveCSS("border-radius", "30px 30px 0px 0px");
  expect(await sheet.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain(blur("40px"));
  expect(await sheet.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(panel("0.78"));
  expect(await css(page, ".gx-veil", "background-color")).toBe("rgba(6, 6, 12, 0.45)");
  /* A tap on the scrim closes the sheet. */
  await page.getByTestId("model-sheet-veil").click({ position: { x: 8, y: 8 } });
  await expect(sheet).toBeHidden();
  expect(errors).toEqual([]);
});

test("desktop: no Home tab in the strip, no tab bar, and the desktop islands stay", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop width");
  const errors = await open(page, "/suites?suite=studio&page=rig");
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button")).toHaveCount(10);
  await expect(page.getByTestId("tabbar")).toBeHidden();
  await expect(page.getByTestId("suite-mark")).toHaveText("STUDIO");
  await expect(page.locator(".gx-header").first()).toHaveCSS("border-radius", "22px");
  expect(errors).toEqual([]);
});
