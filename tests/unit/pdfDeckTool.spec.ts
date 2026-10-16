import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as zod from "zod";
import { loadRoute } from "../helpers/routeModule";
import type { TenantWorkspace } from "../../lib/tenant";
import { exportWorkerPool, fakePdf } from "./remotionWorkerFake";

/* The deck PDF tool (lib/pdf/*, POST /api/pdf, the MCP tool make_deck_pdf): off by default, on only for the house workspace and the workspaces the
   owner lists, free, scoped to the caller's own workspace, and made through the worker's one fixed command. Real temporary databases; the worker
   is in memory; no browser, no network, nothing sent or spent. */
const directory = mkdtempSync(path.join(tmpdir(), "pdf-tool-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const saved = { pdf: process.env.PDF_EXPORTS, urls: process.env.REMOTION_WORKER_URLS, secrets: process.env.REMOTION_WORKER_SECRETS };
test.beforeEach(() => { delete process.env.PDF_EXPORTS; });
test.afterAll(() => { for (const [key, value] of [["PDF_EXPORTS", saved.pdf], ["REMOTION_WORKER_URLS", saved.urls], ["REMOTION_WORKER_SECRETS", saved.secrets]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

const workspace = (name: string, extra: Partial<TenantWorkspace> = {}): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null, ...extra });
const OWNER = { id: "u_owner", role: "member" }, MATE = { id: "u_mate", role: "member" };

test("the gate is the shared engine gate: PDF_EXPORTS exactly 1, and then only the house workspace and the workspaces the owner lists in enginesOnWorkspaces", async () => {
  const { pdfExportsEnabled, pdfAllowedFor } = await import("../../lib/pdf/switch");
  for (const value of [undefined, "", "0", "off", "false", "no", "2", "on", "true", "yes", "enabled", " ", " 1"]) {
    if (value === undefined) delete process.env.PDF_EXPORTS; else process.env.PDF_EXPORTS = value;
    expect(pdfExportsEnabled(), String(value)).toBe(false);
  }
  process.env.PDF_EXPORTS = "1";
  expect(pdfExportsEnabled()).toBe(true);
  const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
  const { platformReady, platformDb } = await import("../../lib/platform");
  await platformReady();
  const list = (ids: string[]) => platformDb().execute({
    sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, ?, 'test') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [JSON.stringify({ openSignup: false, guestHome: false, visitorPages: false, guestWorkspace: null, newInterfaceWorkspaces: ["ws_customer"], enginesOnWorkspaces: ids }), Date.now()],
  });
  await list([]);
  // Off: nobody, not even the house workspace.
  delete process.env.PDF_EXPORTS;
  expect(await pdfAllowedFor({ id: HOUSE_WORKSPACE_ID })).toBe(false);
  process.env.PDF_EXPORTS = "on";
  expect(await pdfAllowedFor({ id: HOUSE_WORKSPACE_ID })).toBe(false);
  // On: the house workspace; a customer workspace is off until the owner lists it for engines (the new-interface list does not count).
  process.env.PDF_EXPORTS = "1";
  expect(await pdfAllowedFor({ id: HOUSE_WORKSPACE_ID })).toBe(true);
  expect(await pdfAllowedFor({ id: "ws_customer" })).toBe(false);
  expect(await pdfAllowedFor(null)).toBe(false);
  await list(["ws_listed"]);
  expect(await pdfAllowedFor({ id: "ws_listed" })).toBe(true);
  expect(await pdfAllowedFor({ id: "ws_customer" })).toBe(false);
  // Listed but the switch off: still nothing.
  delete process.env.PDF_EXPORTS;
  expect(await pdfAllowedFor({ id: "ws_listed" })).toBe(false);
});

test("the tool declares what rule 11 asks: id, who may call, key, switch, a price of 0, and names the missing key", async () => {
  const { PDF_TOOL, pdfToolAvailability } = await import("../../lib/pdf/tool");
  expect(PDF_TOOL).toMatchObject({ id: "make_deck_pdf", kind: "app-action", callers: "render", route: "/api/pdf", switch: "PDF_EXPORTS", priceLabel: "Free", kinds: ["treatment", "pitch", "ppm"] });
  expect(PDF_TOOL.price()).toEqual({ credits: 0, label: "Free" });
  expect(PDF_TOOL.mock).toBe("tests/unit/remotionWorkerFake.ts");
  expect(pdfToolAvailability({})).toEqual({ available: false, reason: "Deck PDFs are not switched on for this deployment." });
  expect(pdfToolAvailability({ PDF_EXPORTS: "on" }).available).toBe(false);
  const missing = pdfToolAvailability({ PDF_EXPORTS: "1" });
  expect(missing.available).toBe(false);
  expect(missing.reason).toContain("REMOTION_WORKER_URLS");
  const secret = "s".repeat(40);
  expect(pdfToolAvailability({ PDF_EXPORTS: "1", REMOTION_WORKER_URLS: "http://remotion-1:8790", REMOTION_WORKER_SECRETS: secret })).toEqual({ available: true, reason: null });
  expect(JSON.stringify(missing)).not.toContain(secret);
});

test("an outside agent over MCP: the tool is not offered unless the workspace has deck PDFs, and calling it is one POST to the same route, free", async () => {
  const { TOOLS, toolsOffered, runTool, PDF_TOOLS } = await import("../../lib/mcp");
  expect(toolsOffered({})).toEqual(TOOLS);
  expect(toolsOffered({}, { pdf: false }).map((t) => t.name)).not.toContain("make_deck_pdf");
  expect(toolsOffered({}, { pdf: true }).map((t) => t.name)).toEqual([...TOOLS.map((t) => t.name), "make_deck_pdf"]);
  expect(PDF_TOOLS.map((t) => t.name)).toEqual(["make_deck_pdf"]);
  const calls: { path: string; init: { method?: string; body?: unknown } }[] = [];
  const call = (async (pathname: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path: pathname, init });
    return { deck: { url: "/api/uploads/pdf_abc", filename: "deck_pitch.pdf", pages: 3, bytes: 20480 } };
  }) as never;
  const args = { kind: "pitch", pitch: { sections: [{ heading: "Idea", paragraphs: ["Words."] }] } };
  // Where the workspace has no deck PDFs the tool is unknown, as get_export is when exports are off, and nothing is called.
  await expect(runTool("make_deck_pdf", args as never, call, "https://app.test")).rejects.toThrow("Unknown tool: make_deck_pdf");
  await expect(runTool("make_deck_pdf", args as never, call, "https://app.test", {}, { pdf: false })).rejects.toThrow("Unknown tool: make_deck_pdf");
  expect(calls).toEqual([]);
  const text = await runTool("make_deck_pdf", args as never, call, "https://app.test", {}, { pdf: true });
  expect(calls).toEqual([{ path: "/api/pdf", init: { method: "POST", body: args } }]);
  expect(text).toContain("deck_pitch.pdf · 3 pages");
  expect(text).toContain("https://app.test/api/uploads/pdf_abc");
  expect(text).toContain("price: Free (0 cr)");
  const described = JSON.stringify(PDF_TOOLS);
  expect(described).toContain("Free");
  expect(described).not.toMatch(/\bcredits? (?!it costs no)\d|\$\d|REMOTION_|secret/i);
});

/* ---- the route ---- */

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
async function route(options: { allowed?: boolean; make?: (...a: unknown[]) => Promise<unknown>; refuse?: boolean } = {}) {
  const log: string[] = [];
  const contract = await import("../../lib/pdf/contract");
  const mod = loadRoute<{ GET: Handler; POST: Handler }>("app/api/pdf/route.ts", {
    zod,
    "@/lib/auth": {
      withTenant: <T>(handler: T) => handler,
      requireRender: async () => { log.push("requireRender"); return options.refuse ? { response: Response.json({ error: "A token that prepares cannot render." }, { status: 403 }) } : { user: { id: "u_owner", role: "member" } }; },
    },
    "@/lib/tenant": { currentTenant: () => ({ workspace: { id: "ws_x" } }) },
    "@/lib/requestBody": { readBoundedText: async (req: Request) => { log.push("readBody"); return req.text(); } },
    "@/lib/demo/spend-guard.server": { sampleWorkspaceOff: async () => { log.push("sampleWorkspaceOff"); return null; } },
    "@/lib/pdf/contract": contract,
    "@/lib/pdf/switch": { pdfAllowedFor: async () => { log.push("allowed?"); return options.allowed ?? false; } },
    "@/lib/pdf/run": { makeDeckPdf: async (...a: unknown[]) => { log.push("makeDeckPdf"); return options.make ? options.make(...a) : { uploadId: "pdf_1", url: "/api/uploads/pdf_1", filename: "x_pitch.pdf", mime: "application/pdf", bytes: 100, pages: 2, kind: "pitch", price: { credits: 0, label: "Free" } }; } },
  });
  return { mod, log };
}
const post = (body: unknown) => new Request("https://app.test/api/pdf", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const pitch = { kind: "pitch", pitch: { sections: [{ heading: "Idea", paragraphs: ["Words."] }] } };

test("off, the route answers 404 before the session, the body or anything else is touched", async () => {
  const { mod, log } = await route({ allowed: false });
  for (const response of [await mod.GET(new Request("https://app.test/api/pdf")), await mod.POST(post(pitch))]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
  }
  expect(log.filter((line) => line !== "allowed?")).toEqual([]);
});

test("on, a deck is made through the same gate every caller uses, free; a bad request is 400, a refusal passes through, a failure says nothing about itself", async () => {
  const ok = await route({ allowed: true });
  const made = await ok.mod.POST(post(pitch));
  expect(made.status).toBe(200);
  expect((await made.json()).deck).toMatchObject({ pages: 2, price: { credits: 0, label: "Free" } });
  expect(made.headers.get("cache-control")).toBe("private, no-store");
  expect(ok.log).toEqual(["allowed?", "requireRender", "readBody", "sampleWorkspaceOff", "makeDeckPdf"]);
  const gate = await route({ allowed: true, refuse: true });
  expect((await gate.mod.POST(post(pitch))).status).toBe(403);
  expect(gate.log).toEqual(["allowed?", "requireRender"]);
  const bad = await route({ allowed: true });
  const bodies = ["not json", {}, { kind: "treatise" }, { ...pitch, price: 5 }, { ...pitch, page: "poster" }, { ...pitch, bleedMm: 7 }, { kind: "pitch", images: [{ upload: "a", take: "b" }] }, { kind: "pitch", images: [{ upload: "../x" }] }, { kind: "pitch", images: Array.from({ length: 25 }, (_, i) => ({ upload: `u${i}` })) }, { kind: "pitch", logo: { take: "t" } }, { kind: "pitch", pitch: { sections: [] } }];
  for (const body of bodies) expect((await bad.mod.POST(post(body))).status, JSON.stringify(body)).toBe(400);
  expect(bad.log.includes("makeDeckPdf")).toBe(false);
  const { PdfError } = await import("../../lib/pdf/contract");
  const busy = await route({ allowed: true, make: async () => { throw new PdfError("Every export worker is busy. Try again in a minute.", 429, 30); } });
  const response = await busy.mod.POST(post(pitch));
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("30");
  const broken = await route({ allowed: true, make: async () => { throw new Error("secret database detail"); } });
  const failed = await broken.mod.POST(post(pitch));
  expect(failed.status).toBe(500);
  expect(JSON.stringify(await failed.json())).toBe(JSON.stringify({ error: "The PDF could not be made. Nothing billed." }));
});

/* ---- making a deck ---- */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const pictures = { async load(handle: { upload?: string; take?: string }) { if (handle.upload === "u_missing") { const { PdfError } = await import("../../lib/pdf/contract"); throw new PdfError("That upload isn't available in this workspace.", 404); } return PNG; } };

async function context(name: string, run: (m: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace(name), async () => run(await setup(name)));
}
async function setup(name: string) {
  const { db, ready } = await import("../../lib/db");
  const { platformReady } = await import("../../lib/platform");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const { upsertTreatment } = await import("../../lib/atomikDocs");
  const draft = await import("../../lib/draftProject");
  await platformReady(); await ready(); await workbenchReady();
  const ws = workspace(name);
  const client = db();
  const board = draft.mappedId("prj_wb_", ws.id, "u_owner", "d1");
  await client.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [board, "Private board"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod_open','Ordinary production',0)", args: [] });
  const body = { ...newProject("d1"), id: "d1", name: "The board", productionProjectId: board, script: "INT. ROOM\n\nAna waits.", production: { beats: { scriptSha256: "x", updatedAt: "", scenes: [{ id: "s1", heading: "INT. ROOM", summary: "", beats: [], characters: [], locations: ["Room"], props: ["Lamp"], shots: [{ id: "a", description: "d", framing: "Wide", movement: "Push", lighting: "Soft", sound: "Hum", duration: 4 }] }] } } };
  await client.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify(body)] });
  for (const [id, role] of [["u_owner", "member"], ["u_mate", "member"]]) await client.execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,0)", args: [id, `${id}@example.test`, id, "x", role] });
  await upsertTreatment({ projectId: "prod_open", ideaId: null, title: "Night Shift", logline: "A courier.", setup: { format: "Short" }, scenes: [{ n: 1, title: "Dock", secs: 5, prose: "Rain." }], notes: [], updatedBy: "Owner", bump: false, onCreate: undefined } as never);
  const pool = exportWorkerPool();
  const deps = (extra: Record<string, unknown> = {}) => ({ config: pool.config, fetch: pool.fetch, pictures, now: () => new Date(Date.UTC(2026, 9, 15)), ...extra });
  const { makeDeckPdf } = await import("../../lib/pdf/run");
  const uploads = async () => (await client.execute("SELECT id,filename,mime,kind,uploader_id,bytes FROM uploads")).rows;
  return { makeDeckPdf, pool, deps, uploads, client, ws };
}

test("a pitch deck is made: the page and its pictures go to the worker, the worker's one fixed command prints it, and the PDF is kept as the caller's own upload", async () => {
  await context("make", async ({ makeDeckPdf, pool, deps, uploads }) => {
    const { liveSlots } = await import("../../lib/worker-slots");
    const request = { kind: "pitch" as const, title: "Brand film", pitch: { logline: "One idea.", audience: "For a client", sections: [{ heading: "The idea", paragraphs: ["Short."] }, { heading: "Why", bullets: ["a", "b"] }] }, images: [{ upload: "u_1", caption: "Mood" }], logo: { upload: "u_logo" }, page: "a4" as const, bleedMm: 3 as const };
    const deck = await makeDeckPdf(request, OWNER, deps());
    expect(deck).toMatchObject({ mime: "application/pdf", kind: "pitch", pages: 4, filename: "brand-film_pitch.pdf", price: { credits: 0, label: "Free" }, url: `/api/uploads/${deck.uploadId}` });
    // What was sent: the spec, one page, two pictures (the logo and the picture), nothing else.
    const sent = pool.calls.filter((c) => c.method === "PUT").map((c) => c.query);
    expect(sent).toEqual(["/vercel/sandbox/remotion/spec.json", "/vercel/sandbox/remotion/input/deck.html", "/vercel/sandbox/remotion/input/i1.png", "/vercel/sandbox/remotion/input/i2.png"]);
    const body = (suffix: string) => pool.calls.find((c) => c.method === "PUT" && c.query?.endsWith(suffix))!.body!.toString();
    const spec = JSON.parse(body("spec.json"));
    expect(spec).toEqual({ version: 1, composition: "pdf", pdf: { pages: 4, trimMm: { width: 297, height: 210 }, bleedMm: 3, images: ["i1.png", "i2.png"] } });
    const html = body("deck.html");
    expect(html).not.toMatch(/<script|<iframe|<link|http:|https:/i);
    expect(html).toContain("Brand film");
    // The command is exactly the worker's one fixed command (the stand-in refuses anything else), and the session was stopped.
    const run = pool.calls.find((c) => c.path.endsWith("/run"))!;
    expect(JSON.parse(run.body!.toString())).toMatchObject({ cmd: "/usr/local/bin/node", args: ["/opt/remotion/cli.mjs"], cwd: "/vercel/sandbox/remotion" });
    expect(pool.running()).toEqual([]);
    // It is the caller's upload, free, and the worker slot is back.
    const rows = await uploads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: deck.uploadId, mime: "application/pdf", kind: "document", uploader_id: "u_owner" });
    expect(await liveSlots()).toEqual([]);
  });
});

test("a treatment and a PPM deck are read from the caller's own workspace; a production or board that is not theirs is exactly as if it did not exist", async () => {
  await context("read", async ({ makeDeckPdf, deps, pool }) => {
    const treatment = await makeDeckPdf({ kind: "treatment", projectId: "prod_open" }, OWNER, deps());
    expect(treatment).toMatchObject({ kind: "treatment", filename: "night-shift_treatment.pdf" });
    const specOf = () => JSON.parse(pool.calls.filter((c) => c.method === "PUT" && c.query?.endsWith("spec.json")).at(-1)!.body!.toString());
    expect(specOf().pdf).toMatchObject({ pages: 3, trimMm: { width: 338.667, height: 190.5 } });
    const ppm = await makeDeckPdf({ kind: "ppm", board: "d1" }, OWNER, deps());
    expect(ppm).toMatchObject({ kind: "ppm" });
    expect(specOf().pdf).toMatchObject({ trimMm: { width: 297, height: 210 } });
    // A teammate has no such board; a production with no treatment, and one that is not there, are the same answer.
    await expect(makeDeckPdf({ kind: "ppm", board: "d1" }, MATE, deps())).rejects.toMatchObject({ status: 404 });
    await expect(makeDeckPdf({ kind: "ppm", board: "nope" }, OWNER, deps())).rejects.toMatchObject({ status: 404 });
    await expect(makeDeckPdf({ kind: "treatment", projectId: "prod_nope" }, OWNER, deps())).rejects.toMatchObject({ status: 404 });
    const { mappedId } = await import("../../lib/draftProject");
    await expect(makeDeckPdf({ kind: "treatment", projectId: mappedId("prj_wb_", "ws_read", "u_owner", "d1") }, MATE, deps())).rejects.toMatchObject({ status: 404 });
    await expect(makeDeckPdf({ kind: "treatment" }, OWNER, deps())).rejects.toMatchObject({ status: 400 });
    await expect(makeDeckPdf({ kind: "pitch" }, OWNER, deps())).rejects.toMatchObject({ status: 400 });
  });
});

test("a deck from one workspace never reads another's: the same ids in a second workspace are simply not found", async () => {
  await context("tenant-a", async ({ makeDeckPdf, deps }) => { await makeDeckPdf({ kind: "ppm", board: "d1" }, OWNER, deps()); });
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("tenant-b"), async () => {
    const { db, ready } = await import("../../lib/db");
    const { workbenchReady } = await import("../../lib/workbench/records");
    await ready(); await workbenchReady();
    const pool = exportWorkerPool();
    const { makeDeckPdf } = await import("../../lib/pdf/run");
    await expect(makeDeckPdf({ kind: "ppm", board: "d1" }, OWNER, { config: pool.config, fetch: pool.fetch, pictures })).rejects.toMatchObject({ status: 404 });
    expect(pool.calls).toEqual([]);
    expect((await db().execute("SELECT COUNT(*) AS n FROM uploads")).rows[0].n).toBe(0);
  });
});

test("a failed print says what happened in plain words and that nothing was billed, keeps nothing, and stops the session", async () => {
  await context("fail", async ({ makeDeckPdf, pool, deps, uploads }) => {
    const request = { kind: "pitch" as const, pitch: { sections: [{ heading: "Idea", paragraphs: ["Words."] }] } };
    pool.behave({ exitCode: 4, result: { ok: false, code: "render_failed", errors: ["/vercel/sandbox/remotion/work chrome crashed secret-detail"] } });
    const failed = await makeDeckPdf(request, OWNER, deps()).catch((e) => e);
    expect(failed).toMatchObject({ status: 502 });
    expect(failed.message).toBe("The deck could not be printed. Nothing billed.");
    expect(failed.message).not.toContain("secret-detail");
    pool.behave({ pdf: Buffer.from("<html>not a pdf</html>") });
    expect(await makeDeckPdf(request, OWNER, deps()).catch((e) => e)).toMatchObject({ status: 502, message: "The PDF could not be made. Nothing billed." });
    pool.behave({ pdf: fakePdf(9, 338.667, 190.5) });
    expect(await makeDeckPdf(request, OWNER, deps()).catch((e) => e)).toMatchObject({ status: 502 });
    pool.behave({ pdf: null });
    expect(await makeDeckPdf(request, OWNER, deps()).catch((e) => e)).toMatchObject({ status: 502 });
    expect(await uploads()).toEqual([]);
    expect(pool.running()).toEqual([]);
    // Busy, unreachable and unconfigured workers each end as the right thing.
    pool.behave({});
    pool.set("http://remotion-1:8790", "busy");
    expect(await makeDeckPdf(request, OWNER, deps()).catch((e) => e)).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    pool.set("http://remotion-1:8790", "refuse");
    expect(await makeDeckPdf(request, OWNER, deps()).catch((e) => e)).toMatchObject({ status: 503 });
    pool.set("http://remotion-1:8790", "down");
    expect(await makeDeckPdf(request, OWNER, deps()).catch((e) => e)).toMatchObject({ status: 502 });
    expect(await makeDeckPdf(request, OWNER, deps({ config: null })).catch((e) => e)).toMatchObject({ status: 503 });
    // No slot free: nothing is sent at all.
    pool.set("http://remotion-1:8790", "free");
    const before = pool.calls.length;
    expect(await makeDeckPdf(request, OWNER, deps({ slot: { acquire: async () => null, release: async () => {} } })).catch((e) => e)).toMatchObject({ status: 429 });
    expect(pool.calls.length).toBe(before);
    // A picture the caller cannot reach stops the deck before any worker is asked.
    expect(await makeDeckPdf({ ...request, images: [{ upload: "u_missing" }] }, OWNER, deps()).catch((e) => e)).toMatchObject({ status: 404 });
    expect(pool.calls.length).toBe(before);
    // A deck of more than 60 pages is refused, not cut.
    const long = { kind: "pitch" as const, pitch: { sections: Array.from({ length: 14 }, (_, i) => ({ heading: `S${i}`, paragraphs: Array.from({ length: 12 }, () => "w ".repeat(890)) })) } };
    expect(await makeDeckPdf(long, OWNER, deps()).catch((e) => e)).toMatchObject({ status: 413 });
    expect(pool.calls.length).toBe(before);
  });
});

test("pictures are bound by what their bytes are, and an id the caller cannot reach answers like one that does not exist", async () => {
  const { bindPictures, workspacePictures } = await import("../../lib/pdf/images");
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
  const bytes: Record<string, Buffer> = { a: PNG, b: JPG, c: Buffer.from("GIF89a....."), big: Buffer.alloc(0) };
  const source = { async load(handle: { upload?: string; take?: string }) { return bytes[handle.upload ?? handle.take!]; } };
  const bound = await bindPictures({ logo: { upload: "a" }, images: [{ upload: "b", caption: "Two" }, { take: "a" }] }, OWNER, source);
  expect(bound.files.map((f) => f.name)).toEqual(["i1.png", "i2.jpg", "i3.png"]);
  expect(bound.logo).toBe("i1.png");
  expect(bound.pictures).toEqual([{ file: "i2.jpg", caption: "Two" }, { file: "i3.png", caption: "" }]);
  await expect(bindPictures({ images: [{ upload: "c" }] }, OWNER, source)).rejects.toMatchObject({ status: 415 });
  // The real source, in a real workspace: a private board's take, another person's upload, a video take and a missing id are all "not available".
  await context("pictures", async ({ client, ws }) => {
    const { mappedId } = await import("../../lib/draftProject");
    const board = mappedId("prj_wb_", ws.id, "u_owner", "d1");
    const take = (id: string, kind: string, project: string | null) => client.execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by,project_id,stored_url,bytes) VALUES(?,?,?,?,?,1,1,?,0,'u_owner',?,'/stored/x.png',1000)", args: [id, "m", "p", "{}", "succeeded", kind, project] });
    await take("take_private", "image", board); await take("take_video", "video", "prod_open");
    await client.execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,uploader_id) VALUES('up_owner','a.png','image/png','png',1000,'x',NULL,NULL,'/stored/u.png',1,'image','u_owner')", args: [] });
    for (const handle of [{ take: "take_private" }, { take: "take_video" }, { take: "nope" }, { upload: "up_owner" }, { upload: "nope" }]) {
      await expect(workspacePictures.load(handle, MATE, 20_000_000), JSON.stringify(handle)).rejects.toMatchObject({ status: 404 });
    }
    await expect(workspacePictures.load({ upload: "up_owner" }, { id: "u_other" }, 20_000_000)).rejects.toMatchObject({ status: 404 });
  });
});
