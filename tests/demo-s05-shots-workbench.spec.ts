import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject, type CanvasNode } from "../lib/workbench/studio";

/*
 * Stream 5 · the board's Shots region and review mode (design/particl-graphite/README.md § 3.1 f, g, l; § 6),
 * behind the new-interface switch. A production with three shot cards opens as a board; its takes come from the
 * project library (mocked in the browser: no engine, no stored generation). Approving and rejecting go through the
 * review trail (PATCH /api/jobs/:id) and a take note (POST /api/notes), both answered in the browser too, and the
 * spec holds that nothing paid is ever sent. Neutral names only.
 */
const SHOTS = process.env.S05_SHOTS || join(tmpdir(), "claude-s05-shots");
const PNG = readFileSync("public/icon-192.png");

const node = (id: string, title: string, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title, type: "scene", x: 0, y: 0, width: 344, linked: [], ...extra });

type Gen = Record<string, unknown> & { id: string };
const take = (id: string, shotId: string, version: number, over: Record<string, unknown> = {}): Gen => ({
  id, projectId: null, projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
  approvedBy: null, approvedAt: null, model: "gemini-3-pro-image", prompt: `Frame for ${id}`, title: `Take ${id}`, params: { resolution: "1K" },
  status: "succeeded", sourceUrl: null, storedUrl: `/api/media/${id}`, totalTokens: null, costUsd: null, creditsBilled: 3, refineCostUsd: null,
  refineModel: null, refineInTokens: null, refineOutTokens: null, error: null, failure: null, createdBy: "someone", authorName: "Tester",
  shotId, shotCode: null, shotScene: null, shotTitle: null, version, durationMs: 20_000, durationS: null, provider: "google", attempts: 1,
  task: "generate", sourceGenId: null, createdAt: Date.now() - 600_000 + version * 1000, updatedAt: Date.now() - 600_000 + version * 1000, ...over,
});

async function seed(page: Page) {
  const workspaceId = (await signInWithNewInterface(page.request, "Shots Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = {
    ...newProject("Shots fixture"),
    brief: "A short film about a morning market opening.",
    nodes: [node("node-shot0001", "Opening wide"), node("node-shot0002", "The first stall"), node("node-shot0003", "Close on hands")],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  /* The shots' production ids, through the existing (free) mapping action. */
  const shotIds: string[] = [];
  for (const n of project.nodes) {
    const mapped = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok(), await mapped.text()).toBe(true);
    shotIds.push(((await mapped.json()) as { shotId: string }).shotId);
  }
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });

  /* Shot 1: v1 approved, v2 waits (frame g). Shot 2: rejected. Shot 3: rendering, no history to estimate from. */
  const generations: Gen[] = [
    take("tk-s1-v1", shotIds[0], 1, { reviewState: "approved", approvedBy: "Tester", approvedAt: Date.now() - 500_000 }),
    take("tk-s1-v2", shotIds[0], 2),
    take("tk-s2-v1", shotIds[1], 1, { reviewState: "changes", reviewBy: "Tester" }),
    /* A video on an engine this workspace has no finished takes of: no history, so no estimate. */
    take("tk-s3-v1", shotIds[2], 1, { kind: "video", model: "dreamina-seedance-2-5-260628", params: { duration: 5, resolution: "1080p" }, status: "running", storedUrl: null, durationMs: null, createdAt: Date.now() - 5_000 }),
  ];
  const reviews: { id: string; state: string }[] = [];
  const notes: { genId: string; text: string }[] = [];
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || (path.startsWith("/api/generate/") && path !== "/api/generate/quote") || /\/release$/.test(path))) paid.push(path);
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/workbench/library?**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("source");
    if (route.request().method() !== "GET") return route.continue();
    return json(route, source === "generations" ? { generations, nextPageCursor: null } : { uploads: [], nextCursor: null });
  });
  await page.route(/\/api\/media\/tk-/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.route(/\/api\/jobs\/tk-[^/?]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { reviewState: string };
    reviews.push({ id, state: body.reviewState });
    const g = generations.find((x) => x.id === id);
    if (g) g.reviewState = body.reviewState;
    return json(route, { ok: true, review: { reviewState: body.reviewState, reviewBy: body.reviewState ? "Tester" : null, updatedAt: Date.now() } });
  });
  await page.route("**/api/notes**", (route) => {
    if (route.request().method() === "POST") {
      notes.push(route.request().postDataJSON() as { genId: string; text: string });
      return json(route, { ok: true, mentioned: [] });
    }
    const genId = new URL(route.request().url()).searchParams.get("genId");
    return json(route, { notes: notes.filter((n) => n.genId === genId).map((n, i) => ({ id: `n${i}`, text: n.text, author: "Tester", userId: me.id, createdAt: Date.now(), guest: false, mentions: [] })) });
  });
  return { project, reviews, notes, paid, generations, shotIds };
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const shot = (page: Page, name: string) => page.locator(`[data-card-id="${name}"]`);

test("shots render in place, the take that waits is frame g, and judging spends nothing", async ({ page }, info) => {
  test.skip(!desktop(page), "phone widths open the project's Record (stream 10); the canvas is desktop only");
  const { project, reviews, notes, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();

  /* Frame f: the Shots group's header from the takes; each shot card draws its node. */
  const group = shot(page, "group:shots");
  await expect(group.getByTestId("board-group")).toContainText("Shots · rendering 3 of 3");
  for (const id of ["node-shot0001", "node-shot0002", "node-shot0003"]) await expect(shot(page, id).getByTestId("take-card")).toHaveCount(1);
  await expect(shot(page, "node-shot0001").getByTestId("take-card")).toContainText("Shot 1 · Opening wide");
  /* No history for the engine: the bar is indeterminate and nothing is estimated. */
  await expect(shot(page, "node-shot0003").getByTestId("take-progress")).toHaveAttribute("data-indeterminate", "");
  await expect(shot(page, "node-shot0003").getByTestId("take-estimate")).toHaveCount(0);
  /* A rejected take is dimmed and kept. */
  await expect(shot(page, "node-shot0002").getByTestId("take-rejected")).toHaveText("Rejected · nothing more spent");
  /* No Board run works on them: no Stop. */
  await expect(page.getByTestId("shots-stop")).toHaveCount(0);

  /* Frame g: the earliest shot whose take waits, with its versions. */
  await expect(shot(page, "group:review").getByTestId("board-group")).toContainText("Shot 1 · review");
  await expect(shot(page, "group:review").getByTestId("board-group")).toContainText("v2 · needs you");
  const review = page.getByTestId("take-review");
  await expect(review).toContainText("Shot 1 · Opening wide · v2");
  await expect(review.getByTestId("take-version")).toHaveText(["v1 · approved", "v2"]);
  await expect(page.getByTestId("take-versions")).toContainText("v1 approved · Tester");

  mkdirSync(SHOTS, { recursive: true });
  const size = info.project.name.replace("workbench-", "");
  await page.locator('[data-card-id="group:shots"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/shots-${size}.png` });

  /* Cards are draggable: every control inside one opts out of the drag and the pan, or a press starts a drag. */
  expect(await page.evaluate(() => [...document.querySelectorAll('[data-testid="take-card"] button, [data-testid="take-card"] input, [data-testid="take-review"] button, [data-testid="take-review"] input, [data-testid="board-group"] button')].filter((el) => !el.closest(".nodrag")).length)).toBe(0);

  /* Approve v2: one approved version per take, so v1's approval is cleared in the same action. */
  await review.getByTestId("take-approve").click();
  await expect.poll(() => reviews).toEqual([{ id: "tk-s1-v2", state: "approved" }, { id: "tk-s1-v1", state: "" }]);
  await expect(page.getByTestId("toast")).toContainText("Shot 1 v2 approved");

  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
  expect(notes).toEqual([]);
});

test("review mode: J and K step, R rejects with a reason as a note, C compares, Esc closes", async ({ page }, info) => {
  test.skip(!desktop(page), "phone widths open the project's Record (stream 10); the canvas is desktop only");
  const { project, reviews, notes, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("take-review")).toBeVisible();

  /* Double-click the shot card: review mode opens on its take. */
  await shot(page, "node-shot0001").getByTestId("take-card").dblclick();
  const mode = page.getByTestId("review-mode");
  await expect(mode).toBeVisible();
  await expect(mode.getByTestId("review-position")).toHaveText("take 1 of 2 · v2");
  await expect(mode).toContainText("Shot 1 · Opening wide");

  /* C cycles the compare views; v2 is compared with v1, the approved one. */
  await page.keyboard.press("c");
  await expect(mode.getByTestId("review-compare-side")).toHaveAttribute("aria-checked", "true");
  await expect(mode.locator(".gx-review-label")).toHaveText(["v1", "v2"]);
  const size = info.project.name.replace("workbench-", "");
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/review-side-${size}.png` });
  await page.keyboard.press("c");
  await expect(mode.getByTestId("review-slider")).toBeVisible();
  await page.keyboard.press("c");
  await expect(mode.getByTestId("review-compare-single")).toHaveAttribute("aria-checked", "true");

  /* K: the next take (shot 3 is still rendering, so it is not in the queue); J back. */
  await page.keyboard.press("k");
  await expect(mode.getByTestId("review-position")).toHaveText("take 2 of 2 · v1");
  await page.keyboard.press("j");
  await expect(mode.getByTestId("review-position")).toHaveText("take 1 of 2 · v2");
  await page.screenshot({ path: `${SHOTS}/review-${size}.png` });

  /* R asks for the reason; Enter rejects: the "changes" mark, and the reason as a note on that take. */
  await page.keyboard.press("r");
  const reason = mode.getByTestId("review-reason");
  await expect(reason).toBeFocused();
  /* Enter on an empty line rejects nothing: the hint says why. */
  await reason.press("Enter");
  await expect(mode.getByTestId("review-reason-hint")).toHaveText("Say why you are rejecting it.");
  expect(reviews).toEqual([]);
  await reason.fill("The light is too flat");
  await reason.press("Enter");
  await expect.poll(() => reviews).toEqual([{ id: "tk-s1-v2", state: "changes" }]);
  await expect.poll(() => notes).toEqual([{ genId: "tk-s1-v2", text: "The light is too flat" }]);
  await expect(page.getByTestId("toast")).toContainText("Shot 1 · v2 rejected");
  await expect(mode.getByTestId("review-reject")).toHaveText("Rejected");

  /* Esc closes; nothing paid was sent. */
  await page.keyboard.press("Escape");
  await expect(mode).toHaveCount(0);
  expect(paid).toEqual([]);
});

test("at phone widths the board is not drawn: no shot cards, no review mode, nothing overflows", async ({ page }, info) => {
  test.skip(desktop(page), "desktop widths are the two tests above");
  const { project, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("take-card")).toHaveCount(0);
  await expect(page.getByTestId("review-mode")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/phone-${info.project.name.replace("workbench-", "")}.png` });
});

test("the Inspector opens on a selected take: price paid, prompt, versions, the actions, history, Advanced; Esc closes", async ({ page }, info) => {
  test.skip(!desktop(page), "phone widths open the project's Record (stream 10); the canvas is desktop only");
  const { project, reviews, notes, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("take-review")).toBeVisible();

  await shot(page, "node-shot0001").getByTestId("take-card").click();
  const insp = page.getByTestId("board-inspector");
  await expect(insp).toBeVisible();
  await expect(insp).toContainText("Shot 1 · Opening wide · v2");
  await expect(insp.getByTestId("insp-engine")).toHaveText("Nano Banana Pro · 1K · 3 cr paid");
  await expect(insp.getByTestId("insp-version")).toHaveText(["v1 · approved", "v2"]);
  await expect(insp.getByTestId("insp-download")).toHaveAttribute("href", "/api/media/tk-s1-v2?download=1");
  /* "Select & edit a region" is not offered: no engine edits a region of a clip. */
  await expect(insp.getByText("Select & edit a region")).toHaveCount(0);
  await insp.getByTestId("insp-advanced").click();
  await expect(insp.locator(".gx-insp-rows")).toContainText("Resolution");
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/inspector-${info.project.name.replace("workbench-", "")}.png` });

  /* Reject needs a reason: an empty line says so and writes nothing. */
  await insp.getByTestId("insp-reject").click();
  await insp.getByTestId("insp-reason").press("Enter");
  await expect(insp.getByTestId("insp-reason-hint")).toHaveText("Say why you are rejecting it.");
  expect(reviews).toEqual([]);
  await insp.getByTestId("insp-reason").fill("Too dark on the left");
  await insp.getByTestId("insp-reject-confirm").click();
  await expect.poll(() => reviews).toEqual([{ id: "tk-s1-v2", state: "changes" }]);
  await expect.poll(() => notes).toEqual([{ genId: "tk-s1-v2", text: "Too dark on the left" }]);
  await expect(insp.getByTestId("insp-reject")).toHaveText("Rejected");

  /* Use as reference hands the take to Make; nothing is made. */
  await insp.getByTestId("insp-use-ref").click();
  await expect(page.getByTestId("toast")).toContainText("added as Image");

  await page.keyboard.press("Escape");
  await expect(insp).toHaveCount(0);
  expect(paid).toEqual([]);
});

test("Change with words on a clip carries the free quote's price, and opening it sends nothing paid", async ({ page }) => {
  test.skip(!desktop(page), "phone widths open the project's Record (stream 10); the canvas is desktop only");
  const { project, paid, generations, shotIds } = await seed(page);
  /* Shot 2 gets a finished clip (v2) that waits for review. */
  generations.push(take("tk-s2-v2", shotIds[1], 2, { kind: "video", model: "dreamina-seedance-2-5-260628", params: { duration: 5, resolution: "1080p" }, storedUrl: "/api/media/tk-s2-v2" }));
  const asked: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => {
    asked.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ estimatedCredits: 12, price: 12, unit: "cr", fingerprint: "a".repeat(64) }) });
  });
  await page.goto(`/suites?project=${project.id}&view=board`);
  await shot(page, "node-shot0002").getByTestId("take-card").click();
  const insp = page.getByTestId("board-inspector");
  await expect(insp).toContainText("Shot 2");
  await expect(insp.getByTestId("insp-change-price")).toHaveText("up to 12 cr");
  /* Other quotes (the shot's own still, Make's) reach the route too: the edit quote is the one that asked for an edit. */
  await expect.poll(() => asked.find((q) => q.task === "edit")).toMatchObject({ task: "edit", sourceGenId: "tk-s2-v2", model: "dreamina-seedance-2-5-260628" });
  await insp.getByTestId("insp-change-words").click();
  await expect(insp.getByTestId("insp-change")).toBeVisible();
  expect(paid).toEqual([]);
});
