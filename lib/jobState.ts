
/**
 * Job state, in the studio's words (brief 1.5): why a take failed and
 * what to do about it, and the queue's counts. Pure; the browser reads it.
 */
export type FailureKind = "refused" | "cap" | "balance" | "slots" | "vendor" | "unknown";
export type FailureAction = "edit" | "unlock" | "topup" | "retry";

export type Row = { status: string; error?: string | null; params?: unknown; kind?: string; model?: string };

/** Which of the four things the brief names happened, read off the row's own words. */
export function failureKind(error: string | null | undefined, params?: unknown): FailureKind {
  const held = (params as { held?: { why?: string } } | undefined)?.held;
  if (held?.why === "slots") return "slots";
  if (held?.why === "credits") return "balance";
  const e = (error ?? "").toLowerCase();
  if (!e) return "unknown";
  if (/refus|safety|moderat|policy|nsfw|sensitive|blocked|content filter|prohibited/.test(e)) return "refused";
  if (/\bcap\b|over the cap|at its cap|unlock/.test(e)) return "cap";
  if (/credit|balance|top up|top-up/.test(e)) return "balance";
  if (/slot|at once|renders in the last hour/.test(e)) return "slots";
  if (/fal\.ai|modelark|ark\b|vendor|engine|timed out|timeout|never came back|no longer has|could not reach|could not download|\b5\d\d\b|network|upstream/.test(e)) return "vendor";
  return "unknown";
}

/** The reason in one sentence and the one action that fits it. */
export function failureCopy(kind: FailureKind): { why: string; action: FailureAction; label: string } {
  switch (kind) {
    case "refused": return { why: "The engine refused this prompt.", action: "edit", label: "Edit the prompt" };
    case "cap": return { why: "The production is at its cap.", action: "unlock", label: "Ask an admin to unlock" };
    case "balance": return { why: "The balance is at zero.", action: "topup", label: "Top up" };
    case "slots": return { why: "Every render slot was busy.", action: "retry", label: "Render again" };
    case "vendor": return { why: "The engine hit an error; nothing was charged for a failure.", action: "retry", label: "Render again" };
    default: return { why: "This render did not finish.", action: "retry", label: "Render again" };
  }
}

/** An identity being trained: asynchronous work that belongs in the queue beside the renders (brief 1.3). */
export type TrainingRow = { id: string; name: string; status: string; costUsd: number | null; creditsBilled?: number | null; steps: number | null };
export const inTraining = <T extends { status: string }>(rows: T[]): T[] => rows.filter((r) => r.status === "training");

export type QueueCounts = { rendering: number; queued: number; held: number; failed: number };

/** The queue's four numbers: rendering (running or queued at the vendor), queued for a slot, held for credits, failed. */
export function queueCounts(rows: Row[]): QueueCounts {
  const c: QueueCounts = { rendering: 0, queued: 0, held: 0, failed: 0 };
  for (const r of rows) {
    if (r.status === "running" || r.status === "queued") c.rendering++;
    else if (r.status === "held") { if ((r.params as { held?: { why?: string } } | undefined)?.held?.why === "slots") c.queued++; else c.held++; }
    else if (r.status === "failed" || r.status === "cancelled") c.failed++;
  }
  return c;
}
