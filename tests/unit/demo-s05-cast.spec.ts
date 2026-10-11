import { test, expect } from "@playwright/test";
import { appearsIn, castLabel, castStatus, consentLine, deriveCast, renderPreset, shotsWords, type CastCardData } from "../../components/graphite/board/cards/cast/cast-model";
import type { BoardCard, BoardSource } from "../../lib/board/types";
import type { SoulIdentity } from "../../lib/workbench/soul-identity";
import type { Asset, CanvasNode, Project } from "../../lib/workbench/studio";
import { project } from "./demo-s05-fixtures";

/* Stream 5 · the Cast region (design/particl-graphite/README.md § 3.1 h). Neutral names only. */

const entry = (over: Record<string, unknown> = {}) => ({ id: "c1", name: "Lead", kind: "character" as const, description: "ivory suit, short dark bob", prompt: "A woman in an ivory suit", takes: [], ...over });
const withProduction = (p: Project, production: Record<string, unknown>) => ({ ...p, production: { ...p.production, ...production } }) as Project;
const src = (p: Project, masters: string[] = []): Pick<BoardSource, "kind" | "project" | "masters"> => ({ kind: "studio", project: p, masters: new Set(masters) });
const cards = (p: Project, masters: string[] = []) => deriveCast(src(p, masters)).filter((c) => c.kind === "cast") as BoardCard<CastCardData>[];
const identity = (over: Partial<SoulIdentity> = {}): SoulIdentity => ({
  id: "id1", projectId: "p1", name: "Lead v2", description: "", subjectType: "character", references: [], status: "ready", previewUrl: null,
  createdAt: 1, updatedAt: 1, creditsBilled: null, error: null, renderModel: "soul_2", consentAt: Date.UTC(2026, 8, 12, 10), consentBy: "Person One", ...over,
});

test("a character, a place and an element are numbered in the shots they appear in, the way the Shots region numbers them", () => {
  const p = project();
  /* The fixture's three shots sit in one scene, which lists the character and the place; no prop is listed. */
  expect(appearsIn(p, "cast", "Lead")).toEqual([1, 2, 3]);
  expect(appearsIn(p, "cast", " lead ")).toEqual([1, 2, 3]);
  expect(appearsIn(p, "environment", "Plate")).toEqual([1, 2, 3]);
  expect(appearsIn(p, "element", "Plate")).toEqual([]);
  expect(appearsIn(p, "cast", "Nobody")).toEqual([]);
  expect(shotsWords([1, 2, 3])).toBe("Shots 1 · 2 · 3");
  expect(shotsWords([2])).toBe("Shot 2");
  expect(shotsWords([])).toBeNull();
});

test("the card reads as its own words, never a person's name it was not given: Lead · ivory suit, short dark bob", () => {
  const [card] = cards(withProduction(project(), { cast: { entries: [entry()] } }));
  expect(card.data).toMatchObject({ variant: "cast", source: "entry", title: "Lead", description: "ivory suit, short dark bob", shots: [1, 2, 3] });
  expect(castLabel(card.data)).toBe("Lead · ivory suit, short dark bob");
});

test("a character's status is its identity's, as the workspace's list says it, and never more than it has read", () => {
  const [card] = cards(withProduction(project(), { cast: { entries: [entry({ identityId: "id1" })] } }));
  expect(castStatus(card.data, [identity()])).toEqual({ text: "Identity ready · Lead v2", tone: "done" });
  expect(castStatus(card.data, [identity({ status: "training" })]).text).toBe("Identity training");
  expect(castStatus(card.data, [identity({ status: "uncertain" })]).text).toBe("Identity needs review");
  /* The list has not answered (or no longer lists it): attached, not ready. */
  expect(castStatus(card.data, null).text).toBe("Identity attached");
  const [none] = cards(withProduction(project(), { cast: { entries: [entry()] } }));
  expect(castStatus(none.data, [identity()])).toEqual({ text: "No identity yet", tone: "idle" });
});

test("the consent line is the training consent that exists, and is never shown signed out", () => {
  expect(consentLine(identity(), true)).toBe("Training consent confirmed 12 Sep 2026 by Person One");
  expect(consentLine(identity({ consentBy: null }), true)).toBe("Training consent confirmed 12 Sep 2026");
  expect(consentLine(identity(), false)).toBeNull();
  expect(consentLine(identity({ consentAt: null }), true)).toBeNull();
  expect(consentLine(null, true)).toBeNull();
  /* No scope, use or end date is stored, so none is said. */
  expect(consentLine(identity(), true)).not.toMatch(/until|paid|web|face|voice/i);
});

test("places come from the environment list, with their plates; an element is locked or not", () => {
  const p = withProduction(project({ assets: [{ id: "a1", name: "Plate", kind: "image", category: "Environment", url: "/x", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], generationId: "g-plate" } as Asset] }), {
    environment: { world: "Warm light", model: "gemini-3.1-flash-image", entries: [{ id: "e1", name: "Plate", notes: "Late afternoon", prompt: "", references: [], plates: [{ assetId: "a1", at: "2026-10-05T00:00:00Z", source: "render" }], selected: "a1" }] },
    cast: { entries: [entry({ id: "c2", name: "Sphere", kind: "element", category: "prop", description: "Set piece", prompt: "A chrome sphere" })] },
  });
  const all = cards(p);
  const place = all.find((c) => c.data.variant === "environment")!;
  expect(place.data).toMatchObject({ title: "Plate", description: "Late afternoon", plates: 1, chosen: true, still: { url: "/api/media/g-plate", kind: "image" }, shots: [1, 2, 3] });
  expect(castStatus(place.data, null)).toEqual({ text: "Plate chosen · 1 plate", tone: "done" });
  expect(place.data.prompt).toContain("Warm light");
  expect(renderPreset(place.data)).toMatchObject({ note: "Plate · Plate" });
  const element = all.find((c) => c.data.variant === "element")!;
  expect(castStatus(element.data, null)).toEqual({ text: "No still yet", tone: "idle" });
  expect(renderPreset(element.data)).toEqual({ prompt: "A chrome sphere", note: "Reference still · Sphere" });
});

test("the region's cards come characters first, then places, then elements, in one group", () => {
  const p = withProduction(project(), {
    environment: { world: "", model: "gemini-3.1-flash-image", entries: [{ id: "e1", name: "Plate", notes: "", prompt: "A wide plate", references: [], plates: [] }] },
    cast: { entries: [entry({ id: "c2", name: "Sphere", kind: "element", category: "prop" }), entry()] },
  });
  const all = deriveCast(src(p));
  expect(all[0]).toMatchObject({ id: "group:cast", kind: "group", region: "cast", data: { title: "Cast, environment and elements", meta: "1 character · 1 place · 1 element" } });
  expect(all.slice(1).map((c) => (c.data as CastCardData).variant)).toEqual(["cast", "environment", "element"]);
  expect(all.slice(1).every((c) => c.group === "group:cast" && c.region === "cast")).toBe(true);
  expect(deriveCast(src(project()))).toEqual([]);
  expect(deriveCast({ ...src(p), kind: "ads" })).toEqual([]);
});

test("a canvas reference card is drawn once, with the production's entry of the same name folded into it, and a locked master says so", () => {
  const sphere: CanvasNode = { id: "n-sphere", title: "Sphere", type: "element", x: 0, y: 0, width: 220, linked: [], assetId: "a2", elementId: "el1", refKind: "element" } as CanvasNode;
  const p = withProduction(project({
    nodes: [...project().nodes, sphere],
    assets: [{ id: "a2", name: "Sphere", kind: "image", category: "Element", url: "/api/media/g-sphere", description: "A chrome sphere", prompt: "", status: "Draft", locked: false, version: 1, refs: [], generationId: "g-sphere" } as Asset],
  }), { cast: { entries: [entry({ id: "c2", name: "Sphere", kind: "element", category: "prop" })] } });
  const all = cards(p, ["el1"]);
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ id: "n-sphere", nodeId: "n-sphere", data: { source: "node", master: true, lockable: false, description: "A chrome sphere", still: { url: "/api/media/g-sphere" } } });
  expect(castStatus(all[0].data, null)).toEqual({ text: "Locked master", tone: "done" });
  /* Unlocked: it can be locked (free), because its picture is a stored file of this workspace. */
  expect(cards(p)[0].data).toMatchObject({ master: false, lockable: true });
});

test("an entry built earlier on an account that is no longer used is shown read-only", () => {
  const p = withProduction(project(), { cast: { entries: [entry({ id: "c3", name: "Place", kind: "element", model: "soul_location", takes: [{ genId: "g1", at: "2026-10-05T00:00:00Z" }] })] } });
  const [card] = cards(p);
  expect(card.data.retired).toBeTruthy();
  expect(castStatus(card.data, null).text).toBe("Built earlier · read-only");
});
