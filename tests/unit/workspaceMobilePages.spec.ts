import { test, expect } from "@playwright/test";
import { MOLECULR_SECTIONS } from "../../lib/suites";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { SOUND_TASKS, SOUND_TOOLS } from "../../lib/workbench/sound-generate";
import { EMPTY_MOLECULR } from "../../lib/workbench/moleculr";
import {
  MOBILE_TEMPLATES,
  flowChain,
  marketingSections,
  mobileRowGroups,
  mobileRowIntro,
  primaryBlockedReason,
  templateFor,
  toggleSection,
  type MobileTemplate,
} from "../../lib/workspace/mobile-templates";
import {
  EMPTY_CREATIVE,
  FORM_QUOTE_NOTE,
  formBlocked,
  formDraftKey,
  formInput,
  formQuote,
  formQuoteLabel,
  formSummary,
  readFormCreative,
  withReference,
  withoutReference,
  writeFormCreative,
  type FormCreative,
  type FormJob,
} from "../../lib/workspace/mobile-form";
import { ALL_PAGES } from "../../lib/workspace/pages";
import { EMPTY_FACTS, SPEC_PAGES, cardChips, cardState, specFor, type SpecFacts } from "../../lib/workspace/spec-cards";
import { stemRows } from "../../lib/workspace/stems";
import type { PageId } from "../../lib/workspace/types";

/**
 * Wave M-B: every template's derivation, and the rule that a primary which
 * cannot run reports a reason. Nothing here touches a browser: if a figure on
 * the phone can drift from the desktop's, it fails here first.
 */

/* ── The mapping ─────────────────────────────────────────────────────────── */

test("every page has a template, and the six of 05-mobile are the ones used", () => {
  for (const page of ALL_PAGES) expect(MOBILE_TEMPLATES[page.id], page.id).toBeTruthy();
  expect(Object.keys(MOBILE_TEMPLATES).sort()).toEqual(ALL_PAGES.map((p) => p.id).sort());
  const used = new Set<MobileTemplate>(Object.values(MOBILE_TEMPLATES));
  expect([...used].sort()).toEqual(["accordion", "cards", "edit", "form", "rows", "shots"]);
  /* 05-mobile's own assignment, page by page. */
  expect(templateFor("rig")).toBe("shots");
  expect(templateFor("rig", "graph")).toBe("flow");
  expect([templateFor("cast"), templateFor("takes")]).toEqual(["cards", "cards"]);
  expect(templateFor("marketing")).toBe("accordion");
  expect([templateFor("motion"), templateFor("swap")]).toEqual(["form", "form"]);
  expect(templateFor("edit")).toBe("edit");
  for (const page of ["brief", "boards", "astra", "deliver", "sources", "compare", "history"] as PageId[])
    expect(templateFor(page), page).toBe("rows");
  /* All of the Atomik suite, including the Generate page the owner kept. */
  for (const page of ["agent", "runs", "generate", "recipes", "builds", "skills", "models", "approvals", "budget"] as PageId[])
    expect(templateFor(page), page).toBe("rows");
});

/* ── Rows ────────────────────────────────────────────────────────────────── */

test("rows are the desktop spec page's own groups and cards, never a second list", () => {
  for (const page of Object.keys(SPEC_PAGES) as PageId[]) {
    const spec = specFor(page)!;
    const groups = mobileRowGroups(page, EMPTY_FACTS);
    expect(groups.map((group) => group.title), page).toEqual(spec.groups.map((group) => group.title));
    expect(groups.flatMap((group) => group.rows.map((row) => row.name)), page).toEqual(
      spec.groups.flatMap((group) => group.cards.map((card) => card.name)),
    );
    expect(mobileRowIntro(page), page).toBe(spec.intro);
  }
});

test("a row's lead, value and tint come from the card's own state and chips", () => {
  const groups = mobileRowGroups("brief", EMPTY_FACTS);
  const spec = specFor("brief")!;
  for (const [g, group] of groups.entries()) {
    for (const [i, row] of group.rows.entries()) {
      const card = spec.groups[g].cards[i];
      expect(row.state).toBe(cardState(card, EMPTY_FACTS));
      expect(row.value).toBe(cardChips(card, EMPTY_FACTS)[0] ?? "ready");
      /* The plan's own card is marked; every other row is its place in the group. */
      expect(row.lead).toBe(card.plan ? "✦" : String(i + 1).padStart(2, "0"));
      expect(row.lead.length).toBeLessThanOrEqual(2);
    }
  }
});

test("a row counts what the facts hold: a running plan turns its card active", () => {
  const facts: SpecFacts = { ...EMPTY_FACTS, planRun: { status: "running" }, planPrice: "Quote at gate" };
  const rows = mobileRowGroups("boards", facts).flatMap((group) => group.rows);
  const plan = rows.find((row) => row.lead === "✦");
  expect(plan).toBeTruthy();
  expect(plan!.state).toBe("ACTIVE");
  const waiting = mobileRowGroups("boards", { ...facts, planRun: { status: "waiting" } }).flatMap((g) => g.rows).find((row) => row.lead === "✦");
  expect(waiting!.state).toBe("WAITING");
});

/* ── Flow ────────────────────────────────────────────────────────────────── */

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 344, linked: [], ...extra });

test("the flow is one chain down the real graph: blue into the scene, grey after", () => {
  const nodes = [
    node("look", { type: "moodboard" }),
    node("world", { type: "element" }),
    node("cast", { type: "character" }),
    node("scene", { linked: ["look", "world", "cast"] }),
    node("colour", { type: "grade", linked: ["scene"] }),
  ];
  const chain = flowChain(nodes, "scene");
  expect(chain.map((step) => step.id)).toEqual(["look", "world", "cast", "scene", "colour"]);
  expect(chain.map((step) => step.wire)).toEqual(["blue", "blue", "blue", "grey", null]);
  expect(chain.filter((step) => step.scene).map((step) => step.id)).toEqual(["scene"]);
});

test("with no shot selected the flow reads around the first scene on the graph", () => {
  const nodes = [node("look", { type: "moodboard" }), node("a"), node("b", { linked: ["look"] })];
  expect(flowChain(nodes, null).find((step) => step.scene)!.id).toBe("a");
  /* A selection that is not a shot (a take, after arriving from Takes) repairs the same way. */
  expect(flowChain(nodes, "look").find((step) => step.scene)!.id).toBe("a");
  expect(flowChain([], "a")).toEqual([]);
  /* A graph with no shot at all still reads as a chain rather than nothing. */
  const refs = [node("x", { type: "moodboard" }), node("y", { type: "element" })];
  expect(flowChain(refs, null)).toEqual([{ id: "x", scene: false, wire: "grey" }, { id: "y", scene: false, wire: null }]);
});

test("every node on the graph appears exactly once, wherever it sits", () => {
  const nodes = [node("loose", { type: "note" }), node("look", { type: "moodboard" }), node("scene", { linked: ["look"] })];
  const chain = flowChain(nodes, "scene");
  expect(chain.map((step) => step.id).sort()).toEqual(["look", "loose", "scene"]);
  expect(new Set(chain.map((step) => step.id)).size).toBe(3);
  expect(chain[chain.length - 1].wire).toBeNull();
});

/* ── Accordion ───────────────────────────────────────────────────────────── */

test("the accordion is Marketing Studio's seven real sections, and empty means empty", () => {
  const sections = marketingSections(null);
  expect(sections.map((section) => section.id)).toEqual(MOLECULR_SECTIONS.map((section) => section.id));
  expect(sections).toHaveLength(7);
  for (const section of sections) {
    expect(section.rows.length, section.id).toBeGreaterThan(0);
    /* With no brief saved, nothing is claimed: every derived value is a dash. */
    for (const row of section.rows) if (row.value !== "not connected") expect(row.value, `${section.id}/${row.name}`).toBe("—");
  }
  expect(sections.filter((section) => section.state === "idle").map((s) => s.id)).toContain("product");
});

test("a saved brief fills the sections it covers, and only those", () => {
  const project: Project = {
    ...newProject("Campaign"),
    moleculr: { ...EMPTY_MOLECULR, productName: "Serum", productUrl: "https://example.com", productDescription: "30 ml", productAssetIds: ["a", "b"], hooks: ["one"], castAssetIds: ["c"] },
  };
  const sections = marketingSections(project);
  const product = sections.find((section) => section.id === "product")!;
  expect(product.state).toBe("done");
  expect(product.rows.map((row) => row.value)).toEqual(["saved", "2", "saved", "saved"]);
  expect(sections.find((section) => section.id === "variants")!.state).toBe("active");
  expect(sections.find((section) => section.id === "brand")!.state).toBe("idle");
});

test("one section opens at a time", () => {
  expect(toggleSection(null, "product")).toBe("product");
  expect(toggleSection("product", "brand")).toBe("brand");
  expect(toggleSection("brand", "brand")).toBeNull();
});

/* ── Form ────────────────────────────────────────────────────────────────── */

const ref = (id: string, kind: "image" | "video" = "image") => ({ id, origin: "upload" as const, name: id, kind, seconds: null });
const creative: FormCreative = { source: ref("v1", "video"), references: [ref("i1"), ref("i2")], prompt: "Hold the wind", resolution: "1080p" };
const request = formInput("motion-transfer", creative)!;
const job = (extra: Partial<FormJob> = {}): FormJob => ({ id: "j1", status: "quoted", input: request, quoteCredits: 142, quoteExpiresAt: 2_000, ...extra });

test("the form reads and writes the same composition the desktop form holds", () => {
  expect(formDraftKey("p1", "object-swap")).toBe("subatomik-consumer:p1:object-swap");
  expect(readFormCreative(writeFormCreative(creative))).toEqual(creative);
  /* Junk, a wrong kind and a repeat are all dropped, as the desktop drops them. */
  expect(readFormCreative({ source: { id: "v1", origin: "upload", kind: "image" }, references: [ref("i1"), ref("i1")], resolution: "9000p" })).toEqual({
    ...EMPTY_CREATIVE,
    references: [ref("i1")],
  });
  expect(readFormCreative(null)).toEqual(EMPTY_CREATIVE);
});

test("the request is only built once the engine could take it", () => {
  expect(formInput("motion-transfer", EMPTY_CREATIVE)).toBeNull();
  expect(request).toEqual({
    variant: "motion-transfer",
    resolution: "1080p",
    prompt: "Hold the wind",
    source: { uploadId: "v1" },
    references: [{ uploadId: "i1" }, { uploadId: "i2" }],
  });
  /* Distinct originals only: the schema refuses the same media twice. */
  expect(withReference(creative, ref("i1")).references).toHaveLength(2);
  expect(withReference(creative, ref("v1")).references).toHaveLength(2);
  expect(withReference(creative, ref("i3")).references.map((item) => item.id)).toEqual(["i1", "i2", "i3"]);
  expect(withoutReference(creative, "i1").references.map((item) => item.id)).toEqual(["i2"]);
  expect(formSummary(creative)).toBe("1080p · 2 ordered references");
});

test("a quote counts only while it is the connected account's own, live and unspent", () => {
  expect(formQuote([job()], request, 1_000)).toEqual({ state: "ready", credits: 142, expiresAt: 2_000 });
  expect(formQuoteLabel(formQuote([job()], request, 1_000))).toBe("142 cr");
  /* Stale, in each of the ways it can be stale. */
  expect(formQuote([], request, 1_000).state).toBe("none");
  expect(formQuote([job()], null, 1_000).state).toBe("none");
  expect(formQuote([job({ status: "accepted" })], request, 1_000).state).toBe("none");
  expect(formQuote([job()], formInput("motion-transfer", { ...creative, prompt: "different" })!, 1_000).state).toBe("changed");
  expect(formQuote([job()], request, 9_000).state).toBe("expired");
  expect(formQuote([job({ quoteExpired: true })], request, 1_000).state).toBe("expired");
  expect(formQuote([job()], request, 1_000, ["j1"]).state).toBe("attempted");
  /* No stale state ever carries a figure, so none can reach a button. */
  for (const state of ["none", "changed", "expired", "attempted"] as const) {
    const quote = { state, credits: null, expiresAt: null };
    expect(formQuoteLabel(quote)).toBe("—");
    expect(FORM_QUOTE_NOTE[state]).toMatch(/estimate|submitted|price/i);
  }
});

test("a missing or stale quote blocks submission, and the reason is the honest one", () => {
  const ready = formQuote([job()], request, 1_000);
  expect(formBlocked({ projectOpen: true, connected: true, creative, request, quote: ready })).toBeNull();
  expect(formBlocked({ projectOpen: false, connected: true, creative, request, quote: ready })).toMatch(/Open a project/);
  expect(formBlocked({ projectOpen: true, connected: null, creative, request, quote: ready })).toMatch(/Checking/);
  expect(formBlocked({ projectOpen: true, connected: false, creative, request, quote: ready })).toMatch(/connected account/);
  expect(formBlocked({ projectOpen: true, connected: true, creative: EMPTY_CREATIVE, request: null, quote: ready })).toMatch(/source video/);
  for (const state of ["none", "changed", "expired", "attempted"] as const)
    expect(formBlocked({ projectOpen: true, connected: true, creative, request, quote: { state, credits: null, expiresAt: null } })).toBe(FORM_QUOTE_NOTE[state]);
});

/* ── Edit & Sound, and the primary's reason ──────────────────────────────── */

test("Edit & Sound has three lanes and five doors — the edit's own, not the design's four", () => {
  const rows = stemRows(newProject("Cut"));
  expect(rows.map((row) => row.id)).toEqual(["dialogue", "sfx", "music"]);
  expect(SOUND_TASKS.length + SOUND_TOOLS.length).toBe(5);
  /* Ambience is a sound-effects bed on the effects lane, which the lane says. */
  expect(rows.find((row) => row.id === "sfx")!.empty).toMatch(/ambience/i);
});

test("a primary that cannot run reports a reason instead of pinning a dead button", () => {
  expect(primaryBlockedReason({ projectOpen: true, runnable: true })).toBeNull();
  expect(primaryBlockedReason({ projectOpen: false, runnable: true })).toMatch(/Open a project/);
  expect(primaryBlockedReason({ projectOpen: true, runnable: false })).toMatch(/Not runnable yet/);
  expect(primaryBlockedReason({ projectOpen: true, runnable: undefined, needs: "Choose a shot." })).toBe("Choose a shot.");
});
