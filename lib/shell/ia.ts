import type { PageId, Suite } from "@/lib/workspace/types";

/**
 * The Suites shell's information architecture (design/particl-graphite/README.md
 * › Information architecture). Four suites plus two views that are not suites
 * (Gen, Workspace). Every page maps onto a page the state layer already knows
 * (lib/workspace/pages.ts), so navigation, selection repair and the page
 * bodies are reused rather than rebuilt; the map narrows as later build steps
 * give Business and Viral their own composers.
 */
export type ShellSuiteId = "studio" | "business" | "viral" | "atomik";
export type ShellView = "suite" | "gen" | "workspace" | "crew";
export type WorkspaceTabId = "general" | "people" | "credits" | "usage" | "dashboard" | "engines" | "security";

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
  /** The shell renders its own Graphite view for this page (Business from step 2, Viral from step 3, Atomik › Tools & connections); the legacy mapping only feeds state. */
  own?: boolean;
  /** Never a tab in the stage strip: the phone's Home, and the Studio home (the phone's stage grid; on a desktop, where the mark goes). */
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
 * The two screens outside the strip (design/particl-graphite/README.md › Phone): `home` is the phone's
 * suite picker — "Where to?" — that the Home tab and the phone's mark return
 * to; `stages` is the Studio home: the stage grid behind the phone's Studio
 * tile (with a Home back), and where the mark goes on a desktop. Both share
 * Brief's backing page.
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

/** Group starts: Studio after 03 and 07; Business after 01 and 02; Viral after 02; Atomik after 01 and 04. */
export const SHELL_SUITES: ShellSuite[] = [
  /* Brief, Boards, 3D blocking and Deliver are the shell's own stage views (over the existing tools); the phone home too. */
  own(withHome(build("studio", "Studio", "STUDIO", "Studio", "particl", [3, 7], [
    ["brief", "Brief", "Brief & Script", "Find the story", "brief"],
    /* Beats shares Brief's backing page; the shell renders its own view (production/BeatsStage). */
    ["beats", "Beats", "Beats & Shots", "Break it into beats and shots", "brief"],
    ["boards", "Storyboards", "Storyboards", "Every shot, framed", "boards"],
    /* Owner, 24 September: where the world is built, before Cast & Elements. The shell renders its own
       view (production/EnvironmentStage) and shares Storyboards' backing page, as Beats shares Brief's. */
    ["environment", "Environment", "Environment", "Build the world", "boards"],
    ["cast", "Cast", "Cast & Elements", "Characters that stay themselves", "cast"],
    ["astra", "3D blocking", "3D blocking", "Block before you render", "astra"],
    ["rig", "Board", "Board", "Bring it all together", "rig"],
    /* Owner's notes (23 September): Takes holds every take and edits them; Edit & Sound holds the cut and the sound.
       Idea 6: Takes is the review desk every "Filed in Takes for review" points at. */
    ["takes", "Takes", "Takes", "Review every take", "takes"],
    ["edit", "Edit & Sound", "Edit & Sound", "Cut the takes, add the sound", "edit"],
    ["deliver", "Deliver", "Deliver", "EDL · XML · the final movie", "deliver"],
  ])), ["brief", "beats", "boards", "environment", "cast", "astra", "takes", "deliver"]),
  /* Business pages are the shell's own views (step 2); `marketing` remains the state page behind them.
     Image ads, then Setup, then Particl's own tools (lib/shell/business-own.ts). The suite opens on
     Image ads; the Ads page is gone (design/particl-graphite/README.md › What this design removes),
     and an old `sp=ads` link lands on Image ads (SHELL_PAGE_ALIASES). */
  own(build("business", "Ads", "ADS", "Ads", "moleculr", [1, 2], [
    ["dtc", "Image ads", "Image ads", "Branded stills from your products and references", "marketing"],
    ["setup", "Setup", "Setup items", "Saved products, brand kit and reference ad", "marketing"],
    ["brand", "Brand", "Brand kit", "Read from your website, reviewed before it is used", "marketing"],
    ["product", "Product", "Product profiles", "Approved facts and original photographs", "marketing"],
    ["format", "Format", "Creative briefs", "Eighteen briefs in six formats, made in Make", "marketing"],
    ["hooks", "Hooks", "Hooks", "Up to twelve opening lines, written against the brief", "marketing"],
    ["reference", "Reference", "Reference ad", "A video you own, reviewed for what to adapt", "marketing"],
    ["design", "Design", "Poster designer", "Editable layers, exported as a full-size PNG", "marketing"],
  ])),
  /* Viral pages are the shell's own views (step 3), run on Particl's API key through /api/generate (Motion transfer and Object swap on the key). */
  own(build("viral", "Social", "SOCIAL", "Social", "subatomik", [2], [
    ["motion", "Motion transfer", "Motion transfer", "Recast the motion you own", "motion"],
    ["swap", "Object swap", "Object swap", "One element replaced", "swap"],
    ["history", "History", "History", "Every result, retained as original bytes", "history"],
  ])),
  /* Tools & connections is the shell's own view (it replaced the step-5 pack list, whose packs now sit
     under its Claude & ChatGPT tab): what Atomik can reach, with live status, and Particl's own MCP
     server and tokens. The page id stays `skills`, so every old link still lands here.
     Memory is the shell's own view too: what Atomik keeps in mind. It shares
     Agent's backing page, as Beats shares Brief's, so `sp=memory` tells the two apart.
     Skills (saved runs, run again with new words) is the same kind of page, beside Memory; its id is
     `saved-skills` because `skills` has always meant Tools & connections. */
  /* Owner, 28 September 2026: "Just Atomik agent". */
  own(build("atomik", "Atomik", "AGENT", "Atomik Agent", "atomik", [1, 4], [
    ["agent", "Agent", "Agent", "Plan, price, then run", "agent"],
    ["runs", "Activity", "Activity", "Durable, recoverable, accounted", "runs"],
    ["approvals", "Approvals", "Approvals", "Nothing paid without a gate", "approvals"],
    ["budget", "Budget", "Budget", "Settled accounting, not estimates", "budget"],
    ["models", "Models", "Models", "Thinking for planning, engines for output", "models"],
    ["skills", "Tools", "Tools & connections", "What Atomik reaches, and what reaches Particl", "skills"],
    ["memory", "Memory", "Memory", "Brand, audience and references Atomik keeps in mind", "agent"],
    ["saved-skills", "Skills", "Skills", "Saved runs, run again with new words", "agent"],
  ]), ["skills", "memory", "saved-skills"]),
];

/**
 * Header option B (design/particl-graphite/README.md § 1): Home · <the current project> · Make · Atomik.
 * Studio, Ads and Social become templates picked on Home, so no suite is a header destination. Until the
 * packages that build the new screens ship, each segment opens today's page for it (Header.tsx):
 * Home the Studio overview (Home of its own is U1), the project its current Studio page (the board is S3),
 * Make today's Gen (the panel is D0 PR 5) and Atomik today's Atomik suite (the control room is D1).
 * The suites above stay as the bridge: their pages are reached from ⌘K and the page strip until S3, S4 and D1.
 */
export type HeaderSegmentId = "home" | "project" | "make" | "atomik";
export const HEADER_SEGMENT: { id: HeaderSegmentId; label: string; title: string }[] = [
  { id: "home", label: "Home", title: "Home · what needs you" },
  /* The live header shows the open project's name here, with its swatch; "Project" is what a page without one says. */
  { id: "project", label: "Project", title: "The current project" },
  { id: "make", label: "Make", title: "Make" },
  { id: "atomik", label: "Atomik", title: "Atomik" },
];

/**
 * The board's regions (design/particl-graphite/README.md § 1.1: Brief · Looks · Storyboard · Shots · Cast · Cut · Deliver), each
 * with today's nearest page. They open that page until the board lands (README § 1.2 says where each old page goes). ⌘K lists them.
 */
export type BoardRegionId = "brief" | "looks" | "storyboard" | "shots" | "cast" | "cut" | "deliver";
export const BOARD_REGIONS: { id: BoardRegionId; label: string; opens: { suite: ShellSuiteId; page: string } }[] = [
  { id: "brief", label: "Brief", opens: { suite: "studio", page: "brief" } },
  { id: "looks", label: "Looks", opens: { suite: "studio", page: "boards" } },
  { id: "storyboard", label: "Storyboard", opens: { suite: "studio", page: "boards" } },
  { id: "shots", label: "Shots", opens: { suite: "studio", page: "takes" } },
  { id: "cast", label: "Cast", opens: { suite: "studio", page: "cast" } },
  { id: "cut", label: "Cut", opens: { suite: "studio", page: "edit" } },
  { id: "deliver", label: "Deliver", opens: { suite: "studio", page: "deliver" } },
];

/**
 * Settings in the five sections the design draws (README § 3.5), each with the page that holds it today (Settings itself is D1).
 * The avatar menu and ⌘K list the same five.
 */
export type SettingsSectionId = "team" | "credits" | "rules" | "connections" | "advanced";
export const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; opens: { workspace: WorkspaceTabId } | { suite: ShellSuiteId; page: string } }[] = [
  { id: "team", label: "Team", opens: { workspace: "people" } },
  { id: "credits", label: "Plan & credits", opens: { workspace: "credits" } },
  { id: "rules", label: "Spending rules", opens: { suite: "atomik", page: "budget" } },
  { id: "connections", label: "Connections", opens: { suite: "atomik", page: "skills" } },
  { id: "advanced", label: "Advanced", opens: { workspace: "engines" } },
];

export const WORKSPACE_TABS: { id: WorkspaceTabId; label: string; href: string }[] = [
  { id: "general", label: "General", href: "/settings" },
  { id: "people", label: "People", href: "/team" },
  { id: "credits", label: "Plans & credits", href: "/billing" },
  { id: "usage", label: "Usage", href: "/usage" },
  { id: "dashboard", label: "Dashboard", href: "/usage" },
  { id: "engines", label: "Engines", href: "/management/engines" },
  { id: "security", label: "Security", href: "/account/security" },
];

export function isShellSuite(value: unknown): value is ShellSuiteId {
  return typeof value === "string" && SHELL_SUITES.some((s) => s.id === value);
}
export function shellSuite(id: ShellSuiteId): ShellSuite {
  return SHELL_SUITES.find((s) => s.id === id)!;
}
/**
 * Page ids that left the strip, and the page an old link (`sp=<id>`) or a remembered page lands on instead.
 * Business › Ads was removed; Business opens on Image ads.
 */
export const SHELL_PAGE_ALIASES: Readonly<Partial<Record<ShellSuiteId, Readonly<Record<string, string>>>>> = { business: { ads: "dtc" } };
/** The page id a retired id stands for in this suite, or null when the id is not a retired one. */
export function pageAlias(suite: ShellSuiteId, page: string | null | undefined): string | null {
  const aliases = SHELL_PAGE_ALIASES[suite];
  return page && aliases && Object.hasOwn(aliases, page) ? aliases[page] : null;
}
export function shellPage(suite: ShellSuiteId, page: string | null | undefined): ShellPage | null {
  const id = pageAlias(suite, page) ?? page;
  return shellSuite(suite).pages.find((p) => p.id === id) ?? null;
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
  /* A retired id in the hint (an old `sp=ads` link) is the page that replaced it. */
  const wanted = pageAlias(suite.id, hint) ?? hint;
  /* With no hint, the stage named like its backing page wins (Storyboards over Environment, Brief over Beats). */
  return matches.find((p) => p.id === wanted) ?? matches.find((p) => p.id === page) ?? matches[0] ?? null;
}
export const ALL_SHELL_PAGES: { suite: ShellSuite; page: ShellPage }[] = SHELL_SUITES.flatMap((suite) => suite.pages.map((page) => ({ suite, page })));

/** Crew's own strip: 01 Room · 02 Members · 03 Sessions, with the prototype's titles and hints. */
export type CrewPageId = "room" | "members" | "sessions";
export const CREW_PAGES: { id: CrewPageId; n: string; label: string; title: string; hint: string }[] = [
  { id: "room", n: "01", label: "Room", title: "Crew review", hint: "A room of Grok agents, one per department. They propose, challenge each other, then the chair converges." },
  { id: "members", n: "02", label: "Members", title: "Members", hint: "Role cards the room can seat. Each is one agent with its own stance and effort." },
  { id: "sessions", n: "03", label: "Sessions", title: "Sessions", hint: "Every room this project has run, with its solutions and settled cost." },
];
export function isCrewPage(value: unknown): value is CrewPageId {
  return CREW_PAGES.some((p) => p.id === value);
}

/* ── Old links → new (README § 1.2) ─────────────────────────────────────────
   Every old page and deep link either lands somewhere new (OLD_TO_NEW) or is
   still served by its old page until the package that replaces it ships
   (PENDING). A row moves from PENDING to OLD_TO_NEW in the PR that ships its
   replacement, never before: no link is sent to a screen that does not exist.
   The only rows live today are normalisations: the design file's spellings of
   a page (`?suite=studio&page=beats`) rewritten to the app's (`?suite=particl&page=brief&sp=beats`),
   so a link copied from the handoff opens the page it names. They are applied
   on the server before the shell renders (app/suites/page.tsx) and again on the
   client as the shell lands (lib/shell/state.tsx). Every other param rides along. */

/** The package that ships a row's replacement: D0 PRs 3 and 5, Home (U1), the Studio board (S3), the Ads and Social boards and Crew review (S4), the control room and Settings (D1). */
export type Ships = "D0-3" | "D0-5" | "U1" | "S3" | "S4" | "D1";

export type OldToNew = { from: string; to: string; ships: Ships };
export type Pending = {
  /** A `/suites` search (`?…`) or an old route (`/path`, as docs/old-shells.md lists it). */
  from: string;
  /** What README § 1.2 (or docs/old-shells.md) says it becomes. */
  becomes: string;
  ships: Ships;
};

/** The path the shell serves; old links are rewritten only there. */
export const SHELL_PATH = "/suites";

/** The design file's suite names, its own aliases, and former spellings, to the state layer's ids (lib/workspace/pages.ts › SUITE_ALIASES agrees). */
const SUITE_SPELLING: Readonly<Record<string, Suite>> = {
  studio: "particl", business: "moleculr", ads: "moleculr", viral: "subatomik", social: "subatomik", subatomic: "subatomik", agent: "atomik",
};
/** Design page ids that are shell pages over another backing page: [backing page, shell page]. Anything else the app reads as it is. */
const DESIGN_PAGES: Readonly<Partial<Record<Suite, Readonly<Record<string, readonly [PageId, string]>>>>> = {
  particl: { stages: ["brief", "stages"], beats: ["brief", "beats"], env: ["boards", "environment"], environment: ["boards", "environment"] },
  moleculr: Object.fromEntries(shellSuite("business").pages.map((p) => [p.id, ["marketing", p.id] as const])),
  atomik: { memory: ["agent", "memory"], "saved-skills": ["agent", "saved-skills"] },
};
/** The design file's view names for today's views. */
const VIEW_SPELLING: Readonly<Record<string, ShellView>> = { make: "gen" };
/** Params the design file sets that no screen reads any more: the Library and Inspector columns are not toggled by URL. */
const DROPPED_PARAMS = ["lib", "insp"] as const;
const WORKSPACE_TAB_IDS: readonly string[] = ["general", "people", "credits", "usage", "dashboard", "engines", "security"] satisfies WorkspaceTabId[];

function rewrite(search: string): { q: URLSearchParams; changed: boolean } {
  const q = new URLSearchParams(search);
  let changed = false;
  const set = (key: string, value: string) => { if (q.getAll(key).length !== 1 || q.get(key) !== value) { q.set(key, value); changed = true; } };
  const drop = (key: string) => { if (q.has(key)) { q.delete(key); changed = true; } };

  for (const key of DROPPED_PARAMS) drop(key);
  /* `&palette=1` opens ⌘K; the shell's word for it is `find=1`. */
  if (q.get("palette") === "1") { drop("palette"); set("find", "1"); }

  const view = q.get("view");
  if (view && Object.hasOwn(VIEW_SPELLING, view)) set("view", VIEW_SPELLING[view]);
  /* Crew's page is `cp`; the design file says `crew`. */
  if (q.get("view") === "crew" && q.has("crew")) {
    const page = q.get("crew");
    drop("crew");
    if (isCrewPage(page)) set("cp", page);
  }
  /* Workspace's section is `tab`. The design file says `ws`, which the shell keeps for the workspace a link was copied in
     (lib/shell/asset-link.ts): only an old section name on the Workspace view, with no take linked, is a section. */
  const ws = q.get("ws");
  if (q.get("view") === "workspace" && ws && WORKSPACE_TAB_IDS.includes(ws) && !q.has("asset")) { drop("ws"); set("tab", ws); }

  const raw = q.get("suite");
  const suite = raw && Object.hasOwn(SUITE_SPELLING, raw) ? SUITE_SPELLING[raw] : raw;
  if (raw && suite !== raw) set("suite", suite!);
  const page = q.get("page");
  const pages = suite ? DESIGN_PAGES[suite as Suite] : undefined;
  if (page && pages && Object.hasOwn(pages, page)) {
    const [backing, shellId] = pages[page];
    set("page", backing);
    set("sp", shellId);
  }
  return { q, changed };
}

/** A `/suites` search with the design file's spellings rewritten to the app's; every other param kept. Idempotent. */
export function normalize(search: string): string {
  const { q } = rewrite(search);
  const text = q.toString();
  return text ? `?${text}` : "";
}

/** Where an old link on `pathname` goes instead, or null when it is served where it is. Never a chain: the target needs no redirect. */
export function redirectFor(pathname: string, search: string): string | null {
  if (pathname !== SHELL_PATH) return null;
  const { q, changed } = rewrite(search);
  if (!changed) return null;
  const text = q.toString();
  return SHELL_PATH + (text ? `?${text}` : "");
}

const N = (from: string, to: string): OldToNew => ({ from, to, ships: "D0-3" });
/** The rows live today (README § 1.2, design form → app form). `normalize(from)` is `to` for each; tests/unit/shellRedirects.spec.ts holds it to that. */
export const OLD_TO_NEW: readonly OldToNew[] = [
  N("?suite=studio&page=stages", "?suite=particl&page=brief&sp=stages"),
  N("?suite=studio&page=brief", "?suite=particl&page=brief"),
  N("?suite=studio&page=beats", "?suite=particl&page=brief&sp=beats"),
  N("?suite=studio&page=boards", "?suite=particl&page=boards"),
  N("?suite=studio&page=env", "?suite=particl&page=boards&sp=environment"),
  N("?suite=studio&page=environment", "?suite=particl&page=boards&sp=environment"),
  ...["cast", "astra", "rig", "takes", "edit", "deliver"].map((p) => N(`?suite=studio&page=${p}`, `?suite=particl&page=${p}`)),
  N("?suite=studio&page=rig&rig=list", "?suite=particl&page=rig&rig=list"),
  N("?suite=studio&page=beats&beats=graph", "?suite=particl&page=brief&beats=graph&sp=beats"),
  ...["dtc", "setup", "brand", "product", "reference", "format", "hooks", "design"].map((p) => N(`?suite=business&page=${p}`, `?suite=moleculr&page=marketing&sp=${p}`)),
  ...["motion", "swap", "history"].map((p) => N(`?suite=viral&page=${p}`, `?suite=subatomik&page=${p}`)),
  ...["memory", "saved-skills"].map((p) => N(`?suite=atomik&page=${p}`, `?suite=atomik&page=agent&sp=${p}`)),
  ...["room", "members", "sessions"].map((p) => N(`?view=crew&crew=${p}`, `?view=crew&cp=${p}`)),
  ...WORKSPACE_TAB_IDS.map((t) => N(`?view=workspace&ws=${t}`, `?view=workspace&tab=${t}`)),
  /* The master's own aliases (docs/handoff-diff.md § 2): Ads and Social are Business and Viral, Make is Gen. */
  N("?suite=ads", "?suite=moleculr"),
  N("?suite=social", "?suite=subatomik"),
  N("?view=make", "?view=gen"),
  /* No-ops: the Library and Inspector are not toggled by URL; ⌘K opens with `find`. */
  N("?lib=0", ""),
  N("?lib=assets", ""),
  N("?insp=0", ""),
  N("?palette=1", "?find=1"),
];

const P = (ships: Ships, becomes: string, ...from: string[]): Pending[] => from.map((f) => ({ from: f, becomes, ships }));
/**
 * Old links still served by their old page, each with the package that retires it (README § 1.2 in the app's
 * form, and every route in docs/old-shells.md). Old routes are retired in D1, once every replacement exists.
 */
export const PENDING: readonly Pending[] = [
  ...P("U1", "Home `?view=home` (projects as cards)", "?suite=particl&page=brief&sp=stages"),
  ...P("S3", "Studio board › Brief `frame=d`; questions `frame=b`", "?suite=particl&page=brief"),
  ...P("S3", "Studio board › Storyboard; the shot list is the board's List view", "?suite=particl&page=brief&sp=beats"),
  ...P("S3", "The board itself", "?suite=particl&page=brief&sp=beats&beats=graph"),
  ...P("S3", "Studio board › Storyboard `frame=d`; Looks `frame=c`", "?suite=particl&page=boards"),
  ...P("S3", "Studio board › Cast region (Cast, Environment and Elements cards) `frame=h`", "?suite=particl&page=boards&sp=environment"),
  ...P("S3", "Studio board › Cast `frame=h`", "?suite=particl&page=cast"),
  ...P("S3", "3D blocking, a tool on a shot card (Inspector › Advanced)", "?suite=particl&page=astra"),
  ...P("S3", "The board itself `?view=board` and its List view", "?suite=particl&page=rig", "?suite=particl&page=rig&rig=list"),
  ...P("S3", "Shots region, Review mode, Make › Recent", "?suite=particl&page=takes"),
  ...P("S3", "Cut region `frame=i`", "?suite=particl&page=edit"),
  ...P("S3", "Deliver card `frame=i`", "?suite=particl&page=deliver"),
  ...P("D0-5", "Make panel `make=1 | image | audio`; the model sheet is Change on the engine line; edit and upscale are card actions",
    "?view=gen", "?view=gen&mode=video", "?view=gen&mode=images", "?view=gen&mode=audio", "?view=gen&task=edit", "?view=gen&task=upscale", "?view=gen&sheet=1"),
  ...P("S4", "Ads board `kind=ads&frame=2` (image ad group)", "?suite=moleculr&page=marketing&sp=dtc"),
  ...P("S4", "Ads board `frame=1` cards", ...["setup", "brand", "product", "reference"].map((p) => `?suite=moleculr&page=marketing&sp=${p}`)),
  ...P("S4", "Ads board `frame=2` (Hooks card, Format briefs card)", ...["format", "hooks"].map((p) => `?suite=moleculr&page=marketing&sp=${p}`)),
  ...P("S4", "Ads board `frame=3` (the poster Designer)", "?suite=moleculr&page=marketing&sp=design"),
  ...P("S4", "Make › Motion transfer / Object swap; Social board Effects card", "?suite=subatomik&page=motion", "?suite=subatomik&page=swap"),
  ...P("S4", "Make › Recent and the board's History drawer", "?suite=subatomik&page=history"),
  ...P("S4", "Crew review inside a board `frame=m`; sessions in the Project record `frame=n`", "?view=crew&cp=room", "?view=crew&cp=members", "?view=crew&cp=sessions"),
  ...P("D1", "Atomik's panel (`&atomik=1` on any screen); the plan card on the board", "?suite=atomik&page=agent"),
  ...P("D1", "Control room › Activity (same URL)", "?suite=atomik&page=runs"),
  ...P("D1", "Control room › Approvals (same URL)", "?suite=atomik&page=approvals"),
  ...P("D1", "Settings › Spending rules `?view=workspace&ws=rules`", "?suite=atomik&page=budget"),
  ...P("D1", "Settings › Advanced › Models", "?suite=atomik&page=models"),
  ...P("D1", "Settings › Connections and Advanced › Tools", "?suite=atomik&page=skills"),
  ...P("D1", "Control room › Memory, Skills (same URLs)", "?suite=atomik&page=agent&sp=memory", "?suite=atomik&page=agent&sp=saved-skills"),
  ...P("D1", "Settings in five sections: Team, Plan & credits, Spending rules, Connections, Advanced; Dashboard → Activity",
    ...WORKSPACE_TAB_IDS.map((t) => `?view=workspace&tab=${t}`)),
  ...P("U1", "⌘K with Atomik's commands (go to, make, approve under N cr)", "?find=1"),
  /* docs/old-shells.md: the older shells' routes, retired in D1. */
  ...P("D1", "Its /suites page (docs/old-shells.md)",
    "/workspace", "/workbench", "/workbench/movie", "/", "/atomik", "/subatomik", "/subatomic", "/generate", "/images", "/audio", "/make/[kind]", "/studio/shot",
    "/library", "/all", "/productions", "/productions/[prod]/[project]/media", "/productions/[prod]/[project]/shots", "/projects/[id]", "/projects/[id]/canvas",
    "/canvas/[id]", "/projects/[id]/rig/elements", "/rig/canvas/[boardId]", "/rig/recipes/[projectId]", "/rig/run/[runId]", "/pipelines", "/takes/[id]", "/shots/[id]",
    "/elements/[id]", "/atomik/ideas", "/atomik/treatment", "/atomik/breakdown", "/atomik/shots", "/settings", "/team", "/usage", "/dashboard", "/statements/[month]",
    "/connect", "/admin", "/platform", "/report", "/policy", "/privacy", "/terms"),
];
