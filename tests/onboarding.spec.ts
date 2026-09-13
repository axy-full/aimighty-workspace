import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { DEFAULT_MODEL_ID } from "../lib/models";
import { STARTER_PRODUCTION } from "../lib/platformLayer";

/**
 * Rule 6, timed: a stranger with an invitation → account → workspace →
 * the starter production → a first render, against a local dev server
 * whose engines are mocked. It never runs against a deployment: the
 * server must say it is mocking, and it must be on localhost.
 *
 * Two runs of the same five minutes. The first drives the API alone (the
 * floor: what the routes cost). The second drives the UI a stranger sees
 * (SOW §9: the invite link, the two cards, landing on Make, Render) and
 * is the number the board prints.
 */
const BASE = process.env.PW_BASE_URL ?? "http://localhost:4551";
const LIMIT_S = 300;
/** The demo production's first character: the name the composer seeds and the placeholders read. */
const CAST_NAME = STARTER_PRODUCTION.cast[0].name;
const PASSWORD = "a long passphrase for a test account 42";

/** The gate: only a local server that says it mocks its engines. */
async function mockedLocal(api: APIRequestContext): Promise<boolean> {
  const health = await api.get("/api/health").then((r) => r.json()).catch(() => null);
  return Boolean(health?.mock) && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE);
}

/** The invitation the platform owner would have sent: one row, a fresh code, a fresh address. */
async function invitation(name: string, tag: string): Promise<{ code: string; email: string }> {
  const platform = createClient({ url: "file:.data/ark.db" });
  const code = randomBytes(18).toString("base64url");
  const email = `${tag}-${Date.now()}@example.test`;
  await platform.execute({
    sql: `INSERT INTO signup_invites (code, email, name, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`,
    args: [code, email, name, "onboarding test", "test", Date.now(), Date.now() + 86_400_000],
  });
  return { code, email };
}

/**
 * The mocked engine finishes in a few seconds, but a job only advances when
 * something fetches it (GET /api/jobs/:id syncs the generation), so the
 * wall never sees "succeeded" until someone asks. Every 2 s, up to 3 min.
 */
async function pollJob(api: APIRequestContext, id: string): Promise<string> {
  let status = "queued";
  for (let i = 0; i < 90 && !["succeeded", "failed"].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await api.get(`/api/jobs/${id}`).then((r) => r.json()).catch(() => null);
    status = job?.generation?.status ?? status;
  }
  return status;
}

test("a stranger with an invite reaches a first render inside five minutes", async () => {
  test.setTimeout(6 * 60_000);
  const api = await request.newContext({ baseURL: BASE });
  test.skip(!(await mockedLocal(api)), "runs only against a local dev server with mocked engines");

  const t0 = Date.now();
  const { code, email } = await invitation("Test Person", "starter");

  const signup = await api.post("/api/auth/signup", {
    data: { code, name: "Test Person", email, workspace: `Onboarding ${Date.now()}`, password: PASSWORD, accept: true },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();

  const projects = await api.get("/api/projects").then((r) => r.json());
  const starter = (projects.projects as { id: string; starter?: boolean; name: string }[]).find((p) => p.starter);
  expect(starter, "the workspace opens on a starter production").toBeTruthy();
  const shots = await api.get(`/api/shots?projectId=${starter!.id}`).then((r) => r.json());
  expect(shots.shots.length).toBe(3);
  const cast = await api.get(`/api/cast?projectId=${starter!.id}`).then((r) => r.text());
  expect(cast).toContain(CAST_NAME);

  const gen = await api.post("/api/generate", {
    data: {
      prompt: "A courier crosses a wet rooftop at dawn, static wide.",
      model: DEFAULT_MODEL_ID, ratio: "16:9", resolution: "1080p", duration: 5,
      generateAudio: true, watermark: false, seed: null,
      projectId: starter!.id, shotId: shots.shots[0].id, task: "generate", sourceGenId: null, references: [],
    },
  });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  const { id } = await gen.json();
  expect(await pollJob(api, id)).toBe("succeeded");
  const secs = (Date.now() - t0) / 1000;
  console.log(`onboarding: invitation → first render in ${secs.toFixed(1)}s`);
  expect(secs).toBeLessThan(LIMIT_S);
});

/**
 * The same five minutes through the screens (SOW §9; board 12i): the
 * invite link opens ACCOUNT, then STUDIO, one POST; the studio opens on
 * Make with the prompt seeded from the demo production; Render lands a
 * take on the wall; the mocked engine finishes it.
 *
 * Two things make this run flaky if ignored: Render stays disabled until
 * the cast list has loaded (the seeded @name is "unknown" until then), so
 * the test waits for enabled rather than visible; and the wall only
 * advances when a job is fetched, so the test polls GET /api/jobs/:id
 * with the page's own cookies.
 */
test("a stranger with an invite reaches a first render inside five minutes, through the UI", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  test.skip(!(await mockedLocal(page.request)), "runs only against a local dev server with mocked engines");

  const t0 = Date.now();
  const { code } = await invitation("Test Person", "starter-ui");

  // 0:00 · EMAIL — the link in the invite.
  await page.goto(`/signup?invite=${code}`);

  // 0:40 · ACCOUNT — the name is already there; a password is all it asks.
  const account = page.locator("[data-onboarding='account']");
  await expect(account).toBeVisible();
  await expect(account.getByLabel("Your name")).toHaveValue("Test Person");
  await account.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await account.getByRole("button", { name: "Continue", exact: true }).click();

  // 1:30 · STUDIO — a name, the acceptance line, one primary.
  const studio = page.locator("[data-onboarding='studio']");
  await expect(studio).toBeVisible();
  /* The card says what the studio comes with, from the server's own number — never a literal. */
  const { grant } = await page.request.get(`/api/auth/signup?code=${encodeURIComponent(code)}`).then((r) => r.json()) as { grant?: number };
  const granted = typeof grant === "number" && grant > 0;
  if (granted) await expect(studio).toContainText(`${grant.toLocaleString("en-US")} credits`);
  await studio.getByLabel("Studio name").fill(`Onboarding ${Date.now()}`);
  const open = studio.getByRole("button", { name: "Open the studio", exact: true });
  await expect(open).toBeDisabled();
  await studio.getByRole("checkbox", { name: /I accept the content policy and the terms/ }).check();
  await expect(open).toBeEnabled();
  await open.click();

  // 2:10 · MAKE — the studio opens on Make, the prompt already naming the demo cast.
  await page.waitForURL(/\/make\/video\?starter=1/, { timeout: 60_000 });
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue(new RegExp(`@${CAST_NAME}\\b`));

  // Render enables once the cast has loaded and the seeded name resolves.
  const render = page.locator("[data-render]").filter({ hasText: /^Render/ }).first();
  await expect(render).toBeEnabled({ timeout: 60_000 });
  /* Board 12i: the primary says what is left after this press, on a granted workspace. */
  if (granted) await expect(render).toContainText(/left after/i);
  const takes = page.locator("article[data-take]");
  const takeIds = () => takes.evaluateAll((els) => els.map((el) => el.getAttribute("data-take") ?? ""));
  const before = new Set(await takeIds());
  await render.click();

  // The take lands on the wall (the composer remounts it on `onMade`); its id is the job to watch.
  const newTake = async () => (await takeIds()).find((id) => id && !before.has(id)) ?? null;
  await expect.poll(newTake, { timeout: 60_000, message: "the render lands on the wall" }).not.toBeNull();
  const id = (await newTake())!;

  expect(await pollJob(page.request, id)).toBe("succeeded");
  const secs = (Date.now() - t0) / 1000;
  console.log(`onboarding (UI): invitation → first render in ${secs.toFixed(1)} s`);
  expect(secs).toBeLessThan(LIMIT_S);
});
