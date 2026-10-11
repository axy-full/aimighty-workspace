/**
 * Settings › Credits & billing in the new interface (docs/redesign/inventory.md § 5.6; components/v12/settings/CreditsBilling.tsx),
 * as data. Each part reads a route that already serves it, and these turn the route's real answer into rows: no figure is
 * typed here, and nothing here prices, charges or tops up.
 *
 *  - GET /api/billing: the plan (paid, else the admin's label), the subscription and its cycles.
 *  - GET /api/usage?rows=1&month=…: the month's ledger, newest first, with its totals.
 *  - GET /api/usage/boards?month=…: what each board settled this month.
 *  - GET /api/workspaces/topups: the packs Top up asks for, and the credits that came in.
 *
 * Pure: no React, no fetch.
 */
import type { CreditLedgerRow } from "@/lib/usageLedgerTerms";
import type { TopupGrant } from "@/lib/shell/workspace-view";

export type BillingCycle = { id?: string; startsAt: number; endsAt: number; credits: number };
export type BillingPlanNow = { id: string; label: string; includedCredits: number } | null;

/** The cycle running at `now`, or null (Invite, no subscription, or a plan the admin labelled without payment). */
export function cycleNow(cycles: readonly BillingCycle[] | null | undefined, now: number): BillingCycle | null {
  return (cycles ?? []).find((c) => c.startsAt <= now && now < c.endsAt) ?? null;
}

const dayMonth = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "1 Oct – 1 Nov": a cycle's dates (UTC, as the ledger counts them). */
export const cycleDates = (cycle: Pick<BillingCycle, "startsAt" | "endsAt">): string => `${dayMonth(cycle.startsAt)} – ${dayMonth(cycle.endsAt)}`;

/** "Today", "Yesterday" or "3 Oct", by the viewer's own calendar day. */
export function whenWords(at: number, now: number): string {
  const day = (t: number) => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const KIND: Record<string, string> = { video: "Video", image: "Still", audio: "Audio", text: "Writing" };
const kindWord = (kind: string) => KIND[kind] ?? (kind ? kind[0].toUpperCase() + kind.slice(1) : "Job");

/**
 * One History row: when, what, and the credits as signed figures. `credits` is what went out (negative), came in
 * (positive), or is held by a running job (`held`). The screen words the figure; this only decides it.
 */
export type HistoryRow = { id: string; at: number; when: string; what: string; credits: number; held: boolean };

/**
 * History, newest first: the month's ledger (what each job charged, or holds while it runs) and the credits that came in
 * (top-ups, the welcome grant). A job that cost nothing has no row: History is money in and out.
 */
export function historyRows(ledger: readonly CreditLedgerRow[] | null | undefined, grants: readonly TopupGrant[] | null | undefined, now: number, limit = 8): HistoryRow[] {
  const out: HistoryRow[] = [];
  for (const r of ledger ?? []) {
    if (!(typeof r.credits === "number" && Number.isFinite(r.credits) && r.credits > 0)) continue;
    const held = r.state === "held" || r.state === "running";
    if (!held && r.state !== "charged" && r.state !== "failed-charged") continue;
    const what = [kindWord(r.kind), r.engine, r.state === "failed-charged" ? "failed" : null].filter(Boolean).join(" · ");
    out.push({ id: `job:${r.id}`, at: r.at, when: whenWords(r.at, now), what, credits: held ? r.credits : -r.credits, held });
  }
  for (const g of grants ?? []) {
    if (!(typeof g.credits === "number" && Number.isFinite(g.credits) && g.credits !== 0)) continue;
    out.push({ id: `grant:${g.id}`, at: g.createdAt, when: whenWords(g.createdAt, now), what: g.note.trim() || (g.credits > 0 ? "Credits added" : "Credits removed"), credits: g.credits, held: false });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** "−10 cr", "+500 cr" or "20 cr held", from a figure the screen formats with lib/price.ts fmtCredits. */
export function signedCredits(row: Pick<HistoryRow, "credits" | "held">, fmt: (n: number) => string): string {
  if (row.held) return `${fmt(row.credits)} held`;
  return `${row.credits < 0 ? "−" : "+"}${fmt(Math.abs(row.credits))}`;
}

/** GET /api/usage/boards: a board's month. */
export type BoardMonth = { id: string | null; name: string; n: number; credits: number };
export function boardRows(body: unknown): BoardMonth[] | null {
  const b = body as { unit?: unknown; boards?: unknown } | null;
  if (!b || b.unit !== "credits" || !Array.isArray(b.boards)) return null;
  return b.boards.filter((r): r is BoardMonth => Boolean(r) && typeof (r as BoardMonth).name === "string" && Number.isFinite((r as BoardMonth).credits))
    .map((r) => ({ id: typeof r.id === "string" ? r.id : null, name: r.name, n: Number(r.n) || 0, credits: r.credits }));
}

/** "3 takes" under a board's name. */
export const takesWords = (n: number): string => `${n} ${n === 1 ? "take" : "takes"}`;

/** The plan as GET /api/billing gives it (null: none, or an older server without the field). */
export function planNowOf(body: unknown): BillingPlanNow {
  const p = (body as { plan?: unknown } | null)?.plan as Partial<NonNullable<BillingPlanNow>> | null | undefined;
  if (!p || typeof p.id !== "string") return null;
  return { id: p.id, label: typeof p.label === "string" && p.label ? p.label : p.id, includedCredits: Number.isFinite(p.includedCredits) ? Number(p.includedCredits) : 0 };
}

/** How many hero takes `credits` buy at a hero take's quoted price, rounded down; null without a usable price. */
export function heroTakes(credits: number, perTake: number | null | undefined): number | null {
  if (!(typeof perTake === "number" && Number.isFinite(perTake) && perTake > 0)) return null;
  return Math.floor(credits / perTake);
}
