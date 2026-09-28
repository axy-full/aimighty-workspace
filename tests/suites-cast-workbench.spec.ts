import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Production › Cast & Elements (owner's brief, 23 September): the cast list
 * comes from the beat sheet or the chosen agent — the agent runs on the real
 * local routes with the mock engine. Building a character or element with
 * Soul Cinema, Soul Location or Soul Cast, finishing it and saving it as a
 * reference element ran on the connected Higgsfield account; that sign-in is
 * retired (lib/higgsfield-consumer/retired.ts), so for everyone, the workspace
 * owner included, the builds are one card and each entry's reference still is
 * made in Gen on this workspace's credits. Nothing asks the account.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n";

async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  expect(me.owner, "the owner's own workspace").toBe(true);
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  /* The server writes the same local files; wait for its lock instead of failing on SQLITE_BUSY. */
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Cast test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Cast ${randomUUID().slice(0, 6)}`);
  project.script = SCRIPT;
  const sha256 = createHash("sha256").update(SCRIPT).digest("hex");
  project.production = { beats: { scriptSha256: sha256, updatedAt: new Date().toISOString(), scenes: [
    { id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "The crossing", beats: [{ id: "beat-a", text: "The fox crosses" }], shots: [{ id: "shot-a", description: "The fox", framing: "", movement: "", lighting: "", sound: "" }], characters: ["Fox"], locations: ["Frozen harbour"], props: ["Lantern"] },
  ] } };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);

  /* Every account request the page makes, bar the shell collector's list of saved jobs (a ledger read). */
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/higgsfield/consumer/")) return;
    if (request.method() === "GET" && url.pathname === "/api/higgsfield/consumer/generation") return;
    asked.push(`${request.method()} ${url.pathname}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?suite=studio&page=cast&project=${project.id}`);
  await expect(page.getByTestId("cast-stage")).toBeVisible();
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project;
  return { errors, asked, read };
}

test("Cast & Elements: the list comes from the beat sheet and the agent; the builds are the retired card, and each entry's still is made in Gen", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(150_000);
  const { errors, asked, read } = await setup(page);
  await expect(page.getByTestId("page-title")).toHaveText("Cast & Elements");

  /* The builds ran on the account: one card says so, and nothing of them is offered. */
  const card = page.getByTestId("owner-run-cast");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("owner-run-cast-title")).toHaveText("Particl no longer signs in to Higgsfield");
  for (const gone of ["cast-connect", "cast-price", "cast-build", "cast-blocked", "cast-elements", "page-soul", "cast-element-save"]) await expect(page.getByTestId(gone)).toHaveCount(0);

  /* Free: the beat sheet's character and prop (its locations are built in Environment). */
  await page.getByTestId("cast-from-beats").click();
  const entries = page.getByTestId("cast-entry");
  await expect(entries).toHaveCount(2);
  await expect(page.getByTestId("cast-counts")).toHaveText("1 characters · 1 elements");

  /* The agent adds what the beat sheet did not name (Mara, and a prop), keeping the names already here. */
  await page.getByTestId("cast-agent-estimate").click();
  await expect(page.getByTestId("cast-agent-quote")).toContainText("3 agent steps");
  await page.getByTestId("cast-agent-start").click();
  await expect(entries).toHaveCount(4, { timeout: 60_000 });
  await expect(entries.filter({ has: page.locator('input[value="Mara"]') })).toHaveCount(1);
  /* The list is saved with the project. */
  await expect.poll(async () => ((await read()).production?.cast?.entries ?? []).length, { timeout: 15_000 }).toBe(4);

  /* No Soul ID to carry and nothing to build: the fox's still is made in Gen, with its words. */
  const fox = entries.filter({ has: page.locator('input[value="Fox"]') });
  await expect(fox.getByLabel("Fox Soul ID")).toHaveCount(0);
  await fox.getByLabel("Fox prompt", { exact: true }).fill("A red fox on the ice at dusk");
  await fox.getByTestId("cast-still-gen").click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Images" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("A red fox on the ice at dusk");
  await page.screenshot({ path: info.outputPath("cast.png") });
  expect(asked, "nothing asks the account").toEqual([]);
  expect(errors).toEqual([]);
});
