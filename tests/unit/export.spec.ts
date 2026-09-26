import { test, expect } from "@playwright/test";
import { takesCsv, type ExportRow } from "../../lib/exportRows";
import { deletionAllowed } from "../../lib/deletion";

const row = (o: Partial<ExportRow>): ExportRow => ({
  id: "gen_1", createdAt: Date.UTC(2026, 8, 6), production: "Northline", shotCode: "SH010", shotTitle: "Rooftop, wide", take: "v1",
  kind: "video", engine: "Seedance 2.5", resolution: "1080P", duration: "5s", status: "succeeded", credits: 40, usd: 0,
  prompt: 'A courier crosses, "quiet"', filename: "NORTH_SH010_SD25_v1_ap.mp4", url: "/api/media/gen_1", bytes: 991017, ...o,
});

test("the takes CSV carries the money column in the workspace's unit and escapes the prompt", () => {
  const cr = takesCsv([row({})], "cr");
  expect(cr.split("\r\n")[0]).toContain(",credits,prompt,filename,url");
  expect(cr).toContain(',"A courier crosses, ""quiet""",');
  expect(cr).toContain(",40,");
  const usd = takesCsv([row({ credits: 0, usd: 2.86416 })], "$");
  expect(usd.split("\r\n")[0]).toContain(",usd,");
  expect(usd).toContain(",2.8642,");
});

test("deleting a workspace needs its exact name, and never the studio's own", () => {
  expect(deletionAllowed({ name: "Coast Road", legacy: false, role: "owner" }, "Coast Road")).toEqual({ ok: true });
  expect(deletionAllowed({ name: "Coast Road", legacy: false, role: "owner" }, "coast road").ok).toBe(false);
  expect(deletionAllowed({ name: "Coast Road", legacy: false, role: "admin" }, "Coast Road").ok).toBe(false);
  expect(deletionAllowed({ name: "Studio", legacy: true, role: "owner" }, "Studio").ok).toBe(false);
});

test("export links are presigned a bounded few at a time, not one round trip after another", async () => {
  const { eachLimited } = await import("../../lib/exportRows");
  let inFlight = 0, peak = 0;
  const done: number[] = [];
  await eachLimited(Array.from({ length: 50 }, (_, i) => i), 16, async (i) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight--; done.push(i);
  });
  expect(peak).toBe(16);
  expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  await eachLimited([], 16, async () => { throw new Error("never called"); });
});

test("the takes export names and links each kind's own master, and skips demo takes that have none", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const tenant = await import("../../lib/tenant");
  const dbModule = await import("../../lib/db");
  const { loadIsolated } = await import("./storageSeam");
  const dir = mkdtempSync(path.join(tmpdir(), "particl-export-rows-"));
  const presigned: string[] = [];
  let inFlight = 0, peak = 0;
  const { exportRows } = loadIsolated<typeof import("../../lib/exportRows")>("lib/exportRows.ts", {
    "./db": dbModule,
    "./tenant": tenant,
    "./storage": {
      usingBlob: () => true,
      videoPath: (id: string) => `generations/${id}.mp4`,
      imagePath: (id: string) => `generations/${id}.png`,
      audioPath: (id: string) => `generations/${id}.mp3`,
      modelPath: (id: string) => `generations/${id}.glb`,
      presignedReadUrl: async (pathname: string) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--; presigned.push(pathname);
        return `https://store.test/${pathname}?signed`;
      },
    },
  });
  const ws = { id: "export-rows", name: "Export", slug: "export-rows", legacy: false, dbUrl: `file:${path.join(dir, "export.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false } as unknown as import("../../lib/tenant").TenantWorkspace;
  await tenant.runInTenant(ws, async () => {
    await dbModule.ready();
    const insert = (id: string, kind: string, stored: string | null, params: Record<string, unknown> = {}) => dbModule.db().execute({
      sql: `INSERT INTO generations(id,model,prompt,params,status,stored_url,kind,created_at,updated_at) VALUES(?,?,?,?,'succeeded',?,?,?,?)`,
      args: [id, "fixture-model", "p", JSON.stringify(params), stored, kind, 1, 1],
    });
    await insert("gen_model", "model", "/api/media/gen_model");
    await insert("gen_jpeg", "image", "/api/media/gen_jpeg", { consumerOriginalMime: "image/jpeg" });
    await insert("gen_demo", "video", "/fixtures/clip.mp4", { demo: true });
    for (let i = 0; i < 30; i++) await insert(`gen_v${i}`, "video", `/api/media/gen_v${i}`);
    const { rows } = await exportRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("gen_model")).toMatchObject({ kind: "model", url: "https://store.test/generations/gen_model.glb?signed" });
    expect(byId.get("gen_model")!.filename).toMatch(/\.glb$/);
    expect(byId.get("gen_jpeg")!.filename).toMatch(/\.jpg$/);
    expect(byId.get("gen_demo")!.url).toBe("");
    expect(presigned).toHaveLength(32);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
  });
});
