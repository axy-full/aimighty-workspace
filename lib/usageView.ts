/**
 * Usage, read as a producer would (SOW v2 §7.12, board 12f): which shot is
 * taking the most takes, what the cycle cost in one line, where each project
 * will end against its cap, and the credits by engine with planning as its
 * own bar. Pure — the route feeds it rows from the one ledger.
 */
export type Block = "a" | "p" | "d" | "x" | "r" | "f";
export type TakeRow = { shotId: string; code: string; projectId: string; project: string; version: number; reviewState: string; status: string };
export type ShotUsage = { shotId: string; code: string; projectId: string; project: string; blocks: Block[]; versions: number[]; takes: number; sentBack: number; state: "Approved" | "Picked" | "Draft"; credits: number };

/** One take as one block: approved · picked · draft · sent back · rendering · failed. */
export function blockOf(reviewState: string, status: string): Block {
  if (status === "failed" || status === "cancelled") return "f";
  if (status !== "succeeded") return "r";
  return reviewState === "approved" ? "a" : reviewState === "picked" ? "p" : reviewState === "changes" ? "x" : "d";
}

/** The shots taking the most takes, in take order per shot, most takes first. The state word is the shot's across
 *  every take it has (`stateOf`), not only the window's: an approved shot stays Approved in the month after. */
export function shotUsage(rows: TakeRow[], creditsByShot: Map<string, number>, top = 8, stateOf?: Map<string, "Approved" | "Picked">): ShotUsage[] {
  const by = new Map<string, ShotUsage>();
  for (const r of rows) {
    const cur = by.get(r.shotId) ?? { shotId: r.shotId, code: r.code, projectId: r.projectId, project: r.project, blocks: [], versions: [], takes: 0, sentBack: 0, state: stateOf?.get(r.shotId) ?? ("Draft" as const), credits: creditsByShot.get(r.shotId) ?? 0 };
    const b = blockOf(r.reviewState, r.status);
    cur.blocks.push(b); cur.versions.push(r.version); cur.takes += 1;
    if (b === "x") cur.sentBack += 1;
    if (b === "a") cur.state = "Approved"; else if (b === "p" && cur.state !== "Approved") cur.state = "Picked";
    by.set(r.shotId, cur);
  }
  return [...by.values()].sort((a, b) => b.takes - a.takes || b.credits - a.credits).slice(0, top);
}

/** `832 cr spent · 1,240 left · about 20 days at this pace` — only what is known. */
export function headlineLine(spent: number, balance: number | null, runwayDays: number | null, cr: (n: number) => string): string {
  const parts = [`${cr(spent)} spent`];
  if (balance != null) parts.push(`${cr(balance)} left`);
  if (runwayDays != null) parts.push(runwayDays > 365 ? "more than a year at this pace" : runwayDays === 0 ? "not a day at this pace" : `about ${runwayDays} day${runwayDays === 1 ? "" : "s"} at this pace`);
  return parts.join(" · ");
}

/** Where a project ends against its cap at the takes-per-shot so far; honest when it cannot say. */
export function burnLabel(b: { known: boolean; projected: number | null; cap: number | null }, cr: (n: number) => string): { text: string; over: boolean } {
  if (!b.known || b.projected == null || !(b.cap != null && b.cap > 0)) return { text: "not enough takes to say", over: false };
  const diff = b.projected - b.cap;
  return diff > 0 ? { text: `ends ${cr(diff)} over its cap`, over: true } : { text: `ends ${cr(-diff)} under`, over: false };
}

/** Credits by engine, the planner's thinking as its own bar, biggest first. */
export function engineRows(byModel: { model: string; kind: string; billedCredits: number }[], label: (id: string) => string): { name: string; credits: number; planning: boolean }[] {
  const acc = new Map<string, { name: string; credits: number; planning: boolean }>();
  for (const r of byModel) {
    const planning = r.kind === "text";
    const name = planning ? "Planning" : r.kind === "training" ? "Training" : label(r.model);
    const cur = acc.get(name) ?? { name, credits: 0, planning };
    cur.credits += r.billedCredits; acc.set(name, cur);
  }
  return [...acc.values()].filter((r) => r.credits > 0).sort((a, b) => b.credits - a.credits);
}

/** Sum rows under a name, biggest first. */
export function sumBy<T>(rows: T[], nameOf: (r: T) => string, creditsOf: (r: T) => number): { name: string; credits: number }[] {
  const acc = new Map<string, number>();
  for (const r of rows) acc.set(nameOf(r), (acc.get(nameOf(r)) ?? 0) + creditsOf(r));
  return [...acc.entries()].map(([name, credits]) => ({ name, credits })).filter((r) => r.credits > 0).sort((a, b) => b.credits - a.credits);
}
