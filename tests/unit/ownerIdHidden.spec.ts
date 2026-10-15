import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { authAs, freshDatabases, scoped, seedPeople, workspace, type Who } from "./demo-gaps-l5-harness";

/**
 * The platform owner's account id is hidden from the members of a client workspace (owner, 14 Oct: "hide my account id in client workspaces"). It is hidden in what is SENT
 * (lib/platformOwnerPrivacy.ts › hideOwnerAccountId, called by withTenant on every JSON answer), never in what is stored: the server keeps the raw id for who may change
 * work, who may release a take, the tray and recovery. The owner's own screens compare their id with what they made, so the owner's id stays as it is for the owner; the
 * house workspace is untouched. These run the real lib/auth.ts (withTenant, the session) on real temporary databases; nothing is sent or spent.
 */
const dir = freshDatabases("owner-id");
const run = Math.random().toString(36).slice(2, 8);
const ROOT_EMAIL = `root-${run}@example.test`;
const CLIENT = workspace(dir, `ws_client_${run}`), HOUSE = workspace(dir, "ws_legacy");
let envBefore: string | undefined;
test.beforeEach(async () => { envBefore = process.env.SUPER_ADMIN_EMAIL; process.env.SUPER_ADMIN_EMAIL = ROOT_EMAIL; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });
test.afterEach(async () => { if (envBefore === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = envBefore; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });
test.describe.configure({ mode: "serial" });

type Ids = { root: string; member: string };
let ids: Promise<Ids> | null = null;

/** The owner's account, a member's, a client workspace and the house; in each: a take, a note and a chat message made by the owner, and one of the member's. */
function fixture(): Promise<Ids> {
  ids ??= (async () => {
    const platform = await import("../../lib/platform");
    const { hashPassword } = await import("../../lib/auth");
    const tenant = await import("../../lib/tenant"), database = await import("../../lib/db");
    await platform.platformReady();
    const root = await platform.createAccount(ROOT_EMAIL, "Rhea Rootname", hashPassword("Unique-studio-password-43"));
    const member = await platform.createAccount(`mia-${run}@example.test`, "Mia Member", hashPassword("Unique-studio-password-43"));
    expect(root.id).toMatch(/^usr_/);
    for (const ws of [CLIENT, HOUSE]) {
      await seedPeople(ws, [{ id: root.id, name: ws === HOUSE ? "Rhea Rootname" : "Particl support" }, { id: member.id, name: "Mia Member" }]);
      await tenant.runInTenant(ws, async () => {
        await database.ready();
        const db = database.db();
        await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('prod_x','Spot',0)", args: [] });
        for (const [gen, by] of [["g_root", root.id], ["g_member", member.id]])
          await db.execute({ sql: "INSERT INTO generations(id,project_id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,version,review_state,deleted) VALUES(?,'prod_x','video','mock','m','p','{}','succeeded',?,1,1,1,'',0)", args: [gen, by] });
        await db.execute({ sql: "INSERT INTO notes(id,gen_id,user_id,text,created_at) VALUES('n_root','g_member',?,'A note from the owner',5)", args: [root.id] });
        await db.execute({ sql: "INSERT INTO messages(id,user_id,text,mentions,created_at) VALUES('m_root',?,'Hello from the owner','[]',6)", args: [root.id] });
        await db.execute({ sql: "INSERT INTO messages(id,user_id,text,mentions,created_at) VALUES('m_member',?,'Hello owner',?,7)", args: [member.id, JSON.stringify([root.id])] });
        await db.execute({ sql: "INSERT INTO security_audit(id,workspace_id,actor_id,action,target_type,target_id,details,created_at) VALUES(?,?,?,'session.created','account',?,'{}',8)", args: [`aud_${ws.id}`, ws.id, root.id, root.id] });
      }, { user: { id: member.id } as never });
    }
    return { root: root.id, member: member.id };
  })();
  return ids;
}

/** A data route as the real withTenant runs it, signed in as `who`. */
async function route<T>(file: string, who: Who): Promise<T> {
  const auth = await authAs(who);
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = { "@/lib/auth": auth };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}
const asWho = (ws: typeof CLIENT, userId: string, role: Who["role"], name: string): Who => ({ mode: "session", ws, userId, name, role, bearer: "" });

/** What each of the three data routes answers, as text. */
async function answers(who: Who, extra: { audit?: boolean } = {}) {
  const jobs = await route<typeof import("../../app/api/jobs/route")>("app/api/jobs/route.ts", who);
  const notes = await route<typeof import("../../app/api/notes/route")>("app/api/notes/route.ts", who);
  const chat = await route<typeof import("../../app/api/chat/route")>("app/api/chat/route.ts", who);
  const read = async (res: Response) => ({ status: res.status, text: await res.text() });
  const out = {
    jobs: await read(await jobs.GET(scoped(who, "http://localhost/api/jobs?limit=100"), undefined as never)),
    notes: await read(await notes.GET(scoped(who, "http://localhost/api/notes?genId=g_member"), undefined as never)),
    chat: await read(await chat.GET(scoped(who, "http://localhost/api/chat"), undefined as never)),
    audit: null as null | { status: number; text: string },
  };
  if (extra.audit) {
    const audit = await route<typeof import("../../app/api/workspaces/audit/route")>("app/api/workspaces/audit/route.ts", who);
    out.audit = await read(await audit.GET(scoped(who, "http://localhost/api/workspaces/audit?limit=20"), undefined as never));
  }
  return out;
}

test("a client workspace's member reads none of the owner's account ids in the takes, notes, chat or activity; the member's own id and everything else is as it was", async () => {
  const { root, member } = await fixture();
  const { platformOwnerIdentity, supportMemberId } = await import("../../lib/platformOwnerPrivacy");
  const identity = await platformOwnerIdentity();
  expect(identity.accountIds).toContain(root);
  const seen = await answers(asWho(CLIENT, member, "admin", "Mia Member"), { audit: true });
  for (const [label, got] of Object.entries(seen)) {
    expect(got?.status, label).toBe(200);
    for (const id of identity.accountIds) expect(got!.text, `${label} holds ${id}`).not.toContain(id);
  }
  const opaque = supportMemberId(CLIENT.id, root);
  const jobs = JSON.parse(seen.jobs.text).generations as { id: string; createdBy: string }[];
  expect(jobs.find((g) => g.id === "g_root")?.createdBy, "the owner's take is the opaque support id").toBe(opaque);
  expect(jobs.find((g) => g.id === "g_member")?.createdBy, "the member's own id is untouched").toBe(member);
  expect(JSON.parse(seen.notes.text).notes[0]).toMatchObject({ userId: opaque, author: "Particl support" });
  const chat = JSON.parse(seen.chat.text).messages as { id: string; userId: string; mentions: string[] }[];
  expect(chat.find((m) => m.id === "m_root")?.userId).toBe(opaque);
  expect(chat.find((m) => m.id === "m_member")).toMatchObject({ userId: member, mentions: [opaque] });
  const audit = JSON.parse(seen.audit!.text) as { events: { actorId: string }[] };
  expect(audit.events.map((e) => e.actorId)).toEqual([opaque]);
});

test("the owner's own view is unchanged: their id, which their screens compare with what they made", async () => {
  const { root, member } = await fixture();
  const seen = await answers(asWho(CLIENT, root, "owner", "Particl support"), { audit: true });
  const jobs = JSON.parse(seen.jobs.text).generations as { id: string; createdBy: string }[];
  expect(jobs.find((g) => g.id === "g_root")?.createdBy).toBe(root);
  expect(jobs.find((g) => g.id === "g_member")?.createdBy).toBe(member);
  expect(JSON.parse(seen.notes.text).notes[0].userId).toBe(root);
  expect((JSON.parse(seen.chat.text).messages as { id: string; userId: string }[]).find((m) => m.id === "m_root")?.userId).toBe(root);
  expect((JSON.parse(seen.audit!.text) as { events: { actorId: string }[] }).events[0].actorId).toBe(root);
});

test("the house workspace is unchanged: the owner's id is there for everyone, as it was", async () => {
  const { root, member } = await fixture();
  const seen = await answers(asWho(HOUSE, member, "admin", "Mia Member"));
  expect(seen.jobs.text).toContain(root);
  expect(seen.notes.text).toContain(root);
  expect(seen.chat.text).toContain(root);
});

test("the stored rows keep the raw id (the server needs it), and the mask is built for one viewer: a body with nothing to hide is returned untouched", async () => {
  const { root, member } = await fixture();
  const database = await import("../../lib/db"), tenant = await import("../../lib/tenant");
  const stored = await tenant.runInTenant(CLIENT, async () => { await database.ready(); return (await database.db().execute({ sql: "SELECT created_by FROM generations WHERE id='g_root'", args: [] })).rows[0].created_by; }, { user: { id: member } as never });
  expect(stored).toBe(root);
  const { storedAccountIdMask, hideOwnerAccountId } = await import("../../lib/platformOwnerPrivacy");
  const forOwner = await storedAccountIdMask(CLIENT, root), forMember = await storedAccountIdMask(CLIENT, member), inHouse = await storedAccountIdMask(HOUSE, member);
  const value = { a: root, nested: [{ by: root, key: member }], [root]: 1 };
  expect(forOwner(value)).toEqual(value);
  expect(JSON.stringify(forMember(value))).not.toContain(root);
  expect(JSON.stringify(forMember(value))).toContain(member);
  expect(inHouse(value)).toEqual(value);
  const plain = new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  expect(await hideOwnerAccountId(plain, CLIENT, member)).toBe(plain);
  const image = new Response(root, { headers: { "content-type": "text/plain" } });
  expect(await hideOwnerAccountId(image, CLIENT, member)).toBe(image);
});
