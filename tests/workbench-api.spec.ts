import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { newProject, type Project } from "../lib/workbench/studio";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";

test("real local routes persist a single generated take and isolate another workspace", async ({ request, playwright }) => {
  const signed = await signInLocally(request); // refuses any non-local or non-mock deployment before writes
  const db = createClient({ url: localPlatformDbUrl() });
  await db.execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
    args: [randomUUID(), signed.workspace.id, 500, "Local mock integration fixture", "admin", "test", Date.now()],
  });
  db.close();
  const draft = newProject(`API production ${randomUUID().slice(0, 8)}`);
  draft.nodes.push({ id: "api-shot", title: "Saved integration shot", type: "generate", text: "A quiet desert at dawn", x: 100, y: 100, width: 344, linked: [], mode: "Image" });
  const saved = await request.put("/api/workbench/projects", { data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const identity = await saved.json() as { revision: number; productionProjectId: string };
  expect(identity.revision).toBe(1);
  expect(identity.productionProjectId).toMatch(/^prj_wb_/);
  const url = `/api/workbench/projects?id=${draft.id}`;
  const loaded = await request.get(url).then(response => response.json()) as { project: Project; revision: number };
  expect(loaded.project.name).toBe(draft.name);
  expect(loaded.project.productionProjectId).toBe(identity.productionProjectId);
  const mapped = await request.post("/api/workbench/projects", { data: { action: "map-shot", projectId: draft.id, nodeId: "api-shot" } });
  expect(mapped.ok(), await mapped.text()).toBeTruthy();
  const shot = await mapped.json() as { productionProjectId: string; shotId: string };
  expect(shot.productionProjectId).toBe(identity.productionProjectId);
  const engines = await request.get("/api/workbench/engines").then(response => response.json());
  const model = engines.models.find((m: { id: string; kind: string }) => m.kind === "image" && m.id.startsWith("gemini"));
  expect(model).toBeTruthy();
  const body = { projectId: identity.productionProjectId, shotId: shot.shotId, model: model.id, prompt: draft.nodes[0].text, ratio: "16:9", resolution: model.resolutions[0], references: [], refine: false };
  const headers = { "Idempotency-Key": randomUUID() };
  const first = await request.post("/api/generate", { data: body, headers });
  expect(first.ok(), await first.text()).toBeTruthy();
  const generation = await first.json() as { id: string };
  const retry = await request.post("/api/generate", { data: body, headers });
  expect(retry.ok(), await retry.text()).toBeTruthy();
  expect((await retry.json()).id).toBe(generation.id);
  const jobsUrl = `/api/jobs?projectId=${identity.productionProjectId}`;
  await expect.poll(async () => {
    const jobs = await request.get(jobsUrl).then(response => response.json());
    return jobs.generations.find((g: { id: string }) => g.id === generation.id)?.status;
  }, { timeout: 45_000 }).toBe("succeeded");
  const jobs = await request.get(jobsUrl).then(response => response.json());
  expect(jobs.generations).toHaveLength(1);
  expect(jobs.generations[0]).toMatchObject({ id: generation.id, shotId: shot.shotId, kind: "image", version: 1 });
  const media = await request.get(`/api/media/${generation.id}?download=1`);
  expect(media.status()).toBe(200);
  expect(media.headers()["content-type"]).toBe("image/png");
  // The storage pipeline normalizes PNG metadata; compare decoded fixture pixels.
  const pixels = await sharp(await media.body()).raw().toBuffer();
  const fixturePixels = await sharp("public/fixtures/still.png").raw().toBuffer();
  const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
  expect(digest(pixels)).toBe(digest(fixturePixels));
  const thumbnail = await request.get(`/api/workbench/preview/generation/${generation.id}`);
  expect(thumbnail.status()).toBe(200);
  expect(thumbnail.headers()["content-type"]).toBe("image/webp");
  const preview = await sharp(await thumbnail.body()).metadata();
  expect(preview.width).toBeLessThanOrEqual(640);
  expect(preview.height).toBeLessThanOrEqual(640);
  loaded.project.assets.push({ id: "generated-api", generationId: generation.id, productionShotId: shot.shotId, nodeId: "api-shot", name: "Recovered take", kind: "image", category: "Take", url: `/api/media/${generation.id}`, description: "", prompt: draft.nodes[0].text!, status: "Draft", locked: false, version: 1, refs: [], mime: "image/png" });
  const revised = await request.put("/api/workbench/projects", { data: { project: loaded.project, revision: loaded.revision } });
  expect(revised.ok(), await revised.text()).toBeTruthy();
  const reloaded = await request.get(url).then(response => response.json());
  expect(reloaded.project.assets[0].generationId).toBe(generation.id);
  expect(reloaded.project.shotMappings["api-shot"]).toBe(shot.shotId);
  expect((await request.put("/api/workbench/projects", { data: { project: loaded.project, revision: loaded.revision } })).status()).toBe(409);

  const outsider = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551" });
  try {
    await signInLocally(outsider);
    expect((await outsider.get(url).then(response => response.json())).project).toBeNull();
    expect((await outsider.post("/api/workbench/projects", { data: { action: "map-shot", projectId: draft.id, nodeId: "api-shot" } })).status()).toBe(404);
    expect((await outsider.post("/api/workbench/projects", { data: { action: "open", projectId: identity.productionProjectId } })).status()).toBe(404);
    expect((await outsider.put("/api/workbench/projects", { data: { project: loaded.project, revision: 0 } })).status()).toBe(409);
    expect((await outsider.post("/api/generate", { data: body, headers: { "Idempotency-Key": randomUUID() } })).status()).toBe(404);
    expect((await outsider.get(`/api/media/${generation.id}?download=1`)).status()).toBe(404);
    expect((await outsider.get(`/api/workbench/preview/generation/${generation.id}`)).status()).toBe(404);
    expect((await outsider.get(jobsUrl).then(response => response.json())).generations).toEqual([]);
  } finally {
    await outsider.dispose();
  }
});
