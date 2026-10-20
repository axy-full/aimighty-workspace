import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { loadRouteModule } from "../helpers/vendorCostScan";

/**
 * Atomik's memory follows the board. A project's entries are read by the people who may read the board (their own, a teammate's shared board, any project
 * that is not a private board) and written, kept, imported, edited and forgotten only by the people who may file into it. Someone else's private board
 * answers exactly as a project that does not exist, in every route, and nothing in an answer says the board is there. An admin has no elevation here.
 * Memory with no project (the whole workspace's) is unchanged.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-atomik-memory-gate-"));
process.env.PLATFORM_DATABASE_URL ??= `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL ??= `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

function workspace(platformKeys = false): TenantWorkspace {
  const id = `ws_${randomUUID().slice(0, 8)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: platformKeys,
    allowanceUsd: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0 } as TenantWorkspace;
}
const person = (id: string, role: "owner" | "admin" | "member" = "member") =>
  ({ id, email: `${id}@example.test`, name: id, role, owner: role === "owner", disabled: false, lastSeen: null, createdAt: 0 }) as TenantUser;
async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>, user?: TenantUser): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, user ? { user } : {});
}
/** A row with the given values and a placeholder in every other required column. */
async function insertRow(table: string, values: Record<string, unknown>) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  const required = (await db().execute(`PRAGMA table_info(${table})`)).rows
    .filter((c) => Number(c.notnull) && c.dflt_value == null && !Number(c.pk) && !(String(c.name) in values));
  const row = { ...Object.fromEntries(required.map((c) => [String(c.name), /INT|REAL|NUM/i.test(String(c.type)) ? 0 : "x"])), ...values };
  await db().execute({ sql: `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`, args: Object.values(row) as never[] });
}
/** A person's saved draft of a production, holding its Cast & Elements (and anything else given). */
async function draft(owner: string, projectId: string, productionId: string, extra: Record<string, unknown> = {}) {
  const { db } = await import("../../lib/db");
  const body = JSON.stringify({ id: projectId, name: "Draft", productionProjectId: productionId, ...extra });
  await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body", args: [`${owner}:${projectId}`, owner, projectId, "Draft", body, Date.now()] });
}
async function archived(reason?: string) {
  const { db } = await import("../../lib/db");
  await (await import("../../lib/archive")).archiveReady();
  const rs = await db().execute({ sql: `SELECT * FROM archived_rows WHERE table_name = 'atomik_memory'${reason ? " AND reason = ?" : ""} ORDER BY archived_at`, args: reason ? [reason] : [] });
  return rs.rows.map((r) => ({ rowId: String(r.row_id), by: r.archived_by == null ? null : String(r.archived_by), body: JSON.parse(String(r.body)) as Record<string, unknown> }));
}
type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
/** A route file as it ships, signed in as `user` in `ws` (auth stubbed, everything else real). */
async function route<T>(file: string, ws: TenantWorkspace, user: TenantUser, extra: Record<string, unknown> = {}, token?: unknown): Promise<T> {
  const auth = await import("../../lib/auth");
  const { runInTenant } = await import("../../lib/tenant");
  return loadRouteModule<T>(file, {
    "@/lib/auth": { ...auth,
      withTenant: (fn: Handler) => (req: Request, ctx?: unknown) => runInTenant(ws, () => fn(req, ctx), { user, ...(token ? { token } : {}) } as never),
      requireSession: async () => (token ? { response: Response.json({ error: "API tokens cannot." }, { status: 403 }) } : { user }),
      requireRender: async () => ({ user, ...(token ? { token } : {}) }),
      requireUser: async () => ({ user }) },
    ...extra,
  });
}
const scopeOf = (ws: TenantWorkspace, user: TenantUser) => ({ "X-Workbench-Scope": `particl-active-${ws.id}-${user.id}` });


const json = (ws: TenantWorkspace, user: TenantUser, body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json", ...scopeOf(ws, user) }, body: JSON.stringify(body) });
type Memory = { GET: Handler; POST: Handler };
type One = { PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>; DELETE: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };
const production = (id: string) => insertRow("projects", { id, name: `Production ${id}`, created_at: Date.now() });
const SECRET = "Secret lead is Maya, ends on the lighthouse.";
const GONE = "prj_wb_does_not_exist";

/** Owner's private board (a draft and its `prj_wb_…` project), one entry under it, one for the whole workspace. */
async function seed(ws: TenantWorkspace, owner: TenantUser) {
  const { mappedId, DRAFT_PROJECT_PREFIX } = await import("../../lib/draftProject");
  const m = await import("../../lib/atomikMemory");
  const board = mappedId(DRAFT_PROJECT_PREFIX, ws.id, owner.id, "d1");
  return inTenant(ws, async () => {
    await insertRow("projects", { id: board, name: "Private board", created_at: Date.now() });
    await insertRow("projects", { id: GONE.replace("does_not_exist", "other"), name: "A project nobody drafted", created_at: Date.now() });
    await draft(owner.id, "d1", board);
    const secret = await m.addMemory({ kind: "note", text: SECRET, projectId: board }, owner.id);
    const open = await m.addMemory({ kind: "note", text: "Every spot ends on a beat of silence." }, owner.id);
    return { board, secret, open };
  }, owner);
}
async function share(ws: TenantWorkspace, owner: TenantUser) {
  const { db } = await import("../../lib/db");
  await inTenant(ws, () => db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner=?", args: [owner.id] }), owner);
}
const texts = (r: { entries: { text: string }[] }) => r.entries.map((e) => e.text).sort();

test("a member cannot list, read into, add, keep, import, find, edit or forget on someone else's private board: each answers as an unknown project does, and nothing leaks", async () => {
  const ws = workspace();
  const owner = person("u_owner", "owner"), mate = person("u_mate", "member"), admin = person("u_admin", "admin");
  const { board, secret, open } = await seed(ws, owner);
  for (const who of [mate, admin]) {
    const memory = await route<Memory>("app/api/atomik/memory/route.ts", ws, who);
    const one = await route<One>("app/api/atomik/memory/[id]/route.ts", ws, who);
    const listed = async (projectId: string) => { const r = await memory.GET(new Request(`https://studio.test/api/atomik/memory?projectId=${projectId}`, { headers: scopeOf(ws, who) })); return [r.status, await r.json()] as const; };
    /* Listing: the workspace's own entries only, byte for byte what an unknown project gives. */
    const [status, seen] = await listed(board);
    const [unknownStatus, unknown] = await listed(GONE);
    expect(status).toBe(200);
    expect(unknownStatus).toBe(200);
    expect(texts(seen)).toEqual(["Every spot ends on a beat of silence."]);
    expect(JSON.stringify(seen)).not.toContain("Maya");
    expect(JSON.stringify(seen)).toBe(JSON.stringify(unknown));
    const post = async (action: string, extra: Record<string, unknown>) => { const r = await memory.POST(new Request("https://studio.test/api/atomik/memory", json(ws, who, { action, ...extra }))); return [r.status, await r.json()] as const; };
    /* Writes: refused with the unknown-project answer, whatever the board is called. */
    for (const [action, extra] of [
      ["add", { kind: "note", text: "A line for the board." }],
      ["keep", { items: [{ kind: "note", text: "Kept line." }], from: "atomik-read" }],
      ["import", { text: "- Imported line about the lighthouse." }],
    ] as const) {
      const mine = await post(action, { ...extra, projectId: board });
      const theirs = await post(action, { ...extra, projectId: GONE });
      expect(mine[0]).toBe(404);
      expect(mine).toEqual(theirs);
      expect(JSON.stringify(mine)).not.toContain(board);
    }
    /* Finding what to forget: the workspace's entries only. */
    const [, found] = await post("find", { text: "lighthouse", projectId: board });
    expect(JSON.stringify(found)).not.toContain("Maya");
    /* An entry under that board is as gone as an id that was never there: edited, forgotten, listed. */
    const edit = await one.PATCH(new Request(`https://studio.test/api/atomik/memory/${secret.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...scopeOf(ws, who) }, body: JSON.stringify({ text: "Changed." }) }), { params: Promise.resolve({ id: secret.id }) });
    const editNone = await one.PATCH(new Request("https://studio.test/api/atomik/memory/mem_none", { method: "PATCH", headers: { "Content-Type": "application/json", ...scopeOf(ws, who) }, body: JSON.stringify({ text: "Changed." }) }), { params: Promise.resolve({ id: "mem_none" }) });
    expect(edit.status).toBe(404);
    expect(await edit.json()).toEqual(await editNone.json());
    const del = await one.DELETE(new Request(`https://studio.test/api/atomik/memory/${secret.id}`, { method: "DELETE", headers: scopeOf(ws, who) }), { params: Promise.resolve({ id: secret.id }) });
    expect(del.status).toBe(404);
    const absent = `${secret.id.slice(0, -1)}${secret.id.endsWith("0") ? "1" : "0"}`;
    const hidden = await post("forget", { ids: [secret.id] });
    expect(hidden).toEqual(await post("forget", { ids: [absent] }));
    expect(hidden[1]).toEqual({ forgotten: 0 });
    /* Moving an entry onto that board is refused too. */
    const move = await one.PATCH(new Request(`https://studio.test/api/atomik/memory/${open.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...scopeOf(ws, who) }, body: JSON.stringify({ projectId: board }) }), { params: Promise.resolve({ id: open.id }) });
    expect(move.status).toBe(404);
  }
  /* Nothing changed under the board, and the owner still has the entry as it was. */
  const m = await import("../../lib/atomikMemory");
  await inTenant(ws, async () => {
    const mine = await m.listMemory(board, owner.id);
    expect(mine.map((e) => e.text).sort()).toEqual(["Every spot ends on a beat of silence.", SECRET]);
    expect((await archived()).length).toBe(0);
  }, owner);
});

test("the owner lists, adds, keeps, imports, edits and forgets on their own board", async () => {
  const ws = workspace();
  const owner = person("u_owner", "owner");
  const { board, secret } = await seed(ws, owner);
  const m = await import("../../lib/atomikMemory");
  await inTenant(ws, async () => {
    expect((await m.listMemory(board, owner.id)).map((e) => e.text)).toContain(SECRET);
    const added = await m.addMemory({ kind: "note", text: "Open on the harbour." , projectId: board }, owner.id);
    expect(added.projectId).toBe(board);
    expect((await m.keepMemory({ items: [{ kind: "note", text: "Keep the grain heavy." }], from: "atomik-read", projectId: board }, owner.id)).entries.length).toBe(1);
    expect((await m.importMemory({ text: "- Imported: grade it warm.", projectId: board }, owner.id)).entries.length).toBeGreaterThan(0);
    expect((await m.updateMemory(secret.id, { text: "Maya, lighthouse." }, owner.id)).text).toContain("Maya");
    expect(await m.forgetMemory([added.id], owner.id)).toBe(1);
  }, owner);
});

test("a teammate may READ a shared board's memory but not write it, and an admin is no different", async () => {
  const ws = workspace();
  const owner = person("u_owner", "owner"), mate = person("u_mate", "member"), admin = person("u_admin", "admin");
  const { board, secret } = await seed(ws, owner);
  await share(ws, owner);
  const m = await import("../../lib/atomikMemory");
  for (const who of [mate, admin]) await inTenant(ws, async () => {
    expect((await m.listMemory(board, who.id)).map((e) => e.text)).toContain(SECRET);
    expect((await m.findForForget("lighthouse", board, who.id)).matches?.length ?? 1).toBeGreaterThan(0);
    await expect(m.addMemory({ kind: "note", text: "Mine." , projectId: board }, who.id)).rejects.toMatchObject({ status: 404 });
    await expect(m.keepMemory({ items: [{ kind: "note", text: "Mine." }], from: "atomik-read", projectId: board }, who.id)).rejects.toMatchObject({ status: 404 });
    await expect(m.importMemory({ text: "- Mine, about the harbour.", projectId: board }, who.id)).rejects.toMatchObject({ status: 404 });
    await expect(m.updateMemory(secret.id, { text: "Overwritten." }, who.id)).rejects.toMatchObject({ status: 404 });
    expect(await m.forgetMemory([secret.id], who.id)).toBe(0);
  }, who);
  await inTenant(ws, async () => expect((await m.listMemory(board, owner.id)).map((e) => e.text)).toContain(SECRET), owner);
});

test("the paid read files under a board only for a person who may file into it", async () => {
  const ws = workspace();
  const owner = person("u_owner", "owner"), mate = person("u_mate", "member");
  const { board } = await seed(ws, owner);
  await share(ws, owner);
  const read = async (who: TenantUser, projectId: string) => {
    const seen: unknown[] = [];
    const real = await import("../../lib/atomikMemoryRead");
    const mod = await route<{ POST: Handler }>("app/api/atomik/memory/read/route.ts", ws, who, {
      "@/lib/language-provider": { languageReachable: () => true },
      "@/lib/atomik": { resolveModel: async () => "mock-model" },
      "@/lib/generationRequests": { withGenerationRequest: (_req: Request, _id: string, run: () => Promise<Response>) => run(), ANSWER_AFTER_MS: 0 },
      "@/lib/textRunCost": { textRunCost: async () => ({}) },
      "@/lib/demo/spend-guard.server": { sampleWorkspaceOff: async () => null },
      "@/lib/atomikMemoryRead": { ...real, runMemoryRead: async (input: { projectId: string | null }) => { seen.push(input.projectId); return { id: "run", read: { entries: [], skipped: {} } }; } },
    });
    const res = await mod.POST(new Request("https://studio.test/api/atomik/memory/read", json(ws, who, { text: "Some notes.", projectId, maxCredits: 5 })));
    return { status: res.status, projectId: seen[0] };
  };
  /* The owner's own board is filed under; a teammate's shared board, which they may only look at, and an unknown one, are filed under nothing. */
  expect(await read(owner, board)).toMatchObject({ projectId: board });
  expect((await read(mate, board)).projectId).toBeNull();
  expect((await read(mate, GONE)).projectId).toBeNull();
});

/* ── References and the sample follow the board's rules ──────────────── */

async function markSample(ws: TenantWorkspace, by: TenantUser, projectId: string, draftId: string) {
  const { db } = await import("../../lib/db");
  const mark = { version: 1, projectId, name: "Sample", draftOwner: by.id, draftId, markedBy: by.id, markedAt: 1 };
  await inTenant(ws, () => db().execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)", args: ["sampleProduction", JSON.stringify(mark), by.id, 1] }), by);
}

test("a reference to a take or an upload the person may not open is answered as an id that is not there: no title, no prompt, no confirmation", async () => {
  const ws = workspace();
  const owner = person("u_owner", "owner"), mate = person("u_mate", "member");
  const { board } = await seed(ws, owner);
  const m = await import("../../lib/atomikMemory");
  const take = async (id: string, project: string | null) => insertRow("generations", { id, model: "m", prompt: "Secret prompt about the lighthouse", params: "{}", status: "succeeded", created_at: 1, updated_at: 1, kind: "image", title: "Secret take title", deleted: 0, created_by: owner.id, project_id: project, stored_url: `/api/media/${id}` });
  await inTenant(ws, async () => {
    await insertRow("projects", { id: "prod_open", name: "Ordinary production", created_at: 1 });
    await take("gen_private", board); await take("gen_open", "prod_open");
    await insertRow("uploads", { id: "up_private", uploader_id: owner.id, filename: "secret-photo.png", kind: "image", mime: "image/png" });
    await insertRow("uploads", { id: "up_unowned", uploader_id: null, filename: "old-logo.png", kind: "image", mime: "image/png" });
  }, owner);
  const ref = (assetId: string, by: TenantUser) => inTenant(ws, () => m.addMemory({ kind: "reference", text: "A reference.", assetId }, by.id), by);
  const missing = await ref("generation:gen_nowhere", mate).catch((e) => e);
  expect(missing).toMatchObject({ status: 404 });
  for (const id of ["generation:gen_private", "upload:up_private"]) {
    const refused = await ref(id, mate).catch((e) => e);
    expect(refused).toMatchObject({ status: 404 });
    expect(refused.message).toBe(missing.message);
    expect(refused.message).not.toMatch(/Secret|secret|lighthouse/);
  }
  /* The owner may, and reads the name; a take of an ordinary project, and an upload with no uploader, are everyone's. */
  expect(await ref("generation:gen_private", owner)).toMatchObject({ assetLabel: "Secret take title" });
  expect(await ref("generation:gen_open", mate)).toMatchObject({ assetLabel: "Secret take title" });
  expect(await ref("upload:up_unowned", mate)).toMatchObject({ assetLabel: "old-logo.png" });
  /* Shared, the board's takes are open to look at. */
  await share(ws, owner);
  expect(await ref("generation:gen_private", mate)).toMatchObject({ assetId: "generation:gen_private" });
});

test("the marked sample: anyone may read its memory, only its marker writes it", async () => {
  for (const kind of ["board", "plain"] as const) {
    const ws = workspace();
    const marker = person("u_marker", "owner"), mate = person("u_mate", "member"), admin = person("u_admin", "admin");
    const m = await import("../../lib/atomikMemory");
    let project: string;
    if (kind === "board") project = (await seed(ws, marker)).board;
    else { project = "prod_sample"; await inTenant(ws, () => production(project), marker); }
    await markSample(ws, marker, project, "d1");
    const kept = await inTenant(ws, () => m.addMemory({ kind: "note", text: "The sample keeps a lighthouse." , projectId: project }, marker.id), marker);
    expect(kept.projectId).toBe(project);
    for (const who of [mate, admin]) await inTenant(ws, async () => {
      expect((await m.listMemory(project, who.id)).map((e) => e.text)).toContain("The sample keeps a lighthouse.");
      await expect(m.addMemory({ kind: "note", text: "Mine." , projectId: project }, who.id)).rejects.toMatchObject({ status: 404 });
      await expect(m.keepMemory({ items: [{ kind: "note", text: "Mine." }], from: "atomik-read", projectId: project }, who.id)).rejects.toMatchObject({ status: 404 });
      await expect(m.importMemory({ text: "- Mine, about the harbour.", projectId: project }, who.id)).rejects.toMatchObject({ status: 404 });
      await expect(m.updateMemory(kept.id, { text: "Overwritten." }, who.id)).rejects.toMatchObject({ status: 404 });
      expect(await m.forgetMemory([kept.id], who.id)).toBe(0);
      /* The entry says so: readable, not changeable. */
      expect((await m.listMemory(project, who.id)).find((e) => e.id === kept.id)?.readOnly).toBe(true);
    }, who);
    await inTenant(ws, async () => {
      expect((await m.listMemory(project, marker.id)).find((e) => e.id === kept.id)?.readOnly).toBe(false);
      expect((await m.updateMemory(kept.id, { text: "The sample keeps two lighthouses." }, marker.id)).text).toContain("two");
    }, marker);
  }
});

test("the platform owner writes the marked sample's memory, as the rule says (owner, 13 Oct): add, keep, import, edit and forget all work, and nothing marks it read-only for them", async () => {
  /* The platform owner is named by the deployment (isPlatformOwner, lib/auth.ts): the configured address. */
  const previous = process.env.SUPER_ADMIN_EMAIL;
  process.env.SUPER_ADMIN_EMAIL = "u_platform@example.test";
  try {
    for (const kind of ["board", "plain"] as const) {
      const ws = workspace();
      const marker = person("u_marker", "owner"), platform = person("u_platform", "admin"), mate = person("u_mate", "member");
      const m = await import("../../lib/atomikMemory");
      let project: string;
      if (kind === "board") project = (await seed(ws, marker)).board;
      else { project = "prod_sample"; await inTenant(ws, () => production(project), marker); }
      await markSample(ws, marker, project, "d1");
      const kept = await inTenant(ws, () => m.addMemory({ kind: "note", text: "The sample keeps a lighthouse." , projectId: project }, marker.id), marker);
      await inTenant(ws, async () => {
        const added = await m.addMemory({ kind: "note", text: "Added by the platform owner.", projectId: project }, platform.id);
        expect(added.projectId, kind).toBe(project);
        expect((await m.keepMemory({ items: [{ kind: "note", text: "Kept by the platform owner." }], from: "atomik-read", projectId: project }, platform.id)).entries.length, kind).toBe(1);
        expect((await m.importMemory({ text: "- Imported by the platform owner, about the harbour.", projectId: project }, platform.id)).entries.length, kind).toBeGreaterThan(0);
        expect((await m.updateMemory(kept.id, { text: "The sample keeps two lighthouses." }, platform.id)).text, kind).toContain("two");
        expect((await m.listMemory(project, platform.id)).every((e) => e.readOnly === false), `${kind}: nothing is read-only for the platform owner`).toBe(true);
        expect(await m.forgetMemory([added.id], platform.id), kind).toBe(1);
      }, platform);
      /* The same address does not lift anyone else: a member is still refused on the same sample. */
      await inTenant(ws, async () => { await expect(m.addMemory({ kind: "note", text: "Mine.", projectId: project }, mate.id), kind).rejects.toMatchObject({ status: 404 }); }, mate);
    }
  } finally {
    /* The next spec in this worker must not inherit a platform owner. */
    if (previous === undefined) delete process.env.SUPER_ADMIN_EMAIL;
    else process.env.SUPER_ADMIN_EMAIL = previous;
  }
});

test("readOnly marks the entries a person can read but not change: a shared board's, never their own or the workspace's", async () => {
  const ws = workspace();
  const owner = person("u_owner", "owner"), mate = person("u_mate", "member");
  const { board, secret, open } = await seed(ws, owner);
  await share(ws, owner);
  const m = await import("../../lib/atomikMemory");
  const flags = async (who: TenantUser) => inTenant(ws, async () => Object.fromEntries((await m.listMemory(board, who.id)).map((e) => [e.id, e.readOnly])), who);
  expect(await flags(mate)).toEqual({ [secret.id]: true, [open.id]: false });
  expect(await flags(owner)).toEqual({ [secret.id]: false, [open.id]: false });
  /* Every route's reply carries it. */
  await inTenant(ws, async () => expect((await m.memoryView(secret, mate.id)).readOnly).toBe(true), mate);
});
