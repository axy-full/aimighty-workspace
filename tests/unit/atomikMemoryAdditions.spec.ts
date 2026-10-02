import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import type { CatalogModel } from "../../lib/catalog";
import type { TextRun } from "../../lib/engines/types";
import { loadRouteModule } from "../helpers/vendorCostScan";

/**
 * What the owner chose for Atomik's memory on 29 Sep, beyond the amounts-only
 * rule (tests/unit/atomikMemoryAmounts.spec.ts):
 *  - anybody may forget an entry, the whole workspace's included — archived,
 *    so it comes back from the archive;
 *  - an approved identity can point at Cast & Elements or a Soul ID, by
 *    reference: Atomik reads the name it has now, and leaves out one that is gone;
 *  - the Business brand kit's lines are picked, and each lands as an ordinary entry;
 *  - Atomik reading a paste is paid: quoted first, run only at the approved
 *    price, charged what it actually cost, its proposals filtered like any
 *    other input, and nothing kept until the person ticks it.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-atomik-memory-2-"));
process.env.PLATFORM_DATABASE_URL ??= `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL ??= `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

function workspace(platformKeys = false): TenantWorkspace {
  const id = `ws_${randomUUID().slice(0, 8)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: platformKeys,
    allowanceUsd: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0 } as TenantWorkspace;
}
const person = (id: string, role: "owner" | "admin" | "member" = "member") =>
  ({ id, email: `${id}@example.test`, name: id, role, owner: role === "owner", disabled: false, lastSeen: null, createdAt: 0 }) as TenantUser;
async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>, user?: TenantUser): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, user ? { user } : {});
}
/** A row with the given values and a placeholder in every other required column. */
async function insertRow(table: string, values: Record<string, unknown>) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  const required = (await db().execute(`PRAGMA table_info(${table})`)).rows
    .filter((c) => Number(c.notnull) && c.dflt_value == null && !Number(c.pk) && !(String(c.name) in values));
  const row = { ...Object.fromEntries(required.map((c) => [String(c.name), /INT|REAL|NUM/i.test(String(c.type)) ? 0 : "x"])), ...values };
  await db().execute({ sql: `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`, args: Object.values(row) as never[] });
}
const production = (id: string) => insertRow("projects", { id, name: `Production ${id}`, created_at: Date.now() });
/** A person's saved draft of a production, holding its Cast & Elements (and anything else given). */
async function draft(owner: string, projectId: string, productionId: string, extra: Record<string, unknown> = {}) {
  const { db } = await import("../../lib/db");
  const body = JSON.stringify({ id: projectId, name: "Draft", productionProjectId: productionId, ...extra });
  await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body", args: [`${owner}:${projectId}`, owner, projectId, "Draft", body, Date.now()] });
}
const cast = (...entries: { id: string; name: string; kind: "character" | "element" }[]) => ({ production: { cast: { entries: entries.map((e) => ({ ...e, description: "", prompt: "", takes: [] })) } } });
/** A Soul ID as training leaves it: ready once settled. */
async function soul(id: string, owner: string, productionId: string | null, fields: { name?: string; status?: string; settled?: boolean } = {}) {
  const { db } = await import("../../lib/db");
  await (await import("../../lib/soulIdentities")).soulIdentitiesReady();
  await db().execute({
    sql: `INSERT INTO soul_identities(id,owner,production_project_id,name,description,subject_type,references_json,status,credential_fingerprint,settled_at,created_at,updated_at,consent_at,provider_origin,model_version)
          VALUES(?,?,?,?,'','character','[]',?,'fp',?,1,1,1,'api-v1','v1')`,
    args: [id, owner, productionId, fields.name ?? `Identity ${id}`, fields.status ?? "ready", fields.settled === false ? null : 1],
  });
}
async function archived(reason?: string) {
  const { db } = await import("../../lib/db");
  await (await import("../../lib/archive")).archiveReady();
  const rs = await db().execute({ sql: `SELECT * FROM archived_rows WHERE table_name = 'atomik_memory'${reason ? " AND reason = ?" : ""} ORDER BY archived_at`, args: reason ? [reason] : [] });
  return rs.rows.map((r) => ({ rowId: String(r.row_id), by: r.archived_by == null ? null : String(r.archived_by), body: JSON.parse(String(r.body)) as Record<string, unknown> }));
}
type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
/** A route file as it ships, signed in as `user` in `ws` (auth stubbed, everything else real). */
async function route<T>(file: string, ws: TenantWorkspace, user: TenantUser, extra: Record<string, unknown> = {}, token?: unknown): Promise<T> {
  const auth = await import("../../lib/auth");
  const { runInTenant } = await import("../../lib/tenant");
  return loadRouteModule<T>(file, {
    "@/lib/auth": { ...auth,
      withTenant: (fn: Handler) => (req: Request, ctx?: unknown) => runInTenant(ws, () => fn(req, ctx), { user, ...(token ? { token } : {}) } as never),
      requireSession: async () => (token ? { response: Response.json({ error: "API tokens cannot." }, { status: 403 }) } : { user }),
      requireRender: async () => ({ user, ...(token ? { token } : {}) }),
      requireUser: async () => ({ user }) },
    ...extra,
  });
}
const scopeOf = (ws: TenantWorkspace, user: TenantUser) => ({ "X-Workbench-Scope": `particl-active-${ws.id}-${user.id}` });

/* ── Anybody may forget ──────────────────────────────────────────────── */

test("anybody may forget an entry, the whole workspace's included: a member forgets what the owner kept, and the archive keeps it", async () => {
  const m = await import("../../lib/atomikMemory");
  const ws = workspace();
  const owner = person("u_owner", "owner"), member = person("u_member", "member"), other = person("u_other", "member");
  const [teamwide, second] = await inTenant(ws, async () => [
    await m.addMemory({ kind: "brand", text: "Teal and sand, the whole workspace." }, owner.id),
    await m.addMemory({ kind: "note", text: "End every spot on the board." }, owner.id),
  ], owner);
  /* Through the routes a member uses: the page's forget, and the row's own. */
  const memory = await route<{ POST: Handler }>("app/api/atomik/memory/route.ts", ws, member);
  const forgot = await memory.POST(new Request("https://studio.test/api/atomik/memory", { method: "POST", headers: { "Content-Type": "application/json", ...scopeOf(ws, member) }, body: JSON.stringify({ action: "forget", ids: [teamwide.id] }) }));
  expect(forgot.status).toBe(200);
  expect(await forgot.json()).toEqual({ forgotten: 1 });
  const one = await route<{ DELETE: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> }>("app/api/atomik/memory/[id]/route.ts", ws, other);
  const gone = await one.DELETE(new Request(`https://studio.test/api/atomik/memory/${second.id}`, { method: "DELETE", headers: scopeOf(ws, other) }), { params: Promise.resolve({ id: second.id }) });
  expect(await gone.json()).toEqual({ forgotten: 1 });
  await inTenant(ws, async () => {
    expect(await m.listMemory(null, owner.id)).toEqual([]);
    /* Archived, never erased: the whole row, and who forgot it. */
    const kept = await archived("forgotten");
    expect(kept.map((a) => [a.rowId, a.by])).toEqual([[teamwide.id, member.id], [second.id, other.id]]);
    expect(kept[0].body).toMatchObject({ id: teamwide.id, project_id: null, created_by: owner.id, text: "Teal and sand, the whole workspace." });
  });
});

/* ── Approved identities from Cast & Elements ────────────────────────── */

test("an approved identity points at Cast & Elements or a Soul ID by reference: the name it has now is read, and one that is gone is left out", async () => {
  const m = await import("../../lib/atomikMemory");
  const { castRef, soulRef } = await import("../../lib/atomikMemoryText");
  await inTenant(workspace(), async () => {
    await production("prod_a"); await production("prod_b");
    await draft("u1", "draft-a", "prod_a", cast({ id: "cast-maya", name: "Maya", kind: "character" }, { id: "cast-board", name: "The red board", kind: "element" }));
    await soul("soul_maya", "u1", "prod_a", { name: "Maya (Soul ID)" });
    await soul("soul_training", "u1", "prod_a", { settled: false });
    await soul("soul_elsewhere", "u2", "prod_b");

    const maya = await m.addMemory({ kind: "identity", text: "The approved lead.", assetId: castRef("prod_a", "cast-maya"), projectId: "prod_a" }, "u1");
    expect(maya).toMatchObject({ kind: "identity", assetId: "cast:prod_a:cast-maya", assetLabel: "Maya", assetKind: "character", text: "The approved lead.", projectId: "prod_a" });
    const board = await m.addMemory({ kind: "identity", text: "", assetId: castRef("prod_a", "cast-board") }, "u1");
    expect(board).toMatchObject({ assetLabel: "The red board", assetKind: "element", projectId: null });
    const faceId = await m.addMemory({ kind: "identity", text: "The face of the spring campaign.", assetId: soulRef("soul_maya") }, "u1");
    expect(faceId).toMatchObject({ assetId: "soul:soul_maya", assetLabel: "Maya (Soul ID)", assetKind: "Soul ID" });

    /* A reference, not a copy: the row holds the element's id and the words a person wrote, nothing of the element itself. */
    const { db } = await import("../../lib/db");
    const row = (await db().execute({ sql: "SELECT * FROM atomik_memory WHERE id = ?", args: [maya.id] })).rows[0];
    expect([row.asset_id, row.text]).toEqual(["cast:prod_a:cast-maya", "The approved lead."]);

    /* Refused: another kind, an element not in this person's own Cast & Elements, a Soul ID still training or out of reach, an unknown reference. */
    await expect(m.addMemory({ kind: "brand", text: "x", assetId: soulRef("soul_maya") }, "u1")).rejects.toMatchObject({ status: 400, message: "Only an approved identity points at a Soul ID or at Cast & Elements." });
    await expect(m.addMemory({ kind: "identity", text: "", assetId: castRef("prod_a", "cast-nobody") }, "u1")).rejects.toMatchObject({ status: 404 });
    await expect(m.addMemory({ kind: "identity", text: "", assetId: castRef("prod_a", "cast-maya") }, "u2")).rejects.toMatchObject({ status: 404 });
    await expect(m.addMemory({ kind: "identity", text: "", assetId: castRef("prod_none", "cast-maya") }, "u1")).rejects.toMatchObject({ status: 404 });
    await expect(m.addMemory({ kind: "identity", text: "", assetId: soulRef("soul_training") }, "u1")).rejects.toMatchObject({ status: 409, message: "That Soul ID is still training. Keep it once it is ready." });
    await expect(m.addMemory({ kind: "identity", text: "", assetId: soulRef("soul_elsewhere") }, "u1")).rejects.toMatchObject({ status: 404 });
    await expect(m.addMemory({ kind: "identity", text: "", assetId: "element:whatever" }, "u1")).rejects.toMatchObject({ status: 400 });

    /* Renamed where it lives: memory shows, and the planner reads, the name it has now. */
    await draft("u1", "draft-a", "prod_a", cast({ id: "cast-maya", name: "Maya Okafor", kind: "character" }, { id: "cast-board", name: "The red board", kind: "element" }));
    await db().execute("UPDATE soul_identities SET name = 'Maya, approved' WHERE id = 'soul_maya'");
    const listed = await m.listMemory("prod_a", "u1");
    expect(listed.find((e) => e.id === maya.id)).toMatchObject({ assetLabel: "Maya Okafor", available: true });
    expect(listed.find((e) => e.id === faceId.id)).toMatchObject({ assetLabel: "Maya, approved", available: true });
    const planned = await m.plannerMemory({ projectId: "prod_a", query: "Maya walks the harbour" });
    expect(planned.filter((i) => i.kind === "identity").map((i) => i.asset)).toEqual(expect.arrayContaining([{ name: "Maya Okafor", kind: "character" }, { name: "Maya, approved", kind: "Soul ID" }, { name: "The red board", kind: "element" }]));
    expect(await m.plannerMemoryText({ projectId: "prod_a", query: "Maya" })).toContain('- Approved identity (this project): "Maya Okafor" (character) — The approved lead.');

    /* Gone from Cast & Elements, or the Soul ID gone: shown as gone, and left out of every plan. */
    await draft("u1", "draft-a", "prod_a", cast({ id: "cast-board", name: "The red board", kind: "element" }));
    await db().execute("UPDATE soul_identities SET purged_at = 1 WHERE id = 'soul_maya'");
    const after = await m.listMemory("prod_a", "u1");
    expect(after.find((e) => e.id === maya.id)).toMatchObject({ available: false, assetLabel: "Maya" });
    expect(after.find((e) => e.id === faceId.id)).toMatchObject({ available: false });
    expect((await m.plannerMemory({ projectId: "prod_a", query: "Maya" })).map((i) => i.asset?.name)).toEqual(["The red board"]);
    /* Its words can still be edited, against what it was saved with. */
    expect(await m.updateMemory(maya.id, { text: "The approved lead, until the recast." }, "u2")).toMatchObject({ assetId: "cast:prod_a:cast-maya", text: "The approved lead, until the recast." });
  });
});

/* ── The Business brand kit ──────────────────────────────────────────── */

test("the brand kit's lines are offered to pick; each picked line lands as an ordinary entry, and the agent still reads the kit itself", async () => {
  const m = await import("../../lib/atomikMemory");
  const { brandKitPicks } = await import("../../lib/atomikMemoryText");
  const moleculr = {
    productName: "", productUrl: "", productAssetIds: [], castAssetIds: [], format: "poster" as const, hooks: [], notes: "", variants: [],
    brandKit: { name: "Driftline", tagline: "Ride the light", voice: "Warm, dry humour. Never salesy. A premium price point, said plainly.", audience: "Skaters, 16 to 24, in coastal towns.",
      colors: ["#0fa3a3", "#e8d9b5"], font: "system" as const, description: "A skate brand from the coast. Boards from $120. Hand-shaped in Goa.", fontFamilies: ["Inter"], website: "https://driftline.example", logoAssetId: "asset-logo" },
    products: [
      { id: "p1", name: "Wave Runner", url: "", description: "Breathable knit upper. Retails at $120.", brand: "Driftline", assetIds: [] },
      { id: "p2", name: "Gift card", url: "", description: "$50.", brand: "", assetIds: [] },
    ],
  };
  const picks = brandKitPicks(moleculr, (id) => (id === "asset-logo" ? "upload:up_logo" : null));
  expect(picks.map((p) => [p.key, p.kind, p.text, p.leftOut, p.refused])).toEqual([
    ["name", "brand", "Brand name: Driftline.", 0, null],
    ["tagline", "brand", "Tagline: Ride the light", 0, null],
    ["voice", "brand", "Brand voice: Warm, dry humour. Never salesy. A premium price point, said plainly.", 0, null],
    ["about", "brand", "About Driftline: A skate brand from the coast. Hand-shaped in Goa.", 1, null],
    ["palette", "brand", "Brand palette: #0FA3A3, #E8D9B5.", 0, null],
    ["type", "brand", "Typography: Inter.", 0, null],
    ["website", "brand", "Website: https://driftline.example", 0, null],
    ["audience", "audience", "Skaters, 16 to 24, in coastal towns.", 0, null],
    ["product:p1", "note", "Product: Wave Runner — Breathable knit upper.", 1, null],
    ["product:p2", "note", "Product: Gift card — $50.", 0, "$50"],
    ["logo", "reference", "The brand's logo.", 0, null],
  ]);
  expect(picks.find((p) => p.key === "logo")?.assetId).toBe("upload:up_logo");
  /* A kit with nothing in it offers nothing; products alone (the older single-product fields) still offer their line. */
  expect(brandKitPicks(null)).toEqual([]);
  expect(brandKitPicks({ productName: "Night Deck", productDescription: "Glows after dark." }).map((p) => p.text)).toEqual(["Product: Night Deck — Glows after dark."]);

  await inTenant(workspace(), async () => {
    await production("prod_k");
    await insertRow("uploads", { id: "up_logo", filename: "Driftline logo.png", mime: "image/png", ext: "png", bytes: 1, sha256: "b".repeat(64), stored_url: "https://blob.example/up_logo", created_at: Date.now() });
    const chosen = ["name", "voice", "palette", "audience", "product:p1", "logo"].map((key) => picks.find((p) => p.key === key)!);
    const items = chosen.map((p) => ({ kind: p.kind, text: p.text, ...(p.assetId ? { assetId: p.assetId } : {}) }));
    /* Nothing is kept until the person picks. */
    expect(await m.listMemory("prod_k", "u1")).toEqual([]);
    const made = await m.keepMemory({ items, projectId: "prod_k", from: "brand-kit" }, "u1");
    expect(made.skipped).toEqual({ money: 0, duplicates: 0, beyondLimit: 0, invalid: 0 });
    expect(made.entries.map((e) => [e.kind, e.text, e.status, e.source, e.origin, e.acceptedBy, e.projectId])).toEqual(items.map((i) => [i.kind, i.text, "active", "person", "brand-kit", "u1", "prod_k"]));
    expect(made.entries.at(-1)).toMatchObject({ kind: "reference", assetId: "upload:up_logo", assetLabel: "Driftline logo.png" });
    /* A line with an amount is refused on the server too, the same lines again are kept once, and a refused one does not stop the rest. */
    const again = await m.keepMemory({ items: [...items.slice(0, 2), { kind: "note", text: picks.find((p) => p.key === "product:p2")!.text }, { kind: "note", text: "Hand-shaped in Goa." }], projectId: "prod_k", from: "brand-kit" }, "u2");
    expect(again.skipped).toEqual({ money: 1, duplicates: 2, beyondLimit: 0, invalid: 0 });
    expect(again.entries.map((e) => e.text)).toEqual(["Hand-shaped in Goa."]);
    /* Ordinary entries: the planner reads them like any other. */
    expect((await m.plannerMemory({ projectId: "prod_k", query: "a skate spot" })).map((i) => i.text)).toEqual(expect.arrayContaining(["Brand name: Driftline.", "Skaters, 16 to 24, in coastal towns."]));
    /* Refused before anything is kept: where they came from unsaid, nothing ticked, too many, a project not in this workspace. */
    await expect(m.keepMemory({ items, from: "somewhere" }, "u1")).rejects.toMatchObject({ status: 400 });
    await expect(m.keepMemory({ items: [], from: "brand-kit" }, "u1")).rejects.toMatchObject({ status: 400 });
    await expect(m.keepMemory({ items: Array.from({ length: m.KEEP_LIMIT + 1 }, (_, i) => ({ kind: "note", text: `Line ${i}` })), from: "brand-kit" }, "u1")).rejects.toMatchObject({ status: 413 });
    await expect(m.keepMemory({ items, projectId: "prod_nope", from: "brand-kit" }, "u1")).rejects.toMatchObject({ status: 404 });
    expect((await m.listMemory("prod_k", "u1")).length).toBe(made.entries.length + 1);
  });

  /* The workbench agent still reads the kit itself, as before. */
  const server = await import("../../lib/workbench/atomik-server");
  const { seedProject } = await import("../../lib/workbench/studio");
  const project = { ...seedProject(), moleculr };
  const context = JSON.parse(server.atomikContext(project, server.atomikRequestSchema.parse({ projectId: "p", requestId: randomUUID(), request: "Plan the launch", suite: "moleculr" })));
  expect(context.project.campaign.brandKit).toMatchObject({ name: "Driftline", voice: moleculr.brandKit.voice, audience: moleculr.brandKit.audience });
});

/* ── Atomik reads a paste: paid, priced first, kept only when ticked ─── */

const READER: CatalogModel = { id: "anthropic/claude-sonnet-4.6", name: "Reader", owner: "anthropic", type: "language", description: "", contextWindow: 200000, maxTokens: 8192,
  pricing: { input: "0.00003", output: "0.00015" } };
const PASTE = ["- Brand colours are teal and warm sand", "- Our audience is skaters in coastal towns", "- Packs are $49 each", "- A premium price point, never discount-led", "- Always end on the board"].join("\n");
/** A provider's reply: the proposals as `content`, at `cost`. */
const replyWith = (content: string, cost = 0.01) => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content } }], usage: { cost, prompt_tokens: 900, completion_tokens: 120 } }) });
async function withCredits<T>(fn: (ws: TenantWorkspace) => Promise<T>, credits = 5000): Promise<T> {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const ws = workspace(true);
  await platformReady();
  const { creditUsd } = await import("../../lib/creditTerms");
  /* In today's credits, saying so (unit_usd): a grant row without one is a legacy US$0.10 grant. */
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at,unit_usd) VALUES(?,?,?,'manual',0,?)", args: [`grant_${ws.id}`, ws.id, credits, creditUsd()] });
  return inTenant(ws, () => fn(ws), person("u_reader"));
}
async function meterOf(workspaceId: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT id,status,engine_cost_usd,billed_credits FROM meter_events WHERE workspace_id = ? ORDER BY created_at", args: [workspaceId] })).rows;
}

test("the paid read is quoted first, runs only at the approved price, is charged what it cost, and keeps nothing until the person ticks", async () => {
  const m = await import("../../lib/atomikMemory");
  const read = await import("../../lib/atomikMemoryRead");
  const { db } = await import("../../lib/db");
  const { fromDeci, isCreditAmount, toDeci } = await import("../../lib/creditTerms");
  await withCredits(async (ws) => {
    /* The quote: an approximate price in credits (whole tenths), and nothing claimed, reserved or sent. */
    const quote = await read.quoteMemoryRead({ text: PASTE, model: READER.id }, READER);
    expect(quote).toMatchObject({ model: READER.id });
    expect(isCreditAmount(quote.estimateCredits) && quote.estimateCredits > 0.1).toBe(true);
    expect(await meterOf(ws.id)).toEqual([]);
    if ((await db().execute("SELECT name FROM sqlite_master WHERE name = 'paid_text_jobs'")).rows.length)
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM paid_text_jobs")).rows[0].n)).toBe(0);

    /* An approval below the price now asked is refused before anything is reserved or sent. */
    let calls = 0;
    const submit = async (request: TextRun) => {
      calls++;
      /* The read is reserved before it is sent. */
      expect((await meterOf(ws.id)).at(-1)?.status).toBe("running");
      const body = JSON.parse(request.body) as { model: string; messages: { role: string; content: string }[] };
      expect(body.model).toBe(READER.id);
      expect(body.messages[0].content).toContain("Never include an amount of money");
      expect(body.messages[1].content).toContain("<<<TEXT\n- Brand colours are teal and warm sand");
      /* A careless model: one amount, one duplicate, one kind it made up, one reference (which needs an asset). */
      return replyWith(JSON.stringify({ entries: [
        { kind: "brand", text: "Brand colours are teal and warm sand" }, { kind: "audience", text: "Our audience is skaters in coastal towns" },
        { kind: "note", text: "Packs are $49 each" }, { kind: "brand", text: "A premium price point, never discount-led" },
        { kind: "rule", text: "Always end on the board" }, { kind: "brand", text: "brand colours are teal and warm sand" }, { kind: "reference", text: "The hero still" },
      ] }));
    };
    await expect(read.runMemoryRead({ text: PASTE, model: READER.id, maxCredits: fromDeci(toDeci(quote.estimateCredits) - 1), projectId: null, createdBy: "u_reader" }, { model: READER, submit }))
      .rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(0);
    expect(await meterOf(ws.id)).toEqual([]);

    /* At the approved price: sent once, and charged what it actually cost, not the estimate. */
    const done = await read.runMemoryRead({ text: PASTE, model: READER.id, maxCredits: quote.estimateCredits, projectId: null, createdBy: "u_reader" }, { model: READER, submit });
    expect(calls).toBe(1);
    expect(done.read.entries).toEqual([
      { kind: "brand", text: "Brand colours are teal and warm sand" }, { kind: "audience", text: "Our audience is skaters in coastal towns" },
      { kind: "brand", text: "A premium price point, never discount-led" }, { kind: "note", text: "Always end on the board" }, { kind: "note", text: "The hero still" },
    ]);
    expect(done.read.skipped).toEqual({ money: 1, duplicates: 1, beyondLimit: 0, invalid: 0 });
    const [event] = await meterOf(ws.id);
    expect(event).toMatchObject({ id: done.id, status: "succeeded" });
    expect(Number(event.engine_cost_usd)).toBeCloseTo(0.01, 6);
    expect(Number(event.billed_credits)).toBe(done.credits);
    /* In whole tenths, never below the 0.1 credit minimum. */
    expect(isCreditAmount(done.credits) && done.credits >= 0.1).toBe(true);
    expect(done.credits).toBeLessThan(quote.estimateCredits);
    const job = (await db().execute({ sql: "SELECT kind,status,cost_usd FROM paid_text_jobs WHERE id = ?", args: [done.id] })).rows[0];
    expect([job.kind, job.status, Number(job.cost_usd)]).toEqual(["memory", "succeeded", 0.01]);

    /* Nothing was kept — not even as a suggestion — until the person ticks. */
    expect(await m.listMemory(null, "u_reader")).toEqual([]);
    const ticked = [done.read.entries[0], done.read.entries[2]];
    /* Ticked proposals are checked again on the way in: an amount slipped back in is refused, a reference without an asset too. */
    const kept = await m.keepMemory({ items: [...ticked, { kind: "note", text: "Packs are $49 each" }, { kind: "reference", text: "The hero still" }], from: "atomik-read" }, "u_reader");
    expect(kept.skipped).toEqual({ money: 1, duplicates: 0, beyondLimit: 0, invalid: 1 });
    expect(kept.entries.map((e) => [e.kind, e.text, e.status, e.source, e.origin])).toEqual([
      ["brand", "Brand colours are teal and warm sand", "active", "import", "atomik-read"],
      ["brand", "A premium price point, never discount-led", "active", "import", "atomik-read"],
    ]);
    expect((await m.listMemory(null, "u_reader")).length).toBe(2);
  });
});

test("a read that answers with nothing to keep is refused and charges nothing; one never runs twice under its id", async () => {
  const read = await import("../../lib/atomikMemoryRead");
  await withCredits(async (ws) => {
    const quote = await read.quoteMemoryRead({ text: PASTE, model: READER.id }, READER);
    const run = (id: string, content: string) => read.runMemoryRead({ id, text: PASTE, model: READER.id, maxCredits: quote.estimateCredits, projectId: null, createdBy: "u_reader" }, { model: READER, submit: async () => replyWith(content) });
    await expect(run("text_memory_prose", "Here is what I found: teal and sand.")).rejects.toThrow("Atomik answered, but not with entries to review. Nothing was charged.");
    await expect(run("text_memory_amounts", JSON.stringify({ entries: [{ kind: "note", text: "Packs are $49" }, { kind: "note", text: "A 30% markup" }] }))).rejects.toThrow("Atomik found nothing in this text that memory can keep. Nothing was charged.");
    const events = await meterOf(ws.id);
    expect(events.map((e) => [e.id, e.status, Number(e.billed_credits)])).toEqual([["text_memory_prose", "failed", 0], ["text_memory_amounts", "failed", 0]]);
    /* An id that already has a paid claim is never sent again. */
    await expect(run("text_memory_prose", JSON.stringify({ entries: [{ kind: "brand", text: "Teal" }] }))).rejects.toThrow("already has a paid claim");
    await expect(read.runMemoryRead({ text: "", model: READER.id, maxCredits: 5, projectId: null, createdBy: "u" }, { model: READER })).rejects.toMatchObject({ status: 400 });
    expect(() => read.readText("x".repeat(20_001))).toThrow("at most 20,000 characters");
  });
});

test("the read route: Atomik's models only, the approved price required, a lost reply recovered without a second read, and API tokens refused", async () => {
  const read = await import("../../lib/atomikMemoryRead");
  const { selectAtomikModel } = await import("../../lib/atomikModelPolicy");
  const { engineFor } = await import("../../lib/engines");
  const { PaidTextError } = await import("../../lib/paidText");
  const available = [READER.id, "google/gemini-3.1-pro-preview", "openai/gpt-5.5", "meta/llama-4"];
  let sent = 0;
  const extra = {
    /* lib/atomik › resolveModel, against a fixed catalogue: Atomik's model policy decides, as it does in the route. */
    "@/lib/atomik": { resolveModel: async (want: string) => { try { return selectAtomikModel(want, available); } catch (error) { throw new PaidTextError((error as Error).message, 400); } } },
    /* The real read, priced on a fixed model and answered by the mock engine (ENGINE_MOCK=1): no provider is called. */
    "@/lib/atomikMemoryRead": { ...read,
      quoteMemoryRead: (input: { text: string; model: string }) => read.quoteMemoryRead(input, { ...READER, id: input.model }),
      runMemoryRead: (input: Parameters<typeof read.runMemoryRead>[0]) => read.runMemoryRead(input, { model: { ...READER, id: input.model }, submit: (request) => { sent++; return engineFor("vercel").run!(request); } }) },
  };
  await withCredits(async (ws) => {
    const user = person("u_reader");
    const memory = await route<{ POST: Handler }>("app/api/atomik/memory/read/route.ts", ws, user, extra);
    const post = (body: unknown, headers: Record<string, string> = {}) => memory.POST(new Request("https://studio.test/api/atomik/memory/read", { method: "POST", headers: { "Content-Type": "application/json", ...scopeOf(ws, user), ...headers }, body: JSON.stringify(body) }));

    /* The quote is credits only for a workspace on credits. */
    const quoted = await post({ text: PASTE, quoteOnly: true });
    expect(quoted.status).toBe(200);
    const quote = (await quoted.json()) as { model: string; estimateCredits: number; estimateUsd?: number };
    expect(quote.model).toBe(READER.id);
    expect(quote.estimateUsd).toBeUndefined();
    /* Claude, OpenAI or Grok only: Gemini and any other family are refused with the reason. */
    expect((await (await post({ text: PASTE, model: "google/gemini-3.1-pro-preview", quoteOnly: true })).json()).error).toContain("no longer offered in Atomik");
    expect((await post({ text: PASTE, model: "meta/llama-4", quoteOnly: true })).status).toBe(400);
    expect((await (await post({ text: PASTE, model: "openai/gpt-5.5", quoteOnly: true })).json()).model).toBe("openai/gpt-5.5");
    /* Never without the approved price. */
    const unpriced = await post({ text: PASTE, model: quote.model }, { "Idempotency-Key": "memory-read-unpriced" });
    expect(unpriced.status).toBe(409);
    expect((await unpriced.json()).error).toBe("Review the price before Atomik reads this.");
    expect(sent).toBe(0);

    /* The read, on the mock model: every line proposed, the amount left out by the server, nothing kept. */
    const body = { text: PASTE, model: quote.model, maxCredits: quote.estimateCredits };
    const first = await post(body, { "Idempotency-Key": "memory-read-once" });
    expect(first.status).toBe(200);
    const answer = (await first.json()) as { id: string; entries: { kind: string; text: string }[]; skipped: { money: number }; credits: number | null };
    expect(answer.entries.map((e) => e.text)).toEqual(["Brand colours are teal and warm sand", "Our audience is skaters in coastal towns", "A premium price point, never discount-led", "Always end on the board"]);
    expect(answer.skipped.money).toBe(1);
    expect(answer.credits).toBeGreaterThanOrEqual(0.1);
    expect(sent).toBe(1);
    /* The reply was lost: the same request under its key answers the same, and is not read or charged again. */
    const again = await post(body, { "Idempotency-Key": "memory-read-once" });
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(answer);
    expect(sent).toBe(1);
    expect((await meterOf(ws.id)).length).toBe(1);
    expect(await (await import("../../lib/atomikMemory")).listMemory(null, user.id)).toEqual([]);

    /* A body past one paste is refused before anything is read, quoted or claimed; so is text past the paste limit. */
    expect((await post({ text: "x".repeat(120_000), quoteOnly: true })).status).toBe(413);
    expect((await post({ text: "x".repeat(20_001), quoteOnly: true })).status).toBe(413);
    expect((await post({ text: "   ", quoteOnly: true })).status).toBe(400);
    expect(sent).toBe(1);

    /* An API token neither quotes nor reads into memory. */
    const tokened = await route<{ POST: Handler }>("app/api/atomik/memory/read/route.ts", ws, user, extra, { id: "tok_1", scope: "render", name: "CI" });
    const refused = await tokened.POST(new Request("https://studio.test/api/atomik/memory/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: PASTE, quoteOnly: true }) }));
    expect(refused.status).toBe(403);
  });
});
