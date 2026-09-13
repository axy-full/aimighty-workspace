import { billCreditsWith, marginFor, creditUsd, tableFor } from "./creditTerms";
import { capVerdict, type CapRule, type CapUnit } from "./caps";
import { shotCapVerdict, ruleLine, type ApprovalRule } from "./approvalRule";
import { heldMessage } from "./held";

/**
 * The quote engine (brief 3): what a thing costs, resolved before the button
 * that spends it is enabled.
 *
 * The first rule of the design is that the price is on the action, and the
 * second half of that sentence is the part with teeth: quote BEFORE you
 * enable. A number arrived at after the press is a receipt, not a price.
 *
 * Two things make a quote, and both matter:
 *
 *   the number   what the work costs, in whole credits
 *   the verdict  whether this person, in this production, may press it
 *
 * A number without a verdict is how a producer gets a priced button that
 * fails at the gate, and a verdict without a number is how they get a gate
 * with nothing to weigh. They are returned together, always.
 *
 * Everything here is pure. The rows are read in lib/impact.ts, the money is
 * charged by the meter, and nothing in this file touches the database or the
 * clock. That is deliberate: the browser prices a button with the same
 * function the server gates with, so the price on the button is the price
 * that is charged, or the button was lying.
 */

/* ── The number ─────────────────────────────────────────────────────────── */

export type Unit = {
  /** What this unit is, for the caller to line up against its own list. */
  key: string;
  /** Vendor cost of one job, in dollars, from the engine's own estimator. */
  usd: number;
  /** The margin key, and the model id it is priced at. Never an alias. */
  engine: string;
  /**
   * How many of this identical job.
   *
   * A batch multiplies before it rounds, because four variations of one
   * prompt are one press. Separate shots do not: each is its own job and
   * rounds on its own, which is why fourteen shots at twenty-nine credits
   * is four hundred and six and never something a fraction under.
   */
  count?: number;
  /**
   * What the shot this job belongs to has already taken, and what it is
   * called. The per-shot rule is written about one shot's running total, so
   * judging a set without them is judging a different rule.
   */
  spent?: number;
  code?: string;
  /** Whose cap this counts against. Different shots can answer differently. */
  projectId?: string | null;
  /**
   * Whether the platform's money pays for this engine's vendor.
   *
   * A workspace that brought its own key for a vendor is not charged credits
   * for it and is not measured against the platform's allowance. Quoting it
   * against a credit balance would put a top-up prompt in front of work that
   * costs no credits at all.
   */
  platformPays?: boolean;
};

/**
 * One priced job, carrying what the verdict needs to judge it on its own.
 *
 * The gates are per-job, not per-total: a shot's own running total decides the
 * approval rule, its own production decides the cap, and only the jobs the
 * platform pays for touch the balance. Rolling those up before judging is how
 * a quote starts disagreeing with the press.
 */
export type QuoteLine = {
  key: string;
  credits: number;
  count: number;
  usd: number;
  spent: number;
  code: string;
  projectId: string | null;
  platformPays: boolean;
};

export type Quote = {
  /** Whole credits, the only number a workspace ever sees. */
  totalCredits: number;
  /** The per-unit price, and only when every unit really is the same price. */
  unitCredits: number | null;
  /** How many jobs this covers. */
  units: number;
  /** Vendor cost. Platform-side; never shown to a workspace. */
  usd: number;
  lines: QuoteLine[];
};

export const EMPTY_QUOTE: Quote = { totalCredits: 0, unitCredits: null, units: 0, usd: 0, lines: [] };

export type Terms = { perCredit: number; table: Record<string, number> };

/**
 * The terms in force, read from the environment once — or, for a workspace
 * flagged internal (§7A guardrail 6), every engine at cost. The flag is an
 * argument, not a lookup: this file stays pure so the browser prices with it.
 */
export const liveTerms = (internal = false): Terms => ({ perCredit: creditUsd(), table: tableFor(internal) });

/**
 * Price a set of jobs.
 *
 * `unitCredits` is filled in only when every line came out the same, which is
 * what lets a panel say "re-render all 14 · 406 cr" honestly. Shots differ in
 * length and engine, so the moment they do the total is a sum and the caller
 * has nothing to multiply — the design's own copy implies a flat rate, and a
 * flat rate is exactly the thing that would quietly misprice a real
 * production.
 */
export function quoteOf(units: Unit[], terms: Terms = liveTerms()): Quote {
  const lines: QuoteLine[] = [];
  let totalCredits = 0;
  let usd = 0;
  let count = 0;

  for (const u of units) {
    const n = Number.isInteger(u.count) && (u.count as number) > 0 ? (u.count as number) : 1;
    const credits = billCreditsWith(u.usd * n, marginFor(u.engine, terms.table), terms.perCredit);
    lines.push({
      key: u.key, credits, count: n, usd: u.usd * n,
      spent: Number.isFinite(u.spent) ? Number(u.spent) : 0,
      code: u.code ?? "",
      projectId: u.projectId ?? null,
      /* Default true: the platform's keys are the common case, and a quote
         that forgot to say so should over-state the balance it needs rather
         than quietly skip the wall. */
      platformPays: u.platformPays !== false,
    });
    totalCredits += credits;
    usd += u.usd * n;
    count += n;
  }

  const per = lines.length ? lines[0].credits / lines[0].count : 0;
  const uniform = lines.length > 0 && lines.every((l) => l.credits === per * l.count);

  return {
    totalCredits,
    unitCredits: uniform ? per : null,
    units: count,
    usd,
    lines,
  };
}

/* ── The verdict ────────────────────────────────────────────────────────
   Not an approximation of the press: the same walls, in the same order, with
   the same arguments. The order below is app/api/generate/route.ts's own —

     the approval rule      refuses, 403
     the monthly allowance  refuses, 429
     the production's cap   refuses, 409
     the credit balance     does NOT refuse; the take is parked as held

   That last one is the one worth spelling out. Running out of credits stopped
   being a refusal when holding was built: the work is written down, queued and
   released on a top-up, and nothing is lost. A quote that called it a refusal
   would be telling a producer they cannot do something the product would in
   fact accept. */

/** Which wall this ran into, in the order the render path checks them. */
export type Gate = "ok" | "approval" | "allowance" | "cap" | "held";

export type Verdict = {
  /** Whether the press would be accepted at all. Held work is accepted. */
  allow: boolean;
  gate: Gate;
  /** The sentence under the button. Empty when there is nothing to say. */
  line: string;
  /** Something true and worth knowing that does not stop the press. */
  notice: string;
};

/** One production's cap, in that production's own unit. */
export type Cap = {
  cap: number | null;
  unit: CapUnit;
  spent: number;
  rule: CapRule;
  unlocked: boolean;
};

export type Context = {
  /** Whole credits left, or null where a workspace does not pay in credits. */
  balance: number | null;
  /** The monthly ceiling on the platform's engines, in dollars, or null. */
  allowance: { cap: number; spent: number } | null;
  /** The cap of each production the quote touches, keyed by its id. */
  caps: Record<string, Cap>;
  warnPct: number;
  /** The workspace's approval rule, the ceiling it uses, and who is asking. */
  rule: ApprovalRule;
  shotCap: number;
  isAdmin: boolean;
};

const fmt = (n: number): string => `${Math.round(n).toLocaleString("en-US")} cr`;
const usdFmt = (n: number): string => `$${n.toFixed(2)}`;

export function verdictOf(q: Quote, c: Context): Verdict {
  /* A choice that spends nothing is never gated. Leaving existing takes alone
     is the option a producer reaches for precisely when the production is out
     of room, and a cap it does not spend against must not be what stops it. */
  if (q.totalCredits === 0) return { allow: true, gate: "ok", line: "", notice: "" };

  /* The approval rule, judged one shot at a time against that shot's own
     running total — which is what the rule says and what the press does.
     Judging the set on its sum would stop a member under a rule the workspace
     never set; judging it with no history at all would wave through the second
     take of a shot already at its ceiling. */
  if (c.rule === "cap" && !c.isAdmin) {
    for (const l of q.lines) {
      const stop = shotCapVerdict({
        rule: c.rule, isAdmin: c.isAdmin, cap: c.shotCap,
        shotCredits: l.spent, takeCredits: l.credits, code: l.code || "This shot",
      }, fmt);
      if (stop.blocked) return { allow: false, gate: "approval", line: stop.line, notice: "" };
    }
  }

  /* The workspace's monthly ceiling on the platform's engines. Only the jobs
     the platform actually pays for count against it. */
  if (c.allowance) {
    const needs = q.lines.reduce((n, l) => n + (l.platformPays ? l.usd : 0), 0);
    const { cap, spent } = c.allowance;
    if (spent >= cap || spent + needs > cap) {
      return {
        allow: false, gate: "allowance", notice: "",
        line: `This workspace has used ${usdFmt(spent)} of its ${usdFmt(cap)} monthly cap on the platform's engines. An admin can add a vendor key or raise it.`,
      };
    }
  }

  /* Each production's own cap, against only the part of this quote that lands
     in it. A change that reaches two productions is two questions, and
     answering it with one cap would let a run through that the press refuses
     halfway. */
  let notice = "";
  const byProject = new Map<string, number>();
  for (const l of q.lines) {
    const key = l.projectId ?? "";
    byProject.set(key, (byProject.get(key) ?? 0) + (c.caps[key]?.unit === "$" ? l.usd : l.credits));
  }
  for (const [key, needs] of byProject) {
    const cap = c.caps[key];
    if (!cap) continue;
    const v = capVerdict({
      cap: cap.cap, spent: cap.spent, needs,
      rule: cap.rule, unlocked: cap.unlocked, warnPct: c.warnPct, unit: cap.unit,
    });
    if (!v.allow) return { allow: false, gate: "cap", line: v.error ?? "", notice: "" };
    if (v.notice && !notice) notice = v.notice;
  }

  /* Credits last, and never as a refusal. What the platform pays for is what
     the balance covers; a vendor the workspace holds its own key for costs it
     no credits and is not weighed here at all. */
  if (c.balance != null) {
    const needs = q.lines.reduce((n, l) => n + (l.platformPays ? l.credits : 0), 0);
    if (needs > 0 && c.balance < needs) {
      return {
        allow: true, gate: "held", notice,
        line: heldMessage(needs, c.balance),
      };
    }
  }

  return {
    allow: true, gate: "ok", notice,
    /* Nothing is in the way, so the only thing worth saying is the rule that
       would have applied, which is what 2.2 asks the composer to show. */
    line: ruleLine(c.rule, c.shotCap, fmt),
  };
}

/* ── Staleness ──────────────────────────────────────────────────────────── */

/**
 * A quote is only good for the moment it was taken.
 *
 * Prices move, a top-up lands, another member spends the balance this one was
 * counting on. The rule the whole layer rests on is that the price on the
 * button is the price charged, so a quote that has gone cold is re-taken
 * before anything is billed rather than honoured out of politeness.
 */
export const QUOTE_TTL_MS = 120_000;

export type Priced<T> = T & { pricedAt: number; stamp: string };

/** What the quote was computed from, so a changed input invalidates it. */
export function stampOf(units: Unit[], terms: Terms = liveTerms()): string {
  const parts = units.map((u) => [
    u.key, u.engine, u.usd.toFixed(6), u.count ?? 1,
    u.spent ?? 0, u.projectId ?? "", u.platformPays !== false ? 1 : 0,
  ].join(":"));
  /* The margin table is in here as well as the price of a credit. Both move
     the number, and a stamp that covered only one of them would call a quote
     fresh after the thing that changed it changed. */
  const table = Object.entries(terms.table).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(",");
  return `${terms.perCredit}|${table}|${parts.join("|")}`;
}

export function isStale(q: { pricedAt: number; stamp: string }, stampNow: string, at: number): boolean {
  if (q.stamp !== stampNow) return true;
  return at - q.pricedAt > QUOTE_TTL_MS;
}
