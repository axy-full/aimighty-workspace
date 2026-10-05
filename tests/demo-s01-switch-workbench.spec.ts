import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { signInLocally, joinLocallyAsMember } from "./helpers/workbenchLocal";
import { setNewInterface, setNewInterfaceEveryone, signInWithNewInterface } from "./helpers/newInterface";
import { password, signupInvite } from "./helpers/identityAdmin";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { closeSuitesMenu, openSuitesMenu } from "./helpers/suitesMenu";

/**
 * The per-workspace "new interface" switch and the shell wiring behind it (lib/shell/new-interface.ts, lib/shell/screens.ts).
 * Nothing has landed yet, so with the switch ON every address still opens today's page: what the switch changes now is
 * the routing pipeline, the chrome's markers and the one-shot `settings=1`. With it OFF the shell is exactly today's.
 * Local ENGINE_MOCK server only; the server must run with SUPER_ADMIN_EMAIL set to the fixture address (CI does).
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];

function fixture(): Project {
  return { ...newProject("Coastal light study"), id: "ws-switch", productionProjectId: "prod-switch", shotMappings: {} };
}

async function mock(page: Page) {
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
}

/** Problems the page raised: a console error, an uncaught exception, a hydration mismatch. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|favicon|net::ERR/i.test(message.text())) problems.push(message.text()); });
  return problems;
}

async function open(page: Page, path: string, on: boolean) {
  if (on) await signInWithNewInterface(page.request); else await signInLocally(page.request);
  await mock(page);
  const problems = watch(page);
  await page.goto(path);
  await expect(page.locator(".gx")).toBeVisible();
  await expect(page.locator(".gx")).toHaveAttribute("data-interface", on ? "new" : "old");
  return problems;
}

const here = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
/** The address settles on the page it names: the shell's own landing rewrites it once more. */
async function landsOn(page: Page, want: Record<string, string | null>) {
  await expect.poll(() => { const now = here(page); return Object.entries(want).every(([k, v]) => (v === null ? !(k in now) : now[k] === v)); }, { message: `the address lands on ${JSON.stringify(want)}`, timeout: 20_000 }).toBe(true);
}

/** New addresses, and the page of today's each one opens while no new screen has landed (switch off, or on with nothing landed). */
const TODAYS: [string, Record<string, string | null>][] = [
  ["/suites?view=home", { suite: "particl", page: "brief", view: null }],
  ["/suites?view=board&region=cut", { suite: "particl", page: "edit", view: null, region: null }],
  ["/suites?view=board&list=1", { suite: "particl", page: "rig", view: null, list: null }],
  ["/suites?view=board&kind=ads&frame=2", { suite: "moleculr", page: "marketing", sp: "dtc", view: null, kind: null }],
  ["/suites?view=board&kind=social", { suite: "subatomik", page: "history", view: null }],
  ["/suites?atomik=1", { suite: "atomik", page: "agent", atomik: null }],
  ["/suites?view=workspace&ws=team", { view: "workspace", tab: "people" }],
  ["/suites?view=workspace&ws=rules", { suite: "atomik", page: "budget", view: null }],
  ["/suites?view=workspace&tab=credits&open=usage", { view: "workspace", tab: "usage", open: null }],
  /* Old addresses are served where they are. */
  ["/suites?suite=particl&page=rig", { suite: "particl", page: "rig" }],
  ["/suites?suite=particl&page=brief&sp=beats", { suite: "particl", page: "brief", sp: "beats" }],
  ["/suites?suite=moleculr&page=marketing&sp=hooks", { suite: "moleculr", page: "marketing", sp: "hooks" }],
  ["/suites?view=workspace&tab=people", { view: "workspace", tab: "people" }],
  ["/suites?view=crew&cp=members", { view: "crew", cp: "members" }],
];

test("switch OFF: today's shell. New addresses open today's page for them, old ones are untouched, nothing carries a new-interface marker", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const problems = await open(page, "/suites", false);
  await expect(page.locator(".gx")).not.toHaveAttribute("data-screen", /.+/);
  await expect(page.getByTestId("shell-body")).toBeVisible();
  /* Header B and the Studio strip, as D0 has them. */
  await openSuitesMenu(page);
  await expect(page.getByRole("tablist", { name: "Suites" }).getByRole("tab")).toHaveText(["Home", "Coastal light study", "Make", "Atomik"]);
  await closeSuitesMenu(page);
  for (const [path, want] of TODAYS) {
    await page.goto(path);
    await landsOn(page, want);
    await expect(page.locator(".gx")).toHaveAttribute("data-interface", "old");
    await expect(page.locator(".gx")).not.toHaveAttribute("data-screen", /.+/);
  }
  /* `settings=1` is a switch-on affordance: off, it opens nothing. */
  await page.goto("/suites?suite=particl&page=rig&settings=1");
  await expect(page.locator(".gx")).toBeVisible();
  await expect(page.getByTestId("settings-menu")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow").toBe(true);
  expect(problems).toEqual([]);
});

test("switch ON, nothing landed: the same pages at every address, the new-interface marker, `settings=1` opens the avatar menu once", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const problems = await open(page, "/suites", true);
  /* A bare landing is still Studio: Home has not landed. */
  await landsOn(page, { suite: "particl", view: null });
  await expect(page.getByTestId("shell-body")).toBeVisible();
  await openSuitesMenu(page);
  await expect(page.getByRole("tablist", { name: "Suites" }).getByRole("tab")).toHaveText(["Home", "Coastal light study", "Make", "Atomik"]);
  await closeSuitesMenu(page);
  for (const [path, want] of TODAYS) {
    /* Settings has landed (stream 9): its own spec (demo-s09-settings-workbench) holds the Workspace addresses. */
    if (path.includes("view=workspace")) continue;
    await page.goto(path);
    await landsOn(page, want);
    await expect(page.locator(".gx")).toHaveAttribute("data-interface", "new");
    /* No new screen is mounted, so the shell is today's. */
    await expect(page.locator(".gx")).not.toHaveAttribute("data-screen", /.+/);
  }
  /* The design's `palette=1` is ⌘K's `find=1`, in both modes; it opens search once and leaves the address. */
  await page.goto("/suites?suite=particl&page=rig&palette=1");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");
  /* `settings=1`: the avatar menu opens on landing and the address drops it. */
  await page.goto("/suites?suite=particl&page=rig&settings=1");
  await expect(page.getByTestId("settings-menu")).toBeVisible();
  await expect.poll(() => "settings" in here(page)).toBe(false);
  await expect(page.getByTestId("settings-menu")).toBeVisible();
  await expect(page.getByTestId("settings-team")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-menu")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow").toBe(true);
  expect(problems).toEqual([]);
});

test("the screens' own params are kept across the shell's writes with the switch on, and dropped from today's pages with it off", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "the address bar is the same at every size: one desktop run");
  await open(page, "/suites?suite=particl&page=rig&region=cut&frame=d&drawer=library&review=1&card=hooks&screen=home&device=phone&from=x&run=r&take=t", true);
  /* Make opens over the page: the shell rewrites the address for it, and the params stay. */
  await page.keyboard.press("Alt+KeyM");
  await expect.poll(() => here(page).make).toBe("video");
  const kept = here(page);
  for (const key of ["region", "frame", "drawer", "review", "card", "screen", "device", "from", "run", "take"]) expect(kept[key], key).toBeTruthy();
  /* The same address with the switch off: the shell reads none of them, and today's rewrite drops them. */
  await page.context().clearCookies();
  await signInLocally(page.request);
  await page.goto("/suites?suite=particl&page=rig&region=cut&frame=d");
  await expect(page.locator(".gx")).toHaveAttribute("data-interface", "old");
  await page.keyboard.press("Alt+KeyM");
  await expect.poll(() => here(page).make).toBe("video");
  expect(here(page).region).toBeUndefined();
});

test("workspace A on, workspace B off: B is unchanged, A is the new interface", async ({ page, browser }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const viewport = page.viewportSize()!;
  const other = await browser.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551", viewport });
  try {
    const otherPage = await other.newPage();
    await signInLocally(otherPage.request, "Workbench Other");
    await mock(otherPage);
    await signInWithNewInterface(page.request);
    await mock(page);
    await page.goto("/suites");
    await otherPage.goto("/suites");
    await expect(page.locator(".gx")).toHaveAttribute("data-interface", "new");
    await expect(otherPage.locator(".gx")).toHaveAttribute("data-interface", "old");
    /* The flip shows on the next page load, with no deploy. */
    const me = await otherPage.request.get("/api/me").then((r) => r.json()) as { workspace: { id: string } };
    await setNewInterface(me.workspace.id, true);
    await otherPage.reload();
    await expect(otherPage.locator(".gx")).toHaveAttribute("data-interface", "new");
    await setNewInterface(me.workspace.id, false);
    await otherPage.reload();
    await expect(otherPage.locator(".gx")).toHaveAttribute("data-interface", "old");
  } finally {
    await other.close();
  }
});

test("a workspace's own admin and its members cannot turn it on: the admin routes say 403, and the settings route ignores the key", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "an API check: one run");
  const owner = await browser.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551" });
  try {
    const joined = await joinLocallyAsMember(owner.request, page.request);
    for (const request of [owner.request, page.request]) {
      expect((await request.patch(`/api/admin/workspaces/${joined.workspace.id}`, { data: { newInterface: true } })).status()).toBe(403);
      expect((await request.patch("/api/admin/interface", { data: { everyone: true } })).status()).toBe(403);
      expect((await request.get("/api/admin/interface")).status()).toBe(403);
    }
    /* The workspace's own admin may save settings; the key is not one of them, and nothing changes. */
    await owner.request.patch("/api/settings", { data: { newInterface: true } });
    const ownerPage = await owner.newPage();
    await mock(ownerPage);
    await ownerPage.goto("/suites");
    await expect(ownerPage.locator(".gx")).toHaveAttribute("data-interface", "old");
    /* And nothing a browser can fetch carries the list. */
    for (const url of ["/api/me", "/api/settings"]) {
      const text = await owner.request.get(url).then((r) => r.text());
      expect(text, url).not.toMatch(/interface|platform_layer/i);
    }
  } finally {
    await owner.close();
  }
});

test("the platform owner's desk: a chip per workspace and an Everyone switch, and Everyone goes back off", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "the platform desk is a desktop console: one desktop size");
  const ownerEmail = "platform-owner@example.test";
  const login = await page.request.post("/api/auth/login", { data: { email: ownerEmail, password } });
  if (!login.ok()) {
    const code = await signupInvite(ownerEmail);
    const signup = await page.request.post("/api/auth/signup", { data: { code, name: "Platform owner", email: ownerEmail, workspace: "Platform desk", password, accept: true } });
    expect(signup.ok(), await signup.text()).toBe(true);
  }
  const me = await page.request.get("/api/me").then((r) => r.json()) as { superAdmin: boolean; id: string; workspace: { id: string } };
  expect(me.superAdmin, `start the server with SUPER_ADMIN_EMAIL=${ownerEmail}`).toBe(true);
  const name = `Switch ${randomBytes(4).toString("hex")}`;
  const created = await page.request.post("/api/workspaces", { headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` }, data: { name } });
  expect(created.ok(), await created.text()).toBe(true);
  const ws = (await created.json()).workspace as { id: string };
  try {
    await page.goto("/admin");
    const row = page.locator(".steam", { hasText: name });
    await expect(row).toBeVisible();
    const chip = row.getByTestId("new-interface-chip");
    await expect(chip).toHaveText("New interface · off");
    await chip.click();
    await expect(chip).toHaveText("New interface · on");
    const listed = await page.request.get("/api/admin/invites").then((r) => r.json()) as { interfaceEveryone: boolean; workspaces: { id: string; newInterface: boolean }[] };
    expect(listed.workspaces.find((w) => w.id === ws.id)?.newInterface).toBe(true);
    expect(listed.interfaceEveryone).toBe(false);
    /* Everyone: asks first; cancelling changes nothing. */
    const everyone = page.getByTestId("new-interface-everyone").getByRole("button", { name: /Everyone/ });
    await expect(everyone).toHaveText("Everyone · off");
    await everyone.click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(everyone).toHaveText("Everyone · off");
    await everyone.click();
    await page.getByRole("button", { name: "Turn on for everyone" }).click();
    await expect(everyone).toHaveText("Everyone · on");
    await expect(chip).toBeDisabled();
    expect((await page.request.get("/api/admin/interface").then((r) => r.json())).everyone).toBe(true);
    await everyone.click();
    await page.getByRole("button", { name: "Turn off for everyone" }).click();
    await expect(everyone).toHaveText("Everyone · off");
    /* Off for this workspace again. */
    await chip.click();
    await expect(chip).toHaveText("New interface · off");
    expect((await page.request.patch(`/api/admin/workspaces/${ws.id}`, { data: { newInterface: "yes" } })).status()).toBe(400);
    expect((await page.request.patch("/api/admin/interface", { data: { everyone: "yes" } })).status()).toBe(400);
  } finally {
    await setNewInterfaceEveryone(false);
    await setNewInterface(ws.id, false);
  }
});
