import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { exportWorkerPool } from "./remotionWorkerFake";

/**
 * The film deck (lib/pdf/builders.ts › filmDoc; make_deck_pdf kind "film"): one deck from a board, with a quiet Treatment cover or a
 * bold Pitch cover over the same pages. Real temporary databases, the worker in memory; no browser, no network, nothing spent.
 */
const directory = mkdtempSync(path.join(tmpdir(), "pdf-film-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null } as unknown as TenantWorkspace);
const OWNER = { id: "u_owner", role: "member" }, MATE = { id: "u_mate", role: "member" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const HINDI_TITLE = "मानसून";

async function context(name: string, run: (m: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace(name), async () => run(await setup(name)));
}
async function setup(name: string) {
  const { db, ready } = await import("../../lib/db");
  const { platformReady } = await import("../../lib/platform");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  await platformReady(); await ready(); await workbenchReady();
  const client = db();
  const shot = (id: string, framing: string, description: string) => ({ id, description, framing, movement: "Held", lighting: "", sound: "", duration: 3 });
  const body = {
    ...newProject("Monsoon"), id: "d1", name: "Monsoon", brief: "A courier crosses the city in the first rain.", audience: "A streaming studio", deliverables: "A 30 s film", direction: "Warm, wet, close.", aspect: "16:9", fps: 30,
    script: "EXT. STREET - NIGHT\n\nRain. A courier waits.", boardLanguages: ["hi"],
    nodes: [{ id: "n1", title: "Courier", type: "character", refKind: "cast", x: 0, y: 0, width: 254, linked: [] }, { id: "n2", title: "The street", type: "element", refKind: "environment", x: 0, y: 0, width: 254, linked: [] }],
    production: {
      beats: { scriptSha256: "x", updatedAt: "", scenes: [{ id: "s1", heading: "EXT. STREET - NIGHT", summary: "", beats: [], characters: ["Courier"], locations: ["The street"], props: [], shots: [shot("a", "Wide", "Rain on the street."), shot("b", "Close-up", "The courier looks up."), shot("c", "Medium", "She starts to run.")] }] },
      boards: { style: "live", model: "m", frames: {
        a: { prompt: "p", takes: [{ genId: "img_a", style: "live", at: "" }] },
        b: { prompt: "p", takes: [{ genId: "img_b_old", style: "live", at: "" }, { genId: "img_b", style: "live", at: "" }] },
        c: { prompt: "p", takes: [{ genId: "img_hidden", style: "live", at: "" }] },
      } },
    },
  };
  await client.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify(body)] });
  const loaded: string[] = [];
  const pictures = { async load(handle: { upload?: string; take?: string }) {
    loaded.push(handle.take ?? handle.upload ?? "");
    if (handle.take === "img_hidden") { const { PdfError } = await import("../../lib/pdf/contract"); throw new PdfError("That take isn't available in this workspace.", 404); }
    return PNG;
  } };
  const pool = exportWorkerPool();
  const deps = () => ({ config: pool.config, fetch: pool.fetch, pictures, now: () => new Date(Date.UTC(2026, 9, 16)) });
  const { makeDeckPdf } = await import("../../lib/pdf/run");
  const sent = (suffix: string) => pool.calls.filter((c) => c.method === "PUT" && c.query?.endsWith(suffix)).at(-1)!.body!.toString();
  return { makeDeckPdf, deps, pool, sent, loaded };
}

test("one deck, two covers: the Treatment cover is quiet, the Pitch cover is bold, and every page after the cover is the same", async () => {
  await context("film-covers", async ({ makeDeckPdf, deps, sent }) => {
    const treatment = await makeDeckPdf({ kind: "film", board: "d1" }, OWNER, deps());
    const treatmentHtml = sent("deck.html");
    const pitch = await makeDeckPdf({ kind: "film", board: "d1", cover: "pitch" }, OWNER, deps());
    const pitchHtml = sent("deck.html");
    expect(treatment).toMatchObject({ kind: "film", filename: "monsoon_film.pdf", price: { credits: 0, label: "Free" }, mime: "application/pdf" });
    expect(pitch.pages).toBe(treatment.pages);
    expect(treatmentHtml).toContain('class="page cover treatment"');
    expect(treatmentHtml).toContain('<p class="eyebrow">Treatment</p>');
    expect(pitchHtml).toContain('class="page cover pitch"');
    expect(pitchHtml).toContain('<p class="eyebrow">Pitch deck</p>');
    expect(pitchHtml).toContain("A streaming studio");
    expect(treatmentHtml).toContain("3 shots");
    /* Past the cover the deck is the same: the idea, the brief, the script, cast, places, the pictures, the shot list. */
    const after = (html: string) => html.slice(html.indexOf("</section>"));
    expect(after(pitchHtml)).toBe(after(treatmentHtml));
    for (const heading of ["The idea", "The brief", "Script", "Cast", "Locations", "Look and storyboard", "Shot list"]) expect(treatmentHtml).toContain(heading);
    expect(treatmentHtml).toContain("English · Hindi");
    expect(treatmentHtml).not.toMatch(/<script|<iframe|<link|http:|https:/i);
  });
});

test("the board's own storyboard comes with it: each frame's latest take, an unreadable one left out, and no more than the deck takes", async () => {
  await context("film-pictures", async ({ makeDeckPdf, deps, sent, loaded, pool }) => {
    await makeDeckPdf({ kind: "film", board: "d1" }, OWNER, deps());
    expect(loaded).toEqual(["img_a", "img_b", "img_hidden"]);
    const spec = JSON.parse(sent("spec.json"));
    expect(spec.pdf.images).toEqual(["i1.png", "i2.png"]);
    expect(pool.calls.filter((c) => c.method === "PUT").map((c) => c.query?.split("/").pop())).toEqual(["spec.json", "deck.html", "i1.png", "i2.png"]);
    expect(sent("deck.html")).toContain("Shot 1.1 · Wide");
    expect(sent("deck.html")).toContain("Shot 1.2 · Close-up");
    /* A picture the caller names that cannot be read is an error, not a gap. */
    const { PdfError } = await import("../../lib/pdf/contract");
    const picky = { async load() { throw new PdfError("That upload isn't available in this workspace.", 404); } };
    await expect(makeDeckPdf({ kind: "film", board: "d1", images: [{ upload: "u_missing" }] }, OWNER, { ...deps(), pictures: picky })).rejects.toMatchObject({ status: 404 });
  });
});

test("the board is the caller's own: anyone else, or a board that is not there, is the same answer; a cover is for film decks only; a film deck needs its board", async () => {
  await context("film-reach", async ({ makeDeckPdf, deps, pool }) => {
    await expect(makeDeckPdf({ kind: "film", board: "d1" }, MATE, deps())).rejects.toMatchObject({ status: 404 });
    await expect(makeDeckPdf({ kind: "film", board: "nope" }, OWNER, deps())).rejects.toMatchObject({ status: 404 });
    await expect(makeDeckPdf({ kind: "film" }, OWNER, deps())).rejects.toMatchObject({ status: 400 });
    await expect(makeDeckPdf({ kind: "ppm", board: "d1", cover: "pitch" }, OWNER, deps())).rejects.toMatchObject({ status: 400 });
    expect(pool.calls).toEqual([]);
  });
});

test("the request takes a cover for a film deck and nothing else new: unknown covers and fields are refused", async () => {
  const { deckRequestSchema } = await import("../../lib/pdf/contract");
  expect(deckRequestSchema.safeParse({ kind: "film", board: "d1", cover: "pitch" }).success).toBe(true);
  expect(deckRequestSchema.safeParse({ kind: "film", board: "d1", cover: "poster" }).success).toBe(false);
  expect(deckRequestSchema.safeParse({ kind: "film", board: "d1", price: 0 }).success).toBe(false);
  expect(deckRequestSchema.safeParse({ kind: "film", board: "../x" }).success).toBe(false);
});

test("a Hindi board prints: the words are kept whole on the cover and the pages, escaped like any other", async () => {
  const { filmDoc } = await import("../../lib/pdf/builders");
  const { deckHtml } = await import("../../lib/pdf/html");
  const { newProject } = await import("../../lib/workbench/studio");
  const doc = filmDoc({ ...newProject(HINDI_TITLE), brief: `${HINDI_TITLE} <b>x</b>` }, { cover: "pitch", date: "16 Oct 2026" });
  const html = deckHtml(doc);
  expect(html).toContain(HINDI_TITLE);
  expect(html).not.toContain("<b>x</b>");
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
});
