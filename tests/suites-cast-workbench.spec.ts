import { test, expect, type Locator, type Page } from "@playwright/test";
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
const hydrated = (target: Locator) => expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);

/** `scene`: the beat sheet's names in place of the fox and the lantern. */
async function setup(page: Page, scene: { characters?: string[]; props?: string[] } = {}) {
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
    { id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "The crossing", beats: [{ id: "beat-a", text: "The fox crosses" }], shots: [{ id: "shot-a", description: "The fox", framing: "", movement: "", lighting: "", sound: "" }], characters: ["Fox"], locations: ["Frozen harbour"], props: ["Lantern"], ...scene },
  ] } };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);

  /* Every account request the page makes: none, not even a list of saved jobs (the shell's collector went with the sign-in). */
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/higgsfield/consumer/")) return;
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

/**
 * "Add N from the beat sheet" appended the list its render counted. When the
 * agent's cast landed between that render and the click, React ran the
 * handler from the render before, and a name both listed was added twice. The
 * click now decides on the list as it is when its update applies. This test
 * keeps the button's click handler from the render before the agent's names
 * landed and runs it after them: that order, every time.
 */
test("Add from the beat sheet clicked from a render before the agent's cast landed lists each name once", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop width");
  test.setTimeout(150_000);
  /* The beat sheet names the agent's two (Mara, the mooring rope) and two it does not. */
  const { errors, read } = await setup(page, { characters: ["Fox", "Mara"], props: ["Lantern", "Mooring rope"] });
  const add = page.getByTestId("cast-from-beats");
  const status = page.getByTestId("cast-stage").locator(".pd-save");
  const names = async () => ((await read()).production?.cast?.entries ?? []).map((e: { name: string }) => e.name);
  await expect(add).toHaveText("Add 4 from the beat sheet");
  await hydrated(add);
  /* The button's click handler as rendered now, while the list is empty. */
  await add.evaluate((el) => {
    const props = (el as unknown as Record<string, { onClick: () => void }>)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!];
    (window as unknown as { staleAdd: () => void }).staleAdd = props.onClick;
  });

  await page.getByTestId("cast-agent-estimate").click();
  await expect(page.getByTestId("cast-agent-quote")).toContainText("3 agent steps");
  await page.getByTestId("cast-agent-start").click();
  await expect.poll(names, { timeout: 60_000 }).toEqual(["Mara", "Mooring rope"]);
  /* The button counts only what is still missing. */
  await expect(add).toHaveText("Add 2 from the beat sheet");
  await expect(status).toHaveText(/^Saved/);

  /* The click lands now, with that earlier render's list of four: only the two still missing are added. */
  await page.evaluate(() => (window as unknown as { staleAdd: () => void }).staleAdd());
  await expect(page.getByTestId("cast-entry")).toHaveCount(4);
  await expect.poll(names).toEqual(["Mara", "Mooring rope", "Fox", "Lantern"]);
  await expect(add).toHaveText("Add 0 from the beat sheet");
  await expect(add).toBeDisabled();
  await expect(status).toHaveText(/^Saved/);

  /* Once more from that render: nothing is missing, so nothing changes — no edit, and the page still says Saved. */
  const after = await page.evaluate(async () => {
    (window as unknown as { staleAdd: () => void }).staleAdd();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return document.querySelector("[data-testid='cast-stage'] .pd-save")?.textContent ?? "";
  });
  expect(after).toMatch(/^Saved/);
  await expect(page.getByTestId("cast-entry")).toHaveCount(4);
  expect(await names()).toEqual(["Mara", "Mooring rope", "Fox", "Lantern"]);
  expect(errors).toEqual([]);
});
