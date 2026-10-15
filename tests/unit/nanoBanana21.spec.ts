import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * Nano Banana 2.1 beside Pro and 2 (docs/redesign-plan.md, the 15 Oct 22:15 stack, Slice 3, plan N1): a model row, a rate row and a switch of its own,
 * NANOBANANA21_ENABLED. Mocked: nothing is called and nothing is paid; admission is only prepared (free, repeatable). Local temporary databases only.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-nb21-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const actor: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } };
const ID = "gemini-nano-banana-2.1";
test.afterEach(() => { delete process.env.NANOBANANA21_ENABLED; });

test("the model row: its own id, name and sizes (no 512), hidden from every static menu, behind its switch", async () => {
  const models = await import("../../lib/models");
  const { workbenchGenerationModels } = await import("../../lib/workbench/media-quote");
  const { shotEngines } = await import("../../lib/workspace/engines");
  const { ownGenerateEngines } = await import("../../lib/atomik");
  expect(models.NANO_BANANA_21_ID).toBe(ID);
  const row = models.getModel(ID);
  expect(row).toMatchObject({ id: ID, label: "Nano Banana 2.1", short: "NB 2.1", family: "nano-banana", provider: "google", kind: "image", billing: "image", hidden: true, engineSwitch: "NANOBANANA21_ENABLED", maxReferenceImages: 14 });
  expect(row.resolutions).toEqual(["1K", "2K", "4K"]);
  expect(row.gatewayId).toBeUndefined();
  /* Its name is its own everywhere a name is made (not "Nano Banana 2"). */
  expect(models.displayModelName(ID)).toBe("Nano Banana 2.1");
  expect(models.displayModelName("gemini-3.1-flash-image")).toBe("Nano Banana 2");
  /* No static menu lists it: only the lists a workspace with the switch on reads add it. */
  expect(workbenchGenerationModels().some((m) => m.id === ID)).toBe(false);
  expect(shotEngines().some((m) => m.id === ID)).toBe(false);
  expect(ownGenerateEngines().some((m) => m.id === ID)).toBe(false);
  expect(models.offeredModels().filter((m) => !m.hidden).some((m) => m.id === ID)).toBe(false);
  /* The other rows are unchanged, and only this one carries a switch. */
  expect(models.MODELS.filter((m) => m.engineSwitch).map((m) => m.id)).toEqual([ID]);
  expect(models.getModel(models.NANO_BANANA_2_ID).resolutions).toEqual(["512", "1K", "2K", "4K"]);
});

test("the prices: Google's output rows (verified 16 Oct 2026) and the conservative reference figure, through the existing price path; cheaper than Nano Banana 2 at every size it shares", async () => {
  const { estimateImageCostUsd } = await import("../../lib/vendorPricing");
  const { quotedCredits } = await import("../../lib/credits");
  const at = (size: string, refs = 0) => estimateImageCostUsd(ID, size, refs)?.net ?? null;
  expect(at("1K")).toBeCloseTo(0.0336, 9);
  expect(at("2K")).toBeCloseTo(0.0504, 9);
  /* The page shows $0.113 for 4K; 3780 tokens at $30 per 1M is $0.1134, the figure used so a quote is never under. */
  expect(at("4K")).toBeCloseTo(0.1134, 9);
  expect(at("4K")!).toBeGreaterThanOrEqual(0.113);
  /* 1120 / 1680 / 3780 tokens at $30 per 1M image tokens. */
  expect(at("1K")).toBeCloseTo((1120 * 30) / 1e6, 9);
  expect(at("2K")).toBeCloseTo((1680 * 30) / 1e6, 9);
  expect(at("4K")).toBeCloseTo((3780 * 30) / 1e6, 9);
  /* No 512 price is listed: not priced, not offered. */
  expect(at("512")).toBeNull();
  /* A reference image in: 1120 tokens at $1.50 per 1M ($0.00168), the figure used while Google publishes none for 2.1 (TO CONFIRM). */
  expect(at("1K", 3)).toBeCloseTo(0.0336 + 3 * 0.00168, 9);
  expect((1120 * 1.5) / 1e6).toBeCloseTo(0.00168, 9);
  for (const size of ["1K", "2K", "4K"]) expect(at(size)!).toBeLessThan(estimateImageCostUsd("gemini-3.1-flash-image", size, 0)!.net);
  expect(estimateImageCostUsd(ID, "1K", 14)!.net).toBeLessThan(estimateImageCostUsd("gemini-3-pro-image", "1K", 14)!.net);
  /* The customer price is these through the margin table, a whole number of credits, never under. */
  for (const size of ["1K", "2K", "4K"]) expect(Number.isInteger(quotedCredits(at(size)!, ID))).toBe(true);
  const rates = readFileSync("lib/vendorRates.ts", "utf8");
  expect(rates).toMatch(/verified against Google's pricing page, 16 Oct 2026; confirm against the first invoice[\s\S]{0,900}"gemini-nano-banana-2\.1"/);
  expect(rates).toMatch(/TO CONFIRM against the first invoice[\s\S]{0,300}"gemini-nano-banana-2\.1"/);
});

async function withSite<T>(workspaces: string[], fn: () => Promise<T>): Promise<T> {
  const { platformReady, platformDb } = await import("../../lib/platform");
  await platformReady();
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: workspaces })] });
    return await fn();
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
}
async function inWorkspace(id: string, fn: () => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`] });
  if (id !== "ws_legacy") await grantCredits(id, 10000, "Test", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no network in this test"); }) as never;
  try {
    await runInTenant(ws, async () => {
      await ready();
      await db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('project','Project',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      await fn();
    }, actor);
  } finally { globalThis.fetch = realFetch; }
}
const body = (extra: Record<string, unknown> = {}) => ({ model: ID, prompt: "A crane at dawn", resolution: "1K", ratio: "16:9", projectId: "project", ...extra });

test("the switch: off for everyone unless it is exactly 1; then on for the house and the listed workspaces only; never for a customer", async () => {
  const { gatedModelsHere, gatedModelRefusal, gatedModelOn } = await import("../../lib/engineModels");
  const models = await import("../../lib/models");
  await withSite(["ws_nb21_listed"], async () => {
    for (const [id, onWhenSwitched] of [["ws_legacy", true], ["ws_nb21_listed", true], ["ws_nb21_customer", false]] as const) {
      await inWorkspace(id, async () => {
        for (const value of [undefined, "0", "true", "yes", "1 ", ""]) {
          if (value === undefined) delete process.env.NANOBANANA21_ENABLED; else process.env.NANOBANANA21_ENABLED = value;
          expect(await gatedModelsHere(), `${id} ${String(value)}`).toEqual([]);
          expect(await gatedModelRefusal(ID), `${id} ${String(value)}`).toBe(`Unknown model: ${ID}`);
        }
        process.env.NANOBANANA21_ENABLED = "1";
        expect((await gatedModelsHere()).map((m) => m.id), id).toEqual(onWhenSwitched ? [ID] : []);
        expect(await gatedModelRefusal(ID), id).toBe(onWhenSwitched ? null : `Unknown model: ${ID}`);
        expect(await gatedModelOn(models.getModel(ID)), id).toBe(onWhenSwitched);
        /* A model without a switch is untouched, and so is an id that is not there. */
        expect(await gatedModelRefusal("gemini-3.1-flash-image")).toBeNull();
        expect(await gatedModelRefusal("nope")).toBeNull();
        expect(await gatedModelRefusal(undefined)).toBeNull();
      });
    }
  });
});

test("admission: refused as an unknown id where it is off (nothing priced, held or written), taken where it is on, 512 never; the quote is the existing price path", async () => {
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  const { billCredits } = await import("../../lib/creditTerms");
  const { db } = await import("../../lib/db");
  await withSite(["ws_nb21_listed"], async () => {
    /* The switch off: even the house is told it is not a model. */
    await inWorkspace("ws_legacy", async () => {
      delete process.env.NANOBANANA21_ENABLED;
      const off = await prepareGeneration(body(), actor);
      expect(off).toMatchObject({ ok: false });
      expect(JSON.stringify(off)).toContain(`Unknown model: ${ID}`);
    });
    process.env.NANOBANANA21_ENABLED = "1";
    await inWorkspace("ws_nb21_customer", async () => {
      const before = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const refused = await prepareGeneration(body(), actor);
      expect(refused).toMatchObject({ ok: false });
      expect(JSON.stringify(refused)).toContain(`Unknown model: ${ID}`);
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(before);
      /* The model Nano Banana 2 is untouched for the same customer. */
      expect(await prepareGeneration(body({ model: "gemini-3.1-flash-image" }), actor)).toMatchObject({ ok: true });
    });
    for (const id of ["ws_legacy", "ws_nb21_listed"]) {
      await inWorkspace(id, async () => {
        const ok = await prepareGeneration(body(), actor);
        expect(ok, id).toMatchObject({ ok: true });
        if (!ok.ok) throw new Error("not ok");
        const quote = ok.value.quote as { estimatedCredits?: number; price?: number; unit?: string };
        if (id === "ws_nb21_listed") {
          expect(quote).toMatchObject({ unit: "cr", estimatedCredits: billCredits(0.0336, ID) });
        } else expect(quote.price).toBeCloseTo(0.0336, 6);
        /* 512 is not one of its sizes: admission puts a size it does not offer back on a valid one (as for every image engine), so it is never priced at a 512 rate. */
        for (const resolution of ["512", "8K"]) {
          const other = await prepareGeneration(body({ resolution }), actor);
          if (!other.ok) throw new Error(`${id} ${resolution}`);
          expect(JSON.stringify(other.value.quote), `${id} ${resolution}`).toBe(JSON.stringify(quote));
          expect((other.value.compiled.params as { resolution?: string }).resolution, `${id} ${resolution}`).toBe("1K");
        }
        /* A larger size and a reference are priced from the same rows. */
        const big = await prepareGeneration(body({ resolution: "4K" }), actor);
        if (!big.ok) throw new Error("4K not ok");
        if (id !== "ws_nb21_listed") expect((big.value.quote as { price: number }).price).toBeCloseTo(0.1134, 6);
      });
    }
  });
});

test("a gated model later marked retired is listed nowhere and refused: gatedModelsHere filters on isOffered, and both engine lists filter again", async () => {
  const { gatedModelsHere, gatedModelRefusal } = await import("../../lib/engineModels");
  const models = await import("../../lib/models");
  const row = models.getModel(ID) as { retired?: true };
  process.env.NANOBANANA21_ENABLED = "1";
  await inWorkspace("ws_legacy", async () => {
    expect((await gatedModelsHere()).map((m) => m.id)).toEqual([ID]);
    row.retired = true;
    try {
      expect(await gatedModelsHere()).toEqual([]);
      /* Admission already refuses a retired id for new work (retiredReason), before the gate is asked. */
      expect(models.retiredReason(ID)).toBe(models.RETIRED_REASON);
      expect(await gatedModelRefusal(ID)).toBeNull();
    } finally { delete row.retired; }
    expect((await gatedModelsHere()).map((m) => m.id)).toEqual([ID]);
  });
  expect(readFileSync("app/api/engines/route.ts", "utf8")).toContain("gated.filter((m) => isOffered(m) && m.provider === p.id)");
  expect(readFileSync("app/api/workbench/engines/route.ts", "utf8")).toContain("(await gatedModelsHere()).filter(isOffered)");
});

test("structure: both engine lists add the gated models, admission asks the gate before it prices anything, and the switch is the plan's name", () => {
  expect(readFileSync("app/api/engines/route.ts", "utf8")).toContain(".concat(gated.filter((m) => isOffered(m) && m.provider === p.id)");
  expect(readFileSync("app/api/workbench/engines/route.ts", "utf8")).toContain("...(await gatedModelsHere())");
  const admission = readFileSync("lib/generationAdmission.ts", "utf8");
  expect(admission.indexOf("gatedModelRefusal(modelId)")).toBeGreaterThan(0);
  expect(admission.indexOf("gatedModelRefusal(modelId)")).toBeLessThan(admission.indexOf("const genjutsu = isGenjutsuModel(modelId);"));
  const models = readFileSync("lib/models.ts", "utf8");
  expect([...models.matchAll(/engineSwitch: "([A-Z0-9_]+)"/g)].map((m) => m[1])).toEqual(["NANOBANANA21_ENABLED"]);
  const gate = readFileSync("lib/engineModels.ts", "utf8");
  expect(gate).toContain('from "./engineGate"');
  expect(gate).not.toMatch(/process\.env/);
});
