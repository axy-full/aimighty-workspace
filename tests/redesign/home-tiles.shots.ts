import { test, expect } from "@playwright/test";
import type { QueueItem } from "../../lib/control-room/queue";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { seedHome } from "../helpers/v12Home";
import { mockMedia } from "../helpers/workspaceFixtures";

/* Home's wall with an older clip among the stills (redesign fix: no black tiles), beside the prototype's default view. Neutral data of the test workspace's own. */
test.afterAll(closePrototypeServer);

const item = (id: string, title: string, credits: number): QueueItem => ({
  id, title, source: "held", where: "Board", at: Date.now() - 5 * 60_000,
  project: { productionId: "prod-x", draftId: null, name: "Harbour film" },
  price: { kind: "exact", credits }, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "release", genId: id, credits }, decline: null, open: { kind: "take", genId: id, draftId: null },
});

test("home wall with a clip beside the prototype", async ({ page }) => {
  test.setTimeout(300_000);
  await seedHome(page, { takes: 5 });
  await mockMedia(page);
  await page.route((url) => url.pathname === "/api/control-room/approvals", (route) => route.fulfill({ json: { items: [item("held:a", "Shot 4 · keyframe", 2), item("held:b", "Shot 6 · retake", 7)], decided: [], inCredits: true } }));
  /* The oldest take is a clip (the fixture file stands in for its stored original), after five stills. */
  await page.route(/\/api\/jobs\?.*kind=video/, async (route) => {
    const reply = await route.fetch();
    const body = await reply.json();
    const clip = { id: "gen_clip_fixture", kind: "video", status: "succeeded", storedUrl: "/api/media/gen_clip_fixture", model: "dreamina-seedance-2-5-260628", prompt: "A boat leaves the quay, slow push-in", params: { ratio: "16:9", duration: 5 }, createdAt: Date.now() - 86_400_000, durationS: 5 };
    await route.fulfill({ response: reply, json: { ...body, generations: [clip] } });
  });
  await page.route(/\/api\/media\/gen_clip_fixture/, (route) => route.fulfill({ path: "public/fixtures/clip.mp4", contentType: "video/mp4" }));
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("v12-home-tile")).toHaveCount(6, { timeout: 90_000 });
  await expect.poll(async () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".v12-hm-tile-media")).every((el) => (el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el instanceof HTMLVideoElement ? el.readyState >= 2 : false))), { timeout: 60_000 }).toBe(true);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await captureBeside(page, "home-tiles", "?");
});
