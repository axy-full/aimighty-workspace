import { platformDb, platformReady, newId, now, grantCredits, getWorkspace, workspaceAdmins } from "./platform";
import { packById } from "./packs";
import { runInTenant } from "./tenant";
import { releaseHeldJobs } from "./held";
import { sendMail, mailConfigured } from "./mail";
import { notify } from "./push";

/**
 * Top-up requests: a workspace asks for a pack, the platform answers.
 *
 * One row per request in the platform record, with the pack's size and
 * price frozen at the moment of asking so a later price change never
 * rewrites history. Approving one is what adds the credits — through the
 * same grant every other credit arrives by — and releases held takes.
 */
export type TopupStatus = "requested" | "approved" | "declined" | "cancelled";
export type TopupRequest = {
  id: string; workspaceId: string; packId: string; label: string; credits: number; usd: number;
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
    credits: Number(r.credits), usd: Number(r.usd), status: String(r.status) as TopupStatus, note: String(r.note ?? ""),
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
    sql: `INSERT INTO topup_requests (id, workspace_id, pack_id, label, credits, usd, status, note, requested_by, created_at)
          VALUES (?,?,?,?,?,?,'requested',?,?,?)`,
    args: [id, opts.workspaceId, pack.id, pack.label, pack.credits, pack.usd, (opts.note ?? "").slice(0, 300), opts.requestedBy, ts],
  });
  return {
    id, workspaceId: opts.workspaceId, packId: pack.id, label: pack.label, credits: pack.credits, usd: pack.usd,
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
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT * FROM topup_requests WHERE id = ?`, args: [opts.id] });
  const row = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!row) throw new Error("No such request.");
  const req = rowToRequest(row);
  const next = nextStatus(req.status, opts.action);
  if (!next) throw new Error(`This request was already ${req.status}.`);
  const ts = now();
  const upd = await platformDb().execute({
    sql: `UPDATE topup_requests SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ? AND status = 'requested'`,
    args: [next, ts, opts.by, (opts.note ?? "").slice(0, 300) || null, opts.id],
  });
  if (!upd.rowsAffected) throw new Error("This request was answered a moment ago.");
  const request = { ...req, status: next, decidedAt: ts, decidedBy: opts.by, decisionNote: (opts.note ?? "") || null };
  let released = 0;
  if (next === "approved") {
    await grantCredits(req.workspaceId, req.credits, `${req.label} pack · ${req.credits.toLocaleString("en-US")} credits`, opts.by);
    const ws = await getWorkspace(req.workspaceId);
    if (ws) {
      try {
        released = (await runInTenant(ws, () => releaseHeldJobs({ defer: opts.defer }))).released.length;
        await runInTenant(ws, () => notifyApproved(ws.id, ws.name, request, released));
      } catch (e) { console.error("top-up approve follow-through:", (e as Error).message); }
    }
  }
  return { request, released };
}

async function notifyApproved(workspaceId: string, workspaceName: string, req: TopupRequest, released: number): Promise<void> {
  const admins = await workspaceAdmins(workspaceId).catch(() => [] as { id: string; email: string; name: string }[]);
  const who = admins.filter((a) => a.id === req.requestedBy);
  const targets = who.length ? who : admins;
  if (!targets.length) return;
  const title = `${req.credits.toLocaleString("en-US")} credits added`;
  const body = released
    ? `The ${req.label} pack is in, and ${released} held take${released === 1 ? "" : "s"} ${released === 1 ? "is" : "are"} rendering now.`
    : `The ${req.label} pack is in.`;
  await notify("balanceLow", targets.map((a) => a.id), { title, body, url: "/" }).catch(() => {});
  if (!mailConfigured()) return;
  await Promise.allSettled(targets.filter((a) => a.email).map((a) => sendMail({
    to: a.email, subject: `${workspaceName}: ${title}`, text: body, html: `<p>${body.replace(/</g, "&lt;")}</p>`,
  })));
}
