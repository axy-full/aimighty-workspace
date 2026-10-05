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

/** A route file with any of these in its source is one that can spend, or prices something that does. */
export const SPEND_MARKERS =
  /\b(maxCredits|quoteOnly|withGenerationRequest|reserveGenerationSpend|executeGenerationAdmission|executeAudioAdmission|executeDubbingAdmission|runPaidText|releaseHeldJobs|reserveRecoveryContinuation)\b/;

/**
 * What the label of a button that spends starts with. A button with one of these as its text is a paid control
 * and must say what it costs. Deliberately short: a verb that is also free elsewhere ("Run", "Retry", "Send") is not here.
 */
export const SPEND_LABEL = /^\s*(Make|Generate|Render|Release|Recreate|Again|Upscale|Transfer motion|Swap object|Train|Dub|Transcribe|Approve (?:and|&) run|Run again|Re-?run)\b/;

/** `dir` as a regex over a client string whose template holes are written `{}`. */
export function routePattern(dir: string): RegExp {
  const body = dir.split("/").map((part) => (part.startsWith("[") ? "\\{\\}" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return new RegExp(`^/api/${body}(?:[?#]|$)`);
}

export const PAID_PATTERNS = PAID_ROUTES.map((route) => ({ ...route, pattern: routePattern(route.dir) }));
