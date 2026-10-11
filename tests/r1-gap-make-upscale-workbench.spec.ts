import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { PHONES, SIZES, everySpendButtonPriced, floors, noBannedNames, seedPhoneStates, shoot, signedInWarm, watchErrors } from "./helpers/r1-gaps";

/**
 * Release 1 gap 3: Make's Upscale quick tool (the graphite Make frames (deleted in redesign C3; Make is now docs/redesign/inventory.md § 5.12): the third tool beside Motion transfer
 * and Object swap). Priced from the server's quote and off until it is; the paid route is intercepted, so nothing here
 * generates or charges.
 */

const phone = (info: { project: { name: string } }) => PHONES.includes(info.project.name);

async function interceptPaid(page: Page) {
  const sent: { body: Record<string, unknown>; key: string | null }[] = [];
  await page.route("**/api/generate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push({ body: JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>, key: route.request().headers()["idempotency-key"] ?? null });
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "gen_intercepted" }) });
  });
  return sent;
}

const CLIP = join(process.cwd(), "public/fixtures/clip.mp4");
const STILL = join(process.cwd(), "public/campaign/hero.webp");
const PANEL = '[data-testid="make-panel"]';

/** The tool opened on its own address, at any size (a phone has no quick-tool row: it opens Make's own panel the same way Motion transfer does). */
async function openTool(page: Page, project: string) {
  await page.goto(`/suites?project=${project}&view=board&make=upscale`);
  await expect(page.getByTestId("upscale-tool")).toBeVisible();
}
/** A real clip or picture, uploaded through the tool's own Upload, so the server has its stored length and size to price from. */
async function upload(page: Page, file: string) {
  /* The project's takes are read by the client: once they are listed the page is hydrated and the input listens. */
  await expect(page.getByTestId("upscale-select").locator("option")).not.toHaveCount(1, { timeout: 30_000 });
  await page.getByLabel("Upload a source").setInputFiles(file);
  await expect(page.getByTestId("upscale-source")).not.toHaveText("Choose a source", { timeout: 30_000 });
}

test("Upscale sits beside Motion transfer and Object swap in the quick-tool row and opens the tool; the button is off and unpriced with no source", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = watchErrors(page);
  const sent = await interceptPaid(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["review"] });
  if (phone(info)) {
    /* The phone's Make is the simple one (Phone frames F): a prompt box, the engine line and Make at its price. It has no
       quick-tool row, so the panel's tools are not on a phone (Motion transfer and Object swap are not either); what is there is priced. */
    await page.goto(`/suites?project=${seeded.project.id}&make=upscale`);
    await expect(page.getByTestId("phone-make")).toBeVisible();
    await expect(page.getByTestId("upscale-tool")).toHaveCount(0);
    await everySpendButtonPriced(page, ".ph-app");
    await noBannedNames(page, ".ph-app");
    await floors(page, ".ph-app", true);
    await shoot(page, info.project.name, "make-upscale-phone-make");
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
    return;
  }
  await page.goto(`/suites?project=${seeded.project.id}&view=board&make=1`);
  const tools = page.getByTestId("make-quick-tools");
  await expect(tools.getByRole("button")).toHaveText(["Motion transfer", "Object swap", "Upscale"]);
  await shoot(page, info.project.name, "make-quick-tools");
  await tools.getByTestId("make-tool-upscale").click();
  await expect(page).toHaveURL(/make=upscale/);
  await expect(page.getByTestId("make-title")).toHaveText("Upscale");
  const go = page.getByTestId("upscale-go");
  await expect(go).toBeDisabled();
  await expect(go).toHaveAttribute("data-spend", "unpriced");
  await expect(page.getByTestId("upscale-reason")).toHaveText("Choose a picture or a clip.");
  await everySpendButtonPriced(page, PANEL);
  await noBannedNames(page, PANEL);
  await floors(page, PANEL, phone(info));
  await shoot(page, info.project.name, "make-upscale-empty");
  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
});

test("a source the server will not price says its reason and the button stays off and unpriced", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || phone(info), "the panel's quick tools are on the board, not on a phone");
  const sent = await interceptPaid(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["review"] });
  await openTool(page, seeded.project.id);
  const select = page.getByTestId("upscale-select");
  await expect(select.locator("option")).toHaveCount(2, { timeout: 30_000 });
  await select.selectOption({ index: 1 });
  await expect(page.getByTestId("upscale-reason")).toContainText("stored length", { timeout: 30_000 });
  await expect(page.getByTestId("upscale-go")).toBeDisabled();
  await expect(page.getByTestId("upscale-go")).toHaveAttribute("data-spend", "unpriced");
  await everySpendButtonPriced(page, PANEL);
  expect(sent).toEqual([]);
});

test("a clip: Topaz Astra 2 to 4K, priced from the server's quote, one send at that figure", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || phone(info), "the panel's quick tools are on the board, not on a phone");
  const errors = watchErrors(page);
  const sent = await interceptPaid(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["review"] });
  await openTool(page, seeded.project.id);
  await upload(page, CLIP);
  await expect(page.getByTestId("upscale-model")).toHaveText("Topaz Astra 2");
  await expect(page.getByTestId("upscale-engine")).toContainText("4K · 30 fps");
  const go = page.getByTestId("upscale-go");
  await expect(go).toBeEnabled({ timeout: 30_000 });
  await expect(go).toHaveAttribute("data-spend", "priced");
  await expect(go).toHaveText(/^Upscale · (up to )?[\d,.]+ cr$/);
  await everySpendButtonPriced(page, PANEL);
  await noBannedNames(page, PANEL);
  await floors(page, PANEL, phone(info));
  await shoot(page, info.project.name, "make-upscale-clip");
  await page.getByRole("radio", { name: "4K · 60 fps" }).click();
  await expect(go).toBeEnabled({ timeout: 30_000 });
  const price = Number(/([\d,.]+) cr/.exec((await go.textContent()) ?? "")?.[1].replace(/,/g, ""));
  await go.click();
  await expect(page.getByTestId("upscale-note")).toContainText("Queued");
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ task: "upscale", model: "topaz/upscale/video/creative", fps60: true, resolution: "4k", maxCredits: price });
  expect(String(sent[0].body.quoteFingerprint)).toMatch(/^[a-f0-9]{64}$/);
  expect(sent[0].key).toBeTruthy();
  expect(errors).toEqual([]);
});

test("a still: Topaz image upscale at 2× or 4×, each priced by its own quote", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || phone(info), "the panel's quick tools are on the board, not on a phone");
  const sent = await interceptPaid(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["review"] });
  await openTool(page, seeded.project.id);
  await upload(page, STILL);
  await expect(page.getByTestId("upscale-model")).toHaveText("Topaz image upscale");
  const go = page.getByTestId("upscale-go");
  await expect(go).toHaveText(/^Upscale · (up to )?[\d,.]+ cr$/, { timeout: 30_000 });
  await page.getByRole("radio", { name: "4× larger" }).click();
  await expect(go).toHaveText(/^Upscale · (up to )?[\d,.]+ cr$/, { timeout: 30_000 });
  await everySpendButtonPriced(page, PANEL);
  await noBannedNames(page, PANEL);
  await floors(page, PANEL, phone(info));
  await shoot(page, info.project.name, "make-upscale-image");
  await go.click();
  await expect(page.getByTestId("upscale-note")).toContainText("Queued");
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ task: "generate", model: "fal-ai/topaz/upscale/image", topaz: { factor: 4 } });
});
