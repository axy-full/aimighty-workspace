import {
  PAGES as LEGACY_PAGES,
  moleculrSection,
  suiteHref,
  type SuiteId,
} from "@/lib/suites";
import { firstPage, PAGE_ALIASES, resolvePageId, resolveSuite } from "./pages";
import type { PageId, Suite } from "./types";

/* ──────────────────────────────────────────────────────────────────────────
   The switch-over.

   The Particl Suites shell lives at /suites (the redesigned workspace it
   grew out of stays at /workspace). This module is the only place that knows
   the old entry points map onto it: which legacy URL means which suite and
   page, which way back a person has for one release, and the single flag
   that puts the old shell in front again.

   Nothing here decides anything about a viewport. The mapping is pure so it
   can be unit-tested both ways; the device decision belongs to the client
   gate (components/switchover/SwitchoverGate.tsx), because a server cannot
   see how wide a window is.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * THE KILL SWITCH. Set this to `false` and every old entry point renders the
 * old shell again, exactly as it did before this change: no redirect, no
 * gate, no cookie read. Nothing else needs editing, and nothing about the
 * /workspace route itself changes — it stays reachable by its own URL.
 *
 * Documented in docs/workspace-switchover.md.
 */
export const WORKSPACE_IS_DEFAULT = true;

/**
 * Where the old entry points land since 22 September 2026: the Particl Suites
 * shell (`/suites`, FINAL_SPEC), on every device — its phone layer and Studio
 * home replaced the 19 September "phones keep today's surfaces" decision. The
 * redesigned workspace stays reachable at its own URL (/workspace); the old
 * shell stays one `?shell=legacy` away.
 */
export const SHELL_PATH = "/suites";
export const SHELL_ON_PHONES = true;

/** `?shell=legacy` asks for the old shell; `?shell=new` cancels that. */
export const SHELL_PARAM = "shell";
export const LEGACY_SHELL = "legacy";
export const NEW_SHELL = "new";

/**
 * The choice is remembered, because the old shell's own links (suiteHref)
 * carry no `shell` param — without a cookie, the second click would bounce
 * the person back out of the surface they just asked for.
 */
/**
 * The name carries the release: a "previous workspace" choice remembered
 * before the Suites cut-over (`particl_shell`) must not keep anyone — a phone
 * especially — on the old site now. A fresh `?shell=legacy` writes this one.
 */
export const SHELL_COOKIE = "particl_shell_suites";
/** One release. Long enough to finish a job, short enough to expire itself. */
export const SHELL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Phones and phones held landscape keep today's surfaces (owner decision,
 * 19 Sep). Same query the /workspace page already used to hand phones back
 * to /workbench, so there is one definition of "not a desktop".
 */
export const PHONE_QUERY =
  "(max-width: 759px), (hover: none) and (pointer: coarse) and (max-height: 500px)";

/**
 * Params that only the old shell understands. A URL carrying one of them is
 * a deep link INTO the old shell, not a bookmark of a stage, so it is left
 * alone: `new=1` opens the project dialog, `atomik=marketing` opens the
 * Marketing Studio mounted flow, `view=workspace` the old workspace home.
 * Each is listed in docs/workspace-switchover.md with what replaces it.
 */
export const LEGACY_ONLY_PARAMS = ["new", "atomik", "view"] as const;

/** The old entry points this switch-over covers. Everything else is untouched. */
export const SWITCHED_ROUTES = ["/", "/workbench", "/atomik", "/subatomik"] as const;
export type SwitchedRoute = (typeof SWITCHED_ROUTES)[number];

/** Params the mapping consumes itself; anything else is carried through. */
const CONSUMED = new Set(["project", "suite", "page", "stage", "sel", SHELL_PARAM]);

export function switchedRoute(pathname: string): SwitchedRoute | null {
  if (pathname === "/subatomic") return "/subatomik";
  return (SWITCHED_ROUTES as readonly string[]).includes(pathname)
    ? (pathname as SwitchedRoute)
    : null;
}

/** `?shell=legacy` in a query string, or the remembered choice in a cookie. */
export function legacyShellRequested(search: string, cookie: string | null | undefined): boolean {
  const asked = new URLSearchParams(search).get(SHELL_PARAM);
  if (asked === LEGACY_SHELL) return true;
  if (asked === NEW_SHELL) return false;
  return cookie === LEGACY_SHELL;
}

/**
 * The `document.cookie` write for a `?shell=` choice, as a string the gate can
 * put in an inline <script>, or null when the URL asks for nothing.
 *
 * Why a script and not only an effect: an effect runs after hydration, and on
 * a slow machine that is a long way after the document is readable. The cookie
 * is what makes the choice survive the old shell's own links, so it is written
 * while the document parses. Both literals below are constants — nothing from
 * the URL reaches the script.
 */
export function shellCookieScript(search: string): string | null {
  const asked = new URLSearchParams(search).get(SHELL_PARAM);
  if (asked === LEGACY_SHELL)
    return `document.cookie="${SHELL_COOKIE}=${LEGACY_SHELL}; path=/; max-age=${SHELL_COOKIE_MAX_AGE}; samesite=lax"`;
  if (asked === NEW_SHELL) return `document.cookie="${SHELL_COOKIE}=; path=/; max-age=0; samesite=lax"`;
  return null;
}

/* ── Legacy URL → workspace URL ───────────────────────────────────────── */

/**
 * The workspace URL an old URL means, or null when the old URL should keep
 * rendering the old shell (an unmapped path, a legacy-only param, or the
 * default flipped off).
 *
 * Every query param survives: `project` and the page id are translated, the
 * rest are appended unchanged. A Moleculr section becomes the hash, which is
 * where Marketing Studio already reads it from.
 */
export function workspaceUrlFor(
  pathname: string,
  search: string,
  options: { enabled?: boolean } = {},
): string | null {
  if (options.enabled === false || !WORKSPACE_IS_DEFAULT) return null;
  const route = switchedRoute(pathname);
  if (!route) return null;
  const from = new URLSearchParams(search);
  if (from.get(SHELL_PARAM) === LEGACY_SHELL) return null;
  if (LEGACY_ONLY_PARAMS.some((param) => from.has(param))) return null;

  let suite: Suite = "particl";
  let page: PageId | null = null;
  let hash = "";

  if (route === "/atomik") {
    suite = "atomik";
    page = resolvePageId(from.get("page")) ?? legacyDefaultPage("atomik");
  } else if (route === "/subatomik") {
    suite = "subatomik";
    page = resolvePageId(from.get("page")) ?? legacyDefaultPage("subatomik");
  } else if (route === "/workbench") {
    if (resolveSuite(from.get("suite")) === "moleculr") {
      suite = "moleculr";
      page = "marketing";
      const section = moleculrSection(from.get("page"));
      hash = section ? `#${section}` : "";
    } else {
      suite = "particl";
      /* No stage is the project-first home, not a stage: /workbench and
         /workbench?project=x open the workspace home with that project. */
      page = resolvePageId(from.get("stage"));
    }
  } else {
    /* "/" is the suite home; a `suite` param on it still chooses the suite. */
    suite = resolveSuite(from.get("suite")) ?? "particl";
    page = null;
  }

  const to = new URLSearchParams();
  const project = from.get("project");
  if (project) to.set("project", project);
  to.set("suite", suite);
  if (page) {
    to.set("page", page);
    const sel = from.get("sel");
    if (sel) to.set("sel", sel);
  }
  for (const [key, value] of from) if (!CONSUMED.has(key)) to.append(key, value);
  /* The hash the old URL carried wins over a section derived from `page`. */
  return `${SHELL_PATH}?${to.toString()}${hash}`;
}

/* ── Workspace state → legacy URL (the way back) ───────────────────────── */

/** New page id → the legacy page id that held its work, by inverting PAGE_ALIASES. */
export const LEGACY_PAGE_IDS: Partial<Record<PageId, string>> = Object.fromEntries(
  Object.entries(PAGE_ALIASES).map(([legacy, current]) => [current, legacy]),
);

/**
 * The legacy page id for a workspace page: its own id when the old shell had
 * one by that name, the aliased id when it was renamed, and the suite's first
 * legacy page for a page the old shell never had (Agent, Builds, Skills,
 * Sources, Compare, History).
 */
export function legacyPageId(suite: Suite, page: PageId): string {
  const aliased = LEGACY_PAGE_IDS[page];
  if (aliased) return aliased;
  const legacySuite = suite as SuiteId;
  if (LEGACY_PAGES[legacySuite]?.some((item) => item.id === page)) return page;
  return LEGACY_PAGES[legacySuite]?.[0]?.id ?? LEGACY_PAGES.particl[0].id;
}

/** The suite's first page, as a workspace page id (through the aliases). */
function legacyDefaultPage(suite: Suite): PageId {
  const first = LEGACY_PAGES[suite as SuiteId]?.[0]?.id;
  return (first && resolvePageId(first)) || firstPage(suite);
}

/** Add `shell=legacy` to a URL, keeping any hash last where it belongs. */
export function withLegacyShell(href: string): string {
  const [base, hash] = href.split("#");
  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}${SHELL_PARAM}=${LEGACY_SHELL}${hash ? `#${hash}` : ""}`;
}

/**
 * The escape hatch: where the account menu's "Use the previous workspace"
 * link goes from wherever the person is standing in the new shell.
 */
export function legacyShellHref(
  state: { suite: Suite; page: PageId; projectId?: string | null; view?: "home" | "studio" },
): string {
  if (state.view === "home") {
    const query = new URLSearchParams(state.projectId ? { project: state.projectId } : {});
    query.set(SHELL_PARAM, LEGACY_SHELL);
    return `/?${query.toString()}`;
  }
  return withLegacyShell(
    suiteHref(state.suite as SuiteId, state.projectId ?? null, legacyPageId(state.suite, state.page)),
  );
}

/* ── Next plumbing ─────────────────────────────────────────────────────── */

export type RawSearch = Record<string, string | string[] | undefined>;

/** Next hands searchParams as a record; the mapping wants a query string. */
export function searchStringOf(params: RawSearch): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const one of value) query.append(key, one);
    else if (typeof value === "string") query.append(key, value);
  }
  return query.toString();
}
