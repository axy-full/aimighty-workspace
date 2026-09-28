import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { newProject, type Project } from "../lib/workbench/studio";
import { DEFAULT_BOARDS } from "../lib/production/boards";
import { DEFAULT_ENVIRONMENT, newEnvironmentEntry } from "../lib/production/environment";

const at = "2026-09-27T00:00:00.000Z";
const fixture = (): Project => ({ ...newProject("Quoted stage actions"), id: `stage-${randomUUID()}`, productionProjectId: "prod-stage", production: {
  beats: { scriptSha256: "a".repeat(64), updatedAt: at, scenes: [{ id: "scene", heading: "EXT. HARBOUR", summary: "A quiet arrival", beats: [], characters: [], locations: [], props: [], shots: [
    { id: "shot", description: "A ferry arrives", framing: "Wide", movement: "Static", lighting: "Dawn", sound: "Wind" },
  ] }] },
  boards: { ...DEFAULT_BOARDS, frames: { shot: { prompt: "A ferry arrives", style: "bw-sketch", takes: [] } } },
  environment: { ...DEFAULT_ENVIRONMENT, entries: [newEnvironmentEntry("Harbour", "", "A quiet harbour", "harbour")] },
} });

async function fit(page: Page, action: Locator) {
  await action.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await action.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  if (page.viewportSize()!.width < 900) {
    const tabbar = await page.locator(".gx-tabbar").boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(Math.min(page.viewportSize()!.height, tabbar?.y ?? Infinity) + 1);
    expect(Math.round(box!.height * 100) / 100).toBeGreaterThanOrEqual(44);
    expect(Math.round(box!.width * 100) / 100).toBeGreaterThanOrEqual(44);
  }
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

test("frames quote automatically, reject a moved price, and submit only after the shown price is approved", async ({ page }) => {
  await signInLocally(page.request);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockMedia(page);
  let credits = 7;
  const posted: Record<string, unknown>[] = [];
  const quoted: Record<string, unknown>[] = [];
  await page.route(/\/api\/generate(\/quote)?$/, (route) => {
    const body = route.request().postDataJSON();
    if (route.request().url().endsWith("/quote")) {
      quoted.push(body);
      return route.fulfill({ json: { estimatedCredits: credits, fingerprint: "a".repeat(64) } });
    }
    posted.push(body);
    return route.fulfill({ json: { id: "gen_stage", status: "queued" } });
  });
  await page.route(/\/api\/jobs\/gen_stage$/, (route) => route.fulfill({ json: { generation: generation({ id: "gen_stage", status: "running" }) } }));
  await page.goto(`/suites?suite=studio&page=boards&project=${store.current.id}`);
  const frame = page.getByTestId("board-frame").first();
  const action = frame.getByTestId("frame-render");
  await expect(action).toHaveText("Render frame · 7 credits");
  expect(quoted[0].prompt).toContain("black-and-white pencil sketch");
  expect(posted).toHaveLength(0);
  await fit(page, action);
  await page.addStyleTag({ content: '.pd-stage button { font-family: Verdana, sans-serif !important; }' });
  await fit(page, action);
  credits = 9;
  await action.click();
  await expect(action).toHaveText("Render frame · 9 credits");
  expect(posted).toHaveLength(0);
  await action.click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toMatchObject({ maxCredits: 9, quoteFingerprint: "a".repeat(64) });
  await expect.poll(() => store.current.production!.boards!.frames.shot.pending?.length).toBe(1);
  expect(store.current.production!.boards!.frames.shot.pending![0].style).toBe("bw-sketch");
});

test("a sent frame keeps its action closed until its job lands or fails, so another tap buys nothing", async ({ page }) => {
  await signInLocally(page.request);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockMedia(page);
  const posted: Record<string, unknown>[] = [];
  let status: "running" | "failed" | "succeeded" = "running";
  await page.route(/\/api\/generate(\/quote)?$/, (route) => {
    if (route.request().url().endsWith("/quote")) return route.fulfill({ json: { estimatedCredits: 7, fingerprint: "a".repeat(64) } });
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: `gen_once_${posted.length}`, status: "queued" } });
  });
  await page.route(/\/api\/jobs\/gen_once_\d+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    return route.fulfill({ json: { generation: generation({ id, status, ...(status === "failed" ? { error: "The engine turned this frame down." } : {}) }) } });
  });
  await page.goto(`/suites?suite=studio&page=boards&project=${store.current.id}`);
  const frame = page.getByTestId("board-frame").first();
  const action = frame.getByTestId("frame-render");
  await expect(action).toHaveText("Render frame · 7 credits");
  await action.click();
  await expect.poll(() => posted.length).toBe(1);
  /* In flight: closed however it is pressed, and nothing more is sent. */
  await expect(action).toHaveText("Rendering…");
  await expect(action).toBeDisabled();
  await fit(page, action);
  await action.click({ force: true });
  await action.dispatchEvent("click");
  await page.waitForTimeout(800);
  expect(posted).toHaveLength(1);
  /* The job fails: the action opens again at its price, and says why. */
  status = "failed";
  await expect(action).toHaveText("Render frame · 7 credits");
  await expect(action).toBeEnabled();
  await expect(frame.getByTestId("frame-error")).toHaveText("The engine turned this frame down.");
  /* Sent again: what the failed job said is cleared, and the action is closed until this job lands. */
  status = "running";
  await action.click();
  await expect.poll(() => posted.length).toBe(2);
  await expect(frame.getByTestId("frame-error")).toHaveCount(0);
  await expect(action).toBeDisabled();
  status = "succeeded";
  await expect(action).toHaveText("Render frame · 7 credits");
  await expect(action).toBeEnabled();
  await expect.poll(() => store.current.production!.boards!.frames.shot.takes.map((take) => take.genId)).toEqual(["gen_once_2"]);
  expect(posted.map((body) => body.maxCredits)).toEqual([7, 7]);
});

test("a frame whose price cannot be read says why, offers Try again and sends nothing", async ({ page }) => {
  await signInLocally(page.request);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockMedia(page);
  let failQuote = true, submitted = 0;
  await page.route(/\/api\/generate(\/quote)?$/, (route) => {
    if (!route.request().url().endsWith("/quote")) { submitted++; return route.fulfill({ json: { id: "gen_never", status: "queued" } }); }
    if (failQuote) return route.fulfill({ status: 503, json: { error: "The price is unavailable. Try again." } });
    return route.fulfill({ json: { estimatedCredits: 5, fingerprint: "a".repeat(64) } });
  });
  await page.goto(`/suites?suite=studio&page=boards&project=${store.current.id}`);
  const frame = page.getByTestId("board-frame").first();
  const action = frame.getByTestId("frame-render");
  await expect(frame.getByTestId("frame-error")).toHaveText("The price is unavailable. Try again.");
  await expect(action).toHaveText("Price unavailable");
  await expect(action).toBeDisabled();
  await expect(page.getByTestId("boards-render-all")).toHaveText("Price unavailable");
  await expect(page.getByTestId("boards-render-all-retry")).toBeVisible();
  const retry = frame.getByRole("button", { name: "Try again", exact: true });
  await fit(page, retry);
  failQuote = false;
  await retry.click();
  await expect(action).toHaveText("Render frame · 5 credits");
  await expect(page.getByTestId("boards-render-all")).toHaveText("Render 1 frames · 5 credits");
  await expect(frame.getByTestId("frame-error")).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(page.getByTestId("boards-render-all-retry")).toHaveCount(0);
  expect(submitted).toBe(0);
});

test("picked frames are sent once at their shown total and leave the selection", async ({ page }) => {
  await signInLocally(page.request);
  const project = fixture();
  project.production!.beats!.scenes[0].shots.push({ id: "shot-2", description: "The keeper waits", framing: "Close", movement: "Static", lighting: "Dawn", sound: "Gulls" });
  project.production!.boards!.frames["shot-2"] = { prompt: "The keeper waits on the quay", style: "bw-sketch", takes: [] };
  const store = { current: project };
  await mockProjects(page, store);
  await mockMedia(page);
  const posted: Record<string, unknown>[] = [];
  let failKeeper = true;
  await page.route(/\/api\/generate(\/quote)?$/, (route) => {
    if (route.request().url().endsWith("/quote")) {
      if (failKeeper && String(route.request().postDataJSON().prompt).includes("The keeper waits")) return route.fulfill({ status: 503, json: { error: "The price is unavailable. Try again." } });
      return route.fulfill({ json: { estimatedCredits: 4, fingerprint: "a".repeat(64) } });
    }
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: `gen_batch_${posted.length}`, status: "queued" } });
  });
  await page.route(/\/api\/jobs\/gen_batch_\d+$/, (route) => route.fulfill({ json: { generation: generation({ id: new URL(route.request().url()).pathname.split("/").at(-1)!, status: "running" }) } }));
  await page.goto(`/suites?suite=studio&page=boards&project=${project.id}`);
  await page.getByTestId("boards-select-all").click();
  const action = page.getByTestId("boards-render-selected");
  /* One picked frame's price could not be read: the batch says so and reads just that frame again. */
  await expect(action).toHaveText("Price unavailable");
  await expect(action).toBeDisabled();
  const retry = page.getByTestId("boards-render-selected-retry");
  await fit(page, retry);
  failKeeper = false;
  await retry.click();
  await expect(action).toHaveText("Storyboard 2 frames · 8 credits");
  await expect(retry).toHaveCount(0);
  expect(posted).toHaveLength(0);
  await fit(page, action);
  await action.click();
  /* What was sent leaves the selection: the same priced batch is not offered a second time. */
  await expect(page.getByTestId("boards-selection")).toContainText("Select frames to storyboard together");
  expect(posted.map((body) => body.maxCredits)).toEqual([4, 4]);
  await expect(action).toBeDisabled();
  await expect.poll(() => [store.current.production!.boards!.frames.shot.pending?.length, store.current.production!.boards!.frames["shot-2"].pending?.length]).toEqual([1, 1]);
});

test("a changed plate discards the old quote, reads again on request failure, and never submits automatically", async ({ page }) => {
  await signInLocally(page.request);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [] });
  let submitted = 0, failQuote = false;
  let releaseOld: (() => void) | undefined;
  let oldStarted = false;
  await page.route(/\/api\/generate(\/quote)?$/, async (route) => {
    if (!route.request().url().endsWith("/quote")) { submitted++; return route.fulfill({ json: { id: "gen_plate" } }); }
    const body = route.request().postDataJSON();
    if (String(body.prompt).startsWith("Old composition")) {
      oldStarted = true;
      await new Promise<void>((resolve) => { releaseOld = resolve; });
      return route.fulfill({ json: { estimatedCredits: 99, fingerprint: "a".repeat(64) } }).catch(() => undefined);
    }
    if (failQuote) return route.fulfill({ status: 503, json: { error: "The price is unavailable. Try again." } });
    return route.fulfill({ json: { estimatedCredits: 4, fingerprint: "a".repeat(64) } });
  });
  await page.goto(`/suites?suite=studio&page=boards&sp=environment&project=${store.current.id}`);
  const place = page.getByTestId("environment-entry").first();
  const action = place.getByTestId("environment-render");
  await expect(action).toHaveText("Render a plate · 4 credits");
  await place.getByTestId("environment-prompt").fill("Old composition");
  await expect.poll(() => oldStarted).toBe(true);
  await expect(action).toBeDisabled();
  await place.getByTestId("environment-prompt").fill("Final composition");
  await expect(action).toHaveText("Render a plate · 4 credits");
  releaseOld!();
  failQuote = true;
  await place.getByTestId("environment-prompt").fill("Final composition at dawn");
  await expect(place.getByRole("alert")).toHaveText("The price is unavailable. Try again.");
  await expect(action).toBeDisabled();
  failQuote = false;
  await place.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(action).toHaveText("Render a plate · 4 credits");
  await fit(page, action);
  expect(submitted).toBe(0);
});

test("the server retains more than five pending renders and the stages resume every saved job", async ({ page }) => {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const project = fixture();
  delete project.productionProjectId;
  const frames = Array.from({ length: 7 }, (_, i) => ({ jobId: `gen_frame_${i}`, at, style: "bw-sketch" as const }));
  const plates = Array.from({ length: 7 }, (_, i) => ({ jobId: `gen_plate_${i}`, at }));
  project.production!.boards!.frames.shot.pending = frames;
  project.production!.environment!.entries[0].pending = plates;
  const response = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(response.ok(), await response.text()).toBe(true);
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as Project;
  expect((await read()).production!.boards!.frames.shot.pending).toEqual(frames);
  expect((await read()).production!.environment!.entries[0].pending).toEqual(plates);
  const seen = new Set<string>();
  await page.route(/\/api\/jobs\/gen_(frame|plate)_\d+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    seen.add(id);
    return route.fulfill({ json: { generation: generation({ id, status: "running" }) } });
  });
  await page.route("**/api/generate/quote", (route) => route.fulfill({ json: { estimatedCredits: 2, fingerprint: "a".repeat(64) } }));
  let submitted = 0;
  await page.route("**/api/generate", (route) => { submitted++; return route.fulfill({ json: { id: "gen_frame_7", status: "queued" } }); });
  await page.goto(`/suites?suite=studio&page=boards&project=${project.id}`);
  await expect.poll(() => frames.every((job) => seen.has(job.jobId))).toBe(true);
  /* Renders in flight keep the frame's own action closed; another take is asked for deliberately, by picking the frame. */
  await expect(page.getByTestId("frame-render")).toHaveText("Rendering…");
  await expect(page.getByTestId("frame-render")).toBeDisabled();
  await page.getByTestId("frame-select").check();
  await expect(page.getByTestId("boards-render-selected")).toHaveText("Storyboard 1 frames · 2 credits");
  expect(submitted).toBe(0);
  await page.getByTestId("boards-render-selected").click();
  await expect.poll(async () => (await read()).production!.boards!.frames.shot.pending?.length).toBe(8);
  expect(submitted).toBe(1);
  await page.goto(`/suites?suite=studio&page=boards&sp=environment&project=${project.id}`);
  await expect.poll(() => plates.every((job) => seen.has(job.jobId))).toBe(true);
  await expect(page.getByRole("button", { name: "Remove Harbour", exact: true })).toBeDisabled();
  expect((await read()).production!.boards!.frames.shot.pending!.map((job) => job.jobId)).toEqual([...frames.map((job) => job.jobId), "gen_frame_7"]);
  expect((await read()).production!.environment!.entries[0].pending).toEqual(plates);
});

test("transcription reads its quote on selection and waits for the priced action", async ({ page }) => {
  await signInLocally(page.request);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_dialogue", title: "Dialogue source", prompt: "Dialogue source", kind: "audio", projectId: "prod-stage" })] });
  const quoted: Record<string, unknown>[] = [];
  const posted: Record<string, unknown>[] = [];
  await page.route("**/api/audio/transcribe", (route) => {
    const body = route.request().postDataJSON();
    if (body.quoteOnly === true) {
      quoted.push(body);
      return route.fulfill({ json: { estimatedCredits: 3 } });
    }
    posted.push(body);
    return route.fulfill({ json: { text: "The ferry is here.", language: "en", seconds: 5, words: [], srt: "", credits: 3 } });
  });
  await page.goto(`/suites?suite=studio&page=takes&project=${store.current.id}`);
  await page.getByTestId("edit-takes").getByText("Dialogue source", { exact: true }).click();
  const action = page.getByTestId("transcribe-run");
  await expect(action).toHaveText("Transcribe · about 3 credits");
  expect(quoted).toHaveLength(1);
  expect(quoted[0]).toMatchObject({ sourceGenId: "gen_dialogue", quoteOnly: true });
  expect(posted).toHaveLength(0);
  await fit(page, action);
  await action.click();
  await expect(page.getByTestId("transcript")).toContainText("The ferry is here.");
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ sourceGenId: "gen_dialogue", maxCredits: 3 });
  expect(posted[0]).not.toHaveProperty("quoteOnly");
});

test("a transcript whose price cannot be read says so, offers Try again and sends nothing", async ({ page }) => {
  await signInLocally(page.request);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_dialogue", title: "Dialogue source", prompt: "Dialogue source", kind: "audio", projectId: "prod-stage" })] });
  let failQuote = true, posted = 0;
  await page.route("**/api/audio/transcribe", (route) => {
    const body = route.request().postDataJSON();
    if (body.quoteOnly !== true) { posted++; return route.fulfill({ status: 500, json: { error: "Nothing paid is sent in this test." } }); }
    if (failQuote) return route.fulfill({ status: 503, json: { error: "The price is unavailable. Try again." } });
    return route.fulfill({ json: { estimatedCredits: 3 } });
  });
  await page.goto(`/suites?suite=studio&page=takes&project=${store.current.id}`);
  await page.getByTestId("edit-takes").getByText("Dialogue source", { exact: true }).click();
  const panel = page.getByTestId("transcribe");
  const action = panel.getByTestId("transcribe-run");
  await expect(panel.getByRole("alert")).toHaveText("The price is unavailable. Try again.");
  await expect(action).toHaveText("Price unavailable");
  await expect(action).toBeDisabled();
  const retry = panel.getByRole("button", { name: "Try again", exact: true });
  await fit(page, retry);
  failQuote = false;
  await retry.click();
  await expect(action).toHaveText("Transcribe · about 3 credits");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(posted).toBe(0);
});

test("a still re-edit quotes its current source and instruction without an extra price action", async ({ page }) => {
  await signInLocally(page.request);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockMedia(page);
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_still", title: "Window still", prompt: "Window still", projectId: "prod-stage" })] });
  const posted: Record<string, unknown>[] = [];
  const quoted: Record<string, unknown>[] = [];
  await page.route(/\/api\/generate(\/quote)?$/, (route) => {
    const body = route.request().postDataJSON();
    if (route.request().url().endsWith("/quote")) {
      quoted.push(body);
      return route.fulfill({ json: { estimatedCredits: 6, fingerprint: "a".repeat(64) } });
    }
    posted.push(body);
    return route.fulfill({ json: { id: "gen_reedit", status: "queued" } });
  });
  await page.route(/\/api\/jobs\/gen_reedit$/, (route) => route.fulfill({ json: { generation: generation({ id: "gen_reedit", status: "running" }) } }));
  await page.goto(`/suites?suite=studio&page=takes&project=${store.current.id}`);
  await page.getByTestId("edit-takes").getByText("Window still", { exact: true }).click();
  const action = page.getByTestId("edit-render");
  await expect(action).toBeDisabled();
  expect(quoted).toHaveLength(0);
  await page.getByTestId("edit-instruction").fill("Rain on the window, preserve the camera position");
  await expect(action).toHaveText("Re-edit · 6 credits");
  expect(quoted.at(-1)).toMatchObject({ references: [{ genId: "gen_still", role: "reference_image" }] });
  expect(String(quoted.at(-1)!.prompt)).toContain("Rain on the window");
  expect(posted).toHaveLength(0);
  await fit(page, action);
  await action.click();
  await expect(action).toHaveText("Rendering…");
  await expect(action).toBeDisabled();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ maxCredits: 6, references: [{ genId: "gen_still", role: "reference_image" }] });
});
