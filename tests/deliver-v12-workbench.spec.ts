import { test, expect, type Page } from "@playwright/test";
import { filmBoard, openBoard } from "./helpers/boardV12";

/**
 * The Deliver stage and the Pre-vis PPM deck in the new interface (redesign P2-d; components/v12/board/DeliverStage.tsx and
 * PpmStage.tsx; docs/redesign/inventory.md § 6.7). Deliver draws what is real today (the cut's own checks, a free export,
 * the editorial package) and, for what is not built (other sizes and lengths, languages, mandatories, per-platform packs,
 * posting), says so with a price that reads "quoted" and never a figure. The PPM deck reads what the board holds, and its
 * shot list is editable and kept in the board's draft. Local ENGINE_MOCK server; nothing is generated or sent.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const saved = (page: Page) => page.waitForResponse((r) => r.url().includes("/api/workbench/projects") && r.request().method() === "PUT" && r.ok(), { timeout: 30_000 });

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Deliver: the grid by size and length, each cell with its reason; Adapt all is quoted and off; languages, mandatories and the pack say what is not built", async ({ page }) => {
    const { errors } = await openBoard(page, "/suites?view=board&stage=deliver");
    const stagePage = page.getByTestId("v12-deliver-stage");
    await expect(stagePage).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Deliver");
    /* The page stands in for the canvas, so today's tool bar is not over it. */
    await expect(page.getByTestId("v12-board-tools")).toHaveCount(0);
    const cells = page.getByTestId("v12-deliver-cell");
    await expect(cells).toHaveCount(16);
    await expect(page.getByTestId("v12-deliver-summary")).toHaveText("0 of 16 ready");
    await expect(page.getByRole("columnheader")).toHaveText(["", "Master", "30 s", "15 s", "6 s"]);
    await expect(page.getByRole("rowheader")).toHaveText(["16:9", "9:16", "1:1", "4:5"]);
    /* The cut is not finished: its own size is waiting, every other cell is not made, and says why. */
    const master = page.locator('[data-testid="v12-deliver-cell"][data-aspect="16:9"][data-seconds="0"]');
    await expect(master).toHaveAttribute("data-state", "waiting");
    await expect(master).toHaveAttribute("title", "The cut isn’t finished: every shot needs its approved take.");
    const other = page.locator('[data-testid="v12-deliver-cell"][data-aspect="9:16"][data-seconds="15"]');
    await expect(other).toHaveAttribute("data-state", "notbuilt");
    await expect(other).toContainText(/_9x16_15s_v1$/);
    /* The naming pattern is the project's own, never a stand-in. */
    await expect(page.getByTestId("v12-deliver-grid-card")).toContainText("harbour-film_{aspect}_{dur}_v1");
    for (const line of ["MP4 · H.264 · ProRes on request", "Burned-in + SRT", "VO · Music · SFX · WAV"]) await expect(page.getByTestId("v12-deliver-grid-card")).toContainText(line);
    /* Adapt all is quoted and off; the cut's export waits for takes. */
    const adapt = page.getByTestId("v12-deliver-adapt-all");
    await expect(adapt).toBeDisabled();
    await expect(adapt).toHaveText("Adapt all · quoted");
    await expect(page.getByTestId("v12-deliver-export-cut")).toBeDisabled();
    await expect(page.getByTestId("v12-deliver-why")).toContainText("isn’t built yet");
    /* Spec check: today's own rows. */
    await expect(page.getByTestId("v12-deliver-spec")).toContainText("Spec check");
    await expect(page.getByTestId("v12-deliver-spec").getByTestId("deliver-aspect")).toBeVisible();
    /* Mandatories: nothing stores them, so nothing is checked. */
    const mand = page.getByTestId("v12-deliver-mandatories");
    for (const m of ["Logo", "End packshot", "Legal line", "Fonts · colours", "VO tagline"]) await expect(mand).toContainText(m);
    await expect(page.getByTestId("v12-deliver-mandatories-why")).toContainText("aren’t stored in Particl yet");
    /* Export pack: the four platforms by the prototype's words; posting is Later and a person's. */
    const pack = page.getByTestId("v12-deliver-pack");
    await expect(page.getByTestId("v12-deliver-platform")).toHaveCount(4);
    for (const line of ["Reels", "MP4 · 9:16 · SRT", "Shorts", "YouTube", "Meta feed", "MP4 · 4:5 · 1:1", "Premiere / Resolve XML"]) await expect(pack).toContainText(line);
    await expect(page.getByTestId("v12-deliver-post")).toHaveText("Later · every post approved by a person");
    await expect(page.getByTestId("v12-deliver-export-pack")).toContainText("Export pack · free");
    await expect(pack).toContainText("Audio stems and ProRes aren’t built yet.");
    /* No figure of credits anywhere on the page but the word quoted and free. */
    expect(await stagePage.innerText()).not.toMatch(/\d\s*cr\b/);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Deliver: languages are added from the dubbing list, kept in the draft, each with its parts quoted and off", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=deliver");
    await expect(page.getByTestId("v12-deliver-languages")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-deliver-languages")).toContainText("Master only");
    const put = saved(page);
    await page.getByTestId("v12-deliver-add-language").selectOption("ta");
    await put;
    const row = page.getByTestId("v12-deliver-language");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Tamil");
    await expect(row).toContainText("dubbed voice · lip-sync · on-screen text · quoted");
    await expect(page.getByTestId("v12-deliver-adapt-languages")).toBeDisabled();
    await expect(page.getByTestId("v12-deliver-adapt-languages")).toHaveText("Adapt all languages · quoted");
    await page.reload();
    await expect(page.getByTestId("v12-deliver-language")).toHaveCount(1, { timeout: 60_000 });
    const gone = saved(page);
    await page.getByRole("button", { name: "Remove Tamil" }).click();
    await gone;
    await expect(page.getByTestId("v12-deliver-language")).toHaveCount(0);
  });

  test("PPM deck: eight sections from what the board holds, the shot list editable and kept in the draft, a CSV, and the exports that are not built say so", async ({ page }) => {
    const board = { ...filmBoard(), boardKind: "studio" as const, boardFlavor: "previs" as const };
    const { errors, project } = await openBoard(page, "/suites?view=board&stage=ppm-deck", { project: board });
    const ppm = page.getByTestId("v12-ppm-stage");
    await expect(ppm).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("PRE-VIS");
    await expect(page.getByTestId("v12-ppm-section")).toHaveCount(8);
    await expect(page.getByTestId("v12-ppm-section")).toContainText(["Cover", "Script", "Cast", "Locations", "Wardrobe and props", "Look references", "Storyboard", "Shot list"]);
    await expect(page.getByTestId("v12-ppm-section").nth(2)).toContainText("2 characters · Skipper, Deckhand");
    await expect(page.getByTestId("v12-ppm-section").nth(7)).toContainText("8 shots · editable table");
    await expect(page.getByTestId("v12-ppm-logo")).toHaveCount(0);
    /* The shot list: the beat sheet's shots, eleven columns. */
    const rows = page.getByTestId("v12-ppm-row");
    await expect(rows).toHaveCount(8);
    await expect(page.getByRole("columnheader")).toHaveText(["Shot", "Frame", "Dur", "Lens", "Camera move", "Cast", "Location", "Props", "Wardrobe", "VO / dialogue", "Notes"]);
    await expect(rows.first().getByTestId("v12-ppm-cell-frame")).toHaveValue("Wide");
    await expect(rows.first().getByTestId("v12-ppm-cell-move")).toHaveValue("Held · 35mm");
    /* Edit a cell: it shows at once and is saved as you type. */
    const put = saved(page);
    await rows.nth(1).getByTestId("v12-ppm-cell-lens").fill("35 mm");
    await put;
    await rows.nth(1).getByTestId("v12-ppm-cell-wardrobe").fill("Oilskin, red cap");
    await rows.nth(1).getByTestId("v12-ppm-cell-wardrobe").press("Enter");
    await expect.poll(async () => {
      const text = await page.request.get("/api/workbench/projects?id=" + encodeURIComponent(project.id), { headers: { "X-Workbench-Scope": await scopeOf(page) } }).then((r) => r.text());
      return text.includes("Oilskin, red cap") && text.includes("35 mm");
    }, { timeout: 30_000 }).toBe(true);
    await page.reload();
    await expect(page.getByTestId("v12-ppm-row").nth(1).getByTestId("v12-ppm-cell-lens")).toHaveValue("35 mm", { timeout: 60_000 });
    await expect(page.getByTestId("v12-ppm-row").nth(1).getByTestId("v12-ppm-cell-wardrobe")).toHaveValue("Oilskin, red cap");
    /* The CSV is made in the browser with the edits in it; a formula-like cell is quoted as text. */
    await page.getByTestId("v12-ppm-row").nth(2).getByTestId("v12-ppm-cell-notes").fill("=1+1");
    await page.getByTestId("v12-ppm-row").nth(2).getByTestId("v12-ppm-cell-notes").press("Enter");
    const download = page.waitForEvent("download");
    await page.getByTestId("v12-ppm-export-csv").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("harbour-film_shot-list.csv");
    const path = await file.path();
    const csv = (await import("node:fs/promises")).readFile(path!, "utf8");
    const text = await csv;
    expect(text.split("\r\n")[0]).toBe('"Shot","Frame","Dur","Lens","Camera move","Cast","Location","Props","Wardrobe","VO / dialogue","Notes"');
    expect(text).toContain('"35 mm"');
    expect(text).toContain('"Oilskin, red cap"');
    expect(text).toContain('"\'=1+1"');
    expect(text.trim().split("\r\n")).toHaveLength(9);
    /* What is not built is off, with its reason, and free is only said of what is made. */
    for (const id of ["deck", "pdf", "animatic"]) await expect(page.getByTestId(`v12-ppm-export-${id}`)).toBeDisabled();
    await expect(page.getByTestId("v12-ppm-export-deck")).toHaveAttribute("title", "Particl doesn’t make PDFs yet.");
    await expect(page.getByTestId("v12-ppm-export-animatic")).toHaveAttribute("title", "The animatic isn’t built yet.");
    expect(await ppm.innerText()).not.toMatch(/\d\s*cr\b/);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("PPM deck: the cover carries the workspace's own logo when it has one", async ({ page }) => {
    const board = { ...filmBoard(), boardKind: "studio" as const, boardFlavor: "previs" as const };
    await page.route((url) => url.pathname === "/api/settings", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const real = await route.fetch();
      const body = await real.json();
      return route.fulfill({ json: { ...body, settings: { ...body.settings, brandLogoUploadId: "up_logo01" } } });
    });
    await page.route((url) => url.pathname === "/api/uploads/up_logo01", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64") }));
    await openBoard(page, "/suites?view=board&stage=ppm-deck", { project: board });
    await expect(page.getByTestId("v12-ppm-logo")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-ppm-section").first()).toContainText("Your logo · the date");
  });

  test("an empty stage keeps its words: no cut, nothing for the deck", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=ppm-deck");
    /* A Film board's Deliver is the page; a Film board has no PPM deck stage, so the address falls back to its opening stage. */
    await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-ppm-stage")).toHaveCount(0);
  });
});

async function scopeOf(page: Page) {
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string } };
  return `particl-active-${me.workspace.id}-${me.id}`;
}

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("the phone app keeps today's board: no stage pages", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=deliver");
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-deliver-stage")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });
});
