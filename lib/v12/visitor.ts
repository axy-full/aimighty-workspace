/**
 * The visitor's side of the new interface (docs/redesign/inventory.md § 8; components/v12/visitor/): what a signed-out
 * person sees at `/?guest=1` once the platform owner has Guest Home on. The same app, laid out the same way, with nothing of
 * any workspace in it: Particl's own public showcase, a "How it works" row, the bar, and a join sheet behind every
 * action that would think, spend, keep or send work.
 *
 * Pure: no React, no fetch (tests/unit/v12-visitor.spec.ts). Nothing here names a workspace, a person or a brand: the
 * showcase is the three public stills of Particl's own sample (public/campaign), named as lib/workbench/studio.ts names them.
 */
import { seedProject } from "@/lib/workbench/studio";
import { isJoinReason, type JoinReason } from "@/components/v12/join/join-model";

export type VisitorScreen = "home" | "make" | "board";
export const VISITOR_SCREENS: readonly VisitorScreen[] = ["home", "make", "board"];

/** One showcase tile: Particl's own work, a still on a public path. */
export type ShowcaseTile = { id: string; url: string; type: string; title: string; prompt: string };

/**
 * Particl's public showcase: the stills of the seed production (lib/workbench/studio.ts seedProject), which ship in
 * public/campaign and are shown to anyone. Never read from a workspace. The prototype's six stand-ins are not copied.
 */
export function showcase(): ShowcaseTile[] {
  return seedProject().assets
    .filter((a) => a.kind === "image" && a.url.startsWith("/campaign/"))
    .map((a) => ({ id: a.id, url: a.url, type: `Still · ${a.category}`, title: a.name, prompt: a.prompt ?? "" }));
}

/** "How it works" (prototype § 8.2), verbatim. */
export const HOW_IT_WORKS: readonly { title: string; line: string }[] = [
  { title: "Describe it", line: "A film, an ad or an idea, in a sentence or a brief." },
  { title: "Atomik plans the stages", line: "Brief, script, cast, storyboard, shots, cut, deliver — each priced before it runs." },
  { title: "Approve as it’s made", line: "Every take lands as a card: approve, reject or change it with words." },
  { title: "Deliver in every size and language", line: "Masters, cutdowns and adaptations, straight from the board." },
];

/** What the address asks for. Everything else in it is ignored. */
export type VisitorAsk = {
  screen: VisitorScreen;
  /** The join sheet open at load (`join=`), and whether it shows "You're on the list". */
  join: JoinReason | null;
  requested: boolean;
  /** An invite code from the link (`invite=`), well formed or null. */
  invite: string | null;
  /** `step=plan`: a new-workspace invite on its plan step. */
  step: "plan" | null;
  /** A board link (`board=`): any board id; a visitor has no workspace, so it is never opened (§ 8.7). */
  board: string | null;
  joined: boolean;
};

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
const CODE = /^[A-Za-z0-9_-]{8,200}$/;
const BOARD_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export function visitorAsk(q: Raw): VisitorAsk {
  const screen = one(q.screen);
  const join = one(q.join);
  const code = one(q.invite);
  const board = one(q.board);
  return {
    screen: VISITOR_SCREENS.includes(screen as VisitorScreen) ? (screen as VisitorScreen) : "home",
    join: isJoinReason(join) ? join : null,
    requested: one(q.requested) === "1",
    invite: code && CODE.test(code) ? code : null,
    step: one(q.step) === "plan" ? "plan" : null,
    board: board && BOARD_ID.test(board) ? board : null,
    joined: one(q.joined) === "1",
  };
}

/** The "No access" screen (§ 8.7), verbatim. */
export const NO_ACCESS = {
  title: "You don’t have access",
  line: "This board belongs to another workspace. Boards, names and assets are never shown outside their workspace.",
} as const;

/** The sample's tab in the header: "Sample · <title>". */
export const sampleTab = (title: string) => `Sample · ${title}`;

/** The pill on the sample board (§ 8.2). */
export const SAMPLE_PILL = "Sample · changes on the sample aren’t saved";

/** What the bar says a tile asks for when a visitor presses Start on it (the words the join sheet quotes). */
export function visitorBrief(tile: Pick<ShowcaseTile, "title" | "prompt"> | null, typed: string): string {
  const own = typed.replace(/\s+/g, " ").trim();
  if (!tile) return own;
  const like = tile.prompt ? `Make one like “${tile.title}”: ${tile.prompt}` : `Make one like “${tile.title}”.`;
  return own ? `${own}\n\n${like}` : like;
}
