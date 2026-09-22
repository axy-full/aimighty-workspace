import { test, expect } from "@playwright/test";
import { PAGES as LEGACY_PAGES, MOLECULR_SECTIONS, PARTICL_STAGE_ALIASES } from "../../lib/suites";
import { ALL_PAGES, PAGE_ALIASES, resolvePageId } from "../../lib/workspace/pages";
import {
  LEGACY_ONLY_PARAMS,
  LEGACY_SHELL,
  legacyPageId,
  legacyShellHref,
  legacyShellRequested,
  NEW_SHELL,
  SHELL_PARAM,
  switchedRoute,
  withLegacyShell,
  WORKSPACE_IS_DEFAULT,
  workspaceUrlFor,
  searchStringOf,
  shellCookieScript,
  SHELL_COOKIE,
} from "../../lib/workspace/switchover";


const at = (pathname: string, search = "") => {
  const url = workspaceUrlFor(pathname, search);
  if (!url) throw new Error(`No workspace URL for ${pathname}?${search}`);
  return new URL(url, "https://particl.test");
};

test("the default is on, so the mapping is live", () => {
  expect(WORKSPACE_IS_DEFAULT).toBe(true);
});

test("every old Particl stage, including its retired aliases, opens the page that holds its work", () => {
  const expected: Record<string, string> = {
    brief: "brief",
    storyboard: "boards",
    characters: "cast",
    "astra-blender": "astra",
    canvas: "rig",
    assets: "takes",
    edit: "edit",
    export: "deliver",
  };
  for (const stage of LEGACY_PAGES.particl) {
    const url = at("/workbench", `project=p1&stage=${stage.id}`);
    expect(url.pathname).toBe("/suites");
    expect(url.searchParams.get("project")).toBe("p1");
    expect(url.searchParams.get("suite")).toBe("particl");
    expect(url.searchParams.get("page")).toBe(expected[stage.id]);
  }
  /* script / moodboard / elements were retired before this change; they still land. */
  for (const [alias, stage] of Object.entries(PARTICL_STAGE_ALIASES))
    expect(at("/workbench", `stage=${alias}`).searchParams.get("page")).toBe(expected[stage]);
});

test("every alias in the workspace's own table resolves to a real page", () => {
  for (const [legacy, current] of Object.entries(PAGE_ALIASES)) {
    expect(ALL_PAGES.some((page) => page.id === current)).toBe(true);
    expect(resolvePageId(legacy)).toBe(current);
  }
});

test("the Atomik and Subatomik suites map page for page, and bare URLs keep the old default page", () => {
  for (const page of LEGACY_PAGES.atomik) {
    const url = at("/atomik", `project=a1&page=${page.id}`);
    expect(url.searchParams.get("suite")).toBe("atomik");
    expect(url.searchParams.get("page")).toBe(page.id);
    expect(url.searchParams.get("project")).toBe("a1");
  }
  expect(at("/atomik").searchParams.get("page")).toBe("runs");

  const subatomik: Record<string, string> = { "motion-transfer": "motion", "object-swap": "swap", shorts: "shorts" };
  for (const page of LEGACY_PAGES.subatomik) {
    const url = at("/subatomik", `project=v1&page=${page.id}`);
    expect(url.searchParams.get("suite")).toBe("subatomik");
    expect(url.searchParams.get("page")).toBe(subatomik[page.id]);
  }
  expect(at("/subatomik").searchParams.get("page")).toBe("motion");
  /* The retired /subatomic spelling is the same destination. */
  expect(switchedRoute("/subatomic")).toBe("/subatomik");
  expect(at("/subatomic", "page=object-swap").searchParams.get("page")).toBe("swap");
});

test("every Moleculr section opens Marketing Studio with the section as the hash", () => {
  expect(at("/workbench", "suite=moleculr&page=marketing").searchParams.get("page")).toBe("marketing");
  for (const section of MOLECULR_SECTIONS) {
    const url = at("/workbench", `project=m1&suite=moleculr&page=${section.id}`);
    expect(url.searchParams.get("suite")).toBe("moleculr");
    expect(url.searchParams.get("page")).toBe("marketing");
    expect(url.hash).toBe(`#${section.id}`);
  }
});

test("a Particl URL with no stage, and /, open the workspace home rather than a page", () => {
  for (const url of [at("/workbench"), at("/workbench", "project=p1"), at("/"), at("/", "project=p1")]) {
    expect(url.pathname).toBe("/suites");
    expect(url.searchParams.has("page")).toBe(false);
    expect(url.searchParams.get("suite")).toBe("particl");
  }
  expect(at("/workbench", "project=p1").searchParams.get("project")).toBe("p1");
  /* A suite on / still chooses the suite whose home opens. */
  expect(at("/", "suite=subatomik").searchParams.get("suite")).toBe("subatomik");
});

test("query params the mapping does not own are carried through unchanged, and a selection survives", () => {
  const url = at("/subatomik", "project=v1&page=object-swap&account=particl&ref=email");
  expect(url.searchParams.get("account")).toBe("particl");
  expect(url.searchParams.get("ref")).toBe("email");
  expect(at("/workbench", "stage=assets&sel=take:t_1").searchParams.get("sel")).toBe("take:t_1");
  /* A selection is only meaningful with a page: home drops it rather than lie. */
  expect(at("/workbench", "sel=take:t_1").searchParams.has("sel")).toBe(false);
});

test("paths outside the four entry points are never switched", () => {
  for (const path of ["/workbench/movie", "/settings", "/library", "/productions", "/pipelines", "/generate", "/workspace", "/atomik/ideas", "/review/abc"])
    expect(workspaceUrlFor(path, "")).toBeNull();
});

test("a legacy-only param keeps the old shell, because the new one has no equivalent yet", () => {
  for (const param of LEGACY_ONLY_PARAMS)
    expect(workspaceUrlFor("/workbench", `project=p1&${param}=1`)).toBeNull();
  expect(workspaceUrlFor("/workbench", "project=p1&atomik=marketing")).toBeNull();
  expect(workspaceUrlFor("/workbench", "view=workspace")).toBeNull();
});

test("the escape hatch wins over the default, and can be cancelled", () => {
  expect(workspaceUrlFor("/workbench", `stage=canvas&${SHELL_PARAM}=${LEGACY_SHELL}`)).toBeNull();
  expect(legacyShellRequested(`${SHELL_PARAM}=${LEGACY_SHELL}`, null)).toBe(true);
  /* The remembered choice, so the old shell's own links do not bounce back out. */
  expect(legacyShellRequested("", LEGACY_SHELL)).toBe(true);
  /* …and an explicit ?shell=new overrides the cookie. */
  expect(legacyShellRequested(`${SHELL_PARAM}=${NEW_SHELL}`, LEGACY_SHELL)).toBe(false);
  expect(legacyShellRequested("", null)).toBe(false);
  expect(workspaceUrlFor("/workbench", `stage=canvas&${SHELL_PARAM}=${NEW_SHELL}`)).not.toBeNull();
  /* enabled:false is the flag off — the old shell, everywhere. */
  expect(workspaceUrlFor("/workbench", "stage=canvas", { enabled: false })).toBeNull();
});

test("the way back translates every workspace page to a legacy route that exists", () => {
  for (const page of ALL_PAGES) {
    const legacy = legacyPageId(page.suite, page.id);
    expect(LEGACY_PAGES[page.suite as "particl"].some((item) => item.id === legacy)).toBe(true);
    const href = legacyShellHref({ suite: page.suite, page: page.id, projectId: "p1", view: "studio" });
    const url = new URL(href, "https://particl.test");
    expect(url.searchParams.get(SHELL_PARAM)).toBe(LEGACY_SHELL);
    expect(url.searchParams.get("project")).toBe("p1");
    expect(["/workbench", "/atomik", "/subatomik"]).toContain(url.pathname);
  }
});

test("the way back round-trips the pages both surfaces share", () => {
  const shared: [string, string][] = [
    ["particl", "boards"], ["particl", "cast"], ["particl", "astra"], ["particl", "rig"],
    ["particl", "takes"], ["particl", "deliver"], ["particl", "brief"], ["particl", "edit"],
    ["atomik", "runs"], ["atomik", "generate"], ["atomik", "recipes"], ["atomik", "approvals"],
    ["atomik", "budget"], ["atomik", "models"],
    ["subatomik", "motion"], ["subatomik", "swap"], ["subatomik", "shorts"],
    ["moleculr", "marketing"],
  ];
  for (const [suite, page] of shared) {
    const back = new URL(legacyShellHref({ suite: suite as "particl", page: page as "brief", projectId: "p1", view: "studio" }), "https://particl.test");
    const forward = at(back.pathname, back.search.replace(/^\?/, "").replace(`${SHELL_PARAM}=${LEGACY_SHELL}`, ""));
    expect(forward.searchParams.get("suite")).toBe(suite);
    expect(forward.searchParams.get("page")).toBe(page);
  }
});

test("a page the old shell never had falls back to its suite's first legacy page", () => {
  for (const [suite, page] of [["atomik", "agent"], ["atomik", "builds"], ["atomik", "skills"], ["subatomik", "sources"], ["subatomik", "compare"], ["subatomik", "history"]] as const)
    expect(legacyPageId(suite, page)).toBe(LEGACY_PAGES[suite][0].id);
});

test("home's way back is the old suite home, and withLegacyShell keeps a hash last", () => {
  const url = new URL(legacyShellHref({ suite: "particl", page: "brief", projectId: "p1", view: "home" }), "https://particl.test");
  expect(url.pathname).toBe("/");
  expect(url.searchParams.get(SHELL_PARAM)).toBe(LEGACY_SHELL);
  expect(withLegacyShell("/workbench?project=p1&suite=moleculr&page=marketing#brand"))
    .toBe(`/workbench?project=p1&suite=moleculr&page=marketing&${SHELL_PARAM}=${LEGACY_SHELL}#brand`);
  expect(withLegacyShell("/workbench")).toBe(`/workbench?${SHELL_PARAM}=${LEGACY_SHELL}`);
});

test("searchStringOf keeps repeated params and drops the ones Next did not send", () => {
  expect(searchStringOf({ project: "p1", stage: "canvas" })).toBe("project=p1&stage=canvas");
  expect(searchStringOf({ tag: ["a", "b"], missing: undefined })).toBe("tag=a&tag=b");
});

test("the shell choice is written by a script with no URL text in it, or not at all", () => {
  const set = shellCookieScript(`${SHELL_PARAM}=${LEGACY_SHELL}`);
  expect(set).toContain(`${SHELL_COOKIE}=${LEGACY_SHELL}`);
  expect(set).toContain("path=/");
  expect(set).toContain("samesite=lax");
  const clear = shellCookieScript(`${SHELL_PARAM}=${NEW_SHELL}`);
  expect(clear).toContain(`${SHELL_COOKIE}=;`);
  expect(clear).toContain("max-age=0");
  /* Nothing else asks for a cookie, and nothing from the URL reaches the
     script: an injected value neither runs nor appears in it. */
  expect(shellCookieScript("")).toBeNull();
  expect(shellCookieScript("project=p1&stage=canvas")).toBeNull();
  const hostile = `${SHELL_PARAM}=${encodeURIComponent('legacy"; alert(1); x="')}`;
  expect(shellCookieScript(hostile)).toBeNull();
  for (const script of [set, clear]) expect(script).not.toContain("alert");
});
