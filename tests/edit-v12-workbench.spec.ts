import { test, expect, type Page } from "@playwright/test";
import { filmBoard, openBoard } from "./helpers/boardV12";
import type { Project } from "../lib/workbench/studio";

/**
 * The Edit stage in the new interface (components/v12/board/EditStage.tsx; v25 plan PR 22/23-lite): the cut, how it is dressed, and
 * one MP4 for each language the board holds. The export route and the worker are mocked at the network edge (the server side is
 * tested in tests/unit/exportFilm*.spec.ts); nothing is rendered or charged. Local ENGINE_MOCK server.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SIZES: [number, number][] = [[1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440]];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const HINDI = "हर अच्छी फ़िल्म";
const JOB = "export_" + "a".repeat(32);

/** The edit's sequence as the browser reads it (the server refuses a draft that names a take it does not hold, and no engine runs here). */
async function withCut(page: Page, patch: Record<string, unknown>) {
  const asset = (id: string, generationId: string) => ({ id, name: id, kind: "video", category: "Video", url: `/api/media/${generationId}`, description: "", prompt: "", status: "Selected", locked: false, version: 1, refs: [], generationId, seconds: 5 });
  await page.route(/\/api\/workbench\/projects\?id=/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    try {
      const response = await route.fetch();
      const body = await response.json() as { project?: Record<string, unknown> };
      if (body.project) Object.assign(body.project, {
        assets: [asset("clip-a1", "tk-s1"), asset("clip-a2", "tk-s2")],
        shots: [{ id: "cut-1", name: "Opening wide", assetId: "clip-a1", duration: 120, sourceIn: 0, note: "" }, { id: "cut-2", name: "The walk", assetId: "clip-a2", duration: 120, sourceIn: 0, note: "" }],
        ...patch,
      });
      await route.fulfill({ response, json: body });
    } catch { /* the test ended while this read was in flight */ }
  });
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Edit is a page: the cut, the film's cards and one Export MP4 per language, free, at the five desktop sizes", async ({ page }) => {
    await withCut(page, { boardVoice: { hi: { lines: [{ take: "voice-hi1", startSeconds: 1, text: HINDI }], swap: {} } }, boardLanguages: ["hi"] });
    const { errors } = await openBoard(page, "/suites?view=board&stage=edit");
    const stage = page.getByTestId("v12-edit-stage");
    await expect(stage).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Edit");
    await expect(page.getByTestId("v12-edit-cut").getByTestId("cut-card")).toBeVisible();
    const rows = page.getByTestId("v12-edit-language");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("English");
    await expect(rows.nth(1)).toContainText("Hindi");
    await expect(rows.nth(1)).toContainText("1 voice line");
    await expect(rows.nth(0).getByTestId("v12-edit-export")).toHaveText("Export MP4 · free");
    await expect(rows.nth(0).getByTestId("v12-edit-export")).toBeEnabled();
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      expect(await noSideways(page), `${width}x${height}: no sideways scroll`).toBe(true);
      for (const row of await rows.all()) {
        const box = (await row.getByTestId("v12-edit-export").boundingBox())!;
        expect(box.x, `${width}x${height}: the button starts on screen`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${width}x${height}: the button ends on screen`).toBeLessThanOrEqual(width);
      }
      await expect(page.getByTestId("v12-edit-film")).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("Export MP4 asks for the board's film in that language, follows it through the queue, and offers the file; a failure says nothing was billed and retries", async ({ page }) => {
    await withCut(page, { boardVoice: { hi: { lines: [{ take: "voice-hi1", startSeconds: 1, text: HINDI }] } }, boardLanguages: ["hi"] });
    const asked: { board?: string; language?: string; requestId?: string }[] = [];
    let polls = 0;
    let fail = true;
    await page.route("**/api/exports/film", async (route) => {
      const body = route.request().postDataJSON() as { board: string; language: string; requestId: string };
      asked.push(body);
      if (fail) { fail = false; return route.fulfill({ status: 422, json: { error: "There is no Hindi version yet: it needs Hindi voice lines." } }); }
      await route.fulfill({ status: 202, json: { job: { id: JOB, status: "queued" } } });
    });
    await page.route(`**/api/exports/${JOB}`, async (route) => {
      polls += 1;
      const job = polls < 2
        ? { id: JOB, status: "queued", queueLine: "Export queued — 1 ahead of you", error: null, outputs: [] }
        : { id: JOB, status: "ready", queueLine: null, error: null, outputs: [{ kind: "video", url: "/api/uploads/export_video", filename: "film-hi.mp4" }, { kind: "subtitle", url: "/api/uploads/export_srt", filename: "film-hi.srt" }] };
      await route.fulfill({ json: { job } });
    });
    await openBoard(page, "/suites?view=board&stage=edit");
    const hindi = page.locator('[data-testid="v12-edit-language"][data-code="hi"]');
    await expect(hindi).toBeVisible({ timeout: 60_000 });
    await hindi.getByTestId("v12-edit-export").click();
    /* A refusal says why, in words; Retry asks again with the same request id. */
    await expect(hindi.getByTestId("v12-edit-failed")).toContainText("it needs Hindi voice lines");
    await hindi.getByRole("button", { name: "Retry" }).click();
    await expect(hindi.getByTestId("v12-edit-working")).toContainText("queued", { timeout: 15_000 });
    await expect(hindi.getByTestId("v12-edit-ready")).toBeVisible({ timeout: 30_000 });
    await expect(hindi.getByRole("link", { name: "Download MP4" })).toHaveAttribute("href", "/api/uploads/export_video");
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ language: "hi" });
    expect(asked[1].requestId).toBe(asked[0].requestId);
    expect(asked[0].board).toMatch(/^[A-Za-z0-9_-]+$/);
    /* English is its own row, untouched. */
    await expect(page.locator('[data-testid="v12-edit-language"][data-code="en"]').getByTestId("v12-edit-export")).toBeEnabled();
  });

  test("a cut with no takes cannot be exported, and says why; captions and the title card are the board's, kept in its draft", async ({ page }) => {
    const { errors } = await openBoard(page, "/suites?view=board&stage=edit", { project: filmBoard() as Project });
    const stage = page.getByTestId("v12-edit-stage");
    await expect(stage).toBeVisible({ timeout: 60_000 });
    const english = page.getByTestId("v12-edit-export").first();
    await expect(english).toBeDisabled();
    await expect(english).toHaveAttribute("title", "Add takes to the cut first.");
    const put = page.waitForResponse((r) => r.url().includes("/api/workbench/projects") && r.request().method() === "PUT" && r.ok() && (r.request().postData() ?? "").includes("boardCut"), { timeout: 30_000 });
    await page.getByTestId("v12-edit-captions").selectOption("bold");
    await put;
    await page.getByTestId("v12-edit-title").fill("Harbour");
    const putTitle = page.waitForResponse((r) => r.url().includes("/api/workbench/projects") && r.request().method() === "PUT" && r.ok() && (r.request().postData() ?? "").includes('"title":"Harbour"'), { timeout: 30_000 });
    await page.getByTestId("v12-edit-title").press("Enter");
    await putTitle;
    await page.reload();
    await expect(page.getByTestId("v12-edit-captions")).toHaveValue("bold", { timeout: 60_000 });
    await expect(page.getByTestId("v12-edit-title")).toHaveValue("Harbour");
    expect(errors).toEqual([]);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("the phone app keeps today's board: no Edit page", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=edit");
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-edit-stage")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });
});
