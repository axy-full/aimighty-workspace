import { randomBytes } from "node:crypto";
import type { TenantWorkspace } from "./tenant";

/**
 * Preview bootstrap: on a Vercel preview build, brings the owner's staging
 * databases up to date and lets the platform owner (SUPER_ADMIN_EMAIL) into
 * the house workspace on the staging primary database without his old
 * password.
 *
 * It runs from `prebuild` (scripts/ops/preview-seed.cjs) and does nothing
 * anywhere else: every condition in previewSeedGuard must hold, or it logs one
 * line and touches no database. Every step is idempotent, so every preview
 * build may run it.
 *
 * It opens exactly two databases, the two the guard checked: the platform
 * database and the primary one (the house workspace's). Staging may be a
 * restored production snapshot whose workspace rows name production
 * databases, so no workspace row's db_url is ever opened. It never creates a
 * workspace, a database or a credit grant.
 *
 * The owner:
 * - has an account: he is made an owner/admin of the house workspace if he is
 *   not one, and is emailed one "set your password" link (the app's own
 *   password reset, valid 24 hours), once;
 * - has none, the house exists: the account is made in the house workspace
 *   with no usable password, and the same link is emailed. The platform
 *   owner's account may only come from a sign-up or a password reset
 *   (lib/teamInvitations.ts refuses it from a workspace invitation), so the
 *   reset link, which only his mailbox receives, is what sets the password;
 * - has none and there are no accounts at all: nothing is sent; /setup makes
 *   the first account the house owner.
 *
 * The log carries steps and counts only — never an address, a code, a link
 * or a token. The owner's address is written only to the platform database
 * and the house workspace.
 */

/* The owner's staging databases, 7 Oct. A preview build seeds only a database
   whose host's first label is one of these, or starts with it and "-". */
export const PREVIEW_DATABASE_HOSTS = {
  platform: "particl-staging-platform",
  primary: "particl-mu191i1z5i3nsd",
} as const;

/** Hosts an invitation or reset link must never point at from a preview build. */
const LIVE_HOSTS = ["particl.si", "particl.app"];
export const PREVIEW_RESET_HOURS = 24;
/** Marks the password resets this seed issued (password_resets.ip_hash), so it sends one, not one per build. */
export const PREVIEW_RESET_SOURCE = "preview-seed";
const HOUSE_ID = "ws_legacy";

type Env = Record<string, string | undefined>;
export type PreviewSeedConfig = {
  hosts: { platform: string; primary: string };
  /** How a database URL's host is read. Tests name temporary files; the real one parses the URL. */
  hostOf: (url: string) => string;
};
const hostOfUrl = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
export const PREVIEW_SEED_CONFIG: PreviewSeedConfig = { hosts: PREVIEW_DATABASE_HOSTS, hostOf: hostOfUrl };

const carriesCredentials = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return /\/\/[^/]*@/.test(url);
  }
};
const hostMatches = (host: string, prefix: string): boolean => {
  const label = host.split(".")[0] ?? "";
  return Boolean(prefix) && (label === prefix || label.startsWith(prefix + "-"));
};

export type PreviewGuard = { ok: true; email: string } | { ok: false; reason: string };

/** All must hold. The reason is safe to log: it names a variable, never its value. */
export function previewSeedGuard(env: Env, config: PreviewSeedConfig = PREVIEW_SEED_CONFIG): PreviewGuard {
  const no = (reason: string): PreviewGuard => ({ ok: false, reason });
  if (env.VERCEL_ENV === undefined || env.VERCEL_ENV === "") return no("VERCEL_ENV is not set");
  if (env.VERCEL_ENV === "production") return no("production deployment");
  if (env.VERCEL_ENV !== "preview") return no("VERCEL_ENV is not preview");
  const platform = (env.PLATFORM_DATABASE_URL ?? "").trim();
  const primary = (env.TURSO_DATABASE_URL ?? "").trim();
  if (!platform) return no("PLATFORM_DATABASE_URL is not set");
  if (!primary) return no("TURSO_DATABASE_URL is not set");
  if (/prod/i.test(platform) || /prod/i.test(primary)) return no("a database URL names production");
  if (carriesCredentials(platform) || carriesCredentials(primary)) return no("a database URL carries credentials");
  const platformHost = config.hostOf(platform);
  const primaryHost = config.hostOf(primary);
  if (/prod/i.test(platformHost) || /prod/i.test(primaryHost)) return no("a database URL names production");
  if (!hostMatches(platformHost, config.hosts.platform)) return no("PLATFORM_DATABASE_URL is not the staging platform database");
  if (!hostMatches(primaryHost, config.hosts.primary)) return no("TURSO_DATABASE_URL is not the staging primary database");
  const email = (env.SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) return no("SUPER_ADMIN_EMAIL is not set");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return no("SUPER_ADMIN_EMAIL is not an email address");
  return { ok: true, email };
}

/**
 * Where a link points on a preview build: this branch's preview URL, else this
 * deployment's, and APP_ORIGIN only when Vercel names neither. Null when there
 * is none, or when it is a live site's host.
 */
export function previewOrigin(env: Env): string | null {
  const vercel = env.VERCEL_ENV === "preview" ? (env.VERCEL_BRANCH_URL || env.VERCEL_URL || "").trim() : "";
  const raw = vercel ? (/^https?:\/\//.test(vercel) ? vercel : `https://${vercel}`) : (env.APP_ORIGIN ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (LIVE_HOSTS.includes(host)) return null;
  return url.origin;
}

export type OwnerOutcome =
  | "reset-emailed"
  | "reset-already-emailed"
  | "reset-mail-failed"
  | "mail-not-configured"
  | "no-origin"
  | "account-disabled"
  | "no-accounts"
  | "no-house";

export type PreviewSeedReport = {
  skipped: string | null;
  steps: { ok: number; failed: number };
  primary: "ok" | "failed" | null;
  owner: { account: "existing" | "created" | "none" | null; membership: "present" | "added" | null; outcome: OwnerOutcome | null };
};

export type PreviewSeedOptions = {
  env?: Env;
  config?: PreviewSeedConfig;
  log?: (line: string) => void;
  /** The mail transport; the real one is lib/mail sendMail. */
  send?: (msg: { to: string; subject: string; text: string; html: string }) => Promise<unknown>;
};

export async function runPreviewSeed(options: PreviewSeedOptions = {}): Promise<PreviewSeedReport> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const report: PreviewSeedReport = {
    skipped: null,
    steps: { ok: 0, failed: 0 },
    primary: null,
    owner: { account: null, membership: null, outcome: null },
  };
  const skip = (reason: string) => {
    report.skipped = reason;
    log(`preview seed: skipped (${reason})`);
    return report;
  };
  const guard = previewSeedGuard(env, options.config);
  if (!guard.ok) return skip(guard.reason);
  // The libraries read the process's own variables: they must be the ones the guard checked.
  for (const name of ["PLATFORM_DATABASE_URL", "TURSO_DATABASE_URL"])
    if ((process.env[name] ?? "").trim() !== (env[name] ?? "").trim()) return skip("the checked database URLs are not the process's");
  log("preview seed: starting");

  // Nothing that can reach a database is loaded until the guard has passed.
  const platform = await import("./platform");
  const { runInTenant } = await import("./tenant");

  /* ── 1. the platform database and the primary one, up to date ──────── */
  const step = async (run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run();
      report.steps.ok++;
      return true;
    } catch {
      report.steps.failed++;
      return false;
    }
  };
  if (!(await step(() => platform.platformReady()))) {
    log("preview seed: failed (platform schema)");
    return report;
  }
  for (const boot of platformBoots) await step(boot);
  log(`schema: platform ${report.steps.ok} ok, ${report.steps.failed} failed`);
  // The house workspace's database is the primary one: its URL is the environment's, never a row's.
  const primary = platform.rowToWorkspace({ id: HOUSE_ID, slug: "aimighty", name: "House", legacy: 1, db_url: "(primary)", owner_id: "", created_at: 0 });
  report.primary = (await bootPrimary(primary, runInTenant)) ? "ok" : "failed";
  log(`schema: primary ${report.primary}`);

  /* ── 2. the owner, into the house workspace ────────────────────────── */
  try {
    await seedOwner(guard.email, env, report, log, options.send);
  } catch {
    log("owner: failed");
  }
  log(`preview seed: done (${report.steps.failed + (report.primary === "failed" ? 1 : 0)} failures)`);
  return report;
}

const platformBoots: (() => Promise<unknown>)[] = [
  async () => (await import("./accountDb")).accountDbReady(),
  async () => (await import("./billingLedger")).billingReady(),
  async () => (await import("./creditConversion")).conversionsReady(),
  async () => (await import("./providerPool")).providerPoolReady(),
  async () => (await import("./higgsfieldGenerationReceipts")).receiptsReady(),
  async () => (await import("./higgsfield-consumer/store")).consumerStoreReady(),
];

const tenantBoots: (() => Promise<unknown>)[] = [
  async () => (await import("./db")).ready(),
  async () => (await import("./archive")).archiveReady(),
  async () => (await import("./atomikSkills")).skillsReady(),
  async () => (await import("./atomikMemory")).memoryReady(),
  async () => (await import("./dubbing")).dubbingReady(),
  async () => (await import("./mediaDeletion")).mediaDeletionReady(),
  async () => (await import("./soulIdentities")).soulIdentitiesReady(),
  async () => (await import("./renderDispatch")).renderDispatchReady(),
  async () => (await import("./generationSettlement")).generationSettlementReady(),
  async () => (await import("./generationRequests")).generationRequestsReady(),
  async () => (await import("./uploadReservations")).uploadReservationsReady(),
  async () => (await import("./crew/store")).crewReady(),
  async () => (await import("./workbench/records")).workbenchReady(),
  async () => (await import("./workbench/project-library")).projectLibraryReady(),
  async () => (await import("./workbench/verify-server")).verifyReady(),
  async () => (await import("./workbench/atomik-server")).atomikReady(),
  async () => (await import("./workbench/development-server")).developmentReady(),
  async () => (await import("./workbench/rig-agent-store")).rigAgentReady(),
  async () => (await import("./workbench/team-canvas")).teamCanvasReady(),
  async () => (await import("./workbench/canvas-ops-log")).canvasOpsReady(),
  async () => (await import("./higgsfield-consumer/marketing-records")).consumerMarketingItemsReady(),
  async () => (await import("./higgsfield-consumer/character-records")).consumerCharactersReady(),
  async () => (await import("./higgsfield-consumer/jobs")).consumerJobsReady(),
  async () => (await import("./higgsfield-consumer/genjutsu-sources")).consumerMediaImportsReady(),
  async () => (await import("./astra-blender/render-jobs")).astraRenderReady(),
];

/** Every module's tables on the primary database, in the house workspace's scope. True when all succeeded. */
async function bootPrimary(
  ws: TenantWorkspace,
  runInTenant: (ws: TenantWorkspace, fn: () => Promise<boolean>) => Promise<boolean>,
): Promise<boolean> {
  return runInTenant(ws, async () => {
    let ok = true;
    for (const boot of tenantBoots) {
      try {
        await boot();
      } catch {
        ok = false;
      }
    }
    return ok;
  });
}

async function seedOwner(
  email: string,
  env: Env,
  report: PreviewSeedReport,
  log: (line: string) => void,
  send: PreviewSeedOptions["send"],
): Promise<void> {
  const platform = await import("./platform");
  const mail = await import("./mail");
  const outcome = (value: OwnerOutcome, line: string) => {
    report.owner.outcome = value;
    log(line);
  };

  /* The house row, only as the primary database's workspace. A restored row
     that is not the legacy one would name a database the guard never saw. */
  const row = await platform.getWorkspace(HOUSE_ID);
  const house = row && row.legacy && !row.deletedAt && row.dbUrl === process.env.TURSO_DATABASE_URL ? row : null;
  let account = await platform.findAccountByEmail(email);

  if (!account) {
    report.owner.account = "none";
    const accounts = await platform.accountCount();
    if (accounts === 0) return outcome("no-accounts", "owner: no accounts — use /setup");
    if (!house) return outcome("no-house", `owner: no account and no house workspace; nothing changed (accounts: ${accounts})`);
    // An account he cannot reach is no help: make it only when its reset link can be sent.
    if (!mail.mailConfigured()) return outcome("mail-not-configured", "owner: no account; mail not configured — nothing changed");
    if (!previewOrigin(env)) return outcome("no-origin", "owner: no account; no preview URL to link to — nothing changed");
    const name = email.split("@")[0].slice(0, 80) || "Owner";
    // No usable password: only the reset link, which only his mailbox receives, sets one.
    await platform.createAccount(email, name, "!");
    account = await platform.findAccountByEmail(email);
    if (!account) throw new Error("ACCOUNT_NOT_CREATED");
    report.owner.account = "created";
  } else {
    report.owner.account = "existing";
    if (Number(account.disabled ?? 0) === 1) return outcome("account-disabled", "owner: account is disabled; nothing changed");
  }
  const owner = { id: String(account.id), email: String(account.email), name: String(account.name) };

  if (house) {
    const role = await platform.membershipRole(house.id, owner.id);
    if (role === "owner" || role === "admin") report.owner.membership = "present";
    else {
      // The platform helper, scoped by the house workspace's id; its mirror goes to the primary database only.
      await platform.addMember(house, owner, "admin");
      report.owner.membership = "added";
      log("owner: added to the house workspace as admin");
    }
  } else log("owner: no house workspace; membership unchanged");

  const prefix = report.owner.account === "created" ? "owner: account created in the house workspace;" : "owner: account exists;";
  await sendReset(owner, env, prefix, outcome, send);
}

/** One "set your password" link from this seed: never another while one is open or once one was used. */
async function sendReset(
  owner: { id: string; email: string; name: string },
  env: Env,
  prefix: string,
  outcome: (value: OwnerOutcome, line: string) => void,
  send: PreviewSeedOptions["send"],
): Promise<void> {
  const platform = await import("./platform");
  const mail = await import("./mail");
  const { tokenHash } = await import("./auth");
  const p = platform.platformDb();
  const at = platform.now();
  const issued = (
    await p.execute({
      sql: `SELECT 1 FROM password_resets WHERE user_id=? AND ip_hash=? AND (used_at IS NOT NULL OR expires_at>?) LIMIT 1`,
      args: [owner.id, PREVIEW_RESET_SOURCE, at],
    })
  ).rows[0];
  if (issued) return outcome("reset-already-emailed", `${prefix} already emailed`);
  if (!mail.mailConfigured()) return outcome("mail-not-configured", `${prefix} mail not configured`);
  const origin = previewOrigin(env);
  if (!origin) return outcome("no-origin", `${prefix} reset link not emailed — no preview URL to link to`);

  // The app's own reset token and mail (app/api/auth/reset), for a day rather than an hour.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = at + PREVIEW_RESET_HOURS * 3600_000;
  await p.execute({
    sql: `INSERT INTO password_resets (token_hash, user_id, ip_hash, created_at, expires_at) VALUES (?,?,?,?,?)`,
    args: [tokenHash(token), owner.id, PREVIEW_RESET_SOURCE, at, expiresAt],
  });
  try {
    await (send ?? mail.sendMail)({
      to: owner.email,
      ...mail.resetEmail({ name: owner.name, link: `${origin}/reset/${token}`, expiresAt, origin }),
    });
  } catch {
    // Unsent, so not issued: the next build tries again. The transport's error may quote the address; only the step is logged.
    await p.execute({ sql: `DELETE FROM password_resets WHERE token_hash=?`, args: [tokenHash(token)] }).catch(() => {});
    return outcome("reset-mail-failed", `${prefix} mail failed`);
  }
  outcome("reset-emailed", `${prefix} reset link emailed`);
}
