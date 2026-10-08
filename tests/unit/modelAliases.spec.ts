import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { CatalogModel, CatalogSnapshot } from "../../lib/catalog";
import { textQuoteCostUsd } from "../../lib/catalog";
import { DROPPED_MODEL_IDS, MODEL_ALIASES, aliasModel, isDroppedModel } from "../../lib/modelAliases";
import {
  ATOMIK_AUTO_MODEL_IDS, ATOMIK_MODEL_IDS, VERIFIED_TEXT_MODEL_IDS, isAtomikModel, savedAtomikChoice, selectAtomikModel,
} from "../../lib/atomikModelPolicy";
import { ENHANCER_MODELS } from "../../lib/shell/enhancer";
import { DEFAULT_TEXT_MODELS, TEXT_MODEL_IDS, cleanModels, mergeLayer, textModelFor } from "../../lib/platformLayer";
import { OFFERED_CATALOG_IDS, PRICED_TEXT_IDS, SNAPSHOT_CATALOG_IDS } from "../../lib/catalogOffered";
import { atomikEffortOptions } from "../../lib/atomik-reasoning";
import committedJson from "../../lib/modelCatalog.json";

/*
 * The model ids providers do not serve on a direct call (owner, 8 October
 * 2026) are on no menu, default or Auto list; a saved choice naming one reads
 * as its alias at every read point, and the alias is what is quoted.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-model-aliases-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const committed = committedJson as unknown as CatalogSnapshot;
const entry = (id: string): CatalogModel => {
  const m = committed.models.find((x) => x.id === id);
  if (!m) throw new Error(`${id} is not in lib/modelCatalog.json`);
  return m as CatalogModel;
};
const efforts = (id: string) => atomikEffortOptions(entry(id)).map((o) => o.value);

function workspace(): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: "unit", name: "Unit", legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: { gateway: "test-only-never-sent" }, usesPlatformKeys: false, allowanceUsd: null,
    gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null } as TenantWorkspace;
}
async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(workspace(), fn);
}

test("the alias map: nine dropped ids, each moved to an offered model of the same provider, priced in the catalogue", () => {
  expect(MODEL_ALIASES).toEqual({
    "anthropic/claude-opus-4.8-fast": "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-5-fast": "anthropic/claude-opus-5",
    "anthropic/claude-3-haiku": "anthropic/claude-haiku-4.5",
    "openai/gpt-5-pro": "openai/gpt-5",
    "openai/gpt-5.2-pro": "openai/gpt-5.2",
    "openai/gpt-5.4-pro": "openai/gpt-5.4",
    "openai/gpt-5.5-pro": "openai/gpt-5.5",
    "openai/gpt-oss-20b": "openai/gpt-5-nano",
    "openai/o3-pro": "openai/o3",
  });
  for (const [from, to] of Object.entries(MODEL_ALIASES)) {
    expect(isDroppedModel(to), to).toBe(false);
    expect(to.split("/")[0], from).toBe(from.split("/")[0]);
    expect(isAtomikModel(to), to).toBe(true);
    const m = entry(to);
    expect(Number(m.pricing?.input), to).toBeGreaterThan(0);
    expect(Number(m.pricing?.output), to).toBeGreaterThan(0);
    // Quotable on the door it runs through: the gateway, and for OpenAI the direct key (which needs a cached-input price).
    expect(textQuoteCostUsd(m, 10_000, 1_000), to).toBeGreaterThan(0);
    if (to.startsWith("openai/")) expect(textQuoteCostUsd(m, 10_000, 1_000, true), to).toBeGreaterThan(0);
    // A saved effort stays valid: the alias offers every setting the dropped model did.
    for (const value of efforts(from)) expect(efforts(to), `${from} ${value}`).toContain(value);
  }
  expect(aliasModel("anthropic/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
  expect(aliasModel("auto")).toBe("auto");
  expect(aliasModel(null)).toBeNull();
  expect(aliasModel("toString")).toBe("toString");
});

test("the owner's report script counts exactly the dropped ids", async () => {
  const script = await import("../../scripts/ops/model-references.mjs");
  expect([...script.DROPPED_MODEL_IDS].sort()).toEqual([...DROPPED_MODEL_IDS].sort());
});

test("no offered list, default or Auto list names a dropped id; the catalogue keeps their prices for old ledger rows", async () => {
  const { FEATURED } = await import("../../lib/catalog");
  const { GATEWAY_MODELS } = await import("../../lib/enhance");
  const { atomikModels } = await import("../../lib/workbench/atomik-server");
  const { developmentModels } = await import("../../lib/workbench/development-server");
  const saved = process.env.GATEWAY_PROMPT_MODELS;
  delete process.env.GATEWAY_PROMPT_MODELS;
  const everything = committed.models as CatalogModel[];
  const lists: Record<string, readonly string[]> = {
    VERIFIED_TEXT_MODEL_IDS, ATOMIK_MODEL_IDS, ATOMIK_AUTO_MODEL_IDS, "FEATURED.planner": FEATURED.planner,
    ENHANCER_MODELS: Object.values(ENHANCER_MODELS).flat(), DEFAULT_TEXT_MODELS: Object.values(DEFAULT_TEXT_MODELS),
    TEXT_MODEL_IDS, PRICED_TEXT_IDS, OFFERED_CATALOG_IDS, GATEWAY_MODELS: GATEWAY_MODELS(),
    "atomikModels(catalogue)": atomikModels(everything).map((m) => m.id),
    "developmentModels(catalogue)": developmentModels(everything).map((m) => m.id),
  };
  if (saved === undefined) delete process.env.GATEWAY_PROMPT_MODELS; else process.env.GATEWAY_PROMPT_MODELS = saved;
  for (const [name, ids] of Object.entries(lists)) expect(ids.filter(isDroppedModel), name).toEqual([]);
  for (const id of DROPPED_MODEL_IDS) {
    expect(SNAPSHOT_CATALOG_IDS, id).toContain(id);
    expect(textQuoteCostUsd(entry(id), 10_000, 1_000), id).toBeGreaterThan(0);
  }
});

test("Auto keeps its Claude choices without GPT-5.5 Pro, and never plans on a dropped id", async () => {
  expect([...ATOMIK_AUTO_MODEL_IDS]).toEqual(["anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.7", "anthropic/claude-opus-4.6"]);
  const { selectPlannerModel } = await import("../../lib/workbench/rig-agent-planner");
  const { atomikModels } = await import("../../lib/workbench/atomik-server");
  const openaiOnly = atomikModels(["openai/gpt-5.5-pro", "openai/gpt-5.5"].map(entry));
  expect(openaiOnly.map((m) => m.id)).toEqual(["openai/gpt-5.5"]);
  expect(selectPlannerModel("auto", openaiOnly)).toBe("openai/gpt-5.5");
  expect(selectPlannerModel("auto", atomikModels(["openai/gpt-5.5-pro", "openai/gpt-5.5", "anthropic/claude-sonnet-4.6"].map(entry)))).toBe("anthropic/claude-sonnet-4.6");
  expect(selectAtomikModel("auto", ["openai/gpt-5.5-pro", "openai/gpt-5.5"])).toBe("openai/gpt-5.5");
});

test("each read point resolves a dropped id to its alias before the check, without refusing or falling back", async () => {
  /* atomik_chats.model (and a request's model): Atomik's saved choice and selection. */
  for (const [from, to] of Object.entries(MODEL_ALIASES)) {
    expect(savedAtomikChoice(from), from).toEqual({ model: to, note: null });
    expect(selectAtomikModel(from, [to]), from).toBe(to);
  }
  /* The platform's routing, passed in as Auto's route. */
  expect(selectAtomikModel("auto", ["openai/gpt-5.5", "anthropic/claude-sonnet-4.6"], "openai/gpt-5.5-pro")).toBe("openai/gpt-5.5");
  /* rig_agent_runs.model: read again when a board plan is priced and approved. */
  const { selectPlannerModel } = await import("../../lib/workbench/rig-agent-planner");
  expect(selectPlannerModel("openai/o3-pro", [{ id: "openai/o3" }])).toBe("openai/o3");
  expect(selectPlannerModel("anthropic/claude-opus-5-fast", [{ id: "anthropic/claude-opus-5" }])).toBe("anthropic/claude-opus-5");
  /* platform_layer "models".text: cleaned on read, and the route read from it. */
  const stored = { text: { enhance: "anthropic/claude-3-haiku", idea: "anthropic/claude-opus-5-fast", shot: "openai/gpt-5.5-pro" } };
  expect(cleanModels(stored).text).toEqual({ enhance: "anthropic/claude-haiku-4.5", idea: "anthropic/claude-opus-5", shot: DEFAULT_TEXT_MODELS.shot });
  expect(mergeLayer({ models: stored }).models.text.enhance).toBe("anthropic/claude-haiku-4.5");
  expect(textModelFor(stored, "shot")).toBe("openai/gpt-5.5");
  /* GATEWAY_PROMPT_MODELS: the env default. */
  const { GATEWAY_MODELS } = await import("../../lib/enhance");
  const saved = process.env.GATEWAY_PROMPT_MODELS;
  process.env.GATEWAY_PROMPT_MODELS = "openai/o3-pro, anthropic/claude-3-haiku";
  try { expect(GATEWAY_MODELS()).toEqual(["openai/o3", "anthropic/claude-haiku-4.5"]); }
  finally { if (saved === undefined) delete process.env.GATEWAY_PROMPT_MODELS; else process.env.GATEWAY_PROMPT_MODELS = saved; }
  /* ideas.model. */
  const { rowToIdea } = await import("../../lib/atomikDocs");
  expect(rowToIdea({ id: "i", model: "openai/gpt-oss-20b" }).model).toBe("openai/gpt-5-nano");
});

test("a chat and an idea saved on a dropped id read as the alias; the stored rows are not rewritten; a new pick is saved as the alias", async () => {
  await inTenant(async () => {
    const { db, ready } = await import("../../lib/db");
    const { getChat, listChats, patchChat } = await import("../../lib/atomik");
    const { createIdea, getIdea } = await import("../../lib/atomikDocs");
    await ready();
    await db().execute({
      sql: `INSERT INTO atomik_chats (id, project_id, title, model, effort, agent_mode, status, text_cost_usd, created_by, created_at, updated_at, deleted) VALUES (?,NULL,'Chat',?,?,'ask','idle',0,'owner',1,1,0)`,
      args: ["pro", "openai/gpt-5.5-pro", "high"],
    });
    const loaded = (await getChat("pro"))!;
    expect(loaded.chat).toMatchObject({ model: "openai/gpt-5.5", effort: "high" });
    expect(loaded.chat.modelNote).toBeUndefined();
    expect((await listChats()).find((c) => c.id === "pro")).toMatchObject({ model: "openai/gpt-5.5" });
    expect((await db().execute({ sql: "SELECT model FROM atomik_chats WHERE id = ?", args: ["pro"] })).rows[0]).toMatchObject({ model: "openai/gpt-5.5-pro" });
    await patchChat("pro", { model: "anthropic/claude-opus-4.8-fast" });
    expect((await db().execute({ sql: "SELECT model FROM atomik_chats WHERE id = ?", args: ["pro"] })).rows[0]).toMatchObject({ model: "anthropic/claude-opus-4.8" });

    const idea = await createIdea({ logline: "A lighthouse keeper", tone: [], refs: [], model: "openai/o3-pro", createdBy: "owner" });
    expect(idea.model).toBe("openai/o3");
    await db().execute({ sql: "UPDATE ideas SET model = ? WHERE id = ?", args: ["anthropic/claude-3-haiku", idea.id] });
    expect((await getIdea(idea.id))!.model).toBe("anthropic/claude-haiku-4.5");
  });
});

test("a quote for a dropped id is the alias's quote: the model that runs is the model priced", async () => {
  const { seedProject } = await import("../../lib/workbench/studio");
  const { atomikRequestSchema, quoteAtomikJob } = await import("../../lib/workbench/atomik-server");
  const { quoteDevelopmentJob } = await import("../../lib/workbench/development-server");
  const models = ["openai/gpt-5.5-pro", "openai/gpt-5.5", "anthropic/claude-opus-5-fast", "anthropic/claude-opus-5"].map(entry);
  await inTenant(async () => {
    const { db, ready } = await import("../../lib/db");
    await ready(); await fundFixtureWorkspace();
    const project = seedProject();
    project.id = "aliases-" + randomUUID();
    project.productionProjectId = "real-" + randomUUID();
    project.script = "EXT. DUNES - DAY\nWren follows her reflection.";
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: ["owner:" + project.id, "owner", project.id, project.name, JSON.stringify(project), Date.now()] });

    /* The workbench agent (workbench_atomik_jobs, and a pending request saved by an older page). */
    const deps = {
      models: async () => models, allowance: async () => ({ ok: true as const }),
      assertFunding: async () => {}, runAstra: async () => { throw new Error("no call"); }, runSuite: async () => { throw new Error("no call"); },
      limits: async () => ({ allow: true as const, limits: { concurrency: 3, rendersPerHour: 30, storageBytes: 1e6 }, standing: { running: 0, startedLastHour: 0, usedBytes: 0 } }),
      reserve: async () => { throw new Error("a quote reserves nothing"); }, meter: async () => { throw new Error("a quote meters nothing"); },
      auth: async () => ({}), run: async () => { throw new Error("a quote sends nothing"); },
    };
    const ask = (model: string) => atomikRequestSchema.parse({ projectId: project.id, requestId: randomUUID(), request: "Make a shot proposal", model, depth: "Quick", refs: [] });
    for (const [from, to] of [["openai/gpt-5.5-pro", "openai/gpt-5.5"], ["anthropic/claude-opus-5-fast", "anthropic/claude-opus-5"]]) {
      const dropped = await quoteAtomikJob(ask(from), "owner", deps as never);
      const alias = await quoteAtomikJob(ask(to), "owner", deps as never);
      expect(dropped.model, from).toBe(to);
      expect(dropped.estimateUsd, from).toBe(alias.estimateUsd);
      expect(dropped.estimateCredits, from).toBe(alias.estimateCredits);
    }
    /* The dropped model's own price is not the one used: GPT-5.5 Pro costs several times more. */
    const pro = textQuoteCostUsd(entry("openai/gpt-5.5-pro"), 10_000, 1_000)!, base = textQuoteCostUsd(entry("openai/gpt-5.5"), 10_000, 1_000)!;
    expect(pro).toBeGreaterThan(base * 2);

    /* The development agent. */
    const devDeps = {
      models: async () => models, allowance: async () => ({ ok: true as const }),
      auth: async () => ({ token: "test-only-not-sent", method: "api-key" }), funding: async () => {}, reservation: async () => true,
      reserve: async () => { throw new Error("a quote reserves nothing"); }, meter: async () => { throw new Error("a quote meters nothing"); },
      call: async () => { throw new Error("a quote sends nothing"); },
    };
    const develop = (model: string) => ({ projectId: project.id, requestId: randomUUID(), kind: "screenplay" as const, model, effort: "high" });
    const dropped = await quoteDevelopmentJob(develop("openai/gpt-5.5-pro"), "owner", devDeps as never);
    const alias = await quoteDevelopmentJob(develop("openai/gpt-5.5"), "owner", devDeps as never);
    expect(dropped.model).toBe("openai/gpt-5.5");
    expect(dropped.estimateUsd).toBe(alias.estimateUsd);
    expect(dropped.estimateCredits).toBe(alias.estimateCredits);
  });
});
