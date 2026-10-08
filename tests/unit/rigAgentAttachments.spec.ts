import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { TenantWorkspace } from "../../lib/tenant";
import { newProject, type Project } from "../../lib/workbench/studio";
import type { BoardSnapshot } from "../../lib/workbench/rig-agent-plan";
import { mockPlannerModel, runPlanner, MOCK_PLANNER_CATALOG, MOCK_PLANNER_MODEL, type PlannerAttachmentContent } from "../../lib/workbench/rig-agent-planner";

/*
 * Files attached on the empty board reach Atomik's planning call (owner, 8 Oct). Tenancy: an attachment id is read
 * only from the caller's own workspace and only among the uploads filed in this production's Library; an unknown id,
 * another workspace's or another project's is refused (400) and nothing is asked or read. Money: the files are priced
 * into planning's figure ("Start · up to N cr") by the same estimator the charge reserves at, so the figure shown is
 * the reservation, never below it. Scripted mock planner through the real SDK loop; local databases; nothing leaves.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-rig-attach-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.LIVEBLOCKS_SECRET_KEY;

const OWNER = "ana";
let requests = 0;
const rid = () => `req-attach-${String(++requests).padStart(6, "0")}`;
const originalFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

async function paidWorkspace(name: string, credits = 2000): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,?,0,0,20,500)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`, OWNER],
  });
  if (credits) await grantCredits(name, credits, "Test", OWNER, "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
}

/** The same production and draft ids in every workspace: only the workspace tells them apart. */
async function seedBoard() {
  const { db, ready } = await import("../../lib/db");
  const project: Project = { ...newProject("Harbour"), id: "draft-1", productionProjectId: "prod-1" };
  await ready();
  await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Harbour',0)");
  await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-2','Elsewhere',0)");
  await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${OWNER}:draft-1`, OWNER, "draft-1", "Harbour", JSON.stringify(project)] });
}

/** An upload row in the current workspace, filed in `production`'s Library (null: not filed anywhere). */
async function upload(id: string, filename: string, mime: string, bytes: number, production: string | null = "prod-1") {
  const { db } = await import("../../lib/db");
  const { projectLibraryReady } = await import("../../lib/workbench/project-library");
  await projectLibraryReady();
  const ext = filename.split(".").pop()!;
  await db().execute({
    sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,0,?)",
    args: [id, filename, mime, ext, bytes, "0".repeat(64), `/api/uploads/${id}`, mime.startsWith("video/") ? "video" : "image"],
  });
  if (production) await db().execute({ sql: "INSERT INTO project_library_uploads(project_id,upload_id,created_by,created_at) VALUES(?,?,?,0)", args: [production, id, OWNER] });
}

async function inWorkspace<T>(name: string, fn: (ws: TenantWorkspace) => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await paidWorkspace(name);
  return runInTenant(ws, async () => { await seedBoard(); return fn(ws); });
}
const enter = async <T,>(ws: TenantWorkspace, fn: () => Promise<T>) => (await import("../../lib/tenant")).runInTenant(ws, fn);

async function runsIn(): Promise<number> {
  const { db } = await import("../../lib/db");
  const { rigAgentExists } = await import("../../lib/workbench/rig-agent-store");
  return (await rigAgentExists()) ? Number((await db().execute("SELECT COUNT(*) AS n FROM rig_agent_runs")).rows[0].n) : 0;
}
async function meterRow(id: string) {
  const { platformDb } = await import("../../lib/platform");
  const row = (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
  return row ? { status: String(row.status), credits: Number(row.billed_credits ?? 0) } : null;
}
async function balance(ws: TenantWorkspace) {
  const { creditStateFor } = await import("../../lib/credits");
  return (await creditStateFor(ws))!.balance;
}

const PNG = () => sharp({ create: { width: 64, height: 40, channels: 3, background: "#c08040" } }).png().toBuffer();
const BRIEF = "Night market, lanterns, a slow push-in on the noodle stall.";
/** Reads the test's bytes by upload id, as the workspace's storage would. */
const readers = (files: Record<string, Buffer>) => ({ upload: async (id: string) => { const b = files[id]; if (!b) throw new Error("missing"); return b; } });
const pricing = async () => ({ id: MOCK_PLANNER_MODEL, catalog: MOCK_PLANNER_CATALOG, direct: false });

test("an attachment id is checked against this production's Library in the caller's workspace: unknown, foreign, unfiled and malformed ids are refused (400) and nothing is asked", async () => {
  /* Another workspace with the SAME production id and an upload filed in it. */
  const other = await inWorkspace("att-other", async (ws) => { await upload("up-theirs", "theirs.png", "image/png", 1000); return ws; });
  await inWorkspace("att-mine", async () => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { resolvePlanAttachments } = await import("../../lib/workbench/rig-agent-attachments");
    await upload("up-mine", "still.png", "image/png", 1000);
    await upload("up-brief", "brief.txt", "text/plain", 500);
    await upload("up-script", "script.pdf", "application/pdf", 50_000_000);
    await upload("up-loose", "loose.png", "image/png", 1000, null);
    await upload("up-other-project", "other.png", "image/png", 1000, "prod-2");
    await upload("up-long", "long.txt", "text/plain", 100_001);
    await upload("up-huge", "huge.png", "image/png", 32 * 1024 * 1024 + 1);

    /* Own, filed: passed, in the order given, with what the planner is told they are. */
    expect((await resolvePlanAttachments("prod-1", ["upload:up-brief", "upload:up-mine", "upload:up-script"])).map(({ id, kind, name }) => ({ id, kind, name }))).toEqual([
      { id: "upload:up-brief", kind: "text", name: "brief.txt" },
      { id: "upload:up-mine", kind: "image", name: "still.png" },
      { id: "upload:up-script", kind: "file", name: "script.pdf" },
    ]);
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 500, attachments: ["upload:up-mine", "upload:up-brief"] });
    const { getRun } = await import("../../lib/workbench/rig-agent-store");
    const { db } = await import("../../lib/db");
    expect((await getRun(db(), asked.id))!.attachments).toEqual(["upload:up-mine", "upload:up-brief"]);
    await agent.declineRigAgent({ productionId: "prod-1", runId: asked.id, userId: OWNER });
    const before = await runsIn();

    const refused: [string[], RegExp][] = [
      [["upload:nope"], /isn't in this project's Library/],
      /* Another workspace's upload, filed in a production with this very id over there: not found here. */
      [["upload:up-theirs"], /isn't in this project's Library/],
      [["upload:up-loose"], /isn't in this project's Library/],
      [["upload:up-other-project"], /isn't in this project's Library/],
      [["upload:up-mine", "upload:nope"], /isn't in this project's Library/],
      [["gen:abc"], /isn't one Atomik can read/],
      [["upload:../up-mine"], /isn't one Atomik can read/],
      [["up-mine"], /isn't one Atomik can read/],
      [["upload:up-mine", "upload:up-mine"], /Attach each file once/],
      [Array.from({ length: 7 }, (_, i) => `upload:x${i}`), /at most 6 attached files/],
      [["upload:up-long"], /long\.txt is over 100 KB/],
      [["upload:up-huge"], /huge\.png is over 32 MB/],
    ];
    for (const [ids, said] of refused) {
      await expect(agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 500, attachments: ids }), ids.join(",")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(said) });
      /* The price read refuses it the same way. */
      await expect(agent.rigAgentState("prod-1", OWNER, "draft-1", ids), ids.join(",")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(said) });
    }
    expect(await runsIn(), "no run was asked for a refused attachment").toBe(before);
  });
  /* And the other way round: their own upload is theirs. */
  await enter(other, async () => {
    const { resolvePlanAttachments } = await import("../../lib/workbench/rig-agent-attachments");
    expect((await resolvePlanAttachments("prod-1", ["upload:up-theirs"])).map((a) => a.id)).toEqual(["upload:up-theirs"]);
    await expect(resolvePlanAttachments("prod-1", ["upload:up-mine"])).rejects.toMatchObject({ status: 400 });
  });
});

test("the attached files reach the planning call: an image as a picture, a text file quoted, anything else by name; the mock plan shows them", async () => {
  await inWorkspace("att-reach", async () => {
    const agent = await import("../../lib/workbench/rig-agent");
    await upload("up-still", "still.png", "image/png", 2000);
    await upload("up-brief", "brief.txt", "text/plain", BRIEF.length);
    await upload("up-script", "script.pdf", "application/pdf", 9000);
    const png = await PNG();
    let seen: { snapshot: BoardSnapshot; content: PlannerAttachmentContent; prompt: LanguageModelV4CallOptions["prompt"] | null } | null = null;
    const deps = {
      access: async () => null, paceMs: 0, pricing,
      attachmentReaders: readers({ "up-still": png, "up-brief": Buffer.from(BRIEF) }),
      plan: async (snapshot: BoardSnapshot, _model: string, content: PlannerAttachmentContent) => {
        const model = mockPlannerModel(snapshot);
        const doGenerate = model.doGenerate.bind(model);
        seen = { snapshot, content, prompt: null };
        model.doGenerate = async (options) => { seen!.prompt ??= options.prompt; return doGenerate(options); };
        return { ...(await runPlanner(snapshot, model, { attachments: content })), model: MOCK_PLANNER_MODEL };
      },
    };
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots at the stall.", limit: 500, attachments: ["upload:up-still", "upload:up-brief", "upload:up-script"] });
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "awaiting_approval", more: false });
    const got = seen!;
    expect(got.snapshot.attached).toEqual([
      { id: "upload:up-still", name: "still.png", kind: "image" },
      { id: "upload:up-brief", name: "brief.txt", kind: "text" },
      { id: "upload:up-script", name: "script.pdf", kind: "file" },
    ]);
    expect(got.content.texts).toEqual([{ id: "upload:up-brief", text: BRIEF }]);
    expect(got.content.images.map((i) => i.id)).toEqual(["upload:up-still"]);
    expect(got.content.images[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    /* What the model was sent: the request (naming all three), the text quoted, the still as a picture. */
    const user = got.prompt!.find((m) => m.role === "user")!;
    const parts = user.content as { type: string; text?: string; mediaType?: string }[];
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    expect(text).toContain("script.pdf");
    expect(text).toContain(BRIEF);
    expect(text).toMatch(/ATTACHED IMAGE "still\.png"/);
    expect(parts.filter((p) => p.type === "file").map((p) => p.mediaType)).toEqual(["image/jpeg"]);
    /* The proposal shows what it was given. */
    const view = (await agent.rigAgentState("prod-1", OWNER, "draft-1")).run!;
    const titles = JSON.stringify(view);
    for (const name of ["Attached: still.png", "Attached: brief.txt", "Attached: script.pdf"]) expect(titles).toContain(name);

    /* A file taken out of the Library after the ask is not read: the run stops before anything is reserved. */
    await agent.declineRigAgent({ productionId: "prod-1", runId: asked.id, userId: OWNER });
    const again = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 500, attachments: ["upload:up-still"] });
    const { db } = await import("../../lib/db");
    await db().execute("DELETE FROM project_library_uploads WHERE upload_id='up-still'");
    expect((await agent.advanceRigAgentRun(again.id, deps)).state).toBe("failed");
    expect(await meterRow(agent.planEventId(again.id))).toBeNull();
  });
});

test("quote = charge with files attached: Start's figure prices them in by the charge's own estimator, and a figure without them plans nothing", async () => {
  await inWorkspace("att-price", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { quotedCredits } = await import("../../lib/credits");
    const { plannerCeilingUsd } = await import("../../lib/workbench/rig-agent-planner");
    await upload("up-a", "a.png", "image/png", 2000);
    await upload("up-b", "b.png", "image/png", 2000);
    await upload("up-t", "notes.txt", "text/plain", 300);
    const ids = ["upload:up-a", "upload:up-b", "upload:up-t"];
    const png = await PNG();
    const bare = (await agent.rigAgentState("prod-1", OWNER, "draft-1")).ask!.planning!;
    const quoted = (await agent.rigAgentState("prod-1", OWNER, "draft-1", ids)).ask!.planning!;
    expect(bare).toBeGreaterThan(0);
    /* The files move the figure on Start: two pictures and a text excerpt on each of the planner's calls. */
    expect(quoted).toBeGreaterThan(bare);

    let ceiling = 0, during: Awaited<ReturnType<typeof meterRow>> = null, runId = "";
    const deps = {
      access: async () => null, paceMs: 0, pricing,
      attachmentReaders: readers({ "up-a": png, "up-b": png, "up-t": Buffer.from("Lanterns.") }),
      plan: async (snapshot: BoardSnapshot, _model: string, content: PlannerAttachmentContent) => {
        ceiling = quotedCredits(plannerCeilingUsd(MOCK_PLANNER_CATALOG, snapshot)!, "text");
        during = await meterRow(agent.planEventId(runId));
        return { ...(await runPlanner(snapshot, mockPlannerModel(snapshot), { attachments: content })), model: MOCK_PLANNER_MODEL };
      },
    };
    /* The request at its longest (the figure holds whatever is typed): the reservation IS the figure on Start. */
    const start = await balance(ws);
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "y".repeat(2000), limit: quoted, attachments: ids });
    runId = asked.id;
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "awaiting_approval", more: false });
    expect(ceiling).toBe(quoted);
    expect(during).toMatchObject({ status: "running", credits: quoted });
    const settled = (await meterRow(agent.planEventId(runId)))!;
    expect(settled.status).toBe("succeeded");
    expect(settled.credits).toBeGreaterThan(0);
    expect(settled.credits).toBeLessThanOrEqual(quoted);
    expect(await balance(ws)).toBe(start - settled.credits);
    await agent.declineRigAgent({ productionId: "prod-1", runId, userId: OWNER });

    /* Pressed at the figure for no files, with the files attached: planning would pass the limit, so nothing is sent or charged. */
    const tight = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "y".repeat(2000), limit: bare, attachments: ids });
    runId = tight.id;
    expect((await agent.advanceRigAgentRun(runId, deps)).state).toBe("failed");
    expect(await meterRow(agent.planEventId(runId))).toBeNull();
    expect(await balance(ws)).toBe(start - settled.credits);

    /* No files, no change: the figure is the board's as before. */
    const { boardSnapshot } = await import("../../lib/workbench/rig-agent-plan");
    const project = { ...newProject("Harbour"), id: "draft-1", productionProjectId: "prod-1" };
    expect(JSON.stringify(boardSnapshot(project, { nodes: [], assets: [] }, "x"))).not.toContain("attached");
  });
});
