import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";

/*
 * Two tabs, one lost reply, on the Make panel (Release 1; this spec was the old /make/images, /make/audio and /atomik/ideas
 * recovery race, gone with those pages: docs/old-shells.md).
 *
 * Tab A presses Make; the paid POST reaches the server but its reply is lost, so A keeps its claim (key K1) and says it is
 * never sent twice. Tab B, same project, presses Make: it finds K1, asks the server (POST /api/generate/check: landed),
 * follows that job and lets the claim go. Tab A then presses Make again. It never learned what became of K1, and it must
 * not quote and send a second paid request for the same press: it settles its own K1 first (the note B left, else the same
 * check) and follows that job. Exactly one paid POST. A genuinely new take (changed words) after that still goes.
 *
 * Against a local ENGINE_MOCK server. The paid routes (POST /api/generate, POST /api/audio without quoteOnly) and the check
 * are answered in the browser; quotes, drafts and the shot mapping are the server's own. Nothing is billed.
 */

const COMPACT = ["customer-360x640", "customer-390x844", "customer-844x390"];
const DESKTOP = ["customer-1440x900", "customer-1920x1080"];
const CLAIMS = "particl:pending-generation:";

type Paid = { path: string; key: string; body: Record<string, unknown>; reached: boolean };

/** `lost`: the paid requests (1-based, in order) lost before they reach the server; the first is always lost after it. */
async function seed(page: Page, context: BrowserContext, lost: number[] = []) {
  const workspaceId = (await signInLocally(page.request, "Recovery Race")).workspace.id;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 5000, "Recovery race fixture", "manual", "test", Date.now()] });
  } finally { db.close(); }
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project: Project = newProject(`Race ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  /* Every tab opens on this project. */
  await context.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });

  const paid: Paid[] = [];
  const checks: string[] = [];
  const json = (route: Parameters<Parameters<BrowserContext["route"]>[1]>[0], status: number, value: unknown, complete = false) =>
    route.fulfill({ status, contentType: "application/json", headers: complete ? { "Idempotency-Status": "complete" } : {}, body: JSON.stringify(value) });
  await context.route(/\/api\/(generate|audio)(\/check)?(\?.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST") return route.fallback();
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    if (path === "/api/generate/check") {
      const key = String(body.key);
      checks.push(key);
      const at = paid.findIndex((p) => p.key === key && p.reached);
      return json(route, 200, at >= 0 ? { state: "landed", id: `mock-race-job-${at + 1}`, status: "running" } : { state: "absent" });
    }
    if (body.quoteOnly === true) return route.fallback();
    const key = request.headers()["idempotency-key"] ?? "";
    const n = paid.length + 1;
    paid.push({ path, key, body, reached: !lost.includes(n) });
    if (lost.includes(n)) return route.abort("internetdisconnected");
    /* The first paid request reaches the server, and its reply is lost on the way back. */
    if (paid.length === 1) return json(route, 503, { error: "The request was interrupted. Retry with the same Idempotency-Key to recover its job; it will not be submitted twice." });
    return json(route, 202, { id: `mock-race-job-${paid.length}`, status: "running" }, true);
  });
  /* Following a job: it is rendering. */
  await context.route(/\/api\/jobs\/mock-race-job-\d+/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    return json(route, 200, { generation: { id, status: "running", kind: "video", prompt: "", model: "mock" } });
  });
  return { project, paid, checks };
}

const claims = (page: Page) => page.evaluate((prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)).length, CLAIMS);

type Surface = "video" | "batch" | "audio";
const WORDS: Record<Surface, string> = {
  video: "A slow push toward the lighthouse at dusk",
  batch: "A paper boat on a puddle, overhead",
  audio: "Rain on a tin roof, distant thunder",
};

/** Make, opened on `surface` with `words`, ready to press at its price; returns the button. */
async function openMake(page: Page, project: Project, surface: Surface, words: string, phone: boolean) {
  if (phone) {
    await page.goto(`/suites?screen=make&project=${project.id}`);
    await page.getByTestId(`phone-make-type-${surface === "batch" ? "image" : surface}`).click();
    await page.getByTestId("phone-make-prompt").fill(words);
    const go = page.getByTestId("phone-make-go");
    await expect(go).toHaveText(/\d cr$/, { timeout: 90_000 });
    return go;
  }
  await page.goto(`/suites?project=${project.id}&make=${surface === "batch" ? "change" : surface}`);
  await expect(page.getByTestId("make-panel")).toBeVisible({ timeout: 60_000 });
  if (surface === "batch") {
    await page.getByTestId("make-type-image").click();
    await page.getByTestId("make-advanced-toggle").click();
    await page.getByTestId("gen-takes-2").click();
  } else {
    await page.getByTestId(`make-type-${surface}`).click();
  }
  await page.getByTestId("gen-prompt").fill(words);
  const go = page.getByTestId("gen-generate");
  /* A sound is priced by its words, "up to N cr". */
  await expect(go).toHaveText(surface === "batch" ? /^Make 2 takes · \d[\d,]* cr$/ : /^Make · (up to )?\d[\d,]* cr$/, { timeout: 90_000 });
  return go;
}

/** What a press that followed or sent a take says when it is done: the take's toast, or a batch's line. */
const pressDone = (page: Page) => page.getByTestId("toast").filter({ hasText: /rendering/ }).or(page.getByText(/Nothing new was sent|takes sent at/)).first();

async function race(page: Page, context: BrowserContext, surface: Surface, phone: boolean) {
  const { project, paid, checks } = await seed(page, context);
  const words = WORDS[surface];

  /* Tab A: the press whose reply is lost. Its claim stays. */
  const goA = await openMake(page, project, surface, words, phone);
  await goA.click();
  await expect.poll(() => paid.length, { timeout: 60_000 }).toBe(1);
  await expect.poll(() => claims(page)).toBe(1);
  const k1 = paid[0].key;
  expect(k1).toBeTruthy();
  expect(paid[0].path).toBe(surface === "audio" ? "/api/audio" : "/api/generate");

  /* Tab B, the same project: it settles K1 (landed), follows that job, and lets the claim go. Nothing is sent. */
  const other = await context.newPage();
  const goB = await openMake(other, project, surface, words, phone);
  await goB.click();
  await expect.poll(() => checks, { timeout: 60_000 }).toEqual([k1]);
  await expect(pressDone(other)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => claims(other)).toBe(0);
  expect(paid, "tab B followed the lost request: nothing new was sent").toHaveLength(1);

  /* Tab A presses again. Its own K1 is settled first (B's note, else the same check), and that job is followed. */
  if (phone || surface !== "batch") await expect(goA).toHaveText(/\d cr$/, { timeout: 30_000 });
  await goA.click();
  await expect(pressDone(page)).toBeVisible({ timeout: 60_000 });
  expect(paid.map((p) => p.key), "one press, one paid request: tab A sent nothing new").toEqual([k1]);
  expect(checks.every((key) => key === k1), "only K1 was ever asked about").toBe(true);
  if (surface === "batch") await expect(page.getByText(/on the server, followed until it lands\. Nothing new was sent\./)).toBeVisible();
  return { project, paid, checks, other, words };
}

for (const surface of ["video", "batch", "audio"] as const) {
  test(`${surface}: a press after another tab settled this tab's lost request sends nothing new`, async ({ page, context }, info) => {
    const phone = COMPACT.includes(info.project.name);
    test.skip(!phone && !DESKTOP.includes(info.project.name), "Make's sizes");
    test.skip(phone && surface === "batch", "the phone's Make sends one take at a time (no takes stepper); the batch is the panel's");
    test.setTimeout(240_000);
    const { other } = await race(page, context, surface, phone);
    await other.close();
  });
}

test("video: this tab's own lost request comes before another tab's newer one on the same words, so it is followed and nothing is sent", async ({ page, context }, info) => {
  const phone = COMPACT.includes(info.project.name);
  test.skip(!phone && !DESKTOP.includes(info.project.name), "Make's sizes");
  test.setTimeout(300_000);
  /* The second paid request (tab B's new take) is lost before it reaches the server. */
  const { project, paid, checks } = await seed(page, context, [2]);
  const words = WORDS.video;
  const goA = await openMake(page, project, "video", words, phone);
  await goA.click();
  await expect.poll(() => paid.length, { timeout: 60_000 }).toBe(1);
  const kA = paid[0].key;

  /* Tab B settles kA (landed) and follows it. Then it makes a take of the same words: a new shot, and kB never arrives. */
  const other = await context.newPage();
  await (await openMake(other, project, "video", words, phone)).click();
  await expect.poll(() => checks, { timeout: 60_000 }).toEqual([kA]);
  await expect(pressDone(other)).toBeVisible({ timeout: 60_000 });
  await (await openMake(other, project, "video", words, phone)).click();
  await expect.poll(() => paid.length, { timeout: 60_000 }).toBe(2);
  const kB = paid[1].key;
  await expect.poll(() => claims(other)).toBe(1);

  /* Tab A presses: its own kA comes first (landed, B's note) and is followed. kB is B's; nothing is quoted or sent. */
  await expect(goA).toHaveText(/\d cr$/, { timeout: 30_000 });
  await goA.click();
  await expect(pressDone(page)).toBeVisible({ timeout: 60_000 });
  expect(paid.map((p) => p.key), "tab A sent nothing new").toEqual([kA, kB]);
  expect(checks, "kB was never asked about from tab A").toEqual([kA]);
  await other.close();
});

test("after settlement, a new take with changed words goes, from either tab, each once", async ({ page, context }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the panel; the phone's sends the same composer");
  test.setTimeout(300_000);
  const { project, paid, other } = await race(page, context, "video", false);
  const before = paid.length;

  /* Tab B, which settled K1, asks for a new take: it goes, under a new key, at the price on the button. */
  const goB = await openMake(other, project, "video", "Close on the keeper's hands on the rail", false);
  await goB.click();
  await expect.poll(() => paid.length, { timeout: 60_000 }).toBe(before + 1);
  await expect(pressDone(other)).toBeVisible({ timeout: 60_000 });

  /* Tab A, whose K1 is settled now, asks for a new take too: it goes. */
  const goA = await openMake(page, project, "video", "The beam sweeps over a fishing boat", false);
  await goA.click();
  await expect.poll(() => paid.length, { timeout: 60_000 }).toBe(before + 2);
  await expect(pressDone(page)).toBeVisible({ timeout: 60_000 });

  /* And the same words as K1 again, from A, is a second take of them now that A knows K1 landed: it goes too. */
  const again = await openMake(page, project, "video", WORDS.video, false);
  await again.click();
  await expect.poll(() => paid.length, { timeout: 60_000 }).toBe(before + 3);

  const keys = paid.map((p) => p.key);
  expect(new Set(keys).size, "every new take went under its own key").toBe(keys.length);
  for (const p of paid.slice(before)) expect(p.body.maxCredits, "each at the price on its button").toEqual(expect.any(Number));
  await other.close();
});

/*
 * The writing surface: Atomik's idea draft (POST /api/atomik/ideas/draft) claimed its request the same way, and the old
 * spec raced two tabs over it on /atomik/ideas. That page is gone in Release 1 and nothing in the app calls the route now.
 */
test.fixme("writing: two tabs recovering one Atomik idea draft send it once", () => {
  /* Owner question: does the idea draft (POST /api/atomik/ideas/draft, a paid 2 cr write) come back in Release 1, and where
     (a board card, Atomik's sheet)? Until it has a caller there is no surface to race; the route's own idempotency is held by its unit specs. */
});
