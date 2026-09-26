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
  const { platformDb, isSuperAdmin } = await import("../../lib/platform");
  const { ws } = await workspace("Policy house");
  const before = process.env.SUPER_ADMIN_EMAIL;
  // The platform owner is named by the deployment, never by source.
  delete process.env.SUPER_ADMIN_EMAIL;
  expect(isSuperAdmin(mail("anyone"))).toBe(false);
  expect(isSuperAdmin("")).toBe(false);
  const SUPER_ADMIN_EMAIL = mail("platform-owner");
  process.env.SUPER_ADMIN_EMAIL = SUPER_ADMIN_EMAIL;
  expect(isSuperAdmin(SUPER_ADMIN_EMAIL.toUpperCase())).toBe(true);
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
  if (before == null) delete process.env.SUPER_ADMIN_EMAIL;
  else process.env.SUPER_ADMIN_EMAIL = before;
});

test("where mail works, only the emailed link makes a new account; the code alone does not", async () => {
  const {
    acceptWorkspaceInvitation,
    mailboxProof,
    mailboxProven,
    invitationMailLink,
  } = await import("../../lib/teamInvitations");
  const { platformDb } = await import("../../lib/platform");
  const { ws } = await workspace("Mailbox house");
  const code = `mailbox-${tag}`;
  await invite(ws.id, mail("claimed"), code);
  const link = new URL(invitationMailLink("http://localhost:4806", code));
  expect(link.pathname).toBe(`/invite/${code}`);
  expect(mailboxProven(code, link.searchParams.get("m"))).toBe(true);
  expect(mailboxProven(code, mailboxProof(`other-${tag}`))).toBe(false);
  expect(mailboxProven(code, "")).toBe(false);
  expect(mailboxProven(code, undefined)).toBe(false);
  const accepted = (proof?: string) =>
    acceptWorkspaceInvitation({
      code,
      password,
      acceptedPolicy: true,
      requireMailboxProof: true,
      mailboxProof: proof,
    });
  // The inviter reads the code from the response; that is all they have.
  await expect(accepted()).rejects.toMatchObject({
    status: 403,
    name: "MailboxProofNeeded",
  });
  await expect(accepted(mailboxProof(`other-${tag}`))).rejects.toMatchObject({
    status: 403,
  });
  const accounts = () =>
    platformDb().execute({
      sql: "SELECT id FROM accounts WHERE email=?",
      args: [mail("claimed")],
    });
  expect((await accounts()).rows).toHaveLength(0);
  await accepted(String(link.searchParams.get("m")));
  expect((await accounts()).rows).toHaveLength(1);
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

test("invitation email is limited per workspace an hour and per address a day, without one workspace spending another's", async () => {
  const { takeInviteMailSlot, INVITE_MAIL_LIMITS } =
    await import("../../lib/teamInvitations");
  const clock = Date.now,
    frozen = Math.floor(clock() / 86400_000) * 86400_000 + 3600_000 * 5 + 1000;
  Date.now = () => frozen;
  try {
    const here = `ws_limits_${tag}`;
    for (let i = 0; i < INVITE_MAIL_LIMITS.perAddressDay; i++)
      await takeInviteMailSlot(here, mail("Target"));
    // Refusals send nothing, so they spend nothing, however often they come.
    for (let i = 0; i < 10; i++)
      await expect(
        takeInviteMailSlot(here, mail("target")),
      ).rejects.toMatchObject({
        status: 429,
        message: expect.stringMatching(/from this workspace today/),
      });
    // Another workspace's invitation to the same person still goes out.
    await takeInviteMailSlot(`ws_elsewhere_${tag}`, mail("target"));
    // A slot whose email never left comes back.
    const unsent = await takeInviteMailSlot(here, mail("bounced"));
    await unsent.release();
    await unsent.release();
    for (let i = 0; i < INVITE_MAIL_LIMITS.perAddressDay; i++)
      await takeInviteMailSlot(here, mail("bounced"));
    const used = INVITE_MAIL_LIMITS.perAddressDay * 2;
    for (let i = used; i < INVITE_MAIL_LIMITS.perWorkspaceHour; i++)
      await takeInviteMailSlot(here, mail(`person-${i}`));
    await expect(
      takeInviteMailSlot(here, mail("one-more")),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/this hour/),
    });
    // An hour on, the workspace may send again.
    Date.now = () => frozen + 3600_000;
    await takeInviteMailSlot(here, mail("next-hour"));
    // Across every workspace, one address still has a daily ceiling.
    let sent = 0;
    for (let w = 0; sent < INVITE_MAIL_LIMITS.perAddressPlatformDay; w++)
      for (
        let i = 0;
        i < INVITE_MAIL_LIMITS.perAddressDay &&
        sent < INVITE_MAIL_LIMITS.perAddressPlatformDay;
        i++, sent++
      )
        await takeInviteMailSlot(`ws_many_${tag}_${w}`, mail("popular"));
    await expect(
      takeInviteMailSlot(`ws_many_${tag}_last`, mail("popular")),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/too many invitations today/),
    });
  } finally {
    Date.now = clock;
  }
});

test("emailing an invitation checks its cap and seat first, and a failed send spends nothing", async () => {
  const {
    createWorkspaceInvite,
    mailWorkspaceInvite,
    acceptWorkspaceInvitation,
    mailboxProven,
    INVITE_MAIL_LIMITS,
  } = await import("../../lib/teamInvitations");
  const { platformDb } = await import("../../lib/platform");
  const { user, ws } = await workspace("Letter house");
  const p = platformDb();
  const code = `letter-${tag}`;
  await createWorkspaceInvite({
    ws,
    code,
    email: mail("letter"),
    name: "Letter",
    role: "member",
    createdBy: user.id,
    expiresAt: Date.now() + 3 * 86400_000,
  });
  const sent: { to: string; link: string }[] = [];
  const deliver = async (to: string, link: string) => {
    sent.push({ to, link });
  };
  const count = async () =>
    Number(
      (
        await p.execute({
          sql: "SELECT send_count FROM workspace_invites WHERE code=?",
          args: [code],
        })
      ).rows[0].send_count,
    );
  const clock = Date.now,
    frozen = Math.floor(clock() / 3600_000) * 3600_000 + 1000;
  Date.now = () => frozen;
  try {
    await expect(
      mailWorkspaceInvite({
        ws,
        code,
        origin: "http://localhost",
        deliver: async () => {
          throw new Error("The mail provider refused.");
        },
      }),
    ).rejects.toThrow(/refused/);
    expect(await count()).toBe(0);
    // The failed send gave its slots back: the full daily three still go.
    for (let i = 0; i < INVITE_MAIL_LIMITS.perAddressDay; i++)
      await mailWorkspaceInvite({
        ws,
        code,
        origin: "http://localhost",
        deliver,
      });
    expect(await count()).toBe(INVITE_MAIL_LIMITS.perAddressDay);
    expect(sent.every((s) => s.to === mail("letter"))).toBe(true);
    const link = new URL(sent[0].link);
    expect(mailboxProven(code, link.searchParams.get("m"))).toBe(true);
    await p.execute({
      sql: "UPDATE workspace_invites SET send_count=? WHERE code=?",
      args: [INVITE_MAIL_LIMITS.perInvitation, code],
    });
    Date.now = () => frozen + 86400_000;
    await expect(
      mailWorkspaceInvite({ ws, code, origin: "http://localhost", deliver }),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/emailed 5 times/),
    });
    expect(sent).toHaveLength(INVITE_MAIL_LIMITS.perAddressDay);
  } finally {
    Date.now = clock;
  }
  // A full plan: a re-send could only lead to a refusal, so none is sent.
  for (const who of ["seat-one", "seat-two"]) {
    await invite(ws.id, mail(who), `letter-${who}-${tag}`);
    await acceptWorkspaceInvitation({
      code: `letter-${who}-${tag}`,
      password,
      acceptedPolicy: true,
    });
  }
  await invite(ws.id, mail("late"), `letter-late-${tag}`);
  await expect(
    mailWorkspaceInvite({
      ws,
      code: `letter-late-${tag}`,
      origin: "http://localhost",
      deliver,
      checkSeat: true,
    }),
  ).rejects.toMatchObject({ status: 402 });
  expect(sent).toHaveLength(INVITE_MAIL_LIMITS.perAddressDay);
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
  // A case-only difference is the same workspace, as the key has always said,
  // so a retry of either spelling never makes a second live "Reuse".
  const cased = await make("reuse");
  expect(cased.ws.id).toBe(third.ws.id);
  expect((await make("Reuse")).ws.id).toBe(third.ws.id);
  // A workspace renamed onto the name answers for it too.
  await p.execute({
    sql: "UPDATE workspaces SET name='Brand Y' WHERE id=?",
    args: [third.ws.id],
  });
  await p.execute({
    sql: "UPDATE workspaces SET name='Reuse' WHERE id=?",
    args: [first.ws.id],
  });
  expect((await make("Reuse")).ws.id).toBe(first.ws.id);
  // Every earlier request is kept; only its key was retired.
  const rows = (
    await p.execute({
      sql: "SELECT request_id,request_key FROM workspace_provisioning WHERE owner_id=?",
      args: [user.id],
    })
  ).rows;
  expect(rows).toHaveLength(3);
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
  await restoreDeletedWorkspace(ws.id, "platform-desk");
  await restoreDeletedWorkspace(ws.id, "platform-desk");
  expect((await getWorkspace(ws.id))?.deletedAt).toBeNull();
  const receipts = (
    await platformDb().execute({
      sql: "SELECT actor_id FROM security_audit WHERE workspace_id=? AND action='workspace.restored'",
      args: [ws.id],
    })
  ).rows;
  expect(receipts.map((r) => r.actor_id)).toEqual(["platform-desk"]);
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

test("a restore never takes the owner past five workspaces of their own", async () => {
  const { requestWorkspace, resumeWorkspace } =
    await import("../../lib/workspaceProvisioning");
  const { markWorkspaceDeleted, restoreDeletedWorkspace } =
    await import("../../lib/purge");
  const { getWorkspace } = await import("../../lib/platform");
  const user = await owner("ceiling");
  const make = async (name: string) => {
    const result = await resumeWorkspace(
      await requestWorkspace({ owner: user, name }),
      user.id,
    );
    expect(result.workspace, result.provisioning?.error ?? "ready").toBeTruthy();
    return result.workspace!;
  };
  const gone = await make("Gone");
  await markWorkspaceDeleted(gone.id);
  for (const name of ["One", "Two", "Three", "Four", "Five"]) await make(name);
  await expect(restoreDeletedWorkspace(gone.id)).rejects.toThrow(
    /already has 5 workspaces/,
  );
  expect((await getWorkspace(gone.id))?.deletedAt).toBeTruthy();
  const five = await make("Five");
  await markWorkspaceDeleted(five.id);
  await restoreDeletedWorkspace(gone.id);
  expect((await getWorkspace(gone.id))?.deletedAt).toBeNull();
});

/* The routes themselves, with the real invitation lib and platform database
   behind them; only the session, the cookie jar and the mail provider are
   stood in for. */
type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
function mailbox(fail?: (to: string) => boolean) {
  const sent: { to: string; link: string }[] = [];
  return {
    sent,
    mock: {
      mailConfigured: () => true,
      mailFrom: () => "invites@example.test",
      inviteOrigin: () => "http://localhost",
      inviteEmail: (o: { link: string }) => ({
        subject: "Invitation",
        text: o.link,
        html: o.link,
      }),
      sendMail: async (m: { to: string; text: string }) => {
        if (fail?.(m.to)) throw new Error("The mail provider refused.");
        sent.push({ to: m.to, link: m.text });
        return { id: "mail" };
      },
    },
  };
}
async function teamRoutes(
  tenant: import("../../lib/tenant").TenantWorkspace,
  userId: string,
  mailer: ReturnType<typeof mailbox>["mock"],
) {
  const { loadRoute } = await import("../helpers/routeModule");
  const mocks = {
    "@/lib/mail": mailer,
    "@/lib/db": { db: () => ({}), ready: async () => {}, now: () => Date.now() },
    "@/lib/auth": {
      requireAdmin: async () => ({
        user: { id: userId, name: "Owner", owner: true },
      }),
      withTenant: (handler: Handler) => handler,
      isPlatformOwner: async () => false,
    },
    "@/lib/tenant": { requireTenant: () => tenant },
    "@/lib/platform": await import("../../lib/platform"),
    "@/lib/credits": { creditsApply: () => true },
    "@/lib/accountDb": await import("../../lib/accountDb"),
    "@/lib/teamInvitations": await import("../../lib/teamInvitations"),
  };
  const team = loadRoute<{ POST: Handler }>("app/api/team/route.ts", mocks);
  const resend = loadRoute<{ POST: Handler }>(
    "app/api/team/invites/[code]/send/route.ts",
    mocks,
  );
  return {
    invite: (email: string) =>
      team.POST(
        new Request("http://localhost/api/team", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, name: "Teammate" }),
        }),
      ),
    resend: (code: string) =>
      resend.POST(
        new Request(`http://localhost/api/team/invites/${code}/send`, {
          method: "POST",
        }),
        { params: Promise.resolve({ code }) },
      ),
  };
}

test("POST /api/team: a full plan refuses before anything is written or sent; a mail limit reaches the admin as a limit", async () => {
  const { platformDb } = await import("../../lib/platform");
  const { user, ws } = await workspace("Route house");
  const post = mailbox((to) => to === mail("bounce"));
  const routes = await teamRoutes(ws, user.id, post.mock);
  const clock = Date.now,
    frozen = Math.floor(clock() / 3600_000) * 3600_000 + 1000;
  Date.now = () => frozen;
  try {
    for (const who of ["first", "second"]) {
      const made = await routes.invite(mail(who));
      expect(made.status, await made.clone().text()).toBe(200);
      expect(await made.json()).toMatchObject({ sent: true, mailLimited: false });
    }
    expect(post.sent.map((s) => s.to)).toEqual([mail("first"), mail("second")]);
    expect(new URL(post.sent[0].link).searchParams.get("m")).toBeTruthy();
    // Owner plus two open invitations fill the Invite plan.
    const full = await routes.invite(mail("third"));
    expect(full.status).toBe(402);
    expect(
      (
        await platformDb().execute({
          sql: "SELECT 1 FROM workspace_invites WHERE email=?",
          args: [mail("third")],
        })
      ).rows,
    ).toHaveLength(0);
    expect(post.sent).toHaveLength(2);

    // On a plan without a member ceiling, the address limit is what stops mail.
    const roomy = await teamRoutes({ ...ws, planId: "studio" }, user.id, post.mock);
    for (let i = 0; i < 2; i++)
      expect(await (await roomy.invite(mail("first"))).json()).toMatchObject({ sent: true });
    const limited = await (await roomy.invite(mail("first"))).json();
    expect(limited).toMatchObject({ sent: false, mailLimited: true });
    expect(limited.mailError).toMatch(/Copy the invitation link/);
    expect(limited.code).toBeTruthy();
    const bounced = await (await roomy.invite(mail("bounce"))).json();
    expect(bounced).toMatchObject({ sent: false, mailLimited: false });
    expect(bounced.mailError).toMatch(/refused/);
  } finally {
    Date.now = clock;
  }
});

test("POST /api/team/invites/[code]/send: refused with 429 once an invitation has been emailed five times", async () => {
  const { platformDb } = await import("../../lib/platform");
  const { user, ws } = await workspace("Resend house");
  const post = mailbox();
  const routes = await teamRoutes(ws, user.id, post.mock);
  const code = `resend-${tag}`;
  await invite(ws.id, mail("again"), code);
  const clock = Date.now,
    frozen = Math.floor(clock() / 3600_000) * 3600_000 + 1000;
  Date.now = () => frozen;
  try {
    const once = await routes.resend(code);
    expect(once.status, await once.clone().text()).toBe(200);
    expect(post.sent).toHaveLength(1);
    await platformDb().execute({
      sql: "UPDATE workspace_invites SET send_count=5 WHERE code=?",
      args: [code],
    });
    const capped = await routes.resend(code);
    expect(capped.status).toBe(429);
    expect((await capped.json()).error).toMatch(/emailed 5 times/);
    expect(post.sent).toHaveLength(1);
    expect((await routes.resend(`missing-${tag}`)).status).toBe(404);
  } finally {
    Date.now = clock;
  }
});

test("the invitation page's route: a copied link asks for the email, and the emailed link makes the account", async () => {
  const { loadRoute } = await import("../helpers/routeModule");
  const platform = await import("../../lib/platform");
  const { ws } = await workspace("Accept house");
  const code = `accept-${tag}`;
  await invite(ws.id, mail("joiner"), code);
  const post = mailbox();
  const jar = { get: () => undefined, set: () => {} };
  const route = loadRoute<{ GET: Handler; POST: Handler }>(
    "app/api/auth/accept/route.ts",
    {
      "@/lib/recovery": { recoveryRoute: (handler: Handler) => handler },
      "next/headers": { cookies: async () => jar },
      "@/lib/auth": {
        SESSION_COOKIE: "particl_session",
        currentContext: async () => null,
      },
      "@/lib/accountInvitationSession": {
        accountInvitationSession: async () => ({ session: "s", created: true }),
      },
      "@/lib/platform": { ...platform, switchSessionWorkspace: async () => {} },
      "@/lib/teamInvitations": await import("../../lib/teamInvitations"),
      "@/lib/policyAccept": await import("../../lib/policyAccept"),
      "@/lib/accountDb": await import("../../lib/accountDb"),
      "@/lib/mail": post.mock,
    },
  );
  const look = async (query: string) =>
    (await route.GET(new Request(`http://localhost/api/auth/accept?${query}`))).json();
  const send = (body: unknown) =>
    route.POST(
      new Request("http://localhost/api/auth/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  expect(await look(`code=${code}`)).toMatchObject({ mailboxNeeded: true });
  const copied = await send({ code, password, accept: true });
  expect(copied.status).toBe(403);
  expect(await copied.json()).toMatchObject({ needsMailbox: true });
  const asked = await send({ code, emailLink: true });
  expect(asked.status, await asked.clone().text()).toBe(200);
  expect(post.sent.map((s) => s.to)).toEqual([mail("joiner")]);
  const m = new URL(post.sent[0].link).searchParams.get("m")!;
  expect(await look(`code=${code}&m=${m}`)).toMatchObject({ mailboxNeeded: false });
  const joined = await send({ code, m, password, accept: true });
  expect(joined.status, await joined.clone().text()).toBe(200);
  expect(await platform.findAccountByEmail(mail("joiner"))).toBeTruthy();
});

test("a deleted workspace's top-up waits for a restore: approving is refused, declining still works", async () => {
  const { platformDb } = await import("../../lib/platform");
  const { requestTopup, decideTopupCredits } = await import("../../lib/topups");
  const { markWorkspaceDeleted, restoreDeletedWorkspace } =
    await import("../../lib/purge");
  const { user, ws } = await workspace("Topup house");
  const asked = await requestTopup({ workspaceId: ws.id, packId: "starter", requestedBy: user.id });
  const other = await requestTopup({ workspaceId: ws.id, packId: "starter", requestedBy: user.id });
  await markWorkspaceDeleted(ws.id);
  await expect(
    decideTopupCredits({ id: asked.id, action: "approve", by: "platform-desk" }),
  ).rejects.toThrow(/Restore it before approving/);
  const grants = async () =>
    (
      await platformDb().execute({
        sql: "SELECT id FROM credit_grants WHERE workspace_id=? AND id LIKE 'topup:%'",
        args: [ws.id],
      })
    ).rows;
  expect(await grants()).toHaveLength(0);
  expect(
    (await decideTopupCredits({ id: other.id, action: "decline", by: "platform-desk" })).request.status,
  ).toBe("declined");
  await restoreDeletedWorkspace(ws.id);
  await decideTopupCredits({ id: asked.id, action: "approve", by: "platform-desk" });
  expect(await grants()).toHaveLength(1);
});
