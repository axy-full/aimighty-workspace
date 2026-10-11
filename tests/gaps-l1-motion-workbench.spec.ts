import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { everySpendButtonPriced, noBannedNames, PHONES, signedInWarm, watchErrors } from "./helpers/r1-gaps";
import { openProjectFor, take, textReadsAtFloor } from "./helpers/gaps-l1";
import { smallTargets, smallText } from "./phoneFloors";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * Gaps, lane 1 · Motion transfer and Object swap details (design/particl-graphite "Gaps B frames"): the source video, the
 * references (numbered, dragged into order, one to eight), the start and end frames, the live price from the server's estimate,
 * and a run with Cancel where the existing cancel route offers it. A source clip is 4 to 8 s for now; 720p is the default and
 * 1080p is allowed. Against a local ENGINE_MOCK server; every send is answered in the browser, nothing real is sent.
 */
const SHOTS = process.env.GAPS_L1_SHOTS || join(tmpdir(), "claude-gaps-l1-shots");
const shoot = (page: Page, name: string, project: string) => { mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: `${SHOTS}/l1-${name}-${project.replace("workbench-", "")}.png`, animations: "disabled" }); };
const CLIP = { url: "/fixtures/clip-6s.mp4", name: "walk.mp4", type: "video/mp4" };
const LONG = { url: "/fixtures/clip.mp4", name: "long.mp4", type: "video/mp4" };
const STILLS = [
  { url: "/campaign/character.webp", name: "cast.webp", type: "image/webp" },
  { url: "/campaign/environment.webp", name: "dunes.webp", type: "image/webp" },
  { url: "/campaign/hero.webp", name: "hero.webp", type: "image/webp" },
];

async function dropFiles(page: Page, files: { url: string; name: string; type: string }[]) {
  await page.getByTestId("viral-well").evaluate(async (well, files) => {
    const data = new DataTransfer();
    for (const f of files) data.items.add(new File([await (await fetch(f.url)).blob()], f.name, { type: f.type }));
    well.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, files);
}

async function floors(page: Page, project: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  expect(await smallText(page), "text under 12 px").toEqual([]);
  expect(await textReadsAtFloor(page, '[data-testid="make-panel"]'), "text under 55% white").toEqual([]);
  await everySpendButtonPriced(page, '[data-testid="make-panel"]');
  await noBannedNames(page, '[data-testid="make-panel"]');
  if (PHONES.includes(project)) expect(await smallTargets(page, '[data-testid="make-panel"]'), "44px targets").toEqual([]);
}

const PHONE = "the phone's Make is the simple one (Phone frames F) and has no quick tools; the phone test below asserts that";

async function open(page: Page, tool: "motion" | "swap") {
  const workspaceId = await signedInWarm(page, "Motion Tester");
  const { project, scope } = await openProjectFor(page, workspaceId, "Motion fixture");
  await page.goto(`/suites?make=${tool}`);
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", tool);
  return { project, scope, workspaceId };
}

test("Motion transfer: source, numbered references dragged into order, start and end frames, and the live price on the line and the button", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), PHONE);
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  const sends: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/generate") sends.push(r.url()); });
  await open(page, "motion");
  const view = page.getByTestId("viral-view");
  await expect(view).toContainText("Source video");
  await expect(view).toContainText("Direction");
  /* 720p is the default; the button waits for a figure and never invents one. */
  await expect(page.getByRole("radio", { name: "720p" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("viral-generate")).toBeDisabled();
  await dropFiles(page, [CLIP, ...STILLS]);
  await expect(page.getByTestId("viral-source")).toContainText("walk.mp4 · 6 s", { timeout: 60_000 });
  const tiles = page.getByTestId("viral-reference");
  await expect(tiles).toHaveCount(3, { timeout: 60_000 });
  await expect(view).toContainText("3 of 8 · drag to reorder");
  await expect(view).toContainText("Start and end frames");
  /* Each reference carries its place. */
  await expect(tiles.locator(".vr-ref-num")).toHaveText(["1", "2", "3"]);
  /* The live estimate: the server's own quote, "up to N cr", on the line and on the button alike. */
  await expect(page.getByTestId("viral-generate")).toHaveText(/^Transfer motion · up to \d[\d,]* cr$/, { timeout: 60_000 });
  const price = (await page.getByTestId("make-engine-price").innerText()).trim();
  expect(await page.getByTestId("viral-generate").innerText()).toContain(price);
  await expect(page.getByTestId("viral-generate")).toHaveAttribute("data-spend", "priced");

  if (!PHONES.includes(info.project.name)) {
    /* Drag the last reference to the front: the order is the order sent. */
    const names = async () => tiles.locator(".vr-ref-name").allInnerTexts();
    const before = await names();
    await tiles.nth(2).dragTo(tiles.nth(0));
    await expect.poll(names).toEqual([before[2], before[0], before[1]]);
    await expect(tiles.locator(".vr-ref-num")).toHaveText(["1", "2", "3"]);
    /* A start frame is saved to the project (free) and joins the references. */
    await page.getByTestId("viral-frame-start").click();
    await expect(page.getByTestId("viral-note")).toContainText("Start frame saved to this project and added as a reference", { timeout: 60_000 });
    await expect(tiles).toHaveCount(4);
    await expect(page.getByTestId("viral-frame-start")).toHaveAttribute("data-set", "");
  }
  await floors(page, info.project.name);
  await shoot(page, "motion", info.project.name);
  expect(sends, "nothing is sent until a person presses").toEqual([]);
  expect(errors).toEqual([]);
});

test("a source longer than 8 s is not taken: the picker says why, with nothing added and no price", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), PHONE);
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await open(page, "motion");
  await dropFiles(page, [LONG, STILLS[0]]);
  await expect(page.getByTestId("viral-note")).toContainText("The source video must be 4–8 s; this one is 10 s.", { timeout: 60_000 });
  await expect(page.getByTestId("viral-note")).toContainText("up to 8 s for now");
  await expect(page.getByTestId("viral-source-card")).toContainText("Choose a video");
  await expect(page.getByTestId("viral-reason")).toHaveText("Add one source video (4–8 s).");
  await expect(page.getByTestId("viral-generate")).toBeDisabled();
  await expect(page.getByTestId("viral-generate")).toHaveAttribute("data-spend", "unpriced");
  await floors(page, info.project.name);
  await shoot(page, "motion-long", info.project.name);
  expect(errors).toEqual([]);
});

test("Object swap: the source, the one element to replace, and what replaces it", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), PHONE);
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await open(page, "swap");
  const view = page.getByTestId("viral-view");
  await expect(view).toContainText("Source video");
  await expect(view).toContainText("Replace");
  await expect(view).toContainText("one element");
  await expect(view).toContainText("With");
  await dropFiles(page, [CLIP, STILLS[0]]);
  await expect(page.getByTestId("viral-reference")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("viral-reference").locator(".vr-ref-num")).toHaveText(["1"]);
  /* This fixture is under Object swap's pixel floor, which the server says before any estimate; the button waits, unpriced. */
  await expect(page.getByTestId("viral-reason")).toContainText("409,600 pixels", { timeout: 60_000 });
  await expect(page.getByTestId("viral-generate")).toBeDisabled();
  await expect(page.getByTestId("viral-generate")).toHaveAttribute("data-spend", "unpriced");
  await floors(page, info.project.name);
  await shoot(page, "swap", info.project.name);
  expect(errors).toEqual([]);
});

test("running: the take waits on the panel, and Cancel is the existing cancel route, offered only while it waits its turn", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), PHONE);
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  const cancels: string[] = [];
  const sends: string[] = [];
  const workspaceId = await signedInWarm(page, "Run Tester");
  const { project } = await openProjectFor(page, workspaceId, "Running fixture");
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const queued = take("gen-run1", "", 1, { kind: "video", model: "higgsfield-genjutsu-motion-transfer", task: "genjutsu", status: "queued", storedUrl: null, createdBy: me.id, creditsBilled: 0, params: { resolution: "720p", references: [{ uploadId: "ref1", role: "reference_image" }] } });
  /* The one paid press is answered here: a queued job, followed and listed, and the cancel route. */
  await page.route(/\/api\/generate$/, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sends.push(route.request().url());
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "gen-run1", status: "queued" }) });
  });
  await page.route(/\/api\/jobs\/gen-run1$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ generation: queued }) }));
  await page.route("**/api/workbench/library?**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("source");
    if (route.request().method() !== "GET" || source !== "generations") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ generations: [queued], nextPageCursor: null }) });
  });
  await page.route(/\/api\/generations\/gen-run1\/cancel$/, (route) => { cancels.push(route.request().url()); return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ status: "requested" }) }); });
  await page.goto(`/suites?make=motion`);
  await expect(page.getByTestId("viral-view")).toBeVisible();
  await dropFiles(page, [CLIP, STILLS[0]]);
  const go = page.getByTestId("viral-generate");
  await expect(go).toHaveText(/^Transfer motion · up to \d[\d,]* cr$/, { timeout: 60_000 });
  expect(sends, "nothing is sent before the press").toEqual([]);
  await go.click();
  const running = page.getByTestId("viral-running");
  await expect(running).toBeVisible({ timeout: 30_000 });
  await expect(running).toContainText("Running");
  await expect(running).toContainText("Queued");
  await expect(running).toContainText(/up to \d[\d,]* cr/);
  await floors(page, info.project.name);
  await shoot(page, "motion-running", info.project.name);
  await page.getByTestId("viral-cancel").click();
  await expect.poll(() => cancels.length).toBe(1);
  expect(cancels[0]).toContain("/api/generations/gen-run1/cancel");
  await expect(page.getByTestId("viral-take-note")).toContainText("Cancel requested");
  expect(sends).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("on a phone the quick tools are not drawn: the address opens the phone's own Make", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "desktop sizes draw the panel's tools (tests above)");
  const errors = watchErrors(page);
  const workspaceId = await signedInWarm(page, "Phone Tester");
  await openProjectFor(page, workspaceId, "Phone fixture");
  await page.goto("/suites?make=motion");
  await expect(page.getByTestId("phone-make")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("viral-view")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/object swap/i);
  expect(errors).toEqual([]);
});
