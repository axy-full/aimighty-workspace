import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Handing a board over is one atomic fact (board sharing, PR 4): the ownership row, its audit line and the move of the board's live room are one transaction, read inside it
 * and written only against what was read; a board that changed hands meanwhile is a 409 and nothing at all lands; Undo goes only to a member who is still active; and the old
 * room is closed after the commit. Liveblocks is stubbed at the network edge. Real temporary databases; sign-in is a fake.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-board-transfer-hard-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.LIVEBLOCKS_SECRET_KEY = "sk_test_stub_secret";
const run = Math.random().toString(36).slice(2, 8);
type Who = { id: string; role: "admin" | "member"; name: string; email: string };
const who = (id: string, role: "admin" | "member" = "member"): Who => ({ id, role, name: id, email: `${id}@example.test` });
const asUser = (w: Who) => ({ user: { ...w, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
const ADMIN = { ...who("u_admin", "admin"), owner: true };
const settle = async <T,>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: Error & { status?: number }) => ({ ok: false as const, message: error.message, status: error.status }));

async function fixture(name: string) {
  const ws = { id: `bth-${name}-${run}`, name, slug: name, legacy: false, dbUrl: `file:${path.join(dir, `bth-${name}-${run}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true } as TenantWorkspace;
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), records = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const platform = await import("../../lib/platform");
  const transfer = await import("../../lib/workbench/board-transfer");
  const { mappedId } = await import("../../lib/draftProject");
  const rooms = await import("../../lib/workbench/room-rotation");
  const { teamRoomFor } = await import("../../lib/workbench/team-canvas");
  await platform.platformReady();
  for (const [id, role] of [["u_owner", "member"], ["u_new", "member"], ["u_mate", "member"], ["u_admin", "admin"]] as const) {
    await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [id, `${id}@example.test`, id, "x"] });
    await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, id, role] });
  }
  const as = <T,>(p: Who, fn: () => Promise<T>) => tenant.runInTenant(ws, fn, asUser(p));
  await as(ADMIN, async () => { await database.ready(); await database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod_linked','Linked',0)", args: [] }); });
  const ids: Record<string, string> = {};
  for (const [draft, linked] of [["d1", "prod_linked"], ["d2", undefined]] as const) {
    const saved = await as(who("u_owner"), async () => { await records.workbenchReady(); return records.saveDraft("u_owner", { ...newProject(draft), id: draft, nodes: [], ...(linked ? { productionProjectId: linked } : {}) } as never, 0); });
    void saved;
    /* The board's own project (the id a hand-over names); the room is the production its draft is linked to. */
    ids[draft] = mappedId("prj_wb_", ws.id, "u_owner", draft);
  }
  const move = (projectIds: string[], to: string) => as(ADMIN, () => settle(transfer.transferBoards(ws, ADMIN as never, projectIds, to)));
  const undo = (projectIds: string[]) => as(ADMIN, () => settle(transfer.undoTransfers(ws, ADMIN as never, projectIds)));
  const sql = (statement: string, args: (string | number)[] = []) => as(ADMIN, async () => (await database.db().execute({ sql: statement, args })).rows as unknown as Record<string, unknown>[]);
  const owner = (production: string) => as(ADMIN, async () => (await (await import("../../lib/draftProject")).boardOwnerOf(production))?.owner);
  const audit = () => sql("SELECT action FROM security_audit WHERE action LIKE 'board.transfer%'").then((r) => r.map((x) => String(x.action)));
  const generation = (production: string) => as(ADMIN, () => rooms.roomGeneration(production));
  const setMembership = (id: string, disabled: number) => platform.platformDb().execute({ sql: "UPDATE memberships SET disabled=? WHERE workspace_id=? AND account_id=?", args: [disabled, ws.id, id] });
  const dropMembership = (id: string) => platform.platformDb().execute({ sql: "DELETE FROM memberships WHERE workspace_id=? AND account_id=?", args: [ws.id, id] });
  return { ws, ids, move, undo, sql, owner, audit, generation, teamRoomFor, setMembership, dropMembership, as };
}

test("the room each moved board is edited in moves with the change, and the old room is closed after the commit; Undo moves it again", async () => {
  const f = await fixture("rooms");
  const deletes: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if ((init?.method ?? "GET") === "DELETE" && url.includes("/rooms/")) { deletes.push(decodeURIComponent(url.split("/rooms/")[1])); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected network call ${url}`);
  }) as typeof fetch;
  try {
    expect([await f.generation("prod_linked"), await f.generation(f.ids.d2)]).toEqual([0, 0]);
    const first = await f.move([f.ids.d1, f.ids.d2], "u_new");
    expect(first.ok, JSON.stringify(first)).toBe(true);
    /* The room of a draft LINKED to another production is that production's, not a recomputed default. */
    expect([await f.generation("prod_linked"), await f.generation(f.ids.d2)]).toEqual([1, 1]);
    expect(deletes.sort()).toEqual([f.teamRoomFor(f.ws.id, "prod_linked", 0), f.teamRoomFor(f.ws.id, f.ids.d2, 0)].sort());
    deletes.length = 0;
    expect((await f.undo([f.ids.d1])).ok).toBe(true);
    expect(await f.generation("prod_linked")).toBe(2);
    expect(deletes).toEqual([f.teamRoomFor(f.ws.id, "prod_linked", 1)]);
    expect(await f.generation(f.ids.d2), "a board not undone keeps its room").toBe(1);
  } finally { globalThis.fetch = realFetch; }
});

test("the ownership row, the audit line and the room move are one transaction: if the room cannot move, nothing lands", async () => {
  const f = await fixture("atomic");
  await f.sql("CREATE TRIGGER bth_rooms_down BEFORE INSERT ON settings WHEN NEW.key LIKE 'collab:room-generation:%' BEGIN SELECT RAISE(ABORT,'rooms are down'); END");
  const moved = await f.move([f.ids.d1], "u_new");
  expect(moved.ok).toBe(false);
  expect(await f.owner(f.ids.d1)).toBe("u_owner");
  expect(await f.sql("SELECT 1 FROM workbench_board_owners")).toHaveLength(0);
  expect(await f.audit()).toEqual([]);
  await f.sql("DROP TRIGGER bth_rooms_down");
  expect((await f.move([f.ids.d1], "u_new")).ok).toBe(true);
  /* And for Undo. */
  await f.sql("CREATE TRIGGER bth_rooms_down2 BEFORE INSERT ON settings WHEN NEW.key LIKE 'collab:room-generation:%' BEGIN SELECT RAISE(ABORT,'rooms are down'); END");
  expect((await f.undo([f.ids.d1])).ok).toBe(false);
  expect(await f.owner(f.ids.d1)).toBe("u_new");
  expect(await f.audit()).toEqual(["board.transferred"]);
});

test("written against what was read: a board that changed hands meanwhile is a 409, all or none, with no audit line, no room moved and nothing changed", async () => {
  const f = await fixture("mismatch");
  /* A first hand-over to Mia lands (the row now exists); then every write to the table is silently dropped, as if another request had changed it between the read and the write. */
  expect((await f.move([f.ids.d1], "u_mate")).ok).toBe(true);
  await f.sql("CREATE TRIGGER bth_ignore_update BEFORE UPDATE ON workbench_board_owners BEGIN SELECT RAISE(IGNORE); END");
  await f.sql("CREATE TRIGGER bth_ignore_insert BEFORE INSERT ON workbench_board_owners BEGIN SELECT RAISE(IGNORE); END");
  const linkedGeneration = await f.generation("prod_linked");
  const before = await f.audit();
  /* d2 has no row (an insert that does not land) and d1 has one (an update that does not): the batch lands neither. */
  const moved = await f.move([f.ids.d2, f.ids.d1], "u_new");
  expect(moved).toMatchObject({ ok: false, status: 409 });
  expect(await f.owner(f.ids.d1)).toBe("u_mate");
  expect(await f.owner(f.ids.d2)).toBe("u_owner");
  expect(await f.audit(), "no line for a change that did not land").toEqual(before);
  expect(await f.generation("prod_linked"), "no room moved").toBe(linkedGeneration);
  expect(await f.generation(f.ids.d2)).toBe(0);
  expect(await f.undo([f.ids.d1])).toMatchObject({ ok: false, status: 409 });
  expect(await f.owner(f.ids.d1)).toBe("u_mate");
  expect(await f.audit()).toEqual(before);
  await f.sql("DROP TRIGGER bth_ignore_update"); await f.sql("DROP TRIGGER bth_ignore_insert");
  expect((await f.move([f.ids.d2, f.ids.d1], "u_new")).ok).toBe(true);
  expect(await f.audit(), "one line for each board that really changed hands").toEqual(["board.transferred", "board.transferred", "board.transferred"]);
});

test("Undo goes only to a member who is still active: a board is not handed back to someone switched off or removed", async () => {
  const f = await fixture("undo-target");
  expect((await f.move([f.ids.d1], "u_new")).ok).toBe(true);
  await f.setMembership("u_owner", 1);
  expect(await f.undo([f.ids.d1])).toMatchObject({ ok: false, status: 404 });
  expect(await f.owner(f.ids.d1)).toBe("u_new");
  await f.dropMembership("u_owner");
  expect(await f.undo([f.ids.d1])).toMatchObject({ ok: false, status: 404 });
  expect(await f.owner(f.ids.d1)).toBe("u_new");
  expect(await f.audit()).toEqual(["board.transferred"]);
  /* Active again: it goes back. */
  const platform = await import("../../lib/platform");
  await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [f.ws.id, "u_owner", "member"] });
  expect((await f.undo([f.ids.d1])).ok).toBe(true);
  expect(await f.owner(f.ids.d1)).toBe("u_owner");
});
