import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * A Crew round whose streamed answer was lost. The rounds route files no job
 * and binds no Idempotency-Key, so POST /api/generate/check cannot answer for
 * it; its key is its round number instead (claimRound runs round N only while
 * N - 1 rounds have run). The browser keeps the round it sent until the room
 * says what became of it, and a second press reads the room before anything
 * else: a round that ran is never run again, and the lost request itself,
 * arriving late, runs nothing.
 *
 * Real local routes against an ENGINE_MOCK server (the mock room answers with
 * canned lines); the network is intercepted only to lose the round's answer
 * and the room read that follows it. Nothing is billed for real.
 */

const GOAL = "Open the film without dialogue and still make the product unmistakable inside the first four seconds.";

async function open(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), account.workspace.id, 500, "Local mock crew fixture", "admin", "test", Date.now()],
    });
  } finally {
    platform.close();
  }
  const project = { ...newProject(`Crew lost round ${randomUUID().slice(0, 6)}`), brief: "One kitchen, one rainy dawn. The bottle is never held up to camera." };
  expect((await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } })).ok()).toBe(true);
  const rounds: { body: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /^\/api\/crew\/sessions\/[^/]+\/rounds$/.test(new URL(request.url()).pathname)) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (!body.quoteOnly) rounds.push({ body });
    }
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?project=${project.id}&view=crew`);
  await expect(page.getByTestId("suite-mark")).toHaveText("CREW", { timeout: 60_000 });
  return { workspaceId: account.workspace.id, headers, rounds, errors };
}

/** Every settled crew round the workspace has on the meter. */
async function charges(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    return (await platform.execute({ sql: "SELECT billed_credits FROM meter_events WHERE workspace_id=? AND engine='xai' AND status='succeeded' ORDER BY created_at", args: [workspaceId] })).rows.map((r) => Number(r.billed_credits));
  } finally {
    platform.close();
  }
}

test("a crew round whose answer was lost is read from the room, never run twice, and the lost request arriving late runs nothing", async ({ page }) => {
  test.setTimeout(240_000);
  const f = await open(page);
  /* The room has loaded (its roster seated) before the goal is written. */
  await expect(page.getByTestId("crew-run-reason")).toHaveText("Write the goal.", { timeout: 60_000 });
  await page.getByTestId("crew-goal").fill(GOAL);
  await expect(page.getByTestId("crew-goal")).toHaveValue(GOAL);
  const run = page.getByTestId("crew-run");
  await expect(run).toHaveText(/^Run round · \d[\d,]*(?:\.\d)? cr$/, { timeout: 60_000 });

  /* The round reaches the server and runs; its streamed answer is lost, and so is the room read after it. */
  let lose = true;
  let lost: { url: string; body: string } | null = null;
  await page.route(/\/api\/crew\/sessions\/[^/]+\/rounds$/, async (route) => {
    const request = route.request();
    if (!lose || request.method() !== "POST" || (request.postDataJSON() as { quoteOnly?: boolean }).quoteOnly) return route.fallback();
    lose = false;
    lost = { url: request.url(), body: request.postData() ?? "" };
    await (await route.fetch()).text();
    return route.abort("connectionreset");
  });
  let blind = true;
  await page.route(/\/api\/crew\/sessions\/[^/?]+$/, (route) => {
    if (!blind || lose || route.request().method() !== "GET") return route.fallback();
    blind = false;
    return route.abort("internetdisconnected");
  });
  await run.click();
  await expect(page.getByTestId("crew-notice")).toContainText("could not be re-read", { timeout: 60_000 });
  expect(f.rounds).toHaveLength(1);
  const billed = await charges(f.workspaceId);
  expect(billed).toHaveLength(1);

  /* The second press, the room unread since: what left the browser, and what the meter holds. */
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("crew-notice")).toContainText(/Your last round|Round \d complete|price changed|room has been re-read|could not start|already/, { timeout: 90_000 });
  expect({ sent: f.rounds.length - 1, billed: await charges(f.workspaceId) }).toEqual({ sent: 0, billed });
  await expect(page.getByTestId("crew-notice")).toHaveText("Your last round ran; the room has been re-read. Nothing new was sent.");

  /* The lost request, arriving now, runs nothing. */
  const late = await page.request.post(lost!.url, { headers: { ...f.headers, "Content-Type": "application/json" }, data: lost!.body });
  expect(late.status()).toBe(409);
  expect(await charges(f.workspaceId)).toEqual(billed);

  /* The next round is the next number, at the price then on the button, run once. */
  await expect(run).toHaveText(/^Run round · \d[\d,]*(?:\.\d)? cr$/);
  await run.click();
  await expect(page.getByTestId("crew-notice")).toContainText("Round 2 complete", { timeout: 60_000 });
  expect(f.rounds.at(-1)!.body).toMatchObject({ round: 2 });
  expect(await charges(f.workspaceId)).toHaveLength(2);
  expect(f.errors).toEqual([]);
});
