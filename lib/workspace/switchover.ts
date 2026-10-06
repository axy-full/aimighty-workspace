import {
  PAGES as LEGACY_PAGES,
  moleculrSection,
  type SuiteId,
} from "@/lib/suites";
import { firstPage, resolvePageId, resolveSuite } from "./pages";
import type { PageId, Suite } from "./types";

/* ──────────────────────────────────────────────────────────────────────────
   The switch-over.

   The Particl Suites shell lives at /suites. This module is the only place
   that knows how the four old entry points (/, /workbench, /atomik,
   /subatomik) map onto it: which legacy URL means which suite and page. There
   is no way back: Release 1 has one design (the escape hatch, the remembered
   choice and the kill switch are gone).

   The mapping is pure so it can be unit-tested.
   ────────────────────────────────────────────────────────────────────────── */

/** Where the old entry points land: the Particl Suites shell, on every device. */
export const SHELL_PATH = "/suites";

/** The old entry points this switch-over covers. Everything else is untouched. */
export const SWITCHED_ROUTES = ["/", "/workbench", "/atomik", "/subatomik"] as const;
export type SwitchedRoute = (typeof SWITCHED_ROUTES)[number];

/** Params the mapping consumes itself; anything else is carried through. */
const CONSUMED = new Set(["project", "suite", "page", "stage", "sel"]);

export function switchedRoute(pathname: string): SwitchedRoute | null {
  if (pathname === "/subatomic") return "/subatomik";
  return (SWITCHED_ROUTES as readonly string[]).includes(pathname)
    ? (pathname as SwitchedRoute)
    : null;
}

/* ── Legacy URL → workspace URL ───────────────────────────────────────── */

/**
 * The workspace URL an old URL means, or null for a path that is not one of
 * the four entry points.
 *
 * Every query param survives: `project` and the page id are translated, the
 * rest are appended unchanged. A Moleculr section becomes the hash, which is
 * where Marketing Studio already reads it from.
 */
export function workspaceUrlFor(pathname: string, search: string): string | null {
  const route = switchedRoute(pathname);
  if (!route) return null;
  const from = new URLSearchParams(search);

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

/** The suite's first page, as a workspace page id (through the aliases). */
function legacyDefaultPage(suite: Suite): PageId {
  const first = LEGACY_PAGES[suite as SuiteId]?.[0]?.id;
  return (first && resolvePageId(first)) || firstPage(suite);
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
