import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";

/**
 * FINAL_SPEC §6, the flair layer: the header aurora tinted per view, glyph
 * suite tabs whose labels clip (not vanish) below 1180px, framed Library ›
 * Tools groups in the department colours, kind-dot chips, the project poster
 * tile; on phones the glass tab bar routes to the shell's own views and keeps
 * the thumb floors.
 */
const PHONES = ["workbench-360x640", "workbench-390x844"];
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Dune Studies"), id: "flair", productionProjectId: "prod-flair", shotMappings: {} });

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

test("desktop: aurora per view, glyph tabs with labels that clip below 1180px, framed tool groups, kind dots, poster tile", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "desktop widths");
  const errors = await open(page, "/suites?suite=studio&page=rig");
  /* Read the blob tint through a probe's computed colour: Chromium builds
     differ on how they serialise the raw custom property. */
  const tint = () => page.locator(".gx").evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--om-a)";
    el.appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
  await expect(page.getByTestId("header-aurora")).toBeAttached();
  expect(await tint()).toBe("rgba(10, 132, 255, 0.55)");
  /* 60px under the flair layer; the glass layer (GLASS_SPEC §2) makes the toolbar a 64px island. */
  await expect(page.locator(".gx-header").first()).toHaveCSS("height", "64px");

  const suites = page.getByRole("tablist", { name: "Suites" });
  await expect(suites.getByRole("tab")).toHaveCount(6);
  await expect(suites.locator("svg.gx-glyph")).toHaveCount(6);
  await expect(suites.locator(".gx-sig")).toHaveCount(6);
  expect(await suites.getByRole("tab", { name: "Business" }).evaluate((el) => (el as HTMLElement).style.getPropertyValue("--suite"))).toBe("#FF9F0A");
  await expect(suites.getByRole("tab", { name: "Studio" }).locator(".gx-seg-label")).toBeVisible();

  /* Library › Tools: framed groups in the department cycle; assets chips carry kind dots. */
  const groups = page.getByTestId("tool-group");
  /* Brief & Script (the landing page) has its two Production groups: Agent and Script. */
  expect(await groups.count()).toBeGreaterThanOrEqual(2);
  expect(await groups.nth(0).evaluate((el) => (el as HTMLElement).style.getPropertyValue("--dept"))).toBe("#0A84FF");
  expect(await groups.nth(1).evaluate((el) => (el as HTMLElement).style.getPropertyValue("--dept"))).toBe("#BF5AF2");
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  await expect(page.locator(".gx-chip[data-kind='Video']")).toHaveAttribute("style", /--kind:\s*#30D158/);
  await expect(page.locator(".gx-chip[data-kind='All']")).toBeVisible();

  /* The project head's poster tile carries the sample palette. */
  const tile = page.getByTestId("project-switcher").locator(".gx-project-tile");
  await expect(tile).toHaveText("DS");
  await expect(tile).toHaveCSS("width", "72px");
  expect(await tile.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--poster-from"))).toBe("#7A5A34");

  /* Gen and Crew re-tint the header. */
  await suites.getByRole("tab", { name: "Gen" }).click();
  expect(await tint()).toBe("rgba(191, 90, 242, 0.5)");
  await suites.getByRole("tab", { name: "Crew" }).click();
  await expect(page.getByTestId("suite-mark")).toHaveText("CREW");
  expect(await tint()).toBe("rgba(191, 90, 242, 0.5)");

  /* Below 1180 the labels clip but the tab still answers to its name. */
  await page.setViewportSize({ width: 1100, height: 800 });
  const label = suites.getByRole("tab", { name: "Studio" }).locator(".gx-seg-label");
  expect(await label.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  await expect(suites.getByRole("tab", { name: "Studio" }).locator("svg.gx-glyph")).toBeVisible();
  await suites.getByRole("tab", { name: "Studio" }).click();
  await expect(page.locator(".gx")).toHaveAttribute("data-suite", "studio");
  await expect(page.getByTestId("tabbar")).toBeHidden();
  expect(errors).toEqual([]);
});

test("phone: the glass tab bar routes Home · Gen · Suites · Assets · More through the shell and keeps the floors", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const errors = await open(page, "/suites?suite=studio&page=rig");
  const bar = page.getByTestId("tabbar");
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button")).toHaveText(["Home", "Gen", "Suites", "Assets", "More"]);
  await expect(page.getByTestId("tabbar-home")).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".gx-header").first()).not.toHaveCSS("overflow", "hidden");
  await expect(page.getByRole("tablist", { name: "Suites" }).getByRole("tab")).toHaveCount(6);

  await page.getByTestId("tabbar-gen").click();
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await expect(page.getByTestId("tabbar-gen")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("tabbar-home")).not.toHaveAttribute("aria-current", "page");

  await page.getByTestId("tabbar-suites").click();
  await expect(page.getByRole("tablist", { name: "Suites" }).getByRole("tab", { name: "Business" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tabbar-suites")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("tabbar-assets").click();
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("tabbar-assets")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("tabbar-more").click();
  await expect(page.getByTestId("workspace-view")).toBeVisible();
  await expect(page.getByTestId("tabbar-more")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("tabbar-home").click();
  await expect(page.locator(".gx")).toHaveAttribute("data-suite", "studio");
  await expect(page.getByTestId("suite-home")).toBeVisible();
  await expect(page.getByTestId("tabbar-home")).toHaveAttribute("aria-current", "page");
  expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  expect(await smallTargets(page, ".gx-tabbar"), "targets under 44×44").toEqual([]);
  expect(errors).toEqual([]);
});
