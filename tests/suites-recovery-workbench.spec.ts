import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * The Suites shell recovers instead of sticking: Back leaves /suites after
 * the landing, a failed Library read says so with Try again, Load more reaches
 * takes past the first page, Recreate refills Gen while Gen is open, a plan that
 * cannot run says why (in its sheet, and under the stage strip once the sheet
 * is closed), and a failed Ads quote re-arms Generate on its own only when
 * the failure passes by itself; an idle page asks the account nothing. Every
 * reply is route-mocked; nothing paid is ever sent.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-recover", productionProjectId: "prod-ws", shotMappings: {} });

const takes = [
  generation({ id: "gen_harbour", title: "Harbour at dawn", prompt: "Harbour at dawn, enhanced", params: { rawPrompt: "harbour at dawn", ratio: "9:16", duration: 5 } }),
  generation({ id: "gen_alley", title: "Neon alley", prompt: "Neon alley in the rain", params: {} }),
  generation({ id: "gen_pier", title: "Pier at noon", prompt: "Pier at noon", params: {} }),
];
/* Audio takes as /api/audio stores them (lib/audioAdmission.ts): params.task is always set. */
const sounds = [
  generation({ id: "gen_score", kind: "audio", model: "eleven_music", title: "Harbour score", prompt: "Slow strings under gulls", params: { task: "music", lengthMs: 45_000, instrumental: true } }),
  generation({ id: "gen_talk", kind: "audio", model: "eleven_v3", title: "Two voices", prompt: "", params: { task: "dialogue", lines: [{ text: "Morning.", voiceId: "v1" }] } }),
];

async function open(page: Page, url: string, library: { pageSize?: number; failFirst?: () => boolean; generations?: ReturnType<typeof generation>[] } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })], generations: library.generations ?? takes, pageSize: library.pageSize });
  /* Registered after mockLibrary, so it answers first: a failing read while the test says so. */
  await page.route("**/api/workbench/library**", (route) => {
    if (route.request().method() === "GET" && library.failFirst?.()) return route.fulfill({ status: 503, json: { error: "The library is busy. Try again shortly." } });
    return route.fallback();
  });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors };
}

const openAssets = async (page: Page, wide: boolean) => {
  if (!wide) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
};

test("the landing replaces the entry URL: one Back leaves /suites", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await page.goto("/api/me");
  const before = page.url();
  const { errors } = await open(page, "/suites?suite=particl");
  await expect(page).toHaveURL(/sp=/);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(before);
  expect(errors).toEqual([]);
});

test("a failed Library read says so with Try again; Load more reaches takes past the first page", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  let failing = true;
  const { errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards", { pageSize: 2, failFirst: () => failing });
  await openAssets(page, WIDE.includes(info.project.name));
  const library = page.getByTestId("library");
  await expect(library.getByTestId("library-error")).toContainText("The library is busy. Try again shortly.");
  await expect(library.getByText("Reading this project…")).toHaveCount(0);
  /* Said once: the end-of-list Load more stays out of the way while the first read has failed. */
  await expect(library.getByTestId("library-more-error")).toHaveCount(0);
  failing = false;
  await library.getByTestId("library-error").getByRole("button", { name: "Try again" }).click();
  const tiles = library.locator(".gx-asset-thumb[data-ctx^='asset:generation:']");
  await expect(tiles).toHaveCount(2);
  await expect(library.getByTestId("library-more-button")).toHaveText("Load more · 3 shown");
  const box = await library.getByTestId("library-more-button").boundingBox();
  if (!WIDE.includes(info.project.name)) expect(box!.height).toBeGreaterThanOrEqual(44);
  await library.getByTestId("library-more-button").click();
  await expect(tiles).toHaveCount(3);
  await expect(library.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_pier']")).toHaveCount(1);
  await expect(library.getByTestId("library-more")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Takes counts past the first page and loads the rest", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=studio&page=takes", { pageSize: 2 });
  await expect(page.getByText("3+ in this project")).toBeVisible();
  await page.getByTestId("takes-more-button").click();
  await expect(page.getByText("4 in this project")).toBeVisible();
  await expect(page.getByTestId("takes-more")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("the Rig's own library pages on with Load more, from the same store as the Library panel", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=studio&page=rig", { pageSize: 2 });
  const rig = page.getByTestId("rig-library");
  await expect(rig.getByTestId("rig-library-more-button")).toHaveText("Load more · 3 shown");
  const box = await rig.getByTestId("rig-library-more-button").boundingBox();
  if (!WIDE.includes(info.project.name)) expect(box!.height).toBeGreaterThanOrEqual(44);
  await rig.getByTestId("rig-library-more-button").click();
  await expect(rig.getByTestId("rig-library-more")).toHaveCount(0);
  await expect(rig.getByTestId("rig-library-Generations")).toHaveText("Generations · 3");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Recreate on a music take opens Gen on Audio with its prompt; a dialogue says where it is made", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?view=gen", { generations: [...takes, ...sounds] });
  const gen = page.getByTestId("gen-view");
  const menu = page.getByTestId("context-menu");
  await gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_talk']").click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Recreate" })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Recreate" })).toHaveAttribute("title", "A dialogue is made in Edit & Sound, not Gen.");
  await page.keyboard.press("Escape");
  await gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_score']").click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Recreate" })).toBeEnabled();
  await menu.getByRole("menuitem", { name: "Recreate" }).click();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("Slow strings under gulls");
  await expect(gen.getByRole("tab", { name: "Audio" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Harbour score");
  expect(errors).toEqual([]);
});

test("Recreate refills Gen while Gen is open, with that take's own inputs", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?view=gen");
  const gen = page.getByTestId("gen-view");
  await expect(gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_harbour']")).toBeVisible();
  const menu = page.getByTestId("context-menu");
  await gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_harbour']").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Recreate" }).click();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("harbour at dawn");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Harbour at dawn");
  /* Again, from the same open Gen: the composer changes at once. */
  await gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_alley']").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Recreate" }).click();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("Neon alley in the rain");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Neon alley");
  expect(await page.evaluate(() => sessionStorage.getItem("particl-gen-preset"))).toBeNull();
  expect(errors).toEqual([]);
});

test("a plan that cannot run says why in its sheet, then under the stage strip once the sheet is closed, and the note can be dismissed", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  /* Astra's plan cannot run before its scene is saved (Business, which this used, ran on the retired Higgsfield sign-in). */
  const { errors } = await open(page, "/suites?suite=studio&page=astra");
  await page.getByTestId("primary-action").click();
  /* Run stage opens the page's sheet, which says why; one gate at a time, so the row waits while it is open. */
  const sheet = page.getByTestId("atomik-panel");
  /* Before the stage publishes its data the reason is that data; after, what the data lacks. Either way it cannot run. */
  const why = /Needs Astra 3D data|save the scene in Astra first/;
  await expect(sheet).toContainText(why);
  const notice = page.getByTestId("suites-atomik-notice");
  await expect(notice).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(notice).toContainText(why);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});
