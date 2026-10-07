import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { everySpendButtonPriced, floors, noBannedNames, shoot, signedInWarm, watchErrors } from "./helpers/r1-gaps";
import { SHOTS, desktop, emptyLibrary, seedBoard, watchPaid } from "./helpers/gaps-l2";
import type { Asset, CanvasNode, Project } from "../lib/workbench/studio";

/*
 * Gap screens, lane 2 · Transcribe (a card action on a video or audio original). The price is the server's own quote for the
 * source's length, read for free before anything runs; a person's press sends exactly that price through the existing claim-before-send
 * path (lib/workbench/transcription-request.ts); it runs on the card (the route answers when the transcript is ready, so the card
 * shows the time so far, not a made-up percentage); the transcript opens in a side panel with timed, editable lines; "Use as script"
 * writes the project's script and the toast's Undo puts back what it replaced. "Use as captions" is not drawn: Cut has no captions to
 * show yet. "Nothing billed" appears only when the server says it charged nothing. The canvas is the desktop's; phone widths skip.
 */
async function open(page: Page) {
  const workspaceId = await signedInWarm(page, "Transcribe Tester");
  const errors = watchErrors(page);
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const made = await page.request.post("/api/uploads", { headers: { "X-Workbench-Scope": scope }, multipart: { file: { name: "Source.mp4", mimeType: "video/mp4", buffer: await readFile("public/fixtures/clip.mp4") } } });
  expect(made.ok(), await made.text()).toBe(true);
  const upload = (await made.json()) as { id: string };
  const asset: Asset = { id: "src-1", uploadId: upload.id, name: "Source.mp4", kind: "video", category: "Reference", url: `/api/uploads/${upload.id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], mime: "video/mp4" };
  const node = { id: "node-src", title: "Source", type: "media", x: -1080, y: 400, width: 220, linked: [], assetId: "src-1" } as CanvasNode;
  const { project } = await seedBoard(page, workspaceId, (p: Project) => ({ ...p, script: "EXT. DUNES - DAY\n\nA first draft.", assets: [asset], nodes: [node] }));
  await emptyLibrary(page);
  const paid = watchPaid(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  return { paid, errors, project, scope, upload };
}
const card = (page: Page) => page.locator('[data-card-kind="media"]').first();

test("Transcribe shows its price before it runs; nothing is sent until a person presses", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const { paid, errors } = await open(page);
  await expect(card(page)).toBeVisible();
  const go = card(page).getByTestId("transcribe-go");
  await expect(go).toHaveText(/^Transcribe · [\d.,]+ cr$/);
  await expect(go).toHaveAttribute("data-spend", "priced");
  await expect(go).toHaveAttribute("data-spend-price", /^[\d.,]+ cr$/);
  expect(paid, "nothing paid before a person presses").toEqual([]);
  await everySpendButtonPriced(page);
  await noBannedNames(page, '[data-testid="board"]');
  await floors(page, '[data-testid="board"]', false);
  mkdirSync(SHOTS, { recursive: true });
  await shoot(page, info.project.name, "l2-transcribe-price");
  expect(errors).toEqual([]);
});

test("a press runs on the card with the time so far and Notify me when done; the transcript opens with timed, editable lines; Use as script has an Undo", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const { paid, project, scope } = await open(page);
  /* The paid answer is held for a moment so the running state can be seen; it is the local mock engine's own answer. */
  await page.route("**/api/audio/transcribe", async (route) => {
    if (JSON.parse(route.request().postData() ?? "{}").quoteOnly === true) return route.continue();
    await new Promise((r) => setTimeout(r, 2500));
    return route.continue();
  });
  const go = card(page).getByTestId("transcribe-go");
  await expect(go).toHaveText(/^Transcribe · [\d.,]+ cr$/);
  const shown = (await go.getAttribute("data-spend-price"))!;
  await go.click();
  const running = card(page).getByTestId("transcribe-running");
  await expect(running).toBeVisible();
  await expect(running).toContainText("Transcribing · 0:");
  await expect(running.getByTestId("transcribe-notify")).toHaveText("Notify me when done");
  await shoot(page, info.project.name, "l2-transcribe-running");
  const done = card(page).getByTestId("transcribe-done");
  await expect(done).toBeVisible({ timeout: 30_000 });
  expect(paid).toEqual(["/api/audio/transcribe"]);
  await expect(done).toContainText(/Transcript · \d+ lines?/);
  await done.getByTestId("transcribe-open").click();
  const panel = page.getByTestId("transcript-panel");
  await expect(panel).toBeVisible();
  const lines = panel.getByTestId("transcript-lines").locator("li");
  expect(await lines.count()).toBeGreaterThan(0);
  await expect(lines.first().locator(".gx-tp-at")).toHaveText(/^\d+:\d{2}\.\d$/);
  /* Use as captions is not drawn: Cut has nowhere to show captions yet. */
  await expect(panel).not.toContainText("captions");
  await expect(panel.getByTestId("transcript-script")).toHaveText("Use as script · free");
  await shoot(page, info.project.name, "l2-transcribe-done");
  /* A line is edited in place and kept. */
  const first = lines.first().locator("textarea");
  await first.fill("An edited first line.");
  await first.blur();
  await panel.getByTestId("transcript-script").click();
  await expect(page.getByText(/The transcript is the script now/)).toBeVisible();
  await expect.poll(async () => {
    const r = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } });
    return ((await r.json()) as { project: { script?: string } }).project.script ?? "";
  }, { timeout: 15_000 }).toContain("An edited first line.");
  /* Undo puts the earlier script back. */
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect.poll(async () => {
    const r = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } });
    return ((await r.json()) as { project: { script?: string } }).project.script ?? "";
  }, { timeout: 15_000 }).toContain("A first draft.");
  expect(shown).toMatch(/cr$/);
  /* After a reload the transcript is still there, and nothing is offered to buy again. */
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(card(page).getByTestId("transcribe-done")).toBeVisible();
  await expect(card(page).getByTestId("transcribe-go")).toHaveCount(0);
});

test("a failed transcription says Nothing billed only when the server says it charged nothing, and Retry carries the price", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  await open(page);
  let answer: { error: string; charged?: number } = { error: "Grok could not transcribe this take (500). Nothing was charged for it.", charged: 0 };
  await page.route("**/api/audio/transcribe", (route) => {
    if (JSON.parse(route.request().postData() ?? "{}").quoteOnly === true) return route.continue();
    /* A completed answer, as the server marks one (Idempotency-Status): final, and the claim is let go. */
    return route.fulfill({ status: 502, contentType: "application/json", headers: { "Idempotency-Status": "complete" }, body: JSON.stringify(answer) });
  });
  await card(page).getByTestId("transcribe-go").click();
  const action = card(page).getByTestId("transcribe-action");
  await expect(action).toContainText("Transcription failed · Nothing billed");
  await expect(action.getByTestId("transcribe-go")).toHaveText(/^Retry · [\d.,]+ cr$/);
  await expect(action.getByTestId("transcribe-go")).toHaveAttribute("data-spend", "priced");
  await shoot(page, info.project.name, "l2-transcribe-failed");
  /* An answer that does not say what was charged claims nothing about billing. */
  answer = { error: "Grok could not transcribe this take (500). Its charge could not be read; it is held for review." };
  await action.getByTestId("transcribe-go").click();
  await expect(action).toContainText("Transcription failed");
  await expect(action.getByTestId("transcribe-why")).toContainText("held for review");
  await expect(action).not.toContainText("Nothing billed");
});
