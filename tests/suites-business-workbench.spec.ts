import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Business = Marketing Studio (FINAL_SPEC §2). Its pages ran on the connected
 * Higgsfield account, whose sign-in is retired
 * (lib/higgsfield-consumer/retired.ts): for everyone, the workspace owner
 * included, Ads, Image ads and Setup are one card, with Gen on Images (at its
 * price) as the way on. An ad made before is still a take in the Library.
 * Nothing asks the account.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-biz", productionProjectId: "prod-ws", shotMappings: {} });
/** An image ad the account rendered earlier, filed to the project like any take. */
const AD = "gen_hfc_" + "b".repeat(40);

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })],
    generations: [generation({ id: AD, title: "Bottle ad", kind: "image", model: "marketing_studio_image", provider: "higgsfield", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits" } })],
  });
  /* Every account request the page makes, bar the shell collector's list of saved jobs (a ledger read). */
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/higgsfield/consumer/")) return;
    if (request.method() === "GET" && url.pathname === "/api/higgsfield/consumer/generation") return;
    asked.push(`${request.method()} ${url.pathname}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { errors, asked };
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}

test("Ads, Image ads and Setup are the retired card for the owner; an earlier ad is still in the Library; nothing asks the account", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, asked } = await open(page);
  for (const sp of ["ads", "dtc", "setup"] as const) {
    await page.goto(`/suites?suite=moleculr&page=marketing&sp=${sp}`);
    await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
    const card = page.getByTestId("owner-run-business");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("owner-run-business-title")).toHaveText("Particl no longer signs in to Higgsfield");
    await expect(card).toContainText("Ads and image ads here ran on a signed-in Higgsfield account. Past results stay in your Library.");
    for (const gone of ["ads-view", "dtc-view", "setup-view", "ads-generate", "ads-connect", "dtc-connect", "setup-connect"]) await expect(page.getByTestId(gone)).toHaveCount(0);
    await expect(page.getByTestId("primary-action")).toHaveCount(0);
    await noSideScroll(page);
    if (PHONES.includes(info.project.name))
      for (const button of await card.getByRole("button").all()) expect(Math.round((await button.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  }

  /* An ad made before reads as a take in the Library. */
  const library = page.getByTestId("library");
  const opened = !(await library.isVisible());
  if (opened) await page.getByTestId("toggle-library").click();
  await expect(library.locator(`.gx-asset-thumb[data-ctx='asset:generation:${AD}']`)).toBeVisible();
  if (opened) await page.getByTestId("close-library").click();

  /* The way on: Gen, on Images, on this workspace's credits, priced before anything is spent. */
  await expect(page.getByTestId("owner-run-business-price")).toContainText(/ cr|priced on Generate|No Studio engine/);
  await page.getByTestId("owner-run-business-gen").click();
  await expect(page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Images" })).toHaveAttribute("aria-selected", "true");
  expect(asked, "nothing asks the account").toEqual([]);
  expect(errors).toEqual([]);
});
