import { test, expect } from "@playwright/test";
import { buildRateTable } from "../../lib/rateTable.server";
import { billCredits } from "../../lib/creditTerms";
import { shotCostUsd } from "../../lib/shotCost";
import { ENGINE_MODEL } from "../../lib/shotBuilder";
import { takeCost } from "../../lib/breakdownCost";
import { listEstimate, moneyColumns, takeEstimate, wholeCredits } from "../../lib/shotListCost";
import { publicTextCost } from "../../lib/textRunCost";
import { textCostLabel } from "../../lib/textCostLabel";
import { isOwnMedia } from "../../lib/format";
import { createBoardSaver, reapplyAdditions, type SaveState } from "../../lib/boardSaver";
import { boardUrlFor } from "../../lib/rigCanvasUrl";
import { ADDABLE_KINDS, KINDS, isRunnable } from "../../components/rig/nodes";
import { clearComposeHandoff, generateHrefFor, handoffFits, handoffKey, handoffPrompt, HANDOFF_TTL_MS, readComposeHandoff, writeComposeHandoff } from "../../lib/composeHandoff";
import { shellEntryRedirect, signInHrefFor } from "../../lib/signIn";
import { serverSwitchTarget, workspaceUrlFor } from "../../lib/workspace/switchover";
import { PRIVATE_PATHS, PUBLIC_PATHS, publicPageMetadata, siteOrigin } from "../../lib/site";
import { NEUTRAL_ICON, reviewMetadata } from "../../lib/reviewMetadata";
import robots from "../../app/robots";
import nextConfig from "../../next.config";
import sitemap from "../../app/sitemap";

/* ── Atomik money: estimates are in the workspace's unit, rounded per take ── */

const cr = buildRateTable("cr");
const usd = buildRateTable("usd");

test("a planned shot is estimated at exactly what one take of it will bill, in credits", () => {
  for (const engine of ["seedance", "kling", "nano-banana"] as const) {
    for (const planned of [2, 5, 8, 12]) {
      const vendor = shotCostUsd(engine, planned);
      /* The same number billing will charge — not the vendor's dollars printed as credits. */
      expect(takeEstimate(cr, { planned, engine })).toBe(billCredits(vendor, ENGINE_MODEL[engine]));
      /* A workspace on its own keys is quoted its vendor's dollars. */
      expect(takeEstimate(usd, { planned, engine })).toBeCloseTo(vendor, 9);
    }
  }
});

test("a list of shots sums each take already rounded; type-only shots cost nothing", () => {
  const shots = Array.from({ length: 10 }, () => ({ planned: 3, engine: "seedance" }));
  const each = wholeCredits(takeCost(cr, 3, "seedance"));
  expect(listEstimate(cr, shots)).toBe(each * 10);
  expect(listEstimate(cr, [...shots, { planned: 8, engine: "seedance", kind: "type" }])).toBe(each * 10);
  expect(takeEstimate(cr, { planned: 8, kind: "type" })).toBe(0);
  /* Ten 5s Seedance shots are not "$290.00" and not "29 cr": they are ten times one take. */
  expect(listEstimate(cr, Array.from({ length: 10 }, () => ({ planned: 5, engine: "seedance" })))).toBe(10 * billCredits(shotCostUsd("seedance", 5), ENGINE_MODEL.seedance));
});

test("only a file this app stores is downloaded in a batch; an engine's own URL is not", () => {
  expect(isOwnMedia("/api/media/gen_1")).toBe(true);
  expect(isOwnMedia("https://cdn.engine.example/out.mp4")).toBe(false);
  expect(isOwnMedia(null)).toBe(false);
});

test("the shot list CSV names its money columns in the workspace's unit", () => {
  expect(moneyColumns(cr)).toEqual({ estimate: "estimate_credits", spent: "spent_credits" });
  expect(moneyColumns(usd)).toEqual({ estimate: "estimate_usd", spent: "spent_usd" });
});

test("a finished paid text run is told as the ledger billed it, never as vendor dollars, on credits", () => {
  expect(publicTextCost(true, 0.004, 1, "succeeded")).toEqual({ credits: 1 });
  expect(publicTextCost(true, 0.004, null, "succeeded")).toEqual({ credits: null });
  /* The reservation's figure is the estimate held, not what was billed. */
  expect(publicTextCost(true, 0.004, 2, "running")).toEqual({ credits: null });
  expect(publicTextCost(true, 0.004, 2, null)).toEqual({ credits: null });
  expect("costUsd" in publicTextCost(true, 0.004, 3, "succeeded")).toBe(false);
  expect(publicTextCost(false, 0.004, 1, "succeeded")).toEqual({ costUsd: 0.004 });
});

test("a written idea, scene or shot list shows what was billed: credits on credits, dollars only on own keys", () => {
  const credits = { inCredits: true, price: (n: number) => `${Math.max(1, Math.ceil(n))} cr` };
  const dollars = { inCredits: false, price: (n: number) => `$${n.toFixed(2)}` };
  expect(textCostLabel(credits, { credits: 3 })).toBe("3 cr");
  /* A vendor figure that reaches a credit workspace is never shown, rounded or otherwise. */
  expect(textCostLabel(credits, { costUsd: 0.004 })).toBeNull();
  expect(textCostLabel(credits, { credits: null })).toBeNull();
  expect(textCostLabel(dollars, { costUsd: 0.004 })).toBe("$0.004");
  expect(textCostLabel(dollars, {})).toBeNull();
});

/* ── Rig canvas ──────────────────────────────────────────────────────────── */

test("/rig/canvas/new carries every param but project to the board, so a Library reference arrives", () => {
  expect(boardUrlFor("brd_1", "project=p1&ref=up_9")).toBe("/rig/canvas/brd_1?ref=up_9");
  expect(boardUrlFor("brd_1", "project=p1&shot=sh_2&ref=up_9")).toBe("/rig/canvas/brd_1?shot=sh_2&ref=up_9");
  expect(boardUrlFor("brd_1", "project=p1")).toBe("/rig/canvas/brd_1");
});

test("the add menu offers only nodes a board can run; unrunnable kinds are not offered", () => {
  for (const k of ["edit", "upscale", "audio", "voice", "compare"] as const) {
    expect(ADDABLE_KINDS).not.toContain(k);
    expect(isRunnable(k)).toBe(false);
  }
  for (const k of ["asset", "shot", "prompt", "image", "video", "note"] as const) expect(ADDABLE_KINDS).toContain(k);
  expect(KINDS.filter((k) => isRunnable(k))).toEqual(["image", "video"]);
});

type Put = { body: Record<string, unknown>; resolve: (r: { ok: boolean; status: number; json: () => Promise<unknown> }) => void; reject: (e: Error) => void };
function fakeServer() {
  const puts: Put[] = [];
  const put = (body: string) => new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve, reject) => { puts.push({ body: JSON.parse(body), resolve, reject }); });
  const reply = (i: number, status: number, json: unknown) => puts[i].resolve({ ok: status >= 200 && status < 300, status, json: async () => json });
  return { puts, put, reply };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("autosave keeps one write in flight, sends the newest graph next, and carries the revision forward", async () => {
  const server = fakeServer();
  const states: SaveState["kind"][] = [];
  const saver = createBoardSaver({ put: server.put, baseUpdatedAt: 100, onState: (s) => states.push(s.kind) });
  saver.save({ nodes: [1], wires: [] });
  saver.save({ nodes: [2], wires: [] });
  saver.save({ nodes: [3], wires: [] });
  await tick();
  expect(server.puts).toHaveLength(1);
  expect(server.puts[0].body).toMatchObject({ nodes: [1], baseUpdatedAt: 100 });
  server.reply(0, 200, { board: { updatedAt: 150 } });
  await tick(); await tick();
  /* The middle graph is never sent: the graph is whole and [3] supersedes it. */
  expect(server.puts).toHaveLength(2);
  expect(server.puts[1].body).toMatchObject({ nodes: [3], baseUpdatedAt: 150 });
  server.reply(1, 200, { board: { updatedAt: 151 } });
  await tick(); await tick();
  expect(states.at(-1)).toBe("saved");
  expect(saver.dirty()).toBe(false);
});

test("a failed save keeps its graph and says so; the next edit or retry sends it again", async () => {
  const server = fakeServer();
  const seen: SaveState[] = [];
  const saver = createBoardSaver({ put: server.put, baseUpdatedAt: 5, onState: (s) => seen.push(s) });
  saver.save({ nodes: ["a"], wires: [] });
  await tick();
  server.reply(0, 500, { error: "The database is busy." });
  await tick(); await tick();
  expect(seen.at(-1)).toEqual({ kind: "failed", message: "The database is busy." });
  expect(saver.dirty()).toBe(true);
  saver.retry();
  await tick();
  expect(server.puts).toHaveLength(2);
  expect(server.puts[1].body).toMatchObject({ nodes: ["a"], baseUpdatedAt: 5 });
  server.puts[1].reject(new Error("offline"));
  await tick(); await tick();
  expect(seen.at(-1)).toEqual({ kind: "failed", message: "offline" });
  saver.save({ nodes: ["a", "b"], wires: [] });
  await tick();
  expect(server.puts[2].body).toMatchObject({ nodes: ["a", "b"] });
});

test("a 409 stops the autosave: a teammate's board is never overwritten", async () => {
  const server = fakeServer();
  const seen: SaveState["kind"][] = [];
  const saver = createBoardSaver({ put: server.put, baseUpdatedAt: 9, onState: (s) => seen.push(s.kind) });
  saver.save({ nodes: ["mine"], wires: [] });
  await tick();
  server.reply(0, 409, { error: "Someone else changed this board.", conflict: true });
  await tick(); await tick();
  expect(seen.at(-1)).toBe("conflict");
  saver.save({ nodes: ["mine", "more"], wires: [] });
  saver.retry();
  await tick();
  expect(server.puts).toHaveLength(1);
});

test("a 409 that is not a revision conflict (a referenced upload is gone) is a failed save, not a teammate", async () => {
  const server = fakeServer();
  const seen: SaveState[] = [];
  const saver = createBoardSaver({ put: server.put, baseUpdatedAt: 9, onState: (s) => seen.push(s) });
  saver.save({ nodes: ["ref"], wires: [] });
  await tick();
  server.reply(0, 409, { error: "A referenced upload is no longer available. Remove or replace it before saving." });
  await tick(); await tick();
  expect(seen.at(-1)).toEqual({ kind: "failed", message: "A referenced upload is no longer available. Remove or replace it before saving." });
  /* The person removes the node; the next edit is sent. */
  saver.save({ nodes: [], wires: [] });
  await tick();
  expect(server.puts).toHaveLength(2);
  expect(server.puts[1].body).toMatchObject({ nodes: [], baseUpdatedAt: 9 });
});

test("a write that landed but whose answer was lost is recognised as our own, not a teammate's", async () => {
  const server = fakeServer();
  const seen: SaveState["kind"][] = [];
  const saver = createBoardSaver({ put: server.put, baseUpdatedAt: 10, baseGraph: { nodes: [], wires: [] }, onState: (s) => seen.push(s.kind) });
  const a = { nodes: [{ id: "n1", x: 1 }], wires: [] };
  saver.save(a);
  await tick();
  /* The server committed it at revision 11; the network dropped the reply. */
  server.puts[0].reject(new Error("offline"));
  await tick(); await tick();
  expect(seen.at(-1)).toBe("failed");
  const b = { nodes: [{ id: "n1", x: 1 }, { id: "n2", x: 2 }], wires: [] };
  saver.save(b);
  await tick();
  expect(server.puts[1].body).toMatchObject({ baseUpdatedAt: 10 });
  /* Refused against revision 11 — which holds exactly the graph whose fate was unknown. */
  server.reply(1, 409, { conflict: true, error: "Someone else changed this board.", board: { ...a, updatedAt: 11 } });
  await tick(); await tick();
  expect(seen).not.toContain("conflict");
  expect(server.puts).toHaveLength(3);
  expect(server.puts[2].body).toMatchObject({ nodes: b.nodes, baseUpdatedAt: 11 });
  server.reply(2, 200, { board: { updatedAt: 12 } });
  await tick(); await tick();
  expect(seen.at(-1)).toBe("saved");
  expect(saver.accepted()).toEqual(b);
});

test("a teammate's board that is not our lost write is still a conflict", async () => {
  const server = fakeServer();
  const seen: SaveState["kind"][] = [];
  const saver = createBoardSaver({ put: server.put, baseUpdatedAt: 10, onState: (s) => seen.push(s.kind) });
  saver.save({ nodes: [{ id: "n1" }], wires: [] });
  await tick();
  server.puts[0].reject(new Error("offline"));
  await tick(); await tick();
  saver.retry();
  await tick();
  server.reply(1, 409, { conflict: true, board: { nodes: [{ id: "theirs" }], wires: [], updatedAt: 11 } });
  await tick(); await tick();
  expect(seen.at(-1)).toBe("conflict");
  expect(server.puts).toHaveLength(2);
});

test("after a conflict, reloading keeps the teammate's board and puts back only the nodes this person added", () => {
  const node = (id: string, x = 0) => ({ id, x });
  const wire = (id: string, from: string, to: string, slotId = "image") => ({ id, from: { nodeId: from, portId: "out" }, to: { nodeId: to, slotId } });
  const accepted = { nodes: [node("a"), node("b")], wires: [] };
  /* The teammate moved a and deleted b; this person moved a, added c wired from a, and wired a into b. */
  const server = { nodes: [node("a", 50)], wires: [] as ReturnType<typeof wire>[] };
  const mine = { nodes: [node("a", 9), node("b"), node("c")], wires: [wire("w1", "a", "c"), wire("w2", "a", "b")] };
  const merged = reapplyAdditions(server, mine, accepted);
  expect(merged.nodes).toEqual([node("a", 50), node("c")]);
  expect(merged.wires.map((w) => w.id)).toEqual(["w1"]);
  expect(merged.added).toBe(1);
  /* A wire into a new node whose source the teammate removed does not come back dangling. */
  const orphan = reapplyAdditions({ nodes: [], wires: [] }, { nodes: [node("c")], wires: [wire("w3", "gone", "c")] }, accepted);
  expect(orphan.wires).toEqual([]);
  /* Nothing added: the board is exactly the server's. */
  expect(reapplyAdditions(server, { nodes: [node("a", 9)], wires: [] }, accepted)).toEqual({ ...server, added: 0 });
});

/* ── The shot builder's hand-off to Generate ─────────────────────────────── */

function memoryStore() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
}

test("the builder's subject line and Setup reach Generate once, scoped to one workspace and person", () => {
  expect(handoffPrompt("A courier runs through rain", "Wide shot, eye level")).toBe("A courier runs through rain. Wide shot, eye level.");
  expect(handoffPrompt("She waits.", "")).toBe("She waits.");
  expect(handoffPrompt("", "Close-up")).toBe("Close-up.");
  const store = memoryStore();
  expect(writeComposeHandoff(store, "ws1", "a@x", { prompt: "", kind: "video" })).toBe(false);
  expect(writeComposeHandoff(store, "ws1", "a@x", { prompt: "A courier. Wide shot.", kind: "video" }, 1_000)).toBe(true);
  expect(readComposeHandoff(store, "ws2", "a@x", 2_000)).toBeNull();
  expect(readComposeHandoff(store, "ws1", "b@x", 2_000)).toBeNull();
  expect(readComposeHandoff(store, "ws1", "a@x", 2_000)).toEqual({ prompt: "A courier. Wide shot.", kind: "video", at: 1_000, productionProjectId: null });
  expect(readComposeHandoff(store, "ws1", "a@x", 1_000 + HANDOFF_TTL_MS + 1)).toBeNull();
  clearComposeHandoff(store, "ws1", "a@x");
  expect(store.map.has(handoffKey("ws1", "a@x"))).toBe(false);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  expect(writeComposeHandoff(blocked, "ws1", "a@x", { prompt: "x", kind: "video" })).toBe(false);
  expect(readComposeHandoff(blocked, "ws1", "a@x")).toBeNull();
});

test("a hand-off written for a production opens Generate on that production's project and composes nowhere else", () => {
  const store = memoryStore();
  expect(writeComposeHandoff(store, "ws1", "a@x", { prompt: "A courier.", kind: "video", productionProjectId: "prj_a" }, 1_000)).toBe(true);
  const taken = readComposeHandoff(store, "ws1", "a@x", 2_000)!;
  expect(taken.productionProjectId).toBe("prj_a");
  expect(handoffFits(taken, "prj_a")).toBe(true);
  /* Generate remembered another production's project: the words wait rather than bill there. */
  expect(handoffFits(taken, "prj_b")).toBe(false);
  expect(handoffFits(taken, null)).toBe(false);
  /* Words from the unscoped builder belong to no production. */
  expect(handoffFits({ productionProjectId: null }, "prj_b")).toBe(true);
  expect(generateHrefFor("video", "wb_1")).toBe("/generate?mode=video&project=wb_1");
  expect(generateHrefFor("video", null)).toBe("/generate?mode=video");
  expect(generateHrefFor("image", null)).toBe("/generate?mode=images");
});

/* ── Sign-in and the switch-over ─────────────────────────────────────────── */

test("signing in comes back to the page and its query, not to a bare path", () => {
  expect(signInHrefFor("/generate", "mode=images&task=upscale&source=upload:x")).toBe(`/login?next=${encodeURIComponent("/generate?mode=images&task=upscale&source=upload:x")}`);
  expect(signInHrefFor("/library", "?all=1&view=references")).toBe(`/login?next=${encodeURIComponent("/library?all=1&view=references")}`);
  expect(signInHrefFor("/team")).toBe(`/login?next=${encodeURIComponent("/team")}`);
  expect(signInHrefFor("/")).toBe("/login");
  expect(signInHrefFor(null, "a=1")).toBe("/login");
});

test("a signed-out Suites link signs in and returns to its suite and page; no workspace goes to /workbench with the whole query", () => {
  const query = "suite=atomik&page=runs&project=p1";
  expect(shellEntryRedirect("/suites", query, false)).toBe(`/login?next=${encodeURIComponent(`/suites?${query}`)}`);
  expect(shellEntryRedirect("/workspace", "", false)).toBe(`/login?next=${encodeURIComponent("/workspace")}`);
  expect(shellEntryRedirect("/suites", query, true)).toBe(`/workbench?${query}`);
  expect(shellEntryRedirect("/suites", "", true)).toBe("/workbench");
});

test("the server switches a person with a workspace at once, and leaves visitors and shell= URLs to the gate", () => {
  const target = workspaceUrlFor("/workbench", "project=p1&stage=brief");
  expect(target).toBeTruthy();
  expect(serverSwitchTarget(target, "project=p1&stage=brief", true)).toBe(target);
  expect(serverSwitchTarget(target, "project=p1&stage=brief", false)).toBeNull();
  expect(serverSwitchTarget(target, "project=p1&shell=new", true)).toBeNull();
  expect(serverSwitchTarget(null, "", true)).toBeNull();
});

/* ── Public metadata ─────────────────────────────────────────────────────── */

test("the site origin comes from APP_ORIGIN, else the production deployment", () => {
  expect(siteOrigin({ APP_ORIGIN: "https://studio.example/path" })).toBe("https://studio.example");
  expect(siteOrigin({ APP_ORIGIN: "not a url", VERCEL_PROJECT_PRODUCTION_URL: "prod.example" })).toBe("https://prod.example");
  expect(siteOrigin({})).toBeNull();
});

test("robots keeps crawlers out of the API and one-time links; the sitemap lists public pages only", () => {
  const saved = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "https://studio.example";
  try {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    for (const path of ["/api/", "/invite/", "/reset/"]) expect(rules.disallow).toContain(path);
    /* A review link may be fetched for its preview card; its noindex keeps it out of every index. */
    expect(rules.disallow).not.toContain("/review/");
    expect(r.sitemap).toBe("https://studio.example/sitemap.xml");
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain("https://studio.example");
    expect(urls).toContain("https://studio.example/terms");
    expect(urls.length).toBe(PUBLIC_PATHS.length);
    for (const p of PRIVATE_PATHS) expect(urls.some((u) => u.includes(p))).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved;
  }
});

test("a client review page is answered with X-Robots-Tag noindex, and only it", async () => {
  const rules = await nextConfig.headers!();
  const review = rules.filter((r) => r.headers.some((h) => h.key === "X-Robots-Tag"));
  expect(review.map((r) => r.source)).toEqual(["/review/:path*"]);
  expect(review[0].headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow" });
});

test("a public page carries its own title and a link-preview card", () => {
  const m = publicPageMetadata("Terms", "The terms.");
  expect(m.title).toBe("Terms · Particl");
  expect(m.openGraph.title).toBe("Terms · Particl");
  expect(m.openGraph.images[0].url).toBe("/icon.png?v=3");
  expect(m.twitter.card).toBe("summary");
});

test("a client review page carries the studio's name, a neutral icon and no Particl install manifest", () => {
  const m = reviewMetadata("Spring film · Studio A", "Approved takes for Spring film.", "Studio A");
  expect(m.manifest).toBeNull();
  expect(m.icons).toEqual({ icon: [{ url: NEUTRAL_ICON, type: "image/svg+xml" }], apple: [] });
  expect(m.appleWebApp).toEqual({ capable: false, title: "Spring film · Studio A" });
  expect(JSON.stringify(m)).not.toMatch(/particl/i);
  expect(m.robots).toEqual({ index: false, follow: false });
});
