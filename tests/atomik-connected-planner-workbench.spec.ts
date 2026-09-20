import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { legacyShell } from "./helpers/legacyShell";

/**
 * Atomik proposes a step on the connected account (A2): the rail and the
 * phone sheet show its live quote in connected credits (never Particl credits,
 * never the provider's name), offer no engine swap, and Continue sends exactly
 * the quoted credits and wallet to the connected route — once.
 */
const wallet = "22222222-2222-4222-8222-222222222222";
const jobId = "11111111-1111-4111-8111-000000000001";
const meta = {
  model: "kling3_0", type: "video", modelName: "Kling 3.0", jobId, draftId: "atomik-draft", credits: 42, workspaceId: wallet, workspaceName: "Studio wallet",
  quoteExpiresAt: Date.now() + 300_000, input: { type: "video", model: "kling3_0", prompt: "A slow push in on a bottle.", parameters: { duration: 5 }, medias: [] },
};
async function fixture(page: Page, options: { batch?: boolean } = {}) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const project: Project = { ...newProject("Atomik film"), id: "atomik-draft", productionProjectId: "actual-production" };
  const chat = { id: "ach_1", projectId: null, title: "Bottle spot", model: "auto", agentMode: "ask", status: "waiting", textCostUsd: 0.2, createdBy: me.id, createdAt: 1, updatedAt: 2 };
  const batch = options.batch ? { batch: { id: "abat_1", size: 2 } } : {};
  const step = { id: "astp_1", chatId: "ach_1", messageId: "amsg_2", position: 0, kind: "video", title: "Push in", prompt: "A slow push in on a bottle.", model: "connected:kling3_0",
    params: { connected: { ...meta, ...batch } }, refs: [], status: "proposed", genId: null, estCostUsd: null, error: null, createdAt: 3 };
  const second = { ...step, id: "astp_2", position: 1, title: "Pull out", prompt: "A slow pull out.", params: { connected: { ...meta, jobId: "11111111-1111-4111-8111-000000000002", ...batch } } };
  const steps = options.batch ? [step, second] : [step];
  const messages = [
    { id: "amsg_1", chatId: "ach_1", role: "user", text: "A bottle spot.", activity: [], ask: null, attachments: [], workedMs: null, costUsd: 0, model: "", createdAt: 1 },
    { id: "amsg_2", chatId: "ach_1", role: "assistant", text: "One push in on the connected account.", activity: [], ask: null, attachments: [], workedMs: 1, costUsd: 0.2, model: "auto", createdAt: 2 },
  ];
  const approvals: unknown[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => (["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort("blockedbyclient")));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/me") return json(me);
    if (path === "/api/atomik")
      return json({ chats: [{ ...chat, needsApproval: step.status === "proposed" }], models: { featured: [], rest: [] },
        engines: [{ id: "connected:kling3_0", label: "Kling 3.0", kind: "video", note: "connected credits", own: false, connected: true, ratios: [], resolutions: [], durations: [], supportsAudio: false }] });
    if (path === "/api/atomik/ach_1") return json({ chat, messages, steps });
    if (path === "/api/atomik/steps/astp_1/connected") {
      const body = request.postDataJSON();
      if (body.action === "approve" || body.action === "approve-batch") {
        approvals.push(body);
        for (const s of steps) s.status = "running";
        return json({ step, job: { id: jobId, status: "accepted" } });
      }
      return json({ step, job: { id: jobId, status: "accepted" }, pollAfterSeconds: 15 });
    }
    if (path.startsWith("/api/atomik/steps/")) { unexpected.push(`${request.method()} ${path}`); return json({ error: "Not this route." }, 409); }
    if (path === "/api/workbench/projects") return json({ project, projects: [{ id: project.id, name: project.name }], revision: 1, productions: [] });
    if (path === "/api/workbench/atomik") return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return json({ error: "No other mutation permitted." }, 409); }
    return json({});
  });
  return { approvals, unexpected, errors };
}

test("a connected step shows its connected-credit quote and Continue approves exactly that price once", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  const phone = page.viewportSize()!.width < 760;
  const surface = phone ? page.getByRole("group", { name: "Checkpoint", exact: true }) : page.getByRole("complementary", { name: "Atomik" }).or(page.getByLabel("Atomik", { exact: true })).first();
  const cont = surface.getByRole("button", { name: /^Continue/ }).first();
  await expect(cont).toBeVisible();
  await expect(cont).toContainText("42 connected cr");
  await expect(surface.getByRole("button", { name: "Change engine", exact: true })).toHaveCount(0);
  const copy = (await surface.innerText()).toLowerCase();
  expect(copy).not.toContain("higgsfield");
  expect(copy).not.toContain("supercomputer");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await cont.click();
  await expect.poll(() => state.approvals.length).toBe(1);
  expect(state.approvals[0]).toEqual({ action: "approve", credits: 42, workspaceId: wallet });
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a connected batch is one approval for its exact summed credits", async ({ page }) => {
  const state = await fixture(page, { batch: true });
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  const phone = page.viewportSize()!.width < 760;
  const surface = phone ? page.getByRole("group", { name: "Checkpoint", exact: true }) : page.getByRole("complementary", { name: "Atomik" }).or(page.getByLabel("Atomik", { exact: true })).first();
  const cont = surface.getByRole("button", { name: /^Continue/ }).first();
  await expect(cont).toContainText("batch of 2 · 84 connected cr");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const box = await cont.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await cont.click();
  await expect.poll(() => state.approvals.length).toBe(1);
  expect(state.approvals[0]).toEqual({ action: "approve-batch", stepIds: ["astp_1", "astp_2"], credits: 84, workspaceId: wallet });
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
