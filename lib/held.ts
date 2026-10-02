import { after } from "next/server";
import type { Transaction } from "@libsql/client";
import { assertRecoveryOpen, reserveRecoveryContinuation } from "./recovery";
import { db, ready, now } from "./db";
import { meter } from "./meter";
import { currentTenant } from "./tenant";
import { creditState } from "./credits";
import { billCredits, creditUsd, creditsFigure, floorDeci, fromDeci, heldPriceNow, marginKeyOf, toDeci } from "./creditTerms";
import { approvedHeldPrice, sameCredits } from "./creditUnits";
import { reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { enqueueRender } from "./inngest";
import { runInline } from "./renderWork";
import { submitVideoRow } from "./submitVideo";
import { invalidate, PROJECTS_KEY } from "./cache";
import { sendMail, mailConfigured } from "./mail";
import { membershipRole, workspaceAdmins } from "./platform";
import { workspaceLimits, standing } from "./limits";
import { notify } from "./push";
import { ProviderPoolBusyError } from "./generationRequests";
import { POOL_MARK, SHARED_POOL, leavePool, poolPrecheck, queueForPool, releasePoolWaiters, waitingIn } from "./providerPool";

/**
 * The hard stop at zero.
 *
 * A workspace that runs out of credits does not get refused: the take is
 * written with everything needed to run it and parked as `held`. No engine
 * is asked and nothing is billed. The moment credits arrive — a grant, a
 * top-up, or the cron finding the balance restored — held takes are
 * released oldest first, and the first one that does not fit stops the
 * line of takes held for credits, so the balance is never spent out of
 * order. The owner and admins hear once, when the first take is held.
 */
export const HELD_LIMIT = 20;
export type HeldWhy = "credits" | "slots";
/**
 * `needs` is in tenths of a credit at `unitUsd`, the price of a credit when the take was held (absent on older rows:
 * the legacy price).
 *
 * `pool`: waiting for a slot of the platform's shared provider key
 * (lib/providerPool.ts) rather than of this workspace. Always with `why:
 * "slots"`, so every screen that knows a slot wait shows it as one.
 */
export type HeldInfo = { estUsd: number; needs: number; at: number; why: HeldWhy; unitUsd?: number; pool?: typeof POOL_MARK };
type Defer = (fn: () => Promise<void>) => void | Promise<void>;

/**
 * Keep a released take's paid submission alive past the response that
 * released it: reserved as a recovery continuation, then run in Next's
 * `after`. Outside a request (a script, a test) there is no response to
 * outlive, so it runs to the end here — never as a floating promise.
 */
export function continueAfterResponse(kind = "held-release"): Defer {
  return async (fn) => {
    const run = await reserveRecoveryContinuation(kind, fn);
    try {
      after(run);
    } catch {
      await run();
    }
  };
}

/** A take reached its end — a slot, or the reservation, came back: start what waited. */
export async function releaseAfterSettlement(): Promise<void> {
  try {
    await releaseHeldJobs();
  } catch (error) {
    console.error("release after settlement:", (error as Error).message);
  }
  /* The slot may have been the shared pool's: the take next in its line may be another workspace's. */
  try {
    await releasePoolWaiters();
  } catch (error) {
    console.error("shared pool after settlement:", (error as Error).message);
  }
}

/** A take held for the shared pool: a slot wait, marked as the pool's. */
export const poolHold = (info: HeldInfo): HeldInfo => ({ ...info, why: "slots", pool: POOL_MARK });

/**
 * Its reservation found the shared pool full after the take was written (two
 * Generates raced for the last slot): park it as held, in the line, instead of
 * failing it. Only while nothing was claimed or sent for it; false otherwise.
 */
export async function holdForPool(id: string, info: HeldInfo): Promise<boolean> {
  const workspaceId = currentTenant()?.workspace?.id;
  const held = poolHold(info);
  const out = await db().execute({
    sql: `UPDATE generations SET status='held', params=json_set(params, '$.held', json(?)), updated_at=?
          WHERE id=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.paidClaim') IS NULL`,
    args: [JSON.stringify(held), now(), id],
  });
  if (!out.rowsAffected) return false;
  if (workspaceId) await queueForPool(SHARED_POOL, { id, workspaceId, queuedAt: held.at }).catch(() => {});
  invalidate(PROJECTS_KEY);
  return true;
}

const DISCARDED = "Discarded before it started. Nothing was charged.";

/**
 * Take a held take out of the line. Nothing was reserved or sent for it, so
 * nothing is charged or refunded: it becomes a cancelled take. False when it
 * is no longer held (it was released a moment ago, or has already ended).
 */
export async function discardHeldJob(id: string, tx?: Transaction): Promise<boolean> {
  const t = now();
  const out = await (tx ?? db()).execute({
    sql: `UPDATE generations SET status='cancelled', error=?, cost_usd=0, updated_at=?,
            params=json_set(params, '$.discardedAt', ?)
          WHERE id=? AND status='held'`,
    args: [DISCARDED, t, t, id],
  });
  if (out.rowsAffected) invalidate(PROJECTS_KEY);
  /* Out of the shared pool's line too, if it stood in it. It held no slot, so none is released. */
  const workspaceId = currentTenant()?.workspace?.id;
  if (out.rowsAffected && workspaceId) await leavePool(id, workspaceId).catch(() => false);
  return out.rowsAffected > 0;
}

export function heldInfo(estUsd: number, kind: string, model: string, why: HeldWhy = "credits"): HeldInfo {
  return { estUsd, needs: billCredits(estUsd, marginKeyOf(kind, model)), at: now(), why, unitUsd: creditUsd() };
}

/** What is left, to a tenth and rounded down: never more than can be spent. */
const leftOf = (left: number | null | undefined): number => fromDeci(floorDeci(Math.max(0, Number(left ?? 0) || 0)));

export function heldMessage(needs: number, left: number): string {
  const l = leftOf(left);
  return `Held: this needs ${creditsFigure(needs)} credit${needs === 1 ? "" : "s"} and ${creditsFigure(l)} ${l === 1 ? "is" : "are"} left. Top up to release it — nothing is lost.`;
}

export async function heldCount(): Promise<number> {
  await ready();
  const rs = await db().execute(`SELECT COUNT(*) AS n FROM generations WHERE status = 'held' AND deleted = 0`);
  return Number((rs.rows[0] as { n?: number })?.n ?? 0);
}

/** Oldest first; the first take that does not fit stops the line. A null balance means credits do not apply. */
export function planRelease(held: { id: string; needs: number }[], balance: number | null): { release: string[]; short: string[] } {
  if (balance == null) return { release: held.map((h) => h.id), short: [] };
  const release: string[] = [];
  // In whole tenths, so a run of releases never drifts past what the balance holds.
  let left = floorDeci(balance);
  let i = 0;
  for (; i < held.length; i++) {
    const needs = toDeci(held[i].needs);
    if (needs > left) break;
    release.push(held[i].id);
    left -= needs;
  }
  return { release, short: held.slice(i).map((h) => h.id) };
}

type HeldRow = {
  id: string; kind: "video" | "image" | "audio"; model: string; engine: string;
  projectId: string | null; shotId: string | null; createdBy: string | null;
  /** `needs` is what it costs to start now; `heldAt` what it cost when it was held — the figure approved at Generate. */
  estUsd: number; estimateValid: boolean; needs: number; heldAt: number | null; why: HeldWhy;
  token?: { id: string; capUsd: number | null };
  /** Waiting for the shared pool, and since when (its place in that line). */
  pool: boolean; since: number;
};

/**
 * Whether a released take skips the shot's credit cap. That is its author's
 * standing (an admin's take was never capped), or an admin pressing Release
 * on it — never whoever's poll happened to settle another take and start
 * the line. An author who has left the workspace is capped.
 */
function shotCapExemption(adminReleasing: boolean): (author: string | null) => Promise<boolean> {
  const roles = new Map<string, Promise<boolean>>();
  return async (author) => {
    if (adminReleasing) return true;
    const ws = currentTenant()?.workspace;
    if (!author || !ws) return false;
    if (!roles.has(author))
      roles.set(author, membershipRole(ws.id, author).then((role) => role === "owner" || role === "admin").catch(() => false));
    return roles.get(author)!;
  };
}

async function heldRows(only?: string): Promise<HeldRow[]> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT id, kind, model, billed_to, provider, project_id, shot_id, created_by, created_at, params, token_id,
                 (SELECT cap_usd FROM api_tokens WHERE api_tokens.id=generations.token_id) AS token_cap,
                 (SELECT cap_credits FROM api_tokens WHERE api_tokens.id=generations.token_id) AS token_cap_credits
          FROM generations WHERE status = 'held' AND deleted = 0 ${only ? "AND id = ?" : ""}
          ORDER BY created_at ASC LIMIT 50`,
    args: only ? [only] : [],
  });
  return rs.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    let held: Partial<HeldInfo> = {};
    try { held = (JSON.parse(String(row.params ?? "{}")) as { held?: Partial<HeldInfo> }).held ?? {}; } catch { held = {}; }
    const kind = (row.kind === "image" || row.kind === "audio" ? row.kind : "video") as HeldRow["kind"];
    const model = String(row.model);
    const estUsd = Number(held.estUsd ?? 0);
    const needs = heldPriceNow(held, kind, model);
    return {
      id: String(row.id), kind, model,
      engine: String(row.billed_to ?? row.provider ?? "byteplus"),
      projectId: (row.project_id as string | null) ?? null, shotId: (row.shot_id as string | null) ?? null,
      createdBy: (row.created_by as string | null) ?? null,
      /* `needs` is re-derived, not read back.
         The snapshot written when the take was held is what the PERSON was
         told; it is not what the take will cost. Those came apart the moment
         the margin table changed (§7A): a take held at the old price would be
         released as soon as the balance covered it, then bill the new one — a
         workspace pushed negative by a price change it never saw. Whatever is
         released has to be measured against what it costs NOW, and a figure
         that moved is started only by a person approving it (Release).
         The snapshot is still the fallback, for a row old enough to have no
         `estUsd` in it, where deriving would give zero and release it free. */
      estUsd,
      estimateValid: held.estUsd != null && Number.isFinite(estUsd) && estUsd >= 0 && (estUsd > 0 || needs === 0),
      needs,
      heldAt: approvedHeldPrice(held),
      why: held.why === "slots" ? "slots" : "credits",
      pool: held.why === "slots" && held.pool === POOL_MARK,
      since: Number.isFinite(Number(held.at)) && Number(held.at) > 0 ? Number(held.at) : Number(row.created_at ?? 0) || now(),
      token: row.token_id ? {
        id: String(row.token_id),
        capUsd: row.token_cap == null ? null : Number(row.token_cap),
        capCredits: row.token_cap_credits == null ? null : Number(row.token_cap_credits),
      } : undefined,
    };
  });
}

/** Why one take a person pressed Release on did not start. Nothing was reserved or charged for it. */
export type ReleaseRefusal = { status: number; error: string; needs: number; balance: number | null };

export const SLOTS_BUSY = "Every render slot is busy. It starts on its own when one is free.";
export function stillShort(needs: number, balance: number | null): string {
  const left = leftOf(balance);
  return `Still short: this needs ${creditsFigure(needs)} credit${needs === 1 ? "" : "s"} and ${creditsFigure(left)} ${left === 1 ? "is" : "are"} left.`;
}
/** The price on the button is what the person approved (lib/workspace/rig.ts dispatchGate says the same for Generate). */
export function repriced(needs: number): string {
  return `The price is now ${creditsFigure(needs)} cr. Press Release again to approve it.`;
}
/** Written on a take whose price moved while it waited: nobody approved the new figure, so nothing starts it on its own. */
export function movedPrice(needs: number): string {
  return `The price is now ${creditsFigure(needs)} cr. Release it at that price to start it.`;
}

/**
 * Release what the balance now covers. `only` releases one take (a person
 * pressing Release); `approved` is the exact credits that person was shown,
 * and a take whose price is now different is not started; `defer` is how the
 * caller keeps the render alive past its response (by default, Next's
 * `after` behind a recovery continuation). With `only`, a take that does not
 * start comes back with `refused`: why, in the words to show.
 *
 * Takes held for credits keep their order among themselves: the first the
 * balance does not cover stops that line. A take that only waited for a
 * slot, or one that cannot start for a reason of its own (a project, shot
 * or token cap), spends nothing and holds up nobody: the reason is written
 * on it, and the line is measured again without it.
 */
export async function releaseHeldJobs(opts: { only?: string; approved?: number; defer?: Defer } = {}): Promise<{ released: string[]; short: number; refused?: ReleaseRefusal }> {
  await assertRecoveryOpen();
  const rows = await heldRows(opts.only);
  if (!rows.length) return { released: [], short: 0 };
  const state = await creditState();
  /* Credits are checked for the takes held for credits; a slot is needed by
     every release, whatever it was held for. */
  const credits = rows.filter((r) => r.why === "credits");
  const balance = state ? state.balance : null;
  const refused = new Set<string>();
  let plan = planRelease(credits, balance);
  const [limits, st] = await Promise.all([workspaceLimits(), standing()]);
  let running = st.running;
  const defer: Defer = opts.defer ?? continueAfterResponse();
  const exempt = shotCapExemption(opts.only ? currentTenant()?.user?.role === "admin" : false);
  const released: string[] = [];
  let creditsStalled = false;
  let refusal: ReleaseRefusal | undefined;
  const refuse = (status: number, error: string, r: HeldRow) => { if (opts.only) refusal = { status, error, needs: r.needs, balance }; };
  /* The shared pool's line (lib/providerPool.ts). A take in it that waits on
     something of its own (a price, a cap, credits, its workspace's own limits)
     steps out, so it never holds a free shared slot away from the next
     workspace; it steps back in, keeping its first place, when it can start. */
  const workspaceId = currentTenant()?.workspace?.id ?? null;
  const outOfLine = async (r: HeldRow) => { if (r.pool && workspaceId) await leavePool(r.id, workspaceId).catch(() => false); };
  const inLine = async (r: HeldRow) => { if (workspaceId) await queueForPool(SHARED_POOL, { id: r.id, workspaceId, queuedAt: r.since }).catch(() => {}); };
  let stoppedAt = rows.length;
  for (const [index, r] of rows.entries()) {
    /* An old or incomplete snapshot cannot authorize a free or guessed reservation. Keep the take intact. */
    if (!r.estimateValid) {
      const said = "This take's saved price is incomplete. Recreate it to get a current quote; this take is kept.";
      refuse(409, said, r);
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='held' AND COALESCE(error,'')<>?",
        args: [said, now(), r.id, said] }).catch(() => {});
      refused.add(r.id);
      plan = planRelease(credits.filter((c) => !refused.has(c.id)), balance);
      await outOfLine(r);
      continue;
    }
    /* One person's press approves one figure: a price that moved since it was shown starts nothing. */
    if (opts.only && opts.approved != null && !sameCredits(r.needs, opts.approved)) { refuse(409, repriced(r.needs), r); continue; }
    /* Nobody approved a price that moved while the take waited for credits: it is left, said, for a person to
       release at the new figure (its card offers Release at it), and it holds up nobody behind it. */
    if (!opts.only && balance != null && !sameCredits(r.needs, r.heldAt)) {
      const said = movedPrice(r.needs);
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='held' AND COALESCE(error,'')<>?",
        args: [said, now(), r.id, said] }).catch(() => {});
      refused.add(r.id);
      plan = planRelease(credits.filter((c) => !refused.has(c.id)), balance);
      await outOfLine(r);
      continue;
    }
    const short = r.why === "credits" && (creditsStalled || !plan.release.includes(r.id));
    /* A person's press hears the reason that stands even when a slot frees: short is short. */
    if (short && opts.only) { creditsStalled = true; refuse(402, stillShort(r.needs, balance), r); continue; }
    if (running >= limits.concurrency) { refuse(409, SLOTS_BUSY, r); stoppedAt = index; break; }
    if (short) { creditsStalled = true; continue; }
    /* In the shared pool's line: ask the line first (a read), so a take it would not admit reserves nothing.
       The reservation asks again in its own write; only that answer counts. */
    if (r.pool && workspaceId) {
      const line = await poolPrecheck(SHARED_POOL, { id: r.id, workspaceId, at: now(), queuedAt: r.since }).catch(() => null);
      if (line && !line.admit) { refuse(409, SLOTS_BUSY, r); await inLine(r); continue; }
    }
    // The meter first: work the platform cannot bill does not start.
    try {
      await reserveGenerationSpend({ id: r.id, kind: r.kind, engine: r.engine, model: r.model, status: "running",
                    engineCostUsd: r.estUsd, projectId: r.projectId, shotId: r.shotId, createdBy: r.createdBy },
                    { token: r.token, shotCapExempt: r.shotId ? await exempt(r.createdBy) : false });
    } catch (e) {
      /* Nothing else stops it, only a shared slot: it waits in that line (from its own hold time), unreserved and unsent. */
      if (e instanceof ProviderPoolBusyError) {
        refuse(409, SLOTS_BUSY, r);
        if (!r.pool) {
          await db().execute({ sql: `UPDATE generations SET params=json_set(params,'$.held.why','slots','$.held.pool',?), updated_at=? WHERE id=? AND status='held'`,
            args: [POOL_MARK, now(), r.id] }).catch(() => {});
          if (r.why === "credits") { refused.add(r.id); plan = planRelease(credits.filter((c) => !refused.has(c.id)), balance); }
        }
        await inLine(r);
        continue;
      }
      console.error(`release ${r.id}: not metered —`, (e as Error).message);
      const status = e instanceof SpendReservationError ? e.status : 503;
      /* Short at the reservation (another take reserved credits meanwhile): said with the balance as it is now. */
      const left = status === 402 && opts.only ? ((await creditState().catch(() => null))?.balance ?? balance) : balance;
      refuse(status, status === 402 ? stillShort(r.needs, left) : e instanceof SpendReservationError ? e.message : "This take could not be started just now. Nothing was charged.", r);
      // A workspace-wide stop (every slot reserved, the hourly limit, a paused workspace) ends the pass.
      if (!(e instanceof SpendReservationError) || !(e.perJob || e.status === 402)) { stoppedAt = index; break; }
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='held'",
        args: [e.message.slice(0, 600), now(), r.id] }).catch(() => {});
      /* Out of the shared line: short of credits it now waits for credits (and says so), else for a person. */
      if (r.pool && e.status === 402)
        await db().execute({ sql: `UPDATE generations SET params=json_remove(json_set(params,'$.held.why','credits'),'$.held.pool'), updated_at=? WHERE id=? AND status='held'`,
          args: [now(), r.id] }).catch(() => {});
      await outOfLine(r);
      if (r.why === "credits") {
        // Only the balance stops the line. A take its own cap refuses spent
        // nothing, so the takes behind it are measured without it.
        if (e.status === 402) creditsStalled = true;
        else {
          refused.add(r.id);
          plan = planRelease(credits.filter((c) => !refused.has(c.id)), balance);
        }
      }
      continue;
    }
    const t = now();
    const next = r.kind === "video" ? "queued" : "running";
    // The clock restarts: the janitor measures a take from when it was sent, and it is sent now.
    const upd = await db().execute({
      sql: `UPDATE generations
            SET status = ?, created_at = ?, updated_at = ?, error = NULL,
                params = json_remove(json_set(params, '$.releasedAt', ?), '$.held')
            WHERE id = ? AND status = 'held'`,
      args: [next, t, t, t, r.id],
    });
    if (!upd.rowsAffected) {
      // Discarded between its reservation and its release: nothing may stay reserved for it.
      const row = (await db().execute({ sql: "SELECT json_extract(params,'$.discardedAt') AS discarded FROM generations WHERE id=?", args: [r.id] })).rows[0];
      if (row?.discarded != null)
        await meter({ id: r.id, kind: r.kind, engine: r.engine, model: r.model, status: "failed", engineCostUsd: 0 }, { critical: false });
      continue;
    }
    if (r.kind === "video") await defer(async () => { await submitVideoRow(r.id); });
    else if (!(await enqueueRender(r.id, r.kind))) await defer(() => runInline(r.id));
    released.push(r.id);
    running += 1;
  }
  /* This workspace can start nothing more just now: its takes in the shared line step out rather than hold a slot
     from the next workspace. Its next settlement (or the sync) asks again, and they step back in where they were. */
  for (const r of rows.slice(stoppedAt)) await outOfLine(r);
  if (!opts.only && workspaceId) await pruneLine(workspaceId).catch(() => {});
  if (released.length) invalidate(PROJECTS_KEY);
  return { released, short: rows.length - released.length, ...(refusal && !released.length ? { refused: refusal } : {}) };
}

/** The shared line's entries for takes no longer waiting in it here (discarded, released, hidden, gone) step out of it. */
async function pruneLine(workspaceId: string): Promise<void> {
  const ids = await waitingIn(workspaceId);
  if (!ids.length) return;
  const rs = await db().execute({
    sql: `SELECT id FROM generations WHERE id IN (${ids.map(() => "?").join(",")}) AND deleted=0 AND status='held'
            AND json_extract(params,'$.held.pool') IS NOT NULL`,
    args: ids,
  });
  const still = new Set(rs.rows.map((r) => String(r.id)));
  for (const id of ids) if (!still.has(id)) await leavePool(id, workspaceId);
}

function siteUrl(): string {
  const raw = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  return raw.replace(/\/$/, "");
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Tell the owner and admins, once per episode: the first take held while nothing else was. */
export async function notifyHeld(gen: { id: string; needs: number; left: number }): Promise<void> {
  const ws = currentTenant()?.workspace;
  if (!ws) return;
  if ((await heldCount()) !== 1) return;
  const admins = await workspaceAdmins(ws.id).catch(() => [] as { id: string; email: string; name: string }[]);
  if (!admins.length) return;
  const title = "Renders are being held";
  const body = `A take needs ${creditsFigure(gen.needs)} credits and ${creditsFigure(leftOf(gen.left))} are left. Top up to release it — nothing is lost.`;
  await notify("balanceLow", admins.map((a) => a.id), { title, body, url: "/settings#credits" }).catch(() => {});
  if (!mailConfigured()) return;
  const link = `${siteUrl()}/settings#credits`;
  await Promise.allSettled(admins.filter((a) => a.email).map((a) => sendMail({
    to: a.email,
    subject: `${ws.name}: ${title}`,
    text: `${body}\n\n${link}`,
    html: `<p>${esc(body)}</p><p><a href="${esc(link)}">Open Settings</a></p>`,
  })));
}
