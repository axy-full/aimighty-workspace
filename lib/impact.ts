import { db, ready } from "./db";
import { currentTenant } from "./tenant";
import { dependentsOf, type Dependent } from "./elements";
import { plannedTakeUsd } from "./shotBudgetCost";
import { DEFAULT_MODEL_ID, getModel } from "./models";
import { ENGINE_MODEL, type ShotEngine } from "./shotBuilder";
import { renderKeyNameFor, paidByPlatform, allowanceUsd, platformSpendThisMonth } from "./allowance";
import { getSetting } from "./settings";
import { effectiveModels } from "./defaultModels";
import { creditsApply, creditState } from "./credits";
import { projectCapSpent, spentBy } from "./caps";
import { cleanRule, cleanShotCap } from "./approvalRule";
import { shotCreditsSoFar } from "./shotCap";
import { quoteOf, verdictOf, liveTerms, stampOf, type Quote, type Unit, type Verdict, type Context, type Cap } from "./quote";

/**
 * What changing something costs, before it is changed (brief 3, surface 1b).
 *
 * Rule five of the design: nothing re-renders silently, and any edit to a
 * shared element opens this first. So this answers one question — which shots
 * does this reach, and what would each of them cost — and answers it in the
 * only unit a workspace has, whole credits, with the verdict that says whether
 * the button may be pressed at all.
 *
 * Tenant-scoped throughout: every read is db(), which is the workspace in
 * scope and throws when there is none.
 */

export type ImpactShot = {
  shotId: string;
  code: string;
  title: string;
  projectId: string | null;
  /** Whether this shot already has an approved take, which is what a swap costs. */
  approved: boolean;
  /** Whether it is pinned to the version being changed rather than following. */
  pinned: boolean;
  credits: number;
};

export type ChoiceKey = "all" | "approved" | "none";

export type Choice = {
  key: ChoiceKey;
  label: string;
  shots: number;
  quote: Quote;
  verdict: Verdict;
  consequence: string;
};

export type Impact = {
  elementId: string;
  attributeId: string;
  versionId: string;
  shots: ImpactShot[];
  approved: number;
  draft: number;
  choices: Choice[];
  /** Which choice is offered first: the one that changes least that still moves. */
  defaultKey: ChoiceKey;
  pricedAt: number;
  stamp: string;
};

/**
 * The shots a version change reaches, each with its own price.
 *
 * Each shot is priced from its OWN planned length and engine. The design's
 * copy reads as one rate times a count, and for a production of identical
 * five-second shots it comes out that way; for a real one it does not, and a
 * multiplication would underprice the long shots and overprice the short.
 */
export async function impactOf(
  elementId: string, attributeId: string, versionId: string,
  opts: { projectId?: string | null; at: number; isAdmin?: boolean; following?: boolean },
): Promise<Impact> {
  await ready();

  const dependents = await dependentsOf(elementId, attributeId, versionId,
    { projectId: opts.projectId, following: opts.following });
  const described = dependents.length ? await describe(dependents) : [];

  const terms = liveTerms();
  /* Every production the change actually reaches, not the one that was asked
     about. Without a production named, a shared element spans the workspace
     and each production it lands in has a cap of its own. */
  const context = await contextFor(described.map((d) => d.shot.projectId), { isAdmin: opts.isAdmin === true });

  const unitOf = (d: Described): Unit => ({
    key: d.shot.shotId, usd: d.usd, engine: d.engine,
    spent: d.spent, code: d.shot.code, projectId: d.shot.projectId,
    platformPays: d.platformPays,
  });
  const priced = (list: Described[]) => {
    const q = quoteOf(list.map(unitOf), terms);
    return { q, v: verdictOf(q, context) };
  };

  /* Each shot carries its own price, so the panel can show a row without
     asking again and a producer can see which shot is the expensive one. */
  const perShot = quoteOf(described.map(unitOf), terms);
  const all = described.map((d, i) => ({ ...d.shot, credits: perShot.lines[i]?.credits ?? 0 }));
  const approvedOnly = described.filter((d) => d.shot.approved);

  const everything = priced(described);
  const justApproved = priced(approvedOnly);
  const nothing = priced([]);

  const approved = approvedOnly.length;
  const draft = all.length - approved;

  const choices: Choice[] = [
    {
      key: "all", label: `Re-render all ${all.length}`, shots: all.length,
      quote: everything.q, verdict: everything.v,
      consequence: approved
        ? `The ${approved} approved take${approved === 1 ? "" : "s"} return to draft for re-approval.`
        : "Every shot using this is rendered again.",
    },
    {
      key: "approved", label: `Re-render approved only`, shots: approved,
      quote: justApproved.q, verdict: justApproved.v,
      consequence: draft
        ? `The ${draft} draft${draft === 1 ? "" : "s"} keep the old version until you render them.`
        : "Only the approved takes are made again.",
    },
    {
      key: "none", label: "Leave existing takes", shots: 0,
      quote: nothing.q, verdict: nothing.v,
      consequence: "Nothing already made changes; only new renders use it.",
    },
  ];

  return {
    elementId, attributeId, versionId,
    shots: all,
    approved, draft,
    choices,
    /* The design defaults to re-rendering the approved takes: the ones a
       client has seen are the ones that must not drift, and the drafts will
       pick the new version up the next time they run anyway. With nothing
       approved there is nothing to hold to, so leaving them alone is the
       honest default rather than spending on every draft. */
    defaultKey: approved ? "approved" : "none",
    pricedAt: opts.at,
    stamp: stampOf(described.map(unitOf), terms),
  };
}

type Described = {
  shot: ImpactShot;
  usd: number;
  /** The MODEL id this is priced at — never the shot's short engine alias. */
  engine: string;
  /** What this shot has already taken, for the per-shot approval rule. */
  spent: number;
  /** Whether the platform's money pays for this engine's vendor. */
  platformPays: boolean;
};

/**
 * The model a shot would really render on.
 *
 * `shots.engine` holds a short name the shot builder writes — "seedance",
 * "kling", "nano-banana" — and not a model id. Handing that straight to the
 * estimator returns nothing, and nothing becomes zero: every shot the
 * breakdown authored would have quoted at no credits at all, and a quote of
 * nothing passes every wall there is. The mapping already existed one file
 * over; this is that mapping and not a second copy of it.
 */
function modelOf(engine: string | null | undefined, fallback: string): string {
  const raw = String(engine ?? "").trim();
  if (!raw) return fallback;
  const mapped = ENGINE_MODEL[raw as ShotEngine];
  if (mapped) return mapped;
  /* A real model id is kept; anything else is a name nothing can price, and
     falling back is the only answer that does not quote a fiction. */
  try { getModel(raw); return raw; } catch { return fallback; }
}

/** Fill in each dependent shot: what it is called, what it costs, whether it is approved. */
async function describe(dependents: Dependent[]): Promise<Described[]> {
  const ids = dependents.map((d) => d.shotId);
  const holes = ids.map(() => "?").join(",");

  const [rows, approvals, spends, models] = await Promise.all([
    db().execute({
      /* `kind` matters: a type-only shot is a title card the product never
         renders and never bills, so pricing one would put credits on a button
         that could not spend them. */
      sql: `SELECT id, project_id, code, title, planned, engine, kind FROM shots WHERE id IN (${holes})`,
      args: ids,
    }),
    db().execute({
      sql: `SELECT DISTINCT shot_id FROM generations
            WHERE shot_id IN (${holes}) AND review_state = 'approved' AND deleted = 0`,
      args: ids,
    }),
    /* What each shot has already taken, in one pass rather than one per shot.
       The per-shot approval rule is about this running total, and the press
       and the reservation gate read exactly the same figure before they
       decide — hidden takes included, because they were paid for. */
    spentBy("shot_id", ids),
    /* The engine a shot would actually run on when it does not name one:
       this workspace's own default, falling back to the platform's. The same
       resolution the composer opens with, so the quote and the press agree. */
    effectiveModels().catch(() => null),
  ]);

  const isApproved = new Set(approvals.rows.map((r) => String((r as unknown as { shot_id: string }).shot_id)));
  const fallback = models?.video || DEFAULT_MODEL_ID;

  const byId = new Map<string, Described>();
  for (const row of rows.rows) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r = row as any;
    if (String(r.kind ?? "render") === "type") continue;
    const model = modelOf(r.engine, fallback);
    const usd = plannedTakeUsd(r.planned == null ? null : Number(r.planned), model);
    const d = dependents.find((x) => x.shotId === String(r.id))!;
    let platformPays = true;
    try { platformPays = paidByPlatform(renderKeyNameFor(getModel(model).provider)); } catch { platformPays = true; }
    byId.set(String(r.id), {
      usd, engine: model, platformPays,
      spent: spends.get(String(r.id))?.credits ?? 0,
      shot: {
        shotId: String(r.id), code: String(r.code ?? ""), title: String(r.title ?? ""),
        projectId: r.project_id ?? null,
        approved: isApproved.has(String(r.id)),
        pinned: d.pinned,
        credits: 0,
      },
    });
  }

  /* Keep the order the reverse lookup returned, and drop anything whose shot
     row has gone between the two reads rather than pricing a hole. */
  const out: Described[] = [];
  for (const d of dependents) {
    const found = byId.get(d.shotId);
    if (found) out.push(found);
  }
  return out;
}

/**
 * Everything the verdict needs about this workspace and the productions the
 * change touches.
 *
 * Every production reached gets its own cap read, because a change that spans
 * two of them is two questions. Answering with one cap is how a set is quoted
 * as allowed and then refused halfway through.
 */
export async function contextFor(projectIds: (string | null)[], opts: { isAdmin: boolean }): Promise<Context> {
  const inCredits = creditsApply(currentTenant()?.workspace);
  const wanted = [...new Set(projectIds.filter((p): p is string => Boolean(p)))];

  const [state, rule, shotCap, warn, atCap, allowanceSpent, capRows] = await Promise.all([
    inCredits ? creditState() : Promise.resolve(null),
    getSetting("approvalRule"),
    getSetting("shotCapCredits"),
    getSetting("capWarnPct"),
    getSetting("atCap"),
    allowanceUsd() == null ? Promise.resolve(0) : platformSpendThisMonth(),
    Promise.all(wanted.map(async (id) => [id, await projectCapSpent(id)] as const)),
  ]);

  const atCapRule = atCap === "stop" || atCap === "warn" ? atCap : "producer";
  const caps: Record<string, Cap> = {};
  for (const [id, pc] of capRows) {
    if (!pc) continue;
    caps[id] = { cap: pc.cap, unit: pc.unit, spent: pc.spent, rule: atCapRule, unlocked: pc.unlocked };
  }

  const ceiling = allowanceUsd();
  return {
    balance: state ? state.balance : null,
    allowance: ceiling == null ? null : { cap: ceiling, spent: allowanceSpent },
    caps,
    warnPct: Number(warn) || 80,
    rule: cleanRule(rule),
    shotCap: cleanShotCap(shotCap),
    isAdmin: opts.isAdmin,
  };
}

/** What one shot has already taken, for a quote that is about that shot alone. */
export async function shotSpent(shotId: string): Promise<number> {
  return shotCreditsSoFar(shotId);
}

/**
 * What re-rendering these exact shots would cost, and whether it is allowed
 * (brief 3, surface 2c).
 *
 * The impact panel asks "which shots does this version reach" and prices the
 * answer. A shot's own bindings reach one shot, and it is already named, so
 * there is nothing to look up — but the price and the verdict have to be the
 * same ones, computed by the same functions against the same context, or the
 * surface that changes one slot would quote differently from the surface that
 * changes the library and a producer would be right not to trust either.
 */
export async function quoteShots(
  shotIds: string[], opts: { at: number; isAdmin?: boolean },
): Promise<{ quote: Quote; verdict: Verdict; shots: ImpactShot[]; pricedAt: number; stamp: string }> {
  await ready();
  const wanted = [...new Set(shotIds.filter(Boolean))];
  const terms = liveTerms();

  /* Priced as if nothing is pinned: the question is what this shot costs to
     render, which does not depend on how it came to be bound. */
  const described = wanted.length
    ? await describe(wanted.map((shotId) => ({ shotId, projectId: null, slots: [], pinned: false })))
    : [];

  const context = await contextFor(described.map((d) => d.shot.projectId), { isAdmin: opts.isAdmin === true });
  const units: Unit[] = described.map((d) => ({
    key: d.shot.shotId, usd: d.usd, engine: d.engine,
    spent: d.spent, code: d.shot.code, projectId: d.shot.projectId,
    platformPays: d.platformPays,
  }));

  const quote = quoteOf(units, terms);
  return {
    quote,
    verdict: verdictOf(quote, context),
    shots: described.map((d, i) => ({ ...d.shot, credits: quote.lines[i]?.credits ?? 0 })),
    pricedAt: opts.at,
    stamp: stampOf(units, terms),
  };
}
