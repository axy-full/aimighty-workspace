import { test, expect, type Page } from "@playwright/test";
import { filmBoard, openBoard } from "./helpers/boardV12";
import { withCut } from "./helpers/editV12";
import type { Project } from "../lib/workbench/studio";

/**
 * The investor demo's path on mocks (docs/plans/demo-31oct-plan.md, D-6): a Film board that has its cut and its Hindi version is
 * walked from the Edit step to every deliverable: the English MP4, the Hindi MP4 with its subtitle file, and the one deck as a
 * Treatment PDF and as a Pitch PDF. Every export is mocked at the network edge (the server side is tested on mocks in
 * tests/unit/export*.spec.ts and pdf*.spec.ts); nothing is rendered, generated or charged, and the run says so by asserting that no
 * paid route is called. Local ENGINE_MOCK server. The Home and New project steps join this walk when they land.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const HINDI = ["हर अच्छी फ़िल्म", "एक छोटी कहानी"];
const JOBS = { en: "export_" + "1".repeat(32), hi: "export_" + "2".repeat(32) };

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Edit to deliverables: English MP4, Hindi MP4 and its subtitles, the Treatment PDF and the Pitch PDF, free, with nothing paid", async ({ page }) => {
    await withCut(page, {
      boardLanguages: ["hi"],
      boardCut: { captions: "bold", title: { title: "Monsoon", durationSeconds: 2 }, end: { headline: "Coming soon" } },
      boardVoice: {
        en: { lines: [{ take: "voice-en1", startSeconds: 1, text: "Every great film" }] },
        hi: { lines: [{ take: "voice-hi1", startSeconds: 1, text: HINDI[0] }, { take: "voice-hi2", startSeconds: 6, text: HINDI[1] }], swap: { "tk-s2": "tk-s2-hi" } },
      },
    });
    const paid: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() !== "GET" && /\/api\/(generate|audio|credits|billing|plan|stripe|checkout)/.test(url.pathname)) paid.push(`${request.method()} ${url.pathname}`);
    });
    const films: { language: string; board: string }[] = [];
    await page.route("**/api/exports/film", async (route) => {
      const body = route.request().postDataJSON() as { board: string; language: string };
      films.push({ language: body.language, board: body.board });
      await route.fulfill({ status: 202, json: { job: { id: JOBS[body.language as "en" | "hi"], status: "queued" } } });
    });
    for (const [language, id] of Object.entries(JOBS)) {
      await page.route(`**/api/exports/${id}`, (route) => route.fulfill({ json: { job: { id, status: "ready", queueLine: null, error: null, outputs: [
        { kind: "video", url: `/api/uploads/${id}_video`, filename: `film-${language}.mp4` },
        ...(language === "hi" ? [{ kind: "subtitle", url: `/api/uploads/${id}_srt`, filename: "film-hi.srt" }] : []),
      ] } } }));
    }
    const decks: { kind: string; cover: string }[] = [];
    await page.route("**/api/pdf", async (route) => {
      const body = route.request().postDataJSON() as { kind: string; cover: string };
      decks.push({ kind: body.kind, cover: body.cover });
      await route.fulfill({ json: { deck: { url: `/api/uploads/deck_${body.cover}`, filename: `monsoon_film_${body.cover}.pdf`, pages: 9, bytes: 1000, kind: "film", mime: "application/pdf", price: { credits: 0, label: "Free" } } } });
    });

    const { errors } = await openBoard(page, "/suites?view=board&stage=edit");
    await expect(page.getByTestId("v12-edit-stage")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Edit");

    /* The English film. */
    const english = page.locator('[data-testid="v12-edit-language"][data-code="en"]');
    await english.getByTestId("v12-edit-export").click();
    await expect(english.getByRole("link", { name: "Download MP4" })).toHaveAttribute("href", `/api/uploads/${JOBS.en}_video`, { timeout: 30_000 });

    /* The Hindi film: its own voice, its words as subtitles. */
    const hindi = page.locator('[data-testid="v12-edit-language"][data-code="hi"]');
    await expect(hindi).toContainText("Hindi");
    await expect(hindi).toContainText("2 voice lines");
    await expect(hindi).toContainText("1 shot replaced");
    await hindi.getByTestId("v12-edit-export").click();
    await expect(hindi.getByRole("link", { name: "Download MP4" })).toHaveAttribute("href", `/api/uploads/${JOBS.hi}_video`, { timeout: 30_000 });
    await expect(hindi.getByRole("link", { name: "SRT" })).toHaveAttribute("href", `/api/uploads/${JOBS.hi}_srt`);

    /* The deck, once with each cover. */
    for (const cover of ["treatment", "pitch"]) {
      const row = page.locator(`[data-testid="v12-edit-deck"][data-cover="${cover}"]`);
      await row.getByTestId("v12-deck-export").click();
      await expect(row.getByRole("link", { name: /Download PDF/ })).toHaveAttribute("href", `/api/uploads/deck_${cover}`, { timeout: 30_000 });
    }

    /* What was asked, in order, of the board the person is on. */
    expect(films.map((f) => f.language)).toEqual(["en", "hi"]);
    expect(new Set(films.map((f) => f.board)).size).toBe(1);
    expect(decks).toEqual([{ kind: "film", cover: "treatment" }, { kind: "film", cover: "pitch" }]);
    expect(paid, "no paid route is called anywhere on the path").toEqual([]);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("the same walk with the cut still empty: nothing can be exported and the page says why, so no empty film is ever started", async ({ page }) => {
    const asked: string[] = [];
    await page.route(/\/api\/(exports\/film|pdf)$/, (route) => { asked.push(route.request().url()); return route.fulfill({ status: 500, json: {} }); });
    await openBoard(page, "/suites?view=board&stage=edit", { project: filmBoard() as Project });
    await expect(page.getByTestId("v12-edit-stage")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-edit-export").first()).toBeDisabled();
    expect(asked).toEqual([]);
  });
});
