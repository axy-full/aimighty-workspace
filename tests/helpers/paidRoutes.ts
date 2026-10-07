/**
 * The routes a customer's press can spend credits on, as the browser reaches them (the price checks:
 * tests/unit/spend-buttons.spec.ts and tests/spend-buttons-workbench.spec.ts; how to opt a button in: docs/ui-checks.md).
 *
 * `dir` is the folder under app/api/. A client string that names the route (a fetch, a helper's URL constant)
 * puts the code around it on the paid path. The list is closed by a test: any route whose source carries a spend
 * marker (below) has to be here, or in NOT_SPENDING with the reason, so a new paid route cannot be added without a decision.
 */

export type PaidRoute = { dir: string; spends: string };

export const PAID_ROUTES: PaidRoute[] = [
  { dir: "generate", spends: "video, image, upscale (Topaz), Seedance edit, Cinema Studio, Motion transfer, Object swap and the agent's renders" },
  { dir: "audio", spends: "speech, sound effects and music" },
  { dir: "audio/dub", spends: "dubbing" },
  { dir: "audio/transcribe", spends: "transcription" },
  { dir: "jobs/[id]/release", spends: "releasing a held take once the balance covers it" },
  { dir: "atomik/steps/[id]/claim", spends: "taking a proposed Atomik step, once, before it is paid for" },
  { dir: "atomik", spends: "an Atomik planning turn (a new chat)" },
  { dir: "atomik/[id]", spends: "an Atomik planning turn in a chat (its POST; the same path also reads and renames)" },
  { dir: "atomik/ideas/draft", spends: "Atomik drafting ideas" },
  { dir: "atomik/shots/draft", spends: "Atomik drafting a shot list" },
  { dir: "atomik/treatment/scene", spends: "Atomik writing a treatment scene" },
  { dir: "atomik/memory/read", spends: "Atomik reading a memory" },
  { dir: "identities/[id]/train", spends: "training an identity" },
  { dir: "identities/[id]/render", spends: "rendering with an identity" },
  { dir: "soul/identities", spends: "training an identity (its POST; the same path also lists)" },
  { dir: "workbench/astra-blender/render", spends: "the 3D blocking tool's render" },
  { dir: "workbench/atomik", spends: "the 3D blocking tool's agent" },
  { dir: "workbench/development", spends: "development steps (script, treatment, breakdown)" },
  { dir: "pipelines/[id]", spends: "approving a pipeline stage (its POST; the same path also reads)" },
  { dir: "prompt/enhance", spends: "the prompt enhancer" },
  { dir: "crew/sessions", spends: "starting a Crew review (its POST; the same path also lists)" },
  { dir: "crew/sessions/[id]/rounds", spends: "a Crew review round" },
];

/**
 * Routes whose source carries a spend marker and still do not spend on a person's press. Each says why.
 * A route that quotes only (`quoteOnly`) is a read; the press that spends is on the route it prices.
 */
export const NOT_SPENDING: Record<string, string> = {
  "admin/workspaces/[id]": "the platform owner's desk: it releases held jobs after a limit changes, with no customer button",
  "auth/reset": "password reset: only a recovery continuation, nothing is charged",
  "cron/sync": "server-driven (cron), no button",
  "worker": "server-driven (the app's own worker), no button",
  "generate/check": "a check before a press: charges nothing",
  "jobs": "reads and syncs jobs, charges nothing",
  "jobs/[id]": "review state, restore and hide: nothing is charged and nothing is erased",
  "rig/elements": "creating an asset is free; training is priced on its own route (identities)",
};

/**
 * Files the scan puts on the paid path although no control in them starts paid work. The scan follows a route's name through
 * a hook or a helper, and a route can be both read and spent on (a GET, a quote-only POST, a run), so it over-approximates.
 * A file goes here only after its handlers were traced, and says what it does instead:
 *  - `why`: what the file does with the route (reads it, quotes it, opens Make or a dialog) and where the press that spends lives;
 *  - `priced`: the files that own the priced, marked button, for a file that only hands them the paid handler. Each must carry the
 *    opt-in and be imported by the excused file (tests/unit/spend-buttons.spec.ts).
 * An entry whose file is no longer on the paid path, or has been marked itself, fails: the list cannot go stale. A spend-verb
 * label in the file still needs its own marker (or an entry in NOT_SPENDING_BUTTONS).
 */
export type FileExcuse = { why: string; priced?: string[] };
export const NOT_SPENDING_FILES: Record<string, FileExcuse> = {
  "components/graphite/control-room/ApprovalsView.tsx": { why: "lists the approvals queue and hands each row the queue's approve and decline; the rows own the Approve button (priced, marked) and Approve in one go owns its confirm", priced: ["components/graphite/control-room/ApprovalRow.tsx", "components/graphite/control-room/BatchApprove.tsx"] },
  "components/graphite/make/Make.tsx": { why: "the Make panel's frame: it holds the composer's state for its tabs and hands it to Compose, which owns the Make button (priced, marked)", priced: ["components/graphite/make/Compose.tsx"] },
  "components/graphite/board/ads/AdsOverlay.tsx": { why: "reads the Campaign agent's runs (a GET) for the cards and draws the run dialog, whose own button quotes and then reserves up to the quote on a person's press", priced: ["components/workbench/AtomikRunDialog.tsx"] },
  "components/graphite/business/HooksTool.tsx": { why: "reads the Campaign agent's runs (a GET); 'See the price' opens the run dialog, whose own button quotes and then reserves up to the quote on a person's press", priced: ["components/workbench/AtomikRunDialog.tsx"] },
  "components/graphite/business/ReferenceTool.tsx": { why: "reads the Campaign agent's runs (a GET); 'See the price' opens the run dialog, whose own button quotes and then reserves up to the quote on a person's press; Apply the direction edits the brief", priced: ["components/workbench/AtomikRunDialog.tsx"] },
  "components/graphite/board/ads/cards/HookCards.tsx": { why: "the only paid-route string is a quote-only request (nothing reserved); 'Write N more' opens the run dialog, where the press that spends lives" },
  "components/graphite/board/agent/RecordTab.tsx": { why: "reads the approvals queue and the activity to list what was approved and what waits; its buttons only open things, and nothing here approves or spends" },
  "components/graphite/board/cards/cast/CastCard.tsx": { why: "reads the identity list (a GET) and shows the training price; 'Build identity' opens the Inspector and 'Lock as master' is free" },
  "components/graphite/board/inspector/CastBody.tsx": { why: "reads the identity list (a GET); its buttons copy, lock the master (free) or open Make; nothing here starts training" },
  "components/graphite/board/cards/plan/NextCard.tsx": { why: "reads one quote (quote-only) for the stills card and opens Make filled; Make shows its own price and a person presses it" },
  "components/graphite/board/cards/take/TakeCard.tsx": { why: "reads the project's checks (a GET); Retry is RetryTake's own button (priced from a quote, marked), which hands the recipe to Make to be priced again, and Release is ReleaseTake's own priced, marked button", priced: ["components/graphite/board/cards/take/RetryTake.tsx"] },
  "components/graphite/board/inspector/TakeBody.tsx": { why: "reads the project's checks (a GET) and one quote; 'Change with words · N cr' opens Make, where the press that spends is priced" },
};

/**
 * A button whose label reads like a spend verb and that does not spend, as "path::label". Each says what the press does.
 */
export const NOT_SPENDING_BUTTONS: Record<string, string> = {
  "components/graphite/control-room/ActivityView.tsx::Run again": "puts the run's request back in Atomik's box and opens Atomik; nothing is sent, and the Ask there shows its own price",
  "components/graphite/make/Recent.tsx::Make something": "switches the panel from Recent to its Make tab; nothing is made until Make is pressed there",
};

/** A route file with any of these in its source is one that can spend, or prices something that does. */
export const SPEND_MARKERS =
  /\b(maxCredits|quoteOnly|withGenerationRequest|reserveGenerationSpend|executeGenerationAdmission|executeAudioAdmission|executeDubbingAdmission|runPaidText|releaseHeldJobs|reserveRecoveryContinuation)\b/;

/**
 * What the label of a button that spends starts with. A button with one of these as its text is a paid control
 * and must say what it costs. Deliberately short: a verb that is also free elsewhere ("Run", "Retry", "Send") is not here.
 */
export const SPEND_LABEL = /^\s*(Make(?!\s+(?:member|admin|owner|editor|viewer|a\s+token)\b)|Generate|Render|Release|Recreate|Again|Upscale|Transfer motion|Swap object|Train|Dub|Transcribe|Approve (?:and|&) run|Run again|Re-?run)\b/;

/** `dir` as a regex over a client string whose template holes are written `{}`. */
export function routePattern(dir: string): RegExp {
  const body = dir.split("/").map((part) => (part.startsWith("[") ? "\\{\\}" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return new RegExp(`^/api/${body}(?:[?#]|$)`);
}

export const PAID_PATTERNS = PAID_ROUTES.map((route) => ({ ...route, pattern: routePattern(route.dir) }));
