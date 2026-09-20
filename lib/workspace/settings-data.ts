/**
 * Settings on the phone (05-mobile "Settings (M10)", the repo's board M10) —
 * the mapping, as pure data, plus the one hook that reads it.
 *
 * Everything on this screen comes from a route the product already has:
 * `/api/me` for the balance and the credit unit, `/api/usage` for the month's
 * own figure, `/api/workspaces/topups` for the real credit packs,
 * `/api/settings` and `/api/limits` for the workspace rows, and `/api/team`
 * for the roster. Nothing is invented: a figure no route can supply is left
 * out of the screen rather than written down here, and a route that refuses
 * (the team roster is an admin's to read) removes its section instead of
 * showing an empty one.
 *
 * Top-up and Invite link into the flows that already own them — the billing
 * page's credit packs and the team page — rather than a second implementation
 * of either.
 */

/* ── What the routes give ─────────────────────────────────────────────── */

/** `/api/me`, as this screen reads it. */
export type MeRead = {
  name?: string | null;
  email?: string | null;
  role?: string | null;
  owner?: boolean;
  workspace?: { id: string; name: string; slug?: string } | null;
  /** lib/creditTerms CreditState. Null on a workspace billed outside credits. */
  credits?: { creditUsd: number; granted: number; used: number; balance: number } | null;
  models?: { video?: string | null; image?: string | null } | null;
};

/** `/api/settings`. */
export type SettingsRead = {
  settings?: Record<string, string>;
  models?: { video?: string | null; image?: string | null };
};

/** `/api/limits`. */
export type LimitsRead = {
  limits?: { concurrency?: number; rendersPerHour?: number; storageBytes?: number };
  standing?: { usedBytes?: number };
};

/** `/api/usage`, credits path. */
export type UsageRead = { byMonth?: { month: string; credits: number }[] };

/** `/api/workspaces/topups`. */
export type TopupsRead = {
  applies?: boolean;
  canRequest?: boolean;
  packs?: { id: string; label: string; credits: number; bonus: number; total: number; usd: number }[];
};

/** `/api/team`. */
export type TeamRead = {
  canSeeRoles?: boolean;
  users?: { id: string; email: string; name?: string | null; role?: string | null; standing?: string | null; disabled?: boolean }[];
};

/* ── The credits card ─────────────────────────────────────────────────── */

const n = (value: number) => value.toLocaleString("en-US");

export type CreditsCard = {
  /** "1,240 CR". */
  balance: string;
  /** "$124.00", from the workspace's own credit unit. Null when it has none. */
  usd: string | null;
  /** "612 CR this month", only when the usage feed actually carries this month. */
  month: string | null;
};

/** The current month as `/api/usage` groups it: `YYYY-MM`, in local time. */
export function monthKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** This month's credits, or null when the feed has no row for it. */
export function monthToDate(usage: UsageRead | null, now: number): number | null {
  const key = monthKey(now);
  const row = (usage?.byMonth ?? []).find((item) => item.month === key);
  return row && Number.isFinite(row.credits) ? row.credits : null;
}

export function creditsCard(me: MeRead | null, usage: UsageRead | null, now: number): CreditsCard | null {
  const credits = me?.credits;
  if (!credits || !Number.isFinite(credits.balance)) return null;
  const unit = Number.isFinite(credits.creditUsd) ? credits.creditUsd : null;
  const month = monthToDate(usage, now);
  return {
    balance: `${n(credits.balance)} CR`,
    usd: unit === null ? null : `$${(credits.balance * unit).toFixed(2)}`,
    month: month === null ? null : `${n(month)} CR this month`,
  };
}

/**
 * `Top up · 500 CR · $50` from the smallest real pack the workspace is
 * offered, and the existing flow it opens. Null when credits do not apply to
 * this workspace or no pack is offered.
 */
export function topupAction(topups: TopupsRead | null): { label: string; href: string } | null {
  if (!topups || topups.applies === false) return null;
  const pack = (topups.packs ?? []).slice().sort((a, b) => a.usd - b.usd)[0];
  if (!pack) return null;
  return {
    label: `Top up · ${n(pack.credits)} CR · $${pack.usd % 1 === 0 ? pack.usd : pack.usd.toFixed(2)}`,
    href: "/billing#credit-packs",
  };
}

/* ── The workspace rows ───────────────────────────────────────────────── */

export type SettingsRow = {
  label: string;
  value: string;
  /** The word on the right ("admin", "change", "on"), when there is one. */
  action: string | null;
  /** Where the row goes on the desktop; the phone links rather than re-editing. */
  href: string | null;
};

function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  const gb = value / 1024 ** 3;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  const mb = value / 1024 ** 2;
  return `${Math.round(mb)} MB`;
}

const APPROVAL_VALUE: Record<string, string> = {
  anyone: "Anyone in the workspace can render",
  cap: "A cap per shot, then an admin presses",
  producer: "A producer approves every render",
};

/**
 * The rows, from whatever the routes could supply. A row whose value is not
 * readable is dropped: the design's five rows are a maximum, not a promise.
 */
export function workspaceRows(input: {
  me: MeRead | null;
  settings: SettingsRead | null;
  limits: LimitsRead | null;
  /** Neutral display name for a model id (lib/models displayModelName). */
  modelName: (id: string) => string;
}): SettingsRow[] {
  const rows: SettingsRow[] = [];
  const workspace = input.me?.workspace;
  if (workspace?.name)
    rows.push({ label: "Workspace", value: workspace.name, action: input.me?.owner ? "owner" : input.me?.role ?? null, href: "/settings" });

  const video = input.settings?.models?.video ?? input.me?.models?.video ?? "";
  if (video) rows.push({ label: "Default video engine", value: input.modelName(video), action: "change", href: "/settings#defaults" });
  const image = input.settings?.models?.image ?? input.me?.models?.image ?? "";
  if (image) rows.push({ label: "Default still engine", value: input.modelName(image), action: "change", href: "/settings#defaults" });

  const rule = input.settings?.settings?.approvalRule;
  if (rule && APPROVAL_VALUE[rule])
    rows.push({ label: "Cost approval", value: APPROVAL_VALUE[rule], action: "change", href: "/settings#defaults" });

  const cap = Number(input.settings?.settings?.shotCapCredits ?? "");
  if (Number.isFinite(cap) && cap > 0)
    rows.push({ label: "Shot cap", value: `${n(cap)} CR per shot`, action: "change", href: "/settings#defaults" });

  const perHour = input.limits?.limits?.rendersPerHour;
  if (typeof perHour === "number" && perHour > 0)
    rows.push({ label: "Request ceiling", value: `${n(perHour)} renders per hour`, action: null, href: null });

  const quota = input.limits?.limits?.storageBytes;
  const used = input.limits?.standing?.usedBytes;
  if (typeof quota === "number" && quota > 0)
    rows.push({
      label: "Storage",
      value: typeof used === "number" ? `${bytes(used)} of ${bytes(quota)}` : bytes(quota),
      action: null,
      href: "/settings#storage",
    });
  return rows;
}

/* ── The team rows ────────────────────────────────────────────────────── */

export type TeamRow = { id: string; initials: string; name: string; role: string | null };

/** Up to two letters. An address contributes its local part, not its domain. */
function initials(name: string): string {
  const words = name.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length === 1 ? words[0].slice(0, 2) : words.slice(0, 2).map((word) => word[0]).join("");
  return letters.toUpperCase() || "?";
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/**
 * The roster. Roles only where the route returned them (`canSeeRoles`), so a
 * member never sees a role the API deliberately withheld.
 */
export function teamRows(team: TeamRead | null): TeamRow[] {
  return (team?.users ?? []).map((user) => {
    const name = (user.name ?? "").trim() || user.email;
    const raw = (user.standing ?? user.role ?? "").toLowerCase();
    return {
      id: user.id,
      initials: initials(name),
      name,
      role: team?.canSeeRoles && raw ? ROLE_LABEL[raw] ?? raw : null,
    };
  });
}

/* ── The three Atomik rules ───────────────────────────────────────────── */

/**
 * The product's three standing promises about the agent (05-mobile M10 and
 * the repo's own board M10). These are copy, not data: they describe how the
 * run engine behaves — every paid step is quoted and gated, a plan is only
 * ever proposed, and the four irreversible things never happen on their own.
 */
export const ATOMIK_RULES: readonly { label: string; sub: string }[] = [
  { label: "EVERY PAID STEP", sub: "Quoted at the live price and approved before anything is dispatched." },
  { label: "PROPOSE ONLY", sub: "Atomik plans the stage; you decide which of its steps runs." },
  { label: "NEVER WITHOUT YOU", sub: "Spend · unlock · delete · approve. Four things that always wait for you." },
];
