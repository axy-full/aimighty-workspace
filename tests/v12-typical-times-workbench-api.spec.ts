import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { joinLocallyAsMember, localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * GET /api/v12/typical-times (lib/v12/typicalTimes.server.ts) on a local
 * ENGINE_MOCK server: signed in only; a member of workspace A reads how long
 * engines usually take, measured partly from another workspace's takes, and
 * gets durations only — no workspace, take, cost, count or person of anyone's.
 */
const BASE = process.env.PW_BASE_URL || "http://localhost:4551";
/* A catalogue engine the mock suites rarely run, so these 40 rows dominate its history; a mock server reads afresh
   on every request (no memo under ENGINE_MOCK). And an id outside the catalogue, which must never come back. */
const MODEL = "fal-ai/luma-dream-machine/ray-2-flash/reframe";
const PRIVATE_MODEL = "ws-private/finetune-secret-b";
const MS = 123_000;

test("signed-out callers are refused; a member gets durations only, measured across workspaces", async ({ request, playwright }) => {
  const anonymous = await playwright.request.newContext({ baseURL: BASE });
  const other = await playwright.request.newContext({ baseURL: BASE });
  const member = await playwright.request.newContext({ baseURL: BASE });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const added: string[] = [];
  try {
    /* Workspace B's settled takes, written to the platform's meter as its engines would. */
    const b = (await signInLocally(other, "Typical Times Other")).workspace;
    const t = Date.now();
    for (const [model, n] of [[MODEL, 40], [PRIVATE_MODEL, 20]] as const)
      for (let i = 0; i < n; i++) {
        const id = `gen_tt_${randomUUID()}`;
        added.push(id);
        await platform.execute({
          sql: `INSERT INTO meter_events(id,workspace_id,project_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,duration_ms,created_by,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [id, b.id, "proj-secret-b", "video", "fal", model, "succeeded", 1.2345, 0, 0, MS, "person-secret-b", t - i * 1_000, t - i * 1_000],
        });
      }

    expect((await anonymous.get("/api/v12/typical-times")).status()).toBe(401);

    /* A member (not the owner) of workspace A. */
    const a = await joinLocallyAsMember(request, member);
    expect(a.workspace.id).not.toBe(b.id);
    const res = await member.get("/api/v12/typical-times");
    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("private");
    const body = await res.json() as { models: Record<string, Record<string, unknown>> };

    expect(Object.keys(body)).toEqual(["models"]);
    for (const [id, row] of Object.entries(body.models)) {
      expect(Object.keys(row).sort(), id).toEqual(["highMs", "lowMs", "source"]);
      expect(typeof row.lowMs).toBe("number");
      expect(row.highMs as number).toBeGreaterThanOrEqual(row.lowMs as number);
      expect(row.source).toBe("history");
    }
    expect(body.models[MODEL]).toEqual({ lowMs: MS, highMs: MS, source: "history" });

    const text = JSON.stringify(body);
    expect(body.models[PRIVATE_MODEL], "an engine outside the catalogue is never listed").toBeUndefined();
    for (const secret of [b.id, b.slug, PRIVATE_MODEL, "finetune", "proj-secret-b", "person-secret-b", "gen_tt_", "1.2345", "workspace", "cost", "credits", "samples"])
      expect(text, secret).not.toContain(secret);

    /* Workspace B reads the same platform figure: one shared measure, nobody's rows. */
    const own = await other.get("/api/v12/typical-times").then((r) => r.json());
    expect(own.models[MODEL]).toEqual({ lowMs: MS, highMs: MS, source: "history" });
  } finally {
    /* The rows this spec added, and their receipts (written by the meter's insert trigger), go again. */
    for (const id of added) {
      await platform.execute({ sql: "DELETE FROM meter_credit_receipts WHERE event_id = ?", args: [id] }).catch(() => {});
      await platform.execute({ sql: "DELETE FROM meter_events WHERE id = ?", args: [id] }).catch(() => {});
    }
    platform.close();
    await Promise.all([anonymous.dispose(), other.dispose(), member.dispose()]);
  }
});
