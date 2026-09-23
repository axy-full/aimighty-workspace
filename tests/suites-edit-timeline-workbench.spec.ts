import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Production › Edit and Timeline (owner's brief, 23 September): Edit shows every
 * take; a still is re-edited from an instruction with the take as its reference,
 * priced first; a video take opens in Seedance Edit on that clip; any take goes
 * on the timeline. Timeline holds the cut — takes added from its tray, moved,
 * re-timed and taken out — above the sound lanes. Takes left the strip.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const fixture = (): Project => ({ ...newProject("Harbour cut"), id: "ws-edit", productionProjectId: "prod-edit", shotMappings: {}, fps: 24 });

async function open(page: Page) {
  await signInLocally(page.request);
  await mockMedia(page);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [
    generation({ id: "gen_still", title: "Mara at the window", prompt: "Mara at the window", projectId: "prod-edit" }),
    generation({ id: "gen_clip", title: "The crossing", prompt: "The crossing", kind: "video", model: "dreamina-seedance-2-5-260628", durationS: 5, projectId: "prod-edit" }),
  ] });
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  await page.route(/\/api\/generate(\/quote)?$/, (route) => {
    const request = route.request(), body = request.postDataJSON();
    posts.push({ url: request.url(), body });
    return route.fulfill({ json: request.url().endsWith("/quote") ? { estimatedCredits: 4, fingerprint: "f".repeat(64), price: 0.04, unit: "cr" } : { id: "gen_reedit" } });
  });
  await page.route(/\/api\/jobs\/gen_reedit(\?.*)?$/, (route) => route.fulfill({ json: { generation: generation({ id: "gen_reedit", title: "Re-edit", projectId: "prod-edit" }) } }));
  await page.route("**/api/higgsfield/consumer/audio-tools?**", (route) => route.fulfill({ json: { connection: { connected: false, requiresReconnect: false }, capabilities: { voice: false, dubbing: false, analysis: false, reframe: false, languages: [] }, jobs: [] } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=takes");
  await expect(page.getByTestId("project-name")).toHaveText("Harbour cut");
  return { errors, store, posts };
}

test("Takes lists generations then assets by type, re-edits a still at its price and sends takes to the cut; Edit & Sound orders, re-times and trims the cut", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  const { errors, store, posts } = await open(page);
  /* Takes: every generation first, then every asset grouped by type. */
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  const takes = page.getByTestId("edit-takes").getByTestId("edit-take");
  await expect(takes).toHaveCount(2);
  await expect(page.getByTestId("asset-group")).toHaveText([/Videos\s*1/, /Images\s*1/]);

  /* The still: an instruction, a price, then the re-edit with the take as its reference. */
  await takes.filter({ hasText: "Mara at the window" }).click();
  await expect(page.getByTestId("edit-blocked")).toHaveText("Write what should change.");
  await page.getByTestId("edit-instruction").fill("Make it night, rain on the glass");
  await page.getByTestId("edit-price").click();
  await expect(page.getByTestId("edit-render")).toHaveText("Re-edit · 4 credits");
  const quoted = posts.at(-1)!.body;
  expect(quoted.references).toEqual([{ genId: "gen_still", role: "reference_image" }]);
  expect(String(quoted.prompt)).toContain("Edit the reference image: Make it night, rain on the glass");
  await page.getByTestId("edit-render").click();
  /* The dispatcher re-quotes, then submits at exactly the shown price. */
  await expect.poll(() => posts.find((p) => p.url.endsWith("/api/generate"))?.body ?? null).toMatchObject({ maxCredits: 4, quoteFingerprint: "f".repeat(64), references: [{ genId: "gen_still", role: "reference_image" }] });
  await expect(page.getByTestId("edit-result")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("edit-to-timeline").click();

  /* The video take opens Seedance Edit on that clip. */
  await takes.filter({ hasText: "The crossing" }).click();
  await expect(page.getByTestId("gen-edit")).toBeVisible();
  await page.getByTestId("edit-to-timeline").click();
  await expect.poll(() => store.current.shots.map((s) => [s.name, s.duration]), { timeout: 10_000 }).toEqual([["01 — Mara at the window", 72], ["02 — The crossing", 120]]);

  /* Edit & Sound: the cut, re-ordered, re-timed, trimmed, and one more take from the tray. */
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Edit & Sound/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Edit & Sound");
  const shots = page.getByTestId("timeline-shot");
  await expect(shots).toHaveCount(2);
  await page.getByLabel("Move 02 — The crossing earlier").click();
  await page.getByLabel("01 — Mara at the window seconds").fill("2");
  await page.getByTestId("timeline-cut").locator("summary").click();
  await page.getByTestId("timeline-add").first().click();
  await expect(shots).toHaveCount(3);
  await page.getByLabel(/Take 03 — .* out of the cut/).click();
  await expect.poll(() => store.current.shots.map((s) => [s.name, s.duration]), { timeout: 10_000 }).toEqual([["02 — The crossing", 120], ["01 — Mara at the window", 48]]);
  expect(store.current.assets.map((a) => [a.id, a.category])).toEqual([["gen_still", "Take"], ["gen_clip", "Take"]]);
  await page.screenshot({ path: info.outputPath("timeline.png") });
  expect(errors).toEqual([]);
});
