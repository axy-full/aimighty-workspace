import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import type { Generation } from "../lib/jobs";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload, type LibraryRoute } from "./helpers/workspaceFixtures";
import { labelsUnderFloor } from "./helpers/businessOwn";
import { smallTargets } from "./phoneFloors";

/**
 * Idea 12, second slice: priced Next actions on a take. A still is upscaled, outpainted or animated; a clip is upscaled,
 * reframed or extended — each from the take's Next row, in the Inspector or on the Takes desk's selected take. The action's
 * panel shows the estimate for exactly its request ("about N cr", from the quote route, which charges nothing); its one
 * button sends that request once, at that estimate, claimed first (a lost reply is never sent twice); a moved estimate is
 * asked about again; the new take lands filed with its source, which is left as it was; a failure says what its provider
 * did with the charge and offers Retry, priced again. Every paid route is mocked here and recorded: nothing is billed.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SEEDANCE_25 = "dreamina-seedance-2-5-260628";
const TOPAZ_IMAGE = "fal-ai/topaz/upscale/image";
const BRIA_EXPAND = "fal-ai/bria/expand";
const ASTRA = "topaz/upscale/video/creative";
const LUMA_REFRAME = "fal-ai/luma-dream-machine/ray-2-flash/reframe";
const VIDEO_ENGINES = new Set([SEEDANCE_25, ASTRA, LUMA_REFRAME]);
/** Test estimates, in credits, by engine: made up for the mock, and nothing like a real price list. */
const ESTIMATE: Record<string, number> = { [TOPAZ_IMAGE]: 12, [BRIA_EXPAND]: 3, [SEEDANCE_25]: 31, [ASTRA]: 44, [LUMA_REFRAME]: 9 };

const fixture = (saved = true): Project => ({ ...newProject("Next steps"), id: "ws-next", ...(saved ? { productionProjectId: "prod-next" } : {}), shotMappings: {} });
const store = (): LibraryRoute => ({
  generations: [
    generation({ id: "gen_still", title: "Pier at dusk", prompt: "a pier at dusk", projectId: "prod-next", shotId: "shot_pier", shotCode: "SH010", params: { ratio: "16:9", resolution: "1K" } }),
    generation({ id: "gen_clip", title: "Ferry turning", prompt: "the ferry turns", kind: "video", model: SEEDANCE_25, projectId: "prod-next", shotId: "shot_ferry", shotCode: "SH020", params: { resolution: "720p", duration: 8, ratio: "16:9" } }),
    generation({ id: "gen_wide", title: "Harbour at 1080p", prompt: "the harbour", kind: "video", model: SEEDANCE_25, projectId: "prod-next", params: { resolution: "1080p", duration: 8, ratio: "16:9" } }),
    generation({ id: "gen_voice", title: "Keeper's line", prompt: "the storm is coming", kind: "audio", model: "eleven_v3", projectId: "prod-next" }),
  ],
  uploads: [upload({ id: "up_script", filename: "the-crossing.pdf", mime: "application/pdf", kind: "file", width: 0, height: 0 })],
});

type Sent = { body: Record<string, unknown>; key: string | null };
/**
 * The workspace's own rules, as admission answers the quote: "reason" — the shot has an approved take, so it asks why
 * before it prices another (lib/approval.ts); "admin" — the cost approval rule's cap per shot, which a member's take
 * would pass, so an admin has to press it (lib/approvalRule.ts).
 */
type Rule = "reason" | "admin" | null;
type Server = { quotes: Record<string, unknown>[]; sent: Sent[]; writes: string[]; bump: number; failNext: boolean; holdNext: boolean; rule: Rule };
const ASK = { title: "v1 is approved. Why render another?", line: "Ana approved v1. The reason is kept with the new take, so the shot's record says why it was revisited." };
const CAP_LINE = "SH010 is at 60 cr; this take makes it 72 cr, over the 50 cr a shot may take. An admin has to press this one.";

/** The new take as admission files it: its own row, under its source's shot as the next version, naming its source. */
function filed(id: string, body: Record<string, unknown>, library: LibraryRoute): Generation {
  const model = String(body.model);
  const shotId = typeof body.shotId === "string" && body.shotId ? body.shotId : null;
  const shot = library.generations.filter((g) => shotId && g.shotId === shotId);
  const references = Array.isArray(body.references) ? (body.references as Record<string, unknown>[]).map((r) => ({ ...r, kind: "image" })) : [];
  const task = typeof body.task === "string" ? body.task : "generate";
  return generation({
    id, projectId: "prod-next", kind: VIDEO_ENGINES.has(model) ? "video" : "image", model, prompt: String(body.prompt ?? ""), title: null,
    status: "queued", storedUrl: null, shotId, shotCode: shot[0]?.shotCode ?? null, version: shotId ? Math.max(0, ...shot.map((g) => g.version)) + 1 : 1,
    task, sourceGenId: typeof body.sourceGenId === "string" ? body.sourceGenId : null, createdAt: Date.now(), updatedAt: Date.now(),
    params: {
      ...(typeof body.ratio === "string" ? { ratio: body.ratio } : {}), references,
      ...(task !== "generate" ? { task } : {}),
      ...(typeof body.sourceGenId === "string" ? { sourceGenId: body.sourceGenId } : {}),
      ...(typeof body.sourceUploadId === "string" ? { sourceUploadId: body.sourceUploadId } : {}),
    },
  });
}

/** The paid routes, mocked and recorded: the quote (by engine, `bump` added once asked), the one paid POST, and its job. */
async function mockPaid(page: Page, library: LibraryRoute): Promise<Server> {
  const server: Server = { quotes: [], sent: [], writes: [], bump: 0, failNext: false, holdNext: false, rule: null };
  const jobs = new Map<string, { reads: number; fail: boolean; held: boolean }>();
  await page.route("**/api/generate/quote", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    server.quotes.push(body);
    if (server.rule === "reason" && !(typeof body.reason === "string" && body.reason.trim().length >= 3))
      return route.fulfill({ status: 409, json: { error: ASK.title, line: ASK.line, needsReason: true, approvedVersion: 1 } });
    if (server.rule === "admin") return route.fulfill({ status: 403, json: { error: CAP_LINE, needsAdmin: true } });
    const credits = (ESTIMATE[String(body.model)] ?? 1) + server.bump;
    return route.fulfill({ json: { estimatedCredits: credits, price: credits, unit: "cr", fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex") } });
  });
  await page.route("**/api/generate/check", (route) => route.fulfill({ json: { state: "absent" } }));
  await page.route(/\/api\/generate$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const body = request.postDataJSON() as Record<string, unknown>;
    server.sent.push({ body, key: request.headers()["idempotency-key"] ?? null });
    const id = `gen_next_${server.sent.length}`;
    const held = server.holdNext;
    library.generations.unshift({ ...filed(id, body, library), ...(held ? { status: "held" } : {}) });
    jobs.set(id, { reads: 0, fail: server.failNext, held });
    server.failNext = false;
    server.holdNext = false;
    /* Short of credits, admission parks the take as held (lib/held.ts): accepted, reserved nothing, charged nothing yet. */
    return route.fulfill({ status: 202, json: held ? { id, status: "held", held: true } : { id, status: "queued" } });
  });
  /* The new take's job: running when first read, then its end — landed, or failed with what its provider did with the charge. A held one waits. */
  await page.route(/\/api\/jobs\/gen_next_\d+(\?.*)?$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const job = jobs.get(id), g = library.generations.find((x) => x.id === id);
    if (route.request().method() !== "GET" || !job || !g) return route.fallback();
    job.reads++;
    if (job.held) g.status = "held";
    else if (job.reads > 1) {
      Object.assign(g, job.fail
        ? { status: "failed", error: "Refused by the content filter.", failure: { provider: "byteplus", stage: "run", code: "OutputVideoSensitiveContentDetected", kind: "content_filter", message: null, billing: null, payer: "platform", charge: { credits: 0, settled: true } } }
        : { status: "succeeded", storedUrl: `/api/media/${id}` });
    } else g.status = "running";
    return route.fulfill({ json: { generation: g } });
  });
  /* Nothing may write to a source take: a PATCH or DELETE to any job is recorded as a write. */
  page.on("request", (request) => {
    if (/\/api\/jobs\//.test(request.url()) && ["PATCH", "DELETE"].includes(request.method())) server.writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return server;
}

async function open(page: Page, url: string, saved = true) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture(saved) });
  const library = store();
  await mockLibrary(page, library);
  const server = await mockPaid(page, library);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId("project-name")).toHaveText("Next steps");
  return { server, library, errors };
}
const assets = async (page: Page, info: TestInfo) => {
  if (!WIDE.includes(info.project.name)) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
};
const tile = (page: Page, id: string) => page.getByTestId("library").locator(`.gx-asset-thumb[data-ctx='asset:${id}']`);
const deskTile = (page: Page, name: string) => page.getByTestId("takes-grid").getByTestId("take-tile").filter({ has: page.getByText(name, { exact: true }) });
async function inspect(page: Page, info: TestInfo, id: string) {
  await assets(page, info);
  await tile(page, id).click();
  return page.getByTestId("inspector");
}

/**
 * The panel keeps the floors where it is: inside the screen with nothing scrolling sideways, its labels at #7C7C84 after
 * alpha, and its price whole on its button; on a phone every target in it is 44px and its button clears the tab bar.
 */
async function panelFloors(page: Page, info: TestInfo, panel: Locator, where: string) {
  const box = (await panel.boundingBox())!;
  expect(box.x + box.width, `${where}: the panel inside the screen`).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${where}: no sideways scroll`).toBeLessThanOrEqual(1);
  expect(await labelsUnderFloor(page, `${where} [data-testid="next-panel"]`), `${where}: labels under #7C7C84`).toEqual([]);
  const go = panel.getByTestId("next-go");
  expect(await go.evaluate((el) => [...el.querySelectorAll<HTMLElement>(".gx-go-act, .gx-go-price")].filter((part) => part.scrollWidth > part.clientWidth + 1 || part.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((part) => part.textContent)),
    `${where}: the price is never cut`).toEqual([]);
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, `${where} [data-testid="next-panel"]`), `${where}: targets under 44×44`).toEqual([]);
    const bar = page.getByTestId("tabbar");
    if (await bar.isVisible()) {
      await expect.poll(async () => {
        await go.evaluate((el) => el.scrollIntoView({ block: "center" }));
        const [after, barBox] = [(await go.boundingBox())!, (await bar.boundingBox())!];
        return after.y + after.height - barBox.y;
      }, { message: `${where}: the button clears the tab bar` }).toBeLessThanOrEqual(0.5);
    }
  }
  /* With NEXT_SHOTS_DIR set, a picture of the panel where it is. */
  if (process.env.NEXT_SHOTS_DIR) {
    const action = await panel.getAttribute("data-action");
    await panel.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: `${process.env.NEXT_SHOTS_DIR}/priced-${where.includes("inspector") ? "inspector" : "desk"}-${action}-${info.project.name.replace("workbench-", "")}.png` });
  }
}

/** Open an action (unless its panel is open already: its button toggles it), see its estimate, press it once, and see the new take land. Returns the request it sent. */
async function run(page: Page, info: TestInfo, server: Server, where: string, row: Locator, action: string, label: string, credits: number, set?: (panel: Locator) => Promise<void>) {
  const button = row.getByTestId(`next-${action}`);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const panel = row.getByTestId("next-panel");
  await expect(panel).toHaveAttribute("data-action", action);
  if (set) await set(panel);
  const go = panel.getByTestId("next-go");
  await expect(go).toHaveText(`${label} · about ${credits} cr`);
  await expect(go).toBeEnabled();
  await panelFloors(page, info, panel, where);
  const before = server.sent.length;
  await go.click();
  await expect.poll(() => server.sent.length).toBe(before + 1);
  await expect(panel.getByTestId("next-landed")).toBeVisible({ timeout: 20_000 });
  const sent = server.sent[before];
  /* Sent once, claimed under its own key, at the estimate shown, with the fingerprint of the quote it was shown from. */
  expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent.body).toMatchObject({ maxCredits: credits, quoteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  return { panel, sent: sent.body };
}

test("the Inspector prices a still's Upscale, Outpaint and Animate, sends each once at its estimate, and files each new take with the still", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { server, library, errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards");
  const inspector = await inspect(page, info, "generation:gen_still");
  const row = inspector.getByTestId("next-actions");
  await expect(row.getByRole("button")).toHaveText(["Re-edit ›", "Upscale", "Outpaint", "Animate"]);
  const where = '[data-testid="inspector"]';

  const up = await run(page, info, server, where, row, "upscale", "Upscale", 12, async (panel) => {
    await expect(panel.locator(".gx-next-panel-head")).toHaveText(/^Upscale\s*Topaz Image Upscale$/);
    await expect(panel.getByTestId("next-scale").getByRole("radio", { checked: true })).toHaveText("2×");
  });
  expect(up.sent).toMatchObject({ model: TOPAZ_IMAGE, projectId: "prod-next", shotId: "shot_pier", topaz: { factor: 2 }, references: [{ genId: "gen_still", role: "reference_image" }] });
  await expect(up.panel.getByTestId("next-landed")).toContainText("Done: a new take, SH010 v2, filed with Pier at dusk, which stays as it is.");
  await up.panel.getByTestId("next-close").click();
  await expect(row.getByTestId("next-panel")).toHaveCount(0);

  const out = await run(page, info, server, where, row, "outpaint", "Outpaint", 3, async (panel) => {
    await expect(panel.getByTestId("next-ratio")).toHaveValue("9:16");
    await panel.getByTestId("next-ratio").selectOption("1:1");
    await panel.getByTestId("next-words").fill("more of the harbour");
  });
  expect(out.sent).toMatchObject({ model: BRIA_EXPAND, ratio: "1:1", prompt: "more of the harbour", shotId: "shot_pier", references: [{ genId: "gen_still", role: "reference_image" }] });
  await expect(out.panel.getByTestId("next-landed")).toContainText("SH010 v3");
  await out.panel.getByTestId("next-close").click();

  /* Animate asks for the motion first, and prices nothing until it is written. */
  await row.getByTestId("next-animate").click();
  const panel = row.getByTestId("next-panel");
  await expect(panel.getByTestId("next-blocked")).toHaveText("Write what moves.");
  await expect(panel.getByTestId("next-go")).toBeDisabled();
  const asked = server.quotes.length;
  const anim = await run(page, info, server, where, row, "animate", "Animate", 31, async (p) => { await p.getByTestId("next-words").fill("The camera pushes in slowly; the flags stir"); });
  expect(server.quotes.slice(asked).every((q) => String(q.prompt).length > 0)).toBe(true);
  expect(anim.sent).toMatchObject({ model: SEEDANCE_25, task: "generate", ratio: "16:9", resolution: "720p", duration: 5, generateAudio: false, shotId: "shot_pier", references: [{ genId: "gen_still", role: "first_frame" }] });

  /* The new take opens, and says what it was made from. */
  await anim.panel.getByTestId("next-open-result").click();
  await expect(inspector.getByTestId("inspector-title")).toHaveText("The camera pushes in slowly; the flags stir");
  await expect(inspector.getByTestId("asset-facts")).toContainText("Made from");
  await expect(inspector.getByTestId("asset-facts")).toContainText("Pier at dusk · first frame");

  /* Three takes, three presses, three keys; the still itself was never written to, and is still there as it was. */
  expect(server.sent).toHaveLength(3);
  expect(new Set(server.sent.map((s) => s.key)).size).toBe(3);
  expect(server.writes).toEqual([]);
  expect(library.generations.find((g) => g.id === "gen_still")).toMatchObject({ status: "succeeded", title: "Pier at dusk", version: 1 });
  expect(errors).toEqual([]);
});

test("on the Takes desk a clip's Upscale, Reframe and Extend are priced and sent from the selected take, and the new take opens there", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { server, errors } = await open(page, "/suites?suite=studio&page=takes");
  await deskTile(page, "Ferry turning").getByTestId("edit-take").click();
  const selected = page.getByTestId("takes-selected");
  const row = selected.getByTestId("next-actions");
  await expect(row.getByRole("button")).toHaveText(["Edit ›", "Upscale", "Reframe", "Extend"]);
  const where = '[data-testid="takes-selected"]';

  const up = await run(page, info, server, where, row, "upscale", "Upscale", 44, async (panel) => {
    await expect(panel).toContainText("Topaz Astra 2");
    await panel.getByTestId("next-fps").getByRole("radio", { name: "60 fps" }).click();
  });
  expect(up.sent).toMatchObject({ model: ASTRA, task: "upscale", prompt: "", resolution: "4k", fps60: true, astra: { fps: 60 }, sourceGenId: "gen_clip", shotId: "shot_ferry", references: [] });
  await up.panel.getByTestId("next-close").click();

  const re = await run(page, info, server, where, row, "reframe", "Reframe", 9, async (panel) => {
    await expect(panel.getByTestId("next-ratio")).toHaveValue("9:16");
  });
  expect(re.sent).toMatchObject({ model: LUMA_REFRAME, task: "reframe", ratio: "9:16", sourceGenId: "gen_clip", shotId: "shot_ferry" });
  await re.panel.getByTestId("next-close").click();

  const ext = await run(page, info, server, where, row, "extend", "Extend", 31, async (panel) => {
    await panel.getByTestId("next-direction").getByRole("radio", { name: "Go back" }).click();
    await panel.getByTestId("next-words").fill("she walks up to the pier");
  });
  expect(ext.sent).toMatchObject({ model: SEEDANCE_25, task: "extend", prompt: "Extend backward: she walks up to the pier", ratio: "adaptive", resolution: "720p", duration: 5, generateAudio: true, sourceGenId: "gen_clip", shotId: "shot_ferry" });
  await expect(ext.panel.getByTestId("next-landed")).toContainText("SH020 v4");
  await ext.panel.getByTestId("next-open-result").click();
  await expect(selected).toContainText("Selected · Extend backward: she walks up to the pier");
  expect(server.writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("a moved estimate is asked about again: nothing is sent until the new one is pressed, and then it goes at the new one", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { server, errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards");
  const row = (await inspect(page, info, "generation:gen_still")).getByTestId("next-actions");
  await row.getByTestId("next-upscale").click();
  const panel = row.getByTestId("next-panel");
  const go = panel.getByTestId("next-go");
  await expect(go).toHaveText("Upscale · about 12 cr");
  server.bump = 2;
  await go.click();
  await expect(panel.getByTestId("next-note")).toHaveText("The estimate is now about 14 cr. Press Upscale again to approve it.");
  await expect(go).toHaveText("Upscale · about 14 cr");
  expect(server.sent, "nothing sent at the old estimate").toEqual([]);
  await go.click();
  await expect.poll(() => server.sent.length).toBe(1);
  expect(server.sent[0].body).toMatchObject({ maxCredits: 14 });
  await expect(panel.getByTestId("next-landed")).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test("short of credits: the estimate turns the credits pill amber, and the take sent is held, charged nothing until it runs", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { server, errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards");
  const pill = page.getByTestId("workspace-credits");
  await expect(pill).toContainText(/\d/);
  await expect(pill).not.toHaveAttribute("data-low");
  const balance = Number(((await pill.textContent()) ?? "").replace(/[^0-9.]/g, ""));
  expect(balance, "the balance the pill shows").toBeGreaterThan(0);
  const row = (await inspect(page, info, "generation:gen_still")).getByTestId("next-actions");
  /* An estimate the balance cannot cover: the pill weighs the balance against it, as it does Gen's price. */
  const price = Math.ceil(balance) + 100;
  server.bump = price - ESTIMATE[TOPAZ_IMAGE];
  await row.getByTestId("next-upscale").click();
  const panel = row.getByTestId("next-panel");
  const go = panel.getByTestId("next-go");
  await expect(go).toHaveText(`Upscale · about ${price.toLocaleString("en-US")} cr`);
  await expect(pill).toHaveAttribute("data-low", "true");
  await panelFloors(page, info, panel, '[data-testid="inspector"]');
  /* Sent at that estimate, it is held: accepted, reserved nothing, and says so. */
  server.holdNext = true;
  await go.click();
  await expect.poll(() => server.sent.length).toBe(1);
  expect(server.sent[0].body).toMatchObject({ maxCredits: price });
  await expect(panel.getByTestId("next-following")).toHaveText("It is held until credits or a render slot free up. Nothing is charged until it runs.");
  await expect(go).toBeDisabled();
  expect(server.sent, "sent once").toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a failed action says what happened and what its provider did with the charge, and Retry is priced again before it sends", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { server, library, errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards");
  const row = (await inspect(page, info, "generation:gen_clip")).getByTestId("next-actions");
  await row.getByTestId("next-extend").click();
  const panel = row.getByTestId("next-panel");
  await panel.getByTestId("next-words").fill("the ferry clears the harbour");
  const go = panel.getByTestId("next-go");
  await expect(go).toHaveText("Extend · about 31 cr");
  server.failNext = true;
  await go.click();
  await expect(panel.getByTestId("next-failed")).toHaveText("Refused by the content filter · Not billed · Change the prompt or reference", { timeout: 20_000 });
  /* Retry is the paid re-render: its own estimate on its button, and one more press. */
  await expect(go).toHaveText("Retry · about 31 cr");
  await go.click();
  await expect.poll(() => server.sent.length).toBe(2);
  await expect(panel.getByTestId("next-landed")).toBeVisible({ timeout: 20_000 });
  expect(server.sent[1].key).not.toBe(server.sent[0].key);
  /* The failed take stays on record beside the one that landed; nothing was taken away. */
  expect(library.generations.filter((g) => g.id.startsWith("gen_next_")).map((g) => g.status)).toEqual(["succeeded", "failed"]);
  expect(server.writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("what cannot go says why and sends nothing: a sound's actions are not offered, a 1080p clip cannot be extended, an unsaved project waits", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { server, errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards");
  let inspector = await inspect(page, info, "generation:gen_voice");
  await expect(inspector.getByTestId("next-upscale")).toBeDisabled();
  await expect(inspector.getByTestId("next-extend")).toBeDisabled();
  await expect(inspector.getByTestId("next-not-offered")).toHaveText("Upscale and Extend are not offered: no engine Particl uses upscales or extends sound.");
  if (!WIDE.includes(info.project.name)) await page.getByTestId("close-inspector").click();
  inspector = await inspect(page, info, "generation:gen_wide");
  await expect(inspector.getByTestId("next-extend")).toBeDisabled();
  await expect(inspector.getByTestId("next-upscale")).toBeEnabled();
  await expect(inspector.getByTestId("next-why")).toHaveText("Extend takes a 480p or 720p clip; this one is 1080p.");
  expect(server.quotes, "no quote without an open action").toEqual([]);
  expect(server.sent).toEqual([]);

  const unsaved = await open(page, "/suites?suite=particl&page=boards&sp=boards", false);
  const still = await inspect(page, info, "generation:gen_still");
  for (const id of ["re-edit", "upscale", "outpaint", "animate"]) await expect(still.getByTestId(`next-${id}`)).toBeDisabled();
  await expect(still.getByTestId("next-why")).toHaveText("Save the project first.");
  expect(unsaved.server.quotes).toEqual([]);
  expect([...errors, ...unsaved.errors]).toEqual([]);
});

test("the workspace's rules hold in the panel: an approved shot asks why before it is priced; past the shot's cap, an admin has to press it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { server, errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards");
  const row = (await inspect(page, info, "generation:gen_still")).getByTestId("next-actions");
  const panel = row.getByTestId("next-panel");
  /* SH010's v1 is approved: the quote asks why first, and nothing is priced until the reason is written. */
  server.rule = "reason";
  await row.getByTestId("next-outpaint").click();
  await expect(panel.getByTestId("next-asked")).toHaveText(`${ASK.title} ${ASK.line}`);
  await expect(panel.getByTestId("next-go")).toBeDisabled();
  await expect(panel.getByTestId("next-go")).not.toContainText("about");
  await panel.getByTestId("next-reason").fill("Square for the poster");
  await expect(panel.getByTestId("next-go")).toHaveText("Outpaint · about 3 cr");
  await panelFloors(page, info, panel, '[data-testid="inspector"]');
  await panel.getByTestId("next-go").click();
  await expect.poll(() => server.sent.length).toBe(1);
  /* The reason goes with the take it explains, which is filed under the shot as its next version. */
  expect(server.sent[0].body).toMatchObject({ model: BRIA_EXPAND, shotId: "shot_pier", reason: "Square for the poster", maxCredits: 3 });
  await expect(panel.getByTestId("next-landed")).toBeVisible({ timeout: 20_000 });
  await panel.getByTestId("next-close").click();

  /* The cost approval rule: past the shot's cap, a member's take needs an admin. The server's words; the button stays shut. */
  server.rule = "admin";
  await row.getByTestId("next-upscale").click();
  await expect(panel.getByTestId("next-refused")).toHaveText(CAP_LINE);
  await expect(panel.getByTestId("next-go")).toBeDisabled();
  await expect(panel.getByTestId("next-go")).toHaveText("Upscale");
  expect(server.sent, "nothing more sent").toHaveLength(1);
  expect(server.writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("on a phone the Inspector's Next panel keeps the floors for a clip's actions, and its button clears the tab bar", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "the phone sizes");
  const { server, errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards");
  const inspector = await inspect(page, info, "generation:gen_clip");
  const row = inspector.getByTestId("next-actions");
  const where = '[data-testid="inspector"]';
  for (const action of ["upscale", "reframe", "extend"]) {
    await row.getByTestId(`next-${action}`).click();
    const panel = row.getByTestId("next-panel");
    await expect(panel).toHaveAttribute("data-action", action);
    if (action === "extend") await panel.getByTestId("next-words").fill("the ferry clears the harbour");
    await expect(panel.getByTestId("next-go")).toContainText("about");
    await panelFloors(page, info, panel, where);
    await panel.getByTestId("next-close").click();
  }
  expect(server.sent, "opening and pricing sends nothing").toEqual([]);
  expect(errors).toEqual([]);
});
