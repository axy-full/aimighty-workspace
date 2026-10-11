import { test, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { newProject, type Asset } from "../lib/workbench/studio";
import { dimLabels, smallTargets } from "./phoneFloors";
import { assetLinkHref } from "../lib/shell/asset-link";

/**
 * Idea 26: a link to a take, between real people on a local server — no route
 * mocks for the part under test. The sender copies a link; a teammate in the
 * same workspace opens it and gets THEIR OWN draft of the production (offered,
 * never created while the link loads), never the sender's private draft; a
 * person in another workspace resolves nothing; a person in both is offered a
 * switch. Until a link resolves, nothing about the take is on screen or asked
 * for. Nothing paid is sent: the take is a stored fixture.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const TAKE_TITLE = "Lantern on the pier at dusk";
const scopeOf = (workspaceId: string, userId: string) => `particl-active-${workspaceId}-${userId}`;

type Person = { page: Page; userId: string; workspace: { id: string; name: string }; headers: Record<string, string>; apiCalls: string[] };

/** A signed-in person in their own new workspace, in a browser context shaped like the project under test. */
async function person(browser: Browser, info: TestInfo, name: string): Promise<Person> {
  const use = info.project.use;
  const context = await browser.newContext({ baseURL: process.env.PW_BASE_URL, viewport: use.viewport ?? undefined, isMobile: use.isMobile, hasTouch: use.hasTouch });
  const page = await context.newPage();
  const account = await signInLocally(page.request, name);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string };
  /* Every API call the page makes, to prove what it did not ask for. */
  const apiCalls: string[] = [];
  page.on("request", (request) => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/")) apiCalls.push(url.pathname + url.search); });
  return { page, userId: me.id, workspace: account.workspace, headers: { "X-Workbench-Scope": scopeOf(account.workspace.id, me.id) }, apiCalls };
}

/** Add `who` to `workspace` as a member, and move their session into it. */
async function join(who: Person, workspace: { id: string; name: string }) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,?,?)", args: [workspace.id, who.userId, "member", 0, Date.now()] });
  } finally { platform.close(); }
  const switched = await who.page.request.post("/api/workspaces/switch", { headers: who.headers, data: { id: workspace.id } });
  expect(switched.ok(), await switched.text()).toBe(true);
  who.headers = { "X-Workbench-Scope": scopeOf(workspace.id, who.userId) };
}

/** The sender's saved draft of a production, a stored take filed to it, and an upload only their private draft references. */
async function production(sender: Person) {
  /* A paid plan's production allowance, as the project-library fixture does: the sender's production is not the point here. */
  const plan = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await plan.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [sender.workspace.id] }); } finally { plan.close(); }
  const bytes = await readFile("public/fixtures/still.png");
  const session = randomUUID();
  const chunk = await sender.page.request.post("/api/uploads/chunk", { headers: sender.headers, multipart: { session, index: "0", chunk: { name: "chunk", mimeType: "application/octet-stream", buffer: bytes } } });
  expect(chunk.ok(), await chunk.text()).toBe(true);
  const finish = await sender.page.request.post("/api/uploads/finish", { headers: sender.headers, data: { session, count: 1, filename: "Private camera test.png", purpose: "chat" } });
  expect(finish.ok(), await finish.text()).toBe(true);
  const privateUpload = (await finish.json()) as { id: string };
  const asset: Asset = { id: privateUpload.id, name: "Private camera test.png", kind: "image", category: "Reference", url: `/api/uploads/${privateUpload.id}`, uploadId: privateUpload.id, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
  const draft = { ...newProject(`Harbour cut ${randomUUID().slice(0, 6)}`), assets: [asset] };
  const saved = await sender.page.request.put("/api/workbench/projects", { headers: sender.headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = (await saved.json()) as { productionProjectId: string };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let dbUrl: string;
  try { dbUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [sender.workspace.id] })).rows[0].db_url); } finally { platform.close(); }
  const take = `render_${randomUUID().replaceAll("-", "")}`;
  await mkdir(".data/generations", { recursive: true });
  await writeFile(`.data/generations/${take}.png`, bytes);
  const tenant = createClient({ url: dbUrl, timeout: 10_000 });
  try {
    await tenant.execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,stored_url,kind,title,created_by,created_at,updated_at) VALUES(?,?,'gemini-3-pro-image','A lantern on the pier','{}','succeeded',?,'image',?,?,?,?)", args: [take, productionProjectId, `/api/media/${take}`, TAKE_TITLE, sender.userId, Date.now(), Date.now()] });
  } finally { tenant.close(); }
  return { draft, production: productionProjectId, take, asset: `generation:${take}`, privateUpload: privateUpload.id };
}

/**
 * The link the sender's Copy link puts on the clipboard (lib/shell/asset-link.ts › assetLinkHref, the one function every Copy link
 * calls). Release 1 draws no surface that offers Copy link: it lived on the Inspector of the old Library pages, which the board's
 * own Inspector replaced without it. The reader's side, which this spec is about, is unchanged.
 */
function copyLink(sender: Person, production: string, asset: string) {
  const href = assetLinkHref({ origin: process.env.PW_BASE_URL ?? "http://localhost:4551", workspace: sender.workspace.id, production, asset });
  expect(href, "a link names the workspace, the production and the take").toBeTruthy();
  return new URL(href!);
}

/** The shell's phone: below 768 px, or a short touch screen (844x390), where the phone's own screens replace the canvas (lib/shell/use-compact.ts). */
const isPhone = (page: Page) => { const v = page.viewportSize(); return !v || v.width < 768 || v.height <= 500; };

/** The board is up on its Shots region (where the Takes page went), the link's own params gone from the address. The fixture's take is filed on no shot, so no shot card holds it to select. */
async function takeOpened(page: Page, _asset: string) {
  /* A phone draws the board's address as the project's Record (phone-record), not the canvas. */
  const phone = isPhone(page);
  await expect(page.getByTestId(phone ? "phone-record" : "board")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => { const q = new URL(page.url()).searchParams; return [q.get("view"), q.get("region"), q.has("ws"), q.has("production")]; }).toEqual(["board", "shots", false, false]);
}

/** Nothing about the take was shown or asked for. */
async function nothingOfTheTake(who: Person, take: string) {
  await expect(who.page.getByText(TAKE_TITLE)).toHaveCount(0);
  expect(who.apiCalls.filter((call) => call.includes(take)), "no request names the take").toEqual([]);
  await expect(who.page.getByTestId("board"), "the board waits behind the link's card").toHaveCount(0);
}

/** The card's floors: thumb-sized, inside the screen, above the tab bar. With LINK_SHOTS_DIR set, a picture of it. */
async function cardFloors(page: Page, info: TestInfo) {
  const card = page.getByTestId("link-card");
  await expect(card).toBeVisible();
  if (process.env.LINK_SHOTS_DIR) await page.screenshot({ path: `${process.env.LINK_SHOTS_DIR}/${await card.getAttribute("data-phase")}-${info.project.name.replace("workbench-", "")}.png` });
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, '[data-testid="link-card"]'), "link card targets under 44×44").toEqual([]);
    expect(await dimLabels(page, '[data-testid="link-card"]')).toEqual([]);
  }
  const box = (await card.boundingBox())!;
  expect(box.x + box.width, "the card inside the screen").toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  const bar = page.getByTestId("tabbar");
  if (await bar.isVisible()) expect(box.y + box.height, "the card ends above the tab bar").toBeLessThanOrEqual((await bar.boundingBox())!.y + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}

test("a teammate's link opens the reader's own draft of the production — offered, never made while the link loads — and never the sender's private draft", async ({ browser }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const sender = await person(browser, info, "Sender");
  const made = await production(sender);
  const link = copyLink(sender, made.production, made.asset);
  expect(Object.fromEntries(link.searchParams)).toEqual({ view: "board", region: "shots", ws: sender.workspace.id, production: made.production, asset: made.asset });

  const reader = await person(browser, info, "Teammate");
  await join(reader, sender.workspace);
  try {
    /* No draft of this production yet: opening it is offered, and nothing is made or read until it is pressed. */
    await reader.page.goto(link.pathname + link.search);
    await expect(reader.page.getByTestId("link-card")).toHaveAttribute("data-phase", "no-draft");
    await expect(reader.page.getByTestId("link-lead")).toHaveText(`This take is in ${made.draft.name}, which you have not opened yet.`);
    await nothingOfTheTake(reader, made.take);
    expect(reader.apiCalls.filter((call) => call.startsWith("/api/workbench/library")), "no library is read while the link is held").toEqual([]);
    expect(await reader.page.request.get(`/api/workbench/projects?production=${made.production}`, { headers: reader.headers }).then((r) => r.json())).toEqual({ id: null });
    await cardFloors(reader.page, info);

    await reader.page.getByTestId("link-open").click();
    await takeOpened(reader.page, made.asset);
    const url = new URL(reader.page.url());
    expect(url.searchParams.has("ws")).toBe(false);
    expect(url.searchParams.has("production")).toBe(false);
    const own = (await reader.page.request.get(`/api/workbench/projects?production=${made.production}`, { headers: reader.headers }).then((r) => r.json())) as { id: string };
    expect(own.id).toBeTruthy();
    expect(own.id).not.toBe(made.draft.id);
    expect(url.searchParams.get("project")).toBe(own.id);

    /* The sender's private draft stays theirs: not readable, not a library, and its private upload is not in the reader's. */
    expect((await reader.page.request.get(`/api/workbench/projects?id=${made.draft.id}`, { headers: reader.headers }).then((r) => r.json())).project).toBeNull();
    expect((await reader.page.request.get(`/api/workbench/library?projectId=${made.draft.id}&source=uploads`, { headers: reader.headers })).status()).toBe(404);
    expect((await reader.page.request.get(`/api/workbench/library?projectId=${own.id}&source=uploads&id=${made.privateUpload}`, { headers: reader.headers }).then((r) => r.json())).uploads).toEqual([]);
    expect((await reader.page.request.get(`/api/workbench/library?projectId=${own.id}&source=generations&id=${made.take}`, { headers: reader.headers }).then((r) => r.json())).generations.map((g: { id: string }) => g.id)).toEqual([made.take]);

    /* With a draft of their own, the same link goes straight to the take. */
    await reader.page.goto(link.pathname + link.search);
    await takeOpened(reader.page, made.asset);
    await expect(reader.page.getByTestId("link-card")).toHaveCount(0);

    /* An address-bar URL naming the sender's draft opens nothing in its place — not the reader's own project either. */
    reader.apiCalls.length = 0;
    await reader.page.goto(`/suites?project=${made.draft.id}&page=takes&sp=takes&asset=${encodeURIComponent(made.asset)}`);
    await expect(reader.page.getByTestId("link-card")).toHaveAttribute("data-phase", "unavailable");
    await expect(reader.page.getByTestId("link-lead")).toHaveText("The project this link names is not one of yours.");
    await nothingOfTheTake(reader, made.take);
    await cardFloors(reader.page, info);
    await reader.page.getByTestId("link-dismiss").click();
    await expect(reader.page.getByTestId("link-card")).toHaveCount(0);
    await expect.poll(() => new URL(reader.page.url()).searchParams.get("asset")).toBeNull();
    await expect(reader.page.getByTestId(isPhone(reader.page) ? "phone-record" : "board")).toBeVisible({ timeout: 60_000 });
  } finally {
    await reader.page.context().close();
    await sender.page.context().close();
  }
});

test("a link from a workspace the reader is not in resolves nothing there; one of the reader's other workspaces is offered as a switch, and the link opens after it", async ({ browser }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const sender = await person(browser, info, "Sender");
  const made = await production(sender);
  const link = copyLink(sender, made.production, made.asset);
  const outsider = await person(browser, info, "Outsider");
  const member = await person(browser, info, "Member of both");
  try {
    /* Another studio entirely: nothing is resolved, asked for or shown, and there is nothing to switch to. */
    await outsider.page.goto(link.pathname + link.search);
    await expect(outsider.page.getByTestId("link-card")).toHaveAttribute("data-phase", "workspace");
    await expect(outsider.page.getByTestId("link-lead")).toHaveText("This link is for a workspace you are not in.");
    await expect(outsider.page.getByTestId("link-switch")).toHaveCount(0);
    await nothingOfTheTake(outsider, made.take);
    expect(outsider.apiCalls.filter((call) => call.startsWith("/api/workbench/projects") || call.startsWith("/api/workbench/library")), "no project or library read for a foreign link").toEqual([]);
    await cardFloors(outsider.page, info);
    await outsider.page.getByTestId("link-dismiss").click();
    await expect(outsider.page.getByTestId("link-card")).toHaveCount(0);
    await expect.poll(() => new URL(outsider.page.url()).searchParams.get("ws")).toBeNull();
    expect(new URL(outsider.page.url()).searchParams.get("asset")).toBeNull();

    /* Someone in both workspaces, working in their own: switching is offered, and the link opens once they have. */
    const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try { await platform.execute({ sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,?,?)", args: [sender.workspace.id, member.userId, "member", 0, Date.now()] }); }
    finally { platform.close(); }
    await member.page.goto(link.pathname + link.search);
    await expect(member.page.getByTestId("link-card")).toHaveAttribute("data-phase", "workspace");
    await expect(member.page.getByTestId("link-lead")).toHaveText(`This take is in ${sender.workspace.name}, another of your workspaces.`);
    await nothingOfTheTake(member, made.take);
    await cardFloors(member.page, info);
    await member.page.getByTestId("link-switch").click();
    await expect(member.page.getByTestId("link-card")).toHaveAttribute("data-phase", "no-draft");
    await member.page.getByTestId("link-open").click();
    await takeOpened(member.page, made.asset);
  } finally {
    await outsider.page.context().close();
    await member.page.context().close();
    await sender.page.context().close();
  }
});
