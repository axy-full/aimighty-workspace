import { test, expect, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { SIZES, desktop, floors, shot, tenantDb, watchErrors } from "./helpers/l5";

/*
 * "Approve at N cr" on prepared jobs (owner, 16 Oct 2026), in Settings › Connections. Real local ENGINE_MOCK=1 server and real routes: an outside agent's token
 * prepares jobs; a person sees each one's WHOLE prompt, an "Approve at N cr" that the server priced for exactly that job just now, and one tap starts it through the
 * ordinary paid path at that figure. The tap prices again and sends nothing if the figure moved; the claim is let go when nothing started; Dismiss and Open in Make
 * stay. Five widths, then the large screens. Neutral names only; the engines are mocks, so nothing real is spent.
 */
async function styled(page: Page) {
  await expect.poll(() => page.evaluate(() => { const el = document.querySelector(".gs-page"); return el ? getComputedStyle(el).paddingTop : "0px"; })).not.toBe("0px");
}
const LONG = "A slow push on a quiet street at first light. Wet cobbles, a baker propping a door, steam from a grate, one cyclist passing left to right. Warm practical lights, cool sky. Handheld, never shaky. Keep the pace patient and let the sound of the street come in late.";

async function setup(page: Page, playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"]) {
  const { workspace } = await signInWithNewInterface(page.request, "Approve Tester");
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const made = await page.request.post("/api/tokens", { data: { name: "A script on the studio computer", scope: "prepare" }, headers: { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` } });
  expect(made.status(), await made.text()).toBe(200);
  const { token } = await made.json() as { token: string };
  const agent = await playwright.request.newContext({ baseURL: new URL(page.url() === "about:blank" ? "http://localhost" : page.url()).origin, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  return { workspace, agent };
}

test("Approve at N cr: the whole prompt is on view, the price is the server's for this job, one tap starts it at that figure, and it leaves the list", async ({ page, playwright, baseURL }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  await page.goto("/");
  const { workspace, agent } = await setup(page, playwright);
  const errors = watchErrors(page);
  try {
    for (const prompt of [LONG, "A short second shot"]) {
      const res = await agent.post(`${baseURL}/api/prepared-jobs`, { data: { prompt, duration: 5, resolution: "720p", ratio: "16:9" } });
      expect(res.status(), await res.text()).toBe(201);
    }
  } finally { await agent.dispose(); }
  const sent: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate") sent.push(request.postData() ?? ""); });
  await page.goto("/suites?view=workspace&tab=connections");
  await styled(page);
  const jobs = page.getByTestId("settings-prepared-job");
  await expect(jobs).toHaveCount(2);
  const first = jobs.filter({ hasText: "A slow push on a quiet street" });
  /* The whole prompt, as written: not cut at 90 characters, no ellipsis. */
  await expect(first.getByTestId("settings-prepared-prompt")).toHaveText(LONG);
  await expect(first).toContainText("Seedance 2.5 · 5 s · 720p · 16:9 · from A script on the studio computer");
  /* The price: the server's, on the button, with its dollars on hover; a priced control carries the spend marker. */
  const approve = first.getByTestId("settings-prepared-approve");
  await expect(approve).toHaveText(/^Approve at \d[\d,.]* cr$/, { timeout: 60_000 });
  await expect(approve).toHaveAttribute("data-spend", "priced");
  await expect(approve).toHaveAttribute("data-spend-price", /^\d[\d,.]* cr$/);
  await expect(approve.locator(".gx-price")).toHaveAttribute("title", /^\$\d/);
  const shown = (await approve.getAttribute("data-spend-price"))!;
  /* Dismiss and Open in Make stay beside it; nothing has been sent. */
  await expect(first.getByTestId("settings-prepared-dismiss")).toBeVisible();
  await expect(first.getByTestId("settings-prepared-open")).toBeVisible();
  expect(sent).toEqual([]);
  await floors(page, "Connections, prepared jobs", "[data-testid=settings-prepared]");
  await shot(page, "prepared-approve", info);
  const box = await approve.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= (page.viewportSize()?.width ?? 0), "the button is inside the window, no panning").toBe(true);

  /* One tap: it starts once, at the figure shown as its ceiling, and the job leaves the list. */
  await approve.click();
  await expect(jobs).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("settings-prepared-job")).toContainText("A short second shot");
  expect(sent).toHaveLength(1);
  const body = JSON.parse(sent[0]) as Record<string, unknown>;
  expect(body).toMatchObject({ prompt: LONG, model: "dreamina-seedance-2-5-260628", ratio: "16:9", resolution: "720p", duration: 5 });
  expect(`${body.maxCredits} cr`.replace(/\B(?=(\d{3})+(?!\d))/g, ",")).toBe(shown);
  expect(body.quoteFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const db = await tenantDb(workspace.id);
  try {
    const row = (await db.execute({ sql: "SELECT state, decided_by, json_extract(settings_json,'$.takeId') AS take FROM prepared_jobs WHERE prompt = ?", args: [LONG] })).rows[0];
    expect(row.state).toBe("approved");
    expect(row.decided_by).toBeTruthy();
    const take = (await db.execute({ sql: "SELECT created_by FROM generations WHERE id = ?", args: [String(row.take)] })).rows[0];
    expect(take?.created_by, "the recorded take is the approving person's own").toBe(row.decided_by);
  } finally { db.close(); }
  expect(errors).toEqual([]);
});

test("a price that moved between the button and the tap sends nothing: the new figure is shown, the job waits again, and Dismiss works", async ({ page, playwright, baseURL }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  await page.goto("/");
  const { workspace, agent } = await setup(page, playwright);
  try {
    const res = await agent.post(`${baseURL}/api/prepared-jobs`, { data: { prompt: "A heron lifts off a still lake", duration: 5, resolution: "720p", ratio: "16:9" } });
    expect(res.status(), await res.text()).toBe(201);
  } finally { await agent.dispose(); }
  const sent: string[] = [];
  let inflate = false;
  await page.route("**/api/generate/quote", async (route) => {
    /* The button's own quotes are real; once the person has the figure, the tap's quote says the price has gone up. */
    if (!inflate) return route.continue();
    const real = await route.fetch();
    const json = await real.json() as { estimatedCredits: number };
    await route.fulfill({ response: real, json: { ...json, estimatedCredits: json.estimatedCredits + 7, price: json.estimatedCredits + 7 } });
  });
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate") sent.push(request.postData() ?? ""); });
  await page.goto("/suites?view=workspace&tab=connections");
  await styled(page);
  const job = page.getByTestId("settings-prepared-job");
  const approve = job.getByTestId("settings-prepared-approve");
  await expect(approve).toHaveText(/^Approve at \d[\d,.]* cr$/, { timeout: 60_000 });
  const before = Number((await approve.getAttribute("data-spend-price"))!.replace(/[^\d.]/g, ""));
  inflate = true;
  await approve.click();
  await expect(job.getByTestId("settings-prepared-note")).toContainText(`The price is now ${(before + 7).toLocaleString("en-US")} cr. Tap again to approve it.`, { timeout: 60_000 });
  await expect(approve).toHaveAttribute("data-spend-price", `${(before + 7).toLocaleString("en-US")} cr`);
  expect(sent, "nothing was sent at the old figure").toEqual([]);
  /* The claim was let go: the job still waits, in the list, for anyone. */
  const db = await tenantDb(workspace.id);
  try { expect((await db.execute("SELECT state FROM prepared_jobs")).rows.map((r) => r.state)).toEqual(["waiting"]); } finally { db.close(); }
  await shot(page, "prepared-repriced", info);
  /* Dismiss stays: marked, nothing spent. */
  await job.getByTestId("settings-prepared-dismiss").click();
  await expect(page.getByTestId("settings-prepared-job")).toHaveCount(0);
  expect(sent).toEqual([]);
});

test("the large screens: no sideways scroll, the whole prompt and the button inside the window", async ({ page, playwright, baseURL }, info) => {
  test.skip(info.project.name !== "workbench-1920x1080", "the large sizes are set here, once");
  test.setTimeout(240_000);
  await page.goto("/");
  const { agent } = await setup(page, playwright);
  try {
    const res = await agent.post(`${baseURL}/api/prepared-jobs`, { data: { prompt: LONG, duration: 5, resolution: "720p", ratio: "16:9" } });
    expect(res.status(), await res.text()).toBe(201);
  } finally { await agent.dispose(); }
  for (const [width, height] of [[1728, 1117], [2560, 1440]]) {
    await page.setViewportSize({ width, height });
    await page.goto("/suites?view=workspace&tab=connections");
    await styled(page);
    const approve = page.getByTestId("settings-prepared-approve");
    await expect(approve).toHaveText(/^Approve at \d[\d,.]* cr$/, { timeout: 60_000 });
    await expect(page.getByTestId("settings-prepared-prompt")).toHaveText(LONG);
    await floors(page, `Connections ${width}x${height}`);
    const box = (await approve.boundingBox())!;
    expect(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height, `${width}: the button is in the window`).toBe(true);
    /* No fixed-width layout stranding whitespace: the page's content reaches at least a third of the window. */
    expect(await page.evaluate(() => document.querySelector(".gs-page")!.getBoundingClientRect().width), `${width}: the page uses the window`).toBeGreaterThan(Math.min(width / 3, 480));
  }
  expect(desktop(page)).toBe(true);
});
