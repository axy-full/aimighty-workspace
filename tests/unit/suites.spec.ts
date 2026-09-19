import { test, expect } from "@playwright/test";
import {
  MOLECULR_SECTIONS,
  PAGES,
  PARTICL_STAGE_ALIASES,
  SUITES,
  moleculrSection,
  particlStage,
  roomForRoute,
  roomHref,
  suiteForRoute,
  suiteHref,
} from "../../lib/suites";
import { STAGES, normalizeStage } from "../../lib/workbench/studio";

test("suite links preserve the draft ID and validate each suite page independently", () => {
  const draft = "draft /?project=wrong";
  for (const suite of SUITES) {
    for (const page of PAGES[suite.id]) {
      const url = new URL(
        suiteHref(suite.id, draft, page.id),
        "https://particl.test",
      );
      expect(url.searchParams.getAll("project")).toEqual([draft]);
      expect(
        url.searchParams.get(suite.id === "particl" ? "stage" : "page"),
      ).toBe(page.id);
      expect(url.hash).toBe("");
      expect(suiteForRoute(url.pathname, url.searchParams)).toBe(suite.id);
      expect(roomForRoute(url.pathname)).toBe("production");
      expect(url.pathname).toBe(suite.id === "particl" || suite.id === "moleculr" ? "/workbench" : `/${suite.id}`);
      expect(url.searchParams.has(suite.id === "particl" ? "page" : "stage")).toBe(false);
      expect(url.searchParams.get("suite")).toBe(suite.id === "moleculr" ? "moleculr" : null);
      expect(url.searchParams.has("projectId")).toBe(false);
    }
    expect(suiteHref(suite.id, undefined, "invalid")).toBe(
      suiteHref(suite.id, undefined, PAGES[suite.id][0].id),
    );
    const foreignPage = suite.id === "particl" ? "runs" : "brief";
    expect(suiteHref(suite.id, draft, foreignPage)).toBe(suiteHref(suite.id, draft));
  }
});

test("the four suites carry the 19 September names and the eight-stage Particl dock order", () => {
  expect(SUITES.map((suite) => suite.name)).toEqual([
    "Particl Production Studio",
    "Atomik Super Agent",
    "Moleculr Business Suite",
    "Subatomik Viral Studio",
  ]);
  expect(SUITES.map((suite) => suite.id)).toEqual(["particl", "atomik", "moleculr", "subatomik"]);
  expect(PAGES.particl.map(page => page.id)).toEqual(STAGES.map(stage => stage.id));
  expect(PAGES.particl.map((page) => page.id)).toEqual([
    "brief",
    "storyboard",
    "characters",
    "astra-blender",
    "canvas",
    "assets",
    "edit",
    "export",
  ]);
  expect(PAGES.particl.map((page) => page.label)).toEqual([
    "Brief & Script",
    "Boards",
    "Cast & Elements",
    "Astra blender",
    "Rig",
    "Takes",
    "Edit & Sound",
    "Deliver",
  ]);
  expect(STAGES.map((stage) => stage.label)).toEqual(PAGES.particl.map((page) => page.label));
  expect(STAGES.find((stage) => stage.id === "brief")?.hint).toBe("Find the story and the production in it");
  expect(PAGES.atomik.map((page) => page.id)).toEqual(["runs", "generate", "recipes", "approvals", "budget", "models"]);
  expect(PAGES.subatomik.map((page) => page.id)).toEqual(["motion-transfer", "object-swap"]);
});

test("retired Particl stage IDs normalise to the stage that now holds their panel", () => {
  expect(PARTICL_STAGE_ALIASES).toEqual({ script: "brief", moodboard: "storyboard", elements: "characters" });
  for (const [alias, target] of Object.entries(PARTICL_STAGE_ALIASES)) {
    expect(particlStage(alias)).toBe(target);
    expect(normalizeStage(alias)).toBe(target);
    expect(suiteHref("particl", "draft-id", alias)).toBe(`/workbench?project=draft-id&stage=${target}`);
    expect(PAGES.particl.some((page) => page.id === alias)).toBe(false);
  }
  for (const stage of STAGES) {
    expect(particlStage(stage.id)).toBe(stage.id);
    expect(normalizeStage(stage.id)).toBe(stage.id);
  }
  for (const unknown of ["runs", "", "Brief", null, undefined]) {
    expect(particlStage(unknown)).toBeNull();
    expect(normalizeStage(unknown)).toBeNull();
  }
});

test("Moleculr is one Marketing Studio page whose former pages are ordered in-page sections", () => {
  expect(PAGES.moleculr).toEqual([{ id: "marketing", label: "Marketing Studio" }]);
  expect(MOLECULR_SECTIONS.map((section) => section.id)).toEqual([
    "product",
    "brand",
    "cast",
    "format",
    "variants",
    "design",
    "publish",
  ]);
  for (const section of MOLECULR_SECTIONS) {
    expect(moleculrSection(section.id)).toBe(section.id);
    expect(suiteHref("moleculr", "draft-id", section.id)).toBe(
      `/workbench?project=draft-id&suite=moleculr&page=marketing#${section.id}`,
    );
  }
  expect(moleculrSection("marketing")).toBeNull();
  expect(moleculrSection("brief")).toBeNull();
  expect(suiteHref("moleculr", "draft-id")).toBe("/workbench?project=draft-id&suite=moleculr&page=marketing");
  expect(suiteHref("moleculr", "draft-id", "marketing")).toBe(suiteHref("moleculr", "draft-id"));
});

test("room handoffs keep mapped-project generation behavior and collective-library context", () => {
  expect(roomHref("make", "draft-id")).toBe("/generate?project=draft-id");
  expect(roomHref("make")).toBe("/generate");
  expect(roomHref("projects", "draft-id")).toBe("/");
  expect(roomHref("library", "draft-id")).toBe(
    "/library?all=1&project=draft-id",
  );
  expect(roomHref("workspace", "draft-id")).toBe("/settings");
  expect(roomHref("production", "draft-id")).toBe(
    "/workbench?project=draft-id&stage=brief",
  );
  for (const room of ["production", "make", "library"] as const) {
    const draft = "draft + /?project=other&suite=moleculr#still-the-draft";
    const url = new URL(roomHref(room, draft), "https://particl.test");
    expect(url.hash).toBe("");
    expect(url.searchParams.getAll("project")).toEqual([draft]);
  }
});

test("links without a draft omit project instead of creating an invalid identity", () => {
  for (const project of [undefined, null, ""]) {
    for (const suite of SUITES) {
      expect(new URL(suiteHref(suite.id, project), "https://particl.test").searchParams.has("project")).toBe(false);
    }
    for (const room of ["production", "make", "library"] as const) {
      expect(new URL(roomHref(room, project), "https://particl.test").searchParams.has("project")).toBe(false);
    }
  }
});

test("suite detection respects nested routes and does not match path prefixes", () => {
  const marketing = new URLSearchParams("suite=moleculr");
  for (const path of ["/atomik", "/atomik/", "/atomik/ideas", "/atomik/treatment"]) {
    expect(suiteForRoute(path, marketing)).toBe("atomik");
  }
  for (const path of ["/subatomik", "/subatomik/", "/subatomik/motion-transfer", "/subatomic", "/subatomic/", "/subatomic/factory"]) {
    expect(suiteForRoute(path, marketing)).toBe("subatomik");
  }
  expect(suiteForRoute("/workbench", marketing)).toBe("moleculr");
  for (const path of ["/", "/atomik-other", "/subatomically", "/library", "/workbench/movie"]) {
    expect(suiteForRoute(path, marketing)).toBe("particl");
  }
  expect(suiteForRoute("/workbench", new URLSearchParams("suite=unknown"))).toBe("particl");
});

test("room detection keeps existing make and workspace deep links in their room", () => {
  expect(roomForRoute("/")).toBe("projects");
  expect(roomForRoute("/library")).toBe("library");
  for (const path of ["/generate", "/make", "/make/video", "/make/images", "/make/audio"]) {
    expect(roomForRoute(path), path).toBe("make");
  }
  for (const path of ["/settings", "/team", "/billing", "/usage", "/statements/2026-09", "/account/security"]) {
    expect(roomForRoute(path), path).toBe("workspace");
  }
  for (const path of ["/workbench", "/workbench/movie", "/pipelines", "/rig/run/run-1", "/generate-preview", "/settings-other"]) {
    expect(roomForRoute(path), path).toBe("production");
  }
});
