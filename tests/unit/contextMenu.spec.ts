import { test, expect } from "@playwright/test";
import { contextItems, CONTEXT_ORDER } from "../../lib/contextMenu";

/**
 * The one context menu (docs/change-request-1.md §10): ten items in one
 * order on every kind of card; what a kind cannot do is there, disabled,
 * so the shape never changes.
 */
const labels = (items: ReturnType<typeof contextItems>) => items.filter((i) => i.kind !== "divider" && i.kind !== "note").map((i) => (i as { label: string }).label);
const noop = () => {};

test("the ten items keep their order whether or not a kind can do them", () => {
  expect(labels(contextItems({}))).toEqual(["Cut", "Copy", "Paste", "Duplicate", "Rename", "Move to ▸", "Share ▸", "Download", "Open in Rig", "Delete"]);
  const all = contextItems({ cut: noop, copy: noop, paste: noop, duplicate: noop, rename: noop, moveTo: { open: false, onToggle: noop, items: [{ label: "Handbag TVC", onSelect: noop }] }, share: { open: false, onToggle: noop, copyLink: noop, addToReview: noop }, download: noop, openInRig: noop, remove: noop });
  expect(labels(all)).toEqual([...CONTEXT_ORDER]);
  expect(all.length, "ten items and one divider").toBe(11);
});

test("a missing action is a disabled item, never a missing one; Paste null means nothing to paste", () => {
  const items = contextItems({ copy: noop, paste: null, remove: noop });
  const on = items.filter((i) => i.kind === "item" && !i.disabled).map((i) => (i as { label: string }).label);
  expect(on).toEqual(["Copy", "Delete"]);
  const paste = items.find((i) => i.kind === "item" && i.label === "Paste");
  expect(paste && "disabled" in paste && paste.disabled).toBe(true);
});

test("Delete sits below the divider and the note comes last", () => {
  const items = contextItems({ remove: noop, note: "Takes and masters are never deleted with a shot." });
  expect(items[9].kind).toBe("divider");
  expect(items[10]).toMatchObject({ kind: "item", label: "Delete", keys: "⌫" });
  expect(items[11]).toEqual({ kind: "note", text: "Takes and masters are never deleted with a shot." });
});

test("Share opens only with something to share; Move to only with somewhere to go", () => {
  expect(contextItems({ share: { open: false, onToggle: noop } })[6]).toMatchObject({ kind: "item", disabled: true });
  expect(contextItems({ share: { open: true, onToggle: noop, copyLink: noop } })[6]).toMatchObject({ kind: "sub", label: "Share", open: true, items: [{ label: "Copy link" }] });
  expect(contextItems({ moveTo: { open: false, onToggle: noop, items: [] } })[5]).toMatchObject({ kind: "item", disabled: true });
});

test("the keys read as the platform's: ⌘X ⌘C ⌘V ⌘D ↵ ⌘R ⌫", () => {
  const keys = contextItems({}).filter((i) => i.kind === "item").map((i) => (i as { keys?: string }).keys);
  expect(keys).toEqual(["⌘X", "⌘C", "⌘V", "⌘D", "↵", undefined, undefined, undefined, "⌘R", "⌫"]);
});
