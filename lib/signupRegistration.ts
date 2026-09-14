import { randomBytes, createHash } from "node:crypto";
import { assertInvitationSession } from "./accountInvitationSession";
import {
  accountDbReady,
  accountTransaction,
  AccountError,
  takeAccountLimit,
} from "./accountDb";
import { now, newId, findAccountByEmail } from "./platform";
import { hashPassword, passwordProblem } from "./auth";
import {
  prepareWorkspace,
  approvedWelcomeCredits,
  workspaceCreationReadiness,
  type WorkspaceOwner,
} from "./workspaceProvisioning";
import { mailConfigured, sendMail } from "./mail";
import { billingConfiguration } from "./billingConfig";

type PaidPlan = "studio" | "agency" | "production";
type Cadence = "monthly" | "annual";
export type SignupChoice = { planId: PaidPlan; cadence: Cadence };
export type SignupInput = {
  name: string;
  email: string;
  workspace: string;
  password: string;
  planId?: string;
  cadence?: string;
};
type Registration = {
  email: string;
  name: string;
  password_hash: string;
  workspace_name: string;
  plan_id: PaidPlan;
  cadence: Cadence;
  expires_at: number;
  verified_at: number | null;
  account_id: string | null;
  request_id: string | null;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const cleanChoice = (plan?: string, cadence?: string): SignupChoice => ({
  planId: ["studio", "agency", "production"].includes(plan ?? "")
    ? (plan as PaidPlan)
    : "studio",
  cadence: cadence === "annual" ? "annual" : "monthly",
});
export const signupNext = (choice: SignupChoice) =>
  "/billing?" +
  new URLSearchParams({
    plan: choice.planId,
    cadence: choice.cadence,
    onboarding: "1",
  });
export function signupReadiness() {
  const workspace = workspaceCreationReadiness();
  const billing = billingConfiguration();
  const open = workspace.canCreate && mailConfigured() && billing.configured;
  return {
    mode: "self-serve" as const,
    open,
    verificationRequired: true,
    ...(!open
      ? {
          reason: !workspace.canCreate
            ? workspace.reason
            : !mailConfigured()
              ? "Email verification is being configured. Please try again shortly."
              : billing.reason,
        }
      : {}),
  };
}
function validated(input: SignupInput) {
  const email = input.email.trim().toLowerCase(),
    name = input.name.trim(),
    workspace = input.workspace.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)
    throw new AccountError("Enter a valid email address.");
  if (!name || name.length > 80)
    throw new AccountError("Use a name between 1 and 80 characters.");
  if (!workspace || workspace.length > 80)
    throw new AccountError("Use a workspace name between 1 and 80 characters.");
  const problem = passwordProblem(input.password);
  if (problem) throw new AccountError(problem);
  return {
    ...input,
    email,
    name,
    workspace,
    ...cleanChoice(input.planId, input.cadence),
  };
}
async function emailLimits(email: string, source: string) {
  await takeAccountLimit("signup-source:" + source, 12, 3600_000);
  await takeAccountLimit("signup-email-hour:" + hash(email), 4, 3600_000);
  await takeAccountLimit("signup-email-minute:" + hash(email), 1, 60_000);
}
/** No account or external resource is created until this one-use email proof is consumed. */
export async function beginSignup(input: SignupInput, source: string) {
  await accountDbReady();
  const data = validated(input);
  if (await findAccountByEmail(data.email))
    throw new AccountError(
      "An account already exists for that email. Sign in to create another workspace.",
      409,
    );
  await emailLimits(data.email, source);
  const token = randomBytes(32).toString("base64url"),
    expiresAt = now() + 3600_000,
    passwordHash = hashPassword(data.password);
  await accountTransaction(async (tx) => {
    const current = (
      await tx.execute({
        sql: "SELECT verified_at FROM signup_registrations WHERE email=?",
        args: [data.email],
      })
    ).rows[0];
    if (current?.verified_at)
      throw new AccountError(
        "This email is already verified. Sign in to continue.",
        409,
      );
    await tx.execute({
      sql: `INSERT INTO signup_registrations(email,name,password_hash,workspace_name,plan_id,cadence,token_hash,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(email) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,workspace_name=excluded.workspace_name,plan_id=excluded.plan_id,cadence=excluded.cadence,token_hash=excluded.token_hash,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
      args: [
        data.email,
        data.name,
        passwordHash,
        data.workspace,
        data.planId,
        data.cadence,
        hash(token),
        expiresAt,
        now(),
        now(),
      ],
    });
  });
  return { email: data.email, name: data.name, token, expiresAt };
}
export async function resendSignup(emailInput: string, source: string) {
  await accountDbReady();
  const email = emailInput.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)
    throw new AccountError("Enter a valid email address.");
  await emailLimits(email, source);
  const token = randomBytes(32).toString("base64url"),
    expiresAt = now() + 3600_000;
  return accountTransaction(async (tx) => {
    const row = (
      await tx.execute({
        sql: "SELECT * FROM signup_registrations WHERE email=? AND verified_at IS NULL",
        args: [email],
      })
    ).rows[0];
    if (!row) return null;
    await tx.execute({
      sql: "UPDATE signup_registrations SET token_hash=?,expires_at=?,updated_at=? WHERE email=? AND verified_at IS NULL",
      args: [hash(token), expiresAt, now(), email],
    });
    return { email, name: String(row.name), token, expiresAt };
  });
}
export async function deliverSignupVerification(
  registration: { email: string; name: string; token: string },
  origin: string,
) {
  const link =
    origin + "/signup?verify=" + encodeURIComponent(registration.token);
  const esc = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  return sendMail({
    to: registration.email,
    subject: "Verify your email for Particl",
    text: `Verify your email to finish creating your Particl account: ${link}\nThis link expires in one hour. If you did not request this account, ignore this email. No workspace or credits are created until you verify.`,
    html: `<p>Verify your email to finish creating your Particl account.</p><p><a href="${esc(link)}">Verify email</a></p><p>This link expires in one hour. If you did not request this account, ignore this email.</p>`,
  });
}
export async function verifySignup(
  token: string,
  signedInAccountId?: string,
  signedInSession?: string,
): Promise<{ owner: WorkspaceOwner; requestId: string } & SignupChoice> {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token))
    throw new AccountError("This verification link is not valid.", 410);
  return accountTransaction(async (tx) => {
    const r = (
      await tx.execute({
        sql: "SELECT * FROM signup_registrations WHERE token_hash=?",
        args: [hash(token)],
      })
    ).rows[0] as unknown as Registration | undefined;
    if (!r || r.expires_at < now())
      throw new AccountError(
        "This verification link has expired or is not valid. Request another email.",
        410,
      );
    if (r.verified_at) {
      if (r.account_id !== signedInAccountId)
        throw new AccountError(
          "This email has already been verified. Sign in to continue.",
          409,
        );
      await assertInvitationSession(tx, r.account_id!, signedInSession);
      return {
        owner: { id: r.account_id!, email: r.email, name: r.name },
        requestId: r.request_id!,
        planId: r.plan_id,
        cadence: r.cadence,
      };
    }
    const existing = (
      await tx.execute({
        sql: "SELECT id FROM accounts WHERE email=?",
        args: [r.email],
      })
    ).rows[0];
    if (existing)
      throw new AccountError(
        "An account already exists for this email. Sign in to continue.",
        409,
      );
    const owner = { id: newId("usr"), email: r.email, name: r.name };
    await tx.execute({
      sql: "INSERT INTO accounts(id,email,name,password_hash,created_at,accepted_policy_at) VALUES(?,?,?,?,?,?)",
      args: [owner.id, owner.email, owner.name, r.password_hash, now(), now()],
    });
    const requestId = await prepareWorkspace(tx, {
      owner,
      name: r.workspace_name,
      requestKey: "verified-signup",
    });
    await tx.execute({
      sql: "UPDATE signup_registrations SET verified_at=?,account_id=?,request_id=?,password_hash='!',updated_at=? WHERE email=? AND verified_at IS NULL",
      args: [now(), owner.id, requestId, now(), r.email],
    });
    return { owner, requestId, planId: r.plan_id, cadence: r.cadence };
  });
}

/** An approved invite already proves control of its email. Its one-time grant
 * is reserved in the same transaction that consumes the invitation. */
export async function acceptSignupInvitation(
  input: SignupInput & { code: string },
  signedInAccountId?: string,
  signedInSession?: string,
) {
  const data = validated(input),
    welcomeCredits = await approvedWelcomeCredits();
  return accountTransaction(async (tx) => {
    const inv = (
      await tx.execute({
        sql: "SELECT * FROM signup_invites WHERE code=?",
        args: [input.code],
      })
    ).rows[0];
    if (!inv || String(inv.email).toLowerCase() !== data.email)
      throw new AccountError(
        "That invitation is not valid for this email.",
        404,
      );
    const existing = (
      await tx.execute({
        sql: "SELECT * FROM accounts WHERE email=?",
        args: [data.email],
      })
    ).rows[0];
    if (
      existing &&
      (String(existing.id) !== signedInAccountId ||
        existing.disabled ||
        existing.deleted_at)
    )
      throw new AccountError(
        "An account already exists for this email. Sign in to continue.",
        409,
      );
    if (existing)
      await assertInvitationSession(tx, String(existing.id), signedInSession);
    if (inv.used_at) {
      const prior = (
        await tx.execute({
          sql: "SELECT request_id FROM workspace_provisioning WHERE welcome_source=? AND owner_id=?",
          args: ["signup-invite:" + input.code, String(existing?.id ?? "")],
        })
      ).rows[0];
      if (prior && existing)
        return {
          owner: {
            id: String(existing.id),
            name: String(existing.name),
            email: data.email,
          },
          requestId: String(prior.request_id),
        };
      throw new AccountError("This invitation has already been used.", 409);
    }
    if (Number(inv.expires_at) < now())
      throw new AccountError("This invitation has expired.", 410);
    const owner = existing
      ? {
          id: String(existing.id),
          email: data.email,
          name: String(existing.name),
        }
      : { id: newId("usr"), email: data.email, name: data.name };
    if (!existing)
      await tx.execute({
        sql: "INSERT INTO accounts(id,email,name,password_hash,created_at,accepted_policy_at) VALUES(?,?,?,?,?,?)",
        args: [
          owner.id,
          owner.email,
          owner.name,
          hashPassword(data.password),
          now(),
          now(),
        ],
      });
    const requestId = await prepareWorkspace(tx, {
      owner,
      name: data.workspace,
      requestKey: "approved-invite:" + input.code,
      welcomeSource: "signup-invite:" + input.code,
      welcomeCredits,
    });
    await tx.execute({
      sql: "UPDATE signup_invites SET used_at=? WHERE code=? AND used_at IS NULL",
      args: [now(), input.code],
    });
    return { owner, requestId };
  });
}
