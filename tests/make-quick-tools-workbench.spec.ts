import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { smallTargets } from "./phoneFloors";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws no quick tool today (?make=motion|swap shows Home); that gap is recorded as a fixme twin in demo-s10-phone-make-workbench 'the quick tools on a phone', and the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws no quick tool today (?make=motion|swap shows Home); that gap is recorded as a fixme twin in demo-s10-phone-make-workbench 'the quick tools on a phone', and the desktop keeps every assertion here"); });

/**
 * Make's quick tools (design/particl-graphite/README.md § 1.1, § 1.2, § 3.2): Motion transfer and Object swap are
 * modes of the Make panel (`make=motion|swap`), opened from its quick-tool row, and the old Viral page links land on
 * them over Studio; Viral History is still a page. Against a local ENGINE_MOCK server: nothing is sent, and the
 * estimate is the mock engine's. The money path itself (quote, approval, one send) is suites-viral-workbench's.
 * `PR5B_SHOTS=<dir>` also saves each mode at 1440×900 and 390×844, with a source and references in place.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.PR5B_SHOTS;
const SHOT_SIZES: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };
const CLIP = { url: "/fixtures/clip-6s.mp4", name: "walk.mp4", type: "video/mp4" };
const STILLS = [
  { url: "/campaign/character.webp", name: "cast.webp", type: "image/webp" },
  { url: "/campaign/environment.webp", name: "dunes.webp", type: "image/webp" },
];

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

async function seed(page: Page) {
  const workspaceId = (await signInLocally(page.request)).workspace.id;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 5000, "Quick tools fixture", "manual", "test", Date.now()] });
  } finally { db.close(); }
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = newProject(`Quick ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const errors: string[] = [];
  const sends: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate") sends.push(request.url()); });
  return { errors, sends };
}

async function dropFiles(page: Page, files: { url: string; name: string; type: string }[]) {
  await page.getByTestId("viral-well").evaluate(async (well, files) => {
    const data = new DataTransfer();
    for (const f of files) data.items.add(new File([await (await fetch(f.url)).blob()], f.name, { type: f.type }));
    well.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, files);
}

/** Text this PR draws (a tool's panel, or the quick-tool row): at least 12 px, and at least 55 % white unless it belongs to a disabled control. */
async function faintText(page: Page, scope: string) {
  return page.getByTestId(scope).evaluate((panel) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!text || !el || !el.getClientRects().length || el.closest("textarea, :disabled")) continue;
      const style = getComputedStyle(el);
      const alpha = Number(style.color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/)?.[1] ?? 1) * Number(style.opacity);
      if (Number.parseFloat(style.fontSize) < 12 || alpha < 0.55) out.push(`${style.fontSize} ${alpha.toFixed(2)}: “${text.slice(0, 30)}”`);
    }
    return out;
  });
}

async function floors(page: Page, project: string, scope = "make-panel") {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  expect(await faintText(page, scope), "the text floor").toEqual([]);
  if (PHONES.includes(project)) expect(await smallTargets(page, '[data-testid="make-panel"]'), "44px targets").toEqual([]);
}

test("Make's quick tools: the row opens Motion transfer and Object swap over the page, the old Viral links land on them, and History stays a page", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  const { errors, sends } = await seed(page);

  /* The row under Make. */
  await page.goto("/suites?make=video");
  const panel = page.getByTestId("make-panel");
  await expect(panel).toHaveAttribute("data-tab", "video");
  const row = page.getByTestId("make-quick-tools");
  await expect(row.getByRole("button")).toHaveText(["Motion transfer", "Object swap", "Upscale"]);
  await floors(page, info.project.name, "make-quick-tools");
  if (SHOTS && SHOT_SIZES[info.project.name]) {
    mkdirSync(SHOTS, { recursive: true });
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/make-quick-tools-row-${SHOT_SIZES[info.project.name]}.png` });
  }

  await row.getByRole("button", { name: "Motion transfer" }).click();
  await expect(panel).toHaveAttribute("data-tab", "motion");
  expect(param(page, "make")).toBe("motion");
  await expect(page.getByTestId("make-title")).toHaveText("Motion transfer");
  /* A tool has no Make/Recent tabs and no quick-tool row of its own. */
  await expect(page.getByTestId("make-tab-recent")).toHaveCount(0);
  await expect(page.getByTestId("make-quick-tools")).toHaveCount(0);
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "motion");
  await expect(page.getByTestId("viral-source-card")).toContainText("Choose a video");
  await expect(page.getByTestId("viral-source-card")).toContainText("The motion to recast");
  await expect(page.getByTestId("viral-well")).toContainText("References · 1 to 8");
  await expect(page.getByTestId("viral-well")).toContainText("0 of 8");
  await expect(page.getByTestId("viral-engine").locator(".gx-model-name")).toHaveText("Motion transfer");
  await expect(page.getByTestId("viral-engine").locator(".gx-make-engine-part")).toHaveText(["720p"]);
  await expect(page.getByTestId("viral-reason")).toHaveText("Add one source video (4–8 s).");
  await expect(page.getByTestId("viral-generate")).toBeDisabled();
  await expect(page.getByTestId("viral-generate")).toHaveText("Transfer motion");
  await expect(page.getByRole("radiogroup", { name: "Resolution" }).getByRole("radio")).toHaveText(["480p", "720p", "1080p"]);
  await floors(page, info.project.name);

  /* Closing it closes Make; Back brings the tool back. */
  await page.getByTestId("make-close").click();
  await expect(panel).toHaveCount(0);
  expect(param(page, "make")).toBeNull();
  await page.goBack();
  await expect(panel).toHaveAttribute("data-tab", "motion");

  /* The design's form of the old link, and the shell's own: each lands on the tool over Studio, with nothing of Viral left. */
  for (const [link, tool, title] of [["/suites?suite=viral&page=swap", "swap", "Object swap"], ["/suites?suite=subatomik&page=motion&sp=motion", "motion", "Motion transfer"]] as const) {
    await page.goto(link);
    await expect(panel).toHaveAttribute("data-tab", tool);
    await expect(page.getByTestId("make-title")).toHaveText(title);
    expect([param(page, "make"), param(page, "sp")]).toEqual([tool, expect.not.stringMatching(/^(motion|swap)$/)]);
    expect(param(page, "suite")).toBe("particl");
  }
  await expect(page.getByTestId("viral-well")).toContainText("References · 1 to 8");
  await page.goto("/suites?suite=viral&page=swap");
  await expect(page.getByTestId("viral-well")).toContainText("With");
  await expect(page.getByTestId("viral-source-card")).toContainText("The clip with the element to replace");
  await expect(page.getByTestId("viral-generate")).toHaveText("Swap object");
  await floors(page, info.project.name);

  /* History is the Social board's History drawer, and its way back to a tool is Make. */
  await page.goto("/suites?suite=subatomik&page=history&sp=history");
  await expect(page.getByTestId("history-view")).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("history-empty")).toBeVisible();
  await page.getByTestId("history-empty").getByRole("button", { name: "Motion Transfer" }).click();
  await expect(panel).toHaveAttribute("data-tab", "motion");
  /* From the tool, Open History closes Make and goes there. */
  await page.getByTestId("viral-recent").getByRole("button", { name: "Open History" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("history-view")).toBeVisible();

  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});

test("a source and references in each tool: the card, the four-across references and the estimate on the line and the button", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(240_000);
  const { errors, sends } = await seed(page);
  for (const tool of ["motion", "swap"] as const) {
    await page.goto(`/suites?make=${tool}`);
    await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", tool);
    /* No price yet, so the button names only what it does and waits (it never invents a figure). */
    await expect(page.getByTestId("viral-generate")).toBeDisabled();
    await expect(page.getByTestId("viral-generate")).toHaveText(tool === "motion" ? "Transfer motion" : "Swap object");
    await dropFiles(page, [CLIP, ...STILLS]);
    await expect(page.getByTestId("viral-source")).toContainText("walk.mp4 · 6 s", { timeout: 60_000 });
    await expect(page.getByTestId("viral-reference")).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId("viral-well")).toContainText("2 of 8");
    if (tool === "motion") {
      /* The mock engine's estimate, on the line and on the button alike. */
      await expect(page.getByTestId("viral-generate")).toHaveText(/^Transfer motion · up to \d[\d,]* cr$/, { timeout: 60_000 });
      const price = (await page.getByTestId("make-engine-price").innerText()).trim();
      expect(await page.getByTestId("viral-generate").innerText()).toContain(price);
      await expect(page.getByTestId("viral-generate")).toBeEnabled();
      await expect(page.getByTestId("viral-generate")).toHaveAttribute("title", /^up to \$\d+\.\d\d$/);
    } else {
      /* This clip is under Object Swap's pixel floor: admission says so before any estimate, and the button waits. */
      await expect(page.getByTestId("viral-reason")).toContainText("409,600 pixels", { timeout: 60_000 });
      await expect(page.getByTestId("viral-generate")).toBeDisabled();
    }
    await floors(page, info.project.name);
    const size = SHOT_SIZES[info.project.name];
    if (SHOTS && size) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/make-${tool}-${size}.png` });
    }
  }
  expect(sends, "nothing is sent").toEqual([]);
  expect(errors).toEqual([]);
});
