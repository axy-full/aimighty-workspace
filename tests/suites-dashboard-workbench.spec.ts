import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Owner, 24 September: the management dashboard in the Suites. Workspace ›
 * Dashboard reads the analytics the platform already records — spend in the
 * workspace's unit (credits here: a credit workspace never sees the vendor's
 * dollars, which beside its credits would be the margin), by project, person
 * and model, revisions per shot, where generations stall — filters by
 * project and period, and exports CSV. Real local routes, mock engine:
 * nothing is spent.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];

test("Analytics: totals, by project and person (email masked), by model, a project filter — in credits, never a vendor dollar; its old tab opens Activity", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(180_000);
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}`, "Content-Type": "application/json" };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Dashboard test", "admin", "test", Date.now()] }); }
  finally { platform.close(); }
  const project = newProject(`Dashboard ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const production = String((await saved.json()).productionProjectId);

  /* Two real (mock) renders in the project. */
  for (const prompt of ["A red fox on the ice", "Keeper at the window"]) {
    const body = { prompt, model: "gemini-3.1-flash-image", projectId: production, shotId: "", ratio: "16:9", resolution: "1K", duration: 5, refine: false, references: [] };
    const quote = await page.request.post("/api/generate/quote", { headers, data: body }).then((r) => r.json());
    const made = await page.request.post("/api/generate", { headers: { ...headers, "Idempotency-Key": `dash-${randomUUID()}` }, data: { ...body, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint } });
    expect(made.ok(), await made.text()).toBe(true);
    const { id } = await made.json();
    await expect.poll(async () => (await page.request.get(`/api/jobs/${id}`, { headers }).then((r) => r.json())).generation?.status, { timeout: 60_000 }).toBe("succeeded");
  }

  /*
   * Release 1: Workspace > Dashboard (tables by project, person and model, a CSV) is not drawn by any page: its tab address opens Control
   * room > Activity (lib/shell/settings.ts › OLD_TAB_TO_SECTION). What the dashboard read is /api/analytics, so the money and privacy
   * assertions are held on that route: credits only, no vendor dollar, the person's email mostly hidden, a project filter. Activity
   * (desktop; a phone has no Activity screen) lists what each project settled, in credits.
   */
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const analytics = await page.request.get("/api/analytics", { headers }).then((r) => r.json());
  expect(analytics.totals.generations).toBe(2);
  expect(analytics.totals.credits).toBeGreaterThan(0);
  expect(JSON.stringify(analytics)).not.toMatch(/"spend"|"promptSpend"|"credit":|"cost/i);
  expect(analytics.byProject.map((r: { name: string }) => r.name)).toContain(project.name);
  const email = String(me.email ?? "");
  const person = analytics.byPerson.find((r: { id: string }) => r.id === me.id);
  expect(person.name).toBe(String(me.name ?? person.name));
  /* Two people can share a name: each row carries the email, mostly hidden, and never the full address. */
  expect(person.email).toContain(`${email[0]}•••@`);
  expect(JSON.stringify(analytics)).not.toContain(email);
  expect(analytics.byModel.map((r: { model?: string; label?: string }) => r.label ?? r.model).join(" ")).toContain("Nano Banana 2");
  /* A project filter re-reads that project alone. */
  const only = await page.request.get(`/api/analytics?projectId=${production}`, { headers }).then((r) => r.json());
  expect(only.totals.generations).toBe(2);
  expect(JSON.stringify(only)).not.toMatch(/"spend"|"promptSpend"|"credit":/);

  if (info.project.name === "workbench-1440x900") {
    await page.goto("/suites?view=workspace&tab=dashboard");
    await expect(page.getByTestId("control-room")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("control-room")).toContainText(/\bcr\b/, { timeout: 60_000 });
    expect(await page.getByTestId("control-room").innerText()).not.toMatch(/\$\s?\d|Cost \(USD\)/);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(email);
  }

  expect(errors).toEqual([]);
});
