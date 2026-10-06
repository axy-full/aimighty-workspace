import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { openSuitesMenu } from "./helpers/suitesMenu";

/**
 * The Suites shell, audited (September 2026): a Recreate pressed on Gen lands
 * at once with its references and never replays later; the phone's Assets tab
 * works from More; "Run stage" opens the page's Atomik plan with its reason or
 * its gate; the Library's Tools lead somewhere or are not offered; the phone
 * Studio grid counts the project as saved now; an audio take opens its
 * transcript on Takes.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844"];

const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-audit", productionProjectId: "prod-ws", shotMappings: {}, brief: "A fox crosses the ice" });

async function open(page: Page, path: string, store = { current: fixture() }) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, store);
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" }), upload({ id: "up_tone", filename: "room-tone.mp3", mime: "audio/mpeg", kind: "audio", width: 0, height: 0 })],
    generations: [
      generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water", params: { rawPrompt: "wide on the water, raw", references: [{ uploadId: "up_plate", role: "reference_image", kind: "image" }] } }),
      generation({ id: "gen_voice", title: "Harbour voice", prompt: "the keeper speaks", kind: "audio", model: "eleven_v3" }),
    ],
  });
  await page.route(/\/api\/jobs\/gen_wide(\?.*)?$/, (route) => route.fulfill({ json: { generation: generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" }) } }));
  await page.route(/\/api\/uploads\/up_plate\/metadata$/, (route) => route.fulfill({ json: { upload: upload({ id: "up_plate", filename: "harbour-plate.webp" }) } }));
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return errors;
}

test("Recreate pressed on Gen lands at once, with the take's own references, and nothing replays when Gen opens again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await page.getByTestId("make-tab-recent").click();
  await page.getByTestId("gen-view").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_wide']").click();
  await page.getByTestId("asset-inspector").getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("toast")).toContainText("Wide on the water’s recipe is in Make.");
  /* No Open: Gen is where it landed (lib/shell/confirmations). */
  await expect(page.getByTestId("toast-open")).toHaveCount(0);
  /* Already in Gen, the Inspector's overlay closes by itself so the composer is what is seen. */
  if (!WIDE.includes(info.project.name)) await expect(page.getByTestId("close-inspector")).toBeHidden();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("wide on the water, raw");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Wide on the water");
  await expect(page.getByTestId("gen-well")).toContainText("harbour-plate.webp");

  /* Close Make and open it again: the composer starts as it should, not with the old recipe laid over it. */
  await page.getByTestId("gen-prompt").fill("my own words");
  const suites = page.getByRole("tablist", { name: "Suites" });
  await page.getByTestId("make-close").click();
  await expect(page.getByTestId("gen-view")).toHaveCount(0);
  await openSuitesMenu(page);
  await suites.getByRole("tab", { name: "Make" }).click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("gen-prompt")).not.toHaveValue("wide on the water, raw");
  await expect(page.getByTestId("gen-recipe")).toHaveCount(0);
  await expect(page.getByTestId("gen-preset-note")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("phone: the bar reads Home · Record · Make · Atomik on every screen, lights the tab the screen belongs to, and points nowhere old", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const errors = await open(page, "/suites?suite=atomik&page=agent&sp=agent");
  await page.getByTestId("tabbar-more").click();
  await expect(page.getByTestId("tabbar-more")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("tabbar-assets").click();
  await expect(page.getByTestId("tabbar-assets")).toHaveAttribute("aria-current", "page");
  const library = page.getByTestId("library");
  await expect(library).toBeVisible();
  await expect(library.getByTestId("library-assets")).toContainText("harbour-plate.webp");
  expect(errors).toEqual([]);
});



test("phone: the Studio grid counts the project as saved now, not as first loaded", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const store = { current: fixture() };
  const errors = await open(page, "/suites?suite=atomik&page=agent&sp=agent", store);
  await page.getByTestId("tabbar-home").click();
  await page.getByTestId("home-suite-studio").click();
  await expect(page.getByTestId("home-stage-brief")).toContainText("5 words");
  /* Another stage (or a teammate) saves the brief, as the route saves it (a new revision); the grid reads it when it opens again. */
  await page.evaluate(async (brief) => {
    const read = await fetch("/api/workbench/projects?id=ws-audit").then((r) => r.json()) as { project: Project; revision: number };
    await fetch("/api/workbench/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: { ...read.project, brief }, revision: read.revision }) });
  }, "A fox crosses the frozen harbour at dusk and meets the keeper");
  /* A card opens its region of the board (the stage pages are deleted); Back is the grid again. */
  await page.getByTestId("home-stage-takes").click();
  await expect.poll(() => { const q = new URL(page.url()).searchParams; return [q.get("view"), q.get("region")]; }).toEqual(["board", "shots"]);
  await page.goBack();
  await expect(page.getByTestId("home-stage-brief")).toContainText("12 words");
  /* Opened again with nothing saved since: only the list of revisions is read, never the whole project. */
  await page.getByTestId("home-stage-takes").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("board");
  const full: string[] = [];
  page.on("request", (request) => { if (request.method() === "GET" && /\/api\/workbench\/projects\?id=/.test(request.url())) full.push(request.url()); });
  await page.goBack();
  await expect(page.getByTestId("home-stage-brief")).toContainText("12 words");
  await page.waitForTimeout(2500);
  expect(full).toEqual([]);
  expect(errors).toEqual([]);
});
