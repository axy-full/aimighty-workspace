import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { assembleToExport } from "../../lib/exports/assemble";
import { filmRequest } from "../../lib/exports/film";
import { newProject, type Asset } from "../../lib/workbench/studio";
import { exportWorkerPool } from "./remotionWorkerFake";

/**
 * export_film end to end on mocks: the board's own saved draft, read for its owner only, becomes an assembly request for each
 * language, runs on the in-memory worker and is collected; an outside agent reaches it over MCP. No network, no render, no credit.
 */
const directory = mkdtempSync(path.join(tmpdir(), "export-film-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null } as unknown as TenantWorkspace);
const LIMITS = { maxRunningPerWorkspace: 1, maxPerHourPerWorkspace: 6, runTimeoutMs: 200_000, queueExpiryMs: 30 * 60_000 };
const HINDI = "हर अच्छी फ़िल्म";
const asset = (id: string, generationId: string) => ({ id, name: id, kind: "video", category: "", url: "/api/media/x", description: "", prompt: "", status: "Selected", locked: false, version: 1, refs: [], generationId, seconds: 5 }) as Asset;

test("a saved board is exported in English and in Hindi: owner only, free, through the same queue", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("film-run"), async () => {
    const jobs = await import("../../lib/exports/jobs");
    const inputs = await import("../../lib/exports/inputs");
    const records = await import("../../lib/workbench/records");
    const { db, ready } = await import("../../lib/db");
    const { platformReady } = await import("../../lib/platform");
    await platformReady(); await ready(); await records.workbenchReady(); await jobs.exportJobsReady();
    const client = db();
    for (const id of ["u_owner", "u_mate"]) await client.execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x','member',0)", args: [id, `${id}@example.test`, id] });
    for (const [id, kind, seconds] of [["take_1", "video", null], ["take_2", "video", null], ["take_2_hi", "video", null], ["voice_en1", "audio", 3], ["voice_hi1", "audio", 3.5]] as const) {
      await client.execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by,project_id,stored_url,bytes,duration_s) VALUES(?,?,?,?,?,1,1,?,0,'u_owner',NULL,'/stored/x',1000,?)", args: [id, "m", "p", "{}", "succeeded", kind, seconds] });
    }
    const project = {
      ...newProject("Monsoon"), id: "d1", aspect: "16:9", fps: 30,
      assets: [asset("a1", "take_1"), asset("a2", "take_2")],
      shots: [{ id: "s1", name: "Shot 1", assetId: "a1", duration: 150, sourceIn: 0, note: "" }, { id: "s2", name: "Shot 2", assetId: "a2", duration: 150, sourceIn: 0, note: "" }],
      boardCut: { captions: "clean" as const },
      boardVoice: { en: { lines: [{ take: "voice_en1", startSeconds: 1, text: "Every great film" }] }, hi: { lines: [{ take: "voice_hi1", startSeconds: 1, text: HINDI }], swap: { take_2: "take_2_hi" } } },
    };
    await client.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify(project)] });

    /* The board is the caller's own: anyone else gets what an unknown board gets. */
    expect(await records.readDraft("u_mate", "d1")).toBeNull();
    expect(await records.readDraft("u_owner", "nothing")).toBeNull();
    const draft = (await records.readDraft("u_owner", "d1"))!;

    const pool = exportWorkerPool();
    const deps = { enabled: () => true, limits: () => LIMITS, resolver: (who: { id: string; role?: string }) => inputs.createMediaResolver(who, { facts: async () => ({ durationSeconds: 5, width: 1920, height: 1080 }) }), reach: async () => true, loader: async () => Buffer.from("bytes"), worker: { config: pool.config, fetch: pool.fetch } };
    const seen: { props?: { voiceover?: { text?: string }[]; clips?: { source: { file: string } }[] } }[] = [];
    pool.behave({ during: (session) => { seen.push({ props: (session.spec as { props?: never } | null)?.props }); } });
    const made: string[] = [];
    for (const language of ["en", "hi"]) {
      const film = filmRequest(draft.project, language, `film-run-${language}-0001`);
      if (!film.ok) throw new Error(film.error);
      const created = await jobs.createExport(assembleToExport(film.request), { id: "u_owner" }, deps);
      expect(created.job).toMatchObject({ composition: "final", price: { credits: 0, label: "Free" }, status: "queued" });
      await jobs.runExport(created.job.id, deps);
      const done = await jobs.getExport("u_owner", created.job.id, deps);
      expect(done).toMatchObject({ status: "ready", error: null });
      expect(done.outputs.map((o) => o.kind)).toEqual(expect.arrayContaining(["video", "subtitle"]));
      made.push(created.job.id);
    }
    expect(made[0]).not.toBe(made[1]);
    expect(seen[0].props?.voiceover?.map((v) => v.text)).toEqual(["Every great film"]);
    expect(seen[1].props?.voiceover?.map((v) => v.text)).toEqual([HINDI]);
    /* Hindi's shot two is the lip-synced take: the same film otherwise. */
    expect(seen[1].props?.clips).toHaveLength(2);
    /* The same request again returns the job it started. */
    const again = filmRequest(draft.project, "hi", "film-run-hi-0001");
    if (!again.ok) throw new Error(again.error);
    expect((await jobs.createExport(assembleToExport(again.request), { id: "u_owner" }, deps)).duplicate).toBe(true);
  });
});

test("an outside agent exports a board's film over MCP: one POST to the film route, free, and a link to collect it; off, the tool does not exist", async () => {
  const { runTool, EXPORT_TOOLS } = await import("../../lib/mcp");
  const calls: { path: string; init: { method?: string; body?: unknown } }[] = [];
  const call = (async (pathname: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path: pathname, init });
    return { job: { id: "export_" + "d".repeat(32), status: "queued", queueLine: "Export queued — you are next", error: null, outputs: [] } };
  }) as never;
  process.env.REMOTION_EXPORTS = "1";
  try {
    const text = await runTool("export_film", { board: "d1", language: "hi", request_id: "agent-film-hi-0001" }, call, "https://app.test");
    expect(calls).toEqual([{ path: "/api/exports/film", init: { method: "POST", body: { board: "d1", language: "hi", requestId: "agent-film-hi-0001" } } }]);
    expect(text).toContain("price: Free (0 cr)");
    await expect(runTool("export_film", { board: "d1", language: "hi" }, call, "https://app.test", { exports: false })).rejects.toThrow("Unknown tool");
    expect(JSON.stringify(EXPORT_TOOLS.find((t) => t.name === "export_film"))).not.toMatch(/\bcredits? (?!it costs no)\d|\$\d|REMOTION_|secret/i);
  } finally {
    delete process.env.REMOTION_EXPORTS;
  }
  const { FILM_TOOL, ASSEMBLE_TOOL } = await import("../../lib/exports/tool");
  expect(FILM_TOOL).toMatchObject({ id: "export_film", kind: "app-action", callers: "render", route: "/api/exports/film", asks: ASSEMBLE_TOOL.id, priceLabel: "Free" });
  expect(FILM_TOOL.price()).toEqual({ credits: 0, label: "Free" });
});
