import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";

/**
 * A take used as a source (an audio or video original named by its take id) is read only by a person who may see the private board it is filed under:
 * `findStoredSource` is the one place (lib/mediaSource.server.ts), so dubbing, voice change and transcription all start there. Another person's reads as a
 * take that is not there. An Atomik run is its owner (lib/actingViewer.ts). An agent identity with no person behind it (an `agent:` id with no run row, a run
 * that names no person, or "server") is refused 403 NO_ACTING_PERSON before anything is quoted, reserved, metered or written (owner, 19 Oct).
 * The one exception: background work with no user at all (the workers, such as handleDubbing's deferred submit in lib/dubbing.ts and the voice-change render in
 * lib/engines/elevenlabs.ts) is not asked, as before; its job was checked when it was admitted.
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
  const { lookupStoredSource } = await import("../../lib/mediaSource.server");
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
    const verdict = (out: unknown) => !out ? "missing" : (out as { code?: string }).code === "NO_ACTING_PERSON" ? "refused" : "found";
    const read = async (user: ReturnType<typeof person> | null, id: string) => {
      let out: unknown;
      await runInTenant(ws, async () => { out = await lookupStoredSource({ genId: id }); }, (user ? { user } : {}) as never);
      return verdict(out);
    };
    /* The board's owner, and a workspace admin (whose workspace it is). */
    for (const id of [secret, secretVideo]) { expect(await read(person("u_a"), id)).toBe("found"); expect(await read(person("u_admin", "admin"), id)).toBe("found"); }
    /* Another member: not there, for audio and for video. */
    for (const id of [secret, secretVideo]) expect(await read(person("u_b"), id)).toBe("missing");
    /* An Atomik run is its owner. */
    expect(await read(person("agent:run_a"), secret)).toBe("found");
    expect(await read(person("agent:run_b"), secret)).toBe("missing");
    /* A run that exists but has no person to act for is refused, even for an ordinary take. */
    await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_orphan", "prod_x", "draft_x", "agent:run_a", "req_orphan", "goal", "auto", "finished"] });
    expect(await read(person("agent:run_orphan"), secret)).toBe("refused");
    expect(await read(person("agent:run_orphan"), plain)).toBe("refused");
    /* An agent id with no run behind it at all, and the "server" identity, are no person: refused, for a private board's take and an ordinary one alike. */
    for (const who of ["agent:run_missing", "agent:", "server"]) for (const id of [secret, plain, loose]) expect(await read(person(who), id), `${who} ${id}`).toBe("refused");
    /* Uploads: an agent id with no run is refused, even for one nobody owns; a run's owner reads as that person. */
    for (const [uid, who] of [["up_private_a", "u_a"], ["up_unowned", null]] as const)
      await db().execute({ sql: "INSERT OR IGNORE INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind,duration_s,uploader_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [uid, `${uid}.mp3`, "audio/mpeg", "mp3", 10, "x", `uploads/${uid}.mp3`, Date.now(), "audio", 5, who] });
    const readUpload = async (user: ReturnType<typeof person>, uploadId: string) => {
      let out: unknown;
      await runInTenant(ws, async () => { out = await lookupStoredSource({ uploadId }); }, { user } as never);
      return verdict(out);
    };
    expect(await readUpload(person("agent:run_missing"), "up_private_a")).toBe("refused");
    expect(await readUpload(person("agent:run_missing"), "up_unowned")).toBe("refused");
    expect(await readUpload(person("agent:run_orphan"), "up_unowned")).toBe("refused");
    expect(await readUpload(person("agent:run_a"), "up_private_a")).toBe("found");
    expect(await readUpload(person("agent:run_b"), "up_private_a")).toBe("missing");
    expect(await readUpload(person("agent:run_b"), "up_unowned")).toBe("found");
    expect(await readUpload(person("u_a"), "up_private_a")).toBe("found");
    expect(await readUpload(person("u_b"), "up_private_a")).toBe("missing");
    /* Ordinary and unfiled takes are anyone's in the workspace. */
    for (const id of [plain, loose]) { expect(await read(person("u_b"), id)).toBe("found"); expect(await read(person("agent:run_b"), id)).toBe("found"); }
    /* The exception: background work with no user at all (the workers) is not asked, as before. */
    expect(await read(null, secret)).toBe("found");
    let upload: unknown;
    await runInTenant(ws, async () => { upload = await lookupStoredSource({ uploadId: "up_private_a" }); }, {} as never);
    expect(verdict(upload)).toBe("found");
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

test("every door that starts at findStoredSource refuses an agent identity with no person behind it 403 NO_ACTING_PERSON, before anything is reserved, metered or written; a run's owner reads as before", async () => {
  const { runInTenant, requireTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  const { resolveDubbingSource, executeDubbingAdmission } = await import("../../lib/dubbing");
  const { resolveVoiceChangeSource, executeAudioAdmission } = await import("../../lib/audioAdmission");
  const { transcribe } = await import("../../lib/transcription");
  const { NO_ACTING_PERSON } = await import("../../lib/actingViewer");
  await platformReady();
  let src = "";
  await runInTenant(ws, async () => {
    await ready(); await rigAgentReady();
    src = await take("audio", "prj_plain");
    for (const [run, owner] of [["run_doors", "u_a"], ["run_doors_orphan", "agent:run_doors"]]) await db().execute({ sql: "INSERT OR IGNORE INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: [run, "prod_x", "draft_x", owner, `req_${run}`, "goal", "auto", "running"] });
  }, { user: person("u_setup") } as never);
  const REFUSED = { error: NO_ACTING_PERSON, code: "NO_ACTING_PERSON", status: 403 };
  const count = async (sql: string, args: string[] = []) => Number((await db().execute({ sql, args })).rows[0].n);
  const footprint = async () => [
    await count("SELECT COUNT(*) AS n FROM generations"),
    await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='dubbing_jobs'") ? await count("SELECT COUNT(*) AS n FROM dubbing_jobs") : 0,
    Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows[0].n),
  ];
  for (const who of ["agent:run_missing", "agent:run_doors_orphan", "server"]) {
    const user = person(who, "admin") as TenantUser, actor = { user }, noop = { defer: async () => { throw new Error("nothing is handed to a worker"); } };
    await runInTenant(ws, async () => {
      const before = await footprint();
      expect(await resolveDubbingSource({ sourceGenId: src }), who).toEqual(REFUSED);
      expect(await resolveVoiceChangeSource({ sourceGenId: src }), who).toEqual(REFUSED);
      for (const quoteOnly of [true, false]) {
        const dub = await executeDubbingAdmission({ sourceGenId: src, sourceLang: "en", targetLang: "es", mode: "v1", projectId: "prj_plain", quoteOnly, maxCredits: 5000 }, actor, noop);
        expect([dub.status, dub.body], `${who} dubbing quoteOnly ${quoteOnly}`).toEqual([403, { error: NO_ACTING_PERSON, code: "NO_ACTING_PERSON" }]);
        const voice = await executeAudioAdmission({ task: "voiceChange", sourceGenId: src, voiceId: "voice_x", projectId: "prj_plain", quoteOnly, maxCredits: 5000 }, actor, noop);
        expect([voice.status, voice.body], `${who} voice change quoteOnly ${quoteOnly}`).toEqual([403, { error: NO_ACTING_PERSON, code: "NO_ACTING_PERSON" }]);
        const heard = await transcribe({ sourceGenId: src, projectId: "prj_plain", quoteOnly, maxCredits: 5000 }, who);
        expect([heard.status, heard.body], `${who} transcription quoteOnly ${quoteOnly}`).toEqual([403, { error: NO_ACTING_PERSON, code: "NO_ACTING_PERSON" }]);
      }
      /* Nothing reserved, metered or written: no take, no dubbing job, no meter event. */
      expect(await footprint(), who).toEqual(before);
    }, { user } as never);
  }
  /* A run with a person behind it reads as that person, as before. */
  await runInTenant(ws, async () => {
    expect(await resolveDubbingSource({ sourceGenId: src })).toMatchObject({ seconds: 12 });
    expect(await resolveVoiceChangeSource({ sourceGenId: src })).toMatchObject({ seconds: 12 });
    expect((await transcribe({ sourceGenId: src, quoteOnly: true }, "agent:run_doors")).status).toBe(200);
  }, { user: person("agent:run_doors") } as never);
});
