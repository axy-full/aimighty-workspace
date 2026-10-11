import { test, expect, type Page } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openBoard } from "../helpers/boardV12";
import { newProject, type Project } from "../../lib/workbench/studio";
import { EMPTY_MOLECULR } from "../../lib/workbench/moleculr";

/*
 * The Campaign board's first stages (redesign P6-a) beside prototype 12's URLs: `project=launch&stage=Product`, `Look`, `Formats`.
 * The page reads are answered by fixtures and Make is never opened; nothing is generated or spent.
 */
test.afterAll(closePrototypeServer);

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
const campaign = (extra: Partial<Project> = {}): Project => ({ ...newProject("Spring range"), boardKind: "ads", boardFlavor: "campaign", moleculr: { ...EMPTY_MOLECULR }, ...extra } as Project);

async function mocks(page: Page) {
  await page.route((url) => url.pathname === "/api/workbench/moleculr/extract-product", (route) => route.fulfill({ json: PRODUCT }));
  await page.route((url) => url.pathname === "/api/workbench/moleculr/extract-brand", (route) => route.fulfill({ json: BRAND }));
  await page.route((url) => url.pathname === "/api/workbench/moleculr/import-image", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
}
const settle = async (page: Page) => { await page.mouse.move(700, 120); await page.waitForTimeout(1200); };

test("campaign · Product, a page read and waiting for review", async ({ page }) => {
  test.setTimeout(240_000);
  await openBoard(page, "/suites?view=board&stage=product", { project: campaign() });
  await mocks(page);
  await expect(page.getByTestId("v12-stage-kind")).toHaveText("CAMPAIGN", { timeout: 60_000 });
  await expect(page.getByTestId("v12-product-stage")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Paste the product page link" })).toBeVisible();
  await page.getByTestId("v12-product-url").fill(URL_OK);
  await page.getByTestId("v12-product-read").click();
  await expect(page.getByTestId("v12-product-review")).toBeVisible({ timeout: 30_000 });
  await settle(page);
  await captureBeside(page, "campaign-product", "?view=board&project=launch&stage=Product");
});

test("campaign · Look, the brand's mandatories", async ({ page }) => {
  test.setTimeout(240_000);
  const project = campaign({ moleculr: { ...EMPTY_MOLECULR, productName: "Linen bowl", brandKit: { name: "Quay Ceramics", tagline: "Made by hand", voice: "", audience: "", colors: ["#C8B6A0", "#2F3A46"], font: "system", fontFamilies: ["Inter"] } } as never });
  await openBoard(page, "/suites?view=board&stage=look", { project });
  await expect(page.getByTestId("v12-look-stage")).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await captureBeside(page, "campaign-look", "?view=board&project=launch&stage=Look");
});

test("campaign · Formats, eight skills with one price each", async ({ page }) => {
  test.setTimeout(240_000);
  const project = campaign({ moleculr: { ...EMPTY_MOLECULR, productName: "Linen bowl", productDescription: "A hand-thrown bowl in a washed linen glaze." } as never });
  await openBoard(page, "/suites?view=board&stage=formats", { project });
  await expect(page.getByTestId("v12-formats-stage")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("v12-format")).toHaveCount(8);
  await page.getByTestId("v12-format-pick").first().click();
  await settle(page);
  await captureBeside(page, "campaign-formats", "?view=board&project=launch&stage=Formats");
});
