import { moleculrSection } from "@/lib/suites";
import { resolvePageId, resolveSuite, suiteOfPage } from "@/lib/workspace/pages";
import type { Suite } from "@/lib/workspace/types";
import { route } from "./screens";

/**
 * The old routes, and where each one goes now (Release 1: one design, the old pages are not reachable).
 *
 * Pure: no React, no fetch. `planOldRoute(pathname, search)` names the plan for an old address; the pages under `app/`
 * carry it out (lib/shell/old-routes.server.ts), and tests/unit/r1OldRoutes.spec.ts holds the table.
 *
 * Every target is FINAL: it is run through the shell's own screen pipeline (lib/shell/screens.ts › route), the same one
 * `/suites` applies, so an old link lands in one redirect and `/suites` has nothing left to move.
 *
 * Owner, 6 October evening: no old page survives Release 1. The rows the audit left as KEEP or "owner to confirm"
 * (/projects/[id], /takes, /shots, /elements, /atomik/ideas|treatment|breakdown|shots, /studio/shot, /workbench/movie) are
 * redirected too, 307 so the owner can still move them; only the page goes, never its data.
 *
 * What stays where it is (never redirected here): /statements, /admin, /platform, /report, the legal, auth and account
 * pages (/login, /signup, /reset, /invite, /setup, /welcome, /account/security, /billing, /pricing), the review pages and /site/*.
 */

export const SHELL_PATH = "/suites";

export type OldRoutePlan = {
  /** The route family, for the unit table and the docs. */
  id: string;
  /**
   * 308 when true. Every row is temporary (307) in Release 1: no row is final until the owner has decided the places
   * the audit leaves open (the cross-production library, the per-project spend cap, saved treatment drafts).
   */
  permanent: boolean;
  /** A production-side id the old address names, to turn into the Studio project the shell opens. Null for none. */
  lookup: { kind: "production-project" | "board" | "take" | "shot" | "element"; id: string } | null;
  /** The address, given the Studio project the lookup found (null when it found none, or there was nothing to look up). */
  to: (project: string | null) => string;
};

/** Params the old shell read that mean nothing now: its escape, its New-project dialog flag. */
const DROPPED = new Set(["shell", "new"]);

const settle = (q: URLSearchParams): string => `${SHELL_PATH}${route(q.toString())}`;

const plan = (id: string, to: (project: string | null) => string, lookup: OldRoutePlan["lookup"] = null): OldRoutePlan => ({ id, permanent: false, lookup, to });
/** A plan with nothing to look up and one fixed address. */
const fixed = (id: string, search: string): OldRoutePlan => plan(id, () => settle(new URLSearchParams(search)));

/** Params an entry point carries on to the shell: everything but the ones it reads itself, and the dead ones. */
function carried(from: URLSearchParams, consumed: readonly string[]): [string, string][] {
  return [...from].filter(([key]) => !consumed.includes(key) && !DROPPED.has(key));
}

/** The Business section a `?suite=moleculr&page=<section>` link named, as the Ads setup page that holds it (lib/shell/ia.ts). */
const ADS_PAGE: Readonly<Record<string, string>> = { product: "product", brand: "brand", format: "format", design: "design" };

/** The pages of Atomik and of Social that still have an address (Shorts, Sources, Compare, Recipes and Builds have none: they open the suite's first). */
const ATOMIK_PAGES: readonly string[] = ["approvals", "runs", "agent", "budget", "models", "skills"];
const SOCIAL_PAGES: readonly string[] = ["motion", "swap", "history"];

/* ── The entry points (/, /workbench, /workspace, /atomik, /subatomik) ─────────────────────────────────────────────────── */

type Entry = "/" | "/workbench" | "/workspace" | "/atomik" | "/subatomik";

/**
 * The suite and page an entry point's address names, in the state layer's words. /workbench named a Studio `stage`; the
 * other entry points a `suite` and a `page`, which /atomik and /subatomik knew from their path.
 */
function named(entry: Entry, from: URLSearchParams): { suite: Suite; page: string | null } {
  if (from.get("atomik") === "marketing" || (entry === "/workbench" && resolveSuite(from.get("suite")) === "moleculr"))
    return { suite: "moleculr", page: from.get("page") };
  if (entry === "/workbench") return { suite: "particl", page: from.get("stage") };
  if (entry === "/atomik") return { suite: "atomik", page: from.get("page") };
  if (entry === "/subatomik") return { suite: "subatomik", page: from.get("page") };
  return { suite: resolveSuite(from.get("suite")) ?? "particl", page: from.get("page") };
}

function entryAddress(entry: Entry, from: URLSearchParams): string {
  const to = new URLSearchParams();
  const project = from.get("project");
  if (project) to.set("project", project);
  const { suite, page: asked } = named(entry, from);
  const consumed = ["project", "suite", "page", "stage", "sel", ...(from.get("atomik") === "marketing" ? ["atomik"] : [])];
  const page = resolvePageId(asked);

  if (suite === "moleculr") {
    /* Business is the Ads board; the section a link named is the setup card that holds it. */
    to.set("suite", "moleculr");
    to.set("page", "marketing");
    const section = moleculrSection(asked);
    if (section && ADS_PAGE[section]) to.set("sp", ADS_PAGE[section]);
  } else if (suite === "atomik") {
    /* Atomik's own page is the panel (`atomik=1`); the control room's pages keep their addresses. */
    to.set("suite", "atomik");
    to.set("page", page && ATOMIK_PAGES.includes(page) ? page : "agent");
    if (asked === "memory" || asked === "saved-skills") to.set("sp", asked);
  } else if (suite === "subatomik") {
    /* Motion transfer and Object swap are Make's quick tools, History is the Social board's drawer. */
    to.set("suite", "subatomik");
    to.set("page", page && SOCIAL_PAGES.includes(page) ? page : "motion");
  } else if (page) {
    /* A Studio stage is the board's region that took its job (lib/shell/stage-redirects.ts); no stage is Home. */
    to.set("suite", suiteOfPage(page));
    to.set("page", page);
    const sel = from.get("sel");
    if (sel) to.set("sel", sel);
  }
  for (const [key, value] of carried(from, consumed)) to.append(key, value);
  return settle(to);
}

/* ── Make ───────────────────────────────────────────────────────────────────────────────────────────────────────────── */

const MAKE_KIND: Readonly<Record<string, "video" | "image" | "audio">> = { video: "video", images: "image", image: "image", audio: "audio" };

/** The old Gen page's `mode=` (and the redirect pages' kind) as Make's tab, or null for a kind Make has not got. */
export const makeKindOf = (kind: string | null | undefined): "video" | "image" | "audio" | null =>
  kind && Object.hasOwn(MAKE_KIND, kind) ? MAKE_KIND[kind] : null;

/** `/generate`, `/images`, `/audio` and `/make/<kind>`: Make's panel on that tab, with the project and every handoff param kept. */
function make(kind: "video" | "image" | "audio", from: URLSearchParams): string {
  const to = new URLSearchParams();
  for (const [key, value] of from) if (key !== "mode" && key !== "make" && key !== "view" && !DROPPED.has(key)) to.append(key, value);
  to.set("make", kind);
  return settle(to);
}

/* ── The plan for an address ────────────────────────────────────────────────────────────────────────────────────────── */

/** The board of a Studio project (or one of its regions), or Home when the old address named a project that has no Studio project. */
const boardOf = (project: string | null, region?: string): string =>
  settle(new URLSearchParams(project ? { project, view: "board", ...(region ? { region } : {}) } : { view: "home" }));

/**
 * The plan for an old address, or null when the address is not one that is redirected (it is served where it is, or it is
 * not an old route). `search` is the query string, with or without its `?`.
 */
export function planOldRoute(pathname: string, search = ""): OldRoutePlan | null {
  const from = new URLSearchParams(search);
  const parts = pathname.split("/").filter(Boolean);
  const [a, b, c, d] = parts;
  const n = parts.length;

  /* The entry points. */
  if (n === 0) return plan("home", () => entryAddress("/", from));
  if (n === 1 && a === "workbench") return plan("workbench", () => entryAddress("/workbench", from));
  if (n === 1 && a === "atomik") return plan("atomik", () => entryAddress("/atomik", from));
  if (n === 1 && (a === "subatomik" || a === "subatomic")) return plan("subatomik", () => entryAddress("/subatomik", from));
  /* The September workspace shell took the same params the shell does. */
  if (n === 1 && a === "workspace") return plan("workspace", () => entryAddress("/workspace", from));

  /* Make. */
  if (n === 1 && a === "generate") return plan("generate", () => make(makeKindOf(from.get("mode")) ?? "video", from));
  if (n === 1 && a === "images") return plan("images", () => make("image", from));
  if (n === 1 && a === "audio") return plan("audio", () => make("audio", from));
  if (n === 2 && a === "make") {
    const kind = makeKindOf(b);
    return kind ? plan("make-kind", () => make(kind, from)) : null;
  }

  /* The library wall: Make's Recent tab. The project (a Studio project here) is kept. */
  if (n === 1 && (a === "library" || a === "all")) {
    return plan(a, () => {
      const to = new URLSearchParams();
      const project = from.get("project");
      if (project) to.set("project", project);
      to.set("make", "recent");
      return settle(to);
    });
  }

  /* Productions, and the per-project lists, which need the Studio project that holds the production project's work. */
  if (n === 1 && a === "productions") return fixed("productions", "view=home");
  if (n === 4 && a === "productions" && (d === "media" || d === "shots"))
    return plan(`productions-${d}`, (p) => boardOf(p, "shots"), { kind: "production-project", id: c });

  /* The sequence wall, the element versions and the old Rig canvas: the board, or its Cast region. */
  if (n === 3 && a === "projects" && c === "canvas") return plan("project-canvas", (p) => boardOf(p), { kind: "production-project", id: b });
  if (n === 2 && a === "canvas") return plan("canvas", (p) => boardOf(p), { kind: "production-project", id: b });
  if (n === 4 && a === "projects" && c === "rig" && d === "elements") return plan("project-elements", (p) => boardOf(p, "cast"), { kind: "production-project", id: b });
  if (n === 3 && a === "rig" && b === "canvas")
    /* `/rig/canvas/new?project=<production project>` is the old "open the board of this project". */
    return plan("rig-canvas", (p) => boardOf(p), c === "new" ? { kind: "production-project", id: from.get("project") ?? "" } : { kind: "board", id: c });
  if (n === 3 && a === "rig" && b === "recipes") return plan("rig-recipes", (p) => boardOf(p), { kind: "production-project", id: c });

  /* Spend and cap: Settings > Spending rules lists every project with its cap. */
  if (n === 2 && a === "projects") return fixed("project-spend", "view=workspace&tab=rules");

  /* A take, a shot or an element by id: the board's Shots (or Cast) region on its project; a take also opens in the Inspector. */
  const onBoard = (region: string, extra: Record<string, string> = {}) => (p: string | null) =>
    settle(new URLSearchParams({ ...(p ? { project: p } : {}), view: "board", region, ...extra }));
  if (n === 2 && a === "takes") return plan("take", onBoard("shots", { asset: `generation:${b}` }), { kind: "take", id: b });
  if (n === 2 && a === "shots") return plan("shot", onBoard("shots"), { kind: "shot", id: b });
  if (n === 2 && a === "elements") return plan("element", onBoard("cast"), { kind: "element", id: b });

  /* The older Atomik planning pages: the board's Brief region (saved drafts stay in the database). */
  if (n === 2 && a === "atomik" && (b === "ideas" || b === "treatment" || b === "breakdown" || b === "shots"))
    return plan(`atomik-${b}`, onBoard("brief"), { kind: "production-project", id: from.get("project") ?? "" });

  /* The shot builder is Make; the movie export page is the Deliver card. The project, when the address named one, is kept. */
  const withProject = (build: (project: string | null) => string) => (): string => build(from.get("project"));
  if (n === 2 && a === "studio" && b === "shot")
    return plan("studio-shot", withProject((p) => settle(new URLSearchParams({ ...(p ? { project: p } : {}), make: "video" }))));
  if (n === 2 && a === "workbench" && b === "movie") return plan("movie", withProject((p) => onBoard("deliver")(p)));

  /* Runs and the dashboard: Control room › Activity. */
  if (n === 3 && a === "rig" && b === "run") return fixed("rig-run", "suite=atomik&page=runs");
  if (n === 1 && (a === "pipelines" || a === "dashboard")) return fixed(a, "suite=atomik&page=runs");

  /* Settings: the matching fold. */
  if (n === 1 && a === "settings") return fixed("settings", "view=workspace&tab=advanced&open=workspace");
  if (n === 1 && a === "team") return fixed("team", "view=workspace&tab=team");
  if (n === 1 && a === "usage") return fixed("usage", "view=workspace&tab=credits&open=usage");
  if (n === 1 && a === "connect") return fixed("connect", "view=workspace&tab=connections");

  return null;
}
