import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A held take's snapshot carries the vendor's dollars (`estUsd`) beside the
 * credits the person was told (`needs`). Only the workspace's own unit may
 * reach the browser (§7A): credits on the platform's keys, dollars on its
 * own. The release still prices from the raw row.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-held-public-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

function workspace(name: string, credits: boolean): TenantWorkspace {
  return {
    id: `ws_${name}`, slug: name, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: credits, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 4, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}
const EST_USD = 1.37;
const heldRow = (id: string, status: string, why: "credits" | "slots") => ({
  id, kind: "video", provider: "byteplus", model: "dreamina-seedance-2-0-260128", prompt: "test", status,
  params: JSON.stringify({ ratio: "16:9", duration: 5, held: { estUsd: EST_USD, needs: 21, at: 1, why } }),
  created_at: 0, updated_at: 0,
});
const leaksDollars = (value: unknown) => {
  const json = JSON.stringify(value);
  return json.includes("estUsd") || json.includes(String(EST_USD));
};

test("a held take in a credit workspace reaches the browser with its credits and why, never the vendor's dollars", async () => {
  const { rowToGeneration } = await import("../../lib/jobs");
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("credit-map", true), async () => {
    // A discarded held take is cancelled with its snapshot still on it.
    for (const [status, why] of [["held", "credits"], ["held", "slots"], ["cancelled", "credits"]] as const) {
      const gen = rowToGeneration(heldRow(`gen_${status}_${why}`, status, why));
      expect(gen.params).toEqual({ ratio: "16:9", duration: 5, held: { why, needs: 21 } });
      expect(leaksDollars(gen)).toBe(false);
    }
  });
});

test("a workspace on its own keys keeps the dollars that are its own, and is not sent credits beside them", async () => {
  const { rowToGeneration } = await import("../../lib/jobs");
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("own-keys-map", false), async () => {
    const gen = rowToGeneration(heldRow("gen_own", "held", "slots"));
    expect(gen.params.held).toEqual({ why: "slots", estUsd: EST_USD });
  });
});

test("GET-path reads strip the dollars while the release still meters the take from the raw row", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { getGeneration, listGenerations } = await import("../../lib/jobs");
  const { releaseHeldJobs } = await import("../../lib/held");
  const { db, ready } = await import("../../lib/db");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const ws = workspace("credit-release", true);
  await platformDb().execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,'test',?)",
    args: ["grant_credit_release", ws.id, 1000, Date.now()],
  });
  await runInTenant(ws, async () => {
    await ready();
    const row = heldRow("gen_release", "held", "credits");
    await db().execute({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,billed_to,task)
            VALUES(?,?,?,?,?,?,?,'u_test',?,?,'byteplus','generate')`,
      args: [row.id, row.kind, row.provider, row.model, row.prompt, row.params, row.status, Date.now(), Date.now()],
    });
    const one = await getGeneration(row.id);
    expect(one?.params.held).toEqual({ why: "credits", needs: 21 });
    expect(leaksDollars(one)).toBe(false);
    expect(leaksDollars(await listGenerations())).toBe(false);

    const deferred: Array<() => Promise<void>> = [];
    const out = await releaseHeldJobs({ only: row.id, defer: (fn) => { deferred.push(fn); } });
    expect(out.released).toEqual([row.id]);
    expect(deferred).toHaveLength(1); // Never run: it would submit to the engine.
    const metered = (await platformDb().execute({
      sql: "SELECT engine_cost_usd FROM meter_events WHERE id=?", args: [row.id],
    })).rows[0];
    expect(Number(metered.engine_cost_usd)).toBe(EST_USD);
  });
});
