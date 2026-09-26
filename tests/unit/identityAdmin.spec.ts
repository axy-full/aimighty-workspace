import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/* Workspace invitations, workspace creation and the platform's undo of a
   workspace delete, against a real local platform database. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-identity-admin-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;
const password = "Unique-studio-password-43";
/* Unit specs share one worker, and the platform client is cached by whichever
   spec loads it first, so every code and address here is unique to this run. */
const tag = randomUUID().slice(0, 8);
const mail = (local: string) => `${local}-${tag}@example.test`;

async function owner(label: string) {
  const { createAccount } = await import("../../lib/platform");
  const { hashPassword } = await import("../../lib/auth");
  return createAccount(mail(label), label, hashPassword(password));
}
async function workspace(label: string) {
  const { requestWorkspace, resumeWorkspace } =
    await import("../../lib/workspaceProvisioning");
  const user = await owner(label.toLowerCase().replace(/\W+/g, "-"));
  const result = await resumeWorkspace(
    await requestWorkspace({ owner: user, name: label }),
    user.id,
  );
  expect(result.workspace, result.provisioning?.error ?? "ready").toBeTruthy();
  return { user, ws: result.workspace! };
}
async function invite(workspaceId: string, email: string, code: string) {
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({
    sql: `INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_at,expires_at) VALUES(?,?,?,'Team','member',?,?)`,
    args: [code, workspaceId, email, Date.now(), Date.now() + 3600_000],
  });
}

test("a workspace invitation records the policy, and never creates the platform owner's account", async () => {
  const { acceptWorkspaceInvitation } =
    await import("../../lib/teamInvitations");
  const { platformDb, SUPER_ADMIN_EMAIL } = await import("../../lib/platform");
  const { ws } = await workspace("Policy house");
  await invite(ws.id, mail("newcomer"), `policy-new-${tag}`);
  await expect(
    acceptWorkspaceInvitation({ code: `policy-new-${tag}`, password }),
  ).rejects.toThrow(/content policy/);
  const p = platformDb();
  expect(
    (
      await p.execute({
        sql: "SELECT id FROM accounts WHERE email=?",
        args: [mail("newcomer")],
      })
    ).rows,
  ).toHaveLength(0);
  await acceptWorkspaceInvitation({
    code: `policy-new-${tag}`,
    password,
    acceptedPolicy: true,
  });
  const joined = (
    await p.execute({
      sql: "SELECT accepted_policy_at FROM accounts WHERE email=?",
      args: [mail("newcomer")],
    })
  ).rows[0];
  expect(Number(joined.accepted_policy_at)).toBeGreaterThan(0);

  // Anyone who can invite can read the link, so it proves nothing about the mailbox.
  await invite(ws.id, SUPER_ADMIN_EMAIL, `claim-platform-owner-${tag}`);
  await expect(
    acceptWorkspaceInvitation({
      code: `claim-platform-owner-${tag}`,
      password,
      acceptedPolicy: true,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await p.execute({
        sql: "SELECT id FROM accounts WHERE email=?",
        args: [SUPER_ADMIN_EMAIL],
      })
    ).rows,
  ).toHaveLength(0);
});

test("an open invitation holds a seat, so the ceiling is met before anyone is emailed", async () => {
  const { createWorkspaceInvite, assertInviteSeat, acceptWorkspaceInvitation } =
    await import("../../lib/teamInvitations");
  const { platformDb } = await import("../../lib/platform");
  const { user, ws } = await workspace("Seat house");
  expect(ws.planId).toBe("invite");
  const make = (code: string, email: string) =>
    createWorkspaceInvite({
      ws,
      code,
      email,
      name: "Team",
      role: "member",
      createdBy: user.id,
      expiresAt: Date.now() + 3600_000,
    });
  await make(`seat-a-${tag}`, mail("a"));
  await make(`seat-b-${tag}`, mail("b"));
  // Owner plus two open invitations fills the Invite plan's three.
  await expect(make(`seat-c-${tag}`, mail("c"))).rejects.toMatchObject({
    status: 402,
    message: expect.stringMatching(/counting open invitations/),
  });
  const p = platformDb();
  expect(
    (
      await p.execute({
        sql: "SELECT code FROM workspace_invites WHERE code=?",
        args: [`seat-c-${tag}`],
      })
    ).rows,
  ).toHaveLength(0);
  // Inviting the same address again shares its seat.
  await make(`seat-a2-${tag}`, mail("a"));
  // An expired invitation gives its seat back.
  await p.execute({
    sql: "UPDATE workspace_invites SET expires_at=0 WHERE code=?",
    args: [`seat-b-${tag}`],
  });
  await make(`seat-c-${tag}`, mail("c"));
  await assertInviteSeat(ws);
  await acceptWorkspaceInvitation({
    code: `seat-a-${tag}`,
    password,
    acceptedPolicy: true,
  });
  await acceptWorkspaceInvitation({
    code: `seat-c-${tag}`,
    password,
    acceptedPolicy: true,
  });
  // Three members: a re-send could only lead to a refusal.
  await expect(assertInviteSeat(ws)).rejects.toMatchObject({ status: 402 });
});

test("invitation email is limited per workspace an hour and per address a day", async () => {
  const { takeInviteMailSlot, INVITE_MAIL_LIMITS } =
    await import("../../lib/teamInvitations");
  const clock = Date.now,
    frozen = Math.floor(clock() / 86400_000) * 86400_000 + 3600_000 * 5 + 1000;
  Date.now = () => frozen;
  try {
    for (let i = 0; i < INVITE_MAIL_LIMITS.perAddressDay; i++)
      await takeInviteMailSlot(`ws_limits_${tag}`, mail("Target"));
    await expect(
      takeInviteMailSlot(`ws_limits_${tag}`, mail("target")),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/Copy the invitation link/),
    });
    // The address limit holds across workspaces.
    await expect(
      takeInviteMailSlot(`ws_elsewhere_${tag}`, mail("target")),
    ).rejects.toMatchObject({ status: 429 });
    const used = INVITE_MAIL_LIMITS.perAddressDay + 1;
    for (let i = used; i < INVITE_MAIL_LIMITS.perWorkspaceHour; i++)
      await takeInviteMailSlot(`ws_limits_${tag}`, mail(`person-${i}`));
    await expect(
      takeInviteMailSlot(`ws_limits_${tag}`, mail("one-more")),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/this hour/),
    });
    // An hour on, the workspace may send again.
    Date.now = () => frozen + 3600_000;
    await takeInviteMailSlot(`ws_limits_${tag}`, mail("next-hour"));
  } finally {
    Date.now = clock;
  }
});

test("a name frees up once its workspace is deleted or renamed; a live repeat is the same request", async () => {
  const { requestWorkspace, resumeWorkspace } =
    await import("../../lib/workspaceProvisioning");
  const { markWorkspaceDeleted } = await import("../../lib/purge");
  const { platformDb } = await import("../../lib/platform");
  const user = await owner("reuse");
  const make = async (name: string) => {
    const requestId = await requestWorkspace({ owner: user, name });
    const result = await resumeWorkspace(requestId, user.id);
    expect(
      result.workspace,
      result.provisioning?.error ?? "ready",
    ).toBeTruthy();
    return { requestId, ws: result.workspace! };
  };
  const first = await make("Reuse");
  expect(await requestWorkspace({ owner: user, name: "Reuse" })).toBe(
    first.requestId,
  );
  const p = platformDb();
  await p.execute({
    sql: "UPDATE workspaces SET name='Brand X' WHERE id=?",
    args: [first.ws.id],
  });
  const second = await make("Reuse");
  expect(second.ws.id).not.toBe(first.ws.id);
  expect(second.ws.name).toBe("Reuse");
  await markWorkspaceDeleted(second.ws.id);
  const third = await make("Reuse");
  expect(third.ws.id).not.toBe(second.ws.id);
  const cased = await make("reuse");
  expect(cased.ws.id).not.toBe(third.ws.id);
  expect(cased.ws.name).toBe("reuse");
  // Every earlier request is kept; only its key was retired.
  const rows = (
    await p.execute({
      sql: "SELECT request_id,request_key FROM workspace_provisioning WHERE owner_id=?",
      args: [user.id],
    })
  ).rows;
  expect(rows).toHaveLength(4);
  expect(rows.find((r) => r.request_id === first.requestId)?.request_key).toBe(
    `${user.id}:workspace:reuse:${first.requestId}`,
  );
});

test("the platform can restore a deleted workspace: the owner returns, the team waits for the owner", async () => {
  const { acceptWorkspaceInvitation } =
    await import("../../lib/teamInvitations");
  const { markWorkspaceDeleted, restoreDeletedWorkspace } =
    await import("../../lib/purge");
  const { platformDb, getWorkspace } = await import("../../lib/platform");
  const { user, ws } = await workspace("Restore house");
  await invite(ws.id, mail("crew"), `restore-crew-${tag}`);
  const crew = await acceptWorkspaceInvitation({
    code: `restore-crew-${tag}`,
    password,
    acceptedPolicy: true,
  });
  await markWorkspaceDeleted(ws.id);
  expect((await getWorkspace(ws.id))?.deletedAt).toBeTruthy();
  await restoreDeletedWorkspace(ws.id);
  await restoreDeletedWorkspace(ws.id);
  expect((await getWorkspace(ws.id))?.deletedAt).toBeNull();
  const standing = async (account: string) =>
    Number(
      (
        await platformDb().execute({
          sql: "SELECT disabled FROM memberships WHERE workspace_id=? AND account_id=?",
          args: [ws.id, account],
        })
      ).rows[0].disabled,
    );
  expect(await standing(user.id)).toBe(0);
  expect(await standing(crew.accountId)).toBe(1);
  await platformDb().execute({
    sql: "UPDATE workspaces SET deleted_at=1,purged_at=2 WHERE id=?",
    args: [ws.id],
  });
  await expect(restoreDeletedWorkspace(ws.id)).rejects.toThrow(
    /cannot be restored/,
  );
});
