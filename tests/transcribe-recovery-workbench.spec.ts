import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { generation, mockLibrary, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { newProject, type Project } from "../lib/workbench/studio";
import { transcriptionSlot } from "../lib/workbench/transcription-request";
import { grokTranscriptionUsd } from "../lib/xaiVoice";

/**
 * A paid transcription is claimed before it is sent, per take and settings,
 * and a reply that never came back is asked about by its own key
 * (POST /api/generate/check) — never sent again. On the Takes page: a
 * transcript whose reply was lost comes back from its key; one still being
 * made when the page reloads is waited for; one that never reached the server
 * is let go with nothing charged, and the price on the button goes again under
 * a new key; a check that cannot be answered offers Try again. The paid route
 * and the check are a page-level stand-in for the server's claim rules (as
 * tests/helpers/claimsServer.ts is for renders), at every configured size.
 * The last case runs the real local routes on the ENGINE_MOCK server: a key
 * answered once, replayed and checked, a key set aside before it arrives.
 * Nothing is billed for real.
 */

const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.TRANSCRIBE_SHOTS_DIR;
const PRODUCTION = "prod-stt";
const fixture = (): Project => ({ ...newProject("Transcribed takes"), id: `stt-${randomUUID()}`, productionProjectId: PRODUCTION });
const transcript = (credits: number) => ({
  text: "The ferry is here. Not tonight.", language: "en", seconds: 6,
  words: [
    { text: "The", start: 0, end: 0.3, speaker: 0 }, { text: "ferry", start: 0.3, end: 0.7, speaker: 0 }, { text: "is", start: 0.7, end: 0.9, speaker: 0 }, { text: "here.", start: 0.9, end: 1.4, speaker: 0 },
    { text: "Not", start: 2, end: 2.3, speaker: 1 }, { text: "tonight.", start: 2.3, end: 3, speaker: 1 },
  ],
  srt: "1\n00:00:00,000 --> 00:00:01,400\nThe ferry is here.\n", credits,
});

type Claim = { body: string; state: "running" | "answered" | "set_aside" | "held" };
/**
 * The server's claim rules for POST /api/audio/transcribe and its check, in the page:
 * one transcription per Idempotency-Key (a key seen again answers from its claim),
 * a check that reads a key's claim or sets a never-seen key aside.
 * `plan` says what the coming paid POSTs do: lost before the server, made with the
 * reply lost, made and still running with the reply lost, or answered.
 */
async function transcriptionServer(page: Page, price = 3) {
  const claims = new Map<string, Claim>();
  const server = {
    price, claims,
    plan: [] as ("before" | "after" | "running" | "answer")[],
    /** What the coming checks answer before the claim is read: a failure the server could not answer. */
    checkPlan: [] as ("fail" | "read")[],
    sent: [] as { key: string | undefined; body: Record<string, unknown> }[],
    checks: [] as string[],
    charges: [] as number[],
  };
  await page.route("**/api/audio/transcribe", async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.quoteOnly === true) return route.fulfill({ json: { quoteOnly: true, estimatedCredits: server.price, seconds: 6 } });
    const key = request.headers()["idempotency-key"];
    server.sent.push({ key, body });
    const next = server.plan.shift() ?? "answer";
    if (next === "before") return route.abort("internetdisconnected");
    const known = key ? claims.get(key) : undefined;
    const complete = { "Idempotency-Status": "complete" };
    if (known?.state === "set_aside") return route.fulfill({ status: 409, headers: complete, json: { error: "This request was set aside: it had not reached the server when it was checked. Nothing was charged.", code: "set_aside" } });
    if (known?.state === "running") return route.fulfill({ status: 409, json: { error: "This request is still being accepted.", pending: true } });
    if (known) return route.fulfill({ headers: complete, json: transcript(server.price) });
    server.charges.push(server.price);
    if (key) claims.set(key, { body: request.postData()!, state: next === "running" ? "running" : "answered" });
    if (next === "after" || next === "running") return route.abort("connectionreset");
    return route.fulfill({ headers: complete, json: transcript(server.price) });
  });
  await page.route("**/api/generate/check", async (route) => {
    const input = route.request().postDataJSON() as { key: string; endpoint: string; body: string };
    expect(input.endpoint).toBe("/api/audio/transcribe");
    server.checks.push(input.key);
    if (server.checkPlan.shift() === "fail") return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    const claim = claims.get(input.key);
    if (!claim) {
      claims.set(input.key, { body: input.body, state: "set_aside" });
      return route.fulfill({ json: { state: "absent" } });
    }
    if (claim.body !== input.body) return route.fulfill({ status: 409, json: { error: "This Idempotency-Key names a different request." } });
    if (claim.state === "set_aside") return route.fulfill({ json: { state: "absent" } });
    if (claim.state === "running") return route.fulfill({ json: { state: "pending" } });
    if (claim.state === "held")
      return route.fulfill({ json: { state: "unknown", credits: server.price, error: `Your last transcription stopped without an answer. Its ${server.price} credits stay reserved for review. Nothing was sent again.` } });
    return route.fulfill({ json: { state: "answered", reply: transcript(server.price) } });
  });
  return server;
}

async function open(page: Page) {
  await signInLocally(page.request);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_line", title: "Harbour line", prompt: "Harbour line", kind: "audio", projectId: PRODUCTION })] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { store, errors };
}
async function pickTake(page: Page, projectId: string) {
  await page.goto(`/suites?suite=studio&page=takes&project=${projectId}`);
  await page.getByTestId("edit-takes").getByText("Harbour line", { exact: true }).click();
  return page.getByTestId("transcribe");
}

/** In view, inside the page's width, above the phone tab bar, and a whole thumb target on a phone; no sideways scroll. */
async function fit(page: Page, target: Locator) {
  await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await target.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  if (page.viewportSize()!.width < 900) {
    const tabbar = await page.locator(".gx-tabbar").boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(Math.min(page.viewportSize()!.height, tabbar?.y ?? Infinity) + 1);
    if (await target.evaluate((el) => el.tagName === "BUTTON")) {
      expect(Math.round(box!.height * 100) / 100).toBeGreaterThanOrEqual(44);
      expect(Math.round(box!.width * 100) / 100).toBeGreaterThanOrEqual(44);
    }
  }
}

/** With TRANSCRIBE_SHOTS_DIR set, a picture of the state under test, `focus` scrolled to the middle first. */
async function shot(page: Page, info: TestInfo, name: string, focus: Locator) {
  if (!SHOTS) return;
  await focus.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace("workbench-", "")}.png` });
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

test("a transcript whose reply was lost comes back from its own key: shown once, sent once, charged once", async ({ page }, info) => {
  const { store, errors } = await open(page);
  const server = await transcriptionServer(page);
  server.plan = ["after"];
  const panel = await pickTake(page, store.current.id);
  const action = panel.getByTestId("transcribe-run");
  await expect(action).toHaveText("Transcribe · 3 credits");
  await fit(page, action);
  await action.click();
  await expect(panel.getByTestId("transcript")).toContainText("The ferry is here.");
  await expect(panel.getByTestId("transcript")).toContainText("Speaker 2");
  await expect(panel.getByTestId("transcribe-note")).toHaveText("Your last transcription finished and was charged 3 credits. Nothing was sent again.");
  await expect(action).toHaveText("Transcribed");
  await expect(action).toBeDisabled();
  expect(server.sent).toHaveLength(1);
  expect(server.sent[0].body).toEqual({ sourceGenId: "gen_line", projectId: PRODUCTION, diarize: true, maxCredits: 3 });
  expect(server.sent[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(server.checks).toEqual([server.sent[0].key]);
  expect(server.charges).toEqual([3]);
  /* The slot is let go: nothing is left to ask about. */
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("particl:pending-generation:")))).toEqual([]);
  await fit(page, panel.getByTestId("transcribe-note"));
  await fit(page, panel.getByTestId("transcribe-srt"));
  await shot(page, info, "recovered", panel);
  await page.addStyleTag({ content: '[data-testid="transcribe"] * { font-family: Verdana, sans-serif !important; }' });
  await fit(page, panel.getByTestId("transcribe-note"));
  await fit(page, panel.getByTestId("transcribe-srt"));
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="transcribe"]'), "transcript buttons under 44×44").toEqual([]);
  expect(errors).toEqual([]);
});

test("a transcription still being made when the page reloads is asked about and waited for, never sent again", async ({ page }, info) => {
  const { store, errors } = await open(page);
  const server = await transcriptionServer(page);
  server.plan = ["running"];
  const panel = await pickTake(page, store.current.id);
  const action = panel.getByTestId("transcribe-run");
  await expect(action).toHaveText("Transcribe · 3 credits");
  await action.click();
  await expect(panel.getByTestId("transcribe-note")).toHaveText("Your last transcription is still running. Nothing new was sent; asking again shortly.");
  await expect(action).toHaveText("Checking last transcription…");
  await expect(action).toBeDisabled();
  await fit(page, action);
  await fit(page, panel.getByTestId("transcribe-note"));
  await shot(page, info, "still-running", panel);
  const key = server.sent[0].key!;
  /* The page reloads while the server is still at it: the claim is read back and asked about by its key. */
  const asked = server.checks.length;
  await page.reload();
  await page.getByTestId("edit-takes").getByText("Harbour line", { exact: true }).click();
  await expect.poll(() => server.checks.length).toBeGreaterThan(asked);
  await expect(panel.getByTestId("transcribe-note")).toHaveText("Your last transcription is still running. Nothing new was sent; asking again shortly.");
  await expect(action).toBeDisabled();
  server.claims.get(key)!.state = "answered";
  await expect(panel.getByTestId("transcript")).toContainText("Not tonight.", { timeout: 20_000 });
  await expect(panel.getByTestId("transcribe-note")).toHaveText("Your last transcription finished and was charged 3 credits. Nothing was sent again.");
  expect(server.sent).toHaveLength(1);
  expect(new Set(server.checks)).toEqual(new Set([key]));
  expect(server.charges).toEqual([3]);
  expect(errors).toEqual([]);
});

test("a request that never reached the server is let go with nothing charged, and the price on the button goes again under a new key", async ({ page }, info) => {
  const { store, errors } = await open(page);
  const server = await transcriptionServer(page);
  server.plan = ["before"];
  const panel = await pickTake(page, store.current.id);
  const action = panel.getByTestId("transcribe-run");
  await expect(action).toHaveText("Transcribe · 3 credits");
  await action.click();
  await expect(panel.getByTestId("transcribe-note")).toHaveText("Your last transcription never reached the server. Nothing was charged for it.");
  await expect(action).toHaveText("Transcribe · 3 credits");
  await expect(action).toBeEnabled();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(server.sent).toHaveLength(1);
  expect(server.charges).toEqual([]);
  await fit(page, panel.getByTestId("transcribe-note"));
  await fit(page, action);
  await shot(page, info, "never-arrived", panel);
  /* Its key is set aside at the server: it can never land late. A new press is a new approval, under a new key. */
  expect(server.claims.get(server.sent[0].key!)?.state).toBe("set_aside");
  await action.click();
  await expect(panel.getByTestId("transcript")).toContainText("The ferry is here.");
  expect(server.sent).toHaveLength(2);
  expect(server.sent[1].key).not.toBe(server.sent[0].key);
  expect(server.sent[1].body).toEqual({ sourceGenId: "gen_line", projectId: PRODUCTION, diarize: true, maxCredits: 3 });
  expect(server.charges).toEqual([3]);
  await expect(panel.getByTestId("transcribe-note")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a check that cannot be answered offers Try again and sends nothing; one held for review says so and frees the button", async ({ page }, info) => {
  const { store, errors } = await open(page);
  const server = await transcriptionServer(page);
  server.plan = ["after"];
  server.checkPlan = ["fail"];
  const panel = await pickTake(page, store.current.id);
  const action = panel.getByTestId("transcribe-run");
  await expect(action).toHaveText("Transcribe · 3 credits");
  await action.click();
  await expect(panel.getByRole("alert")).toHaveText("Your last transcription could not be checked. Nothing new was sent.");
  const retry = panel.getByTestId("transcribe-check");
  await expect(retry).toHaveText("Try again");
  await expect(action).toBeDisabled();
  await fit(page, retry);
  await fit(page, panel.getByRole("alert"));
  await shot(page, info, "check-failed", panel);
  expect(server.sent).toHaveLength(1);
  /* The server stopped without an answer and holds its reservation: the check says so, and the slot is let go. */
  server.claims.get(server.sent[0].key!)!.state = "held";
  await retry.click();
  await expect(panel.getByRole("alert")).toHaveText("Your last transcription stopped without an answer. Its 3 credits stay reserved for review. Nothing was sent again.");
  await expect(retry).toHaveCount(0);
  await expect(action).toHaveText("Transcribe · 3 credits");
  await expect(action).toBeEnabled();
  await fit(page, panel.getByRole("alert"));
  await shot(page, info, "held", panel);
  expect(server.sent).toHaveLength(1);
  expect(server.charges).toEqual([3]);
  expect(server.checks).toEqual([server.sent[0].key, server.sent[0].key]);
  expect(errors).toEqual([]);
});

test("an unconfirmed transcription found on opening the take is asked about before anything can be pressed", async ({ page }) => {
  const { store, errors } = await open(page);
  const server = await transcriptionServer(page);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const slot = transcriptionSlot(scope, PRODUCTION, { genId: "gen_line" }, { diarize: true });
  const claim = { key: "earlier-transcript-0001", body: JSON.stringify({ sourceGenId: "gen_line", projectId: PRODUCTION, diarize: true, maxCredits: 3 }), credits: 3, endpoint: "/api/audio/transcribe" };
  server.claims.set(claim.key, { body: claim.body, state: "running" });
  await page.addInitScript(({ slot, claim }) => {
    if (sessionStorage.getItem("stt-seeded")) return;
    sessionStorage.setItem("stt-seeded", "1");
    localStorage.setItem(slot, JSON.stringify(claim));
  }, { slot, claim });
  const panel = await pickTake(page, store.current.id);
  const action = panel.getByTestId("transcribe-run");
  await expect(panel.getByTestId("transcribe-note")).toHaveText("Your last transcription is still running. Nothing new was sent; asking again shortly.");
  await expect(action).toHaveText("Checking last transcription…");
  await expect(action).toBeDisabled();
  await fit(page, action);
  server.claims.get(claim.key)!.state = "answered";
  await expect(panel.getByTestId("transcript")).toContainText("The ferry is here.", { timeout: 20_000 });
  expect(server.sent).toEqual([]);
  expect(new Set(server.checks)).toEqual(new Set([claim.key]));
  expect(errors).toEqual([]);
});

/* ── The real local routes, ENGINE_MOCK: one desktop run ── */

function sine(seconds: number) {
  const rate = 48000, frames = rate * seconds, b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 0.5 * 32767), 44 + i * 2);
  return b;
}

test("the route answers a key once: its replay and its check return the same transcript and charge; a key set aside runs nothing", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop run against the real routes");
  test.setTimeout(120_000);
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}`, "Content-Type": "application/json" };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const meterRows = async () => (await platform.execute({ sql: "SELECT id, status, billed_credits, engine_cost_usd FROM meter_events WHERE workspace_id=? AND model='grok-stt' ORDER BY created_at", args: [account.workspace.id] })).rows;
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 500, "Transcription recovery test", "admin", "test", Date.now()] });
    /* A two-second line, uploaded through the real chunked upload. */
    const session = randomUUID();
    const chunk = await page.request.post("/api/uploads/chunk", { headers: { "X-Workbench-Scope": headers["X-Workbench-Scope"] }, multipart: { session, index: "0", chunk: { name: "chunk", mimeType: "application/octet-stream", buffer: sine(2) } } });
    expect(chunk.ok(), await chunk.text()).toBe(true);
    const finished = await page.request.post("/api/uploads/finish", { headers, data: { session, count: 1, filename: "Line.wav", mime: "audio/wav", purpose: "chat" } });
    expect(finished.ok(), await finished.text()).toBe(true);
    const upload = await finished.json();
    const quote = await page.request.post("/api/audio/transcribe", { headers, data: { sourceUploadId: upload.id, diarize: true, quoteOnly: true } });
    expect(quote.ok(), await quote.text()).toBe(true);
    const approved = (await quote.json()).estimatedCredits as number;
    expect(approved).toBeGreaterThan(0);
    const body = { sourceUploadId: upload.id, diarize: true, maxCredits: approved };

    const key = `stt-route-${randomUUID()}`;
    const first = await page.request.post("/api/audio/transcribe", { headers: { ...headers, "Idempotency-Key": key }, data: body });
    expect(first.status(), await first.text()).toBe(200);
    expect(first.headers()["idempotency-status"]).toBe("complete");
    const reply = await first.json();
    expect(reply.words.length).toBeGreaterThan(0);
    expect(reply.credits).toBeLessThanOrEqual(approved);
    const again = await page.request.post("/api/audio/transcribe", { headers: { ...headers, "Idempotency-Key": key }, data: body });
    expect(again.status()).toBe(200);
    expect(again.headers()["idempotency-replayed"]).toBe("true");
    expect(await again.json()).toEqual(reply);
    const checked = await page.request.post("/api/generate/check", { headers, data: { key, endpoint: "/api/audio/transcribe", body: JSON.stringify(body) } });
    expect(await checked.json()).toEqual({ state: "answered", reply });
    /* The same key naming a different request is refused by the check as by the route. */
    expect((await page.request.post("/api/generate/check", { headers, data: { key, endpoint: "/api/audio/transcribe", body: JSON.stringify({ ...body, diarize: false }) } })).status()).toBe(409);
    let rows = await meterRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded", billed_credits: reply.credits });
    /* The mock provider reports a longer line than the source measured: its own count is what the private meter records. */
    expect(Number(rows[0].engine_cost_usd)).toBeCloseTo(grokTranscriptionUsd(reply.seconds), 9);

    /* A key the server never saw is set aside by its check; the request arriving after it runs nothing. */
    const late = `stt-late-${randomUUID()}`;
    const absent = await page.request.post("/api/generate/check", { headers, data: { key: late, endpoint: "/api/audio/transcribe", body: JSON.stringify(body) } });
    expect(await absent.json()).toEqual({ state: "absent" });
    const arrived = await page.request.post("/api/audio/transcribe", { headers: { ...headers, "Idempotency-Key": late }, data: body });
    expect(arrived.status()).toBe(409);
    expect((await arrived.json()).code).toBe("set_aside");
    rows = await meterRows();
    expect(rows).toHaveLength(1);
  } finally {
    platform.close();
  }
});
