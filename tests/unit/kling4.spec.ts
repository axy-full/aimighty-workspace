import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type {
  AdmissionActor,
  PreparedAdmission,
} from "../../lib/admissionTypes";

const dir = mkdtempSync(path.join(tmpdir(), "particl-kling4-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const actor: AdmissionActor = {
  user: {
    id: "owner",
    email: "owner@example.invalid",
    name: "Owner",
    role: "admin",
    owner: true,
    disabled: false,
    createdAt: 0,
    lastSeen: null,
  },
};
const nodeRequire = createRequire(path.resolve("package.json"));
let dispatched: { genId: string; kind: string }[] = [];
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/")
        ? nodeRequire(path.resolve(name.slice(2) + ".ts"))
        : name.startsWith(".")
          ? nodeRequire(path.resolve(path.dirname(file), name + ".ts"))
          : nodeRequire(name);
    },
    target,
    target.exports,
  );
  return target.exports as T;
}
function services() {
  const queue = {
    enqueueRender: async (genId: string, kind: string) => {
      dispatched.push({ genId, kind });
      return true;
    },
  };
  return {
    gen: load<typeof import("../../lib/generationAdmission")>(
      "lib/generationAdmission.ts",
      { "@/lib/inngest": queue },
    ),
    audio: load<typeof import("../../lib/audioAdmission")>(
      "lib/audioAdmission.ts",
      { "@/lib/inngest": queue },
    ),
  };
}
async function scope(
  name: string,
  fn: (loaded: ReturnType<typeof services>) => Promise<void>,
) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } =
    await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`],
  });
  await grantCredits(name, 10000, "Test", "owner", "manual");
  const ws = rowToWorkspace(
    (
      await platformDb().execute({
        sql: "SELECT * FROM workspaces WHERE id=?",
        args: [name],
      })
    ).rows[0],
  );
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network forbidden in admission parity test");
  };
  dispatched = [];
  try {
    await runInTenant(
      ws,
      async () => {
        await ready();
        await db().execute(
          "INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)",
        );
        await db().execute(
          "INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'",
        );
        await fn(services());
      },
      actor,
    );
  } finally {
    globalThis.fetch = fetch;
  }
}

async function rows() {
  const { db } = await import("../../lib/db");
  return (await db().execute("SELECT * FROM generations ORDER BY id")).rows;
}
async function meters() {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  return (
    await platformDb().execute({
      sql: "SELECT * FROM meter_events WHERE workspace_id=?",
      args: [requireTenant().id],
    })
  ).rows;
}
function value(
  result: Awaited<ReturnType<typeof import("../../lib/generationAdmission").prepareGeneration>>,
): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

/* The site setting that lists workspaces besides the house (lib/engineGate.ts). */
async function listWorkspaces(ids: string[]): Promise<() => Promise<void>> {
  const { platformDb } = await import("../../lib/platform");
  const was = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: ids })] });
  return async () => { if (typeof was === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [was] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'"); };
}
const KLING4 = "fal-ai/kling-video/v4/pro";
const KLING3_PRO = "fal-ai/kling-video/v3/pro";
test.afterEach(() => { delete process.env.KLING4_ENABLED; });
/**
 * Stands in for the lead's confirmation: the row ships `confirmed: false` (Kling 4.0 is not on fal as of 16 Oct 2026), and these tests exercise what happens once it is true. It is put back after.
 */
async function whileConfirmed<T>(fn: () => Promise<T>): Promise<T> {
  const { GATED_VENDOR_RATES } = await import("../../lib/vendorRates");
  const was = GATED_VENDOR_RATES[KLING4].confirmed;
  GATED_VENDOR_RATES[KLING4].confirmed = true;
  try { return await fn(); } finally { GATED_VENDOR_RATES[KLING4].confirmed = was; }
}

test("Kling 4.0 resolves on fal, gated by KLING4_ENABLED, and is in no list that walks the registry; Kling 3.0 and 3.0 Pro are as they were", async () => {
  const { MODELS, GATED_MODELS, getModel, findModel, isOffered, offeredModels, displayModelName } = await import("../../lib/models");
  const { workbenchGenerationModels } = await import("../../lib/workbench/media-quote");
  const { shotEngines, engineLabel } = await import("../../lib/workspace/engines");
  const { ownGenerateEngines } = await import("../../lib/atomik");
  const { pipelineStageModels } = await import("../../lib/pipeline/service");
  const k4 = getModel(KLING4);
  expect(k4).toMatchObject({ provider: "fal", kind: "video", billing: "second", falEndpoint: KLING4, gate: "KLING4_ENABLED", label: "Kling 4.0", supportsAudio: true, family: "kling-3" });
  expect(findModel(KLING4)).toBe(k4);
  expect(GATED_MODELS.map((m) => [m.id, m.gate])).toEqual([[KLING4, "KLING4_ENABLED"]]);
  expect(MODELS.some((m) => m.id === KLING4 || m.gate)).toBe(false);
  expect(offeredModels().some((m) => m.id === KLING4)).toBe(false);
  expect(shotEngines().some((m) => m.id === KLING4)).toBe(false);
  expect(workbenchGenerationModels().some((m) => m.id === KLING4)).toBe(false);
  expect(workbenchGenerationModels(undefined, []).some((m) => m.id === KLING4)).toBe(false);
  expect(workbenchGenerationModels(undefined, [k4]).some((m) => m.id === KLING4)).toBe(true);
  expect(ownGenerateEngines().some((m) => m.id === KLING4)).toBe(false);
  expect(pipelineStageModels().some((m) => m.id === KLING4)).toBe(false);
  /* Everything else is offered as before. */
  for (const id of ["fal-ai/kling-video/v3/standard", KLING3_PRO]) {
    expect(isOffered(getModel(id)), id).toBe(true);
    expect(workbenchGenerationModels().some((m) => m.id === id), id).toBe(true);
  }
  expect(displayModelName(KLING4)).toBe("Kling 4.0");
  expect(engineLabel(KLING4)).toEqual({ short: "K 4.0", long: "Kling 4.0" });
});

test("the Kling 4.0 rate is a placeholder marked TO CONFIRM (the plan holds none), equal to 3.0 Pro's; a finished take is priced from its own parameters per second", async () => {
  const { estimateCostUsd } = await import("../../lib/vendorPricing");
  const at = (id: string, audio: boolean) => estimateCostUsd(id, "1080p", "16:9", 5, 0, false, { audio, task: "generate", settle: true })?.net;
  expect(at(KLING4, true)).toBeCloseTo(0.168 * 5, 6);
  expect(at(KLING4, false)).toBeCloseTo(0.112 * 5, 6);
  expect(at(KLING4, true)).toBe(at(KLING3_PRO, true));
  const rates = readFileSync("lib/vendorRates.ts", "utf8");
  expect(rates).toMatch(/Kling 4\.0 on fal\. \*\*TO CONFIRM, and a PLACEHOLDER: the plan[\s\S]{0,900}"fal-ai\/kling-video\/v4\/pro": \{/);
  const models = readFileSync("lib/models.ts", "utf8");
  expect(models).toMatch(/TO\s+\* CONFIRM against fal's own listing before KLING4_ENABLED is set/);
});

test("no price without the switch AND the confirmation: the quote helpers (the planned budget, the preview batch, any estimate) return none for Kling 4.0 for a customer who names the id, for an unconfirmed row even for the house, and a finished take is still priced", async () => scope("k4-price", async () => {
  const { estimateCostUsd } = await import("../../lib/vendorPricing");
  const { plannedTakeUsd } = await import("../../lib/shotBudgetCost");
  const { previewPlan } = await import("../../lib/previewCost");
  const { falVideoCostUsd } = await import("../../lib/falVideo");
  const { modelGateClosed } = await import("../../lib/modelGate");
  const { requireTenant } = await import("../../lib/tenant");
  const quote = () => estimateCostUsd(KLING4, "1080p", "16:9", 5, 0, false, { audio: true, task: "generate" });
  const none = () => {
    expect(quote()).toBeNull();
    expect(plannedTakeUsd(5, KLING4)).toBe(0);
    expect(previewPlan(KLING4, "1080p", 5).perClipUsd).toBe(0);
  };
  /* A settled take is priced from its own recorded parameters in every state below. */
  const settled = () => expect(falVideoCostUsd(KLING4, { resolution: "1080p", ratio: "16:9", duration: 5, generateAudio: true, watermark: false })).toBeCloseTo(0.84, 6);
  /* Nobody has asked the gate: no price, and the catalogue's other models are unaffected. */
  none(); settled();
  expect(estimateCostUsd(KLING3_PRO, "1080p", "16:9", 5, 0, false, { audio: true, task: "generate" })?.net).toBeCloseTo(0.84, 6);
  /* The row is unconfirmed as it ships: switch on and the workspace listed, still no price. */
  process.env.KLING4_ENABLED = "1";
  const restore = await listWorkspaces([requireTenant().id]);
  try {
    expect(await modelGateClosed(KLING4)).toBe("Kling 4.0 isn't available yet.");
    none(); settled();
    await whileConfirmed(async () => {
      /* Confirmed and listed, switch on: priced, for this workspace in this request. */
      expect(await modelGateClosed(KLING4)).toBeNull();
      expect(quote()?.net).toBeCloseTo(0.84, 6);
      expect(plannedTakeUsd(5, KLING4)).toBeCloseTo(0.56, 6);
      expect(previewPlan(KLING4, "1080p", 5).perClipUsd).toBeGreaterThan(0);
      settled();
      /* The switch off again: the next time the gate is asked, no price. */
      delete process.env.KLING4_ENABLED;
      expect(await modelGateClosed(KLING4)).toBe("There is no such model here.");
      none(); settled();
    });
  } finally { await restore(); }
  /* A customer workspace that is not listed names the id with the switch on and the row confirmed: no price. */
  process.env.KLING4_ENABLED = "1";
  await whileConfirmed(async () => {
    expect(await modelGateClosed(KLING4)).toBe("There is no such model here.");
    none(); settled();
  });
}));

test("the browser's rate table carries the Kling 4.0 rate only while its switch is open for the workspace; the catalogue's table is unchanged", async () => {
  const { buildRateTable } = await import("../../lib/rateTable.server");
  const { VENDOR_RATES, GATED_VENDOR_RATES } = await import("../../lib/vendorRates");
  expect(Object.keys(VENDOR_RATES)).not.toContain(KLING4);
  expect(Object.keys(GATED_VENDOR_RATES)).toEqual([KLING4]);
  const closed = buildRateTable("usd");
  expect(Object.keys(closed.models)).not.toContain(KLING4);
  expect(Object.keys(buildRateTable("usd", ["fal-ai/not-a-model"]).models)).toEqual(Object.keys(closed.models));
  const open = buildRateTable("usd", [KLING4]);
  expect(open.models[KLING4].secondRates).toEqual([{ resolutions: ["1080p"], withoutAudio: 0.112, withAudio: 0.168 }]);
  expect(Object.keys(open.models).filter((id) => id !== KLING4)).toEqual(Object.keys(closed.models));
  /* In credits it is scaled by the engine's margin like every other row. */
  expect(buildRateTable("cr", [KLING4]).models[KLING4].secondRates![0].withAudio).toBeGreaterThan(0.168);
});

test("it goes to the fal endpoint it is declared at, by the same rule as Kling 3.0: text-to-video, or image-to-video from a first frame", async () => {
  const { getModel } = await import("../../lib/models");
  const { falEndpointFor } = await import("../../lib/falVideo");
  expect(falEndpointFor(getModel(KLING4), "generate", false)).toBe("fal-ai/kling-video/v4/pro/text-to-video");
  expect(falEndpointFor(getModel(KLING4), "generate", true)).toBe("fal-ai/kling-video/v4/pro/image-to-video");
  expect(falEndpointFor(getModel(KLING3_PRO), "generate", false)).toBe("fal-ai/kling-video/v3/pro/text-to-video");
});

test("the gate (once the row is confirmed): closed unless the switch is exactly 1 AND the workspace is the house or listed; models without a gate are never gated", async () => scope("k4-gate", async () => whileConfirmed(async () => {
  const { openGates, openGatedModels, modelGateClosed, GATE_CLOSED } = await import("../../lib/modelGate");
  const { requireTenant } = await import("../../lib/tenant");
  const customer = requireTenant().id;
  /* No switch, or anything but "1": closed everywhere, even for the house. */
  delete process.env.KLING4_ENABLED;
  for (const odd of [undefined, "", "0", "true", "yes", "on"]) {
    if (odd === undefined) delete process.env.KLING4_ENABLED; else process.env.KLING4_ENABLED = odd;
    expect(await modelGateClosed(KLING4), String(odd)).toBe(GATE_CLOSED);
    expect(await modelGateClosed(KLING4, { id: "ws_legacy" }), String(odd)).toBe(GATE_CLOSED);
    expect([...(await openGates())], String(odd)).toEqual([]);
    expect(await openGatedModels()).toEqual([]);
  }
  process.env.KLING4_ENABLED = "1";
  /* On: the house, yes; a customer workspace not listed, no. */
  expect(await modelGateClosed(KLING4, { id: "ws_legacy" })).toBeNull();
  expect([...(await openGates({ id: "ws_legacy" }))]).toEqual(["KLING4_ENABLED"]);
  expect((await openGatedModels({ id: "ws_legacy" })).map((m) => m.id)).toEqual([KLING4]);
  expect(await modelGateClosed(KLING4)).toBe(GATE_CLOSED);
  expect(await openGatedModels()).toEqual([]);
  /* Listed: open for that workspace only. */
  const restore = await listWorkspaces([customer]);
  try {
    expect(await modelGateClosed(KLING4)).toBeNull();
    expect((await openGatedModels()).map((m) => m.id)).toEqual([KLING4]);
    expect(await modelGateClosed(KLING4, { id: "ws_someone_else" })).toBe(GATE_CLOSED);
  } finally { await restore(); }
  /* A model with no gate, a model that is not in the registry and nothing at all are never refused by the gate. */
  delete process.env.KLING4_ENABLED;
  expect(await modelGateClosed(KLING3_PRO)).toBeNull();
  expect(await modelGateClosed("not-a-model")).toBeNull();
  expect(await modelGateClosed(null)).toBeNull();
})));

test("admission (once the row is confirmed): closed, a Kling 4.0 request is refused before anything is priced, held, written or sent; open (listed), it is quoted like any fal clip; Kling 3.0 Pro is unaffected", async () => scope("k4-admission", async (service) => whileConfirmed(async () => {
  const { requireTenant } = await import("../../lib/tenant");
  const body = { model: KLING4, prompt: "raw: A street", resolution: "1080p", ratio: "16:9", duration: 5, projectId: "project" };
  delete process.env.KLING4_ENABLED;
  const closed = await service.gen.prepareGeneration(body, actor);
  expect(closed.ok).toBe(false);
  if (!closed.ok) { expect(closed.status).toBe(404); expect(closed.body.error).toBe("There is no such model here."); }
  process.env.KLING4_ENABLED = "1";
  const unlisted = await service.gen.prepareGeneration(body, actor);
  expect(unlisted.ok).toBe(false);
  if (!unlisted.ok) expect(unlisted.status).toBe(404);
  expect(await rows()).toHaveLength(0);
  expect(await meters()).toHaveLength(0);
  expect(dispatched).toHaveLength(0);
  /* A request that is not about Kling 4.0 is not touched by the gate. */
  const pro = await service.gen.prepareGeneration({ ...body, model: KLING3_PRO }, actor);
  const proQuote = value(pro).quote.estimatedCredits;
  const restore = await listWorkspaces([requireTenant().id]);
  try {
    const open = value(await service.gen.prepareGeneration(body, actor));
    expect(open.quote.estimatedCredits).toBeGreaterThan(0);
    /* The same rate as Kling 3.0 Pro until the lead replaces the placeholder: the quote is the same. */
    expect(open.quote.estimatedCredits).toBe(proQuote);
  } finally { await restore(); }
  expect(await rows()).toHaveLength(0);
  expect(await meters()).toHaveLength(0);
  expect(dispatched).toHaveLength(0);
})));

test("unconfirmed: Kling 4.0 is not on fal as of 16 Oct 2026, so its row is confirmed:false and it cannot be listed or asked for even with KLING4_ENABLED=1, for the house or a listed workspace", async () => scope("k4-unconfirmed", async (service) => {
  const { GATED_VENDOR_RATES } = await import("../../lib/vendorRates");
  const { modelGateClosed, openGatedModels, openGates, isConfirmed, unavailableYet } = await import("../../lib/modelGate");
  const { requireTenant } = await import("../../lib/tenant");
  expect(GATED_VENDOR_RATES[KLING4].confirmed).toBe(false);
  expect(isConfirmed(KLING4)).toBe(false);
  expect(unavailableYet(KLING4)).toBe("Kling 4.0 isn't available yet.");
  const body = { model: KLING4, prompt: "raw: A street", resolution: "1080p", ratio: "16:9", duration: 5, projectId: "project" };
  const restore = await listWorkspaces([requireTenant().id]);
  try {
    for (const switchValue of [undefined, "0", "1"]) {
      if (switchValue === undefined) delete process.env.KLING4_ENABLED; else process.env.KLING4_ENABLED = switchValue;
      /* The house and a listed workspace alike. */
      expect(await modelGateClosed(KLING4, { id: "ws_legacy" }), String(switchValue)).toBe("Kling 4.0 isn't available yet.");
      expect(await modelGateClosed(KLING4), String(switchValue)).toBe("Kling 4.0 isn't available yet.");
      expect(await openGatedModels({ id: "ws_legacy" })).toEqual([]);
      expect(await openGatedModels()).toEqual([]);
      expect([...(await openGates())]).toEqual([]);
    }
    process.env.KLING4_ENABLED = "1";
    const refused = await service.gen.prepareGeneration(body, actor);
    expect(refused.ok).toBe(false);
    if (!refused.ok) { expect(refused.status).toBe(404); expect(refused.body.error).toBe("Kling 4.0 isn't available yet."); }
    expect(await rows()).toHaveLength(0);
    expect(await meters()).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    /* Kling 3.0 Pro is unaffected. */
    expect((await service.gen.prepareGeneration({ ...body, model: KLING3_PRO }, actor)).ok).toBe(true);
  } finally { await restore(); }
}));

const gate0 = () => readFileSync("lib/modelGate.ts", "utf8");

test("structure: the gate is checked in admission before the identity, the price and the reservation; the two composer lists add the model only through openGatedModels; the registry's own lists never hold it", () => {
  const admission = readFileSync("lib/generationAdmission.ts", "utf8");
  const at = (needle: string) => admission.indexOf(needle);
  expect(at("await modelGateClosed(modelId)")).toBeGreaterThan(0);
  expect(at("const retired = retiredReason(modelId)")).toBeLessThan(at("await modelGateClosed(modelId)"));
  expect(at("await modelGateClosed(modelId)")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("await modelGateClosed(modelId)")).toBeLessThan(at("allowanceCheck(renderKeyNameFor("));
  expect(readFileSync("app/api/workbench/engines/route.ts", "utf8")).toContain("workbenchGenerationModels(undefined, await openGatedModels())");
  expect(readFileSync("app/api/engines/route.ts", "utf8")).toContain(".concat(gated.filter((m) => m.provider === p.id)");
  /* The registry array itself carries no gated model, so a list that walks it cannot offer one. */
  const models = readFileSync("lib/models.ts", "utf8");
  expect(models.slice(0, models.indexOf("export const GATED_MODELS"))).not.toContain("gate:");
  /* The placeholder is unconfirmed in the code that ships, and the gate reads that before the switch. */
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/Kling 4\.0 is not on fal as of 16 Oct 2026[\s\S]{0,500}confirmed: false,/);
  expect(gate0()).toMatch(/if \(!isConfirmed\(model\.id\)\) return unavailableYet\(model\.id\);\s+return/);
  expect(gate0()).toContain("m.gate && isConfirmed(m.id)");
  /* One new setting, the plan's own name; no other. */
  const gate = readFileSync("lib/modelGate.ts", "utf8");
  expect([...gate.matchAll(/process\.env\.([A-Z_0-9]+)/g)].map((m) => m[1])).toEqual([]);
  expect([...models.matchAll(/gate: "([A-Z_0-9]+)"/g)].map((m) => m[1])).toEqual(["KLING4_ENABLED"]);
});
