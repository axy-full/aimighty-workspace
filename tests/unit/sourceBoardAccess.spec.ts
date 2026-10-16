import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A take used as a source (an audio or video original named by its take id) is read only by a person who may see the private board it is filed under:
 * `findStoredSource` is the one place (lib/mediaSource.server.ts), so dubbing, voice change and transcription all start there. Another person's reads as a
 * take that is not there. An Atomik run is its owner; a run whose owner cannot be found reads nothing; background work with no person is not asked.
 * Local temporary databases only; ENGINE_MOCK=1 so a transcription can be quoted.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-source-board-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const ws = { id: "ws_legacy", slug: "ws_legacy", name: "ws_legacy", legacy: true, dbUrl: `file:${path.join(dir, "ws_legacy.db")}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null } as TenantWorkspace;
const person = (id: string, role = "member") => ({ id, email: `${id}@example.invalid`, name: id, role, owner: false, disabled: false, createdAt: 0, lastSeen: null });

let n = 0;
async function take(kind: "audio" | "video", projectId: string | null): Promise<string> {
  const { db } = await import("../../lib/db");
  const id = `gen_src_${Date.now().toString(36)}_${++n}`;
  await db().execute({ sql: "INSERT INTO generations (id, project_id, kind, model, prompt, params, status, created_by, created_at, updated_at, stored_url, bytes, duration_s) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [id, projectId, kind, "sample-model", "a take", "{}", "succeeded", "u_a", Date.now(), Date.now(), `generations/${id}.${kind === "audio" ? "mp3" : "mp4"}`, 1000, 12] });
  return id;
}

test("findStoredSource: a take of a private board is read by its owner and an admin, never by another member; ordinary and unfiled takes by anyone", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { findStoredSource } = await import("../../lib/mediaSource.server");
  const { db, ready } = await import("../../lib/db");
  const { heldBoardsProjectId } = await import("../../lib/draftProject");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  await runInTenant(ws, async () => {
    await ready(); await rigAgentReady();
    const board = heldBoardsProjectId("ws_legacy", "u_a");
    await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [board, board] });
    await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prj_plain','plain',0)", args: [] });
    for (const [run, owner] of [["run_a", "u_a"], ["run_b", "u_b"]]) await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: [run, "prod_x", "draft_x", owner, `req_${run}`, "goal", "auto", "finished"] });
    const secret = await take("audio", board), secretVideo = await take("video", board), plain = await take("audio", "prj_plain"), loose = await take("audio", null);
    const read = async (user: ReturnType<typeof person> | null, id: string) => {
      let out: unknown;
      await runInTenant(ws, async () => { out = await findStoredSource({ genId: id }); }, (user ? { user } : {}) as never);
      return out ? "found" : "missing";
    };
    /* The board's owner, and a workspace admin (whose workspace it is). */
    for (const id of [secret, secretVideo]) { expect(await read(person("u_a"), id)).toBe("found"); expect(await read(person("u_admin", "admin"), id)).toBe("found"); }
    /* Another member: not there, for audio and for video. */
    for (const id of [secret, secretVideo]) expect(await read(person("u_b"), id)).toBe("missing");
    /* An Atomik run is its owner. */
    expect(await read(person("agent:run_a"), secret)).toBe("found");
    expect(await read(person("agent:run_b"), secret)).toBe("missing");
    /* A run that exists but has no person to act for reads nothing, not even an ordinary take. */
    await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_orphan", "prod_x", "draft_x", "agent:run_a", "req_orphan", "goal", "auto", "finished"] });
    expect(await read(person("agent:run_orphan"), secret)).toBe("missing");
    expect(await read(person("agent:run_orphan"), plain)).toBe("missing");
    /* An agent id with no run behind it at all is no person's run: it is an internal call, not asked (the engine doors ask for a person first). */
    expect(await read(person("agent:run_missing"), secret)).toBe("found");
    /* Ordinary and unfiled takes are anyone's in the workspace. */
    for (const id of [plain, loose]) { expect(await read(person("u_b"), id)).toBe("found"); expect(await read(person("agent:run_b"), id)).toBe("found"); }
    /* Background work with no person is not asked (as for uploads). */
    expect(await read(null, secret)).toBe("found");
  }, { user: person("u_setup") } as never);
});

test("every door that starts at findStoredSource refuses another member's private take as a take that is not there: dubbing, voice change, transcription", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { heldBoardsProjectId } = await import("../../lib/draftProject");
  const { resolveDubbingSource } = await import("../../lib/dubbing");
  const { resolveVoiceChangeSource } = await import("../../lib/audioAdmission");
  const { transcribe } = await import("../../lib/transcription");
  await runInTenant(ws, async () => {
    await ready();
    const board = heldBoardsProjectId("ws_legacy", "u_a");
    await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [board, board] });
    const secret = await take("audio", board);
    const as = async (user: ReturnType<typeof person>, fn: () => Promise<void>) => { await runInTenant(ws, fn, { user } as never); };
    await as(person("u_a"), async () => {
      expect(await resolveDubbingSource({ sourceGenId: secret })).toMatchObject({ seconds: 12 });
      expect(await resolveVoiceChangeSource({ sourceGenId: secret })).toMatchObject({ seconds: 12 });
      expect((await transcribe({ sourceGenId: secret, quoteOnly: true }, "u_a")).status).toBe(200);
    });
    await as(person("u_b"), async () => {
      expect(await resolveDubbingSource({ sourceGenId: secret })).toEqual({ error: "That original is not in this workspace.", status: 404 });
      expect(await resolveVoiceChangeSource({ sourceGenId: secret })).toEqual({ error: "That audio original is not in this workspace.", status: 404 });
      expect(await transcribe({ sourceGenId: secret, quoteOnly: true }, "u_b")).toMatchObject({ status: 404, body: { error: "That original is not in this workspace." } });
    });
  }, { user: person("u_setup") } as never);
});
