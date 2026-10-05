import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject, type CanvasNode } from "../lib/workbench/studio";

/*
 * Stream 5 · the board's Cast region (design/particl-graphite/README.md § 3.1 h), behind the new-interface switch. A
 * production with a beat sheet, a cast, a place and an element opens as a board: each card says what is recorded,
 * the training consent that exists is read from the identities list, Render a still hands its words to Make (which
 * prices it), and nothing paid is ever sent. Neutral names only.
 */
const SHOTS = process.env.S05_SHOTS || "/private/tmp/claude-s05-shots";

const shotNode = (id: string, title: string, boardShotId: string): CanvasNode =>
  ({ id, title, type: "scene", x: 0, y: 0, width: 344, linked: [], boardShotId }) as CanvasNode;

async function seed(page: Page) {
  const workspaceId = (await signInWithNewInterface(page.request, "Cast Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const shot = (id: string) => ({ id, description: "A shot", framing: "Wide", movement: "Held", lighting: "", sound: "" });
  const base = newProject("Cast fixture");
  const project = {
    ...base,
    brief: "A short film about a morning market opening.",
    nodes: [shotNode("node-shot0001", "Opening wide", "b1"), shotNode("node-shot0002", "The first stall", "b2"), shotNode("node-shot0003", "Close on hands", "b3")],
    production: {
      beats: {
        scriptSha256: "a".repeat(64), updatedAt: "2026-10-05T00:00:00Z",
        scenes: [{ id: "sc1", heading: "EXT. MARKET", summary: "", beats: [], characters: ["Lead", "Second"], locations: ["Stall row"], props: ["Brass scale"], shots: [shot("b1"), shot("b2"), shot("b3")] }],
      },
      cast: {
        entries: [
          { id: "cast-lead", name: "Lead", kind: "character", description: "ivory suit, short dark bob", prompt: "A woman in an ivory suit with a short dark bob", takes: [], identityId: "id-lead" },
          { id: "cast-second", name: "Second", kind: "character", description: "grey coat", prompt: "A man in a grey coat", takes: [] },
          { id: "cast-scale", name: "Brass scale", kind: "element", category: "prop", description: "Set piece", prompt: "A brass market scale", takes: [] },
        ],
      },
      environment: {
        world: "Warm morning light", model: "gemini-3.1-flash-image",
        entries: [{ id: "env-row", name: "Stall row", notes: "Early morning, awnings half open", prompt: "", references: [], plates: [] }],
      },
    },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });

  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && ((path.startsWith("/api/generate") && path !== "/api/generate/quote") || /\/release$/.test(path) || path.startsWith("/api/soul/identities"))) paid.push(path);
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/workbench/library?**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("source");
    if (route.request().method() !== "GET") return route.continue();
    return json(route, source === "generations" ? { generations: [], nextPageCursor: null } : { uploads: [], nextCursor: null });
  });
  await page.route("**/api/soul/identities?**", (route) => {
    if (route.request().method() !== "GET") return route.abort();
    return json(route, {
      identities: [{ id: "id-lead", projectId: null, name: "Lead v2", description: "", subjectType: "character", references: [], status: "ready", previewUrl: null, createdAt: 1, updatedAt: 1, creditsBilled: 54, error: null, renderModel: "soul_2", consentAt: Date.UTC(2026, 8, 12, 10), consentBy: "Tester" }],
      configured: true, generationAvailable: true,
      terms: { minPhotos: 1, maxPhotos: 40, trainingCredits: 54, versions: [{ version: "v1", trainingCredits: 54 }] },
    });
  });
  return { project, paid };
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const card = (page: Page, name: string) => page.getByTestId("cast-card").filter({ hasText: name });

test("the Cast region draws a character, a place and an element: their words, state, shots and consent; nothing paid", async ({ page }, info) => {
  test.skip(!desktop(page), "phone widths open the project's Record (stream 10); the canvas is desktop only");
  const { project, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();

  const group = page.locator('[data-card-id="group:cast"]').getByTestId("board-group");
  await expect(group).toContainText("Cast, environment and elements");
  await expect(group).toContainText("2 characters · 1 place · 1 element");
  await expect(page.getByTestId("cast-card")).toHaveCount(4);

  /* The character with a ready identity: its state, its shots and the consent that exists. */
  const lead = card(page, "ivory suit");
  await expect(lead).toHaveAccessibleName("Lead · ivory suit, short dark bob");
  await expect(lead.getByTestId("cast-status")).toHaveText("Identity ready · Lead v2");
  await expect(lead.getByTestId("cast-shots")).toHaveText("Shots 1 · 2 · 3");
  await expect(lead.getByTestId("cast-consent")).toContainText("Training consent confirmed 12 Sep 2026 by Tester");
  await expect(lead.getByTestId("cast-build")).toHaveCount(0);
  await expect(lead.getByTestId("cast-render")).toHaveText("Render a still");

  /* The one with no identity says so, shows the fixed training price, and has no consent on record. */
  const second = card(page, "grey coat");
  await expect(second.getByTestId("cast-status")).toHaveText("No identity yet");
  await expect(second.getByTestId("cast-consent")).toContainText("None recorded yet");
  await expect(second.getByTestId("cast-build")).toHaveText("Build identity · 54 cr");

  await expect(card(page, "Stall row").getByTestId("cast-status")).toHaveText("No plate yet");
  await expect(card(page, "Stall row").getByTestId("cast-render")).toHaveText("Render a plate");
  await expect(card(page, "Brass scale").getByTestId("cast-status")).toHaveText("No still yet");

  /* No placeholder person: the page says only what was recorded. */
  await expect(page.locator("body")).not.toContainText(/\bMira\b|Sethi/);

  mkdirSync(SHOTS, { recursive: true });
  /* The rail glides the board to the Cast region (.35 s). */
  await page.locator('[data-region="cast"]').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/cast-${info.project.name.replace("workbench-", "")}.png` });

  /* Cards are draggable: every control inside one opts out of the drag and the pan, or a press starts a drag. */
  expect(await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} input, ${sel} select, ${sel} textarea, ${sel} a`)].filter((el) => !el.closest(".nodrag")).length, "[data-testid=\"cast-card\"]")).toBe(0);
  /* Render a still hands the words to Make (which prices them); nothing is sent. */
  await lead.getByTestId("cast-render").click();
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("A woman in an ivory suit with a short dark bob");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
});

test("a character's Inspector holds the consent and, until an identity is ready, the Build identity form with its consent box", async ({ page }, info) => {
  test.skip(!desktop(page), "phone widths open the project's Record (stream 10); the canvas is desktop only");
  const { project, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("cast-card")).toHaveCount(4);

  await card(page, "ivory suit").getByTestId("cast-title").click();
  const insp = page.getByTestId("board-inspector");
  await expect(insp.getByTestId("insp-cast-consent")).toHaveText("Training consent confirmed 12 Sep 2026 by Tester");
  await expect(insp.getByTestId("insp-build")).toHaveCount(0);

  /* Build identity opens the same Inspector on the character that has none, with the existing form. */
  await card(page, "grey coat").getByTestId("cast-build").click();
  await expect(insp.getByTestId("insp-cast")).toContainText("Second");
  await expect(insp.getByTestId("insp-build")).toBeVisible();
  await expect(insp.getByTestId("soul-card")).toBeVisible();
  await expect(insp.getByTestId("insp-cast-consent")).toContainText("None recorded yet");
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/cast-inspector-${info.project.name.replace("workbench-", "")}.png` });
  await page.keyboard.press("Escape");
  await expect(insp).toHaveCount(0);
  expect(paid).toEqual([]);
});

test("at phone widths the board is not drawn: no cast cards, nothing overflows", async ({ page }) => {
  test.skip(desktop(page), "desktop widths are the two tests above");
  const { project, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("cast-card")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
});
