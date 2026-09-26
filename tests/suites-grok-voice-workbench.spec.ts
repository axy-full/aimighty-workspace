import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Owner, 23 September: Grok APIs wherever possible. Grok Voice speaks a line
 * (xAI's text to speech, its own voices), and Grok transcribes a take — words,
 * speakers, subtitles — each priced first and billed as an xAI charge. Real
 * local routes, mock engine: nothing is spent.
 */
async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${account.workspace.id}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope, "Content-Type": "application/json" };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl = "";
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Grok voice test", "admin", "test", Date.now()] });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
  } finally { platform.close(); }
  const project = newProject(`Grok voice ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const production = String((await saved.json()).productionProjectId);
  /* The server may hold the tenant file's write lock while the take runs: the read waits for it, as the platform's does. */
  const row = async (id: string) => { const db = createClient({ url: tenantUrl, timeout: 10_000 }); try { return (await db.execute({ sql: "SELECT status, provider, billed_to, cost_usd, duration_s FROM generations WHERE id=?", args: [id] })).rows[0]; } finally { db.close(); } };
  const meterRow = async (model: string) => { const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 }); try { return (await db.execute({ sql: "SELECT engine, status, engine_cost_usd FROM meter_events WHERE workspace_id=? AND model=? ORDER BY rowid DESC LIMIT 1", args: [account.workspace.id, model] })).rows[0]; } finally { db.close(); } };
  return { headers, scope, project, production, row, meterRow };
}

test("Grok Voice speaks a line in its own voice, billed as xAI", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop run");
  test.setTimeout(120_000);
  const { headers, production, row, meterRow } = await setup(page);
  const audio = await page.request.get("/api/audio", { headers }).then((r) => r.json());
  expect(audio.speechModels.map((m: { id: string }) => m.id)).toContain("grok-tts");
  /* Grok Voice's own voices ride beside the default model's, so a picker swaps lists with the model. */
  expect(audio.vendors).toEqual({ elevenlabs: true, xai: true });
  expect(audio.grokVoices.map((v: { id: string }) => v.id)).toEqual(expect.arrayContaining(["eve", "ara", "rex"]));
  const voices = await page.request.get("/api/audio/voices?model=grok-tts", { headers }).then((r) => r.json());
  expect(voices.voices.map((v: { id: string }) => v.id)).toEqual(expect.arrayContaining(["eve", "ara", "rex"]));

  const line = { task: "speech", modelId: "grok-tts", voiceId: "eve", text: "Not tonight. [pause] The ice will hold until morning.", projectId: production, language: "en" };
  const quote = await page.request.post("/api/audio", { headers, data: { ...line, quoteOnly: true } }).then((r) => r.json());
  expect(quote.estimatedCredits).toBeGreaterThan(0);
  const sent = await page.request.post("/api/audio", { headers: { ...headers, "Idempotency-Key": `grok-voice-${randomUUID()}` }, data: { ...line, maxCredits: quote.estimatedCredits } });
  expect(sent.ok(), await sent.text()).toBe(true);
  const { id } = await sent.json();
  await expect.poll(async () => (await row(id))?.status, { timeout: 60_000 }).toBe("succeeded");
  expect(await row(id)).toMatchObject({ provider: "xai", billed_to: "xai" });
  expect(await meterRow("grok-tts")).toMatchObject({ engine: "xai", status: "succeeded" });
  /* A voice id that is not a Grok voice is refused before anything is priced. */
  const bad = await page.request.post("/api/audio", { headers, data: { ...line, voiceId: "!", quoteOnly: true } });
  expect(bad.status()).toBe(400);
  /* Nor is another vendor's voice id, which has a Grok voice's shape but is not one of xAI's. */
  const eleven = await page.request.post("/api/audio", { headers, data: { ...line, voiceId: "21m00Tcm4TlvDq8ikWAM", quoteOnly: true } });
  expect(eleven.status()).toBe(400);
  expect((await eleven.json()).error).toBe("Pick a Grok voice.");
});

test("Grok transcribes a take: priced by its length, words and speakers, subtitles to download", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop run");
  test.setTimeout(180_000);
  const { headers, project, production, row, meterRow } = await setup(page);
  /* A real (mock) Grok Imagine Video take in the project. */
  const body = { prompt: "Mara on the ice, speaking", model: "grok-imagine-video", projectId: production, shotId: "", ratio: "16:9", resolution: "480p", duration: 5, refine: false, references: [], firstFrameAssetId: "" };
  const quote = await page.request.post("/api/generate/quote", { headers, data: body }).then((r) => r.json());
  const made = await page.request.post("/api/generate", { headers: { ...headers, "Idempotency-Key": `grok-take-${randomUUID()}` }, data: { ...body, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint } });
  expect(made.ok(), await made.text()).toBe(true);
  const { id: genId } = await made.json();
  await expect.poll(async () => { await page.request.get(`/api/jobs/${genId}`, { headers }); return (await row(genId))?.status; }, { timeout: 90_000 }).toBe("succeeded");
  expect(await row(genId)).toMatchObject({ provider: "xai" });

  const priced = await page.request.post("/api/audio/transcribe", { headers, data: { sourceGenId: genId, quoteOnly: true } });
  expect(priced.ok(), await priced.text()).toBe(true);
  const { estimatedCredits } = await priced.json();
  expect((await page.request.post("/api/audio/transcribe", { headers, data: { sourceGenId: genId, maxCredits: estimatedCredits - 1 } })).status()).toBe(estimatedCredits > 0 ? 409 : 200);

  /* Through the Takes page: select the clip, price, transcribe, read it, take the subtitles. */
  await page.goto(`/suites?suite=studio&page=takes&project=${project.id}`);
  await expect(page.getByTestId("edit-stage")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByTestId("edit-take").filter({ hasText: /Mara on the ice/i }).first().click();
  const panel = page.getByTestId("transcribe");
  await expect(async () => {
    if (await panel.getByTestId("transcribe-price").isVisible()) await panel.getByTestId("transcribe-price").click();
    await expect(panel.getByTestId("transcribe-run")).toContainText(/Transcribe · \d+ credits?/, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await panel.getByTestId("transcribe-run").click();
  await expect(panel.getByTestId("transcript")).toContainText("Speaker 1", { timeout: 60_000 });
  await expect(panel.getByTestId("transcript")).toContainText("Speaker 2");
  const download = page.waitForEvent("download");
  await panel.getByTestId("transcribe-srt").click();
  expect((await download).suggestedFilename()).toMatch(/\.srt$/);
  expect(await meterRow("grok-stt")).toMatchObject({ engine: "xai", status: "succeeded" });
});
