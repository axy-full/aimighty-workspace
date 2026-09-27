/**
 * Who runs the connected Higgsfield account in this workspace, and whether it
 * answers (idea 19). The owner alone connects it and spends through it — every
 * /api/higgsfield/consumer route is owner-only — so a member meets one calm
 * card naming who runs it, with the way to make the same kind of thing on this
 * workspace's credits, never a connect prompt they cannot act on. Pure: the
 * capability, the one read per scope every surface shares, and the member's
 * words.
 */

import type { Plan, Runnable } from "../workspace/plan-types";

export type CapabilityStatus = "member" | "loading" | "ready" | "error";
export type ConnectedCapability = {
  /** This person owns the workspace: the server-rendered session says so, nothing is read. */
  owner: boolean;
  /** `member`: nothing to read; `loading`: the first read; `error`: the first read failed. */
  status: CapabilityStatus;
  /** The owner's account is connected and needs nothing before it runs. */
  connected: boolean;
  /** The owner must reconnect it before anything runs. */
  reconnect: boolean;
  error: string | null;
  /** Who runs it, by display name, when this person is a member and the session names the owner. */
  ownerName: string | null;
};
/** What the connection route (and the routes that carry a `connection`) answers. */
export type ConnectionReply = { connected?: unknown; requiresReconnect?: unknown } | null | undefined;

export const CONNECTION_ENDPOINT = "/api/higgsfield/consumer/connection";
export const CAPABILITY_UNREADABLE = "The connected account could not be read.";
/** How long one answer serves every surface before the next surface to open reads it again, behind it. */
export const CAPABILITY_FRESH_MS = 60_000;

export function connectionFrom(reply: ConnectionReply): { connected: boolean; reconnect: boolean } {
  const reconnect = reply?.requiresReconnect === true;
  return { connected: reply?.connected === true && !reconnect, reconnect };
}

/** One scope's answer, as the store keeps it. */
export type CapabilityEntry = { status: "loading" | "ready" | "error"; connected: boolean; reconnect: boolean; error: string | null; at: number };

export function capabilityOf(owner: boolean, entry: CapabilityEntry | undefined, ownerName: string | null = null): ConnectedCapability {
  if (!owner) return { owner: false, status: "member", connected: false, reconnect: false, error: null, ownerName: ownerName?.trim() || null };
  if (!entry) return { owner: true, status: "loading", connected: false, reconnect: false, error: null, ownerName: null };
  return { owner: true, status: entry.status, connected: entry.connected, reconnect: entry.reconnect, error: entry.error, ownerName: null };
}

/**
 * The shared answers, one per scope (a workspace and a person): at most one
 * read in flight per scope, an answer younger than CAPABILITY_FRESH_MS reused,
 * an older one kept on screen while it is read again, and a surface that got
 * the connection in its own reply shares it. A failed first read is an error
 * to retry, never a demotion to member. A member is never read — the hook
 * does not ask.
 *
 * Connecting, reconnecting or disconnecting busts the scope (`bust`): its
 * answer is dropped, so the next surface reads afresh, and every answer that
 * was already on its way — the store's own read, or a surface's reply that
 * set out before the change (`mark` says when it set out) — is dropped when
 * it lands rather than putting the old connection back.
 */
export function createCapabilityStore(read: (scope: string) => Promise<ConnectionReply>, clock: () => number = Date.now) {
  const entries = new Map<string, CapabilityEntry>();
  const inflight = new Map<string, { job: Promise<void>; epoch: number }>();
  const epochs = new Map<string, number>();
  const listeners = new Set<() => void>();
  const epochOf = (scope: string) => epochs.get(scope) ?? 0;
  const put = (scope: string, entry: CapabilityEntry) => { entries.set(scope, entry); listeners.forEach((listener) => listener()); };
  return {
    get: (scope: string): CapabilityEntry | undefined => entries.get(scope),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Where the scope stands now: a surface takes it before its own read and hands it to `settle`. */
    mark: (scope: string): number => epochOf(scope),
    ensure(scope: string, force = false): Promise<void> {
      const epoch = epochOf(scope);
      const running = inflight.get(scope);
      if (running && running.epoch === epoch) return running.job;
      const have = entries.get(scope);
      if (!force && have?.status === "ready" && clock() - have.at < CAPABILITY_FRESH_MS) return Promise.resolve();
      /* Only a first read (or a retry after a failed one) shows as loading; an answer on screen stays there. */
      if (!have || have.status === "error") put(scope, { status: "loading", connected: false, reconnect: false, error: null, at: 0 });
      /* The read starts on the next tick, so the job is registered before anything it does can finish. */
      const job: Promise<void> = Promise.resolve()
        .then(() => read(scope))
        .then(
          (reply) => { if (epochOf(scope) === epoch && inflight.get(scope)?.job === job) put(scope, { status: "ready", ...connectionFrom(reply), error: null, at: clock() }); },
          (error: unknown) => {
            if (epochOf(scope) !== epoch || inflight.get(scope)?.job !== job) return;
            put(scope, { status: "error", connected: false, reconnect: false, error: error instanceof Error && error.message ? error.message : CAPABILITY_UNREADABLE, at: clock() });
          },
        )
        .finally(() => { if (inflight.get(scope)?.job === job) inflight.delete(scope); });
      inflight.set(scope, { job, epoch });
      return job;
    },
    /** A reply that carried the connection; dropped when the scope was busted after `since` (a `mark`). */
    settle(scope: string, reply: ConnectionReply, since?: number) {
      if (since !== undefined && since !== epochOf(scope)) return false;
      // This answer supersedes any earlier connection read still in flight.
      inflight.delete(scope);
      put(scope, { status: "ready", ...connectionFrom(reply), error: null, at: clock() });
      return true;
    },
    /** The account was connected, reconnected or disconnected: nothing read before now is the answer any more. */
    bust(scope: string) {
      epochs.set(scope, epochOf(scope) + 1);
      inflight.delete(scope);
      if (entries.delete(scope)) listeners.forEach((listener) => listener());
    },
  };
}
export type CapabilityStore = ReturnType<typeof createCapabilityStore>;

/* ── What a member meets ─────────────────────────────────────────────── */

/** The provider whose account the owner connects. The owner's Suites design names it (the naming rule is retired). */
export const CONNECTED_PROVIDER = "Higgsfield";

/** The surfaces that run only on the owner's account. */
export type OwnerRunSurface = "business" | "viral" | "cast" | "workflows";
/** The same kind of thing on this workspace's credits: Gen, on Studio engines, opened on one output. */
export type OwnerRunAlternative = { type: "image" | "video"; what: string; action: string };
export type OwnerRun = {
  /** Which tools here are the owner's. */
  eyebrow: string;
  /** What runs on the owner's account, in one short sentence. */
  line: string;
  /** Null where no Studio engine makes the same kind of thing. */
  alternative: OwnerRunAlternative | null;
};
export const OWNER_RUNS: Record<OwnerRunSurface, OwnerRun> = {
  business: {
    eyebrow: "Business · Marketing Studio",
    line: "Ads and image ads render on their connected account.",
    alternative: { type: "image", what: "Product stills in Gen, on Studio engines", action: "Open Gen · Images" },
  },
  viral: {
    eyebrow: "Viral · Genjutsu",
    line: "Motion Transfer and Object Swap render on their connected account.",
    alternative: { type: "video", what: "Video takes in Gen, on Studio engines", action: "Open Gen · Video" },
  },
  cast: {
    eyebrow: "Cast · Soul Cinema and Soul ID",
    line: "Characters, elements and identities build on their connected account.",
    alternative: { type: "image", what: "Reference stills in Gen, on Studio image engines", action: "Open Gen · Images" },
  },
  workflows: {
    eyebrow: "Connected workflows",
    line: "These run on their connected account.",
    alternative: null,
  },
};
/** Said above the alternative: the member's own way, paid in this workspace's credits. */
export const ALTERNATIVE_LABEL = "On this workspace’s credits";

/** Who runs the account, in words: the owner by name when the session names them. */
export function ownerRunBy(ownerName: string | null | undefined): string {
  return ownerName?.trim() || "the workspace owner";
}
/** The card's title: "Higgsfield-account tools are run by" the owner, by name. */
export function ownerRunTitle(ownerName: string | null | undefined): string {
  return `${CONNECTED_PROVIDER}-account tools are run by ${ownerRunBy(ownerName)}`;
}
/** The workflows card names its tools in the eyebrow ("Dub · Change voice"). */
export function ownerRunEyebrow(surface: OwnerRunSurface, tools: readonly string[] = []): string {
  return surface === "workflows" && tools.length ? tools.join(" · ") : OWNER_RUNS[surface].eyebrow;
}

/**
 * The alternative's price, as the model sheet states it (lib/workspace/model-picker
 * › rowPrice): the engine, then the whole credits, then the settings it is at.
 * Null when there is no figure — never a guess.
 */
export function alternativePrice(label: string, price: { credits: number | null; unit: string; detail: string } | null): string | null {
  if (!price || price.credits == null) return null;
  return [label, `${price.credits.toLocaleString("en-US")} ${price.unit}`, price.detail || null].filter(Boolean).join(" · ");
}

/** The badge a member sees on the suites the owner runs, and what it stands for where it is only a mark. */
export const OWNER_BADGE = "Owner";
export function ownerBadgeNote(ownerName: string | null | undefined): string {
  return `Run by ${ownerRunBy(ownerName)} on the ${CONNECTED_PROVIDER} account`;
}
/** The shell's suites that run only on the owner's account, and the state layer's suites behind them. */
export const OWNER_RUN_SUITES: readonly string[] = ["business", "viral"];
export const OWNER_RUN_LEGACY_SUITES: readonly string[] = ["moleculr", "subatomik"];
export const isOwnerRunSuite = (suite: string | null | undefined): boolean => Boolean(suite && OWNER_RUN_SUITES.includes(suite));

/** The connected account's routes: whatever calls one spends through the owner's account. */
export const CONNECTED_ROUTE_PREFIX = "/api/higgsfield/consumer/";
/** An Atomik plan with any step on the connected account is the owner's to run (Viral's Motion, Swap and History, say). */
export function runsOnOwnerAccount(plan: { steps: readonly { executor: { backend: { path: string } } }[] } | null | undefined): boolean {
  return Boolean(plan?.steps.some((step) => step.executor.backend.path.startsWith(CONNECTED_ROUTE_PREFIX)));
}

/** The run engine applies the same role boundary as its panel, including keyboard and legacy entry points. */
export function ownerAccountPlans(plans: Record<string, Plan>, owner: boolean, ownerName: string | null): Record<string, Plan> {
  if (owner) return plans;
  return Object.fromEntries(Object.entries(plans).map(([page, plan]) => [page,
    runsOnOwnerAccount(plan) ? { ...plan, runnable: (): Runnable => ({ ok: false, reason: ownerBadgeNote(ownerName) }) } : plan,
  ]));
}

/** A cast entry's words for a reference still: its prompt, else its description, else its name. */
export function castStillPrompt(entry: { name: string; description: string; prompt: string }): string {
  return entry.prompt.trim() || entry.description.trim() || entry.name.trim();
}
