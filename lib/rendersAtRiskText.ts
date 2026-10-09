/**
 * Words for renders at risk (lib/rendersAtRisk.ts), shared by the platform
 * owner's email and the admin desk. Safe in the browser: no database here.
 */

export type AtRiskRender = {
  workspaceId: string;
  workspace: string;
  generationId: string;
  provider: string;
  model: string;
  /** When it was at risk from: when it succeeded, or (a provider-finished take still running) when saving first failed. */
  since: number;
  /** False for a take the provider finished whose save failed before it was billed (it is still running). */
  billed: boolean;
  /** Past the 3-day window in which the cron tries to save it (lib/rendersAtRisk.ts RETRY_WINDOW_MS). */
  lost: boolean;
  lastError: string | null;
  alertedAt: number | null;
};

export type AtRiskDesk = {
  /** The server's clock when the desk was read: ages are measured from it. */
  at: number;
  count: number;
  /** How many of `count` are past the 3-day window. */
  lost: number;
  oldestSince: number | null;
  /** When the platform owner was last emailed about the renders now open. */
  lastMailAt: number | null;
  renders: AtRiskRender[];
};

/** "45 min", "3 h", "2 d 4 h". */
export function ageText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} d ${rest} h` : `${days} d`;
}

const plural = (n: number) => `${n} render${n === 1 ? "" : "s"}`;

/** The admin line: how many, how many of them are lost, and how old the oldest is. */
export function atRiskLine(desk: Pick<AtRiskDesk, "count" | "lost" | "oldestSince">, at = Date.now()): string {
  if (!desk.count || desk.oldestSince == null) return "No render is waiting for a stored copy.";
  const lost = desk.lost ? ` · ${desk.lost} lost` : "";
  return `${plural(desk.count)} with no stored copy${lost} · oldest ${ageText(at - desk.oldestSince)}`;
}

/** What is true of a render beyond its ids: not billed yet, and lost (past its window). */
export function atRiskState(r: Pick<AtRiskRender, "billed" | "lost">): string {
  const parts: string[] = [];
  if (!r.billed) parts.push("provider finished, not billed yet");
  if (r.lost) parts.push(r.billed
    ? "lost: no longer retried"
    : "lost: 3 days since the first failed save; tried until the provider no longer has the job");
  return parts.map((p) => ` · ${p}`).join("");
}

/** One render, as the email lists it. Ids, names and timings only: no link, no prompt. */
export function atRiskItem(r: AtRiskRender, at = Date.now()): string {
  const error = r.lastError ? ` · last save error: ${r.lastError}` : "";
  return `${r.workspace} (${r.workspaceId}) · ${r.generationId} · ${r.provider} ${r.model} · ${ageText(at - r.since)}${atRiskState(r)}${error}`;
}
