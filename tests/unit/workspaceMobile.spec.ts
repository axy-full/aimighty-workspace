import { test, expect } from "@playwright/test";
import {
  DOCK_TABS,
  dockActive,
  levelAbove,
  levelFor,
  levelFromParam,
  levelParam,
  mobileBack,
  viewForLevel,
  withLevel,
} from "../../lib/workspace/mobile";
import { applyUrl, fromSearch, go, goHome, INITIAL_STATE, toSearch } from "../../lib/workspace/navigation";
import type { AppState } from "../../lib/workspace/types";

const base: AppState = { ...INITIAL_STATE, projectId: "p1" };

/* ── The drill-down ─────────────────────────────────────────────────────── */

test("the phone opens on Projects, and Projects is the home view", () => {
  expect(base.mobile).toBe("projects");
  expect(viewForLevel("projects")).toBe("home");
  expect(viewForLevel("suite")).toBe("home");
  expect(viewForLevel("page")).toBe("studio");
});

test("go() lands on the Page level from anywhere, and closes the sheet it was chosen from", () => {
  const searching = { ...base, mobile: "suite" as const, sheet: "search" as const };
  const next = go(searching, "particl", "rig");
  expect(next.mobile).toBe("page");
  expect(next.view).toBe("studio");
  expect(next.sheet).toBeNull();
  expect(next.page).toBe("rig");
});

test("back steps up exactly one level; the siblings step to Projects", () => {
  expect(levelAbove("page")).toBe("suite");
  expect(levelAbove("suite")).toBe("projects");
  expect(levelAbove("make")).toBe("projects");
  expect(levelAbove("settings")).toBe("projects");
  const onPage = go(base, "particl", "boards");
  const up = mobileBack(onPage);
  expect(up.mobile).toBe("suite");
  expect(up.view).toBe("home");
  /* The page is remembered, so the stage list still marks where it was. */
  expect(up.page).toBe("boards");
  expect(mobileBack(up).mobile).toBe("projects");
});

test("a level change closes any open sheet", () => {
  const withSheet = { ...base, sheet: "atomik" as const };
  expect(withLevel(withSheet, "make").sheet).toBeNull();
});

test("going home returns to Projects", () => {
  expect(goHome(go(base, "atomik", "runs")).mobile).toBe("projects");
});

/* ── The URL ────────────────────────────────────────────────────────────── */

test("only the levels the desktop URL cannot express carry ?level=", () => {
  expect(levelParam("projects")).toBeNull();
  expect(levelParam("page")).toBeNull();
  expect(levelParam("suite")).toBe("suite");
  expect(levelParam("make")).toBe("make");
  expect(levelParam("settings")).toBe("settings");
  expect(levelFromParam("suite")).toBe("suite");
  expect(levelFromParam("page")).toBeNull();
  expect(levelFromParam("nonsense")).toBeNull();
});

test("a desktop URL is byte-identical to what it was; the Suite level adds one param", () => {
  const onPage = go(base, "particl", "rig");
  expect(toSearch(onPage)).toBe("?project=p1&suite=particl&page=rig");
  const onSuite = withLevel(onPage, "suite");
  expect(toSearch(onSuite)).toBe("?project=p1&suite=particl&level=suite");
  expect(toSearch({ ...base, mobile: "projects" })).toBe("?project=p1&suite=particl");
});

test("a deep link lands on the level it names", () => {
  expect(levelFor(null, "studio")).toBe("page");
  expect(levelFor(null, "home")).toBe("projects");
  expect(levelFor("make", "home")).toBe("make");

  const page = applyUrl(base, fromSearch("?project=p1&suite=particl&page=takes"));
  expect(page.mobile).toBe("page");
  expect(page.page).toBe("takes");

  const suite = applyUrl(base, fromSearch("?project=p1&suite=subatomik&level=suite"));
  expect(suite.mobile).toBe("suite");
  expect(suite.view).toBe("home");
  expect(suite.suite).toBe("subatomik");

  /* A level of its own wins over a page the same URL carries. */
  const both = applyUrl(base, fromSearch("?project=p1&page=rig&level=suite"));
  expect(both.mobile).toBe("suite");
  expect(both.page).toBe("rig");

  /* Aliases still resolve on the phone. */
  const alias = applyUrl(base, fromSearch("?project=p1&page=canvas"));
  expect(alias.page).toBe("rig");
  expect(alias.mobile).toBe("page");
});

/* ── The dock ───────────────────────────────────────────────────────────── */

test("the dock is five tabs; Atomik and Library open sheets", () => {
  expect(DOCK_TABS.map((tab) => tab.label)).toEqual(["Projects", "Stages", "Make", "Atomik", "Library"]);
  expect(DOCK_TABS.filter((tab) => "sheet" in tab).map((tab) => tab.id)).toEqual(["atomik", "library"]);
});

test("a screen tab reads active for its level, a sheet tab while its sheet is up", () => {
  const tab = (id: string) => DOCK_TABS.find((t) => t.id === id)!;
  expect(dockActive(tab("projects"), "projects", null)).toBe(true);
  expect(dockActive(tab("stages"), "suite", null)).toBe(true);
  /* The Page level sits under Stages — the level below it in one drill-down. */
  expect(dockActive(tab("stages"), "page", null)).toBe(true);
  expect(dockActive(tab("atomik"), "page", "atomik")).toBe(true);
  expect(dockActive(tab("library"), "page", "atomik")).toBe(false);
  /* While a sheet is up, the screen tabs step back. */
  expect(dockActive(tab("projects"), "projects", "search")).toBe(false);
});

/* ── The derived counters ───────────────────────────────────────────────── */



