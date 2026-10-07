import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia } from "./helpers/workspaceFixtures";
import { isCompact } from "./helpers/shellMode";

/**
 * The owner's D0 Make items 6, 7, 8 and 9 (design/particl-graphite/README.md § 0 rule 2, § 3.2, § 4), at 1440×900 and 390×844:
 *  6. Make opens on the handoff's defaults, each paid button wearing its price: "Seedance 2.5 · 1080p · 5 s · 43 cr" and
 *     "Make · 43 cr"; a still on Nano Banana Pro, "Make · 3 cr"; a voice line "Make · up to N cr" once there are words to price,
 *     disabled with its reason until then. The line reads with " · " between its parts on the desktop as on the phone.
 *  7. The engine sheet names the size and length each row's figure is at.
 *  8. Make › Recent names each engine in full, and Again wears the server's price for running it again.
 *  9. Object swap, with a source over its 409,600-pixel floor, reads "Swap object · up to N cr" and waits until priced.
 * Every figure is compared with the server's own read; the handoff's sample figures (43, 3) are what that read says today.
 * Nothing is sent: a send fails the test. ENGINE_MOCK server only.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const SEEDANCE = "dreamina-seedance-2-5-260628";
const BANANA_PRO = "gemini-3-pro-image";
const BANANA_2 = "gemini-3.1-flash-image";

/** The server's quote for one take, as the composer asks for it. */
async function quote(page: Page, model: string, resolution: string, duration = 5, ratio = "16:9"): Promise<number> {
  const q = new URLSearchParams({ model, resolution, ratio, duration: String(duration) });
  const reply = await page.request.get(`/api/workbench/engines?${q}`).then((r) => r.json()) as { credits: number };
  expect(typeof reply.credits).toBe("number");
  return reply.credits;
}

/** A signed-in workspace with credits and one saved project, open in this browser. */
async function seed(page: Page) {
  const workspaceId = (await signInLocally(page.request)).workspace.id;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 5000, "Make D0 fixture", "manual", "test", Date.now()] });
  } finally { db.close(); }
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = newProject(`D0 ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await forbidPaidWork(page);
  /* The audio price is the route's quoteOnly read: allowed through, and nothing else. */
  await page.route(/\/api\/audio$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    if ((route.request().postDataJSON() as { quoteOnly?: boolean }).quoteOnly !== true) throw new Error("Workspace tests must not submit paid work without a mock.");
    return route.continue();
  });
  const sends: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate") sends.push(request.url()); });
  return { errors, sends };
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

/** Make's parts, desktop panel or phone screen. */
function parts(page: Page, phone: boolean) {
  return {
    line: page.getByTestId(phone ? "phone-make-engine-line" : "make-engine-line"),
    go: page.getByTestId(phone ? "phone-make-go" : "gen-generate"),
    prompt: page.getByTestId(phone ? "phone-make-prompt" : "gen-prompt"),
    type: (type: "video" | "image" | "audio") => page.getByTestId(phone ? `phone-make-type-${type}` : `make-type-${type}`),
    change: page.getByTestId(phone ? "phone-make-change" : "gen-model"),
    rowPrice: page.getByTestId(phone ? "phone-make-engine-row-price" : "make-engine-row-price"),
  };
}

test("Make opens on Seedance 2.5 · 1080p · 5 s, Nano Banana Pro for a still and a voice for sound, every button priced by the server", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(240_000);
  const phone = isCompact(info);
  const { errors, sends } = await seed(page);
  await page.goto(phone ? "/suites?screen=make" : "/suites?make=video");
  const make = parts(page, phone);

  /* Video: the handoff's line and button, at the server's figure for Seedance 2.5 at 1080p and 5 s. */
  const video = await quote(page, SEEDANCE, "1080p");
  expect(video, "the rate card's Seedance 2.5 · 5 s 1080p row").toBe(43);
  await expect(make.line).toHaveText(`Seedance 2.5 · 1080p · 5 s · ${video} cr`, { timeout: 90_000 });
  await expect(make.go).toHaveText(`Make · ${video} cr`);
  /* Priced, and still waiting for words; with them, the dollars are on its hover. */
  await expect(make.go).toHaveAttribute("aria-disabled", "true");
  await make.prompt.fill("A night market, slow push past the lanterns");
  await expect(make.go).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await expect(make.go).toHaveText(`Make · ${video} cr`);
  await expect(make.go).toHaveAttribute("title", "$4.30");
  await make.prompt.fill("");

  /* 7: the sheet names the size and length every row's figure is at; the ticked row is the line's. */
  await make.change.click();
  const rows = make.rowPrice.filter({ hasText: / cr/ });
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  for (const row of await rows.all()) await expect(row).toHaveText(/^\d[\d,]* cr · (\d+p|\d+K|\d+) · \d+ s$/);
  const ticked = page.locator(phone ? '[data-testid="phone-make-engine-row"][aria-pressed="true"]' : '[data-testid="make-engine-row"][aria-pressed="true"]');
  await expect(ticked.getByTestId(phone ? "phone-make-engine-row-price" : "make-engine-row-price")).toHaveText(`${video} cr · 1080p · 5 s`);
  if (phone) await page.getByTestId("phone-sheet-close").click();
  else await make.change.click();

  /* Image: Nano Banana Pro at 1K. */
  const still = await quote(page, BANANA_PRO, "1K");
  expect(still, "the rate card's keyframe still row").toBe(3);
  await make.type("image").click();
  await expect(make.line).toHaveText(`Nano Banana Pro · 1K · ${still} cr`, { timeout: 60_000 });
  await expect(make.go).toHaveText(`Make · ${still} cr`);

  /* Audio: a voice, priced by its words. No words: Make waits, unpriced, with its reason. */
  await make.type("audio").click();
  await expect(make.line).toHaveText(/^\S.* · \S.*$/, { timeout: 60_000 });
  await expect(make.go).toHaveText("Make");
  await expect(make.go).toHaveAttribute("aria-disabled", "true");
  await expect(make.go).toHaveAttribute("data-spend", "unpriced");
  await make.go.dispatchEvent("click");
  await expect(page.getByTestId(phone ? "phone-make-blocked" : "gen-blocked")).toHaveText("Say what to make.");
  const voiceLine = (await make.line.textContent())!;
  await make.prompt.fill("What if the world saw you differently?");
  await expect(make.go).toHaveText(/^Make · up to \d[\d,]* cr$/, { timeout: 60_000 });
  const figure = (await make.go.textContent())!.replace("Make · ", "");
  await expect(make.line).toHaveText(`${voiceLine} · ${figure}`);
  await expect(make.go).not.toHaveAttribute("aria-disabled", "true");
  console.log(`${info.project.name}: video "${`Seedance 2.5 · 1080p · 5 s · ${video} cr`}" / image "Nano Banana Pro · 1K · ${still} cr" / audio "${voiceLine} · ${figure}" "Make · ${figure}"`);

  expect(await noOverflow(page)).toBe(true);
  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});

/* Recent: a hero take, a keyframe and a quick still. */
const clip = () => generation({ id: "gen_hero", kind: "video", model: SEEDANCE, title: "Market scene 1", prompt: "A night market, slow push", creditsBilled: 43,
  params: { ratio: "16:9", resolution: "1080p", duration: 5 }, durationS: 5 });
const keyframe = () => generation({ id: "gen_key", kind: "image", model: BANANA_PRO, title: "Market scene 2", prompt: "A night market, lanterns", creditsBilled: 3,
  params: { ratio: "16:9", resolution: "1K" } });
const quick = () => generation({ id: "gen_quick", kind: "image", model: BANANA_2, title: "Market scene 3", prompt: "A night market, rain", creditsBilled: 1,
  params: { ratio: "16:9", resolution: "1K" } });

test("Make › Recent names every engine in full, and Again wears the server's price for running it again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.skip(isCompact(info), "the phone app has no Make › Recent panel (its review screens carry Recreate at its price: demo-s10-phone-make-workbench); the desktop keeps every assertion here");
  test.setTimeout(240_000);
  const { errors, sends } = await seed(page);
  await mockMedia(page);
  await mockLibrary(page, { uploads: [], generations: [clip(), keyframe(), quick()] });
  await page.goto("/suites?make=recent");
  const panel = page.getByTestId("make-panel");
  const card = (name: string) => panel.getByTestId("make-recent-card").filter({ hasText: name });
  await expect(panel.getByTestId("make-recent-card")).toHaveCount(3, { timeout: 90_000 });

  const hero = await quote(page, SEEDANCE, "1080p");
  const key = await quote(page, BANANA_PRO, "1K");
  const fast = await quote(page, BANANA_2, "1K");
  /* The full names, never "NB Pro", "NB 2" or a bare "2.5". */
  await expect(card("Market scene 1").locator(".gx-asset-meta")).toHaveText("Seedance 2.5 · 5 s · 43 cr");
  await expect(card("Market scene 2").locator(".gx-asset-meta")).toHaveText("Nano Banana Pro · 1K · 3 cr");
  await expect(card("Market scene 3").locator(".gx-asset-meta")).toHaveText("Nano Banana 2 · 1K · 1 cr");
  await expect(panel).not.toContainText(/\bNB (Pro|2)\b/);
  /* Again: the quote for the same recipe today, on the button. */
  await expect(card("Market scene 1").getByTestId("make-again")).toHaveText(`Again · ${hero} cr`, { timeout: 60_000 });
  await expect(card("Market scene 2").getByTestId("make-again")).toHaveText(`Again · ${key} cr`, { timeout: 60_000 });
  await expect(card("Market scene 3").getByTestId("make-again")).toHaveText(`Again · ${fast} cr`, { timeout: 60_000 });
  for (const again of await panel.getByTestId("make-again").all()) {
    await expect(again).toBeEnabled();
    await expect(again).toHaveAttribute("data-spend", "priced");
  }
  /* Pressed, Again puts the recipe in Make, whose button shows the same figure. */
  await card("Market scene 2").getByTestId("make-again").click();
  await expect(page.getByTestId("gen-recipe")).toBeVisible();
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${key} cr`, { timeout: 60_000 });
  await expect(page.getByTestId("make-engine-line")).toHaveText(`Nano Banana Pro · 1K · ${key} cr`);
  expect(await noOverflow(page)).toBe(true);
  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});

/** An 854×480, 5-second clip: exactly Object swap's 409,600-pixel floor (public/fixtures/README.md). */
const SOURCE = { url: "/fixtures/swap-5s-854x480.mp4", name: "market.mp4", type: "video/mp4" };
const STILL = { url: "/campaign/character.webp", name: "cast.webp", type: "image/webp" };

test("Object swap with a source over its pixel floor wears its estimate, and waits until it has one", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.skip(isCompact(info), "the phone app draws no quick tool today (make-quick-tools-workbench records it); the desktop keeps every assertion here");
  test.setTimeout(240_000);
  const { errors, sends } = await seed(page);
  await page.goto("/suites?make=swap");
  const go = page.getByTestId("viral-generate");
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "swap", { timeout: 90_000 });
  /* No source, no price: the button names what it does and waits. */
  await expect(go).toHaveText("Swap object");
  await expect(go).toBeDisabled();
  await page.getByTestId("viral-well").evaluate(async (well, files) => {
    const data = new DataTransfer();
    for (const f of files) data.items.add(new File([await (await fetch(f.url)).blob()], f.name, { type: f.type }));
    well.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [SOURCE, STILL]);
  await expect(page.getByTestId("viral-source")).toContainText("market.mp4 · 5 s", { timeout: 60_000 });
  await expect(page.getByTestId("viral-reference")).toHaveCount(1, { timeout: 60_000 });
  /* Over the floor: admission prices it, and the button carries the estimate the line shows. */
  await expect(go).toHaveText(/^Swap object · up to \d[\d,]* cr$/, { timeout: 60_000 });
  await expect(page.getByTestId("viral-reason")).toHaveCount(0);
  const price = (await page.getByTestId("make-engine-price").innerText()).trim();
  expect(await go.innerText()).toContain(price);
  await expect(go).toBeEnabled();
  await expect(go).toHaveAttribute("data-spend", "priced");
  console.log(`${info.project.name}: swap "${(await go.textContent())}"`);
  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});
