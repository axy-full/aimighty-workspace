import { test, expect, type Page } from "@playwright/test";
import { seedHome } from "./helpers/v12Home";

/**
 * Make › Remix in the new interface (redesign P6-c; docs/redesign/inventory.md § 10.3): each of the four ops shows its price line
 * or "quoted" with its reason (no quote exists before a source is chosen in the tool, and Cut into clips and Add an effect have no
 * engine), an op with no source in the composer says "Paste a link or drop a video first" and opens nothing, and the row offers
 * Ask Atomik, which fills the words in Atomik's field. Nothing spends: an op only opens a tool, which shows its own price.
 * Local ENGINE_MOCK server.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("each Remix op shows its price or says quoted; with no source an op asks for one and opens nothing; Ask Atomik fills the words", async ({ page }) => {
    test.setTimeout(240_000);
    const paid: string[] = [];
    page.on("request", (r) => { const path = new URL(r.url()).pathname; if (r.method() !== "GET" && /^\/api\/(generate$|audio$|soul|rig\/runs)/.test(path) && !/quote/i.test(r.postData() ?? "")) paid.push(`${r.method()} ${path}`); });
    await seedHome(page, { takes: 2 });
    await page.goto("/suites?view=make");
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("radio", { name: "Remix" }).click();
    const ops = page.getByTestId("v12-make-op");
    await expect(ops).toHaveCount(4);
    await expect(ops).toContainText(["Cut into clips · quoted", "Transfer motion · quoted", "Swap an object · quoted", "Add an effect · quoted"]);
    /* Each "quoted" carries its own reason on hover. */
    const hovers = await ops.evaluateAll((els) => els.map((el) => el.querySelector("[data-price-state='quoted']")?.getAttribute("title") ?? ""));
    expect(hovers.every((h) => h.length > 10)).toBe(true);
    expect(new Set(hovers).size, "no two ops share one reason").toBe(hovers.length - 1 > 0 ? 3 : 4);
    await expect(page.locator('[data-op="cut"]')).toBeDisabled();
    await expect(page.locator('[data-op="effect"]')).toBeDisabled();
    await expect(page.getByTestId("v12-make-go")).toBeDisabled();

    /* No source in the composer: the op says what it needs and opens nothing. */
    await page.locator('[data-op="motion"]').click();
    await expect(page.getByText("Paste a link or drop a video first.")).toBeVisible();
    await expect(page.getByTestId("make-panel")).toHaveCount(0);

    /* Ask Atomik fills the words in Atomik's field; nothing is sent. */
    await page.getByTestId("v12-make-remix-ask").click();
    await expect(page.locator("textarea:visible").last()).toHaveValue(/What should we do with this video/, { timeout: 15_000 });
    expect(paid, "an op and Ask Atomik run nothing").toEqual([]);
    expect(await noOverflow(page)).toBe(true);

    /* Other modes show no Remix row. */
    await page.getByRole("radio", { name: "Image" }).click();
    await expect(page.getByTestId("v12-make-remix-ask")).toHaveCount(0);
    await expect(page.getByTestId("v12-make-op")).toHaveCount(0);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("the phone app keeps today's Make: no Remix row", async ({ page }) => {
    await seedHome(page, { takes: 1 });
    await page.goto("/suites?view=make");
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 90_000 });
    await expect(page.getByTestId("v12-make-remix-ask")).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
  });
});
