import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ProviderOutcome } from "../../lib/providerOutcome";

/*
 * Rule 1 of the owner's 17 Oct brief, through lib/jobView.ts (docs/plans/v30-data-model.md § 4.4; PR A3): an Agent job
 * never exposes its engine (API, History, receipts, exports, error messages); a Director job exposes what it chose.
 *
 * Every engine, model and provider name below is a SENTINEL made up in this test, so a leak cannot hide behind a real
 * name that happens to be filtered elsewhere. Every quote, receipt and cost is SYNTHETIC.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-job-view-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const HOUSE = "ws_legacy";
const workspace = (id: string, file = id) =>
  ({ id, name: id, slug: id, dbUrl: `file:${path.join(dir, file + ".db")}`, legacy: false, dbToken: null, keys: {}, usesPlatformKeys: true }) as unknown as TenantWorkspace;

const tag = Math.random().toString(36).slice(2, 8);
const SENTINEL_ENGINE = `sentinel-engine-${tag}`;
const SENTINEL_MODEL = `sentinel-model-${tag}`;
const SENTINEL_PROVIDER = `sentinel-provider-${tag}`;
const SENTINEL_FINGERPRINT = `sentinel-fingerprint-${tag}`;
/* Synthetic figures, named as such: a vendor cost a take's params might hold, a quote, a receipt. None is real. */
const SYNTHETIC_VENDOR_COST = 0.987654321;
const SYNTHETIC_CREDITS = 4.5;
const SYNTHETIC_USD = 0.25;
const SYNTHETIC_RECEIPT = 3;

const mods = async () => ({
  ...(await import("../../lib/db")),
  ...(await import("../../lib/tenant")),
  ...(await import("../../lib/jobView")),
  ...(await import("../../lib/quotedJobs/store")),
  ...(await import("../../lib/providerOutcome")),
  ...(await import("../../lib/models")),
});

/** The vendor's failure, naming the engine in its own words, on the workspace's own key (so the most is visible). */
const vendorFailure = (): ProviderOutcome => ({
  v: 1, provider: "byteplus", stage: "run", code: "SentinelVendorCode", kind: "content_filter",
  message: `Model ${SENTINEL_ENGINE} refused the request.`, billing: { state: "not_charged", basis: "ark-success-only" }, funding: "own", at: 1,
});

async function seed(ws: TenantWorkspace, client: Client, realModelId: string) {
  const m = await mods();
  const params = (model: string) => JSON.stringify({
    ratio: "16:9", resolution: "720p", duration: 5, generateAudio: true, seed: 7, model,
    higgsfieldVendorCostUsd: SYNTHETIC_VENDOR_COST, soulVendorCostUsd: SYNTHETIC_VENDOR_COST, higgsfieldCredentialFingerprint: SENTINEL_FINGERPRINT,
    quote: { credits: SYNTHETIC_CREDITS },
  });
  const recorded = (engine: string) => JSON.stringify({
    engine, model: SENTINEL_MODEL, provider: SENTINEL_PROVIDER, ports: ["el_cast:attr_face:ver_1"], cast: ["maya"],
    setup: { angle: "low", move: "dolly_in" }, rules: [], conditions: { width: 1280, height: 720, billedWidth: 1280, billedHeight: 720, durationSeconds: 5, seed: 7 }, by: "usr_person", at: 1,
  });
  const take = async (id: string, model: string, prompt: string, engine: string) => {
    await client.execute({
      sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,provider_outcome,created_at,updated_at) VALUES(?,?,?,?,?,'failed',?,1,1)",
      args: [id, "prj_one", model, prompt, params(engine), m.serializeOutcome(vendorFailure())],
    });
    await client.execute({ sql: "INSERT INTO take_provenance(take_id,shot_id,recorded,created_at) VALUES(?,NULL,?,1)", args: [id, recorded(engine)] });
  };
  await take("gen_agent", SENTINEL_MODEL, "A synthetic prompt about a lighthouse", SENTINEL_ENGINE);
  await take("gen_agent_named", SENTINEL_MODEL, `Atomik wrote ${SENTINEL_ENGINE} into this prompt`, SENTINEL_ENGINE);
  await take("gen_agent_real", realModelId, "A synthetic prompt about a harbour", realModelId);
  await take("gen_director", SENTINEL_MODEL, "A synthetic prompt about a forest", SENTINEL_ENGINE);

  return m.runInTenant(ws, async () => {
    const store = m.jobStoreForTests(client, ws.id);
    const quote = ws.id === HOUSE ? { usd: SYNTHETIC_USD } : { credits: SYNTHETIC_CREDITS };
    const command = await store.createCommand({ productionId: "prj_one", instruction: "Synthetic: three shots of the coast", quote, by: "usr_person" });
    const make = async (takeId: string, decider: "agent" | "director", engine: string, meterId: string) => {
      const job = await store.createJob({ productionId: "prj_one", stepId: "pstep_shots", nodeId: "node_1", commandId: decider === "agent" ? command.id : null, decider, product: "generation", engine, quote, by: "usr_person" });
      await store.start(job.id);
      await store.attach(job.id, { meterId, takeId });
      await store.finish(job.id, "failed", vendorFailure());
      return job.id;
    };
    const ids = {
      command: command.id,
      agent: await make("gen_agent", "agent", SENTINEL_ENGINE, "gen_agent"),
      agentNamed: await make("gen_agent_named", "agent", SENTINEL_ENGINE, "gen_agent_named"),
      agentReal: await make("gen_agent_real", "agent", realModelId, "gen_agent_real"),
      director: await make("gen_director", "director", SENTINEL_ENGINE, "gen_director"),
    };
    await client.execute({ sql: "INSERT INTO credit_receipts(event_id,credits,revision) VALUES('gen_agent',?,1),('gen_director',?,1)", args: [SYNTHETIC_RECEIPT, SYNTHETIC_RECEIPT] });
    return ids;
  });
}

async function database(ws: TenantWorkspace) {
  const { runInTenant, ready, db } = await mods();
  return runInTenant(ws, async () => {
    await ready();
    await db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prj_one','Existing',1)");
    return db();
  });
}

for (const who of ["house", "credit"] as const) {
  test(`an Agent job never exposes its engine, in any read model, and a Director job exposes what it chose (${who} workspace)`, async () => {
    const m = await mods();
    const ws = who === "house" ? workspace(HOUSE, "view-house") : workspace("ws_view_credit", "view-credit");
    const client = await database(ws);
    const realModelId = m.offeredModels()[0].id;
    const ids = await seed(ws, client, realModelId);
    const modelIds = m.MODELS.map((x) => x.id);

    /* What must never appear in any Agent output, and what must never appear in ANY output (no vendor cost, no credential). */
    const neverAnywhere = [String(SYNTHETIC_VENDOR_COST), SENTINEL_FINGERPRINT, "VendorCost", "Fingerprint"];
    const neverForAgent = [SENTINEL_ENGINE, SENTINEL_MODEL, SENTINEL_PROVIDER, "sentinel", "byteplus", "BytePlus", "SentinelVendorCode", m.displayModelName(realModelId), ...modelIds, ...neverAnywhere];
    const leaks = (value: unknown, needles: string[]) => {
      const text = (typeof value === "string" ? value : JSON.stringify(value)).toLowerCase();
      return needles.filter((n) => text.includes(n.toLowerCase()));
    };

    await m.runInTenant(ws, async () => {
      const store = m.jobStoreForTests(client, ws.id);
      const agentIds = [ids.agent, ids.agentNamed, ids.agentReal];
      const outputs: { name: string; value: unknown }[] = [];
      for (const id of agentIds) {
        const job = await store.get(id);
        expect(job).toMatchObject({ decider: "agent", engine: null, settings: null, inputs: null, prompt: null });
        outputs.push({ name: `get ${id}`, value: job });
        const line = await store.errorLine(id);
        expect(line).not.toBeNull();
        expect(line!.what).toBe("Refused by the content filter");
        if (line!.charge) expect(line!.charge).toMatch(/^The provider /);
        outputs.push({ name: `error line ${id}`, value: line });
        const recipe = await store.recipe(id);
        expect(recipe!.engine).toBe("");
        outputs.push({ name: `recipe ${id}`, value: recipe });
      }
      outputs.push({ name: "list", value: (await store.list({ commandId: ids.command })) });
      outputs.push({ name: "command", value: await store.getCommand(ids.command) });
      outputs.push({ name: "commands", value: await store.listCommands("prj_one") });
      const csv = await store.csv({ productionId: "prj_one" });
      const csvLines = csv.trim().split("\n");
      expect(csvLines[0]).toBe(m.JOB_CSV_HEADER.join(","));
      for (const id of agentIds) {
        const line = csvLines.find((l) => l.startsWith(id + ","));
        expect(line, id).toBeTruthy();
        outputs.push({ name: `csv ${id}`, value: line });
      }
      // The pure serializer, over the same stored rows: the same answers.
      const rows = (await client.execute({ sql: `SELECT j.*, g.model AS take_model, g.prompt AS take_prompt, g.params AS take_params, g.provider_outcome AS take_outcome, p.recorded AS take_recorded
        FROM quoted_jobs j LEFT JOIN generations g ON g.id=j.take_id LEFT JOIN take_provenance p ON p.take_id=j.take_id WHERE j.decider='agent'` })).rows;
      expect(rows).toHaveLength(3);
      const opts = { credits: who === "credit" };
      outputs.push({ name: "publicJobs", value: m.publicJobs(rows, opts) });
      outputs.push({ name: "jobCsv", value: m.jobCsv(rows, opts) });
      for (const row of rows) outputs.push({ name: "jobErrorLine", value: m.jobErrorLine(row, opts) }, { name: "recreateRecipe", value: m.recreateRecipe(row) });
      // A row whose decider is unreadable is read as an Agent job: the stricter side.
      const odd = { ...rows[0], decider: "Director " };
      outputs.push({ name: "unreadable decider", value: m.publicJob(odd, opts) });

      for (const { name, value } of outputs) expect(leaks(value, neverForAgent), name).toEqual([]);

      // Recreate on an Agent take: an empty engine, the take's shape and inputs, and its prompt unless the prompt names the engine.
      const recipe = await store.recipe(ids.agent);
      expect(recipe).toEqual({
        product: "generation", engine: "", prompt: "A synthetic prompt about a lighthouse",
        settings: { ratio: "16:9", resolution: "720p", duration: 5, generateAudio: true, seed: 7, "setup.angle": "low", "setup.move": "dolly_in" },
        inputs: { ports: ["el_cast:attr_face:ver_1"], cast: ["maya"] },
      });
      expect((await store.recipe(ids.agentNamed))!.prompt).toBe("");

      // The Director job: everything it chose. Still no vendor cost and no credential.
      const director = await store.get(ids.director);
      expect(director).toMatchObject({
        decider: "director", engine: { id: SENTINEL_ENGINE }, prompt: "A synthetic prompt about a forest",
        settings: { ratio: "16:9", resolution: "720p", duration: 5, "setup.angle": "low" }, inputs: { ports: ["el_cast:attr_face:ver_1"], cast: ["maya"] },
      });
      expect(director!.settings).not.toHaveProperty("model");
      expect((await store.recipe(ids.director))!.engine).toBe(SENTINEL_ENGINE);
      expect(csvLines.find((l) => l.startsWith(ids.director + ","))).toContain(SENTINEL_ENGINE);
      for (const value of [director, await store.recipe(ids.director), await store.errorLine(ids.director), csv])
        expect(leaks(value, neverAnywhere)).toEqual([]);

      // Money in the views: credits for a credit workspace (never a dollar quote, never the vendor's billing state);
      // the house sees its dollar quote and the refund status, and has no credit receipts to read.
      if (who === "credit") {
        expect(director).toMatchObject({ quote: { credits: SYNTHETIC_CREDITS }, actual: { credits: SYNTHETIC_RECEIPT }, refundStatus: null });
        expect(await store.getCommand(ids.command)).toMatchObject({ total: { credits: SYNTHETIC_RECEIPT } });
      } else {
        expect(director).toMatchObject({ quote: { usd: SYNTHETIC_USD }, actual: null, refundStatus: "not_charged" });
        // A dollar quote on a stored row is never sent to a viewer that pays in credits.
        expect(m.publicJob(rows[0], { credits: true }).quote).toBeNull();
      }
    });
  });
}
