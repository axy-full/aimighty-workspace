import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Viral = Genjutsu (FINAL_SPEC §1 step 3). Its pages ran on the connected
 * Higgsfield account, whose sign-in is retired
 * (lib/higgsfield-consumer/retired.ts): for everyone, the workspace owner
 * included, Motion Transfer, Object Swap and History are one card, with Gen on
 * Video as the way on. A run's result is still a take in the Library. Nothing
 * asks the account.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-viral", productionProjectId: "prod-ws", shotMappings: {} });
/** A finished account run's original, filed to the project like any take. */
const GEN = "gen_hfc_" + "a".repeat(40);

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_src", filename: "walk.mp4", mime: "video/mp4", kind: "video", durationS: 12 }), upload({ id: "up_ref", filename: "mira.png", mime: "image/png" })],
    generations: [generation({ id: GEN, title: "Swapped bottle", kind: "video", model: "genjutsu", provider: "higgsfield", params: { task: "connected-generation", workflow: "genjutsu", consumerCreditUnit: "higgsfield_credits" } })],
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

test("Motion Transfer, Object Swap and History are the retired card for the owner; the run's result is still in the Library; nothing asks the account", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, asked } = await open(page);
  for (const sp of ["motion", "swap", "history"] as const) {
    await page.goto(`/suites?suite=subatomik&page=${sp}&sp=${sp}`);
    await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
    const card = page.getByTestId("owner-run-viral");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("owner-run-viral-title")).toHaveText("Particl no longer signs in to Higgsfield");
    await expect(card).toContainText("Past results stay in your Library.");
    for (const gone of ["viral-view", "viral-well", "viral-generate", "viral-history"]) await expect(page.getByTestId(gone)).toHaveCount(0);
    await expect(page.getByTestId("primary-action")).toHaveCount(0);
    await noSideScroll(page);
    if (PHONES.includes(info.project.name))
      for (const button of await card.getByRole("button").all()) expect(Math.round((await button.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  }

  /* History reads: the run's result is a take in the Library like any other. */
  const library = page.getByTestId("library");
  const opened = !(await library.isVisible());
  if (opened) await page.getByTestId("toggle-library").click();
  await expect(library.locator(`.gx-asset-thumb[data-ctx='asset:generation:${GEN}']`)).toBeVisible();
  if (opened) await page.getByTestId("close-library").click();

  /* The way on: Gen, on Video, on this workspace's credits. */
  await page.getByTestId("owner-run-viral-gen").click();
  await expect(page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Video" })).toHaveAttribute("aria-selected", "true");
  expect(asked, "nothing asks the account").toEqual([]);
  expect(errors).toEqual([]);
});
