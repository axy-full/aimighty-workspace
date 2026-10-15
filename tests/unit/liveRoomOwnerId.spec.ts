import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { authAs, freshDatabases, scoped, workspace, type Who } from "./demo-gaps-l5-harness";
import type { LiveRoot, RoomClient } from "../../lib/workbench/canvas-push";
import type { CanvasNode } from "../../lib/workbench/studio";

/**
 * The live room shows no account id of the platform owner in a client workspace (owner, 14 Oct: "hide my account id in client workspaces"). Liveblocks shows every person's
 * user id to the others in a room, and the room's storage is read by every member, so both are checked: the id the owner is signed into the room with
 * (app/api/collab/auth/route.ts), and who the room is told made a card (lib/workbench/canvas-push.ts). Members and the house are unchanged, and the stored canvas keeps the raw
 * id the server compares. Rooms are a stand-in here: never the real service. Neutral names only.
 */
const dir = freshDatabases("room-owner-id");
const run = Math.random().toString(36).slice(2, 8);
const ROOT_EMAIL = `root-${run}@example.test`;
const CLIENT = workspace(dir, `ws_client_${run}`), HOUSE = workspace(dir, "ws_legacy");
let envBefore: string | undefined, keyBefore: string | undefined;
test.beforeEach(async () => {
  envBefore = process.env.SUPER_ADMIN_EMAIL; keyBefore = process.env.LIVEBLOCKS_SECRET_KEY;
  process.env.SUPER_ADMIN_EMAIL = ROOT_EMAIL; process.env.LIVEBLOCKS_SECRET_KEY = "sk_test_stand_in";
  (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity();
});
test.afterEach(async () => {
  if (envBefore === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = envBefore;
  if (keyBefore === undefined) delete process.env.LIVEBLOCKS_SECRET_KEY; else process.env.LIVEBLOCKS_SECRET_KEY = keyBefore;
  (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity();
});
test.describe.configure({ mode: "serial" });

let people: Promise<{ root: string; member: string }> | null = null;
function fixture() {
  people ??= (async () => {
    const platform = await import("../../lib/platform");
    const { hashPassword } = await import("../../lib/auth");
    await platform.platformReady();
    const root = await platform.createAccount(ROOT_EMAIL, "Rhea Rootname", hashPassword("Unique-studio-password-43"));
    const member = await platform.createAccount(`mia-${run}@example.test`, "Mia Member", hashPassword("Unique-studio-password-43"));
    expect(root.id).toMatch(/^usr_/);
    return { root: root.id, member: member.id };
  })();
  return people;
}
const asWho = (ws: typeof CLIENT, userId: string, role: Who["role"], name: string): Who => ({ mode: "session", ws, userId, name, role, bearer: "" });

/** The live-room sign-in route, as the real withTenant runs it, with Liveblocks and the production check stood in; returns who it signed into the room. */
async function signedIn(who: Who): Promise<{ status: number; userId: string; info: { name?: string; color?: string } }> {
  const auth = await authAs(who);
  const signed: { userId: string; info: { name?: string; color?: string } }[] = [];
  const fakes: Record<string, unknown> = {
    "@/lib/auth": auth,
    "@liveblocks/node": { Liveblocks: class { prepareSession(userId: string, options: { userInfo: { name?: string; color?: string } }) { signed.push({ userId, info: options.userInfo }); return { allow() {}, authorize: async () => ({ status: 200, body: "{}" }) }; } } },
    "@/lib/workbench/team-canvas": { productionOfRoom: () => "prod_x", requireProduction: async () => ({}), TeamCanvasError: class extends Error {} },
  };
  const real = createRequire(path.resolve("app/api/collab/auth/route.ts"));
  const compiled = ts.transpileModule(readFileSync(path.resolve("app/api/collab/auth/route.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(process.cwd(), name.slice(2))) : real(name)), mod, mod.exports);
  const { POST } = mod.exports as typeof import("../../app/api/collab/auth/route");
  const res = await POST(scoped(who, "http://localhost/api/collab/auth", { method: "POST", body: JSON.stringify({ room: `particl:${who.ws!.id}:prod_x` }) }), undefined as never);
  expect(signed.length, await res.clone().text()).toBe(1);
  return { status: res.status, ...signed[0] };
}

test("a client workspace's room signs the owner in as the opaque support id; a member and the house are signed in as before", async () => {
  const { root, member } = await fixture();
  const { supportMemberId } = await import("../../lib/platformOwnerPrivacy");
  const owner = await signedIn(asWho(CLIENT, root, "owner", "Particl support"));
  expect(owner.status).toBe(200);
  expect(owner.userId).toBe(`${CLIENT.id}:${supportMemberId(CLIENT.id, root)}`);
  expect(owner.userId).toMatch(/:support_[0-9a-f]{24}$/);
  expect(JSON.stringify(owner)).not.toContain(root);
  expect(owner.info.name).toBe("Particl support");
  /* The same person is the same room user from every window and visit; another workspace gives another id. */
  expect((await signedIn(asWho(CLIENT, root, "owner", "Particl support"))).userId).toBe(owner.userId);
  expect(supportMemberId(CLIENT.id, root)).not.toBe(supportMemberId(HOUSE.id, root));
  expect((await signedIn(asWho(CLIENT, member, "admin", "Mia Member"))).userId).toBe(`${CLIENT.id}:${member}`);
  expect((await signedIn(asWho(HOUSE, root, "owner", "Rhea Rootname"))).userId).toBe(`${HOUSE.id}:${root}`);
});

test("the owner's own window still knows its room: peers are told apart by connection, never by account id, and a person's colour is stable", async () => {
  const { root } = await fixture();
  const { roomPeer } = await import("../../lib/workbench/team-canvas-model");
  const { collabColor } = await import("../../lib/collab");
  const owner = await signedIn(asWho(CLIENT, root, "owner", "Particl support"));
  const peer = roomPeer({ connectionId: 41, info: owner.info, presence: { cursor: { x: 1, y: 2 }, selected: "card", drag: null } });
  expect(peer).toMatchObject({ id: 41, name: "Particl support", cursor: { x: 1, y: 2 }, selected: "card" });
  expect(owner.info.color).toBe(collabColor(root));
  expect(JSON.stringify(peer)).not.toContain(root);
});

/* ── What the room is told of who made a card ─────────────────────────── */

class FakeMap {
  m = new Map<string, unknown>();
  get(key: string) { return this.m.get(key); }
  set(key: string, value: unknown) { this.m.set(key, JSON.parse(JSON.stringify(value))); }
  delete(key: string) { return this.m.delete(key); }
}
function fakeRoom() {
  const store = new Map<string, unknown>([["nodes", new FakeMap()], ["assets", new FakeMap()], ["order", []]]);
  const root: LiveRoot = { get: (key) => store.get(key), set: (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); } };
  const client: RoomClient = { async mutateStorage(_id, callback) { await callback({ root }); }, async setPresence() {} };
  return { client, made: () => (store.get("serverMade") ?? {}) as Record<string, string> };
}
const scene = (id: string): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 238, linked: [] });

/** One production with a card made by `author`, pushed into a stand-in room: what the room was told, and what the canvas itself stores. */
async function pushedBy(ws: typeof CLIENT, author: string) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const { readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const room = fakeRoom();
  return runInTenant(ws, async () => {
    await ready();
    await db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod-1','Team',0)");
    const result = await applyCanvasOps("prod-1", { opId: `build-${author}`, ops: [{ kind: "create", node: scene(`s-${author.slice(-6)}`) }], author, what: "ops" }, { room: room.client });
    expect(result.live).toBe("sent");
    return { told: room.made(), stored: (await readTeamCanvas("prod-1"))!.canvas.serverMade };
  });
}

test("the room is never told the owner's account id in a client workspace; the member's own id and the house's are as before, and the stored canvas keeps the raw id", async () => {
  const { root, member } = await fixture();
  const { supportMemberId } = await import("../../lib/platformOwnerPrivacy");
  const owned = await pushedBy(CLIENT, root);
  expect(Object.values(owned.told)).toEqual([supportMemberId(CLIENT.id, root)]);
  expect(JSON.stringify(owned.told)).not.toContain(root);
  /* The server compares the stored author (who may take back what Atomik made for whom): that stays the raw id. */
  expect(Object.values(owned.stored)).toEqual([root]);
  expect(Object.keys(owned.told)).toEqual(Object.keys(owned.stored));
  expect(Object.values((await pushedBy(CLIENT, member)).told)).toEqual([member]);
  expect(Object.values((await pushedBy(HOUSE, root)).told)).toEqual([root]);
});
