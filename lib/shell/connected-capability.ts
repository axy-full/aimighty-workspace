/**
 * The words of the retired Higgsfield sign-in (lib/higgsfield-consumer/retired.ts).
 * Nobody runs the connected account any more — the hook
 * (./use-connected-capability) answers "member" for everyone and reads
 * nothing — and the pages that ran there (Business, Viral and Cast, until
 * their API-key and Particl versions replace them) meet one calm card saying
 * so, with the way to make the same kind of thing on this workspace's credits.
 * Workspace › Engines keeps its Disconnect and Set aside. Pure: the answer's
 * shape and the card's words.
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

/** Workspace › Engines' retired row: the running jobs (Set aside) and Disconnect. */
export const CONNECTION_ENDPOINT = "/api/higgsfield/consumer/connection";
export const CAPABILITY_UNREADABLE = "The connected account could not be read.";

/* ── What everyone meets now ─────────────────────────────────────────── */

/* The Higgsfield sign-in is retired (lib/higgsfield-consumer/retired.ts), so the
   surfaces that ran on the connected account show one card to everyone, the
   workspace owner included: what ran there, that Particl no longer signs in to
   Higgsfield, and — where a Studio engine makes the same kind of thing — the
   way to make it on this workspace's credits. No owner name, no "run by". */

/** The provider whose account the owner connected. */
export const CONNECTED_PROVIDER = "Higgsfield";

/** The surfaces that ran only on the connected account. */
export type OwnerRunSurface = "business" | "viral" | "cast" | "workflows";
/** The same kind of thing on this workspace's credits: Gen, on Studio engines, opened on one output. */
export type OwnerRunAlternative = { type: "image" | "video"; what: string; action: string };
export type OwnerRun = {
  /** Which tools these were. */
  eyebrow: string;
  /** What ran on the connected account, in one short sentence. */
  line: string;
  /** Null where no Studio engine makes the same kind of thing. */
  alternative: OwnerRunAlternative | null;
};
export const OWNER_RUNS: Record<OwnerRunSurface, OwnerRun> = {
  business: {
    eyebrow: "Business · Marketing Studio",
    line: "Ads and image ads here ran on a signed-in Higgsfield account.",
    alternative: { type: "image", what: "Product stills in Gen, on Studio engines", action: "Open Gen · Images" },
  },
  viral: {
    eyebrow: "Viral · Genjutsu",
    line: "Motion Transfer and Object Swap here ran on a signed-in Higgsfield account.",
    alternative: { type: "video", what: "Video takes in Gen, on Studio engines", action: "Open Gen · Video" },
  },
  cast: {
    eyebrow: "Cast · Soul Cinema and Soul ID",
    line: "Soul builds, reference elements and identities here ran on a signed-in Higgsfield account.",
    alternative: { type: "image", what: "Reference stills in Gen, on Studio image engines", action: "Open Gen · Images" },
  },
  workflows: {
    eyebrow: "Connected workflows",
    line: "These ran on a signed-in Higgsfield account.",
    alternative: null,
  },
};
/** Said above the alternative: the way that works here, paid in this workspace's credits. */
export const ALTERNATIVE_LABEL = "On this workspace’s credits";

/** The card's title, and the reason an account plan cannot run: the one thing that changed. */
export const ACCOUNT_RETIRED = `Particl no longer signs in to ${CONNECTED_PROVIDER}`;
/** Under the card's line: nothing made there is lost. */
export const HISTORY_KEPT = "Past results stay in your Library.";
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

/** The shell's suites that ran only on the connected account: their page is the card, with no tabs and no stage to run. */
export const OWNER_RUN_SUITES: readonly string[] = ["business", "viral"];
export const isOwnerRunSuite = (suite: string | null | undefined): boolean => Boolean(suite && OWNER_RUN_SUITES.includes(suite));

/** A cast entry's words for a reference still: its prompt, else its description, else its name. */
export function castStillPrompt(entry: { name: string; description: string; prompt: string }): string {
  return entry.prompt.trim() || entry.description.trim() || entry.name.trim();
}
