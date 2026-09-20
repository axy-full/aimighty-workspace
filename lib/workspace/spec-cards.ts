import type { Project } from "@/lib/workbench/studio";
import { parseScreenplay } from "@/lib/workbench/screenplay";
import type { PageId } from "./types";

/**
 * The spec-card template's content (03-pages.md, "Spec-card template").
 *
 * Copy is carried from the prototype's CARDS constant, with two kinds of
 * change: vendor names are neutral (brief decision 5), and every count the
 * prototype printed from its fixture project ("12 pp", "24 frames", "$250"…)
 * is either derived from the open project or dropped. Card states come from
 * real data where a source exists; with no evidence a card reads READY —
 * never COMPLETE or ACTIVE.
 */

export type CardState = "COMPLETE" | "ACTIVE" | "WAITING" | "READY";

export const CARD_STATE: Record<CardState, { color: string; label: string }> = {
  COMPLETE: { color: "var(--pxw-green)", label: "Complete" },
  ACTIVE: { color: "var(--pxw-blue-ink)", label: "Active" },
  WAITING: { color: "var(--pxw-amber)", label: "Waiting on you" },
  READY: { color: "var(--pxw-neutral-state)", label: "Ready" },
};

/** The smallest pipeline-run shape the cards read (lib/pipeline/public.ts). */
export type RunLite = {
  id: string;
  state: string;
  pipelineId: string;
  pipelineVersion: number;
  attempts: { state: string }[];
};

export type PlanRunLite = { status: "running" | "waiting" | "paused" | "done" | "failed" } | null;

/** Everything a spec page's cards and facts may read. `null` = not loaded. */
export type SpecFacts = {
  project: Project | null;
  /** Atomik: this production's pipeline runs. */
  runs: RunLite[] | null;
  /** Atomik Budget: settled project spend and cap, in credits. */
  budget: { credits: number; capCredits: number | null } | null;
  /** The page's Atomik plan in this session. */
  planRun: PlanRunLite;
  planCompleted: boolean;
  /** The plan's price label ("Free", "Quote at gate"…), from lib/workspace/plans.ts. */
  planPrice: string | null;
};

export const EMPTY_FACTS: SpecFacts = { project: null, runs: null, budget: null, planRun: null, planCompleted: false, planPrice: null };

export type SpecCard = {
  name: string;
  desc: string;
  /** Fixed chips: product facts, never fixture counts. The Library reads these. */
  chips: string[];
  /** Chips counted from data, shown before the fixed ones. */
  live?: (f: SpecFacts) => string[];
  owner: string;
  state?: (f: SpecFacts) => CardState;
  /** The card the page's Atomik plan performs: its run drives the state. */
  plan?: true;
  /** The working tool this card opens. */
  tool?: string;
};

export type SpecGroup = { title: string; note: string | ((f: SpecFacts) => string); cards: SpecCard[] };

export type SpecTool = { id: string; label: string };

export type SpecPage = {
  intro: string;
  groups: SpecGroup[];
  /** Five facts for the Inspector's SPECIFICATION table. */
  facts: (f: SpecFacts) => [string, string][];
  /** Working tools, first is the default. Empty: the page is cards only. */
  tools: SpecTool[];
};

/* ── helpers ─────────────────────────────────────────────────────────── */

const n = (value: number) => value.toLocaleString("en-US");
const count = (value: number, one: string, many = `${one}s`) => `${n(value)} ${value === 1 ? one : many}`;
const has = (text: string | undefined | null) => Boolean(text && text.trim());
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const when = (ok: boolean, state: CardState = "COMPLETE"): CardState => (ok ? state : "READY");
const price = (f: SpecFacts) => f.planPrice ?? "—";

export function scenesOf(project: Project | null): number {
  if (!project?.script?.trim()) return 0;
  try {
    return parseScreenplay(project.script).length;
  } catch {
    return 0;
  }
}

/** What Studio's Look section lists (Studio.tsx libraryAssets("moodboard")). */
export const lookRefs = (project: Project | null) =>
  (project?.assets ?? []).filter((a) => ["image", "link", "document"].includes(a.kind)).length;
/* The category drafts file 3D uploads and renders under; older drafts carry the pre-rename value. */
const ASTRA_CATEGORIES = new Set(["Astra", ["Astra", "blender"].join(" ")]);
const astraAssets = (project: Project | null) =>
  (project?.assets ?? []).filter((a) => ASTRA_CATEGORIES.has(a.category) || a.mime === "model/gltf-binary").length;
const uploads = (project: Project | null, kind?: string) =>
  (project?.assets ?? []).filter((a) => a.uploadId && !a.generationId && (!kind || a.kind === kind)).length;
const runtimeSeconds = (project: Project | null) =>
  project?.fps ? project.shots.reduce((sum, s) => sum + s.duration, 0) / project.fps : 0;

const TERMINAL_RUN = new Set(["succeeded", "cancelled"]);
const APPROVAL_RUN = new Set(["draft", "awaiting_approval", "needs_review", "blocked"]);
const liveRuns = (f: SpecFacts) => (f.runs ?? []).filter((r) => !TERMINAL_RUN.has(r.state));
const approvalRuns = (f: SpecFacts) => (f.runs ?? []).filter((r) => APPROVAL_RUN.has(r.state));
const recipes = (f: SpecFacts) => new Set((f.runs ?? []).map((r) => `${r.pipelineId}:${r.pipelineVersion}`)).size;
const moleculr = (f: SpecFacts) => f.project?.moleculr ?? null;

/** Card state: the plan's run first, then the card's own evidence, else READY. */
export function cardState(card: SpecCard, f: SpecFacts): CardState {
  if (card.plan) {
    if (f.planRun?.status === "waiting") return "WAITING";
    if (f.planRun?.status === "running") return "ACTIVE";
    if (f.planCompleted) return "COMPLETE";
  }
  return card.state?.(f) ?? "READY";
}

/** "Art director · complete", "You · waiting on you". */
export function cardFooter(card: SpecCard, state: CardState) {
  const label = CARD_STATE[state].label;
  return card.owner ? `${card.owner} · ${label.toLowerCase()}` : label;
}

export function cardChips(card: SpecCard, f: SpecFacts) {
  return [...(card.live?.(f) ?? []), ...card.chips];
}

export function groupNote(group: SpecGroup, f: SpecFacts) {
  return typeof group.note === "function" ? group.note(f) : group.note;
}

/** The home feature card's description: the intro's first sentence. */
export function firstSentence(text: string) {
  const match = /^.*?[.!?](?=\s|$)/.exec(text.trim());
  return match ? match[0] : text.trim();
}

/* ── the pages ───────────────────────────────────────────────────────── */

const CONNECTED_FACTS = (f: SpecFacts): [string, string][] => [
  ["Source", "4–30 s"],
  ["References", "up to 30, ordered"],
  ["Resolution", "480p · 720p · 1080p"],
  ["Video uploads", n(uploads(f.project, "video"))],
  ["Billing", "Connected credits"],
];

export const SPEC_PAGES: Partial<Record<PageId, SpecPage>> = {
  /* ─────────────────────────────── Particl ─────────────────────────────── */
  brief: {
    intro: "One stage. The brief, the script and the development passes read and write the same document, so scene numbers stay bound to the boards, the shots and the takes that cite them.",
    tools: [{ id: "brief", label: "Brief" }, { id: "script", label: "Script & development" }],
    facts: (f) => [
      ["Brief", has(f.project?.brief) ? count(words(f.project!.brief), "word") : "Empty"],
      ["Scenes", n(scenesOf(f.project))],
      ["Format", f.project?.scriptFormat === "adfilm" ? "Ad film" : "Screenplay"],
      ["Import", f.project?.scriptSource ? `${count(f.project.scriptSource.pages.length, "page")} imported` : "OCR · PDF"],
      ["Cost", price(f)],
    ],
    groups: [
      { title: "DOCUMENT", note: "brief and script on one surface", cards: [
        { name: "Brief", desc: "Objective, offer, audience, tone and constraints. Every later stage reads this.", chips: [], live: (f) => (has(f.project?.brief) ? [count(words(f.project!.brief), "word"), "saved"] : ["empty"]), owner: "Producer", state: (f) => when(has(f.project?.brief)), tool: "brief" },
        { name: "Script", desc: "Scene-numbered script written against the brief. Scene IDs bind to boards and shots.", chips: [], live: (f) => (has(f.project?.script) ? [count(scenesOf(f.project), "scene")] : ["empty"]), owner: "Writer", state: (f) => when(has(f.project?.script)), tool: "script" },
        { name: "Development", desc: "Alternate passes kept side by side. Nothing is overwritten.", chips: [], live: (f) => [count(f.project?.developmentApplications?.length ?? 0, "pass", "passes") + " applied"], owner: "Writer", state: (f) => when((f.project?.developmentApplications?.length ?? 0) > 0), tool: "script" },
        { name: "Screenplay import", desc: "OCR a PDF or paste a screenplay; scenes are extracted and numbered.", chips: ["OCR", "PDF"], owner: "Producer", state: (f) => when(Boolean(f.project?.scriptSource)), tool: "script" },
      ] },
      { title: "AGENTIC", note: "proposed, priced, then applied on your word", cards: [
        { name: "Draft from brief", desc: "Writes the scene-numbered script from the brief and flags continuity risks.", chips: ["quoted", "text model"], owner: "Atomik", plan: true, tool: "script" },
        { name: "Coverage check", desc: "Reads the script against the brief and reports what is unshot.", chips: ["scene review"], owner: "Atomik", state: (f) => when(Object.keys(f.project?.scriptReviews ?? {}).length > 0), tool: "script" },
        { name: "Breakdown", desc: "Extracts cast, elements, locations and props straight into Cast & Elements.", chips: ["→ Cast"], owner: "Atomik", tool: "script" },
      ] },
    ],
  },

  boards: {
    intro: "Boards follow the script. Look sits at the top as a collapsible section; the boards below inherit its references, and each board keeps the scene number it came from.",
    tools: [{ id: "boards", label: "Look & boards" }],
    facts: (f) => [
      ["Boards", n(f.project?.shots.length ?? 0)],
      ["Scenes", n(scenesOf(f.project))],
      ["Look refs", n(lookRefs(f.project))],
      ["Engine", "Image 2"],
      ["Cost", price(f)],
    ],
    groups: [
      { title: "LOOK", note: "collapsible, sits above the boards", cards: [
        { name: "Look board", desc: "Reference images, palette and grade intent. One source of truth for every board.", chips: [], live: (f) => [count(lookRefs(f.project), "ref")], owner: "Art director", state: (f) => when(lookRefs(f.project) > 0), tool: "boards" },
        { name: "Palette", desc: "The project palette, carried into Rig as a colour node.", chips: ["→ Rig"], owner: "Art director", state: (f) => when((f.project?.nodes ?? []).some((node) => node.type === "grade")), tool: "boards" },
      ] },
      { title: "BOARDS", note: (f) => {
        const frames = f.project?.shots.length ?? 0;
        const scenes = scenesOf(f.project);
        return frames ? `${count(frames, "frame")}${scenes ? ` across ${count(scenes, "scene")}` : ""}` : "one or more per scene";
      }, cards: [
        { name: "Frames", desc: "One or more boards per scene, ordered into sequence.", chips: [], live: (f) => [count(f.project?.shots.length ?? 0, "frame")], owner: "Storyboard", plan: true, state: (f) => when((f.project?.shots.length ?? 0) > 0), tool: "boards" },
        { name: "Annotation", desc: "Camera, lens and movement notes ride with each frame into Rig.", chips: [], live: (f) => [count((f.project?.shots ?? []).filter((s) => has(s.note)).length, "note")], owner: "Director", state: (f) => when(Boolean(f.project?.shots.length) && f.project!.shots.every((s) => has(s.note))), tool: "boards" },
        { name: "Sequence", desc: "Reorder boards and the shot list in Rig follows.", chips: ["→ Rig"], owner: "Editor", tool: "boards" },
      ] },
    ],
  },

  astra: {
    intro: "Blocking before rendering. A shot from Rig opens in the 3D runtime, where camera, lens and movement are set against the plate, then exported back as a layout the shot cites.",
    tools: [{ id: "astra", label: "3D scene" }],
    facts: (f) => [
      ["Runtime", "3D runtime"],
      ["Scene objects", n(f.project?.astraBlender?.objects.length ?? 0)],
      ["3D assets", n(astraAssets(f.project))],
      ["Export", "layout → Rig"],
      ["Cost", price(f)],
    ],
    groups: [
      { title: "LAYOUT", note: "", cards: [
        { name: "Plate import", desc: "Bring an environment plate or element in at native resolution.", chips: ["native"], owner: "Art director", state: (f) => when(astraAssets(f.project) > 0), tool: "astra" },
        { name: "Camera", desc: "Focal length, height and framing set against the plate.", chips: ["focal length", "height"], owner: "DoP", tool: "astra" },
        { name: "Movement", desc: "Push, orbit or lock, exported as a described move the engine can follow.", chips: ["push", "orbit", "lock"], owner: "DoP", tool: "astra" },
        { name: "Export to Rig", desc: "Writes a layout node the shot cites. Re-running keeps the citation.", chips: ["→ Rig"], owner: "Director", plan: true, tool: "astra" },
      ] },
      { title: "FINISHING", note: "priced per clip", cards: [
        { name: "Video upscale", desc: "Upscale finished takes without re-rendering them.", chips: ["priced"], owner: "Finishing" },
        { name: "Image upscale", desc: "Stills and boards to print resolution.", chips: ["priced"], owner: "Finishing" },
      ] },
    ],
  },

  deliver: {
    intro: "Delivery runs against the spec saved on the project. Ratio, frame rate, duration and loudness are verified before anything is packaged.",
    tools: [{ id: "package", label: "Package" }, { id: "movie", label: "Final movie" }],
    facts: (f) => [
      ["Spec", f.project ? `${f.project.aspect} · ${f.project.fps} fps` : "—"],
      ["Events", n(f.project?.shots.length ?? 0)],
      ["Runtime", `${runtimeSeconds(f.project).toLocaleString("en-US", { maximumFractionDigits: 2 })} s`],
      ["Package", "EDL · media · manifest"],
      ["Status", f.project?.shots.length ? "Ready to package" : "No shots yet"],
    ],
    groups: [
      { title: "CHECK", note: "", cards: [
        { name: "Spec check", desc: "Ratio, frame rate, duration and loudness verified against the saved spec.", chips: ["automatic"], owner: "Post super", tool: "package" },
        { name: "Version history", desc: "Every export keeps its inputs, so a delivery can be reproduced exactly.", chips: ["manifest"], owner: "Post super", tool: "package" },
      ] },
      { title: "PACKAGE", note: "", cards: [
        { name: "Master", desc: "MP4 or WebM at 720p or 1080p, rendered from the approved takes on this device.", chips: ["MP4", "WebM"], owner: "Finishing", tool: "movie" },
        { name: "Social cuts", desc: "9:16 and 1:1 reframes from the same master.", chips: ["9:16", "1:1"], owner: "Editor" },
        { name: "Handoff", desc: "Originals, stems and the edit list as one package.", chips: ["originals", "stems"], owner: "Post super", plan: true, tool: "package" },
      ] },
    ],
  },

  /* ─────────────────────────────── Atomik ──────────────────────────────── */
  agent: {
    intro: "Describe the outcome; the agent plans it against this project, prices it, and waits for you before anything paid runs. It reaches every suite, every asset and every engine the workspace has.",
    tools: [{ id: "agent", label: "Conversation" }],
    facts: (f) => [
      ["Context", f.project?.name ?? "—"],
      ["Scenes", n(scenesOf(f.project))],
      ["Suites", "4"],
      ["Autonomy", "Step or run"],
      ["Planning", price(f)],
    ],
    groups: [
      { title: "PLANNING", note: "reviewed before it runs", cards: [
        { name: "Conversation", desc: "Plain-language planning with the whole project in context.", chips: ["quoted"], owner: "Atomik", tool: "agent" },
        { name: "Multi-step plans", desc: "A plan is a named sequence of priced steps you can edit before running.", chips: ["editable"], owner: "Atomik", plan: true, tool: "agent" },
        { name: "Cross-suite", desc: "One plan can span Production, Marketing and the Viral Studio.", chips: ["4 suites"], owner: "Atomik", tool: "agent" },
        { name: "Autonomy", desc: "Run a whole stage, or step through it one action at a time.", chips: ["step", "run"], owner: "You", tool: "agent" },
      ] },
      { title: "CONTEXT", note: "", cards: [
        { name: "Project memory", desc: "Reads the brief, script, cast, shots, takes and ledger.", chips: ["scoped"], owner: "Atomik", state: (f) => when(Boolean(f.project?.productionProjectId), "ACTIVE"), tool: "agent" },
        { name: "Attachments", desc: "Drop references into a plan; they are saved as project originals.", chips: ["byte-identical"], owner: "You", tool: "agent" },
      ] },
    ],
  },

  runs: {
    intro: "Every agent action becomes a durable run. Close the tab, reload, or lose the connection — the run keeps its place, its dispatch claim and its accounting.",
    tools: [{ id: "runs", label: "Runs" }],
    facts: (f) => [
      ["Live", f.runs ? n(liveRuns(f).length) : "—"],
      ["Saved runs", f.runs ? n(f.runs.length) : "—"],
      ["Awaiting approval", f.runs ? n(approvalRuns(f).length) : "—"],
      ["Recovery", "Durable"],
      ["Retry", "Idempotent"],
    ],
    groups: [
      { title: "EXECUTION", note: "", cards: [
        { name: "Durable pipelines", desc: "A run survives reload. Nothing is re-dispatched on recovery.", chips: ["durable"], live: (f) => (f.runs ? [count(f.runs.length, "run")] : []), owner: "Atomik", state: (f) => when(liveRuns(f).length > 0, "ACTIVE"), tool: "runs" },
        { name: "Queue", desc: "Concurrency and per-project caps enforced before dispatch.", chips: ["per project"], owner: "Atomik", state: (f) => when((f.runs ?? []).some((r) => r.state === "running"), "ACTIVE"), tool: "runs" },
        { name: "Cancellation", desc: "Requests cancellation and keeps polling until it is confirmed.", chips: ["confirmed"], owner: "You", tool: "runs" },
        { name: "Recovery records", desc: "An uncertain reply keeps a record and cannot create a second paid job.", chips: ["no double spend"], owner: "Atomik", plan: true, state: (f) => when((f.runs ?? []).some((r) => r.attempts.some((a) => a.state === "uncertain")), "ACTIVE"), tool: "runs" },
      ] },
      { title: "OBSERVABILITY", note: "", cards: [
        { name: "Step log", desc: "Every step, its inputs and what it settled at.", chips: ["auditable"], owner: "Atomik", state: (f) => when((f.runs ?? []).some((r) => r.attempts.length > 0), "ACTIVE"), tool: "runs" },
        { name: "Failures", desc: "Failed generations are not billed and are shown as such.", chips: ["not billed"], owner: "Atomik", tool: "runs" },
      ] },
    ],
  },

  recipes: {
    intro: "A recipe is a saved plan that reruns exactly — same steps, same inputs, same engines. Cloning one is free; only the generations inside it cost anything.",
    tools: [{ id: "recipes", label: "Recipes" }],
    facts: (f) => [
      ["Saved", f.runs ? n(recipes(f)) : "—"],
      ["Cloning", "Free · exact"],
      ["Runs", f.runs ? n(f.runs.length) : "—"],
      ["Scope", "This project"],
      ["Plan", price(f)],
    ],
    groups: [
      { title: "LIBRARY", note: "", cards: [
        { name: "Exact cloning", desc: "A clone reproduces the saved plan byte-for-byte.", chips: ["free", "exact"], live: (f) => (f.runs ? [`${n(recipes(f))} saved`] : []), owner: "Atomik", tool: "recipes" },
        { name: "Parameters", desc: "Swap the product, the cast or the look and rerun the same structure.", chips: ["product", "cast", "look"], owner: "You", tool: "recipes" },
        { name: "From a run", desc: "Turn any successful run into a recipe.", chips: ["one click"], owner: "You", plan: true, state: (f) => when(recipes(f) > 0), tool: "recipes" },
        { name: "Sharing", desc: "Share inside the workspace; spend stays with whoever runs it.", chips: ["workspace"], owner: "Admin", tool: "recipes" },
      ] },
    ],
  },

  builds: {
    intro: "Describe a tool and the agent builds it — interface, data, sign-in and generation models wired in. A published build runs on the viewer's own credits, so sharing one costs its author nothing.",
    tools: [],
    facts: (f) => [
      ["Runs on", "Viewer credits"],
      ["Deploy", "Live URL"],
      ["Sign-in", "Wired in"],
      ["Project", f.project?.name ?? "—"],
      ["Status", "Not runnable yet"],
    ],
    groups: [
      { title: "BUILD", note: "from a description, in conversation", cards: [
        { name: "Apps", desc: "A working generative tool with interface, storage and sign-in wired in.", chips: ["full stack"], owner: "Atomik", plan: true },
        { name: "Sites", desc: "A responsive site built around your own generated assets.", chips: ["responsive"], owner: "Atomik" },
        { name: "Games", desc: "Small interactive pieces on the same stack.", chips: ["interactive"], owner: "Atomik" },
        { name: "Iterate", desc: "Say what to change; the build updates and redeploys.", chips: ["conversational"], owner: "You" },
      ] },
      { title: "PUBLISH", note: "", cards: [
        { name: "Live URL", desc: "Every build deploys to its own address.", chips: ["deployed"], owner: "Atomik" },
        { name: "Viewer credits", desc: "Users sign in and generate on their own balance.", chips: ["zero cost"], owner: "Admin" },
        { name: "Listing", desc: "Offer a build to others in the workspace.", chips: ["listed"], owner: "Admin" },
      ] },
    ],
  },

  skills: {
    intro: "Skills are the tool packs the agent can reach. Each declares what it can do, what it costs and what it is allowed to touch.",
    tools: [],
    facts: () => [
      ["Scope", "Per project"],
      ["Credentials", "Server-side"],
      ["Cost", "Per call"],
      ["Audio", "Speech · SFX · Music"],
      ["Registry", "Not runnable yet"],
    ],
    groups: [
      { title: "INSTALLED", note: "", cards: [
        { name: "Generate", desc: "Stills and video across every configured engine.", chips: ["every engine"], owner: "Atomik", plan: true },
        { name: "Identity", desc: "Build and reuse a locked character identity.", chips: ["locked"], owner: "Atomik" },
        { name: "Brand kit", desc: "Logo, palette and type applied across a campaign.", chips: ["brand"], owner: "Atomik" },
        { name: "Product shots", desc: "Studio, lifestyle and on-model product imagery.", chips: ["product"], owner: "Atomik" },
        { name: "Research", desc: "Reads the project and the brief, not the open web.", chips: ["scoped"], owner: "Atomik" },
        { name: "Editorial", desc: "Assembly, colour match and export.", chips: ["→ Edit"], owner: "Atomik" },
      ] },
    ],
  },

  models: {
    intro: "Thinking model and effort for planning; generation engines for output. Each engine clamps ratio, resolution, duration and audio to what it actually accepts.",
    tools: [{ id: "models", label: "Models" }],
    facts: () => [
      ["Thinking", "Low · medium · high"],
      ["Video", "Motion 2.5 / 2.0"],
      ["Stills", "Image 2"],
      ["Audio", "Speech · SFX · Music"],
      ["Clamping", "Automatic"],
    ],
    groups: [
      { title: "THINKING", note: "planning only, never generation", cards: [
        { name: "Model", desc: "Route planning through the configured thinking model.", chips: ["configured"], owner: "Admin", tool: "models" },
        { name: "Effort", desc: "Low, medium or high. Higher effort costs more and plans deeper.", chips: ["low", "medium", "high"], owner: "Admin", tool: "models" },
      ] },
      { title: "GENERATION", note: "", cards: [
        { name: "Motion 2.5", desc: "1080p with audio. Billed on the returned token count.", chips: ["audio"], owner: "Admin", tool: "models" },
        { name: "Motion 2.0", desc: "Cheaper tier, 4K available, no generated audio.", chips: ["no audio"], owner: "Admin", tool: "models" },
        { name: "Stills", desc: "Gateway, direct and third-party routes for images.", chips: ["routes"], owner: "Admin", tool: "models" },
        { name: "Audio", desc: "Speech, sound effects and music.", chips: ["3 kinds"], owner: "Admin", tool: "models" },
      ] },
    ],
  },

  approvals: {
    intro: "Nothing paid happens without an approval. Each gate binds the exact inputs, the engine, the price and an expiry, so approving a stale quote is impossible.",
    tools: [{ id: "approvals", label: "Approvals" }],
    facts: (f) => [
      ["Waiting", f.runs ? n(approvalRuns(f).length) : "—"],
      ["Binds", "Inputs · price"],
      ["Expiry", "Timed quote"],
      ["Decline", "Holds the run"],
      ["Double spend", "Prevented"],
    ],
    groups: [
      { title: "GATES", note: "", cards: [
        { name: "Priced gate", desc: "The exact price is shown before dispatch, from a live estimate.", chips: ["live"], live: (f) => (f.runs ? [`${n(approvalRuns(f).length)} waiting`] : []), owner: "You", plan: true, state: (f) => when(approvalRuns(f).length > 0, "WAITING"), tool: "approvals" },
        { name: "Immutable binding", desc: "Inputs, wallet and amount are frozen at approval.", chips: ["frozen"], owner: "Atomik", tool: "approvals" },
        { name: "Expiry", desc: "A quote that ages out must be re-estimated.", chips: ["timed"], owner: "Atomik", tool: "approvals" },
        { name: "Decline", desc: "Holds the run. Nothing is dispatched and nothing is charged.", chips: ["safe"], owner: "You", tool: "approvals" },
      ] },
    ],
  },

  budget: {
    intro: "Settled accounting, not estimates. Each generation snapshots the rate it was charged at, so changing a rate never rewrites history.",
    tools: [{ id: "budget", label: "Budget" }],
    facts: (f) => [
      ["Project spend", f.budget ? `${n(f.budget.credits)} cr` : "—"],
      ["Cap", f.budget ? (f.budget.capCredits == null ? "Not set" : `${n(f.budget.capCredits)} cr`) : "—"],
      ["Failed renders", "Not billed"],
      ["Ledger", "Settled only"],
      ["Rates", "Snapshot per render"],
    ],
    groups: [
      { title: "ACCOUNTING", note: "", cards: [
        { name: "Settled cost", desc: "Recorded from the billed token count the engine returns.", chips: ["actual"], live: (f) => (f.budget ? [`${n(f.budget.credits)} cr`] : []), owner: "Finance", plan: true, state: (f) => when((f.budget?.credits ?? 0) > 0, "ACTIVE"), tool: "budget" },
        { name: "Rate snapshot", desc: "Every render keeps the rate it was charged at.", chips: ["immutable"], owner: "Finance", state: (f) => when((f.budget?.credits ?? 0) > 0, "ACTIVE"), tool: "budget" },
        { name: "Caps", desc: "Per-project ceilings enforced before dispatch.", chips: [], live: (f) => [f.budget?.capCredits != null ? `${n(f.budget.capCredits)} cr` : "no cap"], owner: "Admin", state: (f) => when(f.budget?.capCredits != null, "ACTIVE"), tool: "budget" },
        { name: "Attribution", desc: "Spend by person, project, engine and month.", chips: ["per person"], owner: "Finance", tool: "budget" },
      ] },
    ],
  },

  /* ─────────────────────────────── Moleculr ────────────────────────────── */
  marketing: {
    intro: "One studio: a product, who presents it, what it says and where it runs. Configure a variant and it becomes a generation node bound to your saved originals, so a reload or a handoff to Rig keeps every reference.",
    tools: [
      { id: "product", label: "Product" },
      { id: "brand", label: "Brand & cast" },
      { id: "format", label: "Message & format" },
      { id: "variants", label: "Variants & output" },
    ],
    facts: (f) => [
      ["Product images", `${n(moleculr(f)?.productAssetIds.length ?? 0)} of 5`],
      ["Cast images", `${n(moleculr(f)?.castAssetIds.length ?? 0)} of 6`],
      ["Formats", "9"],
      ["Hooks", `${n(moleculr(f)?.hooks.length ?? 0)} of 12`],
      ["Variants", `${n(moleculr(f)?.variants.length ?? 0)} of 100`],
    ],
    groups: [
      { title: "PRODUCT", note: "saved references, never a scrape", cards: [
        { name: "Product details", desc: "Name, offer, price and claims, saved with the project.", chips: ["saved"], owner: "Brand", state: (f) => when(has(moleculr(f)?.productName)), tool: "product" },
        { name: "Product images", desc: "Up to five originals, kept byte-identical.", chips: ["5 max"], live: (f) => (moleculr(f)?.productAssetIds.length ? [`${n(moleculr(f)!.productAssetIds.length)} saved`] : []), owner: "Brand", state: (f) => when((moleculr(f)?.productAssetIds.length ?? 0) > 0), tool: "product" },
        { name: "Product URL", desc: "A saved reference for your own use, not an extraction.", chips: ["reference"], owner: "Brand", state: (f) => when(has(moleculr(f)?.productUrl)), tool: "product" },
        { name: "Cut-out", desc: "Pull a clean product cut-out from one of your own photos.", chips: ["cut-out"], owner: "Retoucher", tool: "product" },
      ] },
      { title: "BRAND & CAST", note: "", cards: [
        { name: "Brand", desc: "Voice, palette and type every variant inherits.", chips: ["inherited"], owner: "Brand", state: (f) => when(has(moleculr(f)?.brandKit?.name)), tool: "brand" },
        { name: "Presenters", desc: "Up to six cast images, or a locked identity from Production.", chips: ["6 max"], live: (f) => (moleculr(f)?.castAssetIds.length ? [`${n(moleculr(f)!.castAssetIds.length)} chosen`] : []), owner: "Casting", state: (f) => when((moleculr(f)?.castAssetIds.length ?? 0) > 0), tool: "brand" },
        { name: "Custom presenter", desc: "Build a reusable presenter from your own references.", chips: ["reusable"], owner: "Casting", tool: "brand" },
      ] },
      { title: "MESSAGE & FORMAT", note: "", cards: [
        { name: "Hooks", desc: "Twelve opening lines per campaign, written against the brief.", chips: ["12"], live: (f) => (moleculr(f)?.hooks.length ? [`${n(moleculr(f)!.hooks.length)} written`] : []), owner: "Copy", state: (f) => when((moleculr(f)?.hooks.length ?? 0) > 0), tool: "format" },
        { name: "Formats", desc: "Nine creative formats — feed, story, carousel and the rest.", chips: ["9"], owner: "Media", tool: "format" },
        { name: "Aspect & quality", desc: "1k, 2k or 4k across the documented ratios.", chips: ["4k"], owner: "Media", tool: "format" },
      ] },
      { title: "VARIANTS & OUTPUT", note: "", cards: [
        { name: "Variants", desc: "Up to a hundred bindings; each one is a generation node.", chips: ["100 max"], live: (f) => (moleculr(f)?.variants.length ? [`${n(moleculr(f)!.variants.length)} bound`] : []), owner: "Media", plan: true, state: (f) => when((moleculr(f)?.variants.length ?? 0) > 0), tool: "variants" },
        { name: "Design", desc: "Layout and treatment across the whole variant set.", chips: ["set-wide"], owner: "Designer", state: (f) => when(Boolean(moleculr(f)?.poster)), tool: "variants" },
        { name: "Video ads", desc: "Campaign video through the project's configured engines.", chips: ["engine-backed"], owner: "Media", tool: "variants" },
        { name: "Review & deliver", desc: "Publish leads to review and delivery. No posting provider is connected.", chips: ["review"], owner: "Brand", tool: "variants" },
      ] },
    ],
  },

  /* ─────────────────────────────── Subatomik ───────────────────────────── */
  motion: {
    intro: "Take the motion from a source video and recast it with your own cast, location and product. Anything you do not describe stays exactly as filmed.",
    tools: [{ id: "studio", label: "Motion Transfer" }],
    facts: CONNECTED_FACTS,
    groups: [
      { title: "INPUT", note: "", cards: [
        { name: "Source video", desc: "One video, four to thirty seconds, from your own library.", chips: ["4–30 s"], owner: "You", state: (f) => when(uploads(f.project, "video") > 0), tool: "studio" },
        { name: "Ordered references", desc: "Up to thirty images; the order is preserved on submission.", chips: ["30 max"], owner: "You", tool: "studio" },
        { name: "Creative direction", desc: "An optional prompt. Starting points, not provider presets.", chips: ["optional"], owner: "Director", tool: "studio" },
        { name: "Resolution", desc: "480p, 720p or 1080p.", chips: ["1080p"], owner: "You", tool: "studio" },
      ] },
      { title: "RUN", note: "quoted before submission", cards: [
        { name: "Live quote", desc: "A missing or stale estimate blocks submission. No assumed price.", chips: ["live only"], owner: "Atomik", tool: "studio" },
        { name: "Reviewed generation", desc: "Exact price and wallet approved before anything is sent.", chips: ["approved"], owner: "You", plan: true, tool: "studio" },
        { name: "Cancellation", desc: "Requested, then confirmed. No promised refund while uncertain.", chips: ["confirmed"], owner: "Atomik", tool: "studio" },
      ] },
    ],
  },

  swap: {
    intro: "Swap one element — a product, a garment, an object — and leave the rest of the shot exactly as filmed.",
    tools: [{ id: "studio", label: "Object Swap" }],
    facts: CONNECTED_FACTS,
    groups: [
      { title: "SWAP", note: "", cards: [
        { name: "Target element", desc: "Name what to replace; everything else is untouched.", chips: ["one element"], owner: "You", plan: true, tool: "studio" },
        { name: "Replacement references", desc: "Ordered images of the thing going in.", chips: ["ordered"], owner: "You", tool: "studio" },
        { name: "Hold the rest", desc: "Motion, lighting and framing stay as filmed.", chips: ["as filmed"], owner: "Atomik", tool: "studio" },
        { name: "Resolution", desc: "480p, 720p or 1080p.", chips: ["1080p"], owner: "You", tool: "studio" },
      ] },
    ],
  },

  sources: {
    intro: "Sources are your own originals. Nothing is fetched from a URL at generation time and nothing is re-encoded on the way in.",
    tools: [{ id: "sources", label: "Sources" }],
    facts: (f) => [
      ["Uploads", n(uploads(f.project))],
      ["Video sources", n(uploads(f.project, "video"))],
      ["Duration", "4–30 s"],
      ["Integrity", "sha256 verified"],
      ["Storage", "Private"],
    ],
    groups: [
      { title: "LIBRARY", note: "", cards: [
        { name: "Uploads", desc: "Byte-identical. Header bytes are read; pixels are never touched.", chips: ["byte-identical"], live: (f) => (uploads(f.project) ? [count(uploads(f.project), "original")] : []), owner: "You", state: (f) => when(uploads(f.project) > 0), tool: "sources" },
        { name: "Shared originals", desc: "Reuse an original across both modes without re-uploading.", chips: ["shared"], owner: "You", tool: "sources" },
        { name: "Enlarged preview", desc: "Inspect a reference full size before you commit it.", chips: ["preview"], owner: "You", tool: "sources" },
        { name: "Frame extraction", desc: "Pull the start or end frame as a PNG at native dimensions.", chips: ["PNG"], owner: "You", tool: "sources" },
      ] },
    ],
  },

  compare: {
    intro: "Put the original and the result side by side, locked to the same clock. Split or wipe, scrub together, match speed and volume.",
    tools: [{ id: "compare", label: "Results" }],
    facts: () => [
      ["Modes", "Split · wipe"],
      ["Sync", "Locked clock"],
      ["Controls", "Seek · speed · volume"],
      ["Fullscreen", "Yes"],
      ["Download", "Original bytes"],
    ],
    groups: [
      { title: "COMPARE", note: "", cards: [
        { name: "Split and wipe", desc: "Two synchronized viewers, one handle.", chips: ["split", "wipe"], owner: "You", plan: true, tool: "compare" },
        { name: "Transport", desc: "Seek, speed and volume apply to both sides.", chips: ["locked"], owner: "You", tool: "compare" },
        { name: "Fullscreen", desc: "Full-height comparison for review.", chips: ["fullscreen"], owner: "You", tool: "compare" },
        { name: "Download original", desc: "The retained original bytes, not a re-encode.", chips: ["original"], owner: "You", tool: "compare" },
      ] },
    ],
  },

  history: {
    intro: "Every result is copied into private storage on completion — provider retention alone is not a library. Recreate any take, or hand it to Edit and upscale.",
    tools: [{ id: "history", label: "Results" }],
    facts: (f) => [
      ["Project", f.project?.name ?? "—"],
      ["Storage", "Private"],
      ["Recreation", "Exact inputs"],
      ["Handoff", "Edit · upscale"],
      ["Credits", "Connected"],
    ],
    groups: [
      { title: "RESULTS", note: "", cards: [
        { name: "Result history", desc: "Model, source, reference order and resolution retained per result.", chips: ["auditable"], owner: "Atomik", tool: "history" },
        { name: "Recreation", desc: "Rerun a saved take with the same inputs.", chips: ["exact"], owner: "You", tool: "history" },
        { name: "Handoff", desc: "Send a result to Edit & Sound, or to upscale.", chips: ["→ Edit"], owner: "Editor", tool: "history" },
        { name: "Credit receipts", desc: "Connected-credit spend recorded separately from workspace costs.", chips: ["separate"], owner: "Finance", plan: true, tool: "history" },
      ] },
    ],
  },
};

export const SPEC_PAGE_IDS = Object.keys(SPEC_PAGES) as PageId[];

export function specFor(page: PageId): SpecPage | null {
  return SPEC_PAGES[page] ?? null;
}

/** Every string a user can read on the page's cards (intro, groups, cards, facts, tools). */
export function specCopy(page: PageId, f: SpecFacts = EMPTY_FACTS): string[] {
  const spec = specFor(page);
  if (!spec) return [];
  return [
    spec.intro,
    ...spec.tools.map((t) => t.label),
    ...spec.facts(f).flat(),
    ...spec.groups.flatMap((g) => [
      g.title,
      groupNote(g, f),
      ...g.cards.flatMap((c) => [c.name, c.desc, c.owner, ...cardChips(c, f), cardFooter(c, cardState(c, f))]),
    ]),
  ];
}
