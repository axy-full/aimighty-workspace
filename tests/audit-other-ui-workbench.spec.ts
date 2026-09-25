import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * Audit fixes on surfaces outside the suites (other-ui): the Library's
 * unfiled wall, the New asset sheet's training price, desktop menus, the
 * app-wide right-click menu, the asset library's paging, the prompt boxes'
 * attach, and the phone production header. Real local routes, mock engine;
 * nothing here reaches a provider.
 */
const DESKTOP = ["workbench-1440x900"];

const png = (fill: string) => sharp({ create: { width: 320, height: 320, channels: 3, background: fill } }).png().toBuffer();
function wav() {
  const bytes = Buffer.alloc(44 + 4800 * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

async function account(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  return { workspaceId: signed.workspace.id as string, me, scope, headers: { "X-Workbench-Scope": scope } };
}

/** Completed historical takes written straight into this login's new local tenant database. */
async function takes(page: Page, workspaceId: string, userId: string, rows: { id: string; kind: "image" | "video"; prompt: string; projectId?: string | null; shotId?: string | null }[]) {
  const platform = createClient({ url: localPlatformDbUrl() });
  let tenantUrl = "";
  try {
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url);
  } finally { platform.close(); }
  expect(tenantUrl).toMatch(/^file:/);
  const tenant = createClient({ url: tenantUrl });
  const image = await png("#3a4f6b");
  try {
    await mkdir(path.join(process.cwd(), ".data", "generations"), { recursive: true });
    for (const row of rows) {
      await writeFile(path.join(process.cwd(), ".data", "generations", `${row.id}.png`), image);
      await tenant.execute({
        sql: "INSERT INTO generations(id,project_id,shot_id,model,prompt,params,status,stored_url,kind,title,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [row.id, row.projectId ?? null, row.shotId ?? null, row.kind === "image" ? "gemini-3-pro-image" : "seedance-2.5", row.prompt, JSON.stringify({ rawPrompt: row.prompt, resolution: "1080p", width: 320, height: 320 }), "succeeded", `/api/media/${row.id}`, row.kind, row.prompt.slice(0, 40), userId, Date.now(), Date.now()],
      });
    }
  } finally { tenant.close(); }
}

async function production(page: Page, name: string) {
  const made = await page.request.post("/api/projects", { data: { name } });
  expect(made.ok(), await made.text()).toBe(true);
  const projectId = (await made.json()).id as string;
  const shot = await page.request.post("/api/shots", { data: { projectId, code: "SH01", title: "Opening frame", kind: "shot" } });
  expect(shot.ok(), await shot.text()).toBe(true);
  const shotJson = await shot.json();
  return { projectId, shotId: (shotJson.id ?? shotJson.shot?.id) as string };
}

test("Unfiled takes: File to shot files the take, Use prompt reaches Generate, and right-click keeps the browser's menu", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const { workspaceId, me, scope, headers } = await account(page);
  const { projectId, shotId } = await production(page, `Filing fixture ${randomUUID().slice(0, 6)}`);
  const toFile = `gen_audit_file_${randomUUID().replaceAll("-", "")}`;
  const toReuse = `gen_audit_reuse_${randomUUID().replaceAll("-", "")}`;
  await takes(page, workspaceId, me.id, [
    { id: toFile, kind: "image", prompt: "A lighthouse keeper climbs the stair" },
    { id: toReuse, kind: "image", prompt: "A red kite over the salt flats at noon" },
  ]);
  /* A saved project Generate can open, remembered the way Generate remembers one. */
  const draft: Project = { ...newProject("Unfiled fixture project"), productionProjectId: projectId };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: draft.id });
  const patches: (string | undefined)[] = [];
  page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes(`/api/jobs/${toFile}`)) patches.push(r.headers()["x-workbench-scope"]); });

  await page.goto("/library?all=1&view=unfiled");
  const card = page.getByRole("article").filter({ hasText: "A lighthouse keeper climbs the stair" });
  await expect(card).toBeVisible({ timeout: 30_000 });

  /* The browser's own menu on a link: nothing of ours opens, and the event is left alone. */
  await page.evaluate(() => window.addEventListener("contextmenu", (e) => { (window as unknown as { prevented: boolean }).prevented = e.defaultPrevented; }));
  /* The app-wide menu (components/ContextMenu) draws `.menu-pop`. */
  const deskMenu = page.locator(".menu-pop");
  await card.getByRole("link", { name: "Download take" }).click({ button: "right" });
  await expect.poll(() => page.evaluate(() => (window as unknown as { prevented?: boolean }).prevented)).toBe(false);
  await expect(deskMenu).toHaveCount(0);
  /* A text selection gets the desk's Copy, and no dead Paste. */
  const words = card.getByText("A lighthouse keeper climbs the stair").first();
  await words.selectText();
  await words.dispatchEvent("contextmenu", { button: 2, clientX: 0, clientY: 0 });
  await expect(deskMenu.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await expect(deskMenu.getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);
  await page.mouse.click(4, 4); // its backdrop closes it
  await expect(deskMenu).toHaveCount(0);

  /* File to shot: the write carries the tab's scope, and lands. */
  await card.getByRole("button", { name: "File to shot" }).click();
  const filing = page.getByRole("dialog", { name: "File to a project" });
  await filing.getByRole("button").filter({ hasText: "Filing fixture" }).first().click();
  await page.getByRole("dialog").getByRole("button").filter({ hasText: "SH01" }).click();
  await expect(page.getByText("Filed to SH01")).toBeVisible();
  expect(patches).toEqual([scope]);
  const filed = await page.request.get(`/api/jobs/${toFile}?sync=0`).then((r) => r.json());
  expect(filed.generation.shotId).toBe(shotId);

  /* Use prompt: Generate opens on this take's prompt. */
  await page.getByRole("article").filter({ hasText: "A red kite over the salt flats at noon" }).getByRole("button", { name: "Use prompt" }).click();
  await expect(page).toHaveURL(new RegExp(`/generate\\?.*promptFrom=${toReuse}`));
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("A red kite over the salt flats at noon", { timeout: 30_000 });
});

test("New asset: training is priced in the workspace's unit, only uploaded stills count, and a voice clip uploads", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const { workspaceId, me } = await account(page);
  const take = `gen_audit_still_${randomUUID().replaceAll("-", "")}`;
  await takes(page, workspaceId, me.id, [{ id: take, kind: "image", prompt: "Iver in profile against a white wall" }]);
  let price: number | null = null, unit = "";
  const identityBodies: Record<string, unknown>[] = [], trainBodies: Record<string, unknown>[] = [];
  await page.route("**/api/identities**", async (route) => {
    const r = route.request(), url = new URL(r.url());
    if (url.pathname === "/api/identities" && r.method() === "GET") {
      /* The real terms, in this workspace's unit, with a trainer connected. */
      const real = await (await route.fetch()).json();
      price = real.terms.trainCredits ?? real.terms.trainCostUsd;
      unit = real.terms.trainCredits != null ? "cr" : "usd";
      return route.fulfill({ json: { identities: [], terms: { ...real.terms, configured: true, minPhotos: 1 } } });
    }
    if (url.pathname === "/api/identities" && r.method() === "POST") {
      identityBodies.push(r.postDataJSON());
      return route.fulfill({ status: 201, json: { identity: { id: "idn_audit" } } });
    }
    if (url.pathname === "/api/identities/idn_audit/train") {
      trainBodies.push(r.postDataJSON());
      return route.fulfill({ status: 409, headers: { "Idempotency-Status": "complete" }, json: { error: "Stopped by the test." } });
    }
    return route.fallback();
  });
  await page.route("**/api/settings", (route) => route.request().method() === "GET" ? route.fulfill({ json: { settings: { trainOnCreate: "always" } } }) : route.fallback());

  await page.goto("/library?all=1&view=elements");
  await page.getByRole("button", { name: /^New asset/ }).click();
  const sheet = page.getByRole("dialog", { name: "New asset", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("textbox", { name: "Name", exact: true }).fill("Iver");

  /* A take is a reference, not a training photo. */
  await sheet.getByRole("button", { name: "A take", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: "Iver in profile" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(sheet).toContainText("Needs 1 uploaded stills of the same person; 0 so far.");
  await expect(sheet.getByRole("checkbox", { name: "Consent to train" })).toHaveCount(0);

  /* A voice clip goes up as a file and fills the VOICE port. */
  await sheet.locator("input[type=file]").setInputFiles({ name: "voice.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(sheet.getByRole("listitem").filter({ hasText: "VOICE" })).toContainText("ready", { timeout: 30_000 });
  await expect(page.getByText("Unrecognised file")).toHaveCount(0);

  /* An uploaded still counts; the price is the workspace's, never 0. */
  await sheet.locator("input[type=file]").setInputFiles({ name: "face.png", mimeType: "image/png", buffer: await png("#8a6b52") });
  await sheet.getByRole("checkbox", { name: "Consent to train" }).check({ timeout: 30_000 });
  expect(price).not.toBeNull();
  const shown = unit === "cr" ? `${price} cr` : `$${Number(price).toFixed(2)}`;
  const create = sheet.locator("[data-create]");
  await expect(create).toContainText(shown, { ignoreCase: true });
  await expect(create).not.toContainText(/\b0 cr\b/i);

  await create.click();
  await expect(page.getByText("Stopped by the test.")).toBeVisible();
  expect(identityBodies).toHaveLength(1);
  expect(identityBodies[0]).toMatchObject({ name: "Iver", reuseDraft: true });
  expect((identityBodies[0].photos as string[])).toHaveLength(1);
  expect(trainBodies[0]).toEqual(unit === "cr" ? { consent: true, maxCredits: price } : { consent: true, maxUsd: price });
});

test("Library filter menus close once a choice is made", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  await account(page);
  await page.goto("/library?all=1&view=elements");
  await page.getByRole("button", { name: /^Kind/ }).click();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: "Character", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Kind/ })).toContainText("Character");
});

test("Load more pressed during a background refresh waits for it, then loads", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const { scope } = await account(page);
  const upload = (id: string, filename: string) => ({ id, filename, mime: "image/png", kind: "image", bytes: 1024, width: 320, height: 320, durationS: null, sha256: id, url: `/api/uploads/${id}`, createdAt: Date.now() - (id === "up_audit_1" ? 0 : 60_000) });
  let hold: Promise<void> | null = null, release = () => {}, held = 0;
  await page.route((url) => url.pathname === "/api/uploads", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (!cursor && hold) { held++; await hold; }
    return route.fulfill({ json: cursor === "c1" ? { uploads: [upload("up_audit_2", "Second page.png")], nextCursor: null } : { uploads: [upload("up_audit_1", "First page.png")], nextCursor: "c1" } });
  });
  await page.goto("/library?all=1");
  await expect(page.locator('[data-library-id="upload:up_audit_1"]')).toBeVisible({ timeout: 30_000 });
  const more = page.getByRole("button", { name: "Load more uploads" });
  await expect(more).toBeVisible();

  hold = new Promise<void>((resolve) => { release = resolve; });
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("particl:assets-changed", { detail })), { scope });
  await expect.poll(() => held).toBe(1);
  await more.click();
  await expect(page.getByRole("button", { name: "Loading uploads…" })).toBeDisabled();
  release();
  await expect(page.locator('[data-library-id="upload:up_audit_2"]')).toBeVisible();
});

test("Prompt attach keeps the files that arrived when one fails, and the composer library offers no dead tools", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const { workspaceId, headers } = await account(page);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 500, "Attach audit", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Attach audit ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.route("**/api/uploads/finish", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.filename === "broken.png") return route.fulfill({ status: 422, json: { error: "The store refused this file." } });
    return route.fallback();
  });

  await page.goto(`/suites?view=gen&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name);
  await page.getByTestId("gen-attach-file").setInputFiles([
    { name: "look.png", mimeType: "image/png", buffer: await png("#2b6a4a") },
    { name: "broken.png", mimeType: "image/png", buffer: await png("#6a2b2b") },
  ]);
  await expect(page.getByTestId("gen-well")).toContainText("look.png", { timeout: 30_000 });
  await expect(page.getByTestId("gen-attach-note")).toContainText("broken.png could not be uploaded (The store refused this file)");

  /* The Generate composer's project library: references, yes; an edit or upscale button with nothing behind it, no. */
  await page.goto(`/workspace?project=${project.id}&suite=particl&page=rig`);
  await page.getByTestId("topbar-generate").click();
  const library = page.getByTestId("generate-composer").getByRole("complementary", { name: "Project library" });
  await expect(library.getByRole("button", { name: "Use as reference" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(library.getByRole("button", { name: "Edit image" })).toHaveCount(0);
  await library.getByRole("button", { name: /^Actions for look\.png/ }).first().click();
  await expect(page.getByRole("menuitem", { name: "Upscale image" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Edit image" })).toHaveCount(0);
});

test("Phone production header offers only the pages that exist", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one run");
  await account(page);
  const { projectId } = await production(page, `Header fixture ${randomUUID().slice(0, 6)}`);
  const list = await page.request.get("/api/productions").then((r) => r.json());
  const prod = (list.productions as { id: string; projects: { id: string }[] }[]).find((p) => p.projects.some((x) => x.id === projectId))!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/productions/${prod.id}/${projectId}/shots`);
  const tabs = page.getByRole("group", { name: "Project", exact: true });
  await expect(tabs.getByRole("button")).toHaveText(["Shots", "Media"], { timeout: 30_000 });
  await tabs.getByRole("button", { name: "Media" }).click();
  await expect(page).toHaveURL(new RegExp(`/productions/${prod.id}/${projectId}/media`));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
