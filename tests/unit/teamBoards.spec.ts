import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/*
 * Teammates' boards (lib/workbench/team-boards.ts) on real platform and workspace databases in a temp directory: who is listed, how
 * the platform owner reads inside a client workspace (as "Particl support", with an id of that workspace only), who may read a board,
 * and that a person who is switched off is no longer a maker. Nothing renders and nothing is billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-team-boards-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;

const run = Math.random().toString(36).slice(2, 8);
const OWNER = { email: `platform_owner-${run}@example.com`, name: "Pat Platform" };
const MEMBER = { email: `mia-${run}@example.com`, name: "Mia Member" };
const CLIENT = { email: `cleo-${run}@example.com`, name: "Cleo Client" };
const OTHER = { email: `otto-${run}@example.com`, name: "Otto Elsewhere" };
const password = "Unique-studio-password-43";
let envBefore: string | undefined;
test.beforeEach(async () => {
  envBefore = process.env.SUPER_ADMIN_EMAIL;
  process.env.SUPER_ADMIN_EMAIL = OWNER.email;
  (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity();
});
test.afterEach(async () => {
  if (envBefore === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = envBefore;
  (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity();
});

async function setup() {
  const { hashPassword } = await import("../../lib/auth");
  const { createAccount, addMember } = await import("../../lib/platform");
  const { requestWorkspace, resumeWorkspace } = await import("../../lib/workspaceProvisioning");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const owner = await createAccount(OWNER.email, OWNER.name, hashPassword(password));
  const clientOwner = await createAccount(CLIENT.email, CLIENT.name, hashPassword(password));
  const member = await createAccount(MEMBER.email, MEMBER.name, hashPassword(password));
  const elsewhere = await createAccount(OTHER.email, OTHER.name, hashPassword(password));
  const requestId = await requestWorkspace({ owner: clientOwner, name: `Team ${run}` });
  const ws = (await resumeWorkspace(requestId, clientOwner.id)).workspace!;
  await addMember(ws, owner, "admin");
  await addMember(ws, member, "member");
  const board = (id: string, name: string, kind: string | null) => JSON.stringify({ id, name, ...(kind ? { boardKind: kind } : {}), nodes: [], shots: [] });
  await runInTenant(ws, async () => {
    await workbenchReady();
    for (const [who, id, name, kind] of [[clientOwner.id, "b-client", "Client board", "social"], [member.id, "b-member", "Member board", null], [owner.id, "b-owner", "Owner board", null], [elsewhere.id, "b-elsewhere", "Left-over board", null]] as const)
      await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: [`${who}:${id}`, who, id, name, board(id, name, kind), Date.now()] });
  });
  return { ws, owner, clientOwner, member, elsewhere, runInTenant };
}
let made: ReturnType<typeof setup> | null = null;
const fixture = () => (made ??= setup());

test("every active member's boards are listed with their makers; the caller's own is marked; someone who is not a member is not listed", async () => {
  const { ws, member, clientOwner, runInTenant } = await fixture();
  const { listTeamBoards } = await import("../../lib/workbench/team-boards");
  const list = await runInTenant(ws, () => listTeamBoards(ws, member.id, { kinds: true }));
  const byId = Object.fromEntries(list.map((b) => [b.id, b]));
  expect(byId["b-member"]).toMatchObject({ mine: true, owner: { id: member.id, name: MEMBER.name } });
  expect(byId["b-client"]).toMatchObject({ mine: false, kind: "social", owner: { id: clientOwner.id, name: CLIENT.name } });
  /* A person with a row here who is no member of this workspace is not a maker. */
  expect(byId["b-elsewhere"]).toBeUndefined();
});

test("the platform owner reads as Particl support inside a client workspace, with an id that is that workspace's own; their address and name are nowhere", async () => {
  const { ws, member, owner, runInTenant } = await fixture();
  const { listTeamBoards, readTeamBoard } = await import("../../lib/workbench/team-boards");
  const { SUPPORT_ACTOR, supportMemberId } = await import("../../lib/platformOwnerPrivacy");
  const list = await runInTenant(ws, () => listTeamBoards(ws, member.id));
  const theirs = list.find((b) => b.id === "b-owner")!;
  expect(theirs.owner).toEqual({ id: supportMemberId(ws.id, owner.id), name: SUPPORT_ACTOR, support: true });
  const text = JSON.stringify(list);
  for (const secret of [OWNER.email, OWNER.name, owner.id]) expect(text).not.toContain(secret);
  /* The opaque id opens it; the account's own id does too, because that is what the drafts are keyed by, but never answers with the name. */
  const seen = await runInTenant(ws, () => readTeamBoard(ws, member.id, theirs.owner.id, "b-owner"));
  expect(seen?.owner.name).toBe(SUPPORT_ACTOR);
  expect(JSON.stringify(seen?.owner)).not.toContain(OWNER.name);
});

test("a board is read only through its real maker, and only when that maker is an active member here", async () => {
  const { ws, member, clientOwner, elsewhere, runInTenant } = await fixture();
  const { readTeamBoard, findTeamBoard, otherOwnersBoard } = await import("../../lib/workbench/team-boards");
  const read = (owner: string, id: string) => runInTenant(ws, () => readTeamBoard(ws, member.id, owner, id));
  expect((await read(clientOwner.id, "b-client"))?.project.name).toBe("Client board");
  expect(await read(clientOwner.id, "b-member")).toBeNull();      // not that person's board
  expect(await read(elsewhere.id, "b-elsewhere")).toBeNull();     // not a member here
  expect(await read(member.id, "b-member")).toBeNull();           // one's own is read the ordinary way
  expect((await runInTenant(ws, () => findTeamBoard(ws, member.id, "b-client")))?.owner.id).toBe(clientOwner.id);
  expect(await runInTenant(ws, () => findTeamBoard(ws, member.id, "b-member"))).toBeNull();
  expect(await runInTenant(ws, () => findTeamBoard(ws, member.id, "b-elsewhere"))).toBeNull();
  /* A save of a teammate's board is a view-only refusal naming its maker; one's own, or a new id, is not. */
  expect((await runInTenant(ws, () => otherOwnersBoard(ws, member.id, "b-client")))?.name).toBe(CLIENT.name);
  expect(await runInTenant(ws, () => otherOwnersBoard(ws, member.id, "b-member"))).toBeNull();
  expect(await runInTenant(ws, () => otherOwnersBoard(ws, member.id, "brand-new"))).toBeNull();
});

test("a member switched off is no longer a maker, and their boards leave the list", async () => {
  const { ws, member, clientOwner, runInTenant } = await fixture();
  const { platformDb } = await import("../../lib/platform");
  const { listTeamBoards } = await import("../../lib/workbench/team-boards");
  await platformDb().execute({ sql: "UPDATE memberships SET disabled=1 WHERE workspace_id=? AND account_id=?", args: [ws.id, clientOwner.id] });
  try {
    const list = await runInTenant(ws, () => listTeamBoards(ws, member.id));
    expect(list.some((b) => b.owner.id === clientOwner.id)).toBe(false);
    expect(list.some((b) => b.id === "b-member")).toBe(true);
  } finally {
    await platformDb().execute({ sql: "UPDATE memberships SET disabled=0 WHERE workspace_id=? AND account_id=?", args: [ws.id, clientOwner.id] });
  }
});
