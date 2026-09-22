import type { PageId, Suite } from "@/lib/workspace/types";

/**
 * The Suites shell's information architecture (design/particl-suites/README.md
 * › Information architecture). Four suites plus two views that are not suites
 * (Gen, Workspace). Every page maps onto a page the state layer already knows
 * (lib/workspace/pages.ts), so navigation, selection repair and the page
 * bodies are reused rather than rebuilt; the map narrows as later build steps
 * give Business and Viral their own composers.
 */
export type ShellSuiteId = "studio" | "business" | "viral" | "atomik";
export type ShellView = "suite" | "gen" | "workspace" | "crew";
export type WorkspaceTabId = "general" | "people" | "credits" | "usage" | "engines" | "security";

export type ShellPage = {
  id: string;
  /** `01`, `02`… — position in the stage strip, in mono. */
  n: string;
  /** Stage-strip label. */
  label: string;
  /** Page h1 and the hint beside it. */
  title: string;
  hint: string;
  /** The state layer's suite and page this one is backed by. */
  legacy: { suite: Suite; page: PageId };
  /** A hairline gap sits before this tab (the start of a group). */
  gapBefore: boolean;
  /** The shell renders its own Graphite view for this page (Business from step 2, Viral from step 3, Atomik › Skills from step 5); the legacy mapping only feeds state. */
  own?: boolean;
  /** Reached from the phone's tab bar, never from the stage strip (Studio home). */
  phoneOnly?: boolean;
};

export type ShellSuite = {
  id: ShellSuiteId;
  /** Header segment label. */
  label: string;
  /** Mono mark beside the wordmark. */
  mark: string;
  /** Full name, the segment's title and the project-head pill. */
  name: string;
  legacy: Suite;
  pages: ShellPage[];
};

type Seed = [id: string, label: string, title: string, hint: string, page: PageId];

function build(id: ShellSuiteId, label: string, mark: string, name: string, legacy: Suite, groups: number[], seeds: Seed[]): ShellSuite {
  return {
    id, label, mark, name, legacy,
    pages: seeds.map(([pid, plabel, title, hint, page], i) => ({
      id: pid, n: String(i + 1).padStart(2, "0"), label: plabel, title, hint,
      legacy: { suite: legacy, page }, gapBefore: groups.includes(i),
    })),
  };
}

/**
 * The phone's two screens outside the strip (GLASS_SPEC §3): `home` is the
 * suite picker — "Where to?" — that the Home tab and the mark return to;
 * `stages` is the Studio stage grid behind the Studio tile, with a Home back.
 * Both share Brief's backing page.
 */
function withHome(suite: ShellSuite): ShellSuite {
  const legacy = { suite: suite.legacy, page: suite.pages[0].legacy.page };
  return { ...suite, pages: [...suite.pages,
    { id: "home", n: "", label: "Home", title: "Where to?", hint: "Every suite, one screen", legacy, gapBefore: false, own: true, phoneOnly: true },
    { id: "stages", n: "", label: "Studio", title: "Studio", hint: "Every stage, one screen", legacy, gapBefore: false, own: true, phoneOnly: true },
  ] };
}

function own(suite: ShellSuite, only?: readonly string[]): ShellSuite {
  return { ...suite, pages: suite.pages.map((p) => (!only || only.includes(p.id) ? { ...p, own: true } : p)) };
}

/** Group starts: Studio after 02 and 05; Business after 02; Viral after 02; Atomik after 01 and 04. */
export const SHELL_SUITES: ShellSuite[] = [
  /* Brief, Boards, Astra and Deliver are the shell's own stage views (over the existing tools); the phone home too. */
  own(withHome(build("studio", "Studio", "STUDIO", "Particl Production Studio", "particl", [2, 5], [
    ["brief", "Brief", "Brief & Script", "Find the story", "brief"],
    ["boards", "Boards", "Boards", "Plan every frame", "boards"],
    ["cast", "Cast", "Cast & Elements", "Keep identity consistent", "cast"],
    ["astra", "Astra", "Astra 3D", "Block before you render", "astra"],
    ["rig", "Rig", "Rig", "Bring it all together", "rig"],
    ["takes", "Takes", "Takes", "Select the right take", "takes"],
    ["edit", "Edit", "Edit & Sound", "Shape the story", "edit"],
    ["deliver", "Deliver", "Deliver", "Ready for the next room", "deliver"],
  ])), ["brief", "boards", "astra", "deliver"]),
  /* Business pages are the shell's own views (step 2); `marketing` remains the state page behind them. */
  own(build("business", "Business", "BUSINESS", "Moleculr Business Suite · Marketing Studio", "moleculr", [2], [
    ["ads", "Ads", "Marketing Studio", "Branded video: a product, who presents it, an optional hook or setting — or one ad reference — and the mode", "marketing"],
    ["dtc", "Image ads", "Image ads", "Branded stills over your avatars and products", "marketing"],
    ["setup", "Setup", "Setup items", "Products · avatars · hooks · settings · references · brand kits", "marketing"],
  ])),
  /* Viral pages are the shell's own views (step 3) on the existing genjutsu-service. */
  own(build("viral", "Viral", "VIRAL", "Subatomik Viral Studio · Genjutsu", "subatomik", [2], [
    ["motion", "Motion Transfer", "Motion Transfer", "Recast the motion you own", "motion"],
    ["swap", "Object Swap", "Object Swap", "One element replaced", "swap"],
    ["history", "History", "History", "Every result, retained as original bytes", "history"],
  ])),
  /* Skills is the shell's own view (step 5: the higgsfield-ai/skills packs); the rest stay legacy bodies for now. */
  own(build("atomik", "Atomik", "SUPERCOMPUTER", "Atomik Supercomputer", "atomik", [1, 4], [
    ["agent", "Agent", "Agent", "Plan, price, then run", "agent"],
    ["runs", "Runs", "Runs", "Durable, recoverable, accounted", "runs"],
    ["approvals", "Approvals", "Approvals", "Nothing paid without a gate", "approvals"],
    ["budget", "Budget", "Budget", "Settled accounting, not estimates", "budget"],
    ["models", "Models", "Models", "Thinking for planning, engines for output", "models"],
    ["skills", "Skills", "Skills", "Tool packs the agent can reach", "skills"],
  ]), ["skills"]),
];

/** Header segment order: Studio | Gen | Business | Viral | Atomik | Crew. Gen and Crew are views, not suites. */
export const HEADER_SEGMENT: { id: ShellSuiteId | "gen" | "crew"; label: string; title: string }[] = [
  { id: "studio", label: "Studio", title: "Particl Production Studio" },
  { id: "gen", label: "Gen", title: "Generate" },
  { id: "business", label: "Business", title: "Moleculr Business Suite · Marketing Studio" },
  { id: "viral", label: "Viral", title: "Subatomik Viral Studio · Genjutsu" },
  { id: "atomik", label: "Atomik", title: "Atomik Supercomputer" },
  /* Crew is a module with its own tables and pages, not a production suite (CREW_ADDENDUM.md). */
  { id: "crew", label: "Crew", title: "Crew" },
];

export const WORKSPACE_TABS: { id: WorkspaceTabId; label: string; href: string }[] = [
  { id: "general", label: "General", href: "/settings" },
  { id: "people", label: "People", href: "/team" },
  { id: "credits", label: "Plans & credits", href: "/billing" },
  { id: "usage", label: "Usage", href: "/usage" },
  { id: "engines", label: "Engines", href: "/management/engines" },
  { id: "security", label: "Security", href: "/account/security" },
];

export function isShellSuite(value: unknown): value is ShellSuiteId {
  return typeof value === "string" && SHELL_SUITES.some((s) => s.id === value);
}
export function shellSuite(id: ShellSuiteId): ShellSuite {
  return SHELL_SUITES.find((s) => s.id === id)!;
}
export function shellPage(suite: ShellSuiteId, page: string | null | undefined): ShellPage | null {
  return shellSuite(suite).pages.find((p) => p.id === page) ?? null;
}
export function firstShellPage(suite: ShellSuiteId): ShellPage {
  return shellSuite(suite).pages[0];
}
/** A suite's remembered page, or its first when the memory is stale (README › Navigation). */
export function restorePage(suite: ShellSuiteId, remembered: string | null | undefined): ShellPage {
  return shellPage(suite, remembered) ?? firstShellPage(suite);
}
/** The shell suite that fronts one of the state layer's suites. */
export function suiteOfLegacy(legacy: Suite): ShellSuiteId {
  return SHELL_SUITES.find((s) => s.legacy === legacy)!.id;
}
/**
 * The shell page showing a given state-layer page. Several Business pages share
 * one backing page until step 5, so a hint (the page the shell last showed in
 * that suite) decides between them.
 */
export function pageOfLegacy(legacy: Suite, page: PageId, hint?: string | null): ShellPage | null {
  const suite = shellSuite(suiteOfLegacy(legacy));
  const matches = suite.pages.filter((p) => p.legacy.page === page);
  return matches.find((p) => p.id === hint) ?? matches[0] ?? null;
}
export const ALL_SHELL_PAGES: { suite: ShellSuite; page: ShellPage }[] = SHELL_SUITES.flatMap((suite) => suite.pages.map((page) => ({ suite, page })));

/** Crew's own strip: 01 Room · 02 Members · 03 Sessions, with the prototype's titles and hints. */
export type CrewPageId = "room" | "members" | "sessions";
export const CREW_PAGES: { id: CrewPageId; n: string; label: string; title: string; hint: string }[] = [
  { id: "room", n: "01", label: "Room", title: "Crew", hint: "A room of Grok agents, one per department. They propose, challenge each other, then the chair converges." },
  { id: "members", n: "02", label: "Members", title: "Members", hint: "Role cards the room can seat. Each is one agent with its own stance and effort." },
  { id: "sessions", n: "03", label: "Sessions", title: "Sessions", hint: "Every room this project has run, with its solutions and settled cost." },
];
export function isCrewPage(value: unknown): value is CrewPageId {
  return CREW_PAGES.some((p) => p.id === value);
}
