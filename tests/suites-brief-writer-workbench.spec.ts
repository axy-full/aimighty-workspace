import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Production › Brief & Script (owner's brief, 23 September): the director picks
 * the agent (Claude, Grok or OpenAI), writes a prompt, sees the price, and the
 * agent writes a script; the draft is offered for review and redrafted from
 * notes until approved, and the approved draft becomes the project's script.
 * Real local routes and the mock engine: the quote, the reserved start, the
 * three durable phases and the redraft's source are all the server's own.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];

async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Brief writer test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Harbour ${randomUUID().slice(0, 6)}`);
  project.brief = "A fox crosses a frozen harbour at dusk while an old harbour master watches. Ninety seconds, quiet, no narration.";
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/workbench/development") && request.method() === "POST") bodies.push(request.postDataJSON()); });
  await page.goto(`/suites?suite=studio&page=brief&project=${project.id}`);
  await expect(page.getByTestId("brief-stage")).toBeVisible();
  return { project, headers, errors, bodies };
}

test("Brief & Script: choose Grok, estimate, write, review, redraft from notes, approve", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(120_000);
  const { project, headers, errors, bodies } = await setup(page);

  /* The agent: three families; Grok resolves to a Grok model. */
  const bar = page.getByTestId("agent-bar");
  for (const name of ["Claude", "Grok", "OpenAI"]) await expect(bar.getByRole("radio", { name })).toBeEnabled();
  await bar.getByRole("radio", { name: "Grok" }).click();
  await expect(bar.getByRole("button", { name: "Agent model" })).toContainText("Grok");

  /* The prompt is the brief; nothing is written without a price. */
  await expect(page.getByTestId("brief-prompt-input")).toHaveValue(project.brief);
  await expect(page.getByTestId("brief-empty")).toBeVisible();
  await page.getByTestId("brief-estimate").click();
  await expect(page.getByTestId("brief-quote")).toContainText("3 agent steps — draft, critique, refine · Grok");
  expect(bodies.at(-1)).toMatchObject({ kind: "write", quoteOnly: true, effort: "auto" });
  expect(String(bodies.at(-1)!.model)).toMatch(/^spacexai\/grok-/);
  await page.getByTestId("brief-write").click();

  /* Draft 1 arrives for review. */
  const review = page.getByTestId("brief-review");
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(review.getByText("Review · Draft 1")).toBeVisible();
  await expect(page.getByTestId("brief-screenplay")).toContainText("EXT. FROZEN HARBOUR - DUSK");
  await expect(page.getByTestId("brief-screenplay")).toContainText("Not tonight, little one.");
  await expect(review).toContainText("Mock draft: built from the prompt.");
  const first = bodies.find((b) => b.kind === "write" && !b.quoteOnly)!;
  expect(first).toMatchObject({ kind: "write", projectId: project.id });
  expect(first.fromJobId).toBeUndefined();

  /* Notes → a priced redraft of that draft. */
  await expect(page.getByTestId("brief-redraft-blocked")).toHaveText("Write your notes for the redraft.");
  await page.getByTestId("brief-notes").fill("Let the fox come back to the lamp at night.");
  await page.getByTestId("brief-redraft-estimate").click();
  await expect(page.getByTestId("brief-redraft-quote")).toContainText("3 agent steps");
  await page.getByTestId("brief-redraft").click();
  await expect(review.getByText("Review · Draft 2")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("brief-screenplay")).toContainText("You came back.");
  await expect(page.getByTestId("brief-screenplay")).toContainText("Let the fox come back to the lamp at night.");
  const redraft = bodies.filter((b) => b.kind === "write" && !b.quoteOnly).at(-1)!;
  expect(redraft).toMatchObject({ kind: "write", instructions: "Let the fox come back to the lamp at night." });
  expect(String(redraft.fromJobId)).toMatch(/^wb_development_/);

  /* Draft 1 stays readable. */
  await review.getByRole("tab", { name: "1" }).click();
  await expect(page.getByTestId("brief-screenplay")).toContainText("Not tonight, little one.");
  await review.getByRole("tab", { name: "2" }).click();

  await review.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("review.png") });
  /* Approve: the draft becomes the project's script, saved. */
  await page.getByTestId("brief-approve").click();
  await expect(page.getByTestId("brief-approved")).toBeVisible();
  await expect.poll(async () => {
    const saved = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json());
    return { script: saved.project?.script ?? "", source: saved.project?.production?.scriptApproval?.source };
  }, { timeout: 15_000 }).toMatchObject({ script: expect.stringContaining("You came back."), source: "agent" });

  /* The script editor knows it is approved. */
  await page.getByTestId("brief-tab-script").click();
  await expect(page.getByText("Approved from the agent’s draft.", { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath("brief.png"), fullPage: false });
  expect(errors).toEqual([]);
});
