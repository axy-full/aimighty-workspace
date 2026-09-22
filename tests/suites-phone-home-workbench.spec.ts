import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";

/**
 * Particl Mobile.dc.html › STUDIO HOME: on the phone, the Studio tab opens
 * the home — the project's name, Up next, the eight stage cards, recent takes;
 * a card opens its page and ‹ Studio in the header comes back. The desktop
 * strip never shows the home.
 */
const PHONES = ["workbench-360x640", "workbench-390x844"];
const fixture = (): Project => ({
  ...newProject("Coastal light study"), id: "ws-home", productionProjectId: "prod-home", shotMappings: {},
  brief: "A fox crosses a frozen harbour at dusk",
  shots: [{ id: "s1", name: "The crossing", assetId: "", duration: 5, sourceIn: 0, note: "" }],
});

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" })] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return errors;
}

test("phone: Home › the Studio tile opens the stage grid; a card opens its page; ‹ Studio and ‹ Home come back; the floors hold", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const errors = await open(page, "/suites?suite=studio&page=rig");
  await expect(page.getByTestId("phone-back")).toHaveText(/Studio/);
  await page.getByTestId("tabbar-home").click();
  await expect(page.getByTestId("suite-home")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Where to?");
  await expect(page.getByTestId("phone-back")).toHaveCount(0);
  await page.getByTestId("home-suite-studio").click();
  const home = page.getByTestId("studio-home");
  await expect(home).toBeVisible();
  await expect(page.getByTestId("phone-back")).toHaveText(/Home/);
  await expect(page.getByTestId("page-title")).toHaveText("Coastal light study");
  await expect(page.getByTestId("home-up-next")).toContainText("Up next · Shot 01");
  await expect(home.getByRole("listitem")).toHaveCount(8);
  await expect(page.getByTestId("home-stage-brief")).toContainText("8 words");
  await expect(page.getByTestId("home-stage-rig")).toContainText("1 shot · 0 rendered");
  await expect(page.getByTestId("home-recent").locator(".gx-home-take")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Studio|Home/ })).toHaveCount(0);
  expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  expect(await smallTargets(page, ".gx-home"), "targets under 44×44").toEqual([]);

  await page.getByTestId("home-stage-takes").click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await page.getByTestId("phone-back").click();
  await expect(page.getByTestId("studio-home")).toBeVisible();
  await page.getByTestId("home-generate-next").click();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await page.getByTestId("phone-back").click();
  await expect(page.getByTestId("studio-home")).toBeVisible();
  await page.getByTestId("phone-back").click();
  await expect(page.getByTestId("suite-home")).toBeVisible();
  expect(errors).toEqual([]);
});

test("desktop: the strip has neither the Home nor the Studio grid tab and the header no back button", async ({ page }, info) => {
  test.skip(!["workbench-1440x900"].includes(info.project.name), "one desktop width");
  const errors = await open(page, "/suites?suite=studio&page=rig");
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button")).toHaveCount(8);
  await expect(page.getByTestId("phone-back")).toBeHidden();
  await expect(page.getByTestId("tabbar")).toBeHidden();
  expect(errors).toEqual([]);
});
