/**
 * Workspace view (components/graphite/WorkspaceView.tsx), as data: each tab
 * reads a route that already serves it, and these turn the route's REAL
 * response into what the tab draws. Pure, so each shape is pinned by a test
 * against the route's own types rather than a mock that drifted from them.
 */

/* ── Plans & credits ─────────────────────────────────────────────────── */

/** GET /api/statements with no month: `{ months: statementMonths() }` (lib/statements.ts). */
export type StatementMonth = { month: string; takes: number };
export function statementMonthsOf(body: unknown): StatementMonth[] {
  const months = (body as { months?: unknown } | null)?.months;
  if (!Array.isArray(months)) return [];
  return months.flatMap((m) => {
    const month = (m as { month?: unknown } | null)?.month;
    return typeof month === "string" && /^\d{4}-\d{2}$/.test(month) ? [{ month, takes: Number((m as { takes?: unknown }).takes) || 0 }] : [];
  });
}
/** The printable statement for a month (app/(app)/statements/[month]), not the JSON behind it. */
export const statementHref = (month: string) => `/statements/${encodeURIComponent(month)}`;
export const statementCsvHref = (month: string) => `/api/statements?month=${encodeURIComponent(month)}&format=csv`;

/** GET /api/billing: `subscription` is lib/billingLedger.ts's BillingSubscription, `plans` the platform's PlanDefs. */
export type BillingPlan = { id: string; label?: string };
export type BillingSubscription = { planId?: string; status?: string; interval?: string; currentPeriodEnd?: number; cancelAtPeriodEnd?: boolean };
export function planLine(plans: readonly BillingPlan[] | undefined, subscription: BillingSubscription | null | undefined): string {
  if (!subscription?.planId) return "No plan on record";
  const plan = plans?.find((p) => p.id === subscription.planId);
  /* Stored as the provider sent it: seconds or milliseconds (components/commercial/BillingClient.tsx reads it the same way). */
  const at = subscription.currentPeriodEnd ? (subscription.currentPeriodEnd < 10_000_000_000 ? subscription.currentPeriodEnd * 1000 : subscription.currentPeriodEnd) : 0;
  const end = at ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
  return [
    `${plan?.label ?? subscription.planId} plan`,
    subscription.status ?? null,
    end ? `${subscription.cancelAtPeriodEnd ? "ends" : "renews"} ${end}` : null,
  ].filter(Boolean).join(" · ");
}

/** GET /api/workspaces/topups (lib/packs.ts Pack, lib/topups.ts TopupRequest, lib/platform.ts listGrants). */
export type TopupPack = { id: string; label: string; credits: number; bonus: number; total: number; usd: number };
export type TopupRequestRow = { id: string; label: string; credits: number; bonus: number; usd: number; status: string; createdAt?: number; decidedAt?: number | null };
export type TopupGrant = { id: string; credits: number; note: string; createdAt: number };
export type Topups = { applies: boolean; provider: string; canRequest: boolean; openLimit?: number; packs: TopupPack[]; requests: TopupRequestRow[]; history?: TopupGrant[] };
/** A pack as the SOW writes it on the top-up screen: `2,200 cr · $200 · 200 free`. The price is the one dollar figure on the page. */
export function packLine(pack: TopupPack): string {
  return [`${pack.total.toLocaleString("en-US")} cr`, `$${pack.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`, pack.bonus > 0 ? `${pack.bonus.toLocaleString("en-US")} free` : null].filter(Boolean).join(" · ");
}
/** The button that asks for a pack says what lands in the balance: bought and free together. */
export const packRequestLabel = (pack: Pick<TopupPack, "total">) => `Request ${pack.total.toLocaleString("en-US")} credits`;

const day = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null);
/**
 * A request as its row reads: what was asked for, and where it stands. A
 * withdrawn request is kept (lib/topups.ts cancelTopup marks it; nothing is
 * erased), so it says "withdrawn" rather than vanishing.
 */
export function requestLine(r: TopupRequestRow): string {
  const what = `${r.label} · ${(r.credits + r.bonus).toLocaleString("en-US")} cr`;
  if (r.status === "requested") return `${what} · waiting on the platform${day(r.createdAt) ? ` since ${day(r.createdAt)}` : ""}`;
  const word = r.status === "approved" ? "added" : r.status === "declined" ? "declined" : r.status === "cancelled" ? "withdrawn" : r.status;
  return [what, `${word}${day(r.decidedAt) ? ` ${day(r.decidedAt)}` : ""}`].join(" · ");
}
/** Open requests first (they carry Withdraw), then the last few answered. */
export function requestRows(requests: readonly TopupRequestRow[] | undefined, answered = 3): TopupRequestRow[] {
  const all = requests ?? [];
  return [...all.filter((r) => r.status === "requested"), ...all.filter((r) => r.status !== "requested").slice(0, answered)];
}
/** A grant as the history lists it: `+2,000 cr` (or `−50 cr`, an adjustment) beside what it was and when. */
export function grantRow(g: TopupGrant): { amount: string; what: string; when: string } {
  const amount = `${g.credits >= 0 ? "+" : "−"}${Math.abs(g.credits).toLocaleString("en-US")} cr`;
  return { amount, what: g.note.trim() || (g.credits >= 0 ? "Credits added" : "Credits removed"), when: day(g.createdAt) ?? "" };
}
/** Where a card checkout may send the browser: https only, never a scheme that runs code. */
export function checkoutUrl(raw: unknown, origin: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw, origin);
    return url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

/* ── Usage ───────────────────────────────────────────────────────────── */

/**
 * GET /api/usage answers in one of two shapes. A workspace on credits gets
 * lib/creditUsage.ts: `unit: "credits"`, `spentCredits` and `byModel`
 * (model, label, provider, kind, n, credits) — one row per model, engine and
 * kind, so the same model can appear twice. The studio's own workspace gets
 * the vendor ledger: `vendors[].models` in dollars.
 */
export type UsageBody = {
  unit?: string; spentCredits?: number;
  byModel?: { model: string; label?: string; provider?: string; kind?: string; n?: number; credits?: number }[];
  vendors?: { id: string; label: string; models?: { model: string; label?: string; n?: number; spend?: number }[] }[];
};
export type UsageRow = { id: string; label: string; n: number; amount: number };
export function usageRows(body: UsageBody | null): { unit: "cr" | "$"; rows: UsageRow[]; total: number } {
  if (!body) return { unit: "cr", rows: [], total: 0 };
  if (body.unit === "credits") {
    const models = body.byModel ?? [];
    const labelOf = (m: (typeof models)[number]) => m.label ?? m.model;
    /* A model billed under two engines or kinds is two rows; the second word tells them apart. */
    const twin = (m: (typeof models)[number]) => models.filter((o) => o !== m && labelOf(o) === labelOf(m));
    const rows = models.map((m) => {
      const same = twin(m);
      const extra = !same.length ? "" : same.every((o) => o.kind !== m.kind) ? m.kind : m.provider;
      return { id: [m.model, m.provider ?? "", m.kind ?? ""].join("/"), label: extra ? `${labelOf(m)} · ${extra}` : labelOf(m), n: m.n ?? 0, amount: m.credits ?? 0 };
    });
    return { unit: "cr", rows, total: body.spentCredits ?? rows.reduce((n, r) => n + r.amount, 0) };
  }
  const rows = (body.vendors ?? []).flatMap((v) => (v.models ?? []).map((m) => ({ id: `${v.id}/${m.model}`, label: `${m.label ?? m.model} · ${v.label}`, n: m.n ?? 0, amount: m.spend ?? 0 })));
  return { unit: "$", rows, total: rows.reduce((n, r) => n + r.amount, 0) };
}

/* ── Engines ─────────────────────────────────────────────────────────── */

/** Legacy mode values are accepted for cached clients, but no workspace edits vendor keys. */
export type KeyMode = "legacy" | "platform" | "own";
export function keyStatus(_mode: KeyMode | undefined, set: boolean): { label: string; canConnect: boolean } {
  return { label: set ? "Available" : "Unavailable", canConnect: false };
}

/** The connected account's sign-in address, accepted only when it is the account's own authorize page. */
export function consumerAuthorizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.origin === "https://clerk.higgsfield.ai" && url.pathname === "/oauth/authorize" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
/** What the callback's `?higgsfield=` code means (lib/higgsfield-consumer/oauth.ts consumerCallbackLocation). */
export function connectionOutcome(code: string | null): { ok: boolean; line: string } | null {
  if (!code) return null;
  if (code === "connected") return { ok: true, line: "Account connected." };
  if (code === "authorization_denied") return { ok: false, line: "Authorization was not approved." };
  if (code === "configuration") return { ok: false, line: "The account connection is not configured on this deployment." };
  if (code === "account_pinned") return { ok: false, line: "Sign in with the same account: this connection runs website tools for every workspace." };
  return { ok: false, line: "The connection was not completed. Connect again from this workspace." };
}

/* ── Security ────────────────────────────────────────────────────────── */

/** GET /api/account/security: lib/accountSecurity.ts readAccountSecurity. */
export type SecurityBody = {
  enabled?: boolean;
  requiredWorkspaces?: { id: string; name: string }[];
  recoveryCodesRemaining?: number;
  sessions?: { id: string; current?: boolean; label?: string; createdAt?: number; expiresAt?: number }[];
};
export function twoStepLine(body: SecurityBody | null): string | null {
  if (!body || typeof body.enabled !== "boolean") return null;
  const required = body.requiredWorkspaces?.length ?? 0;
  return [body.enabled ? "On" : "Off", required ? `required by ${required === 1 ? "a workspace" : `${required} workspaces`}` : null].filter(Boolean).join(" · ");
}
export function sessionRows(body: SecurityBody | null): { id: string; label: string; since: number | null }[] {
  return (body?.sessions ?? []).map((s) => ({ id: s.id, label: s.current ? "This browser" : s.label || "Browser session", since: s.createdAt ?? null }));
}

/** GET /api/workspaces/audit (admins): lib/securityAudit.ts SecurityEvent. */
export type AuditEvent = { id: string; action: string; createdAt: number };
export function auditEntries(body: unknown, labels: Record<string, string>, limit = 5): { id: string; label: string; at: number }[] {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return [];
  return (events as AuditEvent[]).filter((e) => e && typeof e.action === "string").slice(0, limit)
    .map((e) => ({ id: e.id, label: labels[e.action] ?? e.action, at: Number(e.createdAt) }));
}
