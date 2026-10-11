import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { newProject } from "../lib/workbench/studio";

/**
 * Release 1 (owner, 8 Oct): files attached on the empty board reach Atomik's planning call. The plan request carries
 * their ids; the server checks them against this project's Library and hands them to the planner (ENGINE_MOCK=1's
 * scripted planner puts a note on the board for each, so the proposal shows what it was given). The files are priced
 * in: "Start · up to N cr" moves when they are attached, and the run is asked at that figure, the server's own for
 * those files. Only Atomik's thinking is asked for (mocked); no render is sent. The canvas is desktop only.
 */
const SHOTS = process.env.ATTACH_PLAN_SHOTS || join(tmpdir(), "particl-attach-plan");
const still = () => readFileSync("public/campaign/hero.webp");
const figureOf = async (page: Page) => Number((await page.getByTestId("board-start").getAttribute("data-spend-price"))?.match(/^up to ([\d.,]+) cr$/)?.[1].replace(/,/g, "") ?? NaN);

test("Start on the empty board sends the attached files with the plan, at a figure that prices them in", async ({ page }) => {
  test.skip(page.viewportSize()!.width < 1024, "the empty board is on the desktop canvas; phones open the project's Record");
  await signInWithNewInterface(page.request, "Attach Planner");
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string } };
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  await forbidPaidWork(page);
  const generated: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/(generate(?!\/quote)|jobs)/.test(new URL(r.url()).pathname)) generated.push(new URL(r.url()).pathname); });
  const asked: Record<string, unknown>[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/workbench/team-canvas") asked.push(r.postDataJSON() as Record<string, unknown>); });
  /* The server's planning figures for the files attached, as the board read them (attachment ids → figure). */
  const quotes = new Map<string, number>();
  page.on("response", async (r) => {
    const url = new URL(r.url());
    if (r.request().method() !== "GET" || url.pathname !== "/api/workbench/team-canvas" || !url.searchParams.has("attachment") || !r.ok()) return;
    const body = await r.json().catch(() => null) as { agent?: { ask?: { planning?: number } | null } } | null;
    if (typeof body?.agent?.ask?.planning === "number") quotes.set(url.searchParams.getAll("attachment").join(" "), body.agent.ask.planning);
  });

  const project = newProject("Attach plan fixture");
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await page.goto(`/suites?project=${project.id}&view=board`);
  const empty = page.getByTestId("board-empty");
  await expect(empty.getByRole("heading", { name: "What are we making?" })).toBeVisible({ timeout: 60_000 });
  const start = page.getByTestId("board-start");

  /* The figure for this board with nothing attached: Start wears it. */
  await expect(start).toHaveText(/^Start · up to [\d.,]+ cr$/, { timeout: 30_000 });
  const bare = await figureOf(page);
  expect(bare).toBeGreaterThan(0);

  await empty.locator('input[type="file"]').setInputFiles([
    { name: "frame.webp", mimeType: "image/webp", buffer: still() },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Wide on the water at first light.") },
  ]);
  await expect(page.getByTestId("board-attached").getByTestId("attach-thumb")).toHaveCount(2, { timeout: 30_000 });
  /* Attached, they are priced in: the figure moves up before anything is pressed. */
  await expect.poll(() => figureOf(page), { timeout: 30_000 }).toBeGreaterThan(bare);
  const figure = await figureOf(page);
  await expect(start).toHaveAttribute("data-spend", "priced");

  await empty.getByRole("textbox", { name: "What are we making?" }).fill("Two shots of the harbour at dawn.");
  await expect(start).not.toHaveAttribute("aria-disabled", "true");
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/board-attach-start-${page.viewportSize()!.width}x${page.viewportSize()!.height}.png` });
  await start.click();

  /* The plan request carries the files' ids, at the figure on the button. */
  await expect.poll(() => asked.find((a) => a.action === "agent.plan") ?? null, { timeout: 30_000 }).not.toBeNull();
  const plan = asked.find((a) => a.action === "agent.plan")!;
  const ids = plan.attachments as string[];
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(id).toMatch(/^upload:[A-Za-z0-9_-]+$/);
  expect(plan).toMatchObject({ limit: figure, mode: "ask" });

  /* That figure is the server's for exactly those files (the estimator the charge reserves at). */
  expect(quotes.get(ids.join(" "))).toBe(figure);
  const productionId = String(plan.productionId);
  /* An id that isn't in this project's Library is refused, never priced. */
  const foreign = await page.request.get(`/api/workbench/team-canvas?${new URLSearchParams({ productionId, agent: "1", projectId: project.id, attachment: "upload:not-here" })}`, { headers });
  expect(foreign.status()).toBe(400);

  /* The mock planner was handed them: its proposal holds a note for each. */
  let run: { state?: string; proposal?: unknown } | null = null;
  await expect.poll(async () => {
    const read = await (await page.request.get(`/api/workbench/team-canvas?${new URLSearchParams({ productionId, agent: "1" })}`, { headers })).json() as { agent: { run: { state: string } | null } };
    run = read.agent.run;
    return run?.state ?? null;
  }, { timeout: 60_000 }).toBe("awaiting_approval");
  const shown = JSON.stringify(run);
  expect(shown).toContain("Attached: frame.webp");
  expect(shown).toContain("Attached: notes.txt");
  await expect(page.getByTestId("board-agent-panel").getByTestId("agent-proposal")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/board-attach-proposal-${page.viewportSize()!.width}x${page.viewportSize()!.height}.png` });

  /* Only Atomik's thinking was asked for: nothing was rendered. */
  expect(generated).toEqual([]);
});
