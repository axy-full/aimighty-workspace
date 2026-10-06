import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { isCompact } from "./helpers/shellMode";

/**
 * Make with the new interface switched on (design/particl-graphite/README.md § 3.2; "Make frames.dc.html" 1–8): the
 * panel as drawn, Auto's type from the words, Change with the engines priced in "N cr" and dollars on hover, Advanced
 * folded, Recent's chips, and "Short by N cr · Top up" with Make still pressable. With the switch off, today's panel.
 * Against a local ENGINE_MOCK server; nothing is sent. The panel is the desktop's: from compact widths (tests/helpers/shellMode.ts, 844x390
 * included) the shell mounts the phone's own Make, covered by demo-s10-phone-make-workbench.spec.ts. `S06_SHOTS=<dir>` saves each state at 1440×900 and 390×844.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const SHOTS = process.env.S06_SHOTS;
const SHOT_SIZES: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

async function seed(page: Page, opts: { credits?: number } = {}) {
  const workspaceId = (await signInLocally(page.request)).workspace.id;
  if (opts.credits) {
    const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try {
      await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, opts.credits, "Make fixture", "manual", "test", Date.now()] });
    } finally { db.close(); }
  }
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const name = `Make ${randomUUID().slice(0, 6)}`;
  const project = newProject(name);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => {
    try { localStorage.setItem(scope, id); } catch { /* storage off */ }
  }, { scope, id: project.id });
  const errors: string[] = [];
  const sends: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.method() === "POST" && ["/api/generate", "/api/audio"].includes(new URL(request.url()).pathname)) sends.push(request.url()); });
  return { errors, sends, name, workspaceId };
}

/** Text the panel draws: at least 12 px, and at least 55 % white unless it belongs to a disabled control. */
async function faintText(page: Page) {
  return page.getByTestId("make-panel").evaluate((panel) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!text || !el || !el.getClientRects().length || el.closest("textarea, select, :disabled, [aria-disabled='true']")) continue;
      const style = getComputedStyle(el);
      let alpha = Number(style.color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/)?.[1] ?? 1);
      for (let at: Element | null = el; at && at !== panel.parentElement; at = at.parentElement) alpha *= Number(getComputedStyle(at).opacity);
      if (Number.parseFloat(style.fontSize) < 12 || alpha < 0.55) out.push(`${style.fontSize} ${alpha.toFixed(2)}: “${text.slice(0, 30)}”`);
    }
    return out;
  });
}

async function floors(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  expect(await page.getByTestId("make-panel").evaluate((el) => el.scrollWidth - el.clientWidth), "nothing wider than the panel").toBeLessThanOrEqual(1);
  expect(await faintText(page), "the text floor").toEqual([]);
}

async function shot(page: Page, project: string, name: string) {
  const size = SHOT_SIZES[project];
  if (!SHOTS || !size) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${size}.png` });
}

/** The words, the way a person types them (the composer listens to input events). */
async function say(page: Page, words: string) {
  const box = page.getByTestId("gen-prompt");
  await box.click();
  await box.fill(words);
}

test("Make, new interface: the panel as drawn, the type inferred from the words, and Image and Audio", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(isCompact(info), "at compact widths the shell mounts the phone's own Make (phone-make-*), not this panel; the phone covers the same screen in demo-s10-phone-make-workbench (\"Make: the words, the type, the engine line with Change, References with Add, where it lands, and Make at its price\") and sends once, at the price on its button, in \"Make sends once, at the price on its button\"");
  test.setTimeout(180_000);
  const { errors, sends, name } = await seed(page, { credits: 5000 });
  /* A cold dev server reloads the page once while it first compiles Make's routes (Fast Refresh): warm them first. */
  await page.goto("/suites?make=1");
  await say(page, "make shot 2 at golden hour");
  await expect(page.getByTestId("gen-generate")).toHaveText(/cr$/, { timeout: 90_000 }).catch(() => undefined);
  await page.goto("/suites?make=1");
  const panel = page.getByTestId("make-panel");
  await expect(panel).toHaveAttribute("data-ui", "new");
  await expect(panel).toHaveAttribute("data-tab", "video");

  /* Frame 1, empty: the words box, the type inside it, inferred; References with Add; the engine line; where it goes; Make. */
  await expect(page.getByTestId("make-title")).toHaveText("Make");
  await expect(page.getByTestId("make-tab-make")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-prompt")).toHaveAttribute("placeholder", "make shot 2 at golden hour");
  await expect(page.getByRole("radiogroup", { name: "Type" }).getByRole("radio")).toHaveText(["Video", "Image", "Audio"]);
  await expect(page.getByTestId("make-type-video")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("make-type-note")).toHaveText("inferred from your words");
  await expect(page.getByTestId("gen-well")).toContainText("References");
  await expect(page.getByTestId("gen-well")).toContainText("drag from the Library or the board");
  await expect(page.getByTestId("make-add-reference")).toHaveText("+Add");
  await expect(page.getByTestId("gen-model")).toHaveText("Change");
  await expect(page.getByTestId("make-dest")).toHaveText(`To ${name} · Library`);
  await expect(page.getByTestId("make-quick-tools").getByRole("button")).toHaveText(["Motion transfer", "Object swap", "Upscale"]);
  /* Make waits with the words' reason: dimmed, and pressing it says why. */
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("gen-blocked")).toHaveCount(0);
  await shot(page, info.project.name, "f1-make-empty");
  /* aria-disabled, not disabled: a person can still press it (Playwright will not click it, so the press is dispatched). */
  await go.dispatchEvent("click");
  await expect(page.getByTestId("gen-blocked")).toHaveText("Say what to make.");
  await expect(page.getByTestId("gen-prompt")).toBeFocused();
  await floors(page);

  /* Words in: "from your words", and Make at the live price, in credits, with its dollars on hover. */
  await say(page, "make shot 2 at golden hour");
  await expect(page.getByTestId("make-type-note")).toHaveText("from your words");
  await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
  await expect(go).toHaveAttribute("title", /^\$\d[\d,]*\.\d\d$/);
  await expect(go).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("make-engine-price")).toHaveText(/^\d[\d,]* cr$/);
  await expect(page.getByTestId("make-engine-price")).toHaveAttribute("title", /^\$\d[\d,]*\.\d\d$/);
  expect(await panel.innerText()).not.toMatch(/\bquoted\b|\babout \d/i);
  await floors(page);

  /* Frame 7: a still, inferred from the words, and the address follows. */
  await say(page, "a still of the sphere at blue hour");
  await expect(page.getByTestId("make-type-image")).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
  await expect.poll(() => param(page, "make")).toBe("image");
  await expect(page.getByTestId("make-type-note")).toHaveText("from your words");
  await expect(go).toHaveText(/^Make( \d takes)? · \d[\d,]* cr$|^Make$/, { timeout: 60_000 });
  await floors(page);
  await shot(page, info.project.name, "f2-make-image");

  /* A pick stands: the note goes, and words that sound like sound no longer move it. */
  await page.getByTestId("make-type-video").click();
  await expect(page.getByTestId("make-type-note")).toHaveCount(0);
  await say(page, "her line, a calm voice");
  await page.waitForTimeout(600);
  await expect(page.getByTestId("make-type-video")).toHaveAttribute("aria-checked", "true");

  /* Audio: no references (sound takes none); the engine line names the voice or the length. */
  await page.getByTestId("make-type-audio").click();
  await expect.poll(() => param(page, "make")).toBe("audio");
  await expect(page.getByTestId("gen-well")).toHaveCount(0);
  await expect(page.getByTestId("make-engine-line")).not.toBeEmpty();
  await floors(page);
  await shot(page, info.project.name, "f3-make-audio");

  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});

test("Change: the type's engines priced in cr with dollars on hover, the drawn lengths, and Advanced folded", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(isCompact(info), "at compact widths the shell mounts the phone's own Make; its engines priced in cr with dollars on hover are demo-s10-phone-make-workbench \"phone Make, Change: every engine row ends in its price in cr, with the dollars on hover\"");
  test.setTimeout(180_000);
  const { errors, sends } = await seed(page, { credits: 5000 });
  /* `make=change` opens Make with the list open. */
  await page.goto("/suites?make=change");
  const panel = page.getByTestId("make-panel");
  await expect(panel).toHaveAttribute("data-ui", "new");
  const list = page.getByTestId("make-engines");
  await expect(list).toBeVisible();
  await expect(page.getByTestId("gen-model")).toHaveText("Done");
  await expect(page.getByTestId("gen-model")).toHaveAttribute("aria-expanded", "true");
  await say(page, "make shot 2 at golden hour");
  const rows = page.getByTestId("make-engine-row");
  await expect(rows.first()).toBeVisible();
  /* The engine in use is the pressed row; every figure is "N cr" with its dollars, or none at all. */
  await expect(list.locator('[data-testid="make-engine-row"][aria-pressed="true"]')).toHaveCount(1);
  await expect(list.locator(".gx-price").first()).toHaveText(/^\d[\d,]* cr$/, { timeout: 60_000 });
  for (const price of await list.locator(".gx-price").all()) {
    const words = (await price.innerText()).trim();
    expect(words).toMatch(/^\d[\d,]* cr$|^free$/);
    if (words !== "free") await expect(price).toHaveAttribute("title", /^\$\d[\d,]*\.\d\d$/);
  }
  expect(await list.innerText()).not.toMatch(/\bquoted\b|\babout \d/i);
  const lengths = page.getByTestId("make-length");
  if (await lengths.count()) {
    await lengths.last().click();
    await expect(lengths.last()).toHaveAttribute("aria-pressed", "true");
    const seconds = (await lengths.last().innerText()).trim();
    await expect(page.getByTestId("make-engine-line")).toContainText(seconds);
  }
  await expect(page.getByTestId("gen-generate")).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
  await floors(page);
  await shot(page, info.project.name, "f4-make-change");

  /* Advanced, folded: the settings the handoff does not draw. */
  await expect(page.getByTestId("make-advanced")).toHaveCount(0);
  await page.getByTestId("make-advanced-toggle").click();
  await expect(page.getByTestId("make-advanced-toggle")).toHaveAttribute("aria-expanded", "true");
  const advanced = page.getByTestId("make-advanced");
  await expect(advanced.getByTestId("gen-takes")).toBeVisible();
  await expect(advanced.getByTestId("enhance")).toBeVisible();
  await advanced.getByRole("button", { name: "More" }).click();
  await expect(advanced.getByTestId("gen-takes-count")).toHaveText("2");
  await expect(page.getByTestId("gen-generate")).toHaveText(/^Make 2 takes · \d[\d,]* cr$/, { timeout: 60_000 });
  await floors(page);
  await advanced.scrollIntoViewIfNeeded();
  await shot(page, info.project.name, "f4-make-advanced");

  /* Picking a row chooses it and closes the list; Done closes it too. */
  await rows.first().click();
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId("gen-model")).toHaveText("Change");
  await page.getByTestId("gen-model").click();
  await expect(list).toBeVisible();
  await page.getByTestId("gen-model").click();
  await expect(list).toHaveCount(0);
  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});

test("a balance short of the price says by how much, with Top up, and Make stays pressable", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(isCompact(info), "at compact widths the shell mounts the phone's own Make; Short by N cr, Top up and Make still pressable are demo-s10-phone-make-workbench \"phone Make, a balance short of the price: Short by N cr \u00b7 Top up, Make still pressable, nothing sent\"");
  test.setTimeout(180_000);
  const { errors, sends } = await seed(page);
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("make-panel")).toHaveAttribute("data-ui", "new");
  await say(page, "make shot 2 at golden hour");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
  /* Four takes at the longest length: more than a new workspace holds. */
  await page.getByTestId("gen-model").click();
  await page.getByTestId("make-advanced-toggle").click();
  const advanced = page.getByTestId("make-advanced");
  const length = advanced.getByTestId("gen-length");
  if (await length.count()) await length.selectOption({ index: (await length.locator("option").count()) - 1 });
  /* The largest size the engine renders, then four takes. */
  const sizes = advanced.getByRole("group", { name: "Resolution" }).getByRole("button");
  if (await sizes.count()) await sizes.last().click();
  for (let i = 0; i < 3; i++) await advanced.getByRole("button", { name: "More" }).click();
  await expect(go).toHaveText(/^Make 4 takes · \d[\d,]* cr$/, { timeout: 60_000 });
  const short = page.getByTestId("make-short");
  await expect(short).toHaveText(/^Short by \d[\d,.]* cr · Top up$/);
  await expect(go).not.toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("gen-model").click();
  await short.scrollIntoViewIfNeeded();
  await floors(page);
  await shot(page, info.project.name, "make-short-by");
  await page.getByTestId("make-top-up").click();
  await expect.poll(() => param(page, "tab")).toBe("credits");
  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});

test("Recent: the master's chips, and an empty project teaches by doing", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(isCompact(info), "Recent is not drawn on a phone in Release 1: the SOW draws it for the panel (§2.4) and lists only simple Make for the phone (§2.8), so ?make=recent shows Home there; no phone twin by design");
  test.setTimeout(120_000);
  const { errors, sends } = await seed(page, { credits: 5000 });
  await page.goto("/suites?make=recent");
  const panel = page.getByTestId("make-panel");
  await expect(panel).toHaveAttribute("data-ui", "new");
  await expect(panel).toHaveAttribute("data-tab", "recent");
  await expect(page.getByTestId("make-tab-recent")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("group", { name: "Show" }).getByRole("button")).toHaveText(["All", "Takes", "Unfiled", "Filed"]);
  await expect(page.getByTestId("make-recent-all")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-results-empty")).toContainText("Nothing made in this project yet.");
  await floors(page);
  await shot(page, info.project.name, "f6-make-recent");
  await page.getByTestId("make-recent-filed").click();
  await expect(page.getByTestId("make-recent-filed")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("make-recent-make").click();
  await expect(panel).toHaveAttribute("data-tab", "video");
  await expect(page.getByTestId("gen-prompt")).toBeVisible();
  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});

test("the quick tools open over the panel", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(isCompact(info), "Motion transfer and Object swap are not drawn on a phone in Release 1: the SOW draws them as modes of the panel (§2.4) and lists only simple Make for the phone (§2.8), so ?make=motion|swap shows Home there; no phone twin by design");
  test.setTimeout(120_000);
  const { errors, sends } = await seed(page, { credits: 5000 });
  await page.goto("/suites?make=video");
  const panel = page.getByTestId("make-panel");
  await expect(panel).toHaveAttribute("data-ui", "new");
  await page.getByTestId("make-tool-motion").click();
  await expect(panel).toHaveAttribute("data-tab", "motion");
  await expect(page.getByTestId("make-title")).toHaveText("Motion transfer");
  await expect(page.getByTestId("make-tab-recent")).toHaveCount(0);
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "motion");
  await page.getByTestId("make-close").click();
  await expect(panel).toHaveCount(0);

  /* There is one Make: the Edit tab is gone. */
  await page.goto("/suites?make=video");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("gen-tab-edit")).toHaveCount(0);
  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});

test("a press the server accepts: Make closes, the toast says rendering, and the board is told which card to light", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(isCompact(info), "at compact widths the shell mounts the phone's own Make; its one send at the price on the button is demo-s10-phone-make-workbench \"Make sends once, at the price on its button\"");
  test.setTimeout(180_000);
  const { errors, sends } = await seed(page, { credits: 5000 });
  /* The board's side is stream 3's; what it hears is the window event. */
  await page.addInitScript(() => {
    (window as unknown as { __made: unknown[] }).__made = [];
    window.addEventListener("particl:board-made", (event) => (window as unknown as { __made: unknown[] }).__made.push((event as CustomEvent).detail));
  });
  await page.goto("/suites?make=video");
  await say(page, "make shot 2 at golden hour");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 90_000 });
  const price = ((await go.innerText()).match(/\d[\d,]* cr/) ?? [""])[0];
  await go.click();
  await expect(page.getByTestId("make-panel")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText(new RegExp(`${price} · rendering`)).first()).toBeVisible();
  expect(sends.length, "one send, at the press").toBe(1);
  const made = await page.evaluate(() => (window as unknown as { __made: { projectId: string; nodeId: string; name: string }[] }).__made);
  expect(made).toHaveLength(1);
  expect(made[0].projectId).toMatch(/^project-/);
  expect(made[0].nodeId).toBeTruthy();
  expect(errors).toEqual([]);
});
