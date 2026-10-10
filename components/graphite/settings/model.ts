/**
 * Settings as data: each section reads a route that already serves it (the same routes Workspace's
 * tabs read), and these turn the route's real response into the rows the section draws. Pure, so the
 * unit specs hold every line to the code's truth rather than the design's samples.
 */
import type { BillingPlan, BillingSubscription, TopupPack } from "@/lib/shell/workspace-view";
import { creditsText, creditsUsd } from "@/lib/shell/price-words";
import { creditRateLine } from "@/lib/creditTerms";
import { scopeWords, tokenFacts, PARTICL_REACH, type ApiToken, type TokenUnit } from "@/lib/shell/tools-connections";

/* ── Team ───────────────────────────────────────────────────────────── */

/** GET /api/team (owner and admins): lib/team.ts listTeam. */
export type Member = { id: string; email: string; name: string; role?: string; standing?: string; permanent?: boolean; disabled: boolean; locked: boolean; lastSeen: number | null; clips: number; /** An authenticator is on for their account (GET /api/team). */ twoStep?: boolean };
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
  return [m.email, twoFactorWords(m), `last seen ${day(m.lastSeen) ?? "never"}`, m.disabled ? "disabled" : null, m.locked ? "locked" : null].filter(Boolean).join(" · ");
}
/** "two-factor on" or "two-factor off", as the account has it; nothing when the route did not say. */
export function twoFactorWords(m: Pick<Member, "twoStep">): string | null {
  return m.twoStep === true ? "two-factor on" : m.twoStep === false ? "two-factor off" : null;
}

/* ── Roles (Team security, Gaps B; owner correction 7) ─────────────── */

/** The code's three roles and only these: no other role, and no limit set per role. What each may do, as the routes allow it. */
export const ROLES = [
  { id: "owner", name: "Owner", line: "Everything, including billing, keys, roles and the sign-in rule" },
  { id: "admin", name: "Admin", line: "The team, spending rules and approvals over the per-shot cap" },
  { id: "member", name: "Member", line: "Makes and reviews; a shot over the cap waits for an admin" },
] as const;
export type RoleId = (typeof ROLES)[number]["id"];
/** How many people hold each role, from the owner's roster (null when the viewer may not see roles). */
export function roleCounts(team: Team | null): Record<RoleId, number> | null {
  if (!team?.canSeeRoles) return null;
  const counts: Record<RoleId, number> = { owner: 0, admin: 0, member: 0 };
  for (const u of team.users) if (!u.disabled) counts[roleOf(u) as RoleId] = (counts[roleOf(u) as RoleId] ?? 0) + 1;
  return counts;
}
export function inviteLine(i: Invite): string {
  return [i.email, "invited", `expires ${day(i.expiresAt) ?? "—"}`].filter(Boolean).join(" · ");
}
export function peopleMeta(team: Team | null): string {
  if (!team) return "";
  const n = team.users.filter((u) => !u.disabled).length;
  const waiting = team.invites.length;
  return [`${n} on this workspace`, waiting ? `${waiting} invited` : null].filter(Boolean).join(" · ");
}

/** GET /api/workspaces/security (the owner's only): lib/accountSecurity.ts readWorkspaceSecurity. */
export type WorkspacePolicy = { requiresMfa?: boolean; ownerEnrolled?: boolean; members?: number; unenrolled?: number };
export type TwoStepRule = { value: string; line: string; action: "turn-on" | "turn-off" | "enrol-first" | null };

/**
 * The workspace's two-step rule, as Settings › Team draws it. The owner reads the policy route and may change it; the
 * server lets only an owner who has two-step on change it, so until then the owner is sent to set theirs up first.
 * Anyone else reads it off their own account (GET /api/account/security lists the workspaces that require it) and
 * cannot change it.
 */
export function workspaceTwoStep(input: {
  owner: boolean;
  workspaceId: string | null;
  policy: WorkspacePolicy | null;
  policyFailed: boolean;
  required: readonly { id: string }[] | null | undefined;
}): TwoStepRule {
  if (!input.owner) {
    const value = input.required == null ? "Reading…" : input.required.some((w) => w.id === input.workspaceId) ? "on" : "off";
    return { value, line: "Set by the workspace owner", action: null };
  }
  const p = input.policy;
  const line = p?.unenrolled ? `${p.unenrolled} of ${p.members ?? "—"} people have not set it up` : "Everyone signs in with two steps when it is on";
  if (!p || typeof p.requiresMfa !== "boolean") return { value: input.policyFailed ? "—" : "Reading…", line, action: null };
  return { value: p.requiresMfa ? "on" : "off", line, action: !p.ownerEnrolled ? "enrol-first" : p.requiresMfa ? "turn-off" : "turn-on" };
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

/* ── Connections ────────────────────────────────────────────────────── */


/** Where a post could go once Particl posts for a workspace. Listed as not connected, with no Connect (DECISIONS 3). */
export const PUBLISHING_ACCOUNTS: readonly string[] = Object.freeze(["Instagram", "TikTok", "YouTube"]);

/** The value a token row shows: what it may do. */
export const tokenValue = (t: Pick<ApiToken, "scope">): string => (t.scope === "read" ? "read" : t.scope === "prepare" ? "prepare" : "generate");

const agoWords = (at: number, now: number): string => {
  const m = Math.floor(Math.max(0, now - at) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};
/**
 * The facts under a token's name. A workspace billed in credits reads "Can generate · 120 of 500 cr this month · used 2h ago".
 * A workspace on its own engines is billed in its vendors' dollars, which Settings never shows (DECISIONS 6): it reads what the
 * token may do and when it was last used.
 */
export function tokenLine(t: ApiToken, unit: TokenUnit, now = Date.now()): string {
  if (unit === "credits") return tokenFacts(t, unit, now);
  return [scopeWords(t.scope), t.scope === "prepare" ? "a person approves each" : null, t.lastUsed ? `used ${agoWords(t.lastUsed, now)}` : "never used"].filter(Boolean).join(" · ");
}

/* ── Advanced › Tools ───────────────────────────────────────────────── */

/**
 * What Atomik reaches, in the design's words, each with where it opens (README § 3.5, § 7). Every id of
 * `PARTICL_REACH` has a place here; a unit test fails when it gains one this map does not know. "Astra" is Topaz's
 * model name only: the 3D tool reads "3D blocking".
 */
export type ReachPlace =
  | { to: "atomik" }
  | { to: "settings"; section: "advanced" | "connections"; open?: "models" | "mcp" }
  | { to: "make" }
  | { to: "suite"; suite: "studio"; page: "edit" | "astra" };
export const REACH_PLACES: Readonly<Record<string, { label: string; line?: string; action: string; place: ReachPlace }>> = Object.freeze({
  plan: { label: "Plan & price", action: "Open", place: { to: "atomik" } },
  thinking: { label: "Thinking models", action: "Open", place: { to: "settings", section: "advanced", open: "models" } },
  engines: { label: "Particl engines", action: "Open", place: { to: "make" } },
  sound: { label: "Voice, sound & music", action: "Open", place: { to: "suite", suite: "studio", page: "edit" } },
  astra: { label: "3D blocking", line: "Block a scene in 3D before anything renders", action: "Open", place: { to: "suite", suite: "studio", page: "astra" } },
  assistant: { label: "Your own assistant", action: "Open", place: { to: "settings", section: "connections" } },
});
export function reachRows(): { id: string; label: string; line: string; action: string; place: ReachPlace }[] {
  return PARTICL_REACH.flatMap((row) => {
    const at = REACH_PLACES[row.id];
    return at ? [{ id: row.id, label: at.label, line: at.line ?? row.line, action: at.action, place: at.place }] : [];
  });
}
