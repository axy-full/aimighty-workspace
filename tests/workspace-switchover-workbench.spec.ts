import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { LEGACY_SHELL, SHELL_COOKIE, SHELL_PARAM } from "../lib/workspace/switchover";

/**
 * The switch-over: the redesigned workspace is the default surface on
 * desktop, reached from the old entry points, while phones keep exactly
 * today's surfaces and every old URL still works.
 *
 * Desktop asserts each old deep link lands on the page that holds its work
 * with the right selection, that the back button does not bounce off the
 * redirect, and that the escape hatch both opens the old shell and sticks.
 * Phones assert nothing changed: the old shell, at the old URL.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

const PROJECT = "switchover-fixture";

/* Test fixtures only — the app reads these shapes from the real routes. */
function shot(id: string, title: string, y: number): CanvasNode {
  return {
    id, title, type: "scene", x: 100, y, width: 344, linked: [], role: "Director", status: "draft", mode: "Video",
    operations: [{ id: `op-${id}`, kind: "direction", enabled: true, values: { note: "Hold still." } }],
  };
}

const project: Project = {
  ...newProject("Switch-over fixture"),
  id: PROJECT,
  description: "Product film · Spot 02",
  nodes: [shot("sw-a", "Opening wide", 100), shot("sw-b", "The encounter", 500)],
};
const list = [{ id: PROJECT, name: project.name, revision: 1, updatedAt: "2026-09-18T10:00:00Z" }];

async function signedIn(page: Page) {
  await signInLocally(page.request);
  await page.route("**/api/workbench/projects**", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { projects: list, productions: [], project, revision: 1, shared: null } })
      : route.fulfill({ json: { revision: 2 } }),
  );
}

/** The URL the switch sends the tab to: the first /suites document it asks for. */
const switchTarget = (page: Page) =>
  page.waitForRequest((r) => r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).pathname === "/suites").then((r) => r.url());

/** The old shell's root element; the new shell's is `.pxw`. */
const legacyShell = (page: Page) => page.locator(".studio-redesign, .suite-page, .suite-home");

/* ── Desktop: the old entry points land in the new workspace ───────────── */

test("every old deep link lands on the page that now holds its work", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  /* `make`: the old page is a Make quick tool now (lib/shell/make.ts). The switch still names Viral's page; /suites then
     sends it on to Studio with Make open in that tool, so the page underneath is Studio's first. */
  /* `board`: the Studio stage pages are deleted (the board is the whole production), so the switch's target still names the old
     page and /suites sends it on, in one more 307, to the board's region for it (lib/shell/stage-redirects.ts). */
  const cases: { from: string; page: RegExp; title: string; suite: string; board?: Record<string, string>; make?: { tool: "motion" | "swap"; title: string } }[] = [
    { from: `/workbench?project=${PROJECT}&stage=canvas`, page: /[?&]page=rig(&|$)/, title: "", suite: "particl", board: {} },
    { from: `/workbench?project=${PROJECT}&stage=storyboard`, page: /[?&]page=boards(&|$)/, title: "", suite: "particl", board: { region: "storyboard" } },
    { from: `/workbench?project=${PROJECT}&stage=characters`, page: /[?&]page=cast(&|$)/, title: "", suite: "particl", board: { region: "cast" } },
    { from: `/workbench?project=${PROJECT}&stage=astra-blender`, page: /[?&]page=astra(&|$)/, title: "", suite: "particl", board: { region: "shots" } },
    { from: `/workbench?project=${PROJECT}&stage=assets`, page: /[?&]page=takes(&|$)/, title: "", suite: "particl", board: { region: "shots" } },
    { from: `/workbench?project=${PROJECT}&stage=export`, page: /[?&]page=deliver(&|$)/, title: "", suite: "particl", board: { region: "deliver" } },
    /* Stage ids retired before this change still resolve. */
    { from: `/workbench?project=${PROJECT}&stage=script`, page: /[?&]page=brief(&|$)/, title: "", suite: "particl", board: { region: "brief" } },
    /* The Suites shell folds the old Generate page into Agent (lib/shell/ia.ts). */
    { from: `/atomik?project=${PROJECT}&page=generate`, page: /[?&]page=generate(&|$)/, title: "Agent", suite: "atomik" },
    { from: `/atomik?project=${PROJECT}&page=runs`, page: /[?&]page=runs(&|$)/, title: "Runs", suite: "atomik" },
    { from: `/subatomik?project=${PROJECT}&page=motion-transfer`, page: /[?&]page=motion(&|$)/, title: project.name, suite: "subatomik", make: { tool: "motion", title: "Motion transfer" } },
    { from: `/subatomik?project=${PROJECT}&page=object-swap`, page: /[?&]page=swap(&|$)/, title: project.name, suite: "subatomik", make: { tool: "swap", title: "Object swap" } },
    /* Business is the Ads board for everyone: its page is the board's image-ads card. */
    { from: `/workbench?project=${PROJECT}&suite=moleculr&page=marketing`, page: /[?&]page=marketing(&|$)/, title: "", suite: "moleculr", board: { view: "board", kind: "ads" } },
  ];

  for (const one of cases) {
    /* The switch's own target. The Suites shell then writes its canonical page
       into the address (Generate is Agent there), and with the switch made by
       the server that can already have happened by the time the page loads. */
    const switched = switchTarget(page);
    await page.goto(one.from);
    await expect(page, one.from).toHaveURL(/^[^?]*\/suites\?/);
    const target = await switched;
    expect(target, one.from).toMatch(one.page);
    expect(target, one.from).toMatch(new RegExp(`[?&]suite=${one.suite}(&|$)`));
    expect(target, one.from).toMatch(new RegExp(`[?&]project=${PROJECT}(&|$)`));
    await expect(page, one.from).toHaveURL(new RegExp(`[?&]project=${PROJECT}(&|$)`));
    if (one.board) {
      await expect(page.locator(".gx"), one.from).toHaveAttribute("data-screen", /^board/);
      await expect.poll(() => { const q = new URL(page.url()).searchParams; return Object.entries({ view: "board", ...one.board }).every(([k, v]) => q.get(k) === v); }, { message: one.from }).toBe(true);
    } else {
      await expect(page, one.from).toHaveURL(new RegExp(`[?&]suite=${one.make ? "particl" : one.suite}(&|$)`));
      await expect(page.getByTestId("page-title"), one.from).toHaveText(one.title);
    }
    if (one.make) {
      await expect(page, one.from).toHaveURL(new RegExp(`[?&]make=${one.make.tool}(&|$)`));
      await expect(page.getByTestId("make-panel"), one.from).toBeVisible();
      await expect(page.getByTestId("make-panel"), one.from).toHaveAttribute("data-tab", one.make.tool);
      await expect(page.getByTestId("make-title"), one.from).toHaveText(one.make.title);
    }
    await expect(legacyShell(page)).toHaveCount(0);
  }
});

test("a bare old URL opens the workspace home, and a Moleculr section arrives as the hash", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  for (const from of ["/", `/workbench?project=${PROJECT}`]) {
    /* The switch names no page: the Suites URL it goes to is bare, and the
       shell writes its own first page into the address as it opens (which,
       with the switch now made by the server, can already have happened by
       the time the page has loaded). */
    const switched = switchTarget(page);
    await page.goto(from);
    await expect(page, from).toHaveURL(/\/suites\?/);
    expect(new URL(await switched).searchParams.has("page"), from).toBe(false);
    /* The Suites shell has no project-picker home: Studio opens on its overview (the stage pages are the board's regions). */
    await expect(page.locator(".gx"), from).toBeVisible();
    await expect(page.getByTestId("page-title"), from).toHaveText(project.name);
  }

  /* A Moleculr section is a card of the Ads board, for everyone. */
  await page.goto(`/workbench?project=${PROJECT}&suite=moleculr&page=brand`);
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board-ads");
  await expect.poll(() => { const q = new URL(page.url()).searchParams; return [q.get("view"), q.get("kind")]; }).toEqual(["board", "ads"]);
});

test("the project and any other query param survive the switch", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  await page.goto(`/workbench?project=${PROJECT}&stage=canvas&sel=shot:sw-b`);
  /* The Rig page is the board, and the project rides along to it. (A `sel=shot:` selection is not carried: the board keeps its own
     selection, and an old selection link opens it unselected.) */
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  await expect(page).toHaveURL(/[?&]view=board(&|$)/);
  await expect(page).toHaveURL(new RegExp(`[?&]project=${PROJECT}(&|$)`));

  /* Subatomik's connected-account override is a param the mapping does not
     own, so it is carried through untouched rather than dropped. */
  const switched = switchTarget(page);
  /* Object Swap is Make's quick tool now: /suites sends the switch's target on to Make's address (lib/shell/make.ts),
     and that hop carries the param too. */
  const toMake = page.waitForRequest((r) => r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).searchParams.get("make") === "swap").then((r) => r.url());
  await page.goto(`/subatomik?project=${PROJECT}&page=object-swap&account=particl`);
  const target = await switched;
  expect(target).toMatch(/[?&]page=swap(&|$)/);
  expect(target).toMatch(/[?&]account=particl(&|$)/);
  expect(await toMake).toMatch(/[?&]account=particl(&|$)/);
  await expect(page).toHaveURL(/[?&]make=swap(&|$)/);
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect(page.getByTestId("make-panel")).toHaveAttribute("data-tab", "swap");
  await expect(page.getByTestId("make-title")).toHaveText("Object swap");
  /* …and it is still on the address once Studio has written its own page into it (lib/workspace/navigation.ts › CARRIED_PARAMS),
     and after Make closes over that page. */
  await expect(page).toHaveURL(/[?&]page=brief(&|$)/);
  await expect(page).toHaveURL(/[?&]account=particl(&|$)/);
  await page.getByTestId("make-close").click();
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]account=particl(&|$)/);
});

test("the back button leaves the redirect alone instead of bouncing", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  await page.goto(`/workspace?project=${PROJECT}&suite=particl&page=brief`);
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  /* An old bookmark, arriving over the top of it: the board (the Rig page is the board). */
  await page.goto(`/workbench?project=${PROJECT}&stage=canvas`);
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  /* Back returns to where the person was, not to /workbench and forward again. */
  await page.goBack();
  await expect(page).toHaveURL(/\/workspace\?/);
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
});

/* ── Phones: they switch too (22 September) ────────────────────────────── */

test("phones land on the Suites shell as well, at the same mapped URLs", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signedIn(page);

  /* Motion Transfer is Make's quick tool now (lib/shell/make.ts): its old link opens Make in that tool over Studio. */
  for (const [from, title, make] of [
    [`/workbench?project=${PROJECT}&stage=canvas`, null, null],
    [`/subatomik?project=${PROJECT}&page=motion-transfer`, project.name, "motion"],
    ["/", project.name, null],
  ] as const) {
    await page.goto(from);
    await expect(page, from).toHaveURL(/\/suites\?/);
    /* The Rig page is the board; the others open Studio's overview. */
    if (title === null) await expect(page.locator(".gx"), from).toHaveAttribute("data-screen", "board");
    else await expect(page.getByTestId("page-title"), from).toHaveText(title);
    if (make) {
      await expect(page, from).toHaveURL(new RegExp(`[?&]make=${make}(&|$)`));
      await expect(page.getByTestId("make-panel"), from).toBeVisible();
      await expect(page.getByTestId("make-panel"), from).toHaveAttribute("data-tab", make);
      await expect(page.getByTestId("make-title"), from).toHaveText("Motion transfer");
    }
    /* The tab bar is the portrait phone's; a phone held landscape keeps the header's tabs. */
    if (info.project.name !== "workbench-844x390") await expect(page.getByTestId("tabbar"), from).toBeVisible();
    await expect(legacyShell(page), from).toHaveCount(0);
  }
});

/* ── The escape hatch ──────────────────────────────────────────────────── */

test("the escape hatch opens the old shell, is remembered, and can be cancelled", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  /* Asking for it by URL keeps the old shell at the old URL. */
  await page.goto(`/workbench?project=${PROJECT}&stage=canvas&${SHELL_PARAM}=${LEGACY_SHELL}`);
  await expect(page).toHaveURL(new RegExp(`/workbench\\?project=${PROJECT}&stage=canvas&${SHELL_PARAM}=${LEGACY_SHELL}$`));
  await expect(page.locator(".pxw")).toHaveCount(0);
  await expect(legacyShell(page).first()).toBeVisible();

  /* It is remembered, so the old shell's own links do not bounce back out.
     Polled rather than read once: the cookie is written by an inline script
     while the document parses, and the assertions above can be satisfied by
     the server-rendered markup before that script has run. */
  const shellCookie = async () =>
    (await page.context().cookies()).find((one) => one.name === SHELL_COOKIE)?.value;
  await expect.poll(shellCookie).toBe(LEGACY_SHELL);
  await page.goto(`/workbench?project=${PROJECT}&stage=assets`);
  await expect(page).toHaveURL(new RegExp(`/workbench\\?project=${PROJECT}&stage=assets$`));
  await expect(page.locator(".pxw")).toHaveCount(0);

  /* …and cancelled explicitly, which clears the cookie and puts the new
     workspace back in front — and keeps it there on the next plain URL. */
  await page.goto(`/workbench?project=${PROJECT}&stage=assets&${SHELL_PARAM}=new`);
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  await expect(page).toHaveURL(/[?&]region=shots(&|$)/);
  await expect.poll(shellCookie).toBeUndefined();
  await page.goto(`/workbench?project=${PROJECT}&stage=canvas`);
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  await expect(page).toHaveURL(/[?&]view=board(&|$)/);
});

test("the account menu carries the person back to the previous workspace", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);
  await page.goto(`/workspace?project=${PROJECT}&suite=particl&page=rig`);

  await page.getByTestId("workspace-account-open").click();
  const back = page.getByTestId("legacy-shell-link");
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute("href", `/workbench?project=${PROJECT}&stage=canvas&${SHELL_PARAM}=${LEGACY_SHELL}`);
  /* The same menu is the only way in to the pages the new shell has no page
     for; they keep their old routes (docs/workspace-switchover.md). */
  for (const href of ["/settings", "/team", "/billing", "/usage", "/library?all=1", "/generate", "/productions", "/pipelines"])
    await expect(page.getByTestId("workspace-account").locator(`a[href="${href}"]`)).toHaveCount(1);

  await back.click();
  await expect(page).toHaveURL(new RegExp(`/workbench\\?project=${PROJECT}&stage=canvas&${SHELL_PARAM}=${LEGACY_SHELL}$`));
  await expect(page.locator(".pxw")).toHaveCount(0);
});

test("the old shell keeps the flows the new one has no page for", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  /* `new=1` (project dialog), `atomik=marketing` (the mounted Marketing
     Studio flow) and `view=workspace` are legacy-only: the URL is left alone
     and the old shell renders, even though the default is the new one. */
  for (const from of [
    "/workbench?new=1",
    `/workbench?project=${PROJECT}&atomik=marketing`,
    `/workbench?project=${PROJECT}&view=workspace`,
  ]) {
    await page.goto(from);
    /* Still on /workbench — the old shell rewrites its own query (it consumes
       `new`), so the assertion is the path, not the whole URL. */
    await expect(page, from).toHaveURL(/\/workbench(\?|$)/);
    await expect(page, from).not.toHaveURL(/\/workspace/);
    await expect(page.locator(".pxw"), from).toHaveCount(0);
  }

  /* And the routes outside the four entry points are untouched. */
  for (const from of ["/workbench/movie", "/pipelines", "/library?all=1"]) {
    await page.goto(from);
    await expect(page, from).not.toHaveURL(/\/workspace/);
  }
});
