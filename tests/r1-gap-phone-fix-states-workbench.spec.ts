import { test, expect, type Page } from "@playwright/test";
import { PHONES, SIZES, everySpendButtonPriced, floors, noBannedNames, seedPhoneStates, shoot, signedInWarm, watchErrors } from "./helpers/r1-gaps";

/**
 * Release 1 gap 2: the phone's `fix` (Change with words) and `states` screens (design/particl-graphite, Phone frames D and H).
 * Above phone widths the same screens show in the centred 390 px frame (`device=phone`). Every spending button is priced from
 * the server's quote and disabled until it is; swiping and the review buttons never spend. The paid route is intercepted:
 * nothing here generates or charges.
 */

const framed = (info: { project: { name: string } }) => (PHONES.includes(info.project.name) ? "" : "&device=phone");
const phone = (info: { project: { name: string } }) => PHONES.includes(info.project.name);

/** Every POST to the paid generate route, answered with a made-up job id: the request is recorded and never reaches the engine. */
async function interceptPaid(page: Page) {
  const sent: { body: Record<string, unknown>; key: string | null }[] = [];
  await page.route("**/api/generate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push({ body: JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>, key: route.request().headers()["idempotency-key"] ?? null });
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "gen_intercepted" }) });
  });
  return sent;
}

test("fix: the review under a Change with words sheet, as drawn, with Make the fix priced from the server's quote", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = watchErrors(page);
  const sent = await interceptPaid(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["review"] });
  await page.goto(`/suites?project=${seeded.project.id}&screen=fix${framed(info)}`);
  const app = page.getByTestId("phone-app");
  await expect(app).toBeVisible();
  await expect(page.getByTestId("phone-title")).toHaveText("Review");
  await expect(page.getByTestId("phone-fix")).toBeVisible();
  await expect(page.getByTestId("phone-fix-count")).toHaveText("fix 1 of 2");
  await expect(page.getByTestId("phone-fix-engine")).toContainText("the original stays");
  /* The tab bar stays under the sheet (only the full-screen review and plan approval hide it). */
  await expect(page.getByTestId("mobile-dock")).toBeVisible();
  const go = page.getByTestId("phone-fix-go");
  /* Disabled until there are words and a price for them; the price is the server's. */
  await expect(go).toBeDisabled();
  await expect(page.getByTestId("phone-fix-why")).toHaveText("Say what to change.");
  await page.getByTestId("phone-fix-words").fill("Plant her feet; fix the reflection.");
  await expect(go).toBeEnabled({ timeout: 30_000 });
  await expect(go).toHaveAttribute("data-spend", "priced");
  await expect(go).toHaveText(/^Make the fix · (up to )?[\d,.]+ cr$/);
  await everySpendButtonPriced(page, ".ph-app");
  await noBannedNames(page, ".ph-app");
  await floors(page, ".ph-app", phone(info));
  await shoot(page, info.project.name, "phone-fix");
  expect(sent, "looking at the sheet sent nothing").toEqual([]);
  expect(errors).toEqual([]);
});

test("fix: the one press sends the quoted request, once, and goes Home", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const sent = await interceptPaid(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["review"] });
  await page.goto(`/suites?project=${seeded.project.id}&screen=fix${framed(info)}`);
  await page.getByTestId("phone-fix-words").fill("Plant her feet");
  const go = page.getByTestId("phone-fix-go");
  await expect(go).toBeEnabled({ timeout: 30_000 });
  const price = Number(/([\d,.]+) cr/.exec((await go.textContent()) ?? "")?.[1].replace(/,/g, ""));
  await go.click();
  await expect(page.getByTestId("phone-home")).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ task: "edit", rawPrompt: "Plant her feet", maxCredits: price });
  expect(String(sent[0].body.quoteFingerprint)).toMatch(/^[a-f0-9]{64}$/);
  expect(sent[0].key).toBeTruthy();
});

test("review: swiping and the buttons judge and never spend; Change with words opens the sheet and spends nothing", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const sent = await interceptPaid(page);
  const releases: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/release$/.test(r.url())) releases.push(r.url()); });
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["review"] });
  await page.goto(`/suites?project=${seeded.project.id}&screen=review${framed(info)}`);
  const media = page.getByTestId("phone-review-media");
  await expect(media).toBeVisible();
  const change = page.getByTestId("phone-change");
  await expect(change).toBeEnabled({ timeout: 30_000 });
  await expect(change).toContainText(/Change with words · (up to )?[\d,.]+ cr/, { timeout: 30_000 });
  await change.click();
  await expect(page.getByTestId("phone-fix")).toBeVisible();
  await expect(page).toHaveURL(/screen=fix/);
  await page.getByTestId("phone-sheet-close").click();
  await expect(page).toHaveURL(/screen=review/);
  const box = (await media.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  /* The only take is judged, so the review ends and Home shows (the toast says "nothing spent", then "Every take here is judged"). */
  await expect(page.getByTestId("phone-home")).toBeVisible();
  expect(sent, "a swipe sent no paid request").toEqual([]);
  expect(releases).toEqual([]);
});

test("states: rendering, failed and held, each as drawn, each button priced; Retry opens Make and sends nothing", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = watchErrors(page);
  const sent = await interceptPaid(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { heldNeeds: 99_999 });
  await page.goto(`/suites?project=${seeded.project.id}&screen=states${framed(info)}`);
  await expect(page.getByTestId("phone-title")).toHaveText("Quiet harbour · states");
  const cards = page.getByTestId("phone-state-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.filter({ hasText: "Rendering" }).getByTestId("phone-notify")).toHaveText("Notify me when done");
  const failed = cards.filter({ hasText: "Failed" });
  await expect(failed.getByTestId("phone-state-why")).toHaveText(/engine/i);
  const retry = failed.getByTestId("phone-state-retry");
  await expect(retry).toHaveAttribute("data-spend", /priced|unpriced/);
  await expect(retry).toHaveText(/^Retry · (up to )?[\d,.]+ cr$/, { timeout: 30_000 });
  const held = cards.filter({ hasText: "Held" });
  await expect(held.getByTestId("take-release")).toContainText("Release");
  await expect(held.getByTestId("take-release")).toContainText("99,999");
  await expect(held.getByTestId("phone-state-needs")).toContainText("Short by");
  await expect(held.getByTestId("phone-state-topup")).toBeVisible();
  await expect(held.getByTestId("phone-state-hold")).toBeVisible();
  /* Home is the lit tab, and the bar is there. */
  await expect(page.getByTestId("phone-tab-home")).toHaveAttribute("aria-current", "page");
  await everySpendButtonPriced(page, ".ph-app");
  await noBannedNames(page, ".ph-app");
  await floors(page, ".ph-app", phone(info));
  await shoot(page, info.project.name, "phone-states");
  await retry.click();
  await expect(page.getByTestId("phone-make")).toBeVisible();
  expect(sent, "Retry handed the recipe to Make and sent nothing").toEqual([]);
  expect(errors).toEqual([]);
});

test("states: with no connection, judging queues and spending says it needs a connection", async ({ page, context }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const sent = await interceptPaid(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["review"] });
  await page.goto(`/suites?project=${seeded.project.id}&screen=states${framed(info)}`);
  await expect(page.getByTestId("phone-states")).toBeVisible();
  await context.setOffline(true);
  const offline = page.getByTestId("phone-state-offline");
  await expect(offline).toBeVisible();
  await expect(offline).toContainText("Reviews queue until you’re back online");
  await expect(page.getByTestId("phone-state-change")).toBeDisabled();
  await expect(page.getByTestId("phone-state-change")).toContainText("Needs a connection");
  await floors(page, ".ph-app", phone(info));
  await shoot(page, info.project.name, "phone-states-offline");
  await page.getByTestId("phone-state-approve").click();
  await expect(page.getByTestId("toast")).toContainText("sent when you're back online");
  await context.setOffline(false);
  expect(sent).toEqual([]);
});

test("fix: a clip the engine will not edit says the server's reason, offers Remake it in Make, and the button stays unpriced and off", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const sent = await interceptPaid(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["review"], resolution: "1080p" });
  await page.goto(`/suites?project=${seeded.project.id}&screen=fix${framed(info)}`);
  await page.getByTestId("phone-fix-words").fill("Plant her feet");
  await expect(page.getByTestId("phone-fix-why")).toContainText("480p or 720p", { timeout: 30_000 });
  const go = page.getByTestId("phone-fix-go");
  await expect(go).toBeDisabled();
  await expect(go).toHaveAttribute("data-spend", "unpriced");
  await everySpendButtonPriced(page, ".ph-app");
  await floors(page, ".ph-app", phone(info));
  await shoot(page, info.project.name, "phone-fix-refused");
  await page.getByTestId("phone-fix-remake").click();
  await expect(page.getByTestId("phone-make")).toBeVisible();
  expect(sent).toEqual([]);
});
