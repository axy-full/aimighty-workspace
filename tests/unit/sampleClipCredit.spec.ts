import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { loadRouteModule } from "../helpers/vendorCostScan";

/**
 * The starter production's sample clip (Big Buck Bunny, (c) Blender Foundation, CC BY 3.0: lib/sampleClip.ts) carries its credit wherever the clip shows or leaves in a
 * file (owner, 15 Oct 2026). The clip reaches a workspace only as the starter's FALLBACK picture, when the platform's neutral previews are not published; a starter on
 * the published previews has none. These specs seed the real starter in a real workspace database, and check the credit's data and every export path that can include it:
 * the read the screens use, the selects (CSV and the zip's CREDITS.txt), the takes CSV, the workspace export, the movie export's metadata and the review links.
 * Nothing is rendered or sent; every outbound request fails the test.
 */
const dir = mkdtempSync(path.join(tmpdir(), "sample-clip-credit-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "sample-clip-credit-unit-keyring-not-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const originalFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

const LINE = "Big Buck Bunny © Blender Foundation, CC BY 3.0";
const LICENCE = "https://creativecommons.org/licenses/by/3.0/";
const SOURCE = "https://peach.blender.org/";
const owner = { id: "owner", email: "owner@example.test", name: "Owner", role: "owner", owner: true, disabled: false, lastSeen: null, createdAt: 0 } as unknown as TenantUser;

async function workspace(name: string): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  await platformReady();
  const id = `bbb-${name}-${Date.now().toString(36)}`;
  await platformDb().execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,plan_id) VALUES(?,?,?,?,1,'owner',0,0,NULL)`,
    args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`],
  });
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}
async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, { user: owner });
}
/** A route file as it ships, signed in as the owner of `ws` (auth stubbed, everything else real). */
async function route<T>(file: string, ws: TenantWorkspace): Promise<T> {
  const auth = await import("../../lib/auth");
  const { runInTenant } = await import("../../lib/tenant");
  type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
  return loadRouteModule<T>(file, {
    "@/lib/auth": { ...auth, withTenant: (fn: Handler) => (req: Request, ctx?: unknown) => runInTenant(ws, () => fn(req, ctx), { user: owner }), requireUser: async () => ({ user: owner }), requireOwner: async () => ({ user: owner }) },
  });
}
/** The first few chunks of a zip response, as text: its first entry's name and, if it is a text file, its words (stored, not compressed). The stream is dropped after that. */
async function readFirstEntry(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const parts: Buffer[] = [];
  try { for (let i = 0; i < 3; i++) { const next = await reader.read(); if (next.done) break; parts.push(Buffer.from(next.value)); } } catch { /* a stream that fails after its first entries is still read up to there */ }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(parts).toString("utf8");
}
/** The starter, seeded for real (its fallback pictures, as no platform preview is published here), with the starter's own takes returned. */
async function seeded(ws: TenantWorkspace) {
  return inTenant(ws, async () => {
    const { seedStarterProduction } = await import("../../lib/starter");
    const { db } = await import("../../lib/db");
    const made = await seedStarterProduction("owner");
    const takes = (await db().execute({ sql: "SELECT id, stored_url, review_state FROM generations WHERE project_id = ? ORDER BY created_at", args: [made!.projectId] })).rows;
    return { projectId: made!.projectId, ids: takes.map((r) => String(r.id)), approved: takes.filter((r) => r.review_state === "approved").map((r) => String(r.id)), urls: takes.map((r) => String(r.stored_url)) };
  });
}
/** What a published platform preview does to a take: its picture is the platform's neutral preview, which carries no credit. */
async function publishPreviews(ws: TenantWorkspace) {
  await inTenant(ws, async () => { const { db } = await import("../../lib/db"); await db().execute("UPDATE generations SET stored_url = '/api/platform/previews/move-pan'"); });
}

test("the client-safe constant is the URL the starter's seed writes, and the credit's client files import nothing that reaches the vendor rate tables", async () => {
  const { SAMPLE_CLIP_URL } = await import("../../lib/sampleClip");
  const { DEMO_FIXTURE_CLIP_URL } = await import("../../lib/demoProduction");
  expect(SAMPLE_CLIP_URL).toBe(DEMO_FIXTURE_CLIP_URL);
  const { readFileSync } = await import("node:fs");
  for (const file of ["lib/sampleClip.ts", "lib/useSampleClip.ts", "components/ui/SampleClipCredit.tsx"]) {
    const imports = [...readFileSync(file, "utf8").matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.filter((i) => /demoProduction|vendorRates|vendorPricing|credit(s|Terms)|models|platformLayer|starter$/.test(i)), `${file} imports`).toEqual([]);
  }
});

test("only the fallback clip carries the credit: the URL the seed writes decides, and a published platform preview has none", async () => {
  const { demoMediaUrl } = await import("../../lib/demoProduction");
  const { isSampleClipUrl, SAMPLE_CLIP_CREDIT, SAMPLE_CLIP_CREDIT_TEXT, sampleClipNotice } = await import("../../lib/sampleClip");
  expect(isSampleClipUrl(demoMediaUrl("move-pan", new Set()))).toBe(true);
  expect(isSampleClipUrl(demoMediaUrl("move-pan", new Set(["move-pan"])))).toBe(false);
  for (const other of [null, undefined, "", "/api/media/gen_1", "/fixtures/clip-6s.mp4", "/api/platform/previews/move-pan"]) expect(isSampleClipUrl(other)).toBe(false);
  expect(SAMPLE_CLIP_CREDIT.line).toBe(LINE);
  expect(SAMPLE_CLIP_CREDIT.licenceUrl).toBe(LICENCE);
  expect(SAMPLE_CLIP_CREDIT.sourceUrl).toBe(SOURCE);
  expect(SAMPLE_CLIP_CREDIT_TEXT).toBe(`${LINE} (${LICENCE}; source ${SOURCE})`);
  expect(sampleClipNotice(["a", "b"])).toEqual({ notice: LINE, licence: "CC BY 3.0", licenceUrl: LICENCE, sourceUrl: SOURCE, takes: ["a", "b"] });
});

test("the read the screens use names every fallback take of the starter, and none once the platform previews are published", async () => {
  const ws = await workspace("read");
  const starter = await seeded(ws);
  expect(starter.urls.every((u) => u === "/fixtures/clip.mp4")).toBe(true);
  const { GET } = await route<{ GET: (req: Request) => Promise<Response> }>("app/api/sample-clip/route.ts", ws);
  const body = (await (await GET(new Request("https://studio.test/api/sample-clip"))).json()) as { takes: string[]; credit: string };
  expect(body.credit).toBe(LINE);
  expect(body.takes.sort()).toEqual([...starter.ids].sort());
  await publishPreviews(ws);
  expect(((await (await GET(new Request("https://studio.test/api/sample-clip"))).json()) as { takes: string[] }).takes).toEqual([]);
  /* A workspace with no starter has none either. */
  const bare = await workspace("bare");
  const other = await route<{ GET: (req: Request) => Promise<Response> }>("app/api/sample-clip/route.ts", bare);
  expect(((await (await other.GET(new Request("https://studio.test/api/sample-clip"))).json()) as { takes: string[] }).takes).toEqual([]);
});

test("the starter's board draft carries the credit on the assets that are the clip, so a movie export of them can", async () => {
  const ws = await workspace("draft");
  await seeded(ws);
  await inTenant(ws, async () => {
    const { readStarterSource, starterDraft } = await import("../../lib/workbench/starter-draft");
    const { starterProductionId } = await import("../../lib/starter");
    const source = (await readStarterSource((await starterProductionId())!))!;
    expect(source.takes.length).toBeGreaterThan(0);
    expect(source.takes.every((t) => t.sampleClip === true)).toBe(true);
    const { project } = starterDraft("draft-1", source, new Date(0).toISOString());
    expect(project.assets.length).toBeGreaterThan(0);
    expect(project.assets.every((a) => a.sampleClip === true)).toBe(true);
    /* Saved as a draft, the flag survives the schema (an unknown key would be stripped). */
    const { projectSchema } = await import("../../lib/workbench/studio-schema");
    const parsed = projectSchema.parse(JSON.parse(JSON.stringify(project)));
    expect(parsed.assets.every((a) => a.sampleClip === true)).toBe(true);
  });
  await publishPreviews(ws);
  await inTenant(ws, async () => {
    const { readStarterSource, starterDraft } = await import("../../lib/workbench/starter-draft");
    const { starterProductionId } = await import("../../lib/starter");
    const { project } = starterDraft("draft-2", (await readStarterSource((await starterProductionId())!))!, new Date(0).toISOString());
    expect(project.assets.some((a) => a.sampleClip)).toBe(false);
  });
});

test("the movie export's own metadata carries the credit when a clip in the cut is the sample clip, and says only what it always says otherwise", async () => {
  const { movieComment, MOVIE_COMMENT } = await import("../../lib/sampleClip");
  expect(movieComment([{ asset: {} }, { asset: { sampleClip: true } }])).toBe(`${MOVIE_COMMENT} ${LINE} (${LICENCE}; source ${SOURCE})`);
  expect(movieComment([{ asset: {} }])).toBe(MOVIE_COMMENT);
  expect(movieComment([])).toBe(MOVIE_COMMENT);
});

test("the takes CSV and the workspace export carry the credit with the fallback clip, and are exactly as they were without it", async () => {
  const ws = await workspace("export");
  const starter = await seeded(ws);
  await inTenant(ws, async () => {
    const { exportRows, takesCsv } = await import("../../lib/exportRows");
    const { rows, unit } = await exportRows();
    const csv = takesCsv(rows, unit);
    expect(rows.length).toBe(starter.ids.length);
    expect(rows.every((r) => r.credit?.startsWith(LINE))).toBe(true);
    const [head, first] = csv.split("\r\n");
    expect(head.split(",").at(-1)).toBe("credit");
    expect(first).toContain(LICENCE);
    const { workspaceExport } = await import("../../lib/workspaceExport");
    const whole = (await workspaceExport("owner", "owner@example.test")) as unknown as { credits?: { notice: string; licenceUrl: string; sourceUrl: string; takes: string[] }[] };
    expect(whole.credits).toEqual([{ notice: LINE, licence: "CC BY 3.0", licenceUrl: LICENCE, sourceUrl: SOURCE, takes: expect.arrayContaining(starter.ids) }]);
  });
  await publishPreviews(ws);
  await inTenant(ws, async () => {
    const { exportRows, takesCsv } = await import("../../lib/exportRows");
    const { rows, unit } = await exportRows();
    expect(rows.some((r) => r.credit)).toBe(false);
    expect(takesCsv(rows, unit).split("\r\n")[0].split(",").includes("credit")).toBe(false);
    const { workspaceExport } = await import("../../lib/workspaceExport");
    expect("credits" in ((await workspaceExport("owner", "owner@example.test")) as object)).toBe(false);
  });
});

test("the selects: the CSV has a credit column and the zip leads with CREDITS.txt for the fallback clip; with the previews published neither changes", async () => {
  const ws = await workspace("selects");
  const starter = await seeded(ws);
  expect(starter.approved.length).toBeGreaterThan(0);
  const { GET } = await route<{ GET: (req: Request) => Promise<Response> }>("app/api/export/selects/route.ts", ws);
  const get = (format: string) => GET(new Request(`https://studio.test/api/export/selects?projectId=${starter.projectId}&format=${format}`));
  const csv = await (await get("csv")).text();
  const [head, ...lines] = csv.trim().split("\r\n");
  expect(head.split(",").at(-1)).toBe("credit");
  expect(lines.length).toBe(starter.approved.length);
  expect(lines.every((l) => l.includes(LICENCE) && l.includes(SOURCE))).toBe(true);
  /* The zip's first entry is CREDITS.txt, whatever else it holds (the stream is read only as far as its first entry). */
  const zip = await get("zip");
  const text = await readFirstEntry(zip);
  expect(text).toContain("CREDITS.txt");
  expect(text).toContain(LINE);
  expect(text).toContain(LICENCE);
  expect(text).toContain(SOURCE);
  await publishPreviews(ws);
  const plain = await (await get("csv")).text();
  expect(plain.split("\r\n")[0].split(",").includes("credit")).toBe(false);
  expect(plain.includes("creativecommons")).toBe(false);
  expect((await readFirstEntry(await get("zip"))).includes("CREDITS.txt")).toBe(false);
});

test("a review link carries the credit for a take that is the sample clip, and nothing for any other", async () => {
  const ws = await workspace("review");
  const starter = await seeded(ws);
  await inTenant(ws, async () => {
    const { reviewSet } = await import("../../lib/security/review-link");
    const set = (await reviewSet("tok", "share-1", starter.projectId))!;
    expect(set.takes.length).toBeGreaterThan(0);
    expect(set.takes.every((t) => t.credit === true)).toBe(true);
  });
  await publishPreviews(ws);
  await inTenant(ws, async () => {
    const { reviewSet } = await import("../../lib/security/review-link");
    expect((await reviewSet("tok", "share-1", starter.projectId))!.takes.some((t) => t.credit)).toBe(false);
  });
});

test("the Download package carries CREDITS.txt when a collected asset is the sample clip: by its flag, or by the server's list of takes (a starter made before the flag)", async () => {
  const { seedProject } = await import("../../lib/workbench/studio");
  const { buildExportPackage } = await import("../../lib/workbench/studio-export");
  const { SAMPLE_CLIP_CREDITS_FILE, isSampleClipAsset } = await import("../../lib/sampleClip");
  const { strFromU8 } = await import("fflate");
  const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const fetchAsset = async () => new Response(bytes, { headers: { "Content-Type": "image/webp" } });
  const credited = async (mutate: (p: ReturnType<typeof seedProject>) => void, sampleTakes?: ReadonlySet<string>) => {
    const project = seedProject();
    mutate(project);
    const files = await buildExportPackage(project, fetchAsset, { sampleTakes });
    return files["CREDITS.txt"] ? strFromU8(files["CREDITS.txt"]) : null;
  };
  // Nothing is the clip: no file, and the package is as it was.
  expect(await credited(() => {})).toBeNull();
  expect(await credited(() => {}, new Set(["gen_other"]))).toBeNull();
  // The draft says so.
  expect(await credited((p) => { p.assets[0].sampleClip = true; })).toBe(SAMPLE_CLIP_CREDITS_FILE);
  // The draft is older than the flag: the server's list of takes holding the clip decides.
  expect(await credited((p) => { p.assets[0].generationId = "gen_clip"; }, new Set(["gen_clip"]))).toBe(SAMPLE_CLIP_CREDITS_FILE);
  expect(await credited((p) => { p.assets[0].generationId = "gen_clip"; }, new Set(["gen_other"]))).toBeNull();
  expect(isSampleClipAsset({ generationId: "gen_clip" }, new Set(["gen_clip"]))).toBe(true);
  expect(isSampleClipAsset({ generationId: "gen_clip" }, null)).toBe(false);
  expect(isSampleClipAsset({}, new Set(["gen_clip"]))).toBe(false);
});

test("the movie comment credits a clip the server lists, with or without the draft's flag", async () => {
  const { movieComment, MOVIE_COMMENT, SAMPLE_CLIP_CREDIT_TEXT } = await import("../../lib/sampleClip");
  const clips = [{ asset: { generationId: "gen_clip" } }, { asset: { generationId: "gen_x" } }];
  expect(movieComment(clips)).toBe(MOVIE_COMMENT);
  expect(movieComment(clips, new Set(["gen_other"]))).toBe(MOVIE_COMMENT);
  expect(movieComment(clips, new Set(["gen_clip"]))).toBe(`${MOVIE_COMMENT} ${SAMPLE_CLIP_CREDIT_TEXT}`);
  expect(movieComment([{ asset: { sampleClip: true as const } }])).toContain(SAMPLE_CLIP_CREDIT_TEXT);
});

test("the credit's style is tokens only, and each of its links is a 44 px target on a phone", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync("components/ui/sample-clip-credit.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|hsl\(|oklch\(|accent/i);
  const phone = /@media \(max-width: 899px\), \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  expect(phone).toMatch(/\.sample-credit a \{[^}]*min-height: 44px/);
});
