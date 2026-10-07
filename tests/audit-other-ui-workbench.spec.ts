import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { projectName } from "./helpers/projectName";

/**
 * Audit fixes on surfaces outside the suites (other-ui) that Release 1 still draws: the New asset sheet's training price and
 * Make's References well keeping the files that arrived when one fails. The rest of this file asserted the old Library wall,
 * Generate, the Rig phone board and Astra's history (Q15, old pages): removed.
 * Real local routes, mock engine; nothing here reaches a provider.
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
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl = "";
  try {
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url);
  } finally { platform.close(); }
  expect(tenantUrl).toMatch(/^file:/);
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
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

test("New asset: no training starts here (its consent lives on the Cast card), a take is a reference, and a voice clip uploads", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const { workspaceId, me } = await account(page);
  const take = `gen_audit_still_${randomUUID().replaceAll("-", "")}`;
  await takes(page, workspaceId, me.id, [{ id: take, kind: "image", prompt: "Rowan in profile against a white wall" }]);
  /* Review of #558, L-A: every training cites a consent record, which this sheet can't make, so it never trains. */
  const trainingCalls: string[] = [], elementBodies: Record<string, unknown>[] = [];
  await page.route("**/api/identities**", (route) => {
    const r = route.request();
    if (r.method() !== "GET") trainingCalls.push(new URL(r.url()).pathname);
    return route.fallback();
  });
  await page.route("**/api/rig/elements", (route) => {
    const r = route.request();
    if (r.method() !== "POST") return route.fallback();
    elementBodies.push(r.postDataJSON());
    return route.fulfill({ status: 409, json: { error: "Stopped by the test." } });
  });
  await page.route("**/api/settings", (route) => route.request().method() === "GET" ? route.fulfill({ json: { settings: { trainOnCreate: "always" } } }) : route.fallback());

  await page.goto("/library?all=1&view=elements");
  await page.getByRole("button", { name: /^New asset/ }).click();
  const sheet = page.getByRole("dialog", { name: "New asset", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("textbox", { name: "Name", exact: true }).fill("Rowan");
  await expect(sheet).toContainText("Train it from the Cast card, where its consent is recorded.");
  await expect(sheet.getByRole("switch")).toHaveCount(0);
  await expect(sheet.getByRole("checkbox", { name: "Consent to train" })).toHaveCount(0);

  /* A take is a reference. */
  await sheet.getByRole("button", { name: "A take", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: "Rowan in profile" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);

  /* A voice clip goes up as a file and fills the VOICE port. */
  await sheet.locator("input[type=file]").setInputFiles({ name: "voice.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(sheet.getByRole("listitem").filter({ hasText: "VOICE" })).toContainText("ready", { timeout: 30_000 });
  await expect(page.getByText("Unrecognised file")).toHaveCount(0);

  /* An uploaded still is a reference too; creating is free and trains nothing. */
  await sheet.locator("input[type=file]").setInputFiles({ name: "face.png", mimeType: "image/png", buffer: await png("#8a6b52") });
  const create = sheet.locator("[data-create]");
  await expect(create).toContainText(/\b0 cr\b|\$0\.00/i);
  await create.click();
  await expect(page.getByText("Stopped by the test.")).toBeVisible();
  expect(elementBodies).toHaveLength(1);
  expect(elementBodies[0]).toMatchObject({ name: "Rowan", kind: "character", identityId: null });
  expect(trainingCalls).toEqual([]);
});

test("Prompt attach keeps the files that arrived when one fails", async ({ page }, info) => {
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

  await page.goto(`/suites?make=video&project=${project.id}`);
  await expect(projectName(page)).toHaveText(project.name);
  /* Release 1: the old Gen composer's attach button is gone; Make's References well takes device files by drop (components/graphite/make/Compose.tsx
     > dropOnWell > dropToIds > the same uploadFilesToProject), so the files arrive as a drop on the well. */
  const files = [
    { name: "look.png", mime: "image/png", data: (await png("#2b6a4a")).toString("base64") },
    { name: "broken.png", mime: "image/png", data: (await png("#6a2b2b")).toString("base64") },
  ];
  await page.getByTestId("gen-well").evaluate((well, list) => {
    const transfer = new DataTransfer();
    for (const f of list) transfer.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.mime }));
    well.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, files);
  await expect(page.getByTestId("gen-well").getByTestId("make-reference")).toContainText("look.png", { timeout: 30_000 });
  await expect(page.getByTestId("gen-well").getByRole("alert")).toContainText("broken.png could not be uploaded (The store refused this file)");
});
