import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The history of who judged a take and why (lib/takeReview.ts; docs/plans/step-0-data.md items 2 and 3; MIGRATION M1): `take_review_events`, written by PATCH /api/jobs/:id in the SAME
 * write as the mark, with the account id, the channel, the reason codes of a send-back and the id of the note that carries the person's own words (which stay in `notes`). A system clear
 * (a locked master changed) writes one too. The real route on a real workspace database; nothing renders and nothing is billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-take-approval-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const WS: TenantWorkspace = {
  id: "ws_approval", name: "ws_approval", slug: "ws_approval", legacy: false, dbUrl: `file:${path.join(dir, "ws_approval.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null,
  ownerId: "u_admin", createdAt: 0, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
};
type Who = { id: string; token?: { id: string; name: string; scope: string } };
const WHO: Record<string, Who> = {
  person: { id: "u_admin" },
  renderToken: { id: "u_admin", token: { id: "tok1", name: "t", scope: "render" } },
  mcpToken: { id: "u_admin", token: { id: "tok2", name: "Claude over MCP", scope: "prepare" } },
  agent: { id: "agent:run-1" },
};

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)), mod, mod.exports);
  return mod.exports as T;
}

async function setup() {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const records = await import("../../lib/workbench/records");
  const { NextResponse } = createRequire(path.resolve("app/api/jobs/[id]/route.ts"))("next/server") as typeof import("next/server");
  const state = { who: WHO.person };
  const auth = {
    withTenant: (handler: (...a: unknown[]) => Promise<unknown>) => (...a: unknown[]) => tenant.runInTenant(WS, () => handler(...a)),
    requireUser: async () => ({ user: { id: state.who.id, name: state.who.id, role: "admin", owner: false }, ...(state.who.token ? { token: state.who.token } : {}) }),
  };
  const jobs = load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", {
    "@/lib/auth": auth, "@/lib/db": database, "@/lib/tenant": tenant, "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" }, "@/lib/workAccess": await import("../../lib/workAccess"),
    "@/lib/draftProject": { mayReachProject: async () => true, productionReachable: async () => true, mayReadTake: async () => true, NO_SUCH_PROJECT: "\u0000unknown" },
    "@/lib/workbench/records": records, "@/lib/workbench/request-scope": await import("../../lib/workbench/request-scope"),
    "@/lib/mediaBindings": await import("../../lib/mediaBindings"), "@/lib/mediaDeletion": await import("../../lib/mediaDeletion"),
    "@/lib/jobs": await import("../../lib/jobs"), "@/lib/shots": await import("../../lib/shots"), "@/lib/held": await import("../../lib/held"),
    "next/server": { NextResponse, after: () => {} }, "@/lib/recovery": { reserveRecoveryContinuation: async (_n: string, task: () => Promise<unknown>) => task },
    "@/lib/push": { notify: async () => {} }, "@/lib/usageLedger": {},
  });
  const patch = async (id: string, body: unknown) => {
    const res = await jobs.PATCH(new Request("https://studio.test/api/jobs/x", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${WS.id}-${state.who.id}` }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string } };
  };
  const row = async (id: string) => (await tenant.runInTenant(WS, async () => (await database.db().execute({ sql: "SELECT title, review_state, review_by, picked_by, approved_by, approved_at FROM generations WHERE id=?", args: [id] })).rows[0]));
  return { as: (name: string) => { state.who = WHO[name]; }, patch, row, tenant, database };
}

async function seed(api: Awaited<ReturnType<typeof setup>>, ids: string[]) {
  await api.tenant.runInTenant(WS, async () => {
    await api.database.ready();
    await api.database.db().batch([
      { sql: "INSERT OR IGNORE INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES('u_admin','a@example.invalid','Admin','!','admin',0,0)", args: [] },
      ...ids.map((id) => ({ sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,stored_url) VALUES(?,'m','p','{}','succeeded',1,1,'image','Original',0,'u_admin',?)`, args: [id, `/api/media/${id}`] })),
    ], "write");
  });
}


const events = async (api: Awaited<ReturnType<typeof setup>>, gen: string) =>
  (await api.tenant.runInTenant(WS, async () => (await api.database.db().execute({ sql: "SELECT * FROM take_review_events WHERE gen_id=? ORDER BY created_at, rowid", args: [gen] })).rows)).map((r) => ({ ...r }));
const notes = async (api: Awaited<ReturnType<typeof setup>>, gen: string) =>
  (await api.tenant.runInTenant(WS, async () => (await api.database.db().execute({ sql: "SELECT * FROM notes WHERE gen_id=?", args: [gen] })).rows)).map((r) => ({ ...r }));

test("every pick, approval, send-back and clear is an event: the account id, the channel, in order, none lost when a mark is replaced", async () => {
  const api = await setup();
  await seed(api, ["e1"]);
  api.as("person");
  expect((await api.patch("e1", { reviewState: "picked" })).status).toBe(200);
  api.as("renderToken");
  expect((await api.patch("e1", { reviewState: "picked" })).status).toBe(200);
  api.as("agent");
  expect((await api.patch("e1", { reviewState: "changes" })).status).toBe(200);
  api.as("person");
  expect((await api.patch("e1", { reviewState: "approved" })).status).toBe(200);
  expect((await api.patch("e1", { reviewState: "" })).status).toBe(200);
  const rows = await events(api, "e1");
  expect(rows.map((r) => [r.action, r.actor_id, r.via, r.token_id])).toEqual([
    ["picked", "u_admin", "person", null], ["picked", "u_admin", "token", "tok1"], ["changes", "agent:run-1", "agent", null], ["approved", "u_admin", "person", null], ["cleared", "u_admin", "person", null],
  ]);
  /* The take keeps its latest marks as before (names, for older screens), and no event holds a name or a word. */
  expect(await api.row("e1")).toMatchObject({ review_state: "", approved_by: "u_admin" });
  for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/Admin|words/);
});

test("a send-back carries its reason codes and detail in the event and its own words in a note, in the same write; with no reason it is just the mark", async () => {
  const api = await setup();
  await seed(api, ["e2", "e3"]);
  api.as("person");
  const sent = await api.patch("e2", { reviewState: "changes", reasons: ["drift", "framing", "framing"], drift: "wardrobe", reasonText: "  The coat   changed in the second beat  " });
  expect(sent.status).toBe(200);
  const [event] = await events(api, "e2"), [note] = await notes(api, "e2");
  expect(event).toMatchObject({ action: "changes", reasons: JSON.stringify(["framing", "drift"]), drift: "wardrobe", note_id: note.id, via: "person", cause: null });
  expect(note).toMatchObject({ user_id: "u_admin", text: "The coat changed in the second beat" });
  /* The person's words are in the notes only. */
  expect(JSON.stringify(event)).not.toContain("coat");
  /* Only the mark: still works, and writes no note. */
  expect((await api.patch("e3", { reviewState: "changes" })).status).toBe(200);
  expect(await events(api, "e3")).toEqual([expect.objectContaining({ action: "changes", reasons: null, drift: null, note_id: null })]);
  expect(await notes(api, "e3")).toEqual([]);
  /* A token sends one back too, and the event says so. */
  api.as("mcpToken");
  await seed(api, ["e4"]);
  expect((await api.patch("e4", { reviewState: "changes", reasons: ["audio"] })).status).toBe(200);
  expect(await events(api, "e4")).toEqual([expect.objectContaining({ reasons: JSON.stringify(["audio"]), via: "token", token_id: "tok2" })]);
});

test("a bad reason is refused whole: unknown code, a stray detail, reasons with another mark or with no mark, words that are not words or too long; nothing is written", async () => {
  const api = await setup();
  await seed(api, ["e5"]);
  api.as("person");
  const bad: Record<string, unknown>[] = [
    { reviewState: "changes", reasons: ["nope"] }, { reviewState: "changes", reasons: "framing" }, { reviewState: "changes", reasons: ["framing"], drift: "identity" },
    { reviewState: "changes", reasons: ["drift"], drift: "mood" }, { reviewState: "picked", reasons: ["framing"] }, { reviewState: "approved", reasonText: "no" }, { reasons: ["framing"] },
    { drift: "identity" }, { reviewState: "changes", reasonText: 5 }, { reviewState: "changes", reasonText: "x".repeat(501) },
  ];
  for (const body of bad) {
    const res = await api.patch("e5", { ...body, title: "Renamed" });
    expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
  }
  expect(await api.row("e5")).toMatchObject({ title: "Original", review_state: "" });
  expect(await events(api, "e5")).toEqual([]);
  expect(await notes(api, "e5")).toEqual([]);
});

test("the mark, the event and the note are one write: if the note cannot be written the mark does not land and there is no event", async () => {
  const api = await setup();
  await seed(api, ["e6"]);
  api.as("person");
  await api.tenant.runInTenant(WS, () => api.database.db().execute("ALTER TABLE notes RENAME TO notes_away"));
  try {
    const res = await api.patch("e6", { reviewState: "changes", reasons: ["framing"], reasonText: "Too tight" }).catch(() => ({ status: 500 }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await api.row("e6")).toMatchObject({ review_state: "", review_by: null });
    expect(await events(api, "e6")).toEqual([]);
  } finally {
    await api.tenant.runInTenant(WS, () => api.database.db().execute("ALTER TABLE notes_away RENAME TO notes"));
  }
});

test("a locked master changing clears the approved takes it reaches and says so: a system event for each, naming the person who changed it; others are left alone", async () => {
  const api = await setup();
  const { clearApprovalsForMasterChange } = await import("../../lib/takeReview");
  await api.tenant.runInTenant(WS, async () => {
    await api.database.ready();
    await api.database.db().batch([
      { sql: "INSERT OR IGNORE INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES('u_admin','a@example.invalid','Admin','!','admin',0,0)", args: [] },
      { sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('p','Board',0)", args: [] },
      { sql: "INSERT OR IGNORE INTO shots(id,project_id,code,title,status,position,created_at,updated_at) VALUES('s1','p','010','S','open',0,0,0),('s2','p','020','S','open',1,0,0)", args: [] },
      ...[["m1", "video", "approved", "s1"], ["m2", "image", "approved", "s1"], ["m3", "audio", "approved", "s1"], ["m4", "video", "picked", "s1"], ["m5", "video", "approved", "s2"]].map(([id, kind, state, shot]) => ({
        sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,shot_id,review_state,approved_by) VALUES(?,'m','p','{}','succeeded',1,1,?,'T',0,'u_admin',?,?,'Admin')", args: [id, kind, shot, state] })),
    ], "write");
  });
  const returned = await api.tenant.runInTenant(WS, () => clearApprovalsForMasterChange(api.database.db(), { shotIds: ["s1"], kinds: ["video", "image"], actorId: "u_admin", at: 500 }));
  expect(returned).toBe(2);
  const state = async (id: string) => String((await api.row(id))?.review_state);
  expect([await state("m1"), await state("m2"), await state("m3"), await state("m4"), await state("m5")]).toEqual(["", "", "approved", "picked", "approved"]);
  expect(await api.row("m1")).toMatchObject({ approved_by: "Admin" });
  for (const id of ["m1", "m2"]) expect(await events(api, id)).toEqual([expect.objectContaining({ action: "cleared", actor_id: "u_admin", via: "system", cause: "master_changed", token_id: null, created_at: 500 })]);
  for (const id of ["m3", "m4", "m5"]) expect(await events(api, id)).toEqual([]);
});

test("the table is in every workspace database, with its index; nothing about it is a column of a take", async () => {
  const api = await setup();
  await api.tenant.runInTenant(WS, async () => {
    await api.database.ready();
    const names = (await api.database.db().execute("SELECT name FROM sqlite_master WHERE tbl_name='take_review_events'")).rows.map((r) => String(r.name));
    expect(names).toContain("take_review_events");
    expect(names).toContain("idx_take_review_events_gen");
    const cols = (await api.database.db().execute("PRAGMA table_info(take_review_events)")).rows.map((r) => String(r.name));
    expect(cols).toEqual(["id", "gen_id", "action", "actor_id", "via", "token_id", "reasons", "drift", "note_id", "cause", "created_at"]);
    expect((await api.database.db().execute("PRAGMA table_info(generations)")).rows.map((r) => String(r.name))).not.toContain("reasons");
  });
});

test("the history is append-only for real: an UPDATE or a DELETE of an event is refused by the database; clearing a take that has no mark writes no event", async () => {
  const api = await setup();
  await seed(api, ["e7", "e8"]);
  api.as("person");
  expect((await api.patch("e7", { reviewState: "picked" })).status).toBe(200);
  const [event] = await events(api, "e7");
  await api.tenant.runInTenant(WS, async () => {
    await expect(api.database.db().execute({ sql: "UPDATE take_review_events SET actor_id='someone' WHERE id=?", args: [String(event.id)] })).rejects.toThrow(/append-only/);
    await expect(api.database.db().execute({ sql: "DELETE FROM take_review_events WHERE id=?", args: [String(event.id)] })).rejects.toThrow(/append-only/);
    await expect(api.database.db().execute("DELETE FROM take_review_events")).rejects.toThrow(/append-only/);
  });
  expect(await events(api, "e7")).toEqual([event]);
  /* A clear on a take with no mark is no change and no event; on a take that has one it is an event. */
  expect((await api.patch("e8", { reviewState: "" })).status).toBe(200);
  expect(await events(api, "e8")).toEqual([]);
  expect((await api.patch("e8", { reviewState: "picked" })).status).toBe(200);
  expect((await api.patch("e8", { reviewState: "" })).status).toBe(200);
  expect((await events(api, "e8")).map((r) => r.action)).toEqual(["picked", "cleared"]);
});
