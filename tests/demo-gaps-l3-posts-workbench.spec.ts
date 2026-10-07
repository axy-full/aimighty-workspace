import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { everySpendButtonPriced, floors, noBannedNames } from "./helpers/r1-gaps";
import { desktop, shoot, watchErrors } from "./helpers/gaps-l3";
import { seedAds } from "./helpers/s11-board";

/*
 * Gap screens, lane 3 · Social post states (Gaps B frames, "Ads and Social", posts). Posting is not in Particl yet, so a real
 * build has no posts and the section reads "Not in Particl yet", with no button and no price. In a development build asked for
 * (sessionStorage `particl-posts-preview`), five sample posts, one in each state, show the screen: draft (Send for approval),
 * waiting (Approve post, a person's), scheduled (Unschedule), posted, failed (Reconnect and Retry · free). Every action is free;
 * nothing is published and nothing is sent to any platform. The canvas is the desktop's: phone widths open the project's Record.
 */
const NAMED_PHONE = "the canvas is the desktop's; phone widths open the project's Record (phone specs own them)";
const url = (id: string) => `/suites?project=${id}&view=board&kind=social`;

async function preview(page: import("@playwright/test").Page) {
  await page.addInitScript(() => { try { sessionStorage.setItem("particl-posts-preview", "1"); } catch { /* storage off */ } });
  const { project, paid } = await seedAds(page, null, "social");
  const sent: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET" && /post|publish|social/i.test(new URL(r.url()).pathname)) sent.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(url(project.id));
  await expect(page.getByTestId("social-post")).toHaveCount(5, { timeout: 60_000 });
  return { project, paid, sent };
}

test("a real build has no posts: the section says Not in Particl yet, with no button and no price", async ({ page }) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { project } = await seedAds(page, null, "social");
  await page.goto(url(project.id));
  await expect(page.getByTestId("social-start")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("social-start-file").setInputFiles({ name: "walk.mp4", mimeType: "video/mp4", buffer: readFileSync("public/fixtures/clip-6s.mp4") });
  await expect(page.getByTestId("social-source")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("social-post")).toHaveCount(0);
  const off = page.getByTestId("social-unavailable");
  await expect(off).toHaveCount(4);
  await expect(off.filter({ hasText: "Posts" })).toContainText("Not in Particl yet");
  await expect(off.filter({ hasText: "Posts" }).locator("button")).toHaveCount(0);
});

test("five posts, one in each state, each with its words and its free actions", async ({ page }, info) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const errors = watchErrors(page);
  const { paid, sent } = await preview(page);
  await page.getByTestId("board-rail").locator('[data-region="posts"]').click();
  await page.waitForTimeout(700);
  const cards = page.getByTestId("social-post");
  await expect(cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-post-state")))).resolves.toEqual(["draft", "waiting", "scheduled", "posted", "failed"]);
  await expect(cards.nth(0)).toContainText("Instagram · Reel");
  await expect(cards.nth(0).getByTestId("social-post-state")).toHaveText("Draft");
  await expect(cards.nth(0).getByTestId("social-post-send")).toHaveText("Send for approval");
  await expect(cards.nth(1).getByTestId("social-post-state")).toHaveText("Waiting for your approval");
  await expect(cards.nth(1).getByTestId("social-post-approve")).toHaveText("Approve post");
  await expect(cards.nth(2).getByTestId("social-post-state")).toHaveText(/^Scheduled · \w{3} \d\d:\d\d$/);
  await expect(cards.nth(2).getByTestId("social-post-unschedule")).toHaveText("Unschedule");
  await expect(cards.nth(3).getByTestId("social-post-state")).toHaveText("Posted · 2 h ago");
  await expect(cards.nth(3).locator("button")).toHaveCount(0);
  await expect(cards.nth(4).getByTestId("social-post-state")).toHaveText("Failed · the account needs reconnecting · nothing posted");
  await expect(cards.nth(4).getByTestId("social-post-reconnect")).toHaveText("Reconnect");
  await expect(cards.nth(4).getByTestId("social-post-retry")).toHaveText("Retry · free");
  /* The account has to be reconnected before a retry means anything. */
  await expect(cards.nth(4).getByTestId("social-post-retry")).toBeDisabled();
  await expect(page.locator('[data-card-id="group:social-posts"]')).toContainText("every post is approved by a person");
  /* One filled button among the posts: the approval. */
  expect(await page.locator('[data-testid="social-post"] [data-primary]').count()).toBe(1);
  await noBannedNames(page, '[data-testid="board"]');
  await everySpendButtonPriced(page, '[data-testid="board"]');
  await floors(page, '[data-testid="board"]', false);
  await shoot(page, info.project.name, "social-posts");
  expect(paid).toEqual([]);
  expect(sent, "nothing is sent to a platform").toEqual([]);
  expect(errors).toEqual([]);
});

test("a person moves a post along: send for approval, approve, unschedule; each free, none published", async ({ page }) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { paid, sent } = await preview(page);
  await page.getByTestId("board-rail").locator('[data-region="posts"]').click();
  await page.waitForTimeout(700);
  const cards = page.getByTestId("social-post");
  await cards.nth(0).getByTestId("social-post-send").click();
  await expect(cards.nth(0)).toHaveAttribute("data-post-state", "waiting");
  await cards.nth(0).getByTestId("social-post-approve").click();
  await expect(cards.nth(0)).toHaveAttribute("data-post-state", "scheduled");
  await expect(cards.nth(0).getByTestId("social-post-state")).toContainText("Scheduled ·");
  await cards.nth(0).getByTestId("social-post-unschedule").click();
  await expect(cards.nth(0)).toHaveAttribute("data-post-state", "draft");
  expect(paid).toEqual([]);
  expect(sent).toEqual([]);
});
