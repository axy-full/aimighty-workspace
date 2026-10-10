import { test, expect, type Page } from "@playwright/test";
import { openBoard } from "./helpers/boardV12";
import { newProject, type Project } from "../lib/workbench/studio";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";

/**
 * The Campaign board's stages in the new interface (redesign P6-a; components/v12/board/campaign; docs/redesign/inventory.md
 * § 10.1): Product reads a page through today's two free reads and keeps packshots real; Look holds the moodboard and the
 * brand's mandatories as the brand kit can answer them; Formats is an even grid of eight skill cards, each with one price or
 * "quoted"; Variants is hooks by sizes. Nothing spends: the pages' reads are answered here by fixtures, and Make is only opened.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const URL_OK = "https://shop.example.test/linen-bowl";
const PRODUCT = {
  source: { requestedUrl: URL_OK, finalUrl: URL_OK, fetchedAt: "2026-10-10T00:00:00Z" },
  product: { name: "Linen bowl", description: "A hand-thrown bowl in a washed linen glaze. Dishwasher safe.", brand: "Quay Ceramics" },
  evidence: [], imageCandidates: [{ url: "https://shop.example.test/img/bowl-1.png", source: "json-ld", alt: "Bowl, front" }, { url: "https://shop.example.test/img/bowl-2.png", source: "open-graph" }], warnings: [], requiresReview: true,
};
const BRAND = {
  source: { requestedUrl: "https://shop.example.test/", finalUrl: "https://shop.example.test/", fetchedAt: "2026-10-10T00:00:00Z" },
  brand: { name: "Quay Ceramics", description: "Hand-thrown tableware.", tagline: "Made by hand", colors: ["#c8b6a0", "#2f3a46"], fontFamilies: ["Inter"], tone: "Calm" },
  logoCandidates: [{ url: "https://shop.example.test/logo.png", source: "open-graph", alt: "Logo" }], imageryCandidates: [], evidence: [], warnings: [], requiresReview: true,
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

function campaign(extra: Partial<Project> = {}): Project {
  return { ...newProject("Spring range"), boardKind: "ads", boardFlavor: "campaign", moleculr: { ...EMPTY_MOLECULR }, ...extra } as Project;
}

async function mocks(page: Page) {
  const reads: string[] = [];
  await page.route((url) => url.pathname === "/api/workbench/moleculr/extract-product", (route) => { reads.push("product"); return route.fulfill({ json: PRODUCT }); });
  await page.route((url) => url.pathname === "/api/workbench/moleculr/extract-brand", (route) => { reads.push("brand"); return route.fulfill({ json: BRAND }); });
  await page.route((url) => url.pathname === "/api/workbench/moleculr/import-image", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  const paid: string[] = [];
  page.on("request", (r) => { const path = new URL(r.url()).pathname; if (r.method() !== "GET" && /^\/api\/(generate$|audio|soul|rig\/runs)/.test(path)) paid.push(`${r.method()} ${path}`); });
  return { reads, paid };
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Product: paste a link, review what the page says with swatches, a logo and real packshots, then Use this; nothing is used before", async ({ page }) => {
    const { errors } = await openBoard(page, "/suites?view=board&stage=product", { project: campaign() });
    const seen = await mocks(page);
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("CAMPAIGN", { timeout: 60_000 });
    await expect(page.getByTestId("v12-product-stage")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Paste the product page link" })).toBeVisible();
    await expect(page.getByTestId("v12-product-review")).toHaveCount(0);
    await expect(page.getByTestId("v12-product-link")).toContainText("Products stay real packshots only. Nothing is generated.");
    await page.getByTestId("v12-product-url").fill(URL_OK);
    await page.getByTestId("v12-product-read").click();
    const review = page.getByTestId("v12-product-review");
    await expect(review).toBeVisible({ timeout: 30_000 });
    expect(seen.reads.sort()).toEqual(["brand", "product"]);
    await expect(page.getByTestId("v12-product-state")).toHaveText("Review before use");
    await expect(review).toContainText("Linen bowl · Quay Ceramics");
    await expect(page.getByTestId("v12-product-says")).toContainText("A hand-thrown bowl in a washed linen glaze.");
    /* Colours as swatches with their hex. */
    await expect(page.getByTestId("v12-swatch")).toHaveText(["#C8B6A0", "#2F3A46"]);
    await expect(page.getByTestId("v12-product-packshots")).toContainText("2 photos on the page · nothing generated");
    /* Nothing from the page is on the product until it is used. */
    const draft = async () => JSON.stringify((await page.request.get("/api/workbench/projects?id=" + encodeURIComponent((await currentId(page))), { headers: { "X-Workbench-Scope": await scopeOf(page) } }).then((r) => r.json())).project?.moleculr ?? {});
    expect(await draft()).not.toContain("Linen bowl");
    /* A packshot comes in as the page's own photo, an original, never generated. */
    await page.getByTestId("v12-product-packshot-add").first().click();
    await expect(page.getByTestId("v12-product-packshot-add").first()).toHaveText("Added", { timeout: 30_000 });
    await page.getByTestId("v12-product-use").click();
    const made = page.getByTestId("v12-product-made");
    await expect(made).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("v12-product-review")).toHaveCount(0);
    await expect(made).toContainText("Linen bowl · Quay Ceramics");
    await expect(made).toContainText("1 real photo · nothing generated");
    await expect(page.getByTestId("v12-swatch")).toHaveText(["#C8B6A0", "#2F3A46"]);
    await expect(page.getByTestId("v12-product-state")).toContainText("Approved");
    await expect.poll(draft, { timeout: 30_000 }).toContain("Linen bowl");
    expect(seen.paid, "reading and approving a page spends nothing").toEqual([]);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Product: a page that cannot be read says so and keeps the link", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=product", { project: campaign() });
    await page.route((url) => url.pathname === "/api/workbench/moleculr/extract-product", (route) => route.fulfill({ status: 422, json: { error: "That page could not be read." } }));
    await page.route((url) => url.pathname === "/api/workbench/moleculr/extract-brand", (route) => route.fulfill({ status: 422, json: { error: "That page could not be read." } }));
    await expect(page.getByTestId("v12-product-stage")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("v12-product-url").fill("shop.example.test/gone");
    await page.getByTestId("v12-product-read").click();
    await expect(page.getByTestId("v12-product-failed")).toContainText("That page could not be read.", { timeout: 30_000 });
    await expect(page.getByTestId("v12-product-url")).toHaveValue("shop.example.test/gone");
  });

  test("Look: the moodboard and the mandatories as the brand kit answers them; the legal line has nowhere to live", async ({ page }) => {
    const project = campaign({ moleculr: { ...EMPTY_MOLECULR, productName: "Linen bowl", brandKit: { name: "Quay Ceramics", tagline: "Made by hand", voice: "", audience: "", colors: ["#C8B6A0", "#2F3A46"], font: "system", fontFamilies: ["Inter"] } } as never });
    await openBoard(page, "/suites?view=board&stage=look", { project });
    await expect(page.getByTestId("v12-look-stage")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-look-mood")).toContainText("No moodboard yet");
    const rows = page.getByTestId("v12-look-mandatory");
    await expect(rows).toHaveCount(6);
    await expect(rows).toContainText(["Logo", "End packshot", "Legal line", "Fonts", "Colours", "VO tagline"]);
    await expect(rows.nth(2)).toContainText("Not stored yet");
    await expect(rows.nth(2)).not.toHaveAttribute("data-ok", "");
    await expect(rows.nth(3)).toContainText("Inter");
    await expect(rows.nth(5)).toContainText("Made by hand");
    await expect(page.getByTestId("v12-look-mandatories-why")).toContainText("A legal line has no place to live in Particl yet.");
    await expect(page.getByTestId("v12-look-brand")).toContainText("Quay Ceramics");
    expect(await noSideways(page)).toBe(true);
  });

  test("Formats: eight skill cards on one even grid; each has one price or says quoted; a format that does not fit shows once, dimmed, with its reason; Make only opens Make", async ({ page }) => {
    const project = campaign({ moleculr: { ...EMPTY_MOLECULR, productName: "Linen bowl", productDescription: "A hand-thrown bowl in a washed linen glaze." } as never });
    await openBoard(page, "/suites?view=board&stage=formats", { project });
    const seen = await mocks(page);
    await expect(page.getByTestId("v12-formats-stage")).toBeVisible({ timeout: 60_000 });
    const cards = page.getByTestId("v12-format");
    await expect(cards).toHaveCount(8);
    await expect(cards.locator(".v12-sp-title")).toHaveText(["Product video ad", "Talking review", "Unboxing", "Try-on", "Tutorial", "Product voice-over", "Website walk-through", "Photoshoot"]);
    /* Even: every card is the same width and the gaps are one size (24 px) in a row and between rows. */
    const boxes = await cards.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; }));
    expect(new Set(boxes.map((b) => Math.round(b.w))).size).toBe(1);
    const row0 = boxes.filter((b) => Math.round(b.y) === Math.round(boxes[0].y));
    expect(row0.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < row0.length; i++) expect(Math.round(row0[i].x - row0[i - 1].r)).toBe(24);
    const next = boxes.find((b) => b.y > boxes[0].y + 10);
    if (next) expect(Math.round(next.y - Math.max(...row0.map((b) => b.b)))).toBe(24);
    /* Try-on does not fit a bowl; the two with nothing behind them cannot be picked. */
    const tryOn = page.locator('[data-format="try-on"]');
    await expect(tryOn).toHaveAttribute("data-state", "off");
    await expect(tryOn).toContainText("Doesn’t apply: Try-on fits apparel and accessories, not Linen bowl.");
    await expect(tryOn.getByTestId("v12-format-pick")).toHaveCount(0);
    for (const id of ["voice-over", "walk-through"]) {
      await expect(page.locator(`[data-format="${id}"]`)).toHaveAttribute("data-state", "off");
      await expect(page.locator(`[data-format="${id}"]`).getByTestId("v12-format-state")).toHaveText("Not built yet");
    }
    /* Prices: a video format asks the server and reads N cr (or a dash), a still set says quoted; no figure is typed in the page. */
    await expect(page.locator('[data-format="unboxing"] [data-testid="v12-format-state"]')).toContainText(/One run · (\d[\d,]* cr|—|…)/, { timeout: 30_000 });
    await expect(page.locator('[data-format="photoshoot"] [data-testid="v12-format-state"]')).toHaveText("One run · quoted");
    /* A person on camera needs a consent record. */
    await expect(page.locator('[data-format="talking-review"]').getByTestId("v12-format-consent")).toContainText("consent record");
    /* Pick one: the brief is chosen (free) and the one filled button opens Make with it. */
    await expect(page.getByTestId("v12-formats-make")).toBeDisabled();
    await page.locator('[data-format="unboxing"]').getByTestId("v12-format-pick").click();
    await expect(page.locator('[data-format="unboxing"]')).toHaveAttribute("data-state", "picked", { timeout: 30_000 });
    await expect(page.getByTestId("v12-formats-make")).toBeEnabled();
    await page.getByTestId("v12-formats-make").click();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("v12-make")).toContainText("Business · Silent unboxing");
    expect(seen.paid, "opening Make runs nothing").toEqual([]);
    expect(await noSideways(page)).toBe(true);
  });

  test("Variants: hooks down, sizes across; a cell opens Make with its hook; versions and the first row say they are not built", async ({ page }) => {
    const project = campaign({ moleculr: { ...EMPTY_MOLECULR, productName: "Linen bowl", hooks: ["Soft light, every day.", "What’s in your glaze?"], creative: { path: "template", category: "ugc", direction: "", aspect: "9:16", seconds: 15, templateId: "ugc-silent" } } as never });
    await openBoard(page, "/suites?view=board&stage=variants", { project });
    const seen = await mocks(page);
    await expect(page.getByTestId("v12-variants-stage")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-variants-state")).toContainText("Unboxing · 2 hooks");
    await expect(page.getByRole("columnheader")).toHaveText(["", "Reels 9:16", "Feed 4:5", "YouTube 16:9"]);
    await expect(page.getByTestId("v12-variant-row")).toHaveCount(2);
    await expect(page.getByTestId("v12-variant-cell")).toHaveCount(6);
    await expect(page.getByTestId("v12-variant-cell").first()).toContainText(/\d[\d,]* cr|—|…/, { timeout: 30_000 });
    await expect(page.getByTestId("v12-variants-versions")).toContainText("aren’t built yet");
    await expect(page.getByTestId("v12-variants-first-row")).toBeDisabled();
    await page.locator('[data-testid="v12-variant-cell"][data-ratio="4:5"]').first().click();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 30_000 });
    /* Make opens at that cell\u2019s size, with the board\u2019s brief. */
    await expect(page.getByTestId("v12-make")).toContainText("Aspect 4:5");
    expect(seen.paid).toEqual([]);
    expect(await noSideways(page)).toBe(true);
  });

  test("Variants without a format or hooks says what to do first", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=variants", { project: campaign() });
    await expect(page.getByTestId("v12-variants-stage")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-variants-needs-format")).toBeVisible();
    await expect(page.getByTestId("v12-variants-needs-hooks")).toBeVisible();
    await page.getByTestId("v12-variants-go-formats").click();
    await expect(page.getByTestId("v12-formats-stage")).toBeVisible({ timeout: 30_000 });
  });
});

async function scopeOf(page: Page) {
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string } };
  return `particl-active-${me.workspace.id}-${me.id}`;
}
async function currentId(page: Page) {
  return new URL(page.url()).searchParams.get("project") ?? "";
}

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("the phone app keeps today's board: no stage pages", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=product", { project: campaign() });
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-product-stage")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });
});
