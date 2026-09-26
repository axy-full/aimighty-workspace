import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * /connect lists the workspace's API tokens with what each spent this month.
 * A credit workspace reads that in the credits its takes were billed, never
 * the vendor's dollars behind them (beside its credits they are the margin).
 * The ceiling is still set in dollars. One real (mock) render through a
 * render token: nothing is spent.
 */
test("API tokens on /connect: a credit workspace reads a token's month in credits billed, never the vendor's dollars", async ({ page, playwright, baseURL }) => {
  test.setTimeout(120_000);
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 500, "Token test", "admin", "test", Date.now()] }); }
  finally { platform.close(); }
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: newProject(`Tokens ${randomUUID().slice(0, 6)}`), revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const projectId = String((await saved.json()).productionProjectId);
  const minted = await page.request.post("/api/tokens", { headers, data: { name: "Render agent", scope: "render", capUsd: 20 } });
  expect(minted.ok(), await minted.text()).toBe(true);

  /* The agent renders with its token. */
  const agent = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${(await minted.json()).token}` } });
  let billed = 0;
  try {
    const body = { prompt: "A red fox on the ice", model: "gemini-3.1-flash-image", projectId, shotId: "", ratio: "16:9", resolution: "1K", duration: 5, refine: false, references: [] };
    const quote = await agent.post("/api/generate/quote", { data: body }).then((r) => r.json());
    const made = await agent.post("/api/generate", { headers: { "Idempotency-Key": `tokens-${randomUUID()}` }, data: { ...body, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint } });
    expect(made.ok(), await made.text()).toBe(true);
    const { id } = await made.json();
    await expect.poll(async () => (await agent.get(`/api/jobs/${id}`).then((r) => r.json())).generation?.status, { timeout: 60_000 }).toBe("succeeded");
    billed = (await agent.get(`/api/jobs/${id}`).then((r) => r.json())).generation.creditsBilled;
  } finally { await agent.dispose(); }
  expect(billed).toBeGreaterThan(0);

  /* The route says the unit, and the month is exactly the credits that take was billed. */
  const listed = await page.request.get("/api/tokens", { headers }).then((r) => r.json());
  expect(listed).toMatchObject({ unit: "cr", tokens: [{ name: "Render agent", capUsd: 20, spendThisMonth: billed }] });

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/connect");
  await expect(page.getByText(`Can generate · ${billed} cr this month · $20.00 ceiling`, { exact: false })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(/\$\d+\.\d\d (of|this month)/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
