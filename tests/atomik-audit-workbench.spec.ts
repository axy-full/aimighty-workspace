import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * Audit fixes, 25 September, in the browser:
 * - Treatment: a save made against a stale copy merges instead of erasing
 *   what another session saved; the editor's own first scene and title are
 *   not taken for edits; leaving right after a save does not file the tab's
 *   own words as an earlier draft.
 * - Workspace › General: a member reads the rule library and is offered no
 *   control the routes would refuse (writes are admin-only).
 * - The Atomik rail: Change engine sends the engine alone, and a step whose
 *   render never arrived can be approved again from the same tab once the
 *   server has put it back.
 *
 * Suites › Atomik's Recipes and Models, and the rule editor itself, are
 * main's (#361, #357) and are covered by their own specs.
 */
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function treatmentFixture(page: Page, name: string) {
  await signInLocally(page.request);
  const made = await page.request.post("/api/projects", { data: { name } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const { id } = await made.json() as { id: string };
  await page.addInitScript((project) => { try { localStorage.setItem("aw_project", project); } catch { /* storage off */ } }, id);
  const read = async () => (await (await page.request.get(`/api/atomik/treatment?projectId=${encodeURIComponent(id)}`)).json()) as {
    treatment: { draft: number; title: string; logline: string; scenes: { title: string }[]; notes: { id: string }[]; updatedAt: number } | null; versions: unknown[];
  };
  return { id, read };
}

test("Treatment: a save against a stale copy merges with what another session saved", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, "the three-column treatment editor is a desktop surface");
  await signInLocally(page.request);
  const made = await page.request.post("/api/projects", { data: { name: "Merge film" } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const { id } = await made.json() as { id: string };
  const doc = { title: "Merge film", logline: "A kitchen.", setup: {}, scenes: [{ n: 1, title: "Kettle", secs: 5, prose: "The kettle." }], notes: [] };
  const first = await page.request.put("/api/atomik/treatment", { data: { projectId: id, ...doc, expectedUpdatedAt: null } });
  expect(first.ok(), await first.text()).toBeTruthy();
  const loaded = (await first.json()).treatment as { updatedAt: number };
  await page.addInitScript((project) => { try { localStorage.setItem("aw_project", project); } catch { /* storage off */ } }, id);
  await page.goto(await legacyShell(page, "/atomik/treatment"));
  const logline = page.getByRole("textbox", { name: "Logline" });
  await expect(logline).toHaveValue("A kitchen.", { timeout: 30_000 });

  // Another session saves a note and a new scene title in the meantime.
  const theirs = await page.request.put("/api/atomik/treatment", { data: { projectId: id, ...doc, scenes: [{ ...doc.scenes[0], title: "Kettle boils" }], notes: [{ id: "n_theirs", by: "Other", scene: 1, text: "Theirs.", at: 5 }], expectedUpdatedAt: loaded.updatedAt } });
  expect(theirs.ok(), await theirs.text()).toBeTruthy();
  // A stale save is refused outright over the API.
  expect((await page.request.put("/api/atomik/treatment", { data: { projectId: id, ...doc, expectedUpdatedAt: loaded.updatedAt } })).status()).toBe(409);

  await logline.fill("A kitchen at dawn.");
  await expect(page.getByRole("status").filter({ hasText: "Merged with another session" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Scene title" })).toHaveValue("Kettle boils");
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/atomik/treatment?projectId=${encodeURIComponent(id)}`)).json();
    return { logline: saved.treatment.logline, title: saved.treatment.scenes[0]?.title, notes: saved.treatment.notes.map((n: { id: string }) => n.id) };
  }).toEqual({ logline: "A kitchen at dawn.", title: "Kettle boils", notes: ["n_theirs"] });
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
});

test("Treatment: the first save on a new treatment takes the scenes another session wrote meanwhile, and files no draft", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, "the three-column treatment editor is a desktop surface");
  const { id, read } = await treatmentFixture(page, "Harbour film");
  await page.goto(await legacyShell(page, "/atomik/treatment"));
  const logline = page.getByRole("textbox", { name: "Logline" });
  await expect(logline).toHaveValue("", { timeout: 30_000 });
  // The editor opened on its own empty first scene and the production's name; another session writes the treatment first.
  const theirs = await page.request.put("/api/atomik/treatment", { data: { projectId: id, title: "Harbour film", logline: "", setup: {}, scenes: [{ n: 1, title: "Gulls", secs: 6, prose: "Gulls over the harbour." }], notes: [], expectedUpdatedAt: null } });
  expect(theirs.ok(), await theirs.text()).toBeTruthy();

  await logline.fill("A harbour at first light.");
  // Nothing on screen was theirs to lose: a plain merge, not a kept draft.
  await expect(page.getByRole("status").filter({ hasText: "Merged with another session" })).toHaveText("Merged with another session");
  await expect(page.getByRole("textbox", { name: "Scene title" })).toHaveValue("Gulls");
  await expect.poll(async () => {
    const saved = await read();
    return { logline: saved.treatment?.logline, scenes: saved.treatment?.scenes.map((s) => s.title), draft: saved.treatment?.draft, versions: saved.versions.length };
  }).toEqual({ logline: "A harbour at first light.", scenes: ["Gulls"], draft: 1, versions: 0 });
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
});

test("Treatment: leaving while a save is on its way does not file the tab's own words as an earlier draft", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, "the three-column treatment editor is a desktop surface");
  const { id, read } = await treatmentFixture(page, "Kettle film");
  const first = await page.request.put("/api/atomik/treatment", { data: { projectId: id, title: "Kettle film", logline: "A kitchen.", setup: {}, scenes: [{ n: 1, title: "Kettle", secs: 5, prose: "The kettle." }], notes: [], expectedUpdatedAt: null } });
  expect(first.ok(), await first.text()).toBeTruthy();
  /* The tab's autosave lands on the server at once, but its answer is held
     back: the page is left while it still thinks it holds the older version. */
  let landed = false;
  await page.route("**/api/atomik/treatment", async (route) => {
    if (route.request().method() !== "PUT" || landed) return route.fallback();
    const response = await route.fetch();
    landed = true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return route.fulfill({ response });
  });
  await page.goto(await legacyShell(page, "/atomik/treatment"));
  const logline = page.getByRole("textbox", { name: "Logline" });
  await expect(logline).toHaveValue("A kitchen.", { timeout: 30_000 });
  await logline.fill("A kitchen at dawn.");
  await expect.poll(() => landed).toBe(true);
  /* A few more words, then Break down saves and leaves in the same press, with
     the autosave's answer still on its way: the tab's two saves go one after
     the other, so neither is taken for another session's copy. */
  await logline.fill("A kitchen at dawn, the kettle on.");
  await page.getByRole("button", { name: "Break down into shots →" }).click();
  await expect(page).toHaveURL(/\/atomik\/breakdown/);
  await page.waitForTimeout(4500);
  const saved = await read();
  expect({ logline: saved.treatment?.logline, draft: saved.treatment?.draft, versions: saved.versions.length }).toEqual({ logline: "A kitchen at dawn, the kettle on.", draft: 1, versions: 0 });
});

test("Workspace › General: a member reads the rules and is offered no control the routes would refuse", async ({ page }) => {
  await signInLocally(page.request);
  const owner = await page.request.get("/api/me").then((response) => response.json()) as { id: string; workspace: { id: string } };
  const added = await page.request.post("/api/rules", { data: { text: "No logos in the first frame.", scope: "all", apply: "prompt" } });
  expect(added.ok(), await added.text()).toBeTruthy();
  // A second account joins the owner's workspace as a member.
  await signInLocally(page.request);
  const member = await page.request.get("/api/me").then((response) => response.json()) as { email: string };
  const code = randomBytes(18).toString("base64url");
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({
      sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [code, owner.workspace.id, member.email, "Rules member", "member", owner.id, Date.now(), Date.now() + 3_600_000],
    });
  } finally { platform.close(); }
  const accepted = await page.request.post("/api/auth/accept", { data: { code } });
  expect(accepted.ok(), await accepted.text()).toBe(true);
  expect((await page.request.get("/api/me").then((response) => response.json())).workspace.id).toBe(owner.workspace.id);
  // The routes refuse a member's writes…
  expect((await page.request.post("/api/rules", { data: { text: "Members cannot add this.", scope: "all", apply: "prompt" } })).status()).toBe(403);

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?view=workspace&tab=general");
  const card = page.getByTestId("ws-rules");
  // …so the card reads them and offers none.
  await expect(card.getByTestId("ws-rule")).toHaveCount(1);
  await expect(card.getByTestId("ws-rule")).toContainText("No logos in the first frame.");
  await expect(card.getByRole("textbox")).toHaveCount(0);
  await expect(card.getByRole("combobox")).toHaveCount(0);
  await expect(card.getByTestId("ws-rule-add")).toHaveCount(0);
  await expect(card.getByTestId("ws-rule-remove")).toHaveCount(0);
  await card.getByTestId("ws-rules-inherited").click();
  const switches = card.getByRole("switch");
  expect(await switches.count()).toBeGreaterThan(1);
  for (const control of await switches.all()) await expect(control).toBeDisabled();
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

/* ── The Atomik rail (the old app shell hosts it) ─────────────────────── */

const fingerprint = "c".repeat(64);
async function railFixture(page: Page) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const project: Project = { ...newProject("Atomik film"), id: "atomik-draft", productionProjectId: "actual-production" };
  const chat = { id: "ach_1", projectId: null, title: "Bottle spot", model: "auto", agentMode: "ask", status: "waiting", textCostUsd: 0.02, textCredits: 1, createdBy: me.id, createdAt: 1, updatedAt: 2 };
  const step: Record<string, unknown> = { id: "astp_1", chatId: "ach_1", messageId: "amsg_2", position: 0, kind: "video", title: "Push in", prompt: "A slow push in on a bottle.", model: "seedance-2.0",
    params: { ratio: "16:9", resolution: "1080p", seconds: 5 }, refs: [], status: "proposed", genId: null, error: null, createdAt: 3, estCostUsd: 0.9, estCredits: 14, billedCredits: null };
  const messages = [
    { id: "amsg_1", chatId: "ach_1", role: "user", text: "A bottle spot.", activity: [], ask: null, attachments: [], workedMs: null, costUsd: 0, model: "", createdAt: 1 },
    { id: "amsg_2", chatId: "ach_1", role: "assistant", text: "A push in.", activity: [], ask: null, attachments: [], workedMs: 1, costUsd: 0.02, model: "auto", createdAt: 2 },
  ];
  const state = { claims: 0, renders: 0, drop: true, patches: [] as unknown[], unexpected: [] as string[], errors: [] as string[] };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => (["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort("blockedbyclient")));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/me") return json(me);
    if (path === "/api/atomik")
      return json({ chats: [{ ...chat, needsApproval: step.status === "proposed" }], models: { featured: [], rest: [] },
        engines: [
          { id: "seedance-2.0", label: "Seedance 2.0", kind: "video", note: "", own: true, ratios: ["16:9"], resolutions: ["1080p"], durations: [5], supportsAudio: true },
          { id: "fal-ai/kling-video/v3/standard", label: "Kling 3.0 Standard", kind: "video", note: "", own: true, ratios: ["16:9"], resolutions: ["1080p"], durations: [5, 10, 15], supportsAudio: true },
        ] });
    if (path === "/api/atomik/ach_1") return json({ chat, messages, steps: [step] });
    if (path === "/api/generate/quote" && request.method() === "POST") return json({ estimatedCredits: 15, price: 15, unit: "cr", fingerprint });
    if (path === "/api/atomik/steps/astp_1/claim") {
      state.claims++;
      step.status = "running";
      return json({ step });
    }
    if (path === "/api/generate" && request.method() === "POST") {
      state.renders++;
      if (state.drop) {
        /* The render never reaches the server; the server later finds no
           request under the step's key and puts the step back (reconcileRunningSteps). */
        state.drop = false;
        step.status = "proposed";
        step.error = "The approval did not reach the renderer, so nothing was sent. Approve it again.";
        return route.abort("failed");
      }
      return json({ id: "gen_1", status: "queued" }, 202);
    }
    if (path === "/api/atomik/steps/astp_1" && request.method() === "PATCH") {
      const body = request.postDataJSON();
      state.patches.push(body);
      if (body.model) Object.assign(step, { model: body.model, params: { ratio: "16:9", resolution: "1080p", seconds: 5 } });
      if (body.status) Object.assign(step, { status: body.status, genId: body.genId ?? null, error: null });
      return json(step);
    }
    if (path.startsWith("/api/atomik/steps/")) { state.unexpected.push(`${request.method()} ${path}`); return json({ error: "Not this route." }, 409); }
    if (path === "/api/workbench/projects") return json({ project, projects: [{ id: project.id, name: project.name }], revision: 1, productions: [] });
    if (path === "/api/workbench/atomik") return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (request.method() !== "GET") { state.unexpected.push(`${request.method()} ${path}`); return json({ error: "No other mutation permitted." }, 409); }
    return json({});
  });
  return { state, step };
}
const railOf = (page: Page) =>
  page.viewportSize()!.width < 760
    ? page.getByRole("group", { name: "Checkpoint", exact: true })
    : page.getByRole("complementary", { name: "Atomik" }).or(page.getByLabel("Atomik", { exact: true })).filter({ visible: true }).first();

test("Atomik rail: Change engine sends the engine alone, for the server to re-fit and re-price", async ({ page }) => {
  const { state } = await railFixture(page);
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  const rail = railOf(page);
  await expect(rail.getByRole("button", { name: /^Continue/ }).first()).toBeEnabled();
  await rail.getByRole("button", { name: "Change engine" }).first().click();
  await page.getByRole("button", { name: "Kling 3.0 Standard", exact: true }).or(page.getByRole("menuitem", { name: "Kling 3.0 Standard", exact: true })).filter({ visible: true }).first().click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toEqual({ model: "fal-ai/kling-video/v3/standard" });
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Atomik rail: a step put back after its render never arrived can be approved again without a reload", async ({ page }) => {
  const { state } = await railFixture(page);
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  const cont = railOf(page).getByRole("button", { name: /^Continue/ }).first();
  await expect(cont).toBeEnabled();
  await cont.click();
  await expect.poll(() => state.renders).toBe(1);
  expect(state.claims).toBe(1);
  // The plan reads the step as proposed again; the same tab's Continue claims and renders it.
  await expect(cont).toBeEnabled();
  await cont.click();
  await expect.poll(() => state.renders).toBe(2);
  expect(state.claims).toBe(2);
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toEqual({ status: "done", genId: "gen_1" });
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Crew: a room opened on an engine the deployment has moved off offers the move, and is priced again there", async ({ page }) => {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const project = newProject("Crew engine film");
  expect((await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } })).ok()).toBe(true);
  expect((await page.request.get(`/api/crew/members?projectId=${project.id}`, { headers })).ok()).toBe(true);
  const created = await page.request.post("/api/crew/sessions", { headers, data: { projectId: project.id, goal: "Find the ending without a line of dialogue.", context: { brief: false, script: false, boards: false, cast: false, rig: false } } });
  expect(created.ok(), await created.text()).toBe(true);
  const session = (await created.json()).session as { id: string; model: string };
  const current = session.model;
  /* The room was opened on an engine this deployment has since moved off:
     its reads say so until the room is moved. */
  let moved = false;
  const patches: unknown[] = [];
  await page.route(`**/api/crew/sessions/${session.id}`, async (route) => {
    if (route.request().method() === "PATCH") { patches.push(route.request().postDataJSON()); moved = true; return route.fallback(); }
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: moved ? body : { ...body, session: { ...body.session, model: "grok-retired" } } });
  });
  await page.addInitScript(([key, id]) => { try { sessionStorage.setItem(key, id); } catch { /* storage off */ } }, [`particl-crew-room-${project.id}`, session.id]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?project=${project.id}&view=crew`);
  // The room is open once its roster is (a cold dev server compiles each route on first use).
  await expect(page.getByTestId("crew-roster").locator("[data-member]")).toHaveCount(5, { timeout: 60_000 });
  const panel = page.getByTestId("crew-panel");
  const move = panel.getByTestId("crew-engine-move");
  await expect(move).toHaveText(`Move to ${current}`, { timeout: 30_000 });
  await expect(panel).toContainText("grok-retired");
  // A thumb's target on a phone, in either orientation.
  if ((page.viewportSize()?.width ?? 0) < 900) expect(Math.round((await move.boundingBox())!.height * 100) / 100).toBeGreaterThanOrEqual(44);
  await move.click();
  await expect.poll(() => patches).toEqual([{ model: "current" }]);
  await expect(move).toHaveCount(0);
  await expect(panel).not.toContainText("grok-retired");
  await expect(panel).toContainText(current);
  await expect(page.getByTestId("crew-run")).toHaveText(/^Run round · \d+ cr$/);
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
