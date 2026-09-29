import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { newProject, type Asset, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { DevelopmentJob, DevelopmentQuote, DevelopmentState } from "../lib/workbench/development-types";
import type { TakeVerification } from "../lib/workbench/verify";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * A Rig Verify check through the real routes and both ledgers (plan PR 7):
 * priced before anything runs, charged once in credits at what the (mock)
 * judge used, stored under its key, and free to read again: no second job,
 * reservation or meter event. signInLocally refuses non-local/non-mock hosts.
 */
test("a Verify check is priced, charged once, stored, and read back free; nobody outside the project reads it", async ({ request, playwright }) => {
  const account = await signInLocally(request);
  const me = await request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const outsider = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551" });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Local mock Verify test", "admin", "test", Date.now()] });
    const square = () => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 160, b: 90 } } }).png().toBuffer();
    const upload = async (name: string) => {
      const response = await request.post("/api/uploads", { headers, multipart: { file: { name, mimeType: "image/png", buffer: await square() } } });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()) as { id: string; url: string };
    };
    const [master, take] = [await upload("master.png"), await upload("take.png")];
    const asset = (id: string, receipt: { id: string; url: string }, extra: Partial<Asset> = {}): Asset => ({ id, name: id, kind: "image", category: "Character", url: receipt.url, uploadId: receipt.id, mime: "image/png", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });
    const node = (id: string, type: CanvasNode["type"], extra: Partial<CanvasNode>): CanvasNode => ({ id, title: id, type, x: 0, y: 0, width: 220, linked: [], ...extra });
    const project: Project = { ...newProject(`Verify API ${randomUUID().slice(0, 8)}`),
      assets: [asset("face", master), asset("shot-take", take, { nodeId: "open" })],
      nodes: [node("mira", "character", { assetId: "face" }), node("open", "scene", { assetId: "shot-take", linked: ["mira"] }),
        node("check", "review", { linked: ["open", "mira"], verify: { rubric: 1, frames: { videoAt: [0.1, 0.5, 0.9], max: 3 } } })] };
    const saved = await request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
    expect(saved.ok(), await saved.text()).toBe(true);
    const url = `/api/workbench/development?projectId=${project.id}`;
    const state = await request.get(url, { headers }).then((r) => r.json()) as DevelopmentState;
    const model = state.models.find((m) => m.vision && m.id.startsWith("anthropic/")) ?? state.models.find((m) => m.vision)!;
    const input = { projectId: project.id, requestId: randomUUID(), kind: "verify", model: model.id, effort: "auto", nodeId: "check" };
    const meterRows = async () => (await platform.execute({ sql: "SELECT * FROM meter_events WHERE workspace_id=?", args: [account.workspace.id] })).rows;

    const quoted = await request.post("/api/workbench/development", { headers, data: { ...input, quoteOnly: true } });
    expect(quoted.ok(), await quoted.text()).toBe(true);
    const quote = (await quoted.json()) as DevelopmentQuote;
    expect(quote).toMatchObject({ quoteOnly: true, kind: "verify", calls: 1, chunks: 1 });
    expect(quote.estimateCredits).toBeGreaterThan(0);
    /* Credits only: no vendor dollars reach a credit workspace. */
    expect(quote.estimateUsd).toBeUndefined();
    expect(await meterRows()).toHaveLength(0);
    /* A start that did not see this price is refused. */
    expect((await request.post("/api/workbench/development", { headers, data: { ...input, sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits - 1 } })).status()).toBe(409);

    const approved = { ...input, requestId: randomUUID(), sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits };
    const started = await request.post("/api/workbench/development", { headers, data: approved });
    expect(started.ok(), await started.text()).toBe(true);
    const job = ((await started.json()) as { job: DevelopmentJob }).job;
    let done = job;
    await expect.poll(async () => {
      done = ((await request.get(`${url}&requestId=${approved.requestId}`, { headers }).then((r) => r.json())).jobs as DevelopmentJob[]).find((j) => j.id === job.id)!;
      if (done?.status === "queued") await request.post("/api/workbench/development", { headers, data: { resume: true, projectId: project.id, jobId: job.id } });
      return done?.status;
    }, { timeout: 60_000 }).toBe("succeeded");
    expect(done.result?.verify).toMatchObject({ verdict: "pass", nodeId: "check", takeId: `upload:${take.id}` });
    expect(done.credits).toBeGreaterThan(0);
    expect(done.credits!).toBeLessThanOrEqual(quote.estimateCredits);
    const meter = await meterRows();
    expect(meter).toHaveLength(1);
    expect(meter[0]).toMatchObject({ id: job.id, status: "succeeded" });

    /* Read back free: the stored scorecard, no job, no reservation, no meter event. */
    const again = (await request.post("/api/workbench/development", { headers, data: { ...input, requestId: randomUUID(), quoteOnly: true } }).then((r) => r.json())) as DevelopmentQuote;
    expect(again).toMatchObject({ estimateCredits: 0, calls: 0, stored: { id: job.id, verdict: "pass", credits: done.credits, standing: "current" } });
    const second = await request.post("/api/workbench/development", { headers, data: { ...approved, requestId: randomUUID() } });
    expect(second.status()).toBe(409);
    expect(await second.text()).toContain("Reading it again is free");
    expect(await meterRows()).toHaveLength(1);
    const listed = (await request.get(`${url}&verifications=1`, { headers }).then((r) => r.json())) as { verifications: TakeVerification[] };
    expect(listed.verifications.map((v) => [v.id, v.verdict, v.standing, v.credits])).toEqual([[job.id, "pass", "current", done.credits]]);
    expect(JSON.stringify(listed)).not.toMatch(/Usd|usd"|meter_event/);

    /* Another account cannot read this project's checks. */
    await signInLocally(outsider, "Outside Tester");
    const other = await outsider.get("/api/me").then((r) => r.json());
    const otherHeaders = { "X-Workbench-Scope": `particl-active-${other.workspace.id}-${other.id}` };
    expect((await outsider.get(`${url}&verifications=1`, { headers: otherHeaders })).status()).toBe(404);
    expect((await outsider.get(`${url}&verifications=1`, { headers })).status()).toBe(409);
  } finally {
    platform.close();
    await outsider.dispose();
  }
});
