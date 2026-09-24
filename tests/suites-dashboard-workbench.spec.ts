import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Owner, 24 September: the management dashboard in the Suites. Workspace ›
 * Dashboard reads the analytics the platform already records — cost in
 * dollars and credits, by project, person and model, revisions per shot,
 * where generations stall — filters by project and period, and exports CSV.
 * Real local routes, mock engine: nothing is spent.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];

test("Workspace › Dashboard: totals, by project and person, stalls, a project filter and a CSV export", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(180_000);
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}`, "Content-Type": "application/json" };
  const platform = createClient({ url: localPlatformDbUrl() });
  try { await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Dashboard test", "admin", "test", Date.now()] }); }
  finally { platform.close(); }
  const project = newProject(`Dashboard ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const production = String((await saved.json()).productionProjectId);

  /* Two real (mock) renders in the project. */
  for (const prompt of ["A red fox on the ice", "Mara at the window"]) {
    const body = { prompt, model: "gemini-3.1-flash-image", projectId: production, shotId: "", ratio: "16:9", resolution: "1K", duration: 5, refine: false, references: [] };
    const quote = await page.request.post("/api/generate/quote", { headers, data: body }).then((r) => r.json());
    const made = await page.request.post("/api/generate", { headers: { ...headers, "Idempotency-Key": `dash-${randomUUID()}` }, data: { ...body, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint } });
    expect(made.ok(), await made.text()).toBe(true);
    const { id } = await made.json();
    await expect.poll(async () => (await page.request.get(`/api/jobs/${id}`, { headers }).then((r) => r.json())).generation?.status, { timeout: 60_000 }).toBe("succeeded");
  }

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?view=workspace&tab=dashboard");
  const dash = page.getByTestId("ws-dashboard");
  await expect(dash).toBeVisible();
  await expect(page.getByRole("tab", { name: "Dashboard" })).toHaveAttribute("aria-selected", "true");
  await expect(dash.getByTestId("dash-generations")).toHaveText("2", { timeout: 30_000 });
  await expect(dash.getByTestId("dash-cost")).toHaveText(/^\$\d+\.\d\d$/);
  await expect(dash.getByTestId("dash-projects")).toContainText(project.name);
  await expect(dash.getByTestId("dash-people")).toContainText(String(me.name ?? ""));
  /* Two people can share a name: each row carries the email, mostly hidden, and never the full address. */
  const email = String(me.email ?? "");
  await expect(dash.getByTestId("dash-people")).toContainText(`${email[0]}•••@`);
  await expect(dash.getByTestId("dash-people")).not.toContainText(email);
  await expect(dash.getByTestId("dash-models")).toContainText("Nano Banana 2");
  await expect(dash.getByTestId("dash-stuck")).toContainText("1K");
  await expect(dash.getByTestId("dash-iteration")).toContainText("Prompt length");

  /* A project row focuses the dashboard on that project; the period filter re-reads. */
  await dash.getByTestId("dash-projects").getByText(project.name).click();
  await expect(dash.getByTestId("dash-project")).toHaveValue(production);
  await expect(dash.getByTestId("dash-projects")).toHaveCount(0);
  await dash.getByRole("radio", { name: "7 days" }).click();
  await expect(dash.getByTestId("dash-generations")).toHaveText("2");

  /* CSV export. */
  const download = page.waitForEvent("download");
  await dash.getByTestId("dash-export").click();
  expect((await download).suggestedFilename()).toMatch(/^particl-dashboard-.+\.csv$/);

  /* On a phone the tables scroll inside the card, never the page. */
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (info.project.name === "workbench-1440x900") await dash.screenshot({ path: info.outputPath("dashboard-1440.png") });
  expect(errors).toEqual([]);
});
