import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { dimLabels, smallTargets } from "./phoneFloors";
import { newProject, type Asset, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { DevelopmentJob, DevelopmentQuote } from "../lib/workbench/development-types";
import type { TakeVerification } from "../lib/workbench/verify";

/**
 * The agentic Rig, step 5 (plan PR 7): press Verify on a take and get a priced
 * scorecard. Against the real local ENGINE_MOCK=1 server throughout: the quote,
 * the reservation, the development job, the mock judge (which compares average
 * colours and calls no provider), the settlement and the stored check. Test
 * pictures are plain colour squares: the same colour as the master passes, a
 * near one is unsure, and "unsure" needs a person.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const ENGINE = "dreamina-seedance-2-5-260628";
type Rgb = { r: number; g: number; b: number };
const RED: Rgb = { r: 220, g: 40, b: 40 }, NEAR_RED: Rgb = { r: 180, g: 40, b: 40 }, BLUE: Rgb = { r: 40, g: 40, b: 220 };
type Receipt = { id: string; url: string; mime: string };

const card = (id: string, title: string, type: CanvasNode["type"], extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title, type, x: 0, y: 0, width: 220, linked: [], ...extra });
const picture = (id: string, name: string, category: string, receipt: Receipt, extra: Partial<Asset> = {}): Asset => ({
  id, name, kind: receipt.mime.startsWith("video/") ? "video" : "image", category, url: receipt.url, uploadId: receipt.id, mime: receipt.mime,
  description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra,
});

/** A new workspace with credits, a Cast master and a shot whose take is `take` (test fixtures only). */
async function setup(page: Page, info: TestInfo, take: Rgb | "video", withCard = false) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Local mock Verify test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const upload = async (name: string, buffer: Buffer, mimeType: string): Promise<Receipt> => {
    const response = await page.request.post("/api/uploads", { headers, multipart: { file: { name, mimeType, buffer } } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const square = (rgb: Rgb) => sharp({ create: { width: 64, height: 64, channels: 3, background: rgb } }).png().toBuffer();
  const master = await upload("mira-master.png", await square(RED), "image/png");
  const takeReceipt = take === "video" ? await upload("opening-take.mp4", await readFile("public/fixtures/clip.mp4"), "video/mp4") : await upload("opening-take.png", await square(take), "image/png");
  const project: Project = {
    ...newProject("Verify study"), id: `verify-${Date.now().toString(36)}-${info.project.name.replace(/\D/g, "")}`,
    assets: [picture("face", "Mira master", "Character", master), picture("take", "The opening take", "Take", takeReceipt, { nodeId: "open" })],
    nodes: [
      card("mira", "Mira", "character", { assetId: "face" }),
      card("open", "The opening", "scene", { x: 300, assetId: "take", linked: ["mira"], width: 238, role: "Director", status: "draft", mode: take === "video" ? "Video" : "Image", engine: ENGINE, durationS: 5, ratio: "16:9", resolution: "720p" }),
      ...(withCard ? [card("check", "Verify · The opening", "review", { x: 620, linked: ["open", "mira"], verify: { rubric: 1, frames: { videoAt: [0.1, 0.5, 0.9], max: 3 } } })] : []),
    ],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { revision } = (await saved.json()) as { revision: number };
  return { headers, project, revision, takeId: `upload:${takeReceipt.id}`, upload, square };
}

/** Every POST to the development route this page sends: quotes, starts and resumes. */
function watchDevelopment(page: Page) {
  const posts: { quoteOnly?: boolean; resume?: boolean; kind?: string; maxCredits?: number }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/workbench/development") posts.push(request.postDataJSON());
  });
  return { posts, starts: () => posts.filter((p) => !p.quoteOnly && !p.resume) };
}

async function openRig(page: Page, projectId: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await forbidPaidWork(page);
  await page.goto(`/suites?suite=studio&page=rig&project=${projectId}`);
  await expect(page.getByTestId("project-name")).toHaveText("Verify study");
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(page.getByTestId("rig-graph-surface")).toBeVisible();
  await page.getByTestId("rig-graph-surface").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.getByTestId("rig-zoom-fit").click();
  return errors;
}
const node = (page: Page, id: string) => page.getByTestId("rig-graph").locator(`.pxw-graph-node[data-node-id="${id}"]`);
async function closeOverlay(page: Page) {
  if (await page.getByTestId("panel-scrim").isVisible()) await page.getByTestId("close-inspector").click();
  await expect(page.getByTestId("panel-scrim")).toHaveCount(0);
}
async function openInspector(page: Page) {
  if (!(await page.getByTestId("inspector").isVisible())) await page.getByTestId("toggle-inspector").click();
  await expect(page.getByTestId("inspector")).toBeVisible();
}
async function pick(page: Page, id: string) {
  await closeOverlay(page);
  await page.getByTestId("rig-graph-surface").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await node(page, id).locator(".pxw-graph-hit").click();
  await expect(node(page, id)).toHaveAttribute("data-selected", "true");
  await openInspector(page);
}
/** From the shot: "Verify this take" makes its Verify card and opens it in the Card Inspector. */
async function verifyCardFromShot(page: Page) {
  await pick(page, "open");
  await page.getByTestId("rig-verify-open").click();
  const body = page.locator('[data-inspector-body="node"]');
  await expect(body.getByTestId("card-verify")).toBeVisible();
  return body;
}
/** Asks for the price and approves exactly that; the check runs on the mock judge and lands as a scorecard. */
async function priceAndApprove(body: Locator, watch: ReturnType<typeof watchDevelopment>) {
  await body.getByTestId("card-verify-estimate").click();
  await expect(body.getByTestId("card-verify-price")).toContainText(/about \d[\d,]* cr, charged in credits once it is done/);
  const start = body.getByTestId("card-verify-start");
  await expect(start).toHaveText(/^Verify · about \d[\d,]* cr$/);
  const credits = Number((await start.textContent())!.replace(/\D/g, ""));
  expect(credits).toBeGreaterThan(0);
  /* Nothing paid yet: only the free quote went out. */
  expect(watch.starts()).toEqual([]);
  await start.click();
  await expect(body.getByTestId("card-verify-scorecard")).toBeVisible({ timeout: 60_000 });
  /* The start carried the price the person saw, and it went out once. */
  expect(watch.starts()).toHaveLength(1);
  expect(watch.starts()[0]).toMatchObject({ kind: "verify", maxCredits: credits });
  return credits;
}

/** Visible text under 12px inside one region. */
const smallTextIn = (region: Locator) =>
  region.evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!(n.textContent ?? "").trim() || !el || !el.getClientRects().length) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size}px ${el.className || el.tagName}: ${(n.textContent ?? "").trim().slice(0, 30)}`);
    }
    return out;
  });
/** Nothing scrolls sideways: the page, the content pane, the Inspector's body. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="content"], .gx-insp-body, [data-inspector-body]')))
      if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) out.push(`${el.dataset.testid ?? el.className} ${el.scrollWidth} > ${el.clientWidth}`);
    return out;
  });
/** At the end of the Inspector's scroll, its last line sits above a floating tab bar. */
const clearsTabBar = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".gx-insp-body");
    const body = document.querySelector<HTMLElement>('[data-inspector-body="node"]');
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    if (!scroller || !body || !bar || getComputedStyle(bar).position !== "fixed" || !bar.getClientRects().length) return [];
    scroller.scrollTop = scroller.scrollHeight;
    const last = Array.from(body.querySelectorAll<HTMLElement>("*")).filter((el) => el.getClientRects().length && !el.children.length).pop();
    const top = bar.getBoundingClientRect().top;
    return last && last.getBoundingClientRect().bottom > top + 1 ? [`${last.className || last.tagName} ends at ${last.getBoundingClientRect().bottom}, the tab bar starts at ${top}`] : [];
  });
/** The phone floors on the Card Inspector, at every size the label floor and no sideways scroll. */
async function floors(page: Page, info: TestInfo, body: Locator, what: string) {
  if (PHONES.includes(info.project.name)) {
    expect(await smallTextIn(body), `${what}: text under 12px`).toEqual([]);
    expect(await smallTargets(page, '[data-inspector-body="node"]'), `${what}: targets under 44×44`).toEqual([]);
  }
  expect(await dimLabels(page, '[data-inspector-body="node"]'), `${what}: labels under #7C7C84`).toEqual([]);
  expect(await clearsTabBar(page), `${what}: the last line under the tab bar`).toEqual([]);
  expect(await sideways(page), `${what}: sideways scroll`).toEqual([]);
}

test("press Verify on a take: the price comes first, the approved check lands as a scorecard, and a second press is free", async ({ page }, info) => {
  const s = await setup(page, info, RED);
  const watch = watchDevelopment(page);
  const errors = await openRig(page, s.project.id);
  const body = await verifyCardFromShot(page);
  await expect(body.getByTestId("card-verify-take")).toContainText("The opening · v1 · still");
  await expect(body.getByTestId("card-verify-masters")).toContainText("Cast · Mira v1");
  await expect(body.getByTestId("card-verify-checks")).toContainText("Identity, Wardrobe, Artifacts");
  await expect(body.getByTestId("card-verify-none")).toHaveText("Not checked yet.");
  await floors(page, info, body, "before the price");
  const verifyId = (await body.getAttribute("data-node-id"))!;

  await body.getByTestId("card-verify-estimate").click();
  await expect(body.getByTestId("card-verify-price")).toBeVisible();
  await floors(page, info, body, "with the price");
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("verify-price-390x844.png"), animations: "disabled" });
  await body.getByRole("button", { name: "Cancel" }).click();
  await priceAndApprove(body, watch);

  const scorecard = body.getByTestId("card-verify-scorecard");
  await expect(scorecard).toHaveAttribute("data-verdict", "pass");
  await expect(body.getByTestId("card-verify-verdict")).toContainText("Passed");
  await expect(body.getByTestId("card-verify-row")).toHaveCount(3);
  for (const row of await body.getByTestId("card-verify-row").all()) await expect(row).toHaveAttribute("data-verdict", "pass");
  await expect(body.getByTestId("card-verify-meta")).toContainText(/cr charged$/);
  await floors(page, info, body, "the scorecard");
  if (["workbench-390x844", "workbench-1440x900"].includes(info.project.name)) await page.screenshot({ path: info.outputPath(`verify-scorecard-${info.project.name}.png`), animations: "disabled" });

  /* The same take against the same masters: the stored scorecard, and nothing is sent. */
  const sent = watch.posts.length;
  await body.getByTestId("card-verify-estimate").click();
  await expect(body.getByTestId("card-verify-free")).toContainText("Reading it again is free");
  expect(watch.posts.length).toBe(sent);
  const stored = await page.request.get(`/api/workbench/development?projectId=${s.project.id}&verifications=1`, { headers: s.headers }).then((r) => r.json()) as { verifications: TakeVerification[] };
  expect(stored.verifications).toHaveLength(1);
  expect(stored.verifications[0]).toMatchObject({ takeId: s.takeId, verifyNodeId: verifyId, verdict: "pass", standing: "current", mastersCurrent: true });

  /* On the canvas the card says it passed, and the verdict reached the team canvas. */
  await closeOverlay(page);
  await expect(node(page, verifyId).getByTestId("rig-verify-line")).toHaveAttribute("data-verdict", "pass");
  await expect(node(page, verifyId).locator(".pxw-graph-verify-verdict")).toHaveText("PASSED");
  expect(await dimLabels(page, '[data-testid="rig-graph"]'), "canvas labels under #7C7C84").toEqual([]);
  if (PHONES.includes(info.project.name)) {
    const sizes = await node(page, verifyId).locator(".pxw-graph-verify span").evaluateAll((els) => els.map((el) => Number.parseFloat(getComputedStyle(el).fontSize)));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
  }
  expect(await sideways(page), "sideways scroll on the canvas").toEqual([]);

  /* Takes: the take carries its check. */
  await page.goto(`/suites?suite=studio&page=takes&project=${s.project.id}`);
  await expect(page.locator(`[data-take="${s.takeId}"]`).getByTestId("take-verify")).toHaveText("Verified", { timeout: 30_000 });
  expect(await sideways(page), "sideways scroll in Takes").toEqual([]);
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("verify-takes-390x844.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("an unsure check is never a pass: the card and Takes say it needs you", async ({ page }, info) => {
  const s = await setup(page, info, NEAR_RED);
  const watch = watchDevelopment(page);
  const errors = await openRig(page, s.project.id);
  const body = await verifyCardFromShot(page);
  await priceAndApprove(body, watch);
  await expect(body.getByTestId("card-verify-scorecard")).toHaveAttribute("data-verdict", "needs_you");
  await expect(body.getByTestId("card-verify-verdict")).toContainText("Needs you");
  await expect(body.getByTestId("card-verify-needs-you")).toContainText("nothing passed on a guess");
  await expect(body.locator('[data-testid="card-verify-row"][data-check="identity"]')).toHaveAttribute("data-verdict", "unsure");
  await expect(body.locator('[data-testid="card-verify-row"][data-check="identity"] .pxw-verify-row-verdict')).toHaveText("Unsure");
  await floors(page, info, body, "a scorecard that needs you");
  const verifyId = (await body.getAttribute("data-node-id"))!;
  await closeOverlay(page);
  await expect(node(page, verifyId).locator(".pxw-graph-verify-verdict")).toHaveText("NEEDS YOU");
  await page.goto(`/suites?suite=studio&page=takes&project=${s.project.id}`);
  await expect(page.locator(`[data-take="${s.takeId}"]`).getByTestId("take-verify")).toHaveText("Check needs you", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("a changed master: the stored check says it was against an older master, and a new check is priced again", async ({ page }, info) => {
  const s = await setup(page, info, RED, true);
  /* The first check, through the real routes: priced, approved as priced, run on the mock judge. */
  const input = { projectId: s.project.id, requestId: randomUUID(), kind: "verify", model: "", effort: "auto", nodeId: "check" };
  const state = await page.request.get(`/api/workbench/development?projectId=${s.project.id}`, { headers: s.headers }).then((r) => r.json()) as { models: { id: string; vision: boolean }[] };
  input.model = state.models.find((m) => m.vision && m.id.startsWith("anthropic/"))?.id ?? state.models.find((m) => m.vision)!.id;
  const quoted = await page.request.post("/api/workbench/development", { headers: s.headers, data: { ...input, quoteOnly: true } });
  expect(quoted.ok(), await quoted.text()).toBe(true);
  const quote = (await quoted.json()) as DevelopmentQuote;
  expect(quote.estimateCredits).toBeGreaterThan(0);
  const started = await page.request.post("/api/workbench/development", { headers: s.headers, data: { ...input, sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits } });
  expect(started.ok(), await started.text()).toBe(true);
  const job = ((await started.json()) as { job: DevelopmentJob }).job;
  await expect.poll(async () => {
    const jobs = (await page.request.get(`/api/workbench/development?projectId=${s.project.id}&requestId=${input.requestId}`, { headers: s.headers }).then((r) => r.json())).jobs as DevelopmentJob[];
    const now = jobs.find((j) => j.id === job.id);
    if (now?.status === "queued") await page.request.post("/api/workbench/development", { headers: s.headers, data: { resume: true, projectId: s.project.id, jobId: job.id } });
    return now?.status;
  }, { timeout: 60_000 }).toBe("succeeded");
  /* The same check again through the route: stored, free. */
  const again = (await page.request.post("/api/workbench/development", { headers: s.headers, data: { ...input, requestId: randomUUID(), quoteOnly: true } }).then((r) => r.json())) as DevelopmentQuote;
  expect(again).toMatchObject({ estimateCredits: 0, calls: 0, stored: { id: job.id, verdict: "pass" } });

  /* Mira's master picture changes: a new version of the master. */
  const blue = await s.upload("mira-new-wardrobe.png", await s.square(BLUE), "image/png");
  const changed = { ...s.project, assets: [...s.project.assets, picture("face2", "Mira, new wardrobe", "Character", blue)], nodes: s.project.nodes.map((n) => (n.id === "mira" ? { ...n, assetId: "face2" } : n)) };
  const saved = await page.request.put("/api/workbench/projects", { headers: s.headers, data: { project: changed, revision: s.revision } });
  expect(saved.ok(), await saved.text()).toBe(true);

  const watch = watchDevelopment(page);
  const errors = await openRig(page, s.project.id);
  await expect(node(page, "check").getByTestId("rig-verify-line")).toHaveAttribute("data-standing", "older-master");
  await expect(node(page, "check").locator(".pxw-graph-verify-detail")).toHaveText("Checked against an older master");
  await pick(page, "check");
  const body = page.locator('[data-inspector-body="node"][data-node-id="check"]');
  await expect(body.getByTestId("card-verify-scorecard")).toHaveAttribute("data-verdict", "pass");
  await expect(body.getByTestId("card-verify-stale")).toContainText("Checked against an older master");
  await floors(page, info, body, "a check against an older master");
  /* Verify again: a new, priced check — not the stored one. */
  await expect(body.getByTestId("card-verify-estimate")).toHaveText("Verify again");
  await body.getByTestId("card-verify-estimate").click();
  await expect(body.getByTestId("card-verify-price")).toContainText(/about \d[\d,]* cr/);
  await expect(body.getByTestId("card-verify-free")).toHaveCount(0);
  expect(watch.starts()).toEqual([]);
  await page.goto(`/suites?suite=studio&page=takes&project=${s.project.id}`);
  await expect(page.locator(`[data-take="${s.takeId}"]`).getByTestId("take-verify")).toHaveText("Verified · older master", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("a video take is checked from three stills its browser samples and stores", async ({ page }, info) => {
  test.skip(!["workbench-1440x900", "workbench-390x844"].includes(info.project.name), "one desktop and one phone decode the clip; the other sizes are covered by the still checks");
  const s = await setup(page, info, "video");
  const watch = watchDevelopment(page);
  const errors = await openRig(page, s.project.id);
  const body = await verifyCardFromShot(page);
  await expect(body.getByTestId("card-verify-take")).toContainText("video, three frames");
  await priceAndApprove(body, watch);
  const quoted = watch.posts.find((p) => p.quoteOnly) as { videoFrames?: { uploadId: string; timeSeconds: number }[] } | undefined;
  expect(quoted?.videoFrames).toHaveLength(3);
  const stored = await page.request.get(`/api/workbench/development?projectId=${s.project.id}&verifications=1`, { headers: s.headers }).then((r) => r.json()) as { verifications: TakeVerification[] };
  expect(stored.verifications[0].frames.map((f) => f.uploadId)).toEqual(quoted!.videoFrames!.map((f) => f.uploadId));
  expect(stored.verifications[0].framesKey).toBe("video:0.1,0.5,0.9");
  /* Each row's picture is the frame that shows it best. */
  const thumbs = await body.locator(".pxw-verify-thumb[src]").evaluateAll((els) => els.map((el) => (el as HTMLImageElement).getAttribute("src")));
  expect(thumbs.length).toBeGreaterThan(0);
  for (const src of thumbs) expect(src).toMatch(/^\/api\/workbench\/preview\/upload\//);
  await floors(page, info, body, "a video take's scorecard");
  expect(errors).toEqual([]);
});
