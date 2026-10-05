/**
 * Settings as data: each section reads a route that already serves it (the same routes Workspace's
 * tabs read), and these turn the route's real response into the rows the section draws. Pure, so the
 * unit specs hold every line to the code's truth rather than the design's samples.
 */
import type { BillingPlan, BillingSubscription, TopupPack } from "@/lib/shell/workspace-view";
import { creditsText, creditsUsd } from "@/lib/shell/price-words";
import { creditRateLine } from "@/lib/creditTerms";

/* ── Team ───────────────────────────────────────────────────────────── */

/** GET /api/team (owner and admins): lib/team.ts listTeam. */
export type Member = { id: string; email: string; name: string; role?: string; standing?: string; permanent?: boolean; disabled: boolean; locked: boolean; lastSeen: number | null; clips: number };
export type Invite = { code: string; email: string; name: string; role?: string; expiresAt: number; sendCount?: number };
export type Team = { canSeeRoles: boolean; mail?: { configured: boolean }; users: Member[]; invites: Invite[] };

const day = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null);

/** A person's role as the code names it: the owner, else their role on the workspace. Limits are by role, never by person. */
export function roleOf(m: Pick<Member, "role" | "standing">): string {
  return m.standing === "owner" ? "owner" : m.role ?? "member";
}
/** Whether the roster lets this row's role change: never the owner, never a permanent seat, and only on the owner's view. */
export function roleChangeable(m: Pick<Member, "role" | "standing" | "permanent">, canSeeRoles: boolean): boolean {
  return canSeeRoles && !m.permanent && m.standing !== "owner" && (m.role === "admin" || m.role === "member");
}
/** "jordan@example.test · last seen Oct 4 · locked": the email, when they were last seen, and what stops them. */
export function memberLine(m: Member): string {
  return [m.email, `last seen ${day(m.lastSeen) ?? "never"}`, m.disabled ? "disabled" : null, m.locked ? "locked" : null].filter(Boolean).join(" · ");
}
export function inviteLine(i: Invite): string {
  return [i.email, "invited", `expires ${day(i.expiresAt) ?? "—"}`].join(" · ");
}
export function peopleMeta(team: Team | null): string {
  if (!team) return "";
  const n = team.users.filter((u) => !u.disabled).length;
  const waiting = team.invites.length;
  return [`${n} on this workspace`, waiting ? `${waiting} invited` : null].filter(Boolean).join(" · ");
}

/* ── Plan & credits ─────────────────────────────────────────────────── */

/** What one credit costs, worded by the one helper that words it (lib/creditTerms.ts), from the server's rate; null while it is unknown. */
export const creditPriceLine = (creditUsd: number | null): string | null => creditRateLine(creditUsd);
/** A count of credits and its dollars at the server's rate ("2,000 cr", "$200.00"); the dollars null while the rate is unknown. */
export function creditsWithUsd(credits: number, creditUsd: number | null): { text: string; usd: string | null } {
  return { text: creditsText(credits), usd: creditsUsd(credits, creditUsd) };
}

/** The month the ledger files a job under (UTC, as lib/usageLedger.ts reads `created_at`). */
export const monthKey = (now: number) => new Date(now).toISOString().slice(0, 7);

/** GET /api/usage?rows=1&month=…: the month's ledger totals in credits (lib/usageLedger.ts creditTotals). */
export type MonthTotals = { jobs: number; charged: number; held: number; notBilled: number };
export function monthTotalsOf(body: unknown): MonthTotals | null {
  const b = body as { unit?: unknown; totals?: Partial<MonthTotals> } | null;
  if (!b || b.unit !== "credits" || !b.totals) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { jobs: n(b.totals.jobs), charged: n(b.totals.charged), held: n(b.totals.held), notBilled: n(b.totals.notBilled) };
}
/** "163 cr settled · 20 cr held": what the month charged, and what running jobs hold until they settle. */
export function monthLine(t: MonthTotals): string {
  return [`${creditsText(t.charged)} settled`, t.held > 0 ? `${creditsText(t.held)} held` : null].filter(Boolean).join(" · ");
}

/** The plan as Settings shows it: its name and price, what it includes, and when it renews. Only what the code holds. */
export type PlanDefLike = BillingPlan & { priceUsd?: number; includedCredits?: number };
export function planView(plans: readonly PlanDefLike[] | undefined, sub: BillingSubscription | null | undefined): {
  meta: string; included: number | null; renews: { word: "Renews" | "Ends"; date: string } | null; status: string | null;
} {
  if (!sub?.planId) return { meta: "No plan on record", included: null, renews: null, status: null };
  const plan = plans?.find((p) => p.id === sub.planId);
  const price = typeof plan?.priceUsd === "number" ? ` · $${plan.priceUsd.toLocaleString("en-US")} a month` : "";
  /* Stored as the provider sent it: seconds or milliseconds (lib/shell/workspace-view.ts planLine reads it the same way). */
  const at = sub.currentPeriodEnd ? (sub.currentPeriodEnd < 10_000_000_000 ? sub.currentPeriodEnd * 1000 : sub.currentPeriodEnd) : 0;
  const date = at ? new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;
  return {
    meta: `${plan?.label ?? sub.planId}${price}`,
    included: typeof plan?.includedCredits === "number" && plan.includedCredits > 0 ? plan.includedCredits : null,
    renews: date ? { word: sub.cancelAtPeriodEnd ? "Ends" : "Renews", date } : null,
    status: sub.status && sub.status !== "active" ? sub.status.replace(/_/g, " ") : null,
  };
}

/** "Top up · 500 cr · $50": the pack the button asks for, in what lands in the balance and its own price. */
export function topUpLabel(pack: Pick<TopupPack, "total" | "usd">): string {
  return `Top up · ${creditsText(pack.total)} · $${pack.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
/** The pack Top up asks for: the smallest the platform sells (lib/packs.ts lists them in order). */
export function topUpPack<P extends Pick<TopupPack, "usd">>(packs: readonly P[]): P | null {
  return packs.length ? [...packs].sort((a, b) => a.usd - b.usd)[0] : null;
}
