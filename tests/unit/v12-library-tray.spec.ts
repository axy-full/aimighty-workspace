import { test, expect } from "@playwright/test";
import { STUB_KINDS, TRAY_KINDS, filterTray, masonry, readTrayParams, trayItems, writeTrayParams, type TrayItem } from "../../lib/v12/library";
import { libraryEntries } from "../../lib/workspace/library";
import { onMention, requestMention } from "../../lib/v12/mention";

/**
 * The Library tray as data (lib/v12/library.ts; docs/redesign-plan.md, item C4; inventory § 5.10): where each item
 * lives decides Uploaded or Generated, kinds come from the open board's cards, two-column masonry, and the address.
 */

const T = Date.UTC(2026, 9, 10);
const upload = (id: string, extra: Record<string, unknown> = {}) => ({ id, filename: `${id}.png`, mime: "image/png", kind: "image", bytes: 1, width: 1600, height: 900, durationS: null, sha256: "x", url: `/api/uploads/${id}`, createdAt: T, ...extra });
const generation = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "image", status: "succeeded", storedUrl: `/api/media/${id}`, sourceUrl: null, prompt: "a still", title: `Still ${id}`, params: { ratio: "9:16" }, projectId: "p", model: "m", createdAt: T - 1, ...extra });

const entries = libraryEntries({
  uploads: [upload("u1"), upload("u2", { librarySource: "generation" })] as never,
  generations: [generation("g1")] as never,
});

test("Uploaded or Generated comes from where the item lives: an upload, an upload made from a generation, a generation", () => {
  const items = trayItems(entries);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  expect(by["upload:u1"].source).toBe("Uploaded");
  expect(by["upload:u2"].source).toBe("Generated");
  expect(by["generation:g1"].source).toBe("Generated");
  /* The tile keeps the item's own shape (a 9:16 take stands tall), and its kind line says what it is. */
  expect(by["generation:g1"].aspect).toBe(`${Math.round((9 / 16) * 1000)} / 1000`);
  expect(by["upload:u1"].kindLine).toBe("Still");
});

test("kinds: the open board's cards say Characters, Locations and Props; Everything made is every generated item; Products and Mandatories are stubs", () => {
  const items = trayItems(entries, (id) => (id === "upload:u1" ? "Characters" : null));
  expect(items.find((i) => i.id === "upload:u1")!.kindLine).toBe("Character");
  expect(filterTray(items, "All", "Characters").map((i) => i.id)).toEqual(["upload:u1"]);
  expect(filterTray(items, "All", "Everything made").map((i) => i.id).sort()).toEqual(["generation:g1", "upload:u2"]);
  expect(filterTray(items, "Uploaded", "All").map((i) => i.id)).toEqual(["upload:u1"]);
  expect(filterTray(items, "Generated", "Characters")).toEqual([]);
  for (const stub of STUB_KINDS) expect(filterTray(items, "All", stub)).toEqual([]);
  expect(TRAY_KINDS).toEqual(["All", "Characters", "Locations", "Props", "Products", "Mandatories", "Everything made"]);
});

test("two-column masonry: in order, each tile to the shorter column", () => {
  const tile = (id: string, aspect: string) => ({ id, aspect }) as Pick<TrayItem, "id" | "aspect">;
  const cols = masonry([tile("tall", "9 / 16"), tile("a", "16 / 9"), tile("b", "16 / 9"), tile("c", "16 / 9")]);
  expect(cols.map((c) => c.map((t) => t.id))).toEqual([["tall"], ["a", "b", "c"]]);
  expect(masonry([])).toEqual([[], []]);
});

test("the address: drawer=Library or lib=1 opens it; src= and libkind= or kind= pick; written back only when it differs", () => {
  expect(readTrayParams("?view=board&drawer=Library")).toEqual({ open: true, source: "All", kind: "All" });
  expect(readTrayParams("?view=home&lib=1&src=Uploaded&kind=Products")).toEqual({ open: true, source: "Uploaded", kind: "Products" });
  expect(readTrayParams("?libkind=Everything%20made")).toMatchObject({ open: false, kind: "Everything made" });
  /* Today's board drawer (lowercase) and the board's own kind are not the tray's. */
  expect(readTrayParams("?drawer=library&kind=ads")).toEqual({ open: false, source: "All", kind: "All" });
  expect(writeTrayParams("?view=board&kind=ads", { open: true, source: "Generated", kind: "Props" })).toBe("?view=board&kind=ads&drawer=Library&src=Generated&libkind=Props");
  expect(writeTrayParams("?view=board&drawer=Library&src=Uploaded&kind=Products", { open: false, source: "Uploaded", kind: "Products" })).toBe("?view=board");
  expect(writeTrayParams("?view=board&drawer=history", { open: false, source: "All", kind: "All" })).toBe("?view=board&drawer=history");
});

test("a click hands the tile to the bar when one listens; with none, the caller falls back", () => {
  expect(requestMention({ id: "upload:u1", name: "u1" })).toBe(false);
  const heard: string[] = [];
  const stop = onMention((m) => heard.push(m.name));
  expect(requestMention({ id: "upload:u1", name: "u1" })).toBe(true);
  stop();
  expect(heard).toEqual(["u1"]);
  expect(requestMention({ id: "upload:u1", name: "u1" })).toBe(false);
});
