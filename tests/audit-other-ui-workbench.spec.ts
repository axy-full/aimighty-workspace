import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";
import { newProject, type Project } from "../lib/workbench/studio";
import { createAstraScene } from "../lib/astra-blender/scene";

/**
 * Audit fixes on surfaces outside the suites (other-ui): the Library's
 * unfiled wall, the New asset sheet's training price, desktop menus, the
 * app-wide right-click menu, the asset library's paging, the prompt boxes'
 * attach, the phone production header and the Rig's Apply on a phone.
 * Real local routes, mock engine; nothing here reaches a provider.
 */
const DESKTOP = ["workbench-1440x900"];
const PHONES = ["workbench-360x640", "workbench-390x844"];
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

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

test("Unfiled takes: File to shot files the take, Use prompt reaches Generate with no project remembered, and right-click keeps the browser's menu", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const { workspaceId, me, scope, headers } = await account(page);
  const { projectId, shotId } = await production(page, `Filing fixture ${randomUUID().slice(0, 6)}`);
  const toFile = `gen_audit_file_${randomUUID().replaceAll("-", "")}`;
  const toReuse = `gen_audit_reuse_${randomUUID().replaceAll("-", "")}`;
  await takes(page, workspaceId, me.id, [
    { id: toFile, kind: "image", prompt: "A lighthouse keeper climbs the stair" },
    { id: toReuse, kind: "image", prompt: "A red kite over the salt flats at noon" },
  ]);
  /* A saved project Generate can open. Nothing remembers it: the Library names
     no project and Generate has none in memory, so Generate has to ask. */
  const draft: Project = { ...newProject("Unfiled fixture project"), productionProjectId: projectId };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
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

  /* Use prompt: Generate asks for a project in place, and the prompt survives the choice. */
  await page.getByRole("article").filter({ hasText: "A red kite over the salt flats at noon" }).getByRole("button", { name: "Use prompt" }).click();
  await expect(page).toHaveURL(new RegExp(`/generate\\?.*promptFrom=${toReuse}`));
  await expect(page).not.toHaveURL(/[?&]project=/);
  await page.getByRole("navigation", { name: "Saved projects" }).getByRole("link", { name: "Unfiled fixture project" }).click({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`project=${draft.id}`));
  await expect(page).toHaveURL(new RegExp(`promptFrom=${toReuse}`));
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("A red kite over the salt flats at noon", { timeout: 30_000 });

  /* The still's role is an output setting with its own visible label, not a
     "First frame" beside the reference thumbnails. */
  const saveAs = page.getByRole("group", { name: "Save still as" });
  await expect(saveAs).toBeVisible();
  await expect(saveAs).toContainText("Save still as");
  await expect(saveAs.getByRole("button", { name: "Loose", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[aria-label="Generation references"]').getByRole("button", { name: "First frame" })).toHaveCount(0);
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
  test.skip(!PHONES.includes(info.project.name), "phones");
  await account(page);
  const { projectId } = await production(page, `Header fixture ${randomUUID().slice(0, 6)}`);
  const list = await page.request.get("/api/productions").then((r) => r.json());
  const prod = (list.productions as { id: string; projects: { id: string }[] }[]).find((p) => p.projects.some((x) => x.id === projectId))!;
  await page.goto(`/productions/${prod.id}/${projectId}/shots`);
  const tabs = page.getByRole("group", { name: "Project", exact: true });
  await expect(tabs.getByRole("button")).toHaveText(["Shots", "Media"], { timeout: 30_000 });
  await tabs.getByRole("button", { name: "Media" }).click();
  await expect(page).toHaveURL(new RegExp(`/productions/${prod.id}/${projectId}/media`));
  expect(await fits(page)).toBe(true);
});

test("Rig on a phone: Apply prices each shot at the engine's own settings, sends that ceiling, and rebinds only once a take starts", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phones");
  await account(page);
  const engine = "dreamina-seedance-2-0-260128"; // lengths 4-15s: a 3s shot bills 4s
  const at = Date.now();
  const node = (id: string, kind: string, label: string, extra: Record<string, unknown> = {}) => ({ id, kind, label, x: 0, y: 0, ref: null, ports: [], inputs: [], output: null, settings: {}, state: "idle", credits: 0, staleSince: null, ...extra });
  const board = {
    id: "brd_audit", projectId: "prj_audit", name: "Apply fixture", createdAt: at, updatedAt: at,
    nodes: [
      node("n_asset", "asset", "@Iver", { ref: { elementId: "el_iver" }, ports: [{ id: "face", label: "FACE", attributeId: "att_face", versionId: "ver_1", version: "v1" }] }),
      node("n_shot", "shot", "SH01", { ref: { shotId: "sh1" }, inputs: [{ id: "cast", label: "CAST" }], settings: { title: "Wide" } }),
      node("n_video", "video", "Seedance", { ref: { engine }, settings: { resolution: "1080p", seconds: 5 } }),
    ],
    wires: [{ id: "w1", from: { nodeId: "n_asset", portId: "face" }, to: { nodeId: "n_shot", slotId: "cast" }, kind: "inherited" }],
  };
  const shot = (id: string, code: string, planned: number, description: string) => ({ id, projectId: "prj_audit", code, title: code, description, cast: ["@Iver"], planned, setup: {}, state: "draft", takes: 0, spend: 0 });
  const version = (id: string, i: number) => ({ id, attributeId: "att_face", elementId: "el_iver", label: `v${i}`, uploadId: null, genId: null, identityId: null, status: "ready", createdAt: at + i });
  const element = { id: "el_iver", projectId: "prj_audit", castId: null, kind: "character", name: "Iver", description: "", locked: false, lockedBy: null, lockedAt: null, fromShotId: null, fromGenId: null, createdAt: at,
    attributes: [{ id: "att_face", elementId: "el_iver", kind: "face", label: "Face", currentId: "ver_1", locked: false, position: 0, versions: [version("ver_1", 1), version("ver_2", 2)] }] };
  const bodies: Record<string, unknown>[] = [];
  const puts: { nodes: { id: string; ports: { versionId?: string; version?: string }[] }[] }[] = [];
  let phase: "drop" | "refuse" = "drop";
  await page.route((url) => url.pathname === "/api/rig/boards/brd_audit", (route) => {
    if (route.request().method() === "PUT") { puts.push(route.request().postDataJSON()); return route.fulfill({ json: { board } }); }
    return route.fulfill({ json: { board } });
  });
  await page.route((url) => url.pathname === "/api/shots", (route) => route.fulfill({ json: { shots: [shot("sh1", "SH01", 3, "Iver crosses the ice"), shot("sh2", "SH02", 8, "Iver turns"), shot("sh3", "SH03", 5, "Iver waves")] } }));
  await page.route((url) => url.pathname === "/api/rig/elements", (route) => route.fulfill({ json: { elements: [element] } }));
  await page.route((url) => url.pathname === "/api/generate", async (route) => {
    const body = route.request().postDataJSON();
    bodies.push(body);
    if (phase === "refuse") return route.fulfill({ status: 409, json: { error: "The generation estimate changed." } });
    // The first take starts; the connection drops on the second.
    return bodies.length === 1 ? route.fulfill({ status: 202, json: { id: "gen_audit_1", status: "queued" } }) : route.abort("connectionreset");
  });

  await page.goto("/rig/canvas/brd_audit");
  await page.getByRole("button", { name: "CAST slot" }).click({ timeout: 30_000 });
  const sheet = page.getByRole("dialog", { name: "CAST · SH01" });
  await sheet.getByRole("option").nth(1).click();
  const draftSubset = sheet.getByRole("radio", { name: /^Apply to draft · 3/ });
  await expect(draftSubset).not.toContainText("No price");
  await draftSubset.click();
  const apply = page.locator("[data-apply]");
  await expect(apply).toContainText("Apply v2 to draft");
  expect(await fits(page)).toBe(true);
  await apply.click();

  const toast = page.getByRole("status").filter({ hasText: "Iver" });
  await expect(toast).toContainText("Iver → v2 · 1 of 3 takes rendering");
  await expect(toast).toContainText("SH02 may not have started: the connection dropped");
  expect(bodies.map((b) => b.shotId)).toEqual(["sh1", "sh2"]);
  /* Priced and sent at what admission bills: the 3s shot at the engine's 4s. */
  expect(bodies[0]).toMatchObject({ model: engine, shotId: "sh1", ratio: "16:9", resolution: "1080p", duration: 4, projectId: "prj_audit" });
  expect(bodies[1]).toMatchObject({ duration: 8 });
  const cost = (await toast.textContent())!.match(/rendering · ([^·]+?) ·/)?.[1]?.trim() ?? "";
  if (/cr$/i.test(cost)) expect(bodies[0].maxCredits).toBe(Number(cost.replace(/\D/g, "")));
  else expect(bodies[0]).not.toHaveProperty("maxCredits");
  /* One take started, so the slot now carries v2. */
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0].nodes.find((n) => n.id === "n_asset")!.ports[0]).toMatchObject({ versionId: "ver_2", version: "v2" });

  /* Nothing starts: the binding stays where it was, and the refusal is said. */
  phase = "refuse";
  bodies.length = 0;
  await page.getByRole("button", { name: "CAST slot" }).click();
  await sheet.getByRole("option").nth(0).click();
  await sheet.getByRole("radio", { name: /^Apply to draft · 3/ }).click();
  await page.locator("[data-apply]").click();
  await expect(page.getByRole("status").filter({ hasText: "Nothing started" })).toContainText("Nothing started · Iver stays on v2 · SH01 didn't start: The generation estimate changed");
  expect(bodies).toHaveLength(1);
  await page.waitForTimeout(800); // past the board's 400ms save beat
  expect(puts).toHaveLength(1);
});

test("The changed surfaces fit every size: Library unfiled wall, New asset sheet, Generate's project choice and composer", async ({ page }) => {
  const { workspaceId, me, headers } = await account(page);
  const { projectId } = await production(page, `Fit fixture ${randomUUID().slice(0, 6)}`);
  await takes(page, workspaceId, me.id, [{ id: `gen_audit_fit_${randomUUID().replaceAll("-", "")}`, kind: "image", prompt: "A heron standing in a flooded field" }]);
  const draft: Project = { ...newProject("Fit fixture project"), productionProjectId: projectId };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);

  await page.goto("/library?all=1&view=unfiled");
  await expect(page.getByRole("article").filter({ hasText: "A heron standing in a flooded field" })).toBeVisible({ timeout: 30_000 });
  expect(await fits(page)).toBe(true);

  await page.goto("/library?all=1&view=elements");
  await page.getByRole("button", { name: /^New asset/ }).first().click({ timeout: 30_000 });
  await expect(page.getByRole("dialog", { name: "New asset", exact: true })).toBeVisible();
  expect(await fits(page)).toBe(true);

  await page.goto("/generate?mode=images");
  const choice = page.getByRole("navigation", { name: "Saved projects" }).getByRole("link", { name: "Fit fixture project" });
  await expect(choice).toBeVisible({ timeout: 30_000 });
  expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await fits(page)).toBe(true);
  await choice.click();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeVisible({ timeout: 30_000 });
  const saveAs = page.getByRole("group", { name: "Save still as" });
  await saveAs.scrollIntoViewIfNeeded();
  await expect(saveAs).toBeVisible();
  /* Touch sizes (below 900 wide) get 44px targets. */
  if (page.viewportSize()!.width < 900) for (const b of await saveAs.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await fits(page)).toBe(true);
});

test("Astra: a failed render-history poll clears on the next good one, and the upscale picker takes the same file again", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const { headers } = await account(page);
  const me = await page.request.get("/api/me").then((r) => r.json());

  /* Upscale: the picker is emptied after every choice, so the same file fires again after a failed upload. */
  const { projectId } = await production(page, `Astra fixture ${randomUUID().slice(0, 6)}`);
  const draft: Project = { ...newProject("Astra fixture project"), productionProjectId: projectId };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  let finishes = 0;
  await page.route("**/api/uploads/finish", (route) => { finishes++; return route.fulfill({ status: 422, json: { error: "The store refused this clip." } }); });
  await page.goto(`/generate?mode=video&task=upscale&project=${draft.id}`);
  const picker = page.getByLabel("Upload Astra source");
  const clip = { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048, 1) };
  await picker.setInputFiles(clip, { timeout: 30_000 });
  await expect(picker).toHaveValue("");
  await expect.poll(() => finishes, { timeout: 30_000 }).toBe(1);
  await picker.setInputFiles(clip);
  await expect.poll(() => finishes, { timeout: 30_000 }).toBe(2);
  await page.unroute("**/api/uploads/finish");

  /* Render history: a failed poll says so; the next good poll takes the message away. */
  const project: Project = { ...newProject("Astra poll study"), id: "astra-poll-study", productionProjectId: "astra-poll-production", shotMappings: {}, astraBlender: createAstraScene("product"), astraNative: { schemaVersion: 1, name: "Poll study", program: "import bpy\n", assetIds: [] } };
  let historyDown = true;
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/me") return route.fulfill({ json: me });
    if (url.pathname === "/api/workbench/projects") return route.fulfill({ json: request.method() === "PUT" ? { revision: 2, productionProjectId: project.productionProjectId, shotMappings: {} } : { project, projects: [{ id: project.id, name: project.name }], productions: [], revision: 1 } });
    if (url.pathname === "/api/workbench/astra-blender/render") {
      if (request.method() !== "GET") return route.fulfill({ status: 409, json: { error: "No renders in this fixture." } });
      return historyDown
        ? route.fulfill({ status: 503, json: { error: "Render history is unavailable right now." } })
        : route.fulfill({ json: { runtime: { configured: true, reason: null, blenderVersion: "5.0", timeoutMs: 180000, vcpus: 2, memoryMb: 4096 }, jobs: [] } });
    }
    if (request.method() !== "GET") return route.fulfill({ status: 409, json: { error: "Unexpected write in this fixture." } });
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { generations: [], nextCursor: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto(await legacyShell(page, `/workbench?project=${project.id}&stage=astra-blender`));
  const workspace = page.getByRole("region", { name: "Astra", exact: true });
  await expect(workspace).toBeVisible({ timeout: 30_000 });
  await workspace.getByRole("navigation", { name: "Inspector panels" }).getByRole("button", { name: "Output", exact: true }).click();
  const panel = workspace.getByRole("region", { name: "Native 3D renders", exact: true });
  await expect(panel.getByRole("alert")).toContainText("Render history is unavailable right now.");
  historyDown = false;
  await panel.getByRole("button", { name: "Refresh native render history" }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByText("3D runtime 5.0 · Ready", { exact: true })).toBeVisible();
});
