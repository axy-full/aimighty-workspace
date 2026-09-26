import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { DESKTOP, forbidPaid, projectWithShots } from "./helpers/appPagesAudit";

/**
 * Part of the app-pages audit, in a real browser against a local ENGINE_MOCK=1
 * server: the Rig canvas on a desktop and on a phone. Nothing here submits
 * paid work. The audit is spread over files whose names sort apart, because CI
 * shards take contiguous runs of files and each legacy page costs its dev
 * server gigabytes to compile.
 */

test("the Rig canvas opens, carries a Library reference, offers only runnable nodes and says when a save fails", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "The board is built on a desktop.");
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);

  await page.goto("/rig/canvas/new");
  await expect(page.getByText("A board belongs to a project.")).toBeVisible();

  /* A real Library reference: a free upload of a still that ships with the app. */
  const me = await (await page.request.get("/api/me")).json();
  const uploaded = await page.request.post("/api/uploads", {
    headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` },
    multipart: { file: { name: "Rain reference.webp", mimeType: "image/webp", buffer: readFileSync("public/campaign/character.webp") } },
  });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const ref = ((await uploaded.json()) as { id: string }).id;

  /* A failed board list is said, with a retry, instead of spinning. */
  let failList = true;
  await page.route("**/api/rig/boards?projectId=*", (route) => (failList ? route.fulfill({ status: 500, json: { error: "The database is busy." } }) : route.fallback()));
  await page.goto(`/rig/canvas/new?project=${project.id}&ref=${ref}`);
  await expect(page.getByText("Couldn’t open the board. The database is busy.")).toBeVisible();
  failList = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page).toHaveURL(new RegExp(`/rig/canvas/brd_[^?]+\\?ref=${ref}$`));
  /* The reference lands as a note on the board, named for the upload, and the board saves. */
  await expect(page.getByRole("article", { name: "Note node" })).toHaveCount(1);
  await expect(page.getByRole("article", { name: "Note node" }).getByRole("textbox")).toHaveValue("REF · Rain reference.webp");
  await expect.poll(async () => ((await (await page.request.get(page.url().replace(/.*\/rig\/canvas\/([^?]+).*/, "/api/rig/boards/$1"))).json()).board.nodes as unknown[]).length).toBe(1);
  await expect(page.getByRole("alert").filter({ hasText: /Not saved|Someone else/ })).toHaveCount(0);

  /* The add menu offers only what a board runs, and choosing an item adds it. */
  await page.getByRole("button", { name: /Add node/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /^Image/ })).toBeVisible();
  for (const kind of ["Upscale", "Audio", "Voice", "Compare", "Edit"]) await expect(menu.getByRole("menuitem", { name: new RegExp(`^${kind}`) })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: /^Image/ }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect.poll(async () => ((await (await page.request.get(page.url().replace(/.*\/rig\/canvas\/([^?]+).*/, "/api/rig/boards/$1"))).json()).board.nodes as unknown[]).length).toBe(2);

  /* A save the server refuses leaves a visible Not saved with a retry. */
  let failSave = true;
  await page.route("**/api/rig/boards/brd_*", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    return failSave ? route.fulfill({ status: 500, json: { error: "The database is busy." } }) : route.fallback();
  });
  await page.getByRole("button", { name: /Add node/ }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: /^Prompt/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not saved · The database is busy." })).toBeVisible();
  failSave = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not saved" })).toHaveCount(0);

  /* A teammate saved first: the board says so and does not overwrite them. */
  const boardId = page.url().match(/brd_[^?/]+/)![0];
  const current = (await (await page.request.get(`/api/rig/boards/${boardId}`)).json()).board as { nodes: unknown[]; updatedAt: number };
  const teammate = await page.request.put(`/api/rig/boards/${boardId}`, { data: { nodes: current.nodes, wires: [], baseUpdatedAt: current.updatedAt } });
  expect(teammate.ok()).toBe(true);
  await page.getByRole("button", { name: /Add node/ }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: /^Note/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Someone else changed this board." })).toBeVisible();
  /* Reloading takes the teammate's board and puts back the note added here, which then saves. */
  const before = current.nodes.length;
  await page.getByRole("button", { name: "Reload the board" }).click();
  await expect(page.getByText("Reloaded · 1 node you added put back")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /Someone else|Not saved/ })).toHaveCount(0);
  await expect.poll(async () => ((await (await page.request.get(`/api/rig/boards/${boardId}`)).json()).board.nodes as unknown[]).length).toBe(before + 1);
});

test("on a phone, a node a board cannot run says so and carries no price", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-390x844", "The phone board, once.");
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);
  const made = await page.request.post("/api/rig/boards", { data: { projectId: project.id, name: "Phone board" } });
  const board = ((await made.json()) as { board: { id: string; updatedAt: number } }).board;
  const gen = (id: string, kind: string, x: number) => ({ id, kind, x, y: 0, label: id, ports: [], inputs: [], settings: {}, state: "idle", credits: 0, staleSince: null, output: null });
  const put = await page.request.put(`/api/rig/boards/${board.id}`, { data: { nodes: [gen("up1", "upscale", 0), gen("img1", "image", 300)], wires: [] } });
  expect(put.ok(), await put.text()).toBe(true);
  await page.goto(`/rig/canvas/${board.id}`);
  const upscale = page.locator("[data-phone-board]").getByRole("button", { name: /Doesn’t run on a board/ });
  await expect(upscale).toBeVisible();
  await expect(upscale).toBeDisabled();
  await expect(upscale).not.toContainText(/cr/i);
  /* An image node still runs, priced. */
  await expect(page.locator("[data-phone-board]").getByRole("button", { name: /^Generate/ })).toContainText(/\d+ CR/i);
});
