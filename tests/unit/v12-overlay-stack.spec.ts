import { test, expect } from "@playwright/test";
import { ESC_ORDER, createOverlayStack, type OverlayLayer } from "../../components/v12/ui/overlay-stack";
import { place, placeStart } from "../../components/v12/ui/place";
import type { IconButtonProps } from "../../components/v12/ui/IconButton";

/* The new interface's overlay stack (components/v12/ui/overlay-stack.ts): Esc closes the top-most layer first, in the
   order of docs/redesign/inventory.md § 4.1, and never anything else. */

function opened(layers: OverlayLayer[]) {
  const stack = createOverlayStack();
  const closed: string[] = [];
  layers.forEach((layer, i) => stack.open({ layer, close: () => closed.push(`${layer}#${i}`) }));
  return { stack, closed };
}

test("the Esc order is the inventory's: viewer, join sheet, the board graph's expand, menus, tool, selection, drawers", () => {
  expect([...ESC_ORDER]).toEqual(["viewer", "join", "rig", "menu", "tool", "selection", "drawer"]);
});

test("Esc closes the top-most layer first, one per press, whatever order they opened in", () => {
  /* Opened bottom-up and shuffled: the order they close in is the layer order, not the opening order. */
  const { stack, closed } = opened(["drawer", "selection", "menu", "tool", "join", "rig", "viewer"]);
  for (let i = 0; i < 7; i++) expect(stack.escape()).toHaveLength(1);
  expect(closed).toEqual(["viewer#6", "join#4", "rig#5", "menu#2", "tool#3", "selection#1", "drawer#0"]);
  expect(stack.escape()).toEqual([]);
});

test("within a layer the last opened closes first: a menu opened from a dialog goes before the dialog", () => {
  const { stack, closed } = opened(["menu", "menu", "drawer"]);
  stack.escape();
  expect(closed).toEqual(["menu#1"]);
  expect(stack.list().map((e) => e.layer)).toEqual(["menu", "drawer"]);
  stack.escape();
  stack.escape();
  expect(closed).toEqual(["menu#1", "menu#0", "drawer#2"]);
});

test("Esc with nothing open closes nothing: a render is not a layer, so Esc never cancels one", () => {
  const stack = createOverlayStack();
  expect(stack.escape()).toEqual([]);
  expect(stack.top()).toBeNull();
  expect(ESC_ORDER as readonly string[]).not.toContain("render");
});

test("a layer that closed itself leaves the stack, and its release is safe to call twice", () => {
  const stack = createOverlayStack();
  const closed: string[] = [];
  const release = stack.open({ layer: "viewer", close: () => closed.push("viewer") });
  stack.open({ layer: "drawer", close: () => closed.push("drawer") });
  release();
  release();
  stack.escape();
  expect(closed).toEqual(["drawer"]);
});

test("an outside click closes the menus it is outside of, spares the one it is in and its parent, and leaves a drawer alone", () => {
  const stack = createOverlayStack();
  const closed: string[] = [];
  const inside = (name: string) => (node: unknown) => node === name;
  stack.open({ layer: "menu", outside: true, contains: inside("parent"), close: () => closed.push("parent") });
  stack.open({ layer: "menu", outside: true, contains: inside("child"), close: () => closed.push("child") });
  stack.open({ layer: "drawer", close: () => closed.push("drawer") });
  stack.pointerDown("child");
  expect(closed).toEqual([]);
  stack.pointerDown("parent");
  expect(closed).toEqual(["child"]);
  stack.pointerDown("page");
  expect(closed).toEqual(["child", "parent"]);
  expect(stack.list().map((e) => e.layer)).toEqual(["drawer"]);
});

test("subscribers hear every open and close", () => {
  const stack = createOverlayStack();
  let heard = 0;
  stack.subscribe(() => heard++);
  stack.open({ layer: "menu", close: () => {} });
  stack.escape();
  expect(heard).toBe(2);
});

test("a floating box stays on screen: it flips to the other side when there is no room, and slides inside the edges", () => {
  const view = { width: 1440, height: 900 };
  const box = { width: 240, height: 80 };
  /* Room below: below, centred. */
  expect(place({ left: 600, top: 100, width: 40, height: 32 }, box, view, "bottom")).toEqual({ left: 500, top: 140, side: "bottom" });
  /* At the bottom edge: flips above. */
  expect(place({ left: 600, top: 860, width: 40, height: 32 }, box, view, "bottom").side).toBe("top");
  /* At the right edge: slid left so it ends 8 px inside. */
  const right = place({ left: 1410, top: 100, width: 24, height: 24 }, box, view, "bottom");
  expect(right.left + box.width).toBe(1432);
  /* At the left edge, preferring left: flips right. */
  expect(place({ left: 4, top: 400, width: 24, height: 24 }, box, view, "left").side).toBe("right");
  /* A menu under a control near the right edge lines up with it as far as it can. */
  expect(placeStart({ left: 1400, top: 10, width: 32, height: 32 }, { width: 220, height: 200 }, view).left).toBe(1440 - 8 - 220);
});

test("an icon button cannot be written without a tooltip (the type requires it)", () => {
  // @ts-expect-error: tooltip is required
  const missing: IconButtonProps = { children: null };
  const given: IconButtonProps = { children: null, tooltip: { name: "Download", line: "The full-resolution original." } };
  expect(missing).toBeTruthy();
  expect(given.tooltip.name).toBe("Download");
});
