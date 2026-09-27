import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { goWorkbenchStage, openWorkbenchInspector } from "./helpers/workbenchNavigation";
import { legacyShell } from "./helpers/legacyShell";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

/**
 * The legacy recovery buttons after a lost paid reply: Studio's "Recover
 * submitted take" (GenerationDialog) and Edit & Sound's "Recover submitted …"
 * (SoundGenerate). Neither sends the stored request again. The server is asked
 * what became of its Idempotency-Key (POST /api/generate/check):
 *
 *  - landed: that job is followed, and nothing is sent;
 *  - never arrived: nothing is sent, the key is fenced so the lost request can
 *    never land later, and a new take goes only from a later press on a button
 *    that shows its fresh price.
 *
 * The Studio dialog shares its recovery key with the Rig ([scope, draft, node]),
 * so a Rig take lost there is what the dialog finds. Real local routes against an
 * ENGINE_MOCK server; the network is intercepted only to lose a request or its
 * reply. Nothing is billed for real.
 */

const ENGINE = "dreamina-seedance-2-5-260628";
const SHOT = "lost-legacy";
const BEFORE = "Wide. Hold still on the empty harbour.";
const AFTER = "Close on her hands. She lets go of the rope.";
const SOUND_BEFORE = "Rain on a tin roof, distant thunder.";
const SOUND_AFTER = "Wind over dunes, a low constant bed.";

/* Test fixtures only: a Rig shot the legacy Studio can open ("generate" is a shot node type there too). */
function shot(id: string, title: string, note: string): CanvasNode {
  return {
    id, title, type: "generate", x: 100, y: 100, width: 344, linked: [], role: "Director", status: "draft", mode: "Video",
    operations: [{ id: `op-${id}`, kind: "direction", enabled: true, values: { note } }],
    engine: ENGINE, durationS: 5, ratio: "16:9", resolution: "720p",
  };
}

type Sent = { path: string; key: string | undefined; body: Record<string, unknown> };

async function seeded(page: Page, nodes: CanvasNode[]) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Local mock recovery fixture", "admin", "test", Date.now()],
    });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally {
    platform.close();
  }
  const project: Project = { ...newProject(`Lost reply ${randomUUID().slice(0, 6)}`), nodes };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const sent: Sent[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !/^\/api\/(generate|audio)(\/check)?$/.test(path)) return;
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body?.quoteOnly) return;
    sent.push({ path, key: request.headers()["idempotency-key"], body });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { project, scope, tenantUrl, workspaceId: signed.workspace.id, sent, errors };
}

async function savedProject(page: Page, scope: string, project: Project) {
  return (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json()) as { project: Project }).project;
}

/** Every job one production shot has on the server, and every charge the workspace has on the meter. */
async function ledger(tenantUrl: string, workspaceId: string, productionShotId: string | undefined) {
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const jobs = productionShotId
      ? (await tenant.execute({ sql: "SELECT id,prompt,status FROM generations WHERE shot_id=? ORDER BY created_at", args: [productionShotId] })).rows
        .map((r) => ({ id: String(r.id), prompt: String(r.prompt), status: String(r.status) }))
      : [];
    const charges = (await platform.execute({ sql: "SELECT id,billed_credits FROM meter_events WHERE workspace_id=? ORDER BY created_at", args: [workspaceId] })).rows
      .map((r) => ({ id: String(r.id), credits: Number(r.billed_credits) }));
    return { jobs, charges };
  } finally {
    tenant.close();
    platform.close();
  }
}

/** The ledger once `jobs` jobs exist and each is on the meter: admission writes a job's row, then reserves its charge. */
async function settledLedger(tenantUrl: string, workspaceId: string, productionShotId: string | undefined, jobs: number) {
  await expect.poll(async () => {
    const books = await ledger(tenantUrl, workspaceId, productionShotId);
    return [books.jobs.length, books.charges.length];
  }, { timeout: 60_000 }).toEqual([jobs, jobs]);
  return ledger(tenantUrl, workspaceId, productionShotId);
}

const CLAIMS = "particl:pending-generation:";
/** The claimed attempt for one node in the browser's recovery storage, if any. */
const claimOf = (page: Page, projectId: string, nodeId: string) =>
  page.evaluate(({ prefix, projectId, nodeId }) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith(prefix) && k.includes(JSON.stringify(projectId)) && k.endsWith(`${JSON.stringify(nodeId)}]`));
    return key ? (JSON.parse(localStorage.getItem(key)!) as { key: string; body: string; credits: number; endpoint?: string }) : null;
  }, { prefix: CLAIMS, projectId, nodeId });

/** Arm one paid POST to be lost: before it reaches the server, or after (only its reply dropped). */
async function loseNext(page: Page, pattern: string, how: "before" | "after") {
  const landed: { id?: string }[] = [];
  let armed = true;
  await page.route(pattern, async (route) => {
    const request = route.request();
    if (!armed || request.method() !== "POST" || (request.postDataJSON() as { quoteOnly?: boolean } | null)?.quoteOnly) return route.fallback();
    armed = false;
    if (how === "after") landed.push(await (await route.fetch()).json());
    return route.abort(how === "after" ? "connectionreset" : "internetdisconnected");
  });
  return () => String(landed[0]?.id ?? "");
}

/* ── The Rig, where the take is claimed and lost ─────────────────────────── */

async function rigInspector(page: Page): Promise<Locator> {
  const body = page.locator(`[data-inspector-body="shot"][data-shot-id="${SHOT}"]`);
  await expect(async () => {
    if (!(await body.isVisible())) await page.getByTestId("toggle-inspector").click();
    await expect(body).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await body.getByRole("group", { name: "Inspector tabs" }).getByRole("button", { name: /Controls/ }).click();
  return body;
}

async function rigPrice(body: Locator): Promise<number> {
  const button = body.locator(".pxw-insp-generate");
  await expect(button).toHaveText(/^Generate take · \d[\d,]* cr$/, { timeout: 60_000 });
  await expect(button).toBeEnabled();
  return Number((await button.textContent())!.replace(/.*· /, "").replace(/\D/g, ""));
}

/** A Rig take of the shot, pressed once and lost; then the shot is edited (a new note, one step longer). */
async function lostRigTake(page: Page, project: Project, scope: string, sent: Sent[], how: "before" | "after") {
  await page.goto(`/suites?suite=studio&page=rig&project=${project.id}`);
  const row = page.getByTestId("rig-list").locator(`.pxw-rig-row[data-shot-id="${SHOT}"]`);
  await expect(row).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  await row.click();
  const body = await rigInspector(page);
  const landedId = await loseNext(page, "**/api/generate", how);
  const credits = await rigPrice(body);
  await body.locator(".pxw-insp-generate").click();
  await expect.poll(() => sent.filter((s) => s.path === "/api/generate").length, { timeout: 60_000 }).toBe(1);
  await expect(body.locator(".pxw-insp-generate")).toHaveText(/^Generate take · /);
  const first = sent.find((s) => s.path === "/api/generate")!;
  expect(first.body.maxCredits).toBe(credits);
  expect(String(first.body.prompt)).toContain(BEFORE);
  const claim = await claimOf(page, project.id, SHOT);
  expect(claim?.key).toBe(first.key);

  await body.getByRole("textbox", { name: "Direction note" }).fill(AFTER);
  const before = (await body.getByTestId("shot-duration").textContent())!;
  await body.getByRole("button", { name: "Longer" }).click();
  await expect(body.getByTestId("shot-duration")).not.toHaveText(before);
  await expect.poll(async () => JSON.stringify((await savedProject(page, scope, project)).nodes.find((n) => n.id === SHOT)).includes(AFTER), { timeout: 20_000 }).toBe(true);
  return { first, claim: claim!, credits, landedId: landedId() };
}

/* ── The legacy Studio, where the same node's dialog finds the claim ─────── */

async function studioDialog(page: Page, project: Project) {
  await page.goto(await legacyShell(page, `/workbench?project=${project.id}&stage=canvas`));
  await goWorkbenchStage(page, "canvas");
  if (page.viewportSize()!.width < 760) {
    await page.locator(".mobile-node-viewbar").getByRole("tab", { name: "List", exact: true }).click();
    await page.locator(".mobile-node-list button").filter({ hasText: "Opening wide" }).click();
  } else {
    const node = page.getByRole("article", { name: "Generate node: Opening wide", exact: true });
    await node.focus();
    await node.press("Enter");
  }
  await page.getByRole("button", { name: "Generate take", exact: true }).click();
  return page.getByRole("dialog", { name: "Generate a new take", exact: true });
}

const madeOf = (prompt: string) => (prompt.includes(AFTER) ? "the node as it is now" : prompt.includes(BEFORE) ? "the stale take" : prompt.includes(SOUND_AFTER) ? "the new description" : prompt.includes(SOUND_BEFORE) ? "the stored description" : prompt);

test("Studio's Recover submitted take never re-sends a Rig take that never reached the server: nothing is made or billed, its key is fenced, and the node as it is now goes only at the price on the button", async ({ page }) => {
  test.setTimeout(240_000);
  const { project, scope, tenantUrl, workspaceId, sent, errors } = await seeded(page, [shot(SHOT, "Opening wide", BEFORE)]);
  const { first, claim } = await lostRigTake(page, project, scope, sent, "before");

  const dialog = await studioDialog(page, project);
  const recover = dialog.getByRole("button", { name: "Recover submitted take", exact: true });
  await expect(recover).toBeEnabled({ timeout: 30_000 });
  const mark = sent.length;
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && /^\/api\/generate(\/check)?$/.test(new URL(r.url()).pathname));
  await recover.click();
  await answered;

  /* What left the browser, and what the server made and billed, for a press that showed no price. */
  const productionShot = (await savedProject(page, scope, project)).shotMappings?.[SHOT];
  let books = await ledger(tenantUrl, workspaceId, productionShot);
  expect({ sent: sent.slice(mark).map((s) => s.path), made: books.jobs.map((j) => madeOf(j.prompt)), billed: books.charges.map((c) => c.credits) })
    .toEqual({ sent: ["/api/generate/check"], made: [], billed: [] });
  expect(sent[mark].body.key).toBe(first.key);

  /* Let go: the dialog starts again from the node as it is now, with its fresh price on the button. */
  await expect(dialog.getByRole("status").filter({ hasText: "Your last Generate never reached the server. Nothing was charged for it." })).toBeVisible();
  const generate = dialog.getByRole("button", { name: /^Generate · \d+ cr estimated$/ });
  await expect(generate).toBeEnabled({ timeout: 60_000 });
  await expect(dialog.getByLabel("Generation direction")).toHaveValue(new RegExp(AFTER.replace(/\./g, "\\.")));
  await expect.poll(() => claimOf(page, project.id, SHOT)).toBeNull();

  /* The lost request can never land now: its key was fenced when it was checked. */
  const late = await page.request.post("/api/generate", {
    headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": first.key! },
    data: claim.body,
  });
  expect(late.status()).toBe(409);
  expect(late.headers()["idempotency-status"]).toBe("complete");
  books = await ledger(tenantUrl, workspaceId, productionShot);
  expect({ made: books.jobs.length, billed: books.charges.length }).toEqual({ made: 0, billed: 0 });

  /* A new take goes only from the priced button: once, under a new key, at that price. */
  const shown = Number((await generate.textContent())!.replace(/\D/g, ""));
  const again = sent.length;
  await generate.click();
  await expect(dialog).not.toBeVisible({ timeout: 60_000 });
  const posted = sent.slice(again).filter((s) => s.path === "/api/generate");
  expect(posted).toHaveLength(1);
  expect(posted[0].key).not.toBe(first.key);
  expect(posted[0].body.maxCredits).toBe(shown);
  books = await settledLedger(tenantUrl, workspaceId, productionShot, 1);
  expect({ made: books.jobs.map((j) => madeOf(j.prompt)), billed: books.charges.map((c) => c.credits) }).toEqual({ made: ["the node as it is now"], billed: [shown] });
  expect(errors).toEqual([]);
});

test("Studio's Recover submitted take follows a Rig take that reached the server with its reply dropped: nothing is sent, and it stays billed once", async ({ page }) => {
  test.setTimeout(240_000);
  const { project, scope, tenantUrl, workspaceId, sent, errors } = await seeded(page, [shot(SHOT, "Opening wide", BEFORE)]);
  const { first, credits, landedId } = await lostRigTake(page, project, scope, sent, "after");
  expect(landedId).toBeTruthy();

  const dialog = await studioDialog(page, project);
  const recover = dialog.getByRole("button", { name: "Recover submitted take", exact: true });
  await expect(recover).toBeEnabled({ timeout: 30_000 });
  const mark = sent.length;
  await recover.click();
  await expect(dialog).not.toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Generation submitted. Follow its progress in Activity.")).toBeVisible();
  expect(sent.slice(mark).map((s) => s.path)).toEqual(["/api/generate/check"]);
  expect(sent[mark].body.key).toBe(first.key);
  await expect.poll(() => claimOf(page, project.id, SHOT)).toBeNull();
  const productionShot = (await savedProject(page, scope, project)).shotMappings?.[SHOT];
  const books = await settledLedger(tenantUrl, workspaceId, productionShot, 1);
  expect({ made: books.jobs.map((j) => j.id), billed: books.charges.map((c) => c.credits) }).toEqual({ made: [landedId], billed: [credits] });
  expect(errors).toEqual([]);
});

/* ── Edit & Sound (the legacy Studio's edit stage, every size) ─────────────── */

/** The sound panel on its sound-effect door (voice-over needs a voice, which a mock workspace has none of). */
async function soundPanel(page: Page, project: Project) {
  await page.goto(await legacyShell(page, `/workbench?project=${project.id}`));
  await goWorkbenchStage(page, "edit");
  await openWorkbenchInspector(page, "sound");
  const panel = page.getByRole("region", { name: "Generate sound" });
  await panel.scrollIntoViewIfNeeded();
  const door = panel.getByRole("group", { name: "Sound type" }).getByRole("button", { name: "Sound effect", exact: true });
  await expect(door).toBeEnabled({ timeout: 30_000 });
  await door.click();
  await expect(door).toHaveAttribute("aria-pressed", "true");
  return panel;
}

/** The sound-effect lane's node and its production shot, once the first press made them. */
async function sfxNode(page: Page, scope: string, project: Project) {
  const saved = await savedProject(page, scope, project);
  const node = saved.nodes.find((n) => n.role === "sound-lane:sound");
  return { nodeId: node?.id ?? "", productionShot: node ? saved.shotMappings?.[node.id] : undefined };
}

async function lostSoundEffect(page: Page, project: Project, scope: string, sent: Sent[], how: "before" | "after") {
  const panel = await soundPanel(page, project);
  const landedId = await loseNext(page, "**/api/audio", how);
  await panel.getByLabel("Describe the sound", { exact: true }).fill(SOUND_BEFORE);
  const generate = panel.locator("[data-sound-generate]");
  await expect(generate).toHaveText(/^Generate sound effect · \d+ cr$/, { timeout: 60_000 });
  await expect(generate).toBeEnabled();
  const credits = Number((await generate.textContent())!.replace(/\D/g, ""));
  await generate.click();
  await expect.poll(() => sent.filter((s) => s.path === "/api/audio").length, { timeout: 60_000 }).toBe(1);
  const first = sent.find((s) => s.path === "/api/audio")!;
  expect(first.body).toMatchObject({ task: "sound", text: SOUND_BEFORE, maxCredits: credits });
  await expect(generate).toHaveText(/^Recover submitted sound effect/, { timeout: 30_000 });
  const { nodeId } = await sfxNode(page, scope, project);
  await expect.poll(async () => (await claimOf(page, project.id, nodeId))?.key).toBe(first.key);
  return { first, credits, nodeId, claim: (await claimOf(page, project.id, nodeId))!, landedId: landedId() };
}

test("Edit & Sound's recovery shows the stored request, never re-sends it when it never reached the server, and a new one goes only at the price on the button", async ({ page }) => {
  test.setTimeout(240_000);
  const { project, scope, tenantUrl, workspaceId, sent, errors } = await seeded(page, []);
  const { first, credits, nodeId, claim } = await lostSoundEffect(page, project, scope, sent, "before");

  /* Remounted: the stored description is on show while it is unconfirmed, not an empty box. */
  await page.reload();
  const panel = await soundPanel(page, project);
  const script = panel.getByLabel("Describe the sound", { exact: true });
  const recover = panel.locator("[data-sound-generate]");
  await expect(recover).toHaveText(/^Recover submitted sound effect/, { timeout: 30_000 });
  await expect(recover).toBeEnabled();
  const onScreen = await script.inputValue();
  const mark = sent.length;
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && /^\/api\/(audio|generate\/check)$/.test(new URL(r.url()).pathname) && !(r.request().postDataJSON() as { quoteOnly?: boolean })?.quoteOnly);
  await recover.click();
  await answered;

  /* What the press showed, what left the browser, and what the server made and billed. */
  const { productionShot } = await sfxNode(page, scope, project);
  let books = await ledger(tenantUrl, workspaceId, productionShot);
  expect({ onScreen, sent: sent.slice(mark).map((s) => s.path), made: books.jobs.map((j) => madeOf(j.prompt)), billed: books.charges.map((c) => c.credits) })
    .toEqual({ onScreen: SOUND_BEFORE, sent: ["/api/generate/check"], made: [], billed: [] });
  expect(sent[mark].body).toMatchObject({ key: first.key, endpoint: "/api/audio" });
  await expect(panel.getByRole("status")).toContainText("Your last Generate never reached the server. Nothing was charged for it.");
  await expect.poll(() => claimOf(page, project.id, nodeId)).toBeNull();

  /* The lost request can never land now. */
  const late = await page.request.post("/api/audio", {
    headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": first.key! },
    data: claim.body,
  });
  expect(late.status()).toBe(409);
  expect(late.headers()["idempotency-status"]).toBe("complete");

  /* The form is the person's again; what goes is what is on screen, once, at the price then on the button. */
  await expect(script).toBeEnabled();
  await script.fill(SOUND_AFTER);
  await expect(recover).toHaveText(/^Generate sound effect · \d+ cr$/, { timeout: 60_000 });
  await expect(recover).toBeEnabled();
  const shown = Number((await recover.textContent())!.replace(/\D/g, ""));
  const again = sent.length;
  await recover.click();
  await expect(panel.getByRole("status")).toContainText("Sound effect submitted", { timeout: 60_000 });
  const posted = sent.slice(again).filter((s) => s.path === "/api/audio");
  expect(posted).toHaveLength(1);
  expect(posted[0].key).not.toBe(first.key);
  expect(posted[0].body).toMatchObject({ text: SOUND_AFTER, maxCredits: shown });
  books = await settledLedger(tenantUrl, workspaceId, productionShot, 1);
  expect({ made: books.jobs.map((j) => madeOf(j.prompt)), billed: books.charges.map((c) => c.credits) }).toEqual({ made: ["the new description"], billed: [shown] });
  expect(credits).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("Edit & Sound's recovery follows a sound effect that reached the server with its reply dropped: nothing is sent, and it stays billed once", async ({ page }) => {
  test.setTimeout(240_000);
  const { project, scope, tenantUrl, workspaceId, sent, errors } = await seeded(page, []);
  const { first, credits, nodeId, landedId } = await lostSoundEffect(page, project, scope, sent, "after");
  expect(landedId).toBeTruthy();

  await page.reload();
  const panel = await soundPanel(page, project);
  const recover = panel.locator("[data-sound-generate]");
  await expect(recover).toHaveText(/^Recover submitted sound effect/, { timeout: 30_000 });
  const mark = sent.length;
  await recover.click();
  await expect(panel.getByRole("list", { name: "Sound in progress" })).toContainText("Sound effect", { timeout: 60_000 });
  expect(sent.slice(mark).map((s) => s.path)).toEqual(["/api/generate/check"]);
  expect(sent[mark].body.key).toBe(first.key);
  await expect.poll(() => claimOf(page, project.id, nodeId)).toBeNull();
  const { productionShot } = await sfxNode(page, scope, project);
  const books = await settledLedger(tenantUrl, workspaceId, productionShot, 1);
  expect({ made: books.jobs.map((j) => j.id), billed: books.charges.map((c) => c.credits) }).toEqual({ made: [landedId], billed: [credits] });
  expect(errors).toEqual([]);
});
