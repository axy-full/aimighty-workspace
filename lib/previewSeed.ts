import { randomBytes } from "node:crypto";
import type { TenantWorkspace } from "./tenant";

/**
 * Preview bootstrap: brings the owner's staging databases up to date on a
 * Vercel preview build, and puts the platform owner in a "Preview" workspace
 * with test credits — or, before he has an account, sends him an invitation.
 *
 * It runs from `prebuild` (scripts/ops/preview-seed.cjs) and does nothing
 * anywhere else: every condition in previewSeedGuard must hold, or it logs one
 * line and touches no database. Every step is idempotent, so every preview
 * build may run it.
 *
 * The log carries steps and counts only — never an address, an invitation
 * code, a link or a token. The owner's address is written only where it
 * already lives: the platform database (the invitation, read by the platform
 * desk alone) and, as its owner, the Preview workspace. Other workspaces get
 * tables, never rows.
 *
 * Before the owner has an account this run sends the invitation; his own
 * sign-up then creates his account, password and first workspace. The next
 * preview build (any push, or a redeploy) finds the account and adds the
 * Preview workspace and its test credits.
 */

/* The owner's staging databases, 7 Oct. A preview build seeds only a database
   whose host starts with one of these; anything else is refused. */
export const PREVIEW_DATABASE_HOSTS = {
  platform: "particl-staging-platform",
  primary: "particl-mu191i1z5i3nsd",
} as const;

export const PREVIEW_WORKSPACE_NAME = "Preview";
export const PREVIEW_TEST_CREDITS = 2000;
export const PREVIEW_INVITE_HOURS = 24;
export const previewGrantId = (workspaceId: string) => `preview-test:${workspaceId}`;

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
  const platformHost = config.hostOf(platform);
  const primaryHost = config.hostOf(primary);
  if (/prod/i.test(platformHost) || /prod/i.test(primaryHost)) return no("a database URL names production");
  if (!config.hosts.platform || !platformHost.startsWith(config.hosts.platform))
    return no("PLATFORM_DATABASE_URL is not the staging platform database");
  if (!config.hosts.primary || !primaryHost.startsWith(config.hosts.primary))
    return no("TURSO_DATABASE_URL is not the staging primary database");
  const email = (env.SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) return no("SUPER_ADMIN_EMAIL is not set");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return no("SUPER_ADMIN_EMAIL is not an email address");
  return { ok: true, email };
}

export type PreviewSeedReport = {
  skipped: string | null;
  steps: { ok: number; failed: number };
  tenants: { ok: number; failed: number };
  owner:
    | "account"
    | "invite-emailed"
    | "invite-already-emailed"
    | "invite-mail-not-configured"
    | "invite-no-origin"
    | "invite-mail-failed"
    | "account-disabled"
    | null;
  workspace: "existing" | "created" | "pending" | "not-configured" | "failed" | null;
  credits: "granted" | "already" | "failed" | null;
};

export type PreviewSeedOptions = {
  env?: Env;
  config?: PreviewSeedConfig;
  log?: (line: string) => void;
  /** The mail transport; the real one is lib/mail sendMail. */
  send?: (msg: { to: string; subject: string; text: string; html: string }) => Promise<unknown>;
};

/** Where an invitation link points on a preview build: the configured origin, else this branch's preview URL. */
export function previewOrigin(env: Env): string | null {
  const forced = env.APP_ORIGIN?.trim().replace(/\/$/, "");
  if (forced) return forced;
  const host = (env.VERCEL_BRANCH_URL || env.VERCEL_URL || "").trim().replace(/\/$/, "");
  if (!host) return null;
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

export async function runPreviewSeed(options: PreviewSeedOptions = {}): Promise<PreviewSeedReport> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const report: PreviewSeedReport = {
    skipped: null,
    steps: { ok: 0, failed: 0 },
    tenants: { ok: 0, failed: 0 },
    owner: null,
    workspace: null,
    credits: null,
  };
  const guard = previewSeedGuard(env, options.config);
  if (!guard.ok) {
    report.skipped = guard.reason;
    log(`preview seed: skipped (${guard.reason})`);
    return report;
  }
  log("preview seed: starting");

  // Nothing that can reach a database is loaded until the guard has passed.
  const platform = await import("./platform");
  const { runInTenant } = await import("./tenant");

  /* ── 1. both databases up to date ─────────────────────────────────── */
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
  // platformReady first: everything else stands on its tables.
  if (!(await step(() => platform.platformReady()))) {
    log("preview seed: failed (platform schema)");
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
  for (const boot of platformBoots) await step(boot);
  log(`schema: platform ${report.steps.ok} ok, ${report.steps.failed} failed`);

  /* ── 2. the owner: Preview workspace + test credits, or an invitation ── */
  try {
    await seedOwner(guard.email, env, report, log, options.send);
  } catch {
    log("owner: failed");
  }

  /* ── 3. every tenant database, the primary one included ─────────────── */
  const tenants = await platform.listWorkspaces();
  if (!tenants.some((ws) => ws.legacy))
    // No house row yet (a deployment with no users): its database is the primary one all the same.
    tenants.unshift(platform.rowToWorkspace({ id: "ws_legacy", slug: "aimighty", name: "Primary", legacy: 1, db_url: "(primary)", owner_id: "", created_at: 0 }));
  for (const ws of tenants) {
    if (await bootTenant(ws, runInTenant)) report.tenants.ok++;
    else report.tenants.failed++;
  }
  log(`schema: tenants ${report.tenants.ok} ok, ${report.tenants.failed} failed`);
  log(`preview seed: done (${report.steps.failed + report.tenants.failed} failures)`);
  return report;
}

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

/** One workspace's database, every module's tables, in that workspace's scope. True when all succeeded. */
async function bootTenant(
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
  const p = platform.platformDb();
  const account = await platform.findAccountByEmail(email);
  if (!account) {
    await inviteOwner(email, env, report, log, send);
    return;
  }
  if (Number(account.disabled ?? 0) === 1) {
    report.owner = "account-disabled";
    log("owner: account is disabled; nothing changed");
    return;
  }
  report.owner = "account";
  log("owner: account exists");
  const owner = { id: String(account.id), email: String(account.email), name: String(account.name) };

  let ws: TenantWorkspace | null = null;
  const existing = (
    await p.execute({
      sql: `SELECT w.* FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
            WHERE m.account_id=? AND m.role='owner' AND m.disabled=0 AND w.name=? AND w.deleted_at IS NULL
            ORDER BY w.created_at LIMIT 1`,
      args: [owner.id, PREVIEW_WORKSPACE_NAME],
    })
  ).rows[0];
  if (existing) {
    ws = platform.rowToWorkspace(existing);
    report.workspace = "existing";
    log("workspace: Preview exists");
  } else {
    const provisioning = await import("./workspaceProvisioning");
    const { provisioningConfigured } = await import("./provision");
    const { keyringConfigured } = await import("./keyring");
    if (!provisioning.workspaceCreationReadiness().canCreate) {
      report.workspace = "not-configured";
      const missing = [
        ...(provisioningConfigured() ? [] : ["provisioning (TURSO_API_TOKEN, TURSO_ORG)"]),
        ...(keyringConfigured() ? [] : ["keyring (KEYRING_SECRET)"]),
      ];
      log(`workspace: not created — not configured: ${missing.join(", ")}`);
      return;
    }
    try {
      // The ordinary name-keyed path: a rerun finds the same request, never a second one.
      const requestId = await provisioning.requestWorkspace({ owner, name: PREVIEW_WORKSPACE_NAME });
      const result = await provisioning.resumeWorkspace(requestId, owner.id);
      if (result.workspace) {
        ws = result.workspace;
        report.workspace = "created";
        log("workspace: Preview created");
      } else {
        report.workspace = "pending";
        log(`workspace: Preview ${result.provisioning.state}; the next build retries`);
        return;
      }
    } catch {
      report.workspace = "failed";
      log("workspace: Preview could not be created; the next build retries");
      return;
    }
  }

  const grantId = previewGrantId(ws.id);
  const had = (await p.execute({ sql: "SELECT 1 FROM credit_grants WHERE id=?", args: [grantId] })).rows[0];
  if (had) {
    report.credits = "already";
    log("credits: test grant already present");
    return;
  }
  try {
    await platform.grantCreditsBatch([
      { id: grantId, workspaceId: ws.id, credits: PREVIEW_TEST_CREDITS, note: "Preview test credits", by: null, kind: "manual" },
    ]);
    report.credits = "granted";
    log(`credits: granted ${PREVIEW_TEST_CREDITS}`);
  } catch {
    report.credits = "failed";
    log("credits: grant failed; the next build retries");
  }
}

async function inviteOwner(
  email: string,
  env: Env,
  report: PreviewSeedReport,
  log: (line: string) => void,
  send: PreviewSeedOptions["send"],
): Promise<void> {
  const platform = await import("./platform");
  const mail = await import("./mail");
  const p = platform.platformDb();
  const at = platform.now();
  log(`owner: no account (accounts: ${await platform.accountCount()})`);
  let invite = (
    await p.execute({
      sql: `SELECT code, sent_at FROM signup_invites WHERE email=? AND used_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1`,
      args: [email, at],
    })
  ).rows[0] as unknown as { code: string; sent_at: number | null } | undefined;
  if (invite) log("invite: reusing an open invitation");
  else {
    const code = randomBytes(24).toString("base64url");
    // The same row the platform desk writes (app/api/admin/invites), for a day rather than two weeks.
    await p.execute({
      sql: `INSERT INTO signup_invites (code, email, name, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`,
      args: [code, email, "", "Preview seed", null, at, at + PREVIEW_INVITE_HOURS * 3600_000],
    });
    invite = { code, sent_at: null };
    log("invite: created");
  }
  if (!mail.mailConfigured()) {
    report.owner = "invite-mail-not-configured";
    log("invite: mail not configured — use /setup if the account count is 0");
    return;
  }
  if (invite.sent_at != null) {
    report.owner = "invite-already-emailed";
    log("invite: already emailed");
    return;
  }
  const origin = previewOrigin(env);
  if (!origin) {
    report.owner = "invite-no-origin";
    log("invite: not emailed — no APP_ORIGIN or preview URL to link to");
    return;
  }
  const link = `${origin}/signup?invite=${invite.code}`;
  try {
    await (send ?? mail.sendMail)({
      to: email,
      ...mail.signupInviteMail({ inviter: "Particl preview", name: "", link, validFor: `${PREVIEW_INVITE_HOURS} hours` }),
    });
    await p.execute({
      sql: `UPDATE signup_invites SET sent_at = ?, send_count = send_count + 1 WHERE code = ?`,
      args: [platform.now(), invite.code],
    });
    report.owner = "invite-emailed";
    log("invite: emailed");
  } catch {
    report.owner = "invite-mail-failed";
    // The transport's error may quote the address; only the step is logged.
    log("invite: mail failed — use /setup if the account count is 0");
  }
}
