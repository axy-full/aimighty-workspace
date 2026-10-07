/*
 * Social post states (Gaps B frames, "Ads and Social", posts): draft, waiting for approval, scheduled, posted, failed.
 * Pure: no React, no network. Nothing here posts anything.
 *
 * Posting itself is not in Particl yet (docs/particl-sow-2026-10-04.md § 5.1: Publishing is "later", a flag per platform, on only
 * after that platform's review; Settings › Connections lists the three accounts as not connected). This is the model the screen
 * is built on, so that when a publisher exists the screen, and the rule that governs it, are already here:
 *
 *   draft ──send for approval──▶ waiting ──approve (a PERSON)──▶ scheduled ──(the publisher)──▶ posted | failed
 *     ▲                                                              │                              │
 *     └───────────────────────── unschedule (a person) ◀─────────────┘     retry (a person) ◀──────┘
 *
 * Approving a post is people-only: Atomik (an `agent:` identity), an MCP client and every API token PREPARE posts (write a draft,
 * send it for approval) and never approve, schedule, unschedule or retry one. The publisher's own outcomes (posted, failed) are
 * recorded by the server side only (`settle`), never by a button.
 */

export type PostState = "draft" | "waiting" | "scheduled" | "posted" | "failed";
export type PostPlatform = "instagram" | "tiktok" | "youtube";
export const PLATFORM_NAME: Record<PostPlatform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

export type SocialPost = {
  id: string;
  platform: PostPlatform;
  /** "Reel", "Story", "Shorts": the format on that platform, as a person reads it. */
  format: string;
  /** "Clip 1 · 0:14". */
  clip: string;
  aspect: "9:16" | "1:1" | "16:9" | "4:5";
  state: PostState;
  /** When it is scheduled for (scheduled), or went out (posted), in ms. */
  at: number | null;
  /** Why it failed, and whether the account has to be reconnected first. Set only on a failed post. */
  failure: { reason: string; reconnect: boolean } | null;
  /** The person who approved it, once someone has. An agent's id is never recorded here. */
  approvedBy: string | null;
};

/** Who is acting. Only a `person` approves; the rest prepare. */
export type Actor = { kind: "person"; userId: string } | { kind: "agent"; runId: string } | { kind: "token"; tokenId?: string };
export const PEOPLE_ONLY_POST = "Only a signed-in person can approve a post. Atomik, an MCP client and API tokens can prepare it, never approve it.";

export class PostRefusal extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.name = "PostRefusal"; this.status = status; }
}

export const isPerson = (actor: Actor | null | undefined): actor is Extract<Actor, { kind: "person" }> =>
  !!actor && actor.kind === "person" && typeof actor.userId === "string" && actor.userId.length > 0 && !actor.userId.startsWith("agent:") && actor.userId !== "server";

function needPerson(actor: Actor | null | undefined): Extract<Actor, { kind: "person" }> {
  if (!isPerson(actor)) throw new PostRefusal(PEOPLE_ONLY_POST, 403);
  return actor;
}
function need(post: SocialPost, ...states: PostState[]) {
  if (!states.includes(post.state)) throw new PostRefusal(`This post is ${STATE_WORD[post.state].toLowerCase()}, so that can't be done now.`);
}

export const STATE_WORD: Record<PostState, string> = { draft: "Draft", waiting: "Waiting for approval", scheduled: "Scheduled", posted: "Posted", failed: "Failed" };

/** A draft: anyone may prepare one (a person, Atomik, a token). */
export function prepare(input: Pick<SocialPost, "id" | "platform" | "format" | "clip" | "aspect">): SocialPost {
  return { ...input, state: "draft", at: null, failure: null, approvedBy: null };
}
/** Sends a draft for a person's approval: preparing, so anyone may. */
export function sendForApproval(post: SocialPost): SocialPost {
  need(post, "draft");
  return { ...post, state: "waiting" };
}
/** Approves a post that waits, for a time. People only. */
export function approve(post: SocialPost, actor: Actor | null | undefined, at: number): SocialPost {
  const person = needPerson(actor);
  need(post, "waiting");
  if (!Number.isFinite(at)) throw new PostRefusal("Pick when it goes out.");
  return { ...post, state: "scheduled", at, approvedBy: person.userId, failure: null };
}
/** Takes a scheduled post back to a draft: its approval goes with it. People only. */
export function unschedule(post: SocialPost, actor: Actor | null | undefined): SocialPost {
  needPerson(actor);
  need(post, "scheduled");
  return { ...post, state: "draft", at: null, approvedBy: null };
}
/** Tries a failed post again: free, the same approved post, and a person's press. The account must not need reconnecting first. */
export function retry(post: SocialPost, actor: Actor | null | undefined, at: number): SocialPost {
  needPerson(actor);
  need(post, "failed");
  if (post.failure?.reconnect) throw new PostRefusal("Reconnect the account first.");
  if (!post.approvedBy) throw new PostRefusal("This post was never approved.");
  return { ...post, state: "scheduled", at, failure: null };
}
/** The publisher's outcome, recorded by the server side only (no button calls this). */
export function settle(post: SocialPost, outcome: { ok: true; at: number } | { ok: false; reason: string; reconnect: boolean }): SocialPost {
  need(post, "scheduled");
  return outcome.ok ? { ...post, state: "posted", at: outcome.at, failure: null } : { ...post, state: "failed", failure: { reason: outcome.reason, reconnect: outcome.reconnect } };
}

/* ── Words ─────────────────────────────────────────────────────────────── */

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
/** "Fri 10:00". */
export const whenWords = (at: number) => { const d = new Date(at); return `${DAY[d.getDay()]} ${hhmm(d)}`; };
/** "2 h ago", "5 min ago", "3 days ago". */
export function agoWords(at: number, now: number): string {
  const min = Math.max(1, Math.round((now - at) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** The state line a card shows: "Draft", "Scheduled · Fri 10:00", "Posted · 2 h ago", "Failed · the account needs reconnecting · nothing posted". */
export function stateLine(post: SocialPost, now: number): string {
  switch (post.state) {
    case "draft": return "Draft";
    case "waiting": return "Waiting for your approval";
    case "scheduled": return post.at != null ? `Scheduled · ${whenWords(post.at)}` : "Scheduled";
    case "posted": return post.at != null ? `Posted · ${agoWords(post.at, now)}` : "Posted";
    case "failed": return `Failed · ${post.failure?.reason ?? "it did not go out"} · nothing posted`;
  }
}

export type PostAction = "send" | "approve" | "unschedule" | "reconnect" | "retry";
/** The actions a person is offered on a post in each state. Every one is free. */
export function actionsOf(post: SocialPost): PostAction[] {
  switch (post.state) {
    case "draft": return ["send"];
    case "waiting": return ["approve"];
    case "scheduled": return ["unschedule"];
    case "posted": return [];
    case "failed": return post.failure?.reconnect ? ["reconnect", "retry"] : ["retry"];
  }
}

/** Whether the post screen is on at all: posting is not in Particl yet, so only a development build, asked for, shows it. */
export function postsPreview(): boolean {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return false;
  try { return window.sessionStorage.getItem("particl-posts-preview") === "1"; } catch { return false; }
}
