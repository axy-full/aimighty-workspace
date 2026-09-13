import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireSuperAdmin } from "@/lib/auth";
import { platformDb, platformReady, now, platformKeysByDefault, rowToWorkspace, grantsByKind, getPlatformLayer, grantBudgetState } from "@/lib/platform";
import { creditStateFor } from "@/lib/credits";
import { creditUsd, signupCredits, fundedFraction, marginFor } from "@/lib/creditTerms";
import { asPlanId, DEFAULT_PLANS, planById } from "@/lib/plans";
import { peakByEngine, peakOverall } from "@/lib/concurrency";
import { defaultAllowanceUsd } from "@/lib/allowance";
import { gatewayMintConfigured } from "@/lib/vercelKeys";
import { mailConfigured, sendMail, inviteOrigin, signupInviteEmail, SIGNUP_INVITE_DAYS } from "@/lib/mail";
import { provisioningConfigured } from "@/lib/provision";
import { keyringConfigured } from "@/lib/keyring";
import { meterByWorkspace, marginUsd, engineSpansSince, platformCycle } from "@/lib/meter";
import { cycleBounds, cycleKey } from "@/lib/cycle";
import { shareOf, flagsFor, marginPctOf, monthLabel, grantBudgetRoom, grantBudgetSpentLine } from "@/lib/adminView";

export const dynamic = "force-dynamic";

/**
 * Sign-up invitations: the platform owner's door. An invitation lets one
 * address create an account and a workspace of its own.
 *
 * Board 12h additions (every v1 field stays; these sit beside them):
 *
 *   curl -b "$COOKIE" http://localhost:4550/api/admin/invites
 *   {
 *     ...every v1 field...,
 *     cycle:   { key: "2026-09", start, end },           // cycleBounds(1, now)
 *     totals:  { engineCostUsd, billedCredits, marginPct, // month to date, paid_by_platform = 1, internal EXCLUDED
 *                grantsUsd, committedUsd, grantBudgetUsd }, // welcome grants this cycle · + open codes · the layer's cap or null
 *     grant:   { credits, usdEach, days },               // welcomeGrant() · × creditUsd() · SIGNUP_INVITE_DAYS
 *     queue:   [{ id, kind: "request" | "invite", who, email, what, when, code, expiresAt }],
 *     studios: [{ id, name, slug, tier, internal, suspended, flagged,
 *                 engineCostUsd, billedCredits, marginPct, share, overShare, underMargin, note, multiplier }]
 *   }
 *
 *   curl -b "$COOKIE" -X POST http://localhost:4550/api/admin/invites \
 *        -H 'content-type: application/json' -d '{"requestIds":["req_…","req_…"]}'
 *   200 { issued: [{ code, link, email, name, sent, mailError }] }
 *   409 { error: "The grant budget for September is spent: $X of $Y committed." }  — nothing issued
 *
 *   The single-email body ({ email, name, note, requestId, send }) answers exactly as before.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/* The flags, the margin, the month and the 409 line all come from
   lib/adminView.ts — the one rule the desk, this route and the unit tests
   read — never a second copy here. */

export async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  await platformReady();
  const p = platformDb();
  const [invites, requests, workspaces] = await Promise.all([
    p.execute({ sql: `SELECT * FROM signup_invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`, args: [now()] }),
    p.execute(`SELECT id, name, email, note, mailed, created_at FROM access_requests WHERE handled_at IS NULL ORDER BY created_at DESC LIMIT 100`),
    p.execute(`SELECT w.*, a.email AS owner_email, a.name AS owner_name,
                      (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id = w.id AND m.disabled = 0) AS members
               FROM workspaces w LEFT JOIN accounts a ON a.id = w.owner_id ORDER BY w.created_at`),
  ]);
  const spend = await meterByWorkspace(now() - 30 * 86_400_000).catch(() => new Map());
  /* One grouped query for every workspace's bought-versus-given split, beside
     the one that already reads every workspace's spend. This endpoint is
     polled by the console; a per-workspace call here would be a scan a minute
     per workspace. */
  const split = await grantsByKind().catch(() => new Map());
  /* Peak concurrency per engine (§7): derived from the intervals the meter
     already holds, so it answers for all of history rather than from the
     day a sampler was switched on. Thirty days, matching the spend window
     beside it. */
  const spans = await engineSpansSince(now() - 30 * 86_400_000).catch(() => []);
  const credits = await Promise.all((workspaces.rows as any[]).map(async (r) => {
    try { return await creditStateFor(rowToWorkspace(r)); } catch { return null; }
  }));
  const layer = await getPlatformLayer().catch(() => null);
  /* The board's month (12h): one calendar cycle, the pricing view. Internal
     workspaces are listed in the studios table but never in the totals. */
  const bounds = cycleBounds(1, now());
  const cycle = await platformCycle(bounds.start).catch(() => ({ engineCostUsd: 0, billedCredits: 0, marginPct: null as number | null, byWorkspace: new Map() }));
  const budget = await grantBudgetState().catch(() => ({ budgetUsd: null as number | null, grantedUsd: 0, committedUsd: 0, grantCredits: 0, usdEach: 0 }));
  const plans = layer?.plans ?? DEFAULT_PLANS;
  const multiplier = marginFor("*");
  return NextResponse.json({
    /* The plans themselves, not just each workspace's id: the console has to
       name them and show what each costs, and the platform layer is where
       they can be edited. */
    plans,
    concurrency: { byEngine: peakByEngine(spans, now()), overall: peakOverall(spans, now()), days: 30 },
    creditUsd: creditUsd(),
    signupCredits: signupCredits(),
    ready: provisioningConfigured() && keyringConfigured(),
    mail: mailConfigured(),
    platformKeysByDefault: platformKeysByDefault(),
    defaultAllowanceUsd: defaultAllowanceUsd(),
    gatewayMint: gatewayMintConfigured(),
    invites: invites.rows.map((r: any) => ({ code: r.code, email: r.email, name: r.name, note: r.note, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), sentAt: r.sent_at == null ? null : Number(r.sent_at), sendCount: Number(r.send_count ?? 0) })),
    requests: requests.rows.map((r: any) => ({ id: r.id, name: r.name, email: r.email, note: r.note, mailed: Boolean(Number(r.mailed)), createdAt: Number(r.created_at) })),
    workspaces: workspaces.rows.map((r: any, i: number) => ({ id: r.id, slug: r.slug, name: r.name, legacy: Number(r.legacy) === 1, platformKeys: Number(r.uses_platform_keys) === 1, allowanceUsd: r.allowance_usd == null ? null : Number(r.allowance_usd), gatewayKey: Boolean(r.gateway_key_id), credits: credits[i] ? { granted: credits[i]!.granted, used: credits[i]!.used, balance: credits[i]!.balance } : null, createdAt: Number(r.created_at), owner: r.owner_email ? { email: r.owner_email, name: r.owner_name } : null, members: Number(r.members ?? 0),
      grants: (() => { const g = split.get(String(r.id)); return { paid: g?.paid ?? 0, free: g?.free ?? 0 }; })(),
      planId: asPlanId(r.plan_id),
      spend30: (() => {
        const m = spend.get(String(r.id));
        if (!m) return null;
        const g = split.get(String(r.id));
        return { ...m, marginUsd: marginUsd(m.billedCredits, m.engineCostUsd, creditUsd(), fundedFraction(g?.paid ?? 0, g?.free ?? 0)) };
      })(),
      suspended: Boolean(r.suspended_at), suspendedReason: r.suspended_reason ?? null, flagged: Boolean(r.flagged_at), flagNote: r.flag_note ?? null, internalTest: Number(r.internal_test ?? 0) === 1,
      internal: Number(r.internal ?? 0) === 1,
      limits: { concurrency: r.concurrency == null ? null : Number(r.concurrency), rendersPerHour: r.renders_per_hour == null ? null : Number(r.renders_per_hour), storageGb: r.storage_quota_bytes == null ? null : Math.round(Number(r.storage_quota_bytes) / 1e9 * 10) / 10 } })),

    /* ── Board 12h ─────────────────────────────────────────────────────── */
    cycle: { key: cycleKey(bounds.start), start: bounds.start, end: bounds.end },
    totals: {
      engineCostUsd: cycle.engineCostUsd,
      billedCredits: cycle.billedCredits,
      marginPct: cycle.marginPct,
      grantsUsd: budget.grantedUsd,
      committedUsd: budget.committedUsd,
      grantBudgetUsd: budget.budgetUsd,
    },
    grant: { credits: budget.grantCredits, usdEach: budget.usdEach, days: SIGNUP_INVITE_DAYS },
    /* Open requests first, then the codes already out and not yet used —
       each group newest first, as its query orders it. */
    queue: [
      ...requests.rows.map((r: any) => ({
        id: String(r.id), kind: "request" as const, who: String(r.name || r.email || ""), email: String(r.email ?? ""),
        what: String(r.note ?? ""), when: Number(r.created_at), code: null, expiresAt: null,
      })),
      ...invites.rows.map((r: any) => ({
        id: String(r.code), kind: "invite" as const, who: String(r.name || r.email || ""), email: String(r.email ?? ""),
        what: String(r.note ?? ""), when: Number(r.created_at), code: String(r.code), expiresAt: Number(r.expires_at),
      })),
    ],
    studios: workspaces.rows.map((r: any) => {
      const m = cycle.byWorkspace.get(String(r.id)) ?? { engineCostUsd: 0, billedCredits: 0, jobs: 0, failed: 0 };
      const internal = Number(r.internal ?? 0) === 1;
      /* An internal studio is billed at cost (§7A guardrail 6): its
         pricing-view margin is ceil-rounding, not a number, so it has no
         margin and no place under the floor — the desk prints an em dash.
         Nor has it a share of the total it is left out of. */
      const marginPct = internal ? null : marginPctOf(m.billedCredits, m.engineCostUsd, creditUsd());
      const share = internal ? 0 : shareOf(m.engineCostUsd, cycle.engineCostUsd);
      const { overShare, underMargin } = flagsFor(share, marginPct);
      const flagged = Boolean(r.flagged_at);
      const suspended = Boolean(r.suspended_at);
      return {
        id: String(r.id), name: String(r.name), slug: String(r.slug),
        tier: planById(plans, asPlanId(r.plan_id))?.label ?? "—",
        internal, suspended, flagged,
        engineCostUsd: m.engineCostUsd, billedCredits: m.billedCredits, marginPct,
        share, overShare, underMargin,
        note: (flagged && r.flag_note) || (suspended && r.suspended_reason) || null,
        multiplier: internal ? 1 : multiplier,
      };
    }),
  });
}

/**
 * One code: the request it answers (if any) claimed first, then the row,
 * then the mail. The single and the batch paths share it.
 *
 * The claim comes BEFORE the insert and only while the request is still
 * open (`handled_at IS NULL`): two presses of Send N codes landing at once,
 * or one replayed, would otherwise each write a code for the same request.
 * In the batch (`claim`) a request another press already answered gets no
 * second code — null, and the loop moves on. The single-invite body names a
 * request only as a note of what it answers and issues as it always did.
 */
async function issueOne(req: Request, by: { id: string; name: string }, input: { email: string; name: string; note: string; requestId: string | null; send: boolean; claim?: boolean }) {
  const code = randomBytes(24).toString("base64url");
  const ts = now();
  const expiresAt = ts + SIGNUP_INVITE_DAYS * 86400_000;
  const p = platformDb();
  if (input.requestId) {
    const claimed = await p.execute({ sql: `UPDATE access_requests SET handled_at = ? WHERE id = ? AND handled_at IS NULL`, args: [ts, input.requestId] });
    if (input.claim && !claimed.rowsAffected) return null;
  }
  await p.execute({
    sql: `INSERT INTO signup_invites (code, email, name, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`,
    args: [code, input.email, input.name, input.note, by.id, ts, expiresAt],
  });
  const link = `${inviteOrigin(req)}/signup?invite=${code}`;
  let sent = false; let mailError: string | null = null;
  if (mailConfigured() && input.send) {
    try {
      await sendMail({ to: input.email, ...signupInviteEmail({ name: input.name, inviter: by.name, code, link, days: SIGNUP_INVITE_DAYS }) });
      sent = true;
      await p.execute({ sql: `UPDATE signup_invites SET sent_at = ?, send_count = send_count + 1 WHERE code = ?`, args: [now(), code] });
    } catch (e) { mailError = (e as Error).message; }
  }
  return { code, link, email: input.email, name: input.name, expiresInDays: SIGNUP_INVITE_DAYS, sent, mailError };
}

/** The 409 line when N more welcome grants would pass the month's budget; null when they fit or no budget is set. */
async function budgetRefusal(n: number): Promise<string | null> {
  const b = await grantBudgetState();
  if (grantBudgetRoom(b, n)) return null;
  return grantBudgetSpentLine(b, monthLabel(cycleBounds(1, now()).start));
}

export async function POST(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  await platformReady();
  const body = await req.json().catch(() => ({}));

  /* The batch (board 12h, `Send N codes`): one code per open request, each
     its own row and its own mail — a mail that fails is reported on its row
     and never stops the next. The budget is checked once, for all N, before
     the first row is written. */
  if (Array.isArray(body.requestIds)) {
    const ids = [...new Set(body.requestIds.map((x: unknown) => String(x)).filter(Boolean))].slice(0, 100) as string[];
    if (!ids.length) return NextResponse.json({ error: "Pick the requests to answer." }, { status: 400 });
    const p = platformDb();
    const open = await p.execute({
      sql: `SELECT id, name, email, note FROM access_requests WHERE handled_at IS NULL AND id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at DESC`,
      args: ids,
    });
    const rows = (open.rows as any[]).filter((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(r.email ?? "")));
    if (!rows.length) return NextResponse.json({ error: "Those requests are already answered." }, { status: 400 });
    const refusal = await budgetRefusal(rows.length);
    if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
    const issued: { code: string; link: string; email: string; name: string; sent: boolean; mailError: string | null }[] = [];
    for (const r of rows) {
      const one = await issueOne(req, got.user, {
        email: String(r.email).trim().toLowerCase(), name: String(r.name ?? "").trim().slice(0, 80),
        note: String(r.note ?? "").trim().slice(0, 400), requestId: String(r.id), send: body.send !== false, claim: true,
      });
      /* Answered by another press between the SELECT and the claim: no second code. */
      if (!one) continue;
      issued.push({ code: one.code, link: one.link, email: one.email, name: one.name, sent: one.sent, mailError: one.mailError });
    }
    return NextResponse.json({ issued });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim().slice(0, 80);
  const note = String(body.note ?? "").trim().slice(0, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "That doesn't look like an email address" }, { status: 400 });
  /* One code is one welcome grant; the month's budget covers it like the batch. No budget set, nothing changes. */
  const refusal = await budgetRefusal(1);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
  const one = await issueOne(req, got.user, { email, name, note, requestId: body.requestId ? String(body.requestId) : null, send: body.send !== false });
  /* Unreachable without `claim`; the type says so rather than a `!`. */
  if (!one) return NextResponse.json({ error: "That request is already answered." }, { status: 409 });
  return NextResponse.json(one);
}
