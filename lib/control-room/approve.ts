import type { Step } from "@/lib/atomik";
import { approvedBody, fetchStepQuote, stepRender } from "@/lib/atomikStepRender";
import { batchable, pressable, type QueueItem } from "./queue";

/**
 * Pressing a queue item: each goes through its own existing route, with its
 * own price or fingerprint, exactly as the screen it came from would send it.
 * Nothing here is a new way to approve, and there is no batch route: "Approve
 * in one go" is a person's one tap that sends the items it listed one at a
 * time, and stops at the first refusal.
 *
 *  - a held take:   POST /api/jobs/:id/release {credits}   (lib/held.ts)
 *  - a board build: POST /api/workbench/team-canvas {action:"agent.approve", fingerprint}
 *  - a board plan:  POST /api/workbench/team-canvas {action:"agent.approvePlan", fingerprint} (approved once, at its total)
 *  - a board render: POST /api/workbench/team-canvas {action:"agent.render", seq, fingerprint}
 *  - a plan's step: its own Continue, at its live price (ThreadCheckpoint); never from here, except another member's step that is over the cap or the line, which an
 *    admin approves from here (`approveAnotherStep`: claim, price, render, record; never the chat).
 *
 * "Not now" is the item's own way to let it go, and charges nothing:
 * discard a held take, set a build aside, skip a render, turn a step down.
 */

/** A fetch already bound to the workspace scope the screen was drawn for (lib/useScopedFetch). */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type PressOutcome =
  | { ok: true; already?: boolean }
  | { ok: false; reason: string; status: number | null };

/** Said on the window after any press, so every open queue (Approvals, Home, ⌘K, the phone) reads again. */
export const APPROVALS_CHANGED = "particl:approvals-changed";
export function approvalsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(APPROVALS_CHANGED));
}

/** Said when an answer never arrived: what landed shows on the next read, and nothing is sent again from here. */
export const LOST_REPLY = "The answer didn't arrive. Approvals reads again before anything else is sent.";
/** A plan's step is approved by its own Continue, which prices it live first. */
export const THREAD_CONTINUE = "This step is approved with its plan's Continue, at its live price.";

async function send(fetcher: Fetcher, url: string, init: RequestInit, fallback: string): Promise<PressOutcome> {
  let response: Response;
  try {
    response = await fetcher(url, { cache: "no-store", ...init });
  } catch {
    return { ok: false, reason: LOST_REPLY, status: null };
  }
  const body = (await response.json().catch(() => null)) as { error?: unknown; already?: unknown } | null;
  if (response.ok) return body?.already === true ? { ok: true, already: true } : { ok: true };
  return { ok: false, reason: typeof body?.error === "string" && body.error ? body.error : fallback, status: response.status };
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Approve one item through its own route. Refused here, without a request, when this person may not press it. */
export async function approveItem(item: QueueItem, fetcher: Fetcher): Promise<PressOutcome> {
  const ref = item.approve;
  if (!ref || !pressable(item)) return { ok: false, reason: item.why ?? "This one can't be approved here.", status: null };
  switch (ref.kind) {
    case "release":
      return send(fetcher, `/api/jobs/${encodeURIComponent(ref.genId)}/release`, json({ credits: ref.credits }), "This take could not be released. Nothing was charged.");
    case "board-approve":
      if (ref.plan)
        return send(fetcher, "/api/workbench/team-canvas", json({ action: "agent.approvePlan", productionId: ref.productionId, runId: ref.runId, fingerprint: ref.fingerprint }), "This plan could not be approved. Nothing was charged.");
      return send(fetcher, "/api/workbench/team-canvas", json({ action: "agent.approve", productionId: ref.productionId, runId: ref.runId, fingerprint: ref.fingerprint }), "This build could not be approved.");
    case "board-render":
      return send(fetcher, "/api/workbench/team-canvas", json({ action: "agent.render", productionId: ref.productionId, runId: ref.runId, seq: ref.seq, fingerprint: ref.fingerprint }), "This render could not be approved.");
    case "thread":
      return ref.chatId === null ? approveAnotherStep(item, ref.stepId, fetcher) : { ok: false, reason: THREAD_CONTINUE, status: null };
  }
}

/**
 * An admin approves another member's step that needs an admin's tap (owner, 13 Oct): the claim (which marks it running and hands back the step itself, never its chat), its
 * live price from the route that will render it, the render at that price, and the step settled by the server from the render's own record. The request names only the step
 * (`atomikStepId`): the server resolves where it files, so the member's production caps apply and the admin never reads the board. If the live price is
 * above the one shown, or cannot be had, the claim is handed back (the step is proposed again) and nothing is rendered or charged.
 */
async function approveAnotherStep(item: QueueItem, stepId: string, fetcher: Fetcher): Promise<PressOutcome> {
  let claimed: Response;
  try { claimed = await fetcher(`/api/atomik/steps/${encodeURIComponent(stepId)}/claim`, { method: "POST", cache: "no-store" }); } catch { return { ok: false, reason: LOST_REPLY, status: null }; }
  const claim = (await claimed.json().catch(() => null)) as { error?: unknown; step?: Step } | null;
  if (!claimed.ok || !claim?.step) return { ok: false, reason: typeof claim?.error === "string" && claim.error ? claim.error : "This step couldn't be started. Nothing was charged.", status: claimed.status };
  const step = claim.step;
  const handBack = async () => { try { await fetcher(`/api/atomik/steps/${encodeURIComponent(step.id)}/release`, { method: "POST" }); } catch { /* it is released the next time it is read */ } };
  const plain = stepRender(step, null);
  const render = { ...plain, body: { ...plain.body, atomikStepId: step.id } };
  const quoted = await fetchStepQuote(render, "", undefined, fetcher as unknown as typeof fetch);
  if ("error" in quoted) { await handBack(); return { ok: false, reason: `${quoted.error} Nothing was charged.`, status: null }; }
  const shown = item.price && item.price.kind !== "free" ? item.price.credits : null;
  if (shown !== null && quoted.quote.estimatedCredits > shown) {
    await handBack();
    return { ok: false, reason: "The price moved above the one shown. Nothing was charged; read the queue again.", status: null };
  }
  let rendered: Response;
  try {
    rendered = await fetcher(render.url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": step.requestKey ?? `atomik-step:${step.id}` }, body: JSON.stringify(approvedBody(render, quoted.quote)) });
  } catch { return { ok: false, reason: LOST_REPLY, status: null }; }
  const made = (await rendered.json().catch(() => ({}))) as { error?: string; pending?: boolean; code?: string };
  /* Still being accepted, or set aside: the step settles from the request's record when it is next read, and nothing is sent again from here. */
  if (rendered.status === 409 && (made.pending || made.code === "set_aside")) return { ok: false, reason: made.error ?? "That render is still being accepted. It will show once it has started.", status: 409 };
  /* Refused before anything started (a cap, the line, a balance): the step goes back to be approved again; if a request was recorded, the settle below marks what became of it. */
  if (!rendered.ok) await handBack();
  /* The server settles the step from the render's own record; nothing of the result is sent back to it from here. */
  try { await fetcher(`/api/atomik/steps/${encodeURIComponent(step.id)}/settle`, { method: "POST" }); } catch { /* settled the next time it is read */ }
  return rendered.ok ? { ok: true } : { ok: false, reason: made.error ?? "That render didn't start.", status: rendered.status };
}

/** Not now, through the item's own route. Nothing is charged by any of them. */
export async function declineItem(item: QueueItem, fetcher: Fetcher): Promise<PressOutcome> {
  const ref = item.decline;
  if (!ref) return { ok: false, reason: item.why ?? "This one can't be set aside here.", status: null };
  switch (ref.kind) {
    case "discard":
      return send(fetcher, `/api/jobs/${encodeURIComponent(ref.genId)}`, { method: "DELETE" }, "This take could not be discarded.");
    case "board-decline":
      return send(fetcher, "/api/workbench/team-canvas", json({ action: "agent.decline", productionId: ref.productionId, runId: ref.runId }), "This build could not be set aside.");
    case "board-skip":
      return send(fetcher, "/api/workbench/team-canvas", json({ action: "agent.skip", productionId: ref.productionId, runId: ref.runId, seq: ref.seq }), "This render could not be skipped.");
    case "thread-stop":
      return send(fetcher, `/api/atomik/steps/${encodeURIComponent(ref.stepId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected" }) }, "This step could not be turned down.");
  }
}

export type BatchResult = {
  /** The items approved, in the order they were sent. */
  approved: QueueItem[];
  /** The first refusal, where the batch stopped; the items after it were not sent. */
  refused: { item: QueueItem; reason: string } | null;
  /** Listed, but never sent because the batch stopped first. */
  unsent: QueueItem[];
};

/**
 * "Approve in one go": the listed items, one at a time, each through its own
 * route at its own price, in the order shown. The first refusal stops it:
 * nothing after it is sent, and nothing is sent twice. An item that may not go
 * in a batch stops it too, before anything is sent for it.
 */
export async function approveBatch(items: readonly QueueItem[], fetcher: Fetcher, onStep?: (done: QueueItem, at: number) => void): Promise<BatchResult> {
  const approved: QueueItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const outcome: PressOutcome = batchable(item) ? await approveItem(item, fetcher) : { ok: false, reason: item.why ?? "This one can't go in Approve in one go.", status: null };
    if (!outcome.ok) return { approved, refused: { item, reason: outcome.reason }, unsent: items.slice(i + 1) };
    approved.push(item);
    onStep?.(item, i);
  }
  return { approved, refused: null, unsent: [] };
}
