import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { newProject, type Project } from "../lib/workbench/studio";
import type { CastEntry } from "../lib/production/cast";
import type { TakeFailure } from "../lib/providerOutcome";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { dimLabels } from "./phoneFloors";

/**
 * Production › Cast: a character's render that did not finish says what every
 * other take says (lib/errors.ts failureLine) — what happened, what Particl's
 * ledger holds for it (held, charged, or "Not billed" once it settled at
 * nothing), then the next step — and nothing about the charge while neither
 * the ledger nor the provider has said. Each entry has one render in flight;
 * its read (GET /api/jobs/:id) is answered here with the failure that route
 * sends once the ledger's charge is folded in (withLedgerCharges). Every
 * other route is the real one on a local ENGINE_MOCK=1 server, and nothing
 * is sent to an engine. Separate from tests/suites-cast-workbench.spec.ts,
 * which other changes rewrite.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];

/* Test fixtures only. */
const refused: TakeFailure = { provider: "higgsfield", stage: "run", code: "nsfw", kind: "content_filter", message: null, billing: null, payer: "platform" };
const engineError: TakeFailure = { ...refused, code: "error", kind: "provider_error" };
/** An entry, the render it has in flight, the take the read answers with, and the line its card prints. */
const CASES: { name: string; job: string; generation: { status: string; error?: string; failure: TakeFailure }; line: string }[] = [
  { name: "Fox", job: "gen_cast_settled", generation: { status: "failed", error: "The connected account rejected this generation during moderation.", failure: { ...refused, charge: { credits: 0, settled: true } } },
    line: "Refused by the content filter · Not billed · Change the prompt or reference" },
  { name: "Mara", job: "gen_cast_charged", generation: { status: "failed", failure: { ...engineError, charge: { credits: 12, settled: true } } },
    line: "The engine hit an error · 12 cr charged · Render again" },
  { name: "Ivo", job: "gen_cast_held", generation: { status: "failed", failure: { ...engineError, charge: { credits: 12, settled: false } } },
    line: "The engine hit an error · 12 cr held · Render again" },
  /* A held render discarded before it was sent. */
  { name: "Lux", job: "gen_cast_discarded", generation: { status: "cancelled", failure: { provider: null, stage: null, code: "unknown", kind: "unknown", message: null, billing: null, payer: null, charge: { credits: 0, settled: true } } },
    line: "Cancelled · Not billed · Render again" },
  /* Nothing on the ledger yet and nothing from the provider: no word on the charge, never "Not billed". */
  { name: "Wren", job: "gen_cast_unsaid", generation: { status: "failed", failure: engineError },
    line: "The engine hit an error · Render again" },
];

async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const project = newProject(`Cast failures ${randomUUID().slice(0, 6)}`);
  const entries: CastEntry[] = CASES.map((c, i) => ({
    id: `cast-${i}`, kind: "character", name: c.name, description: "", prompt: `${c.name} on the ice at dusk`, takes: [],
    pending: [{ jobId: c.job, at: new Date(Date.now() - 60_000).toISOString(), batch: 1 }],
  }));
  project.production = { cast: { entries } } as Project["production"];
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await forbidPaidWork(page);
  const reads = new Map<string, number>();
  await page.route(/\/api\/jobs\/(gen_cast_[a-z]+)(\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const found = CASES.find((c) => c.job === id);
    if (!found || route.request().method() !== "GET") return route.fallback();
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return route.fulfill({ json: { generation: { id, kind: "image", model: "hf-soul-standard", creditsBilled: null, params: {}, ...found.generation } } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as Project;
  return { project, reads, errors, read };
}

test("a Cast render that did not finish says what happened, what the ledger kept, and what to do next", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the five sizes");
  test.setTimeout(150_000);
  const f = await setup(page);
  await page.goto(`/suites?suite=studio&page=cast&project=${f.project.id}`);
  await expect(page.getByTestId("cast-stage")).toBeVisible({ timeout: 60_000 });
  const entry = (name: string) => page.getByTestId("cast-entry").filter({ has: page.locator(`input[value="${name}"]`) });

  for (const c of CASES) {
    const line = entry(c.name).getByTestId("cast-error");
    await expect(line, c.name).toHaveText(c.line, { timeout: 30_000 });
    await expect(line).toHaveAttribute("role", "alert");
    expect(f.reads.get(c.job), `${c.name}'s render was read`).toBeGreaterThanOrEqual(1);
  }
  /* The provider's own words never stand in for the line, and no card claims a blanket "Not billed". */
  await expect(page.getByTestId("cast-error").filter({ hasText: "moderation" })).toHaveCount(0);
  await expect(page.getByTestId("cast-error").filter({ hasText: "Not billed" })).toHaveCount(2);

  /* Each render left its entry's in-flight list once it was read, so a reload never reads it again; nothing was filed. */
  await expect.poll(async () => (await f.read()).production?.cast?.entries.map((e) => e.pending ?? []), { timeout: 20_000 }).toEqual(CASES.map(() => []));
  expect((await f.read()).production?.cast?.entries.every((e) => e.takes.length === 0)).toBe(true);

  /* The lines sit inside their cards, at the floors. */
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  for (const line of await page.getByTestId("cast-error").all()) {
    expect(await line.evaluate((el) => el.scrollWidth - el.clientWidth), "a line keeps its words inside its card").toBeLessThanOrEqual(1);
    expect(await line.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)), "a line's text is 12px or more").toBeGreaterThanOrEqual(12);
  }
  expect(await dimLabels(page, '[data-testid="cast-stage"]')).toEqual([]);
  await entry("Wren").getByTestId("cast-error").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("cast-failures.png") });
  expect(f.errors).toEqual([]);
});
