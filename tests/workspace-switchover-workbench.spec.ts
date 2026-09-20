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

/** The old shell's root element; the new shell's is `.pxw`. */
const legacyShell = (page: Page) => page.locator(".studio-redesign, .suite-page, .suite-home");

/* ── Desktop: the old entry points land in the new workspace ───────────── */

test("every old deep link lands on the page that now holds its work", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  const cases: { from: string; page: RegExp; title: string; suite: string }[] = [
    { from: `/workbench?project=${PROJECT}&stage=canvas`, page: /[?&]page=rig(&|$)/, title: "Rig", suite: "particl" },
    { from: `/workbench?project=${PROJECT}&stage=storyboard`, page: /[?&]page=boards(&|$)/, title: "Boards", suite: "particl" },
    { from: `/workbench?project=${PROJECT}&stage=characters`, page: /[?&]page=cast(&|$)/, title: "Cast & Elements", suite: "particl" },
    { from: `/workbench?project=${PROJECT}&stage=astra-blender`, page: /[?&]page=astra(&|$)/, title: "Astra 3D", suite: "particl" },
    { from: `/workbench?project=${PROJECT}&stage=assets`, page: /[?&]page=takes(&|$)/, title: "Takes", suite: "particl" },
    { from: `/workbench?project=${PROJECT}&stage=export`, page: /[?&]page=deliver(&|$)/, title: "Deliver", suite: "particl" },
    /* Stage ids retired before this change still resolve. */
    { from: `/workbench?project=${PROJECT}&stage=script`, page: /[?&]page=brief(&|$)/, title: "Brief & Script", suite: "particl" },
    { from: `/atomik?project=${PROJECT}&page=generate`, page: /[?&]page=generate(&|$)/, title: "Generate", suite: "atomik" },
    { from: `/atomik?project=${PROJECT}&page=runs`, page: /[?&]page=runs(&|$)/, title: "Runs", suite: "atomik" },
    { from: `/subatomik?project=${PROJECT}&page=motion-transfer`, page: /[?&]page=motion(&|$)/, title: "Motion Transfer", suite: "subatomik" },
    { from: `/subatomik?project=${PROJECT}&page=object-swap`, page: /[?&]page=swap(&|$)/, title: "Object Swap", suite: "subatomik" },
    { from: `/workbench?project=${PROJECT}&suite=moleculr&page=marketing`, page: /[?&]page=marketing(&|$)/, title: "Marketing Studio", suite: "moleculr" },
  ];

  for (const one of cases) {
    await page.goto(one.from);
    await expect(page, one.from).toHaveURL(/^[^?]*\/workspace\?/);
    await expect(page, one.from).toHaveURL(one.page);
    await expect(page, one.from).toHaveURL(new RegExp(`[?&]suite=${one.suite}(&|$)`));
    await expect(page, one.from).toHaveURL(new RegExp(`[?&]project=${PROJECT}(&|$)`));
    await expect(page.getByTestId("page-title"), one.from).toHaveText(one.title);
    await expect(legacyShell(page)).toHaveCount(0);
  }
});

test("a bare old URL opens the workspace home, and a Moleculr section arrives as the hash", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  for (const from of ["/", `/workbench?project=${PROJECT}`]) {
    await page.goto(from);
    await expect(page, from).toHaveURL(/\/workspace\?/);
    await expect(page, from).not.toHaveURL(/[?&]page=/);
    await expect(page.getByRole("heading", { name: "Pick a project to work in" })).toBeVisible();
  }

  await page.goto(`/workbench?project=${PROJECT}&suite=moleculr&page=brand`);
  await expect(page).toHaveURL(/[?&]page=marketing/);
  await expect(page).toHaveURL(/#brand$/);
  await expect(page.getByTestId("page-title")).toHaveText("Marketing Studio");
});

test("a selection and any other query param survive the switch", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  await page.goto(`/workbench?project=${PROJECT}&stage=canvas&sel=shot:sw-b`);
  await expect(page).toHaveURL(/[?&]page=rig(&|$)/);
  await expect(page).toHaveURL(/[?&]sel=shot%3Asw-b(&|$)/);
  await expect(page.getByTestId("inspector")).toContainText("The encounter");

  /* Subatomik's connected-account override is a param the mapping does not
     own, so it is carried through untouched rather than dropped. */
  await page.goto(`/subatomik?project=${PROJECT}&page=object-swap&account=particl`);
  await expect(page).toHaveURL(/[?&]page=swap(&|$)/);
  await expect(page).toHaveURL(/[?&]account=particl(&|$)/);
});

test("the back button leaves the redirect alone instead of bouncing", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signedIn(page);

  await page.goto(`/workspace?project=${PROJECT}&suite=particl&page=brief`);
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  /* An old bookmark, arriving over the top of it. */
  await page.goto(`/workbench?project=${PROJECT}&stage=canvas`);
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  /* Back returns to where the person was, not to /workbench and forward again. */
  await page.goBack();
  await expect(page).toHaveURL(/[?&]page=brief(&|$)/);
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
});

/* ── Phones: nothing changed ───────────────────────────────────────────── */

test("phones keep today's surfaces at today's URLs", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signedIn(page);

  for (const from of [
    `/workbench?project=${PROJECT}&stage=canvas`,
    `/atomik?project=${PROJECT}&page=runs`,
    `/subatomik?project=${PROJECT}&page=motion-transfer`,
    "/",
  ]) {
    await page.goto(from);
    /* The URL is untouched: no redirect, no `shell` param, no /workspace. */
    await expect(page, from).toHaveURL(new RegExp(from.replace(/[?]/g, "\\?") + "$"));
    await expect(page.locator(".pxw"), from).toHaveCount(0);
    await expect(page.getByTestId("switchover-note"), from).toHaveCount(0);
  }
  /* And /workspace itself still hands a phone back, as it already did. */
  await page.goto(`/workspace?project=${PROJECT}&suite=particl&page=rig`);
  await expect(page).toHaveURL(new RegExp(`/workbench\\?project=${PROJECT}$`));
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
  await expect(page).toHaveURL(/[?&]page=takes(&|$)/);
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect.poll(shellCookie).toBeUndefined();
  await page.goto(`/workbench?project=${PROJECT}&stage=canvas`);
  await expect(page).toHaveURL(/[?&]page=rig(&|$)/);
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
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
