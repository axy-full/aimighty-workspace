/**
 * Who runs the connected Higgsfield account in this workspace, and whether it
 * answers (idea 19). The owner alone connects it and spends through it — every
 * /api/higgsfield/consumer route is owner-only — so a member meets one calm
 * card naming who runs it, with the way to make the same kind of thing on this
 * workspace's credits, never a connect prompt they cannot act on. Pure: the
 * capability, the one read per scope every surface shares, and the member's
 * words.
 */

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
 */
export function createCapabilityStore(read: (scope: string) => Promise<ConnectionReply>, clock: () => number = Date.now) {
  const entries = new Map<string, CapabilityEntry>();
  const inflight = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const put = (scope: string, entry: CapabilityEntry) => { entries.set(scope, entry); listeners.forEach((listener) => listener()); };
  return {
    get: (scope: string): CapabilityEntry | undefined => entries.get(scope),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensure(scope: string, force = false): Promise<void> {
      const running = inflight.get(scope);
      if (running) return running;
      const have = entries.get(scope);
      if (!force && have?.status === "ready" && clock() - have.at < CAPABILITY_FRESH_MS) return Promise.resolve();
      /* Only a first read (or a retry after a failed one) shows as loading; an answer on screen stays there. */
      if (!have || have.status === "error") put(scope, { status: "loading", connected: false, reconnect: false, error: null, at: 0 });
      /* The read starts on the next tick, so the job is registered before anything it does can finish. */
      const job: Promise<void> = Promise.resolve()
        .then(() => read(scope))
        .then(
          (reply) => put(scope, { status: "ready", ...connectionFrom(reply), error: null, at: clock() }),
          (error: unknown) => {
            /* A read again that fails keeps the answer on screen; only a first read that fails is the error. */
            if (entries.get(scope)?.status === "ready") return;
            put(scope, { status: "error", connected: false, reconnect: false, error: error instanceof Error && error.message ? error.message : CAPABILITY_UNREADABLE, at: clock() });
          },
        )
        .finally(() => { if (inflight.get(scope) === job) inflight.delete(scope); });
      inflight.set(scope, job);
      return job;
    },
    settle(scope: string, reply: ConnectionReply) {
      put(scope, { status: "ready", ...connectionFrom(reply), error: null, at: clock() });
    },
  };
}
export type CapabilityStore = ReturnType<typeof createCapabilityStore>;

/* ── What a member meets ─────────────────────────────────────────────── */

/** The surfaces that run only on the owner's account, and where a member makes the same kind of thing instead. */
export type OwnerRunSurface = "business" | "viral" | "cast";
export type OwnerRun = {
  /** What the owner runs: the title's subject, and whether it reads as one thing or several. */
  subject: string; plural: boolean;
  /** The same kind of thing on this workspace's credits, in one sentence. */
  line: string;
  action: string;
  /** The output Gen opens on. */
  type: "image" | "video";
};
export const OWNER_RUN_EYEBROW = "Higgsfield account";
export const OWNER_RUNS: Record<OwnerRunSurface, OwnerRun> = {
  business: { subject: "Business", plural: false, line: "Make product stills and ads in Gen with Studio engines, on this workspace’s credits.", action: "Open Gen · Images", type: "image" },
  viral: { subject: "Viral", plural: false, line: "Make video takes in Gen with Studio engines, on this workspace’s credits.", action: "Open Gen · Video", type: "video" },
  cast: { subject: "Soul Cinema and Soul ID", plural: true, line: "Make reference stills in Gen with Studio image engines, on this workspace’s credits, then add one to an entry.", action: "Open Gen · Images", type: "image" },
};

/** Who runs the account, in words: the owner by name when the session names them. */
export function ownerRunBy(ownerName: string | null | undefined): string {
  return ownerName?.trim() || "the workspace owner";
}
/** The card’s title: “Business is run by” the owner, by name. */
export function ownerRunTitle(surface: OwnerRunSurface, ownerName: string | null | undefined): string {
  const run = OWNER_RUNS[surface];
  return `${run.subject} ${run.plural ? "are" : "is"} run by ${ownerRunBy(ownerName)}`;
}

/** The badge a member sees on the suites the owner runs, and what it stands for where it is only a mark. */
export const OWNER_BADGE = "Owner";
export function ownerBadgeNote(ownerName: string | null | undefined): string {
  return `Run by ${ownerRunBy(ownerName)} on the Higgsfield account`;
}
/** The shell's suites that run only on the owner's account. */
export const OWNER_RUN_SUITES: readonly string[] = ["business", "viral"];
export const isOwnerRunSuite = (suite: string | null | undefined): boolean => Boolean(suite && OWNER_RUN_SUITES.includes(suite));

/** The connected account's routes: whatever calls one spends through the owner's account. */
export const CONNECTED_ROUTE_PREFIX = "/api/higgsfield/consumer/";
/** An Atomik plan with any step on the connected account is the owner's to run (Viral's Motion, Swap and History, say). */
export function runsOnOwnerAccount(plan: { steps: readonly { executor: { backend: { path: string } } }[] } | null | undefined): boolean {
  return Boolean(plan?.steps.some((step) => step.executor.backend.path.startsWith(CONNECTED_ROUTE_PREFIX)));
}

/** A cast entry's words for a reference still: its prompt, else its description, else its name. */
export function castStillPrompt(entry: { name: string; description: string; prompt: string }): string {
  return entry.prompt.trim() || entry.description.trim() || entry.name.trim();
}
