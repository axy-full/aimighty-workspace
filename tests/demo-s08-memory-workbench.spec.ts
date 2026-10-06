import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInWithNewInterface } from "./helpers/newInterface";
import { expectLargerScreen } from "./helpers/largerScreen";
import { smallTargets } from "./phoneFloors";

/**
 * Control room › Memory (Atomik frame j) with the new interface on, on the
 * real memory routes (free): what waits is kept or skipped, a line is added,
 * a kept line is forgotten after one question in place. Reading with Atomik
 * is priced in credits as "up to N cr" from its quote, and is not pressed
 * here (its read route is answered by a fixture and never called to read).
 */

const PAGE = "/suites?suite=atomik&page=agent&sp=memory";
const SHOTS = join(tmpdir(), "claude-s08-shots");
const SHOT_SIZES = ["workbench-1440x900", "workbench-390x844"];

/**
 * The viewports where the shell mounts the phone app (lib/shell/use-compact.ts: narrower than 768 px, or a touch screen no taller than
 * 500 px, so 844x390 is a phone). The phone has no screen for the control room's Activity, Memory or Skills until after the demo: their
 * addresses show one plain "Open this on a larger screen" page (tests/helpers/largerScreen.ts), which these tests assert there instead.
 */
const COMPACT = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const isCompact = (info: { project: { name: string } }) => COMPACT.includes(info.project.name);

async function floors(page: Page, phone: boolean) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector(".cr");
    if (!root) return ["no .cr"];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement, text = (node.textContent ?? "").trim();
      if (!text || !el || !el.getClientRects().length) continue;
      if (Number.parseFloat(getComputedStyle(el).fontSize) < 12) out.push(text.slice(0, 30));
    }
    return out;
  });
  expect(small, "text under 12 px").toEqual([]);
  if (phone) expect(await smallTargets(page, ".cr"), "targets under 44×44").toEqual([]);
}

test("memory: keep what waits, add a line, forget one in place; reading is priced up to its quote", async ({ page }, info) => {
  if (isCompact(info)) { await expectLargerScreen(page, PAGE, "Memory"); return; }
  test.setTimeout(180_000);
  const signed = await signInWithNewInterface(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  /* Two lines waiting, as a paste from another assistant files them (free, the existing import). */
  const filed = await page.request.post("/api/atomik/memory", {
    headers: { "X-Workbench-Scope": scope },
    data: { action: "import", text: "Our audience is design-led studios.\nAlways deliver a 9:16 cutdown.", projectId: null, from: "claude" },
  });
  expect(filed.ok(), await filed.text()).toBeTruthy();
  const reads: unknown[] = [];
  await page.route("**/api/atomik/memory/read", (route) => {
    const body = route.request().postDataJSON();
    reads.push(body);
    return body?.quoteOnly === true ? route.fulfill({ json: { model: "auto", estimateCredits: 3 } }) : route.fulfill({ status: 500, json: { error: "not in this spec" } });
  });

  await page.goto(PAGE);
  await expect(page.getByTestId("page-title")).toHaveText("Memory");
  const waiting = page.getByTestId("memory-waiting").getByTestId("memory-line");
  await expect(waiting).toHaveCount(2);
  await expect(waiting.first()).toContainText("Imported from Claude");
  await floors(page, info.project.use.isMobile === true);
  if (SHOT_SIZES.includes(info.project.name)) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/memory-${info.project.name.replace("workbench-", "")}.png`, fullPage: true });
  }

  /* Keep one, skip the other. */
  await waiting.first().getByTestId("memory-keep").click();
  await expect(page.getByTestId("memory-waiting").getByTestId("memory-line")).toHaveCount(1);
  await page.getByTestId("memory-waiting").getByTestId("memory-skip").click();
  await expect(page.getByTestId("memory-waiting")).toHaveCount(0);
  const workspace = page.getByTestId("memory-workspace").getByTestId("memory-line");
  await expect(workspace).toHaveCount(1);

  /* Add a line (no project open: the whole workspace). */
  await page.getByTestId("memory-add-text").fill("Hero films always end on the product.");
  await page.getByTestId("memory-add-go").click();
  await expect(workspace).toHaveCount(2);
  await expect(page.getByTestId("memory-workspace")).toContainText("Added by you");

  /* Forget asks once, in place. */
  const line = workspace.filter({ hasText: "Hero films always end on the product." });
  await line.getByTestId("memory-forget").click();
  await line.getByTestId("memory-forget-confirm").click();
  await expect(workspace).toHaveCount(1);

  /* Read with Atomik: priced from its quote, in credits, before anything is sent. */
  await page.getByTestId("memory-read-text").fill("Brand: ivory and sand. Audience: studios.");
  await page.getByTestId("memory-read-open").click();
  await expect(page.getByTestId("memory-read-go")).toHaveText("Read · up to 3 cr");
  await expect(page.getByTestId("memory-read-estimate")).not.toContainText(/about|\$/);
  expect(reads.every((r) => (r as { quoteOnly?: boolean }).quoteOnly === true)).toBe(true);
});
