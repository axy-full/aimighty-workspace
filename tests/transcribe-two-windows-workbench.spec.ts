import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { generation, mockLibrary, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * Two windows on the same take. The first presses Transcribe: its request is
 * claimed in the browser, then sent. The second sees the claim appear at once
 * and asks the server about unconfirmed requests on its own — but never about
 * one still on its way: asked before that POST arrived, the server would set
 * its key aside, and the first window's press would be lost (nothing charged,
 * but nothing transcribed). The sending window holds the take's send lock (Web
 * Locks) until its reply is in; the other window asks only once it is free,
 * and then shows the same transcript. Without Web Locks, the claim's stamp
 * keeps the other window off it for about ten seconds.
 *
 * The paid route and the check are a stand-in for the server's claim rules,
 * shared by both pages (a check for a key the server has not seen sets it
 * aside; a POST under a set-aside key is refused), as in
 * tests/transcribe-recovery-workbench.spec.ts. The first window's POST is held
 * before that stand-in sees it, so a check that overtakes it is caught.
 * Nothing is billed.
 */

const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PRODUCTION = "prod-stt-windows";
const ON_ITS_WAY = "Another transcription of this is already on its way. Nothing new was sent.";
const SET_ASIDE = "This request was set aside: it had not reached the server when it was checked. Nothing was charged.";
const fixture = (): Project => ({ ...newProject("Transcribed takes"), id: `stt-windows-${randomUUID()}`, productionProjectId: PRODUCTION });
const transcript = (credits: number) => ({
  text: "The ferry is here. Not tonight.", language: "en", seconds: 6,
  words: [
    { text: "The", start: 0, end: 0.3, speaker: 0 }, { text: "ferry", start: 0.3, end: 0.7, speaker: 0 }, { text: "is", start: 0.7, end: 0.9, speaker: 0 }, { text: "here.", start: 0.9, end: 1.4, speaker: 0 },
    { text: "Not", start: 2, end: 2.3, speaker: 1 }, { text: "tonight.", start: 2.3, end: 3, speaker: 1 },
  ],
  srt: "1\n00:00:00,000 --> 00:00:01,400\nThe ferry is here.\n", credits,
});

/**
 * One server for every page of the context. `hold`, while set, keeps a paid
 * POST on its way — the server has not seen it — until it resolves. `events`
 * is what reached the server, in order: `post:<key>` when a paid POST arrives,
 * `check:<key>` for each check; `firstCheckAt`, when the first check arrived.
 */
async function sharedServer(context: BrowserContext, price = 3) {
  const claims = new Map<string, "answered" | "set_aside">();
  const server = { claims, hold: null as Promise<void> | null, sent: [] as string[], events: [] as string[], charges: [] as number[], firstCheckAt: 0 };
  const complete = { "Idempotency-Status": "complete" };
  await context.route("**/api/audio/transcribe", async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.quoteOnly === true) return route.fulfill({ json: { quoteOnly: true, estimatedCredits: price, seconds: 6 } });
    const key = request.headers()["idempotency-key"] ?? "";
    server.sent.push(key);
    await server.hold;
    server.events.push(`post:${key}`);
    const known = claims.get(key);
    if (known === "set_aside") return route.fulfill({ status: 409, headers: complete, json: { error: SET_ASIDE, code: "set_aside" } });
    if (known) return route.fulfill({ headers: complete, json: transcript(price) });
    claims.set(key, "answered");
    server.charges.push(price);
    return route.fulfill({ headers: complete, json: transcript(price) });
  });
  await context.route("**/api/generate/check", async (route) => {
    const input = route.request().postDataJSON() as { key: string; endpoint: string };
    expect(input.endpoint).toBe("/api/audio/transcribe");
    server.events.push(`check:${input.key}`);
    server.firstCheckAt ||= Date.now();
    const claim = claims.get(input.key);
    if (!claim) {
      claims.set(input.key, "set_aside");
      return route.fulfill({ json: { state: "absent" } });
    }
    if (claim === "set_aside") return route.fulfill({ json: { state: "absent" } });
    return route.fulfill({ json: { state: "answered", reply: transcript(price) } });
  });
  return server;
}

/** Both windows of one signed-in context, each on the same take's Transcribe panel. */
async function twoWindows(page: Page, context: BrowserContext) {
  await signInLocally(page.request);
  const store = { current: fixture() };
  const library = { uploads: [], generations: [generation({ id: "gen_line", title: "Harbour line", prompt: "Harbour line", kind: "audio", projectId: PRODUCTION })] };
  const server = await sharedServer(context);
  const second = await context.newPage();
  const errors: string[] = [];
  const panels: Locator[] = [];
  for (const tab of [page, second]) {
    await mockProjects(tab, store);
    await mockLibrary(tab, library);
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(`/suites?suite=studio&page=takes&project=${store.current.id}`);
    await tab.getByTestId("edit-takes").getByText("Harbour line", { exact: true }).click();
    const panel = tab.getByTestId("transcribe");
    await expect(panel.getByTestId("transcribe-run")).toHaveText("Transcribe · about 3 credits");
    panels.push(panel);
  }
  return { server, second, first: panels[0], other: panels[1], errors };
}

/** In view, inside the page's width, above the phone tab bar, a whole thumb target on a phone; no sideways scroll. */
async function fit(page: Page, target: Locator) {
  await expect(async () => {
    await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
  }).toPass({ timeout: 10_000 });
}

const claimsLeft = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("particl:pending-generation:")));

test.afterEach(async ({ context }) => { await context.unrouteAll({ behavior: "ignoreErrors" }); });

test("a second window leaves a transcription on its way alone: the first window's request is never set aside, and it completes once", async ({ page, context }, info) => {
  const { server, second, first, other, errors } = await twoWindows(page, context);
  const firstAction = first.getByTestId("transcribe-run"), otherAction = other.getByTestId("transcribe-run");
  let letThrough!: () => void;
  server.hold = new Promise<void>((resolve) => { letThrough = resolve; });
  await firstAction.click();
  await expect.poll(() => server.sent.length).toBe(1);
  const key = server.sent[0];
  expect(key).toMatch(/^[0-9a-f-]{36}$/);

  /* The second window sees the claim at once, and leaves it to the window sending it. */
  await expect(otherAction).toHaveText("Checking last transcription…");
  await expect(otherAction).toBeDisabled();
  await expect(other.getByTestId("transcribe-note")).toHaveText(ON_ITS_WAY);
  await fit(second, other.getByTestId("transcribe-note"));
  await fit(second, otherAction);
  /* Several of its rounds pass while the POST is on its way: nothing reaches the server, so nothing is set aside. */
  await second.waitForTimeout(3_000);
  expect(server.events).toEqual([]);
  await expect(firstAction).toHaveText("Transcribing…");

  letThrough();
  await expect(first.getByTestId("transcript")).toContainText("The ferry is here.");
  await expect(firstAction).toHaveText("Transcribed");
  await expect(first.getByRole("alert")).toHaveCount(0);
  /* It reached the server before anything asked about it, and was charged once. */
  expect(server.events[0]).toBe(`post:${key}`);
  expect(server.claims.get(key)).toBe("answered");
  expect(server.charges).toEqual([3]);

  /* Its reply in, the second window asks — and shows the same transcript. Nothing is sent again. */
  await expect(other.getByTestId("transcript")).toContainText("The ferry is here.");
  await expect(other.getByTestId("transcribe-note")).toHaveText("Your last transcription finished and was charged 3 credits. Nothing was sent again.");
  await expect(otherAction).toHaveText("Transcribed");
  await expect(other.getByRole("alert")).toHaveCount(0);
  expect(server.sent).toEqual([key]);
  expect(server.events.filter((event) => event.startsWith("post:"))).toEqual([`post:${key}`]);
  expect(server.events.slice(1).every((event) => event === `check:${key}`)).toBe(true);
  expect(server.charges).toEqual([3]);
  expect(await claimsLeft(page)).toEqual([]);
  expect(await claimsLeft(second)).toEqual([]);
  await fit(second, other.getByTestId("transcribe-note"));
  await fit(second, other.getByTestId("transcribe-srt"));
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, '[data-testid="transcribe"]'), "first window buttons under 44×44").toEqual([]);
    expect(await smallTargets(second, '[data-testid="transcribe"]'), "second window buttons under 44×44").toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("without Web Locks, the second window leaves a fresh claim to its window for about ten seconds, then asks and shows the transcript", async ({ page, context }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop run: the claim's stamp stands in for the lock");
  test.setTimeout(120_000);
  await context.addInitScript(() => { Object.defineProperty(Navigator.prototype, "locks", { configurable: true, get: () => undefined }); });
  const { server, second, first, other, errors } = await twoWindows(page, context);
  expect(await second.evaluate(() => "locks" in navigator && navigator.locks !== undefined)).toBe(false);
  let letThrough!: () => void;
  server.hold = new Promise<void>((resolve) => { letThrough = resolve; });
  const pressedAt = Date.now();
  await first.getByTestId("transcribe-run").click();
  await expect.poll(() => server.sent.length).toBe(1);
  const key = server.sent[0];
  await expect(other.getByTestId("transcribe-note")).toHaveText(ON_ITS_WAY);
  await second.waitForTimeout(3_000);
  expect(server.events).toEqual([]);
  letThrough();
  await expect(first.getByTestId("transcript")).toContainText("The ferry is here.");
  expect(server.events[0]).toBe(`post:${key}`);
  /* The second window asks once the claim is about ten seconds old, and shows the transcript; nothing is sent again. */
  await expect(other.getByTestId("transcript")).toContainText("The ferry is here.", { timeout: 20_000 });
  await expect(other.getByTestId("transcribe-note")).toHaveText("Your last transcription finished and was charged 3 credits. Nothing was sent again.");
  expect(server.events.slice(1).length).toBeGreaterThan(0);
  expect(server.events.slice(1).every((event) => event === `check:${key}`)).toBe(true);
  expect(server.firstCheckAt - pressedAt).toBeGreaterThanOrEqual(9_000);
  expect(server.sent).toEqual([key]);
  expect(server.charges).toEqual([3]);
  expect(errors).toEqual([]);
});
