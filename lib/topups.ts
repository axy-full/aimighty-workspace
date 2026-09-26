import { platformDb, platformReady, newId, now, getWorkspace, workspaceAdmins } from "./platform";
import { packById, capBonus } from "./packs";
import { runInTenant } from "./tenant";
import { releaseHeldJobs } from "./held";
import { sendMail, mailConfigured } from "./mail";
import { notify } from "./push";
import { billingTransaction, syncBillingLedger } from "./billingLedger";

/**
 * Top-up requests: a workspace asks for a pack, the platform answers.
 *
 * One row per request in the platform record, with the pack's size, its
 * bonus and its price frozen at the moment of asking, so a later change to
 * the table never rewrites what somebody was quoted. Approving one is what
 * adds the credits — through the same grant every other credit arrives by —
 * and releases held takes.
 */
export type TopupStatus = "requested" | "approved" | "declined" | "cancelled";
export type TopupRequest = {
  id: string; workspaceId: string; packId: string; label: string; credits: number; bonus: number; usd: number;
  status: TopupStatus; note: string; requestedBy: string | null; createdAt: number;
  decidedAt: number | null; decidedBy: string | null; decisionNote: string | null;
};

export const OPEN_LIMIT = 3;

/** The only moves there are: a request is answered once, or withdrawn before it is. */
export function nextStatus(current: TopupStatus, action: "approve" | "decline" | "cancel"): TopupStatus | null {
  if (current !== "requested") return null;
  return action === "approve" ? "approved" : action === "decline" ? "declined" : "cancelled";
}

type Defer = (fn: () => Promise<void>) => void;

function rowToRequest(r: Record<string, unknown>): TopupRequest {
  return {
    id: String(r.id), workspaceId: String(r.workspace_id), packId: String(r.pack_id), label: String(r.label ?? r.pack_id),
    credits: Number(r.credits),
    /* Clamped on the way OUT as well as in (§7A guardrail 2). The number on
       this row was frozen by whatever deployment took the request, and it is
       the number that reaches a grant — so the cap is applied where the money
       is, not only where the table was built. */
    bonus: capBonus(Number(r.credits), r.bonus_credits),
    usd: Number(r.usd), status: String(r.status) as TopupStatus, note: String(r.note ?? ""),
    requestedBy: (r.requested_by as string | null) ?? null, createdAt: Number(r.created_at),
    decidedAt: r.decided_at == null ? null : Number(r.decided_at), decidedBy: (r.decided_by as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
  };
}

export async function listTopups(workspaceId: string, limit = 20): Promise<TopupRequest[]> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT * FROM topup_requests WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
    args: [workspaceId, limit],
  });
  return rs.rows.map((r) => rowToRequest(r as unknown as Record<string, unknown>));
}

export async function requestTopup(opts: { workspaceId: string; packId: string; requestedBy: string; note?: string }): Promise<TopupRequest> {
  const pack = packById(opts.packId);
  if (!pack) throw new Error("No such pack.");
  await platformReady();
  const open = await platformDb().execute({
    sql: `SELECT COUNT(*) AS n FROM topup_requests WHERE workspace_id = ? AND status = 'requested'`,
    args: [opts.workspaceId],
  });
  if (Number((open.rows[0] as { n?: number })?.n ?? 0) >= OPEN_LIMIT) {
    throw new Error(`${OPEN_LIMIT} requests are already waiting. Cancel one, or wait for an answer.`);
  }
  const id = newId("tu");
  const ts = now();
  await platformDb().execute({
    sql: `INSERT INTO topup_requests (id, workspace_id, pack_id, label, credits, bonus_credits, usd, status, note, requested_by, created_at)
          VALUES (?,?,?,?,?,?,?,'requested',?,?,?)`,
    args: [id, opts.workspaceId, pack.id, pack.label, pack.credits, pack.bonus, pack.usd, (opts.note ?? "").slice(0, 300), opts.requestedBy, ts],
  });
  return {
    id, workspaceId: opts.workspaceId, packId: pack.id, label: pack.label, credits: pack.credits, bonus: pack.bonus, usd: pack.usd,
    status: "requested", note: (opts.note ?? "").slice(0, 300), requestedBy: opts.requestedBy, createdAt: ts,
    decidedAt: null, decidedBy: null, decisionNote: null,
  };
}

export async function cancelTopup(id: string, workspaceId: string): Promise<boolean> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `UPDATE topup_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND workspace_id = ? AND status = 'requested'`,
    args: [now(), id, workspaceId],
  });
  return rs.rowsAffected > 0;
}

export type QueueRow = TopupRequest & { workspaceName: string; workspaceSlug: string; requesterEmail: string | null; requesterName: string | null };

/** The platform's queue: what is waiting, and what was answered lately. */
export async function topupQueue(): Promise<{ open: QueueRow[]; decided: QueueRow[] }> {
  await platformReady();
  const q = (where: string, order: string, limit: number) => platformDb().execute({
    sql: `SELECT t.*, w.name AS workspace_name, w.slug AS workspace_slug, a.email AS requester_email, a.name AS requester_name
          FROM topup_requests t JOIN workspaces w ON w.id = t.workspace_id
          LEFT JOIN accounts a ON a.id = t.requested_by
          WHERE ${where} ORDER BY ${order} LIMIT ?`,
    args: [limit],
  });
  const [open, decided] = await Promise.all([
    q(`t.status = 'requested'`, `t.created_at ASC`, 100),
    q(`t.status <> 'requested'`, `t.decided_at DESC`, 30),
  ]);
  const map = (rs: { rows: unknown[] }) => rs.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      ...rowToRequest(row),
      workspaceName: String(row.workspace_name ?? ""), workspaceSlug: String(row.workspace_slug ?? ""),
      requesterEmail: (row.requester_email as string | null) ?? null, requesterName: (row.requester_name as string | null) ?? null,
    };
  });
  return { open: map(open), decided: map(decided) };
}

/**
 * Answer a request. Approving adds the credits through the ordinary grant,
 * releases whatever those credits now cover, and tells the person who asked.
 */
export async function decideTopup(opts: { id: string; action: "approve" | "decline"; by: string; note?: string; defer?: Defer }):
  Promise<{ request: TopupRequest; released: number }> {
  const { request, changed } = await decideTopupCredits(opts);
  let released = 0;
  if (request.status === "approved") {
    const ws = await getWorkspace(request.workspaceId);
    if (ws) {
      try {
        released = (await runInTenant(ws, () => releaseHeldJobs({ defer: opts.defer }))).released.length;
        if (changed) await runInTenant(ws, () => notifyApproved(ws.id, ws.name, request, released));
      } catch (e) { console.error("top-up approve follow-through:", (e as Error).message); }
    }
  }
  return { request, released };
}

/** The decision and both credit grants commit together. Replaying an answer never grants twice. */
export async function decideTopupCredits(opts: { id: string; action: "approve" | "decline"; by: string; note?: string }):
  Promise<{ request: TopupRequest; changed: boolean }> {
  return billingTransaction(async (tx, ts) => {
    const rows = await tx.execute({ sql: `SELECT * FROM topup_requests WHERE id=?`, args: [opts.id] });
    if (!rows.rows[0]) throw new Error("No such request.");
    const req = rowToRequest(rows.rows[0] as Record<string, unknown>);
    const next = opts.action === "approve" ? "approved" : "declined";
    if (req.status === next) return { request: req, changed: false };
    if (!nextStatus(req.status, opts.action)) throw new Error(`This request was already ${req.status}.`);
    // Nobody can open a deleted workspace: its credits wait for a restore. Declining still works.
    if (opts.action === "approve") {
      const ws = await tx.execute({ sql: `SELECT deleted_at FROM workspaces WHERE id=?`, args: [req.workspaceId] });
      if (ws.rows[0]?.deleted_at != null) throw new Error("This workspace was deleted. Restore it before approving its top-up.");
    }
    // Initialize the old balance before this new paid pack is inserted, so its lifetime is dated.
    await syncBillingLedger(tx, req.workspaceId, ts);
    await tx.execute({ sql: `UPDATE topup_requests SET status=?,decided_at=?,decided_by=?,decision_note=? WHERE id=? AND status='requested'`,
      args: [next, ts, opts.by, (opts.note ?? "").slice(0, 300) || null, req.id] });
    if (next === "approved") {
      if (!Number.isSafeInteger(req.credits) || req.credits <= 0 || !Number.isFinite(req.usd) || req.usd <= 0) throw new Error("This pack has invalid billing terms.");
      for (const [kind, amount] of [["purchase", req.credits], ["bonus", req.bonus]] as const) {
        if (!amount) continue;
        await tx.execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)`,
          args: [`topup:${req.id}:${kind}`, req.workspaceId, amount, `${req.label} pack · ${amount.toLocaleString("en-US")} ${kind === "bonus" ? "bonus " : ""}credits`, kind, opts.by, ts] });
      }
      await syncBillingLedger(tx, req.workspaceId, ts);
    }
    return { request: { ...req, status: next, decidedAt: ts, decidedBy: opts.by, decisionNote: (opts.note ?? "").slice(0, 300) || null }, changed: true };
  });
}

async function notifyApproved(workspaceId: string, workspaceName: string, req: TopupRequest, released: number): Promise<void> {
  const admins = await workspaceAdmins(workspaceId).catch(() => [] as { id: string; email: string; name: string }[]);
  const who = admins.filter((a) => a.id === req.requestedBy);
  const targets = who.length ? who : admins;
  if (!targets.length) return;
  const title = `${(req.credits + req.bonus).toLocaleString("en-US")} credits added`;
  const body = released
    ? `The ${req.label} pack is in, and ${released} held take${released === 1 ? "" : "s"} ${released === 1 ? "is" : "are"} rendering now.`
    : `The ${req.label} pack is in.`;
  await notify("balanceLow", targets.map((a) => a.id), { title, body, url: "/" }).catch(() => {});
  if (!mailConfigured()) return;
  await Promise.allSettled(targets.filter((a) => a.email).map((a) => sendMail({
    to: a.email, subject: `${workspaceName}: ${title}`, text: body, html: `<p>${body.replace(/</g, "&lt;")}</p>`,
  })));
}
